/**
 * Tests for U3 — apex /mcp-grant cross-subdomain bridge.
 *
 *   - api/_mcp-grant-hmac.ts        sign / verify (load-bearing format
 *                                    for U5: <b64u(payloadJson)>.<b64u(sig)>)
 *   - api/internal/mcp-grant-mint   issues the redirect to
 *                                    api.worldmonitor.app/oauth/authorize-pro
 *   - api/internal/mcp-grant-context returns real client metadata
 *
 * Both endpoints share validation; tests assert they fail in identical
 * ways for tier-0 callers, missing nonces, etc. — DRY check enforced as
 * test cases rather than runtime sharing (each handler keeps its own
 * narrow surface).
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { signGrant, verifyGrant, GrantConfigError } from '../api/_mcp-grant-hmac.ts';
import { mintGrantHandler } from '../api/internal/mcp-grant-mint.ts';
import { grantContextHandler } from '../api/internal/mcp-grant-context.ts';

const FIXED_NOW = 1_700_000_000_000; // arbitrary, far past Y2K

const BASE_NONCE_DATA = {
  client_id: 'client_abc',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_challenge: 'a'.repeat(43),
  state: '',
  created_at: FIXED_NOW - 1000,
};

const BASE_CLIENT_DATA = {
  client_name: 'Claude Desktop',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  last_used: FIXED_NOW - 5000,
};

const PRO_ENT = {
  features: { tier: 1 },
  validUntil: FIXED_NOW + 86_400_000,
};

const FREE_ENT = {
  features: { tier: 0 },
  validUntil: FIXED_NOW + 86_400_000,
};

const EXPIRED_PRO_ENT = {
  features: { tier: 1 },
  validUntil: FIXED_NOW - 1000,
};

/**
 * Build the dependency object for `mintGrantHandler`. Tests override
 * individual deps to exercise specific branches.
 */
function makeMintDeps(overrides = {}) {
  const redis = new Map();
  redis.set(`oauth:nonce:nonce_xyz`, BASE_NONCE_DATA);
  redis.set(`oauth:client:client_abc`, BASE_CLIENT_DATA);
  const setExCalls = [];

  const deps = {
    resolveUserId: async () => 'user_pro_123',
    redisGet: async (key) => redis.get(key) ?? null,
    redisSetEx: async (key, value, ttl) => {
      setExCalls.push({ key, value, ttl });
      redis.set(key, value);
      return true;
    },
    getEntitlements: async () => PRO_ENT,
    isAllowedRedirectUri: () => true,
    signGrant: ({ userId, nonce, exp }) => signGrant({ userId, nonce, exp }, 'test-secret-32bytes-1234567890ab'),
    now: () => FIXED_NOW,
  };

  return { deps: { ...deps, ...overrides }, redis, setExCalls };
}

function makeContextDeps(overrides = {}) {
  const redis = new Map();
  redis.set(`oauth:nonce:nonce_xyz`, BASE_NONCE_DATA);
  redis.set(`oauth:client:client_abc`, BASE_CLIENT_DATA);
  const deps = {
    resolveUserId: async () => 'user_pro_123',
    redisGet: async (key) => redis.get(key) ?? null,
    getEntitlements: async () => PRO_ENT,
    now: () => FIXED_NOW,
  };
  return { deps: { ...deps, ...overrides }, redis };
}

function makePostReq(body) {
  return new Request('https://worldmonitor.app/api/internal/mcp-grant-mint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-jwt' },
    body: JSON.stringify(body),
  });
}

function makeGetReq(nonce) {
  const url = nonce !== undefined
    ? `https://worldmonitor.app/api/internal/mcp-grant-context?nonce=${encodeURIComponent(nonce)}`
    : `https://worldmonitor.app/api/internal/mcp-grant-context`;
  return new Request(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer fake-jwt' },
  });
}

// =========================================================================
// HMAC sign / verify — wire format invariants
// =========================================================================

describe('_mcp-grant-hmac', () => {
  const SECRET = 'test-secret-32bytes-1234567890ab';

  it('round-trips: sign → verify recovers the exact payload', async () => {
    const payload = { userId: 'user_xyz', nonce: 'n_abc', exp: FIXED_NOW + 300_000 };
    const token = await signGrant(payload, SECRET);
    const r = await verifyGrant(token, SECRET, FIXED_NOW);
    assert.equal(r.ok, true);
    assert.deepEqual(r.payload, payload);
  });

  it('produces wire format <b64u(payload)>.<b64u(sig)> with two halves matching [A-Za-z0-9_-]+', async () => {
    const token = await signGrant({ userId: 'u', nonce: 'n', exp: FIXED_NOW + 1000 }, SECRET);
    const parts = token.split('.');
    assert.equal(parts.length, 2, 'token must have exactly one dot separator');
    assert.match(parts[0], /^[A-Za-z0-9_-]+$/, 'payload half must be base64url-no-pad');
    assert.match(parts[1], /^[A-Za-z0-9_-]+$/, 'signature half must be base64url-no-pad');
  });

  it('is deterministic for the same (payload, secret) — load-bearing for verify across U5', async () => {
    const payload = { userId: 'u', nonce: 'n', exp: FIXED_NOW + 1000 };
    const a = await signGrant(payload, SECRET);
    const b = await signGrant(payload, SECRET);
    assert.equal(a, b, 'HMAC over identical bytes must be deterministic');
  });

  it('rejects a token signed with a different secret as bad-signature', async () => {
    const token = await signGrant({ userId: 'u', nonce: 'n', exp: FIXED_NOW + 1000 }, SECRET);
    const r = await verifyGrant(token, 'WRONG-secret', FIXED_NOW);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad-signature');
  });

  it('rejects expired tokens as expired (verifier consumes payload.exp)', async () => {
    const token = await signGrant({ userId: 'u', nonce: 'n', exp: FIXED_NOW - 1 }, SECRET);
    const r = await verifyGrant(token, SECRET, FIXED_NOW);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'expired');
  });

  it('rejects malformed tokens', async () => {
    for (const t of ['', 'no-dot-here', '.', 'a.', '.b', 'in!.va!lid', 'a==.b==']) {
      const r = await verifyGrant(t, SECRET, FIXED_NOW);
      assert.equal(r.ok, false, `expected non-ok for ${JSON.stringify(t)}`);
      assert.equal(r.reason, 'malformed', `expected malformed for ${JSON.stringify(t)}`);
    }
  });

  it('rejects valid signature over a payload with the wrong shape (invalid-payload)', async () => {
    // Hand-craft a token whose payload is JSON but missing required fields.
    const enc = new TextEncoder();
    const payloadBytes = enc.encode(JSON.stringify({ unrelated: 'shape' }));
    const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, payloadBytes));
    const b64u = (bytes) => {
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    const token = `${b64u(payloadBytes)}.${b64u(sig)}`;
    const r = await verifyGrant(token, SECRET, FIXED_NOW);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-payload');
  });

  it('readGrantSecret throws GrantConfigError when MCP_PRO_GRANT_HMAC_SECRET is unset', async () => {
    await assert.rejects(
      () => signGrant({ userId: 'u', nonce: 'n', exp: FIXED_NOW + 1000 }), // no explicit secret → reads env
      (err) => err instanceof GrantConfigError,
    );
  });
});

// =========================================================================
// mintGrantHandler — happy path + every error branch
// =========================================================================

describe('mintGrantHandler', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.MCP_PRO_GRANT_HMAC_SECRET = 'test-secret-32bytes-1234567890ab';
  });
  afterEach(() => {
    Object.keys(process.env).forEach((k) => { if (!(k in originalEnv)) delete process.env[k]; });
    Object.assign(process.env, originalEnv);
  });

  it('happy path: returns redirect to https://api.worldmonitor.app/oauth/authorize-pro with valid grant', async () => {
    const { deps, setExCalls } = makeMintDeps();
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.json();
    assert.ok(typeof body.redirect === 'string');

    // URL parses cleanly (catches any encoding bug) and points at the FIXED host.
    const u = new URL(body.redirect);
    assert.equal(u.origin, 'https://api.worldmonitor.app');
    assert.equal(u.pathname, '/oauth/authorize-pro');
    assert.equal(u.searchParams.get('nonce'), 'nonce_xyz');
    const grant = u.searchParams.get('grant');
    assert.ok(grant, 'grant query param must be present');

    // Grant verifies with the same secret; payload binds userId+nonce; exp is +5min.
    const ver = await verifyGrant(grant, 'test-secret-32bytes-1234567890ab', FIXED_NOW);
    assert.equal(ver.ok, true);
    assert.equal(ver.payload.userId, 'user_pro_123');
    assert.equal(ver.payload.nonce, 'nonce_xyz');
    assert.equal(ver.payload.exp, FIXED_NOW + 5 * 60 * 1000);

    // Redis one-shot stored with 5-min TTL and the same {userId, exp}.
    assert.equal(setExCalls.length, 1);
    assert.equal(setExCalls[0].key, 'mcp-grant:nonce_xyz');
    assert.equal(setExCalls[0].ttl, 300);
    assert.deepEqual(setExCalls[0].value, { userId: 'user_pro_123', exp: FIXED_NOW + 5 * 60 * 1000 });
  });

  it('returns 401 UNAUTHENTICATED when Clerk session resolves null', async () => {
    const { deps } = makeMintDeps({ resolveUserId: async () => null });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.json();
    assert.equal(body.error, 'UNAUTHENTICATED');
  });

  it('returns 405 on non-POST', async () => {
    const { deps } = makeMintDeps();
    const req = new Request('https://worldmonitor.app/api/internal/mcp-grant-mint', { method: 'GET' });
    const res = await mintGrantHandler(req, deps);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('Allow'), 'POST');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  it('returns 400 INVALID_REQUEST on missing/empty nonce', async () => {
    const { deps } = makeMintDeps();
    for (const body of [{}, { nonce: '' }, { nonce: 123 }]) {
      const res = await mintGrantHandler(makePostReq(body), deps);
      assert.equal(res.status, 400, `body=${JSON.stringify(body)}`);
      const json = await res.json();
      assert.equal(json.error, 'INVALID_REQUEST');
    }
  });

  it('returns 400 INVALID_REQUEST on non-JSON body', async () => {
    const { deps } = makeMintDeps();
    const req = new Request('https://worldmonitor.app/api/internal/mcp-grant-mint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-jwt' },
      body: 'not json {',
    });
    const res = await mintGrantHandler(req, deps);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'INVALID_REQUEST');
  });

  it('returns 400 INVALID_NONCE when oauth:nonce:<n> is missing', async () => {
    const { deps } = makeMintDeps({ redisGet: async () => null });
    const res = await mintGrantHandler(makePostReq({ nonce: 'absent' }), deps);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'INVALID_NONCE');
  });

  it('returns 400 UNKNOWN_CLIENT when oauth:client:<id> is missing', async () => {
    const redis = new Map();
    redis.set('oauth:nonce:nonce_xyz', BASE_NONCE_DATA);
    // No client entry.
    const { deps } = makeMintDeps({ redisGet: async (k) => redis.get(k) ?? null });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'UNKNOWN_CLIENT');
  });

  it('returns 400 INVALID_REDIRECT_URI when redirect_uri is no longer allowlisted', async () => {
    const { deps } = makeMintDeps({ isAllowedRedirectUri: () => false });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'INVALID_REDIRECT_URI');
  });

  it('returns 400 INVALID_REDIRECT_URI when client.redirect_uris no longer includes the nonce uri', async () => {
    const redis = new Map();
    redis.set('oauth:nonce:nonce_xyz', BASE_NONCE_DATA);
    redis.set('oauth:client:client_abc', { ...BASE_CLIENT_DATA, redirect_uris: ['https://different.example.com/cb'] });
    const { deps } = makeMintDeps({ redisGet: async (k) => redis.get(k) ?? null });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'INVALID_REDIRECT_URI');
  });

  it('returns 403 INSUFFICIENT_TIER for free-tier user', async () => {
    const { deps } = makeMintDeps({ getEntitlements: async () => FREE_ENT });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error, 'INSUFFICIENT_TIER');
  });

  it('returns 403 INSUFFICIENT_TIER for tier-1 user with validUntil < now (lapsed subscription)', async () => {
    const { deps } = makeMintDeps({ getEntitlements: async () => EXPIRED_PRO_ENT });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error, 'INSUFFICIENT_TIER');
  });

  it('returns 403 INSUFFICIENT_TIER when getEntitlements returns null (Convex blip / unknown user)', async () => {
    const { deps } = makeMintDeps({ getEntitlements: async () => null });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error, 'INSUFFICIENT_TIER');
  });

  it('returns 503 when Redis SETEX of mcp-grant:<n> fails', async () => {
    const { deps } = makeMintDeps({ redisSetEx: async () => false });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.error, 'SERVICE_UNAVAILABLE');
  });

  it('returns 503 when Redis GET (transport) throws', async () => {
    const { deps } = makeMintDeps({ redisGet: async () => { throw new Error('Redis HTTP 500'); } });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.error, 'SERVICE_UNAVAILABLE');
  });

  it('returns 500 CONFIGURATION_ERROR when MCP_PRO_GRANT_HMAC_SECRET is unset', async () => {
    delete process.env.MCP_PRO_GRANT_HMAC_SECRET;
    // Force the handler to hit the env-reading path by passing the
    // production-shaped signGrant that reads from env.
    const { deps } = makeMintDeps({ signGrant: ({ userId, nonce, exp }) => signGrant({ userId, nonce, exp }) });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 500);
    const json = await res.json();
    assert.equal(json.error, 'CONFIGURATION_ERROR');
  });

  it('all error paths set Cache-Control: no-store', async () => {
    // Quick spot-check across several branches (Cache-Control is load-bearing for OAuth flows).
    const cases = [
      makeMintDeps({ resolveUserId: async () => null }),
      makeMintDeps({ redisGet: async () => null }),
      makeMintDeps({ getEntitlements: async () => FREE_ENT }),
      makeMintDeps({ redisSetEx: async () => false }),
    ];
    for (const { deps } of cases) {
      const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
    }
  });

  it('concurrent mints for the same nonce both succeed (second overwrites — anti-replay handled by Redis one-shot at U5)', async () => {
    const { deps } = makeMintDeps();
    const [a, b] = await Promise.all([
      mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps),
      mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
  });
});

// =========================================================================
// grantContextHandler — same validation paths as mint, no leak to non-Pro
// =========================================================================

describe('grantContextHandler', () => {
  it('happy path: returns {client_name, redirect_host} from the registered client metadata', async () => {
    const { deps } = makeContextDeps();
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(body, { client_name: 'Claude Desktop', redirect_host: 'claude.ai' });
  });

  it('returns 401 UNAUTHENTICATED when Clerk session is null', async () => {
    const { deps } = makeContextDeps({ resolveUserId: async () => null });
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.error, 'UNAUTHENTICATED');
  });

  it('returns 400 INVALID_REQUEST for missing nonce param', async () => {
    const { deps } = makeContextDeps();
    const res = await grantContextHandler(makeGetReq(undefined), deps);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'INVALID_REQUEST');
  });

  it('returns 403 INSUFFICIENT_TIER for free user — must NOT leak client_name to non-Pro callers', async () => {
    const { deps } = makeContextDeps({ getEntitlements: async () => FREE_ENT });
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error, 'INSUFFICIENT_TIER');
    // Negative assertion: response body MUST not contain client_name or redirect_host.
    assert.equal(json.client_name, undefined);
    assert.equal(json.redirect_host, undefined);
  });

  it('returns 400 INVALID_NONCE when nonce row is missing', async () => {
    const { deps } = makeContextDeps({ redisGet: async () => null });
    const res = await grantContextHandler(makeGetReq('absent'), deps);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'INVALID_NONCE');
  });

  it('returns 400 UNKNOWN_CLIENT when client row is missing', async () => {
    const redis = new Map();
    redis.set('oauth:nonce:nonce_xyz', BASE_NONCE_DATA);
    const { deps } = makeContextDeps({ redisGet: async (k) => redis.get(k) ?? null });
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'UNKNOWN_CLIENT');
  });

  it('returns 503 SERVICE_UNAVAILABLE on Redis transport failure', async () => {
    const { deps } = makeContextDeps({ redisGet: async () => { throw new Error('Redis HTTP 500'); } });
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.error, 'SERVICE_UNAVAILABLE');
  });

  it('returns 405 on non-GET', async () => {
    const { deps } = makeContextDeps();
    const req = new Request('https://worldmonitor.app/api/internal/mcp-grant-context?nonce=x', {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-jwt' },
    });
    const res = await grantContextHandler(req, deps);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('Allow'), 'GET');
  });

  it('falls back to "Unknown Client" when client_name is missing', async () => {
    const redis = new Map();
    redis.set('oauth:nonce:nonce_xyz', BASE_NONCE_DATA);
    redis.set('oauth:client:client_abc', { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    const { deps } = makeContextDeps({ redisGet: async (k) => redis.get(k) ?? null });
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.client_name, 'Unknown Client');
    assert.equal(body.redirect_host, 'claude.ai');
  });

  it('mint and context render the SAME client_name + redirect_host (DRY parity)', async () => {
    // The mint redirect URL embeds the client_id-derived nonce; the context
    // endpoint surfaces the same client_name+redirect_host to the SPA.
    // Whatever appears on screen must match the registered client.
    const { deps: ctxDeps } = makeContextDeps();
    const ctxRes = await grantContextHandler(makeGetReq('nonce_xyz'), ctxDeps);
    const ctxBody = await ctxRes.json();
    assert.equal(ctxBody.client_name, BASE_CLIENT_DATA.client_name);
    assert.equal(ctxBody.redirect_host, new URL(BASE_NONCE_DATA.redirect_uri).hostname);
  });
});
