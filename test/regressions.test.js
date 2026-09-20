import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { embeddedFiles, downloadContentFile } from '../src/downloads.js';
import { BlackboardSession } from '../src/browser.js';
import { ArchiveDatabase } from '../src/database.js';
import { syncArchive } from '../src/sync.js';

const baseUrl = 'https://abdn.blackboard.com';
const anchor = (href, metadata = '{&quot;linkName&quot;:&quot;Exercise.ipynb&quot;}') => `<a href="${href}" data-bbfile="${metadata}">file</a>`;

test('embedded attachments decode attributes, deduplicate and exclude external/malformed links', () => {
  const html = anchor('/bbcswebdav/xid-1') + anchor(`${baseUrl}/bbcswebdav/xid-1`) + anchor('https://example.com/bbcswebdav/xid-2') + anchor('/bbcswebdav/xid-3', 'invalid');
  const items = embeddedFiles({ id: 'document', body: { rawText: html, displayText: html } }, baseUrl);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Exercise.ipynb');
  assert.equal(items[0].id, embeddedFiles({ id: 'document', body: { rawText: anchor('/bbcswebdav/xid-1') } }, baseUrl)[0].id);
});

test('authenticated requests reject external origins before issuing requests', async () => {
  const session = new BlackboardSession({ baseUrl });
  await assert.rejects(session.getJson('https://example.com/private'), /outside/);
  await assert.rejects(session.getBinary('//example.com/private'), /outside/);
  session.captureXsrf({ url: () => 'https://example.com', headers: () => ({ 'x-blackboard-xsrf': 'external' }) });
  assert.equal(session.xsrfToken, null);
});

test('403 remains an access error, requests do not follow redirects or retry implicitly', async () => {
  const session = new BlackboardSession({ baseUrl });
  session.xsrfToken = 'synthetic-test-token';
  let calls = 0, disposed = false;
  session.context = { request: { get: async (_, options) => {
    calls++;
    assert.equal(options.maxRedirects, 0);
    return { status: () => 403, ok: () => false, dispose: async () => { disposed = true; } };
  } } };
  await assert.rejects(session.getJson('/course'), /request failed \(403\)/);
  assert.equal(calls, 1);
  assert.equal(disposed, true);
});

test('downloads preserve previous versions and reject HTML without losing a good record', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myab-download-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const records = [];
  const database = { findLocalFileByHash: () => null, upsertFile: item => records.push(item) };
  let body = 'version 1', contentType = 'application/pdf';
  const session = { getBinary: async () => ({ body: Buffer.from(body), contentType }) };
  const args = { session, database, downloadRoot: dir, course: { id: 'course' }, item: { id: 'file', title: 'slides.pdf' } };
  const paths = [];
  for (const value of ['version 1', 'version 2', 'version 3']) {
    body = value;
    paths.push((await downloadContentFile(args)).path);
  }
  assert.equal(new Set(paths).size, 3);
  assert.equal(await fs.readFile(paths[1], 'utf8'), 'version 2');
  contentType = 'text/html';
  await assert.rejects(downloadContentFile(args), /HTML viewer/);
  assert.equal(records.length, 3);
});

test('failed embedded downloads consume the budget and produce a partial run', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myab-sync-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const database = new ArchiveDatabase(path.join(dir, 'test.sqlite'));
  t.after(() => database.close());
  let attempts = 0;
  const document = { id: 'doc', body: { rawText: anchor('/bbcswebdav/one') + anchor('/bbcswebdav/two') } };
  const session = {
    getBinary: async () => { attempts++; throw new Error('Synthetic download failure'); },
    getJson: async route => {
      const pathname = new URL(route, baseUrl).pathname;
      if (pathname === '/learn/api/v1/users/me') return { id: 'user' };
      if (pathname.endsWith('/memberships')) return { results: [{ course: { id: 'course' } }] };
      if (pathname === '/learn/api/v1/courses/course') return { id: 'course' };
      if (pathname.endsWith('/contents/ROOT/children')) return { results: [document] };
      if (pathname.endsWith('/contents/doc')) return document;
      return { results: [] };
    }
  };
  const result = await syncArchive({ session, database, config: { baseUrl, downloadDir: dir }, downloadFiles: true, limitFiles: 1 });
  assert.equal(attempts, 1);
  assert.equal(result.status, 'partial');
  assert.equal(result.errors, 1);
  assert.equal(database.status().lastRun.status, 'partial');
});

test('CLI rejects invalid argument values without a stack trace', () => {
  for (const args of [['sync', '--limit-files', '2junk'], ['sync', '--course', '--headed']]) {
    const result = spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Error:/);
    assert.doesNotMatch(result.stderr, /at parseArgs/);
  }
});

test('redirects follow Blackboard hops but reject external destinations before sending headers', async () => {
  const session = new BlackboardSession({ baseUrl });
  session.xsrfToken = 'synthetic-test-token';
  const calls = [];
  session.context = { request: { get: async url => {
    calls.push(url);
    return { status: () => 302, headers: () => ({ location: calls.length === 1 ? '/second' : 'https://external.example/file' }), dispose: async () => {} };
  } } };
  await assert.rejects(session.getBinary('/first'), /outside/);
  assert.deepEqual(calls, [`${baseUrl}/first`, `${baseUrl}/second`]);
});

test('Blackboard file-host redirects use an isolated client with no authentication headers', async () => {
  const session = new BlackboardSession({ baseUrl });
  session.xsrfToken = 'synthetic-test-token';
  session.context = { request: { get: async () => ({ status: () => 302, headers: () => ({ location: 'https://alt-test.blackboard.com/file' }), dispose: async () => {} }) } };
  session.fileRequest = { get: async (url, options) => {
    assert.equal(url, 'https://alt-test.blackboard.com/file');
    assert.deepEqual(options.headers, { Accept: '*/*' });
    assert.equal(options.maxRedirects, 0);
    return { status: () => 200, ok: () => true, body: async () => Buffer.from('file'), headers: () => ({}), url: () => url, dispose: async () => {} };
  } };
  assert.equal((await session.getBinary('/attachment')).body.toString(), 'file');
});

test('transport errors do not expose signed URLs or request headers', async () => {
  const session = new BlackboardSession({ baseUrl });
  session.xsrfToken = 'synthetic-test-token';
  session.context = { request: { get: async () => { throw new Error('secret-query-and-header'); } } };
  await assert.rejects(session.getBinary('/file?signature=secret'), error => {
    assert.doesNotMatch(error.message, /secret|signature/);
    return /transport failed/.test(error.message);
  });
});
