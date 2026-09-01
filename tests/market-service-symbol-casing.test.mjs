import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const MARKET_SERVICE_URL = pathToFileURL(resolve(root, 'src/services/market/index.ts')).href;
const CIRCUIT_BREAKER_URL = pathToFileURL(resolve(root, 'src/utils/circuit-breaker.ts')).href;

function freshImportUrl(url) {
  return `${url}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function overrideGlobal(name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  };
}

function installBrowserEnv() {
  const location = {
    hostname: 'worldmonitor.app',
    protocol: 'https:',
    host: 'worldmonitor.app',
    origin: 'https://worldmonitor.app',
  };
  const navigator = { userAgent: 'node-test', onLine: true };
  const window = { location, navigator };

  const restoreWindow = overrideGlobal('window', window);
  const restoreLocation = overrideGlobal('location', location);
  const restoreNavigator = overrideGlobal('navigator', navigator);

  return () => {
    restoreNavigator();
    restoreLocation();
    restoreWindow();
  };
}

function getRequestUrl(input) {
  if (typeof input === 'string') return new URL(input, 'http://localhost');
  if (input instanceof URL) return new URL(input.toString());
  return new URL(input.url, 'http://localhost');
}

function quote(symbol, price) {
  return {
    symbol,
    name: symbol,
    display: symbol,
    price,
    change: 0,
    sparkline: [],
  };
}

function marketResponse(quotes, extras = {}) {
  return {
    quotes,
    finnhubSkipped: false,
    skipReason: '',
    rateLimited: false,
    ...extras,
  };
}

describe('market service symbol casing', () => {
  it('preserves distinct-case symbols in the batched request and response mapping', async () => {
    const restoreBrowserEnv = installBrowserEnv();
    const { clearAllCircuitBreakers } = await import(freshImportUrl(CIRCUIT_BREAKER_URL));
    clearAllCircuitBreakers();

    const originalFetch = globalThis.fetch;
    const requests = [];

    globalThis.fetch = async (input) => {
      const url = getRequestUrl(input);
      requests.push(url.searchParams.getAll('symbols'));
      return new Response(JSON.stringify(marketResponse([
        quote('btc-usd', 101),
        quote('BTC-USD', 202),
      ])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      const { fetchMultipleStocks } = await import(freshImportUrl(MARKET_SERVICE_URL));
      const result = await fetchMultipleStocks([
        { symbol: ' btc-usd ', name: 'Lower BTC', display: 'btc lower' },
        { symbol: 'BTC-USD', name: 'Upper BTC', display: 'BTC upper' },
      ]);

      assert.deepEqual(requests[0], ['btc-usd', 'BTC-USD']);
      assert.deepEqual(
        result.data.map((entry) => entry.symbol),
        ['btc-usd', 'BTC-USD'],
      );
      assert.deepEqual(
        result.data.map((entry) => entry.name),
        ['Lower BTC', 'Upper BTC'],
      );
    } finally {
      globalThis.fetch = originalFetch;
      clearAllCircuitBreakers();
      restoreBrowserEnv();
    }
  });

  it('keeps per-request cache keys isolated when symbols differ only by case', async () => {
    const restoreBrowserEnv = installBrowserEnv();
    const { clearAllCircuitBreakers } = await import(freshImportUrl(CIRCUIT_BREAKER_URL));
    clearAllCircuitBreakers();

    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    globalThis.fetch = async (input) => {
      fetchCount += 1;
      const url = getRequestUrl(input);
      const [symbol = ''] = url.searchParams.getAll('symbols');
      const price = symbol === 'BTC-USD' ? 222 : 111;
      return new Response(JSON.stringify(marketResponse([quote(symbol, price)])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      const { fetchMultipleStocks } = await import(freshImportUrl(MARKET_SERVICE_URL));

      const lower = await fetchMultipleStocks([
        { symbol: 'btc-usd', name: 'Lower BTC', display: 'btc lower' },
      ]);
      const upper = await fetchMultipleStocks([
        { symbol: 'BTC-USD', name: 'Upper BTC', display: 'BTC upper' },
      ]);

      assert.equal(fetchCount, 2, 'case-distinct symbol sets must not share one cache entry');
      assert.equal(lower.data[0]?.symbol, 'btc-usd');
      assert.equal(upper.data[0]?.symbol, 'BTC-USD');
      assert.equal(upper.data[0]?.name, 'Upper BTC');
    } finally {
      globalThis.fetch = originalFetch;
      clearAllCircuitBreakers();
      restoreBrowserEnv();
    }
  });

  it('keeps requested metadata when the backend normalizes symbol casing', async () => {
    const restoreBrowserEnv = installBrowserEnv();
    const { clearAllCircuitBreakers } = await import(freshImportUrl(CIRCUIT_BREAKER_URL));
    clearAllCircuitBreakers();

    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => new Response(JSON.stringify(marketResponse([
      quote('Btc-Usd', 101),
    ])), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    try {
      const { fetchMultipleStocks } = await import(freshImportUrl(MARKET_SERVICE_URL));
      const result = await fetchMultipleStocks([
        { symbol: 'btc-usd', name: 'Lower BTC', display: 'btc lower' },
        { symbol: 'BTC-USD', name: 'Upper BTC', display: 'BTC upper' },
      ]);

      assert.equal(result.data[0]?.symbol, 'Btc-Usd');
      assert.equal(result.data[0]?.name, 'Lower BTC');
      assert.equal(result.data[0]?.display, 'btc lower');
    } finally {
      globalThis.fetch = originalFetch;
      clearAllCircuitBreakers();
      restoreBrowserEnv();
    }
  });

  it('keeps the last successful quote and asOf when a later same-symbol response is empty', async () => {
    const restoreBrowserEnv = installBrowserEnv();
    // Import the same circuit-breaker module instance the market service binds
    // so we can evict its in-memory TTL cache between the two calls.
    const { CircuitBreaker, clearAllCircuitBreakers } = await import(CIRCUIT_BREAKER_URL);
    clearAllCircuitBreakers();

    const originalExecute = CircuitBreaker.prototype.execute;
    const seenBreakers = new Set();
    CircuitBreaker.prototype.execute = function executeWithCapture(...args) {
      seenBreakers.add(this);
      return originalExecute.apply(this, args);
    };

    const originalFetch = globalThis.fetch;
    const firstAsOf = '2026-08-31T12:00:00.000Z';
    const laterAsOf = '2026-09-01T06:00:00.000Z';
    let fetchCount = 0;

    globalThis.fetch = async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(JSON.stringify(marketResponse([quote('QQQ', 714.25)], {
          asOf: firstAsOf,
        })), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(marketResponse([], { asOf: laterAsOf })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      const { fetchMultipleStocks } = await import(freshImportUrl(MARKET_SERVICE_URL));
      const qqq = [{ symbol: 'QQQ', name: 'Invesco QQQ', display: 'QQQ' }];

      const first = await fetchMultipleStocks(qqq);
      assert.equal(first.data[0]?.symbol, 'QQQ');
      assert.equal(first.data[0]?.price, 714.25);
      assert.equal(first.asOf, firstAsOf);

      assert.ok(seenBreakers.size > 0, 'must observe the Market Quotes breaker to evict its TTL cache');
      for (const breaker of seenBreakers) {
        breaker.clearCache();
      }

      const second = await fetchMultipleStocks(qqq);
      assert.equal(fetchCount, 2, 'empty refresh must reach the network after cache eviction');
      assert.equal(second.data[0]?.symbol, 'QQQ');
      assert.equal(second.data[0]?.price, 714.25);
      assert.equal(
        second.asOf,
        firstAsOf,
        'retained quote must keep the first response freshness clock',
      );
    } finally {
      CircuitBreaker.prototype.execute = originalExecute;
      globalThis.fetch = originalFetch;
      clearAllCircuitBreakers();
      restoreBrowserEnv();
    }
  });
});
