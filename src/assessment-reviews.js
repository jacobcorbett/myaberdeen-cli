import { getAllPages } from './api.js';
import { AuthenticationRequiredError } from './browser.js';
import { throwIfAborted, safeMessage } from './io.js';
import { parseFragment } from 'parse5';

export function migrateAssessmentReviews(archive) {
  if (archive.db.prepare('PRAGMA user_version').get().user_version >= 4) return;
  archive.db.exec('BEGIN IMMEDIATE');
  try {
    archive.db.exec(`
    CREATE TABLE IF NOT EXISTS assessment_reviews (
      course_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
      synced_at TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(course_id,id));
    PRAGMA user_version=4; COMMIT;`);
  } catch (error) { archive.db.exec('ROLLBACK'); throw error; }
}

export function getAssessmentReviews(database, courseIds) {
  if (!database.db.prepare("SELECT 1 FROM sqlite_master WHERE name='assessment_reviews'").get()) return [];
  return database.db.prepare('SELECT * FROM assessment_reviews ORDER BY course_id,id').all()
    .filter(row => !courseIds || courseIds.includes(row.course_id))
    .map(row => ({ ...JSON.parse(row.json), archivedAt: row.synced_at, _archive: database.provenance('assessment_reviews', row) }));
}

export function storeAssessmentReview(database, courseId, review) {
  const { archivedAt, _archive, ...data } = review;
  database.db.prepare(`INSERT INTO assessment_reviews VALUES(?,?,?,?,?)
    ON CONFLICT(course_id,id) DO UPDATE SET title=excluded.title,synced_at=excluded.synced_at,json=excluded.json`)
    .run(courseId, data.id, data.title, new Date().toISOString(), JSON.stringify(data));
  database.observe('assessment_reviews', courseId, data.id, data, { title: data.title });
}

// Only follow existing gradebook references. Never create/start an attempt or
// request the instructor question bank. Answers contain the permitted review.
export async function syncAssessmentReviews(ctx) {
  const { database, course, session, runId, signal, onProgress = () => {} } = ctx;
  const seen = new Set();
  const grades = database.db.prepare(`SELECT g.* FROM grades g JOIN record_state r
    ON r.dataset='grades' AND r.course_id=g.course_id AND r.record_id=g.id
    WHERE g.course_id=? AND r.last_seen_run=?`).all(course.id, runId);
  for (const row of grades) {
    const grade = JSON.parse(row.json), column = grade.gradebookColumn;
    const content = column?.contentId && database.getContent(course.id, column.contentId);
    const test = content?.contentDetail?.['resource/x-bb-asmt-test-link']?.test;
    if (!test) continue;
    for (const key of ['firstAttemptId', 'lastAttemptId', 'highestAttemptId', 'lowestAttemptId']) {
      const id = grade[key];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      throwIfAborted(signal);
      try {
        const base = `/learn/api/v1/courses/${encodeURIComponent(course.id)}/gradebook/attempts/${encodeURIComponent(id)}`;
        const attempt = await session.getJson(base);
        if (attempt?.id !== id || attempt.courseId !== course.id || attempt.userId !== grade.userId) throw new Error('Unexpected assessment attempt identity.');
        if (attempt.status !== 'COMPLETED') continue;
        if (attempt.permissions?.viewAttempt === false) throw new Error('Blackboard does not permit reviewing this attempt.');
        const answers = await getAllPages(session, `${base}/assessment/answers`, { signal });
        validateAnswers(answers, id, test.assessment?.questionCount);
        storeAssessmentReview(database, course.id, { id, courseId: course.id, title: row.title || content.title || id,
          contentId: column.contentId, assessmentId: test.assessment?.id || null,
          expectedQuestionCount: test.assessment?.questionCount ?? null,
          questionCount: answers.length, coverage: 'gradebook-referenced-completed-attempt', attempt, answers });
        onProgress(`Archived test review: ${row.title || id} (${answers.length} questions)`);
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof AuthenticationRequiredError) throw error;
        database.recordSyncError(runId, course.id, 'assessment-reviews', new Error(`${id}: ${safeMessage(error)}`));
        onProgress(`Could not archive test review ${id}: ${safeMessage(error)}`);
      }
    }
  }
}

export function validateAnswers(answers, attemptId, expectedCount) {
  const ids = new Set(), questions = new Set();
  for (const answer of answers) {
    if (!answer?.id || ids.has(answer.id) || answer.attemptId !== attemptId || !answer.questionId ||
        questions.has(answer.questionId) || answer.question?.id !== answer.questionId ||
        !Object.hasOwn(answer, 'givenAnswer') ||
        typeof (answer.question.questionText?.rawText ?? answer.question.questionText?.displayText) !== 'string') {
      throw new Error('Incomplete or inconsistent question review; previous archive retained.');
    }
    const q = answer.question;
    if (Number.isSafeInteger(q.answersCount) && (!Array.isArray(q.answers) || q.answers.length !== q.answersCount)) {
      throw new Error('Incomplete answer options; previous archive retained.');
    }
    ids.add(answer.id); questions.add(answer.questionId);
  }
  if (Number.isSafeInteger(expectedCount) && answers.length !== expectedCount) throw new Error(`Expected ${expectedCount} questions, received ${answers.length}; previous archive retained.`);
  if (!answers.length) throw new Error('No question review returned; previous archive retained.');
}

function text(value) {
  const html = typeof value === 'string' ? value : value?.rawText ?? value?.displayText ?? '';
  const walk = node => ['script', 'style'].includes(node.tagName) ? '' : node.nodeName === '#text' ? node.value :
    (node.tagName === 'br' ? '\n' : '') + (node.childNodes || []).map(walk).join('') + (['p', 'div', 'li'].includes(node.tagName) ? '\n' : '');
  return walk(parseFragment(html)).replace(/\u00a0/g, ' ').trim().replace(/[\\`*_{}[\]()#!|<>]/g, '\\$&');
}
export function renderAssessmentReviews(reviews) {
  return ['# Completed test reviews', '',
    'Only completed attempts referenced by the gradebook are included. Blackboard controls which answers, scores and feedback are visible. Original HTML and structured responses are retained in the JSON export; embedded media is not downloaded.', '',
    ...reviews.flatMap(review => [`## ${text(review.title)}`, '', `Attempt: ${review.id}. Questions: ${review.questionCount}. Archived: ${review.archivedAt || 'this sync'}. Visibility: ${review._archive?.presence || 'unknown'}.`, '',
      ...review.answers.flatMap((answer, index) => {
        const q = answer.question;
        const lines = [`### Question ${index + 1}`, '', text(q.questionText), '', `Type: ${q.questionType}. Possible points: ${q.points ?? 'not supplied'}.`, ''];
        const booleanSelection = Array.isArray(answer.givenAnswer) && answer.givenAnswer.length === q.answers?.length && answer.givenAnswer.every(value => typeof value === 'boolean');
        for (const [i, option] of (q.answers || []).entries()) lines.push(`${i + 1}. ${text(option.answerText)}${booleanSelection && answer.givenAnswer[i] ? ' — selected' : ''}`);
        const response = (JSON.stringify(answer.givenAnswer) ?? 'not supplied').replace(/[\\`*_{}[\]()#!|<>]/g, '\\$&');
        lines.push('', `Your response (original structured value): ${response}`, '',
          `Answer order (as supplied): ${JSON.stringify(answer.order ?? [])}`, '',
          `Correct answers: ${answer.isCorrectAnswersVisible ? 'released; see original JSON' : 'not released'}. Per-question score: ${answer.isScoreVisible ? 'released; see original JSON' : 'not released'}.`, '');
        if (answer.isFeedbackVisible && answer.feedback) lines.push(`Feedback: ${text(answer.feedback)}`, '');
        return lines;
      })]), ''].join('\n');
}
