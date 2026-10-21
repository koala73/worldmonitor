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

import { MONITORED_WORKFLOWS } from '../scripts/check-postmerge-deploys.mjs';

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
    const fetchLine = runStep.run.split(/\r?\n/).find((line) => line.includes('git fetch'));
    // Unsuppressed: the refresh must still FAIL THE JOB when it cannot run —
    // a monitor that silently proceeds on a stale tree proves nothing.
    assert.ok(fetchLine, 'the checker step must refresh its proof refs');
    assert.doesNotMatch(fetchLine, /\|\||2>\/dev\/null|--quiet\s*;/, 'the refresh must not be error-suppressed');
    // `--tags --force` is required by #7359: the convex/ skip proof compares
    // production's deployed commit (the force-moved `convex-deployed` tag) with
    // main, and without it the local tag never advances past the checkout — the
    // monitor would then report drift for code that is already deployed.
    assert.equal(
      fetchLine.trim(),
      'git fetch --quiet --tags --force origin main',
      'the deployed-baseline tag is force-moved, so the refresh must fetch tags with --force',
    );
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

  it('keeps dormant deploy proof paths identical to the workflow triggers', () => {
    for (const monitored of MONITORED_WORKFLOWS.filter((entry) => entry.triggerPaths)) {
      const deployWorkflow = YAML.parse(readFileSync(
        resolve(repoRoot, `.github/workflows/${monitored.file}`),
        'utf8',
      ));
      assert.deepEqual(
        monitored.triggerPaths,
        deployWorkflow.on.push.paths,
        `${monitored.file} trigger paths and monitor proof paths must move together`,
      );
    }
  });
});
