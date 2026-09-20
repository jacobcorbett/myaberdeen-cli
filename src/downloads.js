import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { parseFragment } from 'parse5';

export function safeFilename(value, fallback = 'untitled') {
  const cleaned = String(value || fallback)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[. -]+|[. ]+$/g, '')
    .slice(0, 180);
  return cleaned || fallback;
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

export async function downloadContentFile({ session, database, downloadRoot, course, termName, item }) {
  const fileMetadata = item?.contentDetail?.['resource/x-bb-file']?.file || {};
  const sourceUrl = sourceRoute(course.id, item);
  const result = await session.getBinary(sourceUrl);
  if (/text\/html/i.test(result.contentType)) {
    throw new Error('Blackboard returned an HTML viewer rather than a file; previous file record preserved.');
  }

  const filename = safeFilename(filenameFromDisposition(result.disposition) || fileMetadata.fileName || item.title || item.name || item.id);
  const incomingHash = sha256(result.body);
  const canonical = database.findLocalFileByHash(incomingHash, baseCourseCode(course.courseId || course.externalId || course.id));
  if (canonical?.path) {
    try {
      if (sha256(await fs.readFile(canonical.path)) !== incomingHash) throw new Error('Stale file hash');
      database.upsertFile({ courseId: course.id, contentId: item.id, title: filename, sourceUrl, localPath: canonical.path, sha256: incomingHash, byteSize: result.body.length });
      return { downloaded: false, unchanged: true, deduplicated: true, path: canonical.path };
    } catch {
      // A stale catalogue entry should not prevent a fresh download.
    }
  }
  const directory = path.join(downloadRoot, safeFilename(termName || 'No term'), safeFilename(course.courseId || course.externalId || course.id));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let target = path.join(directory, filename);
  try {
    const existing = await fs.readFile(target);
    const existingHash = sha256(existing);
    if (existingHash === incomingHash) {
      database.upsertFile({ courseId: course.id, contentId: item.id, title: filename, sourceUrl, localPath: target, sha256: incomingHash, byteSize: result.body.length });
      return { downloaded: false, unchanged: true, path: target };
    }
    const extension = path.extname(filename);
    target = path.join(directory, `${path.basename(filename, extension)}-${incomingHash}${extension}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(target, result.body, { mode: 0o600 });
  const hash = sha256(result.body);
  database.upsertFile({ courseId: course.id, contentId: item.id, title: filename, sourceUrl, localPath: target, sha256: hash, byteSize: result.body.length });
  return { downloaded: true, path: target, bytes: result.body.length };
}

function baseCourseCode(value) {
  const text = String(value || '');
  if (text.startsWith('MGD_CS3026')) return 'CS3026';
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
