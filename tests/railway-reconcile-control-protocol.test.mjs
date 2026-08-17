import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RailwayReconcileControlClient } from '../scripts/railway-reconcile-control-client.mjs';
import {
  LEASE_DURATION_MS as RECOVERY_LEASE_DURATION_MS,
  NETWORK_CLOCK_MARGIN_MS as RECOVERY_NETWORK_CLOCK_MARGIN_MS,
  SAFETY_MARGIN_MS as RECOVERY_SAFETY_MARGIN_MS,
  TERMINATION_GRACE_MS as RECOVERY_TERMINATION_GRACE_MS,
} from '../scripts/resolve-railway-reconcile-control.mjs';
import {
  LEASE_DURATION_MS,
  NETWORK_CLOCK_MARGIN_MS,
  RailwayReconcileControl,
  SAFETY_MARGIN_MS,
  TERMINATION_GRACE_MS,
} from '../workers/railway-reconcile-control/src/index.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class FakeTransaction {
  constructor(records) { this.records = records; }
  async get(key) { return clone(this.records.get(key)); }
  async put(key, value) { this.records.set(key, clone(value)); }
  async delete(key) { this.records.delete(key); }
}

class FakeStorage extends FakeTransaction {
  constructor() {
    super(new Map());
    this.tail = Promise.resolve();
  }

  async transaction(callback) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const working = new Map([...this.records].map(([key, value]) => [key, clone(value)]));
    try {
      const result = await callback(new FakeTransaction(working));
      this.records = working;
      return result;
    } finally {
      release();
    }
  }
}

function harness() {
  const now = 1_786_100_000_000;
  const secrets = {
    mutation: 'mutation-secret-at-least-32-bytes-0001',
    verifier: 'verifier-secret-at-least-32-bytes-0001',
    watchdog: 'watchdog-secret-at-least-32-bytes-0001',
    operator: 'operator-secret-at-least-32-bytes-0001',
  };
  const control = new RailwayReconcileControl({ storage: new FakeStorage() }, {
    MUTATION_HMAC_SECRET: secrets.mutation,
    VERIFIER_HMAC_SECRET: secrets.verifier,
    WATCHDOG_HMAC_SECRET: secrets.watchdog,
    OPERATOR_HMAC_SECRET: secrets.operator,
  }, {
    now: () => now,
    randomBytes: (length) => new Uint8Array(length).fill(7),
    randomUuid: () => 'attempt-00000000-0000-4000-8000-000000000001',
  });
  let nonce = 0;
  const fetchImpl = async (url, options) => control.fetch(new Request(url, options));
  const client = (role) => new RailwayReconcileControlClient({
    baseUrl: 'https://railway-reconcile-control.worldmonitor.app',
    role,
    secret: secrets[role],
    now: () => now,
    nonce: () => `nonce-${String(++nonce).padStart(20, '0')}`,
    fetchImpl,
  });
  return { client };
}

describe('Railway reconciliation control protocol conformance', () => {
  it('keeps operator recovery timing identical to the standalone Worker contract', () => {
    assert.equal(RECOVERY_LEASE_DURATION_MS, LEASE_DURATION_MS);
    assert.equal(RECOVERY_TERMINATION_GRACE_MS, TERMINATION_GRACE_MS);
    assert.equal(RECOVERY_NETWORK_CLOCK_MARGIN_MS, NETWORK_CLOCK_MARGIN_MS);
    assert.equal(RECOVERY_SAFETY_MARGIN_MS, SAFETY_MARGIN_MS);
  });

  it('lets the shipped Node client acquire and read the shipped Durable Object', async () => {
    const { client } = harness();
    const acquired = await client('mutation').acquire({
      ownerId: 'github-run:123:1',
      headSha: 'a'.repeat(40),
      runId: '123',
      runAttempt: 1,
    });
    assert.equal(acquired.outcome, 'LEASE_GRANTED');
    assert.equal(acquired.data.attempt.state, 'LEASED');
    assert.match(acquired.data.leaseCapability, /^[A-Za-z0-9_-]{43}$/);

    const status = await client('watchdog').status();
    assert.equal(status.outcome, 'STATUS_REPORTED');
    assert.equal(status.data.currentAttempt.attemptId, acquired.data.attempt.attemptId);
    assert.equal(status.data.lease.attemptId, acquired.data.attempt.attemptId);
  });

  it('maps a Worker contention response to the closed client error', async () => {
    const { client } = harness();
    const mutation = client('mutation');
    await mutation.acquire({
      ownerId: 'github-run:123:1',
      headSha: 'a'.repeat(40),
      runId: '123',
      runAttempt: 1,
    });
    await assert.rejects(
      mutation.acquire({
        ownerId: 'github-run:124:1',
        headSha: 'a'.repeat(40),
        runId: '124',
        runAttempt: 1,
      }),
      (error) => error.code === 'LEASE_HELD' && error.status === 409,
    );
  });
});
