// Last reviewed against Node.js security releases on 2026-11-03.
export const NODE_MINIMUMS = Object.freeze({ 26: '26.13.0' });
export const NODE_RANGE = '>=26.13.0 <27';
export const RELEASE_NODE = '26.13.0';

export function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
  return match ? match.slice(1).map(Number) : null;
}
export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) throw new Error('Expected stable Node versions in major.minor.patch form.');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
export function assertSupportedRuntime(version = process.versions.node) {
  const parts = versionParts(version);
  const minimum = parts && NODE_MINIMUMS[parts[0]];
  if (!minimum || compareVersions(version, minimum) < 0) {
    throw new Error(`Unsupported or unpatched Node.js ${version}. Use ${NODE_RANGE}; install the latest security patch for a supported LTS line.`);
  }
}
