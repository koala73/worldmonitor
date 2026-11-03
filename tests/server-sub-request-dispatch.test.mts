/**
 * Dispatch-layer tests for server-initiated sub-requests (#8399, systemic).
 *
 * The batch endpoint (`tests/batch-execute.test.mts`) proves ONE fan-out
 * charges the caller's budget. This file proves the CLASS: the shared
 * dispatch path in `server/_shared/server-sub-request-dispatch.ts` owns the
 * charge, admission, marker, and fetch that every fan-out inherits, so a new
 * fan-out endpoint cannot omit one of those steps.
 *
 * Invariants pinned here, independently of `/api/batch/v1/execute`:
 *   1. a stamped gateway principal resolves to that principal's own bucket
 *      (never the egress IP), with the credential-derived scope intact;
 *   2. no stamp + a usable caller IP resolves to the caller's IP bucket —
 *      exactly the gateway's own attribution default;
 *   3. no stamp + no usable caller IP (unknown sentinel, RFC 1918 /
 *      link-local egress) resolves `unattributed: true` — and the charge
 *      refuses with 429 `unattributed-sub-request` WITHOUT dispatching and
 *      WITHOUT touching the limiter, i.e. an unattributed sub-request never
 *      receives a fresh egress-keyed allowance;
 *   4. an admitted policy-backed operation charges the limiter once per
 *      sub-operation (the shared path, not a per-endpoint reimplementation);
 *   5. a limiter refusal surfaces as the status/body the caller would have
 *      received directly (429 / fail-closed 503), still without dispatching.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  __resetRateLimitForTest,
  chargeServerSubRequestOperation,
  hasEndpointRatePolicy,
  isUnattributedSubRequestIdentity,
  resolveServerSubRequestCharge,
  TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER,
} from '../server/_shared/rate-limit.ts';
import { dispatchServerSubRequest } from '../server/_shared/server-sub-request-dispatch.ts';
import { SUB_REQUEST_MARKER_HEADER } from '../server/_shared/sub-request-admission.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const POLICY_PATH = '/api/market/v1/list-market-quotes';
const CALLER_IP = '203.0.113.9';

function inboundRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://www.worldmonitor.app/api/fan-out/v1/example', {
    method: 'POST',
    headers: { 'x-real-ip': CALLER_IP, ...headers },
  });
}

function collectLimiterKeys(base: typeof fetch): { keys: string[]; countEvalsha: () => number } {
  const keys: string[] = [];
  let evalsha = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    evalsha += [...body.matchAll(/evalsha/gi)].length;
    for (const match of body.matchAll(/"(rl:[^"]+)"/g)) keys.push(match[1]!);
    return base(input, init);
  }) as typeof fetch;
  return { keys, countEvalsha: () => evalsha };
}

describe('server-initiated sub-request dispatch path (#8399)', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    __resetRateLimitForTest();
    installRedis({});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    __resetRateLimitForTest();
  });

  it('isUnattributedSubRequestIdentity treats egress identities as unattributed', () => {
    assert.equal(isUnattributedSubRequestIdentity('unknown'), true);
    assert.equal(isUnattributedSubRequestIdentity(''), true);
    assert.equal(isUnattributedSubRequestIdentity('10.0.4.15'), true);
    assert.equal(isUnattributedSubRequestIdentity('192.168.1.20'), true);
    assert.equal(isUnattributedSubRequestIdentity('172.16.0.8'), true);
    assert.equal(isUnattributedSubRequestIdentity('169.254.169.254'), true);
    assert.equal(isUnattributedSubRequestIdentity(CALLER_IP), false);
    assert.equal(isUnattributedSubRequestIdentity('198.51.100.23'), false);
  });

  it('resolves a stamped gateway principal to that principal — never the egress IP', () => {
    const charge = resolveServerSubRequestCharge(
      inboundRequest({ [TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER]: 'api_key:user_stamped' }),
    );

    assert.equal(charge.unattributed, false);
    assert.deepEqual(charge.opts, { principalUserId: 'user_stamped', principalScope: 'api_key' });
  });

  it('resolves no stamp + a usable caller IP to the caller IP bucket', () => {
    const charge = resolveServerSubRequestCharge(inboundRequest());

    assert.equal(charge.unattributed, false);
    assert.deepEqual(charge.opts, {});
  });

  it('resolves no stamp + an egress/unknown IP to unattributed (fail closed, not egress-keyed)', () => {
    // `{}` here means NO x-real-ip at all (the unknown sentinel). The
    // default `inboundRequest()` carries a routable caller IP and is covered
    // by the IP-bucket test above — it must stay attributed.
    for (const headers of [
      { 'x-real-ip': '' },
      { 'x-real-ip': '10.0.4.15' },
      { 'x-real-ip': '192.168.1.20' },
    ]) {
      const charge = resolveServerSubRequestCharge(inboundRequest(headers));
      assert.equal(charge.unattributed, true, `expected unattributed for ${JSON.stringify(headers)}`);
      assert.deepEqual(charge.opts, {});
    }
  });

  it('refuses an unattributed sub-request without dispatching and without touching the limiter', async () => {
    const redis = installRedis({});
    const { keys } = collectLimiterKeys(redis.fetchImpl);
    const noIdentity = inboundRequest({ 'x-real-ip': '' });
    const charge = resolveServerSubRequestCharge(noIdentity);

    assert.equal(charge.unattributed, true);

    const refused = await chargeServerSubRequestOperation(
      noIdentity,
      POLICY_PATH,
      charge,
    );

    assert.deepEqual(refused, {
      status: 429,
      body: { error: 'Too many requests', reason: 'unattributed-sub-request' },
    });
    assert.equal(keys.length, 0, 'an unattributed sub-request must not receive an egress-keyed allowance');
  });

  it('charges an admitted policy-backed operation to the caller bucket via the shared path', async () => {
    assert.equal(hasEndpointRatePolicy(POLICY_PATH), true);
    const redis = installRedis({});
    const { keys, countEvalsha } = collectLimiterKeys(redis.fetchImpl);
    const charge = resolveServerSubRequestCharge(inboundRequest());

    const refused = await chargeServerSubRequestOperation(
      inboundRequest(),
      POLICY_PATH,
      charge,
    );

    assert.equal(refused, null, 'the always-allow fake must admit the operation');
    assert.equal(countEvalsha(), 1, 'each sub-operation charges exactly one admission');
    assert.ok(keys.length > 0, 'the charge must reach the limiter');
    for (const key of keys) {
      assert.match(
        key,
        new RegExp(`^rl:ep:${POLICY_PATH}:ip:${CALLER_IP}(:|$)`),
        `shared-path charge must name the sub-operation path and the caller IP, got ${key}`,
      );
    }
  });

  it('charges the stamped principal scope through the shared path, not a raw-header guess', async () => {
    const redis = installRedis({});
    const { keys } = collectLimiterKeys(redis.fetchImpl);
    const stamped = inboundRequest({ [TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER]: 'session:user_stamped' });
    const charge = resolveServerSubRequestCharge(stamped);

    const refused = await chargeServerSubRequestOperation(
      stamped,
      POLICY_PATH,
      charge,
    );

    assert.equal(refused, null);
    assert.ok(keys.length > 0, 'the charge must reach the limiter');
    for (const key of keys) {
      assert.match(key, /:user:user_stamped(:|$)/, `expected the stamped session principal, got ${key}`);
      assert.ok(!key.includes(CALLER_IP), 'a stamped principal must not fall back to IP');
    }
  });

  it('returns the 429 a direct call would have received, without dispatching', async () => {
    const redis = installRedis({});
    const base = redis.fetchImpl;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await base(input, init);
      const commands = JSON.parse(typeof init?.body === 'string' ? init.body : 'null');
      if (!Array.isArray(commands) || !Array.isArray(commands[0])) return response;
      const results = await response.json();
      for (let i = 0; i < commands.length; i += 1) {
        // The shared fake is always-allow; model an exhausted window instead.
        if (String(commands[i][0]).toUpperCase() === 'EVALSHA') {
          results[i] = { result: [-1, Date.now() + 60_000] };
        }
      }
      return Response.json(results);
    }) as typeof fetch;
    __resetRateLimitForTest();

    const charge = resolveServerSubRequestCharge(inboundRequest());
    const refused = await chargeServerSubRequestOperation(
      inboundRequest(),
      POLICY_PATH,
      charge,
    );

    assert.deepEqual(refused, { status: 429, body: { error: 'Too many requests' } });
  });

  it('returns 503 when the limiter is unavailable on a fail-closed policy path', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRateLimitForTest();

    const charge = resolveServerSubRequestCharge(inboundRequest());
    const refused = await chargeServerSubRequestOperation(
      inboundRequest(),
      POLICY_PATH,
      charge,
    );

    assert.deepEqual(refused, {
      status: 503,
      body: { error: 'Rate-limit service temporarily unavailable' },
    });
  });

  it('owns charge, admission, marker attachment, and fetch as one dispatch operation', async () => {
    const redis = installRedis({});
    const { keys } = collectLimiterKeys(redis.fetchImpl);
    const calls: Array<{ url: string; headers: Headers }> = [];
    const result = await dispatchServerSubRequest({
      inbound: inboundRequest(),
      target: new URL(`https://www.worldmonitor.app${POLICY_PATH}?symbols=AAPL`),
      headers: { accept: 'application/json' },
      fetchImpl: async (url, init) => {
        calls.push({ url, headers: new Headers(init?.headers) });
        return Response.json({ ok: true });
      },
    });

    assert.equal(result.kind, 'dispatched');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `https://www.worldmonitor.app${POLICY_PATH}?symbols=AAPL`);
    assert.match(calls[0]!.headers.get(SUB_REQUEST_MARKER_HEADER) ?? '', /^[0-9a-f-]{36}$/);
    assert.ok(keys.length > 0, 'dispatch must charge the caller before it fetches');
  });

  it('refuses unsafe or unattributed dispatches before fetch', async () => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return Response.json({ ok: true });
    };
    const crossOrigin = await dispatchServerSubRequest({
      inbound: inboundRequest(),
      target: new URL(`https://example.com${POLICY_PATH}`),
      headers: {},
      fetchImpl,
    });
    const unattributed = await dispatchServerSubRequest({
      inbound: inboundRequest({ 'x-real-ip': '' }),
      target: new URL(`https://www.worldmonitor.app${POLICY_PATH}`),
      headers: {},
      fetchImpl,
    });

    assert.deepEqual(crossOrigin, {
      kind: 'refused',
      status: 400,
      body: { error: 'Cross-origin sub-requests are not allowed' },
    });
    assert.equal(unattributed.kind, 'refused');
    assert.equal(unattributed.status, 429);
    assert.equal(fetches, 0);
  });
});
