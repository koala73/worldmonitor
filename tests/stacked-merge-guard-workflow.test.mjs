// #7006 — the stacked-merge guard must run on every PR (including a change of
// base) and the post-merge monitor must file a visible alarm instead of only
// red-xing a closed PR. These tests pin the workflow wiring; the decision
// functions live in tests/check-stacked-merge.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guardPath = resolve(repoRoot, '.github/workflows/stacked-merge-guard.yml');
const monitorPath = resolve(repoRoot, '.github/workflows/orphaned-stacked-merge-monitor.yml');
const guard = YAML.parse(readFileSync(guardPath, 'utf8'));
const monitor = YAML.parse(readFileSync(monitorPath, 'utf8'));

function pin(uses) {
  assert.match(uses, /@[0-9a-f]{40}$/i, `${uses} must be pinned to a commit SHA`);
}

describe('stacked merge guard workflow', () => {
  it('runs on pull_request base edits and on push to main so the deploy gate can require it', () => {
    assert.equal(guard.name, 'Stacked Merge Guard');
    assert.deepEqual(guard.on.pull_request.types, [
      'opened',
      'synchronize',
      'reopened',
      'edited',
      'ready_for_review',
    ]);
    assert.deepEqual(guard.on.push.branches, ['main']);
    assert.ok(Object.hasOwn(guard.jobs, 'stacked-merge-guard'));
    assert.equal(guard.jobs['stacked-merge-guard'].name, undefined, 'job id is the check-run name the gate matches');
  });

  it('invokes the pre-merge checker with the event payload, not interpolated branch names', () => {
    const step = guard.jobs['stacked-merge-guard'].steps.find((entry) => entry.name === 'Guard stacked PR base');
    assert.ok(step, 'workflow must define the pre-merge checker step');
    assert.match(step.run, /node scripts\/check-stacked-merge\.mjs --mode pre-merge/);
    assert.equal(step.env.GH_TOKEN, '${{ github.token }}');
    assert.doesNotMatch(step.run, /github\.event\.pull_request\.base\.ref/);
  });

  it('checks out the PR with a pinned Node 24 toolchain and read-only permissions', () => {
    assert.deepEqual(guard.permissions, { contents: 'read', 'pull-requests': 'read' });
    const checkout = guard.jobs['stacked-merge-guard'].steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    const setupNode = guard.jobs['stacked-merge-guard'].steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    assert.ok(checkout, 'workflow must check out the repo');
    assert.ok(setupNode, 'workflow must set up Node');
    pin(checkout.uses);
    pin(setupNode.uses);
    assert.equal(setupNode.with['node-version'], '24');
  });
});

describe('orphaned stacked merge monitor workflow', () => {
  it('runs only after a merge and can open an issue plus a PR comment', () => {
    assert.equal(monitor.name, 'Orphaned Stacked Merge Monitor');
    assert.deepEqual(monitor.on.pull_request.types, ['closed']);
    assert.equal(monitor.jobs.monitor.if, "github.event.pull_request.merged == true");
    assert.deepEqual(monitor.permissions, {
      contents: 'read',
      issues: 'write',
      'pull-requests': 'write',
    });
  });

  it('checks out the merge commit, refreshes main, and runs the post-merge checker', () => {
    const checkout = monitor.jobs.monitor.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    const runStep = monitor.jobs.monitor.steps.find((step) => step.name === 'Verify merge commit reached main');
    assert.ok(checkout, 'workflow must check out the merge commit so the script exists');
    assert.equal(checkout.with.ref, '${{ github.event.pull_request.merge_commit_sha }}');
    assert.equal(checkout.with['fetch-depth'], 0);
    assert.equal(checkout.with.filter, 'blob:none');
    pin(checkout.uses);
    assert.ok(runStep, 'workflow must define the post-merge checker step');
    assert.match(runStep.run, /git fetch --quiet origin "\$DEFAULT_BRANCH"/);
    assert.match(runStep.run, /node scripts\/check-stacked-merge\.mjs --mode post-merge/);
    assert.equal(runStep.env.GH_TOKEN, '${{ github.token }}');
  });
});
