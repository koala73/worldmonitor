import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import handler, {
  __setNotifyDepsForTests,
  NOTIFY_WRITE_RATE_LIMIT,
  NOTIFY_WRITE_RATE_SCOPE,
  NOTIFY_WRITE_RATE_WINDOW,
} from '../api/notify.ts';

const originalFetch = globalThis.fetch;
const originalUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const TEST_NOW = 1_700_000_000_000;
const TEST_USER_ID = 'user_notify_rate_limit_test';
const IDEMPOTENCY_KEY = '7ea904e0-2f7f-4bbb-86e6-1ed5af3bea83';

type RateLimitResult = {
  allowed: boolean;
  limit: number;
  reset: number;
  degraded: boolean;
};

function makePost(
  body: Record<string, unknown> = { eventType: 'market_alert', payload: { symbol: 'WTI' } },
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request('https://worldmonitor.app/api/notify', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function installDeps(rateLimitResult: RateLimitResult): Array<RateLimitResult> {
  const rateLimitCalls: RateLimitResult[] = [];
  __setNotifyDepsForTests({
    validateBearerToken: async () => ({ valid: true, userId: TEST_USER_ID }),
    checkTierProEntitlement: async () => ({ allowed: true }),
    checkScopedRateLimit: async () => {
      rateLimitCalls.push(rateLimitResult);
      return rateLimitResult;
    },
  });
  return rateLimitCalls;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

afterEach(() => {
  __setNotifyDepsForTests(null);
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  if (originalUpstashUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUpstashUrl;
  if (originalUpstashToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalUpstashToken;
});

describe('/api/notify write rate limit', () => {
  it('uses the shared degraded 503 contract when the limiter is unavailable', async () => {
    const rateLimitCalls = installDeps({
      allowed: true,
      limit: NOTIFY_WRITE_RATE_LIMIT,
      reset: 0,
      degraded: true,
    });

    const res = await handler(makePost());

    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.equal(res.headers.get('Retry-After'), '5');
    assert.deepEqual(await res.json(), { error: 'Rate-limit service temporarily unavailable' });
    assert.equal(rateLimitCalls.length, 1);
  });

  it('returns the complete shared 429 header contract for a confirmed quota denial', async () => {
    mock.method(Date, 'now', () => TEST_NOW);
    installDeps({
      allowed: false,
      limit: NOTIFY_WRITE_RATE_LIMIT,
      reset: TEST_NOW + 30_000,
      degraded: false,
    });

    const res = await handler(makePost());

    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'RATE_LIMITED' });
    assert.equal(res.headers.get('RateLimit-Policy'), '"default";q=30;w=60');
    assert.equal(res.headers.get('RateLimit-Limit'), '30');
    assert.equal(res.headers.get('RateLimit-Remaining'), '0');
    assert.equal(res.headers.get('RateLimit-Reset'), '30');
    assert.equal(res.headers.get('RateLimit'), '"default";r=0;t=30');
    assert.equal(res.headers.get('X-RateLimit-Limit'), '30');
    assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
    assert.equal(res.headers.get('X-RateLimit-Reset'), String(TEST_NOW + 30_000));
    assert.equal(res.headers.get('Retry-After'), '30');
  });

  it('replays a completed Idempotency-Key response without charging an exhausted quota', async () => {
    const body = { eventType: 'market_alert', payload: { symbol: 'WTI' } };
    const reqHash = await sha256Hex(JSON.stringify(body));
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    globalThis.fetch = mock.fn(async () => Response.json([{
      result: JSON.stringify({
        state: 'completed',
        status: 200,
        contentType: 'application/json',
        reqHash,
        body: JSON.stringify({ ok: true }),
      }),
    }])) as typeof fetch;
    const rateLimitCalls = installDeps({
      allowed: false,
      limit: NOTIFY_WRITE_RATE_LIMIT,
      reset: TEST_NOW + 30_000,
      degraded: false,
    });

    const res = await handler(makePost(body, { 'Idempotency-Key': IDEMPOTENCY_KEY }));

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Idempotent-Replayed'), 'true');
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(rateLimitCalls, []);
  });
});
