/**
 * Contract for the main-only Railway registry reconciler.
 *
 * A registry change is incomplete until the live production configuration
 * matches it. This workflow owns that transition. It applies from the exact
 * merged checkout, then proves the result through the separate Viewer identity.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/railway-registry-sync.yml');
const source = readFileSync(workflowPath, 'utf8');
const workflow = YAML.parse(source);

function steps(job) {
  assert.ok(Array.isArray(job?.steps), 'job must define steps');
  return job.steps;
}

function stepNamed(job, name) {
  const step = steps(job).find((candidate) => candidate.name === name);
  assert.ok(step, `job must define ${JSON.stringify(name)}`);
  return step;
}

describe('Railway Registry Sync workflow', () => {
  it('runs for desired-state and reconciler changes on main', () => {
    assert.equal(workflow.name, 'Railway Registry Sync');
    assert.deepEqual(workflow.on.push, {
      branches: ['main'],
      paths: [
        '.github/workflows/railway-registry-sync.yml',
        'scripts/audit-railway-watch-paths.mjs',
        'scripts/railway-native-autodeploy-fleet.json',
        'scripts/railway-*.mjs',
        'scripts/railway-services.json',
        'scripts/run-railway-registry-sync.mjs',
      ],
    });
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
    assert.equal(Object.hasOwn(workflow.on, 'schedule'), false);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
  });

  it('serializes production writes and never cancels an in-flight apply', () => {
    assert.deepEqual(workflow.concurrency, {
      group: 'railway-registry-sync-production',
      'cancel-in-progress': false,
    });
  });

  it('uses one protected main-only job', () => {
    assert.deepEqual(Object.keys(workflow.jobs), ['reconcile']);
    const job = workflow.jobs.reconcile;
    assert.equal(job.needs, undefined);
    assert.equal(job['continue-on-error'], undefined);
    assert.deepEqual(job.environment, {
      name: 'ingestion-acceptance-production',
      deployment: false,
    });
  });

  it('keeps mutation and Viewer credentials in separate steps', () => {
    const job = workflow.jobs.reconcile;
    assert.equal(job.env, undefined);

    const apply = stepNamed(job, 'Reconcile registry-managed Railway configuration');
    assert.deepEqual(apply.env, {
      RAILWAY_TOKEN: '${{ secrets.RAILWAY_RECONCILE_DEPLOY_TOKEN_V2 }}',
      RAILWAY_PROJECT_ID: '${{ vars.RAILWAY_PROJECT_ID }}',
    });
    assert.equal(apply.run, 'node scripts/run-railway-registry-sync.mjs --mode apply');

    const verify = stepNamed(job, 'Verify live configuration with the Viewer identity');
    assert.match(verify.if, /^always\(\)/);
    assert.match(verify.if, /steps\.checkout\.outcome == 'success'/);
    assert.match(verify.if, /steps\.setup-node\.outcome == 'success'/);
    assert.match(verify.if, /steps\.install-railway\.outcome == 'success'/);
    assert.deepEqual(verify.env, {
      RAILWAY_API_TOKEN: '${{ secrets.RAILWAY_PRODUCTION_VIEWER_API_TOKEN }}',
      RAILWAY_PROJECT_ID: '${{ vars.RAILWAY_PROJECT_ID }}',
    });
    assert.equal(verify.run, 'node scripts/run-railway-registry-sync.mjs --mode verify');

    for (const step of steps(job)) {
      if (step === apply || step === verify) continue;
      assert.equal(step.env, undefined, `${step.name ?? step.uses} must not inherit a Railway credential`);
    }
    assert.doesNotMatch(apply.run, /RAILWAY_API_TOKEN|PRODUCTION_VIEWER/);
    assert.doesNotMatch(verify.run, /RAILWAY_TOKEN|RECONCILE_DEPLOY/);
  });

  it('applies before the independent Viewer readback', () => {
    const jobSteps = steps(workflow.jobs.reconcile);
    const apply = stepNamed(workflow.jobs.reconcile, 'Reconcile registry-managed Railway configuration');
    const verify = stepNamed(workflow.jobs.reconcile, 'Verify live configuration with the Viewer identity');
    assert.equal(jobSteps[0].name, 'Start config-reconciliation run budget');
    assert.match(jobSteps[0].run, /RAILWAY_CONFIG_AUDIT_JOB_STARTED_AT_MS/);
    assert.ok(jobSteps.indexOf(apply) < jobSteps.indexOf(verify));
    assert.match(source, /Start config-reconciliation run budget/);
    assert.doesNotMatch(source, /Name the operator sync command|run node scripts\/audit-railway-watch-paths\.mjs --apply/);
  });
});
