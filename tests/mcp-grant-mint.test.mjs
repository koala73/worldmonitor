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

/**
 * These handlers now read the entitlement backend's CONFIGURATION, not just the
 * row their injected loader returns (#5619 follow-up): an absent row is a plan
 * verdict only when a lookup could actually run. Default to configured — that
 * is production, and it keeps `getEntitlements: async () => null` meaning
 * "Convex confirmed no row", which is what the 403 assertions below are about.
 * The unconfigured case gets its own explicit test.
 */
const ORIGINAL_CONVEX_SITE_URL = process.env.CONVEX_SITE_URL;
const ORIGINAL_CONVEX_SECRET = process.env.CONVEX_SERVER_SHARED_SECRET;

beforeEach(() => {
  process.env.CONVEX_SITE_URL = 'https://fake.convex.site';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'fake-secret';
});

afterEach(() => {
  if (ORIGINAL_CONVEX_SITE_URL === undefined) delete process.env.CONVEX_SITE_URL;
  else process.env.CONVEX_SITE_URL = ORIGINAL_CONVEX_SITE_URL;
  if (ORIGINAL_CONVEX_SECRET === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
  else process.env.CONVEX_SERVER_SHARED_SECRET = ORIGINAL_CONVEX_SECRET;
});

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

// `planKey` is REQUIRED on the real entitlement shape (CachedEntitlements in
// server/_shared/entitlement-check.ts) and every production free shape carries
// 'free' — convex's FREE_TIER_DEFAULTS and the edge fallback both set it.
// Omitting it here made this fixture classify as insufficient_tier rather than
// free_account, so free-account assertions were exercising the wrong verdict.
const FREE_ENT = {
  planKey: 'free',
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

  // #6716 — the handshake admits a CONFIRMED free account and nothing else.
  //
  // The allowance is selected only after a user-bound credential resolves, and
  // this is one of four gates on the only path to that credential (a `wm_` key
  // is not an option: convex/apiKeys.ts requires `apiAccess`, which the free
  // plan lacks). Refusing here left the allowance reachable only by accounts
  // that had already been Pro, while SERVER_INSTRUCTIONS advertised it to
  // every client on `initialize`.
  const FREE_ACCOUNT_SHAPES = [
    ['a canonical free row', () => FREE_ENT],
    ['no entitlement row at all (never subscribed)', () => null],
  ];

  for (const [label, ent] of FREE_ACCOUNT_SHAPES) {
    it(`mints for ${label} — the free funnel needs a door (#6716)`, async () => {
      const { deps } = makeMintDeps({ getEntitlements: async () => ent() });
      const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
      assert.equal(res.status, 200, 'a confirmed free account must be able to connect');
      const json = await res.json();
      assert.ok(json.redirect, 'the handshake continues to authorize-pro');
      assert.equal(json.error, undefined);
    });
  }

  // Everything that is NOT a confirmed free account still refuses. The
  // last entry is the one that matters most: a row whose stored features were
  // overridden to look tier-0 while `planKey` still names a paid plan is a data
  // fault, and a data fault must fail closed rather than land on an allowance
  // by resembling a free account.
  const INSUFFICIENT_TIER_SHAPES = [
    ['a Pro row whose validUntil has passed', () => EXPIRED_PRO_ENT],
    ['tier-1 with mcpAccess: false', () => PRO_ENT_NO_MCP_ACCESS],
    ['tier-1 with mcpAccess undefined (legacy row)', () => ({
      planKey: 'pro',
      features: { tier: 1 },
      validUntil: FIXED_NOW + 86_400_000,
    })],
    ['a tier-0 shape carrying a PAID planKey (feature-override data fault)', () => ({
      planKey: 'pro_monthly',
      features: { tier: 0, mcpAccess: false },
      validUntil: FIXED_NOW + 86_400_000,
    })],
    ['a tier-0 shape with no planKey at all', () => ({
      features: { tier: 0, mcpAccess: false },
      validUntil: FIXED_NOW + 86_400_000,
    })],
  ];

  for (const [label, ent] of INSUFFICIENT_TIER_SHAPES) {
    it(`refuses to mint for ${label} (#6716)`, async () => {
      const { deps } = makeMintDeps({ getEntitlements: async () => ent() });
      const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.error, 'INSUFFICIENT_TIER');
      assert.equal(json.redirect, undefined);
    });
  }

  it('still refuses an UNVERIFIABLE entitlement — that is not a free account (#6716)', async () => {
    // The distinction the whole gate now rests on: `insufficient_tier` is a
    // confirmed answer ("this account has no subscription"), while
    // billing_verification means we could not get an answer. Minting on a read
    // we do not trust would hand out credentials during an entitlement outage.
    // With CONVEX_SITE_URL absent, getEntitlements returns null BEFORE
    // attempting a lookup, so null is not a verdict about the account.
    delete process.env.CONVEX_SITE_URL;
    try {
      const { deps } = makeMintDeps({ getEntitlements: async () => null });
      const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
      assert.notEqual(res.status, 200, 'an unverifiable entitlement must not mint');
    } finally {
      process.env.CONVEX_SITE_URL = 'https://fake.convex.site';
    }
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

  // The consent surface is also an OAuth issuance gate. It must refuse before
  // revealing client metadata when the account does not have active Pro MCP.
  // #6716 — the consent card renders for a CONFIRMED free account, mirroring
  // the mint that immediately follows. A user cannot meaningfully approve a
  // connection without seeing what they are approving, and refusing here would
  // strand a free account mid-flow on an error page.
  it('renders the consent card for a canonical free row (#6716)', async () => {
    const { deps } = makeContextDeps({ getEntitlements: async () => FREE_ENT });
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.error, undefined);
    assert.ok(json.client_name, 'the user must see what they are approving');
  });

  // The client-metadata disclosure this gate guards is still bounded to
  // Clerk-authenticated sessions (resolveUserId rejects anonymous callers
  // first) — but anything that is NOT a confirmed free account still gets
  // nothing, so an expired paid row or a feature-override data fault cannot
  // enumerate registered clients.
  const CONTEXT_INSUFFICIENT_TIER_SHAPES = [
    ['tier-1 with mcpAccess: false', () => PRO_ENT_NO_MCP_ACCESS],
    ['tier-1 with mcpAccess undefined (legacy row)', () => ({
      planKey: 'pro',
      features: { tier: 1 },
      validUntil: FIXED_NOW + 86_400_000,
    })],
    ['a tier-0 shape carrying a PAID planKey (feature-override data fault)', () => ({
      planKey: 'pro_monthly',
      features: { tier: 0, mcpAccess: false },
      validUntil: FIXED_NOW + 86_400_000,
    })],
  ];

  for (const [label, ent] of CONTEXT_INSUFFICIENT_TIER_SHAPES) {
    it(`refuses the consent card for ${label} (#6716)`, async () => {
      const { deps } = makeContextDeps({ getEntitlements: async () => ent() });
      const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.equal(json.error, 'INSUFFICIENT_TIER');
      assert.equal(json.client_name, undefined);
    });
  }

  /**
   * #5619 — the consent card is the one Pro gate with no client-side
   * entitlement subscription to contradict it, so a lookup failure rendered as
   * "buy Pro" is unanswerable from the page. A Convex 4xx (our own shared
   * secret / contract, not the user's plan) now arrives here as the
   * verification marker, and it must keep the retryable vocabulary.
   */
  it('#5619: an unverifiable entitlement is 503 TIER_VERIFICATION_UNAVAILABLE, not the upsell', async () => {
    const { deps } = makeContextDeps({
      getEntitlements: async () => ({
        features: { tier: 0, mcpAccess: false },
        validUntil: 0,
        verificationUnavailable: true,
      }),
    });
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.error, 'TIER_VERIFICATION_UNAVAILABLE');
    assert.equal(res.headers.get('X-Billing-Verification'), 'entitlement_verification_unavailable');
    assert.ok(Number(res.headers.get('Retry-After')) > 0);
    // Still leaks nothing — a caller we cannot verify is not a Pro caller.
    assert.equal(json.client_name, undefined);
    assert.equal(json.redirect_host, undefined);
  });

  it('#5619: an UNCONFIGURED backend is 503, not the upsell', async () => {
    // The consent card is the one Pro gate with no client-side entitlement
    // subscription to contradict it, and #5619 item 3 named this endpoint
    // specifically. With CONVEX_SITE_URL / the shared secret missing,
    // getEntitlements returns null for everyone before attempting a lookup —
    // so INSUFFICIENT_TIER here tells a paying subscriber to buy the plan they
    // already own, because of our deploy defect.
    delete process.env.CONVEX_SITE_URL;
    delete process.env.CONVEX_SERVER_SHARED_SECRET;
    const { deps } = makeContextDeps({ getEntitlements: async () => null });
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.error, 'TIER_VERIFICATION_UNAVAILABLE');
    assert.equal(
      res.headers.get('X-Billing-Verification'),
      'entitlement_verification_unavailable',
    );
    // Still leaks nothing — a caller we cannot verify is not a Pro caller.
    assert.equal(json.client_name, undefined);
    assert.equal(json.redirect_host, undefined);
  });

  it('#5619 + #6716: a CONFIRMED absent entitlement is a free account, and connects', async () => {
    // #5619 established the distinction that still matters: a null reaching
    // this gate means Convex ANSWERED and the user has no row, versus a null
    // that means we never got to ask (the retryable case above). #6716 changes
    // only what the confirmed answer earns — a never-subscribed account is the
    // free funnel's target, so it connects and is metered per call.
    const { deps } = makeContextDeps({ getEntitlements: async () => null });
    const res = await grantContextHandler(makeGetReq('nonce_xyz'), deps);
    assert.equal(res.status, 200);
    // The retryable vocabulary stays reserved for states we could not verify.
    assert.equal(res.headers.get('X-Billing-Verification'), null);
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

// =========================================================================
// #5622 — the grant handshake splits "unverifiable" from "not entitled"
// =========================================================================

/**
 * Both endpoints answered every sub-Pro entitlement with a terminal 403
 * INSUFFICIENT_TIER, including the transient marker `getEntitlements`
 * synthesizes when the backend lookup FAILS. The SPA maps that code to
 * "A WorldMonitor Pro subscription is required to authorize MCP clients." — a
 * paying customer told to buy what they already own because Convex blipped.
 *
 * The pair is asserted together on purpose: they share the gate
 * (server/_shared/pro-mcp-gate.ts) precisely because the SPA branches on `error`
 * and a divergence would change the user's outcome depending on whether they had
 * clicked Authorize yet.
 */
describe('grant handshake billing-verification denials (#5622)', () => {
  const TRANSIENT_ENT = {
    features: { tier: 0, mcpAccess: false },
    validUntil: 0,
    verificationUnavailable: true,
  };
  const LAPSED_ENT = {
    features: { tier: 0, mcpAccess: false },
    validUntil: 0,
    billingStatus: 'subscription_lapsed',
  };
  const RENEWAL_FAILED_ENT = {
    features: { tier: 0, mcpAccess: false },
    validUntil: 0,
    billingStatus: 'renewal_verification_failed',
    retryAfterSeconds: 22,
  };

  const SURFACES = [
    ['mint', (deps) => mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps), makeMintDeps],
    ['context', (deps) => grantContextHandler(makeGetReq('nonce_xyz'), deps), makeContextDeps],
  ];

  for (const [label, invoke, makeDeps] of SURFACES) {
    it(`${label}: an unverifiable entitlement is a retryable 503, not INSUFFICIENT_TIER`, async () => {
      const { deps } = makeDeps({ getEntitlements: async () => TRANSIENT_ENT });
      const res = await invoke(deps);

      assert.equal(res.status, 503);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
      assert.equal(res.headers.get('Retry-After'), '5');
      assert.equal(
        res.headers.get('X-Billing-Verification'),
        'entitlement_verification_unavailable',
      );
      const json = await res.json();
      assert.equal(json.error, 'TIER_VERIFICATION_UNAVAILABLE');
      assert.notEqual(
        json.error,
        'INSUFFICIENT_TIER',
        'the SPA renders INSUFFICIENT_TIER as a terminal upsell',
      );
      // The non-leak invariant still holds on the new path.
      assert.equal(json.client_name, undefined);
      assert.equal(json.redirect_host, undefined);
    });

    it(`${label}: an in-flight renewal re-check carries the provider's own delay`, async () => {
      const { deps } = makeDeps({ getEntitlements: async () => RENEWAL_FAILED_ENT });
      const res = await invoke(deps);

      assert.equal(res.status, 503);
      assert.equal(res.headers.get('Retry-After'), '22');
      assert.equal(res.headers.get('X-Billing-Verification'), 'renewal_verification_failed');
      assert.equal((await res.json()).error, 'TIER_VERIFICATION_UNAVAILABLE');
    });

    it(`${label}: a provider-confirmed lapse connects — dunning is already over (#6716)`, async () => {
      // Dunning runs while the row is `on_hold`, and isCoveringAt keeps those
      // users on FULL Pro throughout. A CONFIRMED lapse therefore means the
      // billing attempts have ended and the account is now simply a free one,
      // so it takes the free-account door like any other. The RETRYABLE states
      // above still refuse — that distinction is #5600 and it is intact.
      const { deps } = makeDeps({ getEntitlements: async () => LAPSED_ENT });
      const res = await invoke(deps);

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Retry-After'), null);
    });

    it(`${label}: a CONFIRMED free row connects, and carries no verification header`, async () => {
      // The #5622 contract this block defends is retryable-vs-terminal, and it
      // is intact: X-Billing-Verification and Retry-After stay reserved for
      // states we could not verify. A confirmed free row is a verified answer,
      // and since #6716 that answer is "connect and meter", not "buy Pro".
      const { deps } = makeDeps({ getEntitlements: async () => FREE_ENT });
      const res = await invoke(deps);

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('X-Billing-Verification'), null);
      assert.equal(res.headers.get('Retry-After'), null);
    });
  }

  it('mint does NOT claim the nonce on a retryable denial, so the retry can still succeed', async () => {
    // The whole value of a retryable answer is that the SAME click works a moment
    // later. Burning the SET-NX claim here would make the advertised retry fail
    // with NONCE_CLAIMED_BY_OTHER_USER or a stale record.
    const setNxCalls = [];
    const { deps } = makeMintDeps({
      getEntitlements: async () => TRANSIENT_ENT,
      redisSetNxEx: async (key, value, ttl) => {
        setNxCalls.push({ key, value, ttl });
        return true;
      },
    });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);

    assert.equal(res.status, 503);
    assert.deepEqual(setNxCalls, [], 'the gate must run before the nonce claim');
  });

  it('a CURRENT Pro row carrying a renewal marker for a stronger plan still mints', async () => {
    const { deps } = makeMintDeps({
      getEntitlements: async () => ({
        ...PRO_ENT,
        billingStatus: 'renewal_verification_pending',
        retryAfterSeconds: 9,
      }),
    });
    const res = await mintGrantHandler(makePostReq({ nonce: 'nonce_xyz' }), deps);
    assert.equal(res.status, 200);
  });
});
