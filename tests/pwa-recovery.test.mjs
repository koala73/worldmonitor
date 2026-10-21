import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const navigationSource = readFileSync(resolve(ROOT, 'public/sw-navigation.js'), 'utf8');

function createNavigationHarness({ fetchImpl, offlineResponse = { offline: true }, cacheNames = [] } = {}) {
  const listeners = new Map();
  const timers = new Map();
  const deletedCaches = [];
  const clearedTimers = [];
  let nextTimerId = 0;

  const context = {
    AbortController,
    Error,
    Promise,
    URL,
    caches: {
      async delete(name) {
        deletedCaches.push(name);
        return true;
      },
      async keys() {
        return cacheNames;
      },
      async match(url, options) {
        assert.equal(url, '/offline.html');
        assert.equal(options.ignoreSearch, true);
        return offlineResponse;
      },
    },
    clearTimeout(id) {
      clearedTimers.push(id);
      timers.delete(id);
    },
    fetch: fetchImpl,
    self: {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      location: { origin: 'https://www.worldmonitor.app' },
    },
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
  };
  vm.runInNewContext(navigationSource, context, { filename: 'sw-navigation.js' });

  return {
    clearedTimers,
    deletedCaches,
    dispatchActivate() {
      let activation;
      listeners.get('activate')({ waitUntil(promise) { activation = promise; } });
      return activation;
    },
    dispatchFetch(request) {
      let response;
      listeners.get('fetch')({ request, respondWith(promise) { response = promise; } });
      return response;
    },
    timers,
  };
}

describe('PWA navigation recovery', () => {
  it('returns the network response first and clears the navigation deadline', async () => {
    const networkResponse = { network: true };
    const harness = createNavigationHarness({ fetchImpl: async () => networkResponse });

    const response = await harness.dispatchFetch({
      mode: 'navigate',
      url: 'https://www.worldmonitor.app/briefs',
    });

    assert.equal(response, networkResponse);
    assert.deepEqual([...harness.timers], []);
    assert.deepEqual(harness.clearedTimers, [1]);
  });

  it('uses the offline fallback after the five-second navigation deadline', async () => {
    let fetchOptions;
    const offlineResponse = { offline: true };
    const harness = createNavigationHarness({
      fetchImpl: (_request, options) => {
        fetchOptions = options;
        return new Promise(() => {});
      },
      offlineResponse,
    });

    const responsePromise = harness.dispatchFetch({
      mode: 'navigate',
      url: 'https://www.worldmonitor.app/briefs',
    });
    const [{ callback, delay }] = harness.timers.values();
    assert.equal(delay, 5_000);
    callback();

    assert.equal(await responsePromise, offlineResponse);
    assert.equal(fetchOptions.signal.aborted, true);
    assert.deepEqual([...harness.timers], []);
  });

  it('leaves API and cross-origin requests to their own handlers', () => {
    let fetchCalls = 0;
    const harness = createNavigationHarness({ fetchImpl: () => { fetchCalls += 1; } });

    assert.equal(harness.dispatchFetch({
      mode: 'navigate',
      url: 'https://www.worldmonitor.app/api/health',
    }), undefined);
    assert.equal(harness.dispatchFetch({
      mode: 'navigate',
      url: 'https://other.example/briefs',
    }), undefined);
    assert.equal(fetchCalls, 0);
  });

  it('removes the legacy navigation cache during activation', async () => {
    const harness = createNavigationHarness({ cacheNames: ['html-navigation', 'workbox-precache-v2'] });

    await harness.dispatchActivate();

    assert.deepEqual(harness.deletedCaches, ['html-navigation']);
  });
});

describe('offline Retry CSP', () => {
  const offlineHtml = readFileSync(resolve(ROOT, 'public/offline.html'), 'utf8');
  const inlineScripts = [...offlineHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  const retryButton = offlineHtml.match(/<button\b[^>]*\bid=["']t-retry["'][^>]*>/i)?.[0] ?? '';
  const scriptHash = `'sha256-${createHash('sha256').update(inlineScripts[0]?.[1] ?? '').digest('base64')}'`;

  it('binds Retry from the trusted inline script instead of an inline event attribute', () => {
    assert.equal(inlineScripts.length, 1, 'offline page should contain one CSP-hashed inline script');
    assert.doesNotMatch(retryButton, /\son\w+\s*=/i);
    assert.match(inlineScripts[0][1], /getElementById\('t-retry'\)\.addEventListener\('click'/);
  });

  it('ships the Retry script hash on Vercel and both nginx dashboard CSP surfaces', () => {
    const vercel = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8'));
    const vercelCsp = vercel.headers
      .find((entry) => entry.headers?.some(
        (header) => header.key === 'X-Frame-Options' && header.value === 'SAMEORIGIN',
      ))
      ?.headers.find((header) => header.key === 'Content-Security-Policy')?.value;
    const nginxSources = [
      readFileSync(resolve(ROOT, 'docker/nginx-security-headers.conf'), 'utf8'),
      readFileSync(resolve(ROOT, 'docker/nginx.conf'), 'utf8'),
    ];
    const nginxCsps = nginxSources.flatMap((source) =>
      [...source.matchAll(/add_header Content-Security-Policy "([^"]+)"/g)]
        .map((match) => match[1])
        .filter((csp) => csp.includes("'strict-dynamic'")),
    );

    assert.ok(vercelCsp?.includes(scriptHash), `Vercel CSP is missing ${scriptHash}`);
    assert.equal(nginxCsps.length, 2, 'expected both nginx dashboard CSP surfaces');
    for (const csp of nginxCsps) {
      assert.ok(csp.includes(scriptHash), `nginx CSP is missing ${scriptHash}`);
    }
  });
});
