import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const TEST_STATE_KEY = '__wmProxyPersistentResponseCacheTestState';

type CachedResponsePayload = {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
};

type CacheEnvelope = {
  key: string;
  updatedAt: number;
  data: CachedResponsePayload;
};

type NetworkOutcome = Response | Error;

interface ProxyPersistentResponseCacheTestState {
  cached: CacheEnvelope | null;
  fetchCalls: Array<{ input: string; init?: RequestInit }>;
  networkOutcomes: NetworkOutcome[];
  writes: Array<{ key: string; data: CachedResponsePayload; updatedAt?: number }>;
}

declare global {
  // eslint-disable-next-line no-var
  var __wmProxyPersistentResponseCacheTestState: ProxyPersistentResponseCacheTestState | undefined;
}

async function loadProxyModule(): Promise<{
  fetchWithProxy(url: string): Promise<Response>;
}> {
  const entryPath = resolve(root, 'src/utils/proxy.ts');
  const stubs = new Map([
    ['runtime-stub', `
      export function isDesktopRuntime() { return false; }
      export function toApiUrl(path) { return \`https://api.test\${path}\`; }
      export function toRuntimeUrl(path) { return \`http://desktop.test\${path}\`; }
    `],
    ['persistent-cache-stub', `
      export async function getPersistentCache() {
        return globalThis.${TEST_STATE_KEY}.cached;
      }
      export async function setPersistentCache(key, data, updatedAt) {
        globalThis.${TEST_STATE_KEY}.writes.push({ key, data, updatedAt });
      }
    `],
  ]);

  const aliases = new Map([
    ['../services/runtime', 'runtime-stub'],
    ['../services/persistent-cache', 'persistent-cache-stub'],
  ]);

  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.VITE_RSS_DIRECT_TO_RELAY': '"false"',
    },
    plugins: [{
      name: 'proxy-persistent-response-cache-test-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          const target = aliases.get(args.path);
          return target ? { path: target, namespace: 'stub' } : null;
        });
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubs.get(args.path),
          loader: 'ts',
        }));
      },
    }],
  });

  const bundleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`;
  return import(bundleUrl);
}

const proxyModule = await loadProxyModule();
const API_PATH = '/api/rss-proxy?url=https%3A%2F%2Fexample.test%2Ffeed.xml';
const RESPONSE_MAX_AGE_SECONDS = 180;
const RESPONSE_MAX_AGE_MS = RESPONSE_MAX_AGE_SECONDS * 1000;
const EXPIRED_RESPONSE_AGE_MS = RESPONSE_MAX_AGE_MS + 1000;
const DEFAULT_RESPONSE_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_CACHE_CONTROL = `public, max-age=${RESPONSE_MAX_AGE_SECONDS}, s-maxage=900, stale-while-revalidate=1800`;
const CACHE_CONTROL_WITHOUT_MAX_AGE = 'public, s-maxage=900, stale-while-revalidate=1800';
const FIXED_NOW_MS = Date.UTC(2026, 7, 2, 12);

function cachedResponse(
  body: string,
  ageMs: number,
  cacheControl = DEFAULT_CACHE_CONTROL,
): CacheEnvelope {
  return {
    key: `api-response:${API_PATH}`,
    updatedAt: Date.now() - ageMs,
    data: {
      url: API_PATH,
      status: 200,
      statusText: 'OK',
      headers: {
        'cache-control': cacheControl,
        'content-type': 'application/xml',
      },
      body,
    },
  };
}

beforeEach(() => {
  mock.method(Date, 'now', () => FIXED_NOW_MS);
  globalThis.__wmProxyPersistentResponseCacheTestState = {
    cached: null,
    fetchCalls: [],
    networkOutcomes: [],
    writes: [],
  };

  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const state = globalThis.__wmProxyPersistentResponseCacheTestState!;
    state.fetchCalls.push({ input: String(input), init });
    const outcome = state.networkOutcomes.shift();
    if (!outcome) throw new Error('No network outcome configured');
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
});

afterEach(() => {
  mock.restoreAll();
  delete globalThis.__wmProxyPersistentResponseCacheTestState;
});

describe('fetchWithProxy persistent response freshness', () => {
  it('returns a fresh cached response while revalidating it in the background', async () => {
    const state = globalThis.__wmProxyPersistentResponseCacheTestState!;
    state.cached = cachedResponse('<rss>cached</rss>', 60_000);
    state.networkOutcomes.push(new Response('<rss>refreshed</rss>', { status: 200 }));

    const response = await proxyModule.fetchWithProxy(API_PATH);

    assert.equal(await response.text(), '<rss>cached</rss>');
    assert.deepEqual(state.fetchCalls, [{
      input: `https://api.test${API_PATH}`,
      init: { cache: 'no-store' },
    }]);
    await new Promise(setImmediate);
    assert.equal(state.writes.length, 1, 'fresh entries should still be revalidated in the background');
  });

  it('awaits the network response when the persisted response is past max-age', async () => {
    const state = globalThis.__wmProxyPersistentResponseCacheTestState!;
    state.cached = cachedResponse('<rss>expired</rss>', EXPIRED_RESPONSE_AGE_MS);
    state.networkOutcomes.push(new Response('<rss>current</rss>', {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
    }));

    const response = await proxyModule.fetchWithProxy(API_PATH);

    assert.equal(await response.text(), '<rss>current</rss>');
    assert.deepEqual(state.fetchCalls, [{
      input: `https://api.test${API_PATH}`,
      init: { cache: 'no-store' },
    }]);
    assert.equal(state.writes.length, 1, 'the current response should replace the stale envelope');
  });

  it('uses the five-minute default when max-age is absent and revalidates a younger entry', async () => {
    const state = globalThis.__wmProxyPersistentResponseCacheTestState!;
    state.cached = cachedResponse(
      '<rss>cached</rss>',
      DEFAULT_RESPONSE_MAX_AGE_MS - 1,
      CACHE_CONTROL_WITHOUT_MAX_AGE,
    );
    state.networkOutcomes.push(new Response('<rss>refreshed</rss>', { status: 200 }));

    const response = await proxyModule.fetchWithProxy(API_PATH);

    assert.equal(await response.text(), '<rss>cached</rss>');
    await new Promise(setImmediate);
    assert.equal(state.writes.length, 1, 'a fresh default-TTL entry should revalidate in the background');
  });

  for (const [boundary, ageMs] of [
    ['at', DEFAULT_RESPONSE_MAX_AGE_MS],
    ['older than', DEFAULT_RESPONSE_MAX_AGE_MS + 1],
  ] as const) {
    it(`awaits the network response when a max-age-absent entry is ${boundary} the default TTL`, async () => {
      const state = globalThis.__wmProxyPersistentResponseCacheTestState!;
      state.cached = cachedResponse(
        '<rss>expired</rss>',
        ageMs,
        CACHE_CONTROL_WITHOUT_MAX_AGE,
      );
      state.networkOutcomes.push(new Response('<rss>current</rss>', { status: 200 }));

      const response = await proxyModule.fetchWithProxy(API_PATH);

      assert.equal(await response.text(), '<rss>current</rss>');
    });
  }

  it('treats an entry at its explicit max-age boundary as stale', async () => {
    const state = globalThis.__wmProxyPersistentResponseCacheTestState!;
    state.cached = cachedResponse('<rss>boundary</rss>', RESPONSE_MAX_AGE_MS);
    state.networkOutcomes.push(new Response('<rss>current</rss>', { status: 200 }));

    const response = await proxyModule.fetchWithProxy(API_PATH);

    assert.equal(await response.text(), '<rss>current</rss>');
  });

  it('treats max-age=0 as immediately stale', async () => {
    const state = globalThis.__wmProxyPersistentResponseCacheTestState!;
    state.cached = cachedResponse('<rss>cached</rss>', 0, 'public, max-age=0');
    state.networkOutcomes.push(new Response('<rss>current</rss>', { status: 200 }));

    const response = await proxyModule.fetchWithProxy(API_PATH);

    assert.equal(await response.text(), '<rss>current</rss>');
  });

  it('returns a failed refresh instead of presenting stale cache as a live success', async () => {
    const state = globalThis.__wmProxyPersistentResponseCacheTestState!;
    state.cached = cachedResponse('<rss>expired</rss>', EXPIRED_RESPONSE_AGE_MS);
    state.networkOutcomes.push(new Response('upstream unavailable', { status: 503 }));

    const response = await proxyModule.fetchWithProxy(API_PATH);

    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'upstream unavailable');
    assert.equal(state.writes.length, 0, 'failed refreshes must not renew the persistent cache');
  });

  it('propagates a stale-entry refresh exception instead of swallowing it', async () => {
    const state = globalThis.__wmProxyPersistentResponseCacheTestState!;
    state.cached = cachedResponse('<rss>expired</rss>', EXPIRED_RESPONSE_AGE_MS);
    state.networkOutcomes.push(new Error('network offline'));

    await assert.rejects(
      proxyModule.fetchWithProxy(API_PATH),
      /network offline/,
    );
  });

  it('caps an excessive server max-age so cached news cannot remain live indefinitely', async () => {
    const state = globalThis.__wmProxyPersistentResponseCacheTestState!;
    state.cached = cachedResponse('<rss>old</rss>', 16 * 60_000, 'public, max-age=86400');
    state.networkOutcomes.push(new Response('<rss>current</rss>', { status: 200 }));

    const response = await proxyModule.fetchWithProxy(API_PATH);

    assert.equal(await response.text(), '<rss>current</rss>');
  });

  it('does not reuse or persist responses marked no-store', async () => {
    const state = globalThis.__wmProxyPersistentResponseCacheTestState!;
    state.cached = cachedResponse('<rss>stale-cache</rss>', 0, 'no-store');
    state.networkOutcomes.push(new Response('<rss>live-stale</rss>', {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/xml',
      },
    }));

    const response = await proxyModule.fetchWithProxy(API_PATH);

    assert.equal(await response.text(), '<rss>live-stale</rss>');
    assert.equal(state.writes.length, 0, 'no-store responses must not enter the API response cache');
  });
});
