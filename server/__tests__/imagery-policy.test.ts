// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createDomainGateway } from '../gateway';
import { searchImagery } from '../worldmonitor/imagery/v1/search-imagery';
import { createImageryServiceRoutes } from '../../src/generated/server/worldmonitor/imagery/v1/service_server';
import { ENDPOINT_RATE_POLICIES, FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED, __resetRateLimitForTest } from '../_shared/rate-limit';
import { __resetKeyPrefixCacheForTests } from '../_shared/redis';
import { issueSessionToken } from '../../api/_session.js';
import { createRedisFetch } from '../../tests/helpers/fake-upstash-redis.mts';

const PATH = '/api/imagery/v1/search-imagery';
const env = { ...process.env };
let providerCalls: number;
let redisError: boolean;
let limiterKeys: string[];
let gateway: ReturnType<typeof createDomainGateway>;

beforeEach(() => {
  providerCalls = 0; redisError = false; limiterKeys = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://imagery-redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  process.env.WM_SESSION_SECRET = 'synthetic-imagery-session-secret';
  process.env.VERCEL_ENV = 'production';
  delete process.env.LOCAL_API_MODE;
  delete process.env.AXIOM_TOKEN;
  __resetKeyPrefixCacheForTests();
  __resetRateLimitForTest();
  vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  const redis = createRedisFetch({});
  const counters = new Map<string, number>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'imagery-redis.invalid') {
      if (init?.body) {
        const command = JSON.parse(String(init.body));
        if (Array.isArray(command[0])) {
          if (redisError) return Response.json({ error: 'Synthetic outage' }, { status: 503 });
          return Response.json(command.map((entry: unknown[]) => {
            expect(String(entry[0])).toMatch(/^eval(sha)?$/i);
            const key = String(entry[3]);
            limiterKeys.push(key);
            const limit = Number(entry[3 + Number(entry[2])]);
            const count = (counters.get(key) ?? 0) + 1;
            counters.set(key, count);
            return { result: [limit - count, limit] };
          }));
        }
      }
      return redis.fetchImpl(input, init);
    }
    expect(url.href).toBe('https://earth-search.aws.element84.com/v1/search');
    providerCalls++;
    return Response.json({ features: [], numberMatched: 0 });
  });
  const routes = createImageryServiceRoutes({ searchImagery });
  gateway = createDomainGateway([...routes, { ...routes[0]!, path: '/api/economic/v1/list-world-bank-indicators' }]);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  __resetRateLimitForTest();
  __resetKeyPrefixCacheForTests();
});

async function request(index = 1, session = true, path = PATH) {
  const cookie = session ? { Cookie: `wm-session=${(await issueSessionToken()).token}` } : {};
  const query = new URLSearchParams({ bbox: `${index / 1000},0,1,1`, datetime: '2026-08-01T00:00:00Z' });
  return gateway(new Request(`https://worldmonitor.app${path}?${query}`, {
    headers: { 'x-real-ip': '192.0.2.54', ...cookie },
  }), { waitUntil: () => {} });
}

test('registers a 30/min fail-closed imagery provider policy', () => {
  expect(ENDPOINT_RATE_POLICIES[PATH]).toEqual({ limit: 30, window: '60 s' });
  expect(FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED).toHaveProperty(PATH);
});
test('anonymous callers stop before STAC and sessions retain cache behavior', async () => {
  expect((await request(1, false)).status).toBe(401);
  expect(providerCalls).toBe(0);
  const cold = await request();
  expect(cold.status).toBe(200);
  expect((await cold.json()).cacheHit).toBe(false);
  expect((await (await request()).json()).cacheHit).toBe(true);
  expect(providerCalls).toBe(1);
});
test('blocks the 31st unique query despite rotating freely issued sessions', async () => {
  for (let index = 1; index <= 30; index++) expect((await request(index)).status).toBe(200);
  const denied = await request(31);
  expect(denied.status).toBe(429);
  expect(denied.headers.get('Retry-After')).toBeTruthy();
  expect(providerCalls).toBe(30);
  expect(new Set(limiterKeys).size).toBe(1);
  expect(limiterKeys[0]).toContain(`rl:ep:${PATH}:ip:192.0.2.54:`);
});
for (const outage of ['missing', 'error']) {
  test(`cloud Redis ${outage} fails closed before STAC`, async () => {
    if (outage === 'missing') {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
    } else redisError = true;
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get('X-RateLimit-Mode')).toBe('degraded');
    expect(providerCalls).toBe(0);
  });
}
test('sidecar imagery works without Redis while unrelated paths remain fail closed', async () => {
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  expect((await request()).status).toBe(200);
  expect(providerCalls).toBe(1);
  expect((await request(2, true, '/api/economic/v1/list-world-bank-indicators')).status).toBe(503);
  expect(providerCalls).toBe(1);
});

test('invalid datetime returns a field violation before STAC', async () => {
  const routes = createImageryServiceRoutes({ searchImagery });
  const response = await routes[0]!.handler(new Request(`https://worldmonitor.app${PATH}?bbox=0,0,1,1&datetime=invalid`), {});
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ violations: [{ field: 'datetime', description: 'Invalid imagery datetime' }] });
  expect(providerCalls).toBe(0);
});
