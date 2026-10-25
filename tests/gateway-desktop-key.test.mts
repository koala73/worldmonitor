/**
 * Plan 2026-10-25-001 U4 — the gateway admits desktop-key principals.
 *
 * A desktop key is a `wm_` key whose kind is `desktop`; a downgraded owner's
 * `api` key (owner lacks apiAccess but holds Pro) is treated as a desktop
 * principal for the owner's OLDEST active keys up to `maxDesktopKeys` (KTD5).
 * Either gets what a signed-in Pro session gets (KTD4), minus the one named
 * API-only set (KTD7), under one per-owner daily ceiling plus a per-minute
 * burst bucket (KTD6). An `api` key whose owner has apiAccess keeps today's
 * behaviour exactly.
 *
 * Harness: the REAL gateway, validators, entitlement cache and meters, over
 * the fake Upstash Redis plus a stubbed Convex (`fetch`), the same way
 * tests/gateway-pro-fresh-cache.test.mts drives the Pro-fresh contract.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import { TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER } from '../server/_shared/rate-limit.ts';
import { __resetEntitlementNegativeCacheForTests } from '../server/_shared/entitlement-check.ts';
import {
  __clearLocalUnavailableBackoffForTests,
  __resetKeyPrefixCacheForTests,
} from '../server/_shared/redis.ts';
import { secondsUntilUtcMidnight } from '../server/_shared/api-key-rate-limit.ts';
import {
  DESKTOP_KEY_BURST_PER_MINUTE,
  DESKTOP_KEY_DAILY_CEILING,
  getEntitlementFeatures,
} from '../convex/config/productCatalog.ts';
import { installRedis, type FakeRedisState } from './helpers/fake-upstash-redis.mts';
import { API_ONLY_EXACT_PATHS, API_ONLY_PATH_PREFIXES, isApiOnlyPath } from '../server/_shared/api-only-paths.ts';
import { DESKTOP_KEY_LIMIT_ERROR } from '../shared/desktop-key-access.js';
import { invalidateUserApiKeyCaches } from '../convex/payments/cacheActions.ts';
import {
  DESKTOP_KEY_BURST_PER_MINUTE as METER_BURST,
  DESKTOP_KEY_DAILY_CEILING as METER_CEILING,
  desktopKeyDailyKey,
  desktopKeyMinuteKey,
  reserveDesktopKeyBudget,
  resolveDesktopKeyLimits,
} from '../server/_shared/desktop-key-meter.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
  'CONVEX_SITE_URL',
  'CONVEX_SERVER_SHARED_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'VERCEL_ENV',
  'WORLDMONITOR_VALID_KEYS',
  'API_RATE_LIMIT_ENFORCE',
  'DODO_PAYMENTS_ENVIRONMENT',
  'LOCAL_API_MODE',
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>();

// ── Routes ──────────────────────────────────────────────────────────────────
// Pro routes named by AE1, one ungated keyed route for metering, and every
// member of the API-only set routed through this test gateway so a desktop
// principal's denial is proven at the gateway layer even for edges that are
// served elsewhere in production.
const COUNTRY_BRIEF = '/api/intelligence/v1/get-country-intel-brief';
const ROUTE_IMPACT = '/api/supply-chain/v1/get-route-impact';
const SUMMARIZE = '/api/news/v1/summarize-article';
const REGULAR = '/api/news/v1/list-feed-digest';
const API_ONLY_ROUTES: Array<{ method: 'GET' | 'POST'; path: string }> = [
  { method: 'POST', path: '/api/v2/shipping/route-intelligence' },
  { method: 'GET', path: '/api/v2/shipping/webhooks' },
  { method: 'POST', path: '/api/v2/shipping/webhooks' },
  { method: 'POST', path: '/api/mcp' },
  { method: 'GET', path: '/api/oauth/authorize' },
  { method: 'POST', path: '/api/oauth/token' },
  { method: 'POST', path: '/api/oauth/register' },
];

const PAYLOADS: Record<string, unknown> = {
  [COUNTRY_BRIEF]: { brief: { country: 'US', headline: 'Stable', risks: ['none'] } },
  [ROUTE_IMPACT]: { route: 'suez', impact: { delayDays: 3, costDelta: 0.12 } },
  [SUMMARIZE]: { summary: 'Three paragraphs condensed to one sentence.', model: 'test' },
  [REGULAR]: { items: [{ id: 'a' }] },
};

const seenByHandler: Array<{ path: string; principal: string | null; userId: string | null }> = [];
const handler = createDomainGateway([
  ...[COUNTRY_BRIEF, ROUTE_IMPACT, REGULAR].map((path) => ({
    method: 'GET' as const,
    path,
    handler: async (request: Request) => {
      seenByHandler.push({
        path,
        principal: request.headers.get(TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER),
        userId: request.headers.get('x-user-id'),
      });
      return Response.json(PAYLOADS[path]);
    },
  })),
  {
    method: 'POST' as const,
    path: SUMMARIZE,
    handler: async (request: Request) => {
      seenByHandler.push({
        path: SUMMARIZE,
        principal: request.headers.get(TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER),
        userId: request.headers.get('x-user-id'),
      });
      return Response.json(PAYLOADS[SUMMARIZE]);
    },
  },
  ...API_ONLY_ROUTES.map(({ method, path }) => ({
    method,
    path,
    handler: async () => Response.json({ leaked: true }),
  })),
]);

// ── Convex stubs ────────────────────────────────────────────────────────────
type KeyRow = { id: string; userId: string; name: string; keyKind: 'api' | 'desktop'; activeKeyRank?: number; rankUnknown?: true };
type Entitlement = Record<string, unknown> | { __status: number };
const keysByHash = new Map<string, KeyRow | null>();
const entitlementsByUser = new Map<string, Entitlement>();
let redis: FakeRedisState;
let failRedisFor: ((commands: Array<Array<string | number>>) => boolean) | null = null;
let entitlementFetches = 0;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let keySeq = 0;
function mintKey(row: Omit<KeyRow, 'id'> & { id?: string }): string {
  keySeq += 1;
  const key = `wm_${keySeq.toString(16).padStart(40, '0')}`;
  keysByHash.set(sha256(key), { id: row.id ?? `key_${keySeq}`, ...row });
  return key;
}

/**
 * What Convex `validateKeyByHash` answers for `keyHash`: the row with its
 * `activeKeyRank` computed the way `activeKeyRankOf` does — position among
 * the owner's ACTIVE keys of both kinds, oldest (minted) first. A row minted
 * with an explicit rank keeps it (the pre-rank / poisoned-entry scenarios).
 */
function convexValidateAnswer(keyHash: string): KeyRow | null {
  const row = keysByHash.get(keyHash);
  if (!row) return null;
  if (row.rankUnknown) { const { rankUnknown: _omit, ...bare } = row; return bare; }
  if (row.activeKeyRank !== undefined) return row;
  const siblings = [...keysByHash.entries()].filter(([, r]) => r && r.userId === row.userId);
  return { ...row, activeKeyRank: siblings.findIndex(([hash]) => hash === keyHash) };
}

/** Convex-side revocation only: the row is gone, nothing in Redis is touched. */
function revokeRow(key: string): void {
  keysByHash.set(sha256(key), null);
}

/**
 * The production revoke path (plan R5 / KTD5): `convex/apiKeys.ts
 * revokeApiKey` flags the row AND schedules
 * `payments/cacheActions.invalidateUserApiKeyCaches` for the revoked key plus
 * the owner's other active keys, because their `activeKeyRank` just shifted.
 * This runs that action's handler against the same fake Upstash the gateway
 * reads, so the test proves the sibling entry is dropped by production code,
 * not by a hand-written `redis.delete`.
 */
async function revokeThroughProduction(key: string): Promise<void> {
  const hash = sha256(key);
  const row = keysByHash.get(hash);
  assert.ok(row, 'revoking a key that exists');
  revokeRow(key);
  const siblingHashes = [...keysByHash.entries()]
    .filter(([, r]) => r && r.userId === row.userId)
    .map(([h]) => h);
  const action = invalidateUserApiKeyCaches as unknown as {
    _handler: (ctx: unknown, args: { keyHashes: string[] }) => Promise<void>;
  };
  await action._handler({}, { keyHashes: [hash, ...siblingHashes] });
}

function entitlement(planKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planKey,
    validUntil: Date.now() + 86_400_000,
    features: getEntitlementFeatures(planKey),
    ...overrides,
  };
}

function setEntitlement(userId: string, value: Entitlement): void {
  entitlementsByUser.set(userId, value);
  // Both the Redis entitlement cache and the in-process negative cache must
  // forget the previous answer, as a renewal webhook's invalidation would.
  redis.redis.delete(`entitlements:test:${userId}`);
  __resetEntitlementNegativeCacheForTests();
}

function req(path: string, key: string, method: 'GET' | 'POST' = 'GET'): Request {
  const headers: Record<string, string> = { 'X-Api-Key': key };
  const init: RequestInit = { method, headers };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify({ url: 'https://example.com/story', title: 'Story' });
  }
  return new Request(`https://www.worldmonitor.app${path}`, init);
}

const ctx = { waitUntil: () => {} };
const call = (path: string, key: string, method: 'GET' | 'POST' = 'GET') => handler(req(path, key, method), ctx);

function utcDate(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}
const dayKey = (userId: string) => `rl:desktopkey:day:${userId}:${utcDate()}`;
const minuteKey = (userId: string) => `rl:desktopkey:min:${userId}:${Math.floor(Date.now() / 60_000)}`;
const dayCount = (userId: string) => Number(redis.redis.get(dayKey(userId)) ?? 0);

before(() => {
  for (const name of ENV_KEYS) ORIGINAL_ENV.set(name, process.env[name]);
});

beforeEach(() => {
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'desktop-key-shared-secret';
  delete process.env.WORLDMONITOR_VALID_KEYS;
  delete process.env.API_RATE_LIMIT_ENFORCE;
  delete process.env.DODO_PAYMENTS_ENVIRONMENT;
  delete process.env.LOCAL_API_MODE;
  keysByHash.clear();
  entitlementsByUser.clear();
  seenByHandler.length = 0;
  failRedisFor = null;
  entitlementFetches = 0;
  __resetEntitlementNegativeCacheForTests();
  __resetKeyPrefixCacheForTests();
  __clearLocalUnavailableBackoffForTests();
  redis = installRedis({});
  const redisFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/internal-validate-api-key')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { keyHash?: string };
      return Response.json(convexValidateAnswer(body.keyHash ?? ''));
    }
    if (url.endsWith('/api/internal-entitlements')) {
      entitlementFetches += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { userId?: string };
      const value = entitlementsByUser.get(body.userId ?? '') ?? null;
      if (value && '__status' in value) return Response.json({}, { status: value.__status });
      return Response.json(value);
    }
    if (url.startsWith('https://redis.example') && failRedisFor) {
      const commands = JSON.parse(String(init?.body ?? '[]')) as Array<Array<string | number>>;
      const batch = Array.isArray(commands[0]) ? commands : [commands];
      if (failRedisFor(batch)) return new Response('upstream error', { status: 500 });
    }
    return redisFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const name of ENV_KEYS) {
    const value = ORIGINAL_ENV.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __resetKeyPrefixCacheForTests();
  __clearLocalUnavailableBackoffForTests();
});

// ── Scenarios ───────────────────────────────────────────────────────────────

describe('AE1: a desktop key alone gets non-empty Pro data', () => {
  it('AE1: desktop key, no bearer, on get-country-intel-brief, get-route-impact and summarize-article', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });

    for (const [path, method] of [[COUNTRY_BRIEF, 'GET'], [ROUTE_IMPACT, 'GET'], [SUMMARIZE, 'POST']] as const) {
      const res = await call(path, key, method);
      assert.equal(res.status, 200, `${method} ${path}: ${await res.clone().text()}`);
      assert.deepEqual(await res.json(), PAYLOADS[path], `${path} must return the handler payload, not an empty body`);
    }
    assert.equal(seenByHandler.length, 3);
  });

  it('AE1: a lapsed-free owner cannot borrow Pro data with a desktop key (fail closed)', async () => {
    setEntitlement('free_owner', entitlement('free'));
    const key = mintKey({ userId: 'free_owner', name: 'laptop', keyKind: 'desktop' });
    const res = await call(COUNTRY_BRIEF, key);
    assert.equal(res.status, 403);
    assert.equal(seenByHandler.length, 0);
  });
});

describe('AE2: a desktop key never reaches the API-only set', () => {
  it('AE2: every API-only path, including /api/v2/shipping/route-intelligence, is denied for a desktop key', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });

    for (const { method, path } of API_ONLY_ROUTES) {
      const res = await call(path, key, method);
      assert.equal(res.status, 403, `${method} ${path} must be denied for a desktop key`);
      const body = await res.json() as { leaked?: boolean; error?: string };
      assert.notEqual(body.leaked, true, `${path} handler must not run`);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
    }
  });

  it('AE2: an API-plan owner\'s api key still reaches /api/v2 (today\'s behaviour is untouched)', async () => {
    setEntitlement('api_owner', entitlement('api_starter'));
    const key = mintKey({ userId: 'api_owner', name: 'server', keyKind: 'api', activeKeyRank: 0 });
    const res = await call('/api/v2/shipping/route-intelligence', key, 'POST');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { leaked: true });
  });
});

describe('AE4: coverage ends and returns', () => {
  it('AE4: a lapsed Pro owner gets the billing denial a lapsed API key gets; renewal restores the same key', async () => {
    setEntitlement('lapsed_owner', entitlement('pro_monthly', {
      validUntil: Date.now() - 1_000,
      billingStatus: 'subscription_lapsed',
    }));
    const key = mintKey({ userId: 'lapsed_owner', name: 'laptop', keyKind: 'desktop' });

    const denied = await call(COUNTRY_BRIEF, key);
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'Subscription lapsed', code: 'subscription_lapsed' });
    assert.equal(denied.headers.get('X-Billing-Verification'), 'subscription_lapsed');
    assert.equal(denied.headers.get('Cache-Control'), 'no-store');

    setEntitlement('lapsed_owner', entitlement('pro_monthly'));
    const restored = await call(COUNTRY_BRIEF, key);
    assert.equal(restored.status, 200, 'renewal restores the key without a new one');
    assert.deepEqual(await restored.json(), PAYLOADS[COUNTRY_BRIEF]);
  });
});

describe('AE5 / KTD6: one meter per owner per UTC day, plus a burst bucket', () => {
  it('AE5: the account past its daily ceiling gets 429 with Retry-After at the next UTC midnight', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    redis.redis.set(dayKey('pro_owner'), String(DESKTOP_KEY_DAILY_CEILING));

    const res = await call(REGULAR, key);
    assert.equal(res.status, 429);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.limit_type, 'daily');
    assert.equal(body.limit, DESKTOP_KEY_DAILY_CEILING);
    const retryAfter = Number(res.headers.get('Retry-After'));
    const expected = secondsUntilUtcMidnight();
    assert.ok(Math.abs(retryAfter - expected) <= 2, `Retry-After ${retryAfter} must be seconds to UTC midnight (${expected})`);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(dayCount('pro_owner'), DESKTOP_KEY_DAILY_CEILING, 'a rejected request is not charged');
    assert.equal(seenByHandler.length, 0);
  });

  it('AE5: two keys of one owner share the counter', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const first = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    const second = mintKey({ userId: 'pro_owner', name: 'desk', keyKind: 'desktop' });

    assert.equal((await call(REGULAR, first)).status, 200);
    assert.equal((await call(REGULAR, second)).status, 200);
    assert.equal((await call(REGULAR, first)).status, 200);
    assert.equal(dayCount('pro_owner'), 3);
  });

  it('AE5: revoking and recreating a key does not reset the counter', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const first = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    assert.equal((await call(REGULAR, first)).status, 200);
    assert.equal((await call(REGULAR, first)).status, 200);

    await revokeThroughProduction(first);
    assert.equal((await call(REGULAR, first)).status, 401, 'a revoked key is rejected');

    const recreated = mintKey({ userId: 'pro_owner', name: 'laptop-2', keyKind: 'desktop' });
    assert.equal((await call(REGULAR, recreated)).status, 200);
    assert.equal(dayCount('pro_owner'), 3, 'the owner counter continues across revoke-and-recreate');
  });

  it('the burst bucket rejects the request over the per-minute limit', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    redis.redis.set(minuteKey('pro_owner'), String(DESKTOP_KEY_BURST_PER_MINUTE));

    const res = await call(REGULAR, key);
    assert.equal(res.status, 429);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.limit_type, 'per_minute');
    assert.equal(body.limit, DESKTOP_KEY_BURST_PER_MINUTE);
    const retryAfter = Number(res.headers.get('Retry-After'));
    assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter} must be within the minute window`);
    assert.equal(dayCount('pro_owner'), 0, 'a burst rejection does not consume the daily allowance');
    assert.equal(seenByHandler.length, 0);
  });

  it('a Redis counter error returns the rate-limit-degraded 503 with Retry-After', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    failRedisFor = (commands) => commands.some((command) => String(command[1] ?? '').startsWith('rl:desktopkey:'));

    const res = await call(REGULAR, key);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.equal(res.headers.get('Retry-After'), '5');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await res.json(), { error: 'Rate-limit service temporarily unavailable' });
    assert.equal(seenByHandler.length, 0);
  });

  it('an API-plan owner\'s desktop key (AE7) falls back to the catalog ceiling when its plan sells none', async () => {
    setEntitlement('api_owner', entitlement('api_starter'));
    const key = mintKey({ userId: 'api_owner', name: 'laptop', keyKind: 'desktop' });
    redis.redis.set(dayKey('api_owner'), String(DESKTOP_KEY_DAILY_CEILING));
    const res = await call(REGULAR, key);
    assert.equal(res.status, 429);
    assert.equal(((await res.json()) as Record<string, unknown>).limit, DESKTOP_KEY_DAILY_CEILING);
  });
});

describe('AE6: a downgraded API customer keeps their oldest keys at desktop scope', () => {
  it('AE6: two oldest keys get Pro data, the third is denied until one is revoked, and all lose REST v2', async () => {
    setEntitlement('downgraded', entitlement('pro_monthly'));
    const keys = [0, 1, 2].map((rank) => mintKey({ userId: 'downgraded', name: `server-${rank}`, keyKind: 'api' }));

    for (const key of keys.slice(0, 2)) {
      const res = await call(COUNTRY_BRIEF, key);
      assert.equal(res.status, 200, 'oldest keys within maxDesktopKeys keep Pro dashboard data');
      assert.deepEqual(await res.json(), PAYLOADS[COUNTRY_BRIEF]);
    }
    const third = await call(COUNTRY_BRIEF, keys[2]!);
    assert.equal(third.status, 403, 'the key beyond the cap is denied, not revoked');
    assert.match(((await third.json()) as { error: string }).error, /desktop key limit/i);

    for (const key of keys) {
      for (const { method, path } of API_ONLY_ROUTES.filter((route) => route.path.startsWith('/api/v2/'))) {
        const res = await call(path, key, method);
        assert.equal(res.status, 403, `${path} must refuse a downgraded owner's key`);
      }
    }

    // Revoke the oldest through the production path. The third key's entry is
    // WARM with rank 2 from the denial above; only the sibling invalidation the
    // revoke schedules lets Convex re-rank it within the cap before its TTL.
    assert.ok(redis.redis.has(`user-api-key:${sha256(keys[2]!)}`), 'the third key entry is warm before the revoke');
    await revokeThroughProduction(keys[0]!);
    assert.equal(redis.redis.has(`user-api-key:${sha256(keys[2]!)}`), false, 'revocation drops the sibling entry');
    const promoted = await call(COUNTRY_BRIEF, keys[2]!);
    assert.equal(promoted.status, 200, 'after a revocation the next-oldest key qualifies');
  });

  it('AE6: without the sibling invalidation a warm over-cap entry would outlive the revoke (the gap the production path closes)', async () => {
    setEntitlement('downgraded', entitlement('pro_monthly'));
    const keys = [0, 1, 2].map((rank) => mintKey({ userId: 'downgraded', name: `server-${rank}`, keyKind: 'api' }));
    assert.equal((await call(COUNTRY_BRIEF, keys[2]!)).status, 403);
    revokeRow(keys[0]!); // Convex-side only: no cache invalidation
    assert.equal((await call(COUNTRY_BRIEF, keys[2]!)).status, 403, 'the warm rank-2 entry still denies');
  });

  it('AE6: a downgraded key whose rank is unknown (pre-rank cache entry) fails closed', async () => {
    setEntitlement('downgraded', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'downgraded', name: 'server', keyKind: 'api', rankUnknown: true });
    const res = await call(COUNTRY_BRIEF, key);
    assert.equal(res.status, 403);
  });

  it('AE6: a downgraded owner\'s desktop principal is charged to the desktop meter, not the #3199 meter', async () => {
    process.env.API_RATE_LIMIT_ENFORCE = 'true';
    setEntitlement('downgraded', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'downgraded', name: 'server', keyKind: 'api', activeKeyRank: 0 });
    assert.equal((await call(REGULAR, key)).status, 200);
    assert.equal(dayCount('downgraded'), 1);
    assert.equal([...redis.redis.keys()].some((k) => k.startsWith('rl:apikey:')), false);
  });
});

describe('AE7: a Pro owner upgrades to an API plan', () => {
  it('AE7: the desktop key keeps Pro access and still cannot reach REST v2', async () => {
    setEntitlement('upgraded', entitlement('api_starter'));
    const desktop = mintKey({ userId: 'upgraded', name: 'laptop', keyKind: 'desktop' });

    const pro = await call(COUNTRY_BRIEF, desktop);
    assert.equal(pro.status, 200);
    assert.deepEqual(await pro.json(), PAYLOADS[COUNTRY_BRIEF]);

    const v2 = await call('/api/v2/shipping/route-intelligence', desktop, 'POST');
    assert.equal(v2.status, 403);
  });
});

describe('metering attribution', () => {
  it('a desktop principal is not charged to the #3199 meter and is attributed to the owner', async () => {
    process.env.API_RATE_LIMIT_ENFORCE = 'true';
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });

    const res = await call(REGULAR, key);
    assert.equal(res.status, 200);
    assert.equal(dayCount('pro_owner'), 1, 'the desktop meter is charged once');
    assert.equal([...redis.redis.keys()].some((k) => k.startsWith('rl:apikey:')), false, '#3199 keys untouched');
    assert.equal(seenByHandler.length, 1);
    assert.equal(seenByHandler[0]!.userId, 'pro_owner');
    assert.equal(seenByHandler[0]!.principal, 'api_key:pro_owner', 'rate-limit principal is the owner');
  });

  it('an API-plan owner\'s api key keeps today\'s #3199 metering and never touches the desktop meter', async () => {
    process.env.API_RATE_LIMIT_ENFORCE = 'true';
    setEntitlement('api_owner', entitlement('api_starter'));
    const key = mintKey({ userId: 'api_owner', name: 'server', keyKind: 'api', activeKeyRank: 0 });

    const res = await call(REGULAR, key);
    assert.equal(res.status, 200);
    assert.equal(dayCount('api_owner'), 0);
    assert.equal([...redis.redis.keys()].some((k) => k.startsWith('rl:apikey:day:api_owner')), true);
  });
});

describe('entitlement outage', () => {
  it('an entitlement lookup outage returns the retryable 503 for a desktop key', async () => {
    setEntitlement('pro_owner', { __status: 503 });
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });

    const res = await call(COUNTRY_BRIEF, key);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Retry-After'), '5');
    assert.equal(res.headers.get('X-Billing-Verification'), 'entitlement_verification_unavailable');
    assert.equal(((await res.json()) as { code?: string }).code, 'entitlement_verification_unavailable');
    assert.equal(seenByHandler.length, 0);
  });
});

describe('KTD7: the API-only set is named once and pinned', () => {
  it('holds exactly the /api/v2/ prefix plus the MCP and OAuth edges', () => {
    assert.deepEqual([...API_ONLY_PATH_PREFIXES], ['/api/v2/']);
    assert.deepEqual([...API_ONLY_EXACT_PATHS].sort(), [
      '/.well-known/mcp',
      '/.well-known/mcp.json',
      '/api/mcp',
      '/api/oauth/authorize',
      '/api/oauth/authorize-pro',
      '/api/oauth/register',
      '/api/oauth/token',
      '/mcp',
      '/oauth/authorize',
      '/oauth/authorize-pro',
      '/oauth/register',
      '/oauth/token',
    ]);
    for (const { path } of API_ONLY_ROUTES) assert.equal(isApiOnlyPath(path), true, path);
    assert.equal(isApiOnlyPath('/api/v2/anything/new'), true);
    assert.equal(isApiOnlyPath('/api/v2'), true);
    assert.equal(isApiOnlyPath('/api/mcp/'), true);
    for (const path of [COUNTRY_BRIEF, ROUTE_IMPACT, SUMMARIZE, REGULAR, '/api/mcp-proxy', '/api/chat-analyst', '/api/bootstrap', '/api/v1/x', '/api/v20/x']) {
      assert.equal(isApiOnlyPath(path), false, path);
    }
  });
});

describe('KTD6: the meter module', () => {
  it('duplicates the catalog ceilings exactly (bootstrap cannot import the catalog)', () => {
    assert.equal(METER_CEILING, DESKTOP_KEY_DAILY_CEILING);
    assert.equal(METER_BURST, DESKTOP_KEY_BURST_PER_MINUTE);
  });

  it('resolves the plan limits, falling back to the catalog ceiling for plans that sell none', () => {
    assert.deepEqual(resolveDesktopKeyLimits(entitlement('pro_monthly') as never), { dailyLimit: DESKTOP_KEY_DAILY_CEILING, burstPerMinute: DESKTOP_KEY_BURST_PER_MINUTE });
    assert.deepEqual(resolveDesktopKeyLimits(entitlement('api_starter') as never), { dailyLimit: DESKTOP_KEY_DAILY_CEILING, burstPerMinute: DESKTOP_KEY_BURST_PER_MINUTE });
    assert.deepEqual(resolveDesktopKeyLimits({ features: { planLimits: { desktopKeyRequestsPerDay: 10, desktopKeyBurstPerMinute: 3 } } }), { dailyLimit: 10, burstPerMinute: 3 });
    assert.deepEqual(resolveDesktopKeyLimits(null), { dailyLimit: DESKTOP_KEY_DAILY_CEILING, burstPerMinute: DESKTOP_KEY_BURST_PER_MINUTE });
    assert.deepEqual(resolveDesktopKeyLimits({ features: { planLimits: { desktopKeyRequestsPerDay: -1, desktopKeyBurstPerMinute: 2.5 } } }), { dailyLimit: DESKTOP_KEY_DAILY_CEILING, burstPerMinute: DESKTOP_KEY_BURST_PER_MINUTE });
  });

  it('keys the counters on the owner, the UTC date and the epoch minute', () => {
    const at = new Date(Date.UTC(2026, 9, 25, 23, 59, 30));
    assert.equal(desktopKeyDailyKey('u1', at), 'rl:desktopkey:day:u1:2026-10-25');
    assert.equal(desktopKeyMinuteKey('u1', at), `rl:desktopkey:min:u1:${Math.floor(at.getTime() / 60_000)}`);
  });

  it('INCRs both counters in one pipeline, rolls back on rejection, and fails closed on a bad pipeline', async () => {
    const seen: Array<Array<Array<string | number>>> = [];
    const counts = { day: 7_499, minute: 119 };
    const pipeline = async (commands: Array<Array<string | number>>) => {
      seen.push(commands);
      return commands.map(([verb, key]) => {
        const which = String(key).includes(':day:') ? 'day' : 'minute';
        if (verb === 'INCR') return { result: ++counts[which] };
        if (verb === 'DECR') return { result: --counts[which] };
        return { result: 1 };
      });
    };
    const at = new Date(Date.UTC(2026, 9, 25, 23, 59, 30));
    const admitted = await reserveDesktopKeyBudget({ userId: 'u1', dailyLimit: 7_500, burstPerMinute: 120, pipeline, date: at });
    assert.equal(admitted.ok, true);
    assert.deepEqual(seen[0]!.map((c) => c[0]), ['INCR', 'EXPIRE', 'INCR', 'EXPIRE']);
    assert.deepEqual(seen[0]!.map((c) => c[2]).filter(Boolean), [172_800, 120]);

    const daily = await reserveDesktopKeyBudget({ userId: 'u1', dailyLimit: 7_500, burstPerMinute: 120, pipeline, date: at });
    assert.equal(daily.ok, false);
    assert.equal(daily.ok === false && daily.limitType, 'daily');
    assert.equal(daily.ok === false && daily.retryAfterSec, 30, 'seconds to UTC midnight');
    assert.deepEqual(counts, { day: 7_500, minute: 120 }, 'a daily rejection rolls both counters back');

    counts.day = 0;
    const burst = await reserveDesktopKeyBudget({ userId: 'u1', dailyLimit: 7_500, burstPerMinute: 120, pipeline, date: at });
    assert.equal(burst.ok === false && burst.limitType, 'per_minute');
    assert.equal(burst.ok === false && burst.retryAfterSec, 30, 'seconds to the next minute boundary');
    assert.deepEqual(counts, { day: 0, minute: 120 });

    // Admitted, then rolled back by a later limiter: idempotent.
    counts.minute = 0;
    const ok = await reserveDesktopKeyBudget({ userId: 'u1', dailyLimit: 7_500, burstPerMinute: 120, pipeline, date: at });
    assert.equal(ok.ok, true);
    if (ok.ok) { await ok.rollback(); await ok.rollback(); }
    assert.deepEqual(counts, { day: 0, minute: 0 });

    for (const bad of [async () => [], async () => null, async () => { throw new Error('boom'); }, async () => [{ result: 'x' }, {}, {}, {}]]) {
      const result = await reserveDesktopKeyBudget({ userId: 'u1', dailyLimit: 1, burstPerMinute: 1, pipeline: bad as never, date: at });
      assert.deepEqual(result, { ok: null, reason: 'unavailable' });
    }
  });
});

describe('R5: the cap applies to desktop-kind keys too (a Pro Business owner who drops to Pro)', () => {
  it('three desktop keys under a Pro cap of 2: ranks 0 and 1 are admitted, rank 2 gets the one-sentence 403', async () => {
    setEntitlement('shrunk', entitlement('pro_monthly'));
    const keys = [0, 1, 2].map((n) => mintKey({ userId: 'shrunk', name: `desk-${n}`, keyKind: 'desktop' }));
    assert.equal(getEntitlementFeatures('pro_monthly').maxDesktopKeys, 2);

    for (const key of keys.slice(0, 2)) {
      const res = await call(COUNTRY_BRIEF, key);
      assert.equal(res.status, 200, 'the two oldest desktop keys keep Pro data');
    }
    const third = await call(COUNTRY_BRIEF, keys[2]!);
    assert.equal(third.status, 403, 'the third desktop key is denied, not revoked');
    assert.deepEqual(await third.json(), { error: DESKTOP_KEY_LIMIT_ERROR });
    assert.equal(third.headers.get('Cache-Control'), 'no-store');
    assert.equal(seenByHandler.length, 2);
  });

  it('an API-plan owner\'s desktop keys are admitted regardless of rank (API plans sell 0 desktop slots; R8/AE7)', async () => {
    setEntitlement('api_owner', entitlement('api_starter'));
    const keys = [0, 1, 2].map((n) => mintKey({ userId: 'api_owner', name: `desk-${n}`, keyKind: 'desktop' }));
    for (const key of keys) assert.equal((await call(COUNTRY_BRIEF, key)).status, 200);
  });

  it('a desktop key whose rank is unknown fails closed with the Pro-required 403', async () => {
    setEntitlement('shrunk', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'shrunk', name: 'desk', keyKind: 'desktop', rankUnknown: true });
    const res = await call(COUNTRY_BRIEF, key);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'Pro subscription required' });
  });
});

describe('warm entitlement entries written before the deploy (no desktopKeyAccess field)', () => {
  /** A Pro entry as the pre-deploy edge cached it: current shape minus the desktop fields. */
  function legacyEntry(planKey: string): Record<string, unknown> {
    const { desktopKeyAccess: _a, maxDesktopKeys: _b, planLimits, ...features } = getEntitlementFeatures(planKey) as Record<string, unknown> & { planLimits: Record<string, unknown> };
    const { desktopKeyRequestsPerDay: _c, desktopKeyBurstPerMinute: _d, ...legacyLimits } = planLimits;
    return { planKey, validUntil: Date.now() + 86_400_000, features: { ...features, planLimits: legacyLimits } };
  }

  it('a desktop key of a Pro owner with a warm legacy entry is admitted after one Convex refetch', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    redis.redis.set('entitlements:test:pro_owner', JSON.stringify(legacyEntry('pro_monthly')));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });

    const res = await call(COUNTRY_BRIEF, key);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(entitlementFetches, 1, 'the legacy entry is a miss for the desktop decision');
    const rewritten = JSON.parse(redis.redis.get('entitlements:test:pro_owner') ?? 'null') as { features?: { desktopKeyAccess?: boolean } };
    assert.equal(rewritten.features?.desktopKeyAccess, true, 'the refetch rewrites the entry in the merged shape');
    assert.equal((await call(COUNTRY_BRIEF, key)).status, 200);
    assert.equal(entitlementFetches, 1, 'the rewritten entry is served from cache');
  });

  it('an API-plan owner\'s api key keeps the api-access decision from the legacy entry with no refetch', async () => {
    setEntitlement('api_owner', entitlement('api_starter'));
    redis.redis.set('entitlements:test:api_owner', JSON.stringify(legacyEntry('api_starter')));
    const key = mintKey({ userId: 'api_owner', name: 'server', keyKind: 'api' });

    assert.equal((await call('/api/v2/shipping/route-intelligence', key, 'POST')).status, 200);
    assert.equal(entitlementFetches, 0, 'the api-access decision does not refetch');
  });

  it('a downgraded owner\'s api key with a warm legacy entry is re-read through Convex', async () => {
    setEntitlement('downgraded', entitlement('pro_monthly'));
    redis.redis.set('entitlements:test:downgraded', JSON.stringify(legacyEntry('pro_monthly')));
    const key = mintKey({ userId: 'downgraded', name: 'server', keyKind: 'api' });

    assert.equal((await call(COUNTRY_BRIEF, key)).status, 200);
    assert.equal(entitlementFetches, 1);
  });

  it('a Convex row that still lacks the field (backend predating the catalog change) stays denied', async () => {
    setEntitlement('pro_owner', legacyEntry('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    assert.equal((await call(COUNTRY_BRIEF, key)).status, 403, 'fail closed: nothing widens on an unmerged row');
  });
});

describe('KTD7 hardening: duplicate slashes cannot escape the API-only prefix', () => {
  it('collapses // before the prefix check', () => {
    assert.equal(isApiOnlyPath('//api/v2/shipping/route-intelligence'), true);
    assert.equal(isApiOnlyPath('/api//v2/shipping/route-intelligence'), true);
    assert.equal(isApiOnlyPath('/api/v2//shipping'), true);
    assert.equal(isApiOnlyPath('//api//mcp'), true);
    assert.equal(isApiOnlyPath('//api/v1/x'), false);
  });

  it('a desktop key on //api/v2/... is denied at the gateway', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    const res = await handler(new Request('https://www.worldmonitor.app//api/v2/shipping/route-intelligence', {
      method: 'POST',
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
      body: '{}',
    }), ctx);
    assert.equal(res.status, 403);
    const body = await res.json() as { leaked?: boolean };
    assert.notEqual(body.leaked, true, 'handler must not run');
  });
});

describe('KTD6 hardening: an errored EXPIRE in the meter pipeline fails closed', () => {
  it('reserveDesktopKeyBudget reports unavailable when any pipeline entry carries an error', async () => {
    const at = new Date(Date.UTC(2026, 9, 25, 12, 0, 0));
    for (const bad of [
      async () => [{ result: 1 }, { error: 'ERR wrong type' }, { result: 1 }, { result: 1 }],
      async () => [{ result: 1 }, { result: 1 }, { result: 1 }, { error: 'OOM' }],
      async () => [{ result: 1 }, { result: 1 }, { error: 'ERR' }, { result: 1 }],
    ]) {
      const result = await reserveDesktopKeyBudget({ userId: 'u1', dailyLimit: 10, burstPerMinute: 10, pipeline: bad as never, date: at });
      assert.deepEqual(result, { ok: null, reason: 'unavailable' });
    }
  });
});
