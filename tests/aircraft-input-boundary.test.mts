import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { trackAircraft } from '../server/worldmonitor/aviation/v1/track-aircraft.ts';
import { ApiError, createAviationServiceRoutes, type TrackAircraftRequest } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler.ts';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { __resetRateLimitForTest } from '../server/_shared/rate-limit.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { readLimiterRequest } from './helpers/upstash-limiter-wire.mjs';
import { issueSessionToken } from '../api/_session.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const PATH = '/api/aviation/v1/track-aircraft';
const gateway = createDomainGateway(createAviationServiceRoutes(aviationHandler, serverOptions));
const defaults: TrackAircraftRequest = { icao24: '', callsign: '', swLat: 0, swLon: 0, neLat: 0, neLon: 0 };
const wingbitsPosition = { icao24: 'abc123', callsign: 'UAE20', lat: 25, lon: 55, altitudeM: 1000, groundSpeedKts: 100, trackDeg: 90, verticalRate: 0, onGround: false, source: 'POSITION_SOURCE_WINGBITS', observedAt: 1 };
let redis: ReturnType<typeof installRedis>;
let calls: URL[];
let session: string;
let wingbitsStatus: number;
let wingbitsPositions: typeof wingbitsPosition[];
let openSkyStatus: number;
beforeEach(async () => {
  delete process.env.LOCAL_API_MODE;
  delete process.env.WORLDMONITOR_VALID_KEYS;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  process.env.WS_RELAY_URL = 'https://relay.example';
  process.env.WM_SESSION_SECRET = 'synthetic-aircraft-session-secret';
  session = (await issueSessionToken()).token;
  __resetRateLimitForTest();
  redis = installRedis({});
  calls = [];
  wingbitsStatus = 200;
  wingbitsPositions = [wingbitsPosition];
  openSkyStatus = 200;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.hostname === 'redis.example') return redis.fetchImpl(input, init);
    assert.equal(url.hostname, 'relay.example');
    if (url.pathname === '/wingbits/track') return Response.json({ positions: wingbitsPositions, source: 'wingbits' }, { status: wingbitsStatus });
    assert.equal(url.pathname, '/opensky/states/all');
    return Response.json({ states: [['abc123', 'UAE20 ', null, null, 1, 55, 25, 1000, false, 100, 90, 0]] }, { status: openSkyStatus });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});
const request = (query: Record<string, string> = {}) => new Request(`https://api.worldmonitor.app${PATH}?${new URLSearchParams(query)}`, { headers: { 'X-WorldMonitor-Key': session, 'x-real-ip': '192.0.2.10' } });
const ctx = () => ({ request: request(), pathParams: {}, headers: {} });
const read = (options: Partial<TrackAircraftRequest>) => trackAircraft(ctx(), { ...defaults, ...options });
const providers = () => calls.filter(url => url.hostname === 'relay.example');

test('invalid or oversized identifiers fail before cache or upstream I/O', async () => {
  for (const options of [{ icao24: 'abc123&lamin=0' }, { icao24: 'abc12' }, { icao24: 'gggggg' }, { icao24: 'a'.repeat(1000) }, { callsign: 'UAE/20' }, { callsign: 'UAE20&x=1' }, { callsign: 'ABCDEFGHI' }, { callsign: ' '.repeat(1000) + 'UAE20' }]) {
    await assert.rejects(read(options), (error: unknown) => error instanceof ApiError && error.statusCode === 400);
    assert.equal(calls.length, 0);
  }
});
test('canonical ICAO shares bounded key and retains OpenSky lookup/filter behavior', async () => {
  const first = await read({ icao24: ' ABC123 ' });
  const second = await read({ icao24: 'abc123' });
  assert.equal(first.source, 'opensky');
  assert.equal(first.positions[0]?.icao24, 'abc123');
  assert.deepEqual(second.positions, first.positions);
  assert.equal(providers().length, 1);
  assert.equal(providers()[0]!.search, '?icao24=abc123');
  assert.deepEqual([...redis.redis.keys()].filter(key => key.startsWith('aviation:track:')), ['aviation:track:icao:abc123:v2']);
});
test('canonical callsign retains substring matching and Wingbits priority', async () => {
  assert.equal((await read({ callsign: ' uae ' })).positions[0]?.callsign, 'UAE20');
  assert.equal((await read({ callsign: 'UAE' })).source, 'wingbits');
  assert.equal(providers().length, 1);
  assert.equal(providers()[0]!.search, '?callsign=UAE');
  assert.deepEqual([...redis.redis.keys()].filter(key => key.startsWith('aviation:track:')), ['aviation:track:callsign:UAE:v2']);
});
test('identifier store outage fails closed while anonymous bbox remains available', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRateLimitForTest();
  const unavailable = await gateway(request({ icao24: 'abc123' }));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('X-RateLimit-Mode'), 'degraded');
  assert.equal(unavailable.headers.get('Retry-After'), '5');
  assert.equal((await unavailable.json()).message, 'Rate-limit service temporarily unavailable');
  assert.equal(providers().length, 0);
  const bbox = await gateway(request({ sw_lat: '24', sw_lon: '54', ne_lat: '26', ne_lon: '56' }));
  assert.equal(bbox.status, 200);
  assert.equal((await bbox.json()).source, 'wingbits');
  assert.equal(providers().length, 1);
});
test('identifier quota is 30/min across distinct cache keys', async () => {
  const transport = globalThis.fetch;
  let admissions = 0;
  const wire: { init?: RequestInit }[] = [];
  globalThis.fetch = (async (input, init) => {
    const commands = init?.body ? JSON.parse(String(init.body)) : [];
    if (Array.isArray(commands[0]) && commands.some((c: string[]) => c.some(value => String(value).includes('track-aircraft-identifiers')))) {
      wire.push({ init });
      return Response.json(commands.map(() => ({ result: [30 - ++admissions, 30] })));
    }
    return transport(input, init);
  }) as typeof fetch;
  for (let i = 0; i < 30; i++) {
    const allowed = await gateway(request({ callsign: `UAE${i}` }));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('RateLimit-Limit'), '30');
  }
  const denied = await gateway(request({ callsign: 'UAE30' }));
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('RateLimit-Policy'), '"default";q=30;w=60');
  assert.equal(denied.headers.get('RateLimit-Remaining'), '0');
  assert.ok(Number(denied.headers.get('Retry-After')) > 0);
  assert.deepEqual(await denied.json(), { error: 'Too many requests' });
  assert.equal(admissions, 31);
  const sent = readLimiterRequest(wire);
  assert.equal(sent?.tokens, 30);
  assert.equal(sent?.windowMs, 60000);
  assert.ok(sent?.keys.every(key => key.includes('track-aircraft-identifiers:192.0.2.10:')));
  assert.equal(providers().length, 30);
});

test('Redis transport failure denies identifier lookups before provider work', async () => {
  const transport = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input)).hostname === 'redis.example') throw new Error('Synthetic Redis outage');
    return transport(input, init);
  }) as typeof fetch;
  await assert.rejects(read({ callsign: 'UAE20' }), (error: unknown) => error instanceof ApiError && error.statusCode === 503);
  assert.equal(providers().length, 0);
});
test('bbox retains the global gateway budget, authoritative empty results and OpenSky recovery', async () => {
  const transport = globalThis.fetch;
  const wire: { init?: RequestInit }[] = [];
  globalThis.fetch = (async (input, init) => { wire.push({ init }); return transport(input, init); }) as typeof fetch;
  wingbitsPositions = [];
  const empty = await gateway(request({ sw_lat: '10', sw_lon: '10', ne_lat: '11', ne_lon: '11' }));
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).positions, []);
  assert.equal(providers().length, 1);
  assert.equal(readLimiterRequest(wire)?.tokens, 600);
  assert.ok(!wire.some(item => String(item.init?.body).includes('track-aircraft-identifiers')));
  wingbitsStatus = 502;
  const recovered = await gateway(request({ sw_lat: '24', sw_lon: '54', ne_lat: '26', ne_lon: '56' }));
  assert.equal((await recovered.json()).source, 'opensky');
  assert.deepEqual(providers().map(url => url.pathname), ['/wingbits/track', '/wingbits/track', '/opensky/states/all']);
});
test('identifier provider failures preserve empty none responses and no-identifier requests do not fetch', async () => {
  wingbitsStatus = 502;
  assert.equal((await read({ callsign: 'FAIL1' })).source, 'none');
  assert.equal(providers().length, 1);
  openSkyStatus = 502;
  assert.equal((await read({ icao24: 'fffffe' })).source, 'none');
  assert.equal(providers().length, 2);
  assert.deepEqual((await read({})).positions, []);
  assert.equal(providers().length, 2);
});
test('both identifiers and identifiers with bbox are validated and admitted without changing filtering', async () => {
  const both = await read({ icao24: 'ABC123', callsign: ' uae ' });
  assert.equal(both.source, 'opensky');
  assert.equal(both.positions[0]?.icao24, 'abc123');
  const withBbox = await read({ icao24: 'abc123', callsign: 'UAE', swLat: 24, swLon: 54, neLat: 26, neLon: 56 });
  assert.equal(withBbox.positions[0]?.icao24, 'abc123');
  await assert.rejects(read({ icao24: 'bad', swLat: 24, swLon: 54, neLat: 26, neLon: 56 }), (error: unknown) => error instanceof ApiError && error.statusCode === 400);
});
test('verified MCP identifier calls cannot bypass the handler budget', async () => {
  const { signInternalMcpRequest, buildInternalMcpHeaders } = await import('../server/_shared/mcp-internal-hmac.ts');
  process.env.MCP_INTERNAL_HMAC_SECRET = 'synthetic-aircraft-mcp-secret';
  process.env.CONVEX_SITE_URL = 'https://convex.example';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'synthetic-convex-secret';
  const transport = globalThis.fetch;
  let admissions = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'convex.example') return Response.json({ planKey: 'pro', features: { tier: 1, mcpAccess: true, apiAccess: false }, validUntil: Date.now() + 86400000 });
    const commands = init?.body ? JSON.parse(String(init.body)) : [];
    if (Array.isArray(commands[0])) {
      if (commands.some((c: string[]) => String(c[1]).startsWith('internal-mcp-replay:'))) return Response.json(commands.map(() => ({ result: 'OK' })));
      if (commands.some((c: string[]) => c.some(value => String(value).includes('track-aircraft-identifiers')))) return Response.json(commands.map(() => ({ result: [30 - ++admissions, 30] })));
    }
    return transport(input, init);
  }) as typeof fetch;
  const signed = async () => {
    const url = request({ callsign: 'UAE20' }).url;
    const signature = await signInternalMcpRequest({ method: 'GET', url, body: '', userId: 'synthetic_aircraft_user', secret: process.env.MCP_INTERNAL_HMAC_SECRET! });
    return new Request(url, { headers: buildInternalMcpHeaders(signature) });
  };
  for (let i = 0; i < 30; i++) assert.equal((await gateway(await signed())).status, 200);
  const denied = await gateway(await signed());
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('RateLimit-Limit'), '30');
  assert.ok(Number(denied.headers.get('Retry-After')) > 0);
  assert.equal(admissions, 31);
  assert.equal(providers().length, 1);
  assert.equal(providers()[0]!.pathname, '/wingbits/track');
});
test('native HTTP identifier admission preserves real auth, data, cache and window recovery without Redis', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const providerFetch = globalThis.fetch;
  const { createLocalApiServer } = await import('../src-tauri/sidecar/local-api-server.mjs');
  globalThis.fetch = providerFetch;
  const root = await mkdtemp(join(tmpdir(), 'aircraft-native-'));
  await mkdir(join(root, 'aviation/v1'), { recursive: true });
  const serviceUrl = new URL('../src/generated/server/worldmonitor/aviation/v1/service_server.ts', import.meta.url).href;
  const gatewayUrl = new URL('../server/gateway.ts', import.meta.url).href;
  const handlerUrl = new URL('../server/worldmonitor/aviation/v1/handler.ts', import.meta.url).href;
  await writeFile(join(root, 'aviation/v1/track-aircraft.js'), `import {createAviationServiceRoutes} from ${JSON.stringify(serviceUrl)}; import {createDomainGateway,serverOptions} from ${JSON.stringify(gatewayUrl)}; import {aviationHandler} from ${JSON.stringify(handlerUrl)}; export default createDomainGateway(createAviationServiceRoutes(aviationHandler,serverOptions));`);
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  process.env.LOCAL_API_TOKEN = 'synthetic-aircraft-native-token';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const app = await createLocalApiServer({ port: 0, apiDir: root, dataDir: root, mode: 'tauri-sidecar', cloudFallback: false, logger: { log() {}, warn() {}, error() {} } });
  const { port } = await app.start();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const url = `http://127.0.0.1:${port}${PATH}?icao24=ABC123`;
    assert.equal((await originalFetch(url)).status, 401);
    const headers = { 'x-worldmonitor-local-token': process.env.LOCAL_API_TOKEN, 'X-WorldMonitor-Key': session };
    for (let i = 0; i < 30; i++) {
      const response = await originalFetch(url, { headers });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.source, 'opensky');
      assert.deepEqual(body.positions.map((p: { icao24: string }) => p.icao24), ['abc123']);
    }
    const denied = await originalFetch(url, { headers });
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get('Retry-After'), '60');
    assert.equal(denied.headers.get('RateLimit-Limit'), '30');
    now += 59_999;
    assert.equal((await originalFetch(url, { headers })).status, 429);
    now += 1;
    const recovered = await originalFetch(url, { headers });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).source, 'opensky');
    assert.equal(providers().length, 1);
  } finally {
    Date.now = realNow;
    await app.close();
  }
});
