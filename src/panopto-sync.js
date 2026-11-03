import { PanoptoClient } from './panopto-browser.js';
import { panoptoLinks, recordingId, storeRecording } from './panopto-data.js';
import { AuthenticationRequiredError } from './browser.js';
import { safeMessage, throwIfAborted } from './io.js';

export function matchesCourseFolder(name, code, aliases = {}) {
  const endYear = String(code).match(/_(\d{2})$/)?.[1];
  if (!endYear) return false;
  const base = String(code).replace(/_\d{2}$/, '');
  const codes = (aliases[base] || base).match(/[A-Z]{2,}\d{4}/gi) || [];
  const words = String(name).replace(/<[^>]*>/g, '').toLowerCase();
  const year = 2000 + Number(endYear);
  return codes.some(c => new RegExp(`(^|[^a-z0-9])${c}([^a-z0-9]|$)`, 'i').test(words))
    && new RegExp(`(?:${year - 1}|${String(year - 1).slice(-2)})[\\s_–/-]+(?:${year}|${endYear})(?!\\d)`).test(words);
}
export function courseRecordingSources(database, course, config) {
  const rows = database.db.prepare(`SELECT c.json FROM content c LEFT JOIN record_state r ON r.dataset='content' AND r.course_id=c.course_id AND r.record_id=c.id
    WHERE c.course_id=? AND COALESCE(r.presence,'unknown')!='historical'`).all(course.id);
  const found = panoptoLinks(rows.map(r => JSON.parse(r.json)));
  const configured = config.panoptoFolders?.[course.id] || config.panoptoFolders?.[course.course_code] || [];
  if (!Array.isArray(configured)) throw new Error('panoptoFolders mappings must be arrays of folder IDs.');
  const launches = {};
  for (const row of rows) {
    const item = JSON.parse(row.json);
    const lti = item.contentDetail?.['resource/x-bb-blti-link'];
    if (lti?.domainConfig?.primaryDomain === 'abdn.cloud.panopto.eu' && lti.customParams?.context_delivery) {
      const id = recordingId(lti.customParams.context_delivery); found.recordings.push(id);
      if (lti.launchLink) launches[id] = lti.launchLink;
    }
  }
  return { recordings: [...new Set(found.recordings)], launches, folders: [...new Set([...found.folders, ...configured.map(recordingId)])] };
}
export async function syncPanopto({ session, database, config, courses, limitRecordings, folder, signal, client, onProgress = () => {} }) {
  if (folder && courses.length !== 1) throw new Error('--folder requires exactly one selected course.');
  const runId = database.startRun();
  database.setScope(runId, courses, { kind: 'panopto', limitRecordings: limitRecordings || null });
  const result = { runId, status: 'completed', courseIds: courses.map(c => c.id), courses: 0, recordings: 0, errors: [], deferred: 0, discovery: [] };
  let attempts = 0;
  const ownClient = !client;
  client ||= new PanoptoClient(session, { signal });
  try {
    if (ownClient) await client.open();
    for (const course of courses) {
      throwIfAborted(signal);
      onProgress(`Panopto: ${course.course_code} — ${course.name}`);
      let complete = true;
      const report = error => { complete = false; const message = safeMessage(error); result.errors.push({ courseId: course.id, error: message }); database.recordSyncError(runId, course.id, 'panopto', new Error(message)); };
      if (course.available === 0) {
        report(new Error('Course is unavailable in Blackboard; recordings were not accessed.'));
        database.finishSection(runId, course.id, 'panopto', 'unavailable'); database.courseResult(runId, course.id, 'inaccessible'); continue;
      }
      try {
        const sources = courseRecordingSources(database, course, config);
        const ids = new Set(sources.recordings), folders = new Map(sources.folders.map(id => [id, { Id: id, Name: '', source: 'course-link-or-config' }]));
        if (folder) folders.set(recordingId(folder), { Id: recordingId(folder), Name: '', source: 'explicit' });
        // Student viewers may see a recording without being allowed to enumerate its folder.
        // Search is supplementary; only exact course/year matches are selected.
        let successfulFolders = 0, folderErrors = 0;
        for (const f of folders.values()) {
          try {
            const sessions = await client.folderSessions(f.Id);
            successfulFolders++;
            for (const row of sessions) ids.add(recordingId(row.Id));
            database.db.prepare(`INSERT INTO recording_folders VALUES(?,?,?,?,?) ON CONFLICT(course_id,id) DO UPDATE SET name=excluded.name,source=excluded.source,checked_at=excluded.checked_at`)
              .run(course.id, f.Id, f.Name || '', f.source, new Date().toISOString());
          } catch (error) { if (error instanceof AuthenticationRequiredError || signal?.aborted) throw error; folderErrors++; report(error); }
        }
        if (!successfulFolders || folderErrors) {
          const codes = [...new Set(course.course_code.match(/[A-Z]{2,}\d{4}/gi) || [])];
          for (const code of codes) {
            try {
              for (const row of await client.searchSessions(code)) if (matchesCourseFolder(row.FolderName, course.course_code, config.courseAliases)) ids.add(recordingId(row.Id));
            } catch (error) { if (error instanceof AuthenticationRequiredError || signal?.aborted) throw error; report(error); }
          }
        }
        result.discovery.push({ courseId: course.id, coverage: successfulFolders ? 'folders' : 'course-links-and-search', listedFolders: successfulFolders, searchUsed: !successfulFolders || folderErrors > 0, folderInventoryComplete: folders.size > 0 && complete && !folder, discovered: ids.size });
        const processed = new Set();
        for (const id of ids) {
          throwIfAborted(signal);
          if (processed.has(id)) continue;
          if (attempts >= (limitRecordings ?? Infinity)) { result.deferred++; complete = false; continue; }
          attempts++;
          try {
            const viewerId = sources.launches[id] ? await client.launchLti(sources.launches[id], course.id) : id;
            if (processed.has(viewerId)) { attempts--; continue; }
            const { record } = await client.recording(viewerId);
            processed.add(viewerId);
            storeRecording(database, course.id, record); result.recordings++;
          } catch (error) { if (error instanceof AuthenticationRequiredError || signal?.aborted) throw error; report(error); }
        }
      } catch (error) {
        if (error instanceof AuthenticationRequiredError || signal?.aborted) { database.finishSection(runId, course.id, 'panopto', 'partial'); throw error; }
        report(error);
      }
      const status = complete ? 'completed' : 'partial';
      const coverage = result.discovery.find(d => d.courseId === course.id);
      database.finishSection(runId, course.id, coverage?.folderInventoryComplete ? 'panopto' : 'panopto-linked', status); database.courseResult(runId, course.id, status); result.courses++;
    }
    result.status = result.errors.length ? 'partial' : result.deferred ? 'limited' : 'completed';
    database.finishRun(runId, result.status, result.courses); return result;
  } catch (error) {
    database.finishRun(runId, signal?.aborted ? 'interrupted' : error instanceof AuthenticationRequiredError ? 'authentication-required' : 'failed', result.courses, safeMessage(error)); throw error;
  } finally { if (ownClient) await client.close(); }
}
