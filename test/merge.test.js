import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ArchiveDatabase } from '../src/database.js';
import { mergeVault } from '../src/merge.js';

test('mergeVault prefers and preserves an exact curated vault file', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'myab-merge-'));
  const vault=path.join(root,'vault'); const downloads=path.join(root,'downloads');
  const courseDir=path.join(vault,'Uni','Year 1','Courses','CS1000 - Test Course');
  const rawDir=path.join(downloads,'Term 1, 2023-24','CS1000_24');
  fs.mkdirSync(courseDir,{recursive:true}); fs.mkdirSync(rawDir,{recursive:true});
  fs.writeFileSync(path.join(courseDir,'CS1000 - Test Course.md'),'# Test\n');
  const curated=path.join(courseDir,'slides.pdf'); const raw=path.join(rawDir,'slides.pdf');
  fs.writeFileSync(curated,'same bytes'); fs.writeFileSync(raw,'same bytes');
  const databasePath=path.join(root,'archive.sqlite'); const database=new ArchiveDatabase(databasePath);
  database.upsertCourse({id:'_1_1',courseId:'CS1000_24',name:'CS1000 (2023-24): Test Course',termId:'_t_1'},'Term 1, 2023-24');
  const sha=crypto.createHash('sha256').update('same bytes').digest('hex');
  database.upsertFile({courseId:'_1_1',contentId:'_c_1',title:'slides.pdf',sourceUrl:'/file',localPath:raw,sha256:sha,byteSize:10});
  const result=mergeVault(database,{vaultRoot:vault,downloadDir:downloads,databasePath});
  assert.equal(result.removedFiles,1); assert.equal(fs.existsSync(raw),false); assert.equal(fs.existsSync(curated),true);
  assert.equal(database.db.prepare('select local_path from files').get().local_path,curated);
  assert.equal(fs.existsSync(path.join(courseDir,'MyAberdeen','Index.md')),true);
  database.close(); fs.rmSync(root,{recursive:true,force:true});
});

test('mergeVault preserves personal Markdown in a previous resource directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myab-preserve-'));
  const vaultRoot = path.join(root, 'vault');
  const downloadDir = path.join(root, 'downloads');
  const old = path.join(vaultRoot, 'Uni', 'University Resources', 'CS1000_27 - Course');
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(downloadDir);
  const note = path.join(old, 'personal.md');
  fs.writeFileSync(note, 'My own notes');
  const databasePath = path.join(root, 'archive.sqlite');
  const db = new ArchiveDatabase(databasePath);
  try {
    db.upsertCourse({ id: 'course', courseId: 'CS1000_27', name: 'Course' }, 'Term 1, 2026-27');
    mergeVault(db, { vaultRoot, downloadDir, databasePath });
    assert.equal(fs.readFileSync(note, 'utf8'), 'My own notes');
    assert.equal(fs.existsSync(path.join(vaultRoot, 'Uni', 'Year 4', 'Courses', 'CS1000 - Course', 'MyAberdeen', 'Index.md')), true);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
