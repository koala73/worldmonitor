import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

process.env.WS_RELAY_URL = 'wss://relay.example.com';
process.env.RELAY_SHARED_SECRET = 'test-secret';

const { getRelayBaseUrl, getRelayHeaders, fetchWithTimeout, createRelayHandler } = await import('../api/_relay.js');

function makeRequest(url, opts = {}) {
  return new Request(url, {
    method: opts.method || 'GET',
    headers: new Headers({
      Origin: 'https://worldmonitor.app',
      ...opts.headers,
    }),
  });
}

function mockFetch(handler) {
  globalThis.fetch = handler;
}

function mockFetchOk(body = '{"ok":true}', headers = {}) {
  mockFetch(async () => new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  }));
}

function mockFetchStatus(status, body = '{"error":"upstream"}') {
  mockFetch(async () => new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function mockFetchError(message = 'Network error') {
  mockFetch(async () => { throw new Error(message); });
}

describe('getRelayBaseUrl', () => {
  afterEach(restoreEnv);

  it('converts wss:// to https://', () => {
    process.env.WS_RELAY_URL = 'wss://relay.example.com';
    assert.equal(getRelayBaseUrl(), 'https://relay.example.com');
  });

  it('converts ws:// to http://', () => {
    process.env.WS_RELAY_URL = 'ws://relay.example.com';
    assert.equal(getRelayBaseUrl(), 'http://relay.example.com');
  });

  it('strips trailing slash', () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com/';
    assert.equal(getRelayBaseUrl(), 'https://relay.example.com');
  });

  it('returns null when not set', () => {
    delete process.env.WS_RELAY_URL;
    assert.equal(getRelayBaseUrl(), null);
  });

  it('returns null for empty string', () => {
    process.env.WS_RELAY_URL = '';
    assert.equal(getRelayBaseUrl(), null);
  });
});

describe('getRelayHeaders', () => {
  afterEach(restoreEnv);

  it('injects relay secret and Authorization', () => {
    process.env.RELAY_SHARED_SECRET = 'my-secret';
    delete process.env.RELAY_AUTH_HEADER;
    const headers = getRelayHeaders({ Accept: 'application/json' });
    assert.equal(headers.Accept, 'application/json');
    assert.equal(headers['x-relay-key'], 'my-secret');
    assert.equal(headers.Authorization, 'Bearer my-secret');
  });

  it('uses custom auth header name', () => {
    process.env.RELAY_SHARED_SECRET = 'sec';
    process.env.RELAY_AUTH_HEADER = 'X-Custom-Key';
    const headers = getRelayHeaders();
    assert.equal(headers['x-custom-key'], 'sec');
    assert.equal(headers.Authorization, 'Bearer sec');
  });

  it('returns base headers only when no secret', () => {
    process.env.RELAY_SHARED_SECRET = '';
    const headers = getRelayHeaders({ Accept: 'text/xml' });
    assert.equal(headers.Accept, 'text/xml');
    assert.equal(headers.Authorization, undefined);
  });
});

describe('fetchWithTimeout', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns response on success', async () => {
    mockFetchOk('{"data":1}');
    const res = await fetchWithTimeout('https://example.com', {}, 5000);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"data":1}');
  });

  it('aborts on timeout', async () => {
    mockFetch((_url, opts) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      opts?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    }));
    await assert.rejects(
      () => fetchWithTimeout('https://example.com', {}, 50),
      (err) => err.name === 'AbortError',
    );
  });
});

describe('createRelayHandler', () => {
  beforeEach(() => {
    process.env.WS_RELAY_URL = 'wss://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('returns CORS headers on every response', async () => {
    mockFetchOk();
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.ok(res.headers.get('access-control-allow-origin'));
    assert.ok(res.headers.get('vary'));
  });

  it('responds 204 to OPTIONS', async () => {
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test', { method: 'OPTIONS' }));
    assert.equal(res.status, 204);
  });

  it('responds 403 to disallowed origin', async () => {
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test', {
      headers: { Origin: 'https://evil.com' },
    }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'Origin not allowed');
  });

  it('responds 405 to non-GET', async () => {
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test', { method: 'POST' }));
    assert.equal(res.status, 405);
  });

  it('responds 401 when requireApiKey and no valid key', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'real-key-123';
    const handler = createRelayHandler({ relayPath: '/test', requireApiKey: true });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test', {
      headers: { Origin: 'https://tauri.localhost', 'X-WorldMonitor-Key': 'wrong-key' },
    }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Invalid API key');
  });

  it('allows request when requireApiKey and key is valid', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'real-key-123';
    mockFetchOk();
    const handler = createRelayHandler({ relayPath: '/test', requireApiKey: true });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test', {
      headers: { Origin: 'https://tauri.localhost', 'X-WorldMonitor-Key': 'real-key-123' },
    }));
    assert.equal(res.status, 200);
  });

  it('responds 503 when WS_RELAY_URL not set', async () => {
    delete process.env.WS_RELAY_URL;
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'WS_RELAY_URL is not configured');
  });

  it('proxies relay response with correct status and body', async () => {
    mockFetchOk('{"items":[1,2,3]}');
    const handler = createRelayHandler({ relayPath: '/data' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/data'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"items":[1,2,3]}');
  });

  it('forwards search params by default', async () => {
    let capturedUrl;
    mockFetch(async (url) => {
      capturedUrl = url;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const handler = createRelayHandler({ relayPath: '/test' });
    await handler(makeRequest('https://worldmonitor.app/api/test?foo=bar&baz=1'));
    assert.ok(capturedUrl.includes('?foo=bar&baz=1'));
  });

  it('drops search params when forwardSearch is false', async () => {
    let capturedUrl;
    mockFetch(async (url) => {
      capturedUrl = url;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const handler = createRelayHandler({ relayPath: '/test', forwardSearch: false });
    await handler(makeRequest('https://worldmonitor.app/api/test?foo=bar'));
    assert.ok(!capturedUrl.includes('?foo=bar'));
  });

  it('uses buildRelayPath for dynamic paths', async () => {
    let capturedUrl;
    mockFetch(async (url) => {
      capturedUrl = url;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const handler = createRelayHandler({
      buildRelayPath: (_req, url) => {
        const ep = url.searchParams.get('endpoint');
        return ep === 'history' ? '/oref/history' : '/oref/alerts';
      },
      forwardSearch: false,
    });
    await handler(makeRequest('https://worldmonitor.app/api/oref?endpoint=history'));
    assert.ok(capturedUrl.endsWith('/oref/history'));
  });

  it('applies cacheHeaders on success', async () => {
    mockFetchOk();
    const handler = createRelayHandler({
      relayPath: '/test',
      cacheHeaders: (ok) => ({
        'Cache-Control': ok ? 'public, max-age=60' : 'max-age=10',
      }),
    });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  });

  it('applies cacheHeaders on error pass-through', async () => {
    mockFetchStatus(500);
    const handler = createRelayHandler({
      relayPath: '/test',
      cacheHeaders: (ok) => ({
        'Cache-Control': ok ? 'public, max-age=60' : 'max-age=10',
      }),
    });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('cache-control'), 'max-age=10');
  });

  it('applies extraHeaders', async () => {
    mockFetch(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
    }));
    const handler = createRelayHandler({
      relayPath: '/test',
      extraHeaders: (response) => {
        const xc = response.headers.get('x-cache');
        return xc ? { 'X-Cache': xc } : {};
      },
    });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.headers.get('x-cache'), 'HIT');
  });

  it('returns 504 on timeout', async () => {
    mockFetch((_url, opts) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      opts?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    }));
    const handler = createRelayHandler({ relayPath: '/test', timeout: 50 });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 504);
    const body = await res.json();
    assert.equal(body.error, 'Relay timeout');
  });

  it('returns 502 on network error', async () => {
    mockFetchError('Connection refused');
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'Relay request failed');
    assert.equal(body.details, 'Connection refused');
  });

  it('calls fallback when relay unavailable', async () => {
    delete process.env.WS_RELAY_URL;
    const handler = createRelayHandler({
      relayPath: '/test',
      fallback: (_req, cors) => new Response('{"fallback":true}', {
        status: 503,
        headers: { 'Content-Type': 'application/json', ...cors },
      }),
    });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.fallback, true);
  });

  it('calls fallback on network error when fallback set', async () => {
    mockFetchError('fail');
    const handler = createRelayHandler({
      relayPath: '/test',
      fallback: (_req, cors) => new Response('{"fallback":true}', {
        status: 503,
        headers: { 'Content-Type': 'application/json', ...cors },
      }),
    });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.fallback, true);
  });

  it('calls fallback when onlyOk and non-2xx', async () => {
    mockFetchStatus(502);
    const handler = createRelayHandler({
      relayPath: '/test',
      onlyOk: true,
      fallback: (_req, cors) => new Response('{"fallback":true}', {
        status: 503,
        headers: { 'Content-Type': 'application/json', ...cors },
      }),
    });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.fallback, true);
  });

  it('passes through non-2xx when onlyOk is false', async () => {
    mockFetchStatus(502, '{"upstream":"error"}');
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 502);
    assert.equal(await res.text(), '{"upstream":"error"}');
  });
});
