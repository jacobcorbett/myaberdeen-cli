import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ArchiveDatabase } from '../src/database.js';
import { exportArchive } from '../src/export.js';

test('exportArchive creates private per-course datasets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myab-export-'));
  const database = new ArchiveDatabase(path.join(root, 'archive.sqlite'));
  database.upsertCourse({ id: '_1_1', courseId: 'CS1000', name: 'Test Course', termId: '_t_1' }, 'Term 1');
  database.upsertAnnouncement('_1_1', { id: '_a_1', title: 'Welcome' });
  const config = { databasePath: path.join(root, 'archive.sqlite'), downloadDir: path.join(root, 'downloads') };
  const result = exportArchive(database, config);
  const announcements = path.join(root, 'downloads', 'Term 1', 'CS1000', '_course-data', 'announcements.json');
  assert.equal(result.courses, 1);
  assert.equal(JSON.parse(fs.readFileSync(announcements, 'utf8'))[0].title, 'Welcome');
  assert.equal(fs.statSync(announcements).mode & 0o777, 0o600);
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});
