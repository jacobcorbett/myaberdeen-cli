import { pathToFileURL } from 'node:url';
import { NODE_MINIMUMS, RELEASE_NODE, assertSupportedRuntime, compareVersions, versionParts } from '../src/runtime-policy.js';

export function auditRuntimePolicy(releases, schedule, today = new Date()) {
  if (!Array.isArray(releases) || !releases.length || !schedule || typeof schedule !== 'object') throw new Error('Invalid official Node release data.');
  const findings = [], checked = [];
  for (const [major, minimum] of Object.entries(NODE_MINIMUMS)) {
    const line = releases.filter(r => versionParts(r.version)?.[0] === Number(major));
    const security = line.filter(r => r.security === true).sort((a, b) => compareVersions(b.version, a.version))[0];
    const support = schedule[`v${major}`];
    if (!security || !support?.end || !Number.isFinite(Date.parse(support.end))) { findings.push(`Missing official security/support data for Node ${major}.`); continue; }
    if (today >= new Date(`${support.end}T00:00:00Z`)) findings.push(`Node ${major} is end-of-life; remove it from the supported range.`);
    if (compareVersions(minimum, security.version) < 0) findings.push(`Node ${major} minimum ${minimum} is below security release ${security.version}; update runtime-policy.js, package engines, CI, docs and release pin as appropriate.`);
    checked.push({ major: Number(major), minimum, latestSecurity: security.version, endOfLife: support.end });
  }
  const release = releases.find(r => r.version === `v${RELEASE_NODE}`);
  if (!release?.lts) findings.push(`Pinned release runtime ${RELEASE_NODE} is not an official LTS release.`);
  if (release) {
    const security = releases.filter(r => versionParts(r.version)?.[0] === versionParts(RELEASE_NODE)[0] && r.security === true).sort((a, b) => compareVersions(b.version, a.version))[0];
    if (security && compareVersions(RELEASE_NODE, security.version) < 0) findings.push(`Bundled runtime ${RELEASE_NODE} is below security release ${security.version}.`);
  }
  return { checked, bundledRuntime: RELEASE_NODE, findings };
}
async function officialJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Official Node security data unavailable (HTTP ${response.status}); audit did not pass.`);
  return response.json();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertSupportedRuntime();
    const [releases, schedule] = await Promise.all([
      officialJson('https://nodejs.org/dist/index.json'),
      officialJson('https://raw.githubusercontent.com/nodejs/Release/main/schedule.json')
    ]);
    const result = auditRuntimePolicy(releases, schedule);
    console.log(JSON.stringify(result, null, 2));
    if (result.findings.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
