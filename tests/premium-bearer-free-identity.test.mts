/**
 * #5619 follow-up — the bearer arm's own lines, exercised by a real token.
 *
 * `tests/premium-unauthenticated-denial.test.mts` proves a CONFIRMED free
 * account is not flagged `unauthenticated`, but it drives that assertion
 * through the internal-MCP verified-marker branch. Real signed-in users arrive
 * on the BEARER branch, and its own lines — the `session.valid` check, the
 * `role === 'pro'` check, and the fall-through into `denyFor` — are not covered
 * by that path. A regression confined to those lines (say, routing a valid
 * free session to UNAUTHENTICATED) would replace a working upsell with a
 * sign-in loop for every free user, and the existing suite would stay green.
 *
 * This file mints a real RS256 token and serves a matching JWKS, so
 * validateBearerToken genuinely verifies it.
 *
 * It lives in its own file on purpose: `server/auth-session.ts` reads
 * CLERK_JWT_ISSUER_DOMAIN into a module-scope const at import time for its
 * issuer check, so the env must be set BEFORE the first import. Everything
 * below therefore uses dynamic import.
 */
import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';

import { SignJWT, exportJWK, generateKeyPair } from 'jose';

const ISSUER = 'https://clerk-bearer-test.example';
const ORIGINAL_ENV = { ...process.env };

let signToken: (claims: Record<string, unknown>) => Promise<string>;
let resolvePremiumCallerIdentity: typeof import('../server/_shared/premium-check.ts')['resolvePremiumCallerIdentity'];

const FREE_ROW = {
  planKey: 'free',
  features: {
    tier: 0,
    apiAccess: false,
    apiRateLimit: 0,
    maxDashboards: 3,
    prioritySupport: false,
    exportFormats: ['csv'],
    mcpAccess: false,
  },
  validUntil: 0,
};

before(async () => {
  // Set BEFORE the first import of auth-session (see file header).
  process.env.CLERK_JWT_ISSUER_DOMAIN = ISSUER;
  process.env.CONVEX_SITE_URL = 'https://fake.convex.site';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'fake-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  delete process.env.WORLDMONITOR_VALID_KEYS;

  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  signToken = (claims) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
    if (url.includes('/.well-known/jwks.json')) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Redis always misses so every lookup reaches the Convex fallback below.
    if (url.includes('redis.test/get/')) {
      return new Response(JSON.stringify({ result: undefined }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('redis.test')) {
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (url.includes('/api/internal-entitlements')) {
      return new Response(JSON.stringify(FREE_ROW), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  ({ resolvePremiumCallerIdentity } = await import('../server/_shared/premium-check.ts'));
});

after(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

function bearerRequest(token: string): Request {
  return new Request('https://api.worldmonitor.app/api/chat-analyst', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://worldmonitor.app',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: 'what is happening in the strait of hormuz' }),
  });
}

describe('the bearer arm of resolvePremiumCallerIdentity (#5619 follow-up)', () => {
  it('a CONFIRMED free session is denied as a plan verdict, never as unauthenticated', async () => {
    // The property the internal-MCP fixture cannot prove: a real signed-in free
    // user reaches denyFor via the bearer branch and must keep the honest
    // upsell. Flagging them unauthenticated would swap it for a sign-in loop.
    const token = await signToken({ sub: 'user_free_bearer', plan: 'free' });

    const identity = await resolvePremiumCallerIdentity(bearerRequest(token));

    assert.equal(identity.isPremium, false);
    assert.equal(identity.unauthenticated, undefined);
    assert.equal(identity.billingDenial, undefined, 'a confirmed row carries no denial tag');
  });

  it('a Clerk role=pro session is premium without consulting the entitlement backend', async () => {
    const token = await signToken({ sub: 'user_pro_bearer', plan: 'pro' });

    const identity = await resolvePremiumCallerIdentity(bearerRequest(token));

    assert.equal(identity.isPremium, true);
    assert.equal(identity.userId, 'user_pro_bearer');
    assert.equal(identity.kind, 'bearer');
  });

  it('a token that fails verification IS unauthenticated', async () => {
    // The other side of the split added in this change: a genuinely bad token
    // still gets the terminal 401, so the retryable path did not swallow it.
    const identity = await resolvePremiumCallerIdentity(bearerRequest('not.a.jwt'));

    assert.equal(identity.isPremium, false);
    assert.equal(identity.unauthenticated, true);
    assert.equal(identity.billingDenial, undefined);
  });
});
