import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, test } from 'node:test';
import type { SearchGoogleDatesRequest } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { searchGoogleDates } from '../server/worldmonitor/aviation/v1/search-google-dates.ts';
import { ApiError, createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler.ts';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { __resetRateLimitForTest } from '../server/_shared/rate-limit.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { readLimiterRequest } from './helpers/upstash-limiter-wire.mjs';
import { issueSessionToken } from '../api/_session.js';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const PATH = '/api/aviation/v1/search-google-dates';
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
    return Response.json({ dates: [{ date: '2026-10-01', price: 100 }], partial: false });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});
const defaults: SearchGoogleDatesRequest = { origin: 'DXB', destination: 'LHR', startDate: '2026-10-01', endDate: '2026-10-31', tripDuration: 0, isRoundTrip: false, cabinClass: '', maxStops: '', departureWindow: '', airlines: [], sortByPrice: false, passengers: 1 };
const request = (overrides: Record<string, string> = {}) => new Request(`https://api.worldmonitor.app${PATH}?${new URLSearchParams({ origin: 'DXB', destination: 'LHR', start_date: '2026-10-01', end_date: '2026-10-31', ...overrides })}`, { headers: { 'X-WorldMonitor-Key': session, 'x-vercel-forwarded-for': '192.0.2.8' } });
const ctx = () => ({ request: request(), pathParams: {}, headers: {} });
const feeds = () => calls.filter(url => url.hostname !== 'redis.example');
const read = (overrides: Partial<typeof defaults> = {}) => searchGoogleDates(ctx(), { ...defaults, ...overrides });

test('rejects malformed or oversized date-grid input before cache or relay work', async () => {
  const invalid = [{ origin: 'X'.repeat(1000) }, { startDate: '' }, { startDate: '2026-2-01' }, { startDate: '2026-02-29' }, { destination: 'A/B' }, { startDate: '2026-02-30' }, { endDate: '2026-09-30' }, { endDate: '2027-10-02' }, { cabinClass: 'arbitrary' }, { maxStops: '3' }, { departureWindow: '25-26' }, { departureWindow: '20-6' }, { airlines: ['BAD'] }, { airlines: Array(11).fill('BA') }, { isRoundTrip: true, tripDuration: 0 }, { isRoundTrip: true, tripDuration: 366 }];
  for (const value of invalid) {
    await assert.rejects(read(value as Partial<typeof defaults>), (error: unknown) => error instanceof ApiError && error.statusCode === 400);
    assert.equal(calls.length, 0);
  }
});
test('canonical equivalents share a bounded hashed key and relay query', async () => {
  await read({ origin: ' dxb ', cabinClass: '', maxStops: '', airlines: ['ba', 'AA', 'BA'], departureWindow: '06-20', passengers: 99 });
  await read({ cabinClass: 'ECONOMY', maxStops: 'ANY', airlines: ['AA', 'BA'], departureWindow: '6-20', passengers: 9 });
  assert.equal(feeds().length, 1);
  assert.deepEqual(feeds()[0]!.searchParams.getAll('airlines'), ['AA', 'BA']);
  const keys = [...redis.redis.keys()].filter(key => key.startsWith('aviation:gf-dates:'));
  assert.equal(keys.length, 1);
  assert.match(keys[0]!, /^aviation:gf-dates:[a-f0-9]{64}:v3$/);
});
test('gateway invalid input is400 and missing limiter store is503 without relay calls', async () => {
  assert.equal((await gateway(request({ origin: 'TOOLONG' }))).status, 400);
  assert.equal(feeds().length, 0);
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRateLimitForTest();
  assert.equal((await gateway(request())).status, 503);
  assert.equal(feeds().length, 0);
});
test('actual native sidecar requires its token before the date-search gateway', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const providerFetch = globalThis.fetch;
  const { createLocalApiServer } = await import('../src-tauri/sidecar/local-api-server.mjs');
  // Sidecar import installs its network transport; keep upstream I/O synthetic.
  globalThis.fetch = providerFetch;
  const root = await mkdtemp(join(tmpdir(), 'google-dates-sidecar-'));
  await mkdir(join(root, 'aviation/v1'), { recursive: true });
  const serviceUrl = new URL('../src/generated/server/worldmonitor/aviation/v1/service_server.ts', import.meta.url).href;
  const gatewayUrl = new URL('../server/gateway.ts', import.meta.url).href;
  const handlerUrl = new URL('../server/worldmonitor/aviation/v1/handler.ts', import.meta.url).href;
  await writeFile(join(root, 'aviation/v1/search-google-dates.js'), `import {createAviationServiceRoutes} from ${JSON.stringify(serviceUrl)}; import {createDomainGateway,serverOptions} from ${JSON.stringify(gatewayUrl)}; import {aviationHandler} from ${JSON.stringify(handlerUrl)}; export default createDomainGateway(createAviationServiceRoutes(aviationHandler,serverOptions));`);
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
    const url = `http://127.0.0.1:${port}${PATH}?origin=DXB&destination=LHR&start_date=2026-10-01&end_date=2026-10-31`;
    assert.equal((await originalFetch(url, { headers: { 'x-worldmonitor-local-token': 'invalid' } })).status, 401);
    const headers = { 'x-worldmonitor-local-token': process.env.LOCAL_API_TOKEN, 'X-WorldMonitor-Key': session };
    for (let i = 0; i < 10; i++) {
      const response = await originalFetch(url, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { dates: [{ date: '2026-10-01', price: 100 }], degraded: false, error: '' });
    }
    const denied = await originalFetch(url, { headers });
    assert.equal(denied.status, 429);
    assert.equal(Number(denied.headers.get('Retry-After')), 60);
    now += 59_999;
    assert.equal((await originalFetch(url, { headers })).status, 429);
    now += 1;
    const recovered = await originalFetch(url, { headers });
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { dates: [{ date: '2026-10-01', price: 100 }], degraded: false, error: '' });
    assert.equal(feeds().length, 1);
  } finally {
    Date.now = realNow;
    await app.close();
  }
});

test('cloud policy sends10/min to Redis and rejects the11th request', async () => {
  const transport = globalThis.fetch;
  let admitted = 0;
  const wire: { init?: RequestInit }[] = [];
  globalThis.fetch = (async (input, init) => {
    wire.push({ init });
    const response = await transport(input, init);
    const commands = init?.body ? JSON.parse(String(init.body)) : [];
    if (!Array.isArray(commands[0])) return response;
    const result = await response.json();
    for (let i = 0; i < commands.length; i++) if (String(commands[i][0]).toUpperCase() === 'EVALSHA') result[i] = { result: [10 - ++admitted, 10] };
    return Response.json(result);
  }) as typeof fetch;
  for (let i = 0; i < 10; i++) assert.equal((await gateway(request())).status, 200);
  const denied = await gateway(request());
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers.get('Retry-After')) > 0);
  const sent = readLimiterRequest(wire);
  assert.equal(sent?.tokens, 10);
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

test('distinct effective options keep distinct keys; one-way duration is irrelevant', async () => {
  await read();
  await read({ tripDuration: 100 });
  assert.equal(feeds().length, 1);
  for (const option of [{ isRoundTrip: true, tripDuration: 7 }, { cabinClass: 'BUSINESS' }, { maxStops: 'NON_STOP' }, { sortByPrice: true }, { passengers: 2 }, { airlines: ['BA'] }, { departureWindow: '6-20' }]) await read(option);
  assert.equal(feeds().length, 8);
});

test('actual relay calendar handler makes at most6 chunks for accepted366-day range', async () => {
  let googleCalls = 0;
  installCalendarRelay((async (_input, init) => { googleCalls++; return calendarResponse(init); }) as typeof fetch);
  assert.equal((await gateway(request({ start_date: '2026-01-01', end_date: '2027-01-01' }))).status, 200);
  assert.equal(googleCalls, 6);
  assert.equal((await gateway(request({ start_date: '2026-01-01', end_date: '2027-01-02' }))).status, 400);
  assert.equal(googleCalls, 6);
});

test('valid leap day and supported aliases reach only the configured relay', async () => {
  await read({ startDate: '2028-02-29', endDate: '2028-02-29', maxStops: '0', cabinClass: 'business', departureWindow: '0-24', airlines: ['U2'] });
  const url = feeds()[0]!;
  assert.equal(url.origin, 'https://relay.example');
  assert.equal(url.pathname, '/google-flights/search-dates');
  assert.equal(url.searchParams.get('max_stops'), 'NON_STOP');
  assert.equal(url.searchParams.get('cabin_class'), 'BUSINESS');
  await read({ startDate: '2028-02-29', endDate: '2028-02-29', maxStops: 'NON_STOP', cabinClass: 'BUSINESS', departureWindow: '0-24', airlines: ['U2'] });
  assert.equal(feeds().length, 1);
});

async function installMcpFixture(outage = false) {
  const { signInternalMcpRequest, buildInternalMcpHeaders } = await import('../server/_shared/mcp-internal-hmac.ts');
  process.env.MCP_INTERNAL_HMAC_SECRET = 'synthetic-mcp-date-secret-32-bytes';
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
      return Response.json(commands.map(() => ({ result: [10 - ++admissions, 10] })));
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
      const signed = await signInternalMcpRequest({ method: 'GET', url, body: '', userId: 'user_dates_pro', secret: process.env.MCP_INTERNAL_HMAC_SECRET! });
      const headers = new Headers(buildInternalMcpHeaders(signed));
      const { TRUSTED_USER_ID_HEADER } = await import('../server/_shared/mcp-internal-hmac.ts');
      headers.set(TRUSTED_USER_ID_HEADER, 'injected_bucket');
      return new Request(url, { headers });
    },
  };
}

test('verified MCP date searches use the10/min verified user bucket', async () => {
  const fixture = await installMcpFixture();
  for (let i = 0; i < 10; i++) assert.equal((await gateway(await fixture.signed())).status, 200);
  const denied = await gateway(await fixture.signed(), fixture.ctx);
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers.get('Retry-After')) > 0);
  assert.deepEqual(await denied.json(), { error: 'Too many requests' });
  assert.equal(denied.headers.get('RateLimit-Limit'), '10');
  assert.equal(fixture.admissions(), 11);
  const sent = readLimiterRequest(fixture.wire);
  assert.equal(sent?.tokens, 10);
  assert.equal(sent?.windowMs, 60000);
  assert.ok(sent?.keys.some((key: string) => key.includes(':user:user_dates_pro')));
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
  const spoof = new Request(request().url, { headers: { [INTERNAL_MCP_VERIFIED_HEADER]: 'spoofed', [TRUSTED_USER_ID_HEADER]: 'user_dates_pro' } });
  assert.equal((await gateway(spoof)).status, 401);
  assert.equal(fixture.admissions(), 0);
  assert.equal(feeds().length, 0);
});

// Execute the relay's real Google functions without starting its daemon or live feeds.
function installCalendarRelay(provider: typeof fetch) {
  const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const start = source.indexOf('const GF_SHOPPING_URL =');
  const end = source.indexOf('// ─── Widget Agent', start);
  assert.ok(start >= 0 && end > start);
  const handle = runInNewContext(source.slice(start, end) + '\nhandleGoogleFlightsDates;', {
    URL, AbortSignal, process: { env: {} }, console: { warn() {}, error() {} },
    fetch: provider, incrementRelayMetric() {}, recordRelayOutcome() {},
    classifyUpstreamOutcome: () => 'timeout',
  });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === 'redis.example') return redis.fetchImpl(input, init);
    let status = 200;
    let headers: Record<string, string> = {};
    let body = '';
    await handle({ url: url.pathname + url.search }, {
      writeHead(code: number, values: Record<string, string>) { status = code; headers = values; },
      end(value: string) { body = value; },
    });
    return new Response(body, { status, headers });
  }) as typeof fetch;
}

function calendarResponse(init?: RequestInit) {
  const encoded = String(init?.body).slice('f.req='.length);
  const filters = JSON.parse(JSON.parse(decodeURIComponent(encoded))[1]);
  const [start, end] = filters[2] as [string, string];
  const rows = [];
  for (let day = Date.parse(start); day <= Date.parse(end); day += 86_400_000) {
    rows.push([new Date(day).toISOString().slice(0, 10), '', [[null, 100]]]);
  }
  return Response.json([[null, null, JSON.stringify([rows])]]);
}

const yearGrid = { startDate: '2026-10-01', endDate: '2027-10-01' };

test('366-day cold search completes six slow chunks concurrently in date order', async () => {
  let active = 0;
  let peak = 0;
  let count = 0;
  installCalendarRelay((async (_input, init) => {
    const index = count++;
    active++;
    peak = Math.max(peak, active);
    // Six sequential calls would exceed 30 seconds; reverse completion tests ordering.
    await new Promise(resolve => setTimeout(resolve, 6000 + (5 - index) * 20));
    active--;
    return calendarResponse(init);
  }) as typeof fetch);
  const started = Date.now();
  const pending = read(yearGrid);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(peak, 6, 'all six bounded chunks must start before the first completes');
  const result = await pending;
  assert.ok(Date.now() - started < 30_000);
  assert.equal(count, 6);
  assert.equal(result.degraded, false);
  assert.equal(result.dates.length, 366);
  assert.equal(new Set(result.dates.map(row => row.date)).size, 366);
  assert.equal(result.dates[0]?.date, yearGrid.startDate);
  assert.equal(result.dates.at(-1)?.date, yearGrid.endDate);
  assert.deepEqual(result.dates.map(row => row.date), result.dates.map(row => row.date).sort());
  assert.deepEqual(await read(yearGrid), result);
  assert.equal(count, 6, 'complete result is cached');
});

test('failed calendar chunks retain successes without caching a partial grid and recover', async () => {
  let count = 0;
  installCalendarRelay((async (_input, init) => {
    if (++count === 2) throw new DOMException('synthetic chunk timeout', 'TimeoutError');
    return calendarResponse(init);
  }) as typeof fetch);
  const partial = await read(yearGrid);
  assert.equal(partial.degraded, true);
  assert.equal(partial.dates.length, 305);
  assert.equal([...redis.redis.keys()].filter(key => key.startsWith('aviation:gf-dates:')).length, 0);
  const recovered = await read(yearGrid);
  assert.equal(recovered.degraded, false);
  assert.equal(recovered.dates.length, 366);
  assert.equal(count, 12);
});

test('calendar cooldown responses are degraded, do not cache, and suppress provider calls', async () => {
  let count = 0;
  installCalendarRelay((async () => { count++; return new Response('', { status: 429 }); }) as typeof fetch);
  assert.equal((await read()).degraded, true);
  const cooldown = await read();
  assert.equal(cooldown.degraded, true);
  assert.equal(cooldown.error, 'provider cooldown');
  assert.equal((await read(yearGrid)).degraded, true);
  assert.equal(count, 1);
  assert.equal([...redis.redis.keys()].filter(key => key.startsWith('aviation:gf-dates:')).length, 0);
});

test('all chunk failures and response-body failures cannot poison recovery', async () => {
  let count = 0;
  let fail = true;
  installCalendarRelay((async (_input, init) => {
    count++;
    if (fail) {
      if (count % 2 === 0) return new Response('', { status: 503 });
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('synthetic body failure')); } }));
    }
    return calendarResponse(init);
  }) as typeof fetch);
  const failed = await read(yearGrid);
  assert.equal(failed.degraded, true);
  assert.deepEqual(failed.dates, []);
  assert.equal(count, 6);
  assert.equal([...redis.redis.keys()].filter(key => key.startsWith('aviation:gf-dates:')).length, 0);
  fail = false;
  assert.equal((await read(yearGrid)).dates.length, 366);
  assert.equal(count, 12);
});

test('malformed successful calendar bodies are degraded, not cached, and recover', async () => {
  let count = 0;
  let malformed = true;
  installCalendarRelay((async (_input, init) => {
    count++;
    return malformed ? new Response(JSON.stringify([[null, null, JSON.stringify([[[null, '', [[null, 100]]]]])]])) : calendarResponse(init);
  }) as typeof fetch);
  const failed = await read(yearGrid);
  assert.equal(failed.degraded, true);
  assert.deepEqual(failed.dates, []);
  assert.equal([...redis.redis.keys()].filter(key => key.startsWith('aviation:gf-dates:')).length, 0);
  malformed = false;
  assert.equal((await read(yearGrid)).dates.length, 366);
  assert.equal(count, 12);
});
