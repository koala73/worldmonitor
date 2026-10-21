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

  it('uses the distinct break-glass secret boundary without a self-review gate', () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    assert.equal(workflow.jobs.resolve.environment.name, 'ingestion-acceptance-production-breakglass');
    assert.equal(workflow.jobs.resolve.environment.deployment, false);
    assert.equal(
      inputs.approver.description,
      'Operator audit identity; may equal the GitHub actor',
    );
    assert.match(source, /main-only secret boundary/);
    assert.match(source, /no required reviewer/);
    assert.match(source, /self-review adds no independent authorization/);
    assert.match(source, /exact-main and repeated provider-inactivity proof/);
    assert.match(source, /controller CAS\/generation checks/);
    assert.doesNotMatch(source, /EXTERNAL PROVISIONING GATE/);
    assert.doesNotMatch(source, /prevent-self-review/);
    assert.doesNotMatch(source, /reviewer identity\/evidence/);
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
    assert.deepEqual(allSecretNames(workflow.jobs['reject-dispatched-run']), [
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

  it('confines actions:write to one shared GitHub-only dispatcher with exact outputs', () => {
    assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read', statuses: 'read' });
    assert.deepEqual(workflow.jobs.proof.permissions, { contents: 'read', actions: 'read', statuses: 'read' });
    assert.deepEqual(workflow.jobs.resolve.permissions, { contents: 'read', actions: 'read', statuses: 'read' });
    const job = workflow.jobs['dispatch-retry'];
    assert.deepEqual(job.permissions, {
      actions: 'write',
      contents: 'read',
      statuses: 'read',
    });
    assert.equal(job.steps.length, 4);
    assert.deepEqual(job.outputs, {
      outcome: '${{ steps.dispatch.outputs.outcome }}',
      workflow_run_id: '${{ steps.dispatch.outputs.workflow_run_id }}',
      run_attempt: '${{ steps.dispatch.outputs.run_attempt }}',
      rejection: '${{ steps.dispatch.outputs.rejection }}',
    });
    const [checkout, dispatch] = job.steps;
    assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
    assert.equal(checkout.with.ref, '${{ needs.resolve.outputs.expected_head }}');
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(dispatch.id, 'dispatch');
    assert.match(dispatch.run, /dispatch-stale-railway-reconcile\.mjs/);
    assert.match(dispatch.run, /--phase dispatch/);
    assert.equal(dispatch.env.GH_TOKEN, '${{ github.token }}');
    assert.doesNotMatch(JSON.stringify(job), /RAILWAY_TOKEN|HMAC|secrets\.|CONTROL_URL/);
  });

  it('closes definitive retry rejection in the isolated watchdog-capability job', () => {
    const rejection = workflow.jobs['reject-dispatched-run'];
    assert.match(rejection.if, /PRE_DISPATCH_NOT_STARTED/);
    assert.match(rejection.if, /DISPATCH_CONFIRMED_REJECTED/);
    assert.deepEqual(rejection.permissions, { contents: 'read' });
    assert.equal(rejection.environment.name, 'ingestion-acceptance-production-watchdog');
    const close = rejection.steps.find((step) => step.name === 'Close the exact durable dispatch hold');
    assert.equal(close.env.REJECTION, '${{ needs.dispatch-retry.outputs.rejection }}');
    assert.equal(
      close.env.RAILWAY_RECONCILE_WATCHDOG_HMAC,
      '${{ secrets.RAILWAY_RECONCILE_WATCHDOG_HMAC }}',
    );
    assert.match(close.run, /--phase reject/);
    assert.match(rejection.steps.at(-1).run, /exit 1/);
  });

  it('builds fresh authorization proof after protected approval and scrubs the operator secret', () => {
    const resolver = workflow.jobs.resolve.steps.find((step) => step.id === 'resolve');
    assert.equal(resolver.env.RECOVERY_PROOF, undefined);
    const resolverSource = readFileSync(
      resolve(repoRoot, 'scripts/resolve-railway-reconcile-control.mjs'),
      'utf8',
    );
    const deleteOffset = resolverSource.indexOf('delete process.env.RAILWAY_RECONCILE_OPERATOR_HMAC');
    const proofOffset = resolverSource.lastIndexOf('const proof = await buildRecoveryProof');
    assert.ok(deleteOffset >= 0 && deleteOffset < proofOffset);
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
