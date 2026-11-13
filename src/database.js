import path from 'node:path';
import { migrateContentHistory, attachContentHistory } from './content-history.js';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { normaliseAvailability } from './api.js';
import { migrateState, attachTracking } from './archive-state.js';
import { safeMessage, fileMatches } from './io.js';
import { migratePanopto } from './panopto-data.js';
import { migrateAssessmentReviews } from './assessment-reviews.js';
import { migrateRoster } from './roster.js';

export class ArchiveDatabase {
  constructor(databasePath, { readOnly = false } = {}) {
    if (!readOnly) fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.path = databasePath;
    const existed = fs.existsSync(databasePath);
    this.db = new DatabaseSync(databasePath, { readOnly });
    if (readOnly) return;
    if (existed && this.db.prepare('PRAGMA user_version').get().user_version < 6) {
      const version = 6;
      const backup = `${databasePath}.pre-v${version}-${Date.now()}.bak`;
      this.db.prepare('VACUUM INTO ?').run(backup); fs.chmodSync(backup, 0o600);
      this.backupPath = backup;
    }
    fs.chmodSync(databasePath, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.migrate();
    migrateState(this);
    migratePanopto(this);
    migrateAssessmentReviews(this);
    migrateRoster(this);
    migrateContentHistory(this);
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_checks (run_id INTEGER NOT NULL,course_id TEXT NOT NULL,content_id TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(run_id,course_id,content_id));
      CREATE TABLE IF NOT EXISTS text_extractions (sha256 TEXT NOT NULL,extractor_version TEXT NOT NULL,local_path TEXT,status TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT,PRIMARY KEY(sha256,extractor_version));
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        course_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY,
        course_code TEXT,
        name TEXT,
        term_id TEXT,
        term_name TEXT,
        available INTEGER,
        synced_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS content (
        id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        parent_id TEXT,
        title TEXT,
        handler TEXT,
        has_children INTEGER,
        synced_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (course_id, id)
      );
      CREATE TABLE IF NOT EXISTS announcements (
        id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT,
        modified_at TEXT,
        synced_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (course_id, id)
      );
      CREATE TABLE IF NOT EXISTS grades (
        id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        title TEXT,
        due_at TEXT,
        score REAL,
        status TEXT,
        synced_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (course_id, id)
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        title TEXT,
        start_at TEXT,
        end_at TEXT,
        synced_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (course_id, id)
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT,
        message_count INTEGER,
        synced_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (course_id, id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_id TEXT,
        posted_at TEXT,
        message_type TEXT,
        synced_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (course_id, conversation_id, id)
      );
      CREATE TABLE IF NOT EXISTS discussion_posts (
        id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        forum_id TEXT NOT NULL,
        thread_id TEXT,
        parent_id TEXT,
        subject TEXT,
        author_id TEXT,
        posted_at TEXT,
        synced_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (course_id, forum_id, id)
      );
      CREATE TABLE IF NOT EXISTS sync_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER,
        course_id TEXT,
        section TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        error TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_files (
        path TEXT PRIMARY KEY,
        course_code TEXT,
        sha256 TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        source TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        course_id TEXT NOT NULL,
        content_id TEXT NOT NULL,
        title TEXT,
        source_url TEXT NOT NULL,
        local_path TEXT,
        sha256 TEXT,
        byte_size INTEGER,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (course_id, content_id)
      );
      CREATE INDEX IF NOT EXISTS content_course_parent ON content(course_id, parent_id);
      CREATE INDEX IF NOT EXISTS announcements_course ON announcements(course_id);
      CREATE INDEX IF NOT EXISTS grades_course ON grades(course_id);
      CREATE INDEX IF NOT EXISTS messages_course ON messages(course_id);
      CREATE INDEX IF NOT EXISTS discussion_posts_course ON discussion_posts(course_id);
      CREATE INDEX IF NOT EXISTS sync_errors_run ON sync_errors(run_id);
      CREATE INDEX IF NOT EXISTS local_files_hash ON local_files(sha256);
    `);
  }

  startRun() {
    const result = this.db.prepare('INSERT INTO sync_runs(started_at, status) VALUES (?, ?)').run(new Date().toISOString(), 'running');
    this.activeRunId = Number(result.lastInsertRowid);
    return this.activeRunId;
  }

  finishRun(id, status, courseCount, error = null) {
    this.activeRunId = null;
    this.db.prepare('UPDATE sync_runs SET finished_at=?, status=?, course_count=?, error=? WHERE id=?')
      .run(new Date().toISOString(), status, courseCount, error, id);
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }

  upsertCourse(course, termName) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO courses(id,course_code,name,term_id,term_name,available,synced_at,json)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      course_code=excluded.course_code,name=excluded.name,term_id=excluded.term_id,term_name=excluded.term_name,
      available=excluded.available,synced_at=excluded.synced_at,json=excluded.json`)
      .run(course.id, course.courseId || course.externalId || course.id, course.name || '', course.termId || null,
        termName || null, normaliseAvailability(course),
        now, JSON.stringify(course));
  }

  upsertContent(courseId, parentId, item) {
    const handler = item.contentHandler?.id || item.contentHandler || item.type || '';
    this.db.prepare(`INSERT INTO content(id,course_id,parent_id,title,handler,has_children,synced_at,json)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(course_id,id) DO UPDATE SET
      parent_id=excluded.parent_id,title=excluded.title,handler=excluded.handler,has_children=excluded.has_children,
      synced_at=excluded.synced_at,json=excluded.json`)
      .run(item.id, courseId, parentId, item.title || item.name || '', String(handler), item.hasChildren ? 1 : 0,
        new Date().toISOString(), JSON.stringify(item));
  }

  upsertAnnouncement(courseId, item) {
    this.db.prepare(`INSERT INTO announcements(id,course_id,title,created_at,modified_at,synced_at,json)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(course_id,id) DO UPDATE SET
      title=excluded.title,created_at=excluded.created_at,modified_at=excluded.modified_at,synced_at=excluded.synced_at,json=excluded.json`)
      .run(item.id, courseId, item.title || item.subject || '', item.created || item.createdDate || null,
        item.modified || item.modifiedDate || null, new Date().toISOString(), JSON.stringify(item));
  }

  upsertGrade(courseId, item) {
    const id = item.id || item.columnId || item.gradebookColumn?.id;
    if (!id) return;
    const column = item.gradebookColumn || item.column || item;
    this.db.prepare(`INSERT INTO grades(id,course_id,title,due_at,score,status,synced_at,json)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(course_id,id) DO UPDATE SET
      title=excluded.title,due_at=excluded.due_at,score=excluded.score,status=excluded.status,synced_at=excluded.synced_at,json=excluded.json`)
      .run(id, courseId, column.effectiveColumnName || column.localizedColumnName || column.columnName || column.name || column.title || '', column.dueDate || item.dueDate || null,
        numericScore(item), item.status || item.gradeStatus || null, new Date().toISOString(), JSON.stringify(item));
  }

  upsertSchedule(courseId, item, index) {
    const id = item.id || item.eventId || `${item.start || item.startDate || 'event'}-${index}`;
    this.db.prepare(`INSERT INTO schedules(id,course_id,title,start_at,end_at,synced_at,json)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(course_id,id) DO UPDATE SET
      title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,synced_at=excluded.synced_at,json=excluded.json`)
      .run(id, courseId, item.title || item.name || '', item.start || item.startDate || null, item.end || item.endDate || null,
        new Date().toISOString(), JSON.stringify(item));
  }

  upsertConversation(courseId, item) {
    if (!item?.id) return;
    this.db.prepare(`INSERT INTO conversations(id,course_id,created_at,updated_at,message_count,synced_at,json)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(course_id,id) DO UPDATE SET
      created_at=excluded.created_at,updated_at=excluded.updated_at,message_count=excluded.message_count,
      synced_at=excluded.synced_at,json=excluded.json`)
      .run(item.id, courseId, item.createdDate || null, item.updatedDate || null, item.totalCount ?? null,
        new Date().toISOString(), JSON.stringify(item));
  }

  upsertMessage(courseId, conversationId, item) {
    if (!item?.id) return;
    this.db.prepare(`INSERT INTO messages(id,course_id,conversation_id,sender_id,posted_at,message_type,synced_at,json)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(course_id,conversation_id,id) DO UPDATE SET
      sender_id=excluded.sender_id,posted_at=excluded.posted_at,message_type=excluded.message_type,
      synced_at=excluded.synced_at,json=excluded.json`)
      .run(item.id, courseId, conversationId, item.senderId || item.sender?.id || null, item.postDate || null,
        item.type || null, new Date().toISOString(), JSON.stringify(item));
  }

  upsertDiscussionPost(courseId, forumId, item) {
    if (!item?.id) return;
    this.db.prepare(`INSERT INTO discussion_posts(id,course_id,forum_id,thread_id,parent_id,subject,author_id,posted_at,synced_at,json)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(course_id,forum_id,id) DO UPDATE SET
      thread_id=excluded.thread_id,parent_id=excluded.parent_id,subject=excluded.subject,author_id=excluded.author_id,
      posted_at=excluded.posted_at,synced_at=excluded.synced_at,json=excluded.json`)
      .run(item.id, courseId, forumId, item.threadId || null, item.parentId || null, item.subject || '',
        item.lastUpdateUserId || item.userId || item.authorId || null, item.postDate || item.createdDate || null,
        new Date().toISOString(), JSON.stringify(item));
  }

  recordSyncError(runId, courseId, section, error) {
    this.db.prepare('INSERT INTO sync_errors(run_id,course_id,section,occurred_at,error) VALUES (?,?,?,?,?)')
      .run(runId || null, courseId || null, section, new Date().toISOString(), safeMessage(error));
  }

  upsertLocalFile(record) {
    this.db.prepare(`INSERT INTO local_files(path,course_code,sha256,byte_size,source,indexed_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
      course_code=excluded.course_code,sha256=excluded.sha256,byte_size=excluded.byte_size,
      source=excluded.source,indexed_at=excluded.indexed_at`)
      .run(record.path, record.courseCode || null, record.sha256, record.byteSize, record.source, new Date().toISOString());
  }

  findLocalFileByHash(sha256, courseCode = null) {
    const rows = this.db.prepare('SELECT * FROM local_files WHERE sha256=? ORDER BY CASE WHEN course_code=? THEN 0 ELSE 1 END,path').all(sha256, courseCode);
    return rows.find(row => fileMatches(row.path, sha256)) || null;
  }

  repointDownloadedFiles(sha256, localPath) {
    return this.db.prepare('UPDATE files SET local_path=? WHERE sha256=?').run(localPath, sha256).changes;
  }

  upsertFile(record) {
    this.db.prepare(`INSERT INTO files(course_id,content_id,title,source_url,local_path,sha256,byte_size,synced_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(course_id,content_id) DO UPDATE SET
      title=excluded.title,source_url=excluded.source_url,local_path=excluded.local_path,sha256=excluded.sha256,
      byte_size=excluded.byte_size,synced_at=excluded.synced_at`)
      .run(record.courseId, record.contentId, record.title, record.sourceUrl, record.localPath || null,
        record.sha256 || null, record.byteSize ?? null, new Date().toISOString());
    this.observe('files', record.courseId, record.contentId, { sha256: record.sha256, title: record.title, sourceUrl: record.sourceUrl }, { title: record.title });
  }

  status() {
    const counts = {};
    for (const table of ['courses', 'content', 'announcements', 'grades', 'schedules', 'conversations', 'messages', 'discussion_posts', 'files', 'local_files', 'sync_errors']) {
      counts[table] = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    }
    const lastRun = this.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() || null;
    if (lastRun) counts.sync_errors = this.db.prepare('SELECT COUNT(*) AS count FROM sync_errors WHERE run_id=?').get(lastRun.id).count;
    return { counts, lastRun };
  }

  close() {
    this.db.close();
  }
}

function numericScore(item) {
  const value = item.score ?? item.displayGrade?.score ?? item.grade?.score;
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

attachTracking(ArchiveDatabase);
attachContentHistory(ArchiveDatabase);
