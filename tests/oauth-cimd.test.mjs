/**
 * Client ID Metadata Documents (CIMD) on the MCP OAuth server (#9244).
 *
 * A CIMD client_id is an HTTPS URL; the authorization server fetches the JSON
 * document there instead of looking up a DCR registration. These tests drive
 * the real routes (authorize GET/POST, authorize-pro, the Pro grant mint and
 * context, token code exchange and refresh) with documents captured from each
 * vendor's live URL on 2026-10-17 (tests/fixtures/oauth-cimd/live-documents.json),
 * served through a stubbed fetch so no test reaches the network.
 */

import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/oauth-cimd/live-documents.json', import.meta.url), 'utf8'));
const LIVE_DOCS = FIXTURE.documents;

// A per-connector Vercel Connect document. Unlike the exact listed URLs it has
// no vetted snapshot, so its vendor outages reach the caller as retryable.
const CONNECTOR = 'https://connect.vercel.com/connectors/conn_test';
const CONNECTOR_CALLBACK = 'https://connect.vercel.com/callback';
const CONNECTOR_DOC = {
  content_type: 'application/json',
  cache_control: 'no-store',
  body: { client_id: CONNECTOR, client_name: 'WorldMonitor (Vercel Connect)', redirect_uris: [CONNECTOR_CALLBACK], token_endpoint_auth_method: 'none' },
};

const REDIS_URL = 'https://redis.test';
const ENTERPRISE_KEY = 'enterprise-test-key';
const CODE_VERIFIER = 'v'.repeat(64);
const CODE_CHALLENGE = crypto.createHash('sha256').update(CODE_VERIFIER).digest('base64url');

const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'WORLDMONITOR_VALID_KEYS', 'CONVEX_SITE_URL', 'CONVEX_SERVER_SHARED_SECRET'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;

// Vendor documents served by URL. Tests replace entries to simulate a vendor.
let vendor;
let vendorFetches;
let store;

function docResponse(entry) {
  return new Response(JSON.stringify(entry.body), {
    status: 200,
    headers: { 'Content-Type': entry.content_type ?? 'application/json', ...(entry.cache_control ? { 'Cache-Control': entry.cache_control } : {}) },
  });
}

async function vendorFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  vendorFetches.push({ url, init });
  const entry = vendor.get(url);
  if (!entry) return new Response('not found', { status: 404 });
  if (typeof entry === 'function') return entry(init);
  return docResponse(entry);
}

function parseStored(v) {
  if (v === undefined || v === null) return null;
  try { return JSON.parse(v); } catch { return null; }
}

function installFetch() {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== REDIS_URL) return vendorFetch(input, init);
    const [, op, rawKey] = url.pathname.split('/');
    const reply = (result) => new Response(JSON.stringify({ result }), { status: 200 });
    if (op === 'get') return reply(store.get(decodeURIComponent(rawKey)) ?? null);
    if (op === 'getdel') {
      const key = decodeURIComponent(rawKey);
      const value = store.get(key) ?? null;
      store.delete(key);
      return reply(value);
    }
    const body = JSON.parse(init.body);
    const pipeline = Array.isArray(body[0]);
    const results = (pipeline ? body : [body]).map(([cmd, key, value]) => {
      if (['eval', 'evalsha'].includes(String(cmd).toLowerCase())) return { result: [9, 10] };
      if (String(cmd).toUpperCase() === 'SET') { store.set(key, value); return { result: 'OK' }; }
      return { result: 1 };
    });
    return Response.json(pipeline ? results : results[0]);
  };
}

before(() => {
  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;
  process.env.CONVEX_SITE_URL = 'https://fake.convex.site';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'fake-secret';
});

beforeEach(() => {
  store = new Map();
  vendorFetches = [];
  vendor = new Map([...Object.entries(LIVE_DOCS), [CONNECTOR, CONNECTOR_DOC]]);
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { default: authorizeHandler } = await import('../api/oauth/authorize.js');
const { tokenHandler, __setOAuthTokenRatelimitForTest, __resetOAuthTokenRateLimitForTest } = await import('../api/oauth/token.ts');
const { authorizeProHandler } = await import('../api/oauth/authorize-pro.ts');
const { mintGrantHandler } = await import('../api/internal/mcp-grant-mint.ts');
const { grantContextHandler } = await import('../api/internal/mcp-grant-context.ts');
const { signGrant, verifyGrant } = await import('../api/_mcp-grant-hmac.ts');
const {
  resolveOAuthClient,
  clientAllowsRedirectUri,
  clientMetadataCacheTtl,
  isClientMetadataDocumentId,
} = await import('../api/oauth/_client-metadata.js');
const { isAllowedRedirectUri } = await import('../api/oauth/_redirect-uri.js');
const { CLIENT_METADATA_SNAPSHOTS } = await import('../api/oauth/_client-metadata-snapshots.js');

// ---------------------------------------------------------------------------
// Flow helpers
// ---------------------------------------------------------------------------

// The callback a client would use: its first https redirect, else its first
// loopback one with a run-time port when the document omits it.
function pickRedirect(doc) {
  const https = doc.redirect_uris.find((u) => u.startsWith('https://'));
  if (https) return https;
  const u = new URL(doc.redirect_uris[0]);
  if (!u.port) u.port = '53682';
  return u.toString();
}

async function startFlow(clientId, redirectUri, host = 'api.worldmonitor.app') {
  const url = new URL(`https://${host}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st',
  }).toString();
  const res = await authorizeHandler(new Request(url, { headers: { host } }));
  const html = await res.text();
  const cookie = (res.headers.get('Set-Cookie') ?? '').split(';')[0];
  const nonceKey = [...store.keys()].find((k) => k.startsWith('oauth:nonce:'));
  return { res, html, cookie, nonce: nonceKey?.slice('oauth:nonce:'.length) };
}

function submitConsent(nonce, cookie, host = 'api.worldmonitor.app') {
  return authorizeHandler(new Request(`https://${host}/oauth/authorize`, {
    method: 'POST',
    headers: { host, origin: `https://${host}`, 'Content-Type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ api_key: ENTERPRISE_KEY, _nonce: nonce }).toString(),
  }));
}

// Token deps over the same store, mirroring the production Redis wire format.
function tokenDeps() {
  let n = 0;
  return {
    redisGetDel: async (key) => { const v = store.get(key); store.delete(key); return parseStored(v); },
    redisGet: async (key) => parseStored(store.get(key)),
    redisPipeline: async (commands) => commands.map(([cmd, key, value]) => {
      if (String(cmd).toUpperCase() === 'SET') store.set(key, value);
      return { result: 'OK' };
    }),
    redisBeginRefreshAttempt: async (refreshToken, attemptId) => {
      const refreshKey = `oauth:refresh:${refreshToken}`;
      const attemptValue = JSON.stringify({ attempt_id: attemptId });
      const refreshData = parseStored(store.get(refreshKey));
      if (!refreshData || refreshData.kind === 'refresh_attempt') {
        return { kind: 'miss', recoveryPending: store.has(`oauth:famattempt:${refreshToken}`), familyId: parseStored(store.get(`oauth:famptr:${refreshToken}`)) };
      }
      store.set(`oauth:famattempt:${refreshToken}`, attemptValue);
      store.set(refreshKey, JSON.stringify({ kind: 'refresh_attempt', attempt_id: attemptId }));
      return { kind: 'consumed', refreshData, attemptValue, expiresAtMs: null };
    },
    redisRestoreRefreshAttempt: async (refreshToken, attemptValue, refreshData, familyId) => {
      if (store.get(`oauth:famattempt:${refreshToken}`) !== attemptValue) return false;
      store.set(`oauth:refresh:${refreshToken}`, JSON.stringify(refreshData));
      if (familyId) store.set(`oauth:famptr:${refreshToken}`, JSON.stringify(familyId));
      store.delete(`oauth:famattempt:${refreshToken}`);
      return true;
    },
    redisFinalizeRefreshAttempt: async (refreshToken, attemptValue) => {
      if (store.get(`oauth:famattempt:${refreshToken}`) !== attemptValue) return false;
      store.delete(`oauth:refresh:${refreshToken}`);
      store.delete(`oauth:famattempt:${refreshToken}`);
      return true;
    },
    redisProtectFailedRefreshAttempt: async () => true,
    validateProMcpToken: async () => ({ ok: 'valid', userId: 'user_pro' }),
    randomUuid: () => `uuid_${++n}_${crypto.randomUUID()}`,
    randomPointerId: () => crypto.randomUUID(),
    captureRestoreFailure: () => {},
  };
}

function tokenRequest(params) {
  return new Request('https://api.worldmonitor.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

async function exchangeCode(code, clientId, redirectUri) {
  return tokenHandler(tokenRequest({
    grant_type: 'authorization_code', code, code_verifier: CODE_VERIFIER, client_id: clientId, redirect_uri: redirectUri,
  }), tokenDeps());
}

async function refresh(refreshToken, clientId) {
  return tokenHandler(tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }), tokenDeps());
}

beforeEach(() => __setOAuthTokenRatelimitForTest({ limit: async () => ({ success: true }) }));
afterEach(() => __resetOAuthTokenRateLimitForTest());

// ---------------------------------------------------------------------------
// Every published document completes authorize → token → refresh
// ---------------------------------------------------------------------------

describe('CIMD — each vendor document completes the API-key flow', () => {
  for (const [clientId, entry] of Object.entries(LIVE_DOCS)) {
    it(`${entry.body.client_name} (${clientId})`, async () => {
      const redirectUri = pickRedirect(entry.body);
      const flow = await startFlow(clientId, redirectUri);
      assert.equal(flow.res.status, 200, flow.html.slice(0, 400));
      assert.ok(flow.html.includes(`${entry.body.client_name} wants access`), 'consent shows the document client_name');
      assert.ok(flow.html.includes(new URL(clientId).hostname), 'consent shows the client_id host');
      assert.ok(flow.html.includes(new URL(redirectUri).hostname), 'consent shows the redirect host');

      const consent = await submitConsent(flow.nonce, flow.cookie);
      assert.equal(consent.status, 302);
      const location = new URL(consent.headers.get('Location'));
      assert.equal(`${location.origin}${location.pathname}`, `${new URL(redirectUri).origin}${new URL(redirectUri).pathname}`);
      const code = location.searchParams.get('code');
      assert.ok(code);
      assert.equal(JSON.parse(store.get(`oauth:code:${code}`)).client_id, clientId, 'code binds the client_id URL');

      const tokenRes = await exchangeCode(code, clientId, redirectUri);
      assert.equal(tokenRes.status, 200, await tokenRes.clone().text());
      const tokens = await tokenRes.json();
      assert.equal(JSON.parse(store.get(`oauth:refresh:${tokens.refresh_token}`)).client_id, clientId);

      const refreshed = await refresh(tokens.refresh_token, clientId);
      assert.equal(refreshed.status, 200, await refreshed.clone().text());
      const rotated = await refreshed.json();
      assert.notEqual(rotated.refresh_token, tokens.refresh_token);
      assert.equal(JSON.parse(store.get(`oauth:refresh:${rotated.refresh_token}`)).client_id, clientId);

      // CIMD never creates or touches a DCR record.
      assert.equal([...store.keys()].some((k) => k.startsWith('oauth:client:')), false);
    });
  }

  it('a refresh token bound to one client_id cannot be redeemed by another', async () => {
    const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    const flow = await startFlow(claude, 'https://claude.ai/api/mcp/auth_callback');
    const code = new URL((await submitConsent(flow.nonce, flow.cookie)).headers.get('Location')).searchParams.get('code');
    const tokens = await (await exchangeCode(code, claude, 'https://claude.ai/api/mcp/auth_callback')).json();
    const res = await refresh(tokens.refresh_token, 'https://chatgpt.com/oauth/client.json');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error_description, 'client_id mismatch');
  });

  it('a vendor outage at code exchange leaves the code redeemable on retry', async () => {
    // The connector document is no-store, so the exchange always refetches it.
    const flow = await startFlow(CONNECTOR, CONNECTOR_CALLBACK);
    const code = new URL((await submitConsent(flow.nonce, flow.cookie)).headers.get('Location')).searchParams.get('code');
    vendor.set(CONNECTOR, () => new Response('down', { status: 503 }));
    const first = await exchangeCode(code, CONNECTOR, CONNECTOR_CALLBACK);
    assert.equal(first.status, 503);
    assert.ok(store.has(`oauth:code:${code}`), 'the code is not consumed by a retryable failure');
    vendor.set(CONNECTOR, CONNECTOR_DOC);
    const retry = await exchangeCode(code, CONNECTOR, CONNECTOR_CALLBACK);
    assert.equal(retry.status, 200, await retry.clone().text());
  });

  it('a vendor 403 or HTML challenge during refresh is retryable and keeps the token', async () => {
    const flow = await startFlow(CONNECTOR, CONNECTOR_CALLBACK);
    const code = new URL((await submitConsent(flow.nonce, flow.cookie)).headers.get('Location')).searchParams.get('code');
    const tokens = await (await exchangeCode(code, CONNECTOR, CONNECTOR_CALLBACK)).json();
    for (const outage of [
      () => new Response('forbidden', { status: 403 }),
      () => new Response('<html>challenge</html>', { headers: { 'Content-Type': 'text/html' } }),
      // A body cut off mid-transfer: JSON content type, unparseable text.
      () => new Response('{"client_id":"https://connect.vercel.com/conn', { headers: { 'Content-Type': 'application/json' } }),
    ]) {
      vendor.set(CONNECTOR, outage);
      const res = await refresh(tokens.refresh_token, CONNECTOR);
      assert.equal(res.status, 503);
      assert.equal(JSON.parse(store.get(`oauth:refresh:${tokens.refresh_token}`)).client_id, CONNECTOR, 'refresh token restored');
    }
    vendor.set(CONNECTOR, CONNECTOR_DOC);
    assert.equal((await refresh(tokens.refresh_token, CONNECTOR)).status, 200);
  });

  it('a client removed from the vendor document stops refreshing on the next fetch', async () => {
    const linear = 'https://linear.app/.well-known/oauth-client-metadata/mcp.json';
    const redirectUri = 'https://linear.app/connect/mcp/callback';
    const flow = await startFlow(linear, redirectUri);
    const code = new URL((await submitConsent(flow.nonce, flow.cookie)).headers.get('Location')).searchParams.get('code');
    const tokens = await (await exchangeCode(code, linear, redirectUri)).json();
    // The vendor now serves a document for a different client, and the cache expired.
    store.delete(`oauth:cimd:${linear}`);
    vendor.set(linear, { ...LIVE_DOCS[linear], body: { ...LIVE_DOCS[linear].body, client_id: 'https://linear.app/other.json' } });
    const res = await refresh(tokens.refresh_token, linear);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'invalid_client');
  });
});

describe('CIMD — consent page', () => {
  it('warns when the authorization goes to localhost', async () => {
    const claudeCode = 'https://claude.ai/oauth/claude-code-client-metadata';
    const flow = await startFlow(claudeCode, 'http://localhost:61234/callback');
    assert.equal(flow.res.status, 200);
    assert.match(flow.html, /class="client-warn"/);
    assert.match(flow.html, /only to this computer/);
  });

  it('warns for a loopback redirect even when the document also lists hosted callbacks', async () => {
    // Any local app can send VS Code's client_id with a loopback redirect.
    const vscode = 'https://vscode.dev/oauth/client-metadata.json';
    const loopback = await startFlow(vscode, 'http://127.0.0.1:33418/');
    assert.match(loopback.html, /class="client-warn"/);
    store.clear();
    const hosted = await startFlow(vscode, 'https://vscode.dev/redirect');
    assert.doesNotMatch(hosted.html, /class="client-warn"/);
  });

  it('keeps the client host and warning on the bad-key retry page', async () => {
    const claudeCode = 'https://claude.ai/oauth/claude-code-client-metadata';
    const flow = await startFlow(claudeCode, 'http://localhost:61234/callback');
    const res = await authorizeHandler(new Request('https://api.worldmonitor.app/oauth/authorize', {
      method: 'POST',
      headers: { host: 'api.worldmonitor.app', origin: 'https://api.worldmonitor.app', 'Content-Type': 'application/x-www-form-urlencoded', cookie: flow.cookie },
      body: new URLSearchParams({ api_key: 'not-a-key', _nonce: flow.nonce }).toString(),
    }));
    const html = await res.text();
    assert.match(html, /Invalid API key/);
    assert.match(html, /client ID from claude\.ai/);
    assert.match(html, /class="client-warn"/);
  });

  it('a vendor outage at consent submit hands back a fresh session instead of ending the flow', async () => {
    // The connector document is no-store, so the submit always refetches it.
    const post = (nonce, cookie, js) => authorizeHandler(new Request('https://api.worldmonitor.app/oauth/authorize', {
      method: 'POST',
      headers: { host: 'api.worldmonitor.app', origin: 'https://api.worldmonitor.app', 'Content-Type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ api_key: ENTERPRISE_KEY, _nonce: nonce, ...(js ? { _js: '1' } : {}) }).toString(),
    }));

    // The consent page script path: JSON with a replacement nonce.
    const flow = await startFlow(CONNECTOR, CONNECTOR_CALLBACK);
    vendor.set(CONNECTOR, () => new Response('down', { status: 503 }));
    const failed = await post(flow.nonce, flow.cookie, true);
    assert.equal(failed.status, 503);
    const body = await failed.json();
    assert.equal(body.error, 'temporarily_unavailable');
    assert.match(body.message, /could not be verified right now/);
    assert.ok(body.nonce && body.nonce !== flow.nonce, 'a fresh nonce is issued');
    vendor.set(CONNECTOR, CONNECTOR_DOC);
    const retried = await post(body.nonce, flow.cookie, true);
    assert.equal(retried.status, 200, await retried.clone().text());
    const location = new URL((await retried.json()).location);
    assert.equal(`${location.origin}${location.pathname}`, CONNECTOR_CALLBACK);
    assert.ok(location.searchParams.get('code'));

    // A plain form post re-renders the consent page with the replacement nonce.
    store.clear();
    const flow2 = await startFlow(CONNECTOR, CONNECTOR_CALLBACK);
    vendor.set(CONNECTOR, () => new Response('down', { status: 503 }));
    const page = await post(flow2.nonce, flow2.cookie, false);
    assert.equal(page.status, 503);
    const html = await page.text();
    assert.match(html, /could not be verified right now/);
    const fresh = html.match(/name="_nonce" id="nn" value="([^"]+)"/)?.[1];
    assert.ok(fresh && fresh !== flow2.nonce && store.has(`oauth:nonce:${fresh}`));
    assert.match(html, /client ID from connect\.vercel\.com/);
  });

  it('does not warn for a hosted client', async () => {
    const flow = await startFlow('https://claude.ai/oauth/mcp-oauth-client-metadata', 'https://claude.ai/api/mcp/auth_callback');
    assert.doesNotMatch(flow.html, /class="client-warn"/);
  });

  it('escapes a hostile client_name from the document', async () => {
    const url = 'https://linear.app/.well-known/oauth-client-metadata/mcp.json';
    vendor.set(url, { ...LIVE_DOCS[url], body: { ...LIVE_DOCS[url].body, client_name: '<script>alert(1)</script>' } });
    const flow = await startFlow(url, 'https://linear.app/connect/mcp/callback');
    assert.equal(flow.res.status, 200);
    assert.ok(!flow.html.includes('<script>alert(1)</script>'));
    assert.ok(flow.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
});

// ---------------------------------------------------------------------------
// Pro (Clerk) path: grant context, grant mint, authorize-pro
// ---------------------------------------------------------------------------

describe('CIMD — Pro grant path', () => {
  const CHATGPT = 'https://chatgpt.com/oauth/client.json';
  const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const NOW = 1_800_000_000_000;
  const PRO_ENT = { planKey: 'pro_monthly', features: { tier: 1, mcpAccess: true }, validUntil: NOW + 86_400_000 };
  const redisGet = async (key) => parseStored(store.get(key));

  it('context shows the document name and client host; mint and authorize-pro issue a code', async () => {
    process.env.MCP_PRO_GRANT_HMAC_SECRET = 'x'.repeat(48);
    const flow = await startFlow(CHATGPT, REDIRECT);
    assert.equal(flow.res.status, 200);

    const ctxRes = await grantContextHandler(new Request(`https://worldmonitor.app/api/internal/mcp-grant-context?nonce=${flow.nonce}`, { headers: { cookie: flow.cookie } }), {
      resolveUserId: async () => 'user_pro', redisGet, getEntitlements: async () => PRO_ENT, now: () => NOW,
    });
    assert.equal(ctxRes.status, 200, await ctxRes.clone().text());
    assert.deepEqual(await ctxRes.json(), { client_name: 'ChatGPT', redirect_host: 'chatgpt.com', client_host: 'chatgpt.com', localhost_redirect: false });

    const mintRes = await mintGrantHandler(new Request('https://worldmonitor.app/api/internal/mcp-grant-mint', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: flow.cookie }, body: JSON.stringify({ nonce: flow.nonce }),
    }), {
      resolveUserId: async () => 'user_pro',
      redisGet,
      redisSetEx: async (k, v) => { store.set(k, JSON.stringify(v)); return true; },
      redisSetNxEx: async (k, v) => { if (store.has(k)) return false; store.set(k, JSON.stringify(v)); return true; },
      getEntitlements: async () => PRO_ENT,
      isAllowedRedirectUri,
      signGrant: (p) => signGrant(p),
      now: () => NOW,
    });
    assert.equal(mintRes.status, 200, await mintRes.clone().text());
    const redirect = new URL((await mintRes.json()).redirect);

    let issuedFor;
    const proRes = await authorizeProHandler(new Request(redirect), {
      redisGetDel: async (k) => { const v = store.get(k); store.delete(k); return parseStored(v); },
      redisGet,
      redisSetEx: async (k, v) => { store.set(k, JSON.stringify(v)); return true; },
      verifyGrant: (token, secret) => verifyGrant(token, secret, NOW),
      getEntitlements: async () => PRO_ENT,
      issueProMcpTokenForUser: async (userId, clientId, name) => { issuedFor = { userId, clientId, name }; return { tokenId: 'tok_1' }; },
      revokeProMcpToken: async () => ({ ok: true }),
      randomCode: () => 'code_pro_1',
      now: () => NOW,
    });
    assert.equal(proRes.status, 302, await proRes.clone().text());
    const location = new URL(proRes.headers.get('Location'));
    assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
    assert.equal(issuedFor.clientId, CHATGPT, 'the Convex grant records the client_id URL');
    assert.equal(JSON.parse(store.get('oauth:code:code_pro_1')).client_id, CHATGPT);
  });

  it('a vendor outage at authorize-pro leaves the grant link usable on retry', async () => {
    process.env.MCP_PRO_GRANT_HMAC_SECRET = 'x'.repeat(48);
    const flow = await startFlow(CONNECTOR, CONNECTOR_CALLBACK);
    const mintRes = await mintGrantHandler(new Request('https://worldmonitor.app/api/internal/mcp-grant-mint', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: flow.cookie }, body: JSON.stringify({ nonce: flow.nonce }),
    }), {
      resolveUserId: async () => 'user_pro',
      redisGet,
      redisSetEx: async (k, v) => { store.set(k, JSON.stringify(v)); return true; },
      redisSetNxEx: async (k, v) => { if (store.has(k)) return false; store.set(k, JSON.stringify(v)); return true; },
      getEntitlements: async () => PRO_ENT,
      isAllowedRedirectUri,
      signGrant: (p) => signGrant(p),
      now: () => NOW,
    });
    assert.equal(mintRes.status, 200, await mintRes.clone().text());
    const link = (await mintRes.json()).redirect;
    const proDeps = {
      redisGetDel: async (k) => { const v = store.get(k); store.delete(k); return parseStored(v); },
      redisGet,
      redisSetEx: async (k, v) => { store.set(k, JSON.stringify(v)); return true; },
      verifyGrant: (token, secret) => verifyGrant(token, secret, NOW),
      getEntitlements: async () => PRO_ENT,
      issueProMcpTokenForUser: async () => ({ tokenId: 'tok_1' }),
      revokeProMcpToken: async () => ({ ok: true }),
      randomCode: () => 'code_pro_retry',
      now: () => NOW,
    };

    // The connector document is no-store, so the redirect refetches it.
    vendor.set(CONNECTOR, () => new Response('down', { status: 503 }));
    const failed = await authorizeProHandler(new Request(link), proDeps);
    assert.equal(failed.status, 503);
    assert.match(await failed.text(), /could not be verified right now/);
    assert.ok(store.has(`mcp-grant:${flow.nonce}`), 'the grant is not consumed by a retryable failure');
    assert.ok(store.has(`oauth:nonce:${flow.nonce}`), 'the nonce is not consumed by a retryable failure');

    vendor.set(CONNECTOR, CONNECTOR_DOC);
    const retried = await authorizeProHandler(new Request(link), proDeps);
    assert.equal(retried.status, 302, await retried.clone().text());
    assert.equal(JSON.parse(store.get('oauth:code:code_pro_retry')).client_id, CONNECTOR);
  });

  it('a failed nonce read at authorize-pro answers 503 before consuming the link', async () => {
    process.env.MCP_PRO_GRANT_HMAC_SECRET = 'x'.repeat(48);
    const flow = await startFlow(CONNECTOR, CONNECTOR_CALLBACK);
    const mintRes = await mintGrantHandler(new Request('https://worldmonitor.app/api/internal/mcp-grant-mint', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: flow.cookie }, body: JSON.stringify({ nonce: flow.nonce }),
    }), {
      resolveUserId: async () => 'user_pro',
      redisGet,
      redisSetEx: async (k, v) => { store.set(k, JSON.stringify(v)); return true; },
      redisSetNxEx: async (k, v) => { if (store.has(k)) return false; store.set(k, JSON.stringify(v)); return true; },
      getEntitlements: async () => PRO_ENT,
      isAllowedRedirectUri,
      signGrant: (p) => signGrant(p),
      now: () => NOW,
    });
    const link = (await mintRes.json()).redirect;
    const res = await authorizeProHandler(new Request(link), {
      redisGetDel: async (k) => { const v = store.get(k); store.delete(k); return parseStored(v); },
      // The peek times out; every other Redis call would succeed.
      redisGet: async (k) => { if (k.startsWith('oauth:nonce:')) throw new Error('timeout'); return redisGet(k); },
      redisSetEx: async (k, v) => { store.set(k, JSON.stringify(v)); return true; },
      verifyGrant: (token, secret) => verifyGrant(token, secret, NOW),
      getEntitlements: async () => PRO_ENT,
      issueProMcpTokenForUser: async () => ({ tokenId: 'tok_1' }),
      revokeProMcpToken: async () => ({ ok: true }),
      randomCode: () => 'code_pro_peek',
      now: () => NOW,
    });
    assert.equal(res.status, 503);
    assert.ok(store.has(`mcp-grant:${flow.nonce}`), 'the grant is not consumed');
    assert.ok(store.has(`oauth:nonce:${flow.nonce}`), 'the nonce is not consumed');
  });

  it('mint refuses a redirect the document no longer lists', async () => {
    const flow = await startFlow(CHATGPT, REDIRECT);
    store.delete(`oauth:cimd:${CHATGPT}`);
    vendor.set(CHATGPT, { ...LIVE_DOCS[CHATGPT], body: { ...LIVE_DOCS[CHATGPT].body, redirect_uris: ['https://chatgpt.com/other'] } });
    const res = await mintGrantHandler(new Request('https://worldmonitor.app/api/internal/mcp-grant-mint', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: flow.cookie }, body: JSON.stringify({ nonce: flow.nonce }),
    }), {
      resolveUserId: async () => 'user_pro', redisGet,
      redisSetEx: async () => true, redisSetNxEx: async () => true,
      getEntitlements: async () => PRO_ENT, isAllowedRedirectUri, signGrant: (p) => signGrant(p), now: () => NOW,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'INVALID_REDIRECT_URI');
  });
});

// ---------------------------------------------------------------------------
// Negative cases (acceptance criteria)
// ---------------------------------------------------------------------------

const deps = (overrides = {}) => ({
  redisGet: async (key) => parseStored(store.get(key)),
  redisSetEx: async (key, value) => { store.set(key, JSON.stringify(value)); },
  fetch: vendorFetch,
  // These tests pin how the live fetch is classified; the snapshot fallback
  // has its own tests, which pass `snapshots: undefined` for the real set.
  snapshots: {},
  ...overrides,
});

describe('CIMD — rejected documents and client_ids', () => {
  const LINEAR = 'https://linear.app/.well-known/oauth-client-metadata/mcp.json';
  const withBody = (patch) => ({ ...LIVE_DOCS[LINEAR], body: { ...LIVE_DOCS[LINEAR].body, ...patch } });

  it('rejects a document whose client_id differs from its URL', async () => {
    vendor.set(LINEAR, withBody({ client_id: 'https://linear.app/.well-known/oauth-client-metadata/other.json' }));
    assert.deepEqual(await resolveOAuthClient(LINEAR, deps()), { ok: false, reason: 'client_id_mismatch', transient: false });
  });

  it('rejects a redirect_uri the document does not list (authorize GET)', async () => {
    const flow = await startFlow(LINEAR, 'https://linear.app/connect/mcp/callback/extra');
    assert.equal(flow.res.status, 400);
    assert.match(flow.html, /Redirect URI Mismatch/);
    assert.equal(flow.nonce, undefined, 'no nonce is stored');
  });

  it('rejects a redirect_uri outside the host policy even when the document lists it', async () => {
    for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'cursor://anysphere.cursor-mcp/oauth/callback', 'https://user:pw@linear.app/cb']) {
      vendor.set(LINEAR, withBody({ redirect_uris: [bad] }));
      store.clear();
      const resolved = await resolveOAuthClient(LINEAR, deps());
      assert.equal(resolved.ok, true);
      assert.equal(clientAllowsRedirectUri(resolved.client, bad), false, bad);
    }
  });

  it('pins per-connector vendors to their own callback', async () => {
    const connector = 'https://connect.vercel.com/connectors/conn_abc123';
    vendor.set(connector, { content_type: 'application/json', cache_control: 'private, no-store', body: {
      client_id: connector, client_name: 'WorldMonitor (my team)', redirect_uris: ['https://connect.vercel.com/callback', 'https://attacker.example/cb'],
      grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none',
    } });
    const resolved = await resolveOAuthClient(connector, deps());
    assert.equal(resolved.ok, true);
    assert.equal(clientAllowsRedirectUri(resolved.client, 'https://connect.vercel.com/callback'), true);
    assert.equal(clientAllowsRedirectUri(resolved.client, 'https://attacker.example/cb'), false);
    assert.equal(store.has(`oauth:cimd:${connector}`), false, 'private/no-store is not cached');
    for (const id of ['https://connect.vercel.com/connectors/', 'https://connect.vercel.com/connectors/a/b', 'https://connect.vercel.com/connectors/a.json']) {
      assert.equal((await resolveOAuthClient(id, deps())).reason, 'untrusted_client_id', id);
    }
  });

  it('accepts loopback redirects on any port, but only for the listed host and path', async () => {
    const resolved = await resolveOAuthClient('https://claude.ai/oauth/claude-code-client-metadata', deps());
    assert.equal(clientAllowsRedirectUri(resolved.client, 'http://localhost:51234/callback'), true);
    assert.equal(clientAllowsRedirectUri(resolved.client, 'http://127.0.0.1:9/callback'), true);
    assert.equal(clientAllowsRedirectUri(resolved.client, 'http://localhost:51234/other'), false);
    assert.equal(clientAllowsRedirectUri(resolved.client, 'http://[::1]:51234/callback'), false);
    assert.equal(clientAllowsRedirectUri(resolved.client, 'https://localhost:51234/callback'), false);
  });

  it('rejects non-HTTPS, IP-literal, private-host, and non-canonical client_ids without fetching', async () => {
    const ids = {
      'http://linear.app/.well-known/oauth-client-metadata/mcp.json': 'client_id_not_https',
      'https://127.0.0.1/client.json': 'client_id_not_public_host',
      'https://[::1]/client.json': 'client_id_not_public_host',
      'https://10.0.0.5/client.json': 'client_id_not_public_host',
      'https://localhost/client.json': 'client_id_not_public_host',
      'https://metadata.internal/client.json': 'client_id_not_public_host',
      'https://intranet/client.json': 'client_id_not_public_host',
      'https://linear.app/.well-known/oauth-client-metadata/mcp.json?x=1': 'client_id_not_canonical',
      'https://linear.app/.well-known/oauth-client-metadata/mcp.json#f': 'client_id_not_canonical',
      'https://linear.app:8443/.well-known/oauth-client-metadata/mcp.json': 'client_id_not_canonical',
      'https://LINEAR.app/.well-known/oauth-client-metadata/mcp.json': 'client_id_not_canonical',
      'https://linear.app/': 'client_id_not_canonical',
      'https://evil.example/client.json': 'untrusted_client_id',
      'https://linear.app.evil.example/.well-known/oauth-client-metadata/mcp.json': 'untrusted_client_id',
    };
    for (const [id, reason] of Object.entries(ids)) {
      assert.deepEqual(await resolveOAuthClient(id, deps()), { ok: false, reason, transient: false }, id);
    }
    assert.equal(vendorFetches.length, 0, 'no rejected client_id is fetched');
  });

  it('rejects oversized documents', async () => {
    vendor.set(LINEAR, withBody({ client_name: 'x'.repeat(20_000) }));
    assert.equal((await resolveOAuthClient(LINEAR, deps())).reason, 'document_too_large');
    // A streamed body with no Content-Length is cut off at the cap too.
    vendor.set(LINEAR, () => new Response(new ReadableStream({
      pull(c) { c.enqueue(new TextEncoder().encode(' '.repeat(4096))); },
    }), { headers: { 'Content-Type': 'application/json' } }));
    assert.equal((await resolveOAuthClient(LINEAR, deps())).reason, 'document_too_large');
  });

  it('rejects slow documents, as a retryable failure', async () => {
    vendor.set(LINEAR, (init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const started = Date.now();
    assert.deepEqual(await resolveOAuthClient(LINEAR, deps()), { ok: false, reason: 'document_fetch_timeout', transient: true });
    assert.ok(Date.now() - started < 4_500);
    // Headers arrive promptly, the body never finishes.
    vendor.set(LINEAR, () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { headers: { 'Content-Type': 'application/json' } }));
    assert.equal((await resolveOAuthClient(LINEAR, deps())).reason, 'document_fetch_timeout');
  });

  it('rejects redirecting documents and never follows the redirect', async () => {
    vendor.set(LINEAR, () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/doc.json' } }));
    assert.equal((await resolveOAuthClient(LINEAR, deps())).reason, 'document_redirected');
    assert.equal(vendorFetches.at(-1).init.redirect, 'manual');
    assert.deepEqual(vendorFetches.map((f) => f.url), [LINEAR], 'only the document URL is fetched');
  });

  it('rejects non-JSON, secret-bearing, and confidential-only documents', async () => {
    vendor.set(LINEAR, () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }));
    assert.equal((await resolveOAuthClient(LINEAR, deps())).reason, 'document_not_json');
    vendor.set(LINEAR, () => new Response('{nope', { headers: { 'Content-Type': 'application/json' } }));
    assert.equal((await resolveOAuthClient(LINEAR, deps())).reason, 'document_not_json');
    vendor.set(LINEAR, withBody({ client_secret: 's' }));
    assert.equal((await resolveOAuthClient(LINEAR, deps())).reason, 'document_has_client_secret');
    vendor.set(LINEAR, withBody({ token_endpoint_auth_method: 'private_key_jwt' }));
    assert.equal((await resolveOAuthClient(LINEAR, deps())).reason, 'unsupported_token_endpoint_auth_method');
    vendor.set(LINEAR, withBody({ redirect_uris: [] }));
    assert.equal((await resolveOAuthClient(LINEAR, deps())).reason, 'invalid_redirect_uris');
  });

  it('accepts ChatGPT, which prefers private_key_jwt but lists none', async () => {
    const doc = LIVE_DOCS['https://chatgpt.com/oauth/client.json'].body;
    assert.equal(doc.token_endpoint_auth_method, 'private_key_jwt');
    assert.equal((await resolveOAuthClient('https://chatgpt.com/oauth/client.json', deps())).ok, true);
  });

  it('answers a vendor 5xx, 403, or HTML page as retryable and a 404 or 410 as invalid', async () => {
    for (const status of [503, 403, 401, 429]) {
      vendor.set(LINEAR, () => new Response('nope', { status }));
      assert.deepEqual(await resolveOAuthClient(LINEAR, deps()), { ok: false, reason: 'document_fetch_failed', transient: true }, String(status));
    }
    vendor.set(LINEAR, () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }));
    assert.deepEqual(await resolveOAuthClient(LINEAR, deps()), { ok: false, reason: 'document_not_json', transient: true });
    vendor.delete(LINEAR);
    assert.deepEqual(await resolveOAuthClient(LINEAR, deps()), { ok: false, reason: 'document_not_found', transient: false });
    vendor.set(LINEAR, () => new Response('gone', { status: 410 }));
    assert.deepEqual(await resolveOAuthClient(LINEAR, deps()), { ok: false, reason: 'document_not_found', transient: false });
  });

  it('logs what the vendor sent when a document is unusable', async () => {
    const warned = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warned.push(args); };
    try {
      vendor.set(LINEAR, () => new Response('<html>challenge</html>', {
        status: 403, headers: { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge', server: 'cloudflare' },
      }));
      await resolveOAuthClient(LINEAR, deps());
      vendor.set(LINEAR, () => { throw new TypeError('fetch failed'); });
      await resolveOAuthClient(LINEAR, deps());
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warned.length, 2);
    assert.equal(warned[0][0], '[oauth/cimd] client document unusable');
    assert.deepEqual(JSON.parse(warned[0][1]), {
      client_id: LINEAR, reason: 'document_fetch_failed', transient: true,
      status: 403, content_type: 'text/html', cf_mitigated: 'challenge', cf_ray: null, server: 'cloudflare',
      body: '<html>challenge</html>',
    });
    assert.deepEqual(JSON.parse(warned[1][1]), {
      client_id: LINEAR, reason: 'document_fetch_failed', transient: true, error: 'TypeError: fetch failed',
    });
  });

  it('logs an unlisted client_id without fetching it', async () => {
    const warned = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warned.push(args); };
    let result;
    try {
      result = await resolveOAuthClient('https://new-client.example/oauth/client.json', deps());
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(result.reason, 'untrusted_client_id');
    assert.equal(vendorFetches.length, 0);
    assert.deepEqual(warned, [['[oauth/cimd] untrusted client_id', JSON.stringify({ client_id: 'https://new-client.example/oauth/client.json' })]]);
  });

  it('enforces a per-connector pinned callback on a cache hit too', async () => {
    const connector = 'https://connect.vercel.com/connectors/conn_cached';
    store.set(`oauth:cimd:${connector}`, JSON.stringify({ client_id: connector, client_name: 'x', redirect_uris: ['https://attacker.example/cb'] }));
    const resolved = await resolveOAuthClient(connector, deps());
    assert.equal(vendorFetches.length, 0, 'served from cache');
    assert.equal(clientAllowsRedirectUri(resolved.client, 'https://attacker.example/cb'), false);
  });

  it('never treats a DCR record as CIMD, whatever it stores', async () => {
    const id = crypto.randomUUID();
    store.set(`oauth:client:${id}`, JSON.stringify({ client_name: 'x', cimd: true, client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', redirect_uris: ['https://evil.example/cb'] }));
    const resolved = await resolveOAuthClient(id, deps());
    assert.equal(resolved.client.cimd, false);
  });

  it('serves a transient failure on authorize as Service Unavailable, not Unknown Client', async () => {
    vendor.set(CONNECTOR, () => new Response('down', { status: 502 }));
    const flow = await startFlow(CONNECTOR, CONNECTOR_CALLBACK);
    assert.equal(flow.res.status, 400);
    assert.match(flow.html, /could not be verified right now/);
  });
});

describe('CIMD — vetted snapshots', () => {
  const CHATGPT = 'https://chatgpt.com/oauth/client.json';
  const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
  // What chatgpt.com sends Vercel Functions: a 403 page with no cf-ray.
  const BLOCKED = () => new Response('<html> <head> <meta name="viewport" content="width=device-width, initial-scale=1" /> <style global>', {
    status: 403, headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });
  const real = (overrides = {}) => deps({ snapshots: undefined, ...overrides });

  it('every listed document has a snapshot that matches the live capture and validates', async () => {
    assert.deepEqual(Object.keys(CLIENT_METADATA_SNAPSHOTS).sort(), Object.keys(LIVE_DOCS).sort());
    for (const [url, snapshot] of Object.entries(CLIENT_METADATA_SNAPSHOTS)) {
      for (const [field, value] of Object.entries(snapshot)) {
        assert.deepEqual(value, LIVE_DOCS[url].body[field], `${url} ${field}`);
      }
      vendor.set(url, BLOCKED);
      const resolved = await resolveOAuthClient(url, real());
      assert.equal(resolved.ok, true, url);
      assert.deepEqual(resolved.client.redirect_uris, LIVE_DOCS[url].body.redirect_uris, url);
    }
  });

  it('ChatGPT connects end to end while its document is blocked, and nothing is cached', async () => {
    vendor.set(CHATGPT, BLOCKED);
    const flow = await startFlow(CHATGPT, CHATGPT_REDIRECT);
    assert.equal(flow.res.status, 200, flow.html);
    assert.match(flow.html, /client ID from chatgpt\.com/);
    const code = new URL((await submitConsent(flow.nonce, flow.cookie)).headers.get('Location')).searchParams.get('code');
    const exchanged = await exchangeCode(code, CHATGPT, CHATGPT_REDIRECT);
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const refreshed = await refresh((await exchanged.json()).refresh_token, CHATGPT);
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    assert.equal(store.has(`oauth:cimd:${CHATGPT}`), false, 'the snapshot is never cached');
    assert.ok(vendorFetches.filter((f) => f.url === CHATGPT).length >= 3, 'the live document is retried each time');
  });

  it('a withdrawn or invalid live document is not overridden by the snapshot', async () => {
    vendor.delete(CHATGPT);
    assert.deepEqual(await resolveOAuthClient(CHATGPT, real()), { ok: false, reason: 'document_not_found', transient: false });
    vendor.set(CHATGPT, () => new Response('gone', { status: 410 }));
    assert.equal((await resolveOAuthClient(CHATGPT, real())).reason, 'document_not_found');
    vendor.set(CHATGPT, { ...LIVE_DOCS[CHATGPT], body: { ...LIVE_DOCS[CHATGPT].body, client_id: 'https://chatgpt.com/other.json' } });
    assert.equal((await resolveOAuthClient(CHATGPT, real())).reason, 'client_id_mismatch');
    // A vendor dropping a callback takes effect even though the snapshot lists it.
    vendor.set(CHATGPT, { ...LIVE_DOCS[CHATGPT], body: { ...LIVE_DOCS[CHATGPT].body, redirect_uris: ['https://chatgpt.com/new_callback'] } });
    const live = await resolveOAuthClient(CHATGPT, real());
    assert.equal(clientAllowsRedirectUri(live.client, CHATGPT_REDIRECT), false);
  });

  it('logs the fallback', async () => {
    const warned = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warned.push(args); };
    try {
      vendor.set(CHATGPT, BLOCKED);
      await resolveOAuthClient(CHATGPT, real());
    } finally {
      console.warn = originalWarn;
    }
    const logged = JSON.parse(warned[0][1]);
    assert.equal(logged.fallback, 'snapshot');
    assert.equal(logged.status, 403);
  });
});

describe('CIMD — cache', () => {
  const LINEAR = 'https://linear.app/.well-known/oauth-client-metadata/mcp.json';

  it('caches a valid document and reuses it', async () => {
    await resolveOAuthClient(LINEAR, deps());
    await resolveOAuthClient(LINEAR, deps());
    assert.equal(vendorFetches.length, 1);
    assert.equal(JSON.parse(store.get(`oauth:cimd:${LINEAR}`)).client_id, LINEAR);
  });

  it('does not cache a failed or invalid fetch', async () => {
    vendor.set(LINEAR, () => new Response('down', { status: 503 }));
    assert.equal((await resolveOAuthClient(LINEAR, deps())).ok, false);
    vendor.set(LINEAR, { ...LIVE_DOCS[LINEAR], body: { ...LIVE_DOCS[LINEAR].body, client_id: 'https://x.example/' } });
    assert.equal((await resolveOAuthClient(LINEAR, deps())).ok, false);
    assert.equal(store.has(`oauth:cimd:${LINEAR}`), false);
    vendor.set(LINEAR, LIVE_DOCS[LINEAR]);
    assert.equal((await resolveOAuthClient(LINEAR, deps())).ok, true, 'recovers on the next fetch');
  });

  it('ignores a cache entry for a different client_id', async () => {
    store.set(`oauth:cimd:${LINEAR}`, JSON.stringify({ client_id: 'https://evil.example/', client_name: 'x', redirect_uris: ['https://evil.example/cb'] }));
    const resolved = await resolveOAuthClient(LINEAR, deps());
    assert.deepEqual(resolved.client.redirect_uris, ['https://linear.app/connect/mcp/callback']);
  });

  it('still resolves when the cache is down', async () => {
    const resolved = await resolveOAuthClient(LINEAR, deps({ redisGet: async () => { throw new Error('down'); }, redisSetEx: async () => { throw new Error('down'); } }));
    assert.equal(resolved.ok, true);
  });

  it('honours Cache-Control within the one-hour cap', () => {
    assert.equal(clientMetadataCacheTtl('public, max-age=300'), 300);
    assert.equal(clientMetadataCacheTtl('public, max-age=86400'), 3600);
    assert.equal(clientMetadataCacheTtl('max-age=600, s-maxage=60'), 60);
    assert.equal(clientMetadataCacheTtl('no-store,no-cache,max-age=0'), 0);
    assert.equal(clientMetadataCacheTtl('private, max-age=600'), 0);
    assert.equal(clientMetadataCacheTtl('max-age=0'), 0);
    assert.equal(clientMetadataCacheTtl('public, max-age="300"'), 300);
    assert.equal(clientMetadataCacheTtl('s-maxage="60", max-age=600'), 60);
    assert.equal(clientMetadataCacheTtl(null), 300);
  });

  it('caches with the TTL from the vendor header', async () => {
    let ttl;
    await resolveOAuthClient('https://claude.ai/oauth/mcp-oauth-client-metadata', deps({ redisSetEx: async (_k, _v, t) => { ttl = t; } }));
    assert.equal(ttl, 300);
  });
});

describe('client_id dispatch', () => {
  it('sends URLs to CIMD and DCR UUIDs to the registry', async () => {
    assert.equal(isClientMetadataDocumentId(crypto.randomUUID()), false);
    assert.equal(isClientMetadataDocumentId('https://claude.ai/oauth/mcp-oauth-client-metadata'), true);
    assert.equal(isClientMetadataDocumentId('http://x.example/'), true);
    const id = crypto.randomUUID();
    store.set(`oauth:client:${id}`, JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }));
    const resolved = await resolveOAuthClient(id, deps());
    assert.equal(resolved.ok, true);
    assert.equal(resolved.client.cimd, false);
    assert.equal(clientAllowsRedirectUri(resolved.client, 'https://claude.ai/api/mcp/auth_callback'), true);
    assert.equal(vendorFetches.length, 0);
  });
});
