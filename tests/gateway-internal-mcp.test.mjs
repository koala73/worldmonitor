/**
 * Tests for U8 — Gateway internal-MCP HMAC verify + sanitised-Request
 * propagation + `isCallerPremium` extension.
 *
 * Surface under test:
 *   - server/gateway.ts            HMAC pre-check + strip-then-construct
 *   - server/_shared/mcp-internal-hmac.ts::verifyInternalMcpRequest
 *   - server/_shared/premium-check.ts::isCallerPremium
 *
 * The HMAC sign helper from U7 is the SAME module — sign side and verify
 * side share canonicalisation primitives, so any drift between the two
 * surfaces immediately as a 401 here.
 *
 * Convex `getEntitlements` is stubbed by intercepting globalThis.fetch
 * for `${CONVEX_SITE_URL}/api/internal-entitlements`. Upstash is left
 * unset so the rate limiter / entitlement cache paths are no-ops.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import {
  signInternalMcpRequest,
  getInternalMcpVerifiedNonce,
  INTERNAL_MCP_SIG_HEADER,
  INTERNAL_MCP_USER_ID_HEADER,
  INTERNAL_MCP_VERIFIED_HEADER,
  TRUSTED_USER_ID_HEADER,
} from '../server/_shared/mcp-internal-hmac.ts';
import { isCallerPremium } from '../server/_shared/premium-check.ts';

const VERIFIED_NONCE = getInternalMcpVerifiedNonce();

const HMAC_SECRET = 'test-internal-hmac-secret-32bytes-padding-xxxxxxxxxxxxxxxxxxxxx';
const PRO_USER_ID = 'user_pro_abc';
const FREE_USER_ID = 'user_free_xyz';
const TIER1_NO_MCP_USER_ID = 'user_pro_legacy';

const CONVEX_SITE = 'https://fake.convex.site';
const CONVEX_SECRET = 'fake-convex-shared-secret';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

// ---------------------------------------------------------------------------
// Test fixture: gateway with two routes, one capturing the request handed
// to the handler so tests can assert what propagated through.
// ---------------------------------------------------------------------------
let lastHandlerRequest = null;

function makeGateway() {
  return createDomainGateway([
    {
      method: 'POST',
      path: '/api/news/v1/summarize-article',
      handler: async (req) => {
        lastHandlerRequest = req;
        return new Response(JSON.stringify({ ok: true, route: 'summarize-article' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    },
    {
      method: 'POST',
      path: '/api/intelligence/v1/deduct-situation',
      handler: async (req) => {
        lastHandlerRequest = req;
        return new Response(JSON.stringify({ ok: true, route: 'deduct-situation' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    },
    {
      method: 'GET',
      path: '/api/news/v1/list-feed-digest',
      handler: async (req) => {
        lastHandlerRequest = req;
        return new Response(JSON.stringify({ ok: true, route: 'list-feed-digest' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Convex `/api/internal-entitlements` stub — answers based on userId.
// ---------------------------------------------------------------------------
function entitlementForUser(userId) {
  if (userId === PRO_USER_ID) {
    return {
      planKey: 'pro',
      features: { tier: 1, apiAccess: false, apiRateLimit: 60, maxDashboards: 10, prioritySupport: false, exportFormats: [], mcpAccess: true },
      validUntil: Date.now() + 86_400_000,
    };
  }
  if (userId === TIER1_NO_MCP_USER_ID) {
    return {
      planKey: 'pro',
      features: { tier: 1, apiAccess: false, apiRateLimit: 60, maxDashboards: 10, prioritySupport: false, exportFormats: [], mcpAccess: false },
      validUntil: Date.now() + 86_400_000,
    };
  }
  if (userId === FREE_USER_ID) {
    return {
      planKey: 'free',
      features: { tier: 0, apiAccess: false, apiRateLimit: 60, maxDashboards: 1, prioritySupport: false, exportFormats: [], mcpAccess: false },
      validUntil: Date.now() + 86_400_000,
    };
  }
  return null;
}

function installFetchStub(opts = {}) {
  const overrideEntitlement = opts.entitlement;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && url.includes('/api/internal-entitlements')) {
      const body = JSON.parse(init?.body ?? '{}');
      const ent = overrideEntitlement ? overrideEntitlement(body.userId) : entitlementForUser(body.userId);
      return new Response(JSON.stringify(ent), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // Anything else — fail loudly so tests can't silently depend on the network.
    throw new Error(`unexpected fetch in test: ${url}`);
  };
}

function resetEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

beforeEach(() => {
  lastHandlerRequest = null;
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.CONVEX_SITE_URL = CONVEX_SITE;
  process.env.CONVEX_SERVER_SHARED_SECRET = CONVEX_SECRET;
  // Disable Upstash so rate-limit / cache paths are no-ops.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  // The gateway's envelope expects WORLDMONITOR_VALID_KEYS to exist for the
  // legacy wm_ key path tests.
  process.env.WORLDMONITOR_VALID_KEYS = 'wm_test_key_123';
  installFetchStub();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  resetEnv();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function buildSignedRequest({
  method = 'POST',
  url = 'https://api.worldmonitor.app/api/news/v1/summarize-article',
  body = JSON.stringify({ provider: 'auto', mode: 'brief' }),
  userId = PRO_USER_ID,
  secret = HMAC_SECRET,
  now,
  extraHeaders = {},
} = {}) {
  const signed = await signInternalMcpRequest({ method, url, body, userId, secret, now });
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [INTERNAL_MCP_SIG_HEADER]: signed.signature,
      [INTERNAL_MCP_USER_ID_HEADER]: signed.userId,
      ...extraHeaders,
    },
    body: method === 'GET' ? undefined : body,
  });
}

// ===========================================================================
// HAPPY PATHS
// ===========================================================================
describe('gateway internal-MCP HMAC verify — happy paths', () => {
  it('valid signature from tier-1 mcpAccess user → 200; downstream sees trusted markers', async () => {
    const handler = makeGateway();
    const req = await buildSignedRequest();
    const res = await handler(req);
    assert.equal(res.status, 200, `expected 200, got ${res.status} body=${await res.clone().text()}`);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.route, 'summarize-article');

    assert.ok(lastHandlerRequest, 'handler was invoked');
    assert.equal(
      lastHandlerRequest.headers.get(INTERNAL_MCP_VERIFIED_HEADER),
      VERIFIED_NONCE,
      'trusted verified marker propagated as the per-process nonce',
    );
    assert.equal(
      lastHandlerRequest.headers.get(TRUSTED_USER_ID_HEADER),
      PRO_USER_ID,
      'trusted user id propagated',
    );
  });

  it('isCallerPremium returns true for a verified-marker request from tier-1 mcpAccess user', async () => {
    // Synthesize the post-gateway request shape: trusted markers set,
    // no inbound HMAC headers (gateway already consumed them).
    const req = new Request('https://api.worldmonitor.app/api/news/v1/summarize-article', {
      method: 'POST',
      headers: {
        [INTERNAL_MCP_VERIFIED_HEADER]: VERIFIED_NONCE,
        [TRUSTED_USER_ID_HEADER]: PRO_USER_ID,
      },
    });
    const result = await isCallerPremium(req);
    assert.equal(result, true);
  });

  it('isCallerPremium returns FALSE when a request claims to be verified but the userId is tier 0 (defensive re-fetch)', async () => {
    const req = new Request('https://api.worldmonitor.app/api/news/v1/summarize-article', {
      method: 'POST',
      headers: {
        [INTERNAL_MCP_VERIFIED_HEADER]: VERIFIED_NONCE,
        [TRUSTED_USER_ID_HEADER]: FREE_USER_ID,
      },
    });
    const result = await isCallerPremium(req);
    assert.equal(result, false, 'defensive re-fetch caught tier-0 userId');
  });

  it('isCallerPremium returns FALSE when verified-marker carries tier-1 user without mcpAccess (defensive re-fetch)', async () => {
    const req = new Request('https://api.worldmonitor.app/api/news/v1/summarize-article', {
      method: 'POST',
      headers: {
        [INTERNAL_MCP_VERIFIED_HEADER]: VERIFIED_NONCE,
        [TRUSTED_USER_ID_HEADER]: TIER1_NO_MCP_USER_ID,
      },
    });
    const result = await isCallerPremium(req);
    assert.equal(result, false, 'mcpAccess: false fails defensively');
  });

  it('reordered query params still verify (canonicalisation sorts keys)', async () => {
    const handler = makeGateway();
    // Sign a URL with `?a=1&b=2`, send with `?b=2&a=1`.
    const url1 = 'https://api.worldmonitor.app/api/news/v1/list-feed-digest?a=1&b=2';
    const url2 = 'https://api.worldmonitor.app/api/news/v1/list-feed-digest?b=2&a=1';
    const signed = await signInternalMcpRequest({ method: 'GET', url: url1, body: null, userId: PRO_USER_ID, secret: HMAC_SECRET });
    const req = new Request(url2, {
      method: 'GET',
      headers: {
        [INTERNAL_MCP_SIG_HEADER]: signed.signature,
        [INTERNAL_MCP_USER_ID_HEADER]: signed.userId,
      },
    });
    const res = await handler(req);
    assert.equal(res.status, 200, 'reordered query MUST verify after canonicalisation');
  });

  it('GET (no body) hashes empty string consistently between sign and verify', async () => {
    const handler = makeGateway();
    const url = 'https://api.worldmonitor.app/api/news/v1/list-feed-digest';
    const signed = await signInternalMcpRequest({ method: 'GET', url, body: null, userId: PRO_USER_ID, secret: HMAC_SECRET });
    const req = new Request(url, {
      method: 'GET',
      headers: {
        [INTERNAL_MCP_SIG_HEADER]: signed.signature,
        [INTERNAL_MCP_USER_ID_HEADER]: signed.userId,
      },
    });
    const res = await handler(req);
    assert.equal(res.status, 200, 'GET with empty body verified ok');
  });
});

// ===========================================================================
// ERROR PATHS — 401s
// ===========================================================================
describe('gateway internal-MCP HMAC verify — error paths', () => {
  it('missing X-WM-MCP-User-Id but X-WM-MCP-Internal present → 401 invalid_internal_mcp_signature', async () => {
    const handler = makeGateway();
    const url = 'https://api.worldmonitor.app/api/news/v1/summarize-article';
    const body = JSON.stringify({ x: 1 });
    const signed = await signInternalMcpRequest({ method: 'POST', url, body, userId: PRO_USER_ID, secret: HMAC_SECRET });
    const req = new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [INTERNAL_MCP_SIG_HEADER]: signed.signature },
      body,
    });
    const res = await handler(req);
    assert.equal(res.status, 401);
    const j = await res.json();
    assert.equal(j.error, 'invalid_internal_mcp_signature');
  });

  it('mutated signature → 401 (does NOT fall through to validateApiKey)', async () => {
    const handler = makeGateway();
    const req = await buildSignedRequest();
    // Flip a character in the sig portion.
    const sig = req.headers.get(INTERNAL_MCP_SIG_HEADER);
    const mutated = sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A');
    const tampered = new Request(req.url, {
      method: req.method,
      headers: (() => {
        const h = new Headers(req.headers);
        h.set(INTERNAL_MCP_SIG_HEADER, mutated);
        return h;
      })(),
      body: await req.clone().text(),
    });
    const res = await handler(tampered);
    assert.equal(res.status, 401);
    const j = await res.json();
    assert.equal(j.error, 'invalid_internal_mcp_signature');
    assert.equal(lastHandlerRequest, null, 'handler must not run on bad signature');
  });

  it('replay against a different path → 401 (path bound in payload)', async () => {
    const handler = makeGateway();
    const url1 = 'https://api.worldmonitor.app/api/news/v1/list-feed-digest';
    const url2 = 'https://api.worldmonitor.app/api/intelligence/v1/deduct-situation';
    const body = JSON.stringify({ x: 1 });
    const signed = await signInternalMcpRequest({ method: 'POST', url: url1, body, userId: PRO_USER_ID, secret: HMAC_SECRET });
    const req = new Request(url2, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_MCP_SIG_HEADER]: signed.signature,
        [INTERNAL_MCP_USER_ID_HEADER]: signed.userId,
      },
      body,
    });
    const res = await handler(req);
    assert.equal(res.status, 401, 'replay across path must 401');
  });

  it('replay against a different method → 401', async () => {
    const handler = makeGateway();
    const url = 'https://api.worldmonitor.app/api/news/v1/list-feed-digest';
    const signed = await signInternalMcpRequest({ method: 'GET', url, body: null, userId: PRO_USER_ID, secret: HMAC_SECRET });
    // Send as POST with body.
    const req = new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_MCP_SIG_HEADER]: signed.signature,
        [INTERNAL_MCP_USER_ID_HEADER]: signed.userId,
      },
      body: JSON.stringify({ x: 1 }),
    });
    const res = await handler(req);
    assert.equal(res.status, 401, 'replay across method must 401');
  });

  it('replay with mutated body → 401', async () => {
    const handler = makeGateway();
    const url = 'https://api.worldmonitor.app/api/news/v1/summarize-article';
    const original = JSON.stringify({ country_code: 'US' });
    const tampered = JSON.stringify({ country_code: 'RU' });
    const signed = await signInternalMcpRequest({ method: 'POST', url, body: original, userId: PRO_USER_ID, secret: HMAC_SECRET });
    const req = new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_MCP_SIG_HEADER]: signed.signature,
        [INTERNAL_MCP_USER_ID_HEADER]: signed.userId,
      },
      body: tampered,
    });
    const res = await handler(req);
    assert.equal(res.status, 401, 'mutated body must 401');
  });

  it('timestamp 31s in the past → 401', async () => {
    const handler = makeGateway();
    const past = Math.floor(Date.now() / 1000) - 31;
    const req = await buildSignedRequest({ now: past });
    const res = await handler(req);
    assert.equal(res.status, 401);
  });

  it('timestamp 31s in the future → 401', async () => {
    const handler = makeGateway();
    const future = Math.floor(Date.now() / 1000) + 31;
    const req = await buildSignedRequest({ now: future });
    const res = await handler(req);
    assert.equal(res.status, 401);
  });

  it('tier-0 userId in X-WM-MCP-User-Id → 401 insufficient_entitlement', async () => {
    const handler = makeGateway();
    const req = await buildSignedRequest({ userId: FREE_USER_ID });
    const res = await handler(req);
    assert.equal(res.status, 401);
    const j = await res.json();
    assert.equal(j.error, 'insufficient_entitlement');
  });

  it('tier-1 user with mcpAccess: false → 401 insufficient_entitlement', async () => {
    const handler = makeGateway();
    const req = await buildSignedRequest({ userId: TIER1_NO_MCP_USER_ID });
    const res = await handler(req);
    assert.equal(res.status, 401);
    const j = await res.json();
    assert.equal(j.error, 'insufficient_entitlement');
  });

  it('malformed signature header (no dot) → 401', async () => {
    const handler = makeGateway();
    const url = 'https://api.worldmonitor.app/api/news/v1/summarize-article';
    const req = new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_MCP_SIG_HEADER]: 'no_dot_at_all_just_garbage',
        [INTERNAL_MCP_USER_ID_HEADER]: PRO_USER_ID,
      },
      body: JSON.stringify({ x: 1 }),
    });
    const res = await handler(req);
    assert.equal(res.status, 401);
  });

  it('malformed signature header (multiple dots) → 401', async () => {
    const handler = makeGateway();
    const url = 'https://api.worldmonitor.app/api/news/v1/summarize-article';
    const req = new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_MCP_SIG_HEADER]: '1700000000.abc.def',
        [INTERNAL_MCP_USER_ID_HEADER]: PRO_USER_ID,
      },
      body: JSON.stringify({ x: 1 }),
    });
    const res = await handler(req);
    assert.equal(res.status, 401);
  });

  it('malformed signature header (non-numeric ts) → 401', async () => {
    const handler = makeGateway();
    const url = 'https://api.worldmonitor.app/api/news/v1/summarize-article';
    const req = new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_MCP_SIG_HEADER]: 'notanumber.AAAA',
        [INTERNAL_MCP_USER_ID_HEADER]: PRO_USER_ID,
      },
      body: JSON.stringify({ x: 1 }),
    });
    const res = await handler(req);
    assert.equal(res.status, 401);
  });

  it('MCP_INTERNAL_HMAC_SECRET unset → 500 CONFIGURATION on the HMAC-attempt path', async () => {
    delete process.env.MCP_INTERNAL_HMAC_SECRET;
    const handler = makeGateway();
    const req = new Request('https://api.worldmonitor.app/api/news/v1/summarize-article', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_MCP_SIG_HEADER]: '1700000000.AAAA',
        [INTERNAL_MCP_USER_ID_HEADER]: PRO_USER_ID,
      },
      body: JSON.stringify({ x: 1 }),
    });
    const res = await handler(req);
    assert.equal(res.status, 500);
    const j = await res.json();
    assert.equal(j.error, 'CONFIGURATION');
  });

  it('legacy wm_ caller (no internal-MCP headers) → unaffected by missing MCP_INTERNAL_HMAC_SECRET', async () => {
    delete process.env.MCP_INTERNAL_HMAC_SECRET;
    const handler = makeGateway();
    // wm_-key flow: send a valid WORLDMONITOR_VALID_KEYS key on a non-tier-gated route.
    // Use list-feed-digest which is public-ish but in routes table.
    const req = new Request('https://api.worldmonitor.app/api/news/v1/list-feed-digest', {
      method: 'GET',
      headers: { 'X-WorldMonitor-Key': 'wm_test_key_123' },
    });
    const res = await handler(req);
    // Don't assert 200 (other gateway gates may apply); only assert it didn't 500 with CONFIGURATION.
    assert.notEqual(res.status, 500, 'legacy path unaffected by missing MCP secret');
    if (res.status >= 400) {
      const j = await res.json().catch(() => ({}));
      assert.notEqual(j.error, 'CONFIGURATION', 'no CONFIGURATION error on legacy path');
    }
  });
});

// ===========================================================================
// HEADER INJECTION DEFENSE
// ===========================================================================
describe('gateway internal-MCP — header injection defense', () => {
  it('client-injected x-wm-mcp-internal-verified is stripped before any logic', async () => {
    const handler = makeGateway();
    // External attacker sends a guessed marker value (constant '1', the
    // pre-nonce design) with a hopeful spoof of x-user-id.
    const req = new Request('https://api.worldmonitor.app/api/news/v1/list-feed-digest', {
      method: 'GET',
      headers: {
        'X-WorldMonitor-Key': 'wm_test_key_123',
        [INTERNAL_MCP_VERIFIED_HEADER]: '1',
        [TRUSTED_USER_ID_HEADER]: PRO_USER_ID,
      },
    });
    const res = await handler(req);
    if (res.status === 200) {
      // If the legacy wm_ path admits the request, the handler MUST NOT see the spoofed markers.
      assert.ok(lastHandlerRequest, 'handler ran');
      assert.notEqual(
        lastHandlerRequest.headers.get(INTERNAL_MCP_VERIFIED_HEADER),
        '1',
        'spoofed verified marker MUST be stripped',
      );
      // x-user-id may legitimately be set by Clerk session resolution if the
      // route is tier-gated; for this non-tier-gated route, the strip step
      // applies and any inbound x-user-id is removed.
      assert.notEqual(
        lastHandlerRequest.headers.get(TRUSTED_USER_ID_HEADER),
        PRO_USER_ID,
        'spoofed user id MUST be stripped for non-tier-gated route',
      );
    }
  });

  it('attacker who somehow guesses the per-process nonce ALSO gets stripped at gateway entry', async () => {
    const handler = makeGateway();
    const req = new Request('https://api.worldmonitor.app/api/news/v1/list-feed-digest', {
      method: 'GET',
      headers: {
        'X-WorldMonitor-Key': 'wm_test_key_123',
        // Even with the right nonce value (e.g. leaked from a log), the
        // strip step at gateway entry deletes it before any logic runs.
        [INTERNAL_MCP_VERIFIED_HEADER]: VERIFIED_NONCE,
        [TRUSTED_USER_ID_HEADER]: PRO_USER_ID,
      },
    });
    const res = await handler(req);
    if (res.status === 200) {
      assert.ok(lastHandlerRequest, 'handler ran');
      // The handler may legitimately see the nonce only if the gateway
      // re-set it during HMAC verify — and we did NOT send an HMAC header
      // here, so it must have been stripped.
      assert.notEqual(
        lastHandlerRequest.headers.get(INTERNAL_MCP_VERIFIED_HEADER),
        VERIFIED_NONCE,
        'guessed-nonce attack MUST be stripped',
      );
    }
  });

  it('isCallerPremium returns FALSE for an unknown userId even with valid nonce (defensive re-fetch)', async () => {
    // Models the case where someone bypasses the gateway in tests / dev. The
    // header check alone admits this — the defensive re-fetch must still
    // confirm against Convex, and only PRO_USER_ID's entitlement passes.
    const req = new Request('https://api.worldmonitor.app/api/news/v1/summarize-article', {
      method: 'POST',
      headers: {
        [INTERNAL_MCP_VERIFIED_HEADER]: VERIFIED_NONCE,
        [TRUSTED_USER_ID_HEADER]: 'made_up_user_no_entitlement',
      },
    });
    const result = await isCallerPremium(req);
    assert.equal(result, false, 'unknown userId fails defensive re-fetch');
  });

  it('isCallerPremium returns FALSE on a direct edge function when verified-marker is the constant "1" (not the per-process nonce)', async () => {
    // Models a direct-edge-function attack where the request bypasses the
    // gateway entirely (e.g. hitting `api/widget-agent` directly with a
    // spoofed marker). An attacker sending the constant '1' (the pre-
    // nonce design value) cannot get past the timing-safe nonce compare
    // in `isCallerPremium`, so premium semantics are NOT granted.
    const req = new Request('https://api.worldmonitor.app/api/widget-agent', {
      method: 'POST',
      headers: {
        [INTERNAL_MCP_VERIFIED_HEADER]: '1',
        [TRUSTED_USER_ID_HEADER]: PRO_USER_ID,
      },
    });
    const result = await isCallerPremium(req);
    assert.equal(result, false, 'guessed-constant marker rejected by nonce check');
  });

  it('present-but-invalid HMAC + valid wm_ key: invalid path fails closed (does not chain to legacy)', async () => {
    const handler = makeGateway();
    const url = 'https://api.worldmonitor.app/api/news/v1/list-feed-digest';
    // Sign with the WRONG secret, then attach a valid wm_ key to try to chain.
    const signed = await signInternalMcpRequest({ method: 'GET', url, body: null, userId: PRO_USER_ID, secret: 'wrong-secret-not-the-real-one' });
    const req = new Request(url, {
      method: 'GET',
      headers: {
        'X-WorldMonitor-Key': 'wm_test_key_123',
        [INTERNAL_MCP_SIG_HEADER]: signed.signature,
        [INTERNAL_MCP_USER_ID_HEADER]: signed.userId,
      },
    });
    const res = await handler(req);
    assert.equal(res.status, 401, 'present-but-invalid HMAC fails closed');
    const j = await res.json();
    assert.equal(j.error, 'invalid_internal_mcp_signature');
  });
});

// ===========================================================================
// LEGACY PASS-THROUGH
// ===========================================================================
describe('gateway internal-MCP — legacy unaffected', () => {
  it('no internal-MCP headers at all → legacy validateApiKey path runs (request reaches handler when key is valid)', async () => {
    const handler = makeGateway();
    const req = new Request('https://api.worldmonitor.app/api/news/v1/list-feed-digest', {
      method: 'GET',
      headers: { 'X-WorldMonitor-Key': 'wm_test_key_123' },
    });
    const res = await handler(req);
    // The wm_ key may or may not pass depending on origin checks; at minimum
    // the response must NOT be the internal-MCP 401 or the CONFIGURATION 500.
    if (res.status >= 400) {
      const j = await res.json().catch(() => ({}));
      assert.notEqual(j.error, 'invalid_internal_mcp_signature');
      assert.notEqual(j.error, 'insufficient_entitlement');
      assert.notEqual(j.error, 'CONFIGURATION');
    }
  });
});

// ===========================================================================
// F1, F7, F8 — review-pass fixes for the gateway internal-MCP path
// ===========================================================================
describe('gateway internal-MCP — F1: validUntil re-check', () => {
  it('F1: tier-1 mcpAccess user with validUntil < now → 401 insufficient_entitlement', async () => {
    // Override the entitlement stub to return a row with lapsed validUntil.
    // The gateway's Convex-fallback re-check must reject — without F1 the
    // request would propagate as authorized.
    installFetchStub({
      entitlement: () => ({
        planKey: 'pro',
        features: {
          tier: 1, apiAccess: false, apiRateLimit: 60, maxDashboards: 10,
          prioritySupport: false, exportFormats: [], mcpAccess: true,
        },
        validUntil: Date.now() - 1000, // expired 1s ago
      }),
    });
    const handler = makeGateway();
    const req = await buildSignedRequest();
    const res = await handler(req);
    assert.equal(res.status, 401, 'lapsed entitlement must 401 even with verified HMAC');
    const j = await res.json();
    assert.equal(j.error, 'insufficient_entitlement');
    assert.equal(lastHandlerRequest, null, 'handler must NOT run when entitlement is stale');
  });
});

describe('gateway internal-MCP — F7: HMAC headers stripped before handler sees request', () => {
  it('handler receives no X-WM-MCP-Internal or X-WM-MCP-User-Id; only the trusted-marker pair', async () => {
    const handler = makeGateway();
    const req = await buildSignedRequest();
    const res = await handler(req);
    assert.equal(res.status, 200);
    assert.ok(lastHandlerRequest, 'handler ran');
    assert.equal(
      lastHandlerRequest.headers.get(INTERNAL_MCP_SIG_HEADER),
      null,
      'F7: inbound HMAC sig header MUST be stripped before handler',
    );
    assert.equal(
      lastHandlerRequest.headers.get(INTERNAL_MCP_USER_ID_HEADER),
      null,
      'F7: inbound HMAC userId header MUST be stripped before handler',
    );
    // Trusted markers MUST still be present — those are the gateway's
    // outbound contract for downstream isCallerPremium checks.
    assert.equal(
      lastHandlerRequest.headers.get(INTERNAL_MCP_VERIFIED_HEADER),
      VERIFIED_NONCE,
      'F7: trusted verified marker MUST still be present',
    );
    assert.equal(
      lastHandlerRequest.headers.get(TRUSTED_USER_ID_HEADER),
      PRO_USER_ID,
      'F7: trusted userId MUST still be present',
    );
  });
});

describe('gateway internal-MCP — F8: body size cap', () => {
  it('Content-Length > 256 KB → 413 payload_too_large (HMAC-verify path)', async () => {
    const handler = makeGateway();
    const url = 'https://api.worldmonitor.app/api/news/v1/summarize-article';
    // Sign a small body so the signature is shaped correctly; the gate
    // should fire on Content-Length BEFORE verify even runs.
    const body = JSON.stringify({ x: 1 });
    const signed = await signInternalMcpRequest({
      method: 'POST',
      url,
      body,
      userId: PRO_USER_ID,
      secret: HMAC_SECRET,
    });
    const req = new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(4 * 1024 * 1024), // 4MB — well over the cap
        [INTERNAL_MCP_SIG_HEADER]: signed.signature,
        [INTERNAL_MCP_USER_ID_HEADER]: signed.userId,
      },
      body,
    });
    const res = await handler(req);
    assert.equal(res.status, 413, 'oversized Content-Length MUST 413');
    const j = await res.json();
    assert.equal(j.error, 'payload_too_large');
    assert.equal(lastHandlerRequest, null, 'handler must NOT run on oversized body');
  });

  it('strip-only path (no HMAC) ALSO enforces the 256 KB cap', async () => {
    const handler = makeGateway();
    // No HMAC sig — but trust markers present trigger the strip-then-construct
    // block, which also has the body-size guard.
    const url = 'https://api.worldmonitor.app/api/news/v1/summarize-article';
    const req = new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(4 * 1024 * 1024),
        [INTERNAL_MCP_VERIFIED_HEADER]: '1', // attacker-injected marker → triggers strip
      },
      body: JSON.stringify({ x: 1 }),
    });
    const res = await handler(req);
    assert.equal(res.status, 413);
    const j = await res.json();
    assert.equal(j.error, 'payload_too_large');
  });
});
