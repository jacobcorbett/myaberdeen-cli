import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { atomicWrite, throwIfAborted } from './io.js';
import { courseCode } from './api.js';
import { requireVault } from './config.js';

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
      courses.forEach((c, i) => log(`${i + 1}. ${courseCode(c)} — ${c.name || ''} (${c.term_name || 'term unknown'})${c.isAvailable === false ? ' [unavailable]' : ''}`));
      if (Array.isArray(settings.profiles?.current)) log(`Current selection: ${settings.profiles.current.join(', ')}`);
      const answer = (await ask('Course numbers, separated by commas (blank cancels): ')).trim();
      if (!answer) { log('Setup cancelled; configuration unchanged.'); return; }
      const entries = answer.split(/[\s,]+/);
      if (entries.some(n => !/^\d+$/.test(n) || Number(n) < 1 || Number(n) > courses.length)) throw new Error('Choose numbers from the course list. No configuration was changed.');
      selected = entries.map(n => courses[Number(n) - 1]);
    } else {
      selected = options.course.map(query => {
        if (!query.trim()) throw new Error('A course ID/code cannot be empty. No configuration was changed.');
        const matches = courses.filter(c => [c.id, c.courseId, c.externalId].some(v => String(v || '').toLowerCase() === query.trim().toLowerCase()));
        if (matches.length !== 1) throw new Error(`Course “${query}” must match exactly one ID/code from myab courses. No configuration was changed.`);
        return matches[0];
      });
    }
    let vault = options.vault;
    if (interactive && vault === undefined) vault = (await ask('Optional Obsidian vault path (must contain Uni; blank keeps the existing setting or skips): ')).trim() || undefined;
    if (vault !== undefined) {
      const expanded = vault === '~' ? os.homedir() : vault.startsWith('~/') ? path.join(os.homedir(), vault.slice(2)) : path.resolve(vault);
      requireVault({ vaultRoot: expanded });
      settings.vaultRoot = expanded;
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
