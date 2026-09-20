#!/usr/bin/env node
import fs from 'node:fs';
import { getConfig, prepareLocalState } from './config.js';
import { BlackboardSession, AuthenticationRequiredError } from './browser.js';
import { getAccountOverview, courseFromMembership, courseCode, selectCourses } from './api.js';
import { ArchiveDatabase } from './database.js';
import { syncArchive } from './sync.js';
import { exportArchive } from './export.js';
import { mergeVault } from './merge.js';

const config = getConfig();
let command, options;

try {
  ({ command, options } = parseArgs(process.argv.slice(2)));
  if (command === 'help') printHelp();
  else if (command === 'paths') printPaths();
  else if (command === 'login') await login();
  else if (command === 'courses') await listCourses();
  else if (command === 'sync' || command === 'download') await sync(command === 'download' || options.downloadFiles);
  else if (command === 'export') exportData();
  else if (command === 'merge-vault') mergeData();
  else if (command === 'status') status();
  else throw new Error(`Unknown command: ${command}\nRun: myab help`);
} catch (error) {
  if (error instanceof AuthenticationRequiredError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

async function login() {
  console.log('Opening the dedicated MyAberdeen Chrome profile.');
  console.log('Complete the Aberdeen sign-in in that window; it will close after verification.');
  const session = new BlackboardSession(config, { headless: false });
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

  const persistenceSession = new BlackboardSession(config, { headless: true });
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
    authenticatedCookies = null;
    await persistenceSession.close();
  }
}

async function listCourses() {
  await withSession(async session => {
    const { memberships } = await getAccountOverview(session);
    const selected = selectCourses(memberships, options.course);
    for (const membership of memberships) {
      const course = courseFromMembership(membership);
      if (!course || !selected.some(candidate => candidate.id === course.id)) continue;
      console.log(`${courseCode(course)}\t${course.name || ''}\t${course.id}`);
    }
    console.log(`\n${selected.length} course${selected.length === 1 ? '' : 's'}.`);
  });
}

async function sync(downloadFiles) {
  prepareLocalState(config);
  const database = new ArchiveDatabase(config.databasePath);
  try {
    await withSession(async session => {
      const result = await syncArchive({
        session,
        database,
        config,
        courseQuery: options.course,
        limitCourses: options.limitCourses,
        limitFiles: options.limitFiles,
        downloadFiles,
        onProgress: message => console.log(message)
      });
      if (result.errors) process.exitCode = 3;
      console.log(`Sync ${result.status}: ${result.errors} errors; ${result.courses} course${result.courses === 1 ? '' : 's'}.`);
      if (downloadFiles) console.log(`Files: ${config.downloadDir}`);
      console.log(`Archive: ${config.databasePath}`);
      const exported = exportArchive(database, config);
      console.log(`Offline course data: ${exported.directory}`);
    });
  } finally {
    database.close();
  }
}

function exportData() {
  prepareLocalState(config);
  if (!fs.existsSync(config.databasePath)) throw new Error('No local archive yet. Run: myab sync');
  const database = new ArchiveDatabase(config.databasePath);
  try {
    const result = exportArchive(database, config);
    console.log(`Exported ${result.courses} courses to ${result.directory}`);
  } finally {
    database.close();
  }
}

function mergeData() {
  prepareLocalState(config);
  if (!fs.existsSync(config.databasePath)) throw new Error('No local archive yet. Run: myab sync');
  const database = new ArchiveDatabase(config.databasePath);
  try {
    const result = mergeVault(database, config, { deduplicate: true });
    exportArchive(database, config);
    console.log(`Indexed ${result.indexedFiles} existing university files.`);
    console.log(`Linked ${result.linkedRecords} Blackboard records to canonical vault files.`);
    console.log(`Removed ${result.removedFiles} byte-identical raw duplicates (${Math.round(result.removedBytes / 1048576)} MiB).`);
    console.log(`Integrated ${result.moduleCourses} modules and ${result.resourceCourses} university resource areas.`);
  } finally {
    database.close();
  }
}

function status() {
  if (!fs.existsSync(config.databasePath)) {
    console.log('No local archive yet. Run: myab sync');
    printPaths();
    return;
  }
  const database = new ArchiveDatabase(config.databasePath);
  try {
    const { counts, lastRun } = database.status();
    console.log(`Courses: ${counts.courses}`);
    console.log(`Content items: ${counts.content}`);
    console.log(`Announcements: ${counts.announcements}`);
    console.log(`Grades: ${counts.grades}`);
    console.log(`Schedule entries: ${counts.schedules}`);
    console.log(`Conversations: ${counts.conversations}`);
    console.log(`Messages: ${counts.messages}`);
    console.log(`Discussion posts: ${counts.discussion_posts}`);
    console.log(`Files recorded: ${counts.files}`);
    console.log(`Existing vault files indexed: ${counts.local_files}`);
    console.log(`Latest sync errors: ${counts.sync_errors}`);
    if (lastRun) console.log(`Last sync: ${lastRun.status} at ${lastRun.finished_at || lastRun.started_at}`);
  } finally {
    database.close();
  }
}

async function withSession(callback) {
  const session = new BlackboardSession(config, { headless: !options.headed });
  try {
    await session.open();
    return await callback(session);
  } finally {
    await session.close();
  }
}

function printPaths() {
  console.log(`State: ${config.stateDir}`);
  console.log(`Chrome profile: ${config.profileDir}`);
  console.log(`Archive: ${config.databasePath}`);
  console.log(`Downloads: ${config.downloadDir}`);
}

function printHelp() {
  console.log(`Usage: myab <command> [options]

Commands:
  login       Open the dedicated profile for Aberdeen sign-in
  courses     List live courses (headless)
  sync        Archive courses, content, announcements, grades and schedules
  download    Sync and download Blackboard files, including embedded attachments
  export      Write per-course offline JSON alongside downloaded files
  merge-vault Merge with the existing Obsidian university system
  status      Show local archive counts
  paths       Show local profile, database and download paths

Options:
  --course <text>       Select by course ID, code or name fragment
  --limit-courses <n>   Process only the first n matching courses
  --limit-files <n>     Attempt at most n file downloads during this run
  --download-files      Download files during sync
  --headed              Show Chrome for diagnosis
  -h, --help            Show this help`);
}

function parseArgs(args) {
  if (!args.length || args.includes('-h') || args.includes('--help')) return { command: 'help', options: {} };
  const command = args[0];
  const parsed = { course: null, limitCourses: null, limitFiles: null, downloadFiles: false, headed: false };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--course') parsed.course = requireValue(args, ++index, arg);
    else if (arg === '--limit-courses') {
      parsed.limitCourses = Number(requireValue(args, ++index, arg));
      if (!Number.isSafeInteger(parsed.limitCourses) || parsed.limitCourses < 1) throw new Error('--limit-courses must be a positive integer.');
    } else if (arg === '--limit-files') {
      parsed.limitFiles = Number(requireValue(args, ++index, arg));
      if (!Number.isSafeInteger(parsed.limitFiles) || parsed.limitFiles < 1) throw new Error('--limit-files must be a positive integer.');
    } else if (arg === '--download-files') parsed.downloadFiles = true;
    else if (arg === '--headed') parsed.headed = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return { command, options: parsed };
}

function requireValue(args, index, option) {
  if (!args[index] || args[index].startsWith('--')) throw new Error(`${option} requires a value.`);
  return args[index];
}
