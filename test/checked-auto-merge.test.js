import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the actual privileged workflow shell with a synthetic gh executable.
const workflow = fs.readFileSync('.github/workflows/release-auto-merge.yml', 'utf8');
function workflowScript(text) {
  return text.replace(/\r\n/g, '\n').split('        run: |\n')[1].replace(/^ {10}/gm, '');
}
const script = workflowScript(workflow);
const skipShell = process.platform === 'win32' ? 'The merge job runs on Linux.'
  : spawnSync('jq', ['--version']).status !== 0 ? 'Install jq to exercise the workflow shell locally.' : false;

test('workflow shell extraction accepts LF and Windows CRLF checkouts', () => {
  const lf = workflow.replace(/\r\n/g, '\n');
  assert.equal(workflowScript(lf.replace(/\n/g, '\r\n')), workflowScript(lf));
  assert.match(script, /set -euo pipefail/);
});
const checks = ['check (ubuntu-latest)', 'check (macos-latest)', 'check (windows-latest)', 'security'].map(name => ({ name, state: 'SUCCESS' }));
const request = { enabledBy: { login: 'owner' }, mergeMethod: 'SQUASH' };
const pr = { state: 'OPEN', baseRefName: 'main', isDraft: false, headRefOid: 'checked-head', mergeable: 'MERGEABLE', reviewDecision: '', reviews: [], autoMergeRequest: request };

test('checked auto-merge requires live owner intent, exact head, reviews and every successful required check', { skip: skipShell }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myab-merge-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'merge.log');
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh
case "$1 $2" in
  'pr list') cat "$FIXTURE_DIR/list.json";;
  'pr view') cat "$FIXTURE_DIR/pr.json";;
  'pr checks') cat "$FIXTURE_DIR/checks.json"; exit "$CHECK_EXIT";;
  'pr merge') printf '%s\\n' "$*" >> "$MERGE_LOG";;
  *) exit 2;;
esac
`, { mode: 0o700 });
  const run = ({ patch = {}, states = checks, checkExit = 0, env = {}, listRequest = request, listBranch } = {}) => {
    fs.writeFileSync(path.join(dir, 'list.json'), JSON.stringify([{ number: 8, autoMergeRequest: listRequest, headRefName: listBranch }]));
    fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({ ...pr, ...patch }));
    fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify(states));
    fs.rmSync(log, { force: true });
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`, FIXTURE_DIR: dir, MERGE_LOG: log, CHECK_EXIT: String(checkExit),
      GH_TOKEN: 'synthetic', GH_REPO: 'owner/example', REPOSITORY_OWNER: 'owner', EVENT_NAME: 'workflow_run',
      CHECKED_SHA: 'checked-head', PR_NUMBER: '', TRIGGERING_ACTOR: 'owner', ...env } });
    return { status: result.status, stderr: result.stderr, merged: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
  };
  assert.match(run().merged, /pr merge 8 --squash --admin --match-head-commit checked-head/);
  for (const patch of [
    { state: 'CLOSED' }, { baseRefName: 'other' }, { isDraft: true }, { headRefOid: 'new-head' },
    { mergeable: 'UNKNOWN' }, { mergeable: 'CONFLICTING' }, { reviewDecision: 'REVIEW_REQUIRED' },
    { autoMergeRequest: null }, { autoMergeRequest: { ...request, enabledBy: { login: 'other' } } },
    { autoMergeRequest: { ...request, mergeMethod: 'MERGE' } },
    { reviews: [{ author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01' }] }
  ]) assert.equal(run({ patch }).merged, '', JSON.stringify(patch));
  for (const state of ['PENDING', 'FAILURE', 'SKIPPED', 'CANCELLED']) {
    assert.equal(run({ states: checks.map((c, i) => i === 0 ? { ...c, state } : c) }).merged, '', state);
  }
  assert.equal(run({ states: checks.slice(1) }).merged, '');
  assert.equal(run({ states: [...checks, { name: 'future-required-check', state: 'FAILURE' }] }).merged, '');
  assert.equal(run({ checkExit: 1 }).merged, '');
  assert.equal(run({ listRequest: null }).merged, '');
  assert.equal(run({ env: { PR_NUMBER: '9' } }).merged, '');
  assert.equal(run({ env: { EVENT_NAME: 'workflow_dispatch', TRIGGERING_ACTOR: 'other' } }).status, 1);
  assert.equal(run({ env: { GH_TOKEN: '' } }).status, 1);
  assert.match(run({ env: { EVENT_NAME: 'pull_request_target', CHECKED_SHA: '', PR_NUMBER: '8' } }).merged, /pr merge/);
  const reviews = [
    { author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01' },
    { author: { login: 'reviewer' }, state: 'APPROVED', submittedAt: '2026-01-02' }
  ];
  assert.match(run({ patch: { reviews, reviewDecision: 'APPROVED' } }).merged, /pr merge/);
  assert.doesNotMatch(workflow, /uses:.*checkout|download-artifact/);
  const release = { author: { login: 'owner' }, isCrossRepository: false,
    headRefName: 'release-please--branches--main--components--myaberdeen-cli', labels: [{ name: 'autorelease: pending' }], autoMergeRequest: null };
  assert.match(run({ patch: release, listRequest: null, listBranch: release.headRefName }).merged, /pr merge/);
  for (const change of [{ author: { login: 'other' } }, { isCrossRepository: true }, { labels: [] }]) {
    assert.equal(run({ patch: { ...release, ...change }, listRequest: null, listBranch: release.headRefName }).merged, '');
  }
  assert.equal(run().status, 0);
});
