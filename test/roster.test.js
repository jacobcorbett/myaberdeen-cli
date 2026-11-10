import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ArchiveDatabase } from '../src/database.js';
import { syncArchive } from '../src/sync.js';
import { normaliseRoster, readRosters, renderRosters } from '../src/roster.js';
import { parseArgs, resumedOptions } from '../src/cli-options.js';
import { exportArchive } from '../src/export.js';
import { mergeVault } from '../src/merge.js';

const course = { id: 'course-a', courseId: 'EX1000', name: 'Synthetic course' };
const member = n => ({ id: `member-${n}`, userId: `user-${n}`, courseId: course.id, role: 'S',
  courseRole: { identifier: 'S', courseName: { languageKey: 'S.name', bundle: 'course_roles' } },
  user: { id: `user-${n}`, givenName: 'Example', familyName: `Person ${n}`, preferredDisplayName: 'GIVEN_NAME', pronouns: 'they/them',
    emailAddress: 'private@example.test', studentId: 'private-id', avatar: { url: 'https://example.test/private' } },
  permissions: { private: true } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myab-roster-'));
  const database = new ArchiveDatabase(path.join(dir, 'archive.sqlite'));
  t.after(() => { try { database.close(); } catch (e) { if (e.code !== 'ERR_INVALID_STATE') throw e; } fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { baseUrl: 'https://example.test', databasePath: database.path, downloadDir: path.join(dir, 'downloads'), vaultRoot: path.join(dir, 'vault') };
  fs.mkdirSync(path.join(config.vaultRoot, 'Uni'), { recursive: true });
  let mode = 'complete'; const requests = [];
  const session = { getJson: async route => {
    requests.push(route);
    const url = new URL(route, config.baseUrl), p = url.pathname;
    if (p.endsWith('/users/me')) return { id: 'self' };
    if (p === '/learn/api/v1/users/self/memberships') return { results: [{ course }] };
    if (p === '/learn/api/v1/courses/course-a') return course;
    if (p === '/learn/api/v1/courses/course-a/memberships') {
      if (mode === 'denied') throw Object.assign(new Error('Forbidden'), { status: 403 });
      if (mode === 'malformed') return { error: true };
      if (mode === 'empty') return { results: [] };
      if (mode === 'one') return { results: [member(1)] };
      const offset = Number(url.searchParams.get('offset'));
      if (!offset) return { results: [mode === 'updated' ? { ...member(1), user: { ...member(1).user, givenName: 'Changed' } } : member(1)], paging: { count: 2, nextPage: 'next' } };
      if (mode === 'short') return { results: [], paging: { count: 2 } };
      if (mode === 'repeated') return { results: [member(1)], paging: { count: 2 } };
      if (mode === 'bad-identity') return { results: [{ ...member(2), userId: 'other' }], paging: { count: 2 } };
      return { results: [member(2)], paging: { count: 2 } };
    }
    return { results: [] };
  } };
  return { dir, database, config, requests, setMode: value => { mode = value; },
    read: () => readRosters(database, [{ ...course, course_code: course.courseId }])[0],
    run: (roster = true) => syncArchive({ session, database, config, courseQuery: [course.id], roster }) };
}

test('Class Register is opt-in; full pagination is archived with names/roles and unchanged repeat has no changes', async t => {
  const f = fixture(t);
  await f.run(false);
  assert.equal(f.requests.some(r => r.includes('/courses/course-a/memberships')), false);
  assert.equal(f.read().section.status, 'never-checked');
  assert.equal((await f.run()).status, 'completed');
  assert.equal(f.read().members.length, 2);
  assert.equal(f.read().members[0].roleName, 'Student');
  const saved = JSON.stringify(f.read());
  for (const excluded of ['private@example.test', 'private-id', 'avatar', 'permissions', 'emailAddress', 'studentId']) assert.ok(!saved.includes(excluded));
  const cursor = f.database.changes().at(-1).id;
  await f.run();
  assert.deepEqual(f.database.changes({ since: cursor }), []);
  assert.deepEqual(readRosters(f.database, [{ id: 'other' }])[0].members, []);
});

test('denied, malformed, short, repeated and inconsistent refreshes retain all prior members and timestamps', async t => {
  const f = fixture(t); await f.run();
  const before = f.read().members;
  for (const mode of ['denied', 'malformed', 'short', 'repeated', 'bad-identity']) {
    f.setMode(mode);
    assert.equal((await f.run()).status, 'partial');
    assert.deepEqual(f.read().members, before);
    assert.equal(f.read().section.status, mode === 'denied' ? 'unavailable' : 'partial');
  }
});


test('a storage failure rolls back member updates and change tracking together', async t => {
  const f = fixture(t); await f.run();
  const before = f.read().members, cursor = f.database.changes().at(-1).id;
  f.database.db.exec(`CREATE TRIGGER reject_roster_write BEFORE INSERT ON roster_members
    WHEN NEW.id='member-2' BEGIN SELECT RAISE(ABORT, 'Synthetic storage failure'); END;`);
  f.setMode('updated');
  assert.equal((await f.run()).status, 'partial');
  assert.deepEqual(f.read().members, before);
  assert.deepEqual(f.database.changes({ since: cursor }), []);
});

test('ordinary refreshes leave an existing roster and its section check untouched', async t => {
  const f = fixture(t); await f.run(); const before = f.read();
  await f.run(false);
  assert.deepEqual(f.read(), before);
});

test('only successful full traversals mark missing members historical, including an empty register', async t => {
  const f = fixture(t); await f.run(); f.setMode('one'); await f.run();
  assert.equal(f.read().members.find(m => m.id === 'member-2')._archive.presence, 'historical');
  f.setMode('empty'); await f.run();
  assert.ok(f.read().members.every(m => m._archive.presence === 'historical'));
  f.setMode('complete'); await f.run();
  assert.ok(f.read().members.every(m => m._archive.presence === 'current'));
});

test('validation rejects duplicate/missing identities before writing; custom role labels are preserved and display preference enums are never rendered as names', () => {
  assert.throws(() => normaliseRoster([member(1), member(1)], course.id));
  assert.throws(() => normaliseRoster([member(1)], 'other'));
  const custom = member(1); custom.user.preferredDisplayName = 'GIVEN_NAME';
  custom.courseRole.courseName = { languageKey: 'Example custom role', bundle: 'course_roles' };
  assert.equal(normaliseRoster([custom], course.id)[0].roleName, 'Example custom role');
  assert.equal(normaliseRoster([custom], course.id)[0].displayName, 'Example Person 1');
  custom.user.id = 'mismatch'; assert.throws(() => normaliseRoster([custom], course.id));
});

test('private exports and vault notes include status and historical labels without extra profile fields', async t => {
  const f = fixture(t); await f.run();
  exportArchive(f.database, f.config, { courseIds: [course.id] });
  const file = path.join(f.config.downloadDir, 'No term', course.courseId, '_course-data', 'roster.json');
  assert.equal(JSON.parse(fs.readFileSync(file)).members.length, 2);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const plan = mergeVault(f.database, f.config, { courseIds: [course.id], dryRun: true });
  assert.ok(plan.courses[0].notes.includes('Roster.md'));
  mergeVault(f.database, f.config, { courseIds: [course.id], deduplicate: false });
  assert.match(fs.readFileSync(path.join(plan.courses[0].directory, 'MyAberdeen', 'Roster.md'), 'utf8'), /Example Person 1.*Student.*current/);
  assert.match(renderRosters([{ ...f.read(), members: [] }]), /No members were returned/);
});

test('offline CLI produces scoped JSON/text without opening a browser', async t => {
  const f = fixture(t); await f.run();
  for (const format of ['json', 'text']) {
    const result = spawnSync(process.execPath, ['src/cli.js', 'roster', '--course', course.id, '--format', format], {
      encoding: 'utf8', env: { ...process.env, MYAB_CONFIG: path.join(f.dir, 'missing.json'), MYAB_DATABASE: f.database.path, MYAB_CHROME: path.join(f.dir, 'not-chrome') }
    });
    assert.equal(result.status, 0, result.stderr);
    if (format === 'json') assert.equal(JSON.parse(result.stdout)[0].members.length, 2);
    else assert.match(result.stdout, /Example Person 1.*Student/);
  }
});

test('v4 migration creates a private backup; old offline archives report never checked', t => {
  const f = fixture(t), filename = f.database.path;
  f.database.db.exec('DROP TABLE roster_members; PRAGMA user_version=4'); f.database.close();
  const old = new ArchiveDatabase(filename, { readOnly: true });
  assert.equal(readRosters(old, [course])[0].section.status, 'never-checked'); old.close();
  const migrated = new ArchiveDatabase(filename);
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 5);
  const backup = new DatabaseSync(migrated.backupPath, { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 4);
  if (process.platform !== 'win32') assert.equal(fs.statSync(migrated.backupPath).mode & 0o777, 0o600);
  backup.close(); migrated.close();
});

test('roster CLI requires explicit scope, validates format and resumes opt-in collection', () => {
  assert.throws(() => parseArgs(['roster']));
  assert.throws(() => parseArgs(['roster', '--course', 'EX1000', '--format', 'vtt']));
  assert.equal(parseArgs(['check', '--course', 'EX1000', '--roster']).options.roster, true);
  assert.equal(resumedOptions({ resume: 1 }, { roster: true }).roster, true);
});

test('text rendering escapes Markdown, terminal controls and embedded line breaks', () => {
  const f = { courseCode: 'EX1000', section: { status: 'completed' }, members: [{ displayName: '[link](https://example.test)\n\x1b[31m', pronouns: '', roleName: '<role>', _archive: { presence: 'current' } }] };
  const rendered = renderRosters([f]);
  assert.ok(!rendered.includes('\x1b'));
  assert.ok(!rendered.includes('\n\x1b'));
  assert.ok(rendered.includes('\\[link\\]'));
  assert.ok(rendered.includes('\\<role\\>'));
});
