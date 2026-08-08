/**
 * Tests for server/auth-session.ts (Clerk JWT verification with jose)
 *
 * Covers the full validation matrix:
 *  - Returns invalid when CLERK_JWT_ISSUER_DOMAIN is not set (fail-closed)
 *  - Valid Pro token → { valid: true, role: 'pro' }
 *  - Valid Free token → { valid: true, role: 'free' }
 *  - Missing plan claim → defaults to 'free'
 *  - Small JWT clock skew → accepted within the bounded tolerance on both verification paths
 *  - Expired token beyond the tolerance → { valid: false, reason: 'invalid' }
 *  - Not-yet-valid token within the nbf tolerance → accepted on both paths
 *  - Exact exp/nbf tolerance boundaries → pinned with a fixed verification clock (no wall-clock coupling)
 *  - Token with no exp claim → rejected (requiredClaims makes the stated bound enforced)
 *  - Tolerance-only acceptance → surfaced via acceptedWithinClockTolerance
 *  - Invalid signature → { valid: false }
 *  - Allowed audiences → accepted ('convex' template plus configured publishable/audience envs)
 *  - Unexpected audience → rejected
 *  - JWKS transport failure → { valid: false, reason: 'unverifiable' }
 *  - JWKS resolver is reused across calls (module-scoped, not per-request)
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { describe, it, before, after } from 'node:test';
import { generateKeyPair, exportJWK, jwtVerify, SignJWT } from 'jose';

const EXPECTED_CLOCK_TOLERANCE_SECONDS = 5;

type AuthSessionResult = {
  valid: boolean;
  userId?: string;
  role?: string;
  reason?: 'invalid' | 'unverifiable';
  acceptedWithinClockTolerance?: true;
};

// ---------------------------------------------------------------------------
// Suite 1: fail-closed when CLERK_JWT_ISSUER_DOMAIN is NOT set
// ---------------------------------------------------------------------------

// Clear env BEFORE dynamic import so the module captures an empty domain
delete process.env.CLERK_JWT_ISSUER_DOMAIN;

let validateBearerTokenNoEnv: (token: string) => Promise<AuthSessionResult>;

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
  let validateBearerToken: (token: string) => Promise<AuthSessionResult>;
  let getClerkJwtVerifyOptions: () => { clockTolerance?: string | number };
  let getClerkJwtVerifyBaseOptions: () => {
    clockTolerance?: string | number;
    requiredClaims?: string[];
  };
  let verifyPublicKey: CryptoKey;
  let originalClerkSecretKey: string | undefined;

  // Separate key pair for "wrong key" tests
  let wrongPrivateKey: CryptoKey;

  before(async () => {
    // Generate an RSA key pair for signing JWTs
    const { publicKey, privateKey: pk } = await generateKeyPair('RS256');
    privateKey = pk;
    verifyPublicKey = publicKey;

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
    originalClerkSecretKey = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;

    // Dynamic import with cache-busting query param to get a fresh module instance
    const mod = await import(`../server/auth-session.ts?t=${Date.now()}`);
    validateBearerToken = mod.validateBearerToken;
    getClerkJwtVerifyOptions = mod.getClerkJwtVerifyOptions;
    getClerkJwtVerifyBaseOptions = mod.getClerkJwtVerifyBaseOptions;
  });

  after(async () => {
    jwksServer?.close();
    delete process.env.CLERK_JWT_ISSUER_DOMAIN;
    delete process.env.CLERK_PUBLISHABLE_KEY;
    if (originalClerkSecretKey === undefined) {
      delete process.env.CLERK_SECRET_KEY;
    } else {
      process.env.CLERK_SECRET_KEY = originalClerkSecretKey;
    }
  });

  /** Helper to sign a JWT with the test private key */
  function signToken(
    claims: Record<string, unknown>,
    opts?: {
      audience?: string | null;
      expiresAt?: number;
      expiresIn?: string;
      key?: CryptoKey;
      notBeforeAt?: number;
    },
  ) {
    const builder = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setSubject(claims.sub as string ?? 'user_test123')
      .setIssuedAt();

    if (opts?.audience !== null) {
      builder.setAudience(opts?.audience ?? 'convex');
    }

    if (opts?.notBeforeAt !== undefined) {
      builder.setNotBefore(opts.notBeforeAt);
    }

    if (opts?.expiresAt !== undefined) {
      builder.setExpirationTime(opts.expiresAt);
    } else if (opts?.expiresIn) {
      builder.setExpirationTime(opts.expiresIn);
    } else {
      builder.setExpirationTime('1h');
    }

    return builder.sign(opts?.key ?? privateKey);
  }

  it('exposes the intentionally bounded JWT clock tolerance', () => {
    assert.equal(
      getClerkJwtVerifyOptions().clockTolerance,
      EXPECTED_CLOCK_TOLERANCE_SECONDS,
    );
    // The fallback (no-audience) path's options carry the same bound directly,
    // and require `exp` so the bound is enforced rather than assumed.
    assert.equal(
      getClerkJwtVerifyBaseOptions().clockTolerance,
      EXPECTED_CLOCK_TOLERANCE_SECONDS,
    );
    assert.deepEqual(getClerkJwtVerifyBaseOptions().requiredClaims, ['exp']);
  });

  it('accepts a valid Pro token', async () => {
    const token = await signToken({ sub: 'user_pro1', plan: 'pro' });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'user_pro1');
    assert.equal(result.role, 'pro');
    // A token with real life left was not admitted by the tolerance.
    assert.equal(result.acceptedWithinClockTolerance, undefined);
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

  it('accepts an audience-bearing token expired within the clock tolerance', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      { sub: 'user_aud_within_tolerance', plan: 'pro' },
      { expiresAt: now - 1 },
    );

    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'user_aud_within_tolerance');
    // Downstream consumers (api/user-prefs.ts) branch on this to classify a
    // Convex re-verification 401 as expected near-expiry, not auth drift.
    assert.equal(result.acceptedWithinClockTolerance, true);
  });

  it('rejects an audience-bearing token expired beyond the clock tolerance', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      { sub: 'user_aud_beyond_tolerance', plan: 'pro' },
      { expiresAt: now - 8 },
    );

    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  it('rejects a token signed with wrong key', async () => {
    const token = await signToken({ sub: 'user_wrongkey', plan: 'pro' }, { key: wrongPrivateKey });
    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
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

    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  it('accepts a standard Clerk token with no aud claim (fallback path)', async () => {
    const token = await new SignJWT({ sub: 'user_noaud' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setSubject('user_noaud')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const result = await validateBearerToken(token);
    assert.equal(result.valid, true, 'standard Clerk tokens without aud should be accepted');
    assert.equal(result.userId, 'user_noaud');
    assert.equal(result.role, 'free');
  });

  it('accepts a no-audience token expired within the clock tolerance through the fallback path', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      { sub: 'user_noaud_within_tolerance' },
      { audience: null, expiresAt: now - 1 },
    );

    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'user_noaud_within_tolerance');
    assert.equal(result.role, 'free');
    assert.equal(result.acceptedWithinClockTolerance, true);
  });

  it('rejects a no-audience token expired beyond the clock tolerance', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      { sub: 'user_noaud_beyond_tolerance' },
      { audience: null, expiresAt: now - 8 },
    );

    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  it('accepts a not-yet-valid token within the nbf clock tolerance on both paths', async () => {
    // Structurally flake-safe direction: nbf recedes into the past as real
    // time advances, so test-runner delay can only help acceptance. The
    // rejection side of the nbf boundary is pinned with a fixed clock below —
    // a live-clock nbf rejection test would flip to a false pass within
    // seconds, the flake class tracked in #5841.
    const now = Math.floor(Date.now() / 1000);
    const audToken = await signToken(
      { sub: 'user_aud_nbf_within', plan: 'pro' },
      { notBeforeAt: now + 4 },
    );
    const audResult = await validateBearerToken(audToken);
    assert.equal(audResult.valid, true);
    assert.equal(audResult.userId, 'user_aud_nbf_within');

    const noAudToken = await signToken(
      { sub: 'user_noaud_nbf_within' },
      { audience: null, notBeforeAt: now + 4 },
    );
    const noAudResult = await validateBearerToken(noAudToken);
    assert.equal(noAudResult.valid, true);
    assert.equal(noAudResult.userId, 'user_noaud_nbf_within');
    assert.equal(noAudResult.role, 'free');
  });

  it('rejects a token with no exp claim (requiredClaims enforces the stated bound)', async () => {
    const token = await new SignJWT({ sub: 'user_no_exp', plan: 'pro' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setAudience('convex')
      .setSubject('user_no_exp')
      .setIssuedAt()
      .sign(privateKey);

    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  describe('exact tolerance boundaries (fixed verification clock)', () => {
    // These pin the numeric bound behaviorally — a tolerance quietly widened
    // to 6 or narrowed to 4 fails here — with zero wall-clock coupling:
    // jose's `currentDate` option freezes "now", so elapsed runner time
    // cannot flip an outcome. Verification runs against the same exported
    // options objects the module passes to jwtVerify in production.
    it('pins the exp boundary on the audience path: 4s late accepted, exactly 5s late rejected', async () => {
      const t = Math.floor(Date.now() / 1000);
      const currentDate = new Date(t * 1000);

      const justInside = await signToken(
        { sub: 'user_exp_edge_in', plan: 'pro' },
        { expiresAt: t - (EXPECTED_CLOCK_TOLERANCE_SECONDS - 1) },
      );
      const { payload } = await jwtVerify(justInside, verifyPublicKey, {
        ...getClerkJwtVerifyOptions(),
        currentDate,
      });
      assert.equal(payload.sub, 'user_exp_edge_in');

      const atBoundary = await signToken(
        { sub: 'user_exp_edge_out', plan: 'pro' },
        { expiresAt: t - EXPECTED_CLOCK_TOLERANCE_SECONDS },
      );
      await assert.rejects(
        jwtVerify(atBoundary, verifyPublicKey, {
          ...getClerkJwtVerifyOptions(),
          currentDate,
        }),
        (err: { code?: string }) => err.code === 'ERR_JWT_EXPIRED',
      );
    });

    it('pins the nbf boundary on the fallback path: exactly 5s early accepted, 6s early rejected', async () => {
      const t = Math.floor(Date.now() / 1000);
      const currentDate = new Date(t * 1000);

      const atBoundary = await signToken(
        { sub: 'user_nbf_edge_in' },
        { audience: null, notBeforeAt: t + EXPECTED_CLOCK_TOLERANCE_SECONDS },
      );
      const { payload } = await jwtVerify(atBoundary, verifyPublicKey, {
        ...getClerkJwtVerifyBaseOptions(),
        currentDate,
      });
      assert.equal(payload.sub, 'user_nbf_edge_in');

      const beyond = await signToken(
        { sub: 'user_nbf_edge_out' },
        { audience: null, notBeforeAt: t + EXPECTED_CLOCK_TOLERANCE_SECONDS + 1 },
      );
      await assert.rejects(
        jwtVerify(beyond, verifyPublicKey, {
          ...getClerkJwtVerifyBaseOptions(),
          currentDate,
        }),
        (err: { code?: string; claim?: string }) =>
          err.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && err.claim === 'nbf',
      );
    });
  });

  it('extracts email and name from JWT for checkout prefill', async () => {
    const token = await new SignJWT({
      sub: 'user_prefill',
      plan: 'pro',
      email: 'elie@worldmonitor.app',
      given_name: 'Elie',
      family_name: 'Habib',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setAudience('convex')
      .setSubject('user_prefill')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.email, 'elie@worldmonitor.app');
    assert.equal(result.name, 'Elie Habib');
  });

  it('handles missing email/name gracefully (no prefill)', async () => {
    const token = await new SignJWT({ sub: 'user_noprofile', plan: 'pro' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setAudience('convex')
      .setSubject('user_noprofile')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.email, undefined);
    assert.equal(result.name, undefined);
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

    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  it('rejects a token with no sub claim', async () => {
    const token = await new SignJWT({ plan: 'pro' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setAudience('convex')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    assert.deepEqual(
      await validateBearerToken(token),
      { valid: false, reason: 'invalid' },
    );
  });

  it('classifies a JWKS transport failure as unverifiable', async () => {
    const failingJwksServer = createServer((_req, res) => {
      res.destroy();
    });
    await new Promise<void>((resolve) => {
      failingJwksServer.listen(0, '127.0.0.1', () => resolve());
    });
    const failingAddress = failingJwksServer.address();
    const failingPort =
      typeof failingAddress === 'object' && failingAddress ? failingAddress.port : 0;
    const failingIssuer = `http://127.0.0.1:${failingPort}`;
    const originalIssuer = process.env.CLERK_JWT_ISSUER_DOMAIN;

    try {
      process.env.CLERK_JWT_ISSUER_DOMAIN = failingIssuer;
      const failingModule = await import(`../server/auth-session.ts?jwks-failure=${Date.now()}`);
      const token = await new SignJWT({ sub: 'user_jwks_failure', plan: 'pro' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuer(failingIssuer)
        .setAudience('convex')
        .setSubject('user_jwks_failure')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      assert.deepEqual(
        await failingModule.validateBearerToken(token),
        { valid: false, reason: 'unverifiable' },
      );
    } finally {
      process.env.CLERK_JWT_ISSUER_DOMAIN = originalIssuer;
      await new Promise<void>((resolve, reject) => {
        failingJwksServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
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
