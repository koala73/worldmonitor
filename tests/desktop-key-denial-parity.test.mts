/**
 * Plan 2026-10-25-001 — the gateway and bootstrap deny a desktop principal
 * with byte-identical bodies.
 *
 * The over-cap 403 (R5 / AE6) and the daily-limit 429 (KTD6 / AE5) are each
 * documented as ONE row in docs/usage-errors.mdx, and both surfaces import the
 * copy from shared/desktop-key-access.js and the response contract from
 * api/_desktop-key-meter.js. This drives the REAL gateway and the REAL
 * bootstrap entry over one fake Upstash plus one stubbed Convex, on a frozen
 * clock, and compares what they answer — so the two cannot drift again.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import { DESKTOP_KEY_LIMIT_ERROR } from '../shared/desktop-key-access.js';
import { getEntitlementFeatures } from '../convex/config/productCatalog.ts';
import { installRedis, type FakeRedisState } from './helpers/fake-upstash-redis.mts';

const ENV_KEYS = [
  'CONVEX_SITE_URL', 'CONVEX_SERVER_SHARED_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'VERCEL_ENV', 'WORLDMONITOR_VALID_KEYS', 'WM_SESSION_SECRET', 'DODO_PAYMENTS_ENVIRONMENT', 'LOCAL_API_MODE',
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>();
const ORIGINAL_FETCH = globalThis.fetch;
const FROZEN_NOW = Date.UTC(2026, 9, 25, 12, 0, 30);
const OWNER = 'parity_owner';
const REGULAR = '/api/news/v1/list-feed-digest';

type GatewayHandler = (request: Request, ctx: { waitUntil: (p: Promise<unknown>) => void }) => Promise<Response>;
type BootstrapHandler = (request: Request) => Promise<Response>;
let gateway: GatewayHandler;
let bootstrap: BootstrapHandler;
let redis: FakeRedisState;
const keysByHash = new Map<string, { id: string; userId: string; name: string; keyKind: 'desktop'; activeKeyRank: number }>();

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
let keySeq = 0;
function mintDesktopKey(activeKeyRank: number): string {
  keySeq += 1;
  const key = `wm_${keySeq.toString(16).padStart(40, '0')}`;
  keysByHash.set(sha256(key), { id: `key_${keySeq}`, userId: OWNER, name: `desk-${keySeq}`, keyKind: 'desktop', activeKeyRank });
  return key;
}

before(async () => {
  for (const name of ENV_KEYS) ORIGINAL_ENV.set(name, process.env[name]);
  // The bootstrap entry reads its session secret at import time.
  process.env.WM_SESSION_SECRET = 'parity-test-secret-at-least-32-chars-long';
  const { createDomainGateway } = await import('../server/gateway.ts');
  gateway = createDomainGateway([
    { method: 'GET', path: REGULAR, handler: async () => Response.json({ items: [{ id: 'a' }] }) },
  ]) as GatewayHandler;
  bootstrap = (await import('../api/bootstrap.js')).default as BootstrapHandler;
});

beforeEach(async () => {
  mock.timers.enable({ apis: ['Date'], now: FROZEN_NOW });
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'parity-shared-secret';
  process.env.WORLDMONITOR_VALID_KEYS = 'enterprise-parity-key';
  delete process.env.DODO_PAYMENTS_ENVIRONMENT;
  delete process.env.LOCAL_API_MODE;
  keysByHash.clear();
  const { __resetEntitlementNegativeCacheForTests } = await import('../server/_shared/entitlement-check.ts');
  const { __resetKeyPrefixCacheForTests, __clearLocalUnavailableBackoffForTests } = await import('../server/_shared/redis.ts');
  __resetEntitlementNegativeCacheForTests();
  __resetKeyPrefixCacheForTests();
  __clearLocalUnavailableBackoffForTests();
  redis = installRedis({});
  const redisFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/internal-validate-api-key')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { keyHash?: string };
      return Response.json(keysByHash.get(body.keyHash ?? '') ?? null);
    }
    if (url.endsWith('/api/internal-entitlements')) {
      return Response.json({ planKey: 'pro_monthly', validUntil: FROZEN_NOW + 86_400_000, features: getEntitlementFeatures('pro_monthly') });
    }
    // Bootstrap's own per-IP limiter (INCR / EXPIRE NX / TTL) predates the
    // fake's command set (no TTL); answer it under-limit the way
    // api/bootstrap-auth.test.mjs does so the desktop path below is reached.
    if (url.startsWith('https://redis.example') && String(init?.body ?? '').includes('rl:bootstrap-user-api-key:')) {
      return Response.json([{ result: 1 }, { result: 1 }, { result: 60 }]);
    }
    return redisFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = ORIGINAL_FETCH;
  for (const name of ENV_KEYS) {
    const value = ORIGINAL_ENV.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const viaGateway = (key: string) => gateway(
  new Request(`https://www.worldmonitor.app${REGULAR}`, { headers: { 'X-Api-Key': key } }),
  { waitUntil: () => {} },
);
const viaBootstrap = (key: string) => bootstrap(
  new Request('https://api.worldmonitor.app/api/bootstrap?keys=marketQuotes', { headers: { 'X-WorldMonitor-Key': key } }),
);

const COMPARED_HEADERS = ['Retry-After', 'Cache-Control', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'RateLimit-Policy', 'RateLimit', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-RateLimit-Mode'];
function picked(res: Response): Record<string, string | null> {
  return Object.fromEntries(COMPARED_HEADERS.map((name) => [name, res.headers.get(name)]));
}

describe('desktop-key denials are identical on the gateway and bootstrap', () => {
  it('over-cap 403: same status, same one-sentence body', async () => {
    const third = mintDesktopKey(2);
    const g = await viaGateway(third);
    const b = await viaBootstrap(third);
    assert.equal(g.status, 403, await g.clone().text());
    assert.equal(b.status, 403, await b.clone().text());
    const gBody = await g.json();
    assert.deepEqual(gBody, { error: DESKTOP_KEY_LIMIT_ERROR });
    assert.deepEqual(await b.json(), gBody);
    assert.equal(g.headers.get('Cache-Control'), 'no-store');
    assert.equal(b.headers.get('Cache-Control'), 'no-store');
  });

  it('daily-limit 429: same status, same body, same rate-limit headers', async () => {
    const key = mintDesktopKey(0);
    redis.redis.set(`rl:desktopkey:day:${OWNER}:2026-10-25`, String(getEntitlementFeatures('pro_monthly').planLimits.desktopKeyRequestsPerDay));
    const g = await viaGateway(key);
    const b = await viaBootstrap(key);
    assert.equal(g.status, 429, await g.clone().text());
    assert.equal(b.status, 429, await b.clone().text());
    const gBody = await g.json() as Record<string, unknown>;
    assert.equal(gBody.limit_type, 'daily');
    assert.equal(gBody.error, 'Daily request limit reached');
    assert.deepEqual(await b.json(), gBody);
    assert.deepEqual(picked(b), picked(g));
    assert.equal(g.headers.get('Retry-After'), String(12 * 3600 - 30));
  });

  it('burst 429: same body and headers', async () => {
    const key = mintDesktopKey(0);
    redis.redis.set(`rl:desktopkey:min:${OWNER}:${Math.floor(FROZEN_NOW / 60_000)}`, String(getEntitlementFeatures('pro_monthly').planLimits.desktopKeyBurstPerMinute));
    const g = await viaGateway(key);
    const b = await viaBootstrap(key);
    assert.equal(g.status, 429);
    assert.equal(b.status, 429);
    const gBody = await g.json() as Record<string, unknown>;
    assert.equal(gBody.limit_type, 'per_minute');
    assert.deepEqual(await b.json(), gBody);
    assert.deepEqual(picked(b), picked(g));
  });

  it('meter outage 503: same body and degraded headers', async () => {
    const key = mintDesktopKey(0);
    const redisFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://redis.example') && String(init?.body ?? '').includes('rl:desktopkey:')) {
        return new Response('upstream error', { status: 500 });
      }
      return redisFetch(input, init);
    }) as typeof fetch;
    const g = await viaGateway(key);
    const b = await viaBootstrap(key);
    assert.equal(g.status, 503);
    assert.equal(b.status, 503);
    const gBody = await g.json();
    assert.deepEqual(gBody, { error: 'Rate-limit service temporarily unavailable' });
    assert.deepEqual(await b.json(), gBody);
    assert.deepEqual(picked(b), picked(g));
  });
});
