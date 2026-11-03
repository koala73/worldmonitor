import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { SearchGoogleDatesRequest } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { searchGoogleDates } from '../server/worldmonitor/aviation/v1/search-google-dates.ts';
import { ValidationError, createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler.ts';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { __resetRateLimitForTest } from '../server/_shared/rate-limit.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { readLimiterRequest } from './helpers/upstash-limiter-wire.mjs';
import { decodeTfs, loadGoogleFlightsRelay, pageFixture, relayTransport, resultsPage } from './helpers/google-flights-page.mts';
import { issueSessionToken } from '../api/_session.js';
import { RpcValidationError, assertToolFetchOk } from '../api/mcp/billing-denial.ts';
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
  const invalid = [{ origin: 'X'.repeat(1000) }, { startDate: '' }, { startDate: '2026-2-01' }, { startDate: '2026-02-29' }, { destination: 'A/B' }, { startDate: '2026-02-30' }, { endDate: '2026-09-30' }, { endDate: '2027-10-02' }, { endDate: '2026-11-01' }, { cabinClass: 'arbitrary' }, { maxStops: '3' }, { departureWindow: '25-26' }, { departureWindow: '20-6' }, { airlines: ['BAD'] }, { airlines: Array(11).fill('BA') }, { isRoundTrip: true, tripDuration: 0 }, { isRoundTrip: true, tripDuration: 366 }];
  for (const value of invalid) {
    await assert.rejects(read(value as Partial<typeof defaults>), (error: unknown) => error instanceof ValidationError && error.violations.length === 1);
    assert.equal(calls.length, 0);
  }
});
test('canonical equivalents share a bounded hashed key and relay query', async () => {
  await read({ origin: ' dxb ', cabinClass: '', maxStops: '', airlines: ['ba', 'AA', 'BA'], departureWindow: '06-20', passengers: 99 });
  await read({ cabinClass: 'ECONOMY', maxStops: 'ANY', airlines: ['AA', 'BA'], departureWindow: '6-20', passengers: 9 });
  await read({ passengers: 1.1 });
  await read({ passengers: 1.9 });
  assert.equal(feeds().length, 2);
  assert.deepEqual(feeds()[0]!.searchParams.getAll('airlines'), ['AA', 'BA']);
  const keys = [...redis.redis.keys()].filter(key => key.startsWith('aviation:gf-dates:'));
  assert.equal(keys.length, 2);
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

// Execute the relay's real Google Flights section without starting its daemon or live feeds.
function installPageRelay(provider: (url: URL, init?: RequestInit) => Promise<Response>) {
  const outcomes: string[] = [];
  const pages: URL[] = [];
  const relay = loadGoogleFlightsRelay((async (input, init) => {
    const url = new URL(String(input));
    pages.push(url);
    return provider(url, init);
  }) as typeof fetch, outcomes);
  const transport = relayTransport(relay.dates, (async (input, init) => redis.fetchImpl(input, init)) as typeof fetch);
  globalThis.fetch = (async (input, init) => {
    calls.push(new URL(String(input)));
    return transport(input, init);
  }) as typeof fetch;
  return { outcomes, pages };
}

const legDate = (url: URL) => decodeTfs(url).legs[0]!.date;
const pricedDay = (url: URL) => new Response(resultsPage([{ price: 100 + Number(legDate(url).slice(8)), date: legDate(url) }]));
const month = { startDate: '2026-11-01', endDate: '2026-12-01' };
const cachedGrids = () => [...redis.redis.keys()].filter(key => key.startsWith('aviation:gf-dates:'));

test('a 31-day search reads one results page per day, six at a time, in date order', async () => {
  let active = 0;
  let peak = 0;
  const relay = installPageRelay(async (url) => {
    active++;
    peak = Math.max(peak, active);
    // Later days answer first, so ordering cannot come from completion order.
    await new Promise(resolve => setTimeout(resolve, 60 - Number(legDate(url).slice(8))));
    active--;
    return pricedDay(url);
  });
  const result = await read(month);
  assert.equal(peak, 6);
  assert.equal(relay.pages.length, 31);
  assert.ok(relay.pages.every(url => url.origin + url.pathname === 'https://www.google.com/travel/flights/search'));
  assert.equal(result.degraded, false);
  assert.equal(result.dates.length, 31);
  assert.deepEqual(result.dates.slice(0, 2), [{ date: '2026-11-01', returnDate: '', price: 101 }, { date: '2026-11-02', returnDate: '', price: 102 }]);
  assert.deepEqual(result.dates.map(row => row.date), result.dates.map(row => row.date).sort());
  assert.deepEqual(await read(month), result);
  assert.equal(relay.pages.length, 31, 'a complete grid is cached');
});

test('concurrent date searches share one relay-wide cap on pages in flight', async () => {
  let active = 0;
  let peak = 0;
  const relay = installPageRelay(async (url) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
    return pricedDay(url);
  });
  const results = await Promise.all([
    read(month),
    read({ ...month, origin: 'JFK' }),
    read({ ...month, origin: 'CDG' }),
  ]);
  assert.equal(peak, 8);
  assert.equal(relay.pages.length, 93);
  assert.ok(results.every(result => !result.degraded && result.dates.length === 31));
});

test('a range over 31 days is rejected at the edge and at the relay', async () => {
  const relay = installPageRelay(async url => pricedDay(url));
  assert.equal((await gateway(request({ start_date: '2026-11-01', end_date: '2026-12-02' }))).status, 400);
  assert.equal(relay.pages.length, 0);
  const direct = loadGoogleFlightsRelay((async () => { throw new Error('no provider call expected'); }) as typeof fetch);
  let status = 0; let body = '';
  await direct.dates({ url: '/google-flights/search-dates?origin=JFK&destination=LHR&start_date=2026-11-01&end_date=2026-12-02' }, { writeHead(code) { status = code; }, end(value) { body = value; } });
  assert.equal(status, 400);
  assert.match(JSON.parse(body).error, /1 to 31 days/);
});

test('an MCP caller sees which argument broke the date range, not an internal error', async () => {
  const response = await gateway(request({ start_date: '2026-11-01', end_date: '2026-12-20' }));
  await assert.rejects(assertToolFetchOk(response, 'search-google-dates'), (error: unknown) => {
    assert.ok(error instanceof RpcValidationError);
    assert.deepEqual(error.violations, [{ field: 'end_date', description: 'Date range must contain 1 to 31 days' }]);
    return true;
  });
});

test('round-trip days carry the return leg and every filter in tfs; the window picks the fare', async () => {
  const relay = installPageRelay(async (url) => new Response(resultsPage([
    { price: 100, departure: [6, 0], date: legDate(url) },
    { price: 300, departure: [19, 0], date: legDate(url) },
  ])));
  const result = await read({ startDate: '2026-11-01', endDate: '2026-11-02', isRoundTrip: true, tripDuration: 7, cabinClass: 'business', maxStops: '1', airlines: ['U2', 'BA'], passengers: 3, departureWindow: '18-24' });
  assert.deepEqual(result.dates, [
    { date: '2026-11-01', returnDate: '2026-11-08', price: 300 },
    { date: '2026-11-02', returnDate: '2026-11-09', price: 300 },
  ]);
  assert.deepEqual(decodeTfs(relay.pages[0]!), {
    legs: [
      { date: '2026-11-01', maxStops: 1, airlines: ['BA', 'U2'], from: 'DXB', to: 'LHR' },
      { date: '2026-11-08', maxStops: 1, airlines: ['BA', 'U2'], from: 'LHR', to: 'DXB' },
    ],
    adults: 3,
    seat: 3,
    trip: 1,
  });
});

test('a day with no service is absent from a complete grid, not a failure', async () => {
  installPageRelay(async url => new Response(legDate(url) === '2026-11-02' ? pageFixture('bti-lhr-no-service.html') : resultsPage([{ price: 100, date: legDate(url) }])));
  const result = await read({ startDate: '2026-11-01', endDate: '2026-11-03' });
  assert.equal(result.degraded, false);
  assert.deepEqual(result.dates.map(row => row.date), ['2026-11-01', '2026-11-03']);
});

test('failed days keep the answered days, are not cached as a grid, and recover', async () => {
  let fail = true;
  const relay = installPageRelay(async (url) => {
    if (fail && legDate(url) === '2026-11-02') throw new DOMException('synthetic page timeout', 'TimeoutError');
    return pricedDay(url);
  });
  const partial = await read(month);
  assert.equal(partial.degraded, true);
  assert.equal(partial.dates.length, 30);
  assert.equal(cachedGrids().length, 0);
  assert.ok(relay.outcomes.includes('timeout'));
  fail = false;
  const recovered = await read(month);
  assert.equal(recovered.degraded, false);
  assert.equal(recovered.dates.length, 31);
});

test('each failed day is counted once, whether other days answer or none do', async () => {
  let failAll = false;
  const relay = installPageRelay(async (url) => {
    if (failAll || legDate(url) === '2026-11-02') throw new TypeError('fetch failed');
    return pricedDay(url);
  });
  const range = { startDate: '2026-11-01', endDate: '2026-11-03' };
  assert.equal((await read(range)).dates.length, 2);
  assert.deepEqual(relay.outcomes.filter(outcome => outcome !== 'success'), ['terminalFailure', 'fallback']);
  relay.outcomes.length = 0;
  failAll = true;
  const failed = await read({ startDate: '2026-11-05', endDate: '2026-11-07' });
  assert.match(failed.error, /^relay returned 502: fetch failed/);
  assert.deepEqual(relay.outcomes, ['terminalFailure', 'terminalFailure', 'terminalFailure']);
});

test('a 429 arms the cooldown, answers degraded, and suppresses provider calls', async () => {
  const relay = installPageRelay(async () => new Response('', { status: 429 }));
  const first = await read(month);
  assert.equal(first.degraded, true);
  assert.equal(first.error, 'provider cooldown');
  const pagesAfterFirst = relay.pages.length;
  assert.ok(pagesAfterFirst <= 6, 'only the pages already in flight reach the provider');
  const second = await read(month);
  assert.equal(second.degraded, true);
  assert.equal(second.error, 'provider cooldown');
  assert.equal(relay.pages.length, pagesAfterFirst);
  assert.equal(cachedGrids().length, 0);
});

test('when every day fails the first reason reaches the caller and recovery is not poisoned', async () => {
  let fail = true;
  installPageRelay(async (url) => {
    if (!fail) return pricedDay(url);
    return Number(legDate(url).slice(8)) % 2
      ? new Response('', { status: 503 })
      : new Response(new ReadableStream({ start(controller) { controller.error(new Error('synthetic body failure')); } }));
  });
  const failed = await read(month);
  assert.equal(failed.degraded, true);
  assert.deepEqual(failed.dates, []);
  assert.match(failed.error, /^relay returned 502: (Google Flights returned 503|synthetic body failure)/);
  assert.equal(cachedGrids().length, 0);
  fail = false;
  assert.equal((await read(month)).dates.length, 31);
});

test('a page without the results block is a failure, never an empty grid', async () => {
  let challenge = true;
  const relay = installPageRelay(async url => (challenge ? new Response('<html><body>Our systems have detected unusual traffic</body></html>') : pricedDay(url)));
  const failed = await read({ startDate: '2026-11-15', endDate: '2026-11-15' });
  assert.equal(failed.degraded, true);
  assert.deepEqual(failed.dates, []);
  assert.match(failed.error, /^relay returned 502: Google Flights returned a page without flight results/);
  assert.deepEqual(relay.outcomes, ['terminalFailure']);
  assert.equal(cachedGrids().length, 0);
  challenge = false;
  assert.equal((await read({ startDate: '2026-11-15', endDate: '2026-11-15' })).dates.length, 1);
});

test('a Google error response on the results page surfaces as a rejection', async () => {
  installPageRelay(async () => new Response(pageFixture('jfk-lhr-past-date.html')));
  const result = await read({ startDate: '2026-11-15', endDate: '2026-11-16' });
  assert.equal(result.degraded, true);
  assert.deepEqual(result.dates, []);
  assert.match(result.error, /^relay returned 502: Google Flights rejected the search/);
});
