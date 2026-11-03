import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const platformName = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
const name = `myab-v${pkg.version}-${platformName}-${process.arch}`;
const archive = path.join(root, 'dist', `${name}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'myab smoke '));
try {
  const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  assert.equal((await fs.readFile(`${archive}.sha256`, 'utf8')).split(' ')[0], digest);
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:MYAB_PACKAGE_INPUT -DestinationPath $env:MYAB_PACKAGE_OUTPUT'], {
      env: { ...process.env, MYAB_PACKAGE_INPUT: archive, MYAB_PACKAGE_OUTPUT: temp }
    });
  } else execFileSync('tar', ['-xzf', archive, '-C', temp]);
  const bundle = path.join(temp, name);
  const app = path.join(bundle, 'lib', 'app');
  const runtime = path.join(bundle, 'lib', 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  assert.match(await fs.readFile(path.join(app, 'LICENSE'), 'utf8'), /MIT License[\s\S]*Jacob Corbett/);
  assert.equal(JSON.parse(await fs.readFile(path.join(app, 'package.json'), 'utf8')).license, 'MIT');
  await fs.access(path.join(app, 'SECURITY.md'));
  await fs.access(path.join(app, 'CONTRIBUTING.md'));
  const state = path.join(temp, 'private-state');
  const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', MYAB_CONFIG: path.join(state, 'config.json'), MYAB_STATE_DIR: state, MYAB_DATABASE: path.join(state, 'archive.sqlite'), MYAB_PROFILE_DIR: path.join(state, 'profile'), MYAB_DOWNLOAD_DIR: path.join(state, 'downloads'), MYAB_VAULT: path.join(state, 'vault') };
  // Exercise the actual launcher, including extraction to a path containing spaces.
  const run = args => {
    const launcher = path.join(bundle, process.platform === 'win32' ? 'myab.cmd' : 'myab');
    const result = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${args.join(' ')}"`], { cwd: temp, env, encoding: 'utf8', windowsVerbatimArguments: true })
      : spawnSync(launcher, args, { cwd: temp, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    return result.stdout;
  };
  assert.match(run(['help']), /Usage: myab/);
  assert.match(run(['help']), /panopto-sync/);
  assert.equal(run(['version']).trim(), pkg.version);
  assert.equal(JSON.parse(run(['paths'])).stateDir, state);
  assert.equal(JSON.parse(run(['doctor'])).node, JSON.parse(await fs.readFile(path.join(bundle, 'BUILD.json'), 'utf8')).node);
  // Run the bundled dependency graph and SQLite against synthetic data, without Chrome or an account.
  const fixture = `
    import { ArchiveDatabase } from './src/database.js';
    import { chromium, request } from 'playwright-core';
    import { storeRecording, viewerUrl } from './src/panopto-data.js';
    const db = new ArchiveDatabase(process.env.MYAB_DATABASE);
    if (db.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite integrity failed');
    db.upsertCourse({id:'synthetic',courseId:'CS1000_27',name:'Synthetic course',isAvailable:true});
    db.startRun();
    storeRecording(db, 'synthetic', {id:'11111111-1111-1111-1111-111111111111',url:viewerUrl('11111111-1111-1111-1111-111111111111'),title:'Synthetic recording',duration:3,transcripts:{'1':{captions:[{start:0,duration:3,text:'Synthetic transcript'}]}}});
    db.close();
    if (chromium.name() !== 'chromium') throw new Error('Missing Playwright browser dependency');
    const context = await request.newContext();
    await context.dispose();
  `;
  execFileSync(runtime, ['--input-type=module', '-e', fixture], { cwd: app, env, stdio: 'inherit' });
  JSON.parse(run(['status']));
  assert.equal(JSON.parse(run(['recordings', '--course', 'CS1000_27']))[0].captionCount, 1);
  assert.match(run(['transcript', '--course', 'CS1000_27', '--id', '11111111-1111-1111-1111-111111111111', '--format', 'srt']), /Synthetic transcript/);
  assert.equal(JSON.parse(run(['doctor'])).databaseIntegrity, 'ok');
  console.log(`Portable release smoke check passed: ${name}`);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
