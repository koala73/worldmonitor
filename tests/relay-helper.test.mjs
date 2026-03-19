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

  it('wraps non-JSON error responses in a JSON envelope', async () => {
    // Simulate Cloudflare/nginx returning an HTML error page
    mockFetch(async () => new Response(
      '<html><body><h1>502 Bad Gateway</h1></body></html>',
      { status: 502, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 502);
  });

  it('wraps text/plain error responses in a JSON envelope', async () => {
    mockFetch(async () => new Response(
      'Service Unavailable',
      { status: 503, headers: { 'Content-Type': 'text/plain' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 503);
  });

  it('preserves JSON error responses as-is', async () => {
    mockFetchStatus(502, '{"upstream":"error"}');
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(await res.text(), '{"upstream":"error"}');
  });

  it('passes through non-JSON success responses unchanged', async () => {
    // Some endpoints legitimately return non-JSON on success (e.g. XML feeds)
    mockFetch(async () => new Response(
      '<rss><channel></channel></rss>',
      { status: 200, headers: { 'Content-Type': 'application/xml' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/xml');
    assert.equal(await res.text(), '<rss><channel></channel></rss>');
  });

  it('wraps error response with no content-type in JSON envelope', async () => {
    mockFetch(async () => new Response('bad gateway', { status: 502, headers: {} }));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
  });

  // ── Content-Type edge cases ──────────────────────────────────────────

  it('wraps text/html with charset param in JSON envelope', async () => {
    mockFetch(async () => new Response(
      '<html><body>Bad Gateway</body></html>',
      { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 502);
  });

  it('preserves JSON error with uppercase APPLICATION/JSON content-type', async () => {
    mockFetch(async () => new Response(
      '{"detail":"bad request"}',
      { status: 400, headers: { 'Content-Type': 'APPLICATION/JSON' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.detail, 'bad request');
  });

  it('preserves JSON error with application/json; charset=utf-8 content-type', async () => {
    mockFetch(async () => new Response(
      '{"message":"not found"}',
      { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.equal(text, '{"message":"not found"}');
  });

  it('passes application/vnd.api+json error through unchanged (JSON-compatible type)', async () => {
    // application/vnd.api+json contains "+json" so it is treated as JSON and passed through
    mockFetch(async () => new Response(
      '{"errors":[{"status":"500"}]}',
      { status: 500, headers: { 'Content-Type': 'application/vnd.api+json' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('content-type'), 'application/vnd.api+json');
    const body = await res.json();
    assert.deepEqual(body.errors, [{ status: '500' }]);
  });

  it('wraps error with empty string content-type in JSON envelope', async () => {
    mockFetch(async () => {
      const resp = new Response('something broke', { status: 500 });
      // Explicitly set empty content-type via headers
      return new Response('something broke', {
        status: 500,
        headers: { 'Content-Type': '' },
      });
    });
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 500);
  });

  it('wraps multipart/form-data error in JSON envelope', async () => {
    mockFetch(async () => new Response(
      'some binary data',
      { status: 502, headers: { 'Content-Type': 'multipart/form-data' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 502);
  });

  it('preserves mixed-case Application/Json error response as-is', async () => {
    mockFetch(async () => new Response(
      '{"err":"server error"}',
      { status: 500, headers: { 'Content-Type': 'Application/Json' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.equal(text, '{"err":"server error"}');
  });

  // ── Status code edge cases ───────────────────────────────────────────

  it('wraps 400 text/html error in JSON envelope', async () => {
    mockFetch(async () => new Response(
      '<html>Bad Request</html>',
      { status: 400, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 400);
  });

  it('wraps 401 text/html error in JSON envelope', async () => {
    mockFetch(async () => new Response(
      'Unauthorized',
      { status: 401, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 401);
  });

  it('wraps 403 text/plain error in JSON envelope', async () => {
    mockFetch(async () => new Response(
      'Forbidden',
      { status: 403, headers: { 'Content-Type': 'text/plain' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 403);
  });

  it('wraps 404 text/html error in JSON envelope', async () => {
    mockFetch(async () => new Response(
      '<h1>Not Found</h1>',
      { status: 404, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 404);
  });

  it('wraps 499 text/plain error in JSON envelope', async () => {
    mockFetch(async () => new Response(
      'Client Closed Request',
      { status: 499, headers: { 'Content-Type': 'text/plain' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 499);
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 499);
  });

  it('wraps 500 text/html error in JSON envelope', async () => {
    mockFetch(async () => new Response(
      '<html>Internal Server Error</html>',
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 500);
  });

  it('wraps 504 text/html error in JSON envelope', async () => {
    mockFetch(async () => new Response(
      '<html>Gateway Timeout</html>',
      { status: 504, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 504);
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 504);
  });

  it('does NOT wrap 200 non-JSON response (success passthrough)', async () => {
    mockFetch(async () => new Response(
      '<html>OK page</html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html');
    assert.equal(await res.text(), '<html>OK page</html>');
  });

  it('does NOT wrap 201 non-JSON response (success passthrough)', async () => {
    mockFetch(async () => new Response(
      'Created',
      { status: 201, headers: { 'Content-Type': 'text/plain' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(await res.text(), 'Created');
  });

  it('does NOT wrap 299 non-JSON response (upper bound of success range)', async () => {
    mockFetch(async () => new Response(
      'success boundary',
      { status: 299, headers: { 'Content-Type': 'text/plain' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 299);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(await res.text(), 'success boundary');
  });

  it('wraps 300 non-JSON response (first non-2xx)', async () => {
    mockFetch(async () => new Response(
      'Multiple Choices',
      { status: 300, headers: { 'Content-Type': 'text/plain' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 300);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 300);
  });

  // ── Body edge cases ──────────────────────────────────────────────────

  it('wraps empty body with non-JSON error content-type', async () => {
    mockFetch(async () => new Response(
      '',
      { status: 502, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 502);
  });

  it('wraps very large HTML body and still returns parseable JSON', async () => {
    const largeHtml = '<html>' + '<p>error</p>'.repeat(10000) + '</html>';
    mockFetch(async () => new Response(
      largeHtml,
      { status: 502, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 502);
    // The large HTML body should NOT leak into the JSON envelope
    const text = JSON.stringify(body);
    assert.ok(!text.includes('<html>'));
  });

  it('wraps body that looks like JSON but has wrong content-type', async () => {
    // Server returns valid JSON body but says it is text/html
    mockFetch(async () => new Response(
      '{"actually":"json"}',
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    // The original JSON body is replaced by the envelope
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 500);
    assert.equal(body.actually, undefined);
  });

  it('wraps null body with error status', async () => {
    mockFetch(async () => new Response(
      null,
      { status: 503, headers: { 'Content-Type': 'text/plain' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 503);
  });

  // ── Interaction with fallback + onlyOk ───────────────────────────────

  it('calls fallback BEFORE wrapping when onlyOk is true and response is non-JSON error', async () => {
    // When onlyOk is true and response is non-2xx, fallback should fire
    // regardless of content-type — wrapping never gets a chance
    mockFetch(async () => new Response(
      '<html>502</html>',
      { status: 502, headers: { 'Content-Type': 'text/html' } },
    ));
    let fallbackCalled = false;
    const handler = createRelayHandler({
      relayPath: '/test',
      onlyOk: true,
      fallback: (_req, cors) => {
        fallbackCalled = true;
        return new Response('{"from":"fallback"}', {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      },
    });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(fallbackCalled, true);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.from, 'fallback');
  });

  it('wraps non-JSON error when onlyOk is true but fallback is NOT set', async () => {
    // onlyOk without fallback: the code path falls through to buildRelayResponse
    mockFetch(async () => new Response(
      '<html>502</html>',
      { status: 502, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({
      relayPath: '/test',
      onlyOk: true,
      // no fallback
    });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 502);
  });

  it('does NOT call fallback for non-2xx JSON error when onlyOk is false', async () => {
    mockFetchStatus(502, '{"upstream":"error"}');
    let fallbackCalled = false;
    const handler = createRelayHandler({
      relayPath: '/test',
      onlyOk: false,
      fallback: () => {
        fallbackCalled = true;
        return new Response('{}', { status: 200 });
      },
    });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(fallbackCalled, false);
    assert.equal(res.status, 502);
    assert.equal(await res.text(), '{"upstream":"error"}');
  });

  // ── Interaction with extraHeaders and cacheHeaders ───────────────────

  it('preserves extraHeaders in wrapped non-JSON error response', async () => {
    mockFetch(async () => new Response(
      '<html>502</html>',
      { status: 502, headers: { 'Content-Type': 'text/html', 'X-Cache': 'MISS' } },
    ));
    const handler = createRelayHandler({
      relayPath: '/test',
      extraHeaders: (response) => {
        const xc = response.headers.get('x-cache');
        return xc ? { 'X-Cache': xc } : {};
      },
    });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('x-cache'), 'MISS');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
  });

  it('preserves cacheHeaders in wrapped non-JSON error response', async () => {
    mockFetch(async () => new Response(
      '<html>503</html>',
      { status: 503, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({
      relayPath: '/test',
      cacheHeaders: (ok) => ({
        'Cache-Control': ok ? 'public, max-age=60' : 'no-store',
      }),
    });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
  });

  it('preserves both extraHeaders and cacheHeaders in wrapped response', async () => {
    mockFetch(async () => new Response(
      'Unavailable',
      { status: 503, headers: { 'Content-Type': 'text/plain', 'X-Request-Id': 'abc-123' } },
    ));
    const handler = createRelayHandler({
      relayPath: '/test',
      cacheHeaders: (ok) => ({
        'Cache-Control': ok ? 'public, max-age=120' : 'no-cache',
      }),
      extraHeaders: (response) => ({
        'X-Request-Id': response.headers.get('x-request-id') || '',
      }),
    });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(res.headers.get('x-request-id'), 'abc-123');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 503);
  });

  it('includes CORS headers in wrapped non-JSON error response', async () => {
    mockFetch(async () => new Response(
      '<html>502</html>',
      { status: 502, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 502);
    assert.ok(res.headers.get('access-control-allow-origin'));
    assert.ok(res.headers.get('vary'));
  });

  // ── JSON envelope is always parseable ────────────────────────────────

  it('produces parseable JSON envelope for every non-2xx non-JSON status', async () => {
    const statuses = [300, 301, 302, 400, 401, 403, 404, 405, 429, 499, 500, 502, 503, 504];
    for (const status of statuses) {
      mockFetch(async () => new Response(
        `<html>Error ${status}</html>`,
        { status, headers: { 'Content-Type': 'text/html' } },
      ));
      const handler = createRelayHandler({ relayPath: '/test' });
      const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
      assert.equal(res.status, status, `Status mismatch for ${status}`);
      const text = await res.text();
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(text); }, `Body not valid JSON for status ${status}`);
      assert.ok(parsed.error.startsWith('Upstream error'), `Missing error field for status ${status}`);
      assert.equal(parsed.status, status, `Missing status field for status ${status}`);
    }
  });

  it('produces parseable JSON even when upstream body contains characters that need escaping', async () => {
    // The wrapping replaces the body, but let us verify the envelope itself is clean
    mockFetch(async () => new Response(
      '<script>alert("xss")</script>\n\t\r\0',
      { status: 502, headers: { 'Content-Type': 'text/html' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    const text = await res.text();
    const parsed = JSON.parse(text);
    assert.ok(parsed.error.startsWith('Upstream error'));
    assert.equal(parsed.status, 502);
  });

  // ── Success responses with unusual content-types pass through unchanged ──

  it('passes through application/xml success response unchanged', async () => {
    mockFetch(async () => new Response(
      '<?xml version="1.0"?><data/>',
      { status: 200, headers: { 'Content-Type': 'application/xml' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/xml');
    assert.equal(await res.text(), '<?xml version="1.0"?><data/>');
  });

  it('passes through text/csv success response unchanged', async () => {
    mockFetch(async () => new Response(
      'name,value\nfoo,1\nbar,2',
      { status: 200, headers: { 'Content-Type': 'text/csv' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/csv');
    assert.equal(await res.text(), 'name,value\nfoo,1\nbar,2');
  });

  it('passes through application/octet-stream success response unchanged', async () => {
    mockFetch(async () => new Response(
      'binary-ish-data',
      { status: 200, headers: { 'Content-Type': 'application/octet-stream' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(await res.text(), 'binary-ish-data');
  });

  it('passes through text/plain success response unchanged', async () => {
    mockFetch(async () => new Response(
      'just plain text',
      { status: 200, headers: { 'Content-Type': 'text/plain' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(await res.text(), 'just plain text');
  });

  it('passes through application/vnd.api+json success response unchanged', async () => {
    mockFetch(async () => new Response(
      '{"data":{"type":"articles","id":"1"}}',
      { status: 200, headers: { 'Content-Type': 'application/vnd.api+json' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.api+json');
    assert.equal(await res.text(), '{"data":{"type":"articles","id":"1"}}');
  });

  it('passes through success response with no explicit content-type (gets default text/plain)', async () => {
    // When Response has no explicit Content-Type, the runtime defaults to text/plain;charset=UTF-8
    // The upstream response.headers.get('content-type') returns that default, so the
    // `|| 'application/json'` fallback in buildRelayResponse never fires.
    mockFetch(async () => new Response('{"ok":true}', { status: 200, headers: {} }));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/plain'));
    assert.equal(await res.text(), '{"ok":true}');
  });

  // ── Boundary: status < 200 is not valid for Response constructor ────
  // Node rejects status codes outside 200-599, so an upstream that somehow
  // triggers a RangeError is caught and returned as a 502.

  it('returns 502 when upstream produces an invalid status code (triggers catch)', async () => {
    mockFetch(async () => new Response(
      'informational-ish',
      { status: 199, headers: { 'Content-Type': 'text/plain' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    // The RangeError from Response constructor is caught by the handler
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'Relay request failed');
  });

  it('wraps non-JSON 599 error (upper bound of valid HTTP status)', async () => {
    mockFetch(async () => new Response(
      'custom error',
      { status: 599, headers: { 'Content-Type': 'text/plain' } },
    ));
    const handler = createRelayHandler({ relayPath: '/test' });
    const res = await handler(makeRequest('https://worldmonitor.app/api/test'));
    assert.equal(res.status, 599);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.ok(body.error.startsWith('Upstream error'), `unexpected error: ${body.error}`);
    assert.equal(body.status, 599);
  });
});
