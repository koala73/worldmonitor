import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEASE_DURATION_MS,
  MUTATION_JOB_BUDGET_MS,
  NETWORK_CLOCK_MARGIN_MS,
  RailwayReconcileControl,
  default as worker,
  SAFETY_MARGIN_MS,
  TERMINATION_GRACE_MS,
} from './src/index.js';

const ROLE_SECRETS = {
  mutation: 'mutation-secret-32-bytes-minimum-0001',
  verifier: 'verifier-secret-32-bytes-minimum-0001',
  watchdog: 'watchdog-secret-32-bytes-minimum-0001',
  operator: 'operator-secret-32-bytes-minimum-0001',
};

const ENV = {
  MUTATION_HMAC_SECRET: ROLE_SECRETS.mutation,
  VERIFIER_HMAC_SECRET: ROLE_SECRETS.verifier,
  WATCHDOG_HMAC_SECRET: ROLE_SECRETS.watchdog,
  OPERATOR_HMAC_SECRET: ROLE_SECRETS.operator,
};

const encoder = new TextEncoder();
let nonceCounter = 0;
let operationCounter = 0;
let runCounter = 0;
const priorAuditById = new Map();
const DEFAULT_DISPATCH_SOURCE = Object.freeze({
  sourceHeadSha: 'a'.repeat(40),
  sourceRunId: '41180000000',
  sourceRunAttempt: 1,
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class FakeTransaction {
  constructor(records) {
    this.records = records;
  }

  async get(key) {
    return clone(this.records.get(key));
  }

  async put(key, value) {
    this.records.set(key, clone(value));
  }

  async delete(key) {
    this.records.delete(key);
  }
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

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key]);
  return result;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function makeControl(now = 1_800_000_000_000) {
  const clock = { now };
  const storage = new FakeStorage();
  const control = new RailwayReconcileControl(
    { storage },
    ENV,
    { now: () => clock.now },
  );
  return { clock, control, storage };
}

async function send(control, clock, path, role, body, overrides = {}) {
  const method = overrides.method || 'POST';
  const bodyText = method === 'GET' ? '' : (overrides.bodyText ?? canonicalJson(body));
  const timestamp = String(overrides.timestamp ?? Math.floor(clock.now / 1000));
  const nonce = overrides.nonce || `nonce-${String(++nonceCounter).padStart(20, '0')}`;
  const bodyDigest = await sha256Hex(bodyText);
  const canonical = `${method}\n${path}\n${bodyDigest}\n${timestamp}\n${nonce}`;
  const secret = overrides.secret || ROLE_SECRETS[role];
  const signature = await hmacHex(secret, canonical);
  return control.fetch(new Request(`https://control.test${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      'x-wm-control-role': overrides.roleHeader || role,
      'x-wm-control-version': overrides.headerVersion || '1',
      'x-wm-control-timestamp': timestamp,
      'x-wm-control-nonce': nonce,
      'x-wm-control-signature': signature,
    },
    ...(method === 'GET' ? {} : { body: bodyText }),
  }));
}

async function responseBody(response) {
  const envelope = await response.json();
  assert.equal(envelope.version, 1);
  assert.equal(typeof envelope.ok, 'boolean');
  assert.match(envelope.outcome, /^[A-Z][A-Z0-9_]{0,63}$/);
  if (envelope.ok) {
    assert.deepEqual(Object.keys(envelope).sort(), ['data', 'ok', 'outcome', 'version']);
    assert.equal(typeof envelope.data, 'object');
    return envelope.data;
  }
  assert.deepEqual(Object.keys(envelope).sort(), ['error', 'ok', 'outcome', 'version']);
  assert.deepEqual(Object.keys(envelope.error).sort(), ['code', 'message']);
  assert.equal(envelope.outcome, envelope.error.code);
  assert.ok(envelope.error.message.length >= 1 && envelope.error.message.length <= 240);
  assert.doesNotMatch(envelope.error.message, /[\u0000-\u001f\u007f]/);
  return envelope;
}

function getStatus(control, clock) {
  return send(
    control,
    clock,
    '/v1/watchdog/status',
    'watchdog',
    null,
    { method: 'GET' },
  );
}

async function acquireLease(control, clock, overrides = {}) {
  const runId = overrides.runId || String(31_180_000_000 + (++runCounter));
  const runAttempt = overrides.runAttempt || 1;
  const response = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: `github-run:${runId}:${runAttempt}`,
    headSha: overrides.headSha || 'b'.repeat(40),
    ...(overrides.recoveryAttemptId ? { recoveryAttemptId: overrides.recoveryAttemptId } : {}),
    runId,
    runAttempt,
  });
  assert.equal(response.status, 201);
  const data = await responseBody(response);
  priorAuditById.set(data.attempt.attemptId, data.attempt);
  return data;
}

function operatorRequest(priorId, expectedHead, decision, overrides = {}) {
  const prior = priorAuditById.get(priorId);
  const targetRunId = overrides.targetRunId !== undefined
    ? overrides.targetRunId
    : (prior?.runId ?? null);
  const targetRunAttempt = overrides.targetRunAttempt !== undefined
    ? overrides.targetRunAttempt
    : (prior?.runAttempt ?? null);
  const targetHead = overrides.targetHead !== undefined
    ? overrides.targetHead
    : (targetRunId === null ? null : (prior?.headSha ?? expectedHead));
  const intentDigest = overrides.intentDigest !== undefined
    ? overrides.intentDigest
    : (decision === 'accept_observed_convergence' ? 'e'.repeat(64) : null);
  return {
    version: 1,
    operationId: (++operationCounter).toString(16).padStart(64, '0'),
    priorId,
    priorCreatedAt: prior
      ? new Date(prior.createdAt).toISOString()
      : new Date(1_800_000_000_000).toISOString(),
    expectedHead,
    decision,
    actor: 'oncall-engineer',
    approver: 'production-approver',
    reason: 'Reviewed exact production evidence and approved this resolution.',
    evidenceDigest: 'f'.repeat(64),
    intentDigest,
    triggeringActor: 'triggering-engineer',
    operatorRunId: '40000000001',
    operatorRunAttempt: 1,
    evidenceId: 'operator-evidence-0001',
    runEvidenceId: 'github-run-evidence-0001',
    environmentEvidenceId: 'breakglass-review-evidence-0001',
    gateStatusId: '99',
    gateUpdatedAt: '2026-08-07T11:59:00.000Z',
    targetRunId,
    targetRunAttempt,
    targetHead,
    ...overrides,
  };
}

async function turnLeaseIntoManualBarrier(control, clock, lease) {
  const { headSha } = lease.attempt;
  const ownerFields = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    ownerId: lease.attempt.ownerId,
    leaseCapability: lease.leaseCapability,
    headSha,
  };
  const intentDigest = 'e'.repeat(64);
  assert.equal((await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/start', 'mutation', {
    ...ownerFields,
    intentDigest,
    minTtlMs: 10 * 60 * 1000,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/release', 'mutation', ownerFields)).status, 200);
  assert.equal((await send(control, clock, '/v1/verifier/fail', 'verifier', {
    version: 1,
    attemptId: lease.attempt.attemptId,
    headSha,
    intentDigest,
    reason: 'TERMINAL_FAILURE',
  })).status, 200);
  return lease;
}

async function createManualBarrier(
  control,
  clock,
  { headSha, recoveryAttemptId, runId, runAttempt },
) {
  const lease = await acquireLease(control, clock, {
    headSha,
    recoveryAttemptId,
    runId,
    runAttempt,
  });
  return turnLeaseIntoManualBarrier(control, clock, lease);
}

test('fixed lease exceeds the complete mutation lifetime budget', () => {
  assert.equal(LEASE_DURATION_MS, 30 * 60 * 1000);
  assert.equal(MUTATION_JOB_BUDGET_MS, 13 * 60 * 1000);
  assert.equal(TERMINATION_GRACE_MS, 5 * 60 * 1000);
  assert.equal(NETWORK_CLOCK_MARGIN_MS, 60 * 1000);
  assert.equal(SAFETY_MARGIN_MS, 6 * 60 * 1000);
  assert.ok(
    LEASE_DURATION_MS
      > MUTATION_JOB_BUDGET_MS
        + TERMINATION_GRACE_MS
        + NETWORK_CLOCK_MARGIN_MS
        + SAFETY_MARGIN_MS,
  );
});

test('Worker derives its only Durable Object ID from immutable CONTROL_SCOPE', async () => {
  const names = [];
  const ids = [];
  const namespace = {
    idFromName(name) {
      names.push(name);
      return `id:${name}`;
    },
    get(id) {
      ids.push(id);
      return { fetch: async () => Response.json({ ok: true }) };
    },
  };
  const env = {
    CONTROL_SCOPE: 'worldmonitor/railway-production',
    RAILWAY_RECONCILE_CONTROL: namespace,
  };

  for (const requestedScope of ['attacker/one', 'attacker/two']) {
    const response = await worker.fetch(new Request(
      'https://railway-reconcile-control.worldmonitor.app/v1/mutation/acquire',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, scope: requestedScope }),
      },
    ), env);
    assert.equal(response.status, 200);
  }

  assert.deepEqual(names, [
    'worldmonitor/railway-production',
    'worldmonitor/railway-production',
  ]);
  assert.deepEqual(ids, [
    'id:worldmonitor/railway-production',
    'id:worldmonitor/railway-production',
  ]);
});

test('outer Worker version probe exposes only deployment identity without claiming readiness', async () => {
  let objectLookups = 0;
  const response = await worker.fetch(new Request(
    'https://railway-reconcile-control.worldmonitor.app/version',
  ), {
    CONTROL_SCOPE: 'worldmonitor/railway-production',
    DEPLOYMENT_SHA: 'a'.repeat(40),
    RAILWAY_RECONCILE_CONTROL: {
      idFromName() { objectLookups += 1; return 'forbidden'; },
      get() { objectLookups += 1; return { fetch: async () => new Response() }; },
    },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), {
    protocolVersion: 1,
    deploymentSha: 'a'.repeat(40),
  });
  assert.equal(objectLookups, 0);
});

test('control object rejects a streaming oversized body without buffering it all', async () => {
  const { control } = makeControl();
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(9 * 1024));
      if (pulls === 3) controller.close();
    },
  });
  const request = new Request('https://railway-reconcile-control.worldmonitor.app/v1/mutation/acquire', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  });
  assert.equal(request.headers.has('content-length'), false);
  const response = await control.fetch(request);
  assert.equal(response.status, 413);
  assert.equal((await responseBody(response)).error.code, 'REQUEST_TOO_LARGE');
  assert.equal(pulls, 2);
});

test('concurrent acquire requests create exactly one LEASED generation', async () => {
  const { clock, control } = makeControl();
  const [first, second] = await Promise.all([
    send(control, clock, '/v1/mutation/acquire', 'mutation', {
      version: 1,
      ownerId: 'github-run:31180000100:1',
      headSha: 'a'.repeat(40),
      runId: '31180000100',
      runAttempt: 1,
    }),
    send(control, clock, '/v1/mutation/acquire', 'mutation', {
      version: 1,
      ownerId: 'github-run:31180000101:1',
      headSha: 'a'.repeat(40),
      runId: '31180000101',
      runAttempt: 1,
    }),
  ]);

  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  const winner = first.status === 201 ? await responseBody(first) : await responseBody(second);
  const loser = first.status === 409 ? await responseBody(first) : await responseBody(second);
  assert.equal(winner.attempt.state, 'LEASED');
  assert.equal(winner.attempt.generation, 1);
  assert.equal(winner.leaseExpiresAt, clock.now + 30 * 60 * 1000);
  assert.match(winner.leaseCapability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(loser.error.code, 'LEASE_HELD');

  const status = await getStatus(control, clock);
  assert.equal(status.status, 200);
  const snapshot = await responseBody(status);
  assert.equal(snapshot.lease.attemptId, winner.attempt.attemptId);
  assert.equal(snapshot.currentAttempt.state, 'LEASED');
  assert.equal(snapshot.barrier, null);
});

test('every acquire binds the exact GitHub run identity while ordinary runs need no recovery ID', async () => {
  for (const body of [
    {
      version: 1,
      ownerId: 'github-run:31180000001:1',
      headSha: 'a'.repeat(40),
    },
    {
      version: 1,
      ownerId: 'github-run:31180000001:1',
      headSha: 'a'.repeat(40),
      runId: '31180000001',
    },
    {
      version: 1,
      ownerId: 'github-run:31180000001:1',
      headSha: 'a'.repeat(40),
      runId: '31180000001',
      runAttempt: 2,
    },
  ]) {
    const { clock, control } = makeControl();
    const response = await send(control, clock, '/v1/mutation/acquire', 'mutation', body);
    assert.equal(response.status, 400);
  }

  const { clock, control } = makeControl();
  const acquired = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: 'github-run:31180000001:2',
    headSha: 'a'.repeat(40),
    runId: '31180000001',
    runAttempt: 2,
  });
  assert.equal(acquired.status, 201);
  const data = await responseBody(acquired);
  assert.equal(data.attempt.ownerId, 'github-run:31180000001:2');
  assert.equal(data.attempt.runId, '31180000001');
  assert.equal(data.attempt.runAttempt, 2);
  assert.equal(data.attempt.recoveryAttemptId, null);
});

test('prepare binds immutable intent and only the owner capability can release', async () => {
  const { clock, control } = makeControl();
  const lease = await acquireLease(control, clock);
  const ownerFields = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    ownerId: lease.attempt.ownerId,
    leaseCapability: lease.leaseCapability,
    headSha: lease.attempt.headSha,
  };
  const intentDigest = '1'.repeat(64);

  const wrongOwner = await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    ownerId: 'github-run-attacker-job-1',
    intentDigest,
  });
  assert.equal(wrongOwner.status, 403);
  assert.equal((await responseBody(wrongOwner)).error.code, 'LEASE_OWNER_MISMATCH');

  const prepared = await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest,
  });
  assert.equal(prepared.status, 200);
  assert.equal((await responseBody(prepared)).attempt.state, 'PREPARED');

  const rebound = await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest: '2'.repeat(64),
  });
  assert.equal(rebound.status, 409);
  assert.equal((await responseBody(rebound)).error.code, 'INVALID_ATTEMPT_TRANSITION');

  const nonOwnerRelease = await send(control, clock, '/v1/mutation/release', 'mutation', {
    ...ownerFields,
    ownerId: 'github-run-attacker-job-1',
  });
  assert.equal(nonOwnerRelease.status, 403);
  assert.equal((await responseBody(nonOwnerRelease)).error.code, 'LEASE_OWNER_MISMATCH');

  const wrongCapability = await send(control, clock, '/v1/mutation/assert', 'mutation', {
    ...ownerFields,
    leaseCapability: `${ownerFields.leaseCapability.slice(0, -1)}${ownerFields.leaseCapability.endsWith('A') ? 'B' : 'A'}`,
    minTtlMs: 1,
  });
  assert.equal(wrongCapability.status, 403);
  assert.equal((await responseBody(wrongCapability)).error.code, 'LEASE_CAPABILITY_MISMATCH');

  const released = await send(control, clock, '/v1/mutation/release', 'mutation', ownerFields);
  assert.equal(released.status, 200);
  assert.equal((await responseBody(released)).attempt.state, 'PRE_MUTATION_ABORTED');

  const status = await getStatus(control, clock);
  const snapshot = await responseBody(status);
  assert.equal(snapshot.lease, null);
  assert.equal(snapshot.currentAttempt.state, 'PRE_MUTATION_ABORTED');
  assert.equal(snapshot.barrier, null);
});

test('owner assertions enforce minimum TTL and expired PREPARED leases are superseded', async () => {
  const { clock, control } = makeControl();
  const first = await acquireLease(control, clock, {
    headSha: 'c'.repeat(40),
  });
  const ownerFields = {
    version: 1,
    attemptId: first.attempt.attemptId,
    ownerId: first.attempt.ownerId,
    leaseCapability: first.leaseCapability,
    headSha: first.attempt.headSha,
  };
  const intentDigest = '3'.repeat(64);
  const prepared = await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest,
  });
  assert.equal(prepared.status, 200);

  const asserted = await send(control, clock, '/v1/mutation/assert', 'mutation', {
    ...ownerFields,
    minTtlMs: 2 * 60 * 1000,
  });
  assert.equal(asserted.status, 200);

  clock.now = first.leaseExpiresAt - 60 * 1000;
  const insufficient = await send(control, clock, '/v1/mutation/assert', 'mutation', {
    ...ownerFields,
    minTtlMs: 2 * 60 * 1000,
  });
  assert.equal(insufficient.status, 409);
  assert.equal((await responseBody(insufficient)).error.code, 'LEASE_TTL_INSUFFICIENT');

  clock.now = first.leaseExpiresAt + 1;
  const second = await acquireLease(control, clock, {
    headSha: 'd'.repeat(40),
  });
  assert.equal(second.attempt.generation, 2);
  assert.notEqual(second.attempt.attemptId, first.attempt.attemptId);

  assert.equal(second.supersededAttempt.state, 'PRE_MUTATION_ABORTED');
  assert.equal(second.supersededAttempt.closedReason, 'LEASE_EXPIRED');
  assert.deepEqual(second.attempt.supersededRuns, []);
});

test('automatic acquisition does not add an already released pre-mutation run to lineage', async () => {
  const { clock, control } = makeControl();
  const first = await acquireLease(control, clock, {
    headSha: 'c'.repeat(40),
    runId: '31180000601',
    runAttempt: 2,
  });
  const released = await send(control, clock, '/v1/mutation/release', 'mutation', {
    version: 1,
    attemptId: first.attempt.attemptId,
    ownerId: first.attempt.ownerId,
    leaseCapability: first.leaseCapability,
    headSha: first.attempt.headSha,
  });
  assert.equal(released.status, 200);
  assert.equal((await responseBody(released)).attempt.state, 'PRE_MUTATION_ABORTED');

  const second = await acquireLease(control, clock, {
    headSha: 'd'.repeat(40),
    runId: '31180000602',
    runAttempt: 1,
  });
  assert.deepEqual(second.attempt.supersededRuns, []);
});

test('one GitHub run cannot renew its fixed lease by acquiring again', async () => {
  for (const closeMode of ['expired', 'released']) {
    const { clock, control } = makeControl();
    const identity = { runId: '31180000650', runAttempt: 3 };
    const first = await acquireLease(control, clock, {
      headSha: 'c'.repeat(40),
      ...identity,
    });
    if (closeMode === 'expired') {
      clock.now = first.leaseExpiresAt + 1;
    } else {
      assert.equal((await send(control, clock, '/v1/mutation/release', 'mutation', {
        version: 1,
        attemptId: first.attempt.attemptId,
        ownerId: first.attempt.ownerId,
        leaseCapability: first.leaseCapability,
        headSha: first.attempt.headSha,
      })).status, 200);
    }

    const repeated = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
      version: 1,
      ownerId: `github-run:${identity.runId}:${identity.runAttempt}`,
      headSha: 'd'.repeat(40),
      ...identity,
    });
    assert.equal(repeated.status, 409, closeMode);
    assert.equal((await responseBody(repeated)).error.code, 'RUN_ALREADY_ACQUIRED', closeMode);
  }

  const { clock, control } = makeControl();
  const firstIdentity = { runId: '31180000651', runAttempt: 1 };
  const first = await acquireLease(control, clock, {
    headSha: 'e'.repeat(40),
    ...firstIdentity,
  });
  assert.equal((await send(control, clock, '/v1/mutation/release', 'mutation', {
    version: 1,
    attemptId: first.attempt.attemptId,
    ownerId: first.attempt.ownerId,
    leaseCapability: first.leaseCapability,
    headSha: first.attempt.headSha,
  })).status, 200);
  const second = await acquireLease(control, clock, {
    headSha: 'f'.repeat(40),
    runId: '31180000652',
    runAttempt: 1,
  });
  assert.equal((await send(control, clock, '/v1/mutation/release', 'mutation', {
    version: 1,
    attemptId: second.attempt.attemptId,
    ownerId: second.attempt.ownerId,
    leaseCapability: second.leaseCapability,
    headSha: second.attempt.headSha,
  })).status, 200);
  const replayedOldRun = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: `github-run:${firstIdentity.runId}:${firstIdentity.runAttempt}`,
    headSha: '0'.repeat(40),
    ...firstIdentity,
  });
  assert.equal(replayedOldRun.status, 409);
  assert.equal((await responseBody(replayedOldRun)).error.code, 'RUN_ALREADY_ACQUIRED');
});

test('pre-mutation churn remains acquirable beyond the mutation-lineage limit', async () => {
  const { clock, control } = makeControl();
  let lease = await acquireLease(control, clock, {
    headSha: 'c'.repeat(40),
    runId: '31180000700',
    runAttempt: 1,
  });

  for (let index = 1; index <= 65; index += 1) {
    const released = await send(control, clock, '/v1/mutation/release', 'mutation', {
      version: 1,
      attemptId: lease.attempt.attemptId,
      ownerId: lease.attempt.ownerId,
      leaseCapability: lease.leaseCapability,
      headSha: lease.attempt.headSha,
    });
    assert.equal(released.status, 200);
    lease = await acquireLease(control, clock, {
      headSha: 'c'.repeat(40),
      runId: String(31_180_000_700 + index),
      runAttempt: 1,
    });
  }

  assert.deepEqual(lease.attempt.supersededRuns, []);
});

test('MUTATION_STARTED raises a global barrier that release and expiry cannot clear', async () => {
  const { clock, control } = makeControl();
  const lease = await acquireLease(control, clock, {
    headSha: 'e'.repeat(40),
  });
  const ownerFields = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    ownerId: lease.attempt.ownerId,
    leaseCapability: lease.leaseCapability,
    headSha: lease.attempt.headSha,
  };
  const intentDigest = '4'.repeat(64);
  const resultDigest = '5'.repeat(64);
  assert.equal((await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest,
  })).status, 200);

  const started = await send(control, clock, '/v1/mutation/start', 'mutation', {
    ...ownerFields,
    intentDigest,
    minTtlMs: 10 * 60 * 1000,
  });
  assert.equal(started.status, 200);
  assert.equal((await responseBody(started)).attempt.state, 'MUTATION_STARTED');

  const bound = await send(control, clock, '/v1/mutation/bind-result', 'mutation', {
    ...ownerFields,
    intentDigest,
    resultKind: 'MUTATED',
    resultDigest,
    minTtlMs: 1,
  });
  assert.equal(bound.status, 200);
  assert.equal((await responseBody(bound)).attempt.resultKind, 'MUTATED');

  const released = await send(control, clock, '/v1/mutation/release', 'mutation', ownerFields);
  assert.equal(released.status, 200);
  const releasedBody = await responseBody(released);
  assert.equal(releasedBody.attempt.state, 'MUTATION_STARTED');

  clock.now = lease.leaseExpiresAt + 1;
  const blocked = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: 'github-run:31180000401:1',
    headSha: 'f'.repeat(40),
    runId: '31180000401',
    runAttempt: 1,
  });
  assert.equal(blocked.status, 423);
  assert.equal((await responseBody(blocked)).error.code, 'MUTATION_BARRIER_ACTIVE');

  const status = await getStatus(control, clock);
  const snapshot = await responseBody(status);
  assert.equal(snapshot.lease, null);
  assert.equal(snapshot.currentAttempt.state, 'MUTATION_STARTED');
  assert.equal(snapshot.barrier.attemptId, lease.attempt.attemptId);
  assert.equal(snapshot.barrier.headSha, 'e'.repeat(40));
});

test('no-mutation acceptance requires exact digests, refreshes lastAccepted, and raises no barrier', async () => {
  const { clock, control } = makeControl();
  const lease = await acquireLease(control, clock, {
    headSha: '1'.repeat(40),
  });
  const ownerFields = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    ownerId: lease.attempt.ownerId,
    leaseCapability: lease.leaseCapability,
    headSha: lease.attempt.headSha,
  };
  const intentDigest = '6'.repeat(64);
  const resultDigest = '7'.repeat(64);
  assert.equal((await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/bind-result', 'mutation', {
    ...ownerFields,
    intentDigest,
    resultKind: 'NO_MUTATION',
    resultDigest,
    minTtlMs: 1,
  })).status, 200);
  const abortPendingVerification = await send(
    control,
    clock,
    '/v1/mutation/abort',
    'mutation',
    { ...ownerFields, reason: 'MAIN_MOVED' },
  );
  assert.equal(abortPendingVerification.status, 409);
  assert.equal(
    (await responseBody(abortPendingVerification)).error.code,
    'VERIFICATION_PENDING',
  );
  assert.equal((await send(
    control,
    clock,
    '/v1/mutation/release',
    'mutation',
    ownerFields,
  )).status, 200);

  const pending = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: 'github-run:31180000501:1',
    headSha: '2'.repeat(40),
    runId: '31180000501',
    runAttempt: 1,
  });
  assert.equal(pending.status, 409);
  assert.equal((await responseBody(pending)).error.code, 'VERIFICATION_PENDING');

  const mismatch = await send(control, clock, '/v1/verifier/accept', 'verifier', {
    version: 1,
    attemptId: lease.attempt.attemptId,
    headSha: lease.attempt.headSha,
    intentDigest,
    resultDigest: '8'.repeat(64),
  });
  assert.equal(mismatch.status, 409);
  assert.equal((await responseBody(mismatch)).error.code, 'RESULT_DIGEST_MISMATCH');

  clock.now += 30_000;
  const accepted = await send(control, clock, '/v1/verifier/accept', 'verifier', {
    version: 1,
    attemptId: lease.attempt.attemptId,
    headSha: lease.attempt.headSha,
    intentDigest,
    resultDigest,
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = await responseBody(accepted);
  assert.equal(acceptedBody.attempt.state, 'TERMINAL_ACCEPTED');
  assert.equal(acceptedBody.barrier, null);
  assert.equal(acceptedBody.lastAccepted.acceptedAt, clock.now);
  assert.equal(acceptedBody.lastAccepted.resultKind, 'NO_MUTATION');
  assert.deepEqual(acceptedBody.lastAccepted.supersededRuns, []);

  const status = await getStatus(control, clock);
  const snapshot = await responseBody(status);
  assert.equal(snapshot.currentAttempt.state, 'TERMINAL_ACCEPTED');
  assert.equal(snapshot.lastAccepted.attemptId, lease.attempt.attemptId);
  assert.equal(snapshot.barrier, null);
});

test('expired PREPARED NO_MUTATION remains verification-pending and is never superseded', async () => {
  const { clock, control } = makeControl();
  const lease = await acquireLease(control, clock, {
    headSha: '2'.repeat(40),
    runId: '31180000002',
    runAttempt: 1,
  });
  const ownerFields = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    ownerId: lease.attempt.ownerId,
    leaseCapability: lease.leaseCapability,
    headSha: lease.attempt.headSha,
  };
  const intentDigest = '8'.repeat(64);
  const resultDigest = '9'.repeat(64);
  assert.equal((await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/bind-result', 'mutation', {
    ...ownerFields,
    intentDigest,
    resultKind: 'NO_MUTATION',
    resultDigest,
    minTtlMs: 1,
  })).status, 200);

  clock.now = lease.leaseExpiresAt + 1;
  const held = await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId: 'recovery-verification-pending',
    headSha: '3'.repeat(40),
  });
  assert.equal(held.status, 409);
  assert.equal((await responseBody(held)).error.code, 'VERIFICATION_PENDING');

  const successor = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: 'github-run:31180000003:1',
    headSha: '3'.repeat(40),
    runId: '31180000003',
    runAttempt: 1,
  });
  assert.equal(successor.status, 409);
  assert.equal((await responseBody(successor)).error.code, 'VERIFICATION_PENDING');

  const snapshot = await responseBody(await getStatus(control, clock));
  assert.equal(snapshot.generation, lease.attempt.generation);
  assert.equal(snapshot.currentAttempt.attemptId, lease.attempt.attemptId);
  assert.equal(snapshot.currentAttempt.state, 'PREPARED');
  assert.equal(snapshot.currentAttempt.resultKind, 'NO_MUTATION');
  assert.equal(snapshot.currentAttempt.closedReason, null);
  assert.deepEqual(snapshot.dispatchHolds, []);
});

test('verifier acceptance is idempotent after a lost success response', async () => {
  const { clock, control } = makeControl();
  const lease = await acquireLease(control, clock, {
    headSha: '6'.repeat(40),
  });
  const ownerFields = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    ownerId: lease.attempt.ownerId,
    leaseCapability: lease.leaseCapability,
    headSha: lease.attempt.headSha,
  };
  const intentDigest = '7'.repeat(64);
  const resultDigest = '8'.repeat(64);
  assert.equal((await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/bind-result', 'mutation', {
    ...ownerFields,
    intentDigest,
    resultKind: 'NO_MUTATION',
    resultDigest,
    minTtlMs: 1,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/release', 'mutation', ownerFields)).status, 200);
  const body = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    headSha: lease.attempt.headSha,
    intentDigest,
    resultDigest,
  };
  const first = await send(control, clock, '/v1/verifier/accept', 'verifier', body);
  const replay = await send(control, clock, '/v1/verifier/accept', 'verifier', body);
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual(await responseBody(replay), await responseBody(first));
});

test('accepted replay reports a barrier raised by a later generation', async () => {
  const { clock, control, storage } = makeControl();
  const lease = await acquireLease(control, clock, { headSha: '6'.repeat(40) });
  const ownerFields = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    ownerId: lease.attempt.ownerId,
    leaseCapability: lease.leaseCapability,
    headSha: lease.attempt.headSha,
  };
  const intentDigest = '7'.repeat(64);
  const resultDigest = '8'.repeat(64);
  assert.equal((await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/bind-result', 'mutation', {
    ...ownerFields,
    intentDigest,
    resultKind: 'NO_MUTATION',
    resultDigest,
    minTtlMs: 1,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/release', 'mutation', ownerFields)).status, 200);
  const body = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    headSha: lease.attempt.headSha,
    intentDigest,
    resultDigest,
  };
  assert.equal((await send(control, clock, '/v1/verifier/accept', 'verifier', body)).status, 200);
  const meta = storage.records.get('control-meta:v1');
  meta.barrier = {
    version: 1,
    attemptId: 'later-barrier-attempt-0001',
    generation: meta.generation + 1,
    headSha: '9'.repeat(40),
    intentDigest: 'a'.repeat(64),
    raisedAt: clock.now + 1,
  };
  storage.records.set('control-meta:v1', meta);

  const replay = await responseBody(await send(
    control,
    clock,
    '/v1/verifier/accept',
    'verifier',
    body,
  ));
  assert.equal(replay.barrier.attemptId, 'later-barrier-attempt-0001');
});

test('owner abort closes only a positively pre-mutation attempt', async () => {
  const { clock, control } = makeControl();
  const lease = await acquireLease(control, clock, {
    headSha: '0'.repeat(40),
  });
  const ownerFields = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    ownerId: lease.attempt.ownerId,
    leaseCapability: lease.leaseCapability,
    headSha: lease.attempt.headSha,
  };
  assert.equal((await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest: '0'.repeat(64),
  })).status, 200);
  const aborted = await send(control, clock, '/v1/mutation/abort', 'mutation', {
    ...ownerFields,
    reason: 'MAIN_MOVED',
  });
  assert.equal(aborted.status, 200);
  const abortedData = await responseBody(aborted);
  assert.equal(abortedData.attempt.state, 'PRE_MUTATION_ABORTED');
  assert.equal(abortedData.attempt.closedReason, 'MAIN_MOVED');
  assert.equal((await responseBody(await getStatus(control, clock))).lease, null);
});

test('mutated acceptance clears only its exact matching global barrier', async () => {
  const { clock, control } = makeControl();
  const lease = await acquireLease(control, clock, {
    headSha: '2'.repeat(40),
  });
  const ownerFields = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    ownerId: lease.attempt.ownerId,
    leaseCapability: lease.leaseCapability,
    headSha: lease.attempt.headSha,
  };
  const intentDigest = '9'.repeat(64);
  const resultDigest = 'a'.repeat(64);
  assert.equal((await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest,
  })).status, 200);

  const premature = await send(control, clock, '/v1/mutation/bind-result', 'mutation', {
    ...ownerFields,
    intentDigest,
    resultKind: 'MUTATED',
    resultDigest,
    minTtlMs: 1,
  });
  assert.equal(premature.status, 409);
  assert.equal((await responseBody(premature)).error.code, 'INVALID_ATTEMPT_TRANSITION');

  assert.equal((await send(control, clock, '/v1/mutation/start', 'mutation', {
    ...ownerFields,
    intentDigest,
    minTtlMs: 10 * 60 * 1000,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/bind-result', 'mutation', {
    ...ownerFields,
    intentDigest,
    resultKind: 'MUTATED',
    resultDigest,
    minTtlMs: 1,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/release', 'mutation', ownerFields)).status, 200);

  const mismatch = await send(control, clock, '/v1/verifier/accept', 'verifier', {
    version: 1,
    attemptId: lease.attempt.attemptId,
    headSha: lease.attempt.headSha,
    intentDigest,
    resultDigest: 'b'.repeat(64),
  });
  assert.equal(mismatch.status, 409);
  assert.equal((await responseBody(mismatch)).error.code, 'RESULT_DIGEST_MISMATCH');
  assert.notEqual((await responseBody(await getStatus(control, clock))).barrier, null);

  const accepted = await send(control, clock, '/v1/verifier/accept', 'verifier', {
    version: 1,
    attemptId: lease.attempt.attemptId,
    headSha: lease.attempt.headSha,
    intentDigest,
    resultDigest,
  });
  const acceptedData = await responseBody(accepted);
  assert.equal(accepted.status, 200);
  assert.equal(acceptedData.attempt.state, 'TERMINAL_ACCEPTED');
  assert.equal(acceptedData.barrier, null);

  const next = await acquireLease(control, clock, {
    headSha: '3'.repeat(40),
  });
  assert.equal(next.attempt.generation, 2);
});

test('exact verifier proof can retire only an expired lease after a lost owner release', async () => {
  const { clock, control } = makeControl();
  const lease = await acquireLease(control, clock, {
    headSha: 'd'.repeat(40),
  });
  const ownerFields = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    ownerId: lease.attempt.ownerId,
    leaseCapability: lease.leaseCapability,
    headSha: lease.attempt.headSha,
  };
  const intentDigest = 'd'.repeat(64);
  const resultDigest = 'e'.repeat(64);
  assert.equal((await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/start', 'mutation', {
    ...ownerFields,
    intentDigest,
    minTtlMs: 10 * 60 * 1000,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/bind-result', 'mutation', {
    ...ownerFields,
    intentDigest,
    resultKind: 'MUTATED',
    resultDigest,
    minTtlMs: 1,
  })).status, 200);

  const stillActive = await send(control, clock, '/v1/verifier/accept', 'verifier', {
    version: 1,
    attemptId: lease.attempt.attemptId,
    headSha: lease.attempt.headSha,
    intentDigest,
    resultDigest,
  });
  assert.equal(stillActive.status, 409);
  assert.equal((await responseBody(stillActive)).error.code, 'LEASE_STILL_ACTIVE');
  assert.notEqual((await responseBody(await getStatus(control, clock))).barrier, null);

  clock.now = lease.leaseExpiresAt + 1;
  const accepted = await send(control, clock, '/v1/verifier/accept', 'verifier', {
    version: 1,
    attemptId: lease.attempt.attemptId,
    headSha: lease.attempt.headSha,
    intentDigest,
    resultDigest,
  });
  assert.equal(accepted.status, 200);
  const snapshot = await responseBody(await getStatus(control, clock));
  assert.equal(snapshot.lease, null);
  assert.equal(snapshot.currentAttempt.state, 'TERMINAL_ACCEPTED');
  assert.equal(snapshot.barrier, null);
});

test('deterministic verifier contract failure records MANUAL_REQUIRED and preserves the barrier', async () => {
  const { clock, control } = makeControl();
  const lease = await acquireLease(control, clock, {
    headSha: '4'.repeat(40),
  });
  const ownerFields = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    ownerId: lease.attempt.ownerId,
    leaseCapability: lease.leaseCapability,
    headSha: lease.attempt.headSha,
  };
  const intentDigest = 'c'.repeat(64);
  assert.equal((await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/start', 'mutation', {
    ...ownerFields,
    intentDigest,
    minTtlMs: 10 * 60 * 1000,
  })).status, 200);
  clock.now = lease.leaseExpiresAt + 1;

  const failed = await send(control, clock, '/v1/verifier/fail', 'verifier', {
    version: 1,
    attemptId: lease.attempt.attemptId,
    headSha: lease.attempt.headSha,
    intentDigest,
    reason: 'VERIFIER_CONTRACT_FAILURE',
  });
  assert.equal(failed.status, 200);
  const failedData = await responseBody(failed);
  assert.equal(failedData.attempt.state, 'MANUAL_REQUIRED');
  assert.equal(failedData.attempt.closedReason, 'VERIFIER_CONTRACT_FAILURE');
  assert.equal(failedData.barrier.attemptId, lease.attempt.attemptId);
  assert.equal((await responseBody(await getStatus(control, clock))).lease, null);

  clock.now = lease.leaseExpiresAt + 24 * 60 * 60 * 1000;
  const blocked = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: 'github-run:31180000701:1',
    headSha: '5'.repeat(40),
    runId: '31180000701',
    runAttempt: 1,
  });
  assert.equal(blocked.status, 423);
  assert.equal((await responseBody(blocked)).error.code, 'MUTATION_BARRIER_ACTIVE');
});

test('dispatch holds never age out and require an exact RUN_BOUND recovery to consume them', async () => {
  const { clock, control } = makeControl();
  const recoveryAttemptId = 'recovery-00000001';
  const headSha = '6'.repeat(40);
  const held = await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha,
  });
  assert.equal(held.status, 201);
  const heldData = await responseBody(held);
  assert.equal(heldData.dispatchHold.state, 'DISPATCH_HELD');
  assert.equal(heldData.dispatchHold.failedHeadRetryAuthorized, false);

  clock.now += 7 * 24 * 60 * 60 * 1000;
  const blocked = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: 'github-run:31180000800:1',
    headSha,
    runId: '31180000800',
    runAttempt: 1,
  });
  assert.equal(blocked.status, 409);
  assert.equal((await responseBody(blocked)).error.code, 'DISPATCH_HOLD_ACTIVE');
  const heldStatus = await responseBody(await getStatus(control, clock));
  assert.equal(heldStatus.dispatchHolds.length, 1);
  assert.equal(heldStatus.dispatchHolds[0].state, 'DISPATCH_HELD');

  const wrongRun = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: 'github-run:31190000002:1',
    headSha,
    recoveryAttemptId: 'recovery-00000999',
    runId: '31190000002',
    runAttempt: 1,
  });
  assert.equal(wrongRun.status, 409);
  assert.equal((await responseBody(wrongRun)).error.code, 'DISPATCH_HOLD_ACTIVE');

  const unboundRecovery = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: 'github-run:31190000001:1',
    headSha,
    recoveryAttemptId,
    runId: '31190000001',
    runAttempt: 1,
  });
  assert.equal(unboundRecovery.status, 409);
  assert.equal((await responseBody(unboundRecovery)).error.code, 'DISPATCH_HOLD_ACTIVE');

  const bound = await send(control, clock, '/v1/watchdog/bind-run', 'watchdog', {
    version: 1,
    recoveryAttemptId,
    headSha,
    runId: '31190000001',
    runAttempt: 1,
  });
  assert.equal(bound.status, 200);
  assert.equal((await responseBody(bound)).dispatchHold.state, 'RUN_BOUND');

  const lease = await acquireLease(control, clock, {
    headSha,
    recoveryAttemptId,
    runId: '31190000001',
  });
  assert.equal(lease.dispatchHold.state, 'LEASE_ACQUIRED');
  assert.equal(lease.dispatchHold.failedHeadRetryAuthorized, false);
  assert.equal(lease.dispatchHold.linkedAttemptId, lease.attempt.attemptId);
  assert.equal(lease.attempt.recoveryAttemptId, recoveryAttemptId);
  assert.equal(lease.attempt.runId, '31190000001');
  assert.equal(lease.attempt.runAttempt, 1);
  const admittedStatus = await responseBody(await getStatus(control, clock));
  assert.deepEqual(admittedStatus.dispatchHolds, []);
  assert.equal(admittedStatus.currentAttempt.recoveryAttemptId, recoveryAttemptId);
  assert.equal(admittedStatus.currentAttempt.runId, '31190000001');
  assert.equal(admittedStatus.currentAttempt.runAttempt, 1);
});

test('bind-run fixes one dispatch hold to one run before matching admission', async () => {
  const { clock, control } = makeControl();
  const recoveryAttemptId = 'recovery-00000003';
  const headSha = '8'.repeat(40);
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha,
  })).status, 201);
  const bound = await send(control, clock, '/v1/watchdog/bind-run', 'watchdog', {
    version: 1,
    recoveryAttemptId,
    headSha,
    runId: '31190000003',
    runAttempt: 1,
  });
  assert.equal(bound.status, 200);
  assert.equal((await responseBody(bound)).dispatchHold.state, 'RUN_BOUND');

  const wrongRun = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: 'github-run:31190000004:1',
    headSha,
    recoveryAttemptId,
    runId: '31190000004',
    runAttempt: 1,
  });
  assert.equal(wrongRun.status, 409);
  assert.equal((await responseBody(wrongRun)).error.code, 'DISPATCH_HOLD_ACTIVE');

  const lease = await acquireLease(control, clock, {
    headSha,
    recoveryAttemptId,
    runId: '31190000003',
  });
  assert.equal(lease.dispatchHold.runId, '31190000003');
  assert.equal(lease.dispatchHold.state, 'LEASE_ACQUIRED');
  assert.equal(lease.attempt.recoveryAttemptId, recoveryAttemptId);
  assert.equal(lease.attempt.runId, '31190000003');
  assert.equal(lease.attempt.runAttempt, 1);
});

test('dispatch-rejected requires durable evidence before a lost hold stops blocking', async () => {
  const { clock, control } = makeControl();
  const recoveryAttemptId = 'recovery-00000002';
  const headSha = '7'.repeat(40);
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha,
  })).status, 201);

  clock.now += 30 * 24 * 60 * 60 * 1000;
  assert.equal((await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: 'github-run:31180000900:1',
    headSha,
    runId: '31180000900',
    runAttempt: 1,
  })).status, 409);

  const rejected = await send(control, clock, '/v1/watchdog/dispatch-rejected', 'watchdog', {
    version: 1,
    recoveryAttemptId,
    headSha,
    reason: 'DISPATCH_CONFIRMED_REJECTED',
    evidenceDigest: 'd'.repeat(64),
  });
  assert.equal(rejected.status, 200);
  const rejectedData = await responseBody(rejected);
  assert.equal(rejectedData.dispatchHold.state, 'DISPATCH_REJECTED');
  assert.equal(rejectedData.dispatchHold.evidenceDigest, 'd'.repeat(64));

  const lease = await acquireLease(control, clock, {
    headSha,
  });
  assert.equal(lease.attempt.state, 'LEASED');
});

test('a closed dispatch hold ID can never be reused', async () => {
  const { clock, control } = makeControl();
  const recoveryAttemptId = 'recovery-reused-hold-0001';
  const headSha = '7'.repeat(40);
  const body = {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha,
  };
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', body)).status, 201);
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-rejected', 'watchdog', {
    version: 1,
    recoveryAttemptId,
    headSha,
    reason: 'DISPATCH_CONFIRMED_REJECTED',
    evidenceDigest: 'd'.repeat(64),
  })).status, 200);
  const reused = await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', body);
  assert.equal(reused.status, 409);
  assert.equal((await responseBody(reused)).error.code, 'DISPATCH_HOLD_ID_REUSED');
});

test('pre-dispatch abort requires exact source run provenance and cannot close RUN_BOUND', async () => {
  const headSha = '8'.repeat(40);
  {
    const { clock, control } = makeControl();
    const missingSource = await send(
      control,
      clock,
      '/v1/watchdog/dispatch-hold',
      'watchdog',
      { version: 1, recoveryAttemptId: 'recovery-source-missing-0001', headSha },
    );
    assert.equal(missingSource.status, 400);
  }

  {
    const { clock, control } = makeControl();
    const recoveryAttemptId = 'recovery-pre-dispatch-abort-0001';
    const held = await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
      version: 1,
      ...DEFAULT_DISPATCH_SOURCE,
      recoveryAttemptId,
      headSha,
      sourceRunId: '41180000001',
      sourceRunAttempt: 2,
    });
    assert.equal(held.status, 201);
    const hold = (await responseBody(held)).dispatchHold;
    assert.equal(hold.sourceRunId, '41180000001');
    assert.equal(hold.sourceRunAttempt, 2);

    const wrongSource = await send(
      control,
      clock,
      '/v1/watchdog/dispatch-rejected',
      'watchdog',
      {
        version: 1,
        recoveryAttemptId,
        headSha,
        reason: 'PRE_DISPATCH_NOT_STARTED',
        evidenceDigest: 'a'.repeat(64),
        sourceRunId: '41180000001',
        sourceRunAttempt: 1,
      },
    );
    assert.equal(wrongSource.status, 409);
    assert.equal((await responseBody(wrongSource)).error.code, 'SOURCE_RUN_MISMATCH');

    const aborted = await send(
      control,
      clock,
      '/v1/watchdog/dispatch-rejected',
      'watchdog',
      {
        version: 1,
        recoveryAttemptId,
        headSha,
        reason: 'PRE_DISPATCH_NOT_STARTED',
        evidenceDigest: 'b'.repeat(64),
        sourceRunId: '41180000001',
        sourceRunAttempt: 2,
      },
    );
    assert.equal(aborted.status, 200);
    assert.equal(aborted.headers.get('cache-control'), 'no-store');
    const abortedEnvelope = await aborted.json();
    assert.equal(abortedEnvelope.outcome, 'PRE_DISPATCH_ABORTED');
    assert.equal(abortedEnvelope.data.dispatchHold.state, 'PRE_DISPATCH_ABORTED');
    assert.equal(abortedEnvelope.data.dispatchHold.reason, 'PRE_DISPATCH_NOT_STARTED');
    assert.deepEqual((await responseBody(await getStatus(control, clock))).dispatchHolds, []);
  }

  {
    const { clock, control } = makeControl();
    const recoveryAttemptId = 'recovery-bound-no-abort-0001';
    assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
      version: 1,
      ...DEFAULT_DISPATCH_SOURCE,
      recoveryAttemptId,
      headSha,
      sourceRunId: '41180000002',
      sourceRunAttempt: 1,
    })).status, 201);
    assert.equal((await send(control, clock, '/v1/watchdog/bind-run', 'watchdog', {
      version: 1,
      recoveryAttemptId,
      headSha,
      runId: '31180000004',
      runAttempt: 1,
    })).status, 200);
    const noAbort = await send(
      control,
      clock,
      '/v1/watchdog/dispatch-rejected',
      'watchdog',
      {
        version: 1,
        recoveryAttemptId,
        headSha,
        reason: 'PRE_DISPATCH_NOT_STARTED',
        evidenceDigest: 'c'.repeat(64),
        sourceRunId: '41180000002',
        sourceRunAttempt: 1,
      },
    );
    assert.equal(noAbort.status, 409);
    assert.equal((await responseBody(noAbort)).error.code, 'INVALID_DISPATCH_HOLD_TRANSITION');
    const snapshot = await responseBody(await getStatus(control, clock));
    assert.equal(snapshot.dispatchHolds[0].state, 'RUN_BOUND');
  }
});

test('watchdog cannot convert transport-loss absence into definitive dispatch rejection', async () => {
  const { clock, control } = makeControl();
  const recoveryAttemptId = 'recovery-lost-000001';
  const headSha = 'c'.repeat(40);
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha,
  })).status, 201);
  const rejected = await send(control, clock, '/v1/watchdog/dispatch-rejected', 'watchdog', {
    version: 1,
    recoveryAttemptId,
    headSha,
    reason: 'RUN_CONFIRMED_ABSENT',
    evidenceDigest: 'e'.repeat(64),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await responseBody(rejected)).error.code, 'INVALID_DISPATCH_REJECTION_REASON');
  const snapshot = await responseBody(await getStatus(control, clock));
  assert.equal(snapshot.dispatchHolds[0].recoveryAttemptId, recoveryAttemptId);
  assert.equal(snapshot.dispatchHolds[0].state, 'DISPATCH_HELD');
});

test('route-scoped HMAC rejects replay, cross-role use, stale timestamps, and unknown versions', async () => {
  const { clock, control } = makeControl();
  const replayNonce = 'nonce-replay-0000000001';
  const first = await send(
    control,
    clock,
    '/v1/watchdog/status',
    'watchdog',
    null,
    { method: 'GET', nonce: replayNonce },
  );
  assert.equal(first.status, 200);
  const replay = await send(
    control,
    clock,
    '/v1/watchdog/status',
    'watchdog',
    null,
    { method: 'GET', nonce: replayNonce },
  );
  assert.equal(replay.status, 409);
  assert.equal((await responseBody(replay)).error.code, 'AUTH_REPLAY');

  const crossRole = await send(control, clock, '/v1/mutation/acquire', 'verifier', {
    version: 1,
    ownerId: 'github-run-1000-job-1',
    headSha: '9'.repeat(40),
  });
  assert.equal(crossRole.status, 403);
  assert.equal((await responseBody(crossRole)).error.code, 'AUTH_ROLE_FORBIDDEN');

  const crossSecret = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: 'github-run-1000-job-1',
    headSha: '9'.repeat(40),
  }, { secret: ROLE_SECRETS.verifier });
  assert.equal(crossSecret.status, 401);
  assert.equal((await responseBody(crossSecret)).error.code, 'AUTH_INVALID');

  const stale = await send(
    control,
    clock,
    '/v1/watchdog/status',
    'watchdog',
    null,
    { method: 'GET', timestamp: Math.floor(clock.now / 1000) - 301 },
  );
  assert.equal(stale.status, 401);
  assert.equal((await responseBody(stale)).error.code, 'AUTH_STALE');

  const headerVersion = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: 'github-run-1000-job-1',
    headSha: '9'.repeat(40),
  }, { headerVersion: '2' });
  assert.equal(headerVersion.status, 400);
  assert.equal((await responseBody(headerVersion)).error.code, 'UNKNOWN_PROTOCOL_VERSION');

  const bodyVersion = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 2,
    ownerId: 'github-run-1000-job-1',
    headSha: '9'.repeat(40),
  });
  assert.equal(bodyVersion.status, 400);
  assert.equal((await responseBody(bodyVersion)).error.code, 'UNKNOWN_PROTOCOL_VERSION');

  const oldRoute = await send(control, clock, '/v1/verifier/reject', 'verifier', { version: 1 });
  assert.equal(oldRoute.status, 404);
  assert.equal((await responseBody(oldRoute)).error.code, 'UNKNOWN_PROTOCOL_VERSION');
});

test('nonce retention covers the full second-granular authentication window', async () => {
  const { clock, control } = makeControl();
  const timestamp = Math.floor(clock.now / 1000);
  const nonce = 'nonce-window-edge-00000001';
  const first = await send(
    control,
    clock,
    '/v1/watchdog/status',
    'watchdog',
    null,
    { method: 'GET', timestamp, nonce },
  );
  assert.equal(first.status, 200);
  clock.now = (timestamp * 1000) + (5 * 60 * 1000) + 999;
  const replay = await send(
    control,
    clock,
    '/v1/watchdog/status',
    'watchdog',
    null,
    { method: 'GET', timestamp, nonce },
  );
  assert.equal(replay.status, 409);
  assert.equal((await responseBody(replay)).error.code, 'AUTH_REPLAY');
});

test('authenticated rejected transitions still consume their nonce durably', async () => {
  const { clock, control } = makeControl();
  const headSha = '3'.repeat(40);
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId: 'recovery-rejected-nonce-0001',
    headSha,
  })).status, 201);
  const body = {
    version: 1,
    ownerId: 'github-run:31180001001:1',
    headSha,
    runId: '31180001001',
    runAttempt: 1,
  };
  const nonce = 'nonce-rejected-transition-0001';

  const rejected = await send(
    control,
    clock,
    '/v1/mutation/acquire',
    'mutation',
    body,
    { nonce },
  );
  assert.equal(rejected.status, 409);
  assert.equal((await responseBody(rejected)).error.code, 'DISPATCH_HOLD_ACTIVE');

  const replay = await send(
    control,
    clock,
    '/v1/mutation/acquire',
    'mutation',
    body,
    { nonce },
  );
  assert.equal(replay.status, 409);
  assert.equal((await responseBody(replay)).error.code, 'AUTH_REPLAY');

  const invalidVersionNonce = 'nonce-invalid-body-version-0001';
  const invalidVersion = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    ...body,
    version: 2,
  }, { nonce: invalidVersionNonce });
  assert.equal(invalidVersion.status, 400);
  assert.equal((await responseBody(invalidVersion)).error.code, 'UNKNOWN_PROTOCOL_VERSION');
  const invalidVersionReplay = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    ...body,
    version: 2,
  }, { nonce: invalidVersionNonce });
  assert.equal(invalidVersionReplay.status, 409);
  assert.equal((await responseBody(invalidVersionReplay)).error.code, 'AUTH_REPLAY');
});

test('one compromised role cannot exhaust another role nonce capacity', async () => {
  const { clock, control, storage } = makeControl();
  storage.records.set('auth-nonces:v1:watchdog', Array.from({ length: 2_048 }, (_, index) => ({
    hash: `watchdog-${index}`,
    expiresAt: clock.now + 60_000,
  })));

  const mutation = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
    version: 1,
    ownerId: 'github-run:31180001002:1',
    headSha: '9'.repeat(40),
    runId: '31180001002',
    runAttempt: 1,
  });
  assert.equal(mutation.status, 201);

  const watchdog = await getStatus(control, clock);
  assert.equal(watchdog.status, 503);
  assert.equal((await responseBody(watchdog)).error.code, 'AUTH_NONCE_CAPACITY');
});

test('control authentication rejects short or reused route credentials', async () => {
  for (const env of [
    { ...ENV, MUTATION_HMAC_SECRET: 'too-short' },
    { ...ENV, VERIFIER_HMAC_SECRET: ENV.MUTATION_HMAC_SECRET },
  ]) {
    const { clock, control } = makeControl();
    control.env = env;
    const response = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
      version: 1,
      ownerId: 'github-run-credential-check-job-1',
      headSha: '9'.repeat(40),
    });
    assert.equal(response.status, 503);
    assert.equal((await responseBody(response)).error.code, 'AUTH_UNAVAILABLE');
  }
});

test('resolve_pre_mutation_hold closes only the exact hold and appends a linked resolution', async () => {
  const { clock, control } = makeControl();
  const recoveryAttemptId = 'recovery-operator-0001';
  const headSha = 'a'.repeat(40);
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha,
  })).status, 201);
  const resolved = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    recoveryAttemptId,
    headSha,
    'resolve_pre_mutation_hold',
  ));
  assert.equal(resolved.status, 200);
  const data = await responseBody(resolved);
  assert.deepEqual(Object.keys(data).sort(), [
    'decision',
    'evidenceDigest',
    'evidenceId',
    'headSha',
    'operationId',
    'priorGeneration',
    'priorId',
    'resolutionId',
    'supersedingAttemptId',
    'supersedingGeneration',
  ]);
  assert.equal(data.priorId, recoveryAttemptId);
  assert.equal(data.decision, 'resolve_pre_mutation_hold');
  assert.equal(data.operationId.length, 64);
  assert.equal(data.evidenceId, 'operator-evidence-0001');
  assert.equal(data.evidenceDigest, 'f'.repeat(64));
  const snapshot = await responseBody(await getStatus(control, clock));
  assert.deepEqual(snapshot.dispatchHolds, []);
  assert.equal(snapshot.currentAttempt.state, 'OPERATOR_RESOLVED');
  assert.equal(snapshot.currentAttempt.supersedesDispatchHoldId, recoveryAttemptId);
  assert.equal(snapshot.currentAttempt.reason, operatorRequest('', '', '').reason);
});

test('resolving a dispatch hold retires an expired lease and rejects a live lease', async () => {
  for (const live of [false, true]) {
    const { clock, control, storage } = makeControl();
    const recoveryAttemptId = `recovery-hold-with-${live ? 'live' : 'expired'}-lease`;
    const headSha = 'a'.repeat(40);
    assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
      version: 1,
      ...DEFAULT_DISPATCH_SOURCE,
      recoveryAttemptId,
      headSha,
    })).status, 201);
    const meta = storage.records.get('control-meta:v1');
    meta.currentLease = {
      version: 1,
      attemptId: 'unrelated-stale-attempt-0001',
      generation: 1,
      ownerId: 'github-run:41180000999:1',
      headSha: 'b'.repeat(40),
      acquiredAt: clock.now - 60_000,
      expiresAt: live ? clock.now + 60_000 : clock.now - 1,
    };
    storage.records.set('control-meta:v1', meta);

    const resolved = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
      recoveryAttemptId,
      headSha,
      'resolve_pre_mutation_hold',
    ));
    if (live) {
      assert.equal(resolved.status, 409);
      assert.equal((await responseBody(resolved)).error.code, 'LEASE_STILL_ACTIVE');
      assert.notEqual((await responseBody(await getStatus(control, clock))).lease, null);
    } else {
      assert.equal(resolved.status, 200);
      assert.equal((await responseBody(await getStatus(control, clock))).lease, null);
    }
  }
});

test('operator resolution requires a supplied lowercase 64-hex operation ID', async () => {
  const { clock, control } = makeControl();
  const recoveryAttemptId = 'recovery-operation-id-0001';
  const headSha = '9'.repeat(40);
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha,
  })).status, 201);

  for (const operationId of [undefined, 'a'.repeat(63), 'A'.repeat(64)]) {
    const body = operatorRequest(
      recoveryAttemptId,
      headSha,
      'resolve_pre_mutation_hold',
      { operationId },
    );
    if (operationId === undefined) delete body.operationId;
    const response = await send(control, clock, '/v1/operator/resolve', 'operator', body);
    assert.equal(response.status, 400);
    assert.equal((await responseBody(response)).error.code, 'INVALID_OPERATION_ID');
  }
});

test('operator resolution requires the exact durable prior createdAt as millisecond ISO', async () => {
  const { clock, control } = makeControl();
  const recoveryAttemptId = 'recovery-prior-created-at-0001';
  const headSha = '7'.repeat(40);
  const held = await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha,
  });
  assert.equal(held.status, 201);
  const hold = (await responseBody(held)).dispatchHold;
  const exactCreatedAt = new Date(hold.createdAt).toISOString();

  for (const priorCreatedAt of [
    undefined,
    '2027-01-15T08:00:00Z',
    new Date(hold.createdAt + 1).toISOString(),
  ]) {
    const body = operatorRequest(
      recoveryAttemptId,
      headSha,
      'resolve_pre_mutation_hold',
      { priorCreatedAt },
    );
    if (priorCreatedAt === undefined) delete body.priorCreatedAt;
    const response = await send(control, clock, '/v1/operator/resolve', 'operator', body);
    assert.ok([400, 409].includes(response.status));
  }

  const resolved = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    recoveryAttemptId,
    headSha,
    'resolve_pre_mutation_hold',
    { priorCreatedAt: exactCreatedAt },
  ));
  assert.equal(resolved.status, 200);
});

test('operator can supersede an old-head dispatch hold onto exact current main', async () => {
  const { clock, control } = makeControl();
  const recoveryAttemptId = 'recovery-old-head-0001';
  const oldHead = '1'.repeat(40);
  const currentHead = '2'.repeat(40);
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha: oldHead,
  })).status, 201);
  const resolved = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    recoveryAttemptId,
    currentHead,
    'resolve_pre_mutation_hold',
  ));
  assert.equal(resolved.status, 200);
  const snapshot = await responseBody(await getStatus(control, clock));
  assert.equal(snapshot.currentAttempt.headSha, currentHead);
  assert.deepEqual(snapshot.dispatchHolds, []);
});

test('operator resolution replays the committed result across volatile evidence refreshes', async () => {
  const { clock, control } = makeControl();
  const recoveryAttemptId = 'recovery-idempotent-operator-0001';
  const headSha = '5'.repeat(40);
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha,
  })).status, 201);
  const body = operatorRequest(recoveryAttemptId, headSha, 'resolve_pre_mutation_hold');
  const first = await send(control, clock, '/v1/operator/resolve', 'operator', body);
  const replay = await send(control, clock, '/v1/operator/resolve', 'operator', {
    ...body,
    triggeringActor: 'replacement-triggering-engineer',
    operatorRunId: '40000000002',
    operatorRunAttempt: 2,
    evidenceId: 'operator-evidence-0002',
    runEvidenceId: 'github-run-evidence-0002',
    environmentEvidenceId: 'breakglass-review-evidence-0002',
    evidenceDigest: 'e'.repeat(64),
    gateStatusId: '100',
    gateUpdatedAt: '2026-08-07T12:00:00.000Z',
  });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual(await responseBody(replay), await responseBody(first));
  const snapshot = await responseBody(await getStatus(control, clock));
  assert.equal(snapshot.generation, 1);
  assert.equal(snapshot.currentAttempt.triggeringActor, 'triggering-engineer');
  assert.equal(snapshot.currentAttempt.operatorRunId, '40000000001');
  assert.equal(snapshot.currentAttempt.operatorRunAttempt, 1);
  assert.equal(snapshot.currentAttempt.evidenceId, 'operator-evidence-0001');
  assert.equal(snapshot.currentAttempt.runEvidenceId, 'github-run-evidence-0001');
  assert.equal(
    snapshot.currentAttempt.environmentEvidenceId,
    'breakglass-review-evidence-0001',
  );
  assert.equal(snapshot.currentAttempt.evidenceDigest, 'f'.repeat(64));
  assert.equal(snapshot.currentAttempt.gateStatusId, '99');
  assert.equal(snapshot.currentAttempt.gateUpdatedAt, '2026-08-07T11:59:00.000Z');

  for (const immutableChange of [
    { priorId: 'different-prior-id' },
    { priorCreatedAt: new Date(1_800_000_000_001).toISOString() },
    { expectedHead: '6'.repeat(40) },
    { decision: 'authorize_current_main_retry' },
    { actor: 'different-oncall-engineer' },
    { approver: 'different-production-approver' },
    { reason: 'Reviewed a different immutable resolution reason.' },
    { targetRunId: '31181545166', targetRunAttempt: 1, targetHead: headSha },
  ]) {
    const reused = await send(control, clock, '/v1/operator/resolve', 'operator', {
      ...body,
      ...immutableChange,
    });
    assert.equal(reused.status, 409);
    assert.equal((await responseBody(reused)).error.code, 'OPERATOR_OPERATION_REUSED');
  }
  assert.equal((await responseBody(await getStatus(control, clock))).generation, 1);
});

test('operator replay fails closed when its committed result is malformed', async () => {
  const { clock, control, storage } = makeControl();
  const recoveryAttemptId = 'recovery-corrupt-operator-replay-0001';
  const headSha = '4'.repeat(40);
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha,
  })).status, 201);
  const body = operatorRequest(recoveryAttemptId, headSha, 'resolve_pre_mutation_hold');
  assert.equal((await send(
    control,
    clock,
    '/v1/operator/resolve',
    'operator',
    body,
  )).status, 200);

  const replayKey = `operator-resolution:${body.operationId}`;
  const replayRecord = storage.records.get(replayKey);
  replayRecord.result = {};
  storage.records.set(replayKey, replayRecord);

  const replay = await send(control, clock, '/v1/operator/resolve', 'operator', body);
  assert.equal(replay.status, 503);
  assert.equal((await responseBody(replay)).error.code, 'STATE_UNAVAILABLE');
});

test('operator resolution compares evidence target runs with bound holds', async () => {
  const { clock, control } = makeControl();
  const recoveryAttemptId = 'recovery-target-bound-0001';
  const headSha = '6'.repeat(40);
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha,
  })).status, 201);
  assert.equal((await send(control, clock, '/v1/watchdog/bind-run', 'watchdog', {
    version: 1,
    recoveryAttemptId,
    headSha,
    runId: '31181545167',
    runAttempt: 2,
  })).status, 200);

  const mismatch = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    recoveryAttemptId,
    headSha,
    'resolve_pre_mutation_hold',
    { targetRunId: '31181545168', targetRunAttempt: 1 },
  ));
  assert.equal(mismatch.status, 409);
  assert.equal((await responseBody(mismatch)).error.code, 'TARGET_RUN_MISMATCH');

  const wrongAttempt = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    recoveryAttemptId,
    headSha,
    'resolve_pre_mutation_hold',
    { targetRunId: '31181545167', targetRunAttempt: 1 },
  ));
  assert.equal(wrongAttempt.status, 409);
  assert.equal((await responseBody(wrongAttempt)).error.code, 'TARGET_RUN_MISMATCH');

  const resolved = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    recoveryAttemptId,
    headSha,
    'resolve_pre_mutation_hold',
    { targetRunId: '31181545167', targetRunAttempt: 2 },
  ));
  assert.equal(resolved.status, 200);
});

test('operator resolution compares evidence target runs with prior attempts', async () => {
  const { clock, control } = makeControl();
  const recoveryAttemptId = 'recovery-target-attempt-0001';
  const headSha = '7'.repeat(40);
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha,
  })).status, 201);
  assert.equal((await send(control, clock, '/v1/watchdog/bind-run', 'watchdog', {
    version: 1,
    recoveryAttemptId,
    headSha,
    runId: '31181545169',
    runAttempt: 1,
  })).status, 200);
  const lease = await createManualBarrier(control, clock, {
    headSha,
    recoveryAttemptId,
    runId: '31181545169',
    runAttempt: 1,
  });

  const mismatch = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    lease.attempt.attemptId,
    headSha,
    'authorize_current_main_retry',
    { targetRunId: '31181545170', targetRunAttempt: 1 },
  ));
  assert.equal(mismatch.status, 409);
  assert.equal((await responseBody(mismatch)).error.code, 'TARGET_RUN_MISMATCH');

  const wrongAttempt = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    lease.attempt.attemptId,
    headSha,
    'authorize_current_main_retry',
    { targetRunId: '31181545169', targetRunAttempt: 2 },
  ));
  assert.equal(wrongAttempt.status, 409);
  assert.equal((await responseBody(wrongAttempt)).error.code, 'TARGET_RUN_MISMATCH');

  const resolved = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    lease.attempt.attemptId,
    headSha,
    'authorize_current_main_retry',
    { targetRunId: '31181545169', targetRunAttempt: 1 },
  ));
  assert.equal(resolved.status, 200);
});

test('pre-mutation operator resolution compares evidence target runs with prior attempts', async () => {
  const { clock, control } = makeControl();
  const recoveryAttemptId = 'recovery-target-pre-mutation-0001';
  const headSha = '8'.repeat(40);
  assert.equal((await send(control, clock, '/v1/watchdog/dispatch-hold', 'watchdog', {
    version: 1,
    ...DEFAULT_DISPATCH_SOURCE,
    recoveryAttemptId,
    headSha,
  })).status, 201);
  assert.equal((await send(control, clock, '/v1/watchdog/bind-run', 'watchdog', {
    version: 1,
    recoveryAttemptId,
    headSha,
    runId: '31181545171',
    runAttempt: 1,
  })).status, 200);
  const lease = await acquireLease(control, clock, {
    headSha,
    recoveryAttemptId,
    runId: '31181545171',
    runAttempt: 1,
  });
  clock.now = lease.leaseExpiresAt + 1;

  const mismatch = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    lease.attempt.attemptId,
    headSha,
    'resolve_pre_mutation_hold',
    { targetRunId: '31181545172', targetRunAttempt: 1 },
  ));
  assert.equal(mismatch.status, 409);
  assert.equal((await responseBody(mismatch)).error.code, 'TARGET_RUN_MISMATCH');
  const snapshot = await responseBody(await getStatus(control, clock));
  assert.equal(snapshot.generation, 1);
  assert.equal(snapshot.currentAttempt.attemptId, lease.attempt.attemptId);
});

test('operator retry supersedes an old-head mutation barrier with a current-head hold', async () => {
  const { clock, control } = makeControl();
  const oldHead = '3'.repeat(40);
  const currentHead = '4'.repeat(40);
  const lease = await createManualBarrier(control, clock, {
    headSha: oldHead,
  });
  const resolved = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    lease.attempt.attemptId,
    currentHead,
    'authorize_current_main_retry',
  ));
  assert.equal(resolved.status, 200);
  const data = await responseBody(resolved);
  const snapshot = await responseBody(await getStatus(control, clock));
  assert.equal(snapshot.currentAttempt.headSha, currentHead);
  assert.equal(snapshot.dispatchHolds[0].headSha, currentHead);
  assert.equal(snapshot.dispatchHolds[0].recoveryAttemptId, data.supersedingAttemptId);
});

test('operator-authorized retry hold derives source provenance from the operator run', async () => {
  const { clock, control } = makeControl();
  const headSha = '5'.repeat(40);
  const lease = await createManualBarrier(control, clock, {
    headSha,
    runId: '31181545180',
    runAttempt: 1,
  });
  const resolved = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    lease.attempt.attemptId,
    headSha,
    'authorize_current_main_retry',
    {
      priorCreatedAt: new Date(lease.attempt.createdAt).toISOString(),
      operatorRunId: '41181545180',
      operatorRunAttempt: 3,
      targetRunId: '31181545180',
      targetRunAttempt: 1,
    },
  ));
  assert.equal(resolved.status, 200);
  const snapshot = await responseBody(await getStatus(control, clock));
  assert.equal(snapshot.dispatchHolds.length, 1);
  assert.equal(snapshot.dispatchHolds[0].sourceRunId, '41181545180');
  assert.equal(snapshot.dispatchHolds[0].sourceRunAttempt, 3);
  assert.equal(snapshot.dispatchHolds[0].failedHeadRetryAuthorized, true);
});

test('one-person operator resolution records the same actor and audit identity', async () => {
  const { clock, control } = makeControl();
  const headSha = '7'.repeat(40);
  const lease = await createManualBarrier(control, clock, { headSha });
  const resolved = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    lease.attempt.attemptId,
    headSha,
    'authorize_current_main_retry',
    { approver: 'oncall-engineer' },
  ));
  assert.equal(resolved.status, 200);
  const snapshot = await responseBody(await getStatus(control, clock));
  assert.equal(snapshot.currentAttempt.actor, 'oncall-engineer');
  assert.equal(snapshot.currentAttempt.approver, 'oncall-engineer');
  assert.equal(snapshot.dispatchHolds[0].failedHeadRetryAuthorized, true);
});

test('authorized retry carries bounded superseded run lineage through admission and acceptance', async () => {
  const { clock, control } = makeControl();
  const headSha = '6'.repeat(40);
  const runA = { runId: '31181545201', runAttempt: 1 };
  const runB = { runId: '31181545202', runAttempt: 2 };
  const runC = { runId: '31181545203', runAttempt: 1 };

  const firstBarrier = await createManualBarrier(control, clock, {
    headSha,
    ...runA,
  });
  const firstResolutionResponse = await send(
    control,
    clock,
    '/v1/operator/resolve',
    'operator',
    operatorRequest(
      firstBarrier.attempt.attemptId,
      headSha,
      'authorize_current_main_retry',
      {
        priorCreatedAt: new Date(firstBarrier.attempt.createdAt).toISOString(),
        targetRunId: runA.runId,
        targetRunAttempt: runA.runAttempt,
      },
    ),
  );
  assert.equal(firstResolutionResponse.status, 200);
  const firstResolution = await responseBody(firstResolutionResponse);
  const firstLineage = [runA];
  let snapshot = await responseBody(await getStatus(control, clock));
  assert.deepEqual(snapshot.currentAttempt.supersededRuns, firstLineage);
  assert.deepEqual(snapshot.dispatchHolds[0].supersededRuns, firstLineage);

  assert.equal((await send(control, clock, '/v1/watchdog/bind-run', 'watchdog', {
    version: 1,
    recoveryAttemptId: firstResolution.supersedingAttemptId,
    headSha,
    ...runB,
  })).status, 200);
  const secondLease = await acquireLease(control, clock, {
    headSha,
    recoveryAttemptId: firstResolution.supersedingAttemptId,
    ...runB,
  });
  assert.deepEqual(secondLease.dispatchHold.supersededRuns, firstLineage);
  assert.deepEqual(secondLease.attempt.supersededRuns, firstLineage);

  await turnLeaseIntoManualBarrier(control, clock, secondLease);
  const secondResolutionResponse = await send(
    control,
    clock,
    '/v1/operator/resolve',
    'operator',
    operatorRequest(
      secondLease.attempt.attemptId,
      headSha,
      'authorize_current_main_retry',
      {
        priorCreatedAt: new Date(secondLease.attempt.createdAt).toISOString(),
        targetRunId: runB.runId,
        targetRunAttempt: runB.runAttempt,
      },
    ),
  );
  assert.equal(secondResolutionResponse.status, 200);
  const secondResolution = await responseBody(secondResolutionResponse);
  const secondLineage = [runA, runB];
  snapshot = await responseBody(await getStatus(control, clock));
  assert.deepEqual(snapshot.currentAttempt.supersededRuns, secondLineage);
  assert.deepEqual(snapshot.dispatchHolds[0].supersededRuns, secondLineage);

  assert.equal((await send(control, clock, '/v1/watchdog/bind-run', 'watchdog', {
    version: 1,
    recoveryAttemptId: secondResolution.supersedingAttemptId,
    headSha,
    ...runC,
  })).status, 200);
  const terminalLease = await acquireLease(control, clock, {
    headSha,
    recoveryAttemptId: secondResolution.supersedingAttemptId,
    ...runC,
  });
  assert.deepEqual(terminalLease.attempt.supersededRuns, secondLineage);

  const ownerFields = {
    version: 1,
    attemptId: terminalLease.attempt.attemptId,
    ownerId: terminalLease.attempt.ownerId,
    leaseCapability: terminalLease.leaseCapability,
    headSha,
  };
  const intentDigest = '1'.repeat(64);
  const resultDigest = '2'.repeat(64);
  assert.equal((await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/bind-result', 'mutation', {
    ...ownerFields,
    intentDigest,
    resultKind: 'NO_MUTATION',
    resultDigest,
    minTtlMs: 1,
  })).status, 200);
  assert.equal((await send(
    control,
    clock,
    '/v1/mutation/release',
    'mutation',
    ownerFields,
  )).status, 200);
  const accepted = await send(control, clock, '/v1/verifier/accept', 'verifier', {
    version: 1,
    attemptId: terminalLease.attempt.attemptId,
    headSha,
    intentDigest,
    resultDigest,
  });
  assert.equal(accepted.status, 200);
  const acceptedData = await responseBody(accepted);
  assert.deepEqual(acceptedData.attempt.supersededRuns, secondLineage);
  assert.deepEqual(acceptedData.lastAccepted.supersededRuns, secondLineage);
});

test('superseded run lineage admits 64 unique pairs and rejects a 65th without truncation', async () => {
  const { clock, control } = makeControl();
  const headSha = '7'.repeat(40);
  const run = (index) => ({
    runId: String(31_181_546_000 + index),
    runAttempt: 1,
  });
  let lease = await createManualBarrier(control, clock, { headSha, ...run(0) });
  let resolution;

  for (let index = 0; index < 64; index += 1) {
    const response = await send(
      control,
      clock,
      '/v1/operator/resolve',
      'operator',
      operatorRequest(
        lease.attempt.attemptId,
        headSha,
        'authorize_current_main_retry',
        {
          priorCreatedAt: new Date(lease.attempt.createdAt).toISOString(),
          targetRunId: run(index).runId,
          targetRunAttempt: run(index).runAttempt,
        },
      ),
    );
    assert.equal(response.status, 200);
    resolution = await responseBody(response);
    if (index === 63) break;

    assert.equal((await send(control, clock, '/v1/watchdog/bind-run', 'watchdog', {
      version: 1,
      recoveryAttemptId: resolution.supersedingAttemptId,
      headSha,
      ...run(index + 1),
    })).status, 200);
    lease = await acquireLease(control, clock, {
      headSha,
      recoveryAttemptId: resolution.supersedingAttemptId,
      ...run(index + 1),
    });
    await turnLeaseIntoManualBarrier(control, clock, lease);
  }

  let snapshot = await responseBody(await getStatus(control, clock));
  assert.equal(snapshot.currentAttempt.supersededRuns.length, 64);
  assert.equal(snapshot.dispatchHolds[0].supersededRuns.length, 64);

  assert.equal((await send(control, clock, '/v1/watchdog/bind-run', 'watchdog', {
    version: 1,
    recoveryAttemptId: resolution.supersedingAttemptId,
    headSha,
    ...run(64),
  })).status, 200);
  lease = await acquireLease(control, clock, {
    headSha,
    recoveryAttemptId: resolution.supersedingAttemptId,
    ...run(64),
  });
  await turnLeaseIntoManualBarrier(control, clock, lease);
  const overflow = await send(
    control,
    clock,
    '/v1/operator/resolve',
    'operator',
    operatorRequest(
      lease.attempt.attemptId,
      headSha,
      'authorize_current_main_retry',
      {
        priorCreatedAt: new Date(lease.attempt.createdAt).toISOString(),
        targetRunId: run(64).runId,
        targetRunAttempt: run(64).runAttempt,
      },
    ),
  );
  assert.equal(overflow.status, 409);
  assert.equal((await responseBody(overflow)).error.code, 'SUPERSEDED_RUNS_LIMIT');
  snapshot = await responseBody(await getStatus(control, clock));
  assert.equal(snapshot.currentAttempt.attemptId, lease.attempt.attemptId);
  assert.equal(snapshot.currentAttempt.supersededRuns.length, 64);

  const currentHead = '8'.repeat(40);
  const converged = await send(
    control,
    clock,
    '/v1/operator/resolve',
    'operator',
    operatorRequest(
      lease.attempt.attemptId,
      currentHead,
      'accept_observed_convergence',
      {
        priorCreatedAt: new Date(lease.attempt.createdAt).toISOString(),
        targetRunId: run(64).runId,
        targetRunAttempt: run(64).runAttempt,
        targetHead: headSha,
      },
    ),
  );
  assert.equal(converged.status, 200);
  assert.equal((await responseBody(converged)).headSha, currentHead);
  snapshot = await responseBody(await getStatus(control, clock));
  assert.equal(snapshot.barrier, null);
  assert.equal(snapshot.currentAttempt.state, 'TERMINAL_ACCEPTED');
  assert.equal(snapshot.currentAttempt.headSha, headSha);
  assert.equal(snapshot.currentAttempt.authorizationHeadSha, currentHead);
  assert.equal(snapshot.lastAccepted.headSha, headSha);
  assert.deepEqual(snapshot.currentAttempt.supersededRuns, [run(64)]);
});

test('resolve_pre_mutation_hold can supersede a released no-mutation verification fence', async () => {
  const { clock, control } = makeControl();
  const lease = await acquireLease(control, clock, {
    headSha: 'b'.repeat(40),
  });
  const ownerFields = {
    version: 1,
    attemptId: lease.attempt.attemptId,
    ownerId: lease.attempt.ownerId,
    leaseCapability: lease.leaseCapability,
    headSha: lease.attempt.headSha,
  };
  const intentDigest = '1'.repeat(64);
  assert.equal((await send(control, clock, '/v1/mutation/prepare', 'mutation', {
    ...ownerFields,
    intentDigest,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/bind-result', 'mutation', {
    ...ownerFields,
    intentDigest,
    resultKind: 'NO_MUTATION',
    resultDigest: '2'.repeat(64),
    minTtlMs: 1,
  })).status, 200);
  assert.equal((await send(control, clock, '/v1/mutation/release', 'mutation', ownerFields)).status, 200);
  const resolved = await send(control, clock, '/v1/operator/resolve', 'operator', {
    ...operatorRequest(lease.attempt.attemptId, lease.attempt.headSha, 'resolve_pre_mutation_hold'),
  });
  assert.equal(resolved.status, 200);
  const data = await responseBody(resolved);
  const snapshot = await responseBody(await getStatus(control, clock));
  assert.equal(snapshot.currentAttempt.state, 'OPERATOR_RESOLVED');
  assert.equal(snapshot.currentAttempt.supersedesAttemptId, lease.attempt.attemptId);
  const next = await acquireLease(control, clock, {
    headSha: 'c'.repeat(40),
  });
  assert.equal(next.attempt.generation, 3);
});

for (const decision of ['accept_observed_convergence', 'authorize_current_main_retry']) {
  test(`${decision} clears only the exact latest post-mutation barrier`, async () => {
    const { clock, control } = makeControl();
    const headSha = decision === 'accept_observed_convergence'
      ? 'd'.repeat(40)
      : 'e'.repeat(40);
    const lease = await createManualBarrier(control, clock, {
      headSha,
    });
    if (decision === 'accept_observed_convergence') {
      const wrongHead = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
        lease.attempt.attemptId,
        headSha,
        decision,
        { targetHead: 'f'.repeat(40) },
      ));
      assert.equal(wrongHead.status, 409);
      assert.equal((await responseBody(wrongHead)).error.code, 'HEAD_SHA_MISMATCH');

      const wrongIntent = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
        lease.attempt.attemptId,
        headSha,
        decision,
        { intentDigest: 'd'.repeat(64) },
      ));
      assert.equal(wrongIntent.status, 409);
      assert.equal((await responseBody(wrongIntent)).error.code, 'INTENT_DIGEST_MISMATCH');
    }

    const resolved = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
      lease.attempt.attemptId,
      headSha,
      decision,
    ));
    assert.equal(resolved.status, 200);
    const data = await responseBody(resolved);
    assert.equal(data.priorId, lease.attempt.attemptId);
    assert.equal(data.decision, decision);
    assert.equal(data.evidenceId, 'operator-evidence-0001');
    assert.equal(data.evidenceDigest, 'f'.repeat(64));
    const snapshot = await responseBody(await getStatus(control, clock));
    assert.equal(snapshot.currentAttempt.supersedesAttemptId, lease.attempt.attemptId);
    assert.equal(snapshot.currentAttempt.decision, decision);
    assert.equal(snapshot.currentAttempt.actor, 'oncall-engineer');
    assert.equal(snapshot.currentAttempt.approver, 'production-approver');
    assert.equal(snapshot.currentAttempt.evidenceDigest, 'f'.repeat(64));
    assert.equal(snapshot.currentAttempt.triggeringActor, 'triggering-engineer');
    assert.equal(snapshot.currentAttempt.operatorRunId, '40000000001');
    assert.equal(snapshot.currentAttempt.operatorRunAttempt, 1);
    assert.equal(snapshot.currentAttempt.evidenceId, 'operator-evidence-0001');
    assert.equal(snapshot.currentAttempt.runEvidenceId, 'github-run-evidence-0001');
    assert.equal(
      snapshot.currentAttempt.environmentEvidenceId,
      'breakglass-review-evidence-0001',
    );
    assert.equal(snapshot.currentAttempt.gateStatusId, '99');
    assert.equal(snapshot.currentAttempt.gateUpdatedAt, '2026-08-07T11:59:00.000Z');
    assert.equal(snapshot.barrier, null);
    if (decision === 'accept_observed_convergence') {
      assert.equal(snapshot.currentAttempt.state, 'TERMINAL_ACCEPTED');
      assert.equal(snapshot.currentAttempt.resultKind, 'OPERATOR_OBSERVED_CONVERGENCE');
      assert.equal(snapshot.lastAccepted.attemptId, data.supersedingAttemptId);
      assert.equal(snapshot.lastAccepted.headSha, headSha);
      assert.equal(snapshot.lastAccepted.resultDigest, 'f'.repeat(64));
      assert.equal(snapshot.lastAccepted.acceptedAt, clock.now);
      assert.deepEqual(snapshot.lastAccepted.supersededRuns, [{
        runId: lease.attempt.runId,
        runAttempt: lease.attempt.runAttempt,
      }]);
    } else {
      assert.equal(snapshot.currentAttempt.state, 'OPERATOR_RESOLVED');
      assert.equal(snapshot.dispatchHolds.length, 1);
      assert.equal(snapshot.dispatchHolds[0].recoveryAttemptId, data.supersedingAttemptId);
      assert.equal(snapshot.dispatchHolds[0].headSha, headSha);

      const ordinary = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
        version: 1,
        ownerId: 'github-run:31181545167:1',
        headSha,
        runId: '31181545167',
        runAttempt: 1,
      });
      assert.equal(ordinary.status, 409);
      assert.equal((await responseBody(ordinary)).error.code, 'DISPATCH_HOLD_ACTIVE');

      const admitted = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
        version: 1,
        ownerId: 'github-run:31181545168:1',
        headSha,
        recoveryAttemptId: data.supersedingAttemptId,
        runId: '31181545168',
        runAttempt: 1,
      });
      assert.equal(admitted.status, 409);
      assert.equal((await responseBody(admitted)).error.code, 'DISPATCH_HOLD_ACTIVE');
      assert.equal((await send(control, clock, '/v1/watchdog/bind-run', 'watchdog', {
        version: 1,
        recoveryAttemptId: data.supersedingAttemptId,
        headSha,
        runId: '31181545168',
        runAttempt: 1,
      })).status, 200);
      const boundAdmission = await send(control, clock, '/v1/mutation/acquire', 'mutation', {
        version: 1,
        ownerId: 'github-run:31181545168:1',
        headSha,
        recoveryAttemptId: data.supersedingAttemptId,
        runId: '31181545168',
        runAttempt: 1,
      });
      assert.equal(boundAdmission.status, 201);
      assert.equal((await responseBody(boundAdmission)).dispatchHold.state, 'LEASE_ACQUIRED');
      assert.deepEqual((await responseBody(await getStatus(control, clock))).dispatchHolds, []);
    }
  });
}

test('operator resolution rejects superseded attempts and mismatched barriers with exact codes', async () => {
  const { clock, control, storage } = makeControl();
  const headSha = '1'.repeat(40);
  const lease = await createManualBarrier(control, clock, { headSha });
  const meta = clone(storage.records.get('control-meta:v1'));

  storage.records.set('control-meta:v1', { ...meta, latestAttemptId: 'newer-attempt-id' });
  const superseded = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    lease.attempt.attemptId,
    headSha,
    'authorize_current_main_retry',
  ));
  assert.equal(superseded.status, 409);
  assert.equal((await responseBody(superseded)).error.code, 'ATTEMPT_SUPERSEDED');

  storage.records.set('control-meta:v1', {
    ...meta,
    barrier: { ...meta.barrier, attemptId: 'different-barrier-attempt' },
  });
  const mismatchedBarrier = await send(control, clock, '/v1/operator/resolve', 'operator', operatorRequest(
    lease.attempt.attemptId,
    headSha,
    'authorize_current_main_retry',
  ));
  assert.equal(mismatchedBarrier.status, 409);
  assert.equal((await responseBody(mismatchedBarrier)).error.code, 'BARRIER_MISMATCH');
});

test('operator resolution rejects unsafe decisions and injectable reasons', async () => {
  const { clock, control } = makeControl();
  const lease = await createManualBarrier(control, clock, {
    headSha: 'f'.repeat(40),
  });
  const cases = [
    operatorRequest(lease.attempt.attemptId, lease.attempt.headSha, 'resolve_pre_mutation_hold'),
    operatorRequest(lease.attempt.attemptId, lease.attempt.headSha, 'authorize_current_main_retry', {
      reason: 'See [proof](https://evil.test) before retry.',
    }),
    operatorRequest(lease.attempt.attemptId, lease.attempt.headSha, 'authorize_current_main_retry', {
      reason: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz123456',
    }),
  ];
  for (const body of cases) {
    const response = await send(control, clock, '/v1/operator/resolve', 'operator', body);
    assert.ok([400, 409].includes(response.status));
  }
  assert.notEqual((await responseBody(await getStatus(control, clock))).barrier, null);
});
