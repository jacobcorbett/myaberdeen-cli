import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ArchiveDatabase } from '../src/database.js';
import { syncArchive } from '../src/sync.js';
import { getAssessmentReviews, renderAssessmentReviews, validateAnswers } from '../src/assessment-reviews.js';
import { exportArchive } from '../src/export.js';
import { mergeVault } from '../src/merge.js';
import { parseArgs } from '../src/cli-options.js';

const course = { id: 'course-a', courseId: 'CS1000_27', name: 'Synthetic test course' };
const content = { id: 'test', title: 'Example test', contentDetail: { 'resource/x-bb-asmt-test-link': { test: { assessment: { id: 'assessment', questionCount: 2 } } } } };
const grade = { id: 'grade', userId: 'user', firstAttemptId: 'attempt', lastAttemptId: 'attempt', pointsPossible: 2,
  gradebookColumn: { contentId: 'test', name: 'Example test' } };
const question = i => ({ id: `answer-${i}`, questionId: `question-${i}`, attemptId: 'attempt', givenAnswer: [true, false], order: [],
  isCorrectAnswersVisible: false, isScoreVisible: false, question: { id: `question-${i}`, questionType: 'multipleanswer', points: 1,
    questionText: { rawText: '<p>Which value is &lt; 3?</p>' }, answers: [{ answerText: { rawText: '<p>Two</p>' } }, { answerText: { rawText: 'Four' } }] } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myab-test-reviews-'));
  const database = new ArchiveDatabase(path.join(dir, 'archive.sqlite'));
  t.after(() => { try { database.close(); } catch (error) { if (error.code !== 'ERR_INVALID_STATE') throw error; } fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { baseUrl: 'https://example.test', downloadDir: path.join(dir, 'downloads'), databasePath: database.path, vaultRoot: path.join(dir, 'vault') };
  fs.mkdirSync(path.join(config.vaultRoot, 'Uni'), { recursive: true });
  let mode = 'complete', requests = [];
  const session = { getJson: async route => {
    requests.push(route);
    const url = new URL(route, config.baseUrl), p = url.pathname;
    if (p.endsWith('/users/me')) return { id: 'user' };
    if (p.endsWith('/memberships')) return { results: [{ course }] };
    if (p === '/learn/api/v1/courses/course-a') return course;
    if (p.endsWith('/contents/ROOT/children')) return { results: [content] };
    if (p.endsWith('/contents/test')) return content;
    if (p.endsWith('/gradebook/grades')) return { results: [grade] };
    if (p.endsWith('/gradebook/attempts/attempt')) return { id: 'attempt', courseId: course.id, userId: 'user', status: mode === 'in-progress' ? 'IN_PROGRESS' : 'COMPLETED' };
    if (p.endsWith('/assessment/answers')) {
      if (mode === 'denied') throw Object.assign(new Error('Review denied'), { status: 403 });
      if (mode === 'malformed') return { error: 'not a collection' };
      // Two pages, including a short page with advertised continuation.
      if (mode === 'short') return { results: [question(1)] };
      return Number(url.searchParams.get('offset')) === 0 ? { results: [question(1)], paging: { count: 2, nextPage: 'next' } } : { results: [question(2)], paging: { count: 2 } };
    }
    return { results: [] };
  } };
  return { database, config, dir, requests, setMode: value => { mode = value; }, run: () => syncArchive({ session, database, config, courseQuery: [course.id] }) };
}

test('sync captures paginated review questions once per referenced completed attempt; repeat is unchanged', async t => {
  const f = fixture(t);
  assert.equal((await f.run()).status, 'completed');
  const reviews = getAssessmentReviews(f.database, [course.id]);
  assert.equal(reviews[0].questionCount, 2);
  assert.equal(reviews[0].answers[0].givenAnswer[0], true);
  assert.equal(f.requests.filter(r => r.endsWith('/gradebook/attempts/attempt')).length, 1);
  assert.deepEqual(getAssessmentReviews(f.database, ['other-course']), []);
  const cursor = f.database.changes({ since: 0 }).at(-1).id;
  await f.run();
  assert.deepEqual(f.database.changes({ since: cursor }), []);
});

test('denied, malformed and incomplete review refreshes preserve the full previous snapshot and report partial', async t => {
  const f = fixture(t); await f.run();
  for (const mode of ['denied', 'malformed', 'short']) {
    f.setMode(mode);
    assert.equal((await f.run()).status, 'partial');
    const review = getAssessmentReviews(f.database, [course.id])[0];
    assert.equal(review.questionCount, 2);
    assert.equal(review._archive.presence, 'current');
    assert.equal(f.database.sections(course.id).find(s => s.section === 'assessment-reviews').status, 'partial');
  }
});

test('in-progress attempts are never opened for question review', async t => {
  const f = fixture(t); f.setMode('in-progress'); await f.run();
  assert.equal(f.requests.some(r => r.includes('/assessment/answers')), false);
  assert.deepEqual(getAssessmentReviews(f.database, [course.id]), []);
});

test('question identity/count validation rejects duplicates and mismatched attempts', () => {
  assert.throws(() => validateAnswers([question(1), question(1)], 'attempt', 2));
  assert.throws(() => validateAnswers([question(1)], 'other', 1));
  assert.throws(() => validateAnswers([question(1)], 'attempt', 2));
  const missingOptions = question(1); missingOptions.question.answersCount = 3;
  assert.throws(() => validateAnswers([missingOptions], 'attempt', 1), /Incomplete answer options/);
  const missingResponse = question(1); delete missingResponse.givenAnswer;
  assert.throws(() => validateAnswers([missingResponse], 'attempt', 1), /Incomplete/);
});

test('private export and vault merge provide readable questions while retaining raw structure', async t => {
  const f = fixture(t); await f.run();
  exportArchive(f.database, f.config, { courseIds: [course.id] });
  const file = path.join(f.config.downloadDir, 'No term', course.courseId, '_course-data', 'assessment-reviews.json');
  assert.equal(JSON.parse(fs.readFileSync(file))[0].answers[0].question.answers.length, 2);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const plan = mergeVault(f.database, f.config, { courseIds: [course.id], dryRun: true });
  assert.ok(plan.courses[0].notes.includes('Assessment-reviews.md'));
  mergeVault(f.database, f.config, { courseIds: [course.id], deduplicate: false });
  const note = path.join(plan.courses[0].directory, 'MyAberdeen', 'Assessment-reviews.md');
  assert.match(fs.readFileSync(note, 'utf8'), /Question 2/);
  const rendered = renderAssessmentReviews(getAssessmentReviews(f.database, [course.id]));
  assert.match(rendered, /Correct answers: not released/);
  assert.match(rendered, /Two/);
  assert.doesNotMatch(rendered, /<p>/);
});

test('v3 migration backs up the database and old read-only archives remain readable', t => {
  const f = fixture(t), filename = f.database.path;
  f.database.db.exec('DROP TABLE assessment_reviews; PRAGMA user_version=3'); f.database.close();
  const old = new ArchiveDatabase(filename, { readOnly: true });
  assert.deepEqual(getAssessmentReviews(old, [course.id]), []); old.close();
  const migrated = new ArchiveDatabase(filename);
  assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, 5);
  const backup = new DatabaseSync(migrated.backupPath, { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 3); backup.close(); migrated.close();
});

test('offline review command requires explicit scope and only supports JSON/text', () => {
  assert.throws(() => parseArgs(['test-reviews']));
  assert.throws(() => parseArgs(['test-reviews', '--course', 'CS1000', '--format', 'vtt']));
  assert.equal(parseArgs(['test-reviews', '--course', 'CS1000', '--format', 'text']).command, 'test-reviews');
});
