import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { atomicWrite, throwIfAborted } from './io.js';
import { courseCode, normaliseAvailability } from './api.js';
import { requireVault, expandHome } from './config.js';

export async function setup(config, courses, options = {}, { ask, log = console.log, signal } = {}) {
  if (!courses.length) throw new Error('No course memberships were returned. No configuration was changed.');
  if (!options.course && !ask && !process.stdin.isTTY) throw new Error('Interactive setup needs a terminal. Run myab login, then myab setup; or use myab setup --course <exact-ID/code> (repeatable).');
  const before = fs.existsSync(config.configPath) ? fs.readFileSync(config.configPath, 'utf8') : null;
  const settings = before === null ? {} : JSON.parse(before);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid MyAberdeen configuration JSON.');
  if (settings.profiles !== undefined && (!settings.profiles || typeof settings.profiles !== 'object' || Array.isArray(settings.profiles))) throw new Error('profiles must be an object. No configuration was changed.');
  let reader;
  const interactive = !options.course;
  if (interactive && !ask) {
    reader = createInterface({ input: process.stdin, output: process.stdout });
    ask = prompt => reader.question(prompt, { signal });
  }
  try {
    let selected;
    if (interactive) {
      log('Choose the courses to include in --active. Memberships may include old courses; check the term.');
      courses.forEach((c, i) => log(`${i + 1}. ${courseCode(c)} — ${c.name || ''} (${c.term_name || 'term unknown'})${normaliseAvailability(c) === 0 ? ' [unavailable]' : ''}`));
      if (Array.isArray(settings.profiles?.current)) log(`Current selection: ${settings.profiles.current.join(', ')}`);
      while (!selected) {
        const answer = await ask('Course numbers, separated by commas (blank cancels): ');
        if (typeof answer !== 'string') throw new Error('Setup input ended; configuration unchanged.');
        if (!answer.trim()) { log('Setup cancelled; configuration unchanged.'); return; }
        const entries = answer.trim().split(/[\s,]+/).filter(Boolean);
        if (!entries.length || entries.some(n => !/^\d+$/.test(n) || Number(n) < 1 || Number(n) > courses.length)) {
          log('Choose numbers from the course list, or leave blank to cancel.'); continue;
        }
        selected = entries.map(n => courses[Number(n) - 1]);
      }
    } else {
      selected = options.course.map(query => {
        if (!query.trim()) throw new Error('A course ID/code cannot be empty. No configuration was changed.');
        const matches = courses.filter(c => [c.id, c.courseId, c.externalId].some(v => String(v || '').toLowerCase() === query.trim().toLowerCase()));
        if (matches.length !== 1) throw new Error(`Course “${query}” must match exactly one ID/code from myab courses. No configuration was changed.`);
        return matches[0];
      });
    }
    let vault = options.vault;
    while (true) {
      if (interactive && vault === undefined) {
        const answer = await ask('Optional Obsidian vault path (must contain Uni; blank keeps the existing setting or skips): ');
        if (typeof answer !== 'string') throw new Error('Setup input ended; configuration unchanged.');
        vault = answer.trim() || undefined;
      }
      if (vault === undefined) break;
      try {
        const expanded = normaliseInputPath(vault);
        requireVault({ vaultRoot: expanded });
        settings.vaultRoot = expanded; break;
      } catch (error) {
        if (!interactive || options.vault !== undefined) throw error;
        log(error.message); vault = undefined;
      }
    }
    if (options.academicStartYear !== undefined) settings.academicStartYear = options.academicStartYear;
    settings.profiles = { ...settings.profiles, current: [...new Set(selected.map(c => c.id))] };
    throwIfAborted(signal);
    const current = fs.existsSync(config.configPath) ? fs.readFileSync(config.configPath, 'utf8') : null;
    if (current !== before) throw new Error('Configuration changed during setup. Run setup again to preserve those changes.');
    atomicWrite(config.configPath, JSON.stringify(settings, null, 2) + '\n');
    log(`Saved ${settings.profiles.current.length} current courses to ${config.configPath}.`);
    log('Next: myab check --active (metadata), then myab refresh --active (downloads too).');
    if (!settings.vaultRoot && !config.vaultRoot) log('Obsidian integration is disabled. Normal archive commands work without a vault.');
  } finally { reader?.close(); }
}

export function normaliseInputPath(value, platform = process.platform) {
  let input = value.trim();
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) input = input.slice(1, -1);
  if (platform !== 'win32') input = input.replace(/\\([ ()&'"])/g, '$1');
  if (!input.trim()) throw new Error('Choose a nonempty path.');
  return expandHome(input);
}
