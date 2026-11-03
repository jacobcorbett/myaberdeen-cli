import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const BASE_URL = 'https://abdn.blackboard.com';
export function getConfigPaths(env = process.env) {
  const stateDir = expandHome(env.MYAB_STATE_DIR || '~/.local/share/myaberdeen-cli');
  const configPath = expandHome(env.MYAB_CONFIG || path.join(stateDir, 'config.json'));
  return { stateDir, configPath };
}
export class ConfigurationError extends Error {
  constructor(message, configPath) { super(`Configuration error in ${configPath}: ${message}`); this.configPath = configPath; }
}
export function getConfig(env = process.env) {
  const { stateDir, configPath } = getConfigPaths(env);
  const invalid = message => new ConfigurationError(message, configPath);
  let settings = {};
  if (fs.existsSync(configPath)) {
    try { settings = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { throw invalid('Invalid MyAberdeen configuration JSON; check for trailing commas and missing quotes.'); }
    if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw invalid('MyAberdeen configuration must be an object.');
  }
  if (settings.academicStartYear !== undefined && (!Number.isInteger(settings.academicStartYear) || settings.academicStartYear < 1900)) throw invalid('academicStartYear must be an integer year.');
  for (const key of ['freshnessMinutes', 'deepCheckHours']) {
    if (settings[key] !== undefined && (typeof settings[key] !== 'number' || !Number.isFinite(settings[key]) || settings[key] < 0)) throw invalid(`${key} must be a non-negative number.`);
  }
  const profileDir = expandHome(env.MYAB_PROFILE_DIR || path.join(stateDir, 'chrome-profile'));
  const databasePath = expandHome(env.MYAB_DATABASE || path.join(stateDir, 'myaberdeen.sqlite'));
  for (const key of ['downloadDir', 'chromePath', 'vaultRoot']) if (settings[key] !== undefined && (typeof settings[key] !== 'string' || !settings[key].trim())) throw invalid(`${key} must be a nonempty path.`);
  const configDirectory = path.dirname(configPath);
  const downloadDir = env.MYAB_DOWNLOAD_DIR ? expandHome(env.MYAB_DOWNLOAD_DIR) : expandHome(settings.downloadDir || '~/Documents/MyAberdeen', configDirectory);
  const candidates = chromeCandidates(env);
  const chromePath = env.MYAB_CHROME ? expandHome(env.MYAB_CHROME) : settings.chromePath ? expandHome(settings.chromePath, configDirectory) : candidates.find(p => fs.existsSync(p)) || candidates[0];
  const vault = env.MYAB_VAULT || settings.vaultRoot;
  if (vault !== undefined && (typeof vault !== 'string' || !vault.trim())) throw invalid('vaultRoot must be a nonempty path.');
  const vaultRoot = vault ? expandHome(vault, env.MYAB_VAULT ? process.cwd() : configDirectory) : null;
  return { ...settings, stateDir, profileDir, databasePath, downloadDir, chromePath, vaultRoot, configPath, baseUrl: BASE_URL };
}
export function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Some mounted filesystems do not support POSIX permissions. */ }
}
export function prepareLocalState(config) {
  ensurePrivateDirectory(config.stateDir); ensurePrivateDirectory(config.profileDir); ensurePrivateDirectory(config.downloadDir);
}
export function expandHome(value, base = process.cwd()) {
  if (value === '~') return os.homedir();
  if (/^~[\\/]/.test(value)) return path.join(os.homedir(), value.slice(2));
  return path.resolve(base, value);
}

export function requireVault(config) {
  if (!config.vaultRoot) throw new Error('Obsidian integration is optional. Configure vaultRoot with myab setup --vault <path> or set MYAB_VAULT before using merge-vault.');
  const root = path.join(config.vaultRoot, 'Uni');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`University vault directory not found: ${root}. Choose a vault containing a Uni directory.`);
  return root;
}

export function chromeCandidates(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')];
  if (platform === 'win32') return [...new Set([
    env.PROGRAMFILES || 'C:\\Program Files', env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local')
  ].map(root => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')))];
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
}
