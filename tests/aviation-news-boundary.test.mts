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

test('prewarmer snapshot serves filtered requests with no reader feed calls', async () => {
  const { seedAviationNews, NEWS_KEY, NEWS_TTL } = await import('../scripts/seed-aviation.mjs');
  assert.equal(NEWS_KEY, 'aviation:news:feeds:v2');
  assert.equal(NEWS_TTL, 2400);
  const snapshot = await seedAviationNews();
  redis.redis.set(NEWS_KEY, JSON.stringify(snapshot));
  calls = [];
  const recent = await read(['Qantas'], 24, 3);
  assert.equal(recent.items.length, 3);
  assert.ok(recent.items.every(item => item.title === 'Qantas SYD expansion'));
  const older = await read(['older'], 72, 20);
  assert.equal(older.items.length, 9);
  assert.equal(feeds().length, 0);
});

test('Unicode URLs survive shared snapshot reads and nested link nodes are dropped', async () => {
  const { seedAviationNews, NEWS_KEY } = await import('../scripts/seed-aviation.mjs');
  const transport = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input)).hostname === 'redis.example') return transport(input, init);
    return new Response('<rss><channel><item><title>Emirates Unicode</title><link>https://news.example/航空</link></item><item><title>Qantas valid</title><link>https://news.example/valid</link></item><item><title>Invalid link</title><link><href>https://news.example/nested</href></link></item></channel></rss>');
  }) as typeof fetch;
  const produced = await seedAviationNews();
  const cold = await read([]);
  assert.equal(cold.source, 'rss');
  assert.equal(cold.items.length, 18);
  assert.equal(produced.items.length, 18);
  assert.ok(produced.items.every((item: { link: string }) => !item.link.includes('[object Object]')));
  redis.redis.set(NEWS_KEY, JSON.stringify(produced));
  calls = [];
  for (const entity of ['Emirates', 'Qantas']) {
    const result = await read([entity]);
    assert.equal(result.source, 'rss');
    assert.equal(result.items.length, 9);
    assert.equal(result.items[0]!.id, Buffer.from(result.items[0]!.url, 'utf8').toString('base64').slice(0, 32));
  }
  assert.equal(feeds().length, 0);
});

test('producer and reader bound full article fields and serialized snapshot size', async () => {
  const { seedAviationNews } = await import('../scripts/seed-aviation.mjs');
  const transport = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input)).hostname === 'redis.example') return transport(input, init);
    const items = Array.from({ length: 30 }, (_, i) => `<item><title>Emirates ${i}</title><link>https://news.example/${i}</link><description><![CDATA[${'x'.repeat(10000)}LATE_MATCH]]></description></item>`).join('');
    return new Response(`<rss><channel>${items}<item><title>excess</title></item></channel></rss>`);
  }) as typeof fetch;
  const produced = await seedAviationNews();
  await read([], 24, 50);
  const cached = JSON.parse(redis.redis.get('aviation:news:feeds:v2')!);
  assert.deepEqual(cached, produced);
  assert.equal(cached.items.length, 270);
  assert.ok(cached.items.every((item: { description: string }) => item.description.length === 2048));
  const { serializeExtraKeyValue } = await import('../scripts/_seed-utils.mjs');
  const persisted = serializeExtraKeyValue('aviation:news:feeds:v2', produced);
  assert.ok(Buffer.byteLength(persisted) < 840_000);
  assert.ok(persisted.length * 2 < 2 * 1024 * 1024);
  const { buildEnvelope } = await import('../scripts/_seed-envelope-source.mjs');
  assert.ok(Buffer.byteLength(JSON.stringify(buildEnvelope({ fetchedAt: new Date().toISOString(), recordCount: 270, sourceVersion: 'test', schemaVersion: 1, state: 'ok', data: produced }))) < 2 * 1024 * 1024);
  assert.equal((await read(['LATE_MATCH'])).items.length, 0);
  assert.equal((await read(['xxxx'])).items.length, 20);
});

test('native sidecar gateway uses local cache without Upstash; cloud and Docker stay closed', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  assert.equal((await gateway(request(['Emirates']))).status, 200);
  assert.equal(feeds().length, 9);
  assert.equal((await gateway(request(['Qantas']))).status, 200);
  assert.equal(feeds().length, 9);
  for (const mode of ['docker', '']) {
    process.env.LOCAL_API_MODE = mode;
    __resetRateLimitForTest();
    assert.equal((await gateway(request(['Emirates']))).status, 503);
  }
});

test('drops serialized records above 3KiB in both producer and reader', async () => {
  const { seedAviationNews } = await import('../scripts/seed-aviation.mjs');
  const transport = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input)).hostname === 'redis.example') return transport(input, init);
    return new Response(`<rss><channel><item><title>Emirates short</title><link>https://news.example/short</link></item><item><title>Emirates oversized</title><link>https://news.example/long</link><description>${'航'.repeat(2048)}</description></item><item><title>Emirates long URL</title><link>https://news.example/${'x'.repeat(2048)}</link></item></channel></rss>`);
  }) as typeof fetch;
  const produced = await seedAviationNews();
  assert.equal(produced.items.length, 9);
  const result = await read(['Emirates']);
  assert.equal(result.items.length, 9);
  assert.ok(result.items.every(item => item.title === 'Emirates short'));
  assert.deepEqual(JSON.parse(redis.redis.get('aviation:news:feeds:v2')!), produced);
});

test('actual native sidecar requires its token before the news gateway', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createLocalApiServer } = await import('../src-tauri/sidecar/local-api-server.mjs');
  const root = await mkdtemp(join(tmpdir(), 'aviation-news-sidecar-'));
  await mkdir(join(root, 'aviation/v1'), { recursive: true });
  const serviceUrl = new URL('../src/generated/server/worldmonitor/aviation/v1/service_server.ts', import.meta.url).href;
  const gatewayUrl = new URL('../server/gateway.ts', import.meta.url).href;
  const handlerUrl = new URL('../server/worldmonitor/aviation/v1/handler.ts', import.meta.url).href;
  await writeFile(join(root, 'aviation/v1/list-aviation-news.js'), `import {createAviationServiceRoutes} from ${JSON.stringify(serviceUrl)}; import {createDomainGateway,serverOptions} from ${JSON.stringify(gatewayUrl)}; import {aviationHandler} from ${JSON.stringify(handlerUrl)}; export default createDomainGateway(createAviationServiceRoutes(aviationHandler,serverOptions));`);
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
    const url = `http://127.0.0.1:${port}${PATH}?window_hours=24&max_items=20&entities=Emirates`;
    assert.equal((await originalFetch(url, { headers: { 'x-worldmonitor-local-token': 'invalid' } })).status, 401);
    const headers = { 'x-worldmonitor-local-token': process.env.LOCAL_API_TOKEN, 'X-WorldMonitor-Key': session };
    for (let i = 0; i < 30; i++) assert.equal((await originalFetch(url, { headers })).status, 200);
    const denied = await originalFetch(url, { headers });
    assert.equal(denied.status, 429);
    assert.equal(Number(denied.headers.get('Retry-After')), 60);
    now += 59_999;
    assert.equal((await originalFetch(url, { headers })).status, 429);
    now += 1;
    assert.equal((await originalFetch(url, { headers })).status, 200);
    assert.ok(feeds().length <= 9);
  } finally {
    Date.now = realNow;
    await app.close();
  }
});
