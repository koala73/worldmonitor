import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, it, before, after, mock } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

import { createDomainGateway } from '../server/gateway.ts';
import { issueSessionToken } from '../api/_session.js';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

const originalKeys = process.env.WORLDMONITOR_VALID_KEYS;
const originalSessionSecret = process.env.WM_SESSION_SECRET;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalFetch = globalThis.fetch;

function installRateLimitRedisFake(): void {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  const { fetchImpl } = createRedisFetch({});
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url.startsWith(process.env.UPSTASH_REDIS_REST_URL || '')) {
      return fetchImpl(input, init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

// Public routes now require a wms_ session token (issue #3541) — header-only
// origin trust is gone. Mint one for tests that previously relied on
// "trusted browser origin = anonymous public read."
process.env.WM_SESSION_SECRET = originalSessionSecret
  ?? 'test-secret-must-be-at-least-32-chars-long-xxx';
let SESSION_TOKEN: string;
before(async () => {
  installRateLimitRedisFake();
  SESSION_TOKEN = (await issueSessionToken()).token;
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
});

afterEach(() => {
  if (originalKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = originalKeys;
  installRateLimitRedisFake();
  // Keep the session secret stable across tests so SESSION_TOKEN stays valid.
  process.env.WM_SESSION_SECRET = originalSessionSecret
    ?? 'test-secret-must-be-at-least-32-chars-long-xxx';
});

describe('premium gateway API key enforcement', () => {
  it('enforces premium credentials while allowing public market session auth', async () => {
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/analyze-stock',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-ranking',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/market/v1/get-insider-transactions',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
    ]);

    process.env.WORLDMONITOR_VALID_KEYS = 'real-key-123';

    // Trusted browser origin without credentials — 401 (no API key, no bearer token)
    const browserNoKey = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(browserNoKey.status, 401);
    assert.deepEqual(await browserNoKey.json(), { error: 'API key required' });

    const resilienceScoreNoKey = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(resilienceScoreNoKey.status, 401);

    const resilienceRankingNoKey = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(resilienceRankingNoKey.status, 401);

    // Trusted browser origin with valid API key — 200 (API-key holders bypass entitlement check)
    const browserWithKey = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': 'real-key-123',
      },
    }));
    assert.equal(browserWithKey.status, 200);

    const resilienceScoreWithKey = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': 'real-key-123',
      },
    }));
    assert.equal(resilienceScoreWithKey.status, 200);

    const resilienceRankingWithKey = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking', {
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': 'real-key-123',
      },
    }));
    assert.equal(resilienceRankingWithKey.status, 200);

    // Unknown origin — blocked (403 from isDisallowedOrigin before key check)
    const unknownNoKey = await handler(new Request('https://external.example.com/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: { Origin: 'https://external.example.com' },
    }));
    assert.equal(unknownNoKey.status, 403);

    // Public endpoints — anonymous browsers authenticate via the wms_ session token
    // (issue #3541; previously this was a trusted-origin bypass).
    const publicAllowed = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
    }));
    assert.equal(publicAllowed.status, 200);

    const insiderTransactionsAllowed = await handler(new Request('https://worldmonitor.app/api/market/v1/get-insider-transactions?symbol=AAPL', {
      headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
    }));
    assert.equal(insiderTransactionsAllowed.status, 200);
  });

  it('PR #3557 review: anonymous wms_ session token does NOT unlock premium endpoints', async () => {
    // Regression: an earlier revision returned valid:true for wms_ tokens and
    // the gateway treated any non-wm_ valid key as enterprise → entitlement
    // check skipped → premium content served to any anonymous caller. Lock the
    // contract: wms_ on a premium route must 401 (no Pro auth) — never 200.
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/analyze-stock',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
    ]);

    for (const path of ['/api/market/v1/analyze-stock?symbol=AAPL', '/api/resilience/v1/get-resilience-score?countryCode=US']) {
      const res = await handler(new Request(`https://worldmonitor.app${path}`, {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }));
      assert.notEqual(res.status, 200, `wms_ MUST NOT unlock ${path} (got ${res.status})`);
    }
  });

  it('strips client-supplied x-user-id before an anonymous session reaches handlers', async () => {
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async (request) => new Response(JSON.stringify({
          userId: request.headers.get('x-user-id'),
        }), { status: 200 }),
      },
    ]);

    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': SESSION_TOKEN,
        'x-user-id': 'attacker-controlled-user',
      },
    }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { userId: null });
  });

  it('rewrites client-supplied x-user-id on wm_ user-API-key auth (#3548)', async () => {
    // Third injection site (sibling of the Clerk session + legacy-bearer
    // paths). Mocks the two Convex endpoints the wm_ branch ultimately
    // hits: /api/internal-validate-api-key (key → owner userId) and
    // /api/internal-entitlements (tier check). Any other URL 404s so an
    // unmocked endpoint surfaces as a clean failure, not a silent allow.
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/analyze-stock',
        handler: async (req) =>
          new Response(JSON.stringify({ userId: req.headers.get('x-user-id') }), { status: 200 }),
      },
    ]);

    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    const originalFetch = globalThis.fetch;
    process.env.CONVEX_SITE_URL = 'https://test.convex.site';
    process.env.CONVEX_SERVER_SHARED_SECRET = 'test-secret';
    process.env.WORLDMONITOR_VALID_KEYS = 'real-key-123';

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/api/internal-validate-api-key')) {
        return new Response(
          JSON.stringify({ userId: 'owner_pro', keyId: 'k1', name: 'test' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/internal-entitlements')) {
        return new Response(
          JSON.stringify({
            planKey: 'pro_monthly',
            validUntil: Date.now() + 86_400_000,
            features: {
              tier: 1,
              apiAccess: true,
              apiRateLimit: 60,
              maxDashboards: 5,
              prioritySupport: false,
              exportFormats: [],
              mcpAccess: true,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.startsWith(process.env.CONVEX_SITE_URL || '')) {
        return new Response('not-mocked', { status: 404 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const res = await handler(
        new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
          headers: {
            Origin: 'https://worldmonitor.app',
            'X-WorldMonitor-Key': 'wm_owner_pro_test',
            'x-user-id': 'victim-user',
          },
        }),
      );

      assert.equal(res.status, 200);
      const body = (await res.json()) as { userId: string | null };
      assert.equal(body.userId, 'owner_pro');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalSiteUrl;
      if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
    }
  });
});

describe('POST-to-GET compatibility hardening', () => {
  function makePublicMarketHandler() {
    let seenUrl: URL | null = null;
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async (req) => {
          seenUrl = new URL(req.url);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    ]);
    return {
      handler,
      seenUrl: () => seenUrl,
    };
  }

  function compatPost(body: string, headers: Record<string, string> = {}) {
    return new Request('https://worldmonitor.app/api/market/v1/list-market-quotes', {
      method: 'POST',
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': SESSION_TOKEN,
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
    });
  }

  it('converts bounded scalar and array JSON bodies to GET query params', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = JSON.stringify({ symbols: ['AAPL', 'MSFT'], includeExtended: true });

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 200);
    assert.deepEqual(seenUrl()?.searchParams.getAll('symbols'), ['AAPL', 'MSFT']);
    assert.equal(seenUrl()?.searchParams.get('includeExtended'), 'true');
  });

  it('rejects POST-to-GET array expansion over 200 values', async () => {
    const { handler } = makePublicMarketHandler();
    const body = JSON.stringify({
      symbols: Array.from({ length: 201 }, (_, i) => `SYM${i}`),
    });

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: 'Too many values for POST compatibility parameter',
      parameter: 'symbols',
      maxValues: 200,
    });
  });

  it('skips POST-to-GET compatibility before reading bodies with missing, invalid, or oversized Content-Length', async () => {
    const { handler } = makePublicMarketHandler();
    const body = JSON.stringify({ symbols: ['AAPL'] });

    const missingReq = compatPost(body);
    missingReq.clone = () => { throw new Error('POST compatibility must not parse missing-length bodies'); };
    const missing = await handler(missingReq);
    assert.equal(missing.status, 405);

    const invalidReq = compatPost(body, { 'Content-Length': 'abc' });
    invalidReq.clone = () => { throw new Error('POST compatibility must not parse invalid-length bodies'); };
    const invalid = await handler(invalidReq);
    assert.equal(invalid.status, 405);

    const oversizedReq = compatPost(body, { 'Content-Length': '1048576' });
    oversizedReq.clone = () => { throw new Error('POST compatibility must not parse oversized bodies'); };
    const oversized = await handler(oversizedReq);
    assert.equal(oversized.status, 405);
  });

  it('preserves malformed JSON compatibility by falling back to matching GET without query params', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = '{not json';

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 200);
    assert.equal(seenUrl()?.search, '');
  });
});

// ---------------------------------------------------------------------------
// Bearer token auth path for premium endpoints
// ---------------------------------------------------------------------------

describe('premium gateway bearer token auth', () => {
  let privateKey: CryptoKey;
  let wrongPrivateKey: CryptoKey;
  let jwksServer: Server;
  let jwksPort: number;
  let handler: (req: Request) => Promise<Response>;

  before(async () => {
    const { publicKey, privateKey: pk } = await generateKeyPair('RS256');
    privateKey = pk;

    const { privateKey: wpk } = await generateKeyPair('RS256');
    wrongPrivateKey = wpk;

    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'test-key-1';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    const jwks = { keys: [publicJwk] };

    jwksServer = createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jwks));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      jwksServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = jwksServer.address();
    jwksPort = typeof addr === 'object' && addr ? addr.port : 0;

    process.env.CLERK_JWT_ISSUER_DOMAIN = `http://127.0.0.1:${jwksPort}`;
    process.env.WORLDMONITOR_VALID_KEYS = 'real-key-123';

    handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/analyze-stock',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-ranking',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
    ]);
  });

  after(async () => {
    jwksServer?.close();
    delete process.env.CLERK_JWT_ISSUER_DOMAIN;
  });

  function signToken(claims: Record<string, unknown>, opts?: { key?: CryptoKey; audience?: string }) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setAudience(opts?.audience ?? 'convex')
      .setSubject(claims.sub as string ?? 'user_test')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(opts?.key ?? privateKey);
  }

  it('valid bearer token resolves userId but entitlement check still applies', async () => {
    // A valid Pro bearer token resolves a userId via session, but without entitlement data
    // in the test env (no Redis/Convex), the entitlement check fails closed → 403
    const token = await signToken({ sub: 'user_pro', plan: 'pro' });
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    // Fail-closed: entitlement data unavailable → 403
    assert.equal(res.status, 403);
    const body = await res.json() as { error: string };
    assert.match(body.error, /[Uu]nable to verify|[Aa]uthentication required/);
  });

  it('free bearer token on premium endpoint → 403', async () => {
    const token = await signToken({ sub: 'user_free', plan: 'free' });
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(res.status, 403);
  });

  it('rejects invalid/expired bearer token on premium endpoint → 401', async () => {
    const token = await signToken({ sub: 'user_bad', plan: 'pro' }, { key: wrongPrivateKey });
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    // Invalid bearer → no session → forceKey true → 401 (missing API key)
    assert.equal(res.status, 401);
  });

  it('public routes accept the anonymous browser session token', async () => {
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
    }));
    assert.equal(res.status, 200);
  });

  it('public routes WITHOUT a session token are rejected (#3541 — header-only trust is gone)', async () => {
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(res.status, 401);
  });

  it('rejects free bearer token on resilience premium endpoints → 403', async () => {
    const token = await signToken({ sub: 'user_free', plan: 'free' });

    const scoreRes = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(scoreRes.status, 403);

    const rankingRes = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(rankingRes.status, 403);
  });

  it('rejects invalid bearer token on resilience premium endpoints → 401', async () => {
    const token = await signToken({ sub: 'user_bad', plan: 'pro' }, { key: wrongPrivateKey });

    const scoreRes = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(scoreRes.status, 401);

    const rankingRes = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(rankingRes.status, 401);
  });

  it('accepts valid Pro bearer token on resilience premium endpoints → 200', async () => {
    const token = await signToken({ sub: 'user_pro', plan: 'pro' });

    const scoreRes = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(scoreRes.status, 200);

    const rankingRes = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(rankingRes.status, 200);
  });

  it('rewrites spoofed x-user-id from a verified legacy bearer before reaching handlers', async () => {
    const token = await signToken({ sub: 'user_pro', plan: 'pro' });
    const headerEchoHandler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async (request) => new Response(JSON.stringify({
          userId: request.headers.get('x-user-id'),
        }), { status: 200 }),
      },
    ]);

    const res = await headerEchoHandler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
        'x-user-id': 'attacker-controlled-user',
      },
    }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { userId: 'user_pro' });
  });

  it('forwards POST body alongside trusted x-user-id on the legacy bearer path', async () => {
    // The gateway rebuilds the Request to inject the trusted x-user-id
    // header on the bearer path (`withAuthenticatedUserId`). The rebuild
    // must use `new Request(originalRequest, { headers })` (WHATWG input-
    // clone semantics) rather than `new Request(url, { body: req.body })`
    // — the latter would either require `duplex: 'half'` under undici or
    // hand the handler a stream already locked by the auth path.
    // This test pins both the body integrity AND the trusted userId
    // override on the same request, so a regression to the broken pattern
    // surfaces immediately on POST bearer auth.
    const token = await signToken({ sub: 'user_pro', plan: 'pro' });
    const echoHandler = createDomainGateway([
      {
        method: 'POST',
        path: '/api/intelligence/v1/deduct-situation',
        handler: async (request) => {
          const body = await request.json();
          return new Response(JSON.stringify({
            userId: request.headers.get('x-user-id'),
            body,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
      },
    ]);

    const payload = { situation: 'test', evidence: ['a', 'b', 'c'], count: 42 };
    const res = await echoHandler(new Request('https://worldmonitor.app/api/intelligence/v1/deduct-situation', {
      method: 'POST',
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-user-id': 'attacker-controlled-user',
      },
      body: JSON.stringify(payload),
    }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { userId: 'user_pro', body: payload });
  });
});
