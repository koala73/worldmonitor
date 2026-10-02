import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMarketServiceRoutes } from '../src/generated/server/worldmonitor/market/v1/service_server.ts';
import { marketHandler } from '../server/worldmonitor/market/v1/handler.ts';
import { validateGeneratedRequest } from '../server/request-validator.ts';
import { getPriceHistory } from '../server/worldmonitor/market/v1/get-price-history.ts';
import { drainResponseHeaders } from '../server/_shared/response-headers.ts';
import { readFileSync } from 'node:fs';

const REDIS = 'https://redis.test';
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};

const DAY = 86_400;
const T0 = 1_750_000_000;

type YahooReply = { status: number | 'hang'; timestamps?: number[]; closes?: (number | null)[]; currency?: string };

let yahooReplies: Record<string, YahooReply>;
let yahooRequests: URL[];
let redisKeysRead: string[];

function chart({ timestamps = [], closes = [], currency = 'USD' }: YahooReply) {
  return { chart: { result: [{ meta: { currency, regularMarketPrice: closes.at(-1) ?? 0 }, timestamp: timestamps, indicators: { quote: [{ close: closes }] } }] } };
}

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === REDIS) {
      if (url.pathname.startsWith('/get/')) {
        redisKeysRead.push(decodeURIComponent(url.pathname.slice('/get/'.length)));
        return Response.json({ result: null });
      }
      if (url.pathname === '/pipeline') {
        const commands = JSON.parse(String(init?.body)) as unknown[];
        return Response.json(commands.map(() => ({ result: 'OK' })));
      }
      return Response.json({ result: 'OK' });
    }
    if (url.origin === 'https://query1.finance.yahoo.com') {
      yahooRequests.push(url);
      const symbol = decodeURIComponent(url.pathname.split('/').at(-1)!);
      const reply = yahooReplies[symbol];
      if (!reply) throw new Error(`unexpected Yahoo symbol ${symbol}`);
      if (reply.status === 'hang') {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      }
      if (reply.status !== 200) return new Response('upstream error', { status: reply.status });
      return Response.json(chart(reply));
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function route() {
  const descriptor = createMarketServiceRoutes(marketHandler, { validateRequest: validateGeneratedRequest })
    .find((r) => r.path === '/api/market/v1/get-price-history');
  assert.ok(descriptor, 'expected a get-price-history route');
  assert.equal(descriptor.method, 'GET');
  return descriptor.handler;
}

async function get(query: string) {
  const response = await route()(new Request(`https://worldmonitor.app/api/market/v1/get-price-history?${query}`));
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = REDIS;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  yahooReplies = {};
  yahooRequests = [];
  redisKeysRead = [];
  installFetch();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ENV.url == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.url;
  if (ORIGINAL_ENV.token == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.token;
});

describe('GetPriceHistory', () => {
  it('returns aligned epoch-ms timestamps and closes per tracked symbol, dropping null closes with their dates', async () => {
    yahooReplies['GC=F'] = { status: 200, timestamps: [T0, T0 + DAY, T0 + 2 * DAY, T0 + 3 * DAY], closes: [2400.5, null, 2410.25, 2420] };
    yahooReplies['SI=F'] = { status: 200, timestamps: [T0, T0 + DAY, T0 + 2 * DAY], closes: [30.1, 30.2, null], currency: 'USD' };

    const { status, body } = await get('symbols=gc%3Df,%20SI%3DF&range=6mo');

    assert.equal(status, 200);
    assert.equal(body.range, '6mo');
    assert.deepEqual(body.unavailable, []);
    assert.deepEqual(body.series, [
      { symbol: 'GC=F', name: 'Gold', currency: 'USD', timestamps: [T0 * 1000, (T0 + 2 * DAY) * 1000, (T0 + 3 * DAY) * 1000], closes: [2400.5, 2410.25, 2420] },
      { symbol: 'SI=F', name: 'Silver', currency: 'USD', timestamps: [T0 * 1000, (T0 + DAY) * 1000], closes: [30.1, 30.2] },
    ]);
    assert.deepEqual(yahooRequests.map((u) => [u.pathname, u.searchParams.get('range'), u.searchParams.get('interval')]), [
      ['/v8/finance/chart/GC%3DF', '6mo', '1d'],
      ['/v8/finance/chart/SI%3DF', '6mo', '1d'],
    ]);
    assert.ok(redisKeysRead.includes('market:price-history:v1:GC=F:6mo'), `per-symbol cache key read: ${redisKeysRead}`);
    assert.ok(redisKeysRead.includes('market:price-history:v1:SI=F:6mo'), `per-symbol cache key read: ${redisKeysRead}`);
  });

  it('reports an untracked symbol as unavailable without fetching it', async () => {
    yahooReplies['^GSPC'] = { status: 200, timestamps: [T0, T0 + DAY], closes: [6000, 6010] };

    const { status, body } = await get('symbols=NOTREAL,%5EGSPC&range=1mo');

    assert.equal(status, 200);
    assert.deepEqual(body.unavailable, ['NOTREAL']);
    assert.deepEqual(body.series.map((s: { symbol: string; name: string }) => [s.symbol, s.name]), [['^GSPC', 'S&P 500']]);
    assert.deepEqual(yahooRequests.map((u) => u.pathname), ['/v8/finance/chart/%5EGSPC']);
  });

  it('serves the other symbols when one fails upstream', async () => {
    yahooReplies['HG=F'] = { status: 500 };
    yahooReplies['PL=F'] = { status: 200, timestamps: [T0, T0 + DAY], closes: [1000, 1010] };

    const { status, body } = await get('symbols=HG%3DF,PL%3DF&range=1y');

    assert.equal(status, 200);
    assert.deepEqual(body.unavailable, ['HG=F']);
    assert.deepEqual(body.series.map((s: { symbol: string }) => s.symbol), ['PL=F']);
  });

  it('defaults the range to 3mo', async () => {
    yahooReplies['^TASI.SR'] = { status: 200, timestamps: [T0, T0 + DAY], closes: [11000, 11050], currency: 'SAR' };

    const { status, body } = await get('symbols=%5ETASI.SR');

    assert.equal(status, 200);
    assert.equal(body.range, '3mo');
    assert.equal(body.series[0].currency, 'SAR');
    assert.equal(yahooRequests[0]?.searchParams.get('range'), '3mo');
  });

  it('rejects more than 4 symbols with a 400 before any fetch', async () => {
    const { status, body } = await get('symbols=GC%3DF,SI%3DF,HG%3DF,PL%3DF,PA%3DF');

    assert.equal(status, 400);
    assert.equal(body.violations[0].field, 'symbols');
    assert.deepEqual(yahooRequests, []);
  });

  it('rejects a missing symbols parameter with a 400', async () => {
    const { status, body } = await get('range=1mo');

    assert.equal(status, 400);
    assert.equal(body.violations[0].field, 'symbols');
  });

  it('rejects a range outside 1mo|3mo|6mo|1y with a 400 before any fetch', async () => {
    for (const range of ['5y', 'max', '1d', '3MO']) {
      const { status, body } = await get(`symbols=GC%3DF&range=${range}`);
      assert.equal(status, 400, range);
      assert.equal(body.violations[0].field, 'range');
    }
    assert.deepEqual(yahooRequests, []);
  });
  it('reports a symbol with only one close as unavailable, since one bar is not a history', async () => {
    yahooReplies['^TASI.SR'] = { status: 200, timestamps: [T0], closes: [10392.97], currency: 'SAR' };
    yahooReplies['SARUSD=X'] = { status: 200, timestamps: [T0, T0 + DAY], closes: [0.2667, 0.2664] };

    const { status, body } = await get('symbols=%5ETASI.SR,SARUSD%3DX&range=3mo');

    assert.equal(status, 200);
    assert.deepEqual(body.unavailable, ['^TASI.SR']);
    assert.deepEqual(body.series.map((s: { symbol: string }) => s.symbol), ['SARUSD=X']);
  });

  it('marks a response no-store when a tracked symbol failed upstream, so a 429 is not cached for hours', async () => {
    yahooReplies['HG=F'] = { status: 429 };
    yahooReplies['PL=F'] = { status: 200, timestamps: [T0, T0 + DAY], closes: [1000, 1010] };
    const degraded = new Request('https://worldmonitor.app/api/market/v1/get-price-history');
    await getPriceHistory({ request: degraded } as never, { symbols: 'HG=F,PL=F', range: '1mo' });
    assert.equal(drainResponseHeaders(degraded)?.['X-No-Cache'], '1');

    const untracked = new Request('https://worldmonitor.app/api/market/v1/get-price-history');
    await getPriceHistory({ request: untracked } as never, { symbols: 'NOTREAL,PL=F', range: '1mo' });
    assert.equal(drainResponseHeaders(untracked)?.['X-No-Cache'], undefined, 'an untracked symbol is a permanent answer, not a degraded one');
  });

  it('answers within its time budget, serving finished symbols and listing a hung one as unavailable', async () => {
    yahooReplies['GC=F'] = { status: 200, timestamps: [T0, T0 + DAY], closes: [2400, 2410] };
    yahooReplies['SI=F'] = { status: 'hang' };
    const request = new Request('https://worldmonitor.app/api/market/v1/get-price-history');
    const started = Date.now();
    const body = await getPriceHistory({ request } as never, { symbols: 'GC=F,SI=F', range: '3mo' });
    assert.ok(Date.now() - started < 5_000, `returned after ${Date.now() - started} ms`);
    assert.deepEqual(body.series.map((s) => s.symbol), ['GC=F']);
    assert.deepEqual(body.unavailable, ['SI=F']);
    assert.equal(drainResponseHeaders(request)?.['X-No-Cache'], '1');
  });
});

describe('GetPriceHistory OpenAPI contract', () => {
  const spec = JSON.parse(readFileSync(new URL('../docs/api/MarketService.openapi.json', import.meta.url), 'utf8'));
  const operation = spec.paths['/api/market/v1/get-price-history'].get;
  const param = (name: string) => operation.parameters.find((p: { name: string }) => p.name === name);

  it('documents an empty range as valid, as the proto allows', () => {
    assert.match('', new RegExp(param('range').schema.pattern));
    assert.match('6mo', new RegExp(param('range').schema.pattern));
    assert.doesNotMatch('5y', new RegExp(param('range').schema.pattern));
  });

  it('shows a response example that answers its own request example', () => {
    const symbols = String(param('symbols').example).split(',');
    const example = operation.responses['200'].content['application/json'].example;
    assert.equal(example.range, param('range').example);
    assert.deepEqual(example.series.map((s: { symbol: string }) => s.symbol), symbols);
    assert.deepEqual(example.unavailable, []);
    for (const s of example.series) assert.equal(s.timestamps.length, s.closes.length);
  });
});
