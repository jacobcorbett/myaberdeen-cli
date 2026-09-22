import { fingerprint, throwIfAborted } from './io.js';

export async function getAllPages(session, route, { limit = 100, maxItems = 20_000, signal } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxItems) || maxItems < 1) throw new Error('Invalid pagination limits.');
  const output = [], pages = new Set();
  let offset = 0;
  while (true) {
    throwIfAborted(signal);
    const url = new URL(route, 'https://placeholder.invalid');
    url.searchParams.set('limit', String(limit)); url.searchParams.set('offset', String(offset));
    const payload = await session.getJson(`${url.pathname}${url.search}`);
    const page = Array.isArray(payload) ? payload : payload?.results;
    if (!Array.isArray(page)) throw new Error(`Unexpected pagination response for ${url.pathname}; archive completeness is unknown.`);
    const signature = fingerprint(page.map(item => item?.id ?? item));
    if (page.length && pages.has(signature)) throw new Error(`Pagination made no progress for ${url.pathname}.`);
    pages.add(signature);
    if (output.length + page.length > maxItems) throw new Error(`Pagination limit reached for ${url.pathname}; results are incomplete.`);
    output.push(...page);
    const total = payload?.paging?.count ?? payload?.totalCount;
    if (page.length < limit && !(typeof total === 'number' && total > output.length) && !payload?.paging?.nextPage) return output;
    if (!page.length) throw new Error(`Pagination ended before the advertised total for ${url.pathname}.`);
    offset += page.length;
  }
}
export async function getAccountOverview(session) {
  const user = await session.getJson('/learn/api/v1/users/me?expand=systemRoles,insRoles');
  if (!user?.id) throw new Error('Blackboard returned no account ID.');
  const memberships = await getAllPages(session, `/learn/api/v1/users/${encodeURIComponent(user.id)}/memberships?expand=course.effectiveAvailability,course.permissions,courseRole&includeCount=true`, { limit: 200 });
  const terms = await getAllPages(session, '/learn/api/v1/terms', { limit: 200 });
  return { user, memberships, terms };
}
export function courseFromMembership(membership) { return membership.course || membership.courseMembership?.course || null; }
export function courseCode(course) { return course?.courseId || course?.externalId || course?.course_code || course?.id || 'unknown-course'; }
export function selectCourses(memberships, query) {
  const courses = memberships.map(m => courseFromMembership(m) || m).filter(c => c?.id);
  if (!query || (Array.isArray(query) && !query.length)) return courses;
  const selected = new Set();
  for (const term of Array.isArray(query) ? query : [query]) {
    const needle = String(term).trim().toLowerCase();
    if (!needle) throw new Error('A course selector cannot be empty.');
    const identifiers = c => [c.id, c.courseId, c.externalId, c.course_code].filter(Boolean).map(v => String(v).toLowerCase());
    let matches = courses.filter(c => identifiers(c).includes(needle));
    if (!matches.length) matches = courses.filter(c => [...identifiers(c), String(c.name || '').toLowerCase()].some(v => v.includes(needle)));
    if (!matches.length) throw new Error(`No course matched “${term}”.`);
    for (const match of matches) selected.add(match.id);
  }
  return courses.filter(c => selected.has(c.id));
}
export function normaliseAvailability(course) {
  const value = course.effectiveAvailability?.available ?? course.isAvailable ?? course.availability?.available;
  if (value === true || value === 'Yes') return 1;
  if (value === false || value === 'No' || value === 'Disabled') return 0;
  return null;
}
