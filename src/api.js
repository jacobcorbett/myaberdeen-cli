function asResults(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.results || [];
}

export async function getAllPages(session, route, { limit = 100, maxItems = 20_000 } = {}) {
  const output = [];
  let offset = 0;
  while (output.length < maxItems) {
    const url = new URL(route, 'https://placeholder.invalid');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const payload = await session.getJson(`${url.pathname}${url.search}`);
    const page = asResults(payload);
    output.push(...page);
    if (page.length < limit) break;
    offset += page.length;
  }
  return output.slice(0, maxItems);
}

export async function getAccountOverview(session) {
  const user = await session.getJson('/learn/api/v1/users/me?expand=systemRoles,insRoles');
  const memberships = await getAllPages(
    session,
    `/learn/api/v1/users/${encodeURIComponent(user.id)}/memberships?expand=course.effectiveAvailability,course.permissions,courseRole&includeCount=true`,
    { limit: 200 }
  );
  const terms = await getAllPages(session, '/learn/api/v1/terms', { limit: 200 });
  return { user, memberships, terms };
}

export function courseFromMembership(membership) {
  return membership.course || membership.courseMembership?.course || null;
}

export function courseCode(course) {
  return course?.courseId || course?.externalId || course?.id || 'unknown-course';
}

export function selectCourses(memberships, query) {
  const courses = memberships.map(courseFromMembership).filter(Boolean);
  if (!query) return courses;
  const needle = query.toLowerCase();
  return courses.filter(course => [course.id, course.courseId, course.externalId, course.name]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(needle)));
}
