import fs from 'node:fs/promises';
import { assertSupportedRuntime, RELEASE_NODE } from '../src/runtime-policy.js';
assertSupportedRuntime();
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtimeVersion = (await fs.readFile(path.join(root, '.node-version'), 'utf8')).trim();
if (runtimeVersion !== RELEASE_NODE) throw new Error('.node-version must match the reviewed release runtime policy.');
assertSupportedRuntime(runtimeVersion);
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const platform = process.platform, arch = process.arch;
if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported release platform/architecture.');
const tag = process.env.RELEASE_TAG || `v${pkg.version}`;
if (tag !== `v${pkg.version}`) throw new Error(`Release tag ${tag} does not match package version v${pkg.version}.`);
const platformName = { darwin: 'macos', linux: 'linux', win32: 'windows' }[platform];
const name = `myab-${tag}-${platformName}-${arch}`;
const dist = path.join(root, 'dist');
await fs.mkdir(dist, { recursive: true });
const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'myab-build-'));
const bundle = path.join(stage, name);
const app = path.join(bundle, 'lib', 'app');
const runtime = path.join(bundle, 'lib', 'runtime');
const downloadRoot = `https://nodejs.org/dist/v${runtimeVersion}`;
const nodeName = platform === 'win32' ? 'node.exe' : 'node';
const runtimeBase = `node-v${runtimeVersion}-${platform === 'win32' ? 'win' : platform}-${arch}`;
const runtimeArchive = `${runtimeBase}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
try {
  await fs.mkdir(app, { recursive: true });
  await fs.mkdir(runtime, { recursive: true });
  // Explicit allowlist: never copy the working tree, home, profile or course archive wholesale.
  for (const item of ['src', 'skills', '.node-version', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE', 'AGENTS.md', 'config.example.json', 'package.json', 'package-lock.json']) {
    await fs.cp(path.join(root, item), path.join(app, item), { recursive: true });
  }
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, stdio: 'inherit', shell: platform === 'win32' });
  // Download an official runtime rather than copying a potentially dynamically linked local Node.
  const artifact = runtimeArchive;
  const sums = (await download(`${downloadRoot}/SHASUMS256.txt`)).toString();
  const expected = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(([, file]) => file === artifact)?.[0];
  if (!expected) throw new Error(`No official checksum for ${artifact}`);
  const bytes = await download(`${downloadRoot}/${artifact}`);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Node runtime checksum mismatch.');
  const archivePath = path.join(stage, runtimeArchive);
  await fs.writeFile(archivePath, bytes);
  if (platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:MYAB_PACKAGE_INPUT -DestinationPath $env:MYAB_PACKAGE_OUTPUT'], {
      env: { ...process.env, MYAB_PACKAGE_INPUT: archivePath, MYAB_PACKAGE_OUTPUT: stage }, stdio: 'inherit'
    });
  } else execFileSync('tar', ['-xzf', archivePath, '-C', stage], { stdio: 'inherit' });
  const extracted = path.join(stage, runtimeBase);
  await fs.copyFile(path.join(extracted, ...(platform === 'win32' ? ['node.exe'] : ['bin', 'node'])), path.join(runtime, nodeName));
  await fs.copyFile(path.join(extracted, 'LICENSE'), path.join(runtime, 'LICENSE'));
  if (platform !== 'win32') await fs.chmod(path.join(runtime, nodeName), 0o755);
  if (platform === 'win32') {
    await fs.writeFile(path.join(bundle, 'myab.cmd'), '@echo off\r\n"%~dp0lib\\runtime\\node.exe" "%~dp0lib\\app\\src\\cli.js" %*\r\nexit /b %errorlevel%\r\n');
  } else {
    await fs.writeFile(path.join(bundle, 'myab'), '#!/bin/sh\n# Keep this launcher beside lib/; add the bundle directory to PATH.\nMYAB_BUNDLE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1\nexec "$MYAB_BUNDLE_DIR/lib/runtime/node" "$MYAB_BUNDLE_DIR/lib/app/src/cli.js" "$@"\n', { mode: 0o755 });
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  await fs.writeFile(path.join(bundle, 'BUILD.json'), JSON.stringify({ version: pkg.version, revision, dirty, node: `v${runtimeVersion}`, buildNode: process.version, platform, arch }, null, 2) + '\n');
  await fs.writeFile(path.join(bundle, 'README.txt'), `MyAberdeen CLI ${tag} (${platformName} ${arch})\n\nExtract the entire folder. Run ${platform === 'win32' ? '.\\myab.cmd' : './myab'} help from a terminal.\nKeep lib/ beside the launcher. Node is included; Google Chrome is still required.\nAdd this folder to PATH for the myab command. Do not move or symlink only the launcher.\nSetup and updates: lib/app/README.md\nAI skill: lib/app/skills/myaberdeen-cli/SKILL.md\nBuild details: BUILD.json\nNode and dependency licences are preserved under lib/.\nThese portable bundles are not signed/notarised.\n`);
  const extension = platform === 'win32' ? 'zip' : 'tar.gz';
  const output = path.join(dist, `${name}.${extension}`);
  await fs.rm(output, { force: true });
  if (platform === 'win32') {
    // Environment variables avoid interpreting paths as PowerShell source.
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Compress-Archive -LiteralPath $env:MYAB_PACKAGE_INPUT -DestinationPath $env:MYAB_PACKAGE_OUTPUT'], {
      env: { ...process.env, MYAB_PACKAGE_INPUT: bundle, MYAB_PACKAGE_OUTPUT: output }, stdio: 'inherit'
    });
  } else execFileSync('tar', ['-czf', output, '-C', stage, name], { stdio: 'inherit' });
  const sha = createHash('sha256').update(await fs.readFile(output)).digest('hex');
  await fs.writeFile(`${output}.sha256`, `${sha}  ${path.basename(output)}\n`);
  console.log(output);
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}
