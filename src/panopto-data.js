import { atomicWrite } from './io.js';
import path from 'node:path';
import { safeFilename } from './downloads.js';

export const PANOPTO_ORIGIN = 'https://abdn.cloud.panopto.eu';
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function recordingId(value) {
  if (!GUID.test(String(value || ''))) throw new Error('A valid Panopto recording/folder ID is required.');
  return value.toLowerCase();
}
export function viewerUrl(id, time) {
  const url = new URL('/Panopto/Pages/Viewer.aspx', PANOPTO_ORIGIN);
  url.searchParams.set('id', recordingId(id));
  if (Number.isFinite(time) && time >= 0) url.searchParams.set('start', String(time));
  return url.href;
}

// Only explicit Panopto viewer/embed/folder URLs count as discovery evidence.
export function panoptoLinks(value) {
  const recordings = new Set(), folders = new Set();
  const visit = input => {
    if (Array.isArray(input)) return input.forEach(visit);
    if (input && typeof input === 'object') return Object.values(input).forEach(visit);
    if (typeof input !== 'string') return;
    for (const match of input.replace(/&amp;/g, '&').matchAll(/https:\/\/[^\s<>"']+/g)) {
      let url; try { url = new URL(match[0]); } catch { continue; }
      if (url.origin !== PANOPTO_ORIGIN) continue;
      const id = url.searchParams.get('id');
      if (/\/Pages\/(Viewer|Embed)\.aspx$/i.test(url.pathname) && GUID.test(id || '')) recordings.add(id.toLowerCase());
      const fragment = new URLSearchParams(url.hash.slice(1));
      const folder = url.searchParams.get('folderID') || fragment.get('folderID');
      if (GUID.test(folder || '')) folders.add(folder.toLowerCase());
    }
  };
  visit(value); return { recordings: [...recordings], folders: [...folders] };
}

export function normaliseCaptions(rows) {
  if (!Array.isArray(rows)) throw new Error('Unexpected Panopto caption response; existing transcript retained.');
  return rows.map(row => {
    if (typeof row.Caption !== 'string' || !Number.isFinite(row.Time) || row.Time < 0
      || !Number.isFinite(row.CaptionDuration) || row.CaptionDuration < 0) throw new Error('Invalid Panopto caption timing or text.');
    return { start: row.Time, duration: row.CaptionDuration, text: row.Caption };
  }).sort((a, b) => a.start - b.start);
}
export function formatDuration(seconds) {
  const value = seconds === null || seconds === undefined || seconds === '' ? NaN : Number(seconds);
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  const total = Math.round(value);
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), secs = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}
function clock(seconds, separator = '.') {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
}
export function transcriptText(captions, format = 'text') {
  if (!['text', 'srt', 'vtt', 'json'].includes(format)) throw new Error('Transcript format must be text, srt, vtt or json.');
  if (format === 'json') return JSON.stringify(captions, null, 2) + '\n';
  if (format === 'text') return captions.map(c => `[${clock(c.start)}] ${c.text}`).join('\n') + '\n';
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + captions.map((c, i) => `${format === 'srt' ? `${i + 1}\n` : ''}${clock(c.start, format === 'srt' ? ',' : '.')} --> ${clock(c.start + c.duration, format === 'srt' ? ',' : '.')}\n${c.text.replace(/\r?\n\s*\r?\n/g, '\n')}`).join('\n\n') + '\n';
}

export function migratePanopto(archive) {
  if (archive.db.prepare('PRAGMA user_version').get().user_version >= 3) return;
  archive.db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS recordings (
      course_id TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,folder_id TEXT,
      checked_at TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(course_id,id));
    CREATE TABLE IF NOT EXISTS recording_folders (
      course_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT,source TEXT NOT NULL,
      checked_at TEXT NOT NULL,PRIMARY KEY(course_id,id));
    CREATE TABLE IF NOT EXISTS recording_assets (
      course_id TEXT NOT NULL,recording_id TEXT NOT NULL,kind TEXT NOT NULL,
      sha256 TEXT NOT NULL,local_path TEXT NOT NULL,byte_size INTEGER NOT NULL,
      checked_at TEXT NOT NULL,PRIMARY KEY(course_id,recording_id,kind,sha256));
    PRAGMA user_version=3; COMMIT;`);
}
export function hasPanopto(database) {
  return database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recordings'").get() !== undefined;
}
export function storeRecording(database, courseId, recording) {
  const now = new Date().toISOString();
  database.db.exec('BEGIN IMMEDIATE');
  try {
    // Playback position changes on viewing, not on lecture content changes.
    const { playback, ...content } = recording;
    database.observe('recordings', courseId, recording.id, content, { title: recording.title });
    database.db.prepare(`INSERT INTO recordings VALUES(?,?,?,?,?,?) ON CONFLICT(course_id,id)
      DO UPDATE SET title=excluded.title,folder_id=excluded.folder_id,checked_at=excluded.checked_at,json=excluded.json`)
      .run(courseId, recording.id, recording.title, recording.folderId || null, now, JSON.stringify(recording));
    database.db.exec('COMMIT');
  } catch (error) { database.db.exec('ROLLBACK'); throw error; }
}
export function getRecordings(database, courseIds) {
  if (!hasPanopto(database)) return [];
  return database.db.prepare('SELECT * FROM recordings ORDER BY title,id').all().filter(r => courseIds.includes(r.course_id))
    .map(row => ({ ...JSON.parse(row.json), courseId: row.course_id, checkedAt: row.checked_at,
      presence: database.provenance('recordings', row).presence,
      assets: database.db.prepare('SELECT kind,sha256,local_path,byte_size,checked_at FROM recording_assets WHERE course_id=? AND recording_id=?').all(row.course_id, row.id) }));
}
export function searchRecordings(recordings, search) {
  const needle = search?.toLowerCase();
  return recordings.map(recording => {
    const matches = Object.entries(recording.transcripts || {}).flatMap(([language, track]) => track.captions
      .filter(c => !needle || c.text.toLowerCase().includes(needle)).map(c => ({ language, ...c, url: viewerUrl(recording.id, c.start) })));
    const { transcripts, ...summary } = recording;
    return { ...summary, languages: Object.keys(transcripts || {}), captionCount: Object.values(transcripts || {}).reduce((n, t) => n + t.captions.length, 0),
      ...(needle ? { matches } : {}) };
  }).filter(r => !needle || r.matches.length || `${r.title} ${r.description || ''} ${r.aiSummary || ''}`.toLowerCase().includes(needle));
}
export function exportRecordings(database, courseId, directory) {
  const recordings = getRecordings(database, [courseId]);
  for (const source of recordings) {
    const { checkedAt, ...record } = source;
    const root = path.join(directory, 'recordings', record.id);
    atomicWrite(path.join(root, 'recording.json'), JSON.stringify(record, null, 2) + '\n');
    for (const [language, track] of Object.entries(record.transcripts || {})) for (const format of ['text', 'srt', 'vtt']) {
      atomicWrite(path.join(root, `${safeFilename(language)}.${format === 'text' ? 'txt' : format}`), transcriptText(track.captions, format));
    }
    const lines = [`# ${record.title}`, '', `[Open recording](${record.url})`, '', `Duration: ${formatDuration(record.duration)}`,
      '', '## AI-generated summary', '', record.aiSummary || 'Not available.', '', '## Chapters', '',
      ...(record.chapters || []).map(c => `- [${clock(c.start)}](${viewerUrl(record.id, c.start)}) ${c.title}`),
      '', '## Transcript', '', 'Automatic captions may contain errors.', '',
      ...Object.entries(record.transcripts || {}).flatMap(([language, track]) => [`### ${language}`, '', ...track.captions.map(c => `[${clock(c.start)}](${viewerUrl(record.id, c.start)}) ${c.text}`), ''])];
    atomicWrite(path.join(root, 'README.md'), lines.join('\n'));
  }
  return recordings.map(({ checkedAt, ...record }) => record);
}
