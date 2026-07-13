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

function createHandler(options: { handlerCdnCacheHeader?: string; publicRouteBody?: unknown } = {}) {
  return createDomainGateway([
    {
      method: 'GET',
      path: '/api/market/v1/list-market-quotes',
      handler: async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: options.handlerCdnCacheHeader ? { 'CDN-Cache-Control': options.handlerCdnCacheHeader } : undefined,
      }),
    },
    {
      method: 'GET',
      path: '/api/conflict/v1/list-acled-events',
      handler: async () => new Response(JSON.stringify(options.publicRouteBody ?? { ok: true }), { status: 200 }),
    },
    {
      method: 'GET',
      path: '/api/news/v1/list-feed-digest',
      handler: async () => new Response(JSON.stringify({ categories: {}, feedStatuses: {}, generatedAt: '2026-07-13T00:00:00.000Z' }), { status: 200 }),
    },
    {
      method: 'GET',
      path: '/api/displacement/v1/get-displacement-summary',
      handler: async () => new Response(JSON.stringify({ summary: { countries: [], topFlows: [] }, fetchedAt: 1, dataAvailable: true }), { status: 200 }),
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

function assertNoSharedCacheHeaders(res: Response) {
  assert.equal(res.headers.get('CDN-Cache-Control'), null);
  assert.doesNotMatch(res.headers.get('Cache-Control') ?? '', /\bpublic\b|\bs-maxage=/i);
}

describe('gateway CDN origin policy', () => {
  it('keeps per-origin CORS without shared CDN caching for session-bearing worldmonitor.app GETs', async () => {
    const res = await requestPublicRoute('https://worldmonitor.app');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
    assert.equal(res.headers.get('Vary'), 'Origin');
    assertNoSharedCacheHeaders(res);
  });

  it('keeps per-origin CORS without shared CDN caching for session-bearing production subdomain GETs', async () => {
    const res = await requestPublicRoute('https://tech.worldmonitor.app');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://tech.worldmonitor.app');
    assert.equal(res.headers.get('Vary'), 'Origin');
    assertNoSharedCacheHeaders(res);
  });

  it('avoids shared CDN caching for session-bearing preview origin GETs', async () => {
    const origin = 'https://worldmonitor-git-feature-eliewm.vercel.app';
    const res = await requestPublicRoute(origin);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(res.headers.get('Vary'), 'Origin');
    assertNoSharedCacheHeaders(res);
  });

  it('avoids shared CDN caching for session-bearing localhost GETs', async () => {
    const origin = 'http://127.0.0.1:5173';
    const res = await requestPublicRoute(origin);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(res.headers.get('Vary'), 'Origin');
    assertNoSharedCacheHeaders(res);
  });

  it('avoids shared CDN caching for enterprise-key Tauri GETs', async () => {
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
    assertNoSharedCacheHeaders(res);
  });

  it('preserves CDN caching for explicit anonymous public no-auth GETs', async () => {
    const origin = 'https://worldmonitor.app';
    const handler = createHandler();
    const res = await handler(new Request('https://worldmonitor.app/api/conflict/v1/list-acled-events', {
      headers: { Origin: origin },
    }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(res.headers.get('Vary'), 'Origin');
    assert.match(res.headers.get('CDN-Cache-Control') ?? '', /s-maxage=/);
  });

  for (const path of [
    '/api/news/v1/list-feed-digest?variant=full&lang=en&public=1',
    '/api/displacement/v1/get-displacement-summary?flow_limit=50&public=1',
  ]) {
    it(`CDN-shields the exact caller-invariant public RPC variant: ${path}`, async () => {
      const handler = createHandler();
      const res = await handler(new Request(`https://worldmonitor.app${path}`, {
        headers: { Origin: 'https://worldmonitor.app' },
      }));

      assert.equal(res.status, 200);
      assert.match(res.headers.get('CDN-Cache-Control') ?? '', /s-maxage=/);
    });

    it(`keeps the public RPC response invariant when credentials are attached: ${path}`, async () => {
      const handler = createHandler();
      const res = await handler(new Request(`https://worldmonitor.app${path}`, {
        headers: {
          Origin: 'https://worldmonitor.app',
          'X-WorldMonitor-Key': sessionToken,
        },
      }));

      assert.equal(res.status, 200);
      assert.match(res.headers.get('CDN-Cache-Control') ?? '', /s-maxage=/);
    });
  }

  // Vercel's filesystem router serves these through api/**/[rpc].ts and echoes the
  // matched segment back as ?rpc=<lastPathSegment>. Production therefore sees a query
  // the hand-built URLs in these tests never had — which silently 401'd every public
  // RPC (#5285). server/_shared/mcp-internal-hmac.ts strips the same echo for signing.
  for (const [path, rpc] of [
    ['/api/news/v1/list-feed-digest?variant=full&lang=en&public=1', 'list-feed-digest'],
    ['/api/displacement/v1/get-displacement-summary?flow_limit=50&public=1', 'get-displacement-summary'],
  ] as const) {
    it(`CDN-shields the public RPC variant when the router echoes ?rpc=: ${path}`, async () => {
      const handler = createHandler();
      const res = await handler(new Request(`https://worldmonitor.app${path}&rpc=${rpc}`, {
        headers: { Origin: 'https://worldmonitor.app' },
      }));

      assert.equal(res.status, 200);
      assert.match(res.headers.get('CDN-Cache-Control') ?? '', /s-maxage=/);
    });
  }

  it('does not widen the public RPC cache contract to legacy or arbitrary query shapes', async () => {
    const handler = createHandler();
    for (const path of [
      '/api/news/v1/list-feed-digest?variant=full&lang=en',
      '/api/news/v1/list-feed-digest?variant=full&lang=en&public=1&jmespath=categories',
      '/api/displacement/v1/get-displacement-summary?flow_limit=49&public=1',
      '/api/displacement/v1/get-displacement-summary?flow_limit=500&public=1',
      '/api/displacement/v1/get-displacement-summary?flow_limit=50&public=1&year=2026',
      '/api/displacement/v1/get-displacement-summary?flow_limit=50&public=1&country_limit=50',
      '/api/displacement/v1/get-displacement-summary?public=1',
      '/api/displacement/v1/get-displacement-summary?flow_limit=50&public=1&unexpected=1',
      '/api/displacement/v1/get-displacement-summary?flow_limit=50&flow_limit=50&public=1',
      '/api/displacement/v1/get-displacement-summary?flow_limit=50&public=1&public=1',
      '/api/displacement/v1/get-displacement-summary?public=1&flow_limit=50',
      '/api/displacement/v1/get-displacement-summary?flow_limit=%35%30&public=1',
      // A caller-supplied ?rpc= that is NOT the router's echo of the final path
      // segment must still fail the shape check — stripping is not a bypass vector.
      '/api/news/v1/list-feed-digest?variant=full&lang=en&public=1&rpc=bogus',
      '/api/displacement/v1/get-displacement-summary?flow_limit=50&public=1&rpc=bogus',
      '/api/displacement/v1/get-displacement-summary?flow_limit=50&public=1&rpc=list-feed-digest',
    ]) {
      const res = await handler(new Request(`https://worldmonitor.app${path}`, {
        headers: { Origin: 'https://worldmonitor.app' },
      }));
      assert.equal(res.status, 401, path);
      assertNoSharedCacheHeaders(res);
    }
  });

  it('skips CDN caching for degraded dataAvailable=false 200 responses', async () => {
    const origin = 'https://worldmonitor.app';
    const handler = createHandler({
      publicRouteBody: { events: [], fetchedAt: 0, dataAvailable: false },
    });
    const res = await handler(new Request('https://worldmonitor.app/api/conflict/v1/list-acled-events?_debug=1', {
      headers: { Origin: origin },
    }));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.dataAvailable, false);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('X-Cache-Tier'), 'no-store');
    assert.equal(res.headers.get('CDN-Cache-Control'), null);
    assert.equal(res.headers.get('Vercel-CDN-Cache-Control'), null);
  });

  it('strips handler-supplied shared CDN headers on credential-bearing GETs', async () => {
    const handler = createHandler({
      handlerCdnCacheHeader: 'public, s-maxage=9999, stale-while-revalidate=9999',
    });
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': sessionToken },
    }));

    assert.equal(res.status, 200);
    assertNoSharedCacheHeaders(res);
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
    assert.equal(noCreds.headers.get('Cache-Control'), 'no-store');

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

  it('normalizes invalid wm_ gateway-validation sentinel to non-cacheable invalid key response', async () => {
    const handler = createHandler();
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': 'wm_revoked_or_unknown_key',
      },
    }));
    const body = await res.json();

    assert.equal(res.status, 401);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('CDN-Cache-Control'), null);
    assert.equal(body.error, 'Invalid API key');
    assert.doesNotMatch(JSON.stringify(body), /gateway validation|Convex|keyHash/i);
  });

  it('normalizes invalid wm_ gateway-validation sentinel on premium RPCs', async () => {
    const handler = createHandler();
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': 'wm_revoked_or_unknown_key',
      },
    }));
    const body = await res.json();

    assert.equal(res.status, 401);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('CDN-Cache-Control'), null);
    assert.equal(body.error, 'Invalid API key');
    assert.doesNotMatch(JSON.stringify(body), /gateway validation|Convex|keyHash/i);
  });
});
