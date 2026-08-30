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

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error('Timed out waiting for market request');
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

  it('combines caller cancellation with the mandatory request deadline', async () => {
    const restoreBrowserEnv = installBrowserEnv();
    const originalFetch = globalThis.fetch;
    const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    const deadlineControllers = [];
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: () => {
        const controller = new AbortController();
        deadlineControllers.push(controller);
        return controller.signal;
      },
    });
    const requestSignals = [];
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      requestSignals.push(signal);
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

    try {
      const { fetchPhysicalDivergence, fetchPhysicalPremiums } = await import(freshImportUrl(MARKET_SERVICE_URL));
      const caller = new AbortController();
      const divergence = fetchPhysicalDivergence(caller.signal);
      await waitFor(() => requestSignals.length === 1);
      assert.notEqual(requestSignals[0], caller.signal);
      deadlineControllers[0].abort(new DOMException('Deadline exceeded', 'TimeoutError'));
      await assert.rejects(divergence, { name: 'TimeoutError' });

      const premiumCaller = new AbortController();
      const premiums = fetchPhysicalPremiums(premiumCaller.signal);
      await waitFor(() => requestSignals.length === 2);
      assert.notEqual(requestSignals[1], premiumCaller.signal);
      premiumCaller.abort(new DOMException('Caller cancelled', 'AbortError'));
      await assert.rejects(premiums, { name: 'AbortError' });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalTimeout) Object.defineProperty(AbortSignal, 'timeout', originalTimeout);
      restoreBrowserEnv();
    }
  });

  it('does not open the premium breaker after caller-owned cancellations', async () => {
    const restoreBrowserEnv = installBrowserEnv();
    const originalFetch = globalThis.fetch;
    let premiumCalls = 0;
    globalThis.fetch = async (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input.url).pathname;
      if (!path.endsWith('/get-physical-premiums')) throw new Error(`Unexpected market request: ${path}`);
      premiumCalls += 1;
      if (premiumCalls <= 2) {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return response({
        premiums: [{ metal: 'gold', premiumPct: 1 }],
        fx: { asOf: '2026-08-18T12:30:00.000Z' },
      });
    };

    try {
      const { fetchPhysicalPremiums } = await import(freshImportUrl(MARKET_SERVICE_URL));
      for (let index = 0; index < 2; index += 1) {
        const caller = new AbortController();
        const request = fetchPhysicalPremiums(caller.signal);
        await waitFor(() => premiumCalls === index + 1);
        caller.abort(new DOMException('Caller cancelled', 'AbortError'));
        await assert.rejects(request, { name: 'AbortError' });
      }

      const healthy = await fetchPhysicalPremiums();
      assert.equal(premiumCalls, 3);
      assert.equal(healthy.premiums[0]?.metal, 'gold');
    } finally {
      globalThis.fetch = originalFetch;
      restoreBrowserEnv();
    }
  });
});
