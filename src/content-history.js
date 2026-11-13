import { parseFragment } from 'parse5';
import { fingerprint } from './io.js';

const settingKey = courseId => `content-history:${courseId}`;

export function migrateContentHistory(archive) {
  if (archive.db.prepare('PRAGMA user_version').get().user_version >= 6) return;
  archive.db.exec('BEGIN IMMEDIATE');
  try {
    archive.db.exec(`
    CREATE TABLE IF NOT EXISTS content_versions (
      version INTEGER PRIMARY KEY AUTOINCREMENT, course_id TEXT NOT NULL, content_id TEXT NOT NULL,
      parent_id TEXT, fingerprint TEXT NOT NULL, json TEXT NOT NULL,
      observed_at TEXT NOT NULL, captured_at TEXT NOT NULL, run_id INTEGER, source TEXT NOT NULL,
      provenance_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS content_versions_item ON content_versions(course_id,content_id,version);
    PRAGMA user_version=6; COMMIT;`);
  } catch (error) { archive.db.exec('ROLLBACK'); throw error; }
}

function transaction(archive, action) {
  archive.db.exec('SAVEPOINT content_history');
  try { const result = action(); archive.db.exec('RELEASE content_history'); return result; }
  catch (error) { archive.db.exec('ROLLBACK TO content_history; RELEASE content_history'); throw error; }
}

export function historyEnabled(archive, courseId) {
  return archive.db.prepare('SELECT value FROM meta WHERE key=?').get(settingKey(courseId))?.value === 'true';
}

function snapshot(archive, row, source, detailStatus) {
  const value = JSON.parse(row.json);
  // Server timestamps alone are not a new wording/metadata version.
  const meaningful = { ...value, parentId: row.parent_id };
  for (const key of ['modified', 'modifiedDate', 'lastModified', 'lastModifiedDate']) delete meaningful[key];
  const digest = fingerprint(meaningful);
  const latest = archive.db.prepare('SELECT fingerprint FROM content_versions WHERE course_id=? AND content_id=? ORDER BY version DESC LIMIT 1').get(row.course_id, row.id);
  if (latest?.fingerprint === digest) return;
  const provenance = archive.provenance('content', row);
  if (source === 'refresh') {
    // The summary is updated after upsertContent; do not attach its previous detail status to this observation.
    provenance.detail_status = detailStatus || 'unknown';
    provenance.detail_checked_at = detailStatus === 'complete' ? row.synced_at : null;
  }
  archive.db.prepare(`INSERT INTO content_versions(course_id,content_id,parent_id,fingerprint,json,observed_at,captured_at,run_id,source,provenance_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(row.course_id, row.id, row.parent_id, digest, row.json,
    row.synced_at, new Date().toISOString(), source === 'refresh' ? archive.activeRunId || null : null,
    source, JSON.stringify(provenance));
}

export function configureHistory(archive, courseIds, enabled) {
  return transaction(archive, () => {
    for (const courseId of courseIds) {
      if (enabled) for (const row of archive.db.prepare('SELECT * FROM content WHERE course_id=?').iterate(courseId)) snapshot(archive, row, 'baseline');
      archive.setMeta(settingKey(courseId), enabled);
    }
    return historyStatus(archive, courseIds);
  });
}

function scope(courseIds) {
  return { sql: `course_id IN (${courseIds.map(() => '?').join(',') || 'NULL'})`, params: courseIds };
}

export function historyStatus(archive, courseIds) {
  const where = scope(courseIds);
  const storage = archive.db.prepare(`SELECT COUNT(*) AS versions, COALESCE(SUM(length(CAST(json AS BLOB))+length(CAST(provenance_json AS BLOB))),0) AS payloadBytes FROM content_versions WHERE ${where.sql}`).get(...where.params);
  return { courses: courseIds.map(courseId => ({ courseId, enabled: historyEnabled(archive, courseId) })), ...storage };
}

export function readHistory(archive, courseId, contentId, version) {
  const rows = archive.db.prepare(`SELECT * FROM content_versions WHERE course_id=? AND content_id=? ORDER BY version`).all(courseId, contentId);
  const describe = row => ({ version: row.version, observedAt: row.observed_at, capturedAt: row.captured_at,
    runId: row.run_id, source: row.source, parentId: row.parent_id, fingerprint: row.fingerprint,
    provenance: JSON.parse(row.provenance_json) });
  if (version === undefined) return rows.map(row => ({ ...describe(row), title: JSON.parse(row.json).title || '' }));
  const index = rows.findIndex(row => row.version === version);
  if (index < 0) throw new Error('Content version not found in this course/item.');
  const expand = row => row ? { ...describe(row), text: contentText(JSON.parse(row.json)), item: JSON.parse(row.json) } : null;
  return { courseId, contentId, before: expand(rows[index - 1]), after: expand(rows[index]) };
}

// Keep the newest N observations per item, including its latest retained baseline.
// Preview is the default; freed SQLite pages remain reusable in the database.
export function pruneHistory(archive, courseIds, keep, apply = false) {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('keep must be a positive integer.');
  return transaction(archive, () => {
    const where = scope(courseIds);
    const sql = `SELECT version FROM (SELECT version, ROW_NUMBER() OVER (PARTITION BY course_id,content_id ORDER BY version DESC) AS position FROM content_versions WHERE ${where.sql}) WHERE position>?`;
    const count = archive.db.prepare(`SELECT COUNT(*) AS count FROM (${sql})`).get(...where.params, keep).count;
    if (apply) archive.db.prepare(`DELETE FROM content_versions WHERE version IN (${sql})`).run(...where.params, keep);
    return { dryRun: !apply, versionsToRemove: count, keepPerItem: keep };
  });
}

export function attachContentHistory(Type) {
  const original = Type.prototype.upsertContent;
  Type.prototype.upsertContent = function (courseId, parentId, item, { detailStatus } = {}) {
    if (!historyEnabled(this, courseId)) return original.call(this, courseId, parentId, item);
    return transaction(this, () => {
      const previous = this.db.prepare('SELECT * FROM content WHERE course_id=? AND id=?').get(courseId, item.id);
      if (previous) snapshot(this, previous, 'baseline');
      const result = original.call(this, courseId, parentId, item);
      snapshot(this, this.db.prepare('SELECT * FROM content WHERE course_id=? AND id=?').get(courseId, item.id), 'refresh', detailStatus);
      return result;
    });
  };
}

function contentText(item) {
  const body = item.body ?? item.description ?? item.text ?? '';
  const html = typeof body === 'string' ? body : body.rawText ?? body.displayText ?? body.text ?? '';
  const walk = node => {
    if (['script', 'style'].includes(node.tagName)) return '';
    if (node.nodeName === '#text') return node.value;
    const edge = ['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'pre'].includes(node.tagName) ? '\n' : '';
    return edge + (node.tagName === 'br' ? '\n' : '') + (node.childNodes || []).map(walk).join('') + edge;
  };
  return walk(parseFragment(String(html))).replace(/\n{3,}/g, '\n\n').trim();
}
