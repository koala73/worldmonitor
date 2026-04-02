import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, it, before, after } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

import { createDomainGateway } from '../server/gateway.ts';

const originalKeys = process.env.WORLDMONITOR_VALID_KEYS;

afterEach(() => {
  if (originalKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = originalKeys;
});

describe('premium stock gateway enforcement', () => {
  it('requires credentials for premium endpoints regardless of origin', async () => {
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/analyze-stock',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
    ]);

    process.env.WORLDMONITOR_VALID_KEYS = 'real-key-123';

    // Trusted browser origin without credentials — 401 (Origin is spoofable, not a security boundary)
    const browserNoKey = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(browserNoKey.status, 401);

    // Trusted browser origin with a valid key — also allowed
    const browserWithKey = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': 'real-key-123',
      },
    }));
    assert.equal(browserWithKey.status, 200);

    // Unknown origin — blocked (403 from isDisallowedOrigin before key check)
    const unknownNoKey = await handler(new Request('https://external.example.com/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: { Origin: 'https://external.example.com' },
    }));
    assert.equal(unknownNoKey.status, 403);

    // Public endpoint — always accessible from trusted origin
    const publicAllowed = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(publicAllowed.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Bearer token auth path for premium endpoints
// ---------------------------------------------------------------------------

describe('premium stock gateway bearer token auth', () => {
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

  it('accepts valid Pro bearer token on premium endpoint → 200', async () => {
    const token = await signToken({ sub: 'user_pro', plan: 'pro' });
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(res.status, 200);
  });

  it('rejects Free bearer token on premium endpoint → 403', async () => {
    const token = await signToken({ sub: 'user_free', plan: 'free' });
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(res.status, 403);
    const body = await res.json() as { error: string };
    assert.match(body.error, /[Pp]ro/);
  });

  it('rejects invalid/expired bearer token on premium endpoint → 401', async () => {
    const token = await signToken({ sub: 'user_bad', plan: 'pro' }, { key: wrongPrivateKey });
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(res.status, 401);
  });

  it('public routes are unaffected by absence of auth header', async () => {
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(res.status, 200);
  });
});
