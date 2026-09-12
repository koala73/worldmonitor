import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { SearchGoogleFlightsRequest } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { searchGoogleFlights } from '../server/worldmonitor/aviation/v1/search-google-flights.ts';
import { ApiError, createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler.ts';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { __resetRateLimitForTest, checkEndpointRateLimit } from '../server/_shared/rate-limit.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { readLimiterRequest } from './helpers/upstash-limiter-wire.mjs';
import { issueSessionToken } from '../api/_session.js';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const PATH = '/api/aviation/v1/search-google-flights';
const gateway = createDomainGateway(createAviationServiceRoutes(aviationHandler, serverOptions));
let redis: ReturnType<typeof installRedis>;
let calls: URL[];
let session: string;
beforeEach(async () => {
  delete process.env.WORLDMONITOR_VALID_KEYS;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  process.env.WS_RELAY_URL = 'https://relay.example';
  delete process.env.LOCAL_API_MODE;
  process.env.WM_SESSION_SECRET = 'synthetic-aviation-news-session-secret';
  session = (await issueSessionToken()).token;
  __resetRateLimitForTest();
  redis = installRedis({});
  calls = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.hostname === 'redis.example') return redis.fetchImpl(input, init);
    return Response.json({ flights: [] });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});
const defaults: SearchGoogleFlightsRequest = { origin: 'DXB', destination: 'LHR', departureDate: '2026-10-01', returnDate: '', cabinClass: '', maxStops: '', departureWindow: '', airlines: [], sortBy: '', passengers: 1 };
const request = (overrides: Record<string, string> = {}) => new Request(`https://api.worldmonitor.app${PATH}?${new URLSearchParams({ origin: 'DXB', destination: 'LHR', departure_date: '2026-10-01', ...overrides })}`, { headers: { 'X-WorldMonitor-Key': session, 'x-vercel-forwarded-for': '192.0.2.9' } });
const ctx = () => ({ request: request(), pathParams: {}, headers: {} });
const feeds = () => calls.filter(url => url.hostname !== 'redis.example');
const read = (overrides: Partial<typeof defaults> = {}) => searchGoogleFlights(ctx(), { ...defaults, ...overrides });

test('rejects malformed or oversized inputs before cache or relay work', async () => {
  const invalid = [{ origin: 'X'.repeat(1000) }, { departureDate: '' }, { departureDate: '2026-2-01' }, { departureDate: '2026-02-29' }, { destination: 'A/B' }, { departureDate: '2026-02-30' }, { returnDate: '2026-09-30' }, { returnDate: 'junk' }, { cabinClass: 'arbitrary' }, { maxStops: '3' }, { sortBy: 'junk' }, { departureWindow: '25-26' }, { departureWindow: '20-6' }, { airlines: ['BAD'] }, { airlines: Array(11).fill('BA') }, { cabinClass: ' '.repeat(1000) }, { sortBy: ' '.repeat(1000) }, { departureDate: '2026-10-01 ' }, { airlines: [' '.repeat(1000) + 'BA'] }];
  for (const value of invalid) {
    await assert.rejects(read(value), (error: unknown) => error instanceof ApiError && error.statusCode === 400);
    assert.equal(calls.length, 0);
  }
});
test('canonical equivalents share bounded hashed cache identity', async () => {
  await read({ origin: ' dxb ', cabinClass: 'economy', maxStops: '0', sortBy: 'price', airlines: ['ba', 'AA', 'BA'], departureWindow: '06-20', passengers: 99 });
  await read({ cabinClass: 'ECONOMY', maxStops: 'NON_STOP', sortBy: 'CHEAPEST', airlines: ['AA', 'BA'], departureWindow: '6-20', passengers: 9 });
  assert.equal(feeds().length, 1);
  assert.deepEqual(feeds()[0]!.searchParams.getAll('airlines'), ['AA', 'BA']);
  const keys = [...redis.redis.keys()].filter(key => key.startsWith('aviation:gf:'));
  assert.equal(keys.length, 1);
  assert.match(keys[0]!, /^aviation:gf:[a-f0-9]{64}:v2$/);
  assert.equal(redis.expires.get(keys[0]!), 600);
});
test('ordinary gateway rejects bad input and store outages without upstream work', async () => {
  assert.equal((await gateway(request({ origin: 'TOOLONG' }))).status, 400);
  assert.equal(feeds().length, 0);
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRateLimitForTest();
  assert.equal((await gateway(request())).status, 503);
  assert.equal(feeds().length, 0);
});
test('effective options remain distinct while defaults and sort aliases share keys', async () => {
  await read();
  await read({ cabinClass: 'economy', maxStops: 'any' });
  assert.equal(feeds().length, 1);
  for (const option of [{ returnDate: '2026-10-05' }, { cabinClass: 'BUSINESS' }, { maxStops: 'NON_STOP' }, { sortBy: 'CHEAPEST' }, { passengers: 2 }, { airlines: ['BA'] }, { departureWindow: '6-20' }]) await read(option);
  assert.equal(feeds().length, 8);
  await read({ sortBy: 'PRICE' });
  assert.equal(feeds().length, 8);
  await read({ sortBy: 'DEPARTURE' });
  await read({ sortBy: 'DEPARTURE_TIME' });
  await read({ sortBy: 'ARRIVAL' });
  await read({ sortBy: 'ARRIVAL_TIME' });
  assert.equal(feeds().length, 10);
});
test('actual native sidecar requires its token before the flight-search gateway', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const providerFetch = globalThis.fetch;
  const { createLocalApiServer } = await import('../src-tauri/sidecar/local-api-server.mjs');
  // Sidecar import installs its network transport; keep upstream I/O synthetic.
  globalThis.fetch = providerFetch;
  const root = await mkdtemp(join(tmpdir(), 'google-flights-sidecar-'));
  await mkdir(join(root, 'aviation/v1'), { recursive: true });
  const serviceUrl = new URL('../src/generated/server/worldmonitor/aviation/v1/service_server.ts', import.meta.url).href;
  const gatewayUrl = new URL('../server/gateway.ts', import.meta.url).href;
  const handlerUrl = new URL('../server/worldmonitor/aviation/v1/handler.ts', import.meta.url).href;
  await writeFile(join(root, 'aviation/v1/search-google-flights.js'), `import {createAviationServiceRoutes} from ${JSON.stringify(serviceUrl)}; import {createDomainGateway,serverOptions} from ${JSON.stringify(gatewayUrl)}; import {aviationHandler} from ${JSON.stringify(handlerUrl)}; export default createDomainGateway(createAviationServiceRoutes(aviationHandler,serverOptions));`);
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  process.env.LOCAL_API_TOKEN = 'synthetic-native-transport';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const app = await createLocalApiServer({ port: 0, apiDir: root, dataDir: root, mode: 'tauri-sidecar', cloudFallback: false, logger: { log() {}, warn() {}, error() {} } });
  const { port } = await app.start();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const url = `http://127.0.0.1:${port}${PATH}?origin=DXB&destination=LHR&departure_date=2026-10-01`;
    assert.equal((await originalFetch(url, { headers: { 'x-worldmonitor-local-token': 'invalid' } })).status, 401);
    const headers = { 'x-worldmonitor-local-token': process.env.LOCAL_API_TOKEN, 'X-WorldMonitor-Key': session };
    for (let i = 0; i < 30; i++) {
      const response = await originalFetch(url, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { flights: [], degraded: false, error: '' });
    }
    const denied = await originalFetch(url, { headers });
    assert.equal(denied.status, 429);
    assert.equal(Number(denied.headers.get('Retry-After')), 60);
    now += 59_999;
    assert.equal((await originalFetch(url, { headers })).status, 429);
    now += 1;
    assert.equal((await originalFetch(url, { headers })).status, 200);
    assert.equal(feeds().length, 1);
  } finally {
    Date.now = realNow;
    await app.close();
  }
});

test('native flight and news budgets remain independent and both reset', async () => {
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  const paths = [PATH, '/api/aviation/v1/list-aviation-news'];
  for (const path of paths) {
    for (let i = 0; i < 30; i++) {
      assert.equal(await checkEndpointRateLimit(request(), path, {}), null);
    }
    assert.equal((await checkEndpointRateLimit(request(), path, {}))?.status, 429);
  }
  __resetRateLimitForTest();
  for (const path of paths) {
    assert.equal(await checkEndpointRateLimit(request(), path, {}), null);
  }
  assert.equal(calls.length, 0);
});

test('cloud policy sends30/min to Redis and rejects the31st request', async () => {
  const transport = globalThis.fetch;
  let admitted = 0;
  const wire: { init?: RequestInit }[] = [];
  globalThis.fetch = (async (input, init) => {
    wire.push({ init });
    const response = await transport(input, init);
    const commands = init?.body ? JSON.parse(String(init.body)) : [];
    if (!Array.isArray(commands[0])) return response;
    const result = await response.json();
    for (let i = 0; i < commands.length; i++) if (String(commands[i][0]).toUpperCase() === 'EVALSHA') result[i] = { result: [30 - ++admitted, 30] };
    return Response.json(result);
  }) as typeof fetch;
  for (let i = 0; i < 30; i++) assert.equal((await gateway(request())).status, 200);
  const denied = await gateway(request());
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers.get('Retry-After')) > 0);
  const sent = readLimiterRequest(wire);
  assert.equal(sent?.tokens, 30);
  assert.equal(sent?.windowMs, 60000);
  assert.ok(sent?.keys.some((key: string) => key.includes(PATH)));
  assert.equal(feeds().length, 1);
});

test('cloud and Docker fail closed on missing or failing store', async () => {
  for (const mode of ['', 'docker']) {
    process.env.LOCAL_API_MODE = mode;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRateLimitForTest();
    assert.equal((await gateway(request())).status, 503);
  }
  redis = installRedis({});
  __resetRateLimitForTest();
  globalThis.fetch = (async () => { throw new Error('Synthetic store outage'); }) as typeof fetch;
  assert.equal((await gateway(request())).status, 503);
  assert.equal(feeds().length, 0);
});

async function installMcpFixture(outage = false) {
  const { signInternalMcpRequest, buildInternalMcpHeaders } = await import('../server/_shared/mcp-internal-hmac.ts');
  process.env.MCP_INTERNAL_HMAC_SECRET = 'synthetic-mcp-flight-secret-32-bytes';
  process.env.CONVEX_SITE_URL = 'https://convex.example';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'synthetic-convex-secret';
  const transport = globalThis.fetch;
  let admissions = 0;
  const wire: { init?: RequestInit }[] = [];
  const events: { status: number; reason: string }[] = [];
  const pending: Promise<unknown>[] = [];
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'synthetic-token';
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.axiom.co') {
      events.push(...JSON.parse(String(init?.body)));
      return Response.json({});
    }
    if (url.hostname === 'convex.example') return Response.json({ planKey: 'pro', features: { tier: 1, mcpAccess: true, apiAccess: false, apiRateLimit: 60 }, validUntil: Date.now() + 86400000 });
    if (url.hostname !== 'redis.example') return transport(input, init);
    const commands = init?.body ? JSON.parse(String(init.body)) : [];
    if (!Array.isArray(commands[0])) return transport(input, init);
    if (commands.some((command: string[]) => String(command[1]).startsWith('internal-mcp-replay:'))) return Response.json(commands.map(() => ({ result: 'OK' })));
    wire.push({ init });
    if (commands.some((command: string[]) => command[0].toUpperCase() === 'EVALSHA')) {
      if (outage) throw new Error('Synthetic endpoint limiter outage');
      return Response.json(commands.map(() => ({ result: [30 - ++admissions, 30] })));
    }
    return transport(input, init);
  }) as typeof fetch;
  return {
    wire,
    events,
    ctx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } },
    settled: () => Promise.all(pending),
    admissions: () => admissions,
    signed: async () => {
      const url = request().url;
      const signed = await signInternalMcpRequest({ method: 'GET', url, body: '', userId: 'user_flights_pro', secret: process.env.MCP_INTERNAL_HMAC_SECRET! });
      const headers = new Headers(buildInternalMcpHeaders(signed));
      const { TRUSTED_USER_ID_HEADER } = await import('../server/_shared/mcp-internal-hmac.ts');
      headers.set(TRUSTED_USER_ID_HEADER, 'injected_bucket');
      return new Request(url, { headers });
    },
  };
}

test('verified MCP flight searches use the30/min verified user bucket', async () => {
  const fixture = await installMcpFixture();
  for (let i = 0; i < 30; i++) assert.equal((await gateway(await fixture.signed())).status, 200);
  const denied = await gateway(await fixture.signed(), fixture.ctx);
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers.get('Retry-After')) > 0);
  assert.deepEqual(await denied.json(), { error: 'Too many requests' });
  assert.equal(denied.headers.get('RateLimit-Limit'), '30');
  assert.equal(fixture.admissions(), 31);
  const sent = readLimiterRequest(fixture.wire);
  assert.equal(sent?.tokens, 30);
  assert.equal(sent?.windowMs, 60000);
  assert.ok(sent?.keys.some((key: string) => key.includes('user_flights_pro')));
  assert.ok(sent?.keys.every((key: string) => !key.includes('injected_bucket')));
  assert.equal(feeds().length, 1);
  await fixture.settled();
  assert.deepEqual(fixture.events.map(({ status, reason }) => ({ status, reason })), [{ status: 429, reason: 'rate_limit_429_endpoint' }]);
});

test('verified MCP fails closed after valid replay and entitlement if endpoint store fails', async () => {
  const fixture = await installMcpFixture(true);
  const response = await gateway(await fixture.signed(), fixture.ctx);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Rate-limit service temporarily unavailable' });
  assert.equal(response.headers.get('Retry-After'), '5');
  assert.equal(response.headers.get('X-RateLimit-Mode'), 'degraded');
  assert.equal(feeds().length, 0);
  await fixture.settled();
  assert.deepEqual(fixture.events.map(({ status, reason }) => ({ status, reason })), [{ status: 503, reason: 'rate_limit_degraded' }]);
});

test('unsigned trusted-marker spoof cannot create a verified MCP admission', async () => {
  const fixture = await installMcpFixture();
  const { INTERNAL_MCP_VERIFIED_HEADER, TRUSTED_USER_ID_HEADER } = await import('../server/_shared/mcp-internal-hmac.ts');
  const spoof = new Request(request().url, { headers: { [INTERNAL_MCP_VERIFIED_HEADER]: 'spoofed', [TRUSTED_USER_ID_HEADER]: 'user_flights_pro' } });
  assert.equal((await gateway(spoof)).status, 401);
  assert.equal(fixture.admissions(), 0);
  assert.equal(feeds().length, 0);
});

test('real relay shopping handler uses the fixed upstream once and preserves round-trip filters', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const helpers = source.slice(source.indexOf('const GF_SHOPPING_URL ='), source.indexOf('function buildDateFilters('));
  const handler = source.slice(source.indexOf('async function handleGoogleFlightsSearch('), source.indexOf('async function handleGoogleFlightsDates('));
  const upstream: { url: string; init: RequestInit }[] = [];
  const flights = [{ legs: [], price: 123, durationMinutes: 60, stops: 0 }];
  const relay = runInNewContext(helpers + handler + '\nhandleGoogleFlightsSearch', {
    URL, Date, AbortSignal, process: { env: {} }, console,
    incrementRelayMetric() {}, recordRelayOutcome() {}, parseGfFlights: () => flights,
    fetch: async (url: string, init: RequestInit) => { upstream.push({ url, init }); return new Response('synthetic shopping result'); },
  }) as (req: { url: string }, res: { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }) => Promise<void>;
  const transport = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'relay.example') return transport(input, init);
    let status = 0; let headers: Record<string, string> = {}; let body = '';
    await relay({ url: url.pathname + url.search }, { writeHead(code, value) { status = code; headers = value; }, end(value) { body = value; } });
    return new Response(body, { status, headers });
  }) as typeof fetch;
  const query = { departureDate: '2028-02-29', returnDate: '2028-02-29', cabinClass: 'business', maxStops: '1', sortBy: 'departure', departureWindow: '0-24', passengers: 3, airlines: ['BA', 'U2'] };
  assert.deepEqual(await read(query), { flights, degraded: false, error: '' });
  assert.deepEqual(await read(query), { flights, degraded: false, error: '' });
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0]!.url, 'https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults');
  assert.equal(upstream[0]!.init.method, 'POST');
  const filters = JSON.parse(JSON.parse(new URLSearchParams(String(upstream[0]!.init.body)).get('f.req')!)[1]);
  assert.equal(filters[1][2], 1);
  assert.equal(filters[1][5], 3);
  assert.deepEqual(filters[1][6], [3, 0, 0, 0]);
  assert.equal(filters[2], 3);
  const segments = filters[1][13];
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map((segment: unknown[]) => [segment[0], segment[1], segment[2], segment[3], segment[4], segment[6]]), [
    [[[["DXB", 0]]], [[["LHR", 0]]], [0, 24, null, null], 2, ['BA', 'U2'], '2028-02-29'],
    [[[["LHR", 0]]], [[["DXB", 0]]], [0, 24, null, null], 2, ['BA', 'U2'], '2028-02-29'],
  ]);
});
test('upstream failure remains degraded and is not cached as a successful search', async () => {
  const transport = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input)).hostname !== 'relay.example') return transport(input, init);
    attempts++;
    return attempts === 1 ? new Response('failure', { status: 502 }) : Response.json({ flights: [] });
  }) as typeof fetch;
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const failed = await read();
    assert.equal(failed.degraded, true);
    assert.deepEqual(failed.flights, []);
    assert.equal((await read()).degraded, true);
    assert.equal(attempts, 1, 'existing short negative cache prevents a retry storm');
    now += 30_001;
    assert.equal((await read()).degraded, false);
    await read();
    assert.equal(attempts, 2);
  } finally {
    Date.now = realNow;
  }
});
