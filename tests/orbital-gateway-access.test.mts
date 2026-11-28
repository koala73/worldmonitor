// The two Pro orbital RPCs, called through the real edge entry (api/orbital/v1/[rpc].ts)
// and gateway: an anonymous browser and a signed-in free account never reach a handler.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { issueSessionToken } from '../api/_session.js';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

const FREE_USER_KEY = `wm_${'a'.repeat(40)}`;
const ROUTES = ['/api/orbital/v1/get-point-passes?lat=33.72&lon=51.73', '/api/orbital/v1/get-country-imagery-evidence?country_code=IR'];
const ENV_KEYS = ['ORBITAL_WATCH_ENABLED', 'WM_SESSION_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'CONVEX_SITE_URL', 'CONVEX_SERVER_SHARED_SECRET'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const handlerReads: string[] = [];
let sessionToken: string;
let gateway: (request: Request) => Promise<Response>;

before(async () => {
  Object.assign(process.env, {
    ORBITAL_WATCH_ENABLED: 'true',
    WM_SESSION_SECRET: originalEnv.WM_SESSION_SECRET ?? 'test-secret-must-be-at-least-32-chars-long-xxx',
    UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'token',
    CONVEX_SITE_URL: 'https://test.convex.site', CONVEX_SERVER_SHARED_SECRET: 'test-secret',
  });
  const redis = createRedisFetch({});
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://redis.example')) {
      // The rate limiter and entitlement cache use Redis too; a handler's seeded reads are GETs of orbital keys.
      if (/orbital/.test(decodeURIComponent(url)) || /orbital/.test(String(init?.body ?? ''))) handlerReads.push(url);
      return redis.fetchImpl(input, init);
    }
    if (url.endsWith('/api/internal-validate-api-key')) {
      return Response.json({ id: 'free-key', userId: 'free_api_user', name: 'Free API key', keyKind: 'api' });
    }
    if (url.endsWith('/api/internal-entitlements')) {
      return Response.json({
        planKey: 'free', validUntil: Date.now() + 86_400_000,
        features: { tier: 0, apiAccess: true, apiRateLimit: 60, maxDashboards: 3, prioritySupport: false, exportFormats: [], mcpAccess: false },
      });
    }
    handlerReads.push(url);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  sessionToken = (await issueSessionToken()).token;
  gateway = (await import('../api/orbital/v1/[rpc].ts')).default as typeof gateway;
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const call = (path: string, headers: Record<string, string>) =>
  gateway(new Request(`https://api.worldmonitor.app${path}`, { headers: { Origin: 'https://www.worldmonitor.app', ...headers } }));

describe('orbital Pro RPCs through the gateway', () => {
  it('refuse an anonymous caller, with or without a browser session token', async () => {
    for (const path of ROUTES) {
      assert.equal((await call(path, {})).status, 401, `${path}: no credentials`);
      const session = await call(path, { 'X-WorldMonitor-Key': sessionToken });
      assert.equal(session.status, 401, `${path}: an anonymous wms_ session is not Pro`);
    }
    assert.deepEqual(handlerReads, [], 'no handler ran');
  });

  it('refuse a signed-in free account at the tier-1 entitlement gate', async () => {
    for (const path of ROUTES) {
      const res = await call(path, { 'X-Api-Key': FREE_USER_KEY });
      assert.equal(res.status, 403, path);
      const body = await res.json() as { error?: string; requiredTier?: number; currentTier?: number };
      assert.deepEqual({ error: body.error, requiredTier: body.requiredTier, currentTier: body.currentTier }, { error: 'Upgrade required', requiredTier: 1, currentTier: 0 }, path);
    }
    assert.deepEqual(handlerReads, [], 'no handler ran');
  });

  it('stay dark while ORBITAL_WATCH_ENABLED is unset or not true', async () => {
    try {
      for (const value of [undefined, 'false', '1']) {
        if (value === undefined) delete process.env.ORBITAL_WATCH_ENABLED;
        else process.env.ORBITAL_WATCH_ENABLED = value;
        for (const path of ROUTES) assert.equal((await call(path, { 'X-Api-Key': FREE_USER_KEY })).status, 404, `${path} with ${value}`);
      }
    } finally {
      process.env.ORBITAL_WATCH_ENABLED = 'true';
    }
  });
});
