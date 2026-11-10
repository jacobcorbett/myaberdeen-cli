import { getAllPages, getAccountOverview, courseCode, selectCourses, normaliseAvailability } from './api.js';
import { isBlackboardFile, downloadContentFile, embeddedFiles } from './downloads.js';
import { AuthenticationRequiredError } from './browser.js';
import { baseCourseCode } from './course-paths.js';
import { syncRoster } from './roster.js';
import { syncAssessmentReviews } from './assessment-reviews.js';
import { fingerprint, throwIfAborted, safeMessage } from './io.js';

export async function syncArchive({ session, database, config, courseQuery, selectedIds, resumeFrom, limitCourses, limitFiles, downloadFiles = false, deep = false, roster = false, signal, onProgress = () => {} }) {
  const runId = database.startRun();
  const stats = { courses: 0, selected: 0, inaccessible: 0, downloaded: 0, notModified: 0, unchanged: 0, deferredFiles: 0 };
  let courses;
  try {
    const { user, memberships, terms } = await getAccountOverview(session);
    database.setMeta('user_id', user.id);
    const termNames = new Map(terms.map(term => [term.id, term.name || term.id]));
    courses = selectCourses(memberships, selectedIds || courseQuery);
    if (limitCourses) courses = courses.slice(0, limitCourses);
    if (downloadFiles && limitFiles && !resumeFrom) {
      const lastAttempts = new Map(database.db.prepare('SELECT course_id,MAX(run_id) last_run FROM file_checks GROUP BY course_id').all().map(r => [r.course_id, r.last_run]));
      courses.sort((a, b) => (lastAttempts.get(a.id) || 0) - (lastAttempts.get(b.id) || 0));
    }
    stats.selected = courses.length;
    database.setScope(runId, courses, { downloadFiles, deep, roster, limitFiles: limitFiles || null });
    onProgress(`Selected ${courses.length}: ${courses.map(c => `${courseCode(c)} — ${c.name || ''}`).join('; ')}`);
    const budget = { remaining: limitFiles ?? Infinity };
    for (const membership of courses) {
      throwIfAborted(signal);
      const before = errorCount(database, runId);
      let course;
      try { course = await session.getJson(`/learn/api/v1/courses/${encodeURIComponent(membership.id)}`); }
      catch (error) {
        fatal(error, signal);
        database.upsertCourse(membership, termNames.get(membership.termId));
        database.recordSyncError(runId, membership.id, 'course', error);
        const unavailable = [403, 404].includes(error.status);
        database.courseResult(runId, membership.id, unavailable ? 'inaccessible' : 'partial');
        if (unavailable) stats.inaccessible++;
        for (const section of ['content', 'announcements', 'grades', 'schedule', 'messages', 'discussions', 'assessment-reviews', ...(roster ? ['roster'] : [])]) database.finishSection(runId, membership.id, section, unavailable ? 'unavailable' : 'partial');
        onProgress(`Could not access ${courseCode(membership)}: ${safeMessage(error)}`);
        continue;
      }
      const termName = termNames.get(course.termId) || null;
      database.upsertCourse(course, termName);
      if (normaliseAvailability(course) === 0) {
        database.recordSyncError(runId, course.id, 'course', new Error('Course is marked unavailable by Blackboard.'));
        for (const section of ['content', 'announcements', 'grades', 'schedule', 'messages', 'discussions', 'assessment-reviews', ...(roster ? ['roster'] : [])]) database.finishSection(runId, course.id, section, 'unavailable');
        database.courseResult(runId, course.id, 'inaccessible'); stats.inaccessible++;
        onProgress(`Unavailable: ${courseCode(course)} — ${course.name || ''}`); continue;
      }
      onProgress(`Syncing ${courseCode(course)} — ${course.name || ''}`);
      const context = { session, database, config, course, termName, runId, deep, signal, onProgress };
      if (roster) await section(context, 'roster', () => syncRoster(context));
      const content = await section(context, 'content', () => syncContent(context), { forums: [] });
      await section(context, 'announcements', async () => {
        const items = await pages(context, `/announcements?sort=startDateRestriction(desc)`);
        for (const item of items) database.upsertAnnouncement(course.id, item);
      });
      await section(context, 'grades', () => syncGrades(context, user.id));
      if (database.sections(course.id).find(s => s.section === 'grades')?.status === 'completed') {
        await section(context, 'assessment-reviews', () => syncAssessmentReviews(context), undefined,
          database.sections(course.id).find(s => s.section === 'content')?.status !== 'completed');
      } else database.finishSection(runId, course.id, 'assessment-reviews', 'partial');
      await section(context, 'schedule', async () => {
        const payload = await session.getJson(`/learn/api/v1/courses/${encodeURIComponent(course.id)}/schedule`);
        const items = Array.isArray(payload) ? payload : payload?.results || payload?.items;
        if (!Array.isArray(items)) throw new Error('Unexpected schedule response; completeness is unknown.');
        items.forEach((item, index) => database.upsertSchedule(course.id, item, index));
      });
      await section(context, 'messages', () => syncMessages(context));
      // If content discovery was partial, an empty forum list proves nothing about absences.
      await section(context, 'discussions', () => syncDiscussions(context, content.forums), undefined,
        database.sections(course.id).find(s => s.section === 'content')?.status !== 'completed');
      const deferredBefore = stats.deferredFiles;
      if (downloadFiles) await section(context, 'files', async () => {
        const candidates = database.db.prepare(`SELECT c.* FROM file_candidates c
          JOIN record_state r ON r.dataset='file_candidates' AND r.course_id=c.course_id AND r.record_id=c.content_id
          LEFT JOIN files f ON f.course_id=c.course_id AND f.content_id=c.content_id
          LEFT JOIN (SELECT course_id,content_id,MAX(run_id) last_run FROM file_checks GROUP BY course_id,content_id) checks ON checks.course_id=c.course_id AND checks.content_id=c.content_id
          WHERE c.course_id=? AND r.last_seen_run=?
          ORDER BY COALESCE(checks.last_run,0), CASE WHEN f.sha256 IS NULL OR f.local_path IS NULL THEN 0 ELSE 1 END, COALESCE(f.checked_at,''), c.content_id`).all(course.id, runId);
        const completed = new Set(resumeFrom ? database.db.prepare("SELECT content_id FROM file_checks WHERE run_id=? AND course_id=? AND status='completed'").all(resumeFrom, course.id).map(row => row.content_id) : []);
        for (const candidate of candidates) {
          throwIfAborted(signal);
          const item = JSON.parse(candidate.json);
          if (isVideo(item)) continue;
          if (completed.has(item.id)) { database.db.prepare("INSERT OR REPLACE INTO file_checks VALUES(?,?,?,'completed')").run(runId, course.id, item.id); continue; }
          if (budget.remaining <= 0) { stats.deferredFiles++; continue; }
          budget.remaining--;
          try {
            const result = await downloadContentFile({ session, database, downloadRoot: config.downloadDir, course, termName, item, canonicalCourseCode: baseCourseCode(course.courseId || course.id, config) });
            database.db.prepare("INSERT OR REPLACE INTO file_checks VALUES(?,?,?,'completed')").run(runId, course.id, item.id);
            if (result.notModified) stats.notModified++;
            else if (result.downloaded) stats.downloaded++;
            else stats.unchanged++;
          } catch (error) {
            fatal(error, signal);
            database.db.prepare("INSERT OR REPLACE INTO file_checks VALUES(?,?,?,'failed')").run(runId, course.id, item.id);
            database.recordSyncError(runId, course.id, 'file-download', new Error(`${item.id}: ${safeMessage(error)}`));
            onProgress(`Could not download ${item.title || item.id}: ${safeMessage(error)}`);
          }
        }
        if (stats.deferredFiles > deferredBefore) database.finishSection(runId, course.id, 'files', 'limited');
      });
      stats.courses++;
      const partial = errorCount(database, runId) > before || stats.deferredFiles > deferredBefore;
      database.courseResult(runId, course.id, partial ? 'partial' : 'completed');
    }
    const errors = errorCount(database, runId);
    const status = errors ? 'partial' : stats.deferredFiles ? 'limited' : 'completed';
    database.db.prepare('UPDATE sync_runs SET metrics_json=? WHERE id=?').run(JSON.stringify({ ...stats, ...session.stats }), runId);
    database.finishRun(runId, status, stats.courses);
    return { ...stats, runId, courseIds: courses.map(c => c.id), errors, status, network: session.stats || {} };
  } catch (error) {
    const status = signal?.aborted ? 'cancelled' : error instanceof AuthenticationRequiredError ? 'authentication-required' : 'failed';
    database.finishRun(runId, status, stats.courses, safeMessage(error));
    throw error;
  }
}

function fatal(error, signal) { throwIfAborted(signal); if (error instanceof AuthenticationRequiredError) throw error; }
function errorCount(database, runId) { return database.db.prepare('SELECT COUNT(*) n FROM sync_errors WHERE run_id=?').get(runId).n; }
function pages(ctx, suffix) { return getAllPages(ctx.session, `/learn/api/v1/courses/${encodeURIComponent(ctx.course.id)}${suffix}`, { signal: ctx.signal }); }
async function section(ctx, name, operation, fallback, incomplete = false) {
  const { database, runId, course, signal, onProgress } = ctx;
  throwIfAborted(signal);
  const before = errorCount(database, runId);
  database.finishSection(runId, course.id, name, 'running');
  try {
    const value = await operation();
    const limited = database.sections(course.id).find(s => s.section === name)?.status === 'limited';
    database.finishSection(runId, course.id, name, errorCount(database, runId) > before || incomplete ? 'partial' : limited ? 'limited' : 'completed');
    return value;
  } catch (error) {
    database.finishSection(runId, course.id, name, error instanceof AuthenticationRequiredError ? 'authentication-required' : signal?.aborted ? 'cancelled' : error.status === 403 ? 'unavailable' : 'partial');
    fatal(error, signal);
    database.recordSyncError(runId, course.id, name, error);
    onProgress(`Could not archive ${name}: ${safeMessage(error)}`);
    return fallback;
  }
}

async function syncContent(ctx) {
  const { session, database, course, config, runId, deep, signal } = ctx;
  const seen = new Set(), parents = new Set(), forums = new Map(), queue = ['ROOT'];
  const discover = item => {
    const forum = item.contentDetail?.['resource/x-bb-forumlink'];
    if (forum?.id) forums.set(forum.id, forum);
    for (const file of [...(isBlackboardFile(item) ? [item] : []), ...embeddedFiles(item, config.baseUrl)]) database.discoverFile(course.id, item.id, file);
  };
  while (queue.length) {
    throwIfAborted(signal);
    const parentId = queue.shift();
    if (parents.has(parentId)) continue; parents.add(parentId);
    let children;
    try { children = await pages(ctx, `/contents/${encodeURIComponent(parentId)}/children?@view=Summary&expand=assignedGroups,selfEnrollmentGroups.group,gradebookCategory&includeInActivityTracking=false`); }
    catch (error) { fatal(error, signal); database.recordSyncError(runId, course.id, 'content', new Error(`Folder ${parentId}: ${safeMessage(error)}`)); continue; }
    for (const summary of children) {
      throwIfAborted(signal);
      if (!summary?.id) throw new Error('Content listing returned an item without an ID.');
      if (seen.has(summary.id)) continue; seen.add(summary.id);
      const previous = database.getContent(course.id, summary.id);
      const priorSummary = database.getSummary(course.id, summary.id);
      const fullCheckDue = !priorSummary?.detail_checked_at || Date.now() - Date.parse(priorSummary.detail_checked_at) > (config.deepCheckHours ?? 24) * 3_600_000;
      const changed = fingerprint({ parentId, item: summary }) !== priorSummary?.fingerprint;
      let item = previous || summary, complete = false;
      if (deep || changed || !previous || priorSummary?.detail_status !== 'complete' || fullCheckDue) {
        try {
          item = await session.getJson(`/learn/api/v1/courses/${encodeURIComponent(course.id)}/contents/${encodeURIComponent(summary.id)}?expand=assignedGroups,selfEnrollmentGroups.group,gradebookCategory`);
          if (item?.id !== summary.id) throw new Error('Content detail returned an unexpected ID.');
          database.upsertContent(course.id, parentId, item); complete = true;
        } catch (error) {
          fatal(error, signal);
          database.recordSyncError(runId, course.id, 'content-detail', new Error(`${summary.id}: ${safeMessage(error)}`));
          if (!previous) database.upsertContent(course.id, parentId, summary);
          else database.observe('content', course.id, summary.id, previous, { unchanged: true });
        }
        database.rememberSummary(course.id, parentId, summary, complete);
      } else {
        database.observe('content', course.id, item.id, item, { unchanged: true });
        database.db.prepare('UPDATE content_summaries SET summary_checked_at=? WHERE course_id=? AND content_id=?').run(new Date().toISOString(), course.id, item.id);
      }
      discover(item);
      if (isContainer(item) || isContainer(summary)) queue.push(summary.id);
      if (item.contentDetailUrl && item.contentDetail?.['resource/x-bb-courselink']) {
        try {
          const linked = await session.getJson(item.contentDetailUrl);
          if (!linked?.id) throw new Error('Linked content returned no ID.');
          database.upsertContent(course.id, parentId, linked); discover(linked);
          if (isContainer(linked)) queue.push(linked.id);
        } catch (error) { fatal(error, signal); database.recordSyncError(runId, course.id, 'linked-content', error); }
      }
    }
  }
  return { forums: [...forums.values()] };
}
function isContainer(item) {
  if (item?.hasChildren) return true;
  return /folder|lesson|module/i.test(String(item?.contentHandler?.id || item?.contentHandler || item?.type || ''));
}
function isVideo(item) {
  const file = item?.contentDetail?.['resource/x-bb-file']?.file || {};
  return String(file.mimeType || '').startsWith('video/') || /\.(mp4|m4v|mov|avi|mkv|webm|wmv)$/i.test(file.fileName || item.title || '');
}
async function syncGrades(ctx, userId) {
  const { database, course, session, runId, signal } = ctx;
  const columns = new Map();
  for (const item of await pages(ctx, `/gradebook/grades?userId=${encodeURIComponent(userId)}`)) {
    if (item.columnUrl) {
      try { if (!columns.has(item.columnUrl)) columns.set(item.columnUrl, await session.getJson(item.columnUrl)); item.gradebookColumn = columns.get(item.columnUrl); }
      catch (error) {
        fatal(error, signal); database.recordSyncError(runId, course.id, 'grade-column', error);
        const old = database.db.prepare('SELECT json FROM grades WHERE course_id=? AND id=?').get(course.id, item.id || item.columnId);
        if (old) item.gradebookColumn = JSON.parse(old.json).gradebookColumn;
      }
    }
    database.upsertGrade(course.id, item);
  }
}
async function syncMessages(ctx) {
  for (const conversation of await pages(ctx, '/conversations')) {
    ctx.database.upsertConversation(ctx.course.id, conversation);
    for (const message of await pages(ctx, `/conversations/${encodeURIComponent(conversation.id)}/messages`)) ctx.database.upsertMessage(ctx.course.id, conversation.id, message);
  }
}
async function syncDiscussions(ctx, forums) {
  for (const forum of forums || []) {
    const base = `/discussionboards/default/forums/${encodeURIComponent(forum.id)}/messages`;
    const queue = await pages(ctx, base), seen = new Set();
    while (queue.length) {
      throwIfAborted(ctx.signal);
      const post = queue.shift();
      if (!post?.id) throw new Error('Discussion response contains a post without an ID.');
      if (seen.has(post.id)) continue;
      if (seen.size >= 50_000) throw new Error('Discussion traversal limit reached.');
      seen.add(post.id); ctx.database.upsertDiscussionPost(ctx.course.id, forum.id, post);
      const replies = await pages(ctx, `${base}/${encodeURIComponent(post.id)}/replies?sort=postDate(asc)`);
      for (const reply of replies) if (!seen.has(reply.id)) queue.push(reply);
    }
  }
}
