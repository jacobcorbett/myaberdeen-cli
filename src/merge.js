import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { safeFilename } from './downloads.js';
import { atomicWrite } from './io.js';
import { baseCourseCode, courseDirectories as findCourseDirectories, resolveCourseDirectory } from './course-paths.js';

export function mergeVault(database, config, { deduplicate = true, courseIds, dryRun = false } = {}) {
  const uniRoot = path.join(config.vaultRoot, 'Uni');
  if (!fs.existsSync(uniRoot)) throw new Error(`University vault not found at ${uniRoot}`);
  const courseDirectories = findCourseDirectories(uniRoot);
  validateDestinations(database, config, courseDirectories, courseIds);
  if (dryRun) return previewMerge(database, config, courseDirectories, courseIds, deduplicate);
  const indexedFiles = indexVaultFiles(database, uniRoot, courseDirectories);
  const dedupe = connectExactDuplicates(database, config, deduplicate, courseIds);
  const integration = integrateCourses(database, config, uniRoot, courseDirectories, courseIds);
  return { indexedFiles, ...dedupe, ...integration };
}

export function indexVaultFiles(database, uniRoot, courseDirectories) {
  const codeByDirectory = [...courseDirectories.entries()].map(([code, directory]) => [directory, code.split(':').at(-1)]);
  let count = 0;
  for (const target of walkFiles(uniRoot)) {
    if (target.endsWith('.md') || target.includes(`${path.sep}.obsidian${path.sep}`)) continue;
    const body = fs.readFileSync(target);
    const courseCode = codeByDirectory.find(([directory]) => target.startsWith(`${directory}${path.sep}`))?.[1] || null;
    database.upsertLocalFile({ path: target, courseCode, sha256: hash(body), byteSize: body.length, source: 'obsidian-vault' });
    count += 1;
  }
  return count;
}

function connectExactDuplicates(database, config, deduplicate, courseIds) {
  const rows = database.db.prepare(`SELECT f.course_id,f.content_id,f.sha256,f.local_path,f.byte_size,c.course_code
    FROM files f JOIN courses c ON c.id=f.course_id WHERE f.local_path IS NOT NULL`).all().filter(row => !courseIds || courseIds.includes(row.course_id));
  const removals = new Map();
  let linkedRecords = 0;
  for (const row of rows) {
    const canonical = database.findLocalFileByHash(row.sha256, baseCourseCode(row.course_code, config));
    if (!canonical || !fs.existsSync(canonical.path)) continue;
    if (hash(fs.readFileSync(canonical.path)) !== row.sha256) continue;
    const oldPath = row.local_path;
    database.db.exec('BEGIN IMMEDIATE');
    try {
      database.db.prepare('UPDATE files SET local_path=? WHERE course_id=? AND content_id=?').run(canonical.path, row.course_id, row.content_id);
      database.db.prepare('UPDATE file_versions SET local_path=? WHERE course_id=? AND content_id=? AND sha256=? AND local_path=?').run(canonical.path, row.course_id, row.content_id, row.sha256, oldPath);
      database.db.exec('COMMIT');
    } catch (error) { database.db.exec('ROLLBACK'); throw error; }
    linkedRecords += 1;
    if (oldPath !== canonical.path && isWithin(oldPath, config.downloadDir)) removals.set(oldPath, row.sha256);
  }
  let removedFiles = 0;
  let removedBytes = 0;
  if (deduplicate) {
    for (const [target, expectedHash] of removals) {
      if (!fs.existsSync(target)) continue;
      if (database.db.prepare('SELECT 1 FROM files WHERE local_path=? UNION ALL SELECT 1 FROM file_versions WHERE local_path=? LIMIT 1').get(target, target)) continue;
      const body = fs.readFileSync(target);
      if (hash(body) !== expectedHash) throw new Error(`Refusing to remove changed file: ${target}`);
      fs.unlinkSync(target);
      removedFiles += 1;
      removedBytes += body.length;
    }
  }
  return { linkedRecords, removedFiles, removedBytes };
}

function integrateCourses(database, config, uniRoot, courseDirectories, courseIds) {
  const courses = database.db.prepare('SELECT * FROM courses ORDER BY term_name,course_code').all().filter(course => !courseIds || courseIds.includes(course.id));
  let moduleCourses = 0;
  let resourceCourses = 0;
  for (const course of courses) {
    const code = baseCourseCode(course.course_code, config);
    const directory = resolveCourseDirectory(course, config, courseDirectories);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (/^[A-Z]{2}(?:\d{4}|\d{3}[A-Z])$/.test(code)) moduleCourses++; else resourceCourses++;
    const ownership = path.join(directory, 'MyAberdeen', 'Index.md');
    if (fs.existsSync(ownership)) {
      const previous = /Blackboard course ID: `([^`]+)`/.exec(fs.readFileSync(ownership, 'utf8'))?.[1];
      if (previous && previous !== course.id) throw new Error(`Course directory belongs to ${previous}; configure a separate path for ${course.id}.`);
    }
    writeCourseIntegration(database, config, course, directory);
    connectMainNote(directory, code, course.name);
  }
  return { moduleCourses, resourceCourses };
}

function writeCourseIntegration(database, config, course, directory) {
  const target = path.join(directory, 'MyAberdeen');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const query = table => database.db.prepare(`SELECT * FROM ${table} WHERE course_id=? ORDER BY rowid`).all(course.id).map(row => ({ ...row, _archive: table === 'files' ? database.fileState(course.id, row.content_id) : database.provenance(table, row) }));
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
    '| Title | Type | Parent | Visibility |', '|---|---|---|---|',
    ...rows.map(row => `| ${cell(row.title)} | ${cell(row.handler)} | ${cell(row.parent_id)} | ${cell(row._archive?.presence)} |`), ''];
}

function renderFiles(course, rows) {
  return [frontmatter('uni', course.course_code), `# ${course.course_code} files`, '',
    ...rows.map(row => `- [${escapeMarkdown(row.title || path.basename(row.local_path || 'file'))}](${row.local_path ? fileLink(row.local_path) : row.source_url}) — ${formatBytes(row.byte_size)} (${row._archive?.presence || 'unknown'})`), ''];
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
    if (candidateText.includes(generatedBlock)) atomicWrite(candidatePath, candidateText.replaceAll(generatedBlock, ''));
  }
  const target = path.join(directory, main);
  const text = fs.readFileSync(target, 'utf8');
  if (!text.includes('MyAberdeen/Index.md')) {
    atomicWrite(target, text + generatedBlock);
  }
}

function frontmatter(type, courseCode) {
  return `---\ntype: ${type}\nscope: module\ncourse: ${courseCode}\ntags:\n  - myaberdeen\n  - offline-archive\n---`;
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

function walkFiles(root,out=[]){for(const entry of fs.readdirSync(root,{withFileTypes:true})){const target=path.join(root,entry.name);if(entry.isDirectory())walkFiles(target,out);else if(entry.isFile())out.push(target);}return out;}
function hash(body){return crypto.createHash('sha256').update(body).digest('hex');}
function isWithin(target,root){const relative=path.relative(root,target);return relative && !relative.startsWith('..')&&!path.isAbsolute(relative);}
function parseJson(value){try{return JSON.parse(value);}catch{return {};}}
function writeMarkdown(target,lines){atomicWrite(target,Array.isArray(lines)?`${lines.join('\n')}\n`:lines);}
function cell(value){return String(value??'').replace(/\|/g,'\\|').replace(/\s+/g,' ').trim();}
function escapeMarkdown(value){return String(value??'').replace(/[\[\]]/g,'\\$&');}
function fileLink(value){return pathToFileURL(value).href.replace(/\(/g,'%28').replace(/\)/g,'%29');}
function formatBytes(value){if(value==null)return 'unknown size';if(value<1024)return `${value} B`;if(value<1048576)return `${(value/1024).toFixed(1)} KiB`;return `${(value/1048576).toFixed(1)} MiB`;}

function previewMerge(database, config, directories, courseIds, deduplicate) {
  const courses = database.db.prepare('SELECT * FROM courses ORDER BY course_code').all().filter(c => !courseIds || courseIds.includes(c.id));
  const hashes = new Map();
  for (const file of walkFiles(path.join(config.vaultRoot, 'Uni'))) if (!file.endsWith('.md')) { const sha = hash(fs.readFileSync(file)); if (!hashes.has(sha)) hashes.set(sha, []); hashes.get(sha).push(file); }
  const removals = [];
  for (const course of courses) for (const row of database.db.prepare('SELECT * FROM files WHERE course_id=?').all(course.id)) {
    if (deduplicate && row.local_path && isWithin(row.local_path, config.downloadDir) && hashes.has(row.sha256) && fs.existsSync(row.local_path) && hash(fs.readFileSync(row.local_path)) === row.sha256 && !database.db.prepare('SELECT course_id FROM files WHERE local_path=? UNION ALL SELECT course_id FROM file_versions WHERE local_path=?').all(row.local_path, row.local_path).some(r => courseIds && !courseIds.includes(r.course_id))) removals.push(row.local_path);
  }
  return { dryRun: true, courses: courses.map(course => ({ id: course.id, directory: resolveCourseDirectory(course, config, directories), notes: ['Index', 'Content', 'Files', 'Announcements', 'Gradebook', 'Messages', 'Discussions', 'Schedule'].map(n => n + '.md') })), duplicateRemovals: [...new Set(removals)] };
}
export function repairLocalIndex(database, config) {
  const root = path.join(config.vaultRoot, 'Uni');
  return indexVaultFiles(database, root, findCourseDirectories(root));
}

function validateDestinations(database, config, directories, courseIds) {
  const planned = new Map();
  for (const course of database.db.prepare('SELECT * FROM courses').all().filter(c => !courseIds || courseIds.includes(c.id))) {
    const target = resolveCourseDirectory(course, config, directories);
    if (planned.has(target) && planned.get(target) !== course.id) throw new Error('Selected courses map to the same directory; configure distinct courseDirectories before merging.');
    planned.set(target, course.id);
    const index = path.join(target, 'MyAberdeen', 'Index.md');
    if (fs.existsSync(index)) {
      const owner = /Blackboard course ID: `([^`]+)`/.exec(fs.readFileSync(index, 'utf8'))?.[1];
      if (owner && owner !== course.id) throw new Error(`Course directory belongs to ${owner}; configure a separate path for ${course.id}.`);
    }
  }
}
