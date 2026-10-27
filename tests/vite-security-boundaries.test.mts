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
    const target = new URL(url);
    if (target.hostname === 'feeds.bbci.co.uk') {
      feedRequests.push(url);
      assert.equal(init?.redirect, 'manual');
      return url.endsWith('/next') ? new Response('<rss/>')
        : new Response(null, { status: 302, headers: { location: redirectTarget } });
    }
    if (target.hostname !== '127.0.0.1' && !['redis.vite.test', 'convex.vite.test'].includes(target.hostname)) {
      feedRequests.push(url);
      throw new Error('Unexpected outbound request');
    }
    if (target.hostname === 'redis.vite.test') {
      if (url.includes('/get/')) cacheReads.push(decodeURIComponent(url.split('/get/')[1]));
      return Response.json({ result: null });
    }
    if (target.hostname === 'convex.vite.test' && target.pathname === '/api/internal-ai-routing-policy') {
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

it('Vite does not trust inbound gateway-only identity stamps', async () => {
  const key = `summary:${CACHE_VERSION}:translate:fr:${'a'.repeat(32)}`;
  const response = await originalFetch(`${base}/api/news/v1/summarize-article-cache?cache_key=${key}`, {
    headers: {
      'X-WorldMonitor-Key': 'vite-test-operator',
      'x-user-id': 'forged-user',
      'x-wm-mcp-internal-verified': '1',
      'x-wm-rl-principal': 'user:forged-user',
    },
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
  // Match api/rss-proxy.js: feed bytes are data, never a same-origin document.
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(await response.text(), '<rss/>');
  feedRequests.length = 0;
  const plaintext = await originalFetch(`${base}/api/rss-proxy?url=${encodeURIComponent('http://feeds.bbci.co.uk/start')}`);
  assert.equal(plaintext.status, 403);
  assert.deepEqual(feedRequests, []);
});

it('Vite applies response sandbox isolation to widget documents', async () => {
  for (const path of ['/wm-widget-sandbox.html', '/%77m-widget-sandbox.html', '/wm-widget%2dsandbox.html',
    '//wm-widget-sandbox.html', '/wm-widget-sandbox.html/.']) {
    const response = await originalFetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy') ?? '', /sandbox allow-scripts;/, path);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none';/, path);
    await response.body?.cancel();
  }
});
