// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createDomainGateway } from '../gateway';
import { getWingbitsLiveFlight } from '../worldmonitor/military/v1/get-wingbits-live-flight';
import { createMilitaryServiceRoutes, type MilitaryServiceHandler } from '../../src/generated/server/worldmonitor/military/v1/service_server';
import { ENDPOINT_RATE_POLICIES, FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED, __resetRateLimitForTest } from '../_shared/rate-limit';
import { __resetKeyPrefixCacheForTests } from '../_shared/redis';
import { issueSessionToken } from '../../api/_session.js';

const PATH = '/api/military/v1/get-wingbits-live-flight';
const originalPolicy = ENDPOINT_RATE_POLICIES[PATH];
const env = { ...process.env };
let cache: Map<string, string>;
let counters: Map<string, number>;
let providerCalls: URL[];
let limiterKeys: string[];
let redisError: boolean;
let gateway: ReturnType<typeof createDomainGateway>;

beforeEach(() => {
  cache = new Map(); counters = new Map(); providerCalls = []; limiterKeys = []; redisError = false;
  process.env.UPSTASH_REDIS_REST_URL = 'https://wingbits-redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  process.env.WM_SESSION_SECRET = 'synthetic-wingbits-session-secret';
  process.env.VERCEL_ENV = 'production';
  delete process.env.LOCAL_API_MODE;
  delete process.env.AXIOM_TOKEN;
  delete process.env.WINGBITS_API_KEY;
  __resetKeyPrefixCacheForTests();
  __resetRateLimitForTest();
  vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'wingbits-redis.invalid') {
      if (url.pathname.startsWith('/get/')) {
        return Response.json({ result: cache.get(decodeURIComponent(url.pathname.slice(5))) ?? null });
      }
      const command = JSON.parse(String(init?.body));
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
      expect(command[0]).toBe('SET');
      cache.set(command[1], command[2]);
      return Response.json({ result: 'OK' });
    }
    expect(['ecs-api.wingbits.com', 'api.planespotters.net']).toContain(url.hostname);
    providerCalls.push(url);
    const headers = new Headers(init?.headers);
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('User-Agent')).toBeTruthy();
    if (url.hostname === 'api.planespotters.net') {
      return Response.json({ photos: [{ thumbnail_large: { src: 'https://photos.invalid/example.jpg' }, link: 'https://photos.invalid/photo', photographer: 'Synthetic' }] });
    }
    if (url.pathname.includes('/schedule/UAE')) return Response.json({});
    if (url.pathname.includes('/schedule/EK')) return Response.json({ schedule: { depIata: 'DXB', arrIata: 'LHR', status: 'en-route' } });
    const hex = url.pathname.split('/').at(-1)!;
    return Response.json({ flight: { h: hex, f: `UAE${parseInt(hex, 16)}`, la: 25, lo: 55, ab: 30000 } });
  });
  const routes = createMilitaryServiceRoutes({ getWingbitsLiveFlight } as MilitaryServiceHandler).filter(route => route.path === PATH);
  gateway = createDomainGateway([...routes, { ...routes[0]!, path: '/api/economic/v1/list-world-bank-indicators' }]);
});
afterEach(() => {
  if (originalPolicy) ENDPOINT_RATE_POLICIES[PATH] = originalPolicy;
  else delete ENDPOINT_RATE_POLICIES[PATH];
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  __resetRateLimitForTest();
  __resetKeyPrefixCacheForTests();
});
async function request(hex = '000001', session = true, path = PATH) {
  const cookie = session ? { Cookie: `wm-session=${(await issueSessionToken()).token}` } : {};
  return gateway(new Request(`https://worldmonitor.app${path}?icao24=${hex}`, { headers: { 'x-real-ip': '192.0.2.47', ...cookie } }), { waitUntil: () => {} });
}

test('production route has the 30/min fail-closed registration', () => {
  expect(ENDPOINT_RATE_POLICIES[PATH]).toEqual({ limit: 30, window: '60 s' });
  expect(FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED).toHaveProperty(PATH);
});
test('requests without credentials are rejected before upstream I/O', async () => {
  expect((await request('000001', false)).status).toBe(401);
  expect(providerCalls).toHaveLength(0);
});
test('ordinary session retains full live/schedule/photo response and no-store caching', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  const { flight } = await response.json();
  expect(flight).toMatchObject({ icao24: '000001', callsignIata: 'EK1', depIata: 'DXB', arrIata: 'LHR', lat: 25, lon: 55, photoCredit: 'Synthetic' });
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(response.headers.get('CDN-Cache-Control')).toBeNull();
  expect(providerCalls).toHaveLength(4);
  expect((await request()).status).toBe(200);
  expect(providerCalls).toHaveLength(4);
});
test('baseline global policy allows the 31st unique aircraft lookup', async () => {
  delete ENDPOINT_RATE_POLICIES[PATH];
  for (let i = 1; i <= 31; i++) expect((await request(i.toString(16).padStart(6, '0'))).status).toBe(200);
  expect(providerCalls).toHaveLength(124);
});
test('baseline without Redis still reaches provider', async () => {
  delete ENDPOINT_RATE_POLICIES[PATH];
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  expect((await request()).status).toBe(200);
  expect(providerCalls).toHaveLength(4);
});
test('configured desktop path works without Upstash', async () => {
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  process.env.WINGBITS_API_KEY = 'synthetic-desktop-key';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  expect((await request('000047')).status).toBe(200);
  expect(providerCalls).toHaveLength(4);
  expect((await request('000048', true, '/api/economic/v1/list-world-bank-indicators')).status).toBe(503);
  expect(providerCalls).toHaveLength(4);
});
test('production policy blocks 31st lookup despite rotating freely issued sessions', async () => {
  for (let i = 1; i <= 30; i++) expect((await request(i.toString(16).padStart(6, '0'))).status).toBe(200);
  const response = await request('00001f');
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBeTruthy();
  expect(providerCalls).toHaveLength(120);
  expect(new Set(limiterKeys).size).toBe(1);
  expect(limiterKeys[0]).toContain(`rl:ep:${PATH}:ip:192.0.2.47:`);
});
for (const outage of ['missing', 'error']) {
  test(`production policy stops Redis ${outage} before provider I/O`, async () => {
    if (outage === 'missing') {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
    } else redisError = true;
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get('X-RateLimit-Mode')).toBe('degraded');
    expect(providerCalls).toHaveLength(0);
  });
}
