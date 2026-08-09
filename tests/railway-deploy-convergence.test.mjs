import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CONVERGENCE_READ_CONCURRENCY,
  ConvergenceError,
  assertRailwayManifestContext,
  buildStrictDriftArgs,
  classifyRelevantDeployment,
  createStrictDriftEnv,
  waitForRailwayDeployConvergence,
} from '../scripts/wait-railway-deploy-convergence.mjs';
import { createIntentManifest, createResultManifest } from '../scripts/railway-reconcile-manifest.mjs';

const HEAD = 'a'.repeat(40);

function manifest({ outcome = 'MUTATION_COMPLETED', entries } = {}) {
  const normalizedEntries = entries ?? [{
    service: 'seed-a', serviceId: 'svc-a', action: 'DEPLOY', outcome: 'TRIGGERED',
    deploymentId: 'dep-a', observedDeploymentId: null, reason: 'CLOSURE_CHANGED',
  }];
  const intent = createIntentManifest({
    attemptId: 'attempt-0001',
    producer: {
      repository: 'koala73/worldmonitor', workflow: 'railway-deploy-trigger.yml',
      runId: '31181545167', runAttempt: 1,
    },
    headSha: HEAD,
    projectId: 'project-1',
    environmentId: 'environment-1',
    owner: 'github-run:31181545167:1',
    recoveryAttemptId: null,
    plannedServices: normalizedEntries.map(({ service, serviceId, action, reason }) => ({
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
    entries: normalizedEntries,
    createdAt: '2026-08-07T10:01:00.000Z',
  });
}

describe('relevant Railway deployment terminal classification', () => {
  it('uses the shared deployed-source, in-flight, and failure status semantics', () => {
    for (const status of ['SUCCESS', 'CRASHED', 'REMOVED', 'SLEEPING']) {
      assert.equal(classifyRelevantDeployment(status), 'ACCEPTED', status);
    }
    for (const status of ['QUEUED', 'WAITING', 'INITIALIZING', 'BUILDING', 'DEPLOYING']) {
      assert.equal(classifyRelevantDeployment(status), 'WAIT', status);
    }
    for (const status of ['FAILED', 'SKIPPED']) {
      assert.equal(classifyRelevantDeployment(status), 'FAILED', status);
    }
    for (const status of [null, undefined, 'NEEDS_APPROVAL', 'A_STATUS_FROM_2027']) {
      assert.equal(classifyRelevantDeployment(status), 'UNKNOWN', String(status));
    }
  });
});

describe('waitForRailwayDeployConvergence', () => {
  it('types deterministic Railway project and environment mismatches', () => {
    const result = manifest();
    assert.throws(
      () => assertRailwayManifestContext(result, {
        projectId: 'other-project',
        environmentId: result.intent.environmentId,
      }),
      (error) => error instanceof ConvergenceError && error.code === 'MANIFEST_PROJECT_MISMATCH',
    );
    assert.throws(
      () => assertRailwayManifestContext(result, {
        projectId: result.intent.projectId,
        environmentId: 'other-environment',
      }),
      (error) => error instanceof ConvergenceError && error.code === 'MANIFEST_ENVIRONMENT_MISMATCH',
    );
  });

  it('stays isolated from seed freshness and aggregate health acceptance', () => {
    const source = readFileSync(new URL('../scripts/wait-railway-deploy-convergence.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /check-seed-freshness|\/api\/health|seed-freshness-baseline/);
  });

  it('polls triggered IDs through in-flight states, then requires strict exact-head drift', async () => {
    const seen = [];
    const statuses = ['INITIALIZING', 'BUILDING', 'DEPLOYING', 'SUCCESS'];
    let now = 0;
    const result = await waitForRailwayDeployConvergence({
      manifest: manifest(),
      expectedHead: HEAD,
      deadlineMs: 10_000,
      pollIntervalMs: 100,
      now: () => now,
      sleep: async (ms) => { now += ms; },
      readDeployment: async (entry) => {
        seen.push(entry.deploymentId);
        return { id: entry.deploymentId, status: statuses.shift() };
      },
      verifyStrictDrift: async ({ headSha }) => ({
        ok: headSha === HEAD,
        blocking: [], missing: [], duplicates: [], unexpected: [],
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 4);
    assert.deepEqual(result.acceptedDeploymentIds, ['dep-a']);
  });

  it('adopts an already-active deployment ID without retriggering it', async () => {
    const adopted = manifest({
      outcome: 'NO_MUTATION',
      entries: [{
        service: 'seed-a', serviceId: 'svc-a', action: 'ADOPT', outcome: 'ALREADY_ACTIVE',
        deploymentId: null, observedDeploymentId: 'dep-active', reason: 'HEAD_ALREADY_ACTIVE',
      }],
    });
    const result = await waitForRailwayDeployConvergence({
      manifest: adopted,
      expectedHead: HEAD,
      readDeployment: async ({ observedDeploymentId }) => ({ id: observedDeploymentId, status: 'SUCCESS' }),
      verifyStrictDrift: async () => ({ ok: true, blocking: [], missing: [], duplicates: [], unexpected: [] }),
    });
    assert.deepEqual(result.acceptedDeploymentIds, ['dep-active']);
  });

  it('accepts cron terminal states only after strict exact-head drift is zero', async () => {
    const adopted = manifest({
      outcome: 'NO_MUTATION',
      entries: [{
        service: 'seed-a', serviceId: 'svc-a', action: 'ADOPT', outcome: 'ALREADY_ACTIVE',
        deploymentId: null, observedDeploymentId: 'dep-cron', reason: 'HEAD_ALREADY_ACTIVE',
      }],
    });
    for (const status of ['CRASHED', 'REMOVED', 'SLEEPING']) {
      let strictReads = 0;
      const result = await waitForRailwayDeployConvergence({
        manifest: adopted,
        expectedHead: HEAD,
        readDeployment: async ({ observedDeploymentId }) => ({ id: observedDeploymentId, status }),
        verifyStrictDrift: async () => {
          strictReads += 1;
          return { ok: true, blocking: [], missing: [], duplicates: [], unexpected: [] };
        },
      });
      assert.deepEqual(result.acceptedDeploymentIds, ['dep-cron'], status);
      assert.equal(strictReads, 1, status);
    }
  });

  it('accepts an empty no-mutation plan only after strict full-fleet drift', async () => {
    const noop = manifest({ outcome: 'NO_MUTATION', entries: [] });
    let deploymentReads = 0;
    let driftReads = 0;
    const result = await waitForRailwayDeployConvergence({
      manifest: noop,
      expectedHead: HEAD,
      readDeployment: async () => { deploymentReads += 1; return null; },
      verifyStrictDrift: async () => {
        driftReads += 1;
        return { ok: true, blocking: [], missing: [], duplicates: [], unexpected: [] };
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.acceptedDeploymentIds, []);
    assert.equal(deploymentReads, 0);
    assert.equal(driftReads, 1);
  });

  it('polls a full fleet with bounded concurrency', async () => {
    const entries = Array.from({ length: 17 }, (_, index) => ({
      service: `seed-${index}`,
      serviceId: `svc-${index}`,
      action: 'DEPLOY',
      outcome: 'TRIGGERED',
      deploymentId: `dep-${index}`,
      observedDeploymentId: null,
      reason: 'CLOSURE_CHANGED',
    }));
    let active = 0;
    let maxActive = 0;
    const result = await waitForRailwayDeployConvergence({
      manifest: manifest({ entries }),
      expectedHead: HEAD,
      readDeployment: async (entry) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return { id: entry.deploymentId, status: 'SUCCESS' };
      },
      verifyStrictDrift: async () => ({ ok: true }),
    });
    assert.equal(CONVERGENCE_READ_CONCURRENCY, 8);
    assert.equal(maxActive, CONVERGENCE_READ_CONCURRENCY);
    assert.equal(result.acceptedDeploymentIds.length, entries.length);
  });

  it('permits skipped entries only behind the final strict fleet proof', async () => {
    const mixed = manifest({
      entries: [
        {
          service: 'seed-a', serviceId: 'svc-a', action: 'DEPLOY', outcome: 'TRIGGERED',
          deploymentId: 'dep-a', observedDeploymentId: null, reason: 'CLOSURE_CHANGED',
        },
        {
          service: 'seed-b', serviceId: 'svc-b', action: 'SKIP', outcome: 'SKIPPED',
          deploymentId: null, observedDeploymentId: null, reason: 'HEAD_ALREADY_ACTIVE',
        },
      ],
    });
    let driftReads = 0;
    const result = await waitForRailwayDeployConvergence({
      manifest: mixed,
      expectedHead: HEAD,
      readDeployment: async (entry) => ({ id: entry.deploymentId, status: 'SUCCESS' }),
      verifyStrictDrift: async () => { driftReads += 1; return { ok: true }; },
    });
    assert.deepEqual(result.acceptedDeploymentIds, ['dep-a']);
    assert.equal(driftReads, 1);
  });

  it('rejects partial and ambiguous top-level outcomes before any automatic convergence work', async () => {
    const cases = [
      manifest({
        outcome: 'MUTATION_PARTIAL',
        entries: [
          {
            service: 'seed-a', serviceId: 'svc-a', action: 'DEPLOY', outcome: 'TRIGGERED',
            deploymentId: 'dep-a', observedDeploymentId: null, reason: 'CLOSURE_CHANGED',
          },
          {
            service: 'seed-b', serviceId: 'svc-b', action: 'DEPLOY', outcome: 'FAILED',
            deploymentId: null, observedDeploymentId: null, reason: 'TRIGGER_FAILED',
          },
        ],
      }),
      manifest({
        outcome: 'MUTATION_AMBIGUOUS',
        entries: [{
          service: 'seed-a', serviceId: 'svc-a', action: 'DEPLOY', outcome: 'AMBIGUOUS',
          deploymentId: null, observedDeploymentId: null, reason: 'TRIGGER_AMBIGUOUS',
        }],
      }),
      manifest({
        outcome: 'MUTATION_AMBIGUOUS',
        entries: [
          {
            service: 'seed-a', serviceId: 'svc-a', action: 'DEPLOY', outcome: 'TRIGGERED',
            deploymentId: 'dep-a', observedDeploymentId: null, reason: 'CLOSURE_CHANGED',
          },
          {
            service: 'seed-b', serviceId: 'svc-b', action: 'DEPLOY', outcome: 'AMBIGUOUS',
            deploymentId: null, observedDeploymentId: null, reason: 'TRIGGER_AMBIGUOUS',
          },
        ],
      }),
      {
        ...manifest(),
        outcome: 'MUTATION_PARTIAL',
        entries: [],
      },
      {
        ...manifest(),
        outcome: 'MUTATION_AMBIGUOUS',
        entries: [{
          service: 'seed-a', serviceId: 'svc-a', action: 'DEPLOY', outcome: 'TRIGGERED',
          deploymentId: 'dep-a', observedDeploymentId: null, reason: 'CLOSURE_CHANGED',
        }],
      },
    ];

    for (const unresolved of cases) {
      let deploymentReads = 0;
      let driftReads = 0;
      await assert.rejects(
        waitForRailwayDeployConvergence({
          manifest: unresolved,
          expectedHead: HEAD,
          readDeployment: async () => { deploymentReads += 1; return null; },
          verifyStrictDrift: async () => { driftReads += 1; return { ok: true }; },
        }),
        (error) => error instanceof ConvergenceError
          && error.code === 'MANIFEST_MUTATION_UNRESOLVED'
          && error.disposition === 'MANUAL_REQUIRED',
      );
      assert.equal(deploymentReads, 0, unresolved.outcome);
      assert.equal(driftReads, 0, unresolved.outcome);
    }
  });

  it('fails closed on terminal failure, unknown status, and missing ID', async () => {
    const cases = [
      { read: async () => ({ id: 'dep-a', status: 'FAILED' }), code: 'DEPLOYMENT_TERMINAL_FAILURE' },
      { read: async () => ({ id: 'dep-a', status: 'NEEDS_APPROVAL' }), code: 'DEPLOYMENT_STATUS_UNKNOWN' },
      { read: async () => null, code: 'DEPLOYMENT_MISSING' },
    ];
    for (const { read, code } of cases) {
      await assert.rejects(
        waitForRailwayDeployConvergence({
          manifest: manifest(), expectedHead: HEAD, readDeployment: read,
          verifyStrictDrift: async () => ({ ok: true }),
        }),
        (error) => error instanceof ConvergenceError && error.code === code,
      );
    }
  });

  it('retries transient deployment-read failures but reports an unresolved failure at the deadline', async () => {
    let now = 0;
    let reads = 0;
    const recovered = await waitForRailwayDeployConvergence({
      manifest: manifest(),
      expectedHead: HEAD,
      deadlineMs: 250,
      pollIntervalMs: 100,
      now: () => now,
      sleep: async (ms) => { now += ms; },
      readDeployment: async () => {
        reads += 1;
        if (reads === 1) throw new Error('transient Railway read failure');
        return { id: 'dep-a', status: 'SUCCESS' };
      },
      verifyStrictDrift: async () => ({ ok: true }),
    });
    assert.equal(recovered.ok, true);
    assert.equal(reads, 2);

    now = 0;
    await assert.rejects(
      waitForRailwayDeployConvergence({
        manifest: manifest(),
        expectedHead: HEAD,
        deadlineMs: 250,
        pollIntervalMs: 100,
        now: () => now,
        sleep: async (ms) => { now += ms; },
        readDeployment: async () => { throw new Error('persistent Railway read failure'); },
        verifyStrictDrift: async () => ({ ok: true }),
      }),
      (error) => error instanceof ConvergenceError && error.code === 'DEPLOYMENT_QUERY_FAILED',
    );
  });

  it('times out instead of accepting a perpetually pending deployment', async () => {
    let now = 0;
    await assert.rejects(
      waitForRailwayDeployConvergence({
        manifest: manifest(), expectedHead: HEAD,
        deadlineMs: 250, pollIntervalMs: 100,
        now: () => now,
        sleep: async (ms) => { now += ms; },
        readDeployment: async () => ({ id: 'dep-a', status: 'BUILDING' }),
        verifyStrictDrift: async () => ({ ok: true }),
      }),
      (error) => error instanceof ConvergenceError && error.code === 'CONVERGENCE_TIMEOUT',
    );
  });

  it('rejects a terminal read or strict proof that crosses the deadline', async () => {
    for (const crossing of ['deployment', 'strict']) {
      let now = 0;
      await assert.rejects(
        waitForRailwayDeployConvergence({
          manifest: manifest(),
          expectedHead: HEAD,
          deadlineMs: 100,
          now: () => now,
          readDeployment: async () => {
            if (crossing === 'deployment') now = 100;
            return { id: 'dep-a', status: 'SUCCESS' };
          },
          verifyStrictDrift: async () => {
            if (crossing === 'strict') now = 100;
            return { ok: true };
          },
        }),
        (error) => error instanceof ConvergenceError && error.code === 'CONVERGENCE_TIMEOUT',
      );
    }
  });

  it('rejects moved heads and any non-zero strict fleet drift', async () => {
    await assert.rejects(
      waitForRailwayDeployConvergence({
        manifest: manifest(), expectedHead: 'b'.repeat(40),
        readDeployment: async () => ({ id: 'dep-a', status: 'SUCCESS' }),
        verifyStrictDrift: async () => ({ ok: true }),
      }),
      (error) => error instanceof ConvergenceError && error.code === 'EXACT_HEAD_MISMATCH',
    );
    await assert.rejects(
      waitForRailwayDeployConvergence({
        manifest: manifest(), expectedHead: HEAD,
        readDeployment: async () => ({ id: 'dep-a', status: 'SUCCESS' }),
        verifyStrictDrift: async () => ({
          ok: false,
          blocking: [{ service: 'seed-b', verdict: 'PENDING_BUILD' }],
          missing: [], duplicates: [], unexpected: [],
        }),
      }),
      (error) => error instanceof ConvergenceError && error.code === 'STRICT_DRIFT_FAILED',
    );
  });
});

describe('strict drift subprocess contract', () => {
  it('passes every immutable planned service as an explicit expected-service argument', () => {
    const args = buildStrictDriftArgs(HEAD, 'production', ['seed-a', 'seed-b']);
    assert.deepEqual(args.slice(1), [
      '--strict', '--json', '--head', HEAD, '--environment', 'production',
      '--expected-service', 'seed-a',
      '--expected-service', 'seed-b',
    ]);
  });

  it('passes only Railway read credentials and process support to the strict child', () => {
    const env = createStrictDriftEnv({
      PATH: '/runner/bin',
      RAILWAY_TOKEN: 'viewer-token',
      RAILWAY_PROJECT_ID: 'project-1',
      RAILWAY_RECONCILE_VERIFIER_HMAC: 'verifier-secret',
      GH_TOKEN: 'github-token',
      RAILWAY_RECONCILE_MUTATION_HMAC: 'mutation-secret',
    });
    assert.deepEqual(env, {
      PATH: '/runner/bin',
      RAILWAY_PROJECT_ID: 'project-1',
      RAILWAY_TOKEN: 'viewer-token',
    });
  });
});
