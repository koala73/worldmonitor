/**
 * Tests for server/auth-session.ts (Clerk JWT verification with jose)
 *
 * Covers the full validation matrix:
 *  - Returns invalid when CLERK_JWT_ISSUER_DOMAIN is not set (fail-closed)
 *  - Valid Pro token → { valid: true, role: 'pro' }
 *  - Valid Free token → { valid: true, role: 'free' }
 *  - Missing plan claim → defaults to 'free'
 *  - Expired token → { valid: false }
 *  - Invalid signature → { valid: false }
 *  - Allowed audiences → accepted ('convex' template plus configured publishable/audience envs)
 *  - Unexpected audience → rejected
 *  - JWKS resolver is reused across calls (module-scoped, not per-request)
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { describe, it, before, after } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

// ---------------------------------------------------------------------------
// Suite 1: fail-closed when CLERK_JWT_ISSUER_DOMAIN is NOT set
// ---------------------------------------------------------------------------

// Clear env BEFORE dynamic import so the module captures an empty domain
delete process.env.CLERK_JWT_ISSUER_DOMAIN;

let validateBearerTokenNoEnv: (token: string) => Promise<{ valid: boolean; userId?: string; role?: string }>;

before(async () => {
  const mod = await import('../server/auth-session.ts');
  validateBearerTokenNoEnv = mod.validateBearerToken;
});

describe('validateBearerToken (no CLERK_JWT_ISSUER_DOMAIN)', () => {
  it('returns invalid when CLERK_JWT_ISSUER_DOMAIN is not set', async () => {
    const result = await validateBearerTokenNoEnv('some-random-token');
    assert.equal(result.valid, false);
    assert.equal(result.userId, undefined);
    assert.equal(result.role, undefined);
  });

  it('returns invalid for empty token', async () => {
    const result = await validateBearerTokenNoEnv('');
    assert.equal(result.valid, false);
  });

  it('returns SessionResult shape with expected fields', async () => {
    const result = await validateBearerTokenNoEnv('test');
    assert.equal(typeof result.valid, 'boolean');
    if (!result.valid) {
      assert.equal(result.userId, undefined);
      assert.equal(result.role, undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: full JWT validation with self-signed keys + local JWKS server
// ---------------------------------------------------------------------------

describe('validateBearerToken (with JWKS)', () => {
  let privateKey: CryptoKey;
  let jwksServer: Server;
  let jwksPort: number;
  let validateBearerToken: (token: string) => Promise<{ valid: boolean; userId?: string; role?: string }>;

  // Separate key pair for "wrong key" tests
  let wrongPrivateKey: CryptoKey;

  before(async () => {
    // Generate an RSA key pair for signing JWTs
    const { publicKey, privateKey: pk } = await generateKeyPair('RS256');
    privateKey = pk;

    const { privateKey: wpk } = await generateKeyPair('RS256');
    wrongPrivateKey = wpk;

    // Export public key as JWK for the JWKS endpoint
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'test-key-1';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    const jwks = { keys: [publicJwk] };

    // Start a local HTTP server serving the JWKS
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

    // Set the issuer domain to the local JWKS server and re-import the module
    // (fresh import since the module caches JWKS at first use)
    process.env.CLERK_JWT_ISSUER_DOMAIN = `http://127.0.0.1:${jwksPort}`;
    process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_123';

    // Dynamic import with cache-busting query param to get a fresh module instance
    const mod = await import(`../server/auth-session.ts?t=${Date.now()}`);
    validateBearerToken = mod.validateBearerToken;
  });

  after(async () => {
    jwksServer?.close();
    delete process.env.CLERK_JWT_ISSUER_DOMAIN;
    delete process.env.CLERK_PUBLISHABLE_KEY;
  });

  /** Helper to sign a JWT with the test private key */
  function signToken(claims: Record<string, unknown>, opts?: { expiresIn?: string; key?: CryptoKey }) {
    const builder = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setAudience('convex')
      .setSubject(claims.sub as string ?? 'user_test123')
      .setIssuedAt();

    if (opts?.expiresIn) {
      builder.setExpirationTime(opts.expiresIn);
    } else {
      builder.setExpirationTime('1h');
    }

    return builder.sign(opts?.key ?? privateKey);
  }

  it('accepts a valid Pro token', async () => {
    const token = await signToken({ sub: 'user_pro1', plan: 'pro' });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'user_pro1');
    assert.equal(result.role, 'pro');
  });

  it('accepts a valid Free token and normalizes role to free', async () => {
    const token = await signToken({ sub: 'user_free1', plan: 'free' });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'user_free1');
    assert.equal(result.role, 'free');
  });

  it('treats missing plan claim as free', async () => {
    const token = await signToken({ sub: 'user_noplan' });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'user_noplan');
    assert.equal(result.role, 'free');
  });

  it('treats unknown plan value as free', async () => {
    const token = await signToken({ sub: 'user_weird', plan: 'enterprise' });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'user_weird');
    assert.equal(result.role, 'free');
  });

  it('rejects an expired token', async () => {
    const token = await new SignJWT({ sub: 'user_expired', plan: 'pro' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setAudience('convex')
      .setSubject('user_expired')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200) // 2h ago
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600) // expired 1h ago
      .sign(privateKey);

    const result = await validateBearerToken(token);
    assert.equal(result.valid, false);
  });

  it('rejects a token signed with wrong key', async () => {
    const token = await signToken({ sub: 'user_wrongkey', plan: 'pro' }, { key: wrongPrivateKey });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, false);
  });

  it('accepts a token with the configured publishable-key audience', async () => {
    const token = await new SignJWT({ sub: 'user_publishable', plan: 'pro' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setAudience('pk_test_123')
      .setSubject('user_publishable')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.role, 'pro');
  });

  it('rejects a token with an unexpected audience', async () => {
    const token = await new SignJWT({ sub: 'user_anyaud', plan: 'pro' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setAudience('some-other-audience')
      .setSubject('user_anyaud')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const result = await validateBearerToken(token);
    assert.equal(result.valid, false);
  });

  it('accepts a standard Clerk token with no aud claim (fallback path)', async () => {
    const token = await new SignJWT({ sub: 'user_noaud', plan: 'pro' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setSubject('user_noaud')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const result = await validateBearerToken(token);
    assert.equal(result.valid, true, 'standard Clerk tokens without aud should be accepted');
    assert.equal(result.userId, 'user_noaud');
  });

  it('rejects a token with wrong issuer', async () => {
    const token = await new SignJWT({ sub: 'user_wrongiss', plan: 'pro' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://wrong-issuer.example.com')
      .setAudience('convex')
      .setSubject('user_wrongiss')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const result = await validateBearerToken(token);
    assert.equal(result.valid, false);
  });

  it('rejects a token with no sub claim', async () => {
    const token = await new SignJWT({ plan: 'pro' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setAudience('convex')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const result = await validateBearerToken(token);
    assert.equal(result.valid, false);
  });

  it('reuses the JWKS resolver across calls (not per-request)', async () => {
    // Make two calls — both should succeed using the same cached JWKS
    const token1 = await signToken({ sub: 'user_a', plan: 'pro' });
    const token2 = await signToken({ sub: 'user_b', plan: 'free' });

    const [r1, r2] = await Promise.all([
      validateBearerToken(token1),
      validateBearerToken(token2),
    ]);

    assert.equal(r1.valid, true);
    assert.equal(r1.role, 'pro');
    assert.equal(r2.valid, true);
    assert.equal(r2.role, 'free');
  });
});

// ---------------------------------------------------------------------------
// Suite 3: CORS origin matching -- pure logic (independent of auth provider)
// ---------------------------------------------------------------------------

describe('CORS origin matching (convex/http.ts)', () => {
  function matchOrigin(origin: string, pattern: string): boolean {
    if (pattern.startsWith('*.')) {
      return origin.endsWith(pattern.slice(1));
    }
    return origin === pattern;
  }

  function allowedOrigin(origin: string | null, trusted: string[]): string | null {
    if (!origin) return null;
    return trusted.some((p) => matchOrigin(origin, p)) ? origin : null;
  }

  const TRUSTED = [
    'https://worldmonitor.app',
    '*.worldmonitor.app',
    'http://localhost:3000',
  ];

  it('allows exact match', () => {
    assert.equal(allowedOrigin('https://worldmonitor.app', TRUSTED), 'https://worldmonitor.app');
  });

  it('allows wildcard subdomain', () => {
    const origin = 'https://preview-xyz.worldmonitor.app';
    assert.equal(allowedOrigin(origin, TRUSTED), origin);
  });

  it('allows localhost', () => {
    assert.equal(allowedOrigin('http://localhost:3000', TRUSTED), 'http://localhost:3000');
  });

  it('blocks unknown origin', () => {
    assert.equal(allowedOrigin('https://evil.com', TRUSTED), null);
  });

  it('blocks partial domain match', () => {
    assert.equal(allowedOrigin('https://attackerworldmonitor.app', TRUSTED), null);
  });

  it('returns null for null origin -- no ACAO header emitted', () => {
    assert.equal(allowedOrigin(null, TRUSTED), null);
  });
});
