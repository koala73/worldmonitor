import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http, { createServer, request as httpRequest } from 'node:http';
import https from 'node:https';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalApiServer } from './local-api-server.mjs';

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

async function setupRemoteServer() {
  const hits = [];
  const origins = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    hits.push(url.pathname);
    origins.push(req.headers.origin || null);
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

test('signs desktop register-interest cloud fallback when shared secret is configured', async () => {
  const originalSecret = process.env.WM_DESKTOP_SHARED_SECRET;
  const originalConvex = process.env.CONVEX_URL;
  process.env.WM_DESKTOP_SHARED_SECRET = 'desktop-test-secret';
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
    }, {
      'Content-Encoding': 'gzip',
      'X-WorldMonitor-Desktop-Timestamp': '1',
      'X-WorldMonitor-Desktop-Signature': 'sha256=bad',
    });
    assert.equal(response.status, 200);
    assert.equal(remote.requests.length, 1);

    const request = remote.requests[0];
    assert.equal(request.path, '/api/leads/v1/register-interest');
    assert.equal(request.json.source, 'desktop-settings');
    const timestamp = request.headers['x-worldmonitor-desktop-timestamp'];
    const signature = request.headers['x-worldmonitor-desktop-signature'];
    assert.equal(request.headers['content-encoding'], undefined);
    assert.match(request.headers['user-agent'], /Chrome\/131\.0\.0\.0/);
    assert.match(timestamp, /^\d+$/);
    assert.match(signature, /^sha256=[a-f0-9]{64}$/);
    assert.notEqual(timestamp, '1');
    assert.notEqual(signature, 'sha256=bad');

    const canonical = JSON.stringify({
      email: 'desktop@example.com',
      source: 'desktop-settings',
      appVersion: '2.8.0',
      referredBy: '',
      website: '',
      turnstileToken: '',
    });
    const expected = `sha256=${createHmac('sha256', process.env.WM_DESKTOP_SHARED_SECRET)
      .update(`${timestamp}\n${canonical}`)
      .digest('hex')}`;
    assert.equal(signature, expected);
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
    if (originalSecret === undefined) delete process.env.WM_DESKTOP_SHARED_SECRET;
    else process.env.WM_DESKTOP_SHARED_SECRET = originalSecret;
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

test('preserves Request body when handler uses fetch(Request)', async () => {
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
        const upstream = await fetch(request);
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

test('blocks handler global fetches to private network targets (#3549)', async () => {
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
        const upstream = await fetch(process.env.WM_TEST_UPSTREAM);
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
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OLLAMA_API_URL: process.env.OLLAMA_API_URL,
    LLM_API_URL: process.env.LLM_API_URL,
  };
  let lookupCallbackWasSync = null;

  delete process.env.GROQ_API_KEY;
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
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OLLAMA_API_URL: process.env.OLLAMA_API_URL,
    LLM_API_URL: process.env.LLM_API_URL,
  };
  let sawOllamaProbe = false;

  delete process.env.GROQ_API_KEY;
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

test('accepts OLLAMA_API_URL via /api/local-env-update', async () => {
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

test('accepts WM_DESKTOP_SHARED_SECRET via /api/local-env-update', async () => {
  const originalSecret = process.env.WM_DESKTOP_SHARED_SECRET;
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
      body: JSON.stringify({ key: 'WM_DESKTOP_SHARED_SECRET', value: 'desktop-secret-from-runtime' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.key, 'WM_DESKTOP_SHARED_SECRET');
    assert.equal(process.env.WM_DESKTOP_SHARED_SECRET, 'desktop-secret-from-runtime');
  } finally {
    if (originalSecret === undefined) delete process.env.WM_DESKTOP_SHARED_SECRET;
    else process.env.WM_DESKTOP_SHARED_SECRET = originalSecret;
    await app.close();
    await localApi.cleanup();
  }
});

test('validates WM_DESKTOP_SHARED_SECRET without provider probe', async () => {
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
      body: JSON.stringify({ key: 'WM_DESKTOP_SHARED_SECRET', value: 'desktop-secret-from-runtime' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.valid, true);
    assert.equal(body.message, 'Desktop shared secret stored');
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
      key: 'GROQ_API_KEY',
      value: 'dummy-key',
    });
    assert.equal(response.status, 200);
    assert.equal(response.json?.valid, true);
    assert.equal(response.json?.message, 'Groq key stored (Cloudflare blocked verification)');
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
      key: 'GROQ_API_KEY',
      value: 'invalid-key',
    });
    assert.equal(response.status, 422);
    assert.equal(response.json?.valid, false);
    assert.equal(response.json?.message, 'Groq rejected this key');
  } finally {
    restoreHttps();
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
    const health = await fetch(`http://127.0.0.1:${port}/api/service-status`);
    assert.equal(health.status, 200);
  } finally {
    if (originalToken !== undefined) {
      process.env.LOCAL_API_TOKEN = originalToken;
    }
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
