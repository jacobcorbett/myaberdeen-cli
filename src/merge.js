import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { safeFilename } from './downloads.js';

export function mergeVault(database, config, { deduplicate = true } = {}) {
  const uniRoot = path.join(config.vaultRoot, 'Uni');
  if (!fs.existsSync(uniRoot)) throw new Error(`University vault not found at ${uniRoot}`);
  const courseDirectories = findCourseDirectories(uniRoot);
  const indexedFiles = indexVaultFiles(database, uniRoot, courseDirectories);
  const dedupe = connectExactDuplicates(database, config, deduplicate);
  const integration = integrateCourses(database, config, uniRoot, courseDirectories);
  return { indexedFiles, ...dedupe, ...integration };
}

function findCourseDirectories(uniRoot) {
  const result = new Map();
  for (const yearName of fs.readdirSync(uniRoot)) {
    const coursesRoot = path.join(uniRoot, yearName, 'Courses');
    if (!fs.existsSync(coursesRoot)) continue;
    for (const name of fs.readdirSync(coursesRoot)) {
      const directory = path.join(coursesRoot, name);
      if (!fs.statSync(directory).isDirectory()) continue;
      const code = name.match(/^([A-Z]{2}(?:\d{4}|\d{3}[A-Z]))\b/)?.[1];
      if (code) result.set(code, directory);
    }
  }
  return result;
}

function indexVaultFiles(database, uniRoot, courseDirectories) {
  const codeByDirectory = [...courseDirectories.entries()].map(([code, directory]) => [directory, code]);
  let count = 0;
  for (const target of walkFiles(uniRoot)) {
    if (target.endsWith('.md') || target.includes(`${path.sep}.obsidian${path.sep}`)) continue;
    const body = fs.readFileSync(target);
    const courseCode = codeByDirectory.find(([, directory]) => target.startsWith(`${directory}${path.sep}`))?.[1] || null;
    database.upsertLocalFile({ path: target, courseCode, sha256: hash(body), byteSize: body.length, source: 'obsidian-vault' });
    count += 1;
  }
  return count;
}

function connectExactDuplicates(database, config, deduplicate) {
  const rows = database.db.prepare(`SELECT f.course_id,f.content_id,f.sha256,f.local_path,f.byte_size,c.course_code
    FROM files f JOIN courses c ON c.id=f.course_id WHERE f.local_path IS NOT NULL`).all();
  const removals = new Map();
  let linkedRecords = 0;
  for (const row of rows) {
    const canonical = database.findLocalFileByHash(row.sha256, baseCourseCode(row.course_code));
    if (!canonical || !fs.existsSync(canonical.path)) continue;
    if (hash(fs.readFileSync(canonical.path)) !== row.sha256) continue;
    const oldPath = row.local_path;
    database.db.prepare('UPDATE files SET local_path=? WHERE course_id=? AND content_id=?').run(canonical.path, row.course_id, row.content_id);
    linkedRecords += 1;
    if (oldPath !== canonical.path && isWithin(oldPath, config.downloadDir)) removals.set(oldPath, row.sha256);
  }
  let removedFiles = 0;
  let removedBytes = 0;
  if (deduplicate) {
    for (const [target, expectedHash] of removals) {
      if (!fs.existsSync(target)) continue;
      const body = fs.readFileSync(target);
      if (hash(body) !== expectedHash) throw new Error(`Refusing to remove changed file: ${target}`);
      fs.unlinkSync(target);
      removedFiles += 1;
      removedBytes += body.length;
    }
  }
  return { linkedRecords, removedFiles, removedBytes };
}

function integrateCourses(database, config, uniRoot, courseDirectories) {
  const courses = database.db.prepare('SELECT * FROM courses ORDER BY term_name,course_code').all();
  let moduleCourses = 0;
  let resourceCourses = 0;
  for (const course of courses) {
    const code = baseCourseCode(course.course_code);
    let directory = courseDirectories.get(code);
    const isModule = /^[A-Z]{2}(?:\d{4}|\d{3}[A-Z])$/.test(code);
    if (!directory && isModule) {
      directory = path.join(uniRoot, academicYear(course.term_name), 'Courses', `${code} - ${safeFilename(cleanCourseName(course.name, code))}`);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      courseDirectories.set(code, directory);
    }
    if (!directory) {
      directory = path.join(uniRoot, 'University Resources', `${safeFilename(course.course_code)} - ${safeFilename(course.name)}`);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      resourceCourses += 1;
    } else {
      // Preserve old resource notes: Markdown alone does not prove they are generated.
      moduleCourses += 1;
    }
    writeCourseIntegration(database, config, course, directory);
    connectMainNote(directory, code, course.name);
  }
  return { moduleCourses, resourceCourses };
}

function writeCourseIntegration(database, config, course, directory) {
  const target = path.join(directory, 'MyAberdeen');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const query = table => database.db.prepare(`SELECT * FROM ${table} WHERE course_id=? ORDER BY rowid`).all(course.id);
  const content = query('content');
  const announcements = query('announcements');
  const grades = query('grades');
  const schedules = query('schedules');
  const conversations = query('conversations');
  const messages = query('messages');
  const discussions = query('discussion_posts');
  const files = query('files');
  const rawDirectory = path.join(config.downloadDir, safeFilename(course.term_name || 'No term'), safeFilename(course.course_code));
  writeMarkdown(path.join(target, 'Index.md'), [
    frontmatter('uni', course.course_code),
    `# ${course.name} — MyAberdeen archive`, '',
    `- Blackboard course ID: \`${course.id}\``,
    `- Term: ${course.term_name || 'No term'}`,
    `- Raw archive: [Open folder](${fileLink(rawDirectory)})`,
    `- SQLite: \`${config.databasePath}\``, '',
    '## Offline sections', '',
    `- [Content](Content.md) — ${content.length} records`,
    `- [Files](Files.md) — ${files.length} records`,
    `- [Announcements](Announcements.md) — ${announcements.length}`,
    `- [Gradebook](Gradebook.md) — ${grades.length}`,
    `- [Messages](Messages.md) — ${messages.length} messages in ${conversations.length} conversations`,
    `- [Discussions](Discussions.md) — ${discussions.length} posts`,
    `- [Schedule](Schedule.md) — ${schedules.length} entries`, ''
  ]);
  writeMarkdown(path.join(target, 'Content.md'), renderContent(course, content));
  writeMarkdown(path.join(target, 'Files.md'), renderFiles(course, files));
  writeMarkdown(path.join(target, 'Announcements.md'), renderAnnouncements(course, announcements));
  writeMarkdown(path.join(target, 'Gradebook.md'), renderGrades(course, grades));
  writeMarkdown(path.join(target, 'Messages.md'), renderMessages(course, messages));
  writeMarkdown(path.join(target, 'Discussions.md'), renderDiscussions(course, discussions));
  writeMarkdown(path.join(target, 'Schedule.md'), renderSchedule(course, schedules));
}

function renderContent(course, rows) {
  return [frontmatter('uni', course.course_code), `# ${course.course_code} content`, '',
    '| Title | Type | Parent |', '|---|---|---|',
    ...rows.map(row => `| ${cell(row.title)} | ${cell(row.handler)} | ${cell(row.parent_id)} |`), ''];
}

function renderFiles(course, rows) {
  return [frontmatter('uni', course.course_code), `# ${course.course_code} files`, '',
    ...rows.map(row => `- [${escapeMarkdown(row.title || path.basename(row.local_path || 'file'))}](${row.local_path ? fileLink(row.local_path) : row.source_url}) — ${formatBytes(row.byte_size)}`), ''];
}

function renderAnnouncements(course, rows) {
  const lines = [frontmatter('uni', course.course_code), `# ${course.course_code} announcements`, ''];
  for (const row of rows) {
    const data = parseJson(row.json);
    lines.push(`## ${row.title || 'Untitled announcement'}`, '', row.created_at ? `Posted: ${row.created_at}` : '', '', bodyText(data), '');
  }
  return lines;
}

function renderGrades(course, rows) {
  return [frontmatter('uni', course.course_code), `# ${course.course_code} gradebook`, '',
    '| Item | Score | Possible | Status | Due |', '|---|---:|---:|---|---|',
    ...rows.map(row => { const data=parseJson(row.json); const column=data.gradebookColumn||{}; return `| ${cell(row.title || column.name || column.title || data.columnId)} | ${cell(row.score)} | ${cell(data.pointsPossible)} | ${cell(row.status)} | ${cell(row.due_at || column.dueDate)} |`; }), ''];
}

function renderMessages(course, rows) {
  const lines = [frontmatter('uni', course.course_code), `# ${course.course_code} messages`, ''];
  for (const row of rows) {
    const data=parseJson(row.json); lines.push(`## ${row.posted_at || row.id}`, '', `Sender: ${data.sender?.displayName || row.sender_id || 'Unknown'}`, '', bodyText(data), '');
  }
  return lines;
}

function renderDiscussions(course, rows) {
  const lines = [frontmatter('uni', course.course_code), `# ${course.course_code} discussions`, ''];
  for (const row of rows) {
    const data=parseJson(row.json); lines.push(`## ${row.subject || row.posted_at || row.id}`, '', row.posted_at ? `Posted: ${row.posted_at}` : '', '', bodyText(data), '');
  }
  return lines;
}

function renderSchedule(course, rows) {
  return [frontmatter('uni', course.course_code), `# ${course.course_code} schedule`, '',
    '| Item | Start | End |', '|---|---|---|', ...rows.map(row => `| ${cell(row.title)} | ${cell(row.start_at)} | ${cell(row.end_at)} |`), ''];
}

function connectMainNote(directory, code, name) {
  const candidates = fs.readdirSync(directory).filter(file => file.endsWith('.md') && file !== 'MyAberdeen Archive.md');
  const exact = `${path.basename(directory)}.md`;
  let main = candidates.includes(exact) ? exact : candidates.filter(file => file.startsWith(code)).sort((a,b) => a.length - b.length)[0];
  if (!main) {
    main = `${safeFilename(code)} - ${safeFilename(cleanCourseName(name, code))}.md`;
    writeMarkdown(path.join(directory, main), [`# ${name}`, '']);
  }
  const generatedBlock = '\n## MyAberdeen archive\n\n- [Offline course archive](MyAberdeen/Index.md)\n';
  for (const candidate of candidates) {
    if (candidate === main) continue;
    const candidatePath = path.join(directory, candidate);
    const candidateText = fs.readFileSync(candidatePath, 'utf8');
    if (candidateText.includes(generatedBlock)) fs.writeFileSync(candidatePath, candidateText.replaceAll(generatedBlock, ''), { mode: 0o600 });
  }
  const target = path.join(directory, main);
  const text = fs.readFileSync(target, 'utf8');
  if (!text.includes('MyAberdeen/Index.md')) {
    fs.appendFileSync(target, generatedBlock, { mode: 0o600 });
  }
}

function frontmatter(type, courseCode) {
  return `---\ntype: ${type}\nscope: module\nupdated: ${new Date().toISOString().slice(0,10)}\ncourse: ${courseCode}\ntags:\n  - myaberdeen\n  - offline-archive\n---`;
}

function bodyText(data) {
  const value = data?.body?.rawText || data?.body?.displayText || data?.message || data?.description || '';
  return stripHtml(String(value)) || '_No text body._';
}

function stripHtml(value) {
  return value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
}

function cleanCourseName(name, code) {
  return String(name || code).replace(new RegExp(`^${code}[^:]*:\\s*`), '').replace(/^\S+\s*\(\d{4}-\d{2}\):\s*/, '').trim() || code;
}

function academicYear(termName) {
  if (String(termName).includes('2023-24')) return 'Year 1';
  if (String(termName).includes('2024-25')) return 'Year 2';
  if (String(termName).includes('2025-26')) return 'Year 3';
  if (String(termName).includes('2026-27')) return 'Year 4';
  return 'Unsorted';
}

function baseCourseCode(value) {
  const text=String(value||''); if(text.startsWith('MGD_CS3026')) return 'CS3026'; return text.match(/^([A-Z]{2}(?:\d{4}|\d{3}[A-Z]))_\d{2}$/)?.[1]||text;
}
function walkFiles(root,out=[]){for(const entry of fs.readdirSync(root,{withFileTypes:true})){const target=path.join(root,entry.name);if(entry.isDirectory())walkFiles(target,out);else out.push(target);}return out;}
function hash(body){return crypto.createHash('sha256').update(body).digest('hex');}
function isWithin(target,root){const relative=path.relative(root,target);return relative && !relative.startsWith('..')&&!path.isAbsolute(relative);}
function parseJson(value){try{return JSON.parse(value);}catch{return {};}}
function writeMarkdown(target,lines){fs.writeFileSync(target,Array.isArray(lines)?`${lines.join('\n')}\n`:lines,{mode:0o600});}
function cell(value){return String(value??'').replace(/\|/g,'\\|').replace(/\s+/g,' ').trim();}
function escapeMarkdown(value){return String(value??'').replace(/[\[\]]/g,'\\$&');}
function fileLink(value){return pathToFileURL(value).href.replace(/\(/g,'%28').replace(/\)/g,'%29');}
function formatBytes(value){if(value==null)return 'unknown size';if(value<1024)return `${value} B`;if(value<1048576)return `${(value/1024).toFixed(1)} KiB`;return `${(value/1048576).toFixed(1)} MiB`;}
