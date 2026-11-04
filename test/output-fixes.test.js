import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pluralise } from '../src/merge.js';
import { formatDuration } from '../src/panopto-data.js';
import { downloadContentFile, safeFilename } from '../src/downloads.js';
import { baseCourseCode, safeFilename as coursePathsSafeFilename } from '../src/course-paths.js';

test('pluralise uses singular nouns only for exactly one', () => {
  assert.equal(pluralise(0, 'record'), '0 records');
  assert.equal(pluralise(1, 'record'), '1 record');
  assert.equal(pluralise(2, 'Panopto recording'), '2 Panopto recordings');
  assert.equal(pluralise(1, 'entry'), '1 entry');
  assert.equal(pluralise(3, 'entry'), '3 entries');
  assert.equal(pluralise(2, 'day'), '2 days');
  assert.equal(pluralise(2, 'analysis', 'analyses'), '2 analyses');
});

test('formatDuration renders whole-second clock durations', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(59), '0:59');
  assert.equal(formatDuration(60), '1:00');
  assert.equal(formatDuration(2700), '45:00');
  assert.equal(formatDuration(3723), '1:02:03');
  assert.equal(formatDuration(3599.6), '1:00:00');
  assert.equal(formatDuration(NaN), 'unknown');
  assert.equal(formatDuration(undefined), 'unknown');
  assert.equal(formatDuration(null), 'unknown');
  assert.equal(formatDuration(-5), 'unknown');
});

test('safeFilename remains available from both modules', () => {
  assert.equal(safeFilename, coursePathsSafeFilename);
});

async function captureDedupCode(t, extra) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myab-alias-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const codes = [];
  const database = { findLocalFileByHash: (hash, code) => { codes.push(code); return null; }, upsertFile: () => {} };
  const session = { getBinary: async () => ({ body: Buffer.from('synthetic'), contentType: 'application/pdf' }) };
  await downloadContentFile({ session, database, downloadRoot: dir, course: { id: '_1_1', courseId: 'XX9999_26' },
    item: { id: 'file', title: 'notes.pdf' }, ...extra });
  return codes;
}

test('download deduplication looks up the aliased course code', async t => {
  const config = { courseAliases: { XX9999: 'YY1234' } };
  assert.equal(baseCourseCode('XX9999_26', config), 'YY1234');
  assert.deepEqual(await captureDedupCode(t, { config }), ['YY1234']);
  assert.deepEqual(await captureDedupCode(t, { canonicalCourseCode: baseCourseCode('XX9999_26', config) }), ['YY1234']);
  assert.deepEqual(await captureDedupCode(t, {}), ['XX9999']);
});
