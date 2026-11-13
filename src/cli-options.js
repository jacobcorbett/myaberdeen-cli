import { OFFLINE_READ_COMMANDS } from './offline-reading.js';

const COMMON = ['course', 'term', 'profile', 'active', 'all', 'json'];
const ALLOWED = {
  ...Object.fromEntries(OFFLINE_READ_COMMANDS.map(command => [command, [...COMMON, 'format', 'id', 'search', 'limit']])),
  'content-history': [...COMMON, 'enable', 'disable', 'id', 'version', 'keep', 'apply'],
  setup: ['course', 'vault', 'academic-start-year'],
  login: [], paths: [], help: [], version: [],
  'panopto-login': [],
  'panopto-sync': [...COMMON, 'headed', 'limit-recordings', 'folder', 'dry-run'],
  recordings: [...COMMON, 'search'],
  roster: [...COMMON, 'format'],
  'test-reviews': [...COMMON, 'id', 'format'],
  recording: [...COMMON, 'id'],
  transcript: [...COMMON, 'id', 'language', 'format'],
  'panopto-download': [...COMMON, 'id', 'headed', 'dry-run', 'max-bytes'],
  courses: [...COMMON, 'headed', 'limit-courses'],
  sync: [...COMMON, 'headed', 'limit-courses', 'limit-files', 'download-files', 'dry-run', 'deep', 'roster', 'resume', 'extract', 'panopto', 'limit-recordings'],
  check: [...COMMON, 'headed', 'limit-courses', 'dry-run', 'deep', 'roster', 'resume', 'extract', 'panopto', 'limit-recordings'],
  download: [...COMMON, 'headed', 'limit-courses', 'limit-files', 'dry-run', 'deep', 'roster', 'resume', 'extract', 'panopto', 'limit-recordings'],
  refresh: [...COMMON, 'headed', 'limit-courses', 'limit-files', 'dry-run', 'deep', 'roster', 'resume', 'extract', 'panopto', 'limit-recordings'],
  export: [...COMMON, 'dry-run'], 'merge-vault': [...COMMON, 'dry-run', 'keep-duplicates'],
  extract: COMMON,
  status: COMMON, brief: COMMON, changes: [...COMMON, 'since', 'limit'], show: [...COMMON, 'id'],
  doctor: ['live', 'json', 'headed'], 'verify-files': COMMON,
  'relocate-files': [...COMMON, 'from', 'to', 'apply'], repair: ['json']
};
const VALUES = new Set(['course', 'term', 'profile', 'limit-courses', 'limit-files', 'since', 'limit', 'id', 'from', 'to', 'resume', 'folder', 'limit-recordings', 'search', 'language', 'format', 'max-bytes', 'vault', 'academic-start-year', 'version', 'keep']);
export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--version') return { command: 'version', options: {} };
  if (!args.length || args.includes('-h') || args.includes('--help')) return { command: 'help', options: {} };
  const command = args[0], options = {};
  if (!ALLOWED[command]) throw new Error(`Unknown command: ${command}. Run: myab help`);
  for (let i = 1; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !ALLOWED[command].includes(name)) throw new Error(`Unsupported option for ${command}: ${args[i]}`);
    let value = true;
    if (VALUES.has(name)) { value = args[++i]; if (!value || value.startsWith('-')) throw new Error(`--${name} requires a value.`); }
    const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (name === 'course') options.course = [...(options.course || []), value];
    else { if (options[key] !== undefined) throw new Error(`--${name} was provided twice.`); options[key] = value; }
  }
  for (const key of ['limitCourses', 'limitFiles', 'limit', 'resume', 'limitRecordings', 'maxBytes', 'version', 'keep']) if (options[key] !== undefined) {
    options[key] = Number(options[key]); if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be a positive integer.`);
  }
  if (options.academicStartYear !== undefined) {
    options.academicStartYear = Number(options.academicStartYear);
    if (!Number.isInteger(options.academicStartYear) || options.academicStartYear < 1900 || options.academicStartYear > 9999) throw new Error('--academic-start-year must be a four-digit year.');
  }
  if (options.active) { if (options.profile) throw new Error('Choose --active or --profile.'); options.profile = 'current'; }
  if (options.all && (options.course || options.term || options.profile)) throw new Error('--all cannot be combined with a narrower selection.');
  if (options.resume && (options.course || options.term || options.profile || options.all)) throw new Error('--resume uses the original bounded selection.');
  if (['sync', 'check', 'download', 'refresh', 'export', 'merge-vault', 'relocate-files', 'extract', 'panopto-sync', 'panopto-download', 'recordings', 'recording', 'transcript', 'test-reviews', 'roster', 'content-history', ...OFFLINE_READ_COMMANDS].includes(command) && !options.all && !options.course && !options.term && !options.profile && !options.resume) throw new Error('Choose --course, --term, --profile, --active, or explicitly --all.');
  if (command === 'content-history') {
    if ([options.enable, options.disable, options.keep !== undefined, options.id !== undefined].filter(Boolean).length > 1) throw new Error('Choose one history action: --enable, --disable, --keep N or --id ID.');
    if (options.version && !options.id) throw new Error('--version requires --id.');
    if (options.apply && !options.keep) throw new Error('--apply requires --keep N.');
  }
  if (command === 'relocate-files' && (!options.from || !options.to)) throw new Error('relocate-files requires --from and --to.');
  if (['show', 'recording', 'transcript', 'panopto-download'].includes(command) && !options.id) throw new Error(`${command} requires --id and a course selection.`);
  if (['test-reviews', 'roster', ...OFFLINE_READ_COMMANDS].includes(command) && options.format && !['json', 'text'].includes(options.format)) throw new Error(`${command} --format must be json or text.`);
  if (options.format && !['json', 'text', 'srt', 'vtt'].includes(options.format)) throw new Error('--format must be json, text, srt or vtt.');
  if (options.limitRecordings && ['sync', 'check', 'refresh', 'download'].includes(command) && !options.panopto) throw new Error('--limit-recordings requires --panopto.');
  if (options.since && !/^\d+$/.test(options.since) && !Number.isFinite(Date.parse(options.since))) throw new Error('--since must be a change cursor or ISO timestamp.');
  if (options.since && !/^\d+$/.test(options.since)) options.since = new Date(options.since).toISOString();
  return { command, options };
}
export function courseQueries(config, options) {
  const profile = options.profile ? config.profiles?.[options.profile] : null;
  if (options.profile && (!Array.isArray(profile) || !profile.length || profile.some(x => typeof x !== 'string' || !x.trim()))) throw new Error(`Profile “${options.profile}” needs a nonempty course allowlist in ${config.configPath}. Run: myab setup`);
  if (profile && options.course) throw new Error('Choose a profile or individual courses.');
  return profile || options.course || null;
}

export function resumedOptions(options, saved) {
  return { ...options, downloadFiles: !!saved.downloadFiles, roster: options.roster ?? !!saved.roster, deep: options.deep ?? !!saved.deep,
    limitFiles: options.limitFiles ?? saved.limitFiles ?? undefined };
}
