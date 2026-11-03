import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { issueSessionToken } from '../api/_session.js';
import { createDomainGateway } from '../server/gateway.ts';
import { PRO_FRESH_CACHE_RPC_PATHS } from '../src/shared/pro-fresh-rpc.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { getCountryHistory } from '../server/worldmonitor/intelligence/v1/get-country-history';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  CLERK_JWT_ISSUER_DOMAIN: process.env.CLERK_JWT_ISSUER_DOMAIN,
  CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
  CONVEX_SERVER_SHARED_SECRET: process.env.CONVEX_SERVER_SHARED_SECRET,
  WM_SESSION_SECRET: process.env.WM_SESSION_SECRET,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
  WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
};

type Entitlement = {
  planKey: string;
  validUntil: number;
  features: {
    tier: number;
    apiAccess: boolean;
    apiRateLimit: number;
    maxDashboards: number;
    prioritySupport: boolean;
    exportFormats: string[];
    mcpAccess: boolean;
  };
};

const entitlements = new Map<string, Entitlement | null>();
let entitlementReads = 0;
let privateKey: CryptoKey;
let jwksServer: Server;
let jwksPort = 0;
let anonymousSessionToken = '';

const handler = createDomainGateway(
  [...PRO_FRESH_CACHE_RPC_PATHS].map((path) => ({
    method: 'GET' as const,
    path,
    handler: async () => new Response('{"ok":true}', { status: 200 }),
  })),
);

const historyPath = '/api/intelligence/v1/get-country-history';
const historyHandler = createDomainGateway([{ method: 'GET', path: historyPath, handler: async request => Response.json(await getCountryHistory({ request, pathParams: {}, headers: {} }, { country: 'US', days: 365 })) }]);

function entitlement(planKey: string, tier: number, validUntil = Date.now() + 60_000): Entitlement {
  return {
    planKey,
    validUntil,
    features: {
      tier,
      apiAccess: tier >= 2,
      apiRateLimit: tier >= 2 ? 60 : 0,
      maxDashboards: tier >= 1 ? 10 : 3,
      prioritySupport: false,
      exportFormats: [],
      mcpAccess: tier >= 1,
    },
  };
}

function request(path: string, headers: HeadersInit): Request {
  return new Request(`https://worldmonitor.app${path}?_debug=1`, {
    headers: {
      Origin: 'https://worldmonitor.app',
      ...headers,
    },
  });
}

function assertPrivateCache(res: Response): void {
  assert.equal(res.headers.get('CDN-Cache-Control'), null);
  assert.equal(res.headers.get('Vercel-CDN-Cache-Control'), null);
  assert.doesNotMatch(res.headers.get('Cache-Control') ?? '', /\bpublic\b|\bs-maxage=/i);
}

async function signToken(userId: string, plan = 'free'): Promise<string> {
  return new SignJWT({ sub: userId, plan })
    .setProtectedHeader({ alg: 'RS256', kid: 'pro-fresh-test-key' })
    .setIssuer(`http://127.0.0.1:${jwksPort}`)
    .setAudience('convex')
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

before(async () => {
  const { publicKey, privateKey: generatedPrivateKey } = await generateKeyPair('RS256');
  privateKey = generatedPrivateKey;
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'pro-fresh-test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  jwksServer = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const address = jwksServer.address();
  jwksPort = typeof address === 'object' && address ? address.port : 0;

  process.env.CLERK_JWT_ISSUER_DOMAIN = `http://127.0.0.1:${jwksPort}`;
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'pro-fresh-shared-secret';
  process.env.WM_SESSION_SECRET = 'pro-fresh-session-secret-at-least-32-chars';
  anonymousSessionToken = (await issueSessionToken()).token;

  // list-stablecoin-markets carries an endpoint rate policy (#6308), and the
  // endpoint limiter fails closed with 503 when Redis is unconfigured. Install
  // the fake so every route here reaches its handler like in production —
  // same accommodation as tests/leads-gateway-public.test.mts. The other four
  // paths have no policy and are unaffected either way.
  const redis = installRedis({});

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.endsWith('/api/internal-entitlements')) {
      entitlementReads++;
      const body = JSON.parse(String(init?.body ?? '{}')) as { userId?: string };
      if (body.userId === 'history-enterprise-outage') return Response.json({}, { status: 503 });
      return new Response(JSON.stringify(entitlements.get(body.userId ?? '') ?? null), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.startsWith(process.env.UPSTASH_REDIS_REST_URL ?? '\0')) {
      const commands = JSON.parse(String(init?.body ?? '[]'));
      if (commands[0]?.[0] === 'ZRANGEBYSCORE' && commands[0]?.[1] === 'history:country:US') {
        return Response.json([{ result: [] }, { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 196 }) }]);
      }
      return redis.fetchImpl(input, init);
    }
    return ORIGINAL_FETCH(input, init);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('country history verified retention', () => {
  it('serves anonymous seven-day history and ignores spoofed tier/user headers', async () => {
    const response = await historyHandler(request(historyPath, { 'x-user-id': 'paid-user', 'x-history-days': '365' }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).effectiveDays, 7);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assertPrivateCache(response);
  });

  it('uses verified Pro/API plans, then clamps expired plans back to free', async () => {
    for (const [user, tier, validUntil, expected] of [
      ['history-pro', 1, Date.now() + 60000, 90],
      ['history-api', 2, Date.now() + 60000, 365],
      ['history-expired', 1, Date.now() - 60000, 7],
    ] as const) {
      entitlements.set(user, entitlement(tier === 2 ? 'api_starter' : 'pro_monthly', tier, validUntil));
      const response = await historyHandler(request(historyPath, { Authorization: `Bearer ${await signToken(user)}` }));
      assert.equal(response.status, 200, user);
      assert.equal((await response.json()).effectiveDays, expected, user);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assertPrivateCache(response);
    }
  });

  it('keeps enterprise-key history available with a bearer whose entitlement service is unavailable', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'history-enterprise-fixture';
    const reads = entitlementReads;
    try {
      const response = await historyHandler(request(historyPath, {
        'X-WorldMonitor-Key': 'history-enterprise-fixture',
        Authorization: `Bearer ${await signToken('history-enterprise-outage')}`,
      }));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).allowedDays, 365);
      assert.equal(entitlementReads, reads);
    } finally {
      if (ORIGINAL_ENV.WORLDMONITOR_VALID_KEYS === undefined) delete process.env.WORLDMONITOR_VALID_KEYS;
      else process.env.WORLDMONITOR_VALID_KEYS = ORIGINAL_ENV.WORLDMONITOR_VALID_KEYS;
    }
  });
});

describe('Pro-only market freshness cache contract', () => {
  it('keeps the allowlist exact', () => {
    assert.deepEqual(
      [...PRO_FRESH_CACHE_RPC_PATHS].sort(),
      [
        '/api/market/v1/list-commodity-quotes',
        '/api/market/v1/list-crypto-quotes',
        '/api/market/v1/list-gulf-quotes',
        '/api/market/v1/list-market-quotes',
        '/api/market/v1/list-stablecoin-markets',
      ],
    );
  });

  it('gives active Pro-or-higher plans a 30-second private browser tier on all five routes', async () => {
    entitlements.set('user_pro_fresh', entitlement('pro_monthly', 1));
    const token = await signToken('user_pro_fresh');

    for (const path of PRO_FRESH_CACHE_RPC_PATHS) {
      const res = await handler(request(path, { Authorization: `Bearer ${token}` }));
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('X-Cache-Tier'), 'live-browser', path);
      assert.match(res.headers.get('Cache-Control') ?? '', /\bmax-age=30\b/, path);
      assert.match(res.headers.get('Cache-Control') ?? '', /\bprivate\b/, path);
      assertPrivateCache(res);
    }
  });

  it('keeps signed-in free and expired paid plans on the existing five-minute private tier', async () => {
    entitlements.set('user_free_cache', entitlement('free', 0));
    entitlements.set('user_expired_pro_cache', entitlement('pro_annual', 1, Date.now() - 1));

    for (const userId of ['user_free_cache', 'user_expired_pro_cache']) {
      const token = await signToken(userId, userId.includes('expired') ? 'pro' : 'free');
      const res = await handler(request(
        '/api/market/v1/list-market-quotes',
        { Authorization: `Bearer ${token}` },
      ));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('X-Cache-Tier'), 'slow-browser');
      assert.match(res.headers.get('Cache-Control') ?? '', /\bmax-age=300\b/);
      assertPrivateCache(res);
    }
  });

  it('keeps anonymous browser sessions on the existing five-minute private tier', async () => {
    const res = await handler(request(
      '/api/market/v1/list-market-quotes',
      { 'X-WorldMonitor-Key': anonymousSessionToken },
    ));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-Cache-Tier'), 'slow-browser');
    assert.match(res.headers.get('Cache-Control') ?? '', /\bmax-age=300\b/);
    assertPrivateCache(res);
  });

  it('fails closed to ordinary freshness when entitlement resolution is unavailable', async () => {
    entitlements.set('user_unresolved_cache', null);
    const token = await signToken('user_unresolved_cache', 'pro');
    const res = await handler(request(
      '/api/market/v1/list-market-quotes',
      { Authorization: `Bearer ${token}` },
    ));

    assert.equal(res.status, 200, 'freshness lookup failure must not block public market data');
    assert.equal(res.headers.get('X-Cache-Tier'), 'slow-browser');
    assertPrivateCache(res);
  });
});
