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
  checkEndpointRateLimit,
  checkRateLimit,
  checkScopedRateLimit,
  getClientIp,
} from '../server/_shared/rate-limit.ts';

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
    assert.match(src, /surface:\s*'server'/);
    assert.match(src, /fingerprint:\s*\['rate-limit',\s*'redis-error',\s*stage\]/);
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
      path: 'server/worldmonitor/leads/v1/register-interest.ts',
      expected: /if\s*\(\s*scoped\.degraded\s*\)\s*\{/,
      reason: 'desktop lead capture bypasses Turnstile, so Redis degradation must fail closed locally',
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
      path: 'api/mcp-proxy.ts',
      expected: /Redis-degraded scoped limits intentionally stay availability-first/,
      reason: 'MCP proxy is already premium-auth gated; scoped limit degradation is logged and remains availability-first',
    },
    {
      path: 'api/user-prefs.ts',
      expected: /Redis-degraded scoped limits intentionally fail open for prefs writes/,
      reason: 'cloud prefs writes are low-stakes, so Redis degradation should not block legitimate settings sync',
    },
  ];

  it('keeps every checkScopedRateLimit caller audited for degraded handling', async () => {
    const fs = await import('node:fs');
    const cp = await import('node:child_process');
    const repo = new URL('..', import.meta.url);
    const output = cp.execFileSync('git', ['grep', '-lF', 'checkScopedRateLimit(', '--', 'server', 'api'], {
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
      'new checkScopedRateLimit callers must be added here with a degraded-path decision',
    );

    for (const { path, expected, reason } of SCOPED_RATE_LIMIT_CALLERS) {
      const src = fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      assert.match(src, expected, `${path}: ${reason}`);
    }
  });
});

describe('rate-limit constants', () => {
  it('exposes the degraded marker shape both surfaces depend on', () => {
    assert.equal(RATE_LIMIT_DEGRADED_HEADERS['X-RateLimit-Mode'], 'degraded');
    assert.equal(RATE_LIMIT_DEGRADED_HEADERS['Retry-After'], '5');
  });

  it('UNKNOWN_CLIENT_IP is the literal "unknown" so the api/ mirror stays string-equal', () => {
    assert.equal(UNKNOWN_CLIENT_IP, 'unknown');
  });
});
