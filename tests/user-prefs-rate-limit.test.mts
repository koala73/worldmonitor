import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import handler, {
  __setUserPrefsDepsForTests,
  USER_PREFS_WRITE_RATE_LIMIT,
  USER_PREFS_WRITE_RATE_SCOPE,
  USER_PREFS_WRITE_RATE_WINDOW,
} from '../api/user-prefs.ts';

const originalConvexUrl = process.env.CONVEX_URL;
const TEST_NOW = 1_700_000_000_000;
const TEST_USER_ID = 'user_rate_limit_test';

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

function restoreEnv(): void {
  if (originalConvexUrl === undefined) delete process.env.CONVEX_URL;
  else process.env.CONVEX_URL = originalConvexUrl;
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
}): Request {
  return new Request('https://worldmonitor.app/api/user-prefs', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
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
});
