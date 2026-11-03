import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ArchiveDatabase } from '../src/database.js';
import { academicYear } from '../src/course-paths.js';
import { brief, relocationPlan, applyRelocation, verifyFiles, localDoctor } from '../src/health.js';
import { syncPanopto } from '../src/panopto-sync.js';
import { getRecordings, viewerUrl } from '../src/panopto-data.js';
import { getConfig, chromeCandidates, expandHome } from '../src/config.js';
import { setup, normaliseInputPath } from '../src/setup.js';
import { mergeVault } from '../src/merge.js';
import { syncArchive } from '../src/sync.js';
import { hash, acquireLock } from '../src/io.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myab-032-'));
  const db = new ArchiveDatabase(path.join(root, 'archive.sqlite'));
  db.upsertCourse({ id: 'c', courseId: 'CS1000_27', name: 'Synthetic course', isAvailable: true }, '2026-27');
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db };
}
const courses = [{ id: 'c', course_code: 'CS1000_27', name: 'Synthetic', available: 1 }];
const r1 = '11111111-1111-1111-1111-111111111111', r2 = '33333333-3333-3333-3333-333333333333', folder = '22222222-2222-2222-2222-222222222222';
const record = id => ({ record: { id, title: 'Synthetic recording', url: viewerUrl(id), transcripts: {} } });

test('bad config keeps help/version available and exposes paths in diagnostic errors', t => {
  const { root } = fixture(t);
  const configPath = path.join(root, 'broken.json'); fs.writeFileSync(configPath, '{"key":1,}');
  const env = { ...process.env, MYAB_STATE_DIR: root, MYAB_CONFIG: configPath, MYAB_VAULT: '' };
  for (const command of ['help', 'version']) {
    const result = spawnSync(process.execPath, ['src/cli.js', command], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const command of ['paths', 'doctor']) {
    const result = spawnSync(process.execPath, ['src/cli.js', command], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    const data = JSON.parse(result.stdout); assert.equal(data.configPath, configPath);
    assert.match(data.configError, /Invalid MyAberdeen configuration JSON/);
    assert.equal(fs.existsSync(path.join(root, 'chrome-profile')), false);
  }
});

test('brief separates optional checks and inaccessible sections from stale metadata', t => {
  const { root, db } = fixture(t); const run = db.startRun();
  for (const section of ['content', 'announcements', 'grades', 'schedule', 'messages', 'discussions']) db.finishSection(run, 'c', section, section === 'messages' ? 'unavailable' : 'completed');
  db.finishSection(run, 'c', 'files', 'limited');
  db.finishSection(run, 'c', 'panopto', 'partial');
  const course = brief(db, { databasePath: db.path }, ['c']).courses[0];
  assert.equal(course.stale, false); assert.deepEqual(course.staleSections, []);
  assert.equal(course.sectionFreshness.files.stale, true);
  assert.equal(course.sectionFreshness.panopto.stale, true);
  assert.deepEqual(course.inaccessibleSections, ['messages']);
  db.db.prepare("UPDATE sync_sections SET checked_at='2000-01-01' WHERE section='grades'").run();
  assert.deepEqual(brief(db, { databasePath: db.path }, ['c']).courses[0].staleSections, ['grades']);
});

test('brief returns newest twenty per-course changes even outside the global last hundred', t => {
  const { db } = fixture(t); db.db.exec("DELETE FROM archive_changes; DELETE FROM sqlite_sequence WHERE name='archive_changes'");
  const insert = db.db.prepare('INSERT INTO archive_changes(course_id,dataset,record_id,kind,occurred_at) VALUES(?,?,?,?,?)');
  for (let n = 1; n <= 300; n++) insert.run(n <= 150 ? 'c' : 'other', 'content', String(n), 'added', new Date().toISOString());
  assert.deepEqual(brief(db, { databasePath: db.path }, ['c']).courses[0].recentChanges.map(r => r.id), Array.from({ length: 20 }, (_, i) => 131 + i));
});

test('denied Panopto folder falls back to course search and preserves partial coverage', async t => {
  const { db } = fixture(t); let searches = 0;
  const client = { folderSessions: async () => { throw Object.assign(new Error('Synthetic denial'), { status: 403 }); }, searchSessions: async () => { searches++; return [{ Id: r1, FolderName: 'CS1000 2026-27' }]; }, recording: async id => record(id) };
  const result = await syncPanopto({ session: {}, database: db, config: { panoptoFolders: { c: [folder] } }, courses, client });
  assert.equal(searches, 1); assert.equal(result.recordings, 1); assert.equal(result.status, 'partial');
  assert.equal(result.discovery[0].folderInventoryComplete, false);
});

test('explicit folder scans retain previously discovered recordings as current', async t => {
  const { db } = fixture(t);
  const client = { searchSessions: async () => [{ Id: r1, FolderName: 'CS1000 2026-27' }], folderSessions: async () => [{ Id: r2 }], recording: async id => record(id) };
  await syncPanopto({ session: {}, database: db, config: {}, courses, client });
  const result = await syncPanopto({ session: {}, database: db, config: {}, courses, client, folder });
  assert.equal(result.discovery[0].folderInventoryComplete, false);
  assert.equal(getRecordings(db, ['c']).find(r => r.id === r1).presence, 'current');
});

test('complete configured folder traversal still retires genuinely absent recordings', async t => {
  const { db } = fixture(t); let ids = [r1, r2];
  const client = { folderSessions: async () => ids.map(Id => ({ Id })), recording: async id => record(id) };
  const args = { session: {}, database: db, config: { panoptoFolders: { c: [folder] } }, courses, client };
  await syncPanopto(args); ids = [r2]; await syncPanopto(args);
  assert.equal(getRecordings(db, ['c']).find(r => r.id === r1).presence, 'historical');
});

test('relocation covers current files, retained versions and video assets with scope and hash checks', t => {
  const { root, db } = fixture(t); const from = path.join(root, 'old'), to = path.join(root, 'new');
  fs.mkdirSync(from); fs.mkdirSync(to);
  for (const name of ['current.pdf', 'old.pdf', 'video.mp4']) { fs.writeFileSync(path.join(from, name), name); fs.writeFileSync(path.join(to, name), name); }
  db.upsertFile({ courseId: 'c', contentId: 'file', title: 'current.pdf', sourceUrl: '/file', localPath: path.join(from, 'current.pdf'), sha256: hash('current.pdf'), byteSize: 11 });
  db.db.prepare('INSERT INTO file_versions VALUES(?,?,?,?,?,?)').run('c', 'file', hash('old.pdf'), path.join(from, 'old.pdf'), 7, new Date().toISOString());
  db.db.prepare('INSERT INTO recording_assets VALUES(?,?,?,?,?,?,?)').run('c', r1, 'video', hash('video.mp4'), path.join(from, 'video.mp4'), 9, new Date().toISOString());
  assert.equal(relocationPlan(db, { from, to, courseIds: ['other'] }).plan.length, 0);
  const plan = relocationPlan(db, { from, to, courseIds: ['c'] });
  assert.deepEqual(new Set(plan.plan.map(r => r.kind)), new Set(['file', 'file-version', 'recording']));
  assert.equal(applyRelocation(db, plan), 3); assert.equal(verifyFiles(db).missing, 0);
  assert.equal(db.db.prepare('SELECT local_path FROM file_versions WHERE sha256=?').get(hash('old.pdf')).local_path, path.join(to, 'old.pdf'));
  assert.equal(fs.existsSync(path.join(from, 'video.mp4')), true);
});

test('relocation rolls back all catalogue updates if a video destination changes', t => {
  const { root, db } = fixture(t); const from = path.join(root, 'old'), to = path.join(root, 'new'); fs.mkdirSync(to);
  fs.writeFileSync(path.join(to, 'file'), 'file'); fs.writeFileSync(path.join(to, 'video'), 'video');
  db.upsertFile({ courseId: 'c', contentId: 'f', title: 'file', sourceUrl: '/f', localPath: path.join(from, 'file'), sha256: hash('file'), byteSize: 4 });
  db.db.prepare('INSERT INTO recording_assets VALUES(?,?,?,?,?,?,?)').run('c', r1, 'video', hash('video'), path.join(from, 'video'), 5, new Date().toISOString());
  const plan = relocationPlan(db, { from, to }); fs.writeFileSync(path.join(to, 'video'), 'changed');
  assert.throws(() => applyRelocation(db, plan), /destination changed/);
  assert.equal(db.getFile('c', 'f').local_path, path.join(from, 'file'));
});

test('academic years accept long end years, slash separators and en dashes', () => {
  for (const input of ['2026-27', '2026-2027', '2026/2027', '2026–27']) assert.equal(academicYear(input), '2026-27');
  assert.equal(academicYear('2026-2027', { academicStartYear: 2023 }), 'Year 4');
});

test('HTML entities decode once and generated notes render imported content as text', t => {
  const { root, db } = fixture(t); db.startRun(); const vaultRoot = path.join(root, 'vault'); fs.mkdirSync(path.join(vaultRoot, 'Uni'), { recursive: true });
  db.upsertAnnouncement('c', { id: 'a', title: '<img src="https://example.invalid/title">', body: { rawText: '<p>Read &amp; learn</p>&lt;img src="https://example.invalid/track"&gt; ![](https://example.invalid/image) &amp;lt;literal&amp;gt;' } });
  mergeVault(db, { vaultRoot, downloadDir: root, databasePath: db.path }, { courseIds: ['c'], deduplicate: false });
  const text = fs.readFileSync(path.join(vaultRoot, 'Uni/2026-27/Courses/CS1000 - Synthetic course/MyAberdeen/Announcements.md'), 'utf8');
  assert.doesNotMatch(text, /<img/); assert.match(text, /&lt;img/); assert.match(text, /Read &amp; learn/);
  assert.ok(text.includes('\\!\\[\\]\\(https://example.invalid/image\\)'));
  assert.ok(text.includes('&amp;lt;literal&amp;gt;'));
});

test('download directory and Chrome settings persist with environment override precedence', t => {
  const { root } = fixture(t); const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ downloadDir: path.join(root, 'custom'), chromePath: path.join(root, 'chrome') }));
  assert.equal(getConfig({ MYAB_CONFIG: configPath }).downloadDir, path.join(root, 'custom'));
  assert.equal(getConfig({ MYAB_CONFIG: configPath, MYAB_DOWNLOAD_DIR: path.join(root, 'override') }).downloadDir, path.join(root, 'override'));
  assert.equal(getConfig({ MYAB_CONFIG: configPath }).chromePath, path.join(root, 'chrome'));
  assert.equal(expandHome('~\\Archive'), path.join(os.homedir(), 'Archive'));
  const candidates = chromeCandidates({ PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local' }, 'win32', 'C:\\Users\\Example');
  assert.ok(candidates.includes('C:\\Users\\Example\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(chromeCandidates({}, 'darwin', root).includes(path.join(root, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')));
});

test('guided setup retries invalid input without losing choices and accepts quoted paths', async t => {
  const { root } = fixture(t); const vault = path.join(root, 'vault space'); fs.mkdirSync(path.join(vault, 'Uni'), { recursive: true });
  const config = getConfig({ MYAB_STATE_DIR: root }); const answers = ['bad', '1,', '/missing-vault', `"${vault}"`]; const lines = [];
  await setup(config, [{ id: 'c', courseId: 'CS1000_27', effectiveAvailability: { available: false } }], {}, { ask: async () => answers.shift(), log: s => lines.push(s) });
  const saved = JSON.parse(fs.readFileSync(config.configPath)); assert.deepEqual(saved.profiles.current, ['c']); assert.equal(saved.vaultRoot, vault);
  assert.ok(lines.some(s => s.includes('[unavailable]')));
  assert.equal(normaliseInputPath(vault.replace(/ /g, '\\ '), 'darwin'), vault);
});

test('non-interactive setup fails before starting Chrome or creating a profile', t => {
  const { root } = fixture(t);
  const result = spawnSync(process.execPath, ['src/cli.js', 'setup'], { encoding: 'utf8', env: { ...process.env, MYAB_STATE_DIR: path.join(root, 'state'), MYAB_CONFIG: path.join(root, 'missing.json'), MYAB_CHROME: path.join(root, 'missing-chrome'), MYAB_VAULT: '' } });
  assert.equal(result.status, 1); assert.match(result.stderr, /needs a terminal/); assert.doesNotMatch(result.stderr, /Chrome was not found/);
  assert.equal(fs.existsSync(path.join(root, 'state')), false);
});

test('doctor reports lock owner and recovery guidance without removing a lock', t => {
  const { root } = fixture(t); const config = getConfig({ MYAB_STATE_DIR: root }); const release = acquireLock(root);
  try { const info = localDoctor(config); assert.equal(info.operationLock.ownerPid, process.pid); assert.equal(info.operationLock.ownerAlive, true); assert.ok(info.suggestions.some(s => s.includes('Never remove Chrome profile locks'))); }
  finally { release(); }
});

test('repeated limited refreshes rotate courses and advance past failed files', async t => {
  const { root, db } = fixture(t); const calls = [];
  const members = ['a', 'b'].map(id => ({ id, courseId: `CS${id === 'a' ? '1000' : '2000'}_27`, name: 'Synthetic', termId: 't', isAvailable: true }));
  const item = id => ({ id, title: `${id}.pdf`, contentHandler: { id: 'resource/x-bb-file' } });
  const session = {
    getBinary: async route => { const id = new URL(route, 'https://example.invalid').pathname.split('/').at(-1); calls.push(id); if (id === 'a0') throw new Error('Synthetic failure'); return { body: Buffer.from(id), contentType: 'application/pdf' }; },
    getJson: async route => {
      const pathname = new URL(route, 'https://example.invalid').pathname;
      if (pathname === '/learn/api/v1/users/me') return { id: 'user' };
      if (pathname.endsWith('/memberships')) return { results: members.map(course => ({ course })) };
      if (pathname.endsWith('/terms')) return { results: [{ id: 't', name: '2026-27' }] };
      const courseId = pathname.split('/')[5];
      if (members.some(c => pathname === `/learn/api/v1/courses/${c.id}`)) return members.find(c => c.id === courseId);
      if (pathname.endsWith('/contents/ROOT/children')) return { results: [0, 1, 2].map(n => item(`${courseId}${n}`)) };
      if (/\/contents\/[ab]\d$/.test(pathname)) return item(pathname.split('/').at(-1));
      return { results: [] };
    }
  };
  for (let i = 0; i < 6; i++) { const before = calls.length; await syncArchive({ session, database: db, config: { baseUrl: 'https://example.invalid', downloadDir: path.join(root, 'downloads') }, courseQuery: ['a', 'b'], downloadFiles: true, limitFiles: 1 }); assert.equal(calls.length - before, 1); }
  assert.equal(new Set(calls).size, 6); assert.deepEqual(calls.slice(0, 2), ['a0', 'b0']);
});

test('temporary course fetch failures remain stale while real denials are inaccessible', async t => {
  const { root, db } = fixture(t);
  const session = status => ({ getJson: async route => {
    const pathname = new URL(route, 'https://example.invalid').pathname;
    if (pathname === '/learn/api/v1/users/me') return { id: 'user' };
    if (pathname.endsWith('/memberships')) return { results: [{ course: { id: 'c', courseId: 'CS1000_27', name: 'Synthetic' } }] };
    if (pathname.endsWith('/terms')) return { results: [] };
    throw Object.assign(new Error('Synthetic course failure'), { status });
  } });
  for (const status of [503, 403]) {
    const result = await syncArchive({ session: session(status), database: db, config: { downloadDir: root }, courseQuery: ['c'] });
    const course = brief(db, { databasePath: db.path }, ['c']).courses[0];
    assert.equal(result.status, 'partial');
    assert.equal(course.stale, status === 503);
    assert.equal(course.inaccessibleSections.length, status === 403 ? 6 : 0);
  }
});

test('corrected year labels reuse existing owned vault directories including CRLF markers', t => {
  const { root, db } = fixture(t); const vaultRoot = path.join(root, 'vault'); const old = path.join(vaultRoot, 'Uni', 'Unsorted', 'Courses', 'CS1000 - Existing');
  fs.mkdirSync(path.join(old, 'MyAberdeen'), { recursive: true }); fs.writeFileSync(path.join(old, 'MyAberdeen', 'Index.md'), '# Existing\r\n- Blackboard course ID: `c`\r\n');
  db.db.prepare('UPDATE courses SET term_name=? WHERE id=?').run('2026–27', 'c');
  const config = { vaultRoot, downloadDir: root, databasePath: db.path };
  assert.equal(mergeVault(db, config, { courseIds: ['c'], dryRun: true }).courses[0].directory, old);
  const duplicate = path.join(vaultRoot, 'Uni', '2026-20', 'Courses', 'CS1000 - Duplicate');
  fs.mkdirSync(path.join(duplicate, 'MyAberdeen'), { recursive: true }); fs.writeFileSync(path.join(duplicate, 'MyAberdeen', 'Index.md'), '- Blackboard course ID: `c`\n');
  assert.throws(() => mergeVault(db, config, { courseIds: ['c'], dryRun: true }), /Multiple generated directories/);
  assert.equal(mergeVault(db, { ...config, courseDirectories: { c: 'Unsorted/Courses/CS1000 - Existing' } }, { courseIds: ['c'], dryRun: true }).courses[0].directory, old);
});

test('relative JSON paths resolve beside config while environment paths retain shell semantics', t => {
  const { root } = fixture(t); const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ downloadDir: 'archive', chromePath: 'bin/chrome', vaultRoot: 'vault' }));
  const config = getConfig({ MYAB_CONFIG: configPath });
  assert.equal(config.downloadDir, path.join(root, 'archive'));
  assert.equal(config.chromePath, path.join(root, 'bin', 'chrome'));
  assert.equal(config.vaultRoot, path.join(root, 'vault'));
  assert.equal(getConfig({ MYAB_CONFIG: configPath, MYAB_DOWNLOAD_DIR: 'override' }).downloadDir, path.resolve('override'));
});

test('owned course matching preserves existing symlinked Courses directories', { skip: process.platform === 'win32' }, t => {
  const { root, db } = fixture(t); const vaultRoot = path.join(root, 'vault'); const target = path.join(root, 'linked-courses');
  const courseDir = path.join(target, 'CS1000 - Existing'); fs.mkdirSync(path.join(courseDir, 'MyAberdeen'), { recursive: true });
  fs.writeFileSync(path.join(courseDir, 'MyAberdeen', 'Index.md'), '- Blackboard course ID: `c`\n');
  fs.mkdirSync(path.join(vaultRoot, 'Uni', 'Unsorted'), { recursive: true });
  fs.symlinkSync(target, path.join(vaultRoot, 'Uni', 'Unsorted', 'Courses'), 'dir');
  const result = mergeVault(db, { vaultRoot, downloadDir: root, databasePath: db.path }, { courseIds: ['c'], dryRun: true });
  assert.equal(result.courses[0].directory, path.join(vaultRoot, 'Uni', 'Unsorted', 'Courses', 'CS1000 - Existing'));
});
