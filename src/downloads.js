import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { parseFragment } from 'parse5';
import { atomicWrite, fileMatches } from './io.js';

export function safeFilename(value, fallback = 'untitled') {
  const cleaned = String(value || fallback)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[. -]+|[. ]+$/g, '')
    .slice(0, 180);
  let bounded = cleaned;
  while (Buffer.byteLength(bounded) > 180) bounded = bounded.slice(0, -1);
  return bounded || 'untitled';
}

export function isBlackboardFile(item) {
  const handler = item?.contentHandler?.id || item?.contentHandler || item?.type || '';
  return String(handler).toLowerCase().includes('file');
}

export function fileRoute(courseId, contentId) {
  return `/ultra/courses/${encodeURIComponent(courseId)}/outline/file/${encodeURIComponent(contentId)}?courseId=${encodeURIComponent(courseId)}`;
}

export function sourceRoute(courseId, item) {
  return item?.contentDetail?.['resource/x-bb-file']?.file?.permanentUrl
    || fileRoute(courseId, item.id);
}

// Parse HTML rather than matching attributes with a regex: Blackboard entity-encodes JSON.
export function embeddedFiles(item, baseUrl) {
  const found = new Map();
  function walk(node) {
    const attrs = Object.fromEntries((node.attrs || []).map(a => [a.name, a.value]));
    if (node.tagName === 'a' && attrs.href && attrs['data-bbfile']) {
      try {
        const url = new URL(attrs.href, baseUrl);
        const metadata = JSON.parse(attrs['data-bbfile']);
        if (url.origin === new URL(baseUrl).origin && url.pathname.startsWith('/bbcswebdav/')) {
          url.hash = '';
          const id = `${item.id}:attachment:${sha256(url.href).slice(0, 24)}`;
          found.set(url.href, { id, title: metadata.linkName || metadata.fileName || id,
            contentHandler: { id: 'resource/x-bb-file' },
            contentDetail: { 'resource/x-bb-file': { file: { ...metadata,
              fileName: metadata.linkName || metadata.fileName, permanentUrl: url.href } } } });
        }
      } catch { /* Invalid metadata or an external link is not a downloadable attachment. */ }
    }
    for (const child of node.childNodes || []) walk(child);
  }
  for (const html of [item.body?.rawText, item.body?.displayText]) {
    if (typeof html === 'string') walk(parseFragment(html));
  }
  return [...found.values()];
}

export async function downloadContentFile({ session, database, downloadRoot, course, termName, item, canonicalCourseCode }) {
  const fileMetadata = item?.contentDetail?.['resource/x-bb-file']?.file || {};
  const sourceUrl = sourceRoute(course.id, item);
  const previous = database.getFile?.(course.id, item.id);
  const verified = previous?.source_url === sourceUrl && fileMatches(previous.local_path, previous.sha256);
  let result = await session.getBinary(sourceUrl, verified ? { etag: previous.etag, lastModified: previous.last_modified } : {});
  if (result.notModified) {
    // A validator is trusted only after a full download established this file/validator pair.
    if (!verified || !fileMatches(previous.local_path, previous.sha256)) result = await session.getBinary(sourceUrl);
    else {
      database.setFileValidators?.(course.id, item.id, { etag: result.etag || previous.etag, lastModified: result.lastModified || previous.last_modified });
      return { downloaded: false, unchanged: true, notModified: true, path: previous.local_path, bytes: 0 };
    }
  }
  if (result.notModified || !Buffer.isBuffer(result.body)) throw new Error('Download returned no usable file body.');
  if (/text\/html/i.test(result.contentType)) throw new Error('Blackboard returned an HTML viewer rather than a file; previous file record preserved.');
  const filename = safeFilename(filenameFromDisposition(result.disposition) || fileMetadata.fileName || item.title || item.name || item.id);
  const incomingHash = sha256(result.body);
  const record = target => {
    database.upsertFile({ courseId: course.id, contentId: item.id, title: filename, sourceUrl, localPath: target, sha256: incomingHash, byteSize: result.body.length });
    database.setFileValidators?.(course.id, item.id, result);
  };
  const canonical = database.findLocalFileByHash(incomingHash, canonicalCourseCode || baseCourseCode(course.courseId || course.externalId || course.id));
  if (canonical?.path && fileMatches(canonical.path, incomingHash)) {
    record(canonical.path);
    return { downloaded: false, unchanged: true, deduplicated: true, path: canonical.path, bytes: result.body.length };
  }
  const directory = path.join(downloadRoot, safeFilename(termName || 'No term'), safeFilename(course.courseId || course.externalId || course.id));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let target = path.join(directory, filename);
  try {
    if (sha256(await fs.readFile(target)) !== incomingHash) {
      const extension = path.extname(filename);
      target = path.join(directory, `${path.basename(filename, extension)}-${incomingHash}${extension}`);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const written = atomicWrite(target, result.body);
  record(target);
  return { downloaded: written, unchanged: !written, path: target, bytes: result.body.length };
}

function baseCourseCode(value) {
  const text = String(value || '');
  return text.match(/^([A-Z]{2}(?:\d{4}|\d{3}[A-Z]))_\d{2}$/)?.[1] || text;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function filenameFromDisposition(value) {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value || '');
  if (encoded) {
    try { return decodeURIComponent(encoded[1]); } catch { return encoded[1]; }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value || '');
  return plain?.[1] || null;
}
