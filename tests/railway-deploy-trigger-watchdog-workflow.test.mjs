import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/railway-deploy-trigger-watchdog.yml');
const source = readFileSync(workflowPath, 'utf8');
const workflow = YAML.parse(source);
const dispatchSource = readFileSync(
  resolve(repoRoot, 'scripts/dispatch-stale-railway-reconcile.mjs'),
  'utf8',
);
const target = YAML.parse(readFileSync(
  resolve(repoRoot, '.github/workflows/railway-deploy-trigger.yml'),
  'utf8',
));

describe('Railway deploy trigger watchdog workflow contract', () => {
  it('uses the exact offset cadence, raw-status mode, and an isolated concurrency lane', () => {
    assert.deepEqual(workflow.on.schedule, [{ cron: '8,23,38,53 * * * *' }]);
    assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, 'classify');
    assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, [
      'status', 'classify', 'dispatch',
    ]);
    assert.equal(workflow.concurrency.group, 'railway-deploy-trigger-watchdog');
    assert.notEqual(workflow.concurrency.group, 'railway-deploy-trigger');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
    assert.equal(Object.hasOwn(workflow.on, 'workflow_run'), false);
    const controller = workflow.jobs.classify.steps.find((step) => step.id === 'controller');
    assert.match(controller.env.WATCHDOG_PHASE, /inputs\.mode == 'status'/);
    assert.match(controller.run, /--phase "\$WATCHDOG_PHASE"/);
  });

  it('declares the target dispatch inputs and run-title correlation before cutover', () => {
    const inputs = target.on.workflow_dispatch.inputs;
    assert.equal(inputs.recovery_attempt_id.required, true);
    assert.equal(inputs.recovery_attempt_id.default, 'none');
    assert.equal(inputs.expected_head_sha.required, true);
    assert.match(target['run-name'], /inputs\.recovery_attempt_id/);
    assert.match(target['run-name'], /inputs\.expected_head_sha/);
  });

  it('splits read-only classification, one actions-write dispatch, and watchdog-only bind/reject', () => {
    assert.deepEqual(workflow.permissions, {});
    assert.deepEqual(workflow.jobs.classify.permissions, {
      actions: 'read',
      contents: 'read',
      statuses: 'read',
    });
    assert.deepEqual(workflow.jobs.dispatch.permissions, {
      actions: 'write',
      contents: 'read',
      statuses: 'read',
    });
    assert.deepEqual(workflow.jobs.bind.permissions, { contents: 'read' });
    assert.deepEqual(workflow.jobs.reject.permissions, { contents: 'read' });
    assert.deepEqual(
      Object.entries(workflow.jobs)
        .filter(([, job]) => job.permissions?.actions === 'write')
        .map(([id]) => id),
      ['dispatch'],
    );
  });

  it('fails non-main invocations before every secret-bearing job', () => {
    assert.equal(workflow.jobs.reject_non_main.if, "github.ref != 'refs/heads/main'");
    assert.deepEqual(workflow.jobs.reject_non_main.permissions, {});
    assert.match(workflow.jobs.reject_non_main.steps[0].run, /exit 1/);
    assert.equal(workflow.jobs.classify.if, "github.ref == 'refs/heads/main'");
    const secretJobs = Object.values(workflow.jobs).filter((job) => (
      job.steps?.some((step) => JSON.stringify(step.env ?? {}).includes('secrets.'))
    ));
    assert.deepEqual(secretJobs.map((job) => job.environment?.name), [
      'ingestion-acceptance-production-watchdog',
      'ingestion-acceptance-production-watchdog',
      'ingestion-acceptance-production-watchdog',
    ]);
  });

  it('runs one shared GitHub-only dispatcher from the exact authorized head', () => {
    const dispatch = workflow.jobs.dispatch;
    const checkout = dispatch.steps[0];
    assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
    assert.equal(checkout.with.ref, '${{ needs.classify.outputs.expected_head_sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
    const step = dispatch.steps[1];
    assert.equal(step.name, 'Dispatch exact Railway deploy-trigger run');
    assert.equal(step.id, 'dispatch');
    assert.match(step.run, /dispatch-stale-railway-reconcile\.mjs/);
    assert.match(step.run, /--phase dispatch/);
    assert.equal(step.env.GH_TOKEN, '${{ github.token }}');
    const dispatchJson = JSON.stringify(dispatch);
    assert.doesNotMatch(dispatchJson, /secrets\.|WATCHDOG_HMAC|CONTROL_URL|environment|RAILWAY_TOKEN/);
    assert.equal(dispatch.outputs.workflow_run_id, '${{ steps.dispatch.outputs.workflow_run_id }}');
    assert.equal(dispatch.outputs.run_attempt, '${{ steps.dispatch.outputs.run_attempt }}');
    assert.equal(dispatch.outputs.rejection, '${{ steps.dispatch.outputs.rejection }}');
  });

  it('keeps the live dispatcher bounded, non-retried, one-POST, and exact-run verified', () => {
    assert.match(dispatchSource, /GITHUB_API_VERSION = '2026-03-10'/);
    assert.match(dispatchSource, /WATCHDOG_REQUEST_TIMEOUT_MS = 10_000/);
    assert.match(dispatchSource, /function dispatchGitHubRecovery/);
    assert.match(dispatchSource, /github\.dispatchRecovery/);
    assert.match(dispatchSource, /github\.readDispatchedRunIdentity/);
    assert.match(dispatchSource, /GITHUB_DISPATCH_REJECTED/);
    assert.doesNotMatch(dispatchSource, /--retry/);
    const requestCalls = dispatchSource.match(/await github\.dispatchRecovery/g) ?? [];
    assert.equal(requestCalls.length, 1);
  });

  it('closes only definitive outcomes in a separate watchdog-capability job', () => {
    assert.match(workflow.jobs.reject.if, /PRE_DISPATCH_NOT_STARTED/);
    assert.match(workflow.jobs.reject.if, /DISPATCH_CONFIRMED_REJECTED/);
    assert.match(workflow.jobs.reject.if, /needs\.dispatch\.result == 'success'/);
    const close = workflow.jobs.reject.steps.find((step) => step.name === 'Close the exact durable dispatch hold');
    assert.equal(
      close.env.RAILWAY_RECONCILE_WATCHDOG_HMAC,
      '${{ secrets.RAILWAY_RECONCILE_WATCHDOG_HMAC }}',
    );
    assert.equal(close.env.REJECTION, '${{ needs.dispatch.outputs.rejection }}');
    assert.match(close.run, /--phase reject/);
    assert.match(workflow.jobs.reject.steps.at(-1).run, /exit 1/);
    assert.match(workflow.jobs.bind.if, /RECOVERY_DISPATCH_ACCEPTED/);
  });

  it('keeps activation fail-closed and contains no Railway mutation or cancellation capability', () => {
    const controller = workflow.jobs.classify.steps.find((step) => step.id === 'controller');
    assert.match(controller.env.AUTO_RECOVERY_ENABLED, /RAILWAY_RECONCILE_AUTO_RECOVERY_ENABLED == 'true'/);
    assert.match(controller.env.AUTO_RECOVERY_ENABLED, /RAILWAY_RECONCILE_CUTOVER_ACTIVE == 'true'/);
    assert.match(controller.env.AUTO_RECOVERY_ENABLED, /inputs\.mode == 'dispatch'/);
    for (const forbidden of [
      'RAILWAY_TOKEN',
      'RAILWAY_RECONCILE_DEPLOY_TOKEN',
      'RAILWAY_RECONCILE_MUTATION',
      'RAILWAY_RECONCILE_VERIFIER',
      'RAILWAY_RECONCILE_OPERATOR',
      '/cancel',
      'force-cancel',
      '/rerun',
    ]) {
      assert.ok(!source.includes(forbidden), `workflow must not contain ${forbidden}`);
    }
  });
});
