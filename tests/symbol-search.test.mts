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
  it('returns mapped Finnhub results for a query', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    let requestedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(
        JSON.stringify({ count: 1, result: [{ symbol: 'NVDA', displaySymbol: 'NVDA', description: 'NVIDIA CORP', type: 'Common Stock' }] }),
        { status: 200 },
      );
    }) as typeof fetch;

    const res = await handler(makeReq('nvidia'));
    assert.equal(res.status, 200);
    assert.match(requestedUrl, /finnhub\.io\/api\/v1\/search\?q=nvidia&token=test-key/);
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
});
