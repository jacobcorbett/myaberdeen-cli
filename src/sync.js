import { getAllPages, getAccountOverview, courseCode, selectCourses } from './api.js';
import { isBlackboardFile, downloadContentFile, embeddedFiles } from './downloads.js';

export async function syncArchive({ session, database, config, courseQuery, limitCourses, limitFiles, downloadFiles = false, onProgress = () => {} }) {
  const runId = database.startRun();
  let synced = 0;
  try {
    const { user, memberships, terms } = await getAccountOverview(session);
    database.setMeta('user_id', user.id);
    database.setMeta('last_sync_started_at', new Date().toISOString());
    const termNames = new Map(terms.map(term => [term.id, term.name || term.id]));
    let courses = selectCourses(memberships, courseQuery);
    if (courseQuery && courses.length === 0) throw new Error(`No course matched “${courseQuery}”.`);
    if (limitCourses) courses = courses.slice(0, limitCourses);
    const fileBudget = { remaining: limitFiles ?? Number.POSITIVE_INFINITY };

    for (const membershipCourse of courses) {
      let course;
      try {
        course = await session.getJson(`/learn/api/v1/courses/${encodeURIComponent(membershipCourse.id)}`);
      } catch (error) {
        database.recordSyncError(runId, membershipCourse.id, 'course', error);
        onProgress(`Skipped inaccessible course ${courseCode(membershipCourse)}: ${error.message}`);
        continue;
      }
      const termName = termNames.get(course.termId) || null;
      database.upsertCourse(course, termName);
      onProgress(`Syncing ${courseCode(course)} — ${course.name || ''}`);

      const content = await safeSection(database, runId, course.id, 'content', onProgress,
        () => syncContentTree({ session, database, course, config, termName, downloadFiles, fileBudget, runId, onProgress }),
        { items: 0, downloaded: 0, forums: [] });
      await safeSection(database, runId, course.id, 'announcements', onProgress,
        () => syncAnnouncements(session, database, course.id));
      await safeSection(database, runId, course.id, 'grades', onProgress,
        () => syncGrades(session, database, course.id, user.id));
      await safeSection(database, runId, course.id, 'schedule', onProgress,
        () => syncSchedule(session, database, course.id));
      await safeSection(database, runId, course.id, 'messages', onProgress,
        () => syncMessages(session, database, course.id));
      await safeSection(database, runId, course.id, 'discussions', onProgress,
        () => syncDiscussions(session, database, course.id, content.forums));
      synced += 1;
      onProgress(`  ${content.items} content items${downloadFiles ? `; ${content.downloaded} files downloaded` : ''}`);
    }
    database.setMeta('last_sync_finished_at', new Date().toISOString());
    const errors = database.db.prepare('SELECT COUNT(*) AS count FROM sync_errors WHERE run_id=?').get(runId).count;
    const status = errors ? 'partial' : 'completed';
    database.finishRun(runId, status, synced);
    return { courses: synced, errors, status };
  } catch (error) {
    database.finishRun(runId, 'failed', synced, error.message);
    throw error;
  }
}

async function syncContentTree({ session, database, course, config, termName, downloadFiles, fileBudget, runId, onProgress }) {
  const seen = new Set();
  const forums = new Map();
  let downloaded = 0;
  let itemCount = 0;
  const queue = ['ROOT'];
  while (queue.length) {
    const parentId = queue.shift();
    const children = await getAllPages(session,
      `/learn/api/v1/courses/${encodeURIComponent(course.id)}/contents/${encodeURIComponent(parentId)}/children?@view=Summary&expand=assignedGroups,selfEnrollmentGroups.group,gradebookCategory&includeInActivityTracking=true`,
      { limit: 100 });
    for (const summary of children) {
      if (!summary?.id || seen.has(summary.id)) continue;
      seen.add(summary.id);
      let item = summary;
      try {
        item = await session.getJson(`/learn/api/v1/courses/${encodeURIComponent(course.id)}/contents/${encodeURIComponent(summary.id)}?expand=assignedGroups,selfEnrollmentGroups.group,gradebookCategory`);
      } catch {
        // The summary remains useful when Blackboard denies one optional detail endpoint.
      }
      database.upsertContent(course.id, parentId, item);
      itemCount += 1;
      const linkedDetailUrl = item.contentDetailUrl;
      if (linkedDetailUrl && item.contentDetail?.['resource/x-bb-courselink']) {
        try {
          const linked = await session.getJson(linkedDetailUrl);
          database.upsertContent(course.id, parentId, linked);
          const forum = linked.contentDetail?.['resource/x-bb-forumlink'];
          if (forum?.id) forums.set(forum.id, { id: forum.id, title: linked.title || item.title || '' });
        } catch (error) {
          database.recordSyncError(runId, course.id, 'linked-content', error);
        }
      }
      if (isContainer(item) || isContainer(summary)) queue.push(item.id);
      for (const fileItem of downloadFiles ? [...(isBlackboardFile(item) ? [item] : []), ...embeddedFiles(item, config.baseUrl)] : []) {
        if (fileBudget.remaining <= 0) break;
        if (isVideo(fileItem)) continue;
        fileBudget.remaining -= 1;
        try {
          const result = await downloadContentFile({ session, database, downloadRoot: config.downloadDir, course, termName, item: fileItem });
          if (result.downloaded) {
            downloaded += 1;
            onProgress(`  Downloaded ${fileItem.title || fileItem.name || fileItem.id}`);
          }
        } catch (error) {
          database.recordSyncError(runId, course.id, 'file-download', error);
          onProgress(`  Skipped file ${fileItem.title || fileItem.id}: ${error.message}`);
        }
      }
    }
  }
  return { items: itemCount, downloaded, forums: [...forums.values()] };
}

function isContainer(item) {
  if (item?.hasChildren) return true;
  const handler = item?.contentHandler?.id || item?.contentHandler || item?.type || '';
  return ['folder', 'lesson', 'module'].some(kind => String(handler).toLowerCase().includes(kind));
}

function isVideo(item) {
  const file = item?.contentDetail?.['resource/x-bb-file']?.file || {};
  const mimeType = String(file.mimeType || '').toLowerCase();
  const title = String(file.fileName || item?.title || '').toLowerCase();
  return mimeType.startsWith('video/') || /\.(mp4|m4v|mov|avi|mkv|webm|wmv)$/i.test(title);
}

async function syncAnnouncements(session, database, courseId) {
  const items = await getAllPages(session,
    `/learn/api/v1/courses/${encodeURIComponent(courseId)}/announcements?sort=startDateRestriction(desc)`, { limit: 100 });
  for (const item of items) database.upsertAnnouncement(courseId, item);
}

async function syncGrades(session, database, courseId, userId) {
  const items = await getAllPages(session,
    `/learn/api/v1/courses/${encodeURIComponent(courseId)}/gradebook/grades?userId=${encodeURIComponent(userId)}`, { limit: 100 });
  const columns = new Map();
  for (const item of items) {
    if (item.columnUrl) {
      try {
        let column = columns.get(item.columnUrl);
        if (!column) {
          column = await session.getJson(item.columnUrl);
          columns.set(item.columnUrl, column);
        }
        item.gradebookColumn = column;
      } catch {
        // The score remains useful when an old course denies column metadata.
      }
    }
    database.upsertGrade(courseId, item);
  }
}

async function syncSchedule(session, database, courseId) {
  const payload = await session.getJson(`/learn/api/v1/courses/${encodeURIComponent(courseId)}/schedule`);
  const items = Array.isArray(payload) ? payload : payload?.results || payload?.items || [];
  items.forEach((item, index) => database.upsertSchedule(courseId, item, index));
}

async function syncMessages(session, database, courseId) {
  const conversations = await getAllPages(session,
    `/learn/api/v1/courses/${encodeURIComponent(courseId)}/conversations`, { limit: 100 });
  for (const conversation of conversations) {
    database.upsertConversation(courseId, conversation);
    const messages = await getAllPages(session,
      `/learn/api/v1/courses/${encodeURIComponent(courseId)}/conversations/${encodeURIComponent(conversation.id)}/messages`,
      { limit: 100, maxItems: 50_000 });
    for (const message of messages) database.upsertMessage(courseId, conversation.id, message);
  }
}

async function syncDiscussions(session, database, courseId, forums) {
  for (const forum of forums || []) {
    const base = `/learn/api/v1/courses/${encodeURIComponent(courseId)}/discussionboards/default/forums/${encodeURIComponent(forum.id)}/messages`;
    const threads = await getAllPages(session, base, { limit: 100, maxItems: 50_000 });
    for (const thread of threads) {
      database.upsertDiscussionPost(courseId, forum.id, thread);
      const replies = await getAllPages(session,
        `${base}/${encodeURIComponent(thread.id)}/replies?sort=postDate(asc)`, { limit: 100, maxItems: 50_000 });
      for (const reply of replies) database.upsertDiscussionPost(courseId, forum.id, reply);
    }
  }
}

async function safeSection(database, runId, courseId, section, onProgress, operation, fallback = undefined) {
  try {
    return await operation();
  } catch (error) {
    database.recordSyncError(runId, courseId, section, error);
    onProgress(`  Could not archive ${section}: ${error.message}`);
    return fallback;
  }
}
