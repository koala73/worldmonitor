import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { listAviationNews } from '../server/worldmonitor/aviation/v1/list-aviation-news.ts';
import { ApiError, createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler.ts';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { __resetRateLimitForTest } from '../server/_shared/rate-limit.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { readLimiterRequest } from './helpers/upstash-limiter-wire.mjs';
import { issueSessionToken } from '../api/_session.js';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const PATH = '/api/aviation/v1/list-aviation-news';
const gateway = createDomainGateway(createAviationServiceRoutes(aviationHandler, serverOptions));
let redis: ReturnType<typeof installRedis>;
let calls: URL[];
let session: string;
beforeEach(async () => {
  delete process.env.WORLDMONITOR_VALID_KEYS;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  process.env.WM_SESSION_SECRET = 'synthetic-aviation-news-session-secret';
  session = (await issueSessionToken()).token;
  __resetRateLimitForTest();
  redis = installRedis({});
  calls = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.hostname === 'redis.example') return redis.fetchImpl(input, init);
    const now = new Date().toUTCString();
    const old = new Date(Date.now() - 48 * 3600000).toUTCString();
    return new Response(`<rss><channel><item><title>Emirates DXB expansion</title><link>https://news.example/emirates</link><pubDate>${now}</pubDate></item><item><title>Qantas SYD expansion</title><link>https://news.example/qantas</link><pubDate>${now}</pubDate></item><item><title>Qantas older update</title><link>https://news.example/old</link><pubDate>${old}</pubDate></item></channel></rss>`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});
const request = (entities: string[] = []) => {
  const params = new URLSearchParams({ window_hours: '24', max_items: '20' });
  for (const entity of entities) params.append('entities', entity);
  return new Request(`https://api.worldmonitor.app${PATH}?${params}`, { headers: { 'X-WorldMonitor-Key': session, 'x-vercel-forwarded-for': '192.0.2.7' } });
};
const ctx = () => ({ request: request(), pathParams: {}, headers: {} });
const feeds = () => calls.filter(url => url.hostname !== 'redis.example');
const read = (entities: string[], windowHours = 24, maxItems = 20) => listAviationNews(ctx(), { entities, windowHours, maxItems });

test('rejects oversized entities and too many entities before discovery I/O', async () => {
  for (const entities of [['x'.repeat(129)], Array.from({length:11}, (_, i) => `airline${i}`)]) {
    await assert.rejects(read(entities), (error: unknown) => error instanceof ApiError && error.statusCode === 400);
    assert.equal(calls.length, 0);
  }
});
test('shares one feed snapshot across entity sets, windows and item limits', async () => {
  const first = await read(['Emirates'], 24, 1);
  assert.equal(first.items.length, 1);
  assert.deepEqual(first.items[0]!.matchedEntities, ['EMIRATES']);
  const second = await read(['Qantas'], 24, 3);
  assert.equal(second.items.length, 3);
  assert.ok(second.items.every(item => item.title === 'Qantas SYD expansion'));
  const broad = await read([], 72, 50);
  assert.equal(broad.items.length, 27);
  assert.equal(feeds().length, 9);
  const keys = [...redis.redis.keys()].filter(key => key.startsWith('aviation:news:'));
  assert.equal(keys.length, 1);
  assert.ok(keys[0]!.length < 64);
  assert.ok(!keys[0]!.includes('EMIRATES'));
});
test('keeps free-form Unicode entities valid and isolates matched entity output', async () => {
  await read(['日本航空 東京', 'DXB-LHR', 'x'.repeat(128)]);
  const first = await read(['Emirates', 'DXB']);
  const second = await read(['DXB', 'Emirates']);
  assert.deepEqual(first.items[0]!.matchedEntities, ['EMIRATES', 'DXB']);
  assert.deepEqual(second.items[0]!.matchedEntities, ['DXB', 'EMIRATES']);
  assert.equal(feeds().length, 9);
});
test('actual anonymous-session gateway rejects an oversized entity before feeds', async () => {
  assert.equal((await gateway(request(['x'.repeat(129)]))).status, 400);
  assert.equal(feeds().length, 0);
  assert.ok([...redis.redis.keys()].every(key => !key.startsWith('aviation:news:')));
});
test('missing or failing limiter store fails closed before feeds', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  assert.equal((await gateway(request(['Emirates']))).status, 503);
  assert.equal(feeds().length, 0);
  redis = installRedis({}); __resetRateLimitForTest();
  globalThis.fetch = (async () => { throw new Error('Synthetic store outage'); }) as typeof fetch;
  assert.equal((await gateway(request(['Emirates']))).status, 503);
});
test('30 public queries share feeds; the 31st is rejected', async () => {
  const transport = globalThis.fetch; let admitted = 0;
  const wire: { init?: RequestInit }[] = [];
  globalThis.fetch = (async (input, init) => {
    wire.push({ init });
    const response = await transport(input, init);
    const commands = init?.body ? JSON.parse(String(init.body)) : [];
    if (!Array.isArray(commands[0])) return response;
    const result = await response.json();
    for (let i = 0; i < commands.length; i++) if (String(commands[i][0]).toUpperCase() === 'EVALSHA') result[i] = {result:[30 - ++admitted,60]};
    return Response.json(result);
  }) as typeof fetch;
  for (let i = 0; i < 30; i++) assert.equal((await gateway(request([`unique${i}`]))).status, 200);
  const denied = await gateway(request(['unique30']));
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers.get('Retry-After')) > 0);
  assert.equal(feeds().length, 9);
  const sent = readLimiterRequest(wire);
  assert.equal(sent?.tokens, 30);
  assert.equal(sent?.windowMs, 60000);
  assert.ok(sent?.keys.some((key: string) => key.includes(PATH)));
});

test('coalesces concurrent cold queries in one process', async () => {
  const [first, second] = await Promise.all([read(['Emirates']), read(['Qantas'])]);
  assert.ok(first.items.every(item => item.title.includes('Emirates')));
  assert.ok(second.items.every(item => item.title.includes('Qantas')));
  assert.equal(feeds().length, 9);
});
test('preserves the current gateway omitted/zero numeric behavior', async () => {
  const req = request(['Emirates']);
  const url = new URL(req.url); url.searchParams.delete('window_hours'); url.searchParams.delete('max_items');
  const response = await gateway(new Request(url, req));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, []);
});
test('bounds the shared snapshot to the existing 30 items per feed', async () => {
  const transport = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input)).hostname === 'redis.example') return transport(input, init);
    return new Response(`<rss><channel>${Array.from({length:40}, (_, i) => `<item><title>Emirates item ${i}</title><link>https://news.example/${i}</link></item>`).join('')}</channel></rss>`);
  }) as typeof fetch;
  assert.equal((await read([], 24, 50)).items.length, 50);
  const entry = [...redis.redis.entries()].find(([key]) => key.startsWith('aviation:news:'));
  assert.ok(entry);
  assert.equal(JSON.parse(entry[1]).items.length, 270);
});


test('plain-text snippets preserve normal text and remove residual tag openings', async () => {
  const transport = globalThis.fetch;
  const descriptions = [
    '<![CDATA[Normal airline & route update]]>',
    '<![CDATA[<b>Update</b> <b>safe</b> <script]]>',
    '<![CDATA[<<script>script>alert(1)</script>]]>',
    '&lt;b&gt;Decoded update&lt;/b&gt; &lt;script',
    '<![CDATA[&lt;script&gt;encoded text&lt;/script&gt;]]>',
    '<![CDATA[Fuel < 5 and passengers > 2]]>',
    '<![CDATA[Fuel < 5]]>',
    '&amp;lt;script&amp;gt;nested encoding',
    'Airline &gt; forecast',
    `<![CDATA[<b>${'x'.repeat(205)}</b>]]>`,
  ];
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input)).hostname === 'redis.example') return transport(input, init);
    return new Response(`<rss><channel>${descriptions.map((description, i) => `<item><title>Emirates case ${i}</title><link>https://news.example/${i}</link><description>${description}</description></item>`).join('')}</channel></rss>`);
  }) as typeof fetch;
  const result = await read(['Emirates'], 24, 50);
  assert.equal(result.items.length, 50);
  const expected = ['Normal airline & route update', 'Update safe ', 'script>alert(1)', 'Decoded update ', '&lt;script&gt;encoded text&lt;/script&gt;', 'Fuel  2', 'Fuel ', '&lt;script&gt;nested encoding', 'Airline > forecast', 'x'.repeat(200)];
  for (let i = 0; i < expected.length; i++) {
    assert.ok(result.items.some(item => item.title === `Emirates case ${i}`));
    assert.deepEqual(result.items.filter(item => item.title === `Emirates case ${i}`).map(item => item.snippet), Array(result.items.filter(item => item.title === `Emirates case ${i}`).length).fill(expected[i]));
  }
  assert.ok(result.items.every(item => !item.snippet.includes('<')));
});
