import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import handler, {
  __setUserPrefsDepsForTests,
  USER_PREFS_WRITE_RATE_LIMIT,
  USER_PREFS_WRITE_RATE_SCOPE,
  USER_PREFS_WRITE_RATE_WINDOW,
} from '../api/user-prefs.ts';
import {
  USER_PREFS_WRITE_RATE_LIMIT as CONVEX_USER_PREFS_WRITE_RATE_LIMIT,
  USER_PREFS_WRITE_RATE_WINDOW_MS,
} from '../convex/constants.ts';

const originalConvexUrl = process.env.CONVEX_URL;
const originalFetch = globalThis.fetch;
const TEST_NOW = 1_700_000_000_000;
const TEST_USER_ID = 'user_rate_limit_test';
const IDEMPOTENCY_KEY = '4f8b9c2e-1a3d-4b6f-8e0a-2c5d7f9b1e34';

type RateLimitResult = {
  allowed: boolean;
  limit: number;
  reset: number;
  degraded: boolean;
};

type ClientCall =
  | { kind: 'auth'; token: string }
  | { kind: 'client'; url: string }
  | { kind: 'setAuth'; token: string }
  | { kind: 'query'; name: unknown; args: Record<string, unknown> }
  | { kind: 'mutation'; name: unknown; args: Record<string, unknown> };

function expectExposedRateLimitHeaders(headers: Headers): void {
  const exposed = headers.get('Access-Control-Expose-Headers') ?? '';
  assert.match(exposed, /Retry-After/);
  assert.match(exposed, /X-RateLimit-Limit/);
  assert.match(exposed, /X-RateLimit-Remaining/);
  assert.match(exposed, /X-RateLimit-Reset/);
}

function restoreEnv(): void {
  if (originalConvexUrl === undefined) delete process.env.CONVEX_URL;
  else process.env.CONVEX_URL = originalConvexUrl;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  globalThis.fetch = originalFetch;
}

async function sha256Hex(str: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

afterEach(() => {
  __setUserPrefsDepsForTests(null);
  mock.restoreAll();
  restoreEnv();
});

function makePost(body: Record<string, unknown> = {
  variant: 'full',
  data: { theme: 'dark' },
  expectedSyncVersion: 1,
}, extraHeaders: Record<string, string> = {}): Request {
  return new Request('https://worldmonitor.app/api/user-prefs', {
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

function installRedisPipeline(handler: (commands: string[][]) => Array<{ result: unknown }>): string[][][] {
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
  const calls: string[][][] = [];
  globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const commands = JSON.parse(String(init?.body ?? '[]')) as string[][];
    calls.push(commands);
    return Response.json(handler(commands));
  }) as typeof fetch;
  return calls;
}

function installDeps(rateLimitResult: RateLimitResult): {
  calls: ClientCall[];
  rateLimitCalls: Array<{ scope: string; limit: number; window: string; identifier: string }>;
} {
  const calls: ClientCall[] = [];
  const rateLimitCalls: Array<{ scope: string; limit: number; window: string; identifier: string }> = [];

  __setUserPrefsDepsForTests({
    validateBearerToken: async (token: string) => {
      calls.push({ kind: 'auth', token });
      return { valid: true, userId: TEST_USER_ID };
    },
    checkScopedRateLimit: async (scope: string, limit: number, window: string, identifier: string) => {
      rateLimitCalls.push({ scope, limit, window, identifier });
      return rateLimitResult;
    },
    createConvexClient: (url: string) => {
      calls.push({ kind: 'client', url });
      return {
        setAuth(token: string): void {
          calls.push({ kind: 'setAuth', token });
        },
        async query(name: unknown, args: Record<string, unknown>): Promise<unknown> {
          calls.push({ kind: 'query', name, args });
          return null;
        },
        async mutation(name: unknown, args: Record<string, unknown>): Promise<unknown> {
          calls.push({ kind: 'mutation', name, args });
          return { ok: true, syncVersion: 7 };
        },
      };
    },
  });

  return { calls, rateLimitCalls };
}

describe('user-prefs POST write rate limit', () => {
  it('keeps the Edge and Convex write limit contracts in lockstep', () => {
    assert.equal(USER_PREFS_WRITE_RATE_LIMIT, CONVEX_USER_PREFS_WRITE_RATE_LIMIT);
    assert.equal(USER_PREFS_WRITE_RATE_WINDOW, String(USER_PREFS_WRITE_RATE_WINDOW_MS / 1000) + ' s');
  });

  it('rejects invalid sessions before checking the scoped limiter', async () => {
    const rateLimitCalls: Array<{ scope: string; limit: number; window: string; identifier: string }> = [];
    let createdClient = false;

    __setUserPrefsDepsForTests({
      validateBearerToken: async () => ({ valid: false }),
      checkScopedRateLimit: async (scope: string, limit: number, window: string, identifier: string) => {
        rateLimitCalls.push({ scope, limit, window, identifier });
        return { allowed: true, limit, reset: 0, degraded: false };
      },
      createConvexClient: () => {
        createdClient = true;
        throw new Error('Convex client should not be constructed for invalid sessions');
      },
    });

    const res = await handler(makePost());

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'UNAUTHENTICATED' });
    assert.deepEqual(rateLimitCalls, []);
    assert.equal(createdClient, false);
  });

  it('returns 429 + Retry-After without calling Convex when the identity is over budget', async () => {
    process.env.CONVEX_URL = 'https://convex.test';
    mock.method(Date, 'now', () => TEST_NOW);
    const warnMock = mock.method(console, 'warn', () => {});
    const { calls, rateLimitCalls } = installDeps({
      allowed: false,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset: TEST_NOW + 30_000,
      degraded: false,
    });

    const res = await handler(makePost());

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '30');
    assert.equal(res.headers.get('X-RateLimit-Limit'), String(USER_PREFS_WRITE_RATE_LIMIT));
    assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
    assert.equal(res.headers.get('X-RateLimit-Reset'), String(TEST_NOW + 30_000));
    expectExposedRateLimitHeaders(res.headers);
    assert.deepEqual(await res.json(), { error: 'RATE_LIMITED' });
    assert.deepEqual(rateLimitCalls, [{
      scope: USER_PREFS_WRITE_RATE_SCOPE,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      window: USER_PREFS_WRITE_RATE_WINDOW,
      identifier: TEST_USER_ID,
    }]);
    assert.equal(calls.some((call) => call.kind === 'client'), false, 'over-budget requests must not construct a Convex client');
    assert.equal(calls.some((call) => call.kind === 'mutation'), false, 'over-budget requests must not reach Convex');
    assert.equal(warnMock.mock.calls.length, 1);
  });

  it('passes an under-budget identity through to setPreferences', async () => {
    process.env.CONVEX_URL = 'https://convex.test';
    const { calls, rateLimitCalls } = installDeps({
      allowed: true,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset: TEST_NOW + 60_000,
      degraded: false,
    });

    const res = await handler(makePost({
      variant: 'tech',
      data: { theme: 'light' },
      expectedSyncVersion: 2,
      schemaVersion: 3,
    }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { syncVersion: 7 });
    assert.deepEqual(rateLimitCalls, [{
      scope: USER_PREFS_WRITE_RATE_SCOPE,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      window: USER_PREFS_WRITE_RATE_WINDOW,
      identifier: TEST_USER_ID,
    }]);
    const mutation = calls.find((call): call is Extract<ClientCall, { kind: 'mutation' }> => call.kind === 'mutation');
    assert.ok(mutation, 'under-budget request should call setPreferences');
    assert.equal(mutation.name, 'userPreferences:setPreferences');
    assert.deepEqual(mutation.args, {
      variant: 'tech',
      data: { theme: 'light' },
      expectedSyncVersion: 2,
      schemaVersion: 3,
    });
  });

  it('fails open when the scoped limiter is degraded', async () => {
    process.env.CONVEX_URL = 'https://convex.test';
    const warnMock = mock.method(console, 'warn', () => {});
    const { calls } = installDeps({
      allowed: true,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset: 0,
      degraded: true,
    });

    const res = await handler(makePost());

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { syncVersion: 7 });
    assert.ok(calls.some((call) => call.kind === 'mutation'), 'degraded limiter should fail open to Convex');
    assert.equal(warnMock.mock.calls.length, 1);
    assert.match(String(warnMock.mock.calls[0].arguments[0]), /rate limit unavailable; failing open/);
  });

  it('replays a completed Idempotency-Key response before charging the scoped limiter', async () => {
    process.env.CONVEX_URL = 'https://convex.test';
    const body = {
      variant: 'full',
      data: { theme: 'dark' },
      expectedSyncVersion: 1,
    };
    const reqHash = await sha256Hex(JSON.stringify(body));
    installRedisPipeline(() => [
      {
        result: JSON.stringify({
          state: 'completed',
          status: 200,
          contentType: 'application/json',
          reqHash,
          body: JSON.stringify({ syncVersion: 42 }),
        }),
      },
    ]);

    const { calls, rateLimitCalls } = installDeps({
      allowed: true,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset: TEST_NOW + 60_000,
      degraded: false,
    });

    const res = await handler(makePost(body, { 'Idempotency-Key': IDEMPOTENCY_KEY }));

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Idempotent-Replayed'), 'true');
    assert.deepEqual(await res.json(), { syncVersion: 42 });
    assert.deepEqual(rateLimitCalls, []);
    assert.equal(calls.some((call) => call.kind === 'client'), false, 'replay should not construct a Convex client');
    assert.equal(calls.some((call) => call.kind === 'mutation'), false, 'replay should not reach Convex');
  });

  it('claims a fresh Idempotency-Key only after the scoped limiter allows the write', async () => {
    process.env.CONVEX_URL = 'https://convex.test';
    const redisCalls = installRedisPipeline((commands) => {
      if (commands[0][0] === 'GET') return [{ result: null }];
      if (commands[0][0] === 'SET' && commands[0].includes('NX')) {
        return [{ result: 'OK' }, { result: null }];
      }
      return [{ result: 'OK' }];
    });
    const { calls, rateLimitCalls } = installDeps({
      allowed: true,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset: TEST_NOW + 60_000,
      degraded: false,
    });

    const res = await handler(makePost(undefined, { 'Idempotency-Key': IDEMPOTENCY_KEY }));

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Idempotency-Key'), IDEMPOTENCY_KEY);
    assert.equal(res.headers.get('Idempotent-Replayed'), 'false');
    assert.deepEqual(await res.json(), { syncVersion: 7 });
    assert.deepEqual(rateLimitCalls, [{
      scope: USER_PREFS_WRITE_RATE_SCOPE,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      window: USER_PREFS_WRITE_RATE_WINDOW,
      identifier: TEST_USER_ID,
    }]);
    assert.ok(calls.some((call) => call.kind === 'mutation'), 'allowed keyed write should reach Convex');
    assert.equal(redisCalls[0][0][0], 'GET', 'completed replay lookup should happen before rate limiting');
    assert.deepEqual(redisCalls[1][0].slice(0, 4), ['SET', redisCalls[1][0][1], redisCalls[1][0][2], 'NX']);
    assert.equal(redisCalls[2][0][0], 'SET', 'successful response should be persisted for replay');
  });

  it('does not claim or cache a fresh Idempotency-Key when the scoped limiter rejects the write', async () => {
    process.env.CONVEX_URL = 'https://convex.test';
    mock.method(Date, 'now', () => TEST_NOW);
    const warnMock = mock.method(console, 'warn', () => {});
    const redisCalls = installRedisPipeline(() => [{ result: null }]);
    const { calls, rateLimitCalls } = installDeps({
      allowed: false,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset: TEST_NOW + 30_000,
      degraded: false,
    });

    const res = await handler(makePost(undefined, { 'Idempotency-Key': IDEMPOTENCY_KEY }));

    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'RATE_LIMITED' });
    assert.equal(redisCalls.length, 1, 'rate-limited fresh keys should only perform the pre-limit replay lookup');
    assert.equal(redisCalls[0][0][0], 'GET');
    assert.deepEqual(rateLimitCalls, [{
      scope: USER_PREFS_WRITE_RATE_SCOPE,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      window: USER_PREFS_WRITE_RATE_WINDOW,
      identifier: TEST_USER_ID,
    }]);
    assert.equal(calls.some((call) => call.kind === 'mutation'), false, 'rate-limited requests must not reach Convex');
    assert.equal(warnMock.mock.calls.length, 1);
  });

  it('maps Convex-side RATE_LIMITED to 429 with retry guidance', async () => {
    process.env.CONVEX_URL = 'https://convex.test';
    mock.method(Date, 'now', () => TEST_NOW);
    const warnMock = mock.method(console, 'warn', () => {});
    const reset = TEST_NOW + 12_000;

    __setUserPrefsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: TEST_USER_ID }),
      checkScopedRateLimit: async () => ({
        allowed: true,
        limit: USER_PREFS_WRITE_RATE_LIMIT,
        reset,
        degraded: false,
      }),
      createConvexClient: () => ({
        setAuth(): void {},
        async query(): Promise<unknown> {
          return null;
        },
        async mutation(): Promise<unknown> {
          const err = new Error('ConvexError: RATE_LIMITED') as Error & {
            data?: Record<string, unknown>;
          };
          err.data = { kind: 'RATE_LIMITED', limit: USER_PREFS_WRITE_RATE_LIMIT, reset };
          throw err;
        },
      }),
    });

    const res = await handler(makePost());

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '12');
    assert.equal(res.headers.get('X-RateLimit-Limit'), String(USER_PREFS_WRITE_RATE_LIMIT));
    assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
    assert.equal(res.headers.get('X-RateLimit-Reset'), String(reset));
    expectExposedRateLimitHeaders(res.headers);
    assert.deepEqual(await res.json(), { error: 'RATE_LIMITED' });
    assert.equal(warnMock.mock.calls.length, 1);
    assert.match(String(warnMock.mock.calls[0].arguments[0]), /convex write rate limit exceeded/);
  });

  it('maps returned Convex-side RATE_LIMITED to 429 with retry guidance and a warning', async () => {
    process.env.CONVEX_URL = 'https://convex.test';
    mock.method(Date, 'now', () => TEST_NOW);
    const warnMock = mock.method(console, 'warn', () => {});
    const reset = TEST_NOW + 12_000;

    __setUserPrefsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: TEST_USER_ID }),
      checkScopedRateLimit: async () => ({
        allowed: true,
        limit: USER_PREFS_WRITE_RATE_LIMIT,
        reset,
        degraded: false,
      }),
      createConvexClient: () => ({
        setAuth(): void {},
        async query(): Promise<unknown> {
          return null;
        },
        async mutation(): Promise<unknown> {
          return {
            ok: false,
            reason: 'RATE_LIMITED',
            limit: USER_PREFS_WRITE_RATE_LIMIT,
            reset,
          };
        },
      }),
    });

    const res = await handler(makePost());

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '12');
    assert.equal(res.headers.get('X-RateLimit-Limit'), String(USER_PREFS_WRITE_RATE_LIMIT));
    assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
    assert.equal(res.headers.get('X-RateLimit-Reset'), String(reset));
    expectExposedRateLimitHeaders(res.headers);
    assert.deepEqual(await res.json(), { error: 'RATE_LIMITED' });
    assert.equal(warnMock.mock.calls.length, 1);
    assert.match(String(warnMock.mock.calls[0].arguments[0]), /convex write rate limit exceeded/);
  });

  it('maps returned Convex-side BLOB_TOO_LARGE to 400', async () => {
    process.env.CONVEX_URL = 'https://convex.test';

    __setUserPrefsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: TEST_USER_ID }),
      checkScopedRateLimit: async () => ({
        allowed: true,
        limit: USER_PREFS_WRITE_RATE_LIMIT,
        reset: TEST_NOW + 60_000,
        degraded: false,
      }),
      createConvexClient: () => ({
        setAuth(): void {},
        async query(): Promise<unknown> {
          return null;
        },
        async mutation(): Promise<unknown> {
          return {
            ok: false,
            reason: 'BLOB_TOO_LARGE',
            size: 123,
            max: 100,
          };
        },
      }),
    });

    const res = await handler(makePost());

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'BLOB_TOO_LARGE' });
  });
});
