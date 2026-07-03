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
  assert.notEqual(cfCacheStatus(resp).toUpperCase(), 'HIT', `${name}: fake auth response must not be a Cloudflare HIT`);
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
  });

  it('bootstrap rejects fake auth as dynamic no-store while anonymous weather stays cacheable', async () => {
    const fake = await fetchText(`${API_BASE}/api/bootstrap?keys=weatherAlerts`, {
      headers: { 'X-WorldMonitor-Key': FAKE_WM_KEY },
    });
    assert.equal(fake.resp.status, 401);
    assertNoStore(fake.resp, 'bootstrap fake auth');
    assertNotCached200(fake.resp, 'bootstrap fake auth');
    assertNoSentinelLeak(fake.bodyText, 'bootstrap fake auth');

    const anon = await fetchText(`${API_BASE}/api/bootstrap?keys=weatherAlerts`);
    assertPublicCacheable(anon.resp, 'bootstrap anonymous weather');
    assert.match(anon.bodyText, /"data"\s*:/, 'bootstrap anonymous weather: expected data envelope');
  });

  it('generated RPCs reject fake auth as dynamic no-store while public no-auth RPCs stay cacheable', async () => {
    const fake = await fetchText(`${API_BASE}/api/market/v1/list-market-quotes?symbols=AAPL`, {
      headers: { 'X-WorldMonitor-Key': FAKE_WM_KEY },
    });
    assert.equal(fake.resp.status, 401);
    assertNoStore(fake.resp, 'generated RPC fake auth');
    assertNotCached200(fake.resp, 'generated RPC fake auth');
    assertNoSentinelLeak(fake.bodyText, 'generated RPC fake auth');

    const publicRpc = await fetchText(`${API_BASE}/api/conflict/v1/list-acled-events`);
    assertPublicCacheable(publicRpc.resp, 'public no-auth RPC');
    assert.match(publicRpc.bodyText, /"events"\s*:/, 'public no-auth RPC: expected events payload');
  });

  it('premium RPC fake auth fails closed without shared cache headers', async () => {
    const fake = await fetchText(`${API_BASE}/api/market/v1/analyze-stock?symbol=AAPL`, {
      headers: { 'X-WorldMonitor-Key': FAKE_WM_KEY },
    });
    assert.equal(fake.resp.status, 401);
    assertNoStore(fake.resp, 'premium RPC fake auth');
    assertNotCached200(fake.resp, 'premium RPC fake auth');
    assertNoSentinelLeak(fake.bodyText, 'premium RPC fake auth');
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
  });

  // The #4497 incident class is a CACHED 200 of private/authenticated data — the
  // negative (401) cases above cannot catch it. With a real MCP-authorized key
  // (WM_LIVE_TEST_KEY, never committed), assert an authenticated 200 MCP response
  // is no-store and not served from a shared-cache HIT. Skipped unless the key is set.
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
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'worldmonitor-live-sweep', version: '1.0' },
        },
      }),
    });
    assert.equal(post.resp.status, 200, 'authenticated MCP initialize should succeed (WM_LIVE_TEST_KEY must be a valid MCP-authorized key)');
    assertNoStore(post.resp, 'authenticated MCP 200');
    assert.notEqual(cfCacheStatus(post.resp).toUpperCase(), 'HIT', 'authenticated MCP 200 must not be a shared-cache HIT');
  });
});
