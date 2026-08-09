import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  assertManifestProvenance,
  finalizeAfterLease,
  finalizeRailwayReconcile,
  verifierFailureReason,
} from '../scripts/finalize-railway-reconcile.mjs';
import {
  ControlPlaneError,
} from '../scripts/railway-reconcile-control-client.mjs';
import {
  createIntentManifest,
  createResultManifest,
} from '../scripts/railway-reconcile-manifest.mjs';
import { ConvergenceError } from '../scripts/wait-railway-deploy-convergence.mjs';
import { ReconcileAuthorizationError } from '../scripts/trigger-railway-deploys.mjs';

const HEAD = 'a'.repeat(40);
const ENV = {
  GITHUB_REPOSITORY: 'koala73/worldmonitor',
  GITHUB_RUN_ID: '31181545167',
  GITHUB_RUN_ATTEMPT: '1',
};

function resultManifest({ outcome = 'MUTATION_COMPLETED' } = {}) {
  const entries = outcome === 'MUTATION_PARTIAL'
    ? [
      {
        service: 'seed-a', serviceId: 'svc-a', action: 'DEPLOY', outcome: 'TRIGGERED',
        deploymentId: 'dep-a', observedDeploymentId: null, reason: 'CLOSURE_CHANGED',
      },
      {
        service: 'seed-b', serviceId: 'svc-b', action: 'DEPLOY', outcome: 'FAILED',
        deploymentId: null, observedDeploymentId: null, reason: 'STOPPED_AFTER_FAILURE',
      },
    ]
    : [{
      service: 'seed-a', serviceId: 'svc-a', action: 'DEPLOY', outcome: 'TRIGGERED',
      deploymentId: 'dep-a', observedDeploymentId: null, reason: 'CLOSURE_CHANGED',
    }];
  const intent = createIntentManifest({
    attemptId: 'attempt-0001',
    producer: {
      repository: ENV.GITHUB_REPOSITORY,
      workflow: 'railway-deploy-trigger.yml',
      runId: ENV.GITHUB_RUN_ID,
      runAttempt: Number(ENV.GITHUB_RUN_ATTEMPT),
    },
    headSha: HEAD,
    projectId: 'project-1',
    environmentId: 'environment-1',
    owner: `github-run:${ENV.GITHUB_RUN_ID}:${ENV.GITHUB_RUN_ATTEMPT}`,
    recoveryAttemptId: null,
    plannedServices: entries.map(({ service, serviceId, action, reason }) => ({
      service, serviceId, action, reason,
    })),
    authorization: {
      gateContext: 'gate', gateState: 'success',
      gateObservedAt: '2026-08-07T10:00:00.000Z',
      mainObservedAt: '2026-08-07T10:00:01.000Z',
    },
    createdAt: '2026-08-07T10:00:02.000Z',
  });
  return createResultManifest({
    intent,
    outcome,
    entries,
    createdAt: '2026-08-07T10:01:00.000Z',
  });
}

describe('terminal verifier failure classification', () => {
  it('maps only evidence-bearing terminal failures into the closed control vocabulary', () => {
    const manifest = resultManifest();
    const cases = [
      ['CONVERGENCE_TIMEOUT', 'CONVERGENCE_TIMEOUT'],
      ['DEPLOYMENT_TERMINAL_FAILURE', 'TERMINAL_FAILURE'],
      ['STRICT_DRIFT_FAILED', 'TERMINAL_FAILURE'],
      ['DEPLOYMENT_STATUS_UNKNOWN', 'UNKNOWN_STATUS'],
      ['DEPLOYMENT_QUERY_FAILED', 'UNREADABLE_HISTORY'],
      ['DEPLOYMENT_MISSING', 'UNREADABLE_HISTORY'],
      ['STRICT_DRIFT_QUERY_FAILED', 'UNREADABLE_HISTORY'],
      ['EXACT_HEAD_MISMATCH', 'VERIFIER_CONTRACT_FAILURE'],
      ['MANIFEST_PROJECT_MISMATCH', 'VERIFIER_CONTRACT_FAILURE'],
      ['MANIFEST_ENVIRONMENT_MISMATCH', 'VERIFIER_CONTRACT_FAILURE'],
      ['STRICT_DRIFT_INVALID', 'VERIFIER_CONTRACT_FAILURE'],
      ['FUTURE_DETERMINISTIC_CONVERGENCE_FAILURE', 'VERIFIER_CONTRACT_FAILURE'],
    ];
    for (const [code, reason] of cases) {
      assert.equal(verifierFailureReason(new ConvergenceError(code, code), manifest), reason, code);
    }
    assert.equal(
      verifierFailureReason(new ReconcileAuthorizationError('MAIN_MOVED', 'main moved'), manifest),
      'STALLED',
    );
    assert.equal(
      verifierFailureReason(new ReconcileAuthorizationError('GATE_NOT_GREEN', 'gate moved'), manifest),
      'STALLED',
    );
    assert.equal(
      verifierFailureReason(new ReconcileAuthorizationError('MAIN_DIVERGED', 'main diverged'), manifest),
      'STALLED',
    );
    assert.equal(
      verifierFailureReason(new ReconcileAuthorizationError('GITHUB_STATE_UNREADABLE', 'API down'), manifest),
      null,
    );
    assert.equal(verifierFailureReason(new Error('runner infrastructure failed'), manifest), null);
    assert.equal(
      verifierFailureReason(new Error('artifact already proves partial mutation'), resultManifest({ outcome: 'MUTATION_PARTIAL' })),
      'PARTIAL_MUTATION',
    );
  });
});

describe('bounded verifier finalization', () => {
  it('waits for lease expiry and retries one ambiguous idempotent decision', async () => {
    let now = 0;
    let calls = 0;
    const sleeps = [];
    const result = await finalizeAfterLease({
      deadlineAt: 60_000,
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
      decide: async () => {
        calls += 1;
        if (calls === 1) {
          throw new ControlPlaneError('LEASE_STILL_ACTIVE', 'lease active', { definitive: true });
        }
        if (calls === 2) throw new ControlPlaneError('CONTROL_TIMEOUT_AMBIGUOUS', 'lost response');
        return { outcome: 'TERMINAL_ACCEPTED' };
      },
    });
    assert.equal(result.outcome, 'TERMINAL_ACCEPTED');
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [15_000, 15_000]);
  });

  it('does not loop past the finalization deadline', async () => {
    let calls = 0;
    await assert.rejects(
      finalizeAfterLease({
        deadlineAt: 100,
        now: () => 100,
        sleep: async () => assert.fail('deadline must prevent sleeping'),
        decide: async () => {
          calls += 1;
          throw new ControlPlaneError('LEASE_STILL_ACTIVE', 'lease active', { definitive: true });
        },
      }),
      (error) => error instanceof ControlPlaneError && error.code === 'LEASE_STILL_ACTIVE',
    );
    assert.equal(calls, 1);
  });
});

describe('exact-run Railway reconciliation finalization', () => {
  it('accepts after convergence when current green main is the exact head or its descendant', async () => {
    const events = [];
    const accepted = [];
    const manifest = resultManifest();
    const result = await finalizeRailwayReconcile({
      manifest,
      expectedHead: HEAD,
      env: ENV,
      now: () => 1_000,
      verify: async ({ manifest: seen, expectedHead, deadlineMs }) => {
        events.push('verify');
        assert.equal(seen.resultDigest, manifest.resultDigest);
        assert.equal(expectedHead, HEAD);
        assert.equal(deadlineMs, 35 * 60 * 1_000);
      },
      authorizeCurrent: async ({ repository, headSha }) => {
        events.push('authorize');
        assert.equal(repository, ENV.GITHUB_REPOSITORY);
        assert.equal(headSha, HEAD);
        return { lineage: 'DESCENDANT', currentMainHeadSha: 'b'.repeat(40) };
      },
      control: {
        accept: async (body) => {
          events.push('accept');
          accepted.push(body);
          return { outcome: 'TERMINAL_ACCEPTED' };
        },
        fail: async () => assert.fail('successful verification must not fail the attempt'),
      },
    });
    assert.deepEqual(events, ['verify', 'authorize', 'accept']);
    assert.deepEqual(accepted, [{
      attemptId: manifest.intent.attemptId,
      headSha: HEAD,
      intentDigest: manifest.intentDigest,
      resultDigest: manifest.resultDigest,
    }]);
    assert.equal(result.outcome, 'TERMINAL_ACCEPTED');
  });

  it('accepts original mutation provenance when only failed verifier jobs are rerun', () => {
    const manifest = resultManifest();
    const rerunEnv = { ...ENV, GITHUB_RUN_ATTEMPT: '2' };
    assert.throws(
      () => assertManifestProvenance(manifest, HEAD, rerunEnv),
      /producer does not match/,
    );
    assert.doesNotThrow(() => assertManifestProvenance(manifest, HEAD, rerunEnv, 1));
  });

  it('durably marks deterministic post-mutation authorization loss as manual-required', async () => {
    const failed = [];
    const manifest = resultManifest();
    await assert.rejects(
      finalizeRailwayReconcile({
        manifest,
        expectedHead: HEAD,
        env: ENV,
        verify: async () => {},
        authorizeCurrent: async () => {
          throw new ReconcileAuthorizationError('MAIN_MOVED', 'main moved');
        },
        control: {
          accept: async () => assert.fail('moved main cannot be accepted'),
          fail: async (body) => { failed.push(body); return { outcome: 'MANUAL_REQUIRED' }; },
        },
      }),
      (error) => error instanceof ReconcileAuthorizationError && error.code === 'MAIN_MOVED',
    );
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason, 'STALLED');
  });

  it('durably closes deterministic verifier contract failures', async () => {
    const failed = [];
    const manifest = resultManifest();
    await assert.rejects(
      finalizeRailwayReconcile({
        manifest,
        expectedHead: HEAD,
        env: ENV,
        verify: async () => {
          throw new ConvergenceError('STRICT_DRIFT_INVALID', 'malformed strict drift result');
        },
        authorizeCurrent: async () => assert.fail('failed convergence must not be authorized'),
        control: {
          accept: async () => assert.fail('failed convergence cannot be accepted'),
          fail: async (body) => { failed.push(body); return { outcome: 'MANUAL_REQUIRED' }; },
        },
      }),
      (error) => error instanceof ConvergenceError && error.code === 'STRICT_DRIFT_INVALID',
    );
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason, 'VERIFIER_CONTRACT_FAILURE');
  });

  it('leaves durable evidence unchanged on verifier infrastructure failure', async () => {
    let controlCalls = 0;
    const manifest = resultManifest();
    await assert.rejects(
      finalizeRailwayReconcile({
        manifest,
        expectedHead: HEAD,
        env: ENV,
        verify: async () => {
          throw new Error('runner lost access to the Railway API');
        },
        control: {
          accept: async () => { controlCalls += 1; },
          fail: async () => { controlCalls += 1; },
        },
      }),
      /runner lost access/,
    );
    assert.equal(controlCalls, 0);
  });

  it('rejects producer or head provenance before provider or control access', async () => {
    const manifest = resultManifest();
    assert.throws(
      () => assertManifestProvenance(manifest, 'b'.repeat(40), ENV),
      /manifest head does not match/,
    );
    let calls = 0;
    await assert.rejects(
      finalizeRailwayReconcile({
        manifest,
        expectedHead: HEAD,
        env: { ...ENV, GITHUB_RUN_ATTEMPT: '2' },
        verify: async () => { calls += 1; },
        authorizeCurrent: async () => { calls += 1; },
        control: {
          accept: async () => { calls += 1; },
          fail: async () => { calls += 1; },
        },
      }),
      /producer does not match/,
    );
    assert.equal(calls, 0);
  });

  it('contains no mutation capability or unrelated ingestion-health acceptance', () => {
    const source = readFileSync(new URL('../scripts/finalize-railway-reconcile.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /DEPLOY_TOKEN|startMutation|\.acquire\(|seed-freshness|\/api\/health/);
  });
});
