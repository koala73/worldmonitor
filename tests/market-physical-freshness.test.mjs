import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
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
  const restoreWindow = overrideGlobal('window', { location, navigator });
  const restoreLocation = overrideGlobal('location', location);
  const restoreNavigator = overrideGlobal('navigator', navigator);
  return () => {
    restoreNavigator();
    restoreLocation();
    restoreWindow();
  };
}

function response(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('physical market service freshness', () => {
  it('refetches both cohort-bound responses instead of replaying a client cache', async () => {
    const restoreBrowserEnv = installBrowserEnv();
    const originalFetch = globalThis.fetch;
    const { clearAllCircuitBreakers } = await import(freshImportUrl(CIRCUIT_BREAKER_URL));
    clearAllCircuitBreakers();

    let premiumCalls = 0;
    let divergenceCalls = 0;
    let failDivergence = false;
    const requestSignals = [];
    globalThis.fetch = async (input, init) => {
      requestSignals.push(init?.signal);
      const path = new URL(typeof input === 'string' ? input : input.url).pathname;
      if (path.endsWith('/get-physical-premiums')) {
        premiumCalls += 1;
        return response({
          premiums: [{ metal: 'gold', premiumPct: premiumCalls }],
          fx: { asOf: `premium-${premiumCalls}` },
        });
      }
      if (path.endsWith('/get-physical-divergence-index')) {
        divergenceCalls += 1;
        if (failDivergence) throw new DOMException('Request timed out', 'AbortError');
        return response({
          readings: [{ metal: 'gold' }, { metal: 'silver' }],
          composite: { state: divergenceCalls === 1 ? 'PHYSICAL_DIVERGENCE_STATE_OK' : 'PHYSICAL_DIVERGENCE_STATE_STALE_INPUT' },
          evaluatedAt: `divergence-${divergenceCalls}`,
          methodologyVersion: 'physical-divergence-v1',
        });
      }
      throw new Error(`Unexpected market request: ${path}`);
    };

    try {
      const { fetchPhysicalDivergence, fetchPhysicalPremiums } = await import(freshImportUrl(MARKET_SERVICE_URL));

      const firstPremium = await fetchPhysicalPremiums();
      const secondPremium = await fetchPhysicalPremiums();
      const firstDivergence = await fetchPhysicalDivergence();
      const secondDivergence = await fetchPhysicalDivergence();

      assert.equal(premiumCalls, 2);
      assert.equal(divergenceCalls, 2);
      assert.equal(requestSignals.length, 4);
      assert.equal(requestSignals.every((signal) => signal instanceof AbortSignal), true);
      assert.equal(firstPremium.fx?.asOf, 'premium-1');
      assert.equal(secondPremium.fx?.asOf, 'premium-2');
      assert.equal(firstDivergence.composite?.state, 'PHYSICAL_DIVERGENCE_STATE_OK');
      assert.equal(secondDivergence.composite?.state, 'PHYSICAL_DIVERGENCE_STATE_STALE_INPUT');

      failDivergence = true;
      await assert.rejects(fetchPhysicalDivergence, { name: 'AbortError' });
      assert.equal(divergenceCalls, 3);
      assert.equal(requestSignals.at(-1) instanceof AbortSignal, true);
    } finally {
      globalThis.fetch = originalFetch;
      clearAllCircuitBreakers();
      restoreBrowserEnv();
    }
  });
});
