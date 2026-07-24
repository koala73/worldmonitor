/**
 * Live API cache/auth regression sweep for issue #4497.
 *
 * This intentionally probes production cache/auth behavior and is skipped unless
 * LIVE_API_CACHE_TESTS=1 is set. It validates the Cloudflare/Vercel rule
 * assumptions from the 2026-06-28 incident follow-up:
 *   - fake auth must never receive a cached 200
 *   - auth errors must be no-store and dynamic
 *   - anonymous public surfaces remain cacheable
 *   - MCP auth/protocol surfaces remain functional and no-store
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

const LIVE = process.env.LIVE_API_CACHE_TESTS === '1';
const API_BASE = stripTrailingSlash(process.env.WM_LIVE_API_BASE_URL || 'https://api.worldmonitor.app');
const WEB_BASE = stripTrailingSlash(process.env.WM_LIVE_WEB_BASE_URL || 'https://worldmonitor.app');
const FAKE_WM_KEY = 'wm_0000000000000000000000000000000000000000';

/**
 * Append a unique cache-buster to a fake-auth probe URL.
 *
 * The fake-auth assertions below are about ORIGIN auth logic ("an invalid key
 * must be rejected no-store"), but they target URLs the edge caches publicly for
 * 600s, and the cache key does NOT include X-WorldMonitor-Key (`vary: Origin`
 * only). So a request bearing an invalid key is served whatever anonymous
 * response is already cached for that URL — verified against production:
 *
 *   cache-busted URL + fake key -> x-vercel-cache: MISS -> 401, no-store   (correct)
 *   already-cached URL + fake key -> x-vercel-cache: HIT  -> 200, public    (cached anon)
 *
 * Without busting, these assertions are order-dependent on CDN state that
 * ordinary traffic controls — including this suite's OWN anonymous probe of the
 * same URL a few lines later. On a 6-hourly schedule that means intermittent
 * reds no PR can fix, which is how a guard earns its way into being ignored.
 *
 * Busting makes the auth assertion deterministic and keeps it testing the thing
 * it names. The cached-anonymous behavior is a separate property, pinned
 * explicitly by its own test below rather than left as a flaky side effect.
 */
let _bust = 0;
function bust(url) {
  _bust += 1;
  return `${url}${url.includes('?') ? '&' : '?'}__cb=${Date.now()}-${_bust}`;
}
const USER_AGENT = 'WorldMonitor-Live-Cache-Auth-Sweep/1.0';
const LIVE_API_CACHE_TIMEOUT_MS = positiveIntegerFromEnv(process.env.LIVE_API_CACHE_TIMEOUT_MS, 15_000);

function positiveIntegerFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function cacheControl(resp) {
  return resp.headers.get('cache-control') || '';
}

function cfCacheStatus(resp) {
  return resp.headers.get('cf-cache-status') || '';
}

function vercelCacheStatus(resp) {
  return resp.headers.get('x-vercel-cache') || '';
}

function isSharedCacheHit(resp) {
  return cfCacheStatus(resp).toUpperCase() === 'HIT' || vercelCacheStatus(resp).toUpperCase() === 'HIT';
}

function markProbeCompleted(name) {
  console.info(`LIVE_SWEEP_PROBE_COMPLETED ${name}`);
}

function assertNoStore(resp, name) {
  assert.match(cacheControl(resp), /\bno-store\b/i, `${name}: Cache-Control must include no-store`);
  const cdnCacheControl = resp.headers.get('cdn-cache-control') || '';
  if (cdnCacheControl) {
    assert.match(cdnCacheControl, /\bno-store\b/i, `${name}: CDN-Cache-Control must be absent or no-store`);
    assert.doesNotMatch(cdnCacheControl, /\bpublic\b|\bs-maxage\b/i, `${name}: CDN-Cache-Control must not be shared-cacheable`);
  }
}

function assertNoSentinelLeak(bodyText, name) {
  assert.doesNotMatch(bodyText, /gateway validation|Convex|keyHash/i, `${name}: leaked internal auth sentinel/detail`);
}

function assertNotCached200(resp, name) {
  // The HTTP status is asserted explicitly at each call site (401); the only
  // meaningful guard here is that the rejection was not served from a shared
  // cache HIT (the #4497 failure mode).
  assert.equal(isSharedCacheHit(resp), false, `${name}: fake auth response must not be a shared-cache HIT`);
}

function assertPublicCacheable(resp, name) {
  assert.equal(resp.status, 200, `${name}: anonymous public request should succeed`);
  assert.match(cacheControl(resp), /\bpublic\b/i, `${name}: anonymous public request should remain public-cacheable`);
}

async function fetchText(pathOrUrl, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('User-Agent', USER_AGENT);
  const timeoutSignal = AbortSignal.timeout(LIVE_API_CACHE_TIMEOUT_MS);
  const signal = init.signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([init.signal, timeoutSignal])
    : init.signal || timeoutSignal;
  const resp = await fetch(pathOrUrl, { ...init, headers, signal });
  const bodyText = await resp.text();
  return { resp, bodyText };
}

async function waitForSharedCacheHit(url, name) {
  const attempts = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = await fetchText(url);
    assertPublicCacheable(result.resp, name);
    attempts.push(`cf=${cfCacheStatus(result.resp) || '-'},vercel=${vercelCacheStatus(result.resp) || '-'}`);
    if (isSharedCacheHit(result.resp)) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${name}: URL never became a confirmed shared-cache HIT (${attempts.join('; ')})`);
}

describe(`live API cache/auth regression sweep (${LIVE ? 'ENABLED' : 'SKIPPED - set LIVE_API_CACHE_TESTS=1'})`, { skip: !LIVE }, () => {
  it('documents the Cloudflare rule assumptions being validated', () => {
    console.info([
      'Cloudflare/API cache assumptions under test:',
      'fake-auth responses are dynamic no-store and never cached 200s;',
      'anonymous public REST/RPC responses remain public-cacheable;',
      'MCP auth/protocol responses are no-store;',
      'OAuth metadata remains discoverable and cacheable.',
    ].join(' '));
    assert.equal(LIVE, true);
    // Mutation guard: reverting assertNotCached200 to inspect only
    // CF-Cache-Status must make this fail. Production commonly exposes a
    // Vercel HIT without a Cloudflare HIT on this path.
    assert.throws(
      () => assertNotCached200(
        new Response(null, { headers: { 'x-vercel-cache': 'HIT' } }),
        'synthetic Vercel cache hit',
      ),
      /shared-cache HIT/,
    );
  });

  it('bootstrap rejects fake auth as dynamic no-store while anonymous weather stays cacheable', async () => {
    const fake = await fetchText(bust(`${API_BASE}/api/bootstrap?keys=weatherAlerts`), {
      headers: { 'X-WorldMonitor-Key': FAKE_WM_KEY },
    });
    assert.equal(fake.resp.status, 401);
    assertNoStore(fake.resp, 'bootstrap fake auth');
    assertNotCached200(fake.resp, 'bootstrap fake auth');
    assertNoSentinelLeak(fake.bodyText, 'bootstrap fake auth');

    const anon = await fetchText(`${API_BASE}/api/bootstrap?keys=weatherAlerts`);
    assertPublicCacheable(anon.resp, 'bootstrap anonymous weather');
    assert.match(anon.bodyText, /"data"\s*:/, 'bootstrap anonymous weather: expected data envelope');
    markProbeCompleted('bootstrap-auth');
  });

  it('PINNED: an invalid key on a publicly-cached URL is served the cached anonymous 200, not a 401', async () => {
    // Documents real production behavior discovered while wiring this suite into
    // CI (#5379). The edge cache key does not include X-WorldMonitor-Key
    // (`vary: Origin` only), so once a public URL is warm, a request carrying an
    // INVALID key is served the cached anonymous response instead of the origin's
    // 401. Confirmed by the contrast with the cache-busted probe above, which
    // gets MISS -> 401 on the very same URL and key.
    //
    // Impact today is bounded: the cached body is the anonymous public payload,
    // so invalid credentials are silently downgraded to anonymous rather than
    // leaking anything private — and genuinely gated keys still fail closed (see
    // the premium RPC test below, which 401s regardless of cache state).
    //
    // Pinned rather than asserted-away because the SHAPE is the #4497 hazard this
    // whole suite exists to watch: if an authenticated 200 ever became cacheable,
    // this same cache-key blindness would serve private data publicly. If this
    // test starts failing because the URL now 401s, the cache key gained the auth
    // header — that is an improvement; update this test deliberately.
    // Tracked separately for a product decision; not fixed here.
    const warm = `${API_BASE}/api/bootstrap?keys=weatherAlerts`;
    await waitForSharedCacheHit(warm, 'bootstrap anonymous warm-up');
    const withBadKey = await fetchText(warm, {
      headers: { 'X-WorldMonitor-Key': FAKE_WM_KEY },
    });

    if (withBadKey.resp.status === 401) {
      assertNoStore(withBadKey.resp, 'invalid key on warm URL (now failing closed)');
      markProbeCompleted('warm-cache');
      return; // cache key now includes the auth header — strictly better.
    }

    assert.equal(withBadKey.resp.status, 200, 'expected either a 401 or the cached anonymous 200');
    assert.match(
      cacheControl(withBadKey.resp), /\bpublic\b/i,
      'the served response should be the public cached one, not a private authenticated payload',
    );
    assertNoSentinelLeak(withBadKey.bodyText, 'invalid key served from cache');
    // The load-bearing assertion: whatever is served must be the ANONYMOUS
    // payload shape. A divergence here would mean private data sitting in a
    // public cache entry — the actual #4497 incident.
    //
    // Asserted STRUCTURALLY, not by byte-length against a second fetch: this is
    // live weather data that changes between requests, and different edge nodes
    // hold differently-sized cache entries (observed 61512 vs 61287 for the same
    // logical response). A size comparison here fails for reasons that have
    // nothing to do with auth — the exact flakiness this test was added to remove.
    const body = JSON.parse(withBadKey.bodyText);
    assert.deepEqual(
      Object.keys(body).sort(), ['data', 'missing'],
      'invalid-key response must be the public bootstrap envelope, nothing more',
    );
    assert.deepEqual(
      Object.keys(body.data ?? {}), ['weatherAlerts'],
      'invalid-key response must carry ONLY the public key that was requested — any additional ' +
        'key would mean an entitled payload is sitting in a public cache entry (#4497)',
    );
    markProbeCompleted('warm-cache');
  });

  it('generated RPCs reject fake auth as dynamic no-store while public no-auth RPCs stay cacheable', async () => {
    const fake = await fetchText(bust(`${API_BASE}/api/market/v1/list-market-quotes?symbols=AAPL`), {
      headers: { 'X-WorldMonitor-Key': FAKE_WM_KEY },
    });
    assert.equal(fake.resp.status, 401);
    assertNoStore(fake.resp, 'generated RPC fake auth');
    assertNotCached200(fake.resp, 'generated RPC fake auth');
    assertNoSentinelLeak(fake.bodyText, 'generated RPC fake auth');

    const publicRpc = await fetchText(`${API_BASE}/api/conflict/v1/list-acled-events`);
    assertPublicCacheable(publicRpc.resp, 'public no-auth RPC');
    assert.match(publicRpc.bodyText, /"events"\s*:/, 'public no-auth RPC: expected events payload');
    markProbeCompleted('generated-rpc');
  });

  it('premium RPC fake auth fails closed without shared cache headers', async () => {
    const fake = await fetchText(bust(`${API_BASE}/api/market/v1/analyze-stock?symbol=AAPL`), {
      headers: { 'X-WorldMonitor-Key': FAKE_WM_KEY },
    });
    assert.equal(fake.resp.status, 401);
    assertNoStore(fake.resp, 'premium RPC fake auth');
    assertNotCached200(fake.resp, 'premium RPC fake auth');
    assertNoSentinelLeak(fake.bodyText, 'premium RPC fake auth');
    markProbeCompleted('premium-rpc');
  });

  it('MCP OPTIONS, public discovery, and gated data method are protocol-valid no-store responses', async () => {
    const options = await fetchText(`${WEB_BASE}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://claude.ai',
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.equal(options.resp.status, 204);
    assert.match(options.resp.headers.get('access-control-allow-methods') || '', /\bPOST\b/);
    assertNoStore(options.resp, 'MCP OPTIONS');

    // A bare GET (no Last-Event-ID) is a client opening the OPTIONAL standalone
    // server->client SSE stream. This stateless route offers none, so the MCP
    // Streamable HTTP spec requires 405 (SDK clients treat it as the graceful
    // "no standalone stream" signal). Returning 401 here surfaces to a strict
    // client as `Failed to open SSE stream: Unauthorized` and is scored as a
    // failed protocol handshake by agent-readiness scanners.
    const bareGet = await fetchText(`${WEB_BASE}/mcp`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    });
    assert.equal(bareGet.resp.status, 405, 'unauthenticated standalone SSE-stream open must be 405, never 401');
    assert.match(bareGet.resp.headers.get('allow') || '', /\bPOST\b/, '405 must advertise Allow (RFC 9110 §15.5.6)');

    // Discovery is public: unauthenticated `initialize` succeeds (200) and must
    // still be no-store (the #4497 cached-200 hazard applies to any 200).
    const discover = await fetchText(`${WEB_BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'worldmonitor-live-sweep', version: '1.0' },
        },
      }),
    });
    assert.equal(discover.resp.status, 200, 'unauthenticated initialize is public discovery');
    assertNoStore(discover.resp, 'MCP anonymous initialize');
    assert.notEqual(cfCacheStatus(discover.resp).toUpperCase(), 'HIT', 'anonymous discovery 200 must not be a shared-cache HIT');

    // resources/list is catalog-enumeration discovery (like tools/list): the
    // `initialize` handshake advertises the `resources` capability, so an
    // unauthenticated resources/list MUST return the catalog (orank's
    // mcp-resource-listing check), not a 401.
    const resourceList = await fetchText(`${WEB_BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} }),
    });
    assert.equal(resourceList.resp.status, 200, 'unauthenticated resources/list is public discovery');
    assertNoStore(resourceList.resp, 'MCP anonymous resources/list');
    const resourceBody = JSON.parse(resourceList.bodyText);
    assert.ok(
      Array.isArray(resourceBody.result?.resources) && resourceBody.result.resources.length >= 1,
      'anonymous resources/list must enumerate a non-empty resource catalog',
    );

    // orank mcp-resource-quality: EVERY resources/list entry must resources/read
    // cleanly for an anonymous caller. The catalog is now all concrete,
    // metadata-only resources, so an anonymous resources/read of each must
    // return a non-empty application/json content payload — not a 401.
    for (const resource of resourceBody.result.resources) {
      const read = await fetchText(`${WEB_BASE}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: resource.uri } }),
      });
      assert.equal(read.resp.status, 200,
        `anonymous resources/read ${resource.uri} must be public (orank mcp-resource-quality)`);
      assertNoStore(read.resp, `MCP anonymous resources/read ${resource.uri}`);
      const readBody = JSON.parse(read.bodyText);
      assert.equal(readBody.error, undefined,
        `anonymous resources/read ${resource.uri} must not error: ${JSON.stringify(readBody.error)}`);
      const content = readBody.result?.contents?.[0];
      // `ui://` entries are MCP-Apps app shells, not metadata: production
      // declares them `text/html;profile=mcp-app` (api/mcp/ui/shell.ts
      // UI_RESOURCE_MIME_TYPE). Same rule as the in-process sibling check in
      // tests/mcp-resources.test.mjs. Still an exact-match assertion per URI
      // scheme — a resource declaring the WRONG one of the two still fails.
      const isUiShell = resource.uri.startsWith('ui://');
      const expectedMime = isUiShell ? 'text/html;profile=mcp-app' : 'application/json';
      assert.equal(content?.mimeType, expectedMime,
        `resources/read ${resource.uri} must declare a valid mimeType`);
      assert.ok(typeof content?.text === 'string' && content.text.length > 0,
        `resources/read ${resource.uri} must return non-empty content`);
      // Content must actually parse as what it declares.
      if (isUiShell) {
        assert.match(content.text, /^\s*<!doctype html/i,
          `resources/read ${resource.uri} declares HTML but did not return an HTML document`);
      } else {
        JSON.parse(content.text); // valid JSON for the declared mimeType
      }
    }

    // A DATA/quota method stays gated: unauthenticated `tools/call` must be a
    // no-store, dynamic 401 carrying the OAuth resource_metadata hint.
    const post = await fetchText(`${WEB_BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_market_data', arguments: {} },
      }),
    });
    assert.equal(post.resp.status, 401);
    assert.match(post.resp.headers.get('www-authenticate') || '', /resource_metadata=/);
    assertNoStore(post.resp, 'MCP unauthenticated data method');

    const body = JSON.parse(post.bodyText);
    assert.equal(body.error?.code, -32001);
    markProbeCompleted('mcp-protocol');
  });

  it('OAuth metadata remains discoverable and cacheable', async () => {
    const protectedResource = await fetchText(`${WEB_BASE}/.well-known/oauth-protected-resource`);
    assertPublicCacheable(protectedResource.resp, 'OAuth protected-resource metadata');
    const resourceBody = JSON.parse(protectedResource.bodyText);
    assert.equal(resourceBody.resource, WEB_BASE);
    assert.ok(Array.isArray(resourceBody.authorization_servers));

    const authServer = await fetchText(`${API_BASE}/.well-known/oauth-authorization-server`);
    assertPublicCacheable(authServer.resp, 'OAuth authorization-server metadata');
    const authBody = JSON.parse(authServer.bodyText);
    assert.equal(authBody.issuer, API_BASE);
    assert.equal(authBody.token_endpoint, `${API_BASE}/oauth/token`);
    markProbeCompleted('oauth-metadata');
  });

  // The #4497 incident class is a CACHED 200 of private/authenticated data — the
  // negative (401) cases above cannot catch it. With a real MCP-authorized key
  // (WM_LIVE_TEST_KEY, never committed), execute a gated data tool and assert
  // the authenticated 200 is no-store and not served from a shared-cache HIT.
  // Public discovery cannot prove that the credential or entitlement works.
  // Skipped unless the key is set.
  it('authenticated MCP 200 is no-store and never a shared-cache HIT', { skip: !process.env.WM_LIVE_TEST_KEY }, async () => {
    const post = await fetchText(`${WEB_BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-WorldMonitor-Key': process.env.WM_LIVE_TEST_KEY,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_market_data', arguments: { symbols: ['AAPL'] } },
      }),
    });
    assert.equal(post.resp.status, 200, 'authenticated MCP data call should succeed (WM_LIVE_TEST_KEY must be a valid MCP-authorized key)');
    assertNoStore(post.resp, 'authenticated MCP 200');
    assert.equal(isSharedCacheHit(post.resp), false, 'authenticated MCP 200 must not be a shared-cache HIT');

    const body = JSON.parse(post.bodyText);
    assert.equal(body.error, undefined, `authenticated MCP data call must not return a JSON-RPC error: ${JSON.stringify(body.error)}`);
    assert.ok(
      Array.isArray(body.result?.content) && typeof body.result.content[0]?.text === 'string',
      'authenticated MCP data call must return a tool content payload',
    );
    const payload = JSON.parse(body.result.content[0].text);
    assert.ok(payload && typeof payload === 'object' && 'data' in payload,
      'authenticated MCP data call must return the market-data cache envelope');
  });
});
