import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { trackAircraft } from '../server/worldmonitor/aviation/v1/track-aircraft.ts';
import { ApiError, createAviationServiceRoutes, type TrackAircraftRequest } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler.ts';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { __resetRateLimitForTest, ENDPOINT_RATE_POLICIES, FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED } from '../server/_shared/rate-limit.ts';
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
test('identifier and bbox gateway requests fail closed without the budget store', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRateLimitForTest();
  const unavailable = await gateway(request({ icao24: 'abc123' }));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('X-RateLimit-Mode'), 'degraded');
  assert.equal(unavailable.headers.get('Retry-After'), '5');
  assert.equal(providers().length, 0);
  const bbox = await gateway(request({ sw_lat: '24', sw_lon: '54', ne_lat: '26', ne_lon: '56' }));
  assert.equal(bbox.status, 503);
  assert.equal(bbox.headers.get('X-RateLimit-Mode'), 'degraded');
  assert.equal(providers().length, 0);
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
test('bbox uses the endpoint budget before providers and preserves empty results and recovery', async () => {
  const transport = globalThis.fetch;
  const wire: { init?: RequestInit }[] = [];
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input)).hostname === 'relay.example') {
      assert.equal(readLimiterRequest(wire)?.tokens, 30);
    }
    wire.push({ init });
    return transport(input, init);
  }) as typeof fetch;
  wingbitsPositions = [];
  const empty = await gateway(request({ sw_lat: '10', sw_lon: '10', ne_lat: '11', ne_lon: '11' }));
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).positions, []);
  assert.equal(providers().length, 1);
  assert.equal(readLimiterRequest(wire)?.tokens, 30);
  assert.ok(!wire.some(item => String(item.init?.body).includes('track-aircraft-identifiers')));
  wingbitsStatus = 502;
  const recovered = await gateway(request({ sw_lat: '24', sw_lon: '54', ne_lat: '26', ne_lon: '56' }));
  assert.equal((await recovered.json()).source, 'opensky');
  assert.deepEqual(providers().map(url => url.pathname), ['/wingbits/track', '/wingbits/track', '/opensky/states/all']);
});

for (const mode of [undefined, 'docker']) test(`one route admission caps mixed cache misses at 30/min in ${mode ?? 'cloud'}`, async () => {
  if (mode) process.env.LOCAL_API_MODE = mode;
  assert.deepEqual(ENDPOINT_RATE_POLICIES[PATH], { limit: 30, window: '60 s' });
  assert.ok(FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED[PATH]);
  const transport = globalThis.fetch;
  let routeAdmissions = 0;
  let identifierAdmissions = 0;
  globalThis.fetch = (async (input, init) => {
    const commands = init?.body ? JSON.parse(String(init.body)) : [];
    if (Array.isArray(commands[0])) {
      if (commands.some((c: string[]) => c.some(value => String(value).includes(`rl:ep:${PATH}:`)))) {
        return Response.json(commands.map(() => ({ result: [30 - ++routeAdmissions, 30] })));
      }
      if (commands.some((c: string[]) => c.some(value => String(value).includes('track-aircraft-identifiers')))) identifierAdmissions++;
    }
    return transport(input, init);
  }) as typeof fetch;
  for (let i = 0; i < 30; i++) {
    const query = i % 2 === 0
      ? { sw_lat: String(i), sw_lon: '10', ne_lat: String(i + 1), ne_lon: '11' }
      : { callsign: `UAE${i}` };
    assert.equal((await gateway(request(query))).status, 200);
  }
  assert.equal(routeAdmissions, 30);
  assert.equal(identifierAdmissions, 15);
  assert.equal(providers().length, 30);
  for (const query of [{ sw_lat: '40', sw_lon: '10', ne_lat: '41', ne_lon: '11' }, { callsign: 'UAE31' }]) {
    const denied = await gateway(request(query));
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get('RateLimit-Limit'), '30');
    assert.ok(Number(denied.headers.get('Retry-After')) > 0);
  }
  assert.equal(providers().length, 30);
  assert.equal(identifierAdmissions, 15, 'route denial must occur before the identifier budget');
});

for (const mode of [undefined, 'docker']) test(`Redis failure denies both gateway shapes in ${mode ?? 'cloud'} before providers`, async () => {
  if (mode) process.env.LOCAL_API_MODE = mode;
  const transport = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input)).hostname === 'redis.example') throw new Error('Synthetic Redis outage');
    return transport(input, init);
  }) as typeof fetch;
  for (const query of [{ sw_lat: '24', sw_lon: '54', ne_lat: '26', ne_lon: '56' }, { icao24: 'abc123' }]) {
    assert.equal((await gateway(request(query))).status, 503);
    assert.equal(providers().length, 0);
  }
});

test('request headers and query parameters cannot enable native admission', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const req = request({ sw_lat: '24', sw_lon: '54', ne_lat: '26', ne_lon: '56', LOCAL_API_MODE: 'tauri-sidecar', mode: 'tauri-sidecar' });
  req.headers.set('LOCAL_API_MODE', 'tauri-sidecar');
  req.headers.set('x-worldmonitor-local-token', 'synthetic-aircraft-native-token');
  const denied = await gateway(req);
  assert.equal(denied.status, 503);
  assert.equal(providers().length, 0);
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
    const bboxUrl = `http://127.0.0.1:${port}${PATH}?sw_lat=24&sw_lon=54&ne_lat=26&ne_lon=56`;
    const bbox = await originalFetch(bboxUrl, { headers });
    assert.equal(bbox.status, 200);
    assert.equal((await bbox.json()).source, 'wingbits');
    assert.equal((await originalFetch(bboxUrl, { headers })).status, 200);
    assert.equal(providers().length, 2);
  } finally {
    Date.now = realNow;
    await app.close();
  }
});

test('nearby exact viewports keep separate data and filter provider overfetch on cache hits', async () => {
  wingbitsPositions = [{ ...wingbitsPosition, lat: 25.2, lon: 55.2 }, { ...wingbitsPosition, lat: 25.8, lon: 55.8 }];
  const west = { swLat: 25.1, swLon: 55.1, neLat: 25.5, neLon: 55.5 };
  const east = { swLat: 25.6, swLon: 55.6, neLat: 25.9, neLon: 55.9 };
  assert.deepEqual((await read(west)).positions.map(p => p.lat), [25.2]);
  assert.deepEqual((await read(east)).positions.map(p => p.lat), [25.8]);
  assert.deepEqual((await read(west)).positions.map(p => p.lat), [25.2]);
  assert.equal(providers().length, 2);
  assert.equal(providers()[0]!.searchParams.get('lamin'), '25.1');
  assert.equal(providers()[1]!.searchParams.get('lamin'), '25.6');
});

test('viewport fetch identity includes identifiers and stays separate from identifier-only data', async () => {
  await read({ icao24: 'abc123' });
  const bbox = { swLat: 24, swLon: 54, neLat: 26, neLon: 56 };
  assert.equal((await read({ ...bbox, icao24: 'abc123' })).source, 'wingbits');
  await read({ ...bbox, icao24: 'def456' });
  assert.equal(providers().length, 3);
});

test('normalized viewport coordinates determine both cache identity and relay query', async () => {
  const reversed = { swLat: 100, swLon: 200, neLat: 24, neLon: 54 };
  await read(reversed);
  await read({ swLat: 24, swLon: 54, neLat: 90, neLon: 180 });
  assert.equal(providers().length, 1);
  assert.equal(providers()[0]!.search, '?lamin=24&lomin=54&lamax=90&lomax=180');
});

test('nonfinite viewport coordinates reject before cache or provider work', async () => {
  for (const swLat of [NaN, Infinity, -Infinity]) {
    await assert.rejects(read({ swLat, neLat: 26, swLon: 54, neLon: 56 }), (error: unknown) => error instanceof ApiError && error.statusCode === 400);
    assert.equal(calls.length, 0);
  }
});
