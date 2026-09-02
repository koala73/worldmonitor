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
    assert.equal(job['timeout-minutes'], 20);
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
    assert.match(verify.if, /steps\.admit-current-main\.outcome == 'success'/);
    assert.match(verify.if, /steps\.setup-node\.outcome == 'success'/);
    assert.match(verify.if, /steps\.install-railway\.outcome == 'success'/);
    assert.match(verify.if, /steps\.start-viewer-budget\.outcome == 'success'/);
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

  it('rejects a stale checkout before setup or production credentials', () => {
    const jobSteps = steps(workflow.jobs.reconcile);
    const checkoutIndex = jobSteps.findIndex((step) => step.id === 'checkout');
    const admission = jobSteps.find((step) => step.id === 'admit-current-main');
    const admissionIndex = jobSteps.indexOf(admission);
    const setupIndex = jobSteps.findIndex((step) => step.id === 'setup-node');
    const apply = stepNamed(workflow.jobs.reconcile, 'Reconcile registry-managed Railway configuration');

    assert.ok(checkoutIndex < admissionIndex);
    assert.ok(admissionIndex < setupIndex);
    assert.ok(admissionIndex < jobSteps.indexOf(apply));
    assert.match(admission.run, /git ls-remote --exit-code origin refs\/heads\/main/);
    assert.match(admission.run, /\$GITHUB_SHA.*\$current_main_sha/);
    assert.match(admission.run, /Refusing stale registry sync/);
    assert.equal(admission.env, undefined);
  });

  it('starts a fresh read budget after apply and before Viewer verification', () => {
    const jobSteps = steps(workflow.jobs.reconcile);
    const apply = stepNamed(workflow.jobs.reconcile, 'Reconcile registry-managed Railway configuration');
    const budget = stepNamed(workflow.jobs.reconcile, 'Start Viewer verification budget');
    const verify = stepNamed(workflow.jobs.reconcile, 'Verify live configuration with the Viewer identity');
    assert.ok(jobSteps.indexOf(apply) < jobSteps.indexOf(budget));
    assert.ok(jobSteps.indexOf(budget) < jobSteps.indexOf(verify));
    assert.match(budget.run, /RAILWAY_CONFIG_AUDIT_JOB_STARTED_AT_MS/);
    assert.match(budget.if, /^always\(\)/);
    assert.match(budget.if, /steps\.admit-current-main\.outcome == 'success'/);
  });

  it('calls the guarded runner instead of the audit apply entrypoint', () => {
    const directAuditApply = steps(workflow.jobs.reconcile).filter((step) => (
      typeof step.run === 'string'
      && /node\s+scripts\/audit-railway-watch-paths\.mjs[^\n]*--apply/.test(step.run)
    ));
    assert.deepEqual(directAuditApply, []);
    assert.equal(
      steps(workflow.jobs.reconcile).some((step) => step.name === 'Name the operator sync command'),
      false,
    );
  });

  it('gives repair guidance after any failed reconciliation', () => {
    const summary = stepNamed(workflow.jobs.reconcile, 'Explain a failed reconciliation');
    assert.equal(summary.if, 'failure()');
    assert.match(summary.run, /Stale revision/);
    assert.match(summary.run, /Source branch, check-suite, or required-variable drift/);
    assert.match(summary.run, /GITHUB_STEP_SUMMARY/);
    assert.equal(summary.env, undefined);
  });
});
