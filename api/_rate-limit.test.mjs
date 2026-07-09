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
    // IETF RateLimit fields alongside the legacy set (draft-ietf-httpapi-ratelimit-headers).
    assert.equal(res.headers.get('RateLimit-Policy'), '"default";q=30;w=60');
    assert.equal(res.headers.get('RateLimit-Limit'), '30');
    assert.equal(res.headers.get('RateLimit-Remaining'), '0');
    // Combined RateLimit member references the "default" policy with a delta-seconds reset.
    assert.match(res.headers.get('RateLimit') ?? '', /^"default";r=0;t=\d+$/);
    // Retry-After is delta-seconds (not the epoch-ms carried by X-RateLimit-Reset).
    assert.match(res.headers.get('Retry-After') ?? '', /^\d+$/);
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

describe('api/_rate-limit checkRateLimit EVALSHA-unsupported fallback (mirrors tests/rate-limit.test.mts #7c)', () => {
  // The api/ mirror was only covered by the constants-parity block above —
  // if this file's limitWithFallback drifts from server/_shared/rate-limit.ts
  // or mishandles the redis-rest proxy's "Command not allowed: EVALSHA"
  // response, API routes could keep failing while the tested server helper
  // stays green. Exercise the mirror's own fallback path end to end.
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
  // allowlist docker/redis-rest-proxy.mjs enforces — mirrors the handler in
  // tests/rate-limit.test.mts so both surfaces are proven against identical
  // proxy behaviour.
  const ALLOWED_COMMANDS = new Set(['INCR', 'EXPIRE', 'TTL']);

  function makeProxyPipelineHandler({ expireNxUnsupported = false } = {}) {
    const store = new Map();
    return (commands) =>
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

  it('degrades instead of creating a permanent counter when EXPIRE NX is unsupported', async () => {
    const pipelineHandler = makeProxyPipelineHandler({ expireNxUnsupported: true });
    globalThis.fetch = async (_url, init) => {
      const commands = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(pipelineHandler(commands)), { status: 200 });
    };

    const mod = await importFreshRateLimitModule();
    const req = makeRequest({ 'x-real-ip': '203.0.113.12' });

    const failOpen = await mod.checkRateLimit(
      req,
      {},
      { scope: 'redis6-fallback', limit: 1, window: '60 s' },
    );
    assert.equal(failOpen, null, 'default API rate limit should fail open when fallback cannot set a TTL');

    const failClosed = await mod.checkRateLimit(
      req,
      {},
      { scope: 'redis6-fallback', limit: 1, window: '60 s', failClosed: true },
    );
    assert.ok(failClosed, 'failClosed API callers should receive a degraded response when fallback cannot set a TTL');
    assert.equal(failClosed.status, 503);
    assert.equal(failClosed.headers.get('X-RateLimit-Mode'), 'degraded');
  });

  it('detects "Command not allowed: EVALSHA", falls back to INCR+EXPIRE without retrying Lua, and enforces 429s', async () => {
    const pipelineHandler = makeProxyPipelineHandler();
    let luaAttempts = 0;
    let fetchCalls = 0;
    globalThis.fetch = async (_url, init) => {
      fetchCalls++;
      const commands = JSON.parse(String(init?.body));
      if (commands.some((c) => /^(EVAL|EVALSHA|SCRIPT)$/i.test(String(c[0])))) luaAttempts++;
      return new Response(JSON.stringify(pipelineHandler(commands)), { status: 200 });
    };

    const mod = await importFreshRateLimitModule();
    const req = makeRequest({ 'x-real-ip': '203.0.113.9' });

    const first = await mod.checkRateLimit(req, {});
    assert.equal(first, null, 'first request is under the global limit');
    assert.equal(luaAttempts, 1, 'exactly one Lua attempt before the unsupported-command detection latches');
    assert.equal(fetchCalls, 2, 'the failed Lua attempt plus its immediate fallback pipeline call');

    const second = await mod.checkRateLimit(req, {});
    assert.equal(second, null, 'second request is still under the limit');
    assert.equal(luaAttempts, 1, 'Lua must not be retried once EVALSHA is known unsupported');
    assert.equal(fetchCalls, 3, 'no further Lua attempts — only the fallback pipeline call');

    // Drive the same identifier past the global fixed-window limit purely
    // through the fallback path until checkRateLimit enforces a 429. Bound
    // generously above the known GLOBAL_RATE_LIMIT (600) so a source change
    // to the limit can't turn this into an infinite loop.
    let res = null;
    let iterations = 0;
    while (!res && iterations < 1000) {
      res = await mod.checkRateLimit(req, {});
      iterations++;
    }

    assert.ok(res, 'expected checkRateLimit to eventually return a 429 Response');
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
    assert.ok(res.headers.get('Retry-After'), 'expected a Retry-After header on the 429');
    assert.equal(luaAttempts, 1, 'Lua must stay latched off while the fallback enforces the window');

    // A different identifier gets its own independent fixed window.
    const otherReq = makeRequest({ 'x-real-ip': '203.0.113.10' });
    const other = await mod.checkRateLimit(otherReq, {});
    assert.equal(other, null, 'a different identifier has its own fixed-window counter');
  });
});
