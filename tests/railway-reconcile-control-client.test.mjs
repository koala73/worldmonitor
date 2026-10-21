import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  CONTROL_CLIENT_USER_AGENT,
  CONTROL_ORIGIN,
  CONTROL_PROTOCOL_VERSION,
  ControlPlaneError,
  RailwayReconcileControlClient,
  canonicalJson,
} from '../scripts/railway-reconcile-control-client.mjs';

const BASE_URL = CONTROL_ORIGIN;
const SECRET = 'test-route-secret-at-least-32-bytes-0001';

function success(data = {}, outcome = 'OK') {
  return new Response(JSON.stringify({
    version: CONTROL_PROTOCOL_VERSION,
    ok: true,
    outcome,
    data,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function acquireData() {
  return {
    attempt: {},
    leaseCapability: 'capability',
    leaseExpiresAt: 1,
    supersededAttempt: null,
    dispatchHold: null,
  };
}

function statusData() {
  return {
    generation: 0,
    lease: null,
    currentAttempt: null,
    barrier: null,
    lastAccepted: null,
    dispatchHolds: [],
  };
}

function operatorResolutionData(body, overrides = {}) {
  return {
    resolutionId: 'resolution-0001',
    operationId: body.operationId,
    priorId: body.priorId,
    priorGeneration: 7,
    supersedingGeneration: 8,
    supersedingAttemptId: 'superseding-attempt-0001',
    headSha: body.expectedHead,
    evidenceId: body.evidenceId,
    evidenceDigest: body.evidenceDigest,
    decision: body.decision,
    ...overrides,
  };
}

function makeClient(overrides = {}) {
  return new RailwayReconcileControlClient({
    baseUrl: BASE_URL,
    role: 'mutation',
    secret: SECRET,
    now: () => 1_786_100_000_000,
    nonce: () => 'nonce-0000000000000001',
    fetchImpl: async () => success(acquireData(), 'LEASE_GRANTED'),
    ...overrides,
  });
}

describe('canonicalJson', () => {
  it('sorts nested object keys while preserving array order', () => {
    assert.equal(
      canonicalJson({ z: 1, a: { y: 2, x: [3, { b: true, a: null }] } }),
      '{"a":{"x":[3,{"a":null,"b":true}],"y":2},"z":1}',
    );
  });

  it('rejects values that cannot have one portable signed representation', () => {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n]) {
      assert.throws(() => canonicalJson({ value }), /canonical JSON/i);
    }
  });

  it('rejects an adversarial __proto__ key instead of signing a colliding object', () => {
    const payload = JSON.parse('{"safe":1,"__proto__":{"polluted":true}}');
    assert.throws(() => canonicalJson(payload), /__proto__/);
    assert.equal({}.polluted, undefined);
  });
});

describe('RailwayReconcileControlClient', () => {
  it('requires one credential role, an HTTPS origin, and no URL credentials or path', () => {
    for (const baseUrl of [
      'http://railway-reconcile-control.worldmonitor.app',
      'https://user:pass@railway-reconcile-control.worldmonitor.app',
      'https://railway-reconcile-control.worldmonitor.app/v1',
      'https://railway-reconcile-control.worldmonitor.app?x=1',
      'https://railway-control.example',
    ]) {
      assert.throws(() => makeClient({ baseUrl }), /control.*URL|HTTPS|origin/i, baseUrl);
    }
    assert.throws(() => makeClient({ role: 'admin' }), /role/i);
    assert.throws(() => makeClient({ secret: '' }), /secret/i);
    assert.throws(() => makeClient({ secret: 'too-short' }), /32 to 1024 bytes/i);
  });

  it('signs the exact method, path, canonical body digest, timestamp, and nonce', async () => {
    let observed;
    const client = makeClient({
      fetchImpl: async (url, options) => {
        observed = { url, options };
        return success(acquireData(), 'LEASE_GRANTED');
      },
    });

    await client.acquire({ owner: 'run:12:1', attemptId: 'attempt-1', headSha: 'a'.repeat(40) });

    assert.equal(observed.url, `${BASE_URL}/v1/mutation/acquire`);
    assert.equal(observed.options.method, 'POST');
    assert.equal(observed.options.redirect, 'error');
    const body = observed.options.body;
    assert.equal(body, canonicalJson({
      attemptId: 'attempt-1',
      headSha: 'a'.repeat(40),
      owner: 'run:12:1',
      version: CONTROL_PROTOCOL_VERSION,
    }));
    const digest = createHash('sha256').update(body).digest('hex');
    const canonical = ['POST', '/v1/mutation/acquire', digest, '1786100000', 'nonce-0000000000000001'].join('\n');
    const signature = createHmac('sha256', SECRET).update(canonical).digest('hex');
    const headers = observed.options.headers;
    assert.equal(headers['user-agent'], CONTROL_CLIENT_USER_AGENT);
    assert.equal(headers['x-wm-control-version'], String(CONTROL_PROTOCOL_VERSION));
    assert.equal(headers['x-wm-control-timestamp'], '1786100000');
    assert.equal(headers['x-wm-control-nonce'], 'nonce-0000000000000001');
    assert.equal(headers['x-wm-control-signature'], signature);
  });

  it('enforces a closed per-role route allowlist before network access', async () => {
    let calls = 0;
    const client = makeClient({ fetchImpl: async () => { calls += 1; return success(); } });
    await assert.rejects(
      client.request('/v1/verifier/accept', { attemptId: 'attempt-1' }),
      /not allowed.*mutation/i,
    );
    await assert.rejects(
      client.request('/v1/mutation/acquire/extra', {}),
      /not allowed/i,
    );
    assert.equal(calls, 0);
  });

  it('does not retry an ambiguous state-changing request', async () => {
    let calls = 0;
    const client = makeClient({
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError('socket reset');
      },
    });
    await assert.rejects(
      client.acquire({ owner: 'run:12:1', attemptId: 'attempt-1', headSha: 'a'.repeat(40) }),
      (error) => error instanceof ControlPlaneError && error.code === 'CONTROL_TRANSPORT_AMBIGUOUS',
    );
    assert.equal(calls, 1);
  });

  it('retries operator resolution once with the identical body and accepts the committed replay', async () => {
    const requestBody = {
      operationId: '1'.repeat(64),
      priorId: 'attempt-prior-0001',
      expectedHead: 'a'.repeat(40),
      decision: 'resolve_pre_mutation_hold',
      evidenceId: 'operator-evidence-0001',
      evidenceDigest: 'b'.repeat(64),
    };
    const encodedBodies = [];
    const client = makeClient({
      role: 'operator',
      fetchImpl: async (_url, options) => {
        encodedBodies.push(options.body);
        if (encodedBodies.length === 1) return new Response('unavailable', { status: 503 });
        const parsed = JSON.parse(options.body);
        return success(
          operatorResolutionData(parsed, { evidenceDigest: 'c'.repeat(64) }),
          'OPERATOR_RESOLUTION_RECORDED',
        );
      },
    });

    const result = await client.resolve(requestBody);
    assert.equal(encodedBodies.length, 2);
    assert.equal(encodedBodies[0], encodedBodies[1]);
    assert.equal(JSON.parse(encodedBodies[1]).operationId, requestBody.operationId);
    assert.equal(result.data.evidenceDigest, 'c'.repeat(64));

    let failedCalls = 0;
    const failingClient = makeClient({
      role: 'operator',
      fetchImpl: async () => {
        failedCalls += 1;
        throw new TypeError('socket remains unavailable');
      },
    });
    await assert.rejects(
      failingClient.resolve(requestBody),
      (error) => error instanceof ControlPlaneError
        && error.code === 'CONTROL_TRANSPORT_AMBIGUOUS',
    );
    assert.equal(failedCalls, 2);
  });

  it('does not retry a definitive operator replay collision', async () => {
    let calls = 0;
    const client = makeClient({
      role: 'operator',
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          version: 1,
          ok: false,
          outcome: 'OPERATOR_OPERATION_REUSED',
          error: {
            code: 'OPERATOR_OPERATION_REUSED',
            message: 'operation identity is already bound to different immutable input',
          },
        }), { status: 409, headers: { 'content-type': 'application/json' } });
      },
    });

    await assert.rejects(
      client.resolve({ operationId: '1'.repeat(64) }),
      (error) => error instanceof ControlPlaneError
        && error.code === 'OPERATOR_OPERATION_REUSED'
        && error.definitive,
    );
    assert.equal(calls, 1);
  });

  it('marks every untrusted post-send mutation response as ambiguous without retry', async () => {
    const cases = [
      [new Response('unavailable', { status: 503 }), 'CONTROL_HTTP_RETRYABLE_AMBIGUOUS'],
      [new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }), 'CONTROL_JSON_INVALID_AMBIGUOUS'],
      [success(statusData(), 'STATUS_REPORTED'), 'CONTROL_SCHEMA_INVALID_AMBIGUOUS'],
    ];
    for (const [response, expectedCode] of cases) {
      let calls = 0;
      const client = makeClient({
        fetchImpl: async () => {
          calls += 1;
          return response;
        },
      });
      await assert.rejects(
        client.acquire({ owner: 'run:12:1', attemptId: 'attempt-1', headSha: 'a'.repeat(40) }),
        (error) => error instanceof ControlPlaneError && error.code === expectedCode,
      );
      assert.equal(calls, 1);
    }
  });

  it('retries the read-only watchdog status once on retryable failure', async () => {
    let calls = 0;
    const client = makeClient({
      role: 'watchdog',
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response('unavailable', { status: 503 });
        return success(statusData(), 'STATUS_REPORTED');
      },
    });
    const result = await client.status();
    assert.equal(result.outcome, 'STATUS_REPORTED');
    assert.equal(calls, 2);
  });

  it('accepts the closed pre-dispatch abort outcome on the watchdog rejection route', async () => {
    const client = makeClient({
      role: 'watchdog',
      fetchImpl: async () => success(
        { dispatchHold: { state: 'PRE_DISPATCH_ABORTED' } },
        'PRE_DISPATCH_ABORTED',
      ),
    });
    const result = await client.rejectDispatch({
      recoveryAttemptId: 'recovery-client-abort-0001',
      headSha: 'a'.repeat(40),
      sourceRunId: '31190000001',
      sourceRunAttempt: 1,
      reason: 'PRE_DISPATCH_NOT_STARTED',
      evidenceDigest: 'b'.repeat(64),
    });
    assert.equal(result.outcome, 'PRE_DISPATCH_ABORTED');
    assert.equal(result.data.dispatchHold.state, 'PRE_DISPATCH_ABORTED');
  });

  it('fails closed on redirects, non-JSON, unknown versions, or extra envelope fields', async () => {
    const cases = [
      new Response(JSON.stringify({ version: 1, ok: true, outcome: 'OK', data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      new Response(JSON.stringify({ version: 99, ok: true, outcome: 'OK', data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify({ version: 1, ok: true, outcome: 'OK', data: {}, surprise: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ];
    Object.defineProperty(cases[0], 'redirected', { value: true });
    for (const response of cases) {
      const client = makeClient({ fetchImpl: async () => response });
      await assert.rejects(
        client.acquire({ owner: 'run:12:1', attemptId: 'attempt-1', headSha: 'a'.repeat(40) }),
        /redirect|JSON|version|schema/i,
      );
    }
  });

  it('maps a closed error response without trusting arbitrary provider text', async () => {
    const client = makeClient({
      fetchImpl: async () => new Response(JSON.stringify({
        version: 1,
        ok: false,
        outcome: 'LEASE_HELD',
        error: { code: 'LEASE_HELD', message: 'another owner holds the lease' },
      }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    });
    await assert.rejects(
      client.acquire({ owner: 'run:12:1', attemptId: 'attempt-1', headSha: 'a'.repeat(40) }),
      (error) => error instanceof ControlPlaneError
        && error.code === 'LEASE_HELD'
        && error.outcome === 'LEASE_HELD'
        && error.status === 409,
    );
  });

  it('rejects route-incompatible outcomes, data fields, and mismatched error outcomes', async () => {
    const responses = [
      success(statusData(), 'STATUS_REPORTED'),
      success({ ...acquireData(), unexpected: true }, 'LEASE_GRANTED'),
      new Response(JSON.stringify({
        version: 1,
        ok: false,
        outcome: 'OTHER_ERROR',
        error: { code: 'LEASE_HELD', message: 'another owner holds the lease' },
      }), { status: 409, headers: { 'content-type': 'application/json' } }),
    ];
    for (const response of responses) {
      const client = makeClient({ fetchImpl: async () => response });
      await assert.rejects(
        client.acquire({ owner: 'run:12:1', attemptId: 'attempt-1', headSha: 'a'.repeat(40) }),
        (error) => error instanceof ControlPlaneError
          && error.code === 'CONTROL_SCHEMA_INVALID_AMBIGUOUS',
      );
    }
  });

  it('aborts a request at the configured bound', async () => {
    const client = makeClient({
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    await assert.rejects(
      client.acquire({ owner: 'run:12:1', attemptId: 'attempt-1', headSha: 'a'.repeat(40) }),
      (error) => error instanceof ControlPlaneError && error.code === 'CONTROL_TIMEOUT_AMBIGUOUS',
    );
  });

  it('keeps the same timeout active through response-body consumption', async () => {
    const client = makeClient({
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    await assert.rejects(
      client.acquire({ owner: 'run:12:1', attemptId: 'attempt-1', headSha: 'a'.repeat(40) }),
      (error) => error instanceof ControlPlaneError && error.code === 'CONTROL_TIMEOUT_AMBIGUOUS',
    );
  });
});
