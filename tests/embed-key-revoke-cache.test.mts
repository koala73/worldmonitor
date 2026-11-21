/**
 * Revoking an embed key must stop the edge from authenticating it at once,
 * not after the 60 s `embed-key:<hash>` cache entry ages out. `revokeEmbedKey`
 * schedules `payments/cacheActions.invalidateEmbedKeyCaches`; this runs that
 * action's handler against the same fake Upstash the edge validator reads, so
 * the test proves production code drops the entry production code reads.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { installRedis } from './helpers/fake-upstash-redis.mts';
import { validateEmbedKey } from '../server/_shared/embed-key.ts';
import { invalidateEmbedKeyCaches } from '../convex/payments/cacheActions.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'CONVEX_SITE_URL', 'CONVEX_SERVER_SHARED_SECRET'] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>();

const KEY = `wme_${'a1b2c3d4e5'.repeat(4)}`;
const OTHER_KEY = `wme_${'0f1e2d3c4b'.repeat(4)}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

beforeEach(() => {
  for (const key of ENV_KEYS) ORIGINAL_ENV.set(key, process.env[key]);
  process.env.CONVEX_SITE_URL = 'https://convex.example';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'shared';
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('a revoked embed key stops authenticating as soon as the invalidation runs', async () => {
  const row = { id: 'k1', userId: 'user_partner', name: 'partner-site' };
  const state = installRedis({
    [`embed-key:${sha256(KEY)}`]: row,
    [`embed-key:${sha256(OTHER_KEY)}`]: { ...row, id: 'k2' },
  });
  const redisFetch = state.fetchImpl;
  // Convex already has the row revoked: the only thing still admitting the
  // key is the warm edge cache entry.
  let convexLookups = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://convex.example/')) {
      convexLookups += 1;
      return Response.json(null);
    }
    return redisFetch(input, init);
  }) as typeof fetch;

  assert.equal((await validateEmbedKey(KEY))?.userId, 'user_partner', 'precondition: the warm entry admits the key');

  const action = invalidateEmbedKeyCaches as unknown as {
    _handler: (ctx: unknown, args: { keyHashes: string[] }) => Promise<void>;
  };
  await action._handler({}, { keyHashes: [sha256(KEY)] });

  assert.equal(await validateEmbedKey(KEY), null, 'the revoked key is denied without waiting for the TTL');
  assert.equal(convexLookups, 1, 'the denial came from Convex, not a stale cache');
  assert.equal((await validateEmbedKey(OTHER_KEY))?.userId, 'user_partner', 'other keys keep their cache entries');
});
