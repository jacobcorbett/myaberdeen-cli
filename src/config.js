import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const BASE_URL = 'https://abdn.blackboard.com';

export function getConfig(env = process.env) {
  const stateDir = expandHome(env.MYAB_STATE_DIR || '~/.local/share/myaberdeen-cli');
  const profileDir = expandHome(env.MYAB_PROFILE_DIR || path.join(stateDir, 'chrome-profile'));
  const databasePath = expandHome(env.MYAB_DATABASE || path.join(stateDir, 'myaberdeen.sqlite'));
  const downloadDir = expandHome(env.MYAB_DOWNLOAD_DIR || '~/Documents/MyAberdeen');
  const chromePath = expandHome(env.MYAB_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  const vaultRoot = expandHome(env.MYAB_VAULT || '~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Main');
  return { stateDir, profileDir, databasePath, downloadDir, chromePath, vaultRoot, baseUrl: BASE_URL };
}

export function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Some mounted filesystems do not support POSIX permissions.
  }
}

export function prepareLocalState(config) {
  ensurePrivateDirectory(config.stateDir);
  ensurePrivateDirectory(config.profileDir);
  ensurePrivateDirectory(config.downloadDir);
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}
