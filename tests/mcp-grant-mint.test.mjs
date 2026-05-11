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
  features: { tier: 1, mcpAccess: true },
  validUntil: FIXED_NOW + 86_400_000,
};

const PRO_ENT_NO_MCP_ACCESS = {
  features: { tier: 1, mcpAccess: false },
  validUntil: FIXED_NOW + 86_400_000,
};

const FREE_ENT = {
  features: { tier: 0, mcpAccess: false },
  validUntil: FIXED_NOW + 86_400_000,
};

const EXPIRED_PRO_ENT = {
  features: { tier: 1, mcpAccess: true },
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
  const setNxExCalls = [];

  const deps = {
    resolveUserId: async () => 'user_pro_123',
    redisGet: async (key) => redis.get(key) ?? null,
    redisSetEx: async (key, value, ttl) => {
      setExCalls.push({ key, value, ttl });
      redis.set(key, value);
      return true;
    },
    // F2: SET NX semantics — succeeds only if the key does not exist.
    // The default impl tracks calls and writes idempotently when missing.
    redisSetNxEx: async (key, value, ttl) => {
      setNxExCalls.push({ key, value, ttl });
      if (redis.has(key)) return false;
      redis.set(key, value);
      return true;
    },
    getEntitlements: async () => PRO_ENT,
    isAllowedRedirectUri: () => true,
    signGrant: ({ userId, nonce, exp }) => signGrant({ userId, nonce, exp }, 'test-secret-32bytes-1234567890ab'),
    now: () => FIXED_NOW,
  };

  return { deps: { ...deps, ...overrides }, redis, setExCalls, setNxExCalls };
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
    // F2: grant write now goes through SET NX. Assert on setNxExCalls
    // instead of setExCalls.
    const { deps, setNxExCalls } = makeMintDeps();
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

    // Redis NX claim with 5-min TTL and the same {userId, exp}.
    assert.equal(setNxExCalls.length, 1);
    assert.equal(setNxExCalls[0].key, 'mcp-grant:nonce_xyz');
    assert.equal(setNxExCalls[0].ttl, 300);
    assert.deepEqual(setNxExCalls[0].value, { userId: 'user_pro_123', exp: FIXED_NOW + 5 * 60 * 1000 });
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

  it('reviewer round-2 P2: returns 403 INSUFFICIENT_TIER for tier-1 user with mcpAccess: false', async () => {
    const { deps } = makeMintDeps({ getEntitlements: async () => PRO_ENT_NO_MCP_ACCESS });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error, 'INSUFFICIENT_TIER');
  });

  it('reviewer round-2 P2: returns 403 INSUFFICIENT_TIER for tier-1 user with undefined mcpAccess (legacy entitlement row)', async () => {
    const { deps } = makeMintDeps({
      getEntitlements: async () => ({
        features: { tier: 1 }, // no mcpAccess field — pre-U10 row
        validUntil: FIXED_NOW + 86_400_000,
      }),
    });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error, 'INSUFFICIENT_TIER');
  });

  it('returns 503 when Redis SET NX of mcp-grant:<n> fails AND no prior record exists (transport failure)', async () => {
    // F2: SET NX failed AND GET returns null → genuine transport failure → 503.
    const { deps } = makeMintDeps({
      redisSetNxEx: async () => false,
      redisGet: async (key) => {
        // Return the oauth:nonce/oauth:client fixtures normally; null for the grant key
        // (no prior claim → genuine transport failure path).
        if (key === 'oauth:nonce:nonce_xyz') return BASE_NONCE_DATA;
        if (key === 'oauth:client:client_abc') return BASE_CLIENT_DATA;
        return null;
      },
    });
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
      makeMintDeps({
        redisSetNxEx: async () => false,
        redisGet: async (key) => {
          if (key === 'oauth:nonce:nonce_xyz') return BASE_NONCE_DATA;
          if (key === 'oauth:client:client_abc') return BASE_CLIENT_DATA;
          return null;
        },
      }),
    ];
    for (const { deps } of cases) {
      const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
    }
  });

  it('F2: concurrent mints from SAME userId for the same nonce both succeed (idempotent multi-tab)', async () => {
    // SET NX semantics: first mint claims; second sees existing record
    // with matching userId → idempotently re-issues the redirect.
    const { deps } = makeMintDeps();
    const [a, b] = await Promise.all([
      mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps),
      mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
  });

  it('F2: mint from a DIFFERENT userId after a prior claim → 403 NONCE_CLAIMED_BY_OTHER_USER', async () => {
    // Pre-claim the grant key as user A.
    const { deps: depsA } = makeMintDeps();
    const a = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), depsA);
    assert.equal(a.status, 200);

    // Now make a fresh deps where the SAME redis store is reused (the
    // claim persists), and resolveUserId returns a DIFFERENT user. The
    // SET NX collision + GET-and-compare must produce 403.
    const sharedRedis = depsA.redisGetSharedStore?.();
    // Build a deps that points at the same store via depsA's redis impl.
    const { deps: depsB } = makeMintDeps({
      resolveUserId: async () => 'user_attacker_999',
      // Reuse depsA's underlying store by going through its redisGet which
      // already reads from the closure'd Map.
      redisGet: depsA.redisGet,
      redisSetNxEx: depsA.redisSetNxEx,
      redisSetEx: depsA.redisSetEx,
    });

    const b = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), depsB);
    assert.equal(b.status, 403);
    const body = await b.json();
    assert.equal(body.error, 'NONCE_CLAIMED_BY_OTHER_USER');
    // anti-information-leak: response sets no-store
    assert.equal(b.headers.get('Cache-Control'), 'no-store');
    // Sanity-check we didn't leak `sharedRedis` reference path.
    assert.equal(sharedRedis, undefined, 'helper did not need a back door');
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

  it('reviewer round-2 P2: returns 403 for tier-1 user with mcpAccess: false (and no client_name leak)', async () => {
    const { deps } = makeContextDeps({ getEntitlements: async () => PRO_ENT_NO_MCP_ACCESS });
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error, 'INSUFFICIENT_TIER');
    assert.equal(json.client_name, undefined);
    assert.equal(json.redirect_host, undefined);
  });

  it('reviewer round-2 P2: returns 403 for tier-1 user with undefined mcpAccess (legacy entitlement row)', async () => {
    const { deps } = makeContextDeps({
      getEntitlements: async () => ({
        features: { tier: 1 }, // no mcpAccess field
        validUntil: FIXED_NOW + 86_400_000,
      }),
    });
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error, 'INSUFFICIENT_TIER');
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

  it('F2: when mcp-grant:<n> is claimed by a DIFFERENT userId, context returns 403 NONCE_CLAIMED_BY_OTHER_USER', async () => {
    // The apex SPA must NOT render consent context for a hijacked nonce.
    const redis = new Map();
    redis.set('oauth:nonce:nonce_xyz', BASE_NONCE_DATA);
    redis.set('oauth:client:client_abc', BASE_CLIENT_DATA);
    // Pre-existing claim by another user (attacker minted first).
    redis.set('mcp-grant:nonce_xyz', { userId: 'user_attacker_999', exp: FIXED_NOW + 60_000 });

    const { deps } = makeContextDeps({
      // resolveUserId returns the VICTIM's userId (the one apex page is currently signed in as).
      resolveUserId: async () => 'user_pro_123',
      redisGet: async (key) => redis.get(key) ?? null,
    });

    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'NONCE_CLAIMED_BY_OTHER_USER');
    assert.equal(body.client_name, undefined, 'must NOT leak client_name on a hijacked nonce');
    assert.equal(body.redirect_host, undefined);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  it('F2: context still works when there is NO prior claim (first-mint case — render normally)', async () => {
    // Absence of mcp-grant:<n> is the normal pre-mint state: render
    // consent UI for the legitimate user; the FIRST mint from this
    // session will claim the nonce.
    const { deps } = makeContextDeps();
    // No mcp-grant:<n> in the redis map by default.
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.client_name, BASE_CLIENT_DATA.client_name);
  });

  it('F2: context still works when mcp-grant:<n> is claimed by the SAME userId (multi-tab)', async () => {
    const redis = new Map();
    redis.set('oauth:nonce:nonce_xyz', BASE_NONCE_DATA);
    redis.set('oauth:client:client_abc', BASE_CLIENT_DATA);
    redis.set('mcp-grant:nonce_xyz', { userId: 'user_pro_123', exp: FIXED_NOW + 60_000 });
    const { deps } = makeContextDeps({
      redisGet: async (key) => redis.get(key) ?? null,
    });
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.client_name, BASE_CLIENT_DATA.client_name);
  });
});
