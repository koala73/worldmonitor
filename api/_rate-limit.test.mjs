// Tests for the M9 (fail-closed posture + audible Redis errors) and M16
// (drop spoofable x-forwarded-for fallback) fixes from issue #3531 — Vercel
// edge mirror at api/_rate-limit.js. Behavioural parity with
// server/_shared/rate-limit.ts is enforced by string-comparing
// RATE_LIMIT_DEGRADED_HEADERS / UNKNOWN_CLIENT_IP across the two files.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  RATE_LIMIT_DEGRADED_HEADERS,
  UNKNOWN_CLIENT_IP,
  __resetRateLimitForTest,
  checkRateLimit,
  getClientIp,
} from './_rate-limit.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalConsoleError = console.error;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeRequest(headers = {}) {
  return new Request('https://worldmonitor.app/api/test', { headers });
}

async function importFreshRateLimitModule() {
  return import(`./_rate-limit.js?test=${Date.now()}-${Math.random()}`);
}

describe('api/_rate-limit getClientIp (#3531)', () => {
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

  it('does NOT honour x-forwarded-for as a fallback identity', () => {
    const req = makeRequest({ 'x-forwarded-for': '198.51.100.8, 203.0.113.10' });
    assert.equal(getClientIp(req), UNKNOWN_CLIENT_IP);
    assert.equal(getClientIp(req), 'unknown');
  });
});

describe('api/_rate-limit getClientIp — Cloudflare edge-proof (GHSA-c267)', () => {
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

describe('api/_rate-limit checkRateLimit fail-open / fail-closed (#3531 M9)', () => {
  let consoleErrors = [];

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    consoleErrors = [];
    console.error = (...args) => {
      consoleErrors.push(args.map((a) => String(a)).join(' '));
    };
    globalThis.fetch = async () => {
      throw new Error('upstash unreachable');
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    __resetRateLimitForTest();
    restoreEnv();
  });

  it('fail-open default: returns null and logs a structured Redis error', async () => {
    const res = await checkRateLimit(makeRequest({ 'cf-connecting-ip': '203.0.113.7' }), {});
    assert.equal(res, null);
    assert.ok(
      consoleErrors.some(
        (line) =>
          line.includes('[rate-limit] redis-error') &&
          line.includes('stage=checkRateLimit'),
      ),
      `expected structured rate-limit error log, got: ${consoleErrors.join('\n')}`,
    );
  });

  it('failClosed=true: returns 503 with the X-RateLimit-Mode degraded marker', async () => {
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
    );
  });

  it('failClosed=true: returns degraded 503 when Upstash env is missing', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const mod = await importFreshRateLimitModule();

    const res = await mod.checkRateLimit(
      makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      { 'Access-Control-Allow-Origin': 'https://worldmonitor.app' },
      { failClosed: true },
    );

    assert.ok(res, 'expected a Response when fail-closed limiter is unconfigured');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.equal(res.headers.get('Retry-After'), '5');
    assert.equal(
      res.headers.get('Access-Control-Allow-Origin'),
      'https://worldmonitor.app',
    );
  });

  it('custom scoped policy uses the caller-supplied lower limit', async () => {
    const redisBodies = [];
    globalThis.fetch = async (_input, init) => {
      redisBodies.push(String(init?.body ?? ''));
      return new Response(
        JSON.stringify([{ result: [29, 30] }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const res = await checkRateLimit(
      makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      {},
      { scope: 'wm-session', limit: 30, window: '60 s', failClosed: true },
    );

    assert.equal(res, null);
    assert.ok(
      redisBodies.some((body) => body.includes('rl:wm-session') && body.includes('30')),
      `expected scoped 30/min limiter command, got: ${redisBodies.join('\n')}`,
    );
  });

  it('custom scoped policy returns 429 with the configured lower limit when exhausted', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify([{ result: [-1, 30] }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const res = await checkRateLimit(
      makeRequest({ 'cf-connecting-ip': '203.0.113.7' }),
      { 'Access-Control-Allow-Origin': 'https://worldmonitor.app' },
      { scope: 'wm-session', limit: 30, window: '60 s', failClosed: true },
    );

    assert.ok(res, 'expected a Response when the scoped policy is exhausted');
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('X-RateLimit-Limit'), '30');
    assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
    assert.equal(
      res.headers.get('Access-Control-Allow-Origin'),
      'https://worldmonitor.app',
    );
  });
});

describe('api/_rate-limit constants parity', () => {
  it('mirrors server/_shared/rate-limit degraded-marker shape', () => {
    assert.equal(RATE_LIMIT_DEGRADED_HEADERS['X-RateLimit-Mode'], 'degraded');
    assert.equal(RATE_LIMIT_DEGRADED_HEADERS['Retry-After'], '5');
  });
});
