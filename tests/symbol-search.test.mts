import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import handler, { mapFinnhubResults } from '../api/symbol-search.ts';

const originalFetch = globalThis.fetch;

// validateApiKey() rejects credential-less requests (production browsers send
// an anonymous session token via the wm-session fetch wrapper). The enterprise
// key path is the simplest to satisfy in-test — an env allowlist + a matching
// header, no HMAC. Set for the whole file.
const TEST_KEY = 'wm-test-enterprise-key';
process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.FINNHUB_API_KEY;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

function makeReq(q?: string, method = 'GET'): Request {
  const url = q === undefined
    ? 'https://worldmonitor.app/api/symbol-search'
    : `https://worldmonitor.app/api/symbol-search?q=${encodeURIComponent(q)}`;
  return new Request(url, { method, headers: { 'X-WorldMonitor-Key': TEST_KEY } });
}

describe('mapFinnhubResults', () => {
  it('maps symbol/description/displaySymbol and keeps equity-type instruments', () => {
    const out = mapFinnhubResults([
      { symbol: 'NVDA', displaySymbol: 'NVDA', description: 'NVIDIA CORP', type: 'Common Stock' },
      { symbol: 'NVDL', displaySymbol: 'NVDL', description: 'GraniteShares 2x NVDA ETF', type: 'ETP' },
    ]);
    assert.deepEqual(out, [
      { symbol: 'NVDA', name: 'NVIDIA CORP', display: 'NVDA' },
      { symbol: 'NVDL', name: 'GraniteShares 2x NVDA ETF', display: 'NVDL' },
    ]);
  });

  it('drops non-equity instrument types (crypto, FX, bonds, warrants)', () => {
    const out = mapFinnhubResults([
      { symbol: 'BINANCE:BTCUSDT', description: 'Bitcoin', type: 'Crypto' },
      { symbol: 'OANDA:EUR_USD', description: 'EUR/USD', type: 'Forex' },
      { symbol: 'AAPL', displaySymbol: 'AAPL', description: 'APPLE INC', type: 'Common Stock' },
    ]);
    assert.deepEqual(out, [{ symbol: 'AAPL', name: 'APPLE INC', display: 'AAPL' }]);
  });

  it('allows results with a missing/empty type and falls back name→symbol', () => {
    const out = mapFinnhubResults([
      { symbol: 'GLW', displaySymbol: 'GLW' },           // no type, no description
      { symbol: 'KULR', description: 'KULR TECH', type: '' },
    ]);
    assert.deepEqual(out, [
      { symbol: 'GLW', name: 'GLW', display: 'GLW' },
      { symbol: 'KULR', name: 'KULR TECH', display: 'KULR' },
    ]);
  });

  it('skips empty symbols and de-dupes', () => {
    const out = mapFinnhubResults([
      { symbol: '', description: 'nothing', type: 'Common Stock' },
      { symbol: 'TSLA', description: 'TESLA INC', type: 'Common Stock' },
      { symbol: 'TSLA', description: 'TESLA INC DUP', type: 'Common Stock' },
    ]);
    assert.deepEqual(out, [{ symbol: 'TSLA', name: 'TESLA INC', display: 'TSLA' }]);
  });

  it('caps the result list at 12', () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({
      symbol: `SYM${i}`, description: `Company ${i}`, type: 'Common Stock',
    }));
    assert.equal(mapFinnhubResults(raw).length, 12);
  });
});

describe('symbol-search handler', () => {
  it('returns mapped Finnhub results for a query, with our User-Agent', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    let requestedUrl = '';
    let requestedUA: string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const h = new Headers(init?.headers ?? {});
      requestedUA = h.get('User-Agent');
      return new Response(
        JSON.stringify({ count: 1, result: [{ symbol: 'NVDA', displaySymbol: 'NVDA', description: 'NVIDIA CORP', type: 'Common Stock' }] }),
        { status: 200 },
      );
    }) as typeof fetch;

    const res = await handler(makeReq('nvidia'));
    assert.equal(res.status, 200);
    assert.match(requestedUrl, /finnhub\.io\/api\/v1\/search\?q=nvidia&token=test-key/);
    // AGENTS.md Critical Conventions: "Always include User-Agent header in
    // server-side fetch calls". Reviewer P1 on PR #3698.
    assert.equal(requestedUA, 'worldmonitor-edge/1.0');
    const body = await res.json() as { results: unknown };
    assert.deepEqual(body.results, [{ symbol: 'NVDA', name: 'NVIDIA CORP', display: 'NVDA' }]);
  });

  it('returns empty results for a blank query without calling Finnhub', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;

    const res = await handler(makeReq('   '));
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json() as { results: unknown }).results, []);
    assert.equal(called, false, 'a blank query must not hit Finnhub');
  });

  it('returns 503 when FINNHUB_API_KEY is not configured', async () => {
    const res = await handler(makeReq('nvidia'));
    assert.equal(res.status, 503);
  });

  it('maps a Finnhub 429 to 503 so the client backs off instead of failing hard', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    const res = await handler(makeReq('nvidia'));
    assert.equal(res.status, 503);
  });

  it('returns 500 when the upstream fetch throws', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    const res = await handler(makeReq('nvidia'));
    assert.equal(res.status, 500);
  });

  it('rejects non-GET methods', async () => {
    const res = await handler(makeReq('x', 'POST'));
    assert.equal(res.status, 405);
  });

  // ── shared Upstash cache (reviewer P2) ─────────────────────────────────
  //
  // Per-client debounce only protects each tab — the Finnhub 60/min quota
  // is shared across all users. The handler reads a short Upstash cache
  // before calling Finnhub, and writes successful results back. Both paths
  // are tested here against a URL-routed fetch mock.

  // `checkRateLimit` shares the same UPSTASH_* env vars as our cache, so
  // enabling Upstash for these tests also activates the rate limiter. The
  // catch-all branch below returns a permissive shape for ANY Upstash URL
  // we didn't specifically route (the rate-limiter scripts / eval paths),
  // so it always says "allow".
  function permissiveUpstashCatchAll(): Response {
    return new Response(
      JSON.stringify({ result: [1, 600, 599, Date.now() + 60_000] }),
      { status: 200 },
    );
  }

  it('serves a cache hit from Upstash without calling Finnhub', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-tok';

    const cachedPayload = { results: [{ symbol: 'GLW', name: 'Corning Inc', display: 'GLW' }] };
    let finnhubCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://upstash.test/get/symsearch')) {
        // Upstash returns the JSON-stringified value under `.result`.
        return new Response(JSON.stringify({ result: JSON.stringify(cachedPayload) }), { status: 200 });
      }
      if (url.includes('finnhub.io')) {
        finnhubCalls++;
        return new Response('should not be called', { status: 500 });
      }
      if (url.startsWith('https://upstash.test')) return permissiveUpstashCatchAll();
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const res = await handler(makeReq('glw'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), cachedPayload);
    assert.equal(finnhubCalls, 0, 'cache hit must not hit Finnhub');
  });

  it('on cache miss, calls Finnhub and writes the result back to Upstash', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-tok';

    let finnhubCalls = 0;
    let setCalls = 0;
    let setBody: string | null = null;
    let getKey: string | null = null;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://upstash.test/get/symsearch')) {
        getKey = decodeURIComponent(url.slice('https://upstash.test/get/'.length));
        return new Response(JSON.stringify({ result: null }), { status: 200 }); // miss
      }
      // setCachedData posts a SET-bearing pipeline; identify it by body
      // shape so we don't conflate with rate-limiter pipeline calls.
      if (url === 'https://upstash.test/pipeline' && typeof init?.body === 'string' && init.body.includes('symsearch:v1:')) {
        setCalls++;
        setBody = init.body;
        return new Response(JSON.stringify([{ result: 'OK' }]), { status: 200 });
      }
      if (url.includes('finnhub.io')) {
        finnhubCalls++;
        return new Response(
          JSON.stringify({ count: 1, result: [{ symbol: 'GLW', displaySymbol: 'GLW', description: 'Corning Inc', type: 'Common Stock' }] }),
          { status: 200 },
        );
      }
      if (url.startsWith('https://upstash.test')) return permissiveUpstashCatchAll();
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    // Pass a stub ctx so the cache-write runs synchronously enough to assert.
    const writePromises: Array<Promise<unknown>> = [];
    const res = await handler(makeReq('glw'), { waitUntil: (p) => writePromises.push(p) });
    await Promise.all(writePromises);

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { results: [{ symbol: 'GLW', name: 'Corning Inc', display: 'GLW' }] });
    assert.equal(finnhubCalls, 1, 'cache miss must hit Finnhub once');
    assert.equal(setCalls, 1, 'successful Finnhub result must be written to Upstash');
    // The cache key is normalized (lowercase, whitespace-folded) so 'GLW',
    // 'glw', and '  GLW ' all share one entry.
    assert.equal(getKey, 'symsearch:v1:glw');
    // Sanity-check the SET command shape.
    assert.match(setBody ?? '', /"SET","symsearch:v1:glw"/);
    assert.match(setBody ?? '', /"EX","600"/);
  });
});
