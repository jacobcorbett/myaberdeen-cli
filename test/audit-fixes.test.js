import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ArchiveDatabase } from '../src/database.js';
import { syncArchive } from '../src/sync.js';
import { getAllPages, normaliseAvailability, selectCourses } from '../src/api.js';
import { BlackboardSession, AuthenticationRequiredError } from '../src/browser.js';
import { downloadContentFile, safeFilename } from '../src/downloads.js';
import { mergeVault } from '../src/merge.js';
import { exportArchive } from '../src/export.js';
import { atomicWrite, hash, acquireLock } from '../src/io.js';
import { verifyFiles, relocationPlan, applyRelocation } from '../src/health.js';
import { parseArgs } from '../src/cli-options.js';

const baseUrl = 'https://abdn.blackboard.com';
const course = { id: 'course', courseId: 'CS1000_27', name: 'Test course', termId: 'term', isAvailable: true };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myab-fixed-'));
  const config = { baseUrl, databasePath: path.join(root, 'archive.sqlite'), downloadDir: path.join(root, 'downloads'), vaultRoot: path.join(root, 'vault'), academicStartYear: 2023 };
  const database = new ArchiveDatabase(config.databasePath);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, config, database };
}
function sessionFor(handler = () => undefined) {
  const calls = [];
  return { calls, async getJson(route) {
    const p = new URL(route, baseUrl).pathname; calls.push(p);
    const custom = await handler(p); if (custom !== undefined) return custom;
    if (p === '/learn/api/v1/users/me') return { id: 'user' };
    if (p.endsWith('/memberships')) return { results: [{ course }] };
    if (p.endsWith('/terms')) return { results: [{ id: 'term', name: 'Term 1, 2026-27' }] };
    if (p === '/learn/api/v1/courses/course') return course;
    return { results: [] };
  } };
}

test('failed detail refresh preserves full body and reports partial, then retries despite unchanged summary', async t => {
  const { database, config } = fixture(t);
  const old = { id: 'doc', title: 'Document', body: { rawText: 'valuable archived body' } };
  database.upsertContent(course.id, 'ROOT', old);
  let fails = true, detailCalls = 0;
  const session = sessionFor(p => {
    if (p.endsWith('/ROOT/children')) return { results: [{ id: 'doc', title: 'New title' }] };
    if (p.endsWith('/contents/doc')) { detailCalls++; if (fails) throw new Error('503'); return { ...old, title: 'New title' }; }
  });
  const result = await syncArchive({ session, database, config });
  assert.equal(result.status, 'partial'); assert.equal(database.getContent(course.id, 'doc').body.rawText, old.body.rawText);
  assert.equal(database.getSummary(course.id, 'doc').detail_status, 'stale');
  fails = false; await syncArchive({ session, database, config }); assert.equal(detailCalls, 2);
  await syncArchive({ session, database, config }); assert.equal(detailCalls, 2);
});

test('failed folder does not prevent sibling traversal or mark prior rows removed', async t => {
  const { database, config } = fixture(t);
  database.upsertContent(course.id, 'bad', { id: 'old', title: 'Preserve visibility' });
  const folders = ['bad', 'good'].map(id => ({ id, hasChildren: true }));
  const session = sessionFor(p => {
    if (p.endsWith('/ROOT/children')) return { results: folders };
    if (p.endsWith('/contents/bad') || p.endsWith('/contents/good')) return folders.find(x => p.endsWith('/' + x.id));
    if (p.endsWith('/bad/children')) throw new Error('403');
    if (p.endsWith('/good/children')) return { results: [{ id: 'child' }] };
    if (p.endsWith('/contents/child')) return { id: 'child' };
  });
  const result = await syncArchive({ session, database, config });
  assert.equal(result.status, 'partial'); assert.ok(database.getContent(course.id, 'child'));
  assert.equal(database.changes().some(c => c.kind === 'no-longer-visible'), false);
});

test('direct forums and nested replies are archived without cycles', async t => {
  const { database, config } = fixture(t);
  const item = { id: 'forum-item', contentDetail: { 'resource/x-bb-forumlink': { id: 'forum' } } };
  const session = sessionFor(p => {
    if (p.endsWith('/ROOT/children')) return { results: [item] };
    if (p.endsWith('/contents/forum-item')) return item;
    if (p.endsWith('/forums/forum/messages')) return { results: [{ id: 'thread' }] };
    if (p.endsWith('/thread/replies')) return { results: [{ id: 'reply', parentId: 'thread' }] };
    if (p.endsWith('/reply/replies')) return { results: [{ id: 'nested', parentId: 'reply' }] };
    if (p.endsWith('/nested/replies')) return { results: [{ id: 'reply' }] };
  });
  const result = await syncArchive({ session, database, config });
  assert.equal(result.status, 'completed'); assert.equal(database.status().counts.discussion_posts, 3);
});

test('mid-sync authentication expiry stops immediately and keeps an explicit run status', async t => {
  const { database, config } = fixture(t); let expired = false, failures = 0;
  const session = sessionFor(p => { if (p.endsWith('/ROOT/children')) expired = true; if (expired) { failures++; throw new AuthenticationRequiredError(); } });
  await assert.rejects(syncArchive({ session, database, config }), AuthenticationRequiredError);
  assert.equal(failures, 1); assert.equal(database.status().lastRun.status, 'authentication-required');
});

test('cancelled sync records cancellation and stops further reads', async t => {
  const { database, config } = fixture(t); const controller = new AbortController();
  const session = sessionFor(p => { if (p.endsWith('/courses/course')) controller.abort(new Error('cancelled')); });
  await assert.rejects(syncArchive({ session, database, config, signal: controller.signal }), /cancelled/);
  assert.equal(database.status().lastRun.status, 'cancelled');
});

test('complete disappearance is historical, reappearance restores, unchanged runs add no changes', async t => {
  const { database, config } = fixture(t); let present = true;
  const session = sessionFor(p => {
    if (p.endsWith('/ROOT/children')) return { results: present ? [{ id: 'doc', title: 'Document' }] : [] };
    if (p.endsWith('/contents/doc')) return { id: 'doc', title: 'Document' };
  });
  await syncArchive({ session, database, config }); const count = database.changes().length;
  await syncArchive({ session, database, config }); assert.equal(database.changes().length, count);
  present = false; await syncArchive({ session, database, config });
  assert.equal(database.changes().at(-1).kind, 'no-longer-visible'); assert.ok(database.getContent(course.id, 'doc'));
  exportArchive(database, config);
  const json = JSON.parse(fs.readFileSync(path.join(config.downloadDir, 'Term 1, 2026-27', course.courseId, '_course-data/content.json')));
  assert.equal(json[0]._archive.presence, 'historical');
  present = true; await syncArchive({ session, database, config }); assert.equal(database.changes().at(-1).kind, 'restored');
});

test('pagination rejects unexpected response shapes, repeated pages and silent truncation', async () => {
  await assert.rejects(getAllPages({ getJson: async () => ({ items: [] }) }, '/items'), /Unexpected/);
  await assert.rejects(getAllPages({ getJson: async () => ({ results: [{ id: 1 }, { id: 2 }] }) }, '/items', { limit: 2 }), /no progress/);
  let id = 0; await assert.rejects(getAllPages({ getJson: async () => ({ results: [{ id: ++id }, { id: ++id }] }) }, '/items', { limit: 2, maxItems: 3 }), /incomplete/);
});

test('availability preserves true, false and unknown; exact course selectors take precedence', () => {
  assert.equal(normaliseAvailability({ isAvailable: true }), 1); assert.equal(normaliseAvailability({ isAvailable: false }), 0); assert.equal(normaliseAvailability({}), null);
  assert.deepEqual(selectCourses([{ id: 'one', courseId: 'CS1000' }, { id: 'two', courseId: 'CS1000_27' }], 'CS1000').map(c => c.id), ['one']);
  assert.throws(() => parseArgs(['download']), /Choose/);
  assert.throws(() => parseArgs(['merge-vault', '--course', 'CS1000', '--headed']), /Unsupported/);
});

test('conditional file requests establish a trusted baseline and repair missing cached files', async t => {
  const { database, config } = fixture(t); const conditions = []; let version = 'one';
  const session = { getBinary: async (route, options = {}) => {
    conditions.push(options);
    if (options.etag === version) return { notModified: true, etag: version };
    return { body: Buffer.from(version), etag: version, contentType: 'application/pdf' };
  } };
  const args = { session, database, downloadRoot: config.downloadDir, course, item: { id: 'file', title: 'slides.pdf' } };
  const first = await downloadContentFile(args); assert.equal(conditions[0].etag, undefined);
  assert.equal((await downloadContentFile(args)).notModified, true);
  version = 'two'; const second = await downloadContentFile(args); assert.notEqual(second.path, first.path);
  assert.equal((await downloadContentFile(args)).notModified, true);
  fs.unlinkSync(second.path); assert.equal((await downloadContentFile(args)).downloaded, true); assert.equal(conditions.at(-1).etag, undefined);
  assert.equal(database.db.prepare('SELECT count(*) n FROM file_versions').get().n, 2);
});

test('unchanged hash-suffixed versions do not rewrite files even without HTTP validators', async t => {
  const { database, config } = fixture(t); let body = 'one';
  const args = { session: { getBinary: async () => ({ body: Buffer.from(body), contentType: 'application/pdf' }) }, database, downloadRoot: config.downloadDir, course, item: { id: 'file', title: 'slides.pdf' } };
  await downloadContentFile(args); body = 'two'; const result = await downloadContentFile(args);
  const before = fs.statSync(result.path).mtimeMs;
  assert.equal((await downloadContentFile(args)).downloaded, false); assert.equal(fs.statSync(result.path).mtimeMs, before);
});

test('conditional headers survive file redirects without session headers and 304 consumes no body', async () => {
  const session = new BlackboardSession({ baseUrl }); session.xsrfToken = 'test-secret';
  session.context = { request: { get: async () => ({ status: () => 302, headers: () => ({ location: 'https://files.blackboard.com/file' }), dispose: async () => {} }) } };
  session.fileRequest = { get: async (url, options) => {
    assert.deepEqual(options.headers, { Accept: '*/*', 'If-None-Match': 'opaque' });
    return { status: () => 304, headers: () => ({ etag: 'opaque' }), body: () => { throw new Error('Must not consume 304 body'); }, dispose: async () => {} };
  } };
  assert.equal((await session.getBinary('/file', { etag: 'opaque' })).notModified, true);
});

test('429 retries are bounded while 403 is not retried', async () => {
  const session = new BlackboardSession({ baseUrl }); session.xsrfToken = 'test'; let calls = 0;
  session.context = { request: { get: async () => { calls++; return { status: () => calls < 3 ? 429 : 403, headers: () => ({ 'retry-after': '0' }), ok: () => false, dispose: async () => {} }; } } };
  await assert.rejects(session.getJson('/items'), /403/); assert.equal(calls, 3);
});

test('browser navigation errors redact authentication URLs', async () => {
  const session = new BlackboardSession({ baseUrl }); session.page = { reload: async () => { throw new Error('Navigation https://login.example/?code=synthetic-secret failed'); } };
  await assert.rejects(session.ensureAuthentication(), e => !e.message.includes('synthetic-secret') && e.message.includes('redacted'));
});

test('scoped merge keeps other-course files/notes and prefers same-course duplicates', t => {
  const { database, config } = fixture(t); const raw = path.join(config.downloadDir, 'handout.pdf'); const body = Buffer.from('handout');
  fs.mkdirSync(config.downloadDir); fs.writeFileSync(raw, body);
  for (const code of ['CS1000', 'CS2000']) {
    const directory = path.join(config.vaultRoot, 'Uni/Year 4/Courses', `${code} - Test course`);
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'handout.pdf'), body);
    database.upsertCourse({ ...course, id: code, courseId: `${code}_27` }, 'Term 1, 2026-27');
  }
  database.upsertFile({ courseId: 'CS2000', contentId: 'file', title: 'handout.pdf', sourceUrl: '/file', localPath: raw, sha256: hash(body), byteSize: body.length });
  const preview = mergeVault(database, config, { courseIds: ['CS1000'], dryRun: true }); assert.equal(preview.duplicateRemovals.length, 0);
  mergeVault(database, config, { courseIds: ['CS1000'] }); assert.ok(fs.existsSync(raw));
  assert.equal(fs.existsSync(path.join(config.vaultRoot, 'Uni/Year 4/Courses/CS2000 - Test course/MyAberdeen/Index.md')), false);
  mergeVault(database, config, { courseIds: ['CS2000'] });
  assert.match(database.getFile('CS2000', 'file').local_path, /CS2000/);
  assert.equal(database.db.prepare('SELECT count(*) n FROM local_files WHERE course_code IS NULL').get().n, 0);
});

test('same module in different years keeps separate generated archives', t => {
  const { database, config } = fixture(t); fs.mkdirSync(path.join(config.vaultRoot, 'Uni'), { recursive: true });
  database.upsertCourse({ ...course, id: 'old', courseId: 'CS1000_26' }, 'Term 1, 2025-26');
  database.upsertCourse({ ...course, id: 'new', courseId: 'CS1000_27' }, 'Term 1, 2026-27');
  mergeVault(database, config);
  for (const [year, id] of [['Year 3', 'old'], ['Year 4', 'new']]) assert.ok(fs.readFileSync(path.join(config.vaultRoot, `Uni/${year}/Courses/CS1000 - Test course/MyAberdeen/Index.md`), 'utf8').includes('`' + id + '`'));
});

test('relocation checks destination hashes and updates catalogue without deleting source files', t => {
  const { database, config, root } = fixture(t); const to = path.join(root, 'NAS'); fs.mkdirSync(to); fs.mkdirSync(config.downloadDir);
  const fromFile = path.join(config.downloadDir, 'file.pdf'), destination = path.join(to, 'file.pdf');
  fs.writeFileSync(fromFile, 'good'); fs.writeFileSync(destination, 'wrong');
  database.upsertFile({ courseId: 'course', contentId: 'file', title: 'file.pdf', sourceUrl: '/file', localPath: fromFile, sha256: hash('good'), byteSize: 4 });
  assert.equal(relocationPlan(database, { from: config.downloadDir, to }).plan.length, 0);
  fs.writeFileSync(destination, 'good'); const plan = relocationPlan(database, { from: config.downloadDir, to });
  assert.equal(applyRelocation(database, plan), 1); assert.ok(fs.existsSync(fromFile)); assert.equal(database.getFile('course', 'file').local_path, destination);
  assert.equal(verifyFiles(database).verified, 1);
});

test('atomic writes leave unchanged content untouched and handle multibyte filenames', t => {
  const { root } = fixture(t), target = path.join(root, 'notes.md');
  assert.equal(atomicWrite(target, 'content'), true); const before = fs.statSync(target).mtimeMs;
  assert.equal(atomicWrite(target, 'content'), false); assert.equal(fs.statSync(target).mtimeMs, before);
  assert.ok(Buffer.byteLength(safeFilename('界'.repeat(180))) <= 180);
});

test('archive lock excludes another process and read-only inspection creates no backup', t => {
  const { root, config } = fixture(t); const release = acquireLock(root);
  assert.throws(() => acquireLock(root), /Another/); release(); const second = acquireLock(root); second();
  const read = new ArchiveDatabase(config.databasePath, { readOnly: true }); read.close(); assert.equal(fs.readdirSync(root).some(p => p.endsWith('.bak')), false);
});

test('CLI scope rejection occurs before opening Chrome or creating state', t => {
  const { root } = fixture(t), state = path.join(root, 'state');
  const run = spawnSync(process.execPath, ['src/cli.js', 'download'], { encoding: 'utf8', env: { ...process.env, MYAB_STATE_DIR: state } });
  assert.equal(run.status, 1); assert.match(run.stderr, /Choose/); assert.equal(fs.existsSync(state), false);
});

test('metadata refresh preserves grade-column detail after a failed column lookup', async t => {
  const { database, config } = fixture(t);
  database.upsertGrade(course.id, { id: 'grade', score: 1, gradebookColumn: { id: 'column', columnName: 'Assessment' } });
  const session = sessionFor(p => {
    if (p.endsWith('/gradebook/grades')) return { results: [{ id: 'grade', score: 2, columnUrl: '/column' }] };
    if (p === '/column') throw new Error('503');
  });
  const result = await syncArchive({ session, database, config });
  const row = database.db.prepare('SELECT * FROM grades').get();
  assert.equal(result.status, 'partial'); assert.equal(row.title, 'Assessment'); assert.equal(row.score, 2);
});

test('resuming a bounded file run advances past already completed files', async t => {
  const { database, config } = fixture(t); const files = ['one', 'two'].map(id => ({ id, title: id + '.pdf', contentHandler: { id: 'resource/x-bb-file' } }));
  const session = sessionFor(p => { if (p.endsWith('/ROOT/children')) return { results: files }; return files.find(f => p.endsWith('/contents/' + f.id)); });
  session.getBinary = async () => ({ body: Buffer.from('file'), contentType: 'application/pdf' });
  const first = await syncArchive({ session, database, config, downloadFiles: true, limitFiles: 1 });
  assert.equal(first.deferredFiles, 1);
  const second = await syncArchive({ session, database, config, downloadFiles: true, limitFiles: 1, resumeFrom: first.runId });
  assert.equal(second.status, 'completed'); assert.equal(database.status().counts.files, 2);
});

test('binary content changes produce change events even when item metadata stays the same', async t => {
  const { database, config } = fixture(t); let body = 'one';
  const args = { session: { getBinary: async () => ({ body: Buffer.from(body), contentType: 'application/pdf' }) }, database, downloadRoot: config.downloadDir, course, item: { id: 'file', title: 'slides.pdf' } };
  database.startRun(); await downloadContentFile(args); database.finishRun(database.activeRunId, 'completed', 1);
  database.startRun(); body = 'two'; await downloadContentFile(args);
  assert.equal(database.changes().at(-1).dataset, 'files'); assert.equal(database.changes().at(-1).kind, 'changed');
});

test('unchanged source extraction reuses text by SHA and extractor version', async t => {
  const { database, config, root } = fixture(t); config.stateDir = path.join(root, 'state');
  const file = path.join(root, 'notes.txt'); fs.writeFileSync(file, 'Lecture content');
  database.upsertFile({ courseId: course.id, contentId: 'file', title: 'notes.txt', sourceUrl: '/file', localPath: file, sha256: hash('Lecture content'), byteSize: 15 });
  const { extractFiles } = await import('../src/extract.js');
  assert.equal(extractFiles(database, config).extracted, 1);
  const row = database.db.prepare('SELECT * FROM text_extractions').get(); const before = fs.statSync(row.local_path).mtimeMs;
  assert.equal(extractFiles(database, config).cached, 1); assert.equal(fs.statSync(row.local_path).mtimeMs, before);
});

test('legacy migration creates a private consistent backup and repairs availability', t => {
  const { root } = fixture(t); const target = path.join(root, 'legacy.sqlite');
  const old = new DatabaseSync(target);
  old.exec('CREATE TABLE courses(id TEXT PRIMARY KEY,course_code TEXT,name TEXT,term_id TEXT,term_name TEXT,available INTEGER,synced_at TEXT,json TEXT)');
  old.prepare('INSERT INTO courses VALUES(?,?,?,?,?,?,?,?)').run('old', 'CS1000', 'Course', null, null, 0, '2020-01-01', JSON.stringify({ id: 'old', isAvailable: true })); old.close();
  const migrated = new ArchiveDatabase(target);
  try {
    assert.ok(migrated.backupPath);
    // Windows uses inherited ACLs rather than POSIX owner/group/other mode bits.
    if (process.platform !== 'win32') assert.equal(fs.statSync(migrated.backupPath).mode & 0o777, 0o600);
    assert.equal(migrated.db.prepare('SELECT available FROM courses').get().available, 1);
    const previous = new DatabaseSync(migrated.backupPath, { readOnly: true }); assert.equal(previous.prepare('SELECT available FROM courses').get().available, 0); previous.close();
  } finally { migrated.close(); }
});

test('scoped deduplication keeps a raw file still referenced by an unselected course', t => {
  const { database, config } = fixture(t), body = Buffer.from('shared');
  const dir = path.join(config.vaultRoot, 'Uni/Year 4/Courses/CS1000 - Test course'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'file.pdf'), body);
  fs.mkdirSync(config.downloadDir); const raw = path.join(config.downloadDir, 'file.pdf'); fs.writeFileSync(raw, body);
  for (const id of ['selected', 'other']) {
    database.upsertCourse({ ...course, id, courseId: id === 'selected' ? 'CS1000_27' : 'CS2000_27' }, 'Term 1, 2026-27');
    database.upsertFile({ courseId: id, contentId: 'file', title: 'file.pdf', sourceUrl: '/file', localPath: raw, sha256: hash(body), byteSize: body.length });
  }
  assert.equal(mergeVault(database, config, { courseIds: ['selected'], dryRun: true }).duplicateRemovals.length, 0);
  mergeVault(database, config, { courseIds: ['selected'] }); assert.ok(fs.existsSync(raw)); assert.equal(database.getFile('other', 'file').local_path, raw);
});

test('resume preserves bounded settings while allowing an explicit new file limit', async () => {
  const { resumedOptions } = await import('../src/cli-options.js');
  const saved = { downloadFiles: true, deep: true, limitFiles: 2 };
  assert.deepEqual(resumedOptions({ resume: 7 }, saved), { resume: 7, downloadFiles: true, deep: true, limitFiles: 2 });
  assert.equal(resumedOptions({ resume: 7, limitFiles: 4 }, saved).limitFiles, 4);
  assert.equal(resumedOptions({ resume: 7 }, { downloadFiles: false, deep: false, limitFiles: null }).downloadFiles, false);
});

test('change cursors compare ISO offsets correctly and scope before applying the limit', t => {
  const { database } = fixture(t);
  const add = database.db.prepare('INSERT INTO archive_changes(course_id,dataset,record_id,kind,occurred_at) VALUES(?,?,?,?,?)');
  add.run('other', 'content', 'one', 'added', '2026-09-22T10:15:00.000Z');
  add.run('course', 'content', 'two', 'added', '2026-09-22T10:30:00.000Z');
  add.run('course', 'content', 'three', 'added', '2026-09-22T11:30:00.000Z');
  const since = '2026-09-22T11:00:00+01:00';
  assert.equal(parseArgs(['changes', '--since', since]).options.since, '2026-09-22T10:00:00.000Z');
  assert.equal(database.changes({ courseIds: ['course'], since, limit: 1 })[0].record_id, 'two');
  assert.deepEqual(database.changes({ courseIds: [], since }), []);
});

test('invalid freshness configuration fails instead of treating archives as indefinitely fresh', async t => {
  const { root } = fixture(t), configPath = path.join(root, 'config.json');
  const { getConfig } = await import('../src/config.js');
  for (const settings of [{ freshnessMinutes: 'forever' }, { deepCheckHours: -1 }, { deepCheckHours: null }]) {
    fs.writeFileSync(configPath, JSON.stringify(settings));
    assert.throws(() => getConfig({ MYAB_CONFIG: configPath }), /non-negative number/);
  }
});

test('concurrent stale-lock recovery cannot remove a newly acquired writer lock', t => {
  const { root } = fixture(t), target = path.join(root, 'operation.lock');
  const finished = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(finished.status, 0);
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'owner.json'), JSON.stringify({ pid: finished.pid, nonce: 'stale' }));
  const read = fs.readFileSync;
  let competing = false, competingError, competingRelease;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const result = read(file, ...args);
    if (file === path.join(target, 'owner.json') && !competing) {
      competing = true;
      try { competingRelease = acquireLock(root); } catch (error) { competingError = error; }
    }
    return result;
  });
  const release = acquireLock(root);
  try {
    assert.match(competingError?.message || '', /Another/);
    assert.throws(() => acquireLock(root), /Another/);
    assert.equal(fs.existsSync(`${target}.recovery`), false);
  } finally { release(); competingRelease?.(); }
});

test('deduplication keeps version history linked to the surviving canonical file', t => {
  const { database, config } = fixture(t), body = Buffer.from('version');
  const dir = path.join(config.vaultRoot, 'Uni/Year 4/Courses/CS1000 - Test course');
  fs.mkdirSync(dir, { recursive: true }); const canonical = path.join(dir, 'file.pdf'); fs.writeFileSync(canonical, body);
  fs.mkdirSync(config.downloadDir); const raw = path.join(config.downloadDir, 'file.pdf'); fs.writeFileSync(raw, body);
  database.upsertCourse(course, 'Term 1, 2026-27');
  database.upsertFile({ courseId: course.id, contentId: 'file', title: 'file.pdf', sourceUrl: '/file', localPath: raw, sha256: hash(body), byteSize: body.length });
  database.setFileValidators(course.id, 'file');
  mergeVault(database, config, { courseIds: [course.id] });
  assert.equal(fs.existsSync(raw), false);
  assert.equal(database.db.prepare('SELECT local_path FROM file_versions').get().local_path, canonical);
});

test('scoped deduplication preserves a raw file referenced only by another course version', t => {
  const { database, config } = fixture(t), body = Buffer.from('old version');
  const dir = path.join(config.vaultRoot, 'Uni/Year 4/Courses/CS1000 - Test course');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'file.pdf'), body);
  fs.mkdirSync(config.downloadDir); const raw = path.join(config.downloadDir, 'file.pdf'); fs.writeFileSync(raw, body);
  database.upsertCourse(course, 'Term 1, 2026-27');
  database.upsertFile({ courseId: course.id, contentId: 'file', title: 'file.pdf', sourceUrl: '/file', localPath: raw, sha256: hash(body), byteSize: body.length });
  database.setFileValidators(course.id, 'file');
  database.db.prepare('INSERT INTO file_versions VALUES(?,?,?,?,?,?)').run('other', 'old-file', hash(body), raw, body.length, new Date().toISOString());
  assert.deepEqual(mergeVault(database, config, { courseIds: [course.id], dryRun: true }).duplicateRemovals, []);
  mergeVault(database, config, { courseIds: [course.id] });
  assert.equal(fs.existsSync(raw), true);
});

test('cancellation during Chrome launch still closes the context returned after cleanup', async t => {
  const { root, config } = fixture(t), controller = new AbortController();
  Object.assign(config, { stateDir: path.join(root, 'state'), profileDir: path.join(root, 'profile'), chromePath: process.execPath });
  const { chromium } = await import('playwright-core');
  const session = new BlackboardSession(config, { signal: controller.signal });
  let closes = 0;
  t.mock.method(chromium, 'launchPersistentContext', async () => {
    controller.abort(new Error('cancelled during launch'));
    await session.close();
    return { close: async () => { closes++; } };
  });
  await assert.rejects(session.open(), /cancelled during launch/);
  await session.close();
  assert.equal(closes, 1);
});
