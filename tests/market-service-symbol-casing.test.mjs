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

function marketResponse(quotes) {
  return {
    quotes,
    finnhubSkipped: false,
    skipReason: '',
    rateLimited: false,
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
      requests.push(url.searchParams.get('symbols'));
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

      assert.equal(requests[0], 'btc-usd,BTC-USD');
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
      const symbols = url.searchParams.get('symbols');
      const [symbol = ''] = (symbols ?? '').split(',');
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
});
