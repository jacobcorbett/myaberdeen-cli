import { parseFragment } from 'parse5';

export const OFFLINE_READ_COMMANDS = ['announcements', 'grades', 'messages', 'discussions'];
const TABLES = { announcements: 'announcements', grades: 'grades', messages: 'messages', discussions: 'discussion_posts' };

function plain(value) {
  if (typeof value !== 'string') return '';
  const block = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'pre']);
  const walk = node => {
    if (['script', 'style'].includes(node.tagName)) return '';
    if (node.nodeName === '#text') return node.value;
    const edge = block.has(node.tagName) ? '\n' : '';
    return edge + (node.tagName === 'br' ? '\n' : '') + (node.childNodes || []).map(walk).join('') + edge;
  };
  return walk(parseFragment(value)).replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function body(data) {
  const value = data.body ?? data.message ?? data.description ?? data.text;
  return plain(typeof value === 'string' ? value : value?.rawText ?? value?.displayText ?? value?.text ?? '');
}
function author(data, fallback) {
  const person = data.sender || data.author || data.user;
  const name = person?.displayName || [person?.givenName, person?.familyName].filter(Boolean).join(' ');
  return name || fallback || null;
}
function context(database, command, row, data) {
  const result = { title: row.title || row.subject || data.subject || null,
    date: command === 'grades' ? row.due_at : row.posted_at || row.created_at || null,
    author: author(data, row.sender_id || row.author_id) };
  if (command === 'grades') Object.assign(result, { score: row.score, status: row.status, dueAt: row.due_at,
    possible: data.pointsPossible ?? data.gradebookColumn?.possible ?? null,
    displayGrade: typeof data.displayGrade === 'string' ? data.displayGrade : data.displayGrade?.displayValue ?? data.grade?.displayValue ?? null });
  if (command === 'messages') {
    const conversation = database.db.prepare('SELECT * FROM conversations WHERE course_id=? AND id=?').get(row.course_id, row.conversation_id);
    Object.assign(result, { conversationId: row.conversation_id, conversation: conversation ? JSON.parse(conversation.json) : null });
    result.title ||= result.conversation?.subject || result.conversation?.title || null;
  }
  if (command === 'discussions') Object.assign(result, { forumId: row.forum_id, threadId: row.thread_id, parentId: row.parent_id });
  return result;
}

export function readCourseItems(database, courses, command, { id, search, limit, freshnessMinutes = 60 } = {}) {
  if (!OFFLINE_READ_COMMANDS.includes(command)) throw new Error('Unsupported offline reading command.');
  const table = TABLES[command], needle = search?.toLocaleLowerCase();
  return courses.map(course => {
    const row = database.sections(course.id).find(s => s.section === command);
    const checkedAt = row?.checked_at || null;
    const age = Date.now() - Date.parse(checkedAt);
    const section = { status: row?.status || 'never-checked', checkedAt,
      stale: !Number.isFinite(age) || age > freshnessMinutes * 60_000 || !['completed', 'unavailable'].includes(row?.status),
      accessible: row ? row.status !== 'unavailable' : null };
    const all = database.db.prepare(`SELECT * FROM ${table} WHERE course_id=?`).all(course.id).map(record => {
      const data = JSON.parse(record.json);
      return { ...data, id: record.id, _context: context(database, command, record, data),
        _archive: { ...database.provenance(table, record), archivedAt: record.synced_at } };
    });
    const filtered = all.filter(item => (!id || item.id === id) && (!needle ||
      [item.id, ...Object.values(item._context).filter(v => typeof v === 'string'), body(item)].join('\n').toLocaleLowerCase().includes(needle)));
    const timestamp = item => { const n = Date.parse(item._context.date); return Number.isFinite(n) ? n : -Infinity; };
    filtered.sort((a, b) => {
      const first = timestamp(a), second = timestamp(b);
      return (first === second ? 0 : first > second ? -1 : 1) ||
        String(a._context.conversationId || a._context.forumId || '').localeCompare(String(b._context.conversationId || b._context.forumId || '')) || a.id.localeCompare(b.id);
    });
    return { courseId: course.id, courseCode: course.course_code || course.courseId || course.id, command, section,
      totalItems: all.length, matchedItems: filtered.length, items: limit ? filtered.slice(0, limit) : filtered };
  });
}

function text(value) {
  return String(value ?? 'not supplied').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, c => c === '\n' || c === '\t' ? c : ' ')
    .replace(/[\\`*_{}[\]()#!|<>]/g, '\\$&');
}
export function renderCourseItems(courses) {
  const lines = ['# Offline course archive', '', 'Cached data only. Section status and check time describe the last refresh; historical records are retained and labelled.', ''];
  for (const course of courses) {
    lines.push(`## ${text(course.courseCode)} — ${text(course.command)}`, '',
      `Section: ${text(course.section.status)}. Checked: ${text(course.section.checkedAt || 'never')}. Stale: ${course.section.stale ? 'yes' : 'no'}.`,
      `Showing ${course.items.length} of ${course.matchedItems} matching records (${course.totalItems} archived).`, '');
    if (!course.items.length) lines.push(course.totalItems ? 'No matching cached records.' :
      course.section.status === 'completed' ? 'No records were returned at the last completed refresh.' :
        'No cached records. This does not establish that the section is empty. Run check for this course and inspect section status.', '');
    for (const item of course.items) {
      const c = item._context;
      lines.push(`### ${text(c.title || item.id)}`, '', `ID: ${text(item.id)}. Visibility: ${text(item._archive.presence)}. Archived: ${text(item._archive.archivedAt)}.`, '');
      if (course.command === 'grades') lines.push(`Score: ${text(c.score)} / ${text(c.possible)}. Display grade: ${text(c.displayGrade)}. Status: ${text(c.status)}. Due: ${text(c.dueAt)}.`, '');
      else lines.push(`Posted: ${text(c.date)}. Author: ${text(c.author)}.`, '');
      if (course.command === 'messages') lines.push(`Conversation: ${text(c.conversationId)}.`, '');
      if (course.command === 'discussions') lines.push(`Forum: ${text(c.forumId)}. Thread: ${text(c.threadId)}. Parent: ${text(c.parentId)}.`, '');
      if (course.command !== 'grades') lines.push(text(body(item) || 'No text body archived.'), '');
    }
  }
  return lines.join('\n') + '\n';
}
