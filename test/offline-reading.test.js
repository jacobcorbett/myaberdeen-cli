import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ArchiveDatabase } from '../src/database.js';
import { parseArgs } from '../src/cli-options.js';
import { OFFLINE_READ_COMMANDS, readCourseItems, renderCourseItems } from '../src/offline-reading.js';

const courses = [{ id: 'course-a', courseId: 'EX1000', name: 'Synthetic course A' }, { id: 'course-b', courseId: 'EX2000', name: 'Synthetic course B' }];
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myab-offline-reading-'));
  const filename = path.join(dir, 'archive.sqlite');
  const database = new ArchiveDatabase(filename);
  t.after(() => { try { database.close(); } catch (e) { if (e.code !== 'ERR_INVALID_STATE') throw e; } fs.rmSync(dir, { recursive: true, force: true }); });
  const run = database.startRun();
  for (const course of courses) {
    database.upsertCourse(course, course.id === 'course-a' ? 'Synthetic term A' : 'Synthetic term B');
    database.upsertAnnouncement(course.id, { id: 'same-id', title: 'Example & announcement', created: '2026-01-01T12:00:00+02:00',
      body: { rawText: '<p>First &amp; second</p><p>Next line<br>Last line</p><script>hidden-script</script><style>hidden-style</style>' } });
    database.upsertAnnouncement(course.id, { id: 'newer', title: 'Latest example', created: '2026-01-01T10:30:00Z', body: 'Plain body', sender: { displayName: 'Example Sender' } });
    database.upsertGrade(course.id, { id: 'grade-zero', score: 0, pointsPossible: 10, status: 'GRADED', gradebookColumn: { effectiveColumnName: 'Example assessment', dueDate: '2026-02-01T12:00:00Z' } });
    database.upsertGrade(course.id, { id: 'grade-pending', status: 'NEEDS_GRADING', gradebookColumn: { effectiveColumnName: 'Example pending item', possible: 20 } });
    for (const conversation of ['conversation-one', 'conversation-two']) {
      database.upsertConversation(course.id, { id: conversation, subject: `Example ${conversation}`, participants: [{ id: 'synthetic-person' }] });
      database.upsertMessage(course.id, conversation, { id: 'same-message-id', postDate: '2026-01-01T00:00:00Z', sender: { id: 'synthetic-person', displayName: 'Example Person' }, body: { displayText: '<p>Example message content</p>' } });
    }
    database.upsertDiscussionPost(course.id, 'forum-one', { id: 'post', threadId: 'thread', subject: 'Example discussion', userId: 'synthetic-author', postDate: '2026-01-02T00:00:00Z', body: { rawText: '<p>Root post</p>' } });
    database.upsertDiscussionPost(course.id, 'forum-one', { id: 'reply', threadId: 'thread', parentId: 'post', subject: 'Example reply', userId: 'synthetic-author', postDate: '2026-01-03T00:00:00Z', body: { rawText: '<p>Reply content</p>' } });
    for (const section of OFFLINE_READ_COMMANDS) database.finishSection(run, course.id, section, 'completed');
  }
  database.finishRun(run, 'completed', 2);
  const rows = database.db.prepare('SELECT * FROM courses ORDER BY id').all();
  return { dir, database, filename, courses: rows };
}

test('offline readers scope courses and preserve raw payloads, archive provenance and conversation/thread context', t => {
  const f = fixture(t);
  for (const command of OFFLINE_READ_COMMANDS) {
    const [result] = readCourseItems(f.database, [f.courses[0]], command);
    assert.equal(result.courseId, 'course-a');
    assert.equal(result.totalItems, 2);
    assert.equal(result.section.status, 'completed');
    assert.equal(result.section.stale, false);
    assert.ok(result.items.every(item => item._archive.presence === 'current' && item._archive.archivedAt));
  }
  const [messages] = readCourseItems(f.database, [f.courses[0]], 'messages');
  assert.equal(new Set(messages.items.map(m => m._context.conversationId)).size, 2);
  assert.equal(messages.items[0]._context.conversation.participants[0].id, 'synthetic-person');
  const [discussions] = readCourseItems(f.database, [f.courses[0]], 'discussions', { id: 'reply' });
  assert.equal(discussions.items[0]._context.parentId, 'post');
  assert.equal(discussions.items[0]._context.threadId, 'thread');
  assert.equal(discussions.items[0]._context.forumId, 'forum-one');
  assert.match(readCourseItems(f.database, [f.courses[0]], 'announcements')[0].items[1].body.rawText, /<p>/);
});

test('filters run before per-course limits, dates sort by instant, and messages retain duplicate IDs across conversations', t => {
  const f = fixture(t);
  const [all] = readCourseItems(f.database, [f.courses[0]], 'announcements');
  assert.equal(all.items[0].id, 'newer');
  const results = readCourseItems(f.database, f.courses, 'announcements', { search: 'FIRST & SECOND', limit: 1 });
  assert.ok(results.every(r => r.items.length === 1 && r.items[0].id === 'same-id' && r.matchedItems === 1 && r.totalItems === 2));
  assert.equal(readCourseItems(f.database, [f.courses[0]], 'messages', { id: 'same-message-id' })[0].items.length, 2);
  assert.equal(readCourseItems(f.database, [f.courses[0]], 'messages', { search: 'conversation-two' })[0].items.length, 1);
  assert.equal(readCourseItems(f.database, [f.courses[0]], 'announcements', { search: 'hidden-script' })[0].items.length, 0);
});

test('readable output strips HTML, preserves paragraphs and zero scores, and labels message/discussion relationships', t => {
  const f = fixture(t);
  const announcements = renderCourseItems(readCourseItems(f.database, [f.courses[0]], 'announcements'));
  assert.match(announcements, /First & second\n\nNext line\nLast line/);
  assert.doesNotMatch(announcements, /<p>|hidden-script|hidden-style/);
  const grades = renderCourseItems(readCourseItems(f.database, [f.courses[0]], 'grades'));
  assert.match(grades, /Score: 0 \/ 10/);
  assert.match(grades, /Score: not supplied \/ 20/);
  assert.match(grades, /Example assessment/);
  assert.match(renderCourseItems(readCourseItems(f.database, [f.courses[0]], 'messages')), /Conversation: conversation-one/);
  assert.match(renderCourseItems(readCourseItems(f.database, [f.courses[0]], 'discussions')), /Forum: forum-one\. Thread: thread\. Parent: post/);
});

test('historical records and denied/stale sections remain visible with honest status', t => {
  const f = fixture(t), run = f.database.startRun();
  f.database.finishSection(run, 'course-a', 'announcements', 'completed');
  f.database.finishSection(run, 'course-a', 'messages', 'unavailable');
  f.database.finishSection(run, 'course-a', 'grades', 'partial');
  f.database.finishRun(run, 'partial', 1);
  const [announcements] = readCourseItems(f.database, [f.courses[0]], 'announcements');
  assert.ok(announcements.items.every(item => item._archive.presence === 'historical'));
  assert.match(renderCourseItems([announcements]), /Visibility: historical/);
  assert.equal(readCourseItems(f.database, [f.courses[0]], 'messages')[0].section.accessible, false);
  assert.equal(readCourseItems(f.database, [f.courses[0]], 'grades')[0].section.stale, true);
  f.database.db.prepare("UPDATE sync_sections SET checked_at='2000-01-01T00:00:00Z'").run();
  assert.equal(readCourseItems(f.database, [f.courses[0]], 'announcements')[0].section.stale, true);
});

test('empty, never-checked and filtered-out sections are distinguishable', t => {
  const f = fixture(t);
  const empty = { id: 'empty-course', course_code: 'EX3000' };
  const [unseen] = readCourseItems(f.database, [empty], 'announcements');
  assert.equal(unseen.section.status, 'never-checked');
  assert.match(renderCourseItems([unseen]), /does not establish that the section is empty/);
  f.database.finishSection(f.database.startRun(), empty.id, 'announcements', 'completed');
  assert.match(renderCourseItems(readCourseItems(f.database, [empty], 'announcements')), /No records were returned/);
  assert.match(renderCourseItems(readCourseItems(f.database, [f.courses[0]], 'announcements', { search: 'does-not-match' })), /No matching cached records/);
});

test('all four CLI commands support scoped JSON/text, profile/term selection, and never open Chrome or change the database', t => {
  const f = fixture(t); f.database.close();
  const configPath = path.join(f.dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ profiles: { current: ['course-a'] } }));
  const env = { ...process.env, MYAB_CONFIG: configPath, MYAB_DATABASE: f.filename, MYAB_STATE_DIR: path.join(f.dir, 'unused-state'), MYAB_CHROME: path.join(f.dir, 'not-chrome') };
  const hash = () => createHash('sha256').update(fs.readFileSync(f.filename)).digest('hex');
  const before = hash();
  for (const command of OFFLINE_READ_COMMANDS) for (const format of ['json', 'text']) {
    const result = spawnSync(process.execPath, ['src/cli.js', command, '--active', '--format', format, '--limit', '1'], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    if (format === 'json') { const parsed = JSON.parse(result.stdout); assert.equal(parsed.length, 1); assert.equal(parsed[0].courseId, 'course-a'); assert.equal(parsed[0].items.length, 1); }
    else assert.match(result.stdout, /EX1000/);
  }
  const byTerm = spawnSync(process.execPath, ['src/cli.js', 'announcements', '--term', 'Synthetic term B'], { encoding: 'utf8', env });
  assert.equal(byTerm.status, 0, byTerm.stderr);
  assert.equal(JSON.parse(byTerm.stdout)[0].courseId, 'course-b');
  assert.equal(hash(), before);
  assert.equal(fs.existsSync(env.MYAB_STATE_DIR), false);
});

test('reading commands validate scope, format, limit and reject network options', () => {
  for (const command of OFFLINE_READ_COMMANDS) {
    assert.throws(() => parseArgs([command]));
    assert.throws(() => parseArgs([command, '--all', '--format', 'srt']));
    assert.throws(() => parseArgs([command, '--all', '--headed']));
    assert.throws(() => parseArgs([command, '--all', '--limit', '0']));
    assert.equal(parseArgs([command, '--course', 'EX1000', '--search', 'example', '--id', 'item', '--limit', '2', '--format', 'text']).options.limit, 2);
  }
});

test('readable output removes terminal escape sequences and escapes Markdown links', t => {
  const f = fixture(t);
  f.database.upsertAnnouncement('course-a', { id: 'untrusted', title: '\x1b[31m[title](https://example.test)', body: '<p>Body \x1b[0m</p>' });
  const text = renderCourseItems(readCourseItems(f.database, [f.courses[0]], 'announcements'));
  assert.ok(!text.includes('\x1b'));
  assert.ok(text.includes('\\[title\\]'));
});
