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

describe('api/_rate-limit getClientIp (#3531)', () => {
  it('prefers cf-connecting-ip when Cloudflare is in front', () => {
    const req = makeRequest({
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': '192.0.2.5',
      'x-forwarded-for': '198.51.100.8',
    });
    assert.equal(getClientIp(req), '203.0.113.7');
  });

  it('does NOT honour x-forwarded-for as a fallback identity', () => {
    const req = makeRequest({ 'x-forwarded-for': '198.51.100.8, 203.0.113.10' });
    assert.equal(getClientIp(req), UNKNOWN_CLIENT_IP);
    assert.equal(getClientIp(req), 'unknown');
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
});

describe('api/_rate-limit constants parity', () => {
  it('mirrors server/_shared/rate-limit degraded-marker shape', () => {
    assert.equal(RATE_LIMIT_DEGRADED_HEADERS['X-RateLimit-Mode'], 'degraded');
    assert.equal(RATE_LIMIT_DEGRADED_HEADERS['Retry-After'], '5');
  });
});
