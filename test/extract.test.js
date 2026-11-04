import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { ArchiveDatabase } from '../src/database.js';
import { extractFiles } from '../src/extract.js';
import { readZipEntries, listZipEntries, ZipError } from '../src/zip.js';
import { hash } from '../src/io.js';

// Tiny synthetic ZIP writer. Entries: { name, data, method = 8, declaredSize?, flags? }.
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data: text, method = 8, declaredSize, flags = 0 } of entries) {
    const data = Buffer.from(text), nameBytes = Buffer.from(name);
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const size = declaredSize ?? data.length, crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body); centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const slide = n => `<p:sld><a:p><a:r><a:t>Slide ${n}</a:t></a:r></a:p></p:sld>`;
const paragraphs = (...lines) => `<w:document><w:body>${lines.map(l => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myab-extract-'));
  const config = { stateDir: path.join(root, 'state'), databasePath: path.join(root, 'archive.sqlite') };
  const database = new ArchiveDatabase(config.databasePath);
  database.upsertCourse({ id: 'course', courseId: 'CS1000_27', name: 'Test course', termId: 'term', isAvailable: true }, 'Term 1');
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let counter = 0;
  const add = (title, body) => {
    const file = path.join(root, title); fs.writeFileSync(file, body);
    database.upsertFile({ courseId: 'course', contentId: `file${++counter}`, title, sourceUrl: '/file', localPath: file, sha256: hash(body), byteSize: body.length });
  };
  const text = () => fs.readFileSync(database.db.prepare("SELECT local_path FROM text_extractions WHERE status='complete'").get().local_path, 'utf8');
  return { database, config, add, text };
}

test('pptx slides are extracted in numeric order, ignoring layouts and rels', t => {
  const { database, config, add, text } = fixture(t);
  const numbers = [1, 10, 11, 12, 2, 3, 4, 5, 6, 7, 8, 9];
  add('deck.pptx', zip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    ...numbers.map(n => ({ name: `ppt/slides/slide${n}.xml`, data: slide(n) })),
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: '<Relationships>REL</Relationships>' },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: '<a:p><a:t>LAYOUT</a:t></a:p>' },
  ]));
  const result = extractFiles(database, config);
  assert.equal(result.extracted, 1); assert.equal(result.version, 'text-v2');
  const lines = text().split('\n').map(l => l.trim()).filter(Boolean);
  assert.deepEqual(lines, Array.from({ length: 12 }, (_, i) => `Slide ${i + 1}`));
  assert.equal(database.db.prepare('SELECT extractor_version FROM text_extractions').get().extractor_version, 'text-v2');
});

test('docx paragraphs are extracted, including stored entries', t => {
  const { database, config, add, text } = fixture(t);
  add('notes.docx', zip([{ name: 'word/document.xml', data: paragraphs('First paragraph', 'Second paragraph'), method: 0 }]));
  assert.equal(extractFiles(database, config).extracted, 1);
  assert.equal(text(), 'First paragraph\nSecond paragraph\n');
});

test('zip reader reads deflated and stored entries by exact name', () => {
  const archive = zip([{ name: 'a.xml', data: 'deflated' }, { name: 'b.xml', data: 'stored', method: 0 }]);
  assert.deepEqual(readZipEntries(archive, () => true).map(e => [e.name, e.data.toString()]), [['a.xml', 'deflated'], ['b.xml', 'stored']]);
  assert.deepEqual(readZipEntries(archive, n => n === 'b.xml').map(e => e.name), ['b.xml']);
});

test('zip reader rejects oversized and lying entries without inflating them fully', () => {
  const bomb = Buffer.alloc(4 * 1024 * 1024);
  const limits = { maxArchiveBytes: 1 << 20, maxEntryBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024, maxEntries: 10 };
  assert.throws(() => readZipEntries(zip([{ name: 'big.xml', data: bomb }]), () => true, limits), ZipError);
  // Declared size understates the real payload: maxOutputLength stops decompression.
  assert.throws(() => readZipEntries(zip([{ name: 'liar.xml', data: bomb, declaredSize: 100 }]), () => true, limits), ZipError);
  // Total budget across several entries.
  const half = Buffer.alloc(600 * 1024);
  assert.throws(() => readZipEntries(zip([{ name: 'a.xml', data: half }, { name: 'b.xml', data: half }]), () => true, limits), /size limit/);
});

test('zip reader rejects corrupt, truncated, encrypted, unsafe and unsupported archives', () => {
  const good = zip([{ name: 'word/document.xml', data: paragraphs('Hello') }]);
  assert.throws(() => readZipEntries(good.subarray(0, good.length - 5), () => true), ZipError);
  assert.throws(() => readZipEntries(good.subarray(0, 40), () => true), ZipError);
  assert.throws(() => readZipEntries(Buffer.from('not a zip at all, definitely not'), () => true), ZipError);
  const corrupt = Buffer.from(good); corrupt[30 + 17 + 3] ^= 0xff; // inside the compressed payload
  assert.throws(() => readZipEntries(corrupt, () => true), ZipError);
  assert.throws(() => readZipEntries(zip([{ name: 'x', data: 'secret', flags: 1 }]), () => true), /Encrypted/);
  assert.throws(() => readZipEntries(zip([{ name: '../evil', data: 'x' }]), () => true), /unsafe/);
  assert.throws(() => readZipEntries(zip([{ name: '/abs', data: 'x' }]), () => true), /unsafe/);
  const bzip = zip([{ name: 'x', data: 'x', method: 0 }]); bzip.writeUInt16LE(12, 8); bzip.writeUInt16LE(12, bzip.length - 22 - 46 - 1 + 10 + 0);
  assert.throws(() => readZipEntries(bzip, () => true), /unsupported compression/);
  const zip64 = Buffer.from(good); zip64.writeUInt16LE(0xffff, zip64.length - 12);
  assert.throws(() => listZipEntries(zip64), /ZIP64/);
});

test('malformed office documents record a non-leaking failure', t => {
  const { database, config, add } = fixture(t);
  add('broken.docx', Buffer.from('PK\u0003\u0004 truncated garbage'));
  const result = extractFiles(database, config);
  assert.equal(result.extracted, 0); assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /malformed, unsupported or too large/);
  assert.ok(!result.errors[0].error.includes(os.tmpdir()));
  assert.equal(database.db.prepare('SELECT status FROM text_extractions').get().status, 'failed');
});
