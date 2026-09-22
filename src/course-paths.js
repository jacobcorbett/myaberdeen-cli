import fs from 'node:fs';
import path from 'node:path';
import { safeFilename } from './downloads.js';

export function baseCourseCode(value, config = {}) {
  const text = String(value || '');
  const alias = config.courseAliases?.[text] || config.courseAliases?.[text.replace(/_\d{2}$/, '')];
  return alias || text.match(/^([A-Z]{2}(?:\d{4}|\d{3}[A-Z]))_\d{2}$/)?.[1] || text;
}
export function academicYear(termName, config = {}) {
  const term = String(termName).match(/(20\d{2})[-/](\d{2}|20\d{2})/);
  if (!term) return 'Unsorted';
  if (Number.isInteger(config.academicStartYear)) return `Year ${Number(term[1]) - config.academicStartYear + 1}`;
  return `${term[1]}-${term[2].slice(-2)}`;
}
export function courseDirectories(uniRoot) {
  const result = new Map();
  for (const year of fs.readdirSync(uniRoot)) {
    const root = path.join(uniRoot, year, 'Courses');
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const target = path.join(root, name);
      if (!fs.statSync(target).isDirectory()) continue;
      const code = name.match(/^([A-Z]{2}(?:\d{4}|\d{3}[A-Z]))\b/)?.[1];
      if (code) result.set(`${year}:${code}`, target);
    }
  }
  return result;
}
export function resolveCourseDirectory(course, config, directories) {
  const uniRoot = path.join(config.vaultRoot, 'Uni');
  const explicit = config.courseDirectories?.[course.id];
  if (explicit) {
    const target = path.resolve(uniRoot, explicit);
    const relative = path.relative(uniRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Configured course directory must be inside the university vault.');
    return target;
  }
  const code = baseCourseCode(course.course_code, config);
  const year = academicYear(course.term_name, config);
  const key = `${year}:${code}`;
  if (directories.has(key)) return directories.get(key);
  // Existing Year N folders can be matched when the configured academic-year map is known.
  const isModule = /^[A-Z]{2}(?:\d{4}|\d{3}[A-Z])$/.test(code);
  const name = String(course.name || code).replace(/^\S+\s*\(\d{4}-\d{2}\):\s*/, '').trim();
  return isModule ? path.join(uniRoot, year, 'Courses', `${code} - ${safeFilename(name)}`)
    : path.join(uniRoot, 'University Resources', `${safeFilename(course.course_code)} - ${safeFilename(course.name)}-${safeFilename(course.id)}`);
}
