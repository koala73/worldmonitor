// Tests for the M9 (fail-closed posture + audible Redis errors) and M16
// (drop spoofable x-forwarded-for fallback) fixes from issue #3531.
//
// Both `server/_shared/rate-limit.ts` and `api/_rate-limit.js` mirror the
// same getClientIp + degraded-response behaviour; this file exercises the
// canonical TypeScript module. The api/ mirror is covered by inspection
// of the shared constants (RATE_LIMIT_DEGRADED_HEADERS) and an additional
// import smoke test below.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ENDPOINT_RATE_POLICIES,
  FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
  GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES,
  RATE_LIMIT_DEGRADED_HEADERS,
  UNKNOWN_CLIENT_IP,
  __ENDPOINT_LIMITER_DEADLINES_FOR_TEST,
  __resetRateLimitForTest,
  checkEndpointRateLimit,
  checkFailClosedScopedIpRateLimit,
  checkRateLimit,
  checkScopedRateLimit,
  getClientIp,
  rateLimitErrorLevel,
  rateLimitFingerprintStage,
} from '../server/_shared/rate-limit.ts';
// @ts-expect-error — JS module, no declaration file
import { rateLimitErrorLevel as apiRateLimitErrorLevel, rateLimitFingerprintStage as apiRateLimitFingerprintStage } from '../api/_rate-limit.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalConsoleError = console.error;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://worldmonitor.app/api/test', { headers });
}

async function importFreshRateLimitModule() {
  return import(`../server/_shared/rate-limit.ts?test=${Date.now()}-${Math.random()}`);
}

describe('rate-limit getClientIp (#3531 — drop spoofable x-forwarded-for)', () => {
  afterEach(() => { delete process.env.CF_EDGE_PROOF_SECRET; });

  it('prefers cf-connecting-ip when Cloudflare proof is present', () => {
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
    const req = makeRequest({
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': '192.0.2.5',
      'x-forwarded-for': '198.51.100.8',
      'x-wm-edge-proof': 'edge-secret-xyz',
    });
    assert.equal(getClientIp(req), '203.0.113.7');
  });

  it('falls back to x-real-ip when cf-connecting-ip is absent', () => {
    const req = makeRequest({
      'x-real-ip': '192.0.2.5',
      'x-forwarded-for': '198.51.100.8',
    });
    assert.equal(getClientIp(req), '192.0.2.5');
  });

  it('returns the UNKNOWN_CLIENT_IP sentinel when only x-forwarded-for is present', () => {
    // Direct request bypassing CF — only x-forwarded-for set. Honouring it
    // would let an attacker rotate identities by toggling the header.
    const req = makeRequest({ 'x-forwarded-for': '198.51.100.8, 203.0.113.10' });
    assert.equal(getClientIp(req), UNKNOWN_CLIENT_IP);
    assert.equal(getClientIp(req), 'unknown');
  });

  it('returns UNKNOWN_CLIENT_IP when no client-IP headers are present', () => {
    assert.equal(getClientIp(makeRequest({})), UNKNOWN_CLIENT_IP);
  });

  it('treats whitespace-only header values as absent', () => {
    const req = makeRequest({ 'cf-connecting-ip': '   ', 'x-real-ip': '192.0.2.5' });
    assert.equal(getClientIp(req), '192.0.2.5');
  });
});

describe('rate-limit getClientIp — Cloudflare edge-proof (GHSA-c267)', () => {
  afterEach(() => { delete process.env.CF_EDGE_PROOF_SECRET; });

  it('unconfigured (no CF_EDGE_PROOF_SECRET): ignores cf-connecting-ip and uses x-real-ip', () => {
    delete process.env.CF_EDGE_PROOF_SECRET;
    const req = makeRequest({ 'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '192.0.2.5' });
    assert.equal(getClientIp(req), '192.0.2.5');
  });

  it('configured + valid proof header: trusts cf-connecting-ip', () => {
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
    const req = makeRequest({
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': '192.0.2.5',
      'x-wm-edge-proof': 'edge-secret-xyz',
    });
    assert.equal(getClientIp(req), '203.0.113.7');
  });

  it('configured + MISSING proof: ignores spoofable cf-connecting-ip, uses x-real-ip', () => {
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
    const req = makeRequest({ 'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '192.0.2.5' });
    assert.equal(getClientIp(req), '192.0.2.5');
  });

  it('configured + WRONG proof: ignores cf-connecting-ip, uses x-real-ip', () => {
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
    const req = makeRequest({
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': '192.0.2.5',
      'x-wm-edge-proof': 'wrong-secret',
    });
    assert.equal(getClientIp(req), '192.0.2.5');
  });

  it('configured + no proof + no x-real-ip: shared UNKNOWN bucket (spoofed cf-connecting-ip cannot rotate identities)', () => {
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
    const req = makeRequest({ 'cf-connecting-ip': '203.0.113.7' });
    assert.equal(getClientIp(req), UNKNOWN_CLIENT_IP);
  });
});

describe('rate-limit fail-open / fail-closed posture (#3531 M9)', () => {
  let consoleErrors: string[] = [];

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    consoleErrors = [];
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map((a) => String(a)).join(' '));
    };
    // Make every Upstash REST call throw so we exercise the catch branch.
    globalThis.fetch = async () => {
      throw new Error('upstash unreachable');
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    restoreEnv();
  });

  it('checkRateLimit defaults to fail-open and logs a structured Redis error', async () => {
    const res = await checkRateLimit(makeRequest({ 'cf-connecting-ip': '203.0.113.7' }), {});
    assert.equal(res, null, 'fail-open should let the request through');
    assert.ok(
      consoleErrors.some(
        (line) =>
          line.includes('[rate-limit] redis-error') &&
          line.includes('stage=checkRateLimit') &&
          line.includes('upstash unreachable'),
      ),
      `expected a structured rate-limit error log, got: ${consoleErrors.join('\n')}`,
    );
  });

  it('checkRateLimit returns 503 with the degraded marker when failClosed=true', async () => {
    const res = await checkRateLimit(
      makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      { 'Access-Control-Allow-Origin': 'https://worldmonitor.app' },
      { failClosed: true },
    );
    assert.ok(res, 'expected a Response when fail-closed');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.equal(res.headers.get('Retry-After'), '5');
    assert.equal(
      res.headers.get('Access-Control-Allow-Origin'),
      'https://worldmonitor.app',
      'CORS headers should be propagated on the degraded response',
    );
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /unavailable/i);
  });

  it('checkRateLimit returns degraded 503 when failClosed=true and Upstash env is missing', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const mod = await importFreshRateLimitModule();

    const res = await mod.checkRateLimit(
      makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      { 'Access-Control-Allow-Origin': 'https://worldmonitor.app' },
      { failClosed: true },
    );

    assert.ok(res, 'expected a degraded response when fail-closed limiter is unconfigured');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.equal(res.headers.get('Retry-After'), '5');
  });

  it('checkEndpointRateLimit defaults to fail-CLOSED for endpoints with an explicit policy', async () => {
    // Per-endpoint policies exist precisely because the limit IS the abuse
    // defence (3/hr lead-capture, LLM, sanctions lookup). A Redis blip must
    // not silently lift those budgets.
    const res = await checkEndpointRateLimit(
      makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      '/api/leads/v1/submit-contact',
      {},
    );
    assert.ok(res, 'expected a Response from fail-closed endpoint policy');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.ok(
      consoleErrors.some((line) =>
        line.includes('stage=checkEndpointRateLimit:/api/leads/v1/submit-contact'),
      ),
      `expected per-endpoint stage in the log, got: ${consoleErrors.join('\n')}`,
    );
  });

  it('checkEndpointRateLimit caller can opt into fail-open via failClosed=false', async () => {
    const res = await checkEndpointRateLimit(
      makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      '/api/leads/v1/submit-contact',
      {},
      { failClosed: false },
    );
    assert.equal(res, null);
  });

  it('checkEndpointRateLimit returns degraded 503 for explicit policies when Upstash env is missing', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const mod = await importFreshRateLimitModule();

    const res = await mod.checkEndpointRateLimit(
      makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      '/api/leads/v1/submit-contact',
      {},
    );

    assert.ok(res, 'expected explicit endpoint policies to fail closed without Redis config');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
  });

  it('summarize-article is an explicit fail-closed endpoint policy route', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const mod = await importFreshRateLimitModule();
    const pathname = '/api/news/v1/summarize-article';

    assert.deepEqual(ENDPOINT_RATE_POLICIES[pathname], { limit: 30, window: '60 s' });
    assert.ok(
      pathname in FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
      'LLM-backed summarize-article must stay in the fail-closed requirement registry',
    );

    const res = await mod.checkEndpointRateLimit(
      makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      pathname,
      { 'Access-Control-Allow-Origin': 'https://worldmonitor.app' },
    );

    assert.ok(res, 'expected summarize-article endpoint policy to fail closed without Redis config');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.equal(
      res.headers.get('Access-Control-Allow-Origin'),
      'https://worldmonitor.app',
      'CORS headers should be propagated on the degraded response',
    );
    assert.equal(res.headers.get('Retry-After'), '5');
  });

  it('deduct-situation is an explicit fail-closed endpoint policy route (#4676)', async () => {
    // LLM-backed situational deduction (imports callLlmReasoning) must fail
    // closed on a Redis outage rather than inherit the availability-first
    // global fallback — mirrors summarize-article / classify-event. Regression
    // guard for the #4676 finding where it was absent from both registries.
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const mod = await importFreshRateLimitModule();
    const pathname = '/api/intelligence/v1/deduct-situation';

    assert.deepEqual(ENDPOINT_RATE_POLICIES[pathname], { limit: 600, window: '60 s' });
    assert.ok(
      pathname in FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
      'LLM-backed deduct-situation must stay in the fail-closed requirement registry',
    );

    const res = await mod.checkEndpointRateLimit(
      makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      pathname,
      { 'Access-Control-Allow-Origin': 'https://worldmonitor.app' },
    );

    assert.ok(res, 'expected deduct-situation endpoint policy to fail closed without Redis config');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.equal(
      res.headers.get('Access-Control-Allow-Origin'),
      'https://worldmonitor.app',
      'CORS headers should be propagated on the degraded response',
    );
  });

  for (const pathname of [
    '/api/military/v1/get-aircraft-details',
    '/api/military/v1/get-aircraft-details-batch',
  ]) {
    it(`${pathname} is an explicit fail-closed endpoint policy route (#7108)`, async () => {
      // Both Wingbits aircraft-enrichment routes proxy a PAID provider on cache
      // miss, so a Redis outage must 503 rather than inherit the gateway's
      // availability-first 600/min fallback and hand out unmetered upstream
      // spend. Registering the policy is not enough on its own: the registry
      // entry can be present while the runtime lookup or the failClosed default
      // regresses, and scripts/enforce-rate-limit-policies.mjs is static-only —
      // it cross-checks the registries and OpenAPI but never calls the limiter.
      // So assert the behavior, matching summarize-article / deduct-situation /
      // reverse-geocode above. The batch sibling is included because it predates
      // this convention and had the same untested gap.
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      const mod = await importFreshRateLimitModule();

      assert.deepEqual(ENDPOINT_RATE_POLICIES[pathname], { limit: 30, window: '60 s' });
      assert.ok(
        pathname in FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
        `${pathname} must stay in the fail-closed requirement registry — a Redis outage must 503, not inherit the fail-open fallback`,
      );

      const res = await mod.checkEndpointRateLimit(
        makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
        pathname,
        { 'Access-Control-Allow-Origin': 'https://worldmonitor.app' },
      );

      assert.ok(res, `expected ${pathname} endpoint policy to fail closed without Redis config`);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
      assert.equal(
        res.headers.get('Access-Control-Allow-Origin'),
        'https://worldmonitor.app',
        'CORS headers should be propagated on the degraded response',
      );
    });
  }

  it('gateway reverse-geocode RPC is a Nominatim provider route with a matched 60/min fail-closed policy (#6432)', async () => {
    // #6432 — the second Nominatim caller. The legacy edge route carries a
    // per-IP 60/min budget (#6234); this RPC must carry the same policy or it
    // silently inherits the gateway's 600/min availability-first fallback,
    // leaving half the egress exposure open. Since the RPC has no handler --
    // checkEndpointRateLimit runs in the gateway before any route logic -- the
    // policy is the whole metering, so assert it stays registered, stays in
    // the fail-closed requirement, and degrades to 503.
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const mod = await importFreshRateLimitModule();
    const pathname = '/api/infrastructure/v1/reverse-geocode';

    assert.deepEqual(ENDPOINT_RATE_POLICIES[pathname], { limit: 60, window: '60 s' });
    assert.ok(
      pathname in FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
      'reverse-geocode RPC must stay in the fail-closed requirement registry — a Redis outage must 503, not inherit the fail-open 600/min fallback',
    );

    const res = await mod.checkEndpointRateLimit(
      makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      pathname,
      { 'Access-Control-Allow-Origin': 'https://worldmonitor.app' },
    );

    assert.ok(res, 'expected reverse-geocode RPC policy to fail closed without Redis config');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');

    process.env.WORLDMONITOR_VALID_KEYS = 'reverse-geocode-gateway-test-key';
    __resetRateLimitForTest();
    const { createDomainGateway } = await import('../server/gateway.ts');
    let handlerCalls = 0;
    const gateway = createDomainGateway([{
      method: 'GET',
      path: pathname,
      handler: async () => {
        handlerCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }]);
    const gatewayRes = await gateway(new Request(
      `https://worldmonitor.app${pathname}?lat=40.7&lon=-74.0`,
      {
        headers: {
          Origin: 'https://worldmonitor.app',
          'X-WorldMonitor-Key': 'reverse-geocode-gateway-test-key',
          'x-real-ip': '203.0.113.7',
        },
      },
    ));

    assert.equal(gatewayRes.status, 503);
    assert.equal(gatewayRes.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.equal(handlerCalls, 0, 'the gateway must reject before route execution');
  });

  it('paid-provider market routes each have explicit fail-closed policies (#6236)', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const mod = await importFreshRateLimitModule();
    const expectedPolicies = new Map([
      ['/api/market/v1/analyze-stock', { limit: 60, window: '60 s' }],
      ['/api/market/v1/backtest-stock', { limit: 60, window: '60 s' }],
      ['/api/market/v1/get-insider-transactions', { limit: 60, window: '60 s' }],
      ['/api/market/v1/get-country-stock-index', { limit: 30, window: '60 s' }],
      ['/api/economic/v1/list-world-bank-indicators', { limit: 30, window: '60 s' }],
    ] as const);

    for (const [pathname, expectedPolicy] of expectedPolicies) {
      assert.deepEqual(
        ENDPOINT_RATE_POLICIES[pathname],
        expectedPolicy,
        `${pathname} must keep its provider-proxy budget`,
      );
      assert.ok(
        pathname in FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
        `${pathname} must stay in the fail-closed requirement registry`,
      );

      const res = await mod.checkEndpointRateLimit(
        makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
        pathname,
        {},
      );

      assert.ok(res, `${pathname} must fail closed without Redis config`);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
    }
  });

  it('paid-provider endpoint policies fail closed when Redis ignores abort until the SDK timeout (#6236)', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    const mod = await importFreshRateLimitModule();

    const res = await mod.checkEndpointRateLimit(
      makeRequest({ 'x-real-ip': '203.0.113.7' }),
      '/api/market/v1/get-insider-transactions',
      { 'Access-Control-Allow-Origin': 'https://worldmonitor.app' },
    );

    assert.ok(res, 'a timed-out limiter decision must not use the SDK allow fallback');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
  });

  it('paid-provider endpoint policies abort a stalled Redis fetch before failing closed (#6236)', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    let fetchAborted = false;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => {
          fetchAborted = true;
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      })) as typeof fetch;
    const mod = await importFreshRateLimitModule();

    const res = await mod.checkEndpointRateLimit(
      makeRequest({ 'x-real-ip': '203.0.113.7' }),
      '/api/market/v1/get-insider-transactions',
      {},
    );

    assert.equal(fetchAborted, true, 'the Redis transport must be cancelled, not left pending');
    assert.equal(res?.status, 503);
    assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
  });

  it('checkEndpointRateLimit keeps unrecognised paths unguarded even with fail-closed defaults', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const mod = await importFreshRateLimitModule();

    const res = await mod.checkEndpointRateLimit(
      makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      '/api/not-a-rate-limited-endpoint',
      {},
    );

    assert.equal(res, null);
  });

  it('documented read-only global fallback routes remain fail-open when Redis config is missing', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const mod = await importFreshRateLimitModule();
    const pathname = '/api/aviation/v1/list-airport-delays';

    assert.ok(
      pathname in GLOBAL_RATE_LIMIT_FALLBACK_READ_ROUTES,
      'the intentionally fail-open read route must be documented in the global fallback registry',
    );
    assert.equal(mod.hasEndpointRatePolicy(pathname), false);

    const endpointRes = await mod.checkEndpointRateLimit(
      makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      pathname,
      {},
    );
    const globalRes = await mod.checkRateLimit(makeRequest({ 'cf-connecting-ip': '203.0.113.7' }), {});

    assert.equal(endpointRes, null, 'no endpoint policy should be applied to the documented read route');
    assert.equal(globalRes, null, 'global fallback keeps read traffic fail-open without Redis config');
  });

  it('server rate-limit degraded logs are also sent through Sentry capture', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../server/_shared/rate-limit.ts', import.meta.url), 'utf8');

    assert.match(src, /import\s+\{\s*captureSilentError\s+\}\s+from\s+['"]\.\.\/\.\.\/api\/_sentry-edge\.js['"]/);
    assert.match(src, /captureSilentError\(err,\s*\{/);
    assert.match(src, /surface:\s*'api'\s*\|\s*'server'\s*=\s*'server'/);
    assert.match(src, /tags:\s*\{\s*surface,\s*component:\s*'rate-limit'/);
    // Group on the collapsed stage, never the raw one. The raw `stage` embeds
    // the caller's pathname, so using it here mints one Sentry issue per route
    // for a single Redis slowdown (#6454). The semantics of the collapse are
    // covered directly by the rateLimitFingerprintStage unit tests below; this
    // assertion only pins that the capture routes through it.
    assert.match(src, /fingerprint:\s*\['rate-limit',\s*'redis-error',\s*rateLimitFingerprintStage\(stage\)\]/);
    assert.doesNotMatch(
      src,
      /fingerprint:\s*\['rate-limit',\s*'redis-error',\s*stage\]/,
      'the raw stage must not be used as a fingerprint — it is high-cardinality and fragments grouping per route',
    );
    assert.match(src, /lastRateLimitSentryCaptureAt\.get\(stage\)/);
    assert.match(src, /lastCaptureAt !== undefined && now - lastCaptureAt < RATE_LIMIT_SENTRY_DEDUP_MS/);
  });

  it('checkScopedRateLimit reports and captures degraded missing-config once per scope', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const mod = await importFreshRateLimitModule();

    const result = await mod.checkScopedRateLimit('test-scope', 5, '60 s', 'identifier');
    const secondResult = await mod.checkScopedRateLimit('test-scope', 5, '60 s', 'identifier-2');

    assert.equal(result.allowed, true);
    assert.equal(result.degraded, true);
    assert.equal(secondResult.allowed, true);
    assert.equal(secondResult.degraded, true);
    const missingConfigLogs = consoleErrors.filter((line) =>
      line.includes('stage=checkScopedRateLimit:test-scope:missing-config'),
    );
    assert.equal(missingConfigLogs.length, 1, 'missing config should be observable without logging every request');
    assert.match(missingConfigLogs[0], /UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing/);
  });

  it('checkScopedRateLimit returns degraded:true on Redis error so callers can fail-closed locally', async () => {
    const result = await checkScopedRateLimit('test-scope', 5, '60 s', 'identifier');
    assert.equal(result.allowed, true, 'preserve availability-first default');
    assert.equal(result.degraded, true, 'flag the degraded path so callers can escalate');
  });

  it('checkFailClosedScopedIpRateLimit converts scoped degradation to the standard 503 contract', async () => {
    const res = await checkFailClosedScopedIpRateLimit(
      makeRequest({ 'x-real-ip': '203.0.113.14' }),
      'pre-attribution-test',
      600,
      '60 s',
      { 'Access-Control-Allow-Origin': 'https://worldmonitor.app' },
    );

    assert.equal(res?.status, 503);
    assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
  });
});

describe('rate-limit fail-closed call-site policy (#3531)', () => {
  // High-cost endpoints that don't go through gateway.ts's checkEndpointRateLimit
  // must opt into fail-closed at the call site — otherwise an Upstash blip
  // silently lifts the only rate-limit gate they have. Static-analysis guard
  // so a future caller reverting to bare `checkRateLimit(req, cors)` is caught
  // in CI rather than during a Redis incident.
  const FAIL_CLOSED_REQUIRED = [
    'api/chat-analyst.ts', // streaming LLM analyst, Pro-only
  ];

  for (const path of FAIL_CLOSED_REQUIRED) {
    it(`${path} passes failClosed: true to checkRateLimit`, async () => {
      const fs = await import('node:fs');
      const url = new URL(`../${path}`, import.meta.url);
      const src = fs.readFileSync(url, 'utf8');
      const callMatch = src.match(/checkRateLimit\([^)]*\)/);
      assert.ok(callMatch, `${path} should still call checkRateLimit`);
      assert.match(
        callMatch[0],
        /failClosed:\s*true/,
        `${path} must pass { failClosed: true } so a Redis outage doesn't silently bypass the only rate-limit gate it has`,
      );
    });
  }
});

describe('scoped rate-limit degraded call-site policy (#3531)', () => {
  const SCOPED_RATE_LIMIT_CALLERS = [
    {
      path: 'api/reverse-geocode.js',
      expected: /failClosed:\s*true/,
      reason: 'the provider-wide Nominatim bucket is shared across both routes and must fail closed before upstream work',
    },
    {
      path: 'server/worldmonitor/leads/v1/register-interest.ts',
      expected: /if\s*\(\s*scoped\.degraded\s*\)\s*\{/,
      reason: 'desktop lead capture bypasses Turnstile, so Redis degradation must fail closed locally',
    },
    {
      path: 'server/worldmonitor/infrastructure/v1/reverse-geocode.ts',
      expected: /if\s*\(\s*providerLimit\.degraded\s*\)\s*\{/,
      reason: 'the gateway half of the provider-wide Nominatim bucket must fail closed before upstream work',
    },
    {
      path: 'api/a2a.ts',
      expected: /Redis-degraded scoped limits intentionally stay availability-first/,
      reason: 'A2A concierge serves only anonymous, quota-free, cheap catalog matching — degradation is logged and stays availability-first',
    },
    {
      path: 'api/ask.ts',
      expected: /Redis-degraded scoped limits intentionally stay availability-first/,
      reason: 'NLWeb /ask serves only anonymous, quota-free, cheap catalog matching — degradation is logged and stays availability-first',
    },
    {
      path: 'api/docs-mcp.ts',
      expected: /Redis-degraded scoped limits intentionally stay availability-first/,
      reason: 'docs MCP facade proxies a fully public, cheap upstream — degradation is logged and stays availability-first',
    },
    {
      path: 'api/mcp-proxy.ts',
      expected: /Redis-degraded scoped limits intentionally stay availability-first/,
      reason: 'MCP proxy is already premium-auth gated; scoped limit degradation is logged and remains availability-first',
    },
    {
      path: 'api/skills/fetch-agentskills.ts',
      expected: /Redis-degraded scoped limits intentionally stay availability-first/,
      reason: 'agent-skills import proxy fetches one public host behind a fixed allowlist and is called by the settings importer - degradation is logged and stays availability-first',
    },
    {
      path: 'api/user-prefs.ts',
      expected: /Redis-degraded scoped limits intentionally fail open for prefs writes/,
      reason: 'cloud prefs writes are low-stakes, so Redis degradation should not block legitimate settings sync',
    },
    {
      path: 'api/notify.ts',
      expected: /limiter outage here should NOT fail open/,
      reason: 'notify publishes create relay-side delivery obligations on the shared event queue, so Redis degradation fails closed instead of allowing unbounded fan-out',
    },
  ];

  it('keeps every checkScopedRateLimit caller audited for degraded handling', async () => {
    const fs = await import('node:fs');
    const cp = await import('node:child_process');
    const repo = new URL('..', import.meta.url);
    const output = cp.execFileSync('git', ['grep', '-lE', 'checkScopedRateLimit\\(|PROVIDER_RATE_LIMIT_IDENTIFIER', '--', 'server', 'api'], {
      cwd: repo,
      encoding: 'utf8',
    });
    const callers = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter(path => path !== 'server/_shared/rate-limit.ts')
      .sort();

    assert.deepEqual(
      callers,
      SCOPED_RATE_LIMIT_CALLERS.map(({ path }) => path).sort(),
      'new scoped or provider-wide rate-limit callers must be added here with a degraded-path decision',
    );

    for (const { path, expected, reason } of SCOPED_RATE_LIMIT_CALLERS) {
      const src = fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      assert.match(src, expected, `${path}: ${reason}`);
    }
  });
});

describe('slow-Redis timeout is degraded, not a silent allow (#6412 review)', () => {
  // @upstash/ratelimit v2 races the Redis call against its own internal timeout
  // and RESOLVES `{ success: true, reason: 'timeout' }` instead of rejecting, so
  // it never reaches a catch block. checkEndpointRateLimit already handled this;
  // checkScopedRateLimit and api/_rate-limit.js's checkRateLimit did not, which
  // meant a SLOW (not down) Redis silently dropped the limit on every in-handler
  // caller with no log, no Sentry event and degraded:false.
  //
  // These two tests each wait out the SDK's real 5 s race with a fetch that never
  // settles — there is no supported seam to shorten it, and a mocked reply cannot
  // produce `reason: 'timeout'` at all. That cost buys the only coverage of a
  // fail-open window; keep the generous per-test timeout.
  const HANG_TEST_TIMEOUT_MS = 20_000;

  let originalFetch: typeof globalThis.fetch;
  let errorLogs: string[];
  let originalConsoleError: typeof console.error;
  let originalUrl: string | undefined;
  let originalToken: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalConsoleError = console.error;
    originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    errorLogs = [];
    console.error = (...args: unknown[]) => { errorLogs.push(args.map(String).join(' ')); };
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    // Never settles, so the SDK's internal timer wins the race.
    globalThis.fetch = (() => new Promise(() => {})) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    // Restore rather than delete: this block configures Upstash, and sibling
    // describes in this file assume they own that env.
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    __resetRateLimitForTest();
  });

  it('checkScopedRateLimit reports a timed-out decision as degraded', { timeout: HANG_TEST_TIMEOUT_MS }, async () => {
    const result = await checkScopedRateLimit('timeout-probe', 30, '60 s', '203.0.113.77');

    assert.equal(result.allowed, true, 'availability-first: the caller is still allowed through');
    assert.equal(
      result.degraded,
      true,
      'a timed-out limiter decision is an unmetered window, not a genuine allow — callers gating on degraded must be able to see it',
    );
    assert.ok(
      errorLogs.some((l) => l.includes('[rate-limit] redis-error') && l.includes('timed out')),
      `the bypass window must be visible in logs: ${errorLogs.join(' | ')}`,
    );
  });

  it('checkRateLimit (api/_rate-limit.js) fails closed on a timed-out decision when asked to', { timeout: HANG_TEST_TIMEOUT_MS }, async () => {
    const { checkRateLimit: apiCheckRateLimit, __resetRateLimitForTest: resetApi } = await import('../api/_rate-limit.js');
    try {
      const req = new Request('https://api.worldmonitor.app/api/anything', {
        headers: { 'x-real-ip': '203.0.113.78' },
      });
      const res = await apiCheckRateLimit(req, {}, { failClosed: true, scope: 'timeout-probe-api', limit: 30, window: '60 s' });

      assert.ok(res, 'a failClosed caller must not be waved through on a timed-out decision');
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
      assert.ok(
        errorLogs.some((l) => l.includes('[rate-limit] redis-error') && l.includes('timed out')),
        `the bypass window must be visible in logs: ${errorLogs.join(' | ')}`,
      );
    } finally {
      resetApi();
    }
  });
});

describe('legacy edge-function rate-limit policy mirrors (#6234)', () => {
  // `api/*.js` edge functions are self-contained JS and cannot import
  // `../server/` (AGENTS.md, enforced by scripts/lint-boundaries.mjs and the
  // pre-push esbuild check). So unlike api/mcp-proxy.ts, which reads
  // ENDPOINT_RATE_POLICIES at module load, these handlers duplicate their
  // budget as a literal constant and enforce it via api/_rate-limit.js.
  //
  // Without this test the registry entry would be decorative: the audit script
  // (scripts/enforce-rate-limit-policies.mjs) and docs/usage-rate-limits.mdx
  // would advertise a number no handler enforces, which is exactly the
  // declare-vs-serve divergence the repo treats as a defect class.
  const MIRRORED_JS_POLICIES = [
    { path: 'api/youtube/live.js', route: '/api/youtube/live', scope: 'youtube-live' },
    { path: 'api/reverse-geocode.js', route: '/api/reverse-geocode', scope: 'reverse-geocode' },
  ];

  for (const { path, route, scope } of MIRRORED_JS_POLICIES) {
    it(`${path} enforces the ENDPOINT_RATE_POLICIES['${route}'] budget`, async () => {
      const fs = await import('node:fs');
      const src = fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      const policy = ENDPOINT_RATE_POLICIES[route];
      assert.ok(policy, `${route} must stay in ENDPOINT_RATE_POLICIES`);

      const limitMatch = src.match(/const RATE_LIMIT_PER_MINUTE = (\d+);/);
      assert.ok(limitMatch, `${path} must declare a RATE_LIMIT_PER_MINUTE constant`);
      assert.equal(
        Number(limitMatch[1]),
        policy.limit,
        `${path} enforces ${limitMatch[1]}/min but ENDPOINT_RATE_POLICIES['${route}'] declares ${policy.limit} — api/*.js cannot import server/_shared/rate-limit.ts, so the budget must be updated in both places`,
      );
      assert.equal(
        policy.window,
        '60 s',
        `${route} must stay on a 60 s window while ${path} hard-codes a per-minute budget`,
      );

      const scopeMatch = src.match(/const RATE_LIMIT_SCOPE = '([^']+)';/);
      assert.ok(scopeMatch, `${path} must declare a RATE_LIMIT_SCOPE constant`);
      assert.equal(
        scopeMatch[1],
        scope,
        `${path} rate-limit scope changed — Redis keys are prefixed rl:<scope>, so renaming it silently resets every caller's window`,
      );

      // Assert the WIRING, not just the declarations. A bare /checkRateLimit\(/
      // presence check proves neither constant reaches the call: dropping
      // `limit:` makes api/_rate-limit.js apply `opts.limit ?? DEFAULT_RATE_LIMIT`
      // (600/min — a 20x silent widening) and dropping `scope:` moves the route
      // into the shared `rl` global bucket, both while the two constants sit
      // there unused and every assertion above still passes. Match the option
      // keys inside the call so the registry entry cannot become decorative.
      // (#6412 review)
      const callMatch = src.match(/checkRateLimit\(\s*\w+\s*,\s*\w+\s*,\s*\{([\s\S]*?)\}\s*\)/);
      assert.ok(callMatch, `${path} must call checkRateLimit with an explicit options object`);
      const callOptions = callMatch[1] ?? '';
      assert.match(
        callOptions,
        /\blimit:\s*RATE_LIMIT_PER_MINUTE\b/,
        `${path} must pass limit: RATE_LIMIT_PER_MINUTE to checkRateLimit — without it the call silently falls back to the 600/min global default and the registry entry is decorative`,
      );
      assert.match(
        callOptions,
        /\bscope:\s*RATE_LIMIT_SCOPE\b/,
        `${path} must pass scope: RATE_LIMIT_SCOPE to checkRateLimit — without it the route shares the global 'rl' bucket instead of rl:${scope}`,
      );
      assert.match(
        callOptions,
        /\bwindow:\s*'60 s'/,
        `${path} must pass window: '60 s' to checkRateLimit so the enforced window matches ENDPOINT_RATE_POLICIES['${route}']`,
      );
      assert.match(
        callOptions,
        /\bctx\b/,
        `${path} must forward ctx to checkRateLimit so the degraded-path Sentry envelope survives isolate teardown`,
      );
    });
  }
});

describe('rate-limit constants', () => {
  it('exposes the degraded marker shape both surfaces depend on', () => {
    assert.equal(RATE_LIMIT_DEGRADED_HEADERS['X-RateLimit-Mode'], 'degraded');
    assert.equal(RATE_LIMIT_DEGRADED_HEADERS['Retry-After'], '5');
  });

  it('UNKNOWN_CLIENT_IP is the literal "unknown" so the api/ mirror stays string-equal', () => {
    assert.equal(UNKNOWN_CLIENT_IP, 'unknown');
  });

  // The abort deadline and the SDK decision deadline are a pair, and their
  // test-context gap is what makes 'abort a stalled Redis fetch before failing
  // closed (#6236)' deterministic rather than a coin flip. The abort signal is
  // armed lazily -- the Upstash client calls the `signal` factory only when it
  // builds the request -- so the gap has to cover that arming cost, measured at
  // 8-71ms on an idle machine. The original 25/20 pair left 1.1ms at worst.
  it('keeps the Redis abort deadline far enough ahead of the limiter decision (#6236)', () => {
    const { decisionMs, abortMs } = __ENDPOINT_LIMITER_DEADLINES_FOR_TEST;
    assert.ok(abortMs > 0, 'the Upstash fetch abort deadline must stay armed');
    assert.ok(
      decisionMs - abortMs >= 100,
      `the abort must fire well before the decision resolves; gap is ${decisionMs - abortMs}ms`,
    );
  });
});

describe('rateLimitFingerprintStage — Sentry grouping for a degraded limiter (#6454)', () => {
  // Both copies must agree; api/_rate-limit.js is the byte-mirror of the .ts one.
  const IMPLS: Array<[string, (stage: string) => string]> = [
    ['server/_shared/rate-limit.ts', rateLimitFingerprintStage],
    ['api/_rate-limit.js', apiRateLimitFingerprintStage],
  ];

  for (const [name, fn] of IMPLS) {
    it(`${name}: strips the per-caller token so one incident is one issue`, () => {
      // The bug: `stage` embeds the pathname, and it was used verbatim as the
      // fingerprint, so a single Redis slowdown opened one issue per route.
      assert.equal(fn('checkEndpointRateLimit:/api/market/v1/list-market-quotes'), 'checkEndpointRateLimit');
      assert.equal(fn('checkEndpointRateLimit:/api/military/v1/get-aircraft-details-batch'), 'checkEndpointRateLimit');
      assert.equal(
        fn('checkEndpointRateLimit:/api/market/v1/list-market-quotes'),
        fn('checkEndpointRateLimit:/api/military/v1/get-aircraft-details-batch'),
        'two routes failing the same way must land in the same Sentry issue',
      );
      assert.equal(fn('checkScopedRateLimit:/api/skills/fetch-agentskills'), 'checkScopedRateLimit');
    });

    it(`${name}: keeps failure-mode suffixes, which are a closed set`, () => {
      // These describe HOW the limiter failed, not who called it, so they do not
      // grow with traffic and each deserves its own issue.
      assert.equal(fn('checkRateLimit:missing-config'), 'checkRateLimit:missing-config');
      assert.equal(fn('checkRateLimit:timeout'), 'checkRateLimit:timeout');
      assert.equal(fn('mcpFreeTierRateLimit:edge-proof'), 'mcpFreeTierRateLimit:edge-proof');
      assert.equal(fn('checkScopedRateLimit:/api/skills/fetch-agentskills:missing-config'), 'checkScopedRateLimit:missing-config');
      assert.notEqual(
        fn('checkRateLimit:timeout'),
        fn('checkRateLimit:missing-config'),
        'a slow Redis and an unconfigured Redis are different problems and must not merge',
      );
    });

    it(`${name}: passes through a stage with no caller token, and never returns empty`, () => {
      assert.equal(fn('checkRateLimit'), 'checkRateLimit');
      assert.equal(fn('checkScopedRateLimit'), 'checkScopedRateLimit');
      assert.equal(fn(''), 'rate-limit');
      assert.equal(fn(':missing-config'), 'rate-limit:missing-config');
    });
  }

  it('both mirrors agree on every shape', () => {
    for (const stage of [
      'checkEndpointRateLimit:/api/a/b/c',
      'checkScopedRateLimit:/api/skills/fetch-agentskills',
      'checkScopedRateLimit:/api/x:missing-config',
      'checkRateLimit:timeout',
      'checkRateLimit',
      '',
    ]) {
      assert.equal(
        rateLimitFingerprintStage(stage),
        apiRateLimitFingerprintStage(stage),
        `mirrors disagree for stage "${stage}" — operators grep across both surfaces`,
      );
    }
  });
});

describe('rateLimitErrorLevel — Sentry severity for a degraded limiter (WORLDMONITOR-VM)', () => {
  // Both copies must agree; api/_rate-limit.js is the byte-mirror of the .ts one.
  const IMPLS: Array<[string, (stage: string, msg: string) => string]> = [
    ['server/_shared/rate-limit.ts', rateLimitErrorLevel],
    ['api/_rate-limit.js', apiRateLimitErrorLevel],
  ];

  for (const [surface, classify] of IMPLS) {
    it(`${surface}: the endpoint limiter's own abort deadline is a transient, not an error`, () => {
      // getEndpointRatelimit arms `AbortSignal.timeout(ENDPOINT_REDIS_ABORT_TIMEOUT_MS)`
      // on the Upstash client. When that deadline wins, the SDK rejects with a
      // DOMException whose message is this exact phrase, checkEndpointRateLimit
      // absorbs it into the fail-closed 503, and the capture must not page.
      assert.equal(
        classify(
          'checkEndpointRateLimit:/api/military/v1/get-aircraft-details-batch',
          'The operation was aborted due to timeout',
        ),
        'warning',
      );
    });

    it(`${surface}: both arms of the same limiter timeout classify alike`, () => {
      // The SDK-race arm throws this literal from checkEndpointRateLimit; it and
      // the abort arm above are one condition, so they must not split severity.
      assert.equal(
        classify('checkEndpointRateLimit:/api/ask', 'Upstash endpoint rate-limit decision timed out'),
        'warning',
      );
      assert.equal(
        classify('checkRateLimit', 'ERR Error running script: execution timed out'),
        'warning',
      );
    });

    it(`${surface}: a missing-config stage and an unclassified error still page`, () => {
      assert.equal(
        classify('checkEndpointRateLimit:/api/ask:missing-config', 'The operation was aborted due to timeout'),
        'error',
        'a deploy misconfiguration outranks any transient phrasing in the message',
      );
      assert.equal(
        classify('checkRateLimit', 'WRONGTYPE Operation against a key holding the wrong kind of value'),
        'error',
      );
    });
  }
});

describe('EVALSHA-unsupported fallback (#7c — self-hosted redis-rest proxy blocks Lua)', () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetRateLimitForTest();
    restoreEnv();
  });

  // Faithful in-memory INCR + EXPIRE-NX + TTL, gated by the same command
  // allowlist docker/redis-rest-proxy.mjs enforces. @upstash/redis
  // auto-pipelines every command (including a bare `.evalsha()`) through
  // POST /pipeline, so the real proxy's per-command `{error}` entries — not
  // an HTTP-level rejection — are what @upstash/ratelimit actually sees.
  // Confirmed against the live SDK (v1.37.0): a blocked command surfaces as
  // `UpstashError: "Command failed: Command not allowed: EVALSHA"`.
  const ALLOWED_COMMANDS = new Set(['INCR', 'EXPIRE', 'TTL']);

  function makeProxyPipelineHandler({ expireNxUnsupported = false } = {}) {
    const store = new Map<string, { count: number; hasTtl: boolean }>();
    return (commands: unknown[][]) =>
      commands.map((cmd) => {
        const op = String(cmd[0]).toUpperCase();
        if (!ALLOWED_COMMANDS.has(op)) return { error: `Command not allowed: ${op}` };
        const key = String(cmd[1]);
        const entry = store.get(key) ?? { count: 0, hasTtl: false };
        if (op === 'INCR') {
          entry.count += 1;
          store.set(key, entry);
          return { result: entry.count };
        }
        if (op === 'EXPIRE') {
          if (expireNxUnsupported && String(cmd[3]).toUpperCase() === 'NX') {
            return { error: 'ERR syntax error' };
          }
          const applied = !entry.hasTtl;
          if (applied) entry.hasTtl = true;
          store.set(key, entry);
          return { result: applied ? 1 : 0 };
        }
        return { result: entry.hasTtl ? 60 : -1 }; // TTL
      });
  }

  it('canonical checkRateLimit enforces the non-Lua fallback window directly', async () => {
    const pipelineHandler = makeProxyPipelineHandler();
    let luaAttempts = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const commands = JSON.parse(String(init?.body)) as unknown[][];
      if (commands.some((c) => /^(EVAL|EVALSHA|SCRIPT)$/i.test(String(c[0])))) luaAttempts++;
      return new Response(JSON.stringify(pipelineHandler(commands)), { status: 200 });
    }) as typeof fetch;

    const mod = await importFreshRateLimitModule();
    const req = makeRequest({ 'x-real-ip': '203.0.113.9' });

    let res: Response | null = null;
    let iterations = 0;
    while (!res && iterations < 1000) {
      res = await mod.checkRateLimit(req, {});
      iterations++;
    }

    assert.ok(res, 'expected checkRateLimit to eventually return a 429 Response');
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('X-RateLimit-Limit'), '600');
    assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
    assert.equal(luaAttempts, 1, 'Lua must latch off after the first unsupported-command response');
  });

  it('checkEndpointRateLimit enforces the endpoint policy through the non-Lua fallback', async () => {
    const pipelineHandler = makeProxyPipelineHandler();
    let luaAttempts = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const commands = JSON.parse(String(init?.body)) as unknown[][];
      if (commands.some((c) => /^(EVAL|EVALSHA|SCRIPT)$/i.test(String(c[0])))) luaAttempts++;
      return new Response(JSON.stringify(pipelineHandler(commands)), { status: 200 });
    }) as typeof fetch;

    const mod = await importFreshRateLimitModule();
    const req = makeRequest({ 'x-real-ip': '203.0.113.10' });
    const pathname = '/api/leads/v1/submit-contact';

    assert.equal(await mod.checkEndpointRateLimit(req, pathname, {}), null);
    assert.equal(await mod.checkEndpointRateLimit(req, pathname, {}), null);
    assert.equal(await mod.checkEndpointRateLimit(req, pathname, {}), null);
    const blocked = await mod.checkEndpointRateLimit(req, pathname, {});

    assert.ok(blocked, 'expected endpoint policy to return a 429 on the fourth request');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('X-RateLimit-Limit'), '3');
    assert.equal(blocked.headers.get('X-RateLimit-Remaining'), '0');
    assert.equal(luaAttempts, 1, 'endpoint fallback must not retry Lua after it is known unsupported');
  });

  it('checkEndpointRateLimit isolates trusted principals sharing one IP while preserving the IP default', async () => {
    const pipelineHandler = makeProxyPipelineHandler();
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const commands = JSON.parse(String(init?.body)) as unknown[][];
      return new Response(JSON.stringify(pipelineHandler(commands)), { status: 200 });
    }) as typeof fetch;

    const mod = await importFreshRateLimitModule();
    const req = makeRequest({ 'x-real-ip': '203.0.113.12' });
    const pathname = '/api/news/v1/summarize-article';

    for (let i = 0; i < 30; i++) {
      assert.equal(
        await mod.checkEndpointRateLimit(req, pathname, {}, { principalUserId: 'pro-a' }),
        null,
      );
    }
    const blocked = await mod.checkEndpointRateLimit(req, pathname, {}, { principalUserId: 'pro-a' });
    assert.equal(blocked?.status, 429, 'one Pro principal must still be capped at 30/min');

    assert.equal(
      await mod.checkEndpointRateLimit(
        makeRequest({ 'x-real-ip': 'user:pro-a' }),
        pathname,
        {},
      ),
      null,
      'an IP-shaped caller value must not collide with the user namespace',
    );

    assert.equal(
      await mod.checkEndpointRateLimit(req, pathname, {}, { principalUserId: 'pro-b' }),
      null,
      'a second Pro principal behind the same IP must receive an independent bucket',
    );
    assert.equal(
      await mod.checkEndpointRateLimit(req, pathname, {}),
      null,
      'callers without a trusted principal must continue using the original IP bucket',
    );
  });

  it('checkRateLimit isolates trusted principals sharing one IP while preserving the IP default', async () => {
    const pipelineHandler = makeProxyPipelineHandler();
    const incrementedKeys = new Set<string>();
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const commands = JSON.parse(String(init?.body)) as unknown[][];
      for (const command of commands) {
        if (String(command[0]).toUpperCase() === 'INCR') {
          incrementedKeys.add(String(command[1]));
        }
      }
      return new Response(JSON.stringify(pipelineHandler(commands)), { status: 200 });
    }) as typeof fetch;

    const mod = await importFreshRateLimitModule();
    const req = makeRequest({ 'x-real-ip': '203.0.113.13' });

    for (let i = 0; i < 600; i++) {
      assert.equal(
        await mod.checkRateLimit(req, {}, { principalUserId: 'pro-a' }),
        null,
      );
    }
    const blocked = await mod.checkRateLimit(req, {}, { principalUserId: 'pro-a' });
    assert.equal(blocked?.status, 429, 'one Pro principal must still be capped at 600/min');

    assert.equal(
      await mod.checkRateLimit(req, {}, { principalUserId: 'pro-b' }),
      null,
      'a second Pro principal behind the same IP must receive an independent bucket',
    );
    assert.equal(
      await mod.checkRateLimit(req, {}),
      null,
      'callers without a trusted principal must continue using the original IP bucket',
    );
    assert.ok(
      incrementedKeys.has('rl:fw:203.0.113.13'),
      'anonymous global traffic must preserve the legacy raw-IP key during rollout',
    );
    assert.ok(
      !incrementedKeys.has('rl:fw:ip:203.0.113.13'),
      'anonymous global traffic must not reset into a new namespaced key',
    );
  });

  it('degrades instead of creating a permanent counter when EXPIRE NX is unsupported', async () => {
    const pipelineHandler = makeProxyPipelineHandler({ expireNxUnsupported: true });
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const commands = JSON.parse(String(init?.body)) as unknown[][];
      return new Response(JSON.stringify(pipelineHandler(commands)), { status: 200 });
    }) as typeof fetch;

    const mod = await importFreshRateLimitModule();
    const req = makeRequest({ 'x-real-ip': '203.0.113.11' });
    const pathname = '/api/leads/v1/submit-contact';

    const failOpen = await mod.checkEndpointRateLimit(req, pathname, {}, { failClosed: false });
    assert.equal(failOpen, null, 'opted-out endpoint callers should fail open when fallback cannot set a TTL');

    const failClosed = await mod.checkEndpointRateLimit(req, pathname, {});
    assert.ok(failClosed, 'default endpoint policy should fail closed when fallback cannot set a TTL');
    assert.equal(failClosed.status, 503);
    assert.equal(failClosed.headers.get('X-RateLimit-Mode'), 'degraded');

    const scoped = await mod.checkScopedRateLimit('redis6-fallback', 1, '60 s', 'caller');
    assert.equal(scoped.allowed, true);
    assert.equal(scoped.degraded, true, 'scoped fallback reports degradation instead of returning a permanent 429');
  });

  it('detects "Command not allowed: EVALSHA" and falls back to INCR+EXPIRE, then enforces the window on subsequent calls without retrying Lua', async () => {
    const pipelineHandler = makeProxyPipelineHandler();
    let luaAttempts = 0;
    let fetchCalls = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      fetchCalls++;
      const commands = JSON.parse(String(init?.body)) as unknown[][];
      if (commands.some((c) => /^(EVAL|EVALSHA|SCRIPT)$/i.test(String(c[0])))) luaAttempts++;
      return new Response(JSON.stringify(pipelineHandler(commands)), { status: 200 });
    }) as typeof fetch;

    const mod = await importFreshRateLimitModule();

    const first = await mod.checkScopedRateLimit('fallback-scope', 2, '60 s', 'caller-1');
    assert.equal(first.allowed, true, 'first request is under the limit of 2');
    assert.equal(first.degraded, false, 'a working fallback is not a degraded/outage state');
    assert.equal(luaAttempts, 1, 'exactly one Lua attempt before the unsupported-command detection latches');
    assert.equal(fetchCalls, 2, 'the failed Lua attempt plus its immediate fallback pipeline call');

    const second = await mod.checkScopedRateLimit('fallback-scope', 2, '60 s', 'caller-1');
    assert.equal(second.allowed, true, 'second request is still under the limit of 2');

    const third = await mod.checkScopedRateLimit('fallback-scope', 2, '60 s', 'caller-1');
    assert.equal(third.allowed, false, 'third request exceeds the limit of 2 and must be blocked');
    assert.equal(third.degraded, false, 'enforcement, not an outage — degraded must stay false');

    // The cached "unsupported" detection must not retry Lua on every call —
    // still exactly 1 attempt after 3 limiter checks, with the other 3 calls
    // going straight to the non-Lua fallback (4 total: 1 Lua + 3 fallback).
    assert.equal(luaAttempts, 1, 'Lua must not be retried once EVALSHA is known unsupported');
    assert.equal(fetchCalls, 4, '1 failed Lua attempt + 3 fallback pipeline calls');

    // A different identifier gets its own independent window.
    const otherCaller = await mod.checkScopedRateLimit('fallback-scope', 2, '60 s', 'caller-2');
    assert.equal(otherCaller.allowed, true, 'a different identifier has its own fixed-window counter');
  });

  it('checkFailClosedScopedIpRateLimit converts an enforced scoped limit to a standard 429', async () => {
    const pipelineHandler = makeProxyPipelineHandler();
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const commands = JSON.parse(String(init?.body)) as unknown[][];
      return new Response(JSON.stringify(pipelineHandler(commands)), { status: 200 });
    }) as typeof fetch;

    const mod = await importFreshRateLimitModule();
    const req = makeRequest({ 'x-real-ip': '203.0.113.15' });

    assert.equal(
      await mod.checkFailClosedScopedIpRateLimit(req, 'pre-attribution-fallback', 1, '60 s', {}),
      null,
    );
    const blocked = await mod.checkFailClosedScopedIpRateLimit(
      req,
      'pre-attribution-fallback',
      1,
      '60 s',
      {},
    );
    assert.equal(blocked?.status, 429);
    assert.equal(blocked.headers.get('X-RateLimit-Limit'), '1');
  });
});
