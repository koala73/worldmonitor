/**
 * Plan 2026-11-04-001 U2 — GET /api/desktop-key/status, the cloud verdict a
 * self-hosted sidecar asks before it unlocks Pro for a browser's desktop key.
 *
 * Harness: the REAL route, validators and entitlement cache over the fake
 * Upstash Redis plus a stubbed Convex (`fetch`), the same way
 * tests/gateway-desktop-key.test.mts drives the gateway's desktop arm, so the
 * verdict here and the gateway's admission are computed by the same code. Only
 * the scoped limiter is swapped for a counting fake: the fake Redis answers
 * every rate-limit script with "allowed", so it cannot prove a 429.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import handler, {
  DESKTOP_KEY_STATUS_IP_CEILING,
  DESKTOP_KEY_STATUS_IP_INVALID_LIMIT,
  DESKTOP_KEY_STATUS_OWNER_LIMIT,
  __setDesktopKeyStatusDepsForTests,
} from '../api/desktop-key/status.ts';
import { __resetEntitlementNegativeCacheForTests } from '../server/_shared/entitlement-check.ts';
import {
  __clearLocalUnavailableBackoffForTests,
  __resetKeyPrefixCacheForTests,
} from '../server/_shared/redis.ts';
import { getEntitlementFeatures } from '../convex/config/productCatalog.ts';
import { installRedis, type FakeRedisState } from './helpers/fake-upstash-redis.mts';

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
  'CONVEX_SITE_URL',
  'CONVEX_SERVER_SHARED_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'VERCEL_ENV',
  'WORLDMONITOR_VALID_KEYS',
  'CF_EDGE_PROOF_SECRET',
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>();
const URL_PATH = 'https://api.worldmonitor.app/api/desktop-key/status';

// ── Convex stubs ────────────────────────────────────────────────────────────
type KeyRow = { id: string; userId: string; name: string; keyKind: 'api' | 'desktop'; activeKeyRank?: number; rankUnknown?: true };
type Entitlement = Record<string, unknown> | { __status: number };
const keysByHash = new Map<string, KeyRow | null>();
const entitlementsByUser = new Map<string, Entitlement>();
let redis: FakeRedisState;
let convexCalls = 0;
let validateStatus = 200;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let keySeq = 0;
function mintKey(row: Omit<KeyRow, 'id'>): string {
  keySeq += 1;
  const key = `wm_${keySeq.toString(16).padStart(40, '0')}`;
  keysByHash.set(sha256(key), { id: `key_${keySeq}`, ...row });
  return key;
}

/** Convex `validateKeyByHash`: rank = position among the owner's active keys, oldest first. */
function convexValidateAnswer(keyHash: string): KeyRow | null {
  const row = keysByHash.get(keyHash);
  if (!row) return null;
  if (row.rankUnknown) { const { rankUnknown: _omit, ...bare } = row; return bare; }
  if (row.activeKeyRank !== undefined) return row;
  const siblings = [...keysByHash.entries()].filter(([, r]) => r && r.userId === row.userId);
  return { ...row, activeKeyRank: siblings.findIndex(([hash]) => hash === keyHash) };
}

function entitlement(planKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { planKey, validUntil: Date.now() + 86_400_000, features: getEntitlementFeatures(planKey), ...overrides };
}

function setEntitlement(userId: string, value: Entitlement): void {
  entitlementsByUser.set(userId, value);
  redis.redis.delete(`entitlements:test:${userId}`);
  __resetEntitlementNegativeCacheForTests();
}

// ── Counting limiter (signature of checkScopedRateLimit) ────────────────────
const limiterCounts = new Map<string, number>();
const limiterCalls: Array<{ scope: string; identifier: string }> = [];
async function countingLimiter(scope: string, limit: number, _window: string, identifier: string) {
  limiterCalls.push({ scope, identifier });
  const bucket = `${scope}:${identifier}`;
  const count = (limiterCounts.get(bucket) ?? 0) + 1;
  limiterCounts.set(bucket, count);
  return { allowed: count <= limit, limit, reset: Date.now() + 60_000, degraded: false };
}

function req(key: string | null, ip = '203.0.113.7', method = 'GET'): Request {
  const headers: Record<string, string> = { 'x-real-ip': ip, 'User-Agent': 'WorldMonitor-SelfHost/test (relay)' };
  if (key !== null) headers['X-WorldMonitor-Key'] = key;
  return new Request(URL_PATH, { method, headers });
}

async function verdictOf(res: Response): Promise<string | undefined> {
  const body = await res.clone().json() as { verdict?: string };
  return body.verdict;
}

const meterKeys = () => [...redis.redis.keys()].filter((k) => k.includes('desktopkey'));

before(() => {
  for (const name of ENV_KEYS) ORIGINAL_ENV.set(name, process.env[name]);
});

beforeEach(() => {
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'desktop-key-status-secret';
  delete process.env.WORLDMONITOR_VALID_KEYS;
  keysByHash.clear();
  entitlementsByUser.clear();
  limiterCounts.clear();
  limiterCalls.length = 0;
  convexCalls = 0;
  validateStatus = 200;
  __resetEntitlementNegativeCacheForTests();
  __resetKeyPrefixCacheForTests();
  __clearLocalUnavailableBackoffForTests();
  __setDesktopKeyStatusDepsForTests({ checkScopedRateLimit: countingLimiter });
  redis = installRedis({});
  const redisFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/internal-validate-api-key')) {
      convexCalls += 1;
      if (validateStatus !== 200) return Response.json({}, { status: validateStatus });
      const body = JSON.parse(String(init?.body ?? '{}')) as { keyHash?: string };
      return Response.json(convexValidateAnswer(body.keyHash ?? ''));
    }
    if (url.endsWith('/api/internal-entitlements')) {
      convexCalls += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { userId?: string };
      const value = entitlementsByUser.get(body.userId ?? '') ?? null;
      if (value && '__status' in value) return Response.json({}, { status: value.__status });
      return Response.json(value);
    }
    return redisFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  __setDesktopKeyStatusDepsForTests(null);
  globalThis.fetch = ORIGINAL_FETCH;
  for (const name of ENV_KEYS) {
    const value = ORIGINAL_ENV.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __resetKeyPrefixCacheForTests();
  __clearLocalUnavailableBackoffForTests();
});

function assertVerdictResponse(res: Response, verdict: string): void {
  assert.equal(res.status, 200, `verdict ${verdict} is a 200`);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Content-Type'), 'application/json');
}

async function assertNoIdentity(res: Response): Promise<void> {
  const body = await res.clone().json() as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    assert.ok(['verdict', 'planFamily'].includes(key), `body must carry only the verdict and plan family, saw ${key}`);
  }
}

// ── Scenarios ───────────────────────────────────────────────────────────────

describe('desktop-key status: verdicts', () => {
  it('an active Pro owner\'s desktop key returns active with the plan family and no identity', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    const res = await handler(req(key));
    assertVerdictResponse(res, 'active');
    assert.deepEqual(await res.json(), { verdict: 'active', planFamily: 'pro' });
  });

  it('a revoked key and an unknown key both return invalid', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const revoked = mintKey({ userId: 'pro_owner', name: 'old', keyKind: 'desktop' });
    keysByHash.set(sha256(revoked), null);
    const unknown = `wm_${'f'.repeat(40)}`;
    for (const key of [revoked, unknown]) {
      const res = await handler(req(key));
      assertVerdictResponse(res, 'invalid');
      assert.deepEqual(await res.json(), { verdict: 'invalid' });
    }
  });

  it('a key beyond the owner\'s maxDesktopKeys rank returns over_cap', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly')); // Pro: 2 desktop slots
    mintKey({ userId: 'pro_owner', name: 'one', keyKind: 'desktop' });
    mintKey({ userId: 'pro_owner', name: 'two', keyKind: 'desktop' });
    const third = mintKey({ userId: 'pro_owner', name: 'three', keyKind: 'desktop' });
    const res = await handler(req(third));
    assertVerdictResponse(res, 'over_cap');
    assert.deepEqual(await res.json(), { verdict: 'over_cap' });
  });

  it('an owner whose validUntil has passed returns lapsed (expired row and provider-confirmed lapse)', async () => {
    setEntitlement('expired_owner', entitlement('pro_monthly', { validUntil: Date.now() - 1_000 }));
    const expiredKey = mintKey({ userId: 'expired_owner', name: 'laptop', keyKind: 'desktop' });
    const expired = await handler(req(expiredKey));
    assertVerdictResponse(expired, 'lapsed');
    assert.deepEqual(await expired.json(), { verdict: 'lapsed' });

    setEntitlement('lapsed_owner', entitlement('pro_monthly', {
      validUntil: Date.now() - 1_000,
      billingStatus: 'subscription_lapsed',
    }));
    const lapsedKey = mintKey({ userId: 'lapsed_owner', name: 'laptop', keyKind: 'desktop' });
    const lapsed = await handler(req(lapsedKey));
    assertVerdictResponse(lapsed, 'lapsed');
    assert.deepEqual(await lapsed.json(), { verdict: 'lapsed' });
  });

  it('a free owner\'s desktop key returns lapsed, never active', async () => {
    setEntitlement('free_owner', entitlement('free'));
    const key = mintKey({ userId: 'free_owner', name: 'laptop', keyKind: 'desktop' });
    assert.equal(await verdictOf(await handler(req(key))), 'lapsed');
  });

  it('a desktop-kind key whose owner moved to an API plan returns active (desktop-key plan KTD4 upgrade case)', async () => {
    setEntitlement('api_owner', entitlement('api_starter'));
    const key = mintKey({ userId: 'api_owner', name: 'laptop', keyKind: 'desktop' });
    const res = await handler(req(key));
    assertVerdictResponse(res, 'active');
    assert.deepEqual(await res.json(), { verdict: 'active', planFamily: 'api' });
  });

  it('an API-kind key returns not_desktop_key, whatever the owner\'s plan', async () => {
    setEntitlement('api_owner', entitlement('api_starter'));
    const apiKey = mintKey({ userId: 'api_owner', name: 'server', keyKind: 'api', activeKeyRank: 0 });
    const res = await handler(req(apiKey));
    assertVerdictResponse(res, 'not_desktop_key');
    assert.deepEqual(await res.json(), { verdict: 'not_desktop_key' });

    // A downgraded API customer's api key would pass the gateway as a desktop
    // principal, but R6 unlocks only desktop-kind keys.
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const downgraded = mintKey({ userId: 'pro_owner', name: 'server', keyKind: 'api' });
    assert.equal(await verdictOf(await handler(req(downgraded))), 'not_desktop_key');
  });
});

describe('desktop-key status: unavailable is never a verdict', () => {
  async function assertUnavailable(res: Response, label: string): Promise<void> {
    assert.equal(res.status, 503, `${label}: ${await res.clone().text()}`);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const retryAfter = Number(res.headers.get('Retry-After'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `${label}: Retry-After must be a positive integer`);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.verdict, undefined, `${label}: a 503 carries no verdict`);
    assert.equal(body.error, 'unavailable');
  }

  it('a rank_unknown scope returns 503', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop', rankUnknown: true });
    await assertUnavailable(await handler(req(key)), 'rank_unknown');
  });

  it('a null entitlement returns 503', async () => {
    const key = mintKey({ userId: 'ghost_owner', name: 'laptop', keyKind: 'desktop' });
    await assertUnavailable(await handler(req(key)), 'null entitlement');
  });

  it('a pending billing verification returns 503', async () => {
    setEntitlement('pending_owner', entitlement('pro_monthly', {
      validUntil: Date.now() - 1_000,
      billingStatus: 'renewal_verification_pending',
      retryAfterSeconds: 30,
    }));
    const key = mintKey({ userId: 'pending_owner', name: 'laptop', keyKind: 'desktop' });
    const res = await handler(req(key));
    await assertUnavailable(res, 'pending verification');
  });

  it('an entitlement backend failure returns 503 with Retry-After, not invalid', async () => {
    setEntitlement('pro_owner', { __status: 500 });
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    await assertUnavailable(await handler(req(key)), 'entitlement 500');
  });

  it('a key-validation outage (UserApiKeyUnavailableError) returns 503, not invalid', async () => {
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    validateStatus = 500;
    await assertUnavailable(await handler(req(key)), 'validate 500');
  });
});

describe('desktop-key status: header handling', () => {
  it('a missing header returns invalid without a Convex call', async () => {
    const res = await handler(req(null));
    assertVerdictResponse(res, 'invalid');
    assert.deepEqual(await res.json(), { verdict: 'invalid' });
    assert.equal(convexCalls, 0);
  });

  it('a malformed key returns invalid without a Convex call', async () => {
    for (const key of ['wm_x', 'not-a-key', `wm_${'A'.repeat(40)}`, ' ']) {
      const res = await handler(req(key));
      assert.equal(await verdictOf(res), 'invalid', `malformed ${JSON.stringify(key)}`);
    }
    assert.equal(convexCalls, 0);
  });

  it('an operator key is not a desktop key and is never echoed as active', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'operator-secret-key';
    const res = await handler(req('operator-secret-key'));
    assert.equal(await verdictOf(res), 'invalid');
  });

  it('OPTIONS answers 204; other methods answer 405 no-store', async () => {
    const preflight = await handler(req(null, '203.0.113.7', 'OPTIONS'));
    assert.equal(preflight.status, 204);
    const post = await handler(req(null, '203.0.113.7', 'POST'));
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('Cache-Control'), 'no-store');
  });

  it('no request reaches the response body with the owner id or key id', async () => {
    setEntitlement('pro_owner_identity', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner_identity', name: 'laptop', keyKind: 'desktop' });
    const res = await handler(req(key));
    assert.equal(await verdictOf(res), 'active');
    await assertNoIdentity(res);
    const text = await res.text();
    assert.ok(!text.includes('pro_owner_identity'));
    assert.ok(!text.includes('key_'));
  });
});

describe('desktop-key status: rate limits and metering', () => {
  it('calls past the per-owner limit return 429 and never touch the daily desktop meter', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    for (let i = 0; i < DESKTOP_KEY_STATUS_OWNER_LIMIT.limit; i += 1) {
      const ok = await handler(req(key));
      assert.equal(await verdictOf(ok), 'active', `call ${i + 1} within the owner limit`);
    }
    const limited = await handler(req(key));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('Cache-Control'), 'no-store');
    assert.ok(Number(limited.headers.get('Retry-After')) >= 0);
    assert.deepEqual(await limited.json(), { error: 'rate_limited' });

    // The owner bucket is keyed by owner, not by key or IP.
    assert.ok(limiterCalls.some((c) => c.identifier === 'pro_owner'));
    assert.deepEqual(meterKeys(), [], 'status checks must not write the desktop-key daily/minute meter');
  });

  it('another key of the same owner shares the owner bucket', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const first = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    const second = mintKey({ userId: 'pro_owner', name: 'desktop', keyKind: 'desktop' });
    for (let i = 0; i < DESKTOP_KEY_STATUS_OWNER_LIMIT.limit; i += 1) await handler(req(first, `198.51.100.${i % 200}`));
    assert.equal((await handler(req(second, '192.0.2.1'))).status, 429);
  });

  it('many distinct valid owners from one IP are not throttled', async () => {
    const owners = DESKTOP_KEY_STATUS_IP_INVALID_LIMIT.limit * 3;
    for (let i = 0; i < owners; i += 1) {
      const userId = `owner_${i}`;
      setEntitlement(userId, entitlement('pro_monthly'));
      const key = mintKey({ userId, name: 'laptop', keyKind: 'desktop' });
      const res = await handler(req(key, '203.0.113.50'));
      assert.equal(await verdictOf(res), 'active', `owner ${i} behind the shared install IP`);
    }
    assert.ok(owners < DESKTOP_KEY_STATUS_IP_CEILING.limit, 'the ceiling is far above a hosted install\'s volume');
  });

  it('repeated invalid keys from one IP are throttled; a valid key from that IP still resolves', async () => {
    for (let i = 0; i < DESKTOP_KEY_STATUS_IP_INVALID_LIMIT.limit; i += 1) {
      const res = await handler(req(`wm_${(0xabc000 + i).toString(16).padStart(40, '0')}`, '203.0.113.66'));
      assert.equal(await verdictOf(res), 'invalid', `invalid attempt ${i + 1}`);
    }
    const limited = await handler(req(`wm_${'e'.repeat(40)}`, '203.0.113.66'));
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'rate_limited' });

    const missing = await handler(req(null, '203.0.113.66'));
    assert.equal(missing.status, 429, 'missing and malformed share the per-IP invalid bucket');

    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    assert.equal(await verdictOf(await handler(req(key, '203.0.113.66'))), 'active');

    // A different IP is unaffected.
    assert.equal(await verdictOf(await handler(req(`wm_${'d'.repeat(40)}`, '203.0.113.67'))), 'invalid');
  });

  it('the route never imports the desktop-key meter', () => {
    const src = readFileSync(new URL('../api/desktop-key/status.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /desktop-key-meter|reserveDesktopKeyBudget|_desktop-key-meter/);
  });
});

describe('desktop-key status: per-IP guards run before any key work', () => {
  it('an IP over the ceiling gets a no-store 429 with Retry-After and no key lookup', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    const first = await handler(req(key, '203.0.113.50'));
    assert.equal(first.status, 200);
    // The ceiling is the first bucket consulted; fill it to its limit.
    const ceiling = limiterCalls[0]!;
    limiterCounts.set(`${ceiling.scope}:${ceiling.identifier}`, DESKTOP_KEY_STATUS_IP_CEILING.limit);
    limiterCalls.length = 0;
    convexCalls = 0;
    const res = await handler(req(key, '203.0.113.50'));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.ok(Number(res.headers.get('Retry-After')) >= 1);
    assert.deepEqual(await res.json(), { error: 'rate_limited' });
    assert.equal(convexCalls, 0, 'no Convex call past the ceiling');
    assert.equal(limiterCalls.length, 1, 'only the ceiling bucket is consulted');

    const otherIp = await handler(req(key, '203.0.113.51'));
    assert.equal(otherIp.status, 200, 'the ceiling is per IP');
  });

  it('a degraded IP ceiling fails closed with 503 and no key lookup; later buckets stay availability-first', async () => {
    setEntitlement('pro_owner', entitlement('pro_monthly'));
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    const degradedScopes = new Set<string>();
    __setDesktopKeyStatusDepsForTests({
      checkScopedRateLimit: async (scope: string, limit: number, window: string, identifier: string) => {
        const result = await countingLimiter(scope, limit, window, identifier);
        return degradedScopes.has(scope) ? { ...result, allowed: true, degraded: true } : result;
      },
    });
    await handler(req(key, '203.0.113.60'));
    const [ceilingScope, ownerScope] = limiterCalls.map((c) => c.scope);
    limiterCalls.length = 0;
    convexCalls = 0;
    __resetKeyPrefixCacheForTests();

    degradedScopes.add(ceilingScope!);
    const res = await handler(req(key, '203.0.113.60'));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.ok(Number(res.headers.get('Retry-After')) >= 1);
    assert.equal(convexCalls, 0, 'no Convex call while the ceiling cannot count');

    degradedScopes.clear();
    degradedScopes.add(ownerScope!);
    const ownerDegraded = await handler(req(key, '203.0.113.60'));
    assert.equal(ownerDegraded.status, 200, 'the owner bucket runs after the lookup and stays availability-first');
    assert.equal(await verdictOf(ownerDegraded), 'active');
  });

  it('an unproven Cloudflare client IP is refused before any limiter or key lookup', async () => {
    process.env.CF_EDGE_PROOF_SECRET = 'edge-proof-secret';
    const key = mintKey({ userId: 'pro_owner', name: 'laptop', keyKind: 'desktop' });
    const request = new Request(URL_PATH, {
      method: 'GET',
      headers: { 'X-WorldMonitor-Key': key, 'cf-connecting-ip': '198.51.100.9', 'x-real-ip': '203.0.113.7' },
    });
    const res = await handler(request);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(limiterCalls.length, 0);
    assert.equal(convexCalls, 0);
  });
});
