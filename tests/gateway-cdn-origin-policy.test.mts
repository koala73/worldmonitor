import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import { issueSessionToken } from '../api/_session.js';

const originalKeys = process.env.WORLDMONITOR_VALID_KEYS;
const originalSecret = process.env.WM_SESSION_SECRET;

// Anonymous browser access now requires a wms_ session token (issue #3541).
// Tests mint one once and pass it on every "browser-like" request.
let sessionToken: string;

before(async () => {
  process.env.WM_SESSION_SECRET = 'test-secret-must-be-at-least-32-chars-long-xxx';
  sessionToken = (await issueSessionToken()).token;
});

afterEach(() => {
  if (originalKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = originalKeys;
  if (originalSecret == null) delete process.env.WM_SESSION_SECRET;
  else process.env.WM_SESSION_SECRET = originalSecret;
  // Re-set test secret in case afterEach ran AFTER the per-test reset.
  process.env.WM_SESSION_SECRET = 'test-secret-must-be-at-least-32-chars-long-xxx';
});

function createHandler() {
  return createDomainGateway([
    {
      method: 'GET',
      path: '/api/market/v1/list-market-quotes',
      handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    },
    {
      method: 'GET',
      path: '/api/market/v1/analyze-stock',
      handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    },
  ]);
}

async function requestPublicRoute(origin: string) {
  const handler = createHandler();
  return handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
    headers: { Origin: origin, 'X-WorldMonitor-Key': sessionToken },
  }));
}

describe('gateway CDN origin policy', () => {
  it('keeps per-origin CORS and enables CDN caching for worldmonitor.app', async () => {
    const res = await requestPublicRoute('https://worldmonitor.app');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
    assert.equal(res.headers.get('Vary'), 'Origin');
    assert.match(res.headers.get('CDN-Cache-Control') ?? '', /s-maxage=/);
  });

  it('keeps per-origin CORS and enables CDN caching for production subdomains', async () => {
    const res = await requestPublicRoute('https://tech.worldmonitor.app');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://tech.worldmonitor.app');
    assert.equal(res.headers.get('Vary'), 'Origin');
    assert.match(res.headers.get('CDN-Cache-Control') ?? '', /s-maxage=/);
  });

  it('enables CDN caching for preview origins', async () => {
    const origin = 'https://worldmonitor-feature-elie-abc123.vercel.app';
    const res = await requestPublicRoute(origin);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(res.headers.get('Vary'), 'Origin');
    assert.match(res.headers.get('CDN-Cache-Control') ?? '', /s-maxage=/);
  });

  it('enables CDN caching for localhost origins', async () => {
    const origin = 'http://127.0.0.1:5173';
    const res = await requestPublicRoute(origin);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(res.headers.get('Vary'), 'Origin');
    assert.match(res.headers.get('CDN-Cache-Control') ?? '', /s-maxage=/);
  });

  it('enables CDN caching for Tauri origins', async () => {
    const origin = 'tauri://localhost';
    process.env.WORLDMONITOR_VALID_KEYS = 'real-key-123';
    const handler = createHandler();
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: {
        Origin: origin,
        'X-WorldMonitor-Key': 'real-key-123',
      },
    }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(res.headers.get('Vary'), 'Origin');
    assert.match(res.headers.get('CDN-Cache-Control') ?? '', /s-maxage=/);
  });

  it('still blocks disallowed origins before route handling', async () => {
    const handler = createHandler();
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: { Origin: 'https://evil.example.com' },
    }));
    assert.equal(res.status, 403);
  });

  it('preserves premium auth behavior', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'real-key-123';
    const handler = createHandler();

    const noCreds = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(noCreds.status, 401);

    const withKey = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': 'real-key-123',
      },
    }));
    assert.equal(withKey.status, 200);
    assert.equal(withKey.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
    assert.equal(withKey.headers.get('Vary'), 'Origin');
    assert.equal(withKey.headers.get('CDN-Cache-Control'), null, 'premium endpoints must NOT have CDN caching');
  });
});
