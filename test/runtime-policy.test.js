import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NODE_RANGE, NODE_MINIMUMS, RELEASE_NODE, assertSupportedRuntime } from '../src/runtime-policy.js';
import { auditRuntimePolicy } from '../scripts/audit-runtime.mjs';

const releases = [
  { version: 'v22.23.4', security: true, lts: 'Jod' },
  { version: 'v24.22.1', security: true, lts: 'Krypton' },
  { version: 'v24.22.2', security: false, lts: 'Krypton' },
  { version: 'v26.12.1', security: true, lts: 'Lithium' },
  { version: 'v26.13.0', security: false, lts: 'Lithium' },
  { version: 'v26.13.1', security: true, lts: 'Lithium' }
];
const schedule = { v22: { end: '2027-04-30' }, v24: { end: '2028-04-30' }, v26: { end: '2029-04-30' } };
const today = new Date('2026-11-03T12:00:00Z');

test('runtime guard rejects affected patches, EOL majors and unreviewed future/prerelease lines', () => {
  for (const version of ['20.20.0', '22.13.0', '22.23.3', '22.23.4', '23.11.0', '24.0.0', '24.19.0', '24.20.0', '24.22.1', '24.22.2', '25.9.0', '26.12.1', '26.13.0', '27.0.0-alpha.0', '28.0.0']) {
    assert.throws(() => assertSupportedRuntime(version), /Unsupported or unpatched/);
  }
  for (const version of ['26.13.1', 'v26.13.1', '26.14.0']) assert.doesNotThrow(() => assertSupportedRuntime(version));
});

test('engine metadata and pinned runtime cannot drift from the reviewed policy', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  assert.equal(pkg.engines.node, NODE_RANGE); assert.equal(lock.packages[''].engines.node, NODE_RANGE);
  assert.equal(fs.readFileSync('.node-version', 'utf8').trim(), RELEASE_NODE);
  assert.ok(Object.values(NODE_MINIMUMS).includes(RELEASE_NODE));
});

test('official security audit accepts supported floors at or above published fixes', () => {
  const result = auditRuntimePolicy(releases, schedule, today);
  assert.deepEqual(result.findings, []); assert.equal(result.checked.length, 1);
});

test('a new official security release fails the audit until policy is updated', () => {
  const result = auditRuntimePolicy([...releases, { version: 'v26.13.2', security: true, lts: 'Lithium' }], schedule, today);
  assert.ok(result.findings.some(f => f.includes('minimum 26.13.1 is below security release v26.13.2')));
  assert.ok(result.findings.some(f => f.includes('Bundled runtime 26.13.1 is below security release')));
});

test('missing official data, EOL support and a missing release pin cannot pass', () => {
  assert.throws(() => auditRuntimePolicy([], schedule, today), /Invalid official/);
  assert.ok(auditRuntimePolicy(releases.filter(r => !r.version.startsWith('v26.')), schedule, today).findings.some(f => f.includes('Missing official')));
  assert.ok(auditRuntimePolicy(releases, { ...schedule, v26: { end: '2026-11-01' } }, today).findings.some(f => f.includes('end-of-life')));
  assert.ok(auditRuntimePolicy(releases.filter(r => r.version !== 'v26.13.1'), schedule, today).findings.some(f => f.includes('not an official LTS')));
});
