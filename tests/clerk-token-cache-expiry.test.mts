/**
 * The Clerk token cache must respect the token's OWN expiry, not just a flat TTL.
 *
 * Why this exists (Sentry WORLDMONITOR-XR / XQ, 2026-07-27): a Pro user's
 * session lost its identity on two unrelated endpoints inside the same second —
 * `/api/notification-channels` answered 401 and the gateway logged
 * `/api/intelligence/v1/classify-event` 401 with `customer_id` NULL — bracketed
 * by authenticated 429s for the same `customer_id` a minute either side. So the
 * session was alive; one short window of requests carried a token the server
 * rejected, and it healed on its own.
 *
 * The mechanism is a stacked pair of caches. Clerk's `session.getToken()` is
 * stale-while-revalidate (documented: "when a token is within 15 seconds of
 * expiration, getToken() returns the valid cached token immediately" and
 * refreshes in the background). `getClerkToken()` then stamped whatever it got
 * with a flat 50s TTL, on the premise recorded in its own comment — "Tokens are
 * cached for 50s (Clerk tokens expire at 60s)" — which assumes every token
 * arrives freshly minted. A token handed over with 12s of life left was
 * therefore served for 50s, and the ~38s remainder is dead: the small, bounded
 * `clockTolerance` in `server/auth-session.ts` is not a substitute for refreshing
 * an expired token.
 *
 * The truth table below is the bound; `honours a near-expiry token from Clerk's
 * stale-while-revalidate path` is the case that was live in production.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  __setClerkInstanceForTests,
  clerkTokenExpiresAtMs,
  getClerkToken,
  shouldReuseCachedClerkToken,
} from '../src/services/clerk.ts';

const NOW = 1_760_000_000_000;

afterEach(() => {
  __setClerkInstanceForTests(null);
});

/** A JWT whose payload carries `exp`, the only claim this cache decision reads. */
function tokenExpiringAt(expMs: number): string {
  const payload = Buffer.from(JSON.stringify({ sub: 'user_1', exp: Math.floor(expMs / 1_000) }))
    .toString('base64url');
  return `header.${payload}.signature`;
}

describe('clerkTokenExpiresAtMs', () => {
  it('reads the exp claim as epoch milliseconds', () => {
    assert.equal(clerkTokenExpiresAtMs(tokenExpiringAt(NOW + 60_000)), NOW + 60_000);
  });

  it('returns null for a token with no exp claim', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user_1' })).toString('base64url');
    assert.equal(clerkTokenExpiresAtMs(`header.${payload}.signature`), null);
  });

  it('returns null rather than throwing on a malformed token', () => {
    for (const bad of [null, '', 'not-a-jwt', 'header..signature', 'a.!!!not-base64!!!.c']) {
      assert.equal(clerkTokenExpiresAtMs(bad as string | null), null);
    }
  });
});

describe('shouldReuseCachedClerkToken', () => {
  it('reuses a freshly minted token well inside both bounds', () => {
    assert.equal(
      shouldReuseCachedClerkToken({
        token: tokenExpiringAt(NOW + 50_000),
        cachedAt: NOW - 10_000,
        now: NOW,
      }),
      true,
    );
  });

  // The production bug. Clerk's stale-while-revalidate hands back a token with
  // 12s left; the flat 50s TTL alone would still call this cache entry fresh
  // 20s later, and every request it signs would 401.
  it('honours a near-expiry token from Clerk\'s stale-while-revalidate path', () => {
    assert.equal(
      shouldReuseCachedClerkToken({
        token: tokenExpiringAt(NOW - 8_000), // expired 8s ago
        cachedAt: NOW - 20_000, // ...but only 20s into the 50s TTL
        now: NOW,
      }),
      false,
    );
  });

  it('stops reusing a token before it expires, to absorb clock skew and flight time', () => {
    // 8s of life left is inside the safety margin: the server's bounded clock
    // tolerance is not a substitute for refreshing a near-expiry cached token.
    assert.equal(
      shouldReuseCachedClerkToken({
        token: tokenExpiringAt(NOW + 8_000),
        cachedAt: NOW - 1_000,
        now: NOW,
      }),
      false,
    );
    // 20s of life left is comfortably outside it.
    assert.equal(
      shouldReuseCachedClerkToken({
        token: tokenExpiringAt(NOW + 20_000),
        cachedAt: NOW - 1_000,
        now: NOW,
      }),
      true,
    );
  });

  it('still enforces the flat TTL for a long-lived token', () => {
    // An hour of validity must not defeat the TTL — it is what bounds how long
    // a revoked-but-unexpired session keeps working.
    assert.equal(
      shouldReuseCachedClerkToken({
        token: tokenExpiringAt(NOW + 3_600_000),
        cachedAt: NOW - 60_000,
        now: NOW,
      }),
      false,
    );
  });

  it('falls back to the flat TTL when exp cannot be read', () => {
    // A Clerk token-format change must degrade to the previous behaviour, not
    // sign every user out.
    assert.equal(
      shouldReuseCachedClerkToken({ token: 'opaque-token', cachedAt: NOW - 10_000, now: NOW }),
      true,
    );
    assert.equal(
      shouldReuseCachedClerkToken({ token: 'opaque-token', cachedAt: NOW - 60_000, now: NOW }),
      false,
    );
  });

  it('never reuses a missing token', () => {
    assert.equal(shouldReuseCachedClerkToken({ token: null, cachedAt: NOW, now: NOW }), false);
  });
});

describe('getClerkToken', () => {
  it('forces a refresh instead of returning Clerk\'s near-expiry cached token', async () => {
    const nearExpiry = tokenExpiringAt(Date.now() + 5_000);
    const refreshed = tokenExpiringAt(Date.now() + 60_000);
    const calls: Array<{ template?: string; skipCache?: boolean }> = [];
    const tokens = [nearExpiry, refreshed];
    const session = {
      async getToken(options: { template?: string; skipCache?: boolean } = {}) {
        calls.push(options);
        return tokens.shift() ?? null;
      },
    };
    __setClerkInstanceForTests({ session } as never);

    assert.equal(await getClerkToken(), refreshed);
    assert.deepEqual(calls, [
      { template: 'convex' },
      { template: 'convex', skipCache: true },
    ]);
  });

  it('returns null when a forced refresh still yields a near-expiry token', async () => {
    const session = {
      async getToken() {
        return tokenExpiringAt(Date.now() + 5_000);
      },
    };
    __setClerkInstanceForTests({ session } as never);

    assert.equal(await getClerkToken(), null);
  });
});
