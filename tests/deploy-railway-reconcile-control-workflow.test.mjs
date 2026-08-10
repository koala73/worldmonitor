import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/deploy-railway-reconcile-control.yml');
const source = readFileSync(workflowPath, 'utf8');
const workflow = YAML.parse(source);

function assertBashSyntax(script) {
  const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

describe('Railway reconcile control deployment workflow', () => {
  it('deploys only from main changes to the isolated Worker or its deployment contract', () => {
    assert.deepEqual(workflow.on.push.branches, ['main']);
    assert.deepEqual(new Set(workflow.on.push.paths), new Set([
      'workers/railway-reconcile-control/**',
      '.github/workflows/deploy-railway-reconcile-control.yml',
      'tests/deploy-railway-reconcile-control-workflow.test.mjs',
    ]));
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  });

  it('has read-only repository permissions and a protected deploy environment', () => {
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(workflow.concurrency, {
      group: 'railway-reconcile-control-production',
      'cancel-in-progress': false,
    });
    assert.equal(workflow.jobs.deploy.environment.name, 'railway-reconcile-control-production');
    assert.equal(workflow.jobs.deploy.environment.deployment, false);
    assert.equal(workflow.jobs.deploy.if, "github.ref == 'refs/heads/main'");
    for (const jobName of ['unit-test', 'deploy']) {
      assert.equal(workflow.jobs[jobName]['timeout-minutes'], 15);
      const checkout = workflow.jobs[jobName].steps.find((step) => step.uses?.startsWith('actions/checkout@'));
      assert.equal(checkout.with['persist-credentials'], false);
      const install = workflow.jobs[jobName].steps.find((step) => step.name === 'Install');
      assert.match(install.run, /npm ci --ignore-scripts/);
    }
  });

  it('requires all four route credentials plus one server-owned scope', () => {
    const secretStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Set control-plane secrets');
    assert.ok(secretStep);
    const expected = [
      'RAILWAY_RECONCILE_CONTROL_SCOPE',
      'RAILWAY_RECONCILE_MUTATION_HMAC',
      'RAILWAY_RECONCILE_VERIFIER_HMAC',
      'RAILWAY_RECONCILE_WATCHDOG_HMAC',
      'RAILWAY_RECONCILE_OPERATOR_HMAC',
    ];
    const bindings = {
      RAILWAY_RECONCILE_CONTROL_SCOPE: 'CONTROL_SCOPE',
      RAILWAY_RECONCILE_MUTATION_HMAC: 'MUTATION_HMAC_SECRET',
      RAILWAY_RECONCILE_VERIFIER_HMAC: 'VERIFIER_HMAC_SECRET',
      RAILWAY_RECONCILE_WATCHDOG_HMAC: 'WATCHDOG_HMAC_SECRET',
      RAILWAY_RECONCILE_OPERATOR_HMAC: 'OPERATOR_HMAC_SECRET',
    };
    for (const name of expected) {
      assert.equal(secretStep.env[name], `\${{ secrets.${name} }}`);
      assert.match(secretStep.run, new RegExp(`${bindings[name]}: ['"]${name}['"]`));
    }
    assert.equal(new Set(expected.map((name) => secretStep.env[name])).size, expected.length);
    assert.doesNotMatch(secretStep.run, /continue-on-error|\|\|\s*true/);
    assert.match(secretStep.run, /must contain 32 to 1024 bytes/);
    assert.match(secretStep.run, /must be pairwise distinct/);
    assert.match(secretStep.run, /wrangler secret bulk/);
    assert.doesNotMatch(secretStep.run, /wrangler secret put/);
  });

  it('runs unit tests before deploy and performs an HTTPS no-redirect propagation smoke', () => {
    assert.deepEqual(workflow.jobs.deploy.needs, ['unit-test']);
    const unit = workflow.jobs['unit-test'];
    assert.equal(unit.defaults.run['working-directory'], 'workers/railway-reconcile-control');
    assert.ok(unit.steps.some((step) => step.name === 'Run unit tests' && step.run === 'npm test'));
    assert.ok(workflow.jobs.deploy.steps.some((step) => step.name === 'Deploy' && /wrangler deploy/.test(step.run)));
    const deploy = workflow.jobs.deploy.steps.find((step) => step.name === 'Deploy');
    assert.match(deploy.run, /DEPLOYMENT_SHA:\$GITHUB_SHA/);
    const fence = workflow.jobs.deploy.steps.find((step) => step.name === 'Fence stale main deployment');
    assert.match(fence.run, /git fetch --no-tags origin main/);
    assert.match(fence.run, /git rev-parse origin\/main/);
    const objectSmoke = workflow.jobs.deploy.steps.find((step) => step.name === 'Smoke canonical Durable Object');
    assert.equal(
      objectSmoke.env.RAILWAY_RECONCILE_WATCHDOG_HMAC,
      '${{ secrets.RAILWAY_RECONCILE_WATCHDOG_HMAC }}',
    );
    assert.match(objectSmoke.run, /RailwayReconcileControlClient/);
    assert.match(objectSmoke.run, /client\.status\(\)/);
    assert.match(objectSmoke.run, /STATUS_REPORTED/);
    assert.deepEqual(workflow.jobs['live-smoke'].needs, ['deploy']);
    assert.equal(workflow.jobs['live-smoke']['timeout-minutes'], 3);
    const smoke = workflow.jobs['live-smoke'].steps.find((step) => step.name === 'Verify exact deployed Worker version');
    assert.ok(smoke);
    assert.equal(smoke.env.RAILWAY_RECONCILE_CONTROL_URL, '${{ vars.RAILWAY_RECONCILE_CONTROL_URL }}');
    assert.equal(smoke.env.EXPECTED_DEPLOYMENT_SHA, '${{ github.sha }}');
    assert.match(smoke.run, /--proto '=https'/);
    assert.match(smoke.run, /--max-redirs 0/);
    assert.match(smoke.run, /--connect-timeout 5/);
    assert.match(smoke.run, /--max-time 10/);
    assert.match(smoke.run, /\/version/);
    assert.match(smoke.run, /\.deploymentSha == \$expected/);
    assert.match(smoke.run, /for attempt in 1 2 3 4 5 6/);
    assert.match(smoke.run, /sleep 5/);
    assert.doesNotMatch(smoke.run, /sleep 30/);
    assert.match(smoke.run, /bounded propagation window/);
    assert.doesNotMatch(smoke.run, /within 25 seconds/);
    assertBashSyntax(smoke.run);
  });

  it('pins every third-party action to a full commit SHA', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses) continue;
        assert.match(step.uses, /^[^@]+@[0-9a-f]{40}$/i, step.uses);
      }
    }
  });
});
