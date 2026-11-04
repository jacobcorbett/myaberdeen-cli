import path from 'node:path';
import fs from 'node:fs';
import { safeFilename } from './downloads.js';
import { atomicWrite } from './io.js';
import { getAssessmentReviews, renderAssessmentReviews } from './assessment-reviews.js';
import { exportRecordings } from './panopto-data.js';

const DATASETS = [
  ['content', 'content.json'],
  ['announcements', 'announcements.json'],
  ['grades', 'grades.json'],
  ['schedules', 'schedule.json'],
  ['conversations', 'conversations.json'],
  ['messages', 'messages.json'],
  ['discussion_posts', 'discussion-posts.json']
];

export function exportArchive(database, config, { courseIds } = {}) {
  const courses = database.db.prepare('SELECT * FROM courses ORDER BY term_name DESC, course_code').all().filter(c => !courseIds || courseIds.includes(c.id));
  const index = [];
  for (const course of courses) {
    const courseDirectory = path.join(config.downloadDir, safeFilename(course.term_name || 'No term'), safeFilename(course.course_code || course.id));
    const dataDirectory = path.join(courseDirectory, '_course-data');
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const counts = {};
    writeJson(path.join(dataDirectory, 'course.json'), JSON.parse(course.json));
    for (const [table, filename] of DATASETS) {
      const rows = database.db.prepare(`SELECT * FROM ${table} WHERE course_id=? ORDER BY rowid`).all(course.id)
        .map(row => { const { last_seen_at, last_seen_run, detail_checked_at, ...provenance } = database.provenance(table, row); return { ...JSON.parse(row.json), _archive: provenance }; });
      counts[table] = rows.length;
      writeJson(path.join(dataDirectory, filename), rows);
    }
    writeJson(path.join(dataDirectory, 'freshness.json'), { sections: database.sections(course.id), records: database.db.prepare('SELECT dataset,record_id,presence,last_seen_at,last_changed_at FROM record_state WHERE course_id=? ORDER BY dataset,record_id').all(course.id) });
    const reviews = getAssessmentReviews(database, [course.id]);
    counts.assessment_reviews = reviews.length;
    writeJson(path.join(dataDirectory, 'assessment-reviews.json'), reviews);
    writeText(path.join(dataDirectory, 'assessment-reviews.md'), renderAssessmentReviews(reviews));
    const files = database.db.prepare(`SELECT content_id,title,source_url,local_path,sha256,byte_size,synced_at
      FROM files WHERE course_id=? ORDER BY title`).all(course.id).map(row => ({ ...row, _archive: database.fileState(course.id, row.content_id) }));
    counts.files = files.length;
    writeJson(path.join(dataDirectory, 'files.json'), files);
    const recordings = exportRecordings(database, course.id, courseDirectory);
    counts.recordings = recordings.length;
    writeJson(path.join(dataDirectory, 'recordings.json'), recordings);
    const relativeDirectory = path.relative(config.downloadDir, courseDirectory);
    index.push({
      id: course.id,
      courseCode: course.course_code,
      name: course.name,
      term: course.term_name,
      directory: relativeDirectory,
      counts
    });
  }
  const archiveDirectory = path.join(config.downloadDir, '_archive');
  fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  const indexPath = path.join(archiveDirectory, 'index.json');
  if (courseIds && fs.existsSync(indexPath)) {
    const previous = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    index.push(...(previous.courses || []).filter(c => !courseIds.includes(c.id)));
    index.sort((a, b) => a.id.localeCompare(b.id));
  }
  writeJson(indexPath, {
    exportedAt: new Date().toISOString(),
    database: config.databasePath,
    courses: index
  });
  const totals = index.reduce((sum, course) => {
    for (const [key, value] of Object.entries(course.counts)) sum[key] = (sum[key] || 0) + value;
    return sum;
  }, {});
  const lines = [
    '# MyAberdeen offline archive',
    '',
    `Exported: ${new Date().toISOString()}`,
    '',
    `Courses: ${index.length}  `,
    `Content records: ${totals.content || 0}  `,
    `Announcements: ${totals.announcements || 0}  `,
    `Grade records: ${totals.grades || 0}  `,
    `Messages: ${totals.messages || 0}  `,
    `Discussion posts: ${totals.discussion_posts || 0}  `,
    `File records: ${totals.files || 0}`,
    '',
    'Each course directory contains its downloaded files and a private `_course-data` directory with offline JSON.',
    '',
    '## Courses',
    '',
    ...index.map(course => `- ${course.courseCode} — ${course.name} (${course.term || 'No term'})`),
    ''
  ];
  writeText(path.join(archiveDirectory, 'README.md'), `${lines.join('\n')}\n`);
  return { courses: courses.length, directory: archiveDirectory };
}

function writeJson(target, value) {
  writeText(target, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(target, value) {
  atomicWrite(target, value);
}
