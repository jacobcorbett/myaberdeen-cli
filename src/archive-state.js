import { fingerprint } from './io.js';
import { normaliseAvailability } from './api.js';

export const DATASETS = ['content', 'announcements', 'grades', 'schedules', 'conversations', 'messages', 'discussion_posts', 'file_candidates'];
export const SECTION_TABLES = { content: ['content', 'file_candidates'], announcements: ['announcements'], grades: ['grades'], schedule: ['schedules'], messages: ['conversations', 'messages'], discussions: ['discussion_posts'], panopto: ['recordings'], 'assessment-reviews': ['assessment_reviews'] };
export function recordKey(table, row) { return table === 'messages' ? `${row.conversation_id}:${row.id}` : table === 'discussion_posts' ? `${row.forum_id}:${row.id}` : table === 'file_candidates' ? row.content_id : row.id; }

export function migrateState(archive) {
  const db = archive.db;
  if (db.prepare('PRAGMA user_version').get().user_version >= 2) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const add = (table, column, type) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); };
    add('sync_runs', 'scope_json', "TEXT NOT NULL DEFAULT '[]'");
    add('sync_runs', 'options_json', "TEXT NOT NULL DEFAULT '{}'");
    add('sync_runs', 'metrics_json', "TEXT NOT NULL DEFAULT '{}'");
    for (const column of ['etag', 'last_modified', 'checked_at']) add('files', column, 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_sections (
        run_id INTEGER NOT NULL, course_id TEXT NOT NULL, section TEXT NOT NULL,
        status TEXT NOT NULL, checked_at TEXT NOT NULL, PRIMARY KEY(run_id,course_id,section));
      CREATE TABLE IF NOT EXISTS course_runs (run_id INTEGER NOT NULL,course_id TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(run_id,course_id));
      CREATE TABLE IF NOT EXISTS record_state (
        dataset TEXT NOT NULL,course_id TEXT NOT NULL,record_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
        presence TEXT NOT NULL DEFAULT 'unknown',last_seen_run INTEGER,last_seen_at TEXT,last_changed_at TEXT,
        PRIMARY KEY(dataset,course_id,record_id));
      CREATE TABLE IF NOT EXISTS archive_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER,course_id TEXT NOT NULL,dataset TEXT NOT NULL,
        record_id TEXT NOT NULL,kind TEXT NOT NULL,title TEXT,occurred_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_summaries (
        course_id TEXT NOT NULL,content_id TEXT NOT NULL,parent_id TEXT,fingerprint TEXT NOT NULL,json TEXT NOT NULL,
        summary_checked_at TEXT NOT NULL,detail_checked_at TEXT,detail_status TEXT NOT NULL DEFAULT 'summary',
        PRIMARY KEY(course_id,content_id));
      CREATE TABLE IF NOT EXISTS file_candidates (
        course_id TEXT NOT NULL,content_id TEXT NOT NULL,parent_id TEXT NOT NULL,title TEXT,json TEXT NOT NULL,
        synced_at TEXT NOT NULL,PRIMARY KEY(course_id,content_id));
      CREATE TABLE IF NOT EXISTS file_versions (
        course_id TEXT NOT NULL,content_id TEXT NOT NULL,sha256 TEXT NOT NULL,local_path TEXT NOT NULL,byte_size INTEGER,
        first_seen_at TEXT NOT NULL,PRIMARY KEY(course_id,content_id,sha256));
      CREATE INDEX IF NOT EXISTS archive_changes_course ON archive_changes(course_id,id);
      CREATE INDEX IF NOT EXISTS record_state_run ON record_state(dataset,course_id,last_seen_run);
    `);
    const state = db.prepare('INSERT OR IGNORE INTO record_state(dataset,course_id,record_id,fingerprint,last_seen_at,last_changed_at) VALUES(?,?,?,?,?,?)');
    for (const table of DATASETS) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all()) state.run(table, row.course_id, recordKey(table, row), fingerprint(table === 'content' ? { ...JSON.parse(row.json), parentId: row.parent_id } : JSON.parse(row.json)), row.synced_at, row.synced_at);
    }
    for (const row of db.prepare('SELECT id,json FROM courses').all()) db.prepare('UPDATE courses SET available=? WHERE id=?').run(normaliseAvailability(JSON.parse(row.json)), row.id);
    for (const row of db.prepare('SELECT * FROM files').all()) state.run('files', row.course_id, row.content_id, fingerprint({ sha256: row.sha256, title: row.title, sourceUrl: row.source_url }), row.synced_at, row.synced_at);
    db.exec(`INSERT OR IGNORE INTO file_versions SELECT course_id,content_id,sha256,local_path,byte_size,synced_at FROM files WHERE local_path IS NOT NULL AND sha256 IS NOT NULL; PRAGMA user_version=2; COMMIT;`);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export const stateMethods = {
  observe(dataset, courseId, recordId, value, { title = '', unchanged = false } = {}) {
    if (!this.activeRunId || !recordId) return;
    const previous = this.db.prepare('SELECT * FROM record_state WHERE dataset=? AND course_id=? AND record_id=?').get(dataset, courseId, recordId);
    const currentHash = unchanged && previous ? previous.fingerprint : fingerprint(value);
    const kind = !previous ? 'added' : previous.presence === 'historical' ? 'restored' : previous.fingerprint !== currentHash ? 'changed' : null;
    const now = new Date().toISOString();
    if (kind) this.db.prepare('INSERT INTO archive_changes(run_id,course_id,dataset,record_id,kind,title,occurred_at) VALUES(?,?,?,?,?,?,?)').run(this.activeRunId, courseId, dataset, recordId, kind, title, now);
    this.db.prepare(`INSERT INTO record_state VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dataset,course_id,record_id) DO UPDATE SET fingerprint=excluded.fingerprint,presence='current',last_seen_run=excluded.last_seen_run,last_seen_at=excluded.last_seen_at,last_changed_at=excluded.last_changed_at`)
      .run(dataset, courseId, recordId, currentHash, 'current', this.activeRunId, now, kind ? now : previous?.last_changed_at || now);
  },
  setScope(runId, courses, options = {}) {
    this.db.prepare('UPDATE sync_runs SET scope_json=?,options_json=? WHERE id=?').run(JSON.stringify(courses.map(c => c.id)), JSON.stringify(options), runId);
  },
  courseResult(runId, courseId, status) { this.db.prepare('INSERT OR REPLACE INTO course_runs VALUES(?,?,?)').run(runId, courseId, status); },
  finishSection(runId, courseId, section, status) {
    this.db.prepare('INSERT OR REPLACE INTO sync_sections VALUES(?,?,?,?,?)').run(runId, courseId, section, status, new Date().toISOString());
    if (status !== 'completed') return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of SECTION_TABLES[section] || []) {
        const absent = this.db.prepare("SELECT * FROM record_state WHERE dataset=? AND course_id=? AND presence!='historical' AND (last_seen_run IS NULL OR last_seen_run!=?)").all(table, courseId, runId);
        for (const row of absent) {
          this.db.prepare('INSERT INTO archive_changes(run_id,course_id,dataset,record_id,kind,occurred_at) VALUES(?,?,?,?,?,?)').run(runId, courseId, table, row.record_id, 'no-longer-visible', new Date().toISOString());
          this.db.prepare("UPDATE record_state SET presence='historical' WHERE dataset=? AND course_id=? AND record_id=?").run(table, courseId, row.record_id);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  },
  getContent(courseId, id) { const row = this.db.prepare('SELECT json FROM content WHERE course_id=? AND id=?').get(courseId, id); return row ? JSON.parse(row.json) : null; },
  getSummary(courseId, id) { return this.db.prepare('SELECT * FROM content_summaries WHERE course_id=? AND content_id=?').get(courseId, id); },
  rememberSummary(courseId, parentId, item, complete) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO content_summaries VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(course_id,content_id) DO UPDATE SET parent_id=excluded.parent_id,fingerprint=excluded.fingerprint,json=excluded.json,summary_checked_at=excluded.summary_checked_at,detail_checked_at=COALESCE(excluded.detail_checked_at,detail_checked_at),detail_status=excluded.detail_status`)
      .run(courseId, item.id, parentId, fingerprint({ parentId, item }), JSON.stringify(item), now, complete ? now : null, complete ? 'complete' : 'stale');
  },
  discoverFile(courseId, parentId, item) {
    this.observe('file_candidates', courseId, item.id, item, { title: item.title || item.id });
    this.db.prepare('INSERT INTO file_candidates VALUES(?,?,?,?,?,?) ON CONFLICT(course_id,content_id) DO UPDATE SET parent_id=excluded.parent_id,title=excluded.title,json=excluded.json,synced_at=excluded.synced_at').run(courseId, item.id, parentId, item.title || '', JSON.stringify(item), new Date().toISOString());
  },
  getFile(courseId, id) { return this.db.prepare('SELECT * FROM files WHERE course_id=? AND content_id=?').get(courseId, id) || null; },
  fileState(courseId, id) {
    return this.db.prepare("SELECT presence,last_seen_at FROM record_state WHERE course_id=? AND ((dataset='file_candidates' AND record_id=?) OR (dataset='content' AND record_id=?)) ORDER BY CASE dataset WHEN 'file_candidates' THEN 0 ELSE 1 END LIMIT 1").get(courseId, id, id.split(':attachment:')[0]) || { presence: 'unknown' };
  },
  setFileValidators(courseId, id, values = {}) {
    this.db.prepare('UPDATE files SET etag=?,last_modified=?,checked_at=? WHERE course_id=? AND content_id=?').run(values.etag || null, values.lastModified || null, new Date().toISOString(), courseId, id);
    this.db.prepare('INSERT OR IGNORE INTO file_versions SELECT course_id,content_id,sha256,local_path,byte_size,synced_at FROM files WHERE course_id=? AND content_id=? AND sha256 IS NOT NULL AND local_path IS NOT NULL').run(courseId, id);
  },
  provenance(table, row) {
    const state = this.db.prepare('SELECT presence,last_seen_at,last_changed_at,last_seen_run FROM record_state WHERE dataset=? AND course_id=? AND record_id=?').get(table, row.course_id, recordKey(table, row));
    const detail = table === 'content' ? this.getSummary(row.course_id, row.id) : null;
    return { ...(state || { presence: 'unknown', last_seen_at: row.synced_at }), ...(detail ? { detail_status: detail.detail_status, detail_checked_at: detail.detail_checked_at } : {}) };
  },
  sections(courseId) { return this.db.prepare('SELECT * FROM sync_sections s WHERE course_id=? AND run_id=(SELECT MAX(run_id) FROM sync_sections WHERE course_id=s.course_id AND section=s.section) ORDER BY section').all(courseId); },
  changes({ courseIds, since = 0, limit = 500 } = {}) {
    const numeric = /^\d+$/.test(String(since));
    if (courseIds && !courseIds.length) return [];
    const threshold = numeric ? Number(since) : new Date(since).toISOString();
    const scope = courseIds ? ` AND course_id IN (${courseIds.map(() => '?').join(',')})` : '';
    return this.db.prepare(`SELECT * FROM archive_changes WHERE ${numeric ? 'id>?' : 'occurred_at>?'}${scope} ORDER BY id LIMIT ?`)
      .all(threshold, ...(courseIds || []), limit);
  },
  errors(runId) { return this.db.prepare('SELECT course_id,section,occurred_at,error FROM sync_errors WHERE run_id=? ORDER BY id').all(runId); },
  recoverInterruptedRuns() { this.db.prepare("UPDATE sync_runs SET status='interrupted',finished_at=?,error='Previous process ended before completion.' WHERE status='running'").run(new Date().toISOString()); }
};

export function attachTracking(Type) {
  Object.assign(Type.prototype, stateMethods);
  const specs = {
    upsertContent: (course, parent, item) => ['content', course, item.id, { ...item, parentId: parent }, item.title],
    upsertAnnouncement: (course, item) => ['announcements', course, item.id, item, item.title],
    upsertGrade: (course, item) => ['grades', course, item.id || item.columnId || item.gradebookColumn?.id, item, item.gradebookColumn?.name],
    upsertSchedule: (course, item, index) => ['schedules', course, item.id || item.eventId || `${item.start || item.startDate || 'event'}-${index}`, item, item.title],
    upsertConversation: (course, item) => ['conversations', course, item.id, item, ''],
    upsertMessage: (course, conversation, item) => ['messages', course, `${conversation}:${item.id}`, item, ''],
    upsertDiscussionPost: (course, forum, item) => ['discussion_posts', course, `${forum}:${item.id}`, item, item.subject]
  };
  for (const [method, describe] of Object.entries(specs)) {
    const original = Type.prototype[method];
    Type.prototype[method] = function (...args) {
      const result = original.apply(this, args);
      const [dataset, course, id, value, title] = describe(...args);
      this.observe(dataset, course, id, value, { title: title || '' });
      return result;
    };
  }
}
