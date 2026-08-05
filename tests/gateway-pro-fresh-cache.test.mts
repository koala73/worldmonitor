import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { issueSessionToken } from '../api/_session.js';
import { createDomainGateway } from '../server/gateway.ts';
import { PRO_FRESH_CACHE_RPC_PATHS } from '../src/shared/pro-fresh-rpc.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  CLERK_JWT_ISSUER_DOMAIN: process.env.CLERK_JWT_ISSUER_DOMAIN,
  CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
  CONVEX_SERVER_SHARED_SECRET: process.env.CONVEX_SERVER_SHARED_SECRET,
  WM_SESSION_SECRET: process.env.WM_SESSION_SECRET,
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

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.endsWith('/api/internal-entitlements')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { userId?: string };
      return new Response(JSON.stringify(entitlements.get(body.userId ?? '') ?? null), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
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
