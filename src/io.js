import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function atomicWrite(target, value, { mode = 0o600 } = {}) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  try { if (fs.readFileSync(target).equals(body)) return false; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(fd, body); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return true;
}
export function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
export function fileMatches(target, expectedHash) {
  if (!target || !expectedHash) return false;
  try { return hash(fs.readFileSync(target)) === expectedHash; }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
}
export function fingerprint(value) {
  const noise = new Set(['hitCount', 'hasBeenViewedByStudent', 'studentReviewedTimestamp', 'stateCompletion']);
  function normalise(input) {
    if (Array.isArray(input)) return input.map(normalise);
    if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().filter(k => !noise.has(k)).map(k => [k, normalise(input[k])]));
    if (typeof input === 'string' && /^https?:\/\//.test(input)) {
      try { const url = new URL(input); for (const key of [...url.searchParams.keys()]) if (/^(x-amz-|signature$|token$|expires$|policy$|key-pair-id$)/i.test(key)) url.searchParams.delete(key); return url.href; } catch { /* Ordinary strings stay unchanged. */ }
    }
    return input;
  }
  return hash(JSON.stringify(normalise(value)));
}
export function safeMessage(error) {
  return String(error?.message || error).replace(/https?:\/\/[^\s)"']+/gi, '[URL redacted]')
    .replace(/(?:authorization|cookie|x-blackboard-xsrf)\s*[:=][^\r\n]*/gi, '[authentication data redacted]');
}
export function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason || new Error('Operation cancelled.'); }
export function acquireLock(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const target = path.join(stateDir, 'operation.lock');
  try { fs.mkdirSync(target, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialise stale-owner checks so a second recovering process cannot remove
    // the first process's newly acquired lock. An unfinished recovery fails closed.
    const recovery = `${target}.recovery`;
    const busy = () => new Error('Another MyAberdeen operation holds or is recovering the local archive lock. Retry after it finishes.');
    try { fs.mkdirSync(recovery, { mode: 0o700 }); }
    catch (e) { if (e.code === 'EEXIST') throw busy(); throw e; }
    try {
      let owner;
      try { owner = JSON.parse(fs.readFileSync(path.join(target, 'owner.json'), 'utf8')); } catch { /* A process may still be claiming the lock. */ }
      let live = true;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') live = false; }
      }
      if (live) throw busy();
      const stale = `${target}.stale-${crypto.randomUUID()}`;
      fs.renameSync(target, stale); fs.rmSync(stale, { recursive: true });
      try { fs.mkdirSync(target, { mode: 0o700 }); }
      catch (e) { if (e.code === 'EEXIST') throw busy(); throw e; }
    } finally { fs.rmdirSync(recovery); }
  }
  const nonce = crypto.randomUUID();
  fs.writeFileSync(path.join(target, 'owner.json'), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
  return () => {
    try { if (JSON.parse(fs.readFileSync(path.join(target, 'owner.json'), 'utf8')).nonce === nonce) fs.rmSync(target, { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
