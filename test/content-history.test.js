import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ArchiveDatabase } from '../src/database.js';
import { configureHistory, readHistory, historyStatus, pruneHistory } from '../src/content-history.js';
import { syncArchive } from '../src/sync.js';
import { parseArgs } from '../src/cli-options.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myab-history-'));
  const database = new ArchiveDatabase(path.join(dir, 'archive.sqlite'));
  t.after(() => { try { database.close(); } catch { /* Already closed by migration test. */ } fs.rmSync(dir, { recursive: true, force: true }); });
  database.upsertCourse({ id: 'course', courseId: 'EX1000' });
  database.upsertCourse({ id: 'other', courseId: 'EX2000' });
  return { database, dir };
}
const item = body => ({ id: 'item', title: 'Exam', body, modified: '2026-01-01' });

test('off by default; enable seeds exact cached wording without changing the change feed', t => {
  const { database: db } = fixture(t);
  db.upsertContent('course', null, item('<p>Multiple choice &amp; short answers</p>'));
  db.upsertContent('course', null, item('<p>Multiple choice</p>'));
  assert.equal(historyStatus(db, ['course']).versions, 0);
  const changes = db.changes();
  const cached = db.db.prepare('SELECT synced_at FROM content').get().synced_at;
  configureHistory(db, ['course'], true);
  configureHistory(db, ['course'], true);
  const versions = readHistory(db, 'course', 'item');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].observedAt, cached);
  assert.equal(versions[0].source, 'baseline');
  assert.deepEqual(db.changes(), changes);
  assert.equal(readHistory(db, 'course', 'item', versions[0].version).after.item.body, '<p>Multiple choice</p>');
  assert.ok(historyStatus(db, ['course']).payloadBytes > 0);
});

test('unchanged/noise refreshes do not grow history; edits, moves and reversions do', t => {
  const { database: db } = fixture(t);
  configureHistory(db, ['course'], true);
  db.startRun();
  db.upsertContent('course', null, item('<p>Original &amp; text</p>'));
  db.upsertContent('course', null, { ...item('<p>Original &amp; text</p>'), hitCount: 3, modified: '2026-02-01' });
  assert.equal(readHistory(db, 'course', 'item').length, 1);
  db.upsertContent('course', null, item('<p>Changed text</p>'));
  const versions = readHistory(db, 'course', 'item');
  const comparison = readHistory(db, 'course', 'item', versions[1].version);
  assert.equal(comparison.before.text, 'Original & text');
  assert.equal(comparison.after.text, 'Changed text');
  assert.equal(comparison.after.source, 'refresh');
  assert.equal(comparison.after.runId, db.activeRunId);
  assert.ok(comparison.after.provenance.last_seen_at);
  db.upsertContent('course', 'folder', item('<p>Changed text</p>'));
  db.upsertContent('course', null, item('<p>Original &amp; text</p>'));
  assert.equal(readHistory(db, 'course', 'item').length, 4);
  db.upsertContent('other', null, item('Private other course'));
  assert.deepEqual(readHistory(db, 'other', 'item'), []);
  assert.throws(() => readHistory(db, 'other', 'item', versions[1].version), /not found/);
});

test('disable preserves history; re-enable captures the gap baseline; explicit scoped prune keeps latest', t => {
  const { database: db } = fixture(t);
  configureHistory(db, ['course', 'other'], true);
  db.upsertContent('course', null, item('A'));
  db.upsertContent('other', null, item('Other'));
  configureHistory(db, ['course'], false);
  db.upsertContent('course', null, item('B'));
  assert.equal(readHistory(db, 'course', 'item').length, 1);
  configureHistory(db, ['course'], true);
  db.upsertContent('course', null, item('C'));
  assert.equal(pruneHistory(db, ['course'], 1).versionsToRemove, 2);
  assert.equal(readHistory(db, 'course', 'item').length, 3);
  assert.equal(pruneHistory(db, ['course'], 1, true).versionsToRemove, 2);
  const versions = readHistory(db, 'course', 'item');
  assert.equal(versions.length, 1);
  assert.equal(readHistory(db, 'course', 'item', versions[0].version).after.text, 'C');
  assert.equal(readHistory(db, 'other', 'item').length, 1);
  db.upsertContent('course', null, item('C'));
  assert.equal(readHistory(db, 'course', 'item').length, 1);
});

test('snapshot failure atomically rolls back current content and change feed', t => {
  const { database: db } = fixture(t);
  db.startRun();
  configureHistory(db, ['course'], true);
  db.upsertContent('course', null, item('A'));
  const changes = db.changes();
  db.db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON content_versions BEGIN SELECT RAISE(ABORT, 'disk simulation'); END;");
  assert.throws(() => db.upsertContent('course', null, item('B')), /disk simulation/);
  assert.equal(db.getContent('course', 'item').body, 'A');
  assert.deepEqual(db.changes(), changes);
});

test('v5 migration backs up privately, preserves data, stays disabled and supports read-only retrieval', t => {
  const { database: db } = fixture(t);
  db.upsertContent('course', null, item('Before migration'));
  const target = db.path;
  db.db.exec('DROP TABLE content_versions; PRAGMA user_version=5;');
  db.close();
  const migrated = new ArchiveDatabase(target);
  try {
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 6);
    assert.ok(fs.existsSync(migrated.backupPath));
    if (process.platform !== 'win32') assert.equal(fs.statSync(migrated.backupPath).mode & 0o777, 0o600);
    const backup = new DatabaseSync(migrated.backupPath, { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 5);
    backup.close();
    assert.equal(migrated.getContent('course', 'item').body, 'Before migration');
    assert.equal(historyStatus(migrated, ['course']).courses[0].enabled, false);
    configureHistory(migrated, ['course'], true);
  } finally { migrated.close(); }
  const readOnly = new ArchiveDatabase(target, { readOnly: true });
  try { assert.equal(readHistory(readOnly, 'course', 'item').length, 1); } finally { readOnly.close(); }
});

test('CLI validates actions and exercises local enable/list/read/prune/disable with synthetic archive', t => {
  const { database: db, dir } = fixture(t);
  for (const args of [[], ['--enable', '--disable'], ['--apply'], ['--version', '1'], ['--keep', '0']]) {
    assert.throws(() => parseArgs(['content-history', ...args]));
  }
  db.upsertContent('course', null, item('Baseline'));
  const run = (...args) => {
    const result = spawnSync(process.execPath, ['src/cli.js', 'content-history', '--course', 'EX1000', ...args], {
      encoding: 'utf8', env: { ...process.env, MYAB_STATE_DIR: dir, MYAB_DATABASE: db.path, MYAB_CONFIG: path.join(dir, 'config.json') }
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(run('--enable').versions, 1);
  const version = run('--id', 'item')[0].version;
  assert.equal(run('--id', 'item', '--version', String(version)).after.text, 'Baseline');
  assert.equal(run('--keep', '1').dryRun, true);
  assert.equal(run('--disable').courses[0].enabled, false);
  assert.equal(run().versions, 1);
});


test('incremental sync preserves history on partial detail failure and records only successful body edits', async t => {
  const { database: db, dir } = fixture(t);
  let body = 'Original exam wording', fail = false, detailCalls = 0;
  const course = { id: 'course', courseId: 'EX1000', name: 'Synthetic course', isAvailable: true };
  const session = { async getJson(route) {
    const p = new URL(route, 'https://example.test').pathname;
    if (p.endsWith('/users/me')) return { id: 'synthetic-user' };
    if (p.endsWith('/memberships')) return { results: [{ course }] };
    if (p.endsWith('/courses/course')) return course;
    if (p.endsWith('/ROOT/children')) return { results: [{ id: 'item', title: 'Exam' }] };
    if (p.endsWith('/contents/item')) {
      detailCalls++;
      if (fail) throw new Error('Synthetic unavailable detail');
      return item(body);
    }
    return { results: [] };
  } };
  const sync = deep => syncArchive({ session, database: db, config: { baseUrl: 'https://example.test', downloadDir: path.join(dir, 'downloads') }, courseQuery: ['course'], deep });
  configureHistory(db, ['course'], true);
  assert.equal((await sync(false)).status, 'completed');
  await sync(false);
  assert.equal(detailCalls, 1);
  assert.equal(readHistory(db, 'course', 'item').length, 1);
  body = 'Revised exam wording'; fail = true;
  assert.equal((await sync(true)).status, 'partial');
  assert.equal(db.getContent('course', 'item').body, 'Original exam wording');
  assert.equal(readHistory(db, 'course', 'item').length, 1);
  fail = false;
  assert.equal((await sync(false)).status, 'completed');
  const versions = readHistory(db, 'course', 'item');
  assert.equal(versions.length, 2);
  assert.equal(versions[1].provenance.detail_status, 'complete');
  assert.equal(versions[1].provenance.detail_checked_at, versions[1].observedAt);
  assert.equal(readHistory(db, 'course', 'item', versions[1].version).before.text, 'Original exam wording');
  const cursor = db.changes().at(-1).id;
  await sync(false);
  assert.deepEqual(db.changes({ since: cursor }), []);
  assert.equal(readHistory(db, 'course', 'item').length, 2);
});
