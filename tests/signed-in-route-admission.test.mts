// Signed-in standalone routes charge a per-user budget after the local JWT
// check and before any other outbound call: the Clerk plan lookup, Convex,
// or a Redis read. The token here has no `plan` claim, so a route that
// resolved the plan first would call Clerk before the limiter.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const ISSUER = 'https://clerk.test';
const REDIS = 'https://redis.test';
const ORIGIN = 'https://worldmonitor.app';
const ENV = {
  CLERK_JWT_ISSUER_DOMAIN: ISSUER,
  UPSTASH_REDIS_REST_URL: REDIS,
  UPSTASH_REDIS_REST_TOKEN: 'tok',
  BRIEF_URL_SIGNING_SECRET: 'brief-secret',
  BRIEF_SHARE_SECRET: 'share-secret',
  CONVEX_SITE_URL: 'https://convex.test',
  CONVEX_SERVER_SHARED_SECRET: 'convex-secret',
  CLERK_SECRET_KEY: 'sk_test_admission',
};
const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
Object.assign(process.env, ENV);

const { __resetJwksForTests } = await import('../server/auth-session.ts');
// @ts-expect-error — JS module, no declaration file
const { __resetRateLimitForTest } = await import('../api/_rate-limit.js');

const ROUTES = [
  { file: 'me/entitlement', scope: 'me-entitlement', method: 'GET' },
  { file: 'referral/me', scope: 'referral-me', method: 'GET' },
  { file: 'latest-brief', scope: 'latest-brief', method: 'GET' },
  { file: 'brief/share-url', scope: 'brief-share-url', method: 'POST', body: {} },
  { file: 'invalidate-user-api-key-cache', scope: 'invalidate-user-api-key-cache', method: 'POST', body: { keyHash: 'a'.repeat(64) } },
  { file: 'user/mcp-quota', scope: 'mcp-quota', method: 'GET' },
  { file: 'user/mcp-revoke', scope: 'mcp-revoke', method: 'POST', body: { tokenId: 'tok_1' } },
  { file: 'internal/mcp-grant-context', scope: 'mcp-grant-context', method: 'GET', query: '?nonce=n1', failClosed: true },
];

const originalFetch = globalThis.fetch;
let signingKey: CryptoKey;
let userCount = 0;
let userId = '';
let jwk: Record<string, unknown> = {};
let limiterMode: 'allow' | 'deny' | 'outage' = 'allow';
let limiterBodies: string[] = [];
let backend: string[] = [];

before(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  signingKey = privateKey;
  jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k1', use: 'sig' };
});

beforeEach(() => {
  __resetJwksForTests();
  __resetRateLimitForTest();
  limiterMode = 'allow';
  limiterBodies = [];
  backend = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    const body = typeof init?.body === 'string' ? init.body : '';
    if (url.startsWith(REDIS) && body.includes('"rl:')) {
      limiterBodies.push(body);
      if (limiterMode === 'outage') throw new Error('limiter unavailable');
      // Sliding-window reply is [remainingTokens, effectiveLimit]; success = remaining >= 0.
      const result = limiterMode === 'deny' ? [-1, 20] : [19, 20];
      const parsed = JSON.parse(body);
      return Array.isArray(parsed[0]) ? Response.json(parsed.map(() => ({ result }))) : Response.json({ result });
    }
    backend.push(url);
    return Response.json({ result: null });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// A fresh user per call, because the Clerk plan answer is cached per user.
async function call(route: (typeof ROUTES)[number]): Promise<Response> {
  userId = `user_${++userCount}`;
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setSubject(userId)
    .setAudience('convex')
    .setExpirationTime('5m')
    .sign(signingKey);
  const { default: handler } = await import(`../api/${route.file}.ts`);
  const req = new Request(`${ORIGIN}/api/${route.file}${route.query ?? ''}`, {
    method: route.method,
    headers: { authorization: `Bearer ${jwt}`, origin: ORIGIN, 'content-type': 'application/json' },
    ...(route.body ? { body: JSON.stringify(route.body) } : {}),
  });
  return handler(req, { waitUntil() {} });
}

for (const route of ROUTES) {
  describe(`api/${route.file}`, () => {
    it('charges its own per-user scope', async () => {
      const response = await call(route);
      assert.notEqual(response.status, 429);
      assert.ok(limiterBodies.some((b) => b.includes(`rl:${route.scope}`) && b.includes(`user:${userId}`)), limiterBodies.join('\n'));
    });

    it('a caller over the budget gets a 429 and no Clerk, Convex or Redis call runs', async () => {
      limiterMode = 'deny';
      const response = await call(route);
      assert.equal(response.status, 429);
      assert.ok(response.headers.get('Retry-After'));
      assert.deepEqual(backend, []);
    });

    if (route.failClosed) {
      it('a limiter outage fails closed before any backend call', async () => {
        limiterMode = 'outage';
        const response = await call(route);
        assert.equal(response.status, 503);
        assert.deepEqual(backend, []);
      });
    } else {
      it('a limiter outage lets the caller through', async () => {
        limiterMode = 'outage';
        const response = await call(route);
        assert.notEqual(response.status, 429);
        assert.equal(response.headers.get('X-RateLimit-Mode'), null);
      });
    }
  });
}
