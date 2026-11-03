import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup } from '../src/setup.js';
import { getConfig } from '../src/config.js';
import { academicYear } from '../src/course-paths.js';
import { mergeVault, repairLocalIndex } from '../src/merge.js';
import { localDoctor } from '../src/health.js';
import { parseArgs } from '../src/cli-options.js';

const courses = [
  { id: '_1_1', courseId: 'CS1000_27', name: 'Test course', term_name: '2026–27' },
  { id: '_2_1', courseId: 'CS2000_27', name: 'Other course' }
];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myab-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = getConfig({ MYAB_STATE_DIR: root, MYAB_CHROME: path.join(root, 'missing-chrome') });
  return { root, config, read: () => JSON.parse(fs.readFileSync(config.configPath, 'utf8')) };
}
const quiet = { log() {} };

test('new user gets no implicit vault or academic start year', t => {
  const { config } = fixture(t);
  assert.equal(config.vaultRoot, null);
  assert.equal(config.academicStartYear, undefined);
  assert.equal(academicYear('Term 1, 2026-27', config), '2026-27');
  assert.equal(repairLocalIndex(null, config), 0);
  assert.throws(() => mergeVault(null, config), /Obsidian integration is optional/);
});

test('guided setup chooses exact memberships without creating an archive or vault', async t => {
  const { config, read } = fixture(t);
  const answers = ['2,1,2', ''];
  await setup(config, courses, {}, { ...quiet, ask: async () => answers.shift() });
  assert.deepEqual(read(), { profiles: { current: ['_2_1', '_1_1'] } });
  assert.equal(fs.existsSync(config.databasePath), false);
  assert.equal(fs.existsSync(config.profileDir), false);
});

test('setup preserves custom settings and other profiles, and validates optional vault', async t => {
  const { root, config, read } = fixture(t);
  const original = { profiles: { current: ['old'], other: ['keep'] }, academicStartYear: 2020, panoptoFolders: { custom: ['folder'] }, custom: true };
  fs.writeFileSync(config.configPath, JSON.stringify(original));
  const vault = path.join(root, 'vault'); fs.mkdirSync(path.join(vault, 'Uni'), { recursive: true });
  await setup(config, courses, { course: ['CS1000_27'], vault }, quiet);
  assert.deepEqual(read(), { ...original, profiles: { current: ['_1_1'], other: ['keep'] }, vaultRoot: vault });
  assert.equal(getConfig({ MYAB_CONFIG: config.configPath }).vaultRoot, vault);
});

test('cancelled or invalid guided setup leaves existing configuration byte-for-byte intact', async t => {
  const { config } = fixture(t);
  const before = '{"profiles":{"current":["keep"]}}\n'; fs.writeFileSync(config.configPath, before);
  await setup(config, courses, {}, { ...quiet, ask: async () => '' });
  await assert.rejects(setup(config, courses, {}, { ...quiet, ask: async () => '999' }), /Choose numbers/);
  await assert.rejects(setup(config, courses, { course: ['CS1000_27'], vault: '/missing-vault' }, quiet), /vault directory not found/);
  await assert.rejects(setup(config, courses, { course: ['CS'] }, quiet), /exactly one/);
  assert.equal(fs.readFileSync(config.configPath, 'utf8'), before);
});

test('setup rejects ambiguous course codes and empty memberships without saving', async t => {
  const { config } = fixture(t);
  await assert.rejects(setup(config, [...courses, { ...courses[0], id: '_3_1' }], { course: ['CS1000_27'] }, quiet), /exactly one/);
  await assert.rejects(setup(config, [], { course: ['CS1000_27'] }, quiet), /No course memberships/);
  assert.equal(fs.existsSync(config.configPath), false);
});

test('setup detects configuration changes during prompts', async t => {
  const { config } = fixture(t);
  let calls = 0;
  await assert.rejects(setup(config, courses, {}, { ...quiet, ask: async () => {
    if (++calls === 1) return '1';
    fs.writeFileSync(config.configPath, '{"custom":"new"}'); return '';
  } }), /changed during setup/);
  assert.equal(fs.readFileSync(config.configPath, 'utf8'), '{"custom":"new"}');
});

test('doctor distinguishes optional vault/tools from missing onboarding configuration', async t => {
  const { config } = fixture(t);
  let result = localDoctor(config);
  assert.equal(result.configFound, false);
  assert.equal(result.currentCoursesConfigured, false);
  assert.equal(result.vaultConfigured, false);
  assert.ok(result.suggestions.some(s => s.includes('myab setup')));
  await setup(config, courses, { course: ['_1_1'] }, quiet);
  result = localDoctor(getConfig({ MYAB_CONFIG: config.configPath }));
  assert.equal(result.configFound, true);
  assert.equal(result.currentCoursesConfigured, true);
  assert.equal(typeof result.extractionTools.pdftotext, 'boolean');
  assert.equal(typeof result.extractionTools.unzip, 'boolean');
  assert.ok(!result.suggestions.some(s => s.includes('then myab setup')));
});

test('setup options accept repeated course selection and validate start years', () => {
  assert.deepEqual(parseArgs(['setup', '--course', '_1_1', '--course', '_2_1', '--academic-start-year', '2025']).options,
    { course: ['_1_1', '_2_1'], academicStartYear: 2025 });
  assert.throws(() => parseArgs(['setup', '--academic-start-year', 'no']), /four-digit year/);
});

test('CLI rejects missing vault before opening or creating any archive', t => {
  const { config } = fixture(t);
  const result = spawnSync(process.execPath, ['src/cli.js', 'merge-vault', '--course', 'CS1000_27'], {
    encoding: 'utf8', env: { ...process.env, MYAB_CONFIG: config.configPath, MYAB_STATE_DIR: config.stateDir, MYAB_VAULT: '' }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Obsidian integration is optional/);
  assert.equal(fs.existsSync(config.databasePath), false);
});
