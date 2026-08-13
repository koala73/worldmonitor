// #6376 — the post-merge deploy monitor must run on a schedule and invoke the
// checker without a green-main gate. The incidents it exists to catch had
// green main while the deploy failed; a gate (or a workflow_run trigger) is
// one more way for this to go quiet.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/postmerge-deploy-monitor.yml');
const workflow = YAML.parse(readFileSync(workflowPath, 'utf8'));

describe('post-merge deploy monitor workflow', () => {
  it('runs on a schedule and on demand, and supersedes longer runs', () => {
    assert.ok(workflow.on.schedule, 'workflow must run on a schedule (a run event cannot see a workflow that never ran)');
    assert.match(workflow.on.schedule[0].cron, /^\*\/10 \* \* \* \*$/);
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
    assert.deepEqual(workflow.concurrency, {
      group: 'postmerge-deploy-monitor',
      'cancel-in-progress': true,
    });
  });

  it('runs the checker with a blobless full-history checkout', () => {
    const checkout = workflow.jobs.monitor.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.ok(checkout, 'workflow must check out the repo');
    assert.equal(checkout.with['fetch-depth'], 0, 'full history is needed to prove a convex=false skip from the head diff');
    assert.equal(checkout.with['filter'], 'blob:none', 'git diff --name-only needs trees only');
    assert.match(checkout.uses, /@[0-9a-f]{40}$/i, 'checkout must be pinned to a commit SHA');
  });

  it('invokes the checker without a green-main gate or workflow_run trigger', () => {
    const runStep = workflow.jobs.monitor.steps.find((step) => step.name === 'Check post-merge deploys reached production');
    assert.ok(runStep, 'workflow must define the checker step');
    assert.match(runStep.run, /git fetch --quiet origin main/);
    assert.match(runStep.run, /node scripts\/check-postmerge-deploys\.mjs/);
    assert.doesNotMatch(runStep.run, /gate/);
    // The seed-freshness green-main gate must NOT appear here: gating on main
    // would silence the monitor exactly when the deploy failed despite green
    // main — the #6376 incident.
    assert.doesNotMatch(JSON.stringify(workflow), /context\s*==\s*"gate"/);
    assert.equal(workflow.on.workflow_run, undefined, 'a workflow_run trigger cannot see a workflow that never ran');
  });

  it('needs no write permissions — it only reads GitHub and the git tree', () => {
    assert.deepEqual(workflow.permissions, { contents: 'read' });
  });
});