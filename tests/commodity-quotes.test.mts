import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createMarketServiceRoutes, ValidationError } from '../src/generated/server/worldmonitor/market/v1/service_server.ts';
import { marketHandler } from '../server/worldmonitor/market/v1/handler.ts';
import {
  SUPPORTED_COMMODITY_SYMBOLS,
  filterCommoditySeed,
  normalizeCommoditySymbol,
  resolveCommodityQuery,
  throwUnsupportedCommodityError,
} from '../server/worldmonitor/market/v1/list-commodity-quotes';

function seedQuote(symbol: string) {
  return { symbol, name: symbol, display: symbol, price: 1, change: 0, sparkline: [] };
}

describe('listCommodityQuotes contract (#6307)', () => {
  it('exposes the configured default commodity symbols as the supported set', () => {
    assert.ok(SUPPORTED_COMMODITY_SYMBOLS instanceof Set);
    assert.ok(SUPPORTED_COMMODITY_SYMBOLS.size >= 30, 'expected the full seed commodity set');
    assert.ok(SUPPORTED_COMMODITY_SYMBOLS.has('GC=F'), 'gold futures is a default commodity');
    assert.ok(SUPPORTED_COMMODITY_SYMBOLS.has('BZ=F'), 'Brent crude is a default commodity');
  });

  it('normalizes symbols (trim, de-whitespace, upper)', () => {
    assert.equal(normalizeCommoditySymbol('  gc  = f '), 'GC=F');
    assert.equal(normalizeCommoditySymbol('cl=F'), 'CL=F');
    assert.equal(normalizeCommoditySymbol('  BZ=F'), 'BZ=F');
  });

  it('returns an empty resolution (symbols=[]) for an empty request', () => {
    const res = resolveCommodityQuery([]);
    assert.deepEqual(res, { symbols: [], overCap: false });
  });

  it('resolves supported symbols in request order, deduplicating', () => {
    const res = resolveCommodityQuery(['CL=F', 'gc=f', 'CL=F', ' BZ=F ']);
    assert.deepEqual(res.symbols, ['CL=F', 'GC=F', 'BZ=F']);
    assert.equal(res.overCap, false);
  });

  it('throws the generated ValidationError (→ HTTP 400 { violations }) for any unsupported symbol', () => {
    assert.throws(
      () => resolveCommodityQuery(['GC=F', 'AAPL']),
      (err) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
        const fields = err.violations.map((f: { field: string; description: string }) => f.field);
        assert.deepEqual(fields, ['symbols']);
        assert.match(JSON.stringify(err.violations), /AAPL/);
        return true;
      },
    );
    // Rejection is explicit even when a supported symbol is also present.
    assert.throws(() => resolveCommodityQuery(['GC=F', 'INVALID']), ValidationError);
  });

  it('rejects whitespace-only symbols instead of treating them as empty→defaults', () => {
    assert.throws(
      () => resolveCommodityQuery(['   ', '\t']),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(JSON.stringify(err.violations), /blank/);
        return true;
      },
    );
    // Blank mixed with a supported symbol still fails closed (never partial success).
    assert.throws(() => resolveCommodityQuery(['GC=F', '  ']), ValidationError);
  });

  it('caps cardinality beyond the configured cap (over-cap is explicit)', () => {
    const many = Array.from({ length: 80 }, (_, i) => `SYM${i}`);
    // none of these are supported → would throw, so build capped against a
    // permissive supported set to exercise the cap independent of support.
    const supported = new Set(many);
    const res = resolveCommodityQuery(many, supported, 64);
    assert.equal(res.symbols.length, 64);
    assert.equal(res.overCap, true);
  });

  it('filters seed quotes to requested symbols in seed order', () => {
    const seed = ['GC=F', 'CL=F', 'SI=F'].map(seedQuote);
    const filtered = filterCommoditySeed(seed, ['CL=F', 'GC=F']);
    assert.deepEqual(filtered.map((q) => q.symbol), ['GC=F', 'CL=F']);
  });

  it('returns the full seed when no symbols are requested (empty → defaults)', () => {
    const seed = ['GC=F', 'CL=F', 'SI=F'].map(seedQuote);
    assert.deepEqual(filterCommoditySeed(seed, []).map((q) => q.symbol), ['GC=F', 'CL=F', 'SI=F']);
  });

  it('throwUnsupportedCommodityError carries a symbols field violation', () => {
    let caught: unknown;
    try {
      throwUnsupportedCommodityError(['AAPL', 'TSLA']);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ValidationError);
    assert.deepEqual(
      caught.violations,
      [{ field: 'symbols', description: 'Unsupported commodity symbols: AAPL, TSLA' }],
    );
  });
});

// ---------------------------------------------------------------------------
// Async handler paths through the real generated dispatch + Redis fetch mock.
// The generated dispatch catches ValidationError and serializes `{ violations }`
// (HTTP 400) BEFORE the error mapper runs — this is the exact production path,
// so these tests cover the empty→defaults, unsupported→400, null→[], and
// Redis-error→[] branches end-to-end. We route to the generated route
// descriptor's handler directly (bypassing the gateway's auth/CORS wrapper) so
// these exercise the dispatched handler, not auth middleware.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'LOCAL_API_MODE',
  'WM_SESSION_SECRET',
] as const;

const originalEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;

type RedisMode =
  | { kind: 'seed'; payload: unknown }
  | { kind: 'null' }
  | { kind: 'error' };

function routeHandler() {
  const descriptor = createMarketServiceRoutes(marketHandler, {})
    .find((r) => r.path === '/api/market/v1/list-commodity-quotes');
  assert.ok(descriptor, 'expected list-commodity-quotes route descriptor');
  return descriptor.handler;
}

function installRedisMock(redis: RedisMode) {
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith('https://redis.test/get/')) {
      if (redis.kind === 'seed') {
        return new Response(JSON.stringify({ result: JSON.stringify(redis.payload) }), { status: 200 });
      }
      if (redis.kind === 'error') {
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
      }
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    void init;
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function requestFor(path: string): Request {
  return new Request(`https://worldmonitor.app${path}`);
}

const DEFAULT_SEED = ['GC=F', 'CL=F', 'SI=F', 'BZ=F'].map(seedQuote);

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
});

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe('ListCommodityQuotes async handler paths (mocked Redis)', () => {
  it('empty symbols returns the configured default seed set', async () => {
    installRedisMock({ kind: 'seed', payload: { quotes: DEFAULT_SEED } });
    const response = await routeHandler()(requestFor('/api/market/v1/list-commodity-quotes'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.quotes.map((q: { symbol: string }) => q.symbol), ['GC=F', 'CL=F', 'SI=F', 'BZ=F']);
  });

  it('supported symbols filter the seed in seed order', async () => {
    installRedisMock({ kind: 'seed', payload: { quotes: DEFAULT_SEED } });
    const response = await routeHandler()(requestFor('/api/market/v1/list-commodity-quotes?symbols=CL%3DF&symbols=GC%3DF'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.quotes.map((q: { symbol: string }) => q.symbol), ['GC=F', 'CL=F']);
  });

  it('unsupported symbol returns HTTP 400 with the documented { violations } shape', async () => {
    installRedisMock({ kind: 'seed', payload: { quotes: DEFAULT_SEED } });
    const response = await routeHandler()(requestFor('/api/market/v1/list-commodity-quotes?symbols=AAPL'));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(Array.isArray(body.violations), `expected {violations}, got ${JSON.stringify(body)}`);
    assert.equal(body.violations[0].field, 'symbols');
    assert.match(body.violations[0].description, /AAPL/);
  });

  it('validation 400 happens before any seed read (Redis unreachable still 400s unsupported)', async () => {
    installRedisMock({ kind: 'error' });
    const response = await routeHandler()(requestFor('/api/market/v1/list-commodity-quotes?symbols=INVALID'));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(Array.isArray(body.violations));
  });

  it('null seed → empty quotes, not an error', async () => {
    installRedisMock({ kind: 'null' });
    const response = await routeHandler()(requestFor('/api/market/v1/list-commodity-quotes'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { quotes: [] });
  });

  it('Redis error → empty quotes, not a 500 (pre-existing fail-open pattern)', async () => {
    installRedisMock({ kind: 'error' });
    const response = await routeHandler()(requestFor('/api/market/v1/list-commodity-quotes'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { quotes: [] });
  });
});
