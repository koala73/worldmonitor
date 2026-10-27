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
let signExpiredToken: (claims: Record<string, unknown>) => Promise<string>;
let resolvePremiumCallerIdentity: typeof import('../server/_shared/premium-check.ts')['resolvePremiumCallerIdentity'];
let widgetHandler: typeof import('../api/widget-agent.ts')['default'];
let bearerEntitlements: Record<string, unknown>;
const policyUsers: string[] = [];
const cacheReads: string[] = [];

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
  process.env.WIDGET_AGENT_KEY = 'test-widget-server';
  process.env.PRO_WIDGET_KEY = 'test-widget-pro';
  delete process.env.WORLDMONITOR_VALID_KEYS;
  bearerEntitlements = FREE_ROW;

  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  signToken = (claims) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  signExpiredToken = (claims) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(privateKey);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
    if (url.includes('/.well-known/jwks.json')) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Redis always misses so every lookup reaches the Convex fallback below.
    if (url.includes('redis.test/get/')) {
      cacheReads.push(decodeURIComponent(url.split('/get/')[1]));
      return new Response(JSON.stringify({ result: undefined }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/internal-ai-routing-policy')) {
      policyUsers.push(JSON.parse(String(init?.body)).userId);
      return Response.json({ policy: { allowedProviders: ['anthropic'] } });
    }
    if (url.includes('redis.test')) {
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (url.includes('/api/internal-entitlements')) {
      return new Response(JSON.stringify(bearerEntitlements), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/internal-validate-api-key')) {
      return Response.json({ id: 'retained-key', userId: 'user_free_key', keyKind: 'api', activeKeyRank: 0 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  ({ resolvePremiumCallerIdentity } = await import('../server/_shared/premium-check.ts'));
  ({ default: widgetHandler } = await import('../api/widget-agent.ts'));
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
  it('retains a verified free bearer identity for translation routing', async () => {
    const { resolveAiRouting } = await import('../server/_shared/ai-routing-policy.ts');
    const request = bearerRequest(await signToken({ sub: 'user_free_policy', plan: 'free' }));
    const identity = await resolvePremiumCallerIdentity(request);
    assert.equal(identity.isPremium, false);
    assert.deepEqual(await resolveAiRouting(request, identity.userId), { kind: 'restricted', allowedProviders: ['anthropic'] });
    assert.ok(policyUsers.includes('user_free_policy'));
  });

  it('applies the signer\'s policy to an expired bearer instead of failing closed', async () => {
    const { resolveAiRouting } = await import('../server/_shared/ai-routing-policy.ts');
    // Clerk session tokens live ~60s, so a restricted customer's request often
    // carries one that just expired; it must still be held to their policy.
    const request = bearerRequest(await signExpiredToken({ sub: 'user_expired_policy', plan: 'free' }));
    assert.deepEqual(await resolveAiRouting(request), { kind: 'restricted', allowedProviders: ['anthropic'] });
    assert.ok(policyUsers.includes('user_expired_policy'));
  });

  it('treats an unverifiable-by-signature bearer as an anonymous caller', async () => {
    const { resolveAiRouting } = await import('../server/_shared/ai-routing-policy.ts');
    const { privateKey } = await generateKeyPair('RS256');
    const foreign = await new SignJWT({ sub: 'user_forged' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    for (const token of ['not-a-jwt', foreign]) {
      assert.deepEqual(await resolveAiRouting(bearerRequest(token)), { kind: 'default' });
    }
    assert.ok(!policyUsers.includes('user_forged'));
  });

  it('fails closed when the bearer cannot be verified at all', async () => {
    const { resolveAiRouting } = await import('../server/_shared/ai-routing-policy.ts');
    const { __resetJwksForTests } = await import('../server/auth-session.ts');
    const saved = process.env.CLERK_JWT_ISSUER_DOMAIN;
    delete process.env.CLERK_JWT_ISSUER_DOMAIN;
    __resetJwksForTests();
    try {
      const request = bearerRequest(await signToken({ sub: 'user_unverifiable', plan: 'free' }));
      assert.equal((await resolveAiRouting(request)).kind, 'unavailable');
    } finally {
      process.env.CLERK_JWT_ISSUER_DOMAIN = saved;
      __resetJwksForTests();
    }
  });

  it('reads only the verified bearer policy namespace on the public summary cache route', async () => {
    const { getSummarizeArticleCache } = await import('../server/worldmonitor/news/v1/get-summarize-article-cache.ts');
    const { buildSummaryCacheKey } = await import('../src/utils/summary-cache-key.ts');
    const cacheKey = await buildSummaryCacheKey(['Policy cache story'], 'translate', '', 'fr', 'en');
    const request = bearerRequest(await signToken({ sub: 'user_cache_policy', plan: 'free' }));
    await getSummarizeArticleCache({ request } as never, { cacheKey });
    assert.ok(cacheReads.some(key => key.endsWith(`${cacheKey}:ai=anthropic`)), cacheReads.join('\n'));
  });

  it('blocks restricted widget content before reserving spend or forwarding it to Anthropic', async () => {
    const { __setWidgetAgentSpendDepsForTests } = await import('../api/widget-agent.ts');
    let quotaCalls = 0;
    __setWidgetAgentSpendDepsForTests({ checkRateLimit: async () => null, runRedisPipeline: async () => { quotaCalls++; return [{ result: 1 }, { result: 1 }]; } });
    const original = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes('/api/internal-ai-routing-policy')) return Response.json({ policy: { allowedProviders: ['ollama'] } });
      return original(input, init);
    }) as typeof fetch;
    try {
      const token = await signToken({ sub: 'user_widget_policy', plan: 'pro' });
      const response = await widgetHandler(new Request('https://www.worldmonitor.app/api/widget-agent', {
        method: 'POST', headers: { Origin: 'https://www.worldmonitor.app', Authorization: `Bearer ${token}` }, body: '{"prompt":"private"}',
      }));
      assert.equal(quotaCalls, 0);
      assert.equal(response.status, 403);
    } finally {
      globalThis.fetch = original;
      __setWidgetAgentSpendDepsForTests(null);
    }
  });
  it('forwards an entitled widget request when its policy permits Anthropic', async () => {
    const { __setWidgetAgentSpendDepsForTests } = await import('../api/widget-agent.ts');
    __setWidgetAgentSpendDepsForTests({ checkRateLimit: async () => null, runRedisPipeline: async () => [{ result: 1 }, { result: 1 }] });
    const original = globalThis.fetch;
    let forwarded = false;
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith('/widget-agent')) {
        forwarded = true;
        return new Response('data: {"type":"done"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      const token = await signToken({ sub: 'user_widget_allowed', plan: 'pro' });
      const response = await widgetHandler(new Request('https://www.worldmonitor.app/api/widget-agent', {
        method: 'POST', headers: { Origin: 'https://www.worldmonitor.app', Authorization: `Bearer ${token}` }, body: '{"prompt":"weather","mode":"create"}',
      }));
      assert.equal(response.status, 200, await response.text());
      assert.equal(forwarded, true);
    } finally {
      globalThis.fetch = original;
      __setWidgetAgentSpendDepsForTests(null);
    }
  });
  it('does not replace a retained secondary key scope with a premium bearer', async () => {
    const token = await signToken({ sub: 'user_pro_bearer', plan: 'pro' });
    const request = new Request('https://api.worldmonitor.app/api/v2/shipping/webhooks/own/rotate-secret', {
      method: 'POST', headers: { 'X-WorldMonitor-Key': '', 'X-Api-Key': `wm_${'a'.repeat(40)}`, Authorization: `Bearer ${token}` },
    });
    const identity = await resolvePremiumCallerIdentity(request);
    assert.equal(identity.isPremium, false);
  });

  it('rejects an expired paid marker at the widget gate', async () => {
    bearerEntitlements = { ...FREE_ROW, features: { ...FREE_ROW.features, tier: 1 }, validUntil: Date.now() - 1, billingStatus: 'renewal_verification_pending' };
    const { __setWidgetAgentSpendDepsForTests } = await import('../api/widget-agent.ts');
    let quotaCalls = 0;
    __setWidgetAgentSpendDepsForTests({ checkRateLimit: async () => null, runRedisPipeline: async () => { quotaCalls++; return [{ result: 1 }, { result: 1 }]; } });
    try {
      const token = await signToken({ sub: 'user_widget_expired', plan: 'free' });
      const response = await widgetHandler(new Request('https://www.worldmonitor.app/api/widget-agent', {
        method: 'POST', headers: { Origin: 'https://www.worldmonitor.app', Authorization: `Bearer ${token}` }, body: '{"prompt":"weather"}',
      }));
      assert.equal(quotaCalls, 0);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('X-Billing-Verification'), 'renewal_verification_pending');
    } finally {
      bearerEntitlements = FREE_ROW;
      __setWidgetAgentSpendDepsForTests(null);
    }
  });
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
