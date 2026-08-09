import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import {
  MUTATION_BOUNDARY_FALLBACK_STEP_NAMES,
  MUTATION_BOUNDARY_STEP_NAMES,
} from '../scripts/resolve-railway-reconcile-control.mjs';
import { MUTATION_JOB_BUDGET_MS } from '../workers/railway-reconcile-control/src/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/railway-deploy-trigger.yml');
const source = readFileSync(workflowPath, 'utf8');
const workflow = YAML.parse(source);

function job(name) {
  const value = workflow.jobs?.[name];
  assert.ok(value, `Railway deploy trigger must define the ${name} job`);
  return value;
}

function stepNamed(jobName, name) {
  const step = job(jobName).steps?.find((candidate) => candidate.name === name);
  assert.ok(step, `${jobName} must define "${name}"`);
  return step;
}

function referencedSecrets(jobName) {
  return [...JSON.stringify(job(jobName)).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
}

describe('Railway deploy trigger lease-aware workflow', () => {
  it('emits a mutation step recognized by protected pre-mutation recovery', () => {
    const recognized = job('mutation').steps.filter(
      (step) => MUTATION_BOUNDARY_STEP_NAMES.includes(step.name),
    );
    assert.deepEqual(recognized.map((step) => step.name), [
      'Mark Railway mutation started',
      'Record manual-required reconciliation state',
    ]);
    const fallback = job('mutation').steps.filter(
      (step) => MUTATION_BOUNDARY_FALLBACK_STEP_NAMES.includes(step.name),
    );
    assert.deepEqual(fallback.map((step) => step.name), [
      'Trigger lease-fenced deploys for the exact green head',
    ]);
    const evidence = stepNamed('mutation', 'Record immutable result evidence');
    assert.match(evidence.run, /MUTATION_COMPLETED\)/);
    assert.match(evidence.run, /MUTATION_PARTIAL\|MUTATION_AMBIGUOUS\|MUTATION_FAILED\)/);
    assert.match(evidence.run, /mutation_started=true/);
    assert.match(evidence.run, /manual_required=true/);
    assert.match(
      String(stepNamed('mutation', 'Mark Railway mutation started').if),
      /evidence\.outputs\.mutation_started == 'true'/,
    );
    assert.match(
      String(stepNamed('mutation', 'Record manual-required reconciliation state').if),
      /evidence\.outputs\.manual_required == 'true'/,
    );
  });

  it('removes workflow-level production concurrency and makes only admission cancel-safe', () => {
    assert.equal(workflow.concurrency, undefined);
    assert.equal(job('admission').concurrency?.['cancel-in-progress'], true);
    assert.match(job('admission').concurrency.group, /normal/);
    assert.match(job('admission').concurrency.group, /recovery/);
    assert.match(job('admission').concurrency.group, /preview/);
    for (const name of ['preview', 'mutation', 'verifier', 'liveness']) {
      assert.equal(job(name).concurrency, undefined, `${name} must not own a GitHub production lock`);
    }
  });

  it('keeps admission runner-backed but free of every production capability', () => {
    const admission = job('admission');
    assert.equal(admission.environment, undefined);
    assert.deepEqual(referencedSecrets('admission'), []);
    const text = JSON.stringify(admission);
    assert.doesNotMatch(text, /RAILWAY_TOKEN|RAILWAY_RECONCILE_CONTROL_URL|serviceInstanceDeploy|trigger-railway-deploys/);
    const resolveStep = stepNamed('admission', 'Resolve exact current green main');
    assert.match(resolveStep.run, /git\/ref\/heads\/main/);
    assert.match(resolveStep.run, /context == "gate"/);
    assert.match(resolveStep.run, /REQUESTED_HEAD.*head_sha/s);
  });

  it('correlates watchdog dispatch before a runner through required inputs and run-name', () => {
    const dispatch = workflow.on?.workflow_dispatch?.inputs;
    assert.equal(dispatch?.recovery_attempt_id?.required, true);
    assert.equal(dispatch?.expected_head_sha?.required, true);
    assert.match(workflow['run-name'], /recovery_attempt_id/);
    assert.match(workflow['run-name'], /expected_head_sha/);
    assert.match(stepNamed('mutation', 'Trigger lease-fenced deploys for the exact green head').run, /--recovery-attempt-id/);
  });

  it('preserves event-driven reconciliation with only an hourly offset backstop', () => {
    assert.deepEqual(workflow.on?.workflow_run?.workflows, ['Deploy Gate']);
    assert.deepEqual(workflow.on?.workflow_run?.types, ['completed']);
    assert.deepEqual(workflow.on?.workflow_run?.branches, ['main']);
    assert.deepEqual(workflow.on?.schedule, [{ cron: '37 * * * *' }]);
    const freshness = YAML.parse(readFileSync(
      resolve(repoRoot, '.github/workflows/seed-freshness-monitor.yml'),
      'utf8',
    ));
    const freshnessMinutes = new Set((freshness.on?.schedule ?? []).flatMap(({ cron }) => {
      const minute = cron.split(' ')[0];
      const step = /^\*\/(\d+)$/.exec(minute);
      if (step) return Array.from({ length: 60 / Number(step[1]) }, (_, index) => index * Number(step[1]));
      return minute.split(',').map(Number);
    }));
    assert.equal(freshnessMinutes.has(37), false);
  });

  it('keeps dry-run isolated, explicit, read-only, and lease-free', () => {
    assert.match(String(job('preview').if), /dry_run == 'true'/);
    assert.deepEqual(referencedSecrets('preview'), ['RAILWAY_RECONCILE_VIEWER_TOKEN']);
    const preview = stepNamed('preview', 'Preview what would be deployed');
    assert.match(preview.run, /--dry-run/);
    assert.doesNotMatch(JSON.stringify(job('preview')), /MUTATION_HMAC|DEPLOY_TOKEN_V2|--workflow-authorized/);
  });

  it('bounds protected mutation at 13 minutes behind exact cutover and green admission', () => {
    const mutation = job('mutation');
    assert.equal(mutation['timeout-minutes'], 13);
    assert.equal(mutation['timeout-minutes'] * 60 * 1_000, MUTATION_JOB_BUDGET_MS);
    assert.equal(mutation.environment?.name, 'ingestion-acceptance-production');
    assert.match(String(mutation.if), /eligible == 'true'/);
    assert.match(String(mutation.if), /RAILWAY_RECONCILE_CUTOVER_ACTIVE == 'true'/);
    assert.deepEqual(referencedSecrets('mutation').sort(), [
      'RAILWAY_RECONCILE_DEPLOY_TOKEN_V2',
      'RAILWAY_RECONCILE_MUTATION_HMAC',
    ]);
    const mutate = stepNamed('mutation', 'Trigger lease-fenced deploys for the exact green head');
    assert.equal(mutate.env.RAILWAY_TOKEN, '${{ secrets.RAILWAY_RECONCILE_DEPLOY_TOKEN_V2 }}');
    assert.match(mutate.run, /--workflow-authorized/);
    assert.match(mutate.run, /--result-manifest/);
    assert.match(mutate.run, /--status-file/);
    assert.match(mutate.run, /command_status=\$\?/);
    assert.match(mutate.run, /command_status=\$command_status/);
    assert.doesNotMatch(JSON.stringify(mutation), /RAILWAY_PRODUCTION_TOKEN/);
    assert.doesNotMatch(JSON.stringify(mutation), /npm install --global @railway\/cli/);
  });

  it('checks out the exact admitted SHA and never persists checkout credentials', () => {
    for (const name of ['preview', 'mutation', 'verifier', 'liveness']) {
      const checkout = job(name).steps.find((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
      assert.ok(checkout, `${name} must check out the admitted head`);
      assert.equal(checkout.with.ref, '${{ needs.admission.outputs.head_sha }}');
      assert.equal(checkout.with['fetch-depth'], 0);
      assert.equal(checkout.with.filter, 'blob:none');
      assert.equal(checkout.with['persist-credentials'], false);
    }
  });

  it('publishes evidence even after mutation failure and transfers it through pinned artifacts', () => {
    const evidence = stepNamed('mutation', 'Record immutable result evidence');
    assert.equal(String(evidence.if), 'always()');
    assert.match(evidence.run, /artifact_name=railway-reconcile-result-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
    assert.match(evidence.run, /producer_run_attempt=\$\{GITHUB_RUN_ATTEMPT\}/);
    assert.equal(job('mutation').outputs.artifact_name, '${{ steps.evidence.outputs.artifact_name }}');
    assert.equal(job('mutation').outputs.producer_run_attempt, '${{ steps.evidence.outputs.producer_run_attempt }}');
    const upload = stepNamed('mutation', 'Upload reconciliation result manifest');
    assert.equal(String(upload.if), 'always()');
    assert.equal(upload.uses, 'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f');
    assert.equal(upload.with.name, '${{ steps.evidence.outputs.artifact_name }}');
    const download = stepNamed('verifier', 'Download immutable reconciliation result');
    assert.equal(download.uses, 'actions/download-artifact@018cc2cf5baa6db3ef3c5f8a56943fffe632ef53');
    assert.equal(download.with.name, '${{ needs.mutation.outputs.artifact_name }}');
    assert.match(String(job('verifier').if), /manifest_ready == 'true'/);
    assert.match(
      stepNamed('verifier', 'Finalize exact Railway reconciliation acceptance').run,
      /--producer-run-attempt.*needs\.mutation\.outputs\.producer_run_attempt/s,
    );
    const enforce = stepNamed('mutation', 'Enforce structured mutation outcome');
    assert.match(String(enforce.if), /command_status != '0'/);
    assert.match(enforce.run, /exit 1/);
  });

  it('gives the 39-minute verifier budget setup margin and only scoped read credentials', () => {
    const verifier = job('verifier');
    assert.equal(verifier['timeout-minutes'], 50);
    assert.equal(verifier.environment?.name, 'ingestion-acceptance-production-verification');
    assert.deepEqual(referencedSecrets('verifier').sort(), [
      'RAILWAY_RECONCILE_VERIFIER_HMAC',
      'RAILWAY_RECONCILE_VIEWER_TOKEN',
    ]);
    const final = stepNamed('verifier', 'Finalize exact Railway reconciliation acceptance');
    assert.match(final.run, /finalize-railway-reconcile\.mjs/);
    assert.equal(final.env.RAILWAY_TOKEN, '${{ secrets.RAILWAY_RECONCILE_VIEWER_TOKEN }}');
    assert.doesNotMatch(JSON.stringify(verifier), /DEPLOY_TOKEN|MUTATION_HMAC|WATCHDOG_HMAC|OPERATOR_HMAC|serviceInstanceDeploy/);
  });

  it('counts only final strict acceptance and alarms when no verifier succeeds', () => {
    const final = stepNamed('verifier', 'Finalize exact Railway reconciliation acceptance');
    assert.ok(final.id);
    const liveness = job('liveness');
    assert.deepEqual(liveness.needs, ['admission', 'mutation', 'verifier']);
    assert.equal(liveness.environment, undefined);
    assert.deepEqual(referencedSecrets('liveness'), []);
    assert.match(String(liveness.if), /needs\.admission\.result == 'success'/);
    assert.match(String(liveness.if), /needs\.admission\.outputs\.dry_run != 'true'/);
    assert.match(String(liveness.if), /needs\.verifier\.result != 'success'/);
    const enforce = stepNamed('liveness', 'Enforce reconciliation liveness');
    assert.match(enforce.run, /cutover is disabled; no protected mutation path ran/i);
    assert.match(enforce.run, /::warning::/);
    assert.match(enforce.run, /check-railway-reconcile-age\.mjs --warn-only/);
    assert.match(enforce.run, /if ! node scripts\/check-railway-reconcile-age\.mjs --warn-only/);
    assert.match(enforce.run, /exit 0/);
    assert.doesNotMatch(enforce.run, /cutover is disabled[^\n]*\n\s*exit 1/i);
    assert.match(enforce.run, /check-railway-reconcile-age\.mjs/);
    assert.doesNotMatch(JSON.stringify(liveness), /RAILWAY_TOKEN|RECONCILE_.*HMAC|DEPLOY_TOKEN/);
    assert.doesNotMatch(source, /check-seed-freshness|\/api\/health/);
  });

  it('pins every external action to a full commit SHA and every Railway CLI install', () => {
    for (const [jobName, definition] of Object.entries(workflow.jobs)) {
      for (const step of definition.steps ?? []) {
        if (step.uses) {
          assert.match(step.uses, /^[^@]+@[0-9a-f]{40}$/, `${jobName}:${step.name ?? step.uses}`);
        }
        if (String(step.run ?? '').includes('npm install --global @railway/cli')) {
          assert.match(step.run, /@railway\/cli@5\.30\.1/);
        }
      }
    }
  });

  it('contains no empty GitHub expression in any workflow', () => {
    const workflowDir = resolve(repoRoot, '.github/workflows');
    const offenders = [];
    for (const file of readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
      const text = readFileSync(resolve(workflowDir, file), 'utf8');
      text.split('\n').forEach((line, index) => {
        if (/\$\{\{\s*\}\}/.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
    assert.deepEqual(offenders, []);
  });
});
