import { getAllPages } from './api.js';
import { throwIfAborted } from './io.js';

export function migrateRoster(archive) {
  if (archive.db.prepare('PRAGMA user_version').get().user_version >= 5) return;
  archive.db.exec('BEGIN IMMEDIATE');
  try {
    archive.db.exec(`CREATE TABLE IF NOT EXISTS roster_members (
      course_id TEXT NOT NULL, id TEXT NOT NULL, synced_at TEXT NOT NULL,
      json TEXT NOT NULL, PRIMARY KEY(course_id,id));
    PRAGMA user_version=5; COMMIT;`);
  } catch (error) { archive.db.exec('ROLLBACK'); throw error; }
}

// Keep only register identity/display fields, never the expanded account profile,
// contact details, accommodations, avatars or permission payloads.
function roleLabel(item) {
  const name = item.courseRole?.courseName;
  if (typeof name === 'string' && name) return name;
  if (typeof name?.name === 'string' && name.name) return name.name;
  const key = name?.languageKey;
  if (typeof key === 'string' && key && !/^[\w.-]+\.name$/.test(key)) return key;
  // Standard Blackboard roles; custom/localised keys otherwise remain identifiers.
  const standard = new Map([['S', 'Student'], ['P', 'Instructor'], ['T', 'Teaching assistant'], ['B', 'Course builder'], ['G', 'Grader'], ['U', 'Guest']]);
  return standard.get(item.role) || item.role;
}

export function normaliseRoster(items, courseId) {
  const ids = new Set(), users = new Set();
  const string = value => typeof value === 'string' ? value : '';
  return items.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || item.courseId !== courseId ||
        typeof item.userId !== 'string' || !item.userId || item.user?.id !== item.userId ||
        ids.has(item.id) || users.has(item.userId) || typeof item.role !== 'string' || !item.role) {
      throw new Error('Incomplete or inconsistent Class Register; previous snapshot retained.');
    }
    const givenName = string(item.user.givenName), familyName = string(item.user.familyName);
    // preferredDisplayName is an enum (for example GIVEN_NAME), not a name.
    const displayName = [givenName, familyName].filter(Boolean).join(' ');
    if (!displayName) throw new Error('Class Register member has no display name; previous snapshot retained.');
    ids.add(item.id); users.add(item.userId);
    return { id: item.id, courseId, userId: item.userId, givenName, familyName, displayName,
      pronouns: string(item.user.pronouns), role: item.role,
      roleId: string(item.courseRole?.identifier),
      roleName: roleLabel(item) };
  });
}

export async function syncRoster({ session, database, course, signal }) {
  const route = `/learn/api/v1/courses/${encodeURIComponent(course.id)}/memberships?expand=user,courseRole&includeCount=true`;
  const members = normaliseRoster(await getAllPages(session, route, { signal }), course.id);
  throwIfAborted(signal);
  // Validate the entire paginated collection before replacing any member data.
  database.db.exec('BEGIN IMMEDIATE');
  try {
    const insert = database.db.prepare(`INSERT INTO roster_members VALUES(?,?,?,?)
      ON CONFLICT(course_id,id) DO UPDATE SET synced_at=excluded.synced_at,json=excluded.json`);
    const now = new Date().toISOString();
    for (const member of members) {
      insert.run(course.id, member.id, now, JSON.stringify(member));
      database.observe('roster_members', course.id, member.id, member);
    }
    database.db.exec('COMMIT');
  } catch (error) { database.db.exec('ROLLBACK'); throw error; }
}

export function readRosters(database, courses) {
  const exists = database.db.prepare("SELECT 1 FROM sqlite_master WHERE name='roster_members'").get();
  return courses.map(course => {
    const section = database.sections(course.id).find(s => s.section === 'roster');
    const members = exists ? database.db.prepare('SELECT * FROM roster_members WHERE course_id=?').all(course.id)
      .map(row => ({ ...JSON.parse(row.json), archivedAt: row.synced_at, _archive: database.provenance('roster_members', row) }))
      .sort((a, b) => a.familyName.localeCompare(b.familyName) || a.givenName.localeCompare(b.givenName) || a.id.localeCompare(b.id)) : [];
    return { courseId: course.id, courseCode: course.course_code || course.courseId || course.id,
      section: section || { status: 'never-checked', checked_at: null }, members };
  });
}

function text(value) {
  return String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/[\\`*_{}[\]()#!|<>]/g, '\\$&');
}
export function renderRosters(rosters) {
  return ['# Class Register', '',
    'Private cached membership data visible to your account. A complete API traversal covers only the members Blackboard exposes. Historical members are retained and labelled; failed refreshes preserve the previous snapshot.', '',
    ...rosters.flatMap(roster => [`## ${text(roster.courseCode)}`, '',
      `Section: ${text(roster.section.status)}. Checked: ${text(roster.section.checked_at || 'never')}.`, '',
      ...(roster.members.length ? roster.members.map(member =>
        `- ${text(member.displayName)}${member.pronouns ? ` (${text(member.pronouns)})` : ''} — ${text(member.roleName)} [${text(member._archive.presence)}]`) :
        [roster.section.status === 'completed' ? 'No members were returned by Blackboard.' : 'No cached members. Refresh this course with --roster; check section status before treating this as an empty register.']), '']), ''].join('\n');
}
