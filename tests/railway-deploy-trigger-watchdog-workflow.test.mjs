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

describe('Railway deploy trigger watchdog workflow contract', () => {
  it('uses the exact offset cadence, manual classification default, and an isolated concurrency lane', () => {
    assert.deepEqual(workflow.on.schedule, [{ cron: '8,23,38,53 * * * *' }]);
    assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, 'classify');
    assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, ['classify', 'dispatch']);
    assert.equal(workflow.concurrency.group, 'railway-deploy-trigger-watchdog');
    assert.notEqual(workflow.concurrency.group, 'railway-deploy-trigger');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
    assert.equal(workflow.jobs.classify.outputs.prior_id, '${{ steps.controller.outputs.prior_id }}');
    assert.equal(Object.hasOwn(workflow.on, 'workflow_run'), false);
  });

  it('splits read-only classification, isolated actions-write dispatch, and no-actions-write binding', () => {
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
    assert.equal(workflow.jobs.classify.permissions.actions, 'read');
    assert.equal(workflow.jobs.bind.permissions.actions, undefined);
    assert.equal(
      workflow.jobs.dispatch.if,
      "github.ref == 'refs/heads/main' && github.run_attempt == 1 && needs.classify.outputs.dispatch_authorized == 'true' && vars.RAILWAY_RECONCILE_CUTOVER_ACTIVE == 'true'",
    );
    assert.deepEqual(workflow.jobs.classify.environment, {
      name: 'ingestion-acceptance-production-watchdog',
      deployment: false,
    });
    assert.equal(workflow.jobs.dispatch.environment, undefined);
    assert.deepEqual(workflow.jobs.bind.environment, {
      name: 'ingestion-acceptance-production-watchdog',
      deployment: false,
    });
    assert.deepEqual(
      Object.entries(workflow.jobs)
        .filter(([, job]) => job.permissions?.actions === 'write')
        .map(([id]) => id),
      ['dispatch'],
    );
  });

  it('fails non-main invocations before any secret-bearing job can start', () => {
    const rejection = workflow.jobs.reject_non_main;
    assert.equal(rejection.if, "github.ref != 'refs/heads/main'");
    assert.deepEqual(rejection.permissions, {});
    assert.match(rejection.steps[0].run, /exit 1/);
    assert.equal(workflow.jobs.classify.if, "github.ref == 'refs/heads/main'");

    const secretJobs = Object.values(workflow.jobs).filter((job) => (
      job.steps?.some((step) => JSON.stringify(step.env ?? {}).includes('secrets.'))
    ));
    assert.deepEqual(secretJobs.map((job) => job.environment?.name), [
      'ingestion-acceptance-production-watchdog',
      'ingestion-acceptance-production-watchdog',
    ]);
  });

  it('pins exact-SHA checkouts outside the write-capable job and persists no credentials', () => {
    const classifierUses = workflow.jobs.classify.steps.filter((step) => step.uses);
    assert.equal(classifierUses.length, 1);
    assert.match(classifierUses[0].uses, /^actions\/checkout@[0-9a-f]{40}$/);
    assert.equal(classifierUses[0].with['persist-credentials'], false);
    assert.equal(classifierUses[0].with.ref, 'refs/heads/main');

    const bindUses = workflow.jobs.bind.steps.filter((step) => step.uses);
    assert.equal(bindUses.length, 1);
    assert.match(bindUses[0].uses, /^actions\/checkout@[0-9a-f]{40}$/);
    assert.equal(bindUses[0].with['persist-credentials'], false);
    assert.equal(bindUses[0].with.ref, '${{ needs.classify.outputs.expected_head_sha }}');
    assert.ok(workflow.jobs.dispatch.steps.every((step) => step.uses === undefined));
  });

  it('isolates all control secrets from the actions-write job', () => {
    const dispatchJson = JSON.stringify(workflow.jobs.dispatch);
    assert.doesNotMatch(dispatchJson, /secrets\.|WATCHDOG_HMAC|CONTROL_URL|environment/);
    assert.doesNotMatch(dispatchJson, /actions\/checkout|"uses":/);

    const bindJson = JSON.stringify(workflow.jobs.bind);
    const bindSecretReferences = [...bindJson.matchAll(/\$\{\{ secrets\.([^ }]+) \}\}/g)]
      .map((match) => match[1]);
    assert.deepEqual(bindSecretReferences, ['RAILWAY_RECONCILE_WATCHDOG_HMAC']);
    assert.equal(workflow.jobs.bind.steps.at(-1).env.GH_TOKEN, undefined);
  });

  it('uses bounded exact preflight, one non-retried 2026-03-10 POST, and exact returned-run proof', () => {
    assert.equal(workflow.jobs.dispatch.steps.length, 3);
    const [preflight, dispatch, verify] = workflow.jobs.dispatch.steps;
    assert.equal(preflight.name, 'Revalidate exact main and green gate');
    assert.deepEqual(Object.keys(preflight.env).sort(), ['EXPECTED_HEAD_SHA', 'GH_TOKEN']);
    assert.match(preflight.run, /git\/ref\/heads\/main/);
    assert.match(preflight.run, /commits\/\$EXPECTED_HEAD_SHA\/status/);
    assert.match(preflight.run, /context == "gate"/);
    assert.match(preflight.run, /--connect-timeout 5/);
    assert.match(preflight.run, /--max-time 15/);
    assert.doesNotMatch(preflight.run, /--retry/);

    assert.equal(dispatch.name, 'Dispatch exact Railway deploy-trigger run');
    assert.equal(dispatch.id, 'dispatch');
    assert.equal(dispatch.env.GH_TOKEN, '${{ github.token }}');
    assert.match(dispatch.run, /--request POST/);
    assert.match(dispatch.run, /return_run_details:true/);
    assert.match(dispatch.run, /X-GitHub-Api-Version: 2026-03-10/);
    assert.match(dispatch.run, /railway-deploy-trigger\.yml\/dispatches/);
    assert.match(dispatch.run, /workflow_run_id/);
    assert.match(dispatch.run, /dispatched_workflow_run_id=\$workflow_run_id/);
    assert.match(dispatch.run, /--connect-timeout 5/);
    assert.match(dispatch.run, /--max-time 15/);
    assert.doesNotMatch(dispatch.run, /--retry/);

    assert.equal(verify.name, 'Verify exact dispatched Railway run');
    assert.equal(verify.id, 'verify');
    assert.equal(verify.env.WORKFLOW_RUN_ID, '${{ steps.dispatch.outputs.dispatched_workflow_run_id }}');
    assert.match(verify.run, /actions\/runs\/\$WORKFLOW_RUN_ID/);
    assert.match(verify.run, /workflow_dispatch/);
    assert.match(verify.run, /head_branch == "main"/);
    assert.match(verify.run, /head_sha == \$expected_head/);
    assert.match(verify.run, /run_attempt == 1/);
    assert.match(verify.run, /railway-deploy-trigger\.yml/);
    assert.match(verify.run, /workflow_run_id=\$WORKFLOW_RUN_ID/);
    assert.match(verify.run, /run_attempt=1/);
    assert.doesNotMatch(verify.run, /--retry/);
    assert.equal(workflow.jobs.dispatch.outputs.workflow_run_id, '${{ steps.verify.outputs.workflow_run_id }}');
    assert.equal(workflow.jobs.dispatch.outputs.run_attempt, '${{ steps.verify.outputs.run_attempt }}');
  });

  it('never repeats the dispatch POST on a workflow rerun', () => {
    assert.match(workflow.jobs.dispatch.if, /github\.run_attempt == 1/);
    assert.doesNotMatch(workflow.jobs.bind.if, /github\.run_attempt == 1/);
  });

  it('binds the exact returned run attempt with only the watchdog capability', () => {
    const bind = workflow.jobs.bind.steps.at(-1);
    assert.equal(
      bind.env.RAILWAY_RECONCILE_WATCHDOG_HMAC,
      '${{ secrets.RAILWAY_RECONCILE_WATCHDOG_HMAC }}',
    );
    assert.equal(bind.env.WORKFLOW_RUN_ID, '${{ needs.dispatch.outputs.workflow_run_id }}');
    assert.equal(bind.env.RUN_ATTEMPT, '${{ needs.dispatch.outputs.run_attempt }}');
    assert.match(bind.run, /--phase bind/);
    assert.match(bind.run, /--workflow-run-id/);
    assert.match(bind.run, /--run-attempt/);
  });

  it('keeps activation fail-closed and gives the classifier only watchdog control capability', () => {
    const controller = workflow.jobs.classify.steps.find((step) => step.id === 'controller');
    assert.match(controller.env.AUTO_RECOVERY_ENABLED, /RAILWAY_RECONCILE_AUTO_RECOVERY_ENABLED == 'true'/);
    assert.match(controller.env.AUTO_RECOVERY_ENABLED, /RAILWAY_RECONCILE_CUTOVER_ACTIVE == 'true'/);
    assert.match(controller.env.AUTO_RECOVERY_ENABLED, /inputs\.mode == 'dispatch'/);
    assert.match(controller.run, /--phase classify/);
    assert.match(controller.run, /--auto-recovery-enabled/);
    assert.equal(controller.env.RAILWAY_RECONCILE_WATCHDOG_HMAC, '${{ secrets.RAILWAY_RECONCILE_WATCHDOG_HMAC }}');
  });

  it('contains no Railway, mutation, verifier, operator, review, cancellation, or rerun capability', () => {
    for (const forbidden of [
      'RAILWAY_TOKEN',
      'RAILWAY_RECONCILE_DEPLOY_TOKEN',
      'RAILWAY_RECONCILE_MUTATION',
      'RAILWAY_RECONCILE_VERIFIER',
      'RAILWAY_RECONCILE_OPERATOR',
      '/cancel',
      'force-cancel',
      '/rerun',
      'pending_deployments',
      'review_pending_deployments',
    ]) {
      assert.ok(!source.includes(forbidden), `workflow must not contain ${forbidden}`);
    }
  });
});
