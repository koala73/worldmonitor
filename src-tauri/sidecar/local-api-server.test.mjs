import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http, { createServer, request as httpRequest } from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

delete process.env.WS_RELAY_URL;
const { createLocalApiServer, __testing__ } = await import('./local-api-server.mjs');

test('bundles the shared LLM health provider registry with the sidecar (#7126)', () => {
  const config = JSON.parse(readFileSync(new URL('../tauri.conf.json', import.meta.url), 'utf8'));
  const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  assert.ok(config.bundle.resources.includes('../shared/llm-health-providers.js'));
  assert.match(
    dockerfile,
    /COPY --from=builder \/app\/shared\/llm-health-providers\.js \.\/shared\/llm-health-providers\.js/,
  );
  assert.match(dockerfile, /^ENV LOCAL_API_RESOURCE_DIR=\/app$/m);
});

// api/_user-api-key.js imports ../shared/desktop-key-access.js, so every route
// that validates a user API key needs it shipped next to api/ (#9906).
test('ships the shared desktop key access module with the sidecar (#9906)', () => {
  const config = JSON.parse(readFileSync(new URL('../tauri.conf.json', import.meta.url), 'utf8'));
  const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  assert.ok(config.bundle.resources.includes('../shared/desktop-key-access.js'));
  assert.match(
    dockerfile,
    /COPY --from=builder \/app\/shared\/desktop-key-access\.js \.\/shared\/desktop-key-access\.js/,
  );
});

// Served locally, these answer 5xx or an empty 200 (notification-suppressions);
// the cloud holds their state. Before #9906 a failed Upstash import hid that.
// reverse-geocode answers 503 locally: its Nominatim limiter fails closed
// without Upstash, and its geocode cache is the cloud's Redis.
test('prefers the cloud for routes whose state lives only in the cloud (#9906)', () => {
  for (const pathname of [
    '/api/analytics-health',
    '/api/notification-suppressions',
    '/api/oauth/authorize',
    '/api/oauth/register',
    '/api/reverse-geocode',
    '/api/security/report',
    '/api/wm-session',
  ]) {
    assert.equal(__testing__.isCloudPreferred(pathname), true, pathname);
  }
  for (const pathname of ['/api/opensky', '/api/oref-alerts', '/api/polymarket', '/api/telegram-feed', '/api/x-feed']) {
    assert.equal(__testing__.isCloudPreferred(pathname), false, pathname);
  }
});

test('jsonForScript keeps any value inside an inline <script> as data', () => {
  const { jsonForScript } = __testing__;
  const hostile = '</script><script>alert(1)</script>\u2028\u2029<!--&';
  const encoded = jsonForScript(hostile);
  assert.doesNotMatch(encoded, /[<>&\u2028\u2029]/);
  assert.equal(runInNewContext(`(${encoded})`), hostile);
  assert.equal(jsonForScript(null), 'null');
  assert.equal(runInNewContext(`(${jsonForScript('live_stream')})`), 'live_stream');
});

test('isYahooFinanceHost matches finance.yahoo.com and its subdomains only', () => {
  const { isYahooFinanceHost } = __testing__;
  for (const host of ['finance.yahoo.com', 'query1.finance.yahoo.com', 'query2.finance.yahoo.com',
    'finance.yahoo.com.', 'query1.finance.yahoo.com.']) {
    assert.equal(isYahooFinanceHost(host), true, host);
  }
  for (const host of ['evilfinance.yahoo.com', 'finance.yahoo.com.evil.example', 'yahoo.com', 'example.com', 'finance.yahoo.com..']) {
    assert.equal(isYahooFinanceHost(host), false, host);
  }
});

test('keeps seed-owned WSB snapshots cloud-preferred', () => {
  assert.equal(__testing__.isCloudPreferred('/api/intelligence/v1/list-wsb-tickers'), true);
});

test('keeps seed-owned defense snapshots cloud-preferred regardless of relay configuration', () => {
  assert.equal(__testing__.isCloudPreferred('/api/bootstrap'), true);
  assert.equal(__testing__.isCloudPreferred('/api/military/v1/get-defense-industrial-base'), true);
  assert.equal(__testing__.isCloudPreferred('/api/scorecard/v1/get-five-factor-scorecard'), true);
  assert.equal(__testing__.isCloudPreferred('/api/scorecard/v1/get-bloc-scorecard'), true);
  assert.equal(__testing__.isCloudPreferred('/api/scorecard/v1/list-five-factor-scorecards'), true);
});

test('keeps seed-owned commodity vulnerability snapshots cloud-preferred', async () => {
  const endpoints = [
    '/api/supply-chain/v1/get-country-vulnerabilities',
    '/api/supply-chain/v1/get-chokepoint-dependencies',
    '/api/supply-chain/v1/list-vulnerability-rankings',
  ];
  for (const endpoint of endpoints) {
    assert.equal(__testing__.isCloudPreferred(endpoint), true);
  }

  const remote = await setupRemoteServer();
  const unavailableHandler = `
    export default async function handler() {
      return new Response(JSON.stringify({ source: 'local-empty', upstreamUnavailable: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  `;
  const localApi = await setupApiDir(Object.fromEntries(
    endpoints.map((endpoint) => [`${endpoint.slice('/api/'.length)}.js`, unavailableHandler]),
  ));
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    cloudFallback: 'true',
    allowPrivateRemoteBase: true,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    for (const endpoint of endpoints) {
      const response = await authFetch(`http://127.0.0.1:${port}${endpoint}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.source, 'remote');
    }
    assert.deepEqual(remote.hits, endpoints);
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
  }
});

// The cloud edge 403s short or library user agents, and the gateway accepts a
// Pro desktop only with the same pair a Pro browser sends: an anonymous wms_
// session plus the user's Clerk bearer (#9396).
async function setupCloudAuthRemote() {
  const mints = [];
  const calls = [];
  // Tests override these to simulate short-lived sessions, failed mints and a slow edge.
  const behavior = { mint: () => ({ lifetimeMs: 12 * 60 * 60 * 1000 }), callDelayMs: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/wm-session') {
      mints.push({ method: req.method, origin: req.headers.origin, userAgent: req.headers['user-agent'] });
      const { lifetimeMs, fail, delayMs = 0 } = behavior.mint(mints.length);
      await sleep(delayMs);
      if (fail) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, exp: Date.now() + lifetimeMs, token: `wms_minted_${mints.length}` }));
      return;
    }
    calls.push({ path: url.pathname, headers: req.headers });
    await sleep(behavior.callDelayMs);
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ source: 'remote' }));
  });
  const port = await listen(server);
  return {
    mints,
    calls,
    behavior,
    remoteBase: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function withCloudAuthSidecar(run) {
  const endpoint = '/api/displacement/v1/get-displacement-summary';
  const remote = await setupCloudAuthRemote();
  const localApi = await setupApiDir({
    'displacement/v1/get-displacement-summary.js': 'export default () => Response.json({ source: "local-empty" });',
  });
  const originalProductKey = process.env.WORLDMONITOR_API_KEY;
  const originalVersion = process.env.LOCAL_API_APP_VERSION;
  delete process.env.WORLDMONITOR_API_KEY;
  process.env.LOCAL_API_APP_VERSION = '9.8.7';
  const app = await createLocalApiServer({
    port: 0, apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase, cloudFallback: 'true', allowPrivateRemoteBase: true,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();
  try {
    await run({ remote, url: `http://127.0.0.1:${port}${endpoint}` });
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
    if (originalProductKey === undefined) delete process.env.WORLDMONITOR_API_KEY;
    else process.env.WORLDMONITOR_API_KEY = originalProductKey;
    if (originalVersion === undefined) delete process.env.LOCAL_API_APP_VERSION;
    else process.env.LOCAL_API_APP_VERSION = originalVersion;
  }
}

for (const rendererUserAgent of [undefined, 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15']) {
  test(`cloud requests carry the sidecar user agent when the renderer sent ${rendererUserAgent ? 'a WebView UA' : 'none'}`, async () => {
    await withCloudAuthSidecar(async ({ remote, url }) => {
      const response = await authFetch(url, rendererUserAgent ? { headers: { 'User-Agent': rendererUserAgent } } : {});
      assert.equal(response.status, 200);
      assert.equal(remote.calls[0].headers['user-agent'], 'WorldMonitor-Desktop/9.8.7 (sidecar)');
    });
  });
}

// A keyless cloud call is a 401 since #3541, which left signed-out desktops
// with empty panels (#7548). They authenticate like an anonymous browser.
test('a signed-out desktop sends one cached anonymous session and no user credential', async () => {
  await withCloudAuthSidecar(async ({ remote, url }) => {
    assert.equal((await authFetch(url)).status, 200);
    assert.equal((await authFetch(url)).status, 200);
    assert.deepEqual(remote.mints, [{ method: 'POST', origin: 'https://worldmonitor.app', userAgent: 'WorldMonitor-Desktop/9.8.7 (sidecar)' }]);
    for (const call of remote.calls) {
      assert.equal(call.headers.authorization, undefined);
      assert.equal(call.headers['x-worldmonitor-key'], 'wms_minted_1');
    }
  });
});

test('a signed-out desktop still reaches the cloud keyless when minting fails', async () => {
  await withCloudAuthSidecar(async ({ remote, url }) => {
    remote.behavior.mint = () => ({ fail: true });
    assert.equal((await authFetch(url)).status, 200);
    assert.equal(remote.mints.length, 1);
    assert.equal(remote.calls[0].headers['x-worldmonitor-key'], undefined);
  });
});

test('a forwarded Pro bearer reaches the cloud with one cached anonymous session', async () => {
  await withCloudAuthSidecar(async ({ remote, url }) => {
    const headers = { 'X-WorldMonitor-User-Authorization': 'Bearer clerk-jwt' };
    assert.equal((await authFetch(url, { headers })).status, 200);
    assert.equal((await authFetch(url, { headers })).status, 200);
    assert.deepEqual(remote.mints, [{ method: 'POST', origin: 'https://worldmonitor.app', userAgent: 'WorldMonitor-Desktop/9.8.7 (sidecar)' }]);
    for (const call of remote.calls) {
      assert.equal(call.headers.authorization, 'Bearer clerk-jwt');
      assert.equal(call.headers['x-worldmonitor-key'], 'wms_minted_1');
      assert.equal(call.headers['x-worldmonitor-user-authorization'], undefined);
    }
  });
});

test('a valid session survives a failed refresh until it expires', async () => {
  await withCloudAuthSidecar(async ({ remote, url }) => {
    // Two minutes left is inside the refresh margin, so the next request refreshes.
    remote.behavior.mint = (n) => (n === 1 ? { lifetimeMs: 2 * 60 * 1000 } : { fail: true });
    const headers = { 'X-WorldMonitor-User-Authorization': 'Bearer clerk-jwt' };
    for (let i = 0; i < 3; i += 1) assert.equal((await authFetch(url, { headers })).status, 200);
    assert.equal(remote.mints.length, 2, 'one refresh attempt, then the retry pause');
    for (const call of remote.calls) assert.equal(call.headers['x-worldmonitor-key'], 'wms_minted_1');
  });
});

test('session minting and the cloud fetch share one deadline', async () => {
  await withCloudAuthSidecar(async ({ remote, url }) => {
    remote.behavior.mint = () => ({ lifetimeMs: 12 * 60 * 60 * 1000, delayMs: 2_500 });
    remote.behavior.callDelayMs = 2_000;
    const startedAt = Date.now();
    await authFetch(url, { headers: { 'X-WorldMonitor-User-Authorization': 'Bearer clerk-jwt' } });
    assert.ok(Date.now() - startedAt < 3_600, `took ${Date.now() - startedAt}ms`);
  });
});

test('a renderer-supplied key wins over the minted session on a signed-out desktop', async () => {
  await withCloudAuthSidecar(async ({ remote, url }) => {
    process.env.WORLDMONITOR_API_KEY = 'desktop-product-key';
    assert.equal((await authFetch(url, { headers: { 'X-WorldMonitor-Key': 'wm_renderer_key' } })).status, 200);
    assert.equal(remote.mints.length, 0);
    assert.equal(remote.calls[0].headers['x-worldmonitor-key'], 'wm_renderer_key');
    assert.equal(remote.calls[0].headers.authorization, undefined);
  });
});

test('a configured product key wins over the minted session', async () => {
  await withCloudAuthSidecar(async ({ remote, url }) => {
    process.env.WORLDMONITOR_API_KEY = 'desktop-product-key';
    const headers = { 'X-WorldMonitor-User-Authorization': 'Bearer clerk-jwt' };
    assert.equal((await authFetch(url, { headers })).status, 200);
    assert.equal(remote.mints.length, 0);
    assert.equal(remote.calls[0].headers['x-worldmonitor-key'], 'desktop-product-key');
    assert.equal(remote.calls[0].headers.authorization, 'Bearer clerk-jwt');
  });
});

test('local handlers never see the forwarded user credential', async () => {
  const localApi = await setupApiDir({
    'header-check.js': `export default (req) => Response.json({
      userAuthorization: req.headers.get('x-worldmonitor-user-authorization'),
    });`,
  });
  const app = await createLocalApiServer({ port: 0, apiDir: localApi.apiDir, logger: { log() {}, warn() {}, error() {} } });
  const { port } = await app.start();
  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/header-check`, {
      headers: { 'X-WorldMonitor-User-Authorization': 'Bearer clerk-jwt' },
    });
    assert.deepEqual(await response.json(), { userAuthorization: null });
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('a forwarded user credential that is not a bearer is dropped', async () => {
  await withCloudAuthSidecar(async ({ remote, url }) => {
    const headers = { 'X-WorldMonitor-User-Authorization': 'Basic Zm9vOmJhcg==' };
    assert.equal((await authFetch(url, { headers })).status, 200);
    assert.equal(remote.calls[0].headers.authorization, undefined);
    assert.equal(remote.calls[0].headers['x-worldmonitor-key'], 'wms_minted_1');
    assert.equal(remote.calls[0].headers['x-worldmonitor-user-authorization'], undefined);
  });
});

test('routes seed-only displacement requests to cloud before a local empty 200', async () => {
  const endpoint = '/api/displacement/v1/get-displacement-summary';
  const seeded = { summary: { year: 2025, countries: [{ code: 'SYR' }], topFlows: [] }, fetchedAt: 123456, dataAvailable: true };
  const hits = [];
  const remote = createServer((req, res) => {
    if (answerSessionMint(req, res)) return;
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(seeded));
  });
  const remotePort = await listen(remote);
  const localApi = await setupApiDir({
    'displacement/v1/get-displacement-summary.js': `export default async function handler() {
      return Response.json({ dataAvailable: false, fetchedAt: 0 });
    }`,
  });
  const app = await createLocalApiServer({
    port: 0, apiDir: localApi.apiDir,
    remoteBase: `http://127.0.0.1:${remotePort}`, cloudFallback: 'true', allowPrivateRemoteBase: true,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();
  try {
    const query = '?year=0&flow_limit=50';
    const response = await authFetch(`http://127.0.0.1:${port}${endpoint}${query}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), seeded);
    assert.deepEqual(hits, [`${endpoint}${query}`]);
    assert.equal(__testing__.isCloudPreferred(endpoint), true);
  } finally {
    await app.close();
    await localApi.cleanup();
    await new Promise((resolve, reject) => remote.close(error => error ? reject(error) : resolve()));
  }
});

test('keeps desktop Ollama headline translation on the local handler (#9476)', async () => {
  assert.equal(__testing__.isCloudPreferred('/api/news/v1/summarize-article'), true);
  const savedEnv = {
    WS_RELAY_URL: process.env.WS_RELAY_URL,
    LOCAL_API_MODE: process.env.LOCAL_API_MODE,
    LOCAL_API_CLOUD_FALLBACK: process.env.LOCAL_API_CLOUD_FALLBACK,
    OLLAMA_API_URL: process.env.OLLAMA_API_URL,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
  };
  delete process.env.WS_RELAY_URL;
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  process.env.LOCAL_API_CLOUD_FALLBACK = 'true';
  process.env.OLLAMA_MODEL = 'qwen3:8b';

  const ollamaHits = [];
  const ollama = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      ollamaHits.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ summary: 'Traduction locale' }));
    });
  });
  const ollamaPort = await listen(ollama);
  process.env.OLLAMA_API_URL = `http://127.0.0.1:${ollamaPort}`;

  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({
    'news/v1/summarize-article.js': `
      export default async function handler(request) {
        const body = await request.json();
        if (body.provider === 'ollama' && body.mode === 'translate') {
          if (body.fail === 'status') {
            return Response.json({ error: 'Ollama translation failed', provider: 'ollama' }, { status: 502 });
          }
          if (body.fail === 'throw') throw new Error('ollama down');
          const endpoint = new URL('/v1/chat/completions', process.env.OLLAMA_API_URL);
          const upstream = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: process.env.OLLAMA_MODEL }),
          });
          const data = await upstream.json();
          return Response.json({ source: 'local-ollama', provider: 'ollama', summary: data.summary });
        }
        return Response.json({ source: 'local-summarize', provider: body.provider, mode: body.mode });
      }
    `,
    'news/v1/list-feed-digest.js': `
      export default function handler() {
        return Response.json({ source: 'local-news' });
      }
    `,
  });
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    allowPrivateRemoteBase: true,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const postSummarize = (payload, headers) => authFetch(`${base}/api/news/v1/summarize-article`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const summarizeHits = () => remote.hits.filter((hit) => hit === '/api/news/v1/summarize-article');

  try {
    const translated = await postSummarize({
      provider: 'ollama',
      mode: 'translate',
      headlines: ['Hello world'],
      variant: 'fr',
    });
    assert.equal(translated.status, 200);
    assert.deepEqual(await translated.json(), {
      source: 'local-ollama',
      provider: 'ollama',
      summary: 'Traduction locale',
    });
    assert.deepEqual(ollamaHits, ['/v1/chat/completions']);
    assert.deepEqual(summarizeHits(), []);

    const paid = await postSummarize({ provider: 'groq', mode: 'brief', headlines: ['Markets'] });
    assert.equal(paid.status, 200);
    assert.equal((await paid.json()).source, 'remote');
    assert.deepEqual(ollamaHits, ['/v1/chat/completions']);
    assert.deepEqual(summarizeHits(), ['/api/news/v1/summarize-article']);

    const otherTranslate = await postSummarize({ provider: 'groq', mode: 'translate', headlines: ['Hello'] });
    assert.equal((await otherTranslate.json()).source, 'remote');
    assert.deepEqual(ollamaHits, ['/v1/chat/completions']);

    const ollamaBrief = await postSummarize({ provider: 'ollama', mode: 'brief', headlines: ['Local summary'] });
    assert.equal((await ollamaBrief.json()).source, 'remote');
    assert.deepEqual(ollamaHits, ['/v1/chat/completions']);

    const digest = await authFetch(`${base}/api/news/v1/list-feed-digest`);
    assert.equal(digest.status, 200);
    assert.equal((await digest.json()).source, 'remote');

    const malformed = await authFetch(`${base}/api/news/v1/summarize-article`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal((await malformed.json()).source, 'remote');

    const failed = await postSummarize({
      provider: 'ollama',
      mode: 'translate',
      headlines: ['Hello'],
      fail: 'status',
    });
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: 'Ollama translation failed', provider: 'ollama' });

    const thrown = await postSummarize({
      provider: 'ollama',
      mode: 'translate',
      headlines: ['Hello'],
      fail: 'throw',
    });
    assert.equal(thrown.status, 502);
    const thrownBody = await thrown.json();
    assert.equal(thrownBody.error, 'Local handler error');
    assert.equal(thrownBody.endpoint, '/api/news/v1/summarize-article');
    assert.equal(ollamaHits.length, 1);

    const anonymous = await fetch(`${base}/api/news/v1/summarize-article`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama', mode: 'translate', headlines: ['Hello'] }),
    });
    assert.equal(anonymous.status, 401);
    assert.equal(ollamaHits.length, 1);
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
    ollama.closeAllConnections();
    await new Promise((resolve) => ollama.close(resolve));
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const failure of ['silent', 'trickle', 'refused']) {
  test(`cloud-preferred requests use local fallback when cloud is ${failure}`, async () => {
    const endpoint = '/api/displacement/v1/get-displacement-summary';
    const hits = [];
    const timers = new Set();
    const remote = createServer((req, res) => {
      if (answerSessionMint(req, res)) return;
      hits.push(req.url);
      if (failure === 'trickle') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
        const timer = setInterval(() => res.write(' '), 50);
        timers.add(timer);
        res.once('close', () => { clearInterval(timer); timers.delete(timer); });
      }
    });
    const remotePort = await listen(remote);
    if (failure === 'refused') await new Promise(resolve => remote.close(resolve));
    const localApi = await setupApiDir({
      'displacement/v1/get-displacement-summary.js': `export default async function handler(req) {
        return Response.json({ source: 'local-empty', dataAvailable: false, body: await req.json() });
      }`,
    });
    const app = await createLocalApiServer({
      port: 0, apiDir: localApi.apiDir,
      remoteBase: `http://127.0.0.1:${remotePort}`, cloudFallback: 'true', allowPrivateRemoteBase: true,
      logger: { log() {}, warn() {}, error() {} },
    });
    const { port } = await app.start();
    let deadline;
    try {
      const response = await Promise.race([
        authFetch(`http://127.0.0.1:${port}${endpoint}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"year":2025}',
        }),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('cloud attempt did not reach local fallback within 4s')), 4000);
        }),
      ]);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { source: 'local-empty', dataAvailable: false, body: { year: 2025 } });
      assert.deepEqual(hits, failure === 'refused' ? [] : [endpoint]);
    } finally {
      clearTimeout(deadline);
      for (const timer of timers) clearInterval(timer);
      remote.closeAllConnections();
      if (remote.listening) await new Promise(resolve => remote.close(resolve));
      await app.close();
      await localApi.cleanup();
    }
  });
}

for (const allowPrivateRemoteBase of [false, true]) {
  test(`cloud proxy preserves its configured base and SSRF guard with private opt-in ${allowPrivateRemoteBase}`, async () => {
    const remote = await setupRemoteServer();
    const localApi = await setupApiDir({
      'displacement/v1/get-displacement-summary.js': 'export default () => Response.json({ source: "local-empty" });',
    });
    const app = await createLocalApiServer({
      port: 0, apiDir: localApi.apiDir, remoteBase: `${remote.remoteBase}/cloud-prefix`,
      cloudFallback: 'true', allowPrivateRemoteBase,
      logger: { log() {}, warn() {}, error() {} },
    });
    const { port } = await app.start();
    try {
      const endpoint = '/api/displacement/v1/get-displacement-summary';
      const response = await authFetch(`http://127.0.0.1:${port}${endpoint}?url=http://169.254.169.254/secret`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.source, allowPrivateRemoteBase ? 'remote' : 'local-empty');
      assert.deepEqual(remote.hits, allowPrivateRemoteBase ? [`/cloud-prefix${endpoint}`] : []);
    } finally {
      await app.close();
      await localApi.cleanup();
      await remote.close();
    }
  });
}

for (const localFailure of ['missing', 'error-response', 'throw']) {
  test(`does not retry a timed-out cloud-preferred POST when the local handler is ${localFailure}`, async () => {
    const endpoint = '/api/v2/shipping/webhooks';
    let cloudCalls = 0;
    const remote = createServer((req, res) => {
      if (!answerSessionMint(req, res)) cloudCalls++;
    });
    const remotePort = await listen(remote);
    const handlers = {
      'error-response': 'export default () => Response.json({ error: "unavailable" }, { status: 503 });',
      throw: 'export default () => { throw new Error("local unavailable"); };',
    };
    const localApi = await setupApiDir(localFailure === 'missing' ? {} : {
      'v2/shipping/webhooks.js': handlers[localFailure],
    });
    const app = await createLocalApiServer({
      port: 0, apiDir: localApi.apiDir,
      remoteBase: `http://127.0.0.1:${remotePort}`, cloudFallback: 'true', allowPrivateRemoteBase: true,
      logger: { log() {}, warn() {}, error() {} },
    });
    const { port } = await app.start();
    let deadline;
    try {
      const response = await Promise.race([
        authFetch(`http://127.0.0.1:${port}${endpoint}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"https://example.com/hook"}',
        }),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('cloud-preferred POST was retried after its deadline')), 4000);
        }),
      ]);
      assert.equal(response.status, { missing: 404, 'error-response': 503, throw: 502 }[localFailure]);
      assert.equal(cloudCalls, 1, 'a POST may already have applied its side effect before the cloud response stalls');
    } finally {
      clearTimeout(deadline);
      remote.closeAllConnections();
      await new Promise(resolve => remote.close(resolve));
      await app.close();
      await localApi.cleanup();
    }
  });
}

test('cloud proxy cancels its upstream request when the desktop client disconnects', async () => {
  let cloudRequest;
  let cloudClosed;
  const received = new Promise(resolve => { cloudRequest = resolve; });
  const closed = new Promise(resolve => { cloudClosed = resolve; });
  const remote = createServer((req, res) => {
    if (answerSessionMint(req, res)) return;
    res.once('close', cloudClosed);
    cloudRequest();
  });
  const remotePort = await listen(remote);
  const localApi = await setupApiDir({
    'displacement/v1/get-displacement-summary.js': 'export default () => Response.json({ dataAvailable: false });',
  });
  const app = await createLocalApiServer({
    port: 0, apiDir: localApi.apiDir,
    remoteBase: `http://127.0.0.1:${remotePort}`, cloudFallback: 'true', allowPrivateRemoteBase: true,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();
  const client = httpRequest(`http://127.0.0.1:${port}/api/displacement/v1/get-displacement-summary`, {
    headers: { Authorization: `Bearer ${TEST_LOCAL_API_TOKEN}` },
  });
  client.on('error', () => {});
  let deadline;
  try {
    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('cloud proxy disconnect test did not settle within 1s')), 1000);
    });
    client.end();
    await Promise.race([received, timeout]);
    client.destroy();
    await Promise.race([closed, timeout]);
  } finally {
    clearTimeout(deadline);
    client.destroy();
    remote.closeAllConnections();
    await new Promise(resolve => remote.close(resolve));
    await app.close();
    await localApi.cleanup();
  }
});

// The sidecar default-denies when LOCAL_API_TOKEN is unset (security fix:
// previously "unset" meant "auth disabled", which made any standalone run
// an open local-HTTP proxy). Set a stable test token + an authFetch helper
// so the existing test cases continue to exercise their original code
// paths instead of the new global auth gate.
const TEST_LOCAL_API_TOKEN = 'sidecar-test-token';
process.env.LOCAL_API_TOKEN = TEST_LOCAL_API_TOKEN;

function authFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${TEST_LOCAL_API_TOKEN}`;
  }
  return fetch(url, { ...options, headers });
}

async function listen(server, host = '127.0.0.1', port = 0) {
  await new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve server address');
  }
  return address.port;
}

function executeYoutubeEmbedHtml(html) {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, 'youtube embed response must contain an executable script');
  const posted = [];
  const appendedScripts = [];
  const messageListeners = [];
  let playerEvents = null;
  let playerOptions = null;
  const parent = {};
  Object.defineProperty(parent, 'postMessage', {
    configurable: false,
    get: () => (message, targetOrigin) => posted.push({ message, targetOrigin }),
    set: () => {
      throw new Error('child attempted to replace parent.postMessage');
    },
  });
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: {
      parent,
      addEventListener(type, listener) {
        if (type === 'message') messageListeners.push(listener);
      },
    },
    document: {
      createElement: () => ({}),
      head: { appendChild: (node) => appendedScripts.push(node) },
      getElementById: () => ({ classList: { add() {}, remove() {} } }),
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    YT: {
      Player: class {
        constructor(_elementId, options) {
          playerOptions = options;
          playerEvents = options.events;
        }

        mute() {}
        playVideo() {}
        isMuted() { return true; }
        getVolume() { return 0; }
        getPlayerState() { return 1; }
        getDuration() { return 4_056_940; }
        getVideoData() {
          return { video_id: 'gCNeDWCI0vo', isLive: true, title: 'Al Jazeera English | Live', author: 'Al Jazeera English' };
        }
      },
    },
  };

  runInNewContext(script, sandbox);
  assert.equal(typeof sandbox.onYouTubeIframeAPIReady, 'function');
  sandbox.onYouTubeIframeAPIReady();
  playerEvents.onReady();
  const sendMessage = (data) => {
    for (const listener of messageListeners) listener({ data, origin: 'https://tauri.localhost', source: parent });
  };
  return { posted, appendedScripts, playerOptions, sendMessage };
}

test('youtube embed bridge plays a channel live embed and rejects ambiguous or malformed ids', async () => {
  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();
  const embed = (query) => fetch(`http://127.0.0.1:${port}/api/youtube-embed?${query}&parentOrigin=${encodeURIComponent('https://tauri.localhost')}`);

  try {
    const channelResponse = await embed('channel=UCNye-wNBqNL5ZzHSJj3l8Bg');
    assert.equal(channelResponse.status, 200);
    const channel = executeYoutubeEmbedHtml(await channelResponse.text());
    assert.equal(channel.playerOptions.videoId, 'live_stream');
    assert.equal(channel.playerOptions.playerVars.channel, 'UCNye-wNBqNL5ZzHSJj3l8Bg');

    const videoResponse = await embed('videoId=zp6LNSoq000');
    const video = executeYoutubeEmbedHtml(await videoResponse.text());
    assert.equal(video.playerOptions.videoId, 'zp6LNSoq000');
    assert.equal(video.playerOptions.playerVars.channel, undefined);
    // A tile that draws its own chrome asks for none; the default stays the native control bar.
    assert.equal(video.playerOptions.playerVars.controls, 1);
    const chromeless = executeYoutubeEmbedHtml(await (await embed('videoId=zp6LNSoq000&controls=0')).text());
    assert.equal(chromeless.playerOptions.playerVars.controls, 0);
    // Muted by default so autoplay is allowed; an unmuted session must get sound, not a hardcoded mute.
    assert.equal(video.playerOptions.playerVars.mute, 1);
    const unmuted = executeYoutubeEmbedHtml(await (await embed('videoId=zp6LNSoq000&mute=0')).text());
    assert.equal(unmuted.playerOptions.playerVars.mute, 0);

    for (const query of [
      'videoId=zp6LNSoq000&channel=UCNye-wNBqNL5ZzHSJj3l8Bg',
      'autoplay=1',
      'channel=UCshort',
      'channel=%40AlJazeeraEnglish',
      'videoId=zp6LNSoq000%22',
    ]) {
      const response = await embed(query);
      assert.equal(response.status, 400, `${query} must be rejected`);
    }
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('youtube embed bridge answers a probe with video data for the allowed parent only', async () => {
  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const allowedResponse = await fetch(
      `http://127.0.0.1:${port}/api/youtube-embed?videoId=gCNeDWCI0vo&parentOrigin=${encodeURIComponent('https://tauri.localhost')}`,
    );
    const allowed = executeYoutubeEmbedHtml(await allowedResponse.text());
    allowed.sendMessage({ type: 'probe' });
    const reply = allowed.posted.find(({ message }) => message?.type === 'yt-video-data');
    // The message is built inside the sandbox's own realm; compare its JSON shape.
    assert.deepEqual(JSON.parse(JSON.stringify(reply ?? null)), {
      message: {
        type: 'yt-video-data',
        videoId: 'gCNeDWCI0vo',
        isLive: true,
        title: 'Al Jazeera English | Live',
        author: 'Al Jazeera English',
        duration: 4_056_940,
        state: 1,
      },
      targetOrigin: 'https://tauri.localhost',
    });

    const rejectedResponse = await fetch(
      `http://127.0.0.1:${port}/api/youtube-embed?videoId=gCNeDWCI0vo&parentOrigin=${encodeURIComponent('https://evil.example')}`,
    );
    const rejected = executeYoutubeEmbedHtml(await rejectedResponse.text());
    rejected.sendMessage({ type: 'probe' });
    assert.deepEqual(rejected.posted, [], 'a rejected parent must receive no video data');
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('youtube embed bridge accepts exact Tauri origin and no-ops rejected parents', async () => {
  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const allowedResponse = await fetch(
      `http://127.0.0.1:${port}/api/youtube-embed?videoId=e34xb-Fbl0U&parentOrigin=${encodeURIComponent('https://tauri.localhost')}`,
    );
    assert.equal(allowedResponse.status, 200);
    const allowed = executeYoutubeEmbedHtml(await allowedResponse.text());
    assert.equal(allowed.appendedScripts.length, 1, 'the YouTube API must still initialize');
    assert.ok(
      allowed.posted.some(({ message, targetOrigin }) => message?.type === 'yt-ready' && targetOrigin === 'https://tauri.localhost'),
      'supported Tauri parent must receive yt-ready at its exact origin',
    );

    for (const parentOrigin of ['', 'https://evil.example']) {
      const query = parentOrigin ? `&parentOrigin=${encodeURIComponent(parentOrigin)}` : '';
      const response = await fetch(
        `http://127.0.0.1:${port}/api/youtube-embed?videoId=e34xb-Fbl0U${query}`,
      );
      assert.equal(response.status, 200);
      const rejected = executeYoutubeEmbedHtml(await response.text());
      assert.equal(rejected.appendedScripts.length, 1, 'rejected parents must not abort player setup');
      assert.deepEqual(rejected.posted, [], 'rejected parents must receive no bridge messages');
    }
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

async function postJsonViaHttp(url, payload, headers = {}) {
  const target = new URL(url);
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: Number(target.port || 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'Authorization': `Bearer ${process.env.LOCAL_API_TOKEN || ''}`,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-json response */ }
        resolve({ status: res.statusCode || 0, text, json });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getJsonViaHttp(url) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: Number(target.port || 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.LOCAL_API_TOKEN || ''}`,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-json response */ }
        resolve({ status: res.statusCode || 0, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function mockHttpsRequestOnce({ statusCode, headers, body }) {
  const original = https.request;
  https.request = (_options, onResponse) => {
    const req = new EventEmitter();
    req.setTimeout = () => { };
    req.write = () => { };
    req.destroy = (error) => {
      if (error) req.emit('error', error);
    };
    req.end = () => {
      queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.statusMessage = '';
        res.headers = headers;
        onResponse(res);
        if (body) res.emit('data', Buffer.from(body));
        res.emit('end');
      });
    };
    return req;
  };
  return () => {
    https.request = original;
  };
}

// Every keyless cloud call mints an anonymous session first (#7548). Fake
// clouds answer it at once so their assertions still see the proxied request.
function answerSessionMint(req, res) {
  if (!new URL(req.url || '/', 'http://127.0.0.1').pathname.endsWith('/api/wm-session')) return false;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, exp: Date.now() + 60 * 60 * 1000, token: 'wms_test' }));
  return true;
}

async function setupRemoteServer() {
  const hits = [];
  const origins = [];
  const headers = [];
  const server = createServer((req, res) => {
    if (answerSessionMint(req, res)) return;
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    hits.push(url.pathname);
    origins.push(req.headers.origin || null);
    headers.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      source: 'remote',
      path: url.pathname,
      origin: req.headers.origin || null,
    }));
  });

  const port = await listen(server);
  return {
    hits,
    origins,
    headers,
    remoteBase: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function setupRegisterInterestRemote() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        path: req.url,
        headers: req.headers,
        body,
        json: JSON.parse(body),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'registered', referralCode: 'abc', referralCount: 0 }));
    });
  });

  const port = await listen(server);
  return {
    requests,
    remoteBase: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function setupApiDir(files) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wm-sidecar-test-'));
  const apiDir = path.join(tempRoot, 'api');
  await mkdir(apiDir, { recursive: true });

  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const absolute = path.join(apiDir, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, source, 'utf8');
    })
  );

  return {
    apiDir,
    async cleanup() {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

async function setupResourceDirWithUpApi(files) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wm-sidecar-resource-test-'));
  const apiDir = path.join(tempRoot, '_up_', 'api');
  await mkdir(apiDir, { recursive: true });

  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const absolute = path.join(apiDir, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, source, 'utf8');
    })
  );

  return {
    resourceDir: tempRoot,
    apiDir,
    async cleanup() {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

test('returns local error directly when cloudFallback is off (default)', async () => {
  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({
    'fred-data.js': `
      export default async function handler() {
        return new Response(JSON.stringify({ source: 'local-error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/fred-data`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.source, 'local-error');
    assert.equal(remote.hits.length, 0);
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
  }
});

test('falls back to cloud when cloudFallback is enabled and local handler returns 500', async () => {
  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({
    'fred-data.js': `
      export default async function handler() {
        return new Response(JSON.stringify({ source: 'local-error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    cloudFallback: 'true',
    allowPrivateRemoteBase: true,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/fred-data`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'remote');
    assert.equal(remote.hits.includes('/api/fred-data'), true);
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
  }
});

test('preserves POST body when cloud fallback is triggered after local non-OK response', async () => {
  const remoteBodies = [];
  const remote = createServer((req, res) => {
    if (answerSessionMint(req, res)) return;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      remoteBodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ source: 'remote', body }));
    });
  });
  const remotePort = await listen(remote);

  const localApi = await setupApiDir({
    'post-fail.js': `
      export default async function handler(req) {
        await req.text();
        return new Response(JSON.stringify({ source: 'local-error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: `http://127.0.0.1:${remotePort}`,
    cloudFallback: 'true',
    allowPrivateRemoteBase: true,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const payload = JSON.stringify({ secret: 'keep-body' });
    const response = await authFetch(`http://127.0.0.1:${port}/api/post-fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.source, 'remote');
    assert.equal(body.body, payload);
    assert.equal(remoteBodies[0], payload);
  } finally {
    await app.close();
    await localApi.cleanup();
    await new Promise((resolve, reject) => {
      remote.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('forwards desktop register-interest to the cloud RPC without legacy signature headers', async () => {
  const originalConvex = process.env.CONVEX_URL;
  delete process.env.CONVEX_URL;

  const remote = await setupRegisterInterestRemote();
  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    allowPrivateRemoteBase: true,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await postJsonViaHttp(`http://127.0.0.1:${port}/api/register-interest`, {
      email: 'desktop@example.com',
      source: 'web-form',
      appVersion: '2.8.0',
      turnstileToken: 'desktop-turnstile-token',
    }, {
      'Content-Encoding': 'gzip',
    });
    assert.equal(response.status, 200);
    assert.equal(remote.requests.length, 1);

    const request = remote.requests[0];
    assert.equal(request.path, '/api/leads/v1/register-interest');
    assert.equal(request.json.source, 'desktop-settings');
    assert.equal(request.json.turnstileToken, 'desktop-turnstile-token');
    assert.equal(request.headers['content-encoding'], undefined);
    assert.match(request.headers['user-agent'], /Chrome\/131\.0\.0\.0/);
    const legacyHeaders = Object.keys(request.headers).filter((name) => name.startsWith('x-worldmonitor-desktop-'));
    assert.deepEqual(legacyHeaders, []);
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
    if (originalConvex === undefined) delete process.env.CONVEX_URL;
    else process.env.CONVEX_URL = originalConvex;
  }
});

test('uses local handler response when local handler succeeds', async () => {
  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({
    'live.js': `
      export default async function handler() {
        return new Response(JSON.stringify({ source: 'local-ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/live`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'local-ok');
    assert.equal(remote.hits.length, 0);
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
  }
});

test('returns 404 when local route does not exist and cloudFallback is off', async () => {
  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({});

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/not-found`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error, 'No local handler for this endpoint');
    assert.equal(remote.hits.length, 0);
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
  }
});

test('replaces browser origin with localhost origin for local handlers', async () => {
  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({
    'origin-check.js': `
      export default async function handler(req) {
        const origin = req.headers.get('origin');
        return new Response(JSON.stringify({
          source: 'local',
          originPresent: Boolean(origin),
          originValue: origin || null,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/origin-check`, {
      headers: { Origin: 'https://tauri.localhost' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'local');
    // Since e14af08f (#709) the server strips the browser Origin but
    // immediately replaces it with `http://127.0.0.1:<port>`, so the
    // handler does receive an Origin header — just the localhost one.
    assert.equal(body.originPresent, true);
    assert.equal(body.originValue, `http://127.0.0.1:${port}`);
    assert.equal(remote.hits.length, 0);
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
  }
});

test('injects the desktop product key into the product-only OpenSky local handler', async () => {
  const originalProductKey = process.env.WORLDMONITOR_API_KEY;
  process.env.WORLDMONITOR_API_KEY = 'desktop-product-key';
  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({
    'opensky.js': `
      export default async function handler(req) {
        return new Response(JSON.stringify({
          origin: req.headers.get('origin'),
          productKey: req.headers.get('x-worldmonitor-key'),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/opensky`, {
      headers: {
        Origin: 'https://tauri.localhost',
        'X-WorldMonitor-Key': 'renderer-supplied-key',
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      origin: `http://127.0.0.1:${port}`,
      productKey: 'desktop-product-key',
    });
    assert.equal(remote.hits.length, 0);
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
    if (originalProductKey === undefined) delete process.env.WORLDMONITOR_API_KEY;
    else process.env.WORLDMONITOR_API_KEY = originalProductKey;
  }
});

test('preserves caller Authorization while hiding the sidecar transport token', async () => {
  const localApi = await setupApiDir({
    'header-check.js': `
      export default async function handler(req) {
        return new Response(JSON.stringify({
          authorization: req.headers.get('authorization'),
          transportToken: req.headers.get('x-worldmonitor-local-token'),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/header-check`, {
      headers: {
        Authorization: 'Bearer caller-oauth-token',
        'X-WorldMonitor-Local-Token': TEST_LOCAL_API_TOKEN,
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      authorization: 'Bearer caller-oauth-token',
      transportToken: null,
    });
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('bounds self-hosted register-interest input before the Convex bridge', async (t) => {
  const originalConvex = process.env.CONVEX_URL;
  const originalSite = process.env.CONVEX_SITE_URL;
  const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
  const originalFetch = globalThis.fetch;
  process.env.CONVEX_URL = 'https://self-hosted.convex.cloud';
  process.env.CONVEX_SITE_URL = 'http://self-hosted.convex.site';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'convex-test-secret';
  let bridgeCalls = 0;
  globalThis.fetch = async () => {
    bridgeCalls++;
    return Response.json({ status: 'registered' });
  };
  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    await localApi.cleanup();
    globalThis.fetch = originalFetch;
    if (originalConvex === undefined) delete process.env.CONVEX_URL;
    else process.env.CONVEX_URL = originalConvex;
    if (originalSite === undefined) delete process.env.CONVEX_SITE_URL;
    else process.env.CONVEX_SITE_URL = originalSite;
    if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
    else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
  });

  await t.test('rejects a null registration payload', async () => {
    const response = await postJsonViaHttp(`${base}/api/register-interest`, null);
    assert.equal(response.status, 400);
    assert.equal(bridgeCalls, 0);
  });

  for (const [email, status] of [
    ['a'.repeat(242) + '@example.com', 200],
    ['first.last+tag@sub.example.com', 200],
    ['a'.repeat(243) + '@example.com', 400],
    ['a@.example.com', 400],
    ['a@example..com', 400],
    ['a@example.com.', 400],
    ['a@' + '.'.repeat(8000) + '@', 400],
    [42, 400],
  ]) {
    await t.test(`email ${String(email).slice(0, 40)} (${String(email).length} characters)`, async () => {
      const before = bridgeCalls;
      const response = await postJsonViaHttp(`${base}/api/register-interest`, { email });
      assert.equal(response.status, status);
      assert.equal(bridgeCalls - before, status === 200 ? 1 : 0);
    });
  }

  const limit = 16 * 1024;
  const payload = { email: 'valid@example.com', padding: '' };
  const overhead = Buffer.byteLength(JSON.stringify(payload));
  for (const bytes of [limit, limit + 1]) {
    await t.test(`registration body of ${bytes} bytes`, async () => {
      const before = bridgeCalls;
      const response = await postJsonViaHttp(`${base}/api/register-interest`, {
        ...payload, padding: 'x'.repeat(bytes - overhead),
      });
      assert.equal(response.status, bytes <= limit ? 200 : 413);
      assert.equal(bridgeCalls - before, bytes <= limit ? 1 : 0);
    });
  }
  await t.test('counts UTF-8 body bytes rather than characters', async () => {
    const before = bridgeCalls;
    const response = await postJsonViaHttp(`${base}/api/register-interest`, {
      ...payload, padding: 'é'.repeat(limit / 2),
    });
    assert.equal(response.status, 413);
    assert.equal(bridgeCalls, before);
  });

  for (const declaredLength of [true, false]) {
    await t.test(`rejects ${declaredLength ? 'declared' : 'chunked'} overflow before upload ends`, async () => {
      const before = bridgeCalls;
      const response = await new Promise((resolve, reject) => {
        const req = httpRequest(`${base}/api/register-interest`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TEST_LOCAL_API_TOKEN}`,
            ...(declaredLength ? { 'Content-Length': String(limit + 1) } : {}),
          },
        }, (res) => {
          res.resume();
          res.on('end', () => {
            resolve(res.statusCode);
            req.destroy();
          });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('rejection waited for upload completion')));
        req.flushHeaders();
        if (!declaredLength) {
          req.write('x'.repeat(limit));
          req.write('x');
        }
      });
      assert.equal(response, 413);
      assert.equal(bridgeCalls, before);
      assert.equal((await getJsonViaHttp(`${base}/api/local-status`)).status, 200);
    });
  }
  await t.test('rejects overlong email even without a configured bridge secret', async () => {
    delete process.env.CONVEX_SERVER_SHARED_SECRET;
    const before = bridgeCalls;
    const response = await postJsonViaHttp(`${base}/api/register-interest`, {
      email: 'a'.repeat(243) + '@example.com',
    });
    assert.equal(response.status, 400);
    assert.equal(bridgeCalls, before);
  });
});

for (const registrationStatus of ['registered', 'already_registered']) {
  test(`uses the authenticated Convex bridge for self-hosted register-interest (${registrationStatus})`, async () => {
    const originalConvex = process.env.CONVEX_URL;
    const originalSite = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    const originalFetch = globalThis.fetch;
    process.env.CONVEX_URL = 'https://self-hosted.convex.cloud';
    process.env.CONVEX_SITE_URL = 'http://self-hosted.convex.site';
    process.env.CONVEX_SERVER_SHARED_SECRET = 'convex-test-secret';

    let captured;
    globalThis.fetch = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        status: registrationStatus,
        position: 7,
        emailSuppressed: true,
        referralCode: 'secret-referral-code',
        referralCount: 9,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const localApi = await setupApiDir({});
    const app = await createLocalApiServer({
      port: 0,
      apiDir: localApi.apiDir,
      remoteBase: 'https://worldmonitor.app',
      logger: { log() { }, warn() { }, error() { } },
    });
    const { port } = await app.start();

    try {
      const response = await postJsonViaHttp(`http://127.0.0.1:${port}/api/register-interest`, {
        email: 'self-hosted@example.com',
        source: 'desktop-settings',
        appVersion: '2.8.0',
        referredBy: 'REF123',
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, {
        status: 'registered',
        referralCode: '',
        referralCount: 0,
        position: 0,
        emailSuppressed: false,
      });
      assert.equal(captured.url, 'http://self-hosted.convex.site/api/internal-register-interest');
      assert.equal(captured.init.headers['x-convex-shared-secret'], 'convex-test-secret');
      assert.equal(captured.init.headers['User-Agent'], 'worldmonitor-sidecar/1.0');
      assert.deepEqual(JSON.parse(captured.init.body), {
        email: 'self-hosted@example.com',
        source: 'desktop-settings',
        appVersion: '2.8.0',
        referredBy: 'REF123',
      });
    } finally {
      await app.close();
      await localApi.cleanup();
      globalThis.fetch = originalFetch;
      if (originalConvex === undefined) delete process.env.CONVEX_URL;
      else process.env.CONVEX_URL = originalConvex;
      if (originalSite === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalSite;
      if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
    }
  });
}

test('does not forward the sidecar transport token through Docker cloud proxy routes', async () => {
  const originalConvex = process.env.CONVEX_URL;
  delete process.env.CONVEX_URL;

  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    allowPrivateRemoteBase: true,
    mode: 'docker',
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const headers = { 'X-WorldMonitor-Local-Token': TEST_LOCAL_API_TOKEN };
    const youtubeResponse = await fetch(`http://127.0.0.1:${port}/api/youtube/live`, { headers });
    assert.equal(youtubeResponse.status, 200);

    const registerResponse = await fetch(`http://127.0.0.1:${port}/api/register-interest`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'docker@example.com', source: 'web-form' }),
    });
    assert.equal(registerResponse.status, 200);

    assert.deepEqual(remote.hits, ['/api/youtube/live', '/api/leads/v1/register-interest']);
    assert.equal(remote.headers.length, 2);
    for (const upstreamHeaders of remote.headers) {
      assert.equal(upstreamHeaders['x-worldmonitor-local-token'], undefined);
    }
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
    if (originalConvex === undefined) delete process.env.CONVEX_URL;
    else process.env.CONVEX_URL = originalConvex;
  }
});

for (const inputKind of ['Request', 'URL']) test(`preserves body when handler uses fetch(${inputKind})`, async () => {
  // Use a DISTINCT upstream server (not the sidecar itself) so this test
  // exercises real "handler proxies to external host" semantics. The upstream
  // is on 127.0.0.1, so it must be opted into the SSRF allowlist via
  // allowPrivateFetchOrigins — production startup has no such opt-in.
  let receivedBody = '';
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ receivedBody }));
    });
  });
  const upstreamPort = await listen(upstream);
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
  process.env.WM_TEST_UPSTREAM = `${upstreamOrigin}/echo`;

  const localApi = await setupApiDir({
    'request-proxy.js': `
      export default async function handler() {
        const request = new Request(process.env.WM_TEST_UPSTREAM, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ secret: 'keep-body' }),
        });
        const upstream = await fetch(${inputKind === 'Request' ? 'request' : 'new URL(request.url), { method: request.method, headers: request.headers, body: await request.text() }'});
        const payload = await upstream.text();
        return new Response(payload, {
          status: upstream.status,
          headers: { 'content-type': 'application/json' },
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    allowPrivateFetchOrigins: [upstreamOrigin],
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/request-proxy`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.receivedBody.includes('"secret":"keep-body"'), true);
    assert.equal(receivedBody.includes('"secret":"keep-body"'), true);
  } finally {
    delete process.env.WM_TEST_UPSTREAM;
    await app.close();
    await localApi.cleanup();
    await new Promise((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('returns local handler error when fetch(Request) uses a consumed body', async () => {
  let upstreamHits = 0;
  const upstream = createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
  process.env.WM_TEST_UPSTREAM = `${upstreamOrigin}/echo`;

  const localApi = await setupApiDir({
    'request-consumed.js': `
      export default async function handler() {
        const request = new Request(process.env.WM_TEST_UPSTREAM, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ secret: 'used-body' }),
        });
        await request.text();
        await fetch(request);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    allowPrivateFetchOrigins: [upstreamOrigin],
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/request-consumed`);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'Local handler error');
    assert.equal(typeof body.reason, 'string');
    assert.equal(body.reason.length > 0, true);
    assert.equal(upstreamHits, 0);
  } finally {
    delete process.env.WM_TEST_UPSTREAM;
    await app.close();
    await localApi.cleanup();
    await new Promise((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

for (const inputKind of ['string', 'URL', 'Request']) test(`blocks handler ${inputKind} fetches to private network targets (#3549, #7892)`, async () => {
  let upstreamHits = 0;

  const upstream = createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  process.env.WM_TEST_UPSTREAM = `http://127.0.0.1:${upstreamPort}/secret?token=super-secret`;

  const localApi = await setupApiDir({
    'private-proxy.js': `
      export default async function handler() {
        const upstream = await fetch(${inputKind === 'string' ? 'process.env.WM_TEST_UPSTREAM' : `new ${inputKind}(process.env.WM_TEST_UPSTREAM)`});
        const payload = await upstream.text();
        return new Response(payload, {
          status: upstream.status,
          headers: { 'content-type': 'application/json' },
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/private-proxy`);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'Local handler error');
    assert.match(body.reason, /SSRF blocked/);
    assert.doesNotMatch(body.reason, /super-secret/);
    assert.equal(upstreamHits, 0);
  } finally {
    delete process.env.WM_TEST_UPSTREAM;
    await app.close();
    await localApi.cleanup();
    await new Promise((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('allows only Docker mode to fetch configured private Redis REST origin', async () => {
  const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  let upstreamHits = 0;

  const upstream = createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const redisOrigin = `http://127.0.0.1:${upstreamPort}`;

  const localApi = await setupApiDir({
    'redis-probe.js': `
      export default async function handler() {
        const upstream = await fetch(process.env.UPSTASH_REDIS_REST_URL + '/ping', {
          headers: { Authorization: 'Bearer ' + process.env.UPSTASH_REDIS_REST_TOKEN },
        });
        const payload = await upstream.text();
        return new Response(payload, {
          status: upstream.status,
          headers: { 'content-type': 'application/json' },
        });
      }
    `,
  });

  async function runProbe(mode) {
    const app = await createLocalApiServer({
      port: 0,
      apiDir: localApi.apiDir,
      mode,
      logger: { log() { }, warn() { }, error() { } },
    });
    const { port } = await app.start();
    try {
      return await authFetch(`http://127.0.0.1:${port}/api/redis-probe`);
    } finally {
      await app.close();
    }
  }

  process.env.UPSTASH_REDIS_REST_URL = redisOrigin;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  try {
    const dockerResponse = await runProbe('docker');
    assert.equal(dockerResponse.status, 200);
    assert.deepEqual(await dockerResponse.json(), { ok: true });
    assert.equal(upstreamHits, 1);

    const desktopResponse = await runProbe('desktop-sidecar');
    assert.equal(desktopResponse.status, 502);
    const desktopBody = await desktopResponse.json();
    assert.equal(desktopBody.error, 'Local handler error');
    assert.match(desktopBody.reason, /SSRF blocked/);
    assert.equal(upstreamHits, 1);
  } finally {
    if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
    if (originalRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
    await localApi.cleanup();
    await new Promise((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('allows Docker LLM origins and only the configured Ollama origin on desktop', async () => {
  const envSnapshot = {
    LOCAL_API_MODE: process.env.LOCAL_API_MODE,
    LLM_API_URL: process.env.LLM_API_URL,
    OLLAMA_API_URL: process.env.OLLAMA_API_URL,
    UNCONFIGURED_PRIVATE_URL: process.env.UNCONFIGURED_PRIVATE_URL,
  };
  let handlerHits = 0;

  const upstreams = [];
  const warnings = [];
  async function createProbeOrigin() {
    const upstream = createServer((req, res) => {
      if (req.headers['x-sidecar-test-probe'] === '1') handlerHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    upstreams.push(upstream);
    const port = await listen(upstream);
    return `http://127.0.0.1:${port}/v1/chat/completions`;
  }

  const [privateLlmUrl, privateOllamaUrl, unconfiguredPrivateUrl] = await Promise.all([
    createProbeOrigin(),
    createProbeOrigin(),
    createProbeOrigin(),
  ]);

  const localApi = await setupApiDir({
    'llm-probe.js': `
      export default async function handler(request) {
        const envKey = new URL(request.url).searchParams.get('envKey');
        const upstream = await fetch(process.env[envKey], {
          headers: { 'x-sidecar-test-probe': '1' },
        });
        const payload = await upstream.text();
        return new Response(payload, {
          status: upstream.status,
          headers: { 'content-type': 'application/json' },
        });
      }
    `,
  });

  async function runProbes(mode, envKeys) {
    process.env.LOCAL_API_MODE = mode;
    const app = await createLocalApiServer({
      port: 0,
      apiDir: localApi.apiDir,
      mode,
      logger: { log() { }, warn(message) { warnings.push(message); }, error() { } },
    });
    const { port } = await app.start();
    try {
      return await Promise.all(
        envKeys.map((envKey) => authFetch(
          `http://127.0.0.1:${port}/api/llm-probe?envKey=${encodeURIComponent(envKey)}`,
        )),
      );
    } finally {
      await app.close();
    }
  }

  try {
    process.env.LLM_API_URL = privateLlmUrl;
    process.env.OLLAMA_API_URL = privateOllamaUrl;
    process.env.UNCONFIGURED_PRIVATE_URL = unconfiguredPrivateUrl;
    const envKeys = ['LLM_API_URL', 'OLLAMA_API_URL', 'UNCONFIGURED_PRIVATE_URL'];
    const dockerResponses = await runProbes('docker', envKeys);
    for (const [index, envKey] of envKeys.entries()) {
      const dockerResponse = dockerResponses[index];
      if (index < 2) {
        assert.equal(dockerResponse.status, 200, envKey);
        assert.deepEqual(await dockerResponse.json(), { ok: true });
      } else {
        assert.equal(dockerResponse.status, 502, envKey);
        const dockerBody = await dockerResponse.json();
        assert.equal(dockerBody.error, 'Local handler error');
        assert.match(dockerBody.reason, /SSRF blocked/);
      }
    }

    const desktopResponses = await runProbes('tauri-sidecar', envKeys);
    for (const [index, envKey] of envKeys.entries()) {
      const desktopResponse = desktopResponses[index];
      if (envKey === 'OLLAMA_API_URL') {
        assert.equal(desktopResponse.status, 200, envKey);
        assert.deepEqual(await desktopResponse.json(), { ok: true });
        continue;
      }
      assert.equal(desktopResponse.status, 502, envKey);
      const desktopBody = await desktopResponse.json();
      assert.equal(desktopBody.error, 'Local handler error');
      assert.match(desktopBody.reason, /SSRF blocked/);
    }
    assert.equal(handlerHits, 3, 'Docker providers and desktop Ollama should reach the upstream');

    process.env.LLM_API_URL = 'not-a-url';
    process.env.OLLAMA_API_URL = '://also-not-a-url';
    const malformedResponses = await runProbes('docker', ['LLM_API_URL', 'OLLAMA_API_URL']);
    for (const [index, envKey] of ['LLM_API_URL', 'OLLAMA_API_URL'].entries()) {
      assert.equal(malformedResponses[index].status, 502, envKey);
      const malformedBody = await malformedResponses[index].json();
      assert.equal(malformedBody.error, 'Local handler error');
      assert.match(malformedBody.reason, /(?:parse URL|Invalid URL)/i);
    }
    assert.ok(warnings.some((message) => message.includes('LLM_API_URL is not a valid URL')));
    assert.ok(warnings.some((message) => message.includes('OLLAMA_API_URL is not a valid URL')));
  } finally {
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await localApi.cleanup();
    await Promise.all(upstreams.map((upstream) => new Promise((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    })));
  }
});

test('a silent Ollama completion outlasts the upstream idle timeout but not the Ollama one', async () => {
  const envSnapshot = {
    LOCAL_API_MODE: process.env.LOCAL_API_MODE,
    OLLAMA_API_URL: process.env.OLLAMA_API_URL,
  };
  const ollama = createServer(async (_req, res) => {
    await sleep(300);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const ollamaPort = await listen(ollama);
  const localApi = await setupApiDir({
    'ollama-probe.js': `
      export default async function handler() {
        const upstream = await fetch(new URL('/v1/chat/completions', process.env.OLLAMA_API_URL), {
          method: 'POST',
          body: '{}',
        });
        return new Response(await upstream.text(), { status: upstream.status });
      }
    `,
  });
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  process.env.OLLAMA_API_URL = `http://127.0.0.1:${ollamaPort}`;
  __testing__.setUpstreamIdleTimeoutMs(50);
  __testing__.setOllamaIdleTimeoutMs(2000);
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    mode: 'tauri-sidecar',
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();
  // The test's own fetch runs through the patched one, so it would idle out
  // waiting on the sidecar.
  const probe = () => new Promise((resolve, reject) => {
    httpRequest(`http://127.0.0.1:${port}/api/ollama-probe`, {
      headers: { Authorization: `Bearer ${TEST_LOCAL_API_TOKEN}` },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject).end();
  });
  try {
    const completed = await probe();
    assert.equal(completed.status, 200);
    assert.deepEqual(completed.body, { ok: true });

    __testing__.setOllamaIdleTimeoutMs(100);
    const hung = await probe();
    assert.equal(hung.status, 502);
    assert.match(hung.body.reason, /idle-timed out/);
  } finally {
    __testing__.setUpstreamIdleTimeoutMs(12000);
    __testing__.setOllamaIdleTimeoutMs(90000);
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await localApi.cleanup();
    await new Promise((resolve, reject) => ollama.close((error) => (error ? reject(error) : resolve())));
  }
});

test('blocks handler global fetches to non-global IPv4 special ranges', async () => {
  const originalHttpRequest = http.request;
  const blockedUrls = [
    'http://100.64.0.1/secret',
    'http://198.18.0.1/secret',
    'http://192.0.0.1/secret',
    'http://192.0.2.1/secret',
    'http://192.88.99.1/secret',
    'http://198.51.100.1/secret',
    'http://203.0.113.1/secret',
    'http://240.0.0.1/secret',
  ];
  let outboundHits = 0;

  http.request = (options, onResponse) => {
    if (options.hostname === '127.0.0.1') {
      return originalHttpRequest.call(http, options, onResponse);
    }

    outboundHits += 1;
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
    req.destroy = (error) => {
      if (error) req.emit('error', error);
    };
    req.end = () => {
      setImmediate(() => req.emit('error', new Error(`unexpected outbound request to ${options.hostname}`)));
    };
    return req;
  };

  const localApi = await setupApiDir({
    'special-range-proxy.js': `
      export default async function handler(request) {
        const url = new URL(request.url);
        const upstream = await fetch(url.searchParams.get('target'));
        const payload = await upstream.text();
        return new Response(payload, {
          status: upstream.status,
          headers: { 'content-type': 'application/json' },
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    for (const blockedUrl of blockedUrls) {
      const response = await authFetch(`http://127.0.0.1:${port}/api/special-range-proxy?target=${encodeURIComponent(blockedUrl)}`);
      assert.equal(response.status, 502, blockedUrl);
      const body = await response.json();
      assert.equal(body.error, 'Local handler error', blockedUrl);
      assert.match(body.reason, /SSRF blocked/, blockedUrl);
    }
    assert.equal(outboundHits, 0);
  } finally {
    http.request = originalHttpRequest;
    await app.close();
    await localApi.cleanup();
  }
});

test('uses asynchronous pinned lookup callback for handler global fetches (#3549)', async () => {
  const originalHttpsRequest = https.request;
  const envSnapshot = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OLLAMA_API_URL: process.env.OLLAMA_API_URL,
    LLM_API_URL: process.env.LLM_API_URL,
  };
  let lookupCallbackWasSync = null;

  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OLLAMA_API_URL;
  delete process.env.LLM_API_URL;

  https.request = (options, onResponse) => {
    assert.equal(options.hostname, '93.184.216.34');
    assert.equal(typeof options.lookup, 'function');

    let sync = true;
    options.lookup(options.hostname, { family: 4 }, (error, address, family) => {
      assert.ifError(error);
      assert.equal(address, '93.184.216.34');
      assert.equal(family, 4);
      lookupCallbackWasSync = sync;
    });
    sync = false;

    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
    req.destroy = (error) => {
      if (error) req.emit('error', error);
    };
    req.end = () => {
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.statusMessage = 'OK';
        res.headers = { 'content-type': 'application/json' };
        onResponse(res);
        res.emit('data', Buffer.from(JSON.stringify({ ok: true })));
        res.emit('end');
      });
    };
    return req;
  };

  const localApi = await setupApiDir({
    'public-proxy.js': `
      export default async function handler() {
        const upstream = await fetch('https://93.184.216.34/data');
        const payload = await upstream.text();
        return new Response(payload, {
          status: upstream.status,
          headers: { 'content-type': 'application/json' },
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/public-proxy`);
    assert.equal(response.status, 200);
    assert.equal(lookupCallbackWasSync, false);
  } finally {
    https.request = originalHttpsRequest;
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app.close();
    await localApi.cleanup();
  }
});

test('uses IPv4 sidecar fetch for allowed private-network LLM probes (#3549)', async () => {
  const originalHttpRequest = http.request;
  const envSnapshot = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OLLAMA_API_URL: process.env.OLLAMA_API_URL,
    LLM_API_URL: process.env.LLM_API_URL,
  };
  let sawOllamaProbe = false;

  delete process.env.OPENROUTER_API_KEY;
  delete process.env.LLM_API_URL;
  process.env.OLLAMA_API_URL = 'http://ollama.test:11434';

  http.request = (options, onResponse) => {
    if (options.hostname !== 'ollama.test') {
      return originalHttpRequest.call(http, options, onResponse);
    }

    sawOllamaProbe = true;
    assert.equal(options.family, 4);
    assert.equal(options.path, '/');

    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
    req.destroy = (error) => {
      if (error) req.emit('error', error);
    };
    req.end = () => {
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.statusMessage = 'OK';
        res.headers = { 'content-type': 'application/json' };
        onResponse(res);
        res.emit('data', Buffer.from(JSON.stringify({ ok: true })));
        res.emit('end');
      });
    };
    return req;
  };

  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await getJsonViaHttp(`http://127.0.0.1:${port}/api/llm-health`);
    assert.equal(response.status, 200);
    assert.equal(response.json.available, true);
    assert.deepEqual(response.json.providers, [
      { name: 'ollama', url: 'http://ollama.test:11434', available: true },
    ]);
    assert.equal(sawOllamaProbe, true);
  } finally {
    http.request = originalHttpRequest;
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app.close();
    await localApi.cleanup();
  }
});

test('ignores a leftover GROQ_API_KEY in LLM health (#8885)', async () => {
  const envSnapshot = {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OLLAMA_API_URL: process.env.OLLAMA_API_URL,
    LLM_API_URL: process.env.LLM_API_URL,
  };
  const restoreHttps = mockHttpsRequestOnce({
    statusCode: 404,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  process.env.GROQ_API_KEY = 'groq-test-key';
  process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
  delete process.env.OLLAMA_API_URL;
  delete process.env.LLM_API_URL;

  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await getJsonViaHttp(`http://127.0.0.1:${port}/api/llm-health`);
    assert.equal(response.status, 200);
    assert.equal(response.json.available, true);
    assert.deepEqual(response.json.providers, [
      { name: 'openrouter', url: 'https://openrouter.ai', available: true },
    ]);
  } finally {
    restoreHttps();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app.close();
    await localApi.cleanup();
  }
});

test('uses canonical app origin when proxying to cloud fallback (cloudFallback enabled)', async () => {
  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({});

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    cloudFallback: 'true',
    allowPrivateRemoteBase: true,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/no-local-handler`, {
      headers: { Origin: 'https://tauri.localhost' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'remote');
    assert.equal(body.origin, 'https://worldmonitor.app');
    assert.equal(remote.origins[0], 'https://worldmonitor.app');
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
  }
});

test('blocks cloud fallback in Docker mode even when explicitly requested', async () => {
  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({
    'docker-test.js': `
      export default async function handler() {
        return new Response(JSON.stringify({ source: 'local-error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        });
      }
    `,
  });

  const warnings = [];
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    cloudFallback: 'true',
    mode: 'docker',
    logger: { log() {}, warn(...args) { warnings.push(args.join(' ')); }, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/docker-test`);
    // Should NOT fall back to cloud; should return the local 500 directly
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.source, 'local-error');
    // Should have logged a warning about Docker mode blocking fallback
    assert.ok(warnings.some(w => w.includes('Docker mode')), 'Should warn about Docker mode blocking fallback');
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
  }
});

test('responds to OPTIONS preflight with CORS headers', async () => {
  const localApi = await setupApiDir({
    'data.js': `
      export default async function handler() {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/data`, { method: 'OPTIONS' });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, PUT, DELETE, OPTIONS');
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('preserves Origin in Vary when gzip compression is applied', async () => {
  const localApi = await setupApiDir({
    'large.js': `
      export default async function handler() {
        return new Response(JSON.stringify({ payload: 'x'.repeat(4096) }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/large`, {
      headers: {
        Origin: 'https://tauri.localhost',
        'Accept-Encoding': 'gzip',
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://tauri.localhost');
    assert.equal(response.headers.get('content-encoding'), 'gzip');

    const vary = (response.headers.get('vary') || '')
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);

    assert.equal(vary.includes('origin'), true);
    assert.equal(vary.includes('accept-encoding'), true);
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('resolves packaged tauri resource layout under _up_/api', async () => {
  const remote = await setupRemoteServer();
  const localResource = await setupResourceDirWithUpApi({
    'live.js': `
      export default async function handler() {
        return new Response(JSON.stringify({ source: 'local-up' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    resourceDir: localResource.resourceDir,
    remoteBase: remote.remoteBase,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    assert.equal(app.context.apiDir, localResource.apiDir);
    assert.equal(app.routes.length, 1);

    const response = await authFetch(`http://127.0.0.1:${port}/api/live`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'local-up');
    assert.equal(remote.hits.length, 0);
  } finally {
    await app.close();
    await localResource.cleanup();
    await remote.close();
  }
});

// ── Ollama env key allowlist + validation tests ──

test('Docker rejects native administration without changing configuration, caches, or relay transport', async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const relayCalls = [];
  const operatorRelay = 'https://operator-relay.example';
  const otherRelay = 'https://untrusted-relay.example';
  process.env.WS_RELAY_URL = operatorRelay;
  process.env.RELAY_SHARED_SECRET = 'synthetic-relay-secret';
  delete process.env.RELAY_AUTH_HEADER;
  globalThis.fetch = (input, options) => {
    const url = String(input);
    if (url.startsWith(operatorRelay) || url.startsWith(otherRelay)) {
      relayCalls.push({ url, headers: new Headers(options?.headers) });
      return Promise.resolve(new Response('[]', { headers: { 'content-type': 'application/json' } }));
    }
    return originalFetch(input, options);
  };
  let privateProbeHits = 0;
  const privateProvider = createServer((_req, res) => {
    privateProbeHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"fixture-model"}]}');
  });
  const privatePort = await listen(privateProvider);
  const relayModule = pathToFileURL(path.resolve(import.meta.dirname, '../../api/oref-alerts.js')).href;
  const localApi = await setupApiDir({
    'oref-alerts.js': `export { default } from ${JSON.stringify(relayModule)};`,
    'missing.js': `import './absent.js'; export default () => new Response('unreachable');`,
  });
  const verboseStatePath = path.join(localApi.apiDir, 'verbose-mode.json');
  await writeFile(verboseStatePath, '{"verboseMode":false}');
  const app = await createLocalApiServer({
    port: 0, apiDir: localApi.apiDir, dataDir: localApi.apiDir, mode: 'docker',
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  // This is the authority nginx grants even when the outside caller is anonymous.
  const proxyHeaders = { 'X-WorldMonitor-Local-Token': TEST_LOCAL_API_TOKEN, Origin: 'http://localhost' };
  try {
    await authFetch(`${base}/api/missing`);
    const requests = [
      ['local-env-update', 'POST', { key: 'WS_RELAY_URL', value: otherRelay }],
      ['local-env-update-batch', 'POST', { entries: [{ key: 'WS_RELAY_URL', value: otherRelay }] }],
      ['local-validate-secret', 'POST', { key: 'OLLAMA_API_URL', value: `http://127.0.0.1:${privatePort}` }],
      ['local-status', 'GET'],
      ['local-traffic-log', 'GET'],
      ['local-traffic-log', 'DELETE'],
      ['local-debug-toggle', 'GET'],
      ['local-debug-toggle', 'POST'],
      ['local-env-update', 'OPTIONS'],
    ];
    for (const [route, method, body] of requests) {
      await t.test(`${method} ${route}`, async () => {
        const response = await fetch(`${base}/api/${route}`, {
          method, headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        assert.equal(response.status, 403);
      });
    }
    // GHSA-wf3p-9m55-6vm8: nginx matches `\\` literally but the sidecar's URL
    // parser reads it as `/`, so this spelling slips past nginx's prefix block.
    // Sent raw because fetch() would normalize it before it left the client.
    await t.test('a backslash-spelled admin path is still denied', async () => {
      const status = await new Promise((resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1', port, method: 'POST', path: '/api/x\\..\\local-env-update',
          headers: { ...proxyHeaders, 'Content-Type': 'application/json' },
        }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end(JSON.stringify({ key: 'WS_RELAY_URL', value: otherRelay }));
      });
      assert.equal(status, 403);
    });
    await t.test('spoofed and native credentials cannot override Docker mode', async () => {
      for (const headers of [{}, { Authorization: `Bearer ${TEST_LOCAL_API_TOKEN}` }, {
        Authorization: 'Bearer caller-oauth', Origin: 'https://tauri.localhost',
        'X-WorldMonitor-Local-Token': 'spoofed-token',
      }]) {
        const response = await fetch(`${base}/api/local-status`, { headers });
        assert.equal(response.status, 403);
      }
    });
    await t.test('rejections leave validation transport and debug state untouched', () => {
      assert.equal(privateProbeHits, 0);
      assert.equal(readFileSync(verboseStatePath, 'utf8'), '{"verboseMode":false}');
    });
    await t.test('rejections preserve environment, failed-import cache, and outbound destination', async () => {
      const relay = await fetch(`${base}/api/oref-alerts`, { headers: proxyHeaders });
      assert.equal(relay.status, 200);
      assert.equal(relayCalls.length, 1);
      assert.equal(relayCalls[0].url, `${operatorRelay}/oref/alerts`);
      assert.equal(relayCalls[0].headers.get('x-relay-key'), 'synthetic-relay-secret');
      assert.equal(relayCalls[0].headers.get('authorization'), 'Bearer synthetic-relay-secret');
      assert.equal(process.env.WS_RELAY_URL, operatorRelay);
      const missing = await authFetch(`${base}/api/missing`);
      assert.match((await missing.json()).reason, /cached-failure/);
      const health = await fetch(`${base}/api/sidecar-health`);
      assert.equal(health.status, 200);
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ['WS_RELAY_URL', 'RELAY_SHARED_SECRET', 'RELAY_AUTH_HEADER']) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await app.close();
    await localApi.cleanup();
    await new Promise(resolve => privateProvider.close(resolve));
  }
});

test('accepts OLLAMA_API_URL through desktop single and batch env updates', async () => {
  const localApi = await setupApiDir({});

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/local-env-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'OLLAMA_API_URL', value: 'http://127.0.0.1:11434' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.key, 'OLLAMA_API_URL');
    assert.equal(process.env.OLLAMA_API_URL, 'http://127.0.0.1:11434');
    const batchResponse = await authFetch(`http://127.0.0.1:${port}/api/local-env-update-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [{ key: 'OLLAMA_API_URL', value: 'http://127.0.0.1:11435' }] }),
    });
    assert.equal(batchResponse.status, 200);
    assert.equal(process.env.OLLAMA_API_URL, 'http://127.0.0.1:11435');
  } finally {
    delete process.env.OLLAMA_API_URL;
    await app.close();
    await localApi.cleanup();
  }
});

test('accepts OLLAMA_MODEL via /api/local-env-update', async () => {
  const localApi = await setupApiDir({});

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/local-env-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'OLLAMA_MODEL', value: 'llama3.1:8b' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.key, 'OLLAMA_MODEL');
    assert.equal(process.env.OLLAMA_MODEL, 'llama3.1:8b');
  } finally {
    delete process.env.OLLAMA_MODEL;
    await app.close();
    await localApi.cleanup();
  }
});

test('accepts ALPHA_VANTAGE_API_KEY via /api/local-env-update', async () => {
  const originalKey = process.env.ALPHA_VANTAGE_API_KEY;
  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/local-env-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'ALPHA_VANTAGE_API_KEY', value: 'desktop-av-key' }),
    });
    assert.equal(response.status, 200);
    assert.equal(process.env.ALPHA_VANTAGE_API_KEY, 'desktop-av-key');
  } finally {
    if (originalKey === undefined) delete process.env.ALPHA_VANTAGE_API_KEY;
    else process.env.ALPHA_VANTAGE_API_KEY = originalKey;
    await app.close();
    await localApi.cleanup();
  }
});

test('stores ALPHA_VANTAGE_API_KEY without claiming the provider demo response verifies it', async () => {
  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await postJsonViaHttp(`http://127.0.0.1:${port}/api/local-validate-secret`, {
      key: 'ALPHA_VANTAGE_API_KEY',
      value: 'desktop-av-key',
    });
    assert.equal(response.status, 200);
    assert.equal(response.json?.valid, true);
    assert.equal(response.json?.message, 'Key stored');
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('rejects unknown key via /api/local-env-update', async () => {
  const localApi = await setupApiDir({});

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/local-env-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'NOT_ALLOWED_KEY', value: 'some-value' }),
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error, 'key not in allowlist');
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('refuses the retired GROQ_API_KEY on update and validation (#8885)', async () => {
  const localApi = await setupApiDir({});

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    for (const route of ['local-env-update', 'local-validate-secret']) {
      const response = await authFetch(`http://127.0.0.1:${port}/api/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'GROQ_API_KEY', value: 'gsk_stale' }),
      });
      assert.equal(response.status, 403, route);
      assert.equal((await response.json()).error, 'key not in allowlist', route);
    }
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('validates OLLAMA_API_URL via /api/local-validate-secret (reachable endpoint)', async () => {
  // Stand up a mock Ollama server that responds to /v1/models
  const mockOllama = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'llama3.1:8b' }] }));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  const ollamaPort = await listen(mockOllama);

  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/local-validate-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'OLLAMA_API_URL', value: `http://127.0.0.1:${ollamaPort}` }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.valid, true);
    assert.equal(body.message, 'Ollama endpoint verified');
  } finally {
    await app.close();
    await localApi.cleanup();
    await new Promise((resolve, reject) => {
      mockOllama.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('validates LM Studio style /v1 base URL via /api/local-validate-secret', async () => {
  const mockOpenAiCompatible = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  const providerPort = await listen(mockOpenAiCompatible);

  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/local-validate-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'OLLAMA_API_URL', value: `http://127.0.0.1:${providerPort}/v1` }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.valid, true);
    assert.equal(body.message, 'Ollama endpoint verified');
  } finally {
    await app.close();
    await localApi.cleanup();
    await new Promise((resolve, reject) => {
      mockOpenAiCompatible.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('validates OLLAMA_API_URL via native /api/tags fallback', async () => {
  // Mock server that only responds to /api/tags (not /v1/models)
  const mockOllama = createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b' }] }));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  const ollamaPort = await listen(mockOllama);

  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/local-validate-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'OLLAMA_API_URL', value: `http://127.0.0.1:${ollamaPort}` }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.valid, true);
    assert.equal(body.message, 'Ollama endpoint verified (native API)');
  } finally {
    await app.close();
    await localApi.cleanup();
    await new Promise((resolve, reject) => {
      mockOllama.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('validates OLLAMA_MODEL stores model name', async () => {
  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/local-validate-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'OLLAMA_MODEL', value: 'mistral:7b' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.valid, true);
    assert.equal(body.message, 'Model name stored');
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('rejects OLLAMA_API_URL with non-http protocol', async () => {
  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/local-validate-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'OLLAMA_API_URL', value: 'ftp://127.0.0.1:11434' }),
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.valid, false);
    assert.equal(body.message, 'Must be an http(s) URL');
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('treats Cloudflare challenge 403 as soft-pass during secret validation', async () => {
  const localApi = await setupApiDir({});
  const restoreHttps = mockHttpsRequestOnce({
    statusCode: 403,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cf-ray': 'abc123',
    },
    body: '<html><title>Attention Required</title><body>Cloudflare Ray ID: 123</body></html>',
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await postJsonViaHttp(`http://127.0.0.1:${port}/api/local-validate-secret`, {
      key: 'OPENROUTER_API_KEY',
      value: 'dummy-key',
    });
    assert.equal(response.status, 200);
    assert.equal(response.json?.valid, true);
    assert.equal(response.json?.message, 'OpenRouter key stored (Cloudflare blocked verification)');
  } finally {
    restoreHttps();
    await app.close();
    await localApi.cleanup();
  }
});

test('does not soft-pass provider auth 403 JSON responses even with cf-ray header', async () => {
  const localApi = await setupApiDir({});
  const restoreHttps = mockHttpsRequestOnce({
    statusCode: 403,
    headers: {
      'content-type': 'application/json',
      'cf-ray': 'abc123',
    },
    body: JSON.stringify({ error: 'invalid api key' }),
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await postJsonViaHttp(`http://127.0.0.1:${port}/api/local-validate-secret`, {
      key: 'OPENROUTER_API_KEY',
      value: 'invalid-key',
    });
    assert.equal(response.status, 422);
    assert.equal(response.json?.valid, false);
    assert.equal(response.json?.message, 'OpenRouter rejected this key');
  } finally {
    restoreHttps();
    await app.close();
    await localApi.cleanup();
  }
});

test('serves no unauthenticated HLS proxy', async () => {
  // The referer-spoofing /api/hls-proxy route was auth-exempt. With it retired the path is an ordinary
  // authenticated request, so a caller without the token is refused before any upstream is contacted.
  const localApi = await setupApiDir({});
  const originalToken = process.env.LOCAL_API_TOKEN;
  process.env.LOCAL_API_TOKEN = 'secret-token-123';

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const upstream = encodeURIComponent('https://example.com/live/index.m3u8');
    const response = await fetch(`http://127.0.0.1:${port}/api/hls-proxy?url=${upstream}`);
    assert.equal(response.status, 401);
  } finally {
    if (originalToken === undefined) delete process.env.LOCAL_API_TOKEN;
    else process.env.LOCAL_API_TOKEN = originalToken;
    await app.close();
    await localApi.cleanup();
  }
});

test('auth-required behavior unchanged — rejects unauthenticated requests when token is set', async () => {
  const localApi = await setupApiDir({});
  const originalToken = process.env.LOCAL_API_TOKEN;
  process.env.LOCAL_API_TOKEN = 'secret-token-123';

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    // Request without auth header should be rejected
    const response = await fetch(`http://127.0.0.1:${port}/api/local-env-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'OLLAMA_API_URL', value: 'http://127.0.0.1:11434' }),
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'Unauthorized');

    // Request with correct auth header should succeed
    const authedResponse = await authFetch(`http://127.0.0.1:${port}/api/local-env-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer secret-token-123',
      },
      body: JSON.stringify({ key: 'OLLAMA_API_URL', value: 'http://127.0.0.1:11434' }),
    });
    assert.equal(authedResponse.status, 200);
  } finally {
    if (originalToken !== undefined) {
      process.env.LOCAL_API_TOKEN = originalToken;
    } else {
      delete process.env.LOCAL_API_TOKEN;
    }
    delete process.env.OLLAMA_API_URL;
    await app.close();
    await localApi.cleanup();
  }
});


test('prefers Brotli compression for payloads larger than 1KB when supported by the client', async () => {
  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({
    'compression-check.js': `
      export default async function handler() {
        const payload = { value: 'x'.repeat(3000) };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/compression-check`, {
      headers: { 'Accept-Encoding': 'gzip, br' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), 'br');

    const compressed = Buffer.from(await response.arrayBuffer());
    const decompressed = brotliDecompressSync(compressed).toString('utf8');
    const body = JSON.parse(decompressed);
    assert.equal(body.value.length, 3000);
    assert.equal(remote.hits.length, 0);
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
  }
});

test('uses gzip compression when Brotli is unavailable but gzip is accepted', async () => {
  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({
    'compression-check.js': `
      export default async function handler() {
        const payload = { value: 'x'.repeat(3000) };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/compression-check`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), 'gzip');

    const compressed = Buffer.from(await response.arrayBuffer());
    const decompressed = gunzipSync(compressed).toString('utf8');
    const body = JSON.parse(decompressed);
    assert.equal(body.value.length, 3000);
    assert.equal(remote.hits.length, 0);
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
  }
});

test('skips gzip/br for already-compressed raster image payloads (#7382)', () => {
  const jpegBody = Buffer.alloc(2048, 0xff);
  assert.equal(
    __testing__.canCompress({ 'content-type': 'image/jpeg' }, jpegBody),
    false,
  );
  assert.equal(
    __testing__.canCompress({ 'content-type': 'image/png' }, jpegBody),
    false,
  );
  assert.equal(
    __testing__.canCompress({ 'content-type': 'image/webp' }, jpegBody),
    false,
  );
  // SVG is text — still worth compressing (e.g. /api/og-story).
  assert.equal(
    __testing__.canCompress({ 'content-type': 'image/svg+xml' }, Buffer.from('x'.repeat(2048))),
    true,
  );
  assert.equal(
    __testing__.canCompress({ 'content-type': 'application/json' }, Buffer.from('x'.repeat(2048))),
    true,
  );
});


// ── Security hardening tests ────────────────────────────────────────────

test('rejects unauthenticated requests to /api/local-status when token is set', async () => {
  const localApi = await setupApiDir({});
  const originalToken = process.env.LOCAL_API_TOKEN;
  process.env.LOCAL_API_TOKEN = 'security-test-token';

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local-status`);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'Unauthorized');

    // With token should succeed
    const authed = await fetch(`http://127.0.0.1:${port}/api/local-status`, {
      headers: { 'Authorization': 'Bearer security-test-token' },
    });
    assert.equal(authed.status, 200);
  } finally {
    if (originalToken !== undefined) {
      process.env.LOCAL_API_TOKEN = originalToken;
    } else {
      delete process.env.LOCAL_API_TOKEN;
    }
    await app.close();
    await localApi.cleanup();
  }
});

test('rejects unauthenticated requests to /api/local-traffic-log when token is set', async () => {
  const localApi = await setupApiDir({});
  const originalToken = process.env.LOCAL_API_TOKEN;
  process.env.LOCAL_API_TOKEN = 'security-test-token';

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local-traffic-log`);
    assert.equal(response.status, 401);
  } finally {
    if (originalToken !== undefined) {
      process.env.LOCAL_API_TOKEN = originalToken;
    } else {
      delete process.env.LOCAL_API_TOKEN;
    }
    await app.close();
    await localApi.cleanup();
  }
});

test('rejects unauthenticated requests to /api/local-debug-toggle when token is set', async () => {
  const localApi = await setupApiDir({});
  const originalToken = process.env.LOCAL_API_TOKEN;
  process.env.LOCAL_API_TOKEN = 'security-test-token';

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local-debug-toggle`);
    assert.equal(response.status, 401);
  } finally {
    if (originalToken !== undefined) {
      process.env.LOCAL_API_TOKEN = originalToken;
    } else {
      delete process.env.LOCAL_API_TOKEN;
    }
    await app.close();
    await localApi.cleanup();
  }
});

test('rejects unauthenticated requests to /api/rss-proxy when token is set', async () => {
  const localApi = await setupApiDir({});
  const originalToken = process.env.LOCAL_API_TOKEN;
  process.env.LOCAL_API_TOKEN = 'security-test-token';

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/rss-proxy?url=https://example.com/rss`);
    assert.equal(response.status, 401);
  } finally {
    if (originalToken !== undefined) {
      process.env.LOCAL_API_TOKEN = originalToken;
    } else {
      delete process.env.LOCAL_API_TOKEN;
    }
    await app.close();
    await localApi.cleanup();
  }
});

test('allows unauthenticated requests to /api/service-status (health check exempt)', async () => {
  const localApi = await setupApiDir({});
  const originalToken = process.env.LOCAL_API_TOKEN;
  process.env.LOCAL_API_TOKEN = 'security-test-token';

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/service-status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
  } finally {
    if (originalToken !== undefined) {
      process.env.LOCAL_API_TOKEN = originalToken;
    } else {
      delete process.env.LOCAL_API_TOKEN;
    }
    await app.close();
    await localApi.cleanup();
  }
});

test('allows unauthenticated requests to /api/sidecar-health (container healthcheck exempt)', async () => {
  const localApi = await setupApiDir({});
  const originalToken = process.env.LOCAL_API_TOKEN;
  process.env.LOCAL_API_TOKEN = 'security-test-token';

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sidecar-health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.port, port);
  } finally {
    if (originalToken !== undefined) {
      process.env.LOCAL_API_TOKEN = originalToken;
    } else {
      delete process.env.LOCAL_API_TOKEN;
    }
    await app.close();
    await localApi.cleanup();
  }
});

test('/api/health?compact=1 still dispatches to the bundled health handler', async () => {
  const localApi = await setupApiDir({
    'health.js': `
      export default async function handler(req) {
        return new Response(JSON.stringify({
          source: 'bundled-health',
          url: req.url,
        }), { headers: { 'content-type': 'application/json' } });
      }
    `,
  });
  const originalToken = process.env.LOCAL_API_TOKEN;
  process.env.LOCAL_API_TOKEN = 'security-test-token';

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health?compact=1`, {
      headers: { Authorization: 'Bearer security-test-token' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'bundled-health');
    assert.match(body.url, /\/api\/health\?compact=1$/);
  } finally {
    if (originalToken !== undefined) {
      process.env.LOCAL_API_TOKEN = originalToken;
    } else {
      delete process.env.LOCAL_API_TOKEN;
    }
    await app.close();
    await localApi.cleanup();
  }
});

test('default-deny: rejects every authenticated route when LOCAL_API_TOKEN is unset', async () => {
  // Regression for the security advisory fix: previously, an unset
  // LOCAL_API_TOKEN was treated as "auth disabled", which made any
  // standalone sidecar (Docker, manual launch) an open local-HTTP
  // proxy. The expected behaviour is now "fail closed": no token →
  // every gated request returns 503.
  const localApi = await setupApiDir({});
  const originalToken = process.env.LOCAL_API_TOKEN;
  delete process.env.LOCAL_API_TOKEN;

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    // Gated route: must 503 even when the caller would otherwise be valid.
    const gated = await fetch(`http://127.0.0.1:${port}/api/local-status`, {
      headers: { Authorization: 'Bearer anything' },
    });
    assert.equal(gated.status, 503);
    const body = await gated.json();
    assert.match(body.error, /LOCAL_API_TOKEN/);

    // Health check is still exempt — it runs before the auth gate so
    // operators can probe a misconfigured sidecar.
    const health = await fetch(`http://127.0.0.1:${port}/api/sidecar-health`);
    assert.equal(health.status, 200);
  } finally {
    if (originalToken !== undefined) {
      process.env.LOCAL_API_TOKEN = originalToken;
    }
    await app.close();
    await localApi.cleanup();
  }
});

test('rss-proxy pins an IPv6-only hostname to the validated address', async () => {
  const localApi = await setupApiDir({});
  const originalResolve4 = dns.resolve4;
  const originalResolve6 = dns.resolve6;
  const originalHttpsRequest = https.request;
  const publicIpv6 = '2606:4700:4700::1111';
  let outboundOptions = null;
  let pinnedLookup = null;

  dns.resolve4 = async () => {
    const error = new Error('No A records');
    error.code = 'ENODATA';
    throw error;
  };
  dns.resolve6 = async (hostname) => {
    assert.equal(hostname, 'ipv6-only.example');
    return [publicIpv6];
  };
  https.request = (options, onResponse) => {
    outboundOptions = options;
    if (typeof options.lookup === 'function') {
      options.lookup(options.hostname, { family: options.family }, (error, address, family) => {
        assert.ifError(error);
        pinnedLookup = { address, family };
      });
    }

    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
    req.destroy = (error) => {
      if (error) req.emit('error', error);
    };
    req.end = () => {
      queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.statusMessage = 'OK';
        res.headers = { 'content-type': 'application/rss+xml' };
        onResponse(res);
        res.emit('data', Buffer.from('<rss />'));
        res.emit('end');
      });
    };
    return req;
  };

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const feedUrl = encodeURIComponent('https://ipv6-only.example/feed.xml');
    const response = await authFetch(`http://127.0.0.1:${port}/api/rss-proxy?url=${feedUrl}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '<rss />');
    assert.equal(outboundOptions?.hostname, 'ipv6-only.example');
    assert.equal(outboundOptions?.family, 6);
    assert.deepEqual(pinnedLookup, { address: publicIpv6, family: 6 });
  } finally {
    dns.resolve4 = originalResolve4;
    dns.resolve6 = originalResolve6;
    https.request = originalHttpsRequest;
    await app.close();
    await localApi.cleanup();
  }
});

test('rss-proxy blocks IPv4-mapped IPv6 literals and DNS answers before transport', async () => {
  const localApi = await setupApiDir({});
  const originalResolve4 = dns.resolve4;
  const originalResolve6 = dns.resolve6;
  const originalHttpsRequest = https.request;
  let outboundCalls = 0;

  dns.resolve4 = async () => ['93.184.216.34'];
  dns.resolve6 = async () => ['::ffff:7f00:1'];
  https.request = () => {
    outboundCalls += 1;
    throw new Error('blocked mapped address must not reach the network');
  };

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const mappedUrls = [
      'https://[::ffff:127.0.0.1]/feed.xml',
      'https://[0:0:0:0:0:ffff:127.0.0.1]/feed.xml',
      'https://[::ffff:7f00:1]/feed.xml',
      'https://[::ffff:c0a8:101]/feed.xml',
      'https://[::ffff:a9fe:101]/feed.xml',
      'https://[::ffff:c633:6401]/feed.xml',
      // Translator and tunnel prefixes carrying a loopback / private IPv4.
      'https://[64:ff9b::7f00:1]/feed.xml',           // NAT64 -> 127.0.0.1
      'https://[64:ff9b::a9fe:a9fe]/feed.xml',        // NAT64 -> 169.254.169.254
      'https://[2002:7f00:1::]/feed.xml',             // 6to4 -> 127.0.0.1
      'https://[2002:c0a8:101::1]/feed.xml',          // 6to4 -> 192.168.1.1
      'https://[::7f00:1]/feed.xml',                  // IPv4-compatible -> 127.0.0.1
      'https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/feed.xml', // Teredo
    ];
    for (const feedUrl of mappedUrls) {
      const response = await authFetch(
        `http://127.0.0.1:${port}/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`,
      );
      assert.equal(response.status, 403, feedUrl);
      const body = await response.json();
      assert.match(body.error, /private\/reserved/, feedUrl);
    }

    const dnsResponse = await authFetch(
      `http://127.0.0.1:${port}/api/rss-proxy?url=${encodeURIComponent('https://mapped-dns.example/feed.xml')}`,
    );
    assert.equal(dnsResponse.status, 403);
    assert.match((await dnsResponse.json()).error, /private\/reserved/);
    assert.equal(outboundCalls, 0);
  } finally {
    dns.resolve4 = originalResolve4;
    dns.resolve6 = originalResolve6;
    https.request = originalHttpsRequest;
    await app.close();
    await localApi.cleanup();
  }
});

test('rss-proxy escapes control characters from the blocked url before logging it', async () => {
  const localApi = await setupApiDir({});
  const warnings = [];
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() {}, warn(...args) { warnings.push(args.join(' ')); }, error() {} },
  });
  const { port } = await app.start();

  try {
    const feedUrl = 'http://127.0.0.1/\n[local-api] forged\r\u001b[2J';
    const response = await authFetch(
      `http://127.0.0.1:${port}/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`,
    );
    assert.equal(response.status, 403);
    const blocked = warnings.filter((line) => line.includes('rss-proxy SSRF blocked'));
    assert.equal(blocked.length, 1, JSON.stringify(warnings));
    for (const line of warnings) {
      assert.doesNotMatch(line, /[\r\n\u001b]/, JSON.stringify(line));
    }
    assert.ok(blocked[0].includes(JSON.stringify(feedUrl)), blocked[0]);
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('a malformed request-target gets a 400 and the sidecar keeps serving', async () => {
  const localApi = await setupApiDir({
    'ping.js': `
      export default async function handler() {
        return new Response('pong', { status: 200 });
      }
    `,
  });
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  const rawRequest = (target) => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error(`no response for ${target}`)); });
  });

  try {
    const raw = await rawRequest('//');
    assert.match(raw.split('\r\n')[0], /^HTTP\/1\.1 400 /);

    const response = await authFetch(`http://127.0.0.1:${port}/api/ping`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'pong');
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('a throw that escapes the request handler gets a 500 and the sidecar keeps serving', async () => {
  const localApi = await setupApiDir({
    'boom.js': `
      export default async function handler() {
        // dispatch() returns this Response; reading its body then throws
        // inside the request handler's own try.
        return new Response(new ReadableStream({
          start(controller) { controller.error(new Error('body failed')); },
        }));
      }
    `,
    'ping.js': `
      export default async function handler() {
        return new Response('pong', { status: 200 });
      }
    `,
  });
  const errors = [];
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: {
      log() {},
      warn() {},
      error(message) {
        errors.push(message);
        // A failing logger inside the handler's own catch is the throw that
        // escapes handleRequest.
        if (message === '[local-api] fatal') throw new Error('logger failed');
      },
    },
  });
  const { port } = await app.start();

  try {
    const failed = await authFetch(`http://127.0.0.1:${port}/api/boom`);
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'Internal server error' });
    assert.ok(errors.includes('[local-api] unhandled request error'), JSON.stringify(errors));

    const response = await authFetch(`http://127.0.0.1:${port}/api/ping`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'pong');
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('rss-proxy forces active and error responses through an inert response policy', async () => {
  const localApi = await setupApiDir({});
  const originalResolve4 = dns.resolve4;
  const originalResolve6 = dns.resolve6;
  const originalHttpsRequest = https.request;
  const upstreamResponses = [
    {
      statusCode: 200,
      statusMessage: 'OK',
      contentType: 'text/html; charset=utf-8',
      body: '<html><script>globalThis.rssProxyExecuted = true;</script></html>',
    },
    {
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      contentType: 'image/svg+xml',
      body: '<svg><script>globalThis.rssProxyExecuted = true;</script></svg>',
    },
  ];
  let upstreamIndex = 0;

  dns.resolve4 = async () => ['93.184.216.34'];
  dns.resolve6 = async () => {
    const error = new Error('No AAAA records');
    error.code = 'ENODATA';
    throw error;
  };
  https.request = (_options, onResponse) => {
    const upstream = upstreamResponses[upstreamIndex++];
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
    req.destroy = (error) => {
      if (error) req.emit('error', error);
    };
    req.end = () => {
      queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = upstream.statusCode;
        res.statusMessage = upstream.statusMessage;
        res.headers = { 'content-type': upstream.contentType };
        onResponse(res);
        res.emit('data', Buffer.from(upstream.body));
        res.emit('end');
      });
    };
    return req;
  };

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    for (const upstream of upstreamResponses) {
      const response = await authFetch(
        `http://127.0.0.1:${port}/api/rss-proxy?url=${encodeURIComponent('https://publisher.example/feed.xml')}`,
      );
      assert.equal(response.status, upstream.statusCode);
      assert.equal(await response.text(), upstream.body);
      assert.equal(response.headers.get('content-type'), 'application/xml; charset=utf-8');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(response.headers.get('content-security-policy') || '', /(?:^|;\s*)sandbox(?:;|$)/);
      assert.match(response.headers.get('content-security-policy') || '', /script-src 'none'/);
    }

    for (const query of ['', '?url=http%3A%2F%2F127.0.0.1%2F']) {
      const response = await authFetch(`http://127.0.0.1:${port}/api/rss-proxy${query}`);
      assert.ok(response.status === 400 || response.status === 403);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(response.headers.get('content-security-policy') || '', /(?:^|;\s*)sandbox(?:;|$)/);
    }
  } finally {
    dns.resolve4 = originalResolve4;
    dns.resolve6 = originalResolve6;
    https.request = originalHttpsRequest;
    await app.close();
    await localApi.cleanup();
  }
});

test('rss-proxy rejects a hostname with mixed public and private DNS answers', async () => {
  const localApi = await setupApiDir({});
  const originalResolve4 = dns.resolve4;
  const originalResolve6 = dns.resolve6;
  const originalHttpsRequest = https.request;
  let outboundCalls = 0;

  dns.resolve4 = async () => ['93.184.216.34'];
  dns.resolve6 = async () => ['fd00::1'];
  https.request = () => {
    outboundCalls += 1;
    throw new Error('blocked DNS result must not reach the network');
  };

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const feedUrl = encodeURIComponent('https://mixed-dns.example/feed.xml');
    const response = await authFetch(`http://127.0.0.1:${port}/api/rss-proxy?url=${feedUrl}`);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /private\/reserved/);
    assert.equal(outboundCalls, 0);
  } finally {
    dns.resolve4 = originalResolve4;
    dns.resolve6 = originalResolve6;
    https.request = originalHttpsRequest;
    await app.close();
    await localApi.cleanup();
  }
});

test('rss-proxy blocks requests to localhost (SSRF protection)', async () => {
  const localApi = await setupApiDir({});

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/rss-proxy?url=http://127.0.0.1:3000`);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.ok(body.error.includes('private') || body.error.includes('localhost'));
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('rss-proxy blocks requests to private IP ranges (SSRF protection)', async () => {
  const localApi = await setupApiDir({});

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    // Test 192.168.x.x range
    const response1 = await authFetch(`http://127.0.0.1:${port}/api/rss-proxy?url=http://192.168.1.1/`);
    assert.equal(response1.status, 403);

    // Test 10.x.x.x range
    const response2 = await authFetch(`http://127.0.0.1:${port}/api/rss-proxy?url=http://10.0.0.1/`);
    assert.equal(response2.status, 403);

    // Test 172.16-31.x.x range
    const response3 = await authFetch(`http://127.0.0.1:${port}/api/rss-proxy?url=http://172.16.0.1/`);
    assert.equal(response3.status, 403);
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('rss-proxy blocks non-http protocols (SSRF protection)', async () => {
  const localApi = await setupApiDir({});

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/rss-proxy?url=file:///etc/passwd`);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.ok(body.error.includes('http'));
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('rss-proxy blocks URLs with credentials (SSRF protection)', async () => {
  const localApi = await setupApiDir({});

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    const response = await authFetch(`http://127.0.0.1:${port}/api/rss-proxy?url=http://user:pass@example.com/rss`);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.ok(body.error.includes('credentials'));
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('traffic log strips query strings from entries to protect privacy', async () => {
  const localApi = await setupApiDir({
    'test-endpoint.js': `
      export default async function handler() {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    // Make a request that will be recorded in the traffic log
    await authFetch(`http://127.0.0.1:${port}/api/test-endpoint?secret=value&key=data`);

    // Retrieve the traffic log
    const logResponse = await authFetch(`http://127.0.0.1:${port}/api/local-traffic-log`);
    assert.equal(logResponse.status, 200);
    const logBody = await logResponse.json();

    // Verify query strings are stripped
    const entry = logBody.entries.find(e => e.path.includes('test-endpoint'));
    assert.ok(entry, 'Traffic log should contain the test-endpoint entry');
    assert.equal(entry.path, '/api/test-endpoint');
    assert.ok(!entry.path.includes('secret='), 'Query string should be stripped from traffic log');
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('service-status reports bound fallback port after EADDRINUSE recovery', async () => {
  const blocker = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('occupied');
  });
  await listen(blocker, '127.0.0.1', 46123);

  const localApi = await setupApiDir({});
  const app = await createLocalApiServer({
    port: 46123,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    assert.notEqual(port, 46123);

    const response = await authFetch(`http://127.0.0.1:${port}/api/service-status`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.local.port, port);
    const localService = body.services.find((service) => service.id === 'local-api');
    assert.equal(localService.description, `Running on 127.0.0.1:${port}`);
  } finally {
    await app.close();
    await localApi.cleanup();
    await new Promise((resolve, reject) => {
      blocker.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('releases the upstream fetch semaphore when a response stalls mid-body (#5441)', async () => {
  // Raw TCP, not http.createServer: sends valid headers with a Content-Length
  // promising more body than it ever delivers, then destroys the socket
  // shortly after — the "accepts connection, sends headers, stalls mid-body,
  // connection eventually drops" failure mode from the issue. Node's http
  // client surfaces this on `res` ('aborted'/'error'), not on `req` — which is
  // exactly what the old globalThis.fetch wrapper never listened for, so the
  // wrapped Promise never settled and the semaphore slot leaked permanently.
  let stallConnections = 0;
  const stallServer = net.createServer((socket) => {
    socket.once('data', () => {
      stallConnections += 1;
      socket.write(
        'HTTP/1.1 200 OK\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Length: 1000\r\n' +
        '\r\n'
      );
      setTimeout(() => socket.destroy(), 20);
    });
  });
  const stallPort = await listen(stallServer);

  const healthy = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const healthyPort = await listen(healthy);

  const localApi = await setupApiDir({
    'stall-proxy.js': `
      export default async function handler() {
        try {
          await fetch('http://127.0.0.1:${stallPort}/');
          return new Response(JSON.stringify({ settled: 'resolved' }), { status: 200 });
        } catch (error) {
          return new Response(JSON.stringify({ settled: 'rejected', message: error.message }), { status: 200 });
        }
      }
    `,
    'healthy-proxy.js': `
      export default async function handler() {
        const upstream = await fetch('http://127.0.0.1:${healthyPort}/');
        const payload = await upstream.text();
        return new Response(payload, { status: upstream.status, headers: { 'content-type': 'application/json' } });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
    allowPrivateFetchOrigins: [
      `http://127.0.0.1:${stallPort}`,
      `http://127.0.0.1:${healthyPort}`,
    ],
  });
  const { port } = await app.start();

  try {
    // getJsonViaHttp, NOT authFetch/global fetch: globalThis.fetch is
    // monkey-patched by local-api-server.mjs and shares its 6-slot semaphore
    // with the handler-side fetches this test is exercising. A real external
    // client (a separate process/browser) never shares that counter — using
    // the patched fetch for these outer calls too would have each one
    // consume a slot just reaching the local API server, before its handler
    // ever got to make its own inner request, self-deadlocking the test
    // rather than reproducing the issue.
    //
    // MAX_CONCURRENT_UPSTREAM is 6 — fire exactly that many concurrent
    // requests through the stalling upstream to exhaust every slot. Do not
    // await them yet: under the pre-fix code these never settle at all, so
    // awaiting here would hang the test itself, not just prove the bug.
    const stallRequests = Array.from({ length: 6 }, () =>
      getJsonViaHttp(`http://127.0.0.1:${port}/api/stall-proxy`)
    );

    // Wait until all 6 have actually reached the upstream (holding their
    // semaphore slot) before touching the healthy endpoint, so the assertion
    // below is exercising a genuinely exhausted semaphore, not a race.
    const deadline = Date.now() + 2000;
    while (stallConnections < 6 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(stallConnections, 6, 'all 6 stalling requests should have reached the upstream');

    // The semaphore is now fully held by 6 in-flight stalling fetches. A 7th
    // request to a completely healthy upstream must still complete quickly —
    // proving the stalled slots were released rather than leaked forever.
    const healthyResponse = await Promise.race([
      getJsonViaHttp(`http://127.0.0.1:${port}/api/healthy-proxy`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('healthy request did not complete — semaphore is wedged')), 3000)
      ),
    ]);
    assert.equal(healthyResponse.status, 200);
    assert.deepEqual(healthyResponse.json, { ok: true });

    // The 6 stalling requests should also have settled (rejected) by now that
    // their upstream connections were destroyed — confirm none of them hung.
    const stallResults = await Promise.all(
      stallRequests.map((p) =>
        Promise.race([
          p.then((r) => r.json),
          new Promise((_, reject) => setTimeout(() => reject(new Error('stall request never settled')), 1000)),
        ])
      )
    );
    for (const result of stallResults) {
      assert.equal(result.settled, 'rejected');
    }
  } finally {
    await app.close();
    await localApi.cleanup();
    await new Promise((resolve, reject) => {
      stallServer.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise((resolve, reject) => {
      healthy.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('nested self-origin fetches do not hold upstream semaphore slots (#5449)', async () => {
  // Self-hosted MCP tools call sibling /api routes on the sidecar's own
  // loopback origin through the patched globalThis.fetch. Each such call used
  // to hold one of the 6 upstream slots for the whole nested request while
  // the nested handler's own fetch needed a slot from the same pool, so six
  // concurrent tool calls wedged until their timeouts fired. Fire 7 outer
  // self-calls whose handler makes one more self-call: with self-origin
  // fetches exempt from the semaphore, all 7 complete promptly.
  const localApi = await setupApiDir({
    'leaf.js': `
      export default async function handler() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    `,
    'self-hop.js': `
      export default async function handler(req) {
        const leaf = await fetch(new URL('/api/leaf', req.url), {
          headers: { 'X-WorldMonitor-Local-Token': process.env.LOCAL_API_TOKEN },
        });
        const payload = await leaf.text();
        return new Response(payload, { status: leaf.status, headers: { 'content-type': 'application/json' } });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
  });
  const { port } = await app.start();

  try {
    // Deliberately the PATCHED globalThis.fetch, not getJsonViaHttp: this is
    // exactly how an MCP registry tool reaches a sibling route in-process.
    const results = await Promise.all(Array.from({ length: 7 }, () =>
      globalThis.fetch(`http://127.0.0.1:${port}/api/self-hop`, {
        headers: { 'X-WorldMonitor-Local-Token': TEST_LOCAL_API_TOKEN },
        signal: AbortSignal.timeout(3000),
      }).then(async (res) => ({ status: res.status, json: await res.json() }))
    ));
    for (const result of results) {
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
    }
  } finally {
    await app.close();
    await localApi.cleanup();
  }
});

test('releases the upstream fetch semaphore when a connection goes silent forever (#5441 follow-up)', async () => {
  // Accepts the connection and never writes anything, never closes -- no
  // FIN/RST, no data. None of res 'error'/'aborted'/'end' or req 'error'/
  // 'close' ever fire for this shape; only the new idle timeout observes it.
  const openSockets = new Set();
  const silentServer = net.createServer((socket) => {
    // Intentionally do nothing with the data -- leave the connection open
    // and silent. Track it so cleanup can force-close it: net.Server.close()
    // waits for every accepted socket to end on its own, and a socket we
    // never write to or read from (by design, to simulate a true silent
    // stall) never will.
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  });
  const silentPort = await listen(silentServer);

  __testing__.setUpstreamIdleTimeoutMs(200);

  const localApi = await setupApiDir({
    'silent-proxy.js': `
      export default async function handler() {
        try {
          await fetch('http://127.0.0.1:${silentPort}/');
          return new Response(JSON.stringify({ settled: 'resolved' }), { status: 200 });
        } catch (error) {
          return new Response(JSON.stringify({ settled: 'rejected', message: error.message }), { status: 200 });
        }
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
    allowPrivateFetchOrigins: [`http://127.0.0.1:${silentPort}`],
  });
  const { port } = await app.start();

  try {
    const result = await Promise.race([
      getJsonViaHttp(`http://127.0.0.1:${port}/api/silent-proxy`).then((r) => r.json),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('silent stall never settled -- idle timeout did not fire')), 3000)
      ),
    ]);
    assert.equal(result.settled, 'rejected');
    assert.match(result.message, /idle-timed out/);

    // Slot must be released: a request through the SAME fetch wrapper (any
    // origin) must not be blocked by the leaked silent connection.
    const stallRequests = Array.from({ length: 6 }, () =>
      getJsonViaHttp(`http://127.0.0.1:${port}/api/silent-proxy`).then((r) => r.json)
    );
    const followUp = await Promise.race([
      Promise.all(stallRequests),
      new Promise((_, reject) => setTimeout(() => reject(new Error('semaphore still wedged after idle timeout')), 5000)),
    ]);
    for (const r of followUp) assert.equal(r.settled, 'rejected');
  } finally {
    __testing__.setUpstreamIdleTimeoutMs(12000);
    await app.close();
    await localApi.cleanup();
    for (const socket of openSockets) socket.destroy();
    await new Promise((resolve, reject) => {
      silentServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('abort-signal path: mid-flight abort rejects promptly and releases the slot (#5441 follow-up)', async () => {
  // Mirrors how fetchWithTimeout drives this exact branch in production: an
  // AbortController whose signal is passed into fetch(), aborted mid-flight
  // against an upstream that never responds.
  const openSockets = new Set();
  const neverResponds = net.createServer((socket) => {
    // Accepts but never writes -- the abort must fire before any other
    // listener would (idle timeout stays at its default 12s here). Tracked
    // so cleanup can force-close it (see the silent-stall test above for why).
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  });
  const neverRespondsPort = await listen(neverResponds);

  const localApi = await setupApiDir({
    'abort-proxy.js': `
      export default async function handler() {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 30);
        try {
          await fetch('http://127.0.0.1:${neverRespondsPort}/', { signal: controller.signal });
          return new Response(JSON.stringify({ settled: 'resolved' }), { status: 200 });
        } catch (error) {
          return new Response(JSON.stringify({ settled: 'rejected', message: error.message, name: error.name }), { status: 200 });
        }
      }
    `,
    'healthy-proxy.js': `
      export default async function handler() {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
    allowPrivateFetchOrigins: [`http://127.0.0.1:${neverRespondsPort}`],
  });
  const { port } = await app.start();

  try {
    const result = await Promise.race([
      getJsonViaHttp(`http://127.0.0.1:${port}/api/abort-proxy`).then((r) => r.json),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('abort-signal path never settled -- semaphore leak reintroduced')), 2000)
      ),
    ]);
    assert.equal(result.settled, 'rejected');
    assert.match(result.message, /aborted by signal/);

    // Slot released promptly (well under the 12s idle timeout): a healthy
    // request right after must not be delayed by the aborted one.
    const healthy = await Promise.race([
      getJsonViaHttp(`http://127.0.0.1:${port}/api/healthy-proxy`).then((r) => r.json),
      new Promise((_, reject) => setTimeout(() => reject(new Error('slot not released after abort')), 1000)),
    ]);
    assert.deepEqual(healthy, { ok: true });
  } finally {
    await app.close();
    await localApi.cleanup();
    for (const socket of openSockets) socket.destroy();
    await new Promise((resolve, reject) => {
      neverResponds.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('abort-signal path: an already-aborted signal rejects immediately without dispatching (#5441 follow-up)', async () => {
  let connectionsReceived = 0;
  const neverShouldConnect = net.createServer((_socket) => {
    connectionsReceived += 1;
  });
  const neverShouldConnectPort = await listen(neverShouldConnect);

  const localApi = await setupApiDir({
    'preaborted-proxy.js': `
      export default async function handler() {
        const controller = new AbortController();
        controller.abort();
        try {
          await fetch('http://127.0.0.1:${neverShouldConnectPort}/', { signal: controller.signal });
          return new Response(JSON.stringify({ settled: 'resolved' }), { status: 200 });
        } catch (error) {
          return new Response(JSON.stringify({ settled: 'rejected', message: error.message }), { status: 200 });
        }
      }
    `,
  });

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() { }, warn() { }, error() { } },
    allowPrivateFetchOrigins: [`http://127.0.0.1:${neverShouldConnectPort}`],
  });
  const { port } = await app.start();

  try {
    const result = await Promise.race([
      getJsonViaHttp(`http://127.0.0.1:${port}/api/preaborted-proxy`).then((r) => r.json),
      new Promise((_, reject) => setTimeout(() => reject(new Error('pre-aborted fetch never settled')), 1000)),
    ]);
    assert.equal(result.settled, 'rejected');
    assert.match(result.message, /aborted by signal/);
    assert.equal(connectionsReceived, 0, 'an already-aborted signal must not dispatch to the network at all');
  } finally {
    await app.close();
    await localApi.cleanup();
    await new Promise((resolve, reject) => {
      neverShouldConnect.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

// ── Self-host desktop-key relay (plan 2026-11-04-001, U3 + U4) ─────────────
// A self-hosted (docker mode) browser stores its own desktop key in an
// HttpOnly cookie through /api/selfhost-key; the sidecar asks the cloud's
// verdict endpoint and relays premium paths to the cloud with that key.

const SELFHOST_ACTIVE_KEY = `wm_${'a'.repeat(40)}`;
const SELFHOST_LAPSED_KEY = `wm_${'b'.repeat(40)}`;
const SELFHOST_INVALID_KEY = `wm_${'c'.repeat(40)}`;
const SELFHOST_OVER_CAP_KEY = `wm_${'d'.repeat(40)}`;
const SELFHOST_API_KIND_KEY = `wm_${'e'.repeat(40)}`;
const SELFHOST_OPERATOR_KEY = `wm_${'f'.repeat(40)}`;
const SELFHOST_PREMIUM_PATH = '/api/market/v1/analyze-stock';
const SELFHOST_FREE_PATH = '/api/market/v1/list-market-quotes';
const SELFHOST_ENV_KEYS = [
  'WORLDMONITOR_SELFHOST_RELAY',
  'WORLDMONITOR_PUBLIC_HTTPS',
  'WORLDMONITOR_API_KEY',
  'WORLDMONITOR_VALID_KEYS',
  'LOCAL_API_APP_VERSION',
  'CONVEX_URL',
];
const LOCAL_ECHO_HANDLER = `export default (req) => Response.json({
  source: 'local',
  cookie: req.headers.get('cookie'),
  key: req.headers.get('x-worldmonitor-key'),
});`;

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function setupSelfHostCloud() {
  const statusCalls = [];
  const relayed = [];
  const mints = [];
  const verdicts = new Map([
    [SELFHOST_ACTIVE_KEY, 'active'],
    [SELFHOST_LAPSED_KEY, 'lapsed'],
    [SELFHOST_INVALID_KEY, 'invalid'],
    [SELFHOST_OVER_CAP_KEY, 'over_cap'],
    [SELFHOST_API_KIND_KEY, 'not_desktop_key'],
  ]);
  const behavior = {
    verdicts,
    status: (key) => ({ code: 200, body: { verdict: verdicts.get(key) ?? 'invalid', planFamily: 'pro' } }),
    relay: (_req, res, url) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'private, max-age=60' });
      res.end(JSON.stringify({ source: 'cloud', path: url.pathname }));
    },
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/wm-session') mints.push(req.headers);
    if (answerSessionMint(req, res)) return;
    if (url.pathname === '/api/desktop-key/status') {
      statusCalls.push({ method: req.method, headers: req.headers });
      const answer = await behavior.status(req.headers['x-worldmonitor-key']);
      if (answer.destroy) {
        req.socket.destroy();
        return;
      }
      res.writeHead(answer.code, { 'content-type': 'application/json', ...(answer.headers || {}) });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
      return;
    }
    const body = await readStream(req);
    relayed.push({ path: url.pathname, search: url.search, method: req.method, headers: req.headers, body });
    await behavior.relay(req, res, url);
  });
  const port = await listen(server);
  return {
    statusCalls,
    relayed,
    mints,
    behavior,
    remoteBase: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

// Requests reach the docker sidecar through nginx, which adds the transport token.
function selfHostRequest(port, pathname, { method = 'GET', headers = {}, body, transport = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...(transport ? { 'X-WorldMonitor-Local-Token': TEST_LOCAL_API_TOKEN } : {}),
        ...(payload !== undefined ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function postSelfHostKey(port, key, headers = {}) {
  return selfHostRequest(port, '/api/selfhost-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
    body: { key },
  });
}

// A request from the install's own page over HTTPS or localhost.
function keyCookie(key) {
  return { Cookie: `wm-desktop-key=${key}`, 'Sec-Fetch-Site': 'same-origin' };
}

async function withSelfHostSidecar(run, { env = {}, mode = 'docker', files } = {}) {
  const cloud = await setupSelfHostCloud();
  const localApi = await setupApiDir(files ?? {
    'market/v1/analyze-stock.js': LOCAL_ECHO_HANDLER,
    'market/v1/list-market-quotes.js': LOCAL_ECHO_HANDLER,
  });
  const savedEnv = Object.fromEntries(SELFHOST_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of SELFHOST_ENV_KEYS) delete process.env[k];
  process.env.LOCAL_API_APP_VERSION = '9.8.7';
  Object.assign(process.env, env);
  const logs = [];
  const capture = (...args) => logs.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '));
  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: cloud.remoteBase,
    allowPrivateRemoteBase: true,
    mode,
    logger: { log: capture, warn: capture, error: capture },
  });
  const { port } = await app.start();
  try {
    await run({ cloud, port, logs });
  } finally {
    await app.close();
    await localApi.cleanup();
    await cloud.close();
    __testing__.resetSelfHostTimings();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function parseSetCookie(response) {
  const raw = response.headers['set-cookie'];
  if (!raw) return null;
  const [cookie] = Array.isArray(raw) ? raw : [raw];
  const [pair, ...attributes] = cookie.split(';').map((part) => part.trim());
  const [name, value] = pair.split('=');
  return {
    raw: cookie,
    name,
    value,
    attributes: attributes.map((a) => a.toLowerCase()),
  };
}

test('the nginx config the Docker image installs forwards the browser authority to /api/', () => {
  const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  const [, installed] = dockerfile.match(/^COPY (docker\/nginx[^\s]*\.conf[^\s]*) \/etc\/nginx\/nginx\.conf\.template$/m) ?? [];
  assert.ok(installed, 'Dockerfile installs an nginx config');
  const conf = readFileSync(new URL(`../../${installed}`, import.meta.url), 'utf8');
  const apiBlock = conf.match(/location \/api\/ \{[\s\S]*?\n {4}\}/)?.[0] ?? '';
  assert.ok(apiBlock, `${installed} has a location /api/ block`);
  assert.match(apiBlock, /proxy_set_header X-Forwarded-Host \$http_host;/,
    'the relay origin check needs the browser authority with its port');
});

test('ships the self-host relay path mirror with the sidecar', () => {
  const config = JSON.parse(readFileSync(new URL('../tauri.conf.json', import.meta.url), 'utf8'));
  const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  assert.ok(config.bundle.resources.includes('../shared/selfhost-relay-paths.js'));
  assert.match(
    dockerfile,
    /COPY --from=builder \/app\/shared\/selfhost-relay-paths\.js \.\/shared\/selfhost-relay-paths\.js/,
  );
});

test('selfhost-key: POST with an active key sets an HttpOnly SameSite=Strict cookie on /api/', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    const before = Date.now();
    const response = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY);
    assert.equal(response.status, 200);
    assert.equal(response.json.enabled, true);
    assert.equal(response.json.status, 'active');
    assert.equal(response.json.stale, false);
    assert.ok(response.json.verifiedAt >= before && response.json.verifiedAt <= Date.now());
    assert.equal(response.headers['cache-control'], 'no-store');
    const cookie = parseSetCookie(response);
    assert.equal(cookie.name, 'wm-desktop-key');
    assert.equal(cookie.value, SELFHOST_ACTIVE_KEY);
    assert.ok(cookie.attributes.includes('httponly'));
    assert.ok(cookie.attributes.includes('samesite=strict'));
    assert.ok(cookie.attributes.includes('path=/api/'));
    assert.ok(cookie.attributes.includes(`max-age=${30 * 24 * 60 * 60}`));
    assert.ok(!cookie.attributes.includes('secure'), 'plain http without the operator flag is not Secure');

    assert.equal(cloud.statusCalls.length, 1);
    const call = cloud.statusCalls[0];
    assert.equal(call.method, 'GET');
    assert.equal(call.headers['x-worldmonitor-key'], SELFHOST_ACTIVE_KEY);
    assert.equal(call.headers.origin, 'https://worldmonitor.app');
    assert.equal(call.headers['user-agent'], 'WorldMonitor-SelfHost/9.8.7 (relay)');
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers['x-worldmonitor-local-token'], undefined);
    assert.equal(cloud.mints.length, 0, 'the verdict call carries the key, never a minted session');
  });
});

test('selfhost-key: the cookie is Secure behind https or with WORLDMONITOR_PUBLIC_HTTPS=1', async () => {
  await withSelfHostSidecar(async ({ port }) => {
    const viaHttps = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY, { 'X-Forwarded-Proto': 'https' });
    assert.ok(parseSetCookie(viaHttps).attributes.includes('secure'));
    const viaHttp = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY, { 'X-Forwarded-Proto': 'http' });
    assert.ok(!parseSetCookie(viaHttp).attributes.includes('secure'));
    // The bundled nginx stamps its own http scheme even behind an outer TLS
    // proxy; the browser's https page origin still marks the cookie Secure.
    const outerTlsOrigin = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY, {
      'X-Forwarded-Proto': 'http', Origin: 'https://dash.example',
    });
    assert.ok(parseSetCookie(outerTlsOrigin).attributes.includes('secure'));
    const outerTlsReferer = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY, {
      'X-Forwarded-Proto': 'http', Referer: 'https://dash.example/settings',
    });
    assert.ok(parseSetCookie(outerTlsReferer).attributes.includes('secure'));
    const plainOrigin = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY, {
      'X-Forwarded-Proto': 'http', Origin: 'http://dash.example',
    });
    assert.ok(!parseSetCookie(plainOrigin).attributes.includes('secure'));
  });
  await withSelfHostSidecar(async ({ port }) => {
    const declared = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY, { 'X-Forwarded-Proto': 'http' });
    assert.ok(parseSetCookie(declared).attributes.includes('secure'));
    assert.ok(parseSetCookie(declared).attributes.includes(`max-age=${30 * 24 * 60 * 60}`));
  }, { env: { WORLDMONITOR_PUBLIC_HTTPS: '1' } });
});

test('selfhost-key: invalid and not_desktop_key verdicts clear any stored key; over_cap and lapsed keep the key', async () => {
  await withSelfHostSidecar(async ({ port }) => {
    for (const [key, status] of [[SELFHOST_INVALID_KEY, 'invalid'], [SELFHOST_API_KIND_KEY, 'not_desktop_key']]) {
      // A rejected replacement must not leave an older working key behind:
      // the browser locks on the rejection, so a later GET must not unlock
      // again from the previous cookie.
      const response = await postSelfHostKey(port, key, keyCookie(SELFHOST_ACTIVE_KEY));
      assert.equal(response.status, 200);
      assert.equal(response.json.status, status);
      const cookie = parseSetCookie(response);
      assert.equal(cookie.value, '', `${status} must never store the rejected key`);
      assert.ok(cookie.attributes.includes('max-age=0'), `${status} clears the stored key`);
    }
    for (const [key, status] of [[SELFHOST_OVER_CAP_KEY, 'over_cap'], [SELFHOST_LAPSED_KEY, 'lapsed']]) {
      const response = await postSelfHostKey(port, key);
      assert.equal(response.json.status, status);
      assert.equal(parseSetCookie(response).value, key);
    }
  });
});

test('selfhost-key: GET reuses a cached verdict for its TTL and asks again after it expires', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    __testing__.setSelfHostVerdictTtlMs(150);
    const first = await selfHostRequest(port, '/api/selfhost-key', { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    const second = await selfHostRequest(port, '/api/selfhost-key', { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(first.json.status, 'active');
    assert.equal(second.json.status, 'active');
    assert.equal(second.json.verifiedAt, first.json.verifiedAt);
    assert.equal(cloud.statusCalls.length, 1);
    await sleep(200);
    const third = await selfHostRequest(port, '/api/selfhost-key', { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(third.json.status, 'active');
    assert.equal(cloud.statusCalls.length, 2);
    assert.ok(third.json.verifiedAt > first.json.verifiedAt);
  });
});

test('selfhost-key: GET without a cookie reports none and calls nothing', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    const response = await selfHostRequest(port, '/api/selfhost-key');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { enabled: true, status: 'none', stale: false, verifiedAt: null });
    assert.equal(cloud.statusCalls.length, 0);
  });
});

for (const outage of ['network', '503']) {
  test(`selfhost-key: a ${outage} outage serves the cached verdict as stale with its original time`, async () => {
    await withSelfHostSidecar(async ({ cloud, port }) => {
      __testing__.setSelfHostVerdictTtlMs(100);
      const posted = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY);
      assert.equal(posted.json.status, 'active');
      await sleep(150);
      cloud.behavior.status = () => (outage === 'network'
        ? { destroy: true }
        : { code: 503, headers: { 'Retry-After': '30' }, body: { error: 'unavailable' } });
      const stale = await selfHostRequest(port, '/api/selfhost-key', { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
      assert.equal(stale.status, 200);
      assert.deepEqual(stale.json, { enabled: true, status: 'active', stale: true, verifiedAt: posted.json.verifiedAt });

      const unknown = await selfHostRequest(port, '/api/selfhost-key', { headers: keyCookie(SELFHOST_LAPSED_KEY) });
      assert.equal(unknown.status, 200);
      assert.deepEqual(unknown.json, { enabled: true, status: 'unavailable', stale: false, verifiedAt: null });
    });
  });
}

test('selfhost-key: a cloud without the verdict route (404) reads as unavailable, never as the route 404', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    cloud.behavior.status = () => ({ code: 404, body: { error: 'Not found' } });
    const posted = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY);
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.json, { enabled: true, status: 'unavailable', stale: false, verifiedAt: null });
    assert.equal(posted.headers['set-cookie'], undefined);
    const got = await selfHostRequest(port, '/api/selfhost-key', { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(got.status, 200);
    assert.equal(got.json.status, 'unavailable');
  });
});

test('selfhost-key: non-verdict cloud answers are unavailable', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    const answers = [
      { code: 200, body: 'not json' },
      { code: 200, body: { verdict: 'granted' } },
      { code: 200, body: { status: 'active' } },
      { code: 403, body: { verdict: 'active' } },
      { code: 429, headers: { 'Retry-After': '10' }, body: { error: 'rate limited' } },
      { code: 500, body: { verdict: 'active' } },
    ];
    for (const answer of answers) {
      cloud.behavior.status = () => answer;
      const response = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY);
      assert.equal(response.json.status, 'unavailable', JSON.stringify(answer));
    }
  });
});

test('selfhost-key: a malformed key is refused with no cloud call; a repeated invalid key is answered from cache', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    for (const key of ['wm_short', `wm_${'A'.repeat(40)}`, `x${SELFHOST_ACTIVE_KEY}`, '', 42]) {
      const response = await postSelfHostKey(port, key);
      assert.equal(response.status, 400, String(key));
      assert.equal(response.json.status, 'invalid');
      const cookie = parseSetCookie(response);
      assert.equal(cookie.value, '');
      assert.ok(cookie.attributes.includes('max-age=0'));
    }
    assert.equal(cloud.statusCalls.length, 0);
    const notJson = await selfHostRequest(port, '/api/selfhost-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope',
    });
    assert.equal(notJson.status, 400);
    assert.equal(cloud.statusCalls.length, 0);

    assert.equal((await postSelfHostKey(port, SELFHOST_INVALID_KEY)).json.status, 'invalid');
    assert.equal((await postSelfHostKey(port, SELFHOST_INVALID_KEY)).json.status, 'invalid');
    assert.equal(cloud.statusCalls.length, 1);
  });
});

test('selfhost-key: POSTs past the per-client limit get 429', async () => {
  await withSelfHostSidecar(async ({ port }) => {
    const client = { 'X-Real-IP': '203.0.113.7' };
    for (let i = 0; i < 10; i++) {
      assert.equal((await postSelfHostKey(port, 'wm_short', client)).status, 400);
    }
    const limited = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY, client);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal(limited.headers['set-cookie'], undefined);
    const otherClient = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY, { 'X-Real-IP': '203.0.113.8' });
    assert.equal(otherClient.status, 200);
  });
});

test('selfhost-key: a cross-site or non-JSON POST is refused and sets no cookie', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    const crossSite = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.headers['set-cookie'], undefined);
    const sameSite = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY, { 'Sec-Fetch-Site': 'same-site' });
    assert.equal(sameSite.status, 403);
    const form = await selfHostRequest(port, '/api/selfhost-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `key=${SELFHOST_ACTIVE_KEY}`,
    });
    assert.equal(form.status, 415);
    assert.equal(form.headers['set-cookie'], undefined);
    const textPlain = await selfHostRequest(port, '/api/selfhost-key', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: { key: SELFHOST_ACTIVE_KEY },
    });
    assert.equal(textPlain.status, 415);
    const crossSiteDelete = await selfHostRequest(port, '/api/selfhost-key', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...keyCookie(SELFHOST_ACTIVE_KEY), 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(crossSiteDelete.status, 403);
    assert.equal(crossSiteDelete.headers['set-cookie'], undefined);
    assert.equal(cloud.statusCalls.length, 0);

    const noFetchMetadata = await selfHostRequest(port, '/api/selfhost-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: { key: SELFHOST_ACTIVE_KEY },
    });
    assert.equal(noFetchMetadata.status, 200, 'a client without Sec-Fetch-Site is not refused');
  });
});

test('selfhost-key: local handlers and the youtube cloud route never see the desktop-key cookie', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    const local = await selfHostRequest(port, SELFHOST_FREE_PATH, {
      headers: { Cookie: `theme=dark; wm-desktop-key=${SELFHOST_ACTIVE_KEY}; lang=en` },
    });
    assert.equal(local.json.source, 'local');
    assert.equal(local.json.cookie, 'theme=dark; lang=en');
    assert.equal(local.json.key, null);

    const onlyKey = await selfHostRequest(port, SELFHOST_FREE_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(onlyKey.json.cookie, null);

    const youtube = await selfHostRequest(port, '/api/youtube/live?channel=x', {
      headers: { Cookie: `theme=dark; wm-session=s1; proxy_session=op; __Host-wm-pro-key=p1; wm-desktop-key=${SELFHOST_ACTIVE_KEY}` },
    });
    assert.equal(youtube.status, 200);
    const call = cloud.relayed.find((c) => c.path === '/api/youtube/live');
    assert.ok(call, 'youtube/live reached the fake cloud');
    assert.equal(call.headers.cookie, 'wm-session=s1; __Host-wm-pro-key=p1', 'ordinary cloud fallback forwards only the wm-session cookies, never the key or operator cookies');
    assert.notEqual(call.headers['x-worldmonitor-key'], SELFHOST_ACTIVE_KEY);
  });
});

test('selfhost-key: DELETE clears the cookie', async () => {
  await withSelfHostSidecar(async ({ port }) => {
    const response = await selfHostRequest(port, '/api/selfhost-key', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...keyCookie(SELFHOST_ACTIVE_KEY) },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { enabled: true, status: 'none', stale: false, verifiedAt: null });
    const cookie = parseSetCookie(response);
    assert.equal(cookie.name, 'wm-desktop-key');
    assert.equal(cookie.value, '');
    assert.ok(cookie.attributes.includes('max-age=0'));
    assert.ok(cookie.attributes.includes('path=/api/'));
    assert.ok(cookie.attributes.includes('httponly'));
  });
});

test('selfhost-key: the route is absent outside docker mode', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    const get = await authFetch(`http://127.0.0.1:${port}/api/selfhost-key`, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(get.status, 404);
    const post = await authFetch(`http://127.0.0.1:${port}/api/selfhost-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: SELFHOST_ACTIVE_KEY }),
    });
    assert.equal(post.status, 404);
    assert.equal(post.headers.get('set-cookie'), null);
    const premium = await authFetch(`http://127.0.0.1:${port}${SELFHOST_PREMIUM_PATH}`, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal((await premium.json()).source, 'local');
    assert.equal(cloud.statusCalls.length, 0);
    assert.equal(cloud.relayed.length, 0);
  }, { mode: 'desktop-sidecar' });
});

test('selfhost-key: the operator off switch disables the setting and the relay with no cloud call', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    const disabled = { enabled: false, status: 'disabled', stale: false, verifiedAt: null };
    const get = await selfHostRequest(port, '/api/selfhost-key', { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(get.status, 200);
    assert.deepEqual(get.json, disabled);
    const post = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY);
    assert.equal(post.status, 200);
    assert.deepEqual(post.json, disabled);
    assert.equal(post.headers['set-cookie'], undefined);
    const premium = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(premium.json.source, 'local');
    assert.equal(premium.json.cookie, null, 'the cookie is still stripped from local handlers');
    assert.equal(cloud.statusCalls.length, 0);
    assert.equal(cloud.relayed.length, 0);
    assert.equal(cloud.mints.length, 0);
  }, { env: { WORLDMONITOR_SELFHOST_RELAY: 'off' } });
});

test('selfhost-key: the raw key never reaches the log', async () => {
  await withSelfHostSidecar(async ({ cloud, port, logs }) => {
    __testing__.setSelfHostVerdictTtlMs(50);
    await postSelfHostKey(port, SELFHOST_ACTIVE_KEY);
    await postSelfHostKey(port, SELFHOST_INVALID_KEY);
    await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    cloud.behavior.relay = (_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Desktop key limit reached for this account' }));
    };
    await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    cloud.behavior.relay = (req) => req.socket.destroy();
    await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    await sleep(80);
    cloud.behavior.status = () => ({ destroy: true });
    await selfHostRequest(port, '/api/selfhost-key', { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.ok(logs.length > 0, 'the sequence logs something, so the check is not vacuous');
    const all = logs.join('\n');
    for (const key of [SELFHOST_ACTIVE_KEY, SELFHOST_INVALID_KEY]) {
      assert.ok(!all.includes(key.slice(3)), 'a raw key appeared in the log');
    }
  });
});

test('relay: a premium path with the cookie goes to the cloud with only the cookie key', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    const response = await selfHostRequest(port, `${SELFHOST_PREMIUM_PATH}?symbol=AAPL`, {
      headers: {
        ...keyCookie(SELFHOST_ACTIVE_KEY),
        Cookie: `wm-session=local-session; wm-desktop-key=${SELFHOST_ACTIVE_KEY}`,
        Origin: 'http://localhost',
        'User-Agent': 'Mozilla/5.0 (Browser)',
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { source: 'cloud', path: SELFHOST_PREMIUM_PATH });
    assert.equal(cloud.relayed.length, 1);
    const call = cloud.relayed[0];
    assert.equal(call.path, SELFHOST_PREMIUM_PATH);
    assert.equal(call.search, '?symbol=AAPL');
    assert.equal(call.headers['x-worldmonitor-key'], SELFHOST_ACTIVE_KEY);
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers.origin, 'https://worldmonitor.app');
    assert.equal(call.headers['user-agent'], 'WorldMonitor-SelfHost/9.8.7 (relay)');
    assert.equal(call.headers['x-worldmonitor-local-token'], undefined);
    assert.equal(call.headers.authorization, undefined);
    assert.equal(cloud.mints.length, 0, 'a relayed call carries the key, never a minted session');
  });
});

test('relay: browser-supplied credentials never ride along with the cookie key', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    await selfHostRequest(port, SELFHOST_PREMIUM_PATH, {
      headers: {
        ...keyCookie(SELFHOST_ACTIVE_KEY),
        'X-WorldMonitor-Key': SELFHOST_LAPSED_KEY,
        'X-Api-Key': SELFHOST_OVER_CAP_KEY,
        Authorization: 'Bearer user.jwt.token',
        'X-WorldMonitor-User-Authorization': 'Bearer clerk.jwt.token',
      },
    });
    assert.equal(cloud.relayed.length, 1);
    const { headers } = cloud.relayed[0];
    assert.equal(headers['x-worldmonitor-key'], SELFHOST_ACTIVE_KEY);
    assert.equal(headers['x-api-key'], undefined);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-worldmonitor-user-authorization'], undefined);
  });
});

test('relay: a key with a cached inactive verdict is served locally', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    assert.equal((await postSelfHostKey(port, SELFHOST_LAPSED_KEY)).json.status, 'lapsed');
    const response = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_LAPSED_KEY) });
    assert.equal(response.json.source, 'local');
    assert.equal(response.json.cookie, null);
    assert.equal(cloud.relayed.length, 0);
  });
});

test('relay: SSE streams incrementally and outlives the relay deadline', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    __testing__.setSelfHostRelayTimeoutMs(200);
    let releaseSecond;
    const secondReleased = new Promise((resolve) => { releaseSecond = resolve; });
    cloud.behavior.relay = async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      res.write('data: one\n\n');
      await secondReleased;
      await sleep(350);
      res.write('data: two\n\n');
      res.end();
    };
    const result = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ query: 'hi' });
      const req = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/api/chat-analyst',
        method: 'POST',
        headers: {
          'X-WorldMonitor-Local-Token': TEST_LOCAL_API_TOKEN,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
          ...keyCookie(SELFHOST_ACTIVE_KEY),
        },
      }, (res) => {
        let text = '';
        let sawFirstBeforeRelease = false;
        const guard = setTimeout(() => reject(new Error('first SSE event never arrived before the stream ended')), 3000);
        res.on('data', (chunk) => {
          text += chunk.toString('utf8');
          if (text.includes('data: one') && !text.includes('data: two') && !sawFirstBeforeRelease) {
            sawFirstBeforeRelease = true;
            clearTimeout(guard);
            releaseSecond();
          }
        });
        res.on('end', () => { clearTimeout(guard); resolve({ status: res.statusCode, headers: res.headers, text, sawFirstBeforeRelease }); });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    assert.equal(result.status, 200);
    assert.equal(result.sawFirstBeforeRelease, true, 'the first event reached the client before the second was written');
    assert.equal(result.text, 'data: one\n\ndata: two\n\n');
    assert.equal(result.headers['content-type'], 'text/event-stream');
    assert.equal(result.headers['x-accel-buffering'], 'no');
    assert.equal(cloud.relayed[0].method, 'POST');
    assert.equal(cloud.relayed[0].body, JSON.stringify({ query: 'hi' }));
  });
});

test('relay: upstream Cache-Control passes through unchanged', async () => {
  await withSelfHostSidecar(async ({ port }) => {
    const response = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(response.headers['cache-control'], 'private, max-age=60');
    assert.doesNotMatch(response.headers['cache-control'], /public|s-maxage/);
  });
});

test('relay: the cloud cannot set cookies on the self-hosted origin', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    cloud.behavior.relay = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'wm-session=cloud; Path=/' });
      res.end('{}');
    };
    const response = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(response.status, 200);
    assert.equal(response.headers['set-cookie'], undefined);
  });
});

test('relay: the same path without the cookie is served locally exactly as today', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    const response = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: { Cookie: 'theme=dark' } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { source: 'local', cookie: 'theme=dark', key: null });
    assert.equal(cloud.relayed.length, 0);
    assert.equal(cloud.statusCalls.length, 0);
  });
});

test('relay: a non-premium path with the cookie is served locally', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    const response = await selfHostRequest(port, SELFHOST_FREE_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(response.json.source, 'local');
    assert.equal(cloud.relayed.length, 0);
  });
});

test('relay: REST v2, MCP and OAuth paths are never relayed', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    for (const pathname of [
      '/api/v2/shipping/route-intelligence',
      '/api/v2/shipping/webhooks',
      '/api/mcp',
      '/mcp',
      '/api/oauth/token',
      '/api/oauth/authorize',
    ]) {
      await selfHostRequest(port, pathname, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    }
    assert.deepEqual(cloud.relayed, []);
    assert.equal(cloud.statusCalls.length, 0);
  });
});

test('relay: operator-configured keys never appear on a relayed request', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    await selfHostRequest(port, SELFHOST_PREMIUM_PATH, {
      headers: { ...keyCookie(SELFHOST_ACTIVE_KEY), 'X-WorldMonitor-Key': 'operator-valid-key-1' },
    });
    assert.equal(cloud.relayed.length, 2);
    for (const call of cloud.relayed) {
      const serialized = JSON.stringify(call);
      assert.ok(!serialized.includes(SELFHOST_OPERATOR_KEY), 'WORLDMONITOR_API_KEY leaked');
      assert.ok(!serialized.includes('operator-valid-key-1'), 'a WORLDMONITOR_VALID_KEYS value leaked');
      assert.ok(!serialized.includes('operator-valid-key-2'), 'a WORLDMONITOR_VALID_KEYS value leaked');
      assert.equal(call.headers['x-worldmonitor-key'], SELFHOST_ACTIVE_KEY);
    }
  }, {
    env: {
      WORLDMONITOR_API_KEY: SELFHOST_OPERATOR_KEY,
      WORLDMONITOR_VALID_KEYS: 'operator-valid-key-1,operator-valid-key-2',
    },
  });
});

test('relay: an upstream 429 reaches the browser unchanged', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    cloud.behavior.relay = (_req, res) => {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '17',
        'x-ratelimit-limit': '120',
        'x-ratelimit-remaining': '0',
      });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
    };
    const response = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(response.status, 429);
    assert.equal(response.headers['retry-after'], '17');
    assert.equal(response.headers['x-ratelimit-limit'], '120');
    assert.equal(response.headers['x-ratelimit-remaining'], '0');
    assert.deepEqual(response.json, { error: 'Rate limit exceeded' });
  });
});

for (const denial of [
  { status: 403, body: { error: 'Desktop key limit reached for this account' } },
  { status: 401, body: { error: 'Invalid API key' } },
]) {
  test(`relay: an upstream ${denial.status} passes through and invalidates the cached verdict`, async () => {
    await withSelfHostSidecar(async ({ cloud, port }) => {
      assert.equal((await postSelfHostKey(port, SELFHOST_ACTIVE_KEY)).json.status, 'active');
      assert.equal(cloud.statusCalls.length, 1);
      cloud.behavior.relay = (_req, res) => {
        res.writeHead(denial.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(denial.body));
      };
      const response = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
      assert.equal(response.status, denial.status);
      assert.deepEqual(response.json, denial.body);

      cloud.behavior.verdicts.set(SELFHOST_ACTIVE_KEY, denial.status === 403 ? 'over_cap' : 'invalid');
      const refreshed = await selfHostRequest(port, '/api/selfhost-key', { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
      assert.equal(cloud.statusCalls.length, 2, 'the denial dropped the cached active verdict');
      assert.equal(refreshed.json.status, denial.status === 403 ? 'over_cap' : 'invalid');
      assert.equal(refreshed.json.stale, false);

      const local = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
      assert.equal(local.json.source, 'local', 'the new inactive verdict stops the relay');
      assert.equal(cloud.relayed.length, 1);
    });
  });
}

test('relay: cloud headers slower than the generic upstream idle timeout still arrive within the relay deadline', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    __testing__.setUpstreamIdleTimeoutMs(100);
    __testing__.setSelfHostRelayTimeoutMs(2000);
    try {
      assert.equal((await postSelfHostKey(port, SELFHOST_ACTIVE_KEY)).json.status, 'active');
      cloud.behavior.relay = async (_req, res, url) => {
        await sleep(400);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ source: 'cloud', path: url.pathname }));
      };
      const response = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
      assert.equal(response.status, 200);
      assert.equal(response.json.source, 'cloud');
    } finally {
      __testing__.setUpstreamIdleTimeoutMs(12000);
    }
  });
});

test('relay: a known inactive key stays local after its verdict goes stale', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    __testing__.setSelfHostVerdictTtlMs(50);
    assert.equal((await postSelfHostKey(port, SELFHOST_LAPSED_KEY)).json.status, 'lapsed');
    await sleep(120);
    const response = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_LAPSED_KEY) });
    assert.equal(response.json.source, 'local');
    assert.equal(cloud.relayed.length, 0, 'a lapsed key is not relayed once its verdict is older than the TTL');
  });
});

test('selfhost-key: a POST during a cloud outage answers unavailable and leaves the stored cookie alone', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    __testing__.setSelfHostVerdictTtlMs(50);
    assert.equal((await postSelfHostKey(port, SELFHOST_ACTIVE_KEY)).json.status, 'active');
    await sleep(120);
    cloud.behavior.status = () => ({ destroy: true });
    const response = await postSelfHostKey(port, SELFHOST_ACTIVE_KEY);
    assert.equal(response.status, 200);
    assert.equal(response.json.status, 'unavailable');
    assert.equal(response.json.stale, false);
    assert.equal(response.headers['set-cookie'], undefined);
  });
});

test('selfhost-key: a GET reports a dead key but never sets or clears the cookie', async () => {
  // A slow GET for an old key can land after a POST stored a new one; a
  // clearing Set-Cookie on it would delete the new key. The relay already
  // stops on the last inactive verdict, so GET only reports.
  await withSelfHostSidecar(async ({ cloud, port }) => {
    for (const key of [SELFHOST_INVALID_KEY, SELFHOST_API_KIND_KEY, 'wm_short', SELFHOST_LAPSED_KEY]) {
      const response = await selfHostRequest(port, '/api/selfhost-key', { headers: keyCookie(key) });
      assert.notEqual(response.json.status, 'active');
      assert.equal(response.headers['set-cookie'], undefined, key.slice(0, 8));
    }
    const relayed = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_INVALID_KEY) });
    assert.equal(relayed.json.source, 'local', 'a key known to be invalid is never relayed');
    assert.equal(cloud.relayed.length, 0);
  });
});

test('relay: two different desktop-key cookies are never relayed', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    assert.equal((await postSelfHostKey(port, SELFHOST_ACTIVE_KEY)).json.status, 'active');
    const conflicting = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, {
      headers: { Cookie: `wm-desktop-key=${SELFHOST_ACTIVE_KEY}; wm-desktop-key=${SELFHOST_OPERATOR_KEY}`, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(conflicting.json.source, 'local');
    assert.equal(conflicting.json.cookie, null);
    assert.equal(cloud.relayed.length, 0);

    const duplicate = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, {
      headers: { Cookie: `wm-desktop-key=${SELFHOST_ACTIVE_KEY}; wm-desktop-key=${SELFHOST_ACTIVE_KEY}`, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(duplicate.json.source, 'cloud', 'the same value twice is one key');
  });
});

test('relay: a cross-site or same-site request is served locally even with the cookie', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    assert.equal((await postSelfHostKey(port, SELFHOST_ACTIVE_KEY)).json.status, 'active');
    const cookie = { Cookie: `wm-desktop-key=${SELFHOST_ACTIVE_KEY}` };
    for (const site of ['cross-site', 'same-site']) {
      const response = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: { ...cookie, 'Sec-Fetch-Site': site } });
      assert.equal(response.json.source, 'local', site);
    }
    assert.equal(cloud.relayed.length, 0);
    for (const site of ['same-origin', 'none']) {
      const response = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: { ...cookie, 'Sec-Fetch-Site': site } });
      assert.equal(response.json.source, 'cloud', site);
    }
  });
});

test('relay: without Fetch Metadata (plain HTTP) only a same-origin Referer relays', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    assert.equal((await postSelfHostKey(port, SELFHOST_ACTIVE_KEY)).json.status, 'active');
    const cookie = { Cookie: `wm-desktop-key=${SELFHOST_ACTIVE_KEY}` };
    const local = async (headers, label) => {
      const response = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: { ...cookie, ...headers } });
      assert.equal(response.json.source, 'local', label);
    };
    await local({}, 'no Referer');
    await local({ Referer: 'http://192.168.1.20:3000/' }, 'a sibling app on another port');
    await local({ Referer: 'not a url' }, 'an unparseable Referer');
    await local({ 'X-Forwarded-Host': 'dash.example', Referer: 'http://other.example/' }, 'another host behind nginx');
    // A proxy that sends only `Host $host` strips the port, so a page on the
    // host's default port would look like this install: refuse instead.
    await local({ Host: 'dash.example', 'X-Forwarded-For': '192.168.1.5', Referer: 'http://dash.example/' }, 'proxied without X-Forwarded-Host');
    await local({ Host: 'dash.example', 'X-Real-IP': '192.168.1.5', Referer: 'http://dash.example/' }, 'X-Real-IP without X-Forwarded-Host');
    assert.equal(cloud.relayed.length, 0);

    const direct = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, {
      headers: { ...cookie, Referer: `http://127.0.0.1:${port}/dashboard` },
    });
    assert.equal(direct.json.source, 'cloud', 'the sidecar reached directly: Host names the page origin');
    const proxied = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, {
      headers: { ...cookie, 'X-Forwarded-Host': '192.168.1.20:8080', Referer: 'http://192.168.1.20:8080/dashboard?country=US' },
    });
    assert.equal(proxied.json.source, 'cloud', 'behind nginx: X-Forwarded-Host names the page origin');
  });
});

test('relay: the cloud cannot set host-wide policy headers on the self-hosted origin', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    assert.equal((await postSelfHostKey(port, SELFHOST_ACTIVE_KEY)).json.status, 'active');
    cloud.behavior.relay = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
        'alt-svc': 'h3=":443"; ma=86400',
      });
      res.end('{"source":"cloud"}');
    };
    const response = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(response.json.source, 'cloud');
    assert.equal(response.headers['strict-transport-security'], undefined);
    assert.equal(response.headers['alt-svc'], undefined);
  });
});

test('relay: an upstream timeout is a relay error, distinct from a denial, and keeps the verdict', async () => {
  await withSelfHostSidecar(async ({ cloud, port }) => {
    __testing__.setSelfHostRelayTimeoutMs(150);
    assert.equal((await postSelfHostKey(port, SELFHOST_ACTIVE_KEY)).json.status, 'active');
    cloud.behavior.relay = async (_req, res) => {
      await sleep(600);
      if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    };
    const timedOut = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(timedOut.status, 504);
    assert.equal(timedOut.headers['x-wm-relay-error'], 'timeout');
    assert.equal(timedOut.json.error, 'relay_timeout');

    cloud.behavior.relay = (req) => req.socket.destroy();
    const unreachable = await selfHostRequest(port, SELFHOST_PREMIUM_PATH, { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(unreachable.status, 502);
    assert.equal(unreachable.headers['x-wm-relay-error'], 'unreachable');

    const verdict = await selfHostRequest(port, '/api/selfhost-key', { headers: keyCookie(SELFHOST_ACTIVE_KEY) });
    assert.equal(verdict.json.status, 'active');
    assert.equal(cloud.statusCalls.length, 1, 'a transport failure does not invalidate the verdict');
  });
});
