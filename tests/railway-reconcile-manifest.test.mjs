import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INTENT_VERSION,
  RESULT_VERSION,
  createIntentManifest,
  createResultManifest,
  validateIntentManifest,
  validateResultManifest,
} from '../scripts/railway-reconcile-manifest.mjs';

const HEAD = 'a'.repeat(40);

function intentInput(overrides = {}) {
  return {
    attemptId: 'attempt-0001',
    producer: {
      repository: 'koala73/worldmonitor',
      workflow: 'railway-deploy-trigger.yml',
      runId: '31181545167',
      runAttempt: 1,
    },
    headSha: HEAD,
    projectId: '29419572-0b0d-437f-8e71-4fa68daf514f',
    environmentId: '91a05726-0b83-4d44-a33e-6aec94e58780',
    owner: 'github-run:31181545167:1',
    recoveryAttemptId: null,
    plannedServices: [
      { service: 'seed-a', serviceId: 'svc-a', action: 'DEPLOY', reason: 'CLOSURE_CHANGED' },
      { service: 'seed-b', serviceId: 'svc-b', action: 'ADOPT', reason: 'HEAD_ALREADY_ACTIVE' },
    ],
    authorization: {
      gateContext: 'gate',
      gateState: 'success',
      gateObservedAt: '2026-08-07T10:00:00.000Z',
      mainObservedAt: '2026-08-07T10:00:01.000Z',
    },
    createdAt: '2026-08-07T10:00:02.000Z',
    ...overrides,
  };
}

function resultInput(intent, overrides = {}) {
  return {
    intent,
    outcome: 'MUTATION_COMPLETED',
    entries: [
      {
        service: 'seed-a',
        serviceId: 'svc-a',
        action: 'DEPLOY',
        outcome: 'TRIGGERED',
        deploymentId: 'dep-a',
        observedDeploymentId: null,
        reason: 'CLOSURE_CHANGED',
      },
      {
        service: 'seed-b',
        serviceId: 'svc-b',
        action: 'ADOPT',
        outcome: 'ALREADY_ACTIVE',
        deploymentId: null,
        observedDeploymentId: 'dep-b',
        reason: 'HEAD_ALREADY_ACTIVE',
      },
    ],
    createdAt: '2026-08-07T10:01:00.000Z',
    ...overrides,
  };
}

function resultFor(outcome, entries) {
  const intent = createIntentManifest(intentInput({
    plannedServices: entries.map(({ service, serviceId, action, reason }) => ({
      service, serviceId, action, reason,
    })),
  }));
  return createResultManifest(resultInput(intent, { outcome, entries }));
}

const entries = {
  triggered: {
    service: 'seed-triggered', serviceId: 'svc-triggered', action: 'DEPLOY', outcome: 'TRIGGERED',
    deploymentId: 'dep-triggered', observedDeploymentId: null, reason: 'CLOSURE_CHANGED',
  },
  active: {
    service: 'seed-active', serviceId: 'svc-active', action: 'ADOPT', outcome: 'ALREADY_ACTIVE',
    deploymentId: null, observedDeploymentId: 'dep-active', reason: 'HEAD_ALREADY_ACTIVE',
  },
  skipped: {
    service: 'seed-skipped', serviceId: 'svc-skipped', action: 'SKIP', outcome: 'SKIPPED',
    deploymentId: null, observedDeploymentId: null, reason: 'NOT_REQUIRED',
  },
  failed: {
    service: 'seed-failed', serviceId: 'svc-failed', action: 'DEPLOY', outcome: 'FAILED',
    deploymentId: null, observedDeploymentId: null, reason: 'TRIGGER_FAILED',
  },
  ambiguous: {
    service: 'seed-ambiguous', serviceId: 'svc-ambiguous', action: 'DEPLOY', outcome: 'AMBIGUOUS',
    deploymentId: null, observedDeploymentId: null, reason: 'TRIGGER_AMBIGUOUS',
  },
};

describe('Railway reconciliation intent manifest', () => {
  it('creates a deterministic digest over a closed, sorted plan', () => {
    const first = createIntentManifest(intentInput());
    const second = createIntentManifest(intentInput({
      plannedServices: [...intentInput().plannedServices].reverse(),
    }));
    assert.equal(first.version, INTENT_VERSION);
    assert.equal(first.intentDigest, second.intentDigest);
    assert.deepEqual(first.plannedServices.map((entry) => entry.service), ['seed-a', 'seed-b']);
    assert.deepEqual(validateIntentManifest(first), first);
  });

  it('rejects unknown versions, digest changes, duplicate services, and non-green authorization', () => {
    const manifest = createIntentManifest(intentInput());
    for (const changed of [
      { ...manifest, version: 'railway-reconcile-intent/v2' },
      { ...manifest, headSha: 'b'.repeat(40) },
      { ...manifest, extra: true },
      { ...manifest, authorization: { ...manifest.authorization, gateState: 'pending' } },
      { ...manifest, plannedServices: [manifest.plannedServices[0], manifest.plannedServices[0]] },
    ]) {
      assert.throws(() => validateIntentManifest(changed), /version|digest|schema|gate|duplicate|sorted/i);
    }
  });

  it('rejects token-like, terminal-control, and Markdown-injection identifiers', () => {
    for (const owner of [
      'Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'owner\n::error::forged',
      'owner<script>',
      'owner](https://evil.example)',
    ]) {
      assert.throws(() => createIntentManifest(intentInput({ owner })), /safe|identifier|token/i, owner);
    }
  });

  it('binds owner exactly to the producing GitHub run and attempt', () => {
    for (const owner of [
      'github-run:31181545167:2',
      'github-run:31181545168:1',
      'github-run:31181545167:1-extra',
    ]) {
      assert.throws(
        () => createIntentManifest(intentInput({ owner })),
        /owner.*producer|producer.*owner/i,
        owner,
      );
    }
  });
});

describe('Railway reconciliation result manifest', () => {
  it('chains the exact intent digest and validates triggered/adopted deployment evidence', () => {
    const intent = createIntentManifest(intentInput());
    const result = createResultManifest(resultInput(intent));
    assert.equal(result.version, RESULT_VERSION);
    assert.equal(result.intentDigest, intent.intentDigest);
    assert.deepEqual(validateResultManifest(result), result);
  });

  it('supports a no-mutation manifest only when no entry claims a trigger', () => {
    const intent = createIntentManifest(intentInput({
      plannedServices: [{ service: 'seed-b', serviceId: 'svc-b', action: 'ADOPT', reason: 'HEAD_ALREADY_ACTIVE' }],
    }));
    const valid = createResultManifest(resultInput(intent, {
      outcome: 'NO_MUTATION',
      entries: [{
        service: 'seed-b', serviceId: 'svc-b', action: 'ADOPT', outcome: 'ALREADY_ACTIVE',
        deploymentId: null, observedDeploymentId: 'dep-b', reason: 'HEAD_ALREADY_ACTIVE',
      }],
    }));
    assert.equal(validateResultManifest(valid).outcome, 'NO_MUTATION');
    assert.throws(() => createResultManifest(resultInput(intent, {
      outcome: 'NO_MUTATION',
      entries: [{
        service: 'seed-b', serviceId: 'svc-b', action: 'ADOPT', outcome: 'TRIGGERED',
        deploymentId: 'dep-b', observedDeploymentId: null, reason: 'CLOSURE_CHANGED',
      }],
    })), /no.mutation|trigger/i);
  });

  it('represents a fleet-wide no-op with an empty but still digest-bound plan', () => {
    const intent = createIntentManifest(intentInput({ plannedServices: [] }));
    const result = createResultManifest(resultInput(intent, {
      outcome: 'NO_MUTATION',
      entries: [],
    }));
    assert.deepEqual(result.entries, []);
    assert.equal(validateResultManifest(result).intentDigest, intent.intentDigest);
  });

  it('enforces the exact entry outcomes allowed by each top-level outcome', () => {
    for (const [outcome, validEntries] of [
      ['NO_MUTATION', [entries.active, entries.skipped]],
      ['MUTATION_COMPLETED', [entries.triggered, entries.active, entries.skipped]],
      ['MUTATION_PARTIAL', [entries.triggered, entries.failed, entries.skipped]],
      ['MUTATION_AMBIGUOUS', [entries.ambiguous]],
    ]) {
      assert.equal(resultFor(outcome, validEntries).outcome, outcome);
    }

    for (const [outcome, invalidEntries] of [
      ['NO_MUTATION', [entries.failed]],
      ['NO_MUTATION', [entries.ambiguous]],
      ['MUTATION_COMPLETED', [entries.active]],
      ['MUTATION_COMPLETED', [entries.triggered, entries.failed]],
      ['MUTATION_COMPLETED', [entries.triggered, entries.ambiguous]],
      ['MUTATION_PARTIAL', [entries.failed]],
      ['MUTATION_PARTIAL', [entries.triggered]],
      ['MUTATION_PARTIAL', [entries.triggered, entries.failed, entries.ambiguous]],
      ['MUTATION_AMBIGUOUS', [entries.triggered]],
    ]) {
      assert.throws(
        () => resultFor(outcome, invalidEntries),
        /no.mutation|mutation.completed|mutation.partial|mutation.ambiguous|trigger|failed|ambiguous/i,
        outcome,
      );
    }
  });

  it('requires and forbids deployment IDs according to each entry outcome', () => {
    const invalidEntries = [
      { ...entries.triggered, deploymentId: null },
      { ...entries.triggered, observedDeploymentId: 'dep-observed' },
      { ...entries.active, observedDeploymentId: null },
      { ...entries.active, deploymentId: 'dep-triggered' },
      { ...entries.skipped, deploymentId: 'dep-triggered' },
      { ...entries.skipped, observedDeploymentId: 'dep-observed' },
      { ...entries.failed, deploymentId: 'dep-triggered' },
      { ...entries.failed, observedDeploymentId: 'dep-observed' },
      { ...entries.ambiguous, deploymentId: 'dep-triggered' },
      { ...entries.ambiguous, observedDeploymentId: 'dep-observed' },
    ];
    for (const entry of invalidEntries) {
      assert.throws(
        () => resultFor('MUTATION_AMBIGUOUS', [entry]),
        /deployment id/i,
        `${entry.outcome}:${entry.deploymentId}:${entry.observedDeploymentId}`,
      );
    }
  });

  it('fails closed on chain mismatch, unknown outcomes, missing IDs, replayed entries, and extra fields', () => {
    const intent = createIntentManifest(intentInput());
    const result = createResultManifest(resultInput(intent));
    for (const changed of [
      { ...result, intentDigest: '0'.repeat(64) },
      { ...result, outcome: 'SORT_OF_OK' },
      { ...result, entries: [{ ...result.entries[0], deploymentId: null }, result.entries[1]] },
      { ...result, entries: [result.entries[0], result.entries[0]] },
      { ...result, rawError: 'secret provider response' },
      { ...result, resultDigest: 'f'.repeat(64) },
    ]) {
      assert.throws(() => validateResultManifest(changed), /digest|outcome|deployment|duplicate|schema/i);
    }
  });
});
