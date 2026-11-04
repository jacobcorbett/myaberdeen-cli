// Minimal read-only ZIP reader for Office text extraction. Supports only
// single-disk, non-ZIP64, unencrypted archives using stored or deflate entries.
import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50, ZIP64_LOCATOR = 0x07064b50;
export const ZIP_LIMITS = Object.freeze({ maxArchiveBytes: 256 * 1024 * 1024, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxEntries: 65_535 });

export class ZipError extends Error {
  constructor(message) { super(message); this.name = 'ZipError'; this.code = 'EZIP'; }
}
const fail = message => { throw new ZipError(message); };

function findEndOfCentralDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= lowest; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
  }
  return fail('Archive end record not found.');
}

// Lists central directory entries without decompressing anything.
export function listZipEntries(buffer, limits = ZIP_LIMITS) {
  if (buffer.length < 22) fail('Archive is too small.');
  const end = findEndOfCentralDirectory(buffer);
  if (end >= 20 && buffer.readUInt32LE(end - 20) === ZIP64_LOCATOR) fail('ZIP64 archives are not supported.');
  const disk = buffer.readUInt16LE(end + 4), cdDisk = buffer.readUInt16LE(end + 6);
  const diskEntries = buffer.readUInt16LE(end + 8), count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) fail('ZIP64 archives are not supported.');
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== count) fail('Multi-disk archives are not supported.');
  if (count > limits.maxEntries) fail('Archive has too many entries.');
  if (start + size > end) fail('Archive central directory is out of bounds.');
  const entries = [];
  let offset = start;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > start + size || buffer.readUInt32LE(offset) !== CENTRAL) fail('Archive central directory is corrupt.');
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > start + size) fail('Archive central directory is corrupt.');
    entries.push({
      name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
      flags: buffer.readUInt16LE(offset + 8), method: buffer.readUInt16LE(offset + 10), crc32: buffer.readUInt32LE(offset + 16),
      compressedSize: buffer.readUInt32LE(offset + 20), uncompressedSize: buffer.readUInt32LE(offset + 24), localOffset: buffer.readUInt32LE(offset + 42),
    });
    offset = next;
  }
  return entries;
}

function unsafeName(name) {
  return !name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..');
}

function readEntry(buffer, entry, allowance) {
  if (unsafeName(entry.name)) fail('Archive entry name is unsafe.');
  if (entry.flags & 0x1) fail('Encrypted archives are not supported.');
  if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff || entry.localOffset === 0xffffffff) fail('ZIP64 archives are not supported.');
  if (entry.method !== 0 && entry.method !== 8) fail('Archive uses an unsupported compression method.');
  if (entry.uncompressedSize > allowance) fail('Archive entry exceeds the extraction size limit.');
  const local = entry.localOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL) fail('Archive local header is corrupt.');
  const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) fail('Archive entry data is truncated.');
  const raw = buffer.subarray(dataStart, dataEnd);
  let data;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) fail('Archive stored entry sizes disagree.');
    data = raw;
  } else {
    try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.uncompressedSize) }); }
    catch { fail('Archive entry could not be decompressed or exceeds its declared size.'); }
  }
  if (data.length !== entry.uncompressedSize) fail('Archive entry size does not match its declared size.');
  if (zlib.crc32(data) !== entry.crc32) fail('Archive entry checksum mismatch.');
  return data;
}

// Reads the entries whose exact names satisfy `select`, in central directory order.
export function readZipEntries(source, select, limits = ZIP_LIMITS) {
  let buffer = source;
  if (!Buffer.isBuffer(source)) {
    if (fs.statSync(source).size > limits.maxArchiveBytes) fail('Archive exceeds the extraction size limit.');
    buffer = fs.readFileSync(source);
  }
  let remaining = limits.maxTotalBytes;
  const results = [];
  for (const entry of listZipEntries(buffer, limits)) {
    if (!select(entry.name)) continue;
    const data = readEntry(buffer, entry, Math.min(limits.maxEntryBytes, remaining));
    remaining -= data.length;
    results.push({ name: entry.name, data });
  }
  return results;
}
