import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseFragment } from 'parse5';
import { atomicWrite, fileMatches } from './io.js';

const VERSION = 'text-v1';
function extractText(file, config) {
  const extension = path.extname(file.title || file.local_path).toLowerCase();
  const options = { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  if (extension === '.pdf') return execFileSync(config.pdftotext || 'pdftotext', ['-layout', file.local_path, '-'], options);
  if (['.docx', '.pptx'].includes(extension)) {
    const xml = execFileSync('unzip', ['-p', file.local_path, extension === '.docx' ? 'word/document.xml' : 'ppt/slides/slide*.xml'], options);
    const fragments = xml.replace(/<\/(?:w:p|a:p)>/g, '\n');
    const texts = [];
    const walk = node => { if (node.nodeName === '#text') texts.push(node.value); for (const child of node.childNodes || []) walk(child); };
    walk(parseFragment(fragments)); return texts.join('');
  }
  if (extension === '.ipynb') {
    const notebook = JSON.parse(fs.readFileSync(file.local_path, 'utf8'));
    return notebook.cells.map(cell => (Array.isArray(cell.source) ? cell.source.join('') : cell.source || '')).join('\n\n');
  }
  if (['.txt', '.md', '.csv', '.py', '.js', '.java', '.r'].includes(extension)) return fs.readFileSync(file.local_path, 'utf8');
  return null;
}
export function extractFiles(database, config, { courseIds } = {}) {
  const records = database.db.prepare('SELECT * FROM files').all().filter(f => (!courseIds || courseIds.includes(f.course_id)) && database.fileState(f.course_id, f.content_id).presence !== 'historical');
  const result = { extracted: 0, cached: 0, unsupported: 0, errors: [], version: VERSION };
  const seen = new Set();
  for (const file of records) {
    if (!file.sha256 || seen.has(file.sha256)) continue; seen.add(file.sha256);
    const previous = database.db.prepare('SELECT * FROM text_extractions WHERE sha256=? AND extractor_version=?').get(file.sha256, VERSION);
    if (previous?.status === 'complete' && fs.existsSync(previous.local_path)) { result.cached++; continue; }
    if (!fileMatches(file.local_path, file.sha256)) { result.errors.push({ contentId: file.content_id, error: 'Source missing or hash mismatch' }); continue; }
    try {
      const text = extractText(file, config);
      if (text === null) { result.unsupported++; continue; }
      if (!text.trim()) throw new Error('No text extracted; scanned or image-only documents need separate inspection.');
      const target = path.join(config.stateDir, 'text-cache', `${file.sha256}-${VERSION}.txt`);
      atomicWrite(target, text);
      database.db.prepare('INSERT OR REPLACE INTO text_extractions VALUES(?,?,?,?,?,?)').run(file.sha256, VERSION, target, 'complete', new Date().toISOString(), null);
      result.extracted++;
    } catch (error) {
      const message = error.code === 'ENOENT' ? 'Text extraction utility unavailable; install Poppler for PDF or unzip for Office files.' : 'Text extraction failed; inspect the original source.';
      database.db.prepare('INSERT OR REPLACE INTO text_extractions VALUES(?,?,?,?,?,?)').run(file.sha256, VERSION, null, 'failed', new Date().toISOString(), message);
      result.errors.push({ contentId: file.content_id, error: message });
    }
  }
  return result;
}
