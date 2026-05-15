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

describe('rate-limit getClientIp (#3531 — drop spoofable x-forwarded-for)', () => {
  it('prefers cf-connecting-ip when Cloudflare is in front', () => {
    const req = makeRequest({
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': '192.0.2.5',
      'x-forwarded-for': '198.51.100.8',
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

describe('rate-limit constants', () => {
  it('exposes the degraded marker shape both surfaces depend on', () => {
    assert.equal(RATE_LIMIT_DEGRADED_HEADERS['X-RateLimit-Mode'], 'degraded');
    assert.equal(RATE_LIMIT_DEGRADED_HEADERS['Retry-After'], '5');
  });

  it('UNKNOWN_CLIENT_IP is the literal "unknown" so the api/ mirror stays string-equal', () => {
    assert.equal(UNKNOWN_CLIENT_IP, 'unknown');
  });
});
