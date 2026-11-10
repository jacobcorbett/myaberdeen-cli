#!/usr/bin/env node
import fs from 'node:fs';
import { assertSupportedRuntime } from './runtime-policy.js';
import path from 'node:path';
import { getConfig, getConfigPaths, ConfigurationError, prepareLocalState, requireVault } from './config.js';
import { BlackboardSession, AuthenticationRequiredError } from './browser.js';
import { getAccountOverview, courseFromMembership, courseCode, selectCourses } from './api.js';
import { ArchiveDatabase } from './database.js';
import { syncArchive } from './sync.js';
import { exportArchive } from './export.js';
import { mergeVault, repairLocalIndex } from './merge.js';
import { extractFiles } from './extract.js';
import { parseArgs, courseQueries, resumedOptions } from './cli-options.js';
import { acquireLock, safeMessage, throwIfAborted } from './io.js';
import { brief, verifyFiles, relocationPlan, applyRelocation, localDoctor } from './health.js';
import { PanoptoClient } from './panopto-browser.js';
import { syncPanopto } from './panopto-sync.js';
import { getRecordings, searchRecordings, transcriptText, recordingId } from './panopto-data.js';
import { downloadRecording } from './panopto-download.js';

import { getAssessmentReviews, renderAssessmentReviews } from './assessment-reviews.js';
import { readRosters, renderRosters } from './roster.js';
import { OFFLINE_READ_COMMANDS, readCourseItems, renderCourseItems } from './offline-reading.js';
import { setup } from './setup.js';

let config, options, command, release, activeSession;
const controller = new AbortController();
const onSignal = signal => { controller.abort(new Error(`Cancelled by ${signal}.`)); process.exitCode = signal === 'SIGINT' ? 130 : 143; if (activeSession) activeSession.close().catch(() => {}); };
process.once('SIGINT', () => onSignal('SIGINT')); process.once('SIGTERM', () => onSignal('SIGTERM'));
try {
  assertSupportedRuntime();
  ({ command, options } = parseArgs(process.argv.slice(2)));
  if (command === 'help') printHelp();
  else if (command === 'version') console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  else {
    config = getConfig();
    if (command === 'setup' && !options.course && !process.stdin.isTTY) throw new Error('Interactive setup needs a terminal. Use myab setup --course <exact-ID/code> (repeatable) for non-interactive setup.');
    const mutates = ['setup', 'login', 'panopto-login', 'panopto-sync', 'panopto-download', 'sync', 'check', 'download', 'refresh', 'repair', 'extract'].includes(command) || ['export', 'merge-vault'].includes(command) && !options.dryRun || command === 'relocate-files' && options.apply;
    if (mutates) release = acquireLock(config.stateDir);
    if (command === 'merge-vault') requireVault(config);
    if (command === 'paths') output(config);
    else if (command === 'setup') {
      const courses = await withSession(async session => {
        const { memberships, terms } = await getAccountOverview(session);
        const names = new Map(terms.map(t => [t.id, t.name]));
        return memberships.map(courseFromMembership).filter(c => c?.id).map(c => ({ ...c, term_name: names.get(c.termId) }));
      });
      await setup(config, courses, options, { signal: controller.signal });
    }
    else if (command === 'login') await login();
    else if (command === 'panopto-login') await panoptoLogin();
    else if (['panopto-sync', 'panopto-download'].includes(command)) await runPanopto();
    else if (command === 'courses') await withSession(async session => {
      const { memberships, terms } = await getAccountOverview(session);
      const names = new Map(terms.map(t => [t.id, t.name]));
      const courses = selected(memberships.map(m => { const c = courseFromMembership(m); return { ...c, term_name: names.get(c?.termId) }; })).slice(0, options.limitCourses);
      if (options.json) output(courses); else for (const c of courses) console.log(`${courseCode(c)}\t${c.name || ''}\t${c.id}`);
    });
    else if (['sync', 'check', 'download', 'refresh'].includes(command)) await runSync();
    else if (command === 'doctor') {
      const result = localDoctor(config);
      if (options.live) { try { await withSession(async () => { result.authentication = 'verified'; }); } catch (e) { result.authentication = e instanceof AuthenticationRequiredError ? 'required' : 'unavailable'; result.error = safeMessage(e); process.exitCode = e instanceof AuthenticationRequiredError ? 2 : 1; } }
      if (fs.existsSync(config.databasePath)) {
        const db = new ArchiveDatabase(config.databasePath, { readOnly: true });
        try { result.databaseIntegrity = db.db.prepare('PRAGMA quick_check').get().quick_check; result.schemaVersion = db.db.prepare('PRAGMA user_version').get().user_version; result.lastRun = db.status().lastRun; } finally { db.close(); }
      }
      output(result);
    } else await localCommand();
  }
} catch (error) {
  if (error instanceof ConfigurationError && ['paths', 'doctor'].includes(command)) output({ ...getConfigPaths(), configError: safeMessage(error), suggestions: ['Fix the configuration file, then retry. Help and version work without valid configuration.'] });
  else console.error(`Error: ${safeMessage(error)}`);
  if (!controller.signal.aborted) process.exitCode = error instanceof AuthenticationRequiredError ? 2 : 1;
} finally { if (release) release(); }

function selected(courses, query = courseQueries(config, options)) {
  let result = selectCourses(courses, query);
  if (options.term) result = result.filter(c => String(c.term_name || c.termId || '').toLowerCase().includes(options.term.toLowerCase()));
  if (!result.length && (options.course || options.profile || options.term)) throw new Error('No courses match this selection.');
  return result;
}
function openDatabase(readOnly = false) {
  if (readOnly && !fs.existsSync(config.databasePath)) throw new Error('No local archive yet. Run: myab check --course <code>');
  const database = new ArchiveDatabase(config.databasePath, { readOnly });
  if (readOnly && database.db.prepare('PRAGMA user_version').get().user_version < 2 && command !== 'status') { database.close(); throw new Error('Archive needs migration. Run: myab repair'); }
  return database;
}
async function localCommand() {
  const writable = command === 'repair' || command === 'extract' || (['export', 'merge-vault'].includes(command) && !options.dryRun) || command === 'relocate-files' && options.apply;
  const database = openDatabase(!writable);
  try {
    if (command === 'repair') {
      const indexedFiles = config.vaultRoot && fs.existsSync(path.join(config.vaultRoot, 'Uni')) ? repairLocalIndex(database, config) : 0;
      output({ indexedFiles, backup: database.backupPath || null, integrity: database.db.prepare('PRAGMA quick_check').get().quick_check }); return;
    }
    const courses = selected(database.db.prepare('SELECT * FROM courses ORDER BY course_code').all());
    const courseIds = courses.map(c => c.id);
    if (OFFLINE_READ_COMMANDS.includes(command)) {
      const result = readCourseItems(database, courses, command, { ...options, freshnessMinutes: config.freshnessMinutes ?? 60 });
      if (options.format === 'text') process.stdout.write(renderCourseItems(result));
      else output(result);
    } else if (command === 'roster') {
      const rosters = readRosters(database, courses);
      if (options.format === 'text') process.stdout.write(renderRosters(rosters));
      else output(rosters);
    } else if (command === 'test-reviews') {
      let reviews = getAssessmentReviews(database, courseIds);
      if (options.id) {
        if (courseIds.length !== 1) throw new Error('Select exactly one course for an attempt ID.');
        reviews = reviews.filter(review => review.id === options.id);
        if (!reviews.length) throw new Error('Test review not archived. Run check for this course first.');
      }
      if (options.format === 'text') process.stdout.write(renderAssessmentReviews(reviews));
      else output(reviews);
    } else if (['recordings', 'recording', 'transcript'].includes(command)) {
      const records = getRecordings(database, courseIds);
      if (command === 'recordings') { output(searchRecordings(records, options.search)); return; }
      const matches = records.filter(r => r.id === recordingId(options.id));
      if (matches.length !== 1) throw new Error('Select one course containing this archived recording. Run panopto-sync first if needed.');
      const record = matches[0];
      if (command === 'recording') { output(record); return; }
      const language = options.language || Object.keys(record.transcripts || {})[0];
      const track = record.transcripts?.[language];
      if (!track) throw new Error('Requested transcript is not available; inspect recording for available languages.');
      process.stdout.write(transcriptText(track.captions, options.format || (options.json ? 'json' : 'text')));
    } else if (command === 'status' || command === 'brief') {
      if (command === 'status' && database.db.prepare('PRAGMA user_version').get().user_version < 2) output(database.status());
      else output(brief(database, config, courseIds));
    } else if (command === 'changes') {
      const changes = database.changes({ courseIds, since: options.since || 0, limit: options.limit || 100 });
      output({ changes, nextCursor: changes.at(-1)?.id || options.since || 0 });
    } else if (command === 'show') {
      if (courseIds.length !== 1) throw new Error('show requires exactly one selected course.');
      const row = database.db.prepare('SELECT * FROM content WHERE course_id=? AND id=?').get(courseIds[0], options.id);
      if (!row) throw new Error('Content item not found in the local archive.');
      output({ ...JSON.parse(row.json), _archive: database.provenance('content', row) });
    } else if (command === 'extract') { const result = extractFiles(database, config, { courseIds }); output(result); if (result.errors.length) process.exitCode = 3; }
    else if (command === 'verify-files') { const result = verifyFiles(database, { courseIds }); output(result); if (result.missing || result.mismatched) process.exitCode = 3; }
    else if (command === 'export') output(options.dryRun ? { dryRun: true, courses: courses.map(c => ({ id: c.id, code: c.course_code })) } : exportArchive(database, config, { courseIds }));
    else if (command === 'merge-vault') {
      const result = mergeVault(database, config, { courseIds, dryRun: !!options.dryRun, deduplicate: !options.keepDuplicates });
      if (!options.dryRun) exportArchive(database, config, { courseIds }); output(result);
    } else if (command === 'relocate-files') {
      const result = relocationPlan(database, { from: options.from, to: options.to, courseIds });
      if (options.apply) result.updated = applyRelocation(database, result); output(result);
      if (result.skipped.length) process.exitCode = 3;
    }
  } finally { database.close(); }
}
async function runSync() {
  let database;
  try {
    if (!options.dryRun) { prepareLocalState(config); database = openDatabase(); database.recoverInterruptedRuns(); }
    let resumeIds, downloadFiles = ['download', 'refresh'].includes(command) || !!options.downloadFiles;
    if (options.resume) {
      if (!database) database = openDatabase(true);
      const run = database.db.prepare('SELECT * FROM sync_runs WHERE id=?').get(options.resume);
      if (!run) throw new Error('Resume run does not exist.');
      if (JSON.parse(run.options_json).kind === 'panopto') throw new Error('Repeat panopto-sync with its course selection; Blackboard resume cannot resume a Panopto run.');
      if (!JSON.parse(run.scope_json).length) throw new Error('This run ended before selecting courses; rerun the original explicit selection.');
      const finished = new Set(database.db.prepare("SELECT course_id FROM course_runs WHERE run_id=? AND status='completed'").all(run.id).map(c => c.course_id));
      resumeIds = JSON.parse(run.scope_json).filter(id => !finished.has(id));
      options = resumedOptions(options, JSON.parse(run.options_json));
      downloadFiles = options.downloadFiles;
      if (!resumeIds.length) { output({ status: 'nothing-to-resume' }); return; }
    }
    await withSession(async session => {
      if (options.dryRun || options.term) {
        const { memberships, terms } = await getAccountOverview(session), names = new Map(terms.map(t => [t.id, t.name]));
        const courses = selected(memberships.map(m => { const c = courseFromMembership(m); return { ...c, term_name: names.get(c?.termId) }; }), resumeIds || courseQueries(config, options)).slice(0, options.limitCourses);
        if (options.dryRun) { output({ dryRun: true, downloadFiles, roster: !!options.roster, courses }); return; }
        resumeIds = courses.map(c => c.id);
      }
      const result = await syncArchive({ session, database, config, courseQuery: courseQueries(config, options), selectedIds: resumeIds, resumeFrom: options.resume, limitCourses: options.limitCourses, limitFiles: options.limitFiles, downloadFiles, deep: !!options.deep, roster: !!options.roster, signal: controller.signal, onProgress: message => console.error(message) });
      if (options.panopto) {
        const courses = database.db.prepare('SELECT * FROM courses').all().filter(c => result.courseIds.includes(c.id));
        result.panopto = await syncPanopto({ session, database, config, courses, limitRecordings: options.limitRecordings, signal: controller.signal, onProgress: message => console.error(message) });
        if (result.panopto.status !== 'completed') process.exitCode = 3;
      }
      exportArchive(database, config, { courseIds: result.courseIds });
      if (options.extract) { result.extraction = extractFiles(database, config, { courseIds: result.courseIds }); if (result.extraction.errors.length) process.exitCode = 3; }
      output(result);
      if (result.errors || result.deferredFiles) process.exitCode = 3;
    });
  } finally { if (database) database.close(); }
}
async function withSession(callback) {
  const session = new BlackboardSession(config, { headless: !options.headed, signal: controller.signal }); activeSession = session;
  try { await session.open(); return await callback(session); }
  finally { await session.close(); activeSession = null; }
}
function output(value) { console.log(JSON.stringify(value, null, 2)); }
function printHelp() {
  console.log(`Usage: myab <command> [options]

Network: login, courses, check (metadata), sync, refresh/download (metadata and files)
Offline: brief/status, changes, show, extract, export, merge-vault, verify-files, relocate-files
Panopto: panopto-login, panopto-sync, recordings, recording, transcript, panopto-download
Getting started: login, setup (choose current courses), check --active
Setup: [--course <exact-ID/code>] (repeatable) [--vault <path>] [--academic-start-year YYYY]
Maintenance: doctor [--live], repair, paths, version

Select: --course <ID/code/name> (repeatable), --term <name>, --profile <name>, --active, --all
Mutating/archive commands require explicit scope. --active uses config.profiles.current.
Preview: --dry-run on check/sync/refresh/download/export/merge-vault
Sync: --limit-courses N, --limit-files N, --deep, --resume <run-id>, --headed, --extract
Panopto sync: --course/--active/--all [--limit-recordings N] [--folder UUID] [--dry-run]
Or add --panopto to check/sync/refresh; video downloads remain explicit.
Panopto read: recordings --course CODE [--search TEXT]; recording --course CODE --id UUID
Transcript: --course CODE --id UUID [--language NAME] [--format text|json|srt|vtt]
Panopto download: --course CODE --id UUID [--dry-run] [--max-bytes N] (default 2 GiB)
Offline reading: announcements|grades|messages|discussions --course CODE [--format json|text]
Filter offline reading: --id ID, --search TEXT, --limit N (per course)
Class Register: roster --course CODE [--format json|text]; refresh with check --course CODE --roster
Test reviews: test-reviews --course CODE [--id ATTEMPT_ID] [--format json|text]
Read: changes --since <cursor-or-ISO-date> [--limit N]; show --course <code> --id <content-id>
Relocate: --from <old-root> --to <new-root> [--apply]; destinations are hash-verified
Merge: --keep-duplicates; preview generated notes and removals with --dry-run
All structured output is JSON; --json is also accepted on data commands.
Exit: 0 success, 1 error, 2 login required, 3 partial/limited, 130/143 cancelled`);
}
async function login() {
  console.log('Opening the dedicated MyAberdeen Chrome profile.');
  console.log('This stores sign-in cookies locally, extending session-only cookies to seven days on disk; provider expiry still applies.');
  console.log('OS keychain integration is reduced. Use a trusted account and never share or sync the profile. See README: Authentication and local data.');
  console.log('Complete the Aberdeen sign-in in that window; it will close after verification.');
  console.log('If Microsoft asks "Stay signed in?", choose Yes to allow future automatic sign-in.');
  const session = new BlackboardSession(config, { headless: false, signal: controller.signal }); activeSession = session;
  let authenticatedCookies = null;
  try {
    await session.openInteractive();
    const signIn = session.page.getByRole('link', { name: 'Sign In', exact: true })
      .or(session.page.getByRole('button', { name: 'Sign In', exact: true }));
    if (await signIn.count()) {
      await signIn.first().click();
      await session.page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {});
      await session.page.bringToFront();
    }
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      throwIfAborted(controller.signal);
      await session.waitForXsrf(1_000);
      if (session.xsrfToken) {
        try {
          const user = await session.verifyAuthentication();
          console.log(`Login verified for ${user.userName || user.name?.given || user.id}.`);
          authenticatedCookies = await session.context.cookies();
          break;
        } catch (error) {
          if (!(error instanceof AuthenticationRequiredError)) throw error;
        }
      }
      await session.page.waitForTimeout(1_000);
    }
    if (!authenticatedCookies) throw new Error('Login was not completed within 15 minutes. Run myab login to try again.');
  } finally {
    await session.close();
  }

  const persistenceSession = new BlackboardSession(config, { headless: true, signal: controller.signal }); activeSession = persistenceSession;
  try {
    await persistenceSession.open({ requireAuthentication: false });
    const retainedUntil = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
    const retainedCookies = authenticatedCookies.map(cookie => cookie.expires < 0
      ? { ...cookie, expires: retainedUntil }
      : cookie);
    await persistenceSession.context.addCookies(retainedCookies);
    persistenceSession.xsrfToken = null;
    await persistenceSession.page.goto(`${config.baseUrl}/ultra/course`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await persistenceSession.waitForXsrf(15_000);
    await persistenceSession.verifyAuthentication();
    console.log('Persistent headless session verified.');
    console.log('Future commands can run without a visible browser.');
  } finally {
    await persistenceSession.close();
  }
}

async function withPanoptoSession(callback, { interactive = false } = {}) {
  const session = new BlackboardSession(config, { headless: !interactive && !options.headed, signal: controller.signal }); activeSession = session;
  try {
    if (interactive) await session.openInteractive();
    else await session.open({ requireAuthentication: false });
    return await callback(session);
  } finally { await session.close(); activeSession = null; }
}
async function panoptoLogin() {
  console.error('Opening Panopto in the dedicated Chrome profile. Complete any university sign-in/MFA in that window.');
  await withPanoptoSession(async session => {
    const client = new PanoptoClient(session, { interactive: true, signal: controller.signal });
    try { await client.open(); console.log('Panopto browser sign-in verified.'); } finally { await client.close(); }
  }, { interactive: true });
}
async function runPanopto() {
  const database = openDatabase(!!options.dryRun);
  try {
    const courses = selected(database.db.prepare('SELECT * FROM courses ORDER BY course_code').all());
    if (!courses.length) throw new Error('No archived courses. Run myab check with a course selection first.');
    if (options.folder && courses.length !== 1) throw new Error('--folder requires exactly one selected course.');
    if (command === 'panopto-sync' && options.dryRun) { output({ dryRun: true, courses: courses.map(c => ({ id: c.id, code: c.course_code })), folder: options.folder || null, limitRecordings: options.limitRecordings || null }); return; }
    if (command === 'panopto-download') {
      if (courses.length !== 1) throw new Error('panopto-download requires exactly one selected course.');
      const id = recordingId(options.id);
      if (!getRecordings(database, [courses[0].id]).some(r => r.id === id && r.presence !== 'historical')) throw new Error('Recording is not currently archived for this course. Run panopto-sync first.');
    }
    await withPanoptoSession(async session => {
      if (command === 'panopto-sync') {
        database.recoverInterruptedRuns();
        const result = await syncPanopto({ session, database, config, courses, limitRecordings: options.limitRecordings, folder: options.folder, signal: controller.signal, onProgress: message => console.error(message) });
        exportArchive(database, config, { courseIds: courses.map(c => c.id) }); output(result);
        if (result.status !== 'completed') process.exitCode = 3;
      } else {
        const client = new PanoptoClient(session, { signal: controller.signal });
        try { await client.open(); output(await downloadRecording({ client, database, config, courseId: courses[0].id, id: options.id, signal: controller.signal, dryRun: !!options.dryRun, maxBytes: options.maxBytes })); }
        finally { await client.close(); }
      }
    });
  } finally { database.close(); }
}
