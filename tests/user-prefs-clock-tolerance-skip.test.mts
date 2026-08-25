import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import handler, { __setUserPrefsDepsForTests } from '../api/user-prefs.ts';

/**
 * Regression coverage for #7140: `session.acceptedWithinClockTolerance` skips
 * the Sentry drift capture on both the GET and POST UNAUTHENTICATED paths in
 * api/user-prefs.ts (documented as an invariant in CONCEPTS.md by #7097).
 * Neither branch had a dedicated test, so deleting either `if` silently
 * breaks the documented "only a token past `exp` _and_ past that tolerance
 * is refused at the edge" boundary without failing any test.
 */

const TEST_USER_ID = 'user_clock_tolerance_test';

afterEach(() => {
  __setUserPrefsDepsForTests(null);
  mock.restoreAll();
});

function makeGet(): Request {
  return new Request('https://worldmonitor.app/api/user-prefs?variant=full', {
    method: 'GET',
    headers: { Origin: 'https://worldmonitor.app', Authorization: 'Bearer test-token' },
  });
}

function makePost(): Request {
  return new Request('https://worldmonitor.app/api/user-prefs', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ variant: 'full', data: { theme: 'dark' }, expectedSyncVersion: 1 }),
  });
}

function installDeps(session: { valid: true; userId: string; acceptedWithinClockTolerance?: true }) {
  process.env.CONVEX_URL = 'https://convex.test';
  __setUserPrefsDepsForTests({
    validateBearerToken: async () => session,
    checkScopedRateLimit: async (_scope, limit) => ({ allowed: true, limit, reset: 0, degraded: false }),
    createConvexClient: () => ({
      setAuth(): void {},
      async query(): Promise<unknown> {
        const err = new Error('ConvexError: Unauthenticated') as Error & { data?: Record<string, unknown> };
        err.data = { kind: 'UNAUTHENTICATED' };
        throw err;
      },
      async mutation(): Promise<unknown> {
        const err = new Error('ConvexError: Unauthenticated') as Error & { data?: Record<string, unknown> };
        err.data = { kind: 'UNAUTHENTICATED' };
        throw err;
      },
    }),
  });
}

describe('user-prefs acceptedWithinClockTolerance skip (#7140)', () => {
  it('GET: tolerance-accepted token skips drift capture', async () => {
    const warnMock = mock.method(console, 'warn', () => {});
    installDeps({ valid: true, userId: TEST_USER_ID, acceptedWithinClockTolerance: true });

    const res = await handler(makeGet());

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'UNAUTHENTICATED' });
    assert.equal(warnMock.mock.calls.length, 1, 'only the tolerance-skip warning should fire');
    assert.match(String(warnMock.mock.calls[0].arguments[0]), /expected near-expiry, not drift/);
  });

  it('GET: ordinary UNAUTHENTICATED (no tolerance flag) still captures as drift', async () => {
    const warnMock = mock.method(console, 'warn', () => {});
    installDeps({ valid: true, userId: TEST_USER_ID });

    const res = await handler(makeGet());

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'UNAUTHENTICATED' });
    assert.equal(warnMock.mock.calls.length, 1);
    assert.match(String(warnMock.mock.calls[0].arguments[0]), /convex auth drift/);
  });

  it('POST: tolerance-accepted token skips drift capture', async () => {
    const warnMock = mock.method(console, 'warn', () => {});
    installDeps({ valid: true, userId: TEST_USER_ID, acceptedWithinClockTolerance: true });

    const res = await handler(makePost());

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'UNAUTHENTICATED' });
    assert.equal(warnMock.mock.calls.length, 1, 'only the tolerance-skip warning should fire');
    assert.match(String(warnMock.mock.calls[0].arguments[0]), /expected near-expiry, not drift/);
  });

  it('POST: ordinary UNAUTHENTICATED (no tolerance flag) still captures as drift', async () => {
    const warnMock = mock.method(console, 'warn', () => {});
    installDeps({ valid: true, userId: TEST_USER_ID });

    const res = await handler(makePost());

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'UNAUTHENTICATED' });
    assert.equal(warnMock.mock.calls.length, 1);
    assert.match(String(warnMock.mock.calls[0].arguments[0]), /convex auth drift/);
  });
});
