import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// The entry script starts the fast bootstrap tier before the App chunk loads,
// and fetchBootstrapData adopts that request instead of issuing a second one.
// Measured on a production build: the fast tier used to start only after the
// App chunk downloaded and evaluated, several hundred ms after main.js ran.

type HydrationState = { tiers: { fast: { source: string } } };
type Harness = {
  primeBootstrapFastTier: () => void;
  primedBootstrapTierBudgetUsedMs: () => number;
  fetchBootstrapData: () => Promise<void>;
  getBootstrapHydrationState: () => HydrationState;
  bootstrapTesting: { resetBootstrapForTests: () => void };
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const originalFetch = globalThis.fetch;
let harness: Harness;

const tierResponse = () => new Response(JSON.stringify({ data: { probe: { ok: true } }, missing: [] }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

before(async () => {
  const result = await build({
    stdin: {
      contents: [
        "export { primeBootstrapFastTier, primedBootstrapTierBudgetUsedMs } from './src/services/bootstrap-prefetch.ts';",
        "export { fetchBootstrapData, getBootstrapHydrationState, __testing__ as bootstrapTesting } from './src/services/bootstrap.ts';",
      ].join('\n'),
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'bootstrap-prefetch-test-entry.ts',
    },
    bundle: true,
    define: { 'import.meta.env': '{"DEV":false}' },
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const source = result.outputFiles[0]?.text;
  assert.ok(source, 'esbuild must emit the prefetch harness');
  harness = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as Harness;
});

afterEach(() => {
  harness.bootstrapTesting.resetBootstrapForTests();
  globalThis.fetch = originalFetch;
});

describe('fast bootstrap tier prefetch', () => {
  it('adopts the primed request instead of fetching the fast tier twice', async () => {
    const requests: Array<{ url: string; credentials?: RequestCredentials }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), credentials: init?.credentials });
      return tierResponse();
    }) as typeof fetch;

    harness.primeBootstrapFastTier();
    assert.equal(requests.length, 1, 'priming starts the request immediately');
    assert.match(requests[0]!.url, /\/api\/bootstrap\?tier=fast&public=1$/);
    assert.equal(requests[0]!.credentials, 'omit', 'the primed read must keep the public, credential-less shape');

    await harness.fetchBootstrapData();
    const fast = requests.filter((r) => r.url.includes('tier=fast'));
    assert.equal(fast.length, 1, 'the fast tier must not be requested a second time');
    assert.equal(harness.getBootstrapHydrationState().tiers.fast.source, 'live');
  });

  it('fetches normally when nothing was primed', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return tierResponse();
    }) as typeof fetch;

    await harness.fetchBootstrapData();
    assert.equal(urls.filter((u) => u.includes('tier=fast')).length, 1);
    assert.equal(harness.getBootstrapHydrationState().tiers.fast.source, 'live');
  });

  it('uses a primed request only once', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return tierResponse();
    }) as typeof fetch;

    harness.primeBootstrapFastTier();
    await harness.fetchBootstrapData();
    await harness.fetchBootstrapData();
    assert.equal(urls.filter((u) => u.includes('tier=fast')).length, 2, 'a later bootstrap generation fetches fresh data');
  });

  it('a stalled primed request still honours the fast-tier abort budget', async () => {
    let primedSignal: AbortSignal | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('tier=fast')) return Promise.resolve(tierResponse());
      primedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }) as typeof fetch;

    harness.primeBootstrapFastTier();
    const started = Date.now();
    await harness.fetchBootstrapData();
    assert.ok(primedSignal?.aborted, 'the fast-tier timeout must abort the primed request');
    assert.ok(Date.now() - started < 5_000, 'boot must not hang on a stalled primed request');
    assert.notEqual(harness.getBootstrapHydrationState().tiers.fast.source, 'live');
  });

  it('measures the fast-tier budget from when the primed request started', async () => {
    // The 1.2 s browser cap bounds the request, not the time since App asked
    // for it. A primed request already in flight for 1 s gets the remaining
    // ~0.2 s, so boot never waits longer than it did before the prefetch.
    let primedSignal: AbortSignal | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('tier=fast')) return Promise.resolve(tierResponse());
      primedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }) as typeof fetch;

    harness.primeBootstrapFastTier();
    await new Promise((r) => setTimeout(r, 1_000));
    const started = Date.now();
    await harness.fetchBootstrapData();
    const waited = Date.now() - started;
    assert.ok(primedSignal?.aborted, 'the primed request must be aborted at the deadline');
    assert.ok(waited < 700, `boot waited ${waited} ms; the budget must count the time already spent in flight`);
  });

  it('keeps a primed response that already arrived even when App loads after the budget', async () => {
    // Slow devices (and the Vite dev server in CI) can take longer than the
    // 1.2 s budget to load App. A response that arrived in the meantime is
    // complete data; aborting its body read would discard it and refetch.
    const urls: string[] = [];
    // Headers arrive at once; the body streams in over a later task and dies
    // with the request's signal, the way a large browser response does.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: { probe: { ok: true } }, missing: [] })));
            controller.close();
          }, 20);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            controller.error(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    harness.primeBootstrapFastTier();
    await new Promise((r) => setTimeout(r, 1_300));
    await harness.fetchBootstrapData();
    assert.equal(harness.getBootstrapHydrationState().tiers.fast.source, 'live');
    assert.equal(urls.filter((u) => u.includes('tier=fast')).length, 1);
  });

  it('charges the budget only while the primed request still awaits a response', async () => {
    // Node reads a buffered body within microtasks, so the test above cannot lose
    // the abort race the way Chrome's task-hopping body read does. Pin the
    // accounting directly: an answered request has used none of the budget.
    globalThis.fetch = (async () => tierResponse()) as typeof fetch;
    harness.primeBootstrapFastTier();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(harness.primedBootstrapTierBudgetUsedMs(), 0);
    harness.bootstrapTesting.resetBootstrapForTests();

    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })) as typeof fetch;
    harness.primeBootstrapFastTier();
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(harness.primedBootstrapTierBudgetUsedMs() >= 100, 'a pending request is charged for its time in flight');
  });

  it('falls back to a direct request when the primed request failed on the network', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (!String(input).includes('tier=fast')) return tierResponse();
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return tierResponse();
    }) as typeof fetch;

    harness.primeBootstrapFastTier();
    await new Promise((r) => setTimeout(r, 10));
    await harness.fetchBootstrapData();
    assert.equal(calls, 2, 'a network failure before App loaded gets one direct retry');
    assert.equal(harness.getBootstrapHydrationState().tiers.fast.source, 'live');
  });

  it('is started by the dashboard entry before the App chunk import', () => {
    const main = readFileSync(resolve(root, 'src/main.ts'), 'utf8');
    const prime = main.indexOf('primeBootstrapFastTier();');
    const appImport = main.indexOf("void import('./App')");
    const redirect = main.indexOf('installWebApiRedirect();');
    assert.ok(prime > redirect, 'the primed request must go through the installed web API fetch wrappers');
    assert.ok(prime >= 0 && prime < appImport, 'the fast tier must start before the App chunk is requested');
    const settingsBranch = main.indexOf("urlParams.get('settings') === '1'");
    assert.ok(prime > settingsBranch, 'standalone settings windows never boot the dashboard and must not prime it');
  });
});
