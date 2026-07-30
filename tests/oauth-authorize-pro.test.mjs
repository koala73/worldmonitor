/**
 * Tests for U5 — `/oauth/authorize-pro` endpoint.
 *
 *   - HMAC verify happens BEFORE any Redis call (prevents nonce-burn on
 *     forged grants + saves a Redis round-trip).
 *   - Both `mcp-grant:<n>` and `oauth:nonce:<n>` are GETDEL'd (one-shot;
 *     replay fails the second time).
 *   - The grant payload's `nonce` MUST match the URL `?nonce=` parameter
 *     (defense vs grant-payload-swap).
 *   - The grant payload's `userId` AND `exp` MUST match the
 *     `mcp-grant:<n>` Redis-stored values exactly (defense vs forgery
 *     class where attacker minted a valid HMAC but no Redis record).
 *   - On `oauth:code` SETEX failure, the just-issued mcpProTokens row
 *     is revoked best-effort (no orphaned rows).
 *   - The `oauth:code:<code>` value shape is exactly:
 *       {kind:'pro', userId, mcpTokenId, client_id, redirect_uri,
 *        code_challenge, scope:'mcp_pro'}
 *     — load-bearing for U6's bearer resolver.
 *   - Every error response sets Cache-Control: no-store
 *     (memory `warmping-origin-trust-cdn-401-poisoning`).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { authorizeProHandler } from '../api/oauth/authorize-pro.ts';
import { signGrant } from '../api/_mcp-grant-hmac.ts';
import { ProMcpIssueFailed } from '../server/_shared/pro-mcp-token.ts';

const FIXED_NOW = 1_700_000_000_000;
const SECRET = 'test-secret-32bytes-1234567890ab';
const NONCE = 'nonce_xyz';
const USER_ID = 'user_pro_123';
const CLIENT_ID = 'client_abc';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const CODE_CHALLENGE = 'a'.repeat(43);
const FIXED_CODE = 'code_fixed_uuid_for_tests';

const BASE_GRANT_REDIS = { userId: USER_ID, exp: FIXED_NOW + 60_000 };
const BASE_NONCE_REDIS = {
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  code_challenge: CODE_CHALLENGE,
  state: 'state_round_trip_value',
  created_at: FIXED_NOW - 1000,
};
const BASE_CLIENT_REDIS = {
  client_name: 'Claude Desktop',
  redirect_uris: [REDIRECT_URI],
  last_used: FIXED_NOW - 5000,
};

const PRO_ENT = { features: { tier: 1, mcpAccess: true }, validUntil: FIXED_NOW + 86_400_000 };
const PRO_ENT_NO_MCP_ACCESS = { features: { tier: 1, mcpAccess: false }, validUntil: FIXED_NOW + 86_400_000 };
const FREE_ENT = { features: { tier: 0, mcpAccess: false }, validUntil: FIXED_NOW + 86_400_000 };
const EXPIRED_PRO_ENT = { features: { tier: 1, mcpAccess: true }, validUntil: FIXED_NOW - 1000 };

async function makeGrantToken(overrides = {}) {
  const payload = { userId: USER_ID, nonce: NONCE, exp: FIXED_NOW + 60_000, ...overrides };
  return signGrant(payload, SECRET);
}

/**
 * Assemble the dependency object. Tests override individual deps to
 * exercise specific branches. Tracks Redis op order so we can assert
 * "HMAC verify happened before any Redis call".
 */
async function makeDeps(overrides = {}) {
  const grantRedis = new Map();
  grantRedis.set(`mcp-grant:${NONCE}`, BASE_GRANT_REDIS);
  grantRedis.set(`oauth:nonce:${NONCE}`, BASE_NONCE_REDIS);
  grantRedis.set(`oauth:client:${CLIENT_ID}`, BASE_CLIENT_REDIS);

  const ops = []; // chronological log of all redis calls
  const setExCalls = [];
  const issueCalls = [];
  const revokeCalls = [];

  const deps = {
    redisGetDel: async (key) => {
      ops.push({ kind: 'getdel', key });
      const v = grantRedis.get(key) ?? null;
      grantRedis.delete(key);
      return v;
    },
    redisGet: async (key) => {
      ops.push({ kind: 'get', key });
      return grantRedis.get(key) ?? null;
    },
    redisSetEx: async (key, value, ttl) => {
      ops.push({ kind: 'setex', key, ttl });
      setExCalls.push({ key, value, ttl });
      grantRedis.set(key, value);
      return true;
    },
    verifyGrant: async (token, _secret, now) => {
      // Use the real verifier with our test secret (ignore arg secret).
      const { verifyGrant } = await import('../api/_mcp-grant-hmac.ts');
      return verifyGrant(token, SECRET, now);
    },
    getEntitlements: async () => PRO_ENT,
    issueProMcpTokenForUser: async (userId, clientId, name) => {
      issueCalls.push({ userId, clientId, name });
      return { tokenId: 'token_id_xyz' };
    },
    revokeProMcpToken: async (userId, tokenId) => {
      revokeCalls.push({ userId, tokenId });
      return { ok: true };
    },
    randomCode: () => FIXED_CODE,
    now: () => FIXED_NOW,
  };

  return { deps: { ...deps, ...overrides }, grantRedis, ops, setExCalls, issueCalls, revokeCalls };
}

function makeReq(query) {
  const url = new URL('https://api.worldmonitor.app/oauth/authorize-pro');
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, v);
  }
  return new Request(url.toString(), { method: 'GET' });
}

function makeReqMethod(method) {
  return new Request('https://api.worldmonitor.app/oauth/authorize-pro?nonce=x&grant=y', { method });
}

// ===========================================================================
// Happy path
// ===========================================================================

describe('authorizeProHandler — happy path', () => {
  it('valid grant + valid nonce + tier ≥ 1 → 302 to redirect_uri with code; oauth:code shape is exactly {kind:pro, ...}', async () => {
    const grant = await makeGrantToken();
    const { deps, setExCalls, issueCalls } = await makeDeps();
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);

    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const loc = new URL(res.headers.get('Location'));
    assert.equal(loc.origin + loc.pathname, REDIRECT_URI);
    assert.equal(loc.searchParams.get('code'), FIXED_CODE);
    assert.equal(loc.searchParams.get('state'), 'state_round_trip_value');

    // issueProMcpTokenForUser was called with userId, clientId, "Connected via <name>"
    assert.equal(issueCalls.length, 1);
    assert.deepEqual(issueCalls[0], {
      userId: USER_ID,
      clientId: CLIENT_ID,
      name: 'Connected via Claude Desktop',
    });

    // oauth:code shape is the exact contract U6 reads.
    const setexCode = setExCalls.find((c) => c.key === `oauth:code:${FIXED_CODE}`);
    assert.ok(setexCode, 'oauth:code SETEX must have happened');
    assert.equal(setexCode.ttl, 600);
    assert.deepEqual(setexCode.value, {
      kind: 'pro',
      userId: USER_ID,
      mcpTokenId: 'token_id_xyz',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: CODE_CHALLENGE,
      scope: 'mcp_pro',
    });
  });

  it('happy path with empty state → redirect URL has NO state query param (no empty &state=)', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({
      redisGetDel: async (key) => {
        if (key === `oauth:nonce:${NONCE}`) {
          return { ...BASE_NONCE_REDIS, state: '' };
        }
        if (key === `mcp-grant:${NONCE}`) return BASE_GRANT_REDIS;
        return null;
      },
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('Location'));
    assert.equal(loc.searchParams.has('state'), false, 'empty state must not appear in URL');
    assert.equal(loc.searchParams.get('code'), FIXED_CODE);
  });

  it('Order of Redis ops: HMAC verify → GETDEL mcp-grant → GETDEL oauth:nonce → GET oauth:client → SETEX oauth:code', async () => {
    const grant = await makeGrantToken();
    const { deps, ops } = await makeDeps();
    await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);

    const opSummary = ops.map((o) => `${o.kind}:${o.key}`);
    assert.deepEqual(opSummary, [
      `getdel:mcp-grant:${NONCE}`,
      `getdel:oauth:nonce:${NONCE}`,
      `get:oauth:client:${CLIENT_ID}`,
      `setex:oauth:code:${FIXED_CODE}`,
    ]);
  });
});

// ===========================================================================
// HMAC verify — happens BEFORE any Redis call
// ===========================================================================

describe('authorizeProHandler — HMAC verify is gating', () => {
  it('HMAC fails → HTML error; Redis was NEVER touched', async () => {
    const { deps, ops } = await makeDeps();
    // Forge: sign with a different secret.
    const badGrant = await signGrant({ userId: USER_ID, nonce: NONCE, exp: FIXED_NOW + 60_000 }, 'WRONG-secret');
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant: badGrant }), deps);

    assert.equal(res.status, 400);
    assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(ops.length, 0, 'Redis MUST NOT have been called when HMAC fails');
  });

  it('grant exp < now → HTML error; Redis NEVER touched', async () => {
    const { deps, ops } = await makeDeps();
    const expiredGrant = await makeGrantToken({ exp: FIXED_NOW - 1 });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant: expiredGrant }), deps);

    assert.equal(res.status, 400);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(ops.length, 0, 'Redis must not be touched on expired grant');
  });

  it('malformed grant token → HTML error; Redis NEVER touched', async () => {
    const { deps, ops } = await makeDeps();
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant: 'not-a-real-token' }), deps);

    assert.equal(res.status, 400);
    assert.equal(ops.length, 0);
  });

  it('grant payload nonce mismatches URL nonce → HTML error; Redis NEVER touched', async () => {
    const { deps, ops } = await makeDeps();
    // Sign for a different nonce, then submit at our URL nonce.
    const grant = await makeGrantToken({ nonce: 'different_nonce' });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);

    assert.equal(res.status, 400);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(ops.length, 0, 'Redis must not be touched when grant nonce mismatches URL nonce');
  });
});

// ===========================================================================
// Required parameters
// ===========================================================================

describe('authorizeProHandler — missing parameters', () => {
  it('missing nonce → HTML error; Redis NEVER touched', async () => {
    const { deps, ops } = await makeDeps();
    const grant = await makeGrantToken();
    const res = await authorizeProHandler(makeReq({ grant }), deps);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(ops.length, 0);
  });

  it('missing grant → HTML error; Redis NEVER touched', async () => {
    const { deps, ops } = await makeDeps();
    const res = await authorizeProHandler(makeReq({ nonce: NONCE }), deps);
    assert.equal(res.status, 400);
    assert.equal(ops.length, 0);
  });

  it('missing both nonce and grant → HTML error; Redis NEVER touched', async () => {
    const { deps, ops } = await makeDeps();
    const res = await authorizeProHandler(makeReq({}), deps);
    assert.equal(res.status, 400);
    assert.equal(ops.length, 0);
  });
});

// ===========================================================================
// Redis one-shot consumption
// ===========================================================================

describe('authorizeProHandler — Redis one-shot consumption', () => {
  it('mcp-grant:<n> already consumed (replay) → HTML error', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({
      redisGetDel: async (key) => {
        if (key === `mcp-grant:${NONCE}`) return null; // simulates already-consumed
        return null;
      },
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  it('oauth:nonce:<n> already consumed (after grant succeeds) → HTML error', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({
      redisGetDel: async (key) => {
        if (key === `mcp-grant:${NONCE}`) return BASE_GRANT_REDIS;
        if (key === `oauth:nonce:${NONCE}`) return null; // already consumed
        return null;
      },
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  it('replay: second call with same params (after first consumed both nonces) returns HTML error', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps();
    const res1 = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res1.status, 302);
    const res2 = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res2.status, 400, 'Second consumption must fail (one-shot)');
    assert.equal(res2.headers.get('Cache-Control'), 'no-store');
  });
});

// ===========================================================================
// Forgery defense — userId / exp mismatch between grant payload and Redis record
// ===========================================================================

describe('authorizeProHandler — forgery defense', () => {
  it('grant userId mismatches mcp-grant:<n>.userId → HTML error', async () => {
    const grant = await makeGrantToken(); // signed for USER_ID
    const { deps } = await makeDeps({
      redisGetDel: async (key) => {
        if (key === `mcp-grant:${NONCE}`) return { userId: 'different_user', exp: FIXED_NOW + 60_000 };
        return null;
      },
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  it('grant exp mismatches mcp-grant:<n>.exp → HTML error (defense vs forgery without Redis record)', async () => {
    const grant = await makeGrantToken({ exp: FIXED_NOW + 60_000 });
    const { deps } = await makeDeps({
      redisGetDel: async (key) => {
        // Redis says exp is different from grant payload — should reject
        if (key === `mcp-grant:${NONCE}`) return { userId: USER_ID, exp: FIXED_NOW + 120_000 };
        return null;
      },
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 400);
  });
});

// ===========================================================================
// Entitlement re-check (defense in depth — tier may have lapsed since grant mint)
// ===========================================================================

describe('authorizeProHandler — entitlement re-check', () => {
  it('tier just lapsed (was 1 at mint, now 0) → HTML error; mcpProTokens row NOT issued', async () => {
    const grant = await makeGrantToken();
    const { deps, issueCalls } = await makeDeps({ getEntitlements: async () => FREE_ENT });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(issueCalls.length, 0, 'issueProMcpTokenForUser MUST NOT be called when tier check fails');
  });

  it('subscription expired (validUntil < now) → HTML error; row NOT issued', async () => {
    const grant = await makeGrantToken();
    const { deps, issueCalls } = await makeDeps({ getEntitlements: async () => EXPIRED_PRO_ENT });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 403);
    assert.equal(issueCalls.length, 0);
  });

  it('getEntitlements returns null (Convex CONFIRMED no row) → HTML error; row NOT issued', async () => {
    // Was named "Convex blip", but a blip has not produced a null since the
    // lookup-failure marker landed — it returns a verificationUnavailable row
    // and takes the retryable path asserted in the #5622 block below. A null
    // here now means one of two things, and only one of them is an upsell, so
    // pin the backend as CONFIGURED to select the confirmed-no-row verdict.
    // The unconfigured half has its own test.
    const grant = await makeGrantToken();
    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    process.env.CONVEX_SITE_URL = 'https://fake.convex.site';
    process.env.CONVEX_SERVER_SHARED_SECRET = 'fake-secret';
    try {
      const { deps, issueCalls } = await makeDeps({ getEntitlements: async () => null });
      const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
      assert.equal(res.status, 403);
      assert.equal(issueCalls.length, 0);
    } finally {
      if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalSiteUrl;
      if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
    }
  });

  it('an UNCONFIGURED entitlement backend → retryable 503, row NOT issued', async () => {
    // The consent page has no client-side entitlement snapshot to contradict a
    // wrong verdict, so a missing env var must not render as "buy Pro" here.
    const grant = await makeGrantToken();
    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    delete process.env.CONVEX_SITE_URL;
    delete process.env.CONVEX_SERVER_SHARED_SECRET;
    try {
      const { deps, issueCalls } = await makeDeps({ getEntitlements: async () => null });
      const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
      assert.equal(res.status, 503);
      assert.equal(issueCalls.length, 0, 'nothing may be issued to a caller we cannot verify');
    } finally {
      if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalSiteUrl;
      if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
    }
  });

  it('reviewer round-2 P2: tier-1 with mcpAccess: false → HTML error; row NOT issued', async () => {
    const grant = await makeGrantToken();
    const { deps, issueCalls } = await makeDeps({
      getEntitlements: async () => PRO_ENT_NO_MCP_ACCESS,
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 403);
    assert.equal(issueCalls.length, 0, 'gate must mirror MCP-edge mcpAccess check');
  });

  it('reviewer round-2 P2: tier-1 with mcpAccess: undefined (legacy row) → HTML error', async () => {
    const grant = await makeGrantToken();
    const { deps, issueCalls } = await makeDeps({
      getEntitlements: async () => ({
        features: { tier: 1 }, // no mcpAccess at all (pre-U10 stored row)
        validUntil: FIXED_NOW + 86_400_000,
      }),
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 403);
    assert.equal(issueCalls.length, 0, 'undefined mcpAccess fails closed');
  });
});

// ===========================================================================
// #5622 — the HTML gate adopts the shared billing-verification contract
// ===========================================================================

/**
 * #5600 swept six Pro-gated JSON endpoints onto the retryable contract and left
 * this page out because it needed a copy decision. Until then, an entitlement
 * the backend could not VERIFY rendered the same terminal "Pro Subscription
 * Required" page a confirmed free user sees — a paying customer told to
 * subscribe because Convex blipped.
 *
 * The distinctions asserted here are the whole point: status (retry vs not),
 * the machine-readable headers, and that the copy does not tell the user to
 * reload a page whose one-shot nonces are already spent.
 */
describe('authorizeProHandler — billing-verification denials (#5622)', () => {
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
  const RENEWAL_PENDING_ENT = {
    features: { tier: 0, mcpAccess: false },
    validUntil: 0,
    billingStatus: 'renewal_verification_pending',
    retryAfterSeconds: 12,
  };

  it('an unverifiable entitlement is a retryable 503, not the terminal upsell', async () => {
    const grant = await makeGrantToken();
    const { deps, issueCalls } = await makeDeps({ getEntitlements: async () => TRANSIENT_ENT });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);

    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-Billing-Verification'), 'entitlement_verification_unavailable');
    assert.equal(res.headers.get('Retry-After'), '5');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
    // Still fail-closed: no Convex token row for an unverified user.
    assert.equal(issueCalls.length, 0, 'a retryable denial must not issue a token row');
  });

  it('carries the provider-supplied delay for an in-flight renewal re-check', async () => {
    const grant = await makeGrantToken();
    const { deps, issueCalls } = await makeDeps({
      getEntitlements: async () => RENEWAL_PENDING_ENT,
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);

    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-Billing-Verification'), 'renewal_verification_pending');
    assert.equal(res.headers.get('Retry-After'), '12');
    assert.equal(issueCalls.length, 0);
  });

  it('the retryable page tells the user to restart from their client, never to reload', async () => {
    // By the time this gate runs, `mcp-grant:<n>` and `oauth:nonce:<n>` have both
    // been GETDEL'd (steps 3-4), so a reload fails as an expired session. Copy
    // that says "try again" without saying WHERE sends the user in a circle.
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({ getEntitlements: async () => TRANSIENT_ENT });
    const html = await (await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps)).text();

    assert.match(html, /MCP client/, 'must point the user back at their MCP client');
    assert.match(html, /temporary/i, 'must not read as a subscription problem');
    assert.doesNotMatch(
      html,
      /(reload|refresh|retry) (this |the )?page/i,
      'the spent nonce makes a page reload the one action guaranteed to fail',
    );
    assert.match(
      html,
      /single-use|restarted/i,
      'the copy must explain WHY a reload is not the retry',
    );
    assert.doesNotMatch(
      html,
      /Pro Subscription Required/,
      'a transient failure must not render the upsell headline',
    );
  });

  it('a provider-confirmed lapse stays a 403 and says so, with no Retry-After', async () => {
    const grant = await makeGrantToken();
    const { deps, issueCalls } = await makeDeps({ getEntitlements: async () => LAPSED_ENT });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);

    assert.equal(res.status, 403);
    assert.equal(res.headers.get('X-Billing-Verification'), 'subscription_lapsed');
    assert.equal(
      res.headers.get('Retry-After'),
      null,
      'a confirmed lapse must not invite a retry — renewal is the only way out',
    );
    assert.equal(issueCalls.length, 0);
    assert.match(await res.text(), /Subscription Lapsed/);
  });

  it('a CONFIRMED free row still gets the plain upsell with no verification header', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({ getEntitlements: async () => FREE_ENT });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);

    assert.equal(res.status, 403);
    assert.equal(res.headers.get('X-Billing-Verification'), null);
    assert.match(await res.text(), /Pro Subscription Required/);
  });

  it('a CURRENT Pro row carrying a renewal marker for a stronger plan still authorizes', async () => {
    // Mirrors checkEntitlementDetailed's tier-fallback: classifying the billing
    // metadata before the tier check would 503 a user whose access is fine.
    const grant = await makeGrantToken();
    const { deps, issueCalls } = await makeDeps({
      getEntitlements: async () => ({
        ...PRO_ENT,
        billingStatus: 'renewal_verification_pending',
        retryAfterSeconds: 9,
      }),
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);

    assert.equal(res.status, 302);
    assert.equal(issueCalls.length, 1);
  });
});

// ===========================================================================
// Client / redirect_uri checks
// ===========================================================================

describe('authorizeProHandler — client + redirect_uri', () => {
  it('oauth:client:<id> missing → HTML error', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({
      redisGet: async () => null,
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 400);
  });

  it('redirect_uri not in client.redirect_uris → HTML error (defense-in-depth)', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({
      redisGet: async (key) => {
        if (key === `oauth:client:${CLIENT_ID}`) {
          return { ...BASE_CLIENT_REDIS, redirect_uris: ['https://different.example.com/cb'] };
        }
        return null;
      },
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 400);
  });
});

// ===========================================================================
// issueProMcpTokenForUser failures
// ===========================================================================

describe('authorizeProHandler — issue failures', () => {
  it('ProMcpIssueFailed[pro-required] → 403 HTML error; OAuth nonce already consumed (acceptable)', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({
      issueProMcpTokenForUser: async () => {
        throw new ProMcpIssueFailed('pro-required', 'Pro required', 403);
      },
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  it('ProMcpIssueFailed[network] → 503 HTML error', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({
      issueProMcpTokenForUser: async () => {
        throw new ProMcpIssueFailed('network', 'Convex 5xx', 502);
      },
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  it('ProMcpIssueFailed[invalid-user-id] → 400 HTML error', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({
      issueProMcpTokenForUser: async () => {
        throw new ProMcpIssueFailed('invalid-user-id', 'bad', 400);
      },
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 400);
  });

  it('ProMcpIssueFailed[config] → 500 HTML error', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({
      issueProMcpTokenForUser: async () => {
        throw new ProMcpIssueFailed('config', 'env missing');
      },
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 500);
  });
});

// ===========================================================================
// oauth:code SETEX failure → best-effort revoke rollback
// ===========================================================================

describe('authorizeProHandler — code-storage failure rollback', () => {
  it('Redis SETEX oauth:code fails after issue succeeds → 500 HTML + revoke called', async () => {
    const grant = await makeGrantToken();
    const { deps, revokeCalls } = await makeDeps({
      redisSetEx: async () => false,
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(revokeCalls.length, 1, 'best-effort revoke must be called');
    assert.deepEqual(revokeCalls[0], { userId: USER_ID, tokenId: 'token_id_xyz' });
  });

  it('Redis SETEX oauth:code throws → HTML error + revoke called', async () => {
    const grant = await makeGrantToken();
    const { deps, revokeCalls } = await makeDeps({
      redisSetEx: async () => {
        throw new Error('Redis transport failure');
      },
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 500);
    assert.equal(revokeCalls.length, 1);
  });

  it('revoke rollback returning {ok:false} does NOT cause a different response — caller still sees Server Error', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({
      redisSetEx: async () => false,
      revokeProMcpToken: async () => ({ ok: false, reason: 'network' }),
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 500, 'failed revoke must not mask the original storage error');
  });
});

// ===========================================================================
// Method gating
// ===========================================================================

describe('authorizeProHandler — method gating', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    it(`${method} → 405`, async () => {
      const { deps, ops } = await makeDeps();
      const res = await authorizeProHandler(makeReqMethod(method), deps);
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('Allow'), 'GET');
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
      assert.equal(ops.length, 0, 'no Redis touch on disallowed method');
    });
  }
});

// ===========================================================================
// Redis transport failures → 503
// ===========================================================================

describe('authorizeProHandler — Redis transport failures', () => {
  it('redisGetDel throws on mcp-grant key → 503', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({
      redisGetDel: async () => {
        throw new Error('Redis HTTP 500');
      },
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  it('redisGet throws on oauth:client key → 503', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps({
      redisGet: async () => {
        throw new Error('Redis HTTP 500');
      },
    });
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 503);
  });
});

// ===========================================================================
// Cache-Control: no-store on every error path (CDN poison-cache defense)
// ===========================================================================

describe('authorizeProHandler — Cache-Control header invariant', () => {
  it('every error response sets Cache-Control: no-store', async () => {
    const cases = [
      // missing params
      { setup: async () => makeDeps(), req: makeReq({}) },
      // bad signature
      {
        setup: async () => makeDeps(),
        req: makeReq({ nonce: NONCE, grant: 'no-dot-here' }),
      },
      // expired grant
      {
        setup: async () => makeDeps(),
        req: makeReq({ nonce: NONCE, grant: await makeGrantToken({ exp: FIXED_NOW - 1 }) }),
      },
      // tier lapsed
      {
        setup: async () => makeDeps({ getEntitlements: async () => FREE_ENT }),
        req: makeReq({ nonce: NONCE, grant: await makeGrantToken() }),
      },
      // mcp-grant missing (replay)
      {
        setup: async () =>
          makeDeps({ redisGetDel: async () => null }),
        req: makeReq({ nonce: NONCE, grant: await makeGrantToken() }),
      },
      // SETEX failure
      {
        setup: async () => makeDeps({ redisSetEx: async () => false }),
        req: makeReq({ nonce: NONCE, grant: await makeGrantToken() }),
      },
      // 405 method
      { setup: async () => makeDeps(), req: makeReqMethod('POST') },
    ];
    for (const c of cases) {
      const { deps } = await c.setup();
      const res = await authorizeProHandler(c.req, deps);
      assert.equal(res.headers.get('Cache-Control'), 'no-store', `Cache-Control wrong on status ${res.status}`);
    }
  });

  it('successful 302 redirect ALSO sets Cache-Control: no-store', async () => {
    const grant = await makeGrantToken();
    const { deps } = await makeDeps();
    const res = await authorizeProHandler(makeReq({ nonce: NONCE, grant }), deps);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });
});
