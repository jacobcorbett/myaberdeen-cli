import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { safeFilename, fileRoute, sourceRoute, isBlackboardFile } from '../src/downloads.js';
import { getAllPages, selectCourses } from '../src/api.js';
import { ArchiveDatabase } from '../src/database.js';

test('safeFilename removes path traversal and forbidden characters', () => {
  assert.equal(safeFilename('../Week 1: slides?.pptx'), 'Week 1- slides-.pptx');
  assert.equal(safeFilename('  .  '), 'untitled');
});

test('fileRoute safely encodes Blackboard identifiers', () => {
  assert.equal(fileRoute('_1 2_1', '_3/4_1'), '/ultra/courses/_1%202_1/outline/file/_3%2F4_1?courseId=_1%202_1');
});

test('sourceRoute prefers the canonical Blackboard file URL', () => {
  const item = { id: '_2_1', contentDetail: { 'resource/x-bb-file': { file: { permanentUrl: '/bbcswebdav/pid-2-dt-content-rid-3_1/xid-3_1' } } } };
  assert.equal(sourceRoute('_1_1', item), '/bbcswebdav/pid-2-dt-content-rid-3_1/xid-3_1');
});

test('file handler detection is conservative', () => {
  assert.equal(isBlackboardFile({ contentHandler: { id: 'resource/x-bb-file' } }), true);
  assert.equal(isBlackboardFile({ contentHandler: { id: 'resource/x-bb-lti-link' } }), false);
});

test('getAllPages follows offset pagination', async () => {
  const calls = [];
  const session = {
    async getJson(route) {
      calls.push(route);
      const offset = Number(new URL(route, 'https://x').searchParams.get('offset'));
      return { results: offset === 0 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }] };
    }
  };
  const output = await getAllPages(session, '/items?sort=name', { limit: 2 });
  assert.deepEqual(output.map(item => item.id), [1, 2, 3]);
  assert.equal(calls.length, 2);
});

test('course selection matches ID, code and name', () => {
  const memberships = [
    { course: { id: '_1_1', courseId: 'CS3524', name: 'Enterprise Security Architecture' } },
    { course: { id: '_2_1', courseId: 'LX1501', name: 'Spanish' } }
  ];
  assert.deepEqual(selectCourses(memberships, 'security').map(course => course.id), ['_1_1']);
  assert.deepEqual(selectCourses(memberships, 'LX1501').map(course => course.id), ['_2_1']);
});

test('archive database upserts durable records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'myab-test-'));
  const databasePath = path.join(directory, 'archive.sqlite');
  const database = new ArchiveDatabase(databasePath);
  database.upsertCourse({ id: '_1_1', courseId: 'CS3524', name: 'Course', termId: '_t_1' }, '2025/26');
  database.upsertContent('_1_1', 'ROOT', { id: '_c_1', title: 'Slides', contentHandler: { id: 'resource/x-bb-file' } });
  const status = database.status();
  assert.equal(status.counts.courses, 1);
  assert.equal(status.counts.content, 1);
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
