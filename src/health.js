import fs from 'node:fs';
import path from 'node:path';
import { constants } from 'node:fs';
import { lockStatus } from './io.js';
import { fileMatches } from './io.js';
import { getRecordings, searchRecordings, hasPanopto } from './panopto-data.js';

export function brief(database, config, courseIds) {
  const courses = database.db.prepare('SELECT * FROM courses ORDER BY course_code').all().filter(c => !courseIds || courseIds.includes(c.id));
  const cursor = database.db.prepare('SELECT MAX(id) id FROM archive_changes').get().id || 0;
  return { offline: true, asOf: new Date().toISOString(), cursor, database: config.databasePath,
    courses: courses.map(course => {
      const sections = database.sections(course.id);
      const metadataSections = ['content', 'announcements', 'grades', 'schedule', 'messages', 'discussions'];
      const freshness = section => {
        const row = sections.find(s => s.section === section);
        const checked = row && Number.isFinite(Date.parse(row.checked_at)) && Date.now() - Date.parse(row.checked_at) <= (config.freshnessMinutes ?? 60) * 60_000;
        return { status: row?.status || 'never-checked', checkedAt: row?.checked_at || null, stale: !checked || !['completed', 'unavailable'].includes(row.status), accessible: row ? row.status !== 'unavailable' : null };
      };
      const sectionFreshness = Object.fromEntries([...new Set([...metadataSections, ...sections.map(s => s.section)])].map(section => [section, freshness(section)]));
      const staleSections = metadataSections.filter(section => sectionFreshness[section].stale);
      const files = database.db.prepare('SELECT content_id,title,local_path,sha256,checked_at FROM files WHERE course_id=?').all(course.id);
      const extractions = database.db.prepare("SELECT f.content_id,x.local_path,x.updated_at FROM files f JOIN text_extractions x ON x.sha256=f.sha256 WHERE f.course_id=? AND x.status='complete'").all(course.id);
      const states = database.db.prepare('SELECT dataset,presence,COUNT(*) count FROM record_state WHERE course_id=? GROUP BY dataset,presence').all(course.id);
      return { id: course.id, code: course.course_code, name: course.name, available: course.available, courseCheckedAt: course.synced_at,
        stale: staleSections.length > 0, staleSections, sectionFreshness, inaccessibleSections: sections.filter(s => s.status === 'unavailable').map(s => s.section),
        recordings: searchRecordings(getRecordings(database, [course.id])),
        sections, counts: states, extractedText: extractions, lastTextExtractionAt: extractions.map(x => x.updated_at).sort().at(-1) || null, filesCheckedAt: sections.find(s => s.section === 'files')?.checked_at || null,
        files: files.map(f => ({ id: f.content_id, title: f.title, presence: database.fileState(course.id, f.content_id).presence, path: f.local_path, exists: !!f.local_path && fs.existsSync(f.local_path) })),
        recentChanges: database.db.prepare('SELECT * FROM archive_changes WHERE course_id=? ORDER BY id DESC LIMIT 20').all(course.id).reverse() };
    }) };
}
export function verifyFiles(database, { courseIds } = {}) {
  const rows = database.db.prepare('SELECT * FROM files').all().filter(r => !courseIds || courseIds.includes(r.course_id));
  if (hasPanopto(database)) rows.push(...database.db.prepare('SELECT course_id,recording_id AS content_id,local_path,sha256 FROM recording_assets').all().filter(r => !courseIds || courseIds.includes(r.course_id)));
  const checks = new Map(), issues = [];
  let verified = 0;
  for (const row of rows) {
    const key = `${row.local_path}:${row.sha256}`;
    if (!checks.has(key)) checks.set(key, !row.local_path || !fs.existsSync(row.local_path) ? 'missing' : fileMatches(row.local_path, row.sha256) ? 'verified' : 'mismatch');
    const status = checks.get(key);
    if (status === 'verified') verified++;
    else issues.push({ courseId: row.course_id, contentId: row.content_id, path: row.local_path, status });
  }
  return { records: rows.length, uniqueChecks: checks.size, verified, missing: issues.filter(x => x.status === 'missing').length, mismatched: issues.filter(x => x.status === 'mismatch').length, issues };
}
export function relocationPlan(database, { from, to, courseIds }) {
  const sourceRoot = path.resolve(from), destinationRoot = path.resolve(to);
  if (!fs.existsSync(destinationRoot)) throw new Error('Relocation destination is not accessible; mount it before retrying.');
  if (sourceRoot === destinationRoot) throw new Error('Relocation roots must differ.');
  const plan = [], skipped = [];
  const files = database.db.prepare('SELECT * FROM files').all().map(r => ({ ...r, kind: 'file' }));
  const current = new Set(files.map(r => JSON.stringify([r.course_id, r.content_id, r.sha256, r.local_path])));
  const versions = database.db.prepare('SELECT * FROM file_versions').all()
    .filter(r => !current.has(JSON.stringify([r.course_id, r.content_id, r.sha256, r.local_path])))
    .map(r => ({ ...r, kind: 'file-version' }));
  const recordings = hasPanopto(database) ? database.db.prepare('SELECT * FROM recording_assets').all()
    .map(r => ({ ...r, content_id: r.recording_id, assetKind: r.kind, kind: 'recording' })) : [];
  for (const row of [...files, ...versions, ...recordings].filter(r => !courseIds || courseIds.includes(r.course_id))) {
    if (!row.local_path) continue;
    const relative = path.relative(sourceRoot, row.local_path);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const target = path.join(destinationRoot, relative);
    const identity = { kind: row.kind, courseId: row.course_id, contentId: row.content_id, ...(row.assetKind ? { assetKind: row.assetKind } : {}) };
    if (!fileMatches(target, row.sha256)) { skipped.push({ ...identity, target, reason: 'Destination missing or hash differs' }); continue; }
    plan.push({ ...identity, from: row.local_path, to: target, sha256: row.sha256 });
  }
  return { plan, skipped };
}
export function applyRelocation(database, result) {
  database.db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of result.plan) {
      if (!fileMatches(row.to, row.sha256)) throw new Error('Relocation destination changed after planning.');
      let changed;
      if (row.kind === 'recording') {
        changed = database.db.prepare('UPDATE recording_assets SET local_path=? WHERE course_id=? AND recording_id=? AND kind=? AND sha256=? AND local_path=?')
          .run(row.to, row.courseId, row.contentId, row.assetKind, row.sha256, row.from).changes;
      } else if (row.kind === 'file-version') {
        changed = database.db.prepare('UPDATE file_versions SET local_path=? WHERE course_id=? AND content_id=? AND sha256=? AND local_path=?')
          .run(row.to, row.courseId, row.contentId, row.sha256, row.from).changes;
      } else if (row.kind === 'file' || row.kind === undefined) {
        changed = database.db.prepare('UPDATE files SET local_path=? WHERE course_id=? AND content_id=? AND local_path=? AND sha256=?').run(row.to, row.courseId, row.contentId, row.from, row.sha256).changes;
        database.db.prepare('UPDATE file_versions SET local_path=? WHERE course_id=? AND content_id=? AND sha256=? AND local_path=?').run(row.to, row.courseId, row.contentId, row.sha256, row.from);
      } else throw new Error('Unknown relocation item kind.');
      if (changed !== 1) throw new Error('Archive changed after relocation planning.');
    }
    database.db.exec('COMMIT');
  } catch (error) { database.db.exec('ROLLBACK'); throw error; }
  return result.plan.length;
}

function executableFound(command, env = process.env) {
  const extensions = process.platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  const roots = path.isAbsolute(command) || command.includes('/') || command.includes('\\') ? [''] : (env.PATH || '').split(path.delimiter);
  return roots.some(root => extensions.some(extension => {
    try {
      const target = root ? path.join(root, command + extension) : command + extension;
      if (!fs.statSync(target).isFile()) return false;
      fs.accessSync(target, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true;
    } catch { return false; }
  }));
}
export function localDoctor(config) {
  const configFound = fs.existsSync(config.configPath);
  const current = config.profiles?.current;
  const currentCoursesConfigured = Array.isArray(current) && current.length > 0 && current.every(c => typeof c === 'string' && c.trim());
  const chromeFound = executableFound(config.chromePath);
  const extractionTools = { pdftotext: executableFound(config.pdftotext || 'pdftotext'), office: true };
  const vaultConfigured = !!config.vaultRoot;
  const vaultFound = vaultConfigured && fs.existsSync(path.join(config.vaultRoot, 'Uni')) && fs.statSync(path.join(config.vaultRoot, 'Uni')).isDirectory();
  const operationLock = lockStatus(config.stateDir);
  const suggestions = [];
  if (operationLock.locked && operationLock.ownerAlive === false && !operationLock.recoveryPending) suggestions.push(`The dead owner of ${operationLock.path} will be recovered automatically by the next archive operation. Never remove Chrome profile locks.`);
  else if (operationLock.locked || operationLock.recoveryPending) suggestions.push(`An operation lock exists at ${operationLock.path}. Wait for active operations. If no myab or dedicated CLI Chrome process is running, inspect the lock owner before removing the operation.lock / operation.lock.recovery directories. Never remove Chrome profile locks.`);
  if (!chromeFound) suggestions.push('Install Google Chrome or set MYAB_CHROME to its executable path.');
  if (!configFound || !currentCoursesConfigured) suggestions.push('Run myab login, then myab setup to create configuration and choose current courses.');
  if (!fs.existsSync(config.databasePath)) suggestions.push('After setup, run myab check --active to create your local archive.');
  if (vaultConfigured && !vaultFound) suggestions.push('Obsidian vault is unavailable: mount it or configure a vault containing Uni with myab setup --vault <path>.');
  if (!extractionTools.pdftotext) suggestions.push('Optional PDF extraction: install Poppler (macOS: brew install poppler; Debian/Ubuntu: sudo apt install poppler-utils; Windows: install Poppler and add its bin directory to PATH).');
  return { node: process.version, platform: process.platform, chromeFound, configFound, currentCoursesConfigured,
    vaultConfigured, vaultFound, extractionTools, suggestions,
    databaseFound: fs.existsSync(config.databasePath), profileLocked: fs.existsSync(path.join(config.profileDir, 'SingletonLock')) || (() => { try { fs.lstatSync(path.join(config.profileDir, 'SingletonLock')); return true; } catch { return false; } })(),
    operationLock, operationLocked: operationLock.locked, lockRecoveryPending: operationLock.recoveryPending, configPath: config.configPath, downloadDir: config.downloadDir, chromePath: config.chromePath };
}
