import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PANOPTO_ORIGIN, recordingId } from './panopto-data.js';
import { throwIfAborted } from './io.js';

export function allowedMediaUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Invalid Panopto media URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
    || !(url.origin === PANOPTO_ORIGIN || url.hostname === 'download.cdn.cloud.panopto.eu' || /^[a-z0-9-]+\.cloudfront\.net$/i.test(url.hostname))) throw new Error('Panopto returned an unsupported media host. No credentials were forwarded.');
  return url;
}
export async function downloadRecording({ client, database, config, courseId, id, signal, dryRun = false, maxBytes = 2 * 1024 ** 3, fetchImpl = fetch }) {
  id = recordingId(id);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('--max-bytes must be a positive integer.');
  const { record, downloadUrl } = await client.recording(id);
  if (!record.downloadable || !downloadUrl) throw new Error('Panopto does not permit a download for this recording.');
  let url = allowedMediaUrl(downloadUrl);
  if (dryRun) return { dryRun: true, id, title: record.title, downloadable: true, maxBytes };
  const directory = path.join(config.downloadDir, '_panopto-media', id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${crypto.randomUUID()}.part`);
  let handle, response;
  try {
    for (let redirects = 0; redirects < 6; redirects++) {
      throwIfAborted(signal);
      const headers = { Accept: 'video/*,application/octet-stream' };
      if (url.origin === PANOPTO_ORIGIN) {
        const cookies = await client.context.cookies(url.href);
        if (cookies.length) headers.Cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
      try { response = await fetchImpl(url.href, { headers, redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) }); }
      catch { throw new Error('Panopto download failed or timed out.'); }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('Panopto download redirect had no destination.');
        url = allowedMediaUrl(new URL(location, url).href); response = null; continue;
      }
      break;
    }
    if (!response || response.status !== 200) throw new Error(`Panopto download unavailable${response ? ` (HTTP ${response.status})` : ''}.`);
    const type = response.headers.get('content-type') || '';
    if (!/^(video\/(mp4|x-m4v)|application\/octet-stream)(;|$)/i.test(type)) throw new Error('Panopto did not return a downloadable video file.');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) throw new Error('Recording exceeds --max-bytes; download was not saved.');
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    const hash = crypto.createHash('sha256'); let bytes = 0, prefix = Buffer.alloc(0);
    for await (const chunk of response.body) {
      throwIfAborted(signal); bytes += chunk.length;
      if (bytes > maxBytes) throw new Error('Recording exceeds --max-bytes; partial download discarded.');
      if (prefix.length < 512) prefix = Buffer.concat([prefix, Buffer.from(chunk).subarray(0, 512 - prefix.length)]);
      if (/^\s*(?:<!doctype|<html|<head|<body|\{\s*")/i.test(prefix.toString('utf8'))) throw new Error('Panopto returned an HTML or JSON error instead of media.');
      hash.update(chunk); await handle.writeFile(chunk);
    }
    if (!bytes || Number.isFinite(length) && length > 0 && bytes !== length) throw new Error('Panopto media download was incomplete.');
    await handle.sync(); await handle.close(); handle = null;
    const sha256 = hash.digest('hex'), target = path.join(directory, `${sha256}.mp4`);
    if (fs.existsSync(target)) {
      const existingHash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(target)) existingHash.update(chunk);
      if (existingHash.digest('hex') === sha256) fs.unlinkSync(temporary);
      else { fs.renameSync(target, `${target}.corrupt-${crypto.randomUUID()}`); fs.renameSync(temporary, target); }
    } else fs.renameSync(temporary, target);
    database.db.prepare('INSERT OR REPLACE INTO recording_assets VALUES(?,?,?,?,?,?,?)').run(courseId, id, 'video', sha256, target, bytes, new Date().toISOString());
    return { id, kind: 'video', path: target, sha256, bytes };
  } finally {
    await handle?.close();
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
