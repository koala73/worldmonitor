// Unit tests for the api-cors-preflight Cloudflare Worker.
//
// These run against the Worker module directly with Node's Fetch primitives —
// the Worker only uses standard Request/Response/Headers which Node 22+ has
// natively. No miniflare / wrangler test harness required.
//
// What we pin here:
//   - OPTIONS preflight returns 204 + Access-Control-Allow-Credentials: true
//     (the load-bearing assertion — the 2026-05-27 outage was a missing ACAC).
//   - Allowed origins are echoed verbatim into ACAO.
//   - Disallowed origins fall back to the canonical https://worldmonitor.app
//     (so browsers reject the request rather than the Worker serving an open
//     wildcard).
//   - Non-/api/ paths pass through to fetch() unmodified.
//   - The allow-headers list matches api/_cors.js (drift would silently
//     break preflight for any header the function expects but the Worker
//     forgets).
//
// If you add a new origin pattern, allow-header, or trusted method to
// api/_cors.js, you MUST mirror it here and the assertion will catch the
// gap — that's the point.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import worker, { isAllowedOrigin, buildCorsHeaders, hasPublicCorsPolicy } from './src/index.js';
// One definition of the public `&public=1` response contract, shared with the
// origin-handler guard (api/bootstrap-auth.test.mjs) and the deployed-URL guard
// (tests/cors-preflight-live.test.mjs). #7308 was a drift bug; a second copy of
// the contract here would be the same mistake in test form.
import { assertPublicBootstrapCorsHeaders } from '../../tests/helpers/public-bootstrap-contract.mjs';

function makeRequest(method, url, headers = {}) {
  return new Request(url, { method, headers });
}

const CANONICAL_FALLBACK = 'https://worldmonitor.app';
const KNOWN_GOOD = 'https://www.worldmonitor.app';
const ACAH_EXPECTED = 'Content-Type, Authorization, X-WorldMonitor-Key, X-Api-Key, X-Widget-Key, X-Pro-Key, X-WorldMonitor-Desktop-Timestamp, X-WorldMonitor-Desktop-Signature, Idempotency-Key, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID';
const ACEH_EXPECTED = 'Mcp-Session-Id, WWW-Authenticate, Retry-After, Idempotency-Key, Idempotent-Replayed, X-Billing-Verification, RateLimit, RateLimit-Policy, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Mode, X-WorldMonitor-Bbox, X-WorldMonitor-Bbox-Missing, X-WorldMonitor-Bbox-Invalid, X-Military-Bbox, Link, Deprecation, Sunset';
// Must be a superset of every method any api/* route advertises. Notably
// includes DELETE for api/product-catalog.js — pinning this prevents the
// regression that PR review caught (Worker omitted DELETE → product-catalog
// purge preflights silently fail in prod).
const ACAM_EXPECTED = 'GET, POST, DELETE, HEAD, OPTIONS';

// --- allowlist coverage ---------------------------------------------------

test('isAllowedOrigin accepts apex worldmonitor.app and subdomains', () => {
  assert.equal(isAllowedOrigin('https://worldmonitor.app'), true);
  assert.equal(isAllowedOrigin('https://www.worldmonitor.app'), true);
  assert.equal(isAllowedOrigin('https://tech.worldmonitor.app'), true);
  assert.equal(isAllowedOrigin('https://commodity.worldmonitor.app'), true);
});

test('isAllowedOrigin accepts trailing-dot FQDN first-party origins (#6411)', () => {
  assert.equal(isAllowedOrigin('https://worldmonitor.app.'), true);
  assert.equal(isAllowedOrigin('https://tech.worldmonitor.app.'), true);
  assert.equal(isAllowedOrigin('https://www.worldmonitor.app.'), true);
});

test('isAllowedOrigin accepts Google Translate proxy origins of worldmonitor.app (#6411)', () => {
  assert.equal(isAllowedOrigin('https://www-worldmonitor-app.translate.goog'), true);
  assert.equal(isAllowedOrigin('https://worldmonitor-app.translate.goog'), true);
  assert.equal(isAllowedOrigin('https://tech-worldmonitor-app.translate.goog'), true);
  assert.equal(isAllowedOrigin('https://evil-example-com.translate.goog'), false);
  // `--` is Google's encoding of a literal hyphen — must not suffix-match.
  assert.equal(isAllowedOrigin('https://evil--worldmonitor-app.translate.goog'), false);
  assert.equal(isAllowedOrigin('https://notworldmonitor-app.translate.goog'), false);
});

test('isAllowedOrigin accepts Vercel preview deploys under the eliewm team scope (mirrors api/_cors.js)', () => {
  // The project deploys previews under the "eliewm" Vercel team scope, so URLs
  // end in `-eliewm.vercel.app` (git-branch alias AND hash deployment forms).
  // The Worker MUST mirror api/_cors.js exactly — if it stays narrower, eliewm
  // preview preflights echo the canonical worldmonitor.app fallback and the
  // browser blocks them before the request ever reaches Vercel.
  assert.equal(isAllowedOrigin('https://worldmonitor-git-feat-x-eliewm.vercel.app'), true);
  assert.equal(isAllowedOrigin('https://worldmonitor-r6q9o-eliewm.vercel.app'), true);
  // Tight allowlist: a foreign team scope, a non-worldmonitor app, and the
  // retired personal scope (worldmonitor-*-elie-<hash>, migration complete)
  // must all stay rejected. Never a bare *.vercel.app.
  assert.equal(isAllowedOrigin('https://worldmonitor-feat-x-attacker.vercel.app'), false);
  assert.equal(isAllowedOrigin('https://some-other-app-eliewm.vercel.app'), false);
  assert.equal(isAllowedOrigin('https://worldmonitor-abc-elie-habib.vercel.app'), false);
});

test('isAllowedOrigin accepts Tauri desktop runtime origins', () => {
  assert.equal(isAllowedOrigin('tauri://localhost'), true);
  assert.equal(isAllowedOrigin('asset://localhost'), true);
  assert.equal(isAllowedOrigin('http://tauri.localhost'), true);
  assert.equal(isAllowedOrigin('https://tauri.localhost:1420'), true);
  assert.equal(isAllowedOrigin('http://app.tauri.localhost'), true);
});

test('isAllowedOrigin rejects unrelated origins', () => {
  assert.equal(isAllowedOrigin('https://evil.com'), false);
  assert.equal(isAllowedOrigin('https://worldmonitor.app.evil.com'), false);
  assert.equal(isAllowedOrigin('https://notworldmonitor.app'), false);
  assert.equal(isAllowedOrigin(''), false);
});

// --- CORS header shape ----------------------------------------------------

test('buildCorsHeaders echoes allowed origin and includes credentials flag', () => {
  const h = buildCorsHeaders(KNOWN_GOOD);
  assert.equal(h['Access-Control-Allow-Origin'], KNOWN_GOOD);
  assert.equal(h['Access-Control-Allow-Credentials'], 'true');
  assert.equal(h['Vary'], 'Origin');
});

test('buildCorsHeaders falls back to canonical origin for disallowed origins', () => {
  const h = buildCorsHeaders('https://evil.com');
  assert.equal(h['Access-Control-Allow-Origin'], CANONICAL_FALLBACK);
  // Still must set ACAC: true; missing it would 'work' for opaque requests
  // but the browser CORS gate compares the echoed origin to the request
  // origin and rejects the mismatch — which is the correct disposition.
  assert.equal(h['Access-Control-Allow-Credentials'], 'true');
});

test('buildCorsHeaders Access-Control-Allow-Headers matches api/_cors.js', () => {
  const h = buildCorsHeaders(KNOWN_GOOD);
  assert.equal(h['Access-Control-Allow-Headers'], ACAH_EXPECTED);
});

test('buildCorsHeaders Access-Control-Expose-Headers matches api/_cors.js', () => {
  const h = buildCorsHeaders(KNOWN_GOOD);
  assert.equal(h['Access-Control-Expose-Headers'], ACEH_EXPECTED);
});

// --- preflight short-circuit (the load-bearing branch) --------------------

test('OPTIONS preflight returns 204 with Access-Control-Allow-Credentials: true', async () => {
  const req = makeRequest('OPTIONS', 'https://api.worldmonitor.app/api/bootstrap?tier=fast', {
    Origin: KNOWN_GOOD,
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'content-type',
  });
  const resp = await worker.fetch(req);
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('access-control-allow-origin'), KNOWN_GOOD);
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(resp.headers.get('access-control-allow-methods'), ACAM_EXPECTED);
  assert.equal(resp.headers.get('access-control-allow-headers'), ACAH_EXPECTED);
  assert.equal(resp.headers.get('access-control-expose-headers'), ACEH_EXPECTED);
  assert.equal(resp.headers.get('vary'), 'Origin');
  assert.match(resp.headers.get('link') ?? '', /rel="deprecation"/);
  assert.match(resp.headers.get('link') ?? '', /api-versioning\.md/);
});

test('OPTIONS preflight to /api/product-catalog preserves the endpoint-owned DELETE policy', async () => {
  // Product catalog owns both its public GET CORS contract and its
  // credentialed DELETE policy. Its preflight must now reach Vercel rather
  // than being replaced by the Worker's generic CORS headers.
  const original = globalThis.fetch;
  let received;
  globalThis.fetch = async (request) => {
    received = request;
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': KNOWN_GOOD,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
      },
    });
  };
  try {
    const req = makeRequest('OPTIONS', 'https://api.worldmonitor.app/api/product-catalog', {
      Origin: KNOWN_GOOD,
      'Access-Control-Request-Method': 'DELETE',
    });
    const resp = await worker.fetch(req);
    assert.equal(received, req, 'preflight must be forwarded to the endpoint');
    assert.equal(resp.headers.get('access-control-allow-origin'), KNOWN_GOOD);
    assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(resp.headers.get('access-control-allow-methods'), 'GET, DELETE, OPTIONS');
  } finally {
    globalThis.fetch = original;
  }
});

test('OPTIONS preflight from disallowed origin echoes the request Origin (#6411)', async () => {
  const evil = 'https://evil.com';
  const req = makeRequest('OPTIONS', 'https://api.worldmonitor.app/api/bootstrap', {
    Origin: evil,
  });
  const resp = await worker.fetch(req);
  assert.equal(resp.status, 204);
  // Preflight must echo the caller so the browser will send the actual request;
  // the POST/GET response still uses the allowlist (canonical fallback) except
  // on explicit 401/403 refusals.
  assert.equal(resp.headers.get('access-control-allow-origin'), evil);
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
});

// --- pass-through for non-/api/ paths -------------------------------------

test('non-/api/ paths bypass CORS injection and call fetch directly', async () => {
  // The Worker's first-line guard returns fetch(request) for any path outside
  // /api/. We can't run a live fetch here, but we can confirm the branch is
  // taken by stubbing globalThis.fetch.
  const original = globalThis.fetch;
  let received;
  globalThis.fetch = async (req) => {
    received = req;
    return new Response('ok', { status: 200 });
  };
  try {
    const req = makeRequest('GET', 'https://api.worldmonitor.app/health-check', {
      Origin: KNOWN_GOOD,
    });
    const resp = await worker.fetch(req);
    assert.equal(resp.status, 200);
    // CORS headers should NOT be injected on pass-through, because the
    // Worker treats non-/api/ paths as out of scope.
    assert.equal(resp.headers.get('access-control-allow-credentials'), null);
    assert.equal(received instanceof Request, true);
  } finally {
    globalThis.fetch = original;
  }
});

// --- non-OPTIONS response injection ---------------------------------------

test('GET response from origin has CORS headers stamped by the Worker', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Simulate Vercel function setting its own (older) ACAO. The Worker
      // should override with the canonical Worker-computed value so there's
      // ONE source of truth.
      'Access-Control-Allow-Origin': 'https://stale-origin.example.com',
    },
  });
  try {
    const req = makeRequest('GET', 'https://api.worldmonitor.app/api/health', {
      Origin: KNOWN_GOOD,
    });
    const resp = await worker.fetch(req);
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('access-control-allow-origin'), KNOWN_GOOD);
    assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(resp.headers.get('access-control-expose-headers'), ACEH_EXPECTED);
    assert.equal(resp.headers.get('content-type'), 'application/json');
  } finally {
    globalThis.fetch = original;
  }
});

test('GET response preserves origin cache variance when the Worker adds Origin variance', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (request, options) => {
    calls.push({ request, options });
    return new Response('<html></html>', {
      status: 200,
      headers: request.url.endsWith('/api/story')
        ? { 'Content-Type': 'text/html; charset=utf-8', Vary: 'User-Agent' }
        : { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };
  try {
    const storyReq = makeRequest('GET', 'https://api.worldmonitor.app/api/story', {
      Origin: KNOWN_GOOD,
      'User-Agent': 'Twitterbot/1.0',
    });
    const storyResp = await worker.fetch(storyReq);
    assert.equal(storyResp.status, 200);
    assert.equal(storyResp.headers.get('vary'), 'User-Agent, Origin');
    assert.deepEqual(calls[0].options, {
      cf: {
        vary: {
          default: { action: 'bypass' },
          headers: {
            'user-agent': { action: 'passthrough' },
          },
        },
      },
    });

    const healthReq = makeRequest('GET', 'https://api.worldmonitor.app/api/health', {
      Origin: KNOWN_GOOD,
    });
    await worker.fetch(healthReq);
    assert.equal(calls[1].options, undefined, 'other API routes must keep the default fetch policy');
  } finally {
    globalThis.fetch = original;
  }
});

test('GET response preserves function-specific exposed headers (bootstrap U3a regression)', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Expose-Headers': [
        'Server-Timing',
        'X-WorldMonitor-Bootstrap-Redis-Duration',
        'Age',
        'X-Vercel-Cache',
        'CF-Cache-Status',
        // A baseline name must not be duplicated when the lists are merged.
        'Retry-After',
      ].join(', '),
    },
  });
  try {
    const req = makeRequest('GET', 'https://api.worldmonitor.app/api/bootstrap?tier=slow&public=1', {
      Origin: KNOWN_GOOD,
    });
    const resp = await worker.fetch(req);
    assert.equal(
      resp.headers.get('access-control-expose-headers'),
      `${ACEH_EXPECTED}, Server-Timing, X-WorldMonitor-Bootstrap-Redis-Duration, Age, X-Vercel-Cache, CF-Cache-Status`,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('GET response does not preserve function-specific exposed headers outside bootstrap', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Expose-Headers': 'X-Internal-Diagnostic',
    },
  });
  try {
    const req = makeRequest('GET', 'https://api.worldmonitor.app/api/health', {
      Origin: KNOWN_GOOD,
    });
    const resp = await worker.fetch(req);
    assert.equal(resp.headers.get('access-control-expose-headers'), ACEH_EXPECTED);
  } finally {
    globalThis.fetch = original;
  }
});

// --- public-CORS path bypass (MCP / OAuth / discovery / public utilities) ----

test('hasPublicCorsPolicy: exact-match paths', () => {
  assert.equal(hasPublicCorsPolicy('/api/mcp'), true);
  assert.equal(hasPublicCorsPolicy('/api/oauth-protected-resource'), true);
  assert.equal(hasPublicCorsPolicy('/api/security/report'), true);
  assert.equal(hasPublicCorsPolicy('/api/geo'), true);
  assert.equal(hasPublicCorsPolicy('/api/version'), true);
  assert.equal(hasPublicCorsPolicy('/api/fwdstart'), true);
  assert.equal(hasPublicCorsPolicy('/api/gpsjam'), true);
  assert.equal(hasPublicCorsPolicy('/api/reverse-geocode'), true);
  assert.equal(hasPublicCorsPolicy('/api/product-catalog'), true);
});

test('hasPublicCorsPolicy: prefix paths for nested OAuth + MCP routes', () => {
  // OAuth flows
  assert.equal(hasPublicCorsPolicy('/api/oauth/register'), true);
  assert.equal(hasPublicCorsPolicy('/api/oauth/token'), true);
  assert.equal(hasPublicCorsPolicy('/api/oauth/authorize'), true);
  assert.equal(hasPublicCorsPolicy('/api/oauth/authorize-pro'), true);
  // MCP nested handlers
  assert.equal(hasPublicCorsPolicy('/api/mcp/handler'), true);
  assert.equal(hasPublicCorsPolicy('/api/mcp/anything'), true);
});

test('hasPublicCorsPolicy: rejects WM-app routes (so credentialed flow keeps Worker policy)', () => {
  assert.equal(hasPublicCorsPolicy('/api/health'), false);
  assert.equal(hasPublicCorsPolicy('/api/bootstrap'), false);
  assert.equal(hasPublicCorsPolicy('/api/wm-session'), false);
  assert.equal(hasPublicCorsPolicy('/api/news/v1/list-articles'), false);
  // Tricky prefix collisions that must NOT bypass:
  assert.equal(hasPublicCorsPolicy('/api/mcps'), false); // not the same as /api/mcp/
  assert.equal(hasPublicCorsPolicy('/api/oauth-anything-else'), false); // not /api/oauth/...
  assert.equal(hasPublicCorsPolicy('/api/geographic-data'), false); // not /api/geo
});

test('OPTIONS preflight to /api/mcp from https://claude.ai passes through to Vercel (Worker does NOT short-circuit)', async () => {
  // Regression: PR review caught that the Worker was short-circuiting MCP
  // preflights with the canonical worldmonitor.app fallback origin echo,
  // which blocked claude.ai / claude.com MCP clients. Pin the bypass.
  const original = globalThis.fetch;
  let received;
  globalThis.fetch = async (req) => {
    received = req;
    return new Response(null, {
      status: 204,
      headers: {
        // Simulate Vercel function returning ACAO: * (getPublicCorsHeaders).
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Key',
      },
    });
  };
  try {
    const req = makeRequest('OPTIONS', 'https://api.worldmonitor.app/api/mcp', {
      Origin: 'https://claude.ai',
      'Access-Control-Request-Method': 'POST',
    });
    const resp = await worker.fetch(req);
    assert.ok(received instanceof Request, 'request should have been forwarded to fetch()');
    assert.equal(received.url, 'https://api.worldmonitor.app/api/mcp');
    assert.equal(resp.status, 204);
    // Vercel's ACAO: * passes through unchanged (Worker did NOT stamp).
    assert.equal(resp.headers.get('access-control-allow-origin'), '*');
    // Worker did NOT inject its own ACAC: true.
    assert.equal(resp.headers.get('access-control-allow-credentials'), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('OPTIONS preflight to /api/oauth/register from https://claude.com passes through (OAuth DCR)', async () => {
  const original = globalThis.fetch;
  let received;
  globalThis.fetch = async (req) => {
    received = req;
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  };
  try {
    const req = makeRequest('OPTIONS', 'https://api.worldmonitor.app/api/oauth/register', {
      Origin: 'https://claude.com',
      'Access-Control-Request-Method': 'POST',
    });
    const resp = await worker.fetch(req);
    assert.ok(received instanceof Request);
    assert.equal(resp.headers.get('access-control-allow-origin'), '*');
    assert.equal(resp.headers.get('access-control-allow-credentials'), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('GET to /api/oauth/token from https://claude.ai passes Vercel headers through unchanged', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'fake' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Vercel function's ACAO: * MUST survive — Worker must not override.
      'Access-Control-Allow-Origin': '*',
    },
  });
  try {
    const req = makeRequest('POST', 'https://api.worldmonitor.app/api/oauth/token', {
      Origin: 'https://claude.ai',
      'Content-Type': 'application/json',
    });
    const resp = await worker.fetch(req);
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('access-control-allow-origin'), '*');
    assert.equal(resp.headers.get('access-control-allow-credentials'), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('public cacheable endpoint paths pass Vercel CORS headers through unchanged', async () => {
  // These endpoints use endpoint-owned wildcard CORS on cacheable GET
  // responses. If the Worker stamps its credentialed Origin-varying headers
  // here, Cloudflare caches an origin-specific contract and breaks the
  // endpoint policy. Pin every path because this Worker is the final CORS
  // layer before the browser.
  const paths = [
    '/api/fwdstart',
    '/api/gpsjam',
    '/api/reverse-geocode',
    '/api/product-catalog',
  ];
  const original = globalThis.fetch;
  const received = [];
  globalThis.fetch = async (request) => {
    received.push(request);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60, s-maxage=300',
        'X-Origin-Cors-Contract': 'endpoint-owned',
      },
    });
  };
  try {
    for (const pathname of paths) {
      const resp = await worker.fetch(makeRequest('GET', `https://api.worldmonitor.app${pathname}`, {
        Origin: KNOWN_GOOD,
      }));
      assert.equal(resp.status, 200, `${pathname} should pass through Vercel's response`);
      assert.equal(resp.headers.get('access-control-allow-origin'), '*', `${pathname} must preserve ACAO: *`);
      assert.equal(resp.headers.get('access-control-allow-credentials'), null, `${pathname} must not receive Worker credentials CORS`);
      assert.equal(resp.headers.get('cache-control'), 'public, max-age=60, s-maxage=300', `${pathname} must preserve cache policy`);
      assert.equal(resp.headers.get('x-origin-cors-contract'), 'endpoint-owned', `${pathname} must preserve origin response headers`);
    }
    assert.deepEqual(received.map((request) => new URL(request.url).pathname), paths);
  } finally {
    globalThis.fetch = original;
  }
});

// --- end public-CORS bypass tests ---------------------------------------------

test('502 fallback when origin throws still includes CORS headers', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('origin down'); };
  try {
    const req = makeRequest('GET', 'https://api.worldmonitor.app/api/health', {
      Origin: KNOWN_GOOD,
    });
    const resp = await worker.fetch(req);
    assert.equal(resp.status, 502);
    assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(resp.headers.get('access-control-allow-origin'), KNOWN_GOOD);
    const body = await resp.json();
    assert.equal(body.error, 'Origin unavailable');
  } finally {
    globalThis.fetch = original;
  }
});

// --- public bootstrap tier shape (#7308) ----------------------------------
//
// `/api/bootstrap?tier=<fast|slow>&public=1` is the one Worker-owned route
// whose Vercel handler deliberately answers with the PUBLIC shape
// (api/bootstrap.js#getPublicBootstrapHeaders: ACAO:*, no Allow-Credentials,
// no Vary: Origin) so a single entry can answer every caller. Stamping the
// Worker's credentialed bag over it re-keyed the response by Origin and put
// Allow-Credentials: true on an unauthenticated payload that also carries
// Timing-Allow-Origin: *.

const PUBLIC_TIER_URL = 'https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1';

// The origin's real public-tier response shape, so these tests prove what the
// Worker does to it rather than what a thin mock happened to omit. `Allow-
// Credentials: true` is NOT something api/bootstrap.js sends on this URL — it is
// here to exercise the Worker's delete branch, which must clear a credentials
// header even if the origin ever supplied one, since ACAO `*` alongside it is
// the pairing browsers reject outright.
const PUBLIC_TIER_ORIGIN_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  'Cache-Control': 'no-store',
  'CDN-Cache-Control': 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
  'Timing-Allow-Origin': '*',
  Vary: 'accept-encoding',
};

test('public bootstrap tier pass-through keeps the origin public shape, not the credentialed bag', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"data":{},"missing":[]}', {
    status: 200,
    headers: PUBLIC_TIER_ORIGIN_HEADERS,
  });
  try {
    const resp = await worker.fetch(makeRequest('GET', PUBLIC_TIER_URL, { Origin: KNOWN_GOOD }));
    assertPublicBootstrapCorsHeaders({ assert, resp, label: 'tier pass-through' });
    // The origin's shared-cache declaration is the only CDN lifetime this path
    // has; the Worker must not drop it while rewriting CORS.
    assert.equal(
      resp.headers.get('cdn-cache-control'),
      'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
    );
    assert.equal(resp.headers.get('vary'), 'accept-encoding');
    assert.equal(resp.headers.get('access-control-allow-headers'), ACAH_EXPECTED);
    assert.equal(resp.headers.get('access-control-expose-headers'), ACEH_EXPECTED);
  } finally {
    globalThis.fetch = original;
  }
});

test('public bootstrap tier pass-through with no Origin header is still the public shape', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"data":{},"missing":[]}', {
    status: 200,
    headers: { 'Timing-Allow-Origin': '*' },
  });
  try {
    const resp = await worker.fetch(makeRequest('GET', PUBLIC_TIER_URL));
    assertPublicBootstrapCorsHeaders({ assert, resp, label: 'no-Origin tier pass-through' });
    // Merging an absent origin Vary with an absent Worker Vary must leave the
    // header off entirely, not set it to the empty string.
    assert.equal(resp.headers.get('vary'), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('a 502 on the public tier URL still carries the public shape', async () => {
  // passThroughToOrigin's catch takes the non-function branch of its ternary
  // whenever corsPolicy is the fixed public bag — the branch a real upstream
  // outage on this URL would hit, and the one no other 502 test reaches.
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('origin down'); };
  try {
    const resp = await worker.fetch(makeRequest('GET', PUBLIC_TIER_URL, { Origin: KNOWN_GOOD }));
    assert.equal(resp.status, 502);
    assert.equal(resp.headers.get('access-control-allow-origin'), '*');
    assert.equal(resp.headers.get('access-control-allow-credentials'), null);
    assert.equal(await resp.json().then((body) => body.error), 'Origin unavailable');
  } finally {
    globalThis.fetch = original;
  }
});

test('a disallowed Origin on the public tier URL keeps the credentialed fallback echo', async () => {
  // api/bootstrap.js rejects a disallowed Origin with 403 before it reads any
  // payload. Handing that caller ACAO:* would make the seed bundle readable by
  // a page the origin refuses, so the Worker must not widen it here.
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('Forbidden', { status: 403 });
  try {
    const resp = await worker.fetch(makeRequest('GET', PUBLIC_TIER_URL, { Origin: 'https://evil.example' }));
    assert.equal(resp.status, 403);
    assert.equal(resp.headers.get('access-control-allow-origin'), 'https://evil.example');
    assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
    assert.match(resp.headers.get('vary') || '', /Origin/i);
  } finally {
    globalThis.fetch = original;
  }
});

test('the public tier preflight carries the public shape, matching its own GET', async () => {
  // A split contract — Allow-Credentials: true on the preflight clearing a
  // response that answers ACAO:* with no credentials — is the same mismatch
  // #7308 fixed one layer down, and the pairing browsers reject.
  const resp = await worker.fetch(makeRequest('OPTIONS', PUBLIC_TIER_URL, {
    Origin: KNOWN_GOOD,
    'Access-Control-Request-Method': 'GET',
  }));
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('access-control-allow-origin'), '*');
  assert.equal(resp.headers.get('access-control-allow-credentials'), null);
  assert.equal(resp.headers.get('vary'), null);
});

test('a preflight declaring a non-GET method on the public tier URL stays credentialed', async () => {
  // Only the GET is the public contract; anything else would be answered by the
  // credentialed handler, so its preflight must advertise that shape.
  const resp = await worker.fetch(makeRequest('OPTIONS', PUBLIC_TIER_URL, {
    Origin: KNOWN_GOOD,
    'Access-Control-Request-Method': 'POST',
  }));
  assert.equal(resp.headers.get('access-control-allow-origin'), KNOWN_GOOD);
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
});

test('a disallowed Origin preflighting the public tier URL keeps the readable echo (#6411)', async () => {
  // The echo is what lets the browser send the actual request and observe the
  // origin's 403 instead of an opaque network error.
  const resp = await worker.fetch(makeRequest('OPTIONS', PUBLIC_TIER_URL, {
    Origin: 'https://evil.example',
    'Access-Control-Request-Method': 'GET',
  }));
  assert.equal(resp.headers.get('access-control-allow-origin'), 'https://evil.example');
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
});

test('the credentialed bootstrap URL (no public=1) keeps the Origin-echoing shape', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"data":{},"missing":[]}', { status: 200 });
  try {
    const resp = await worker.fetch(
      makeRequest('GET', 'https://api.worldmonitor.app/api/bootstrap?tier=fast', { Origin: KNOWN_GOOD }),
    );
    assert.equal(resp.headers.get('access-control-allow-origin'), KNOWN_GOOD);
    assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
    assert.match(resp.headers.get('vary') || '', /Origin/i);
  } finally {
    globalThis.fetch = original;
  }
});

const PUBLIC_SINGLE_KEY_URLS = [
  ['weather', 'https://api.worldmonitor.app/api/bootstrap?keys=weatherAlerts&public=1'],
  ['on-demand', 'https://api.worldmonitor.app/api/bootstrap?keys=forecasts&public=1'],
];

for (const [label, url] of PUBLIC_SINGLE_KEY_URLS) {
  test(`marked ${label} bootstrap pass-through keeps the public shape`, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"data":{},"missing":[]}', {
      status: 200,
      headers: {
        'Cache-Control': 'max-age=300',
        'CDN-Cache-Control': 'public, s-maxage=600',
        'Timing-Allow-Origin': '*',
      },
    });
    try {
      const resp = await worker.fetch(makeRequest('GET', url, { Origin: KNOWN_GOOD }));
      assertPublicBootstrapCorsHeaders({ assert, resp, label: `${label} pass-through` });
      assert.equal(resp.headers.get('cdn-cache-control'), 'public, s-maxage=600');
    } finally {
      globalThis.fetch = original;
    }
  });

  test(`marked ${label} bootstrap preflight matches its GET`, async () => {
    const resp = await worker.fetch(makeRequest('OPTIONS', url, {
      Origin: KNOWN_GOOD,
      'Access-Control-Request-Method': 'GET',
    }));
    assert.equal(resp.status, 204);
    assert.equal(resp.headers.get('access-control-allow-origin'), '*');
    assert.equal(resp.headers.get('access-control-allow-credentials'), null);
    assert.equal(resp.headers.get('vary'), null);
  });
}

test('a marked non-public bootstrap key keeps the credentialed shape', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"Invalid API key"}', { status: 401 });
  try {
    const resp = await worker.fetch(makeRequest(
      'GET',
      'https://api.worldmonitor.app/api/bootstrap?keys=marketQuotes&public=1',
      { Origin: KNOWN_GOOD },
    ));
    assert.equal(resp.status, 401);
    assert.equal(resp.headers.get('access-control-allow-origin'), KNOWN_GOOD);
    assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
    assert.match(resp.headers.get('vary') || '', /Origin/i);
  } finally {
    globalThis.fetch = original;
  }
});
