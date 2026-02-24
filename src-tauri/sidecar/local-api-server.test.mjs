import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalApiServer } from './local-api-server.mjs';

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

async function postJsonViaHttp(url, payload) {
  const target = new URL(url);
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: Number(target.port || 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
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

function mockHttpsRequestOnce({ statusCode, headers, body }) {
  const original = https.request;
  https.request = (_options, onResponse) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/fred-data`);
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/fred-data`);
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const payload = JSON.stringify({ secret: 'keep-body' });
    const response = await fetch(`http://127.0.0.1:${port}/api/post-fail`, {
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/live`);
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/not-found`);
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

test('strips browser origin headers before invoking local handlers', async () => {
  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({
    'origin-check.js': `
      export default async function handler(req) {
        const origin = req.headers.get('origin');
        return new Response(JSON.stringify({
          source: 'local',
          originPresent: Boolean(origin),
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/origin-check`, {
      headers: { Origin: 'https://tauri.localhost' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'local');
    assert.equal(body.originPresent, false);
    assert.equal(remote.hits.length, 0);
  } finally {
    await app.close();
    await localApi.cleanup();
    await remote.close();
  }
});

test('preserves Request body when handler uses fetch(Request)', async () => {
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
  process.env.WM_TEST_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;

  const localApi = await setupApiDir({
    'request-proxy.js': `
      export default async function handler() {
        const request = new Request(\`\${process.env.WM_TEST_UPSTREAM}/echo\`, {
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/request-proxy`);
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

  const upstream = createServer((req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  process.env.WM_TEST_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;

  const localApi = await setupApiDir({
    'request-consumed.js': `
      export default async function handler() {
        const request = new Request(\`\${process.env.WM_TEST_UPSTREAM}/echo\`, {
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/request-consumed`);
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

test('strips browser origin headers when proxying to cloud fallback (cloudFallback enabled)', async () => {
  const remote = await setupRemoteServer();
  const localApi = await setupApiDir({});

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    remoteBase: remote.remoteBase,
    cloudFallback: 'true',
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/no-local-handler`, {
      headers: { Origin: 'https://tauri.localhost' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'remote');
    assert.equal(body.origin, null);
    assert.equal(remote.origins[0], null);
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/data`, { method: 'OPTIONS' });
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/large`, {
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    assert.equal(app.context.apiDir, localResource.apiDir);
    assert.equal(app.routes.length, 1);

    const response = await fetch(`http://127.0.0.1:${port}/api/live`);
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local-env-update`, {
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local-env-update`, {
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

test('rejects unknown key via /api/local-env-update', async () => {
  const localApi = await setupApiDir({});

  const app = await createLocalApiServer({
    port: 0,
    apiDir: localApi.apiDir,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local-env-update`, {
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local-validate-secret`, {
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local-validate-secret`, {
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local-validate-secret`, {
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local-validate-secret`, {
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local-validate-secret`, {
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
    logger: { log() {}, warn() {}, error() {} },
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
    logger: { log() {}, warn() {}, error() {} },
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
    logger: { log() {}, warn() {}, error() {} },
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
    const authedResponse = await fetch(`http://127.0.0.1:${port}/api/local-env-update`, {
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/compression-check`, {
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
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/compression-check`, {
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
