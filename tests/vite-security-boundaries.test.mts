import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { CACHE_VERSION } from '../src/utils/summary-cache-key.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let server: ViteDevServer;
let base: string;
const policyUsers: string[] = [];
const cacheReads: string[] = [];
const feedRequests: string[] = [];
let redirectTarget = '';

before(async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.vite.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.CONVEX_SITE_URL = 'https://convex.vite.test';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'test-secret';
  process.env.WORLDMONITOR_VALID_KEYS = 'vite-test-operator';
  globalThis.fetch = (async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://feeds.bbci.co.uk/')) {
      feedRequests.push(url);
      assert.equal(init?.redirect, 'manual');
      return url.endsWith('/next') ? new Response('<rss/>')
        : new Response(null, { status: 302, headers: { location: redirectTarget } });
    }
    if (/^https?:/.test(url) && !url.startsWith('http://127.0.0.1:') && !url.includes('.vite.test')) {
      feedRequests.push(url);
      throw new Error('Unexpected outbound request');
    }
    if (url.startsWith('https://redis.vite.test')) {
      if (url.includes('/get/')) cacheReads.push(decodeURIComponent(url.split('/get/')[1]));
      return Response.json({ result: null });
    }
    if (url.endsWith('/api/internal-ai-routing-policy')) {
      policyUsers.push(JSON.parse(String(init?.body)).userId);
      return Response.json({ policy: { allowedProviders: [] } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  server = await createServer({
    mode: 'test', logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await server?.close();
  globalThis.fetch = originalFetch;
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
});

it('Vite does not trust an inbound policy user ID', async () => {
  const key = `summary:${CACHE_VERSION}:translate:fr:${'a'.repeat(32)}`;
  const response = await originalFetch(`${base}/api/news/v1/summarize-article-cache?cache_key=${key}`, {
    headers: { 'X-WorldMonitor-Key': 'vite-test-operator', 'x-user-id': 'forged-user' },
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(cacheReads.includes(key), cacheReads.join('\n'));
  assert.deepEqual(policyUsers, []);
});

it('Vite validates RSS redirect destinations before sending requests', async () => {
  for (const target of ['http://127.0.0.1/private', 'https://attacker.example/story', 'http://feeds.bbci.co.uk/next']) {
    redirectTarget = target;
    feedRequests.length = 0;
    const response = await originalFetch(`${base}/api/rss-proxy?url=${encodeURIComponent('https://feeds.bbci.co.uk/start')}`);
    assert.equal(response.status, 403);
    assert.deepEqual(feedRequests, ['https://feeds.bbci.co.uk/start']);
  }
  redirectTarget = '/next';
  const response = await originalFetch(`${base}/api/rss-proxy?url=${encodeURIComponent('https://feeds.bbci.co.uk/start')}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<rss/>');
  feedRequests.length = 0;
  const plaintext = await originalFetch(`${base}/api/rss-proxy?url=${encodeURIComponent('http://feeds.bbci.co.uk/start')}`);
  assert.equal(plaintext.status, 403);
  assert.deepEqual(feedRequests, []);
});

it('Vite applies response sandbox isolation to widget documents', async () => {
  const response = await originalFetch(`${base}/wm-widget-sandbox.html`);
  assert.equal(response.headers.get('content-security-policy'), 'sandbox allow-scripts');
});
