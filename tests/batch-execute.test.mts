import { issueSubRequestAdmission } from '../server/_shared/sub-request-admission.ts';
/**
 * Unit + gateway tests for the generic REST batch endpoint
 * (POST /api/batch/v1/execute, server/worldmonitor/batch/v1/execute-batch.ts).
 *
 * The handler re-dispatches each operation as a same-origin GET through the
 * public gateway, so the security posture rests on five invariants pinned
 * here:
 *   1. only same-origin, documented-RPC-shaped paths are fetched (SSRF guard);
 *   2. credentials and negotiation headers cross with an opaque admission;
 *      cookies and trusted principal stamps do not;
 *   3. a batch can never recurse (marker header + /api/batch/* path both
 *      refuse);
 *   4. the endpoint itself is NOT public — anonymous callers get 401 from the
 *      gateway before the fan-out runs;
 *   5. every sub-operation is charged to the BATCH CALLER's own rate-limit
 *      bucket before dispatch. The sub-request's own gateway pass keys its
 *      limits to the platform's fetch egress IP, so without this pre-charge a
 *      batch is a per-IP quota bypass. The inner gateway pass skips its own
 *      limiter for marked sub-requests (the pre-charge is the admission), so
 *      admitted operations are charged exactly once — never egress-keyed.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  createExecuteBatch,
  BATCH_MARKER_HEADER,
  MAX_BATCH_OPERATIONS,
  MAX_SUB_RESPONSE_BYTES,
} from '../server/worldmonitor/batch/v1/execute-batch.ts';
import type { FetchLike } from '../server/worldmonitor/batch/v1/execute-batch.ts';
import {
  __resetRateLimitForTest,
  hasEndpointRatePolicy,
  SUB_REQUEST_MARKER_HEADER,
  TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER,
} from '../server/_shared/rate-limit.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const ORIGIN = 'https://www.worldmonitor.app';
const CALLER_IP = '203.0.113.9';

function makeCtx(headers: Record<string, string> = {}) {
  const request = new Request(`${ORIGIN}/api/batch/v1/execute`, {
    method: 'POST',
    headers: { 'x-real-ip': CALLER_IP, ...headers },
  });
  return { request, pathParams: {}, headers: Object.fromEntries(request.headers.entries()) };
}

type RecordedCall = { url: string; init: RequestInit };

function recordingFetch(
  respond: (url: string) => Response | Promise<Response> = () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
): { calls: RecordedCall[]; fetchImpl: FetchLike } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return respond(url);
  };
  return { calls, fetchImpl };
}

describe('executeBatch handler', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // The pre-dispatch caller charge is a real limiter call. The shared fake is
    // always-allow, so these tests exercise the admitted path; the refusal
    // paths install their own transport below.
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

  it('fans out operations as same-origin GETs and aggregates results in order', async () => {
    const { calls, fetchImpl } = recordingFetch((url) =>
      url.includes('get-fear-greed-index')
        ? new Response(JSON.stringify({ compositeScore: 42 }), { status: 200 })
        : new Response(JSON.stringify({ message: 'not found' }), { status: 404 }),
    );
    const executeBatch = createExecuteBatch(fetchImpl);

    const res = await executeBatch(makeCtx(), {
      operations: [
        { id: 'fg', path: '/api/market/v1/get-fear-greed-index' },
        { id: '', path: '/api/market/v1/list-market-quotes' },
      ],
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, `${ORIGIN}/api/market/v1/get-fear-greed-index`);
    assert.equal(calls[0]!.init.method, 'GET');
    assert.deepEqual(res.results[0], { id: 'fg', status: 200, body: { compositeScore: 42 }, error: '' });
    // Blank id defaults to the zero-based index.
    assert.equal(res.results[1]!.id, '1');
    assert.equal(res.results[1]!.status, 404);
    assert.equal(res.succeeded, 1);
    assert.equal(res.failed, 1);
  });

  it('preserves query strings (filters + jmespath projections) on sub-requests', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    await executeBatch(makeCtx(), {
      operations: [{ id: 'r', path: '/api/intelligence/v1/get-country-risk?country=DE&jmespath=score' }],
    });

    assert.equal(calls[0]!.url, `${ORIGIN}/api/intelligence/v1/get-country-risk?country=DE&jmespath=score`);
  });

  it('forwards only credential/negotiation headers and stamps the batch marker', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    await executeBatch(
      makeCtx({
        Authorization: 'Bearer wm_deadbeef',
        'X-WorldMonitor-Key': 'wm_cafebabe',
        Cookie: 'session=secret',
        'x-user-id': 'user_123',
        'User-Agent': 'my-agent/2.0',
      }),
      { operations: [{ id: 'a', path: '/api/market/v1/get-fear-greed-index' }] },
    );

    const sent = new Headers(calls[0]!.init.headers as HeadersInit);
    assert.equal(sent.get('authorization'), 'Bearer wm_deadbeef');
    assert.equal(sent.get('x-worldmonitor-key'), 'wm_cafebabe');
    assert.equal(sent.get(BATCH_MARKER_HEADER), '1');
    assert.equal(sent.get('accept'), 'application/json');
    assert.equal(sent.get('user-agent'), 'my-agent/2.0');
    // Cookies and the legacy user-id trust marker must never cross into
    // sub-requests.
    assert.equal(sent.get('cookie'), null);
    assert.equal(sent.get('x-user-id'), null);
    // A fresh request-bound admission crosses instead of a trusted principal.
    assert.match(sent.get(SUB_REQUEST_MARKER_HEADER) ?? '', /^[0-9a-f-]{36}$/);
  });

  it('sends a descriptive default User-Agent when the caller omits one (CF WAF rejects generic UAs)', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    await executeBatch(makeCtx(), { operations: [{ id: 'a', path: '/api/market/v1/get-fear-greed-index' }] });

    const sent = new Headers(calls[0]!.init.headers as HeadersInit);
    assert.match(sent.get('user-agent') ?? '', /WorldMonitor-Batch/);
  });

  it('rejects non-RPC and cross-origin paths per-operation without fetching', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    const res = await executeBatch(makeCtx(), {
      operations: [
        { id: 'abs', path: 'https://evil.com/api/market/v1/get-fear-greed-index' },
        { id: 'scheme-rel', path: '//evil.com/api/market/v1/get-fear-greed-index' },
        { id: 'no-slash', path: 'api/market/v1/get-fear-greed-index' },
        { id: 'not-rpc', path: '/api/mcp' },
        { id: 'upper', path: '/API/market/v1/get-fear-greed-index' },
        { id: 'ok', path: '/api/v2/shipping/route-intelligence' },
      ],
    });

    // Only the valid v2 path reached fetch.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `${ORIGIN}/api/v2/shipping/route-intelligence`);
    for (const bad of res.results.slice(0, 5)) {
      assert.equal(bad.status, 0);
      assert.equal(bad.error, 'invalid_path');
    }
    assert.equal(res.failed, 5);
  });

  it('refuses nested batches: batched /api/batch/* paths and marked inbound requests', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    const res = await executeBatch(makeCtx(), {
      operations: [{ id: 'n', path: '/api/batch/v1/execute' }],
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(res.results[0], { id: 'n', status: 0, error: 'nested_batch' });

    await assert.rejects(
      executeBatch(makeCtx({ [BATCH_MARKER_HEADER]: '1' }), {
        operations: [{ id: 'a', path: '/api/market/v1/get-fear-greed-index' }],
      }),
      (err: Error & { statusCode?: number }) => err.name === 'ApiError' && err.statusCode === 400,
    );
  });

  it('rejects empty, oversized, and duplicate-id batches with a ValidationError', async () => {
    const executeBatch = createExecuteBatch(recordingFetch().fetchImpl);

    await assert.rejects(
      executeBatch(makeCtx(), { operations: [] }),
      (err: Error) => err.name === 'ValidationError',
    );
    await assert.rejects(
      executeBatch(makeCtx(), {
        operations: Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, (_, i) => ({
          id: String(i),
          path: '/api/market/v1/get-fear-greed-index',
        })),
      }),
      (err: Error) => err.name === 'ValidationError',
    );
    await assert.rejects(
      executeBatch(makeCtx(), {
        operations: [
          { id: 'dup', path: '/api/market/v1/get-fear-greed-index' },
          { id: 'dup', path: '/api/market/v1/list-market-quotes' },
        ],
      }),
      (err: Error) => err.name === 'ValidationError',
    );
  });

  it('maps transport failures to per-operation error codes', async () => {
    const timeoutErr = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const executeBatch = createExecuteBatch(async (url) => {
      if (url.includes('list-market-quotes')) throw timeoutErr;
      if (url.includes('get-fear-greed-index')) throw new TypeError('fetch failed');
      return new Response('not json at all', { status: 200 });
    });

    const res = await executeBatch(makeCtx(), {
      operations: [
        { id: 'to', path: '/api/market/v1/list-market-quotes' },
        { id: 'net', path: '/api/market/v1/get-fear-greed-index' },
        { id: 'bad', path: '/api/market/v1/list-crypto-quotes' },
      ],
    });

    assert.deepEqual(res.results[0], { id: 'to', status: 0, error: 'timeout' });
    assert.deepEqual(res.results[1], { id: 'net', status: 0, error: 'fetch_failed' });
    assert.equal(res.results[2]!.error, 'invalid_json');
    assert.equal(res.results[2]!.status, 200);
    assert.equal(res.succeeded, 0);
    assert.equal(res.failed, 3);
  });

  it('charges every sub-operation to the CALLER\'s bucket, not the platform egress', async () => {
    // The limiter key proves attribution: it must carry the sub-operation's
    // own path AND the inbound caller's IP. A key derived inside the
    // re-dispatched sub-request would carry the platform's egress IP instead.
    const redis = installRedis({});
    const base = redis.fetchImpl;
    let admissions = 0;
    const keys: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      admissions += [...body.matchAll(/evalsha/gi)].length;
      // Concurrent limiter calls are auto-pipelined into one HTTP request, and
      // the sliding window touches two window keys per admission — so count
      // EVALSHA commands and assert separately on the key SHAPE.
      for (const match of body.matchAll(/"(rl:[^"]+)"/g)) keys.push(match[1]!);
      return base(input, init);
    }) as typeof fetch;

    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    await executeBatch(makeCtx(), {
      operations: [
        { id: 'a', path: '/api/market/v1/list-market-quotes' },
        { id: 'b', path: '/api/market/v1/list-market-quotes?symbols=AAPL' },
      ],
    });

    assert.equal(calls.length, 2, 'admitted operations still dispatch');
    assert.equal(admissions, 2, 'each operation charges its own admission');
    assert.ok(keys.length > 0, 'the caller charge must reach the limiter');
    for (const key of keys) {
      assert.match(
        key,
        new RegExp(`^rl:ep:/api/market/v1/list-market-quotes:ip:${CALLER_IP}(:|$)`),
        `limiter key must name the sub-operation path and the caller's identity, got ${key}`,
      );
    }
  });

  it('refuses a policy-backed sub-operation without dispatching when the limiter is unavailable', async () => {
    // The endpoint registry fails closed by design; that posture has to extend
    // to batch fan-out, or the batch becomes the way around it during an
    // Upstash outage.
    const policyPath = '/api/market/v1/list-market-quotes';
    const unguardedPath = '/api/market/v1/get-fear-greed-index';
    assert.equal(hasEndpointRatePolicy(policyPath), true);
    assert.equal(hasEndpointRatePolicy(unguardedPath), false);

    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRateLimitForTest();

    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    const res = await executeBatch(makeCtx(), {
      operations: [
        { id: 'guarded', path: policyPath },
        { id: 'unguarded', path: unguardedPath },
      ],
    });

    assert.equal(res.results[0]!.status, 503);
    assert.deepEqual(res.results[0]!.body, { error: 'Rate-limit service temporarily unavailable' });
    // No admission proof can be issued during a Redis outage. Do not dispatch
    // under an egress identity, even for an otherwise fail-open read.
    assert.equal(res.results[1]!.status, 503);
    assert.equal(calls.length, 0);
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

    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    const res = await executeBatch(makeCtx(), {
      operations: [{ id: 'over', path: '/api/market/v1/list-market-quotes' }],
    });

    assert.equal(calls.length, 0, 'a refused operation must never reach the gateway');
    assert.equal(res.results[0]!.status, 429);
    assert.deepEqual(res.results[0]!.body, { error: 'Too many requests' });
    assert.equal(res.succeeded, 0);
    assert.equal(res.failed, 1);
  });

  it('charges the gateway-stamped principal, not a guess from raw credential headers', async () => {
    // The gateway stamps the principal it actually charged. A raw `wm_` header
    // is unvalidated, so inferring `api_key` from it would let a session caller
    // select the separate api_key bucket and split traffic across two budgets.
    const redis = installRedis({});
    const base = redis.fetchImpl;
    const keys: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      for (const match of body.matchAll(/"(rl:[^"]+)"/g)) keys.push(match[1]!);
      return base(input, init);
    }) as typeof fetch;

    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    await executeBatch(
      makeCtx({
        [TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER]: 'api_key:user_stamped',
        // Deliberately contradicts the stamp; the handler must ignore it.
        'X-WorldMonitor-Key': 'wm_unvalidated',
      }),
      { operations: [{ id: 'a', path: '/api/market/v1/list-market-quotes' }] },
    );

    assert.ok(keys.length > 0, 'the caller charge must reach the limiter');
    for (const key of keys) {
      assert.match(key, /:apikey-user:user_stamped(:|$)/, `expected the stamped principal, got ${key}`);
      assert.ok(!key.includes(CALLER_IP), 'a stamped principal must not fall back to IP');
    }
    // Principal stamps stay local; the inner gateway verifies the admission.
    const sent = new Headers(calls[0]!.init.headers as HeadersInit);
    assert.equal(sent.get(TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER), null);
    assert.match(sent.get(SUB_REQUEST_MARKER_HEADER) ?? '', /^[0-9a-f-]{36}$/);
  });

  it('falls back to the caller IP when the stamped principal is absent or malformed', async () => {
    const redis = installRedis({});
    const base = redis.fetchImpl;
    const keys: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      for (const match of body.matchAll(/"(rl:[^"]+)"/g)) keys.push(match[1]!);
      return base(input, init);
    }) as typeof fetch;

    const executeBatch = createExecuteBatch(recordingFetch().fetchImpl);

    // An unknown scope must not become a principal — it degrades to IP, never
    // to an attacker-named bucket.
    await executeBatch(
      makeCtx({ [TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER]: 'enterprise:user_forged' }),
      { operations: [{ id: 'a', path: '/api/market/v1/list-market-quotes' }] },
    );

    assert.ok(keys.length > 0, 'the caller charge must reach the limiter');
    for (const key of keys) {
      assert.ok(key.includes(`:ip:${CALLER_IP}`), `expected an IP bucket, got ${key}`);
      assert.ok(!key.includes('user_forged'), 'an unrecognised scope must not name the bucket');
    }
  });

  it('caps per-operation response size via Content-Length', async () => {
    const executeBatch = createExecuteBatch(async () =>
      new Response('{}', {
        status: 200,
        headers: { 'Content-Length': String(MAX_SUB_RESPONSE_BYTES + 1) },
      }),
    );

    const res = await executeBatch(makeCtx(), {
      operations: [{ id: 'big', path: '/api/market/v1/get-fear-greed-index' }],
    });

    assert.equal(res.results[0]!.error, 'response_too_large');
    assert.equal(res.failed, 1);
  });
});

describe('batch gateway access', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('refuses a forged sub-request marker on the outer caller request', async () => {
    // The sub-request marker is gateway-internal and travels only on
    // re-dispatched sub-requests (which skip the inner limiter because the
    // outer pre-charge was the admission). The outer caller request must
    // never carry it: a client that forges it would otherwise claim
    // server-initiated status. The batch recursion guard refuses it with
    // the same 400 as a nested batch, before any fan-out runs.
    const [{ createDomainGateway, serverOptions }, generated, { batchHandler }] = await Promise.all([
      import('../server/gateway.ts'),
      import('../src/generated/server/worldmonitor/batch/v1/service_server.ts'),
      import('../server/worldmonitor/batch/v1/handler.ts'),
    ]);
    delete process.env.WORLDMONITOR_VALID_KEYS;
    process.env.WM_SESSION_SECRET = 'synthetic-batch-marker-secret-at-least-32-bytes';
    installRedis({});
    __resetRateLimitForTest();
    const { issueSessionToken } = await import('../api/_session.js');

    const token = (await issueSessionToken()).token;
    const gateway = createDomainGateway(generated.createBatchServiceRoutes(batchHandler, serverOptions));
    const res = await gateway(
      new Request(`${ORIGIN}/api/batch/v1/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          'X-WorldMonitor-Key': token,
          'x-real-ip': CALLER_IP,
          [SUB_REQUEST_MARKER_HEADER]: '1',
        },
        body: JSON.stringify({ operations: [{ id: 'a', path: '/api/market/v1/list-market-quotes' }] }),
      }),
    );

    assert.equal(res.status, 400);
  });

  it('strips a client-supplied principal stamp before the fan-out charges it', async () => {
    // The stamp is gateway-internal. If an inbound copy survived to the
    // handler, any caller could name the bucket their batch is charged to.
    const [{ createDomainGateway, serverOptions }, generated, { batchHandler }] = await Promise.all([
      import('../server/gateway.ts'),
      import('../src/generated/server/worldmonitor/batch/v1/service_server.ts'),
      import('../server/worldmonitor/batch/v1/handler.ts'),
    ]);
    delete process.env.WORLDMONITOR_VALID_KEYS;
    process.env.WM_SESSION_SECRET = 'synthetic-batch-principal-secret-at-least-32-bytes';
    const redis = installRedis({});
    __resetRateLimitForTest();
    const { issueSessionToken } = await import('../api/_session.js');

    const keys: string[] = [];
    const base = redis.fetchImpl;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/market/v1/')) {
        return Response.json({ ok: true });
      }
      const body = typeof init?.body === 'string' ? init.body : '';
      for (const match of body.matchAll(/"(rl:[^"]+)"/g)) keys.push(match[1]!);
      return base(input, init);
    }) as typeof fetch;

    const token = (await issueSessionToken()).token;
    const gateway = createDomainGateway(generated.createBatchServiceRoutes(batchHandler, serverOptions));
    const res = await gateway(
      new Request(`${ORIGIN}/api/batch/v1/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          'X-WorldMonitor-Key': token,
          'x-real-ip': CALLER_IP,
          [TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER]: 'api_key:user_forged',
        },
        body: JSON.stringify({ operations: [{ id: 'a', path: '/api/market/v1/list-market-quotes' }] }),
      }),
    );

    assert.equal(res.status, 200);
    const subOpKeys = keys.filter((key) => key.includes('/api/market/v1/list-market-quotes'));
    assert.ok(subOpKeys.length > 0, 'the sub-operation must be charged');
    for (const key of keys) {
      assert.ok(!key.includes('user_forged'), `a forged principal reached the limiter: ${key}`);
    }
    for (const key of subOpKeys) {
      assert.ok(key.includes(`:ip:${CALLER_IP}`), `expected the caller's IP bucket, got ${key}`);
    }
  });

  it('skips prepaid limits only with a valid single-use admission', async () => {
    const [{ createDomainGateway }] = await Promise.all([
      import('../server/gateway.ts'),
    ]);
    const stubRoutes = [
      {
        method: 'GET',
        path: '/api/intelligence/v1/list-material-events',
        handler: async () => new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      },
    ];
    // Sanity: the stub really is a no-policy global-fallback path, so the
    // probe exercises the gateway limiter and nothing else.
    assert.equal(hasEndpointRatePolicy('/api/intelligence/v1/list-material-events'), false);

    async function gatewayLimiterAdmissions(mode: 'plain' | 'forged' | 'valid' | 'replay'): Promise<{ status: number; admissions: number }> {
      const redis = installRedis({});
      __resetRateLimitForTest();
      // A session token satisfies the non-public auth gate on the stub; the
      // limiter assertions below are independent of which bucket it selects.
      process.env.WM_SESSION_SECRET = 'synthetic-inner-skip-secret-at-least-32-bytes';
      const { issueSessionToken } = await import('../api/_session.js');
      const token = (await issueSessionToken()).token;
      const keys: string[] = [];
      const base = redis.fetchImpl;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        for (const match of body.matchAll(/"(rl:[^"]+)"/g)) keys.push(match[1]!);
        return base(input, init);
      }) as typeof fetch;
      const gateway = createDomainGateway(stubRoutes);
      const headers: Record<string, string> = {
        Origin: ORIGIN,
        'X-WorldMonitor-Key': token,
        'x-real-ip': '66.249.1.1',
        [TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER]: 'api_key:user_stamped',
      };
      const url = `${ORIGIN}/api/intelligence/v1/list-material-events`;
      if (mode === 'forged') headers[SUB_REQUEST_MARKER_HEADER] = '1';
      if (mode === 'valid' || mode === 'replay') {
        const admission = await issueSubRequestAdmission(new Request(url, { headers }));
        assert.ok(admission);
        headers[SUB_REQUEST_MARKER_HEADER] = admission;
      }
      if (mode === 'replay') {
        await (await gateway(new Request(url, { headers }))).text();
        keys.length = 0;
      }
      const res = await gateway(new Request(url, { headers }));
      // Drain the body so the gateway's cache-header path settles before the
      // next installRedis replaces globalThis.fetch.
      await res.text();
      return { status: res.status, admissions: keys.length };
    }

    const control = await gatewayLimiterAdmissions('plain');
    assert.equal(control.status, 200);
    assert.ok(control.admissions > 0, 'control: an unmarked request must be charged by the gateway');

    const marked = await gatewayLimiterAdmissions('valid');
    assert.equal(marked.status, 200);
    assert.equal(marked.admissions, 0, 'a marked sub-request must not consume a second (egress-keyed) admission');
    for (const mode of ['forged', 'replay'] as const) {
      const rejected = await gatewayLimiterAdmissions(mode);
      assert.equal(rejected.status, 200);
      assert.ok(rejected.admissions > 0, `${mode} proof must not waive limits`);
    }
  });

  it('accepts a principal-bound admission on a public inner route without charging egress', async () => {
    const [{ createDomainGateway }] = await Promise.all([
      import('../server/gateway.ts'),
    ]);
    const path = '/api/intelligence/v1/get-china-decision-signals';
    const redis = installRedis({});
    __resetRateLimitForTest();
    const keys: string[] = [];
    const base = redis.fetchImpl;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      for (const match of body.matchAll(/"(rl:[^"]+)"/g)) keys.push(match[1]!);
      return base(input, init);
    }) as typeof fetch;
    const gateway = createDomainGateway([{
      method: 'GET',
      path,
      handler: async () => Response.json({ ok: true }),
    }]);
    const headers = new Headers({ Origin: ORIGIN, 'x-real-ip': '66.249.1.1' });
    const admission = await issueSubRequestAdmission(
      new Request(`${ORIGIN}${path}`, { headers }),
      'api_key:user_stamped',
    );
    assert.ok(admission);
    headers.set(SUB_REQUEST_MARKER_HEADER, admission);

    const response = await gateway(new Request(`${ORIGIN}${path}`, { headers }));
    await response.text();

    assert.equal(response.status, 200);
    assert.equal(keys.length, 0, 'the public inner route must not charge the platform egress IP');
  });

  it('fails closed when a marked admission cannot be verified', async () => {
    const [{ createDomainGateway }] = await Promise.all([
      import('../server/gateway.ts'),
    ]);
    const path = '/api/intelligence/v1/get-china-decision-signals';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRateLimitForTest();
    const gateway = createDomainGateway([{
      method: 'GET',
      path,
      handler: async () => Response.json({ ok: true }),
    }]);
    const response = await gateway(new Request(`${ORIGIN}${path}`, {
      headers: {
        Origin: ORIGIN,
        'x-real-ip': '66.249.1.1',
        [SUB_REQUEST_MARKER_HEADER]: crypto.randomUUID(),
      },
    }));

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.equal(response.headers.get('Retry-After'), '5');
  });

  it('charges one endpoint admission and one account meter per real batch operation', async () => {
    const [{ createDomainGateway, serverOptions }, generated] = await Promise.all([
      import('../server/gateway.ts'),
      import('../src/generated/server/worldmonitor/batch/v1/service_server.ts'),
    ]);
    process.env.API_RATE_LIMIT_ENFORCE = 'true';
    process.env.CONVEX_SITE_URL = 'https://batch-test.convex.site';
    process.env.CONVEX_SERVER_SHARED_SECRET = 'batch-test-secret';
    process.env.WORLDMONITOR_VALID_KEYS = 'operator-key';
    const redis = installRedis({});
    __resetRateLimitForTest();
    const key = `wm_${'d'.repeat(40)}`;
    const userId = 'user_batch_meter_review';
    const path = '/api/market/v1/list-market-quotes';
    const keys: string[] = [];
    let daily = 0;
    let handlers = 0;
    const inner = createDomainGateway([{
      method: 'GET', path,
      handler: async () => { handlers += 1; return Response.json({ quotes: [] }); },
    }]);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/internal-validate-api-key')) return Response.json({ userId });
      if (url.includes('/api/internal-entitlements')) return Response.json({
        planKey: 'api_starter', validUntil: Date.now() + 86_400_000,
        features: { tier: 2, apiAccess: true, apiRateLimit: 60, apiDailyAllowance: 2 },
      });
      if (url.startsWith(`${ORIGIN}${path}`)) return inner(new Request(url, init));
      const body = typeof init?.body === 'string' ? init.body : '';
      for (const match of body.matchAll(/"(rl:[^"]+)"/g)) keys.push(match[1]!);
      const commands = body ? JSON.parse(body) : [];
      if (Array.isArray(commands[0])) {
        daily += commands.filter((cmd: unknown[]) => cmd[0] === 'INCR' && String(cmd[1]).includes('rl:apikey:day:')).length;
      }
      return redis.fetchImpl(input, init);
    }) as typeof fetch;
    const executeBatch = createExecuteBatch();
    const outer = createDomainGateway(generated.createBatchServiceRoutes({ executeBatch }, serverOptions));
    const response = await outer(new Request(`${ORIGIN}/api/batch/v1/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': key, 'x-real-ip': CALLER_IP },
      body: JSON.stringify({ operations: [{ id: 'a', path }, { id: 'b', path }] }),
    }));
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.deepEqual(result.results.map((op: { status: number }) => op.status).sort(), [200, 429]);
    assert.equal(handlers, 1, 'outer account admission leaves room for only one operation');
    assert.equal(daily, 3, 'outer call and both attempted operations use the daily meter');
    const endpointKeys = keys.filter(k => k.includes(`rl:ep:${path}:apikey-user:${userId}:`));
    // Upstash touches two sliding windows per admission.
    assert.equal(endpointKeys.length, 4, 'two operations must have only two endpoint admissions');
  });

  it('is NOT public and not premium: anonymous POST gets 401 before any fan-out', async () => {
    const [{ createDomainGateway, PUBLIC_NO_AUTH_RPC_PATHS, serverOptions }, generated, { batchHandler }, { PREMIUM_RPC_PATHS }] = await Promise.all([
      import('../server/gateway.ts'),
      import('../src/generated/server/worldmonitor/batch/v1/service_server.ts'),
      import('../server/worldmonitor/batch/v1/handler.ts'),
      import('../src/shared/premium-paths.ts'),
    ]);
    delete process.env.WORLDMONITOR_VALID_KEYS;
    installRedis({});

    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has('/api/batch/v1/execute'), false);
    assert.equal(PREMIUM_RPC_PATHS.has('/api/batch/v1/execute'), false);

    const gateway = createDomainGateway(generated.createBatchServiceRoutes(batchHandler, serverOptions));
    const res = await gateway(
      new Request('https://www.worldmonitor.app/api/batch/v1/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: [{ id: 'a', path: '/api/market/v1/get-fear-greed-index' }] }),
      }),
    );
    assert.equal(res.status, 401);
  });
});
