import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const BASE_URL = 'https://abdn.blackboard.com';
export function getConfig(env = process.env) {
  const stateDir = expandHome(env.MYAB_STATE_DIR || '~/.local/share/myaberdeen-cli');
  const configPath = expandHome(env.MYAB_CONFIG || path.join(stateDir, 'config.json'));
  let settings = {};
  if (fs.existsSync(configPath)) {
    try { settings = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { throw new Error('Invalid MyAberdeen configuration JSON.'); }
    if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error('MyAberdeen configuration must be an object.');
  }
  if (settings.academicStartYear !== undefined && (!Number.isInteger(settings.academicStartYear) || settings.academicStartYear < 1900)) throw new Error('academicStartYear must be an integer year.');
  for (const key of ['freshnessMinutes', 'deepCheckHours']) {
    if (settings[key] !== undefined && (typeof settings[key] !== 'number' || !Number.isFinite(settings[key]) || settings[key] < 0)) throw new Error(`${key} must be a non-negative number.`);
  }
  const profileDir = expandHome(env.MYAB_PROFILE_DIR || path.join(stateDir, 'chrome-profile'));
  const databasePath = expandHome(env.MYAB_DATABASE || path.join(stateDir, 'myaberdeen.sqlite'));
  const downloadDir = expandHome(env.MYAB_DOWNLOAD_DIR || '~/Documents/MyAberdeen');
  const candidates = process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : process.platform === 'win32' ? [path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  const chromePath = expandHome(env.MYAB_CHROME || candidates.find(p => fs.existsSync(p)) || candidates[0]);
  const vaultRoot = expandHome(env.MYAB_VAULT || settings.vaultRoot || '~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Main');
  return { ...settings, stateDir, profileDir, databasePath, downloadDir, chromePath, vaultRoot, configPath, baseUrl: BASE_URL };
}
export function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Some mounted filesystems do not support POSIX permissions. */ }
}
export function prepareLocalState(config) {
  ensurePrivateDirectory(config.stateDir); ensurePrivateDirectory(config.profileDir); ensurePrivateDirectory(config.downloadDir);
}
function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}
