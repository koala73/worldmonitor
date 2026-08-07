import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/railway-reconcile-manual-recovery.yml');
const source = readFileSync(workflowPath, 'utf8');
const workflow = YAML.parse(source);

function allSecretNames(job) {
  const text = JSON.stringify(job);
  return [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
}

function assertBashSyntax(script) {
  const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

describe('Railway reconciliation protected manual recovery workflow', () => {
  it('is workflow_dispatch-only with required typed closed-decision inputs', () => {
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    const inputs = workflow.on.workflow_dispatch.inputs;
    assert.deepEqual(Object.keys(inputs), [
      'decision', 'prior_id', 'expected_current_head', 'approver', 'reason', 'evidence_json',
    ]);
    for (const input of Object.values(inputs)) assert.equal(input.required, true);
    assert.equal(inputs.decision.type, 'choice');
    assert.deepEqual(inputs.decision.options, [
      'resolve_pre_mutation_hold',
      'accept_observed_convergence',
      'authorize_current_main_retry',
    ]);
    for (const name of ['prior_id', 'expected_current_head', 'approver', 'reason', 'evidence_json']) {
      assert.equal(inputs[name].type, 'string');
    }
  });

  it('uses the distinct break-glass environment and treats reviewer identity as an external provisioning gate', () => {
    assert.equal(workflow.jobs.resolve.environment.name, 'ingestion-acceptance-production-breakglass');
    assert.equal(workflow.jobs.resolve.environment.deployment, false);
    assert.match(source, /EXTERNAL/);
    assert.match(source, /PROVISIONING GATE/);
    assert.match(source, /prevent-self-review/);
    assert.match(source, /reviewer identity\/evidence/);
    assert.match(source, /approver input is an audit assertion/);
    assert.match(source, /not a claim that YAML discovered the live reviewer/);
  });

  it('rejects non-main dispatches before secrets and checks out exact main for both proof passes', () => {
    assert.deepEqual(workflow.jobs.reject_non_main.permissions, {});
    assert.equal(workflow.jobs.reject_non_main.if, "github.ref != 'refs/heads/main'");
    assert.match(workflow.jobs.reject_non_main.steps[0].run, /exit 1/);
    assert.equal(workflow.jobs.proof.if, "github.ref == 'refs/heads/main'");
    assert.equal(workflow.jobs.resolve.if, "github.ref == 'refs/heads/main'");
    assert.match(workflow.jobs['dispatch-retry'].if, /github\.ref == 'refs\/heads\/main'/);
    assert.match(workflow.jobs['bind-dispatched-run'].if, /github\.ref == 'refs\/heads\/main'/);
    for (const name of ['proof', 'resolve']) {
      const checkout = workflow.jobs[name].steps.find((step) => step.uses?.startsWith('actions/checkout@'));
      assert.equal(checkout.with.ref, 'refs/heads/main');
      assert.equal(checkout.with['fetch-depth'], 0);
      assert.equal(checkout.with.filter, 'blob:none');
      assert.equal(checkout.with['persist-credentials'], false);
    }
  });

  it('keeps mutation credentials out while refreshing Viewer proof and isolating watchdog binding', () => {
    assert.deepEqual(new Set(allSecretNames(workflow.jobs.proof)), new Set([
      'RAILWAY_RECONCILE_VIEWER_TOKEN',
    ]));
    assert.deepEqual(new Set(allSecretNames(workflow.jobs.resolve)), new Set([
      'RAILWAY_RECONCILE_VIEWER_TOKEN',
      'RAILWAY_RECONCILE_OPERATOR_HMAC',
    ]));
    assert.deepEqual(allSecretNames(workflow.jobs['dispatch-retry']), []);
    assert.deepEqual(allSecretNames(workflow.jobs['bind-dispatched-run']), [
      'RAILWAY_RECONCILE_WATCHDOG_HMAC',
    ]);

    const proofText = JSON.stringify(workflow.jobs.proof);
    assert.doesNotMatch(proofText, /DEPLOY_TOKEN|OPERATOR_HMAC/);
    const resolverText = JSON.stringify(workflow.jobs.resolve);
    assert.match(resolverText, /RAILWAY_RECONCILE_VIEWER_TOKEN/);
    assert.doesNotMatch(resolverText, /DEPLOY_TOKEN|VERIFIER_HMAC|WATCHDOG_HMAC/);
    const dispatchText = JSON.stringify(workflow.jobs['dispatch-retry']);
    assert.doesNotMatch(dispatchText, /RAILWAY_TOKEN|HMAC|secrets\./);
    const bindingText = JSON.stringify(workflow.jobs['bind-dispatched-run']);
    assert.doesNotMatch(bindingText, /DEPLOY_TOKEN|MUTATION_HMAC|VERIFIER_HMAC|OPERATOR_HMAC/);
  });

  it('cannot authorize a retry until the lease-aware target cutover is active', () => {
    const guard = workflow.jobs.proof.steps.find(
      (step) => step.name === 'Reject retry authorization before lease-aware cutover',
    );
    assert.match(guard.if, /authorize_current_main_retry/);
    assert.match(guard.if, /RAILWAY_RECONCILE_CUTOVER_ACTIVE != 'true'/);
    assert.match(guard.run, /exit 1/);
    assert.match(workflow.jobs['dispatch-retry'].if, /RAILWAY_RECONCILE_CUTOVER_ACTIVE == 'true'/);
  });

  it('confines actions:write to one bounded, non-retried dispatch that outputs the exact GitHub run', () => {
    assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read', statuses: 'read' });
    assert.deepEqual(workflow.jobs.proof.permissions, { contents: 'read', actions: 'read', statuses: 'read' });
    assert.deepEqual(workflow.jobs.resolve.permissions, { contents: 'read', actions: 'read', statuses: 'read' });
    assert.deepEqual(workflow.jobs['dispatch-retry'].permissions, {
      actions: 'write',
      contents: 'read',
      statuses: 'read',
    });
    assert.equal(workflow.jobs['dispatch-retry'].steps.length, 3);
    assert.deepEqual(workflow.jobs['dispatch-retry'].outputs, {
      workflow_run_id: '${{ steps.verify.outputs.workflow_run_id }}',
      run_attempt: '${{ steps.verify.outputs.run_attempt }}',
    });
    const [preflight, dispatch, verify] = workflow.jobs['dispatch-retry'].steps;
    assert.equal(preflight.name, 'Revalidate exact main and green gate');
    assert.match(preflight.run, /git\/ref\/heads\/main/);
    assert.match(preflight.run, /commits\/\$EXPECTED_HEAD\/status/);
    assert.match(preflight.run, /context == "gate"/);
    assert.doesNotMatch(preflight.run, /--retry/);
    assertBashSyntax(preflight.run);

    assert.equal(dispatch.id, 'dispatch');
    assert.equal(dispatch.uses, undefined);
    assert.match(dispatch.run, /railway-deploy-trigger\.yml\/dispatches/);
    assert.match(dispatch.run, /recovery_attempt_id/);
    assert.match(dispatch.run, /expected_head_sha/);
    assert.match(dispatch.run, /return_run_details:true/);
    assert.match(dispatch.run, /X-GitHub-Api-Version: 2026-03-10/);
    assert.match(dispatch.run, /--connect-timeout\s+\d+/);
    assert.match(dispatch.run, /--max-time\s+\d+/);
    assert.equal((dispatch.run.match(/--request POST/g) ?? []).length, 1);
    assert.doesNotMatch(dispatch.run, /--retry(?:\s|$)/);
    assert.match(dispatch.run, /\.workflow_run_id/);
    assert.match(dispatch.run, /dispatched_workflow_run_id=\$workflow_run_id/);
    assert.match(dispatch.run, /GITHUB_OUTPUT/);
    assert.match(dispatch.run, /durable hold remains unresolved/);
    assert.doesNotMatch(dispatch.run, /expected_head:/);
    assert.doesNotMatch(dispatch.run, /bindRun|bind-run|dispatch-rejected/);
    assertBashSyntax(dispatch.run);

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
    assertBashSyntax(verify.run);
  });

  it('never repeats the dispatch POST on a workflow rerun', () => {
    assert.match(workflow.jobs['dispatch-retry'].if, /github\.run_attempt == 1/);
    assert.doesNotMatch(workflow.jobs['bind-dispatched-run'].if, /github\.run_attempt == 1/);
  });

  it('binds only the returned run and attempt from a separate credential-isolated watchdog job', () => {
    const binding = workflow.jobs['bind-dispatched-run'];
    assert.deepEqual(binding.needs, ['resolve', 'dispatch-retry']);
    assert.deepEqual(binding.environment, {
      name: 'ingestion-acceptance-production-watchdog',
      deployment: false,
    });
    assert.deepEqual(binding.permissions, { contents: 'read' });
    assert.equal(binding.permissions.actions, undefined);
    const checkout = binding.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ needs.resolve.outputs.expected_head }}');
    assert.equal(checkout.with['persist-credentials'], false);
    const bind = binding.steps.find((step) => step.name === 'Bind exact dispatched run to durable hold');
    assert.equal(bind.env.RAILWAY_RECONCILE_CONTROL_URL, '${{ vars.RAILWAY_RECONCILE_CONTROL_URL }}');
    assert.equal(
      bind.env.RAILWAY_RECONCILE_WATCHDOG_HMAC,
      '${{ secrets.RAILWAY_RECONCILE_WATCHDOG_HMAC }}',
    );
    assert.equal(bind.env.WORKFLOW_RUN_ID, '${{ needs.dispatch-retry.outputs.workflow_run_id }}');
    assert.equal(bind.env.RUN_ATTEMPT, '${{ needs.dispatch-retry.outputs.run_attempt }}');
    assert.equal(bind.env.RECOVERY_ATTEMPT_ID, '${{ needs.resolve.outputs.recovery_attempt_id }}');
    assert.equal(bind.env.EXPECTED_HEAD, '${{ needs.resolve.outputs.expected_head }}');
    assert.match(bind.run, /RailwayReconcileControlClient/);
    assert.match(bind.run, /client\.bindRun\(/);
    assert.match(bind.run, /runId:\s*process\.env\.WORKFLOW_RUN_ID/);
    assert.match(bind.run, /runAttempt,/);
    assert.match(bind.run, /DISPATCH_RUN_BOUND/);
    assert.match(bind.run, /RUN_BOUND/);
    assertBashSyntax(bind.run);
  });

  it('records actor/run/environment/reason evidence and calls no Railway mutation', () => {
    const resolver = workflow.jobs.resolve.steps.find((step) => step.id === 'resolve');
    assert.equal(resolver.env.GITHUB_TRIGGERING_ACTOR, '${{ github.triggering_actor }}');
    assert.equal(resolver.env.RECOVERY_ACTOR, '${{ github.actor }}');
    assert.equal(resolver.env.RECOVERY_APPROVER, '${{ inputs.approver }}');
    assert.equal(resolver.env.RECOVERY_REASON, '${{ inputs.reason }}');
    assert.equal(resolver.env.RECOVERY_EVIDENCE_JSON, '${{ inputs.evidence_json }}');
    assert.match(resolver.run, /resolve-railway-reconcile-control\.mjs resolve/);
    assert.doesNotMatch(source, /serviceInstanceDeploy|trigger-railway-deploys|railway\s+(?:up|redeploy)/i);
    assert.doesNotMatch(source, /RAILWAY_RECONCILE_DEPLOY_TOKEN/);
    const resolverSource = readFileSync(
      resolve(repoRoot, 'scripts/resolve-railway-reconcile-control.mjs'),
      'utf8',
    );
    assert.doesNotMatch(resolverSource, /serviceInstanceDeploy|trigger-railway-deploys|\.acquire\(|\.startMutation\(/);
    assert.match(resolverSource, /role:\s*'operator'/);
    assert.match(resolverSource, /controlClient\.resolve\(/);
  });

  it('keeps the operator secret out of every ordinary target and watchdog workflow', () => {
    const workflowDir = resolve(repoRoot, '.github/workflows');
    const ordinary = readdirSync(workflowDir).filter((name) => (
      name === 'railway-deploy-trigger.yml' || /railway-deploy-trigger-watchdog\.ya?ml$/.test(name)
    ));
    assert.ok(ordinary.includes('railway-deploy-trigger.yml'));
    for (const name of ordinary) {
      const text = readFileSync(resolve(workflowDir, name), 'utf8');
      assert.doesNotMatch(text, /RAILWAY_RECONCILE_OPERATOR_HMAC|OPERATOR_HMAC_SECRET/, name);
    }
  });

  it('pins every third-party action to a full commit SHA', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses) assert.match(step.uses, /^[^@]+@[0-9a-f]{40}$/i, step.uses);
      }
    }
  });
});
