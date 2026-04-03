/**
 * Server-side session validation for the Vercel edge gateway.
 *
 * Validates Clerk-issued bearer tokens using local JWT verification
 * with jose + cached JWKS. No Convex round-trip needed.
 * Requires CLERK_PUBLISHABLE_KEY (server-side) and CLERK_JWT_ISSUER_DOMAIN.
 *
 * This module must NOT import anything from `src/` -- it runs in the
 * Vercel edge runtime, not the browser.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

// Clerk JWT issuer domain -- set in Vercel env vars
const CLERK_JWT_ISSUER_DOMAIN = process.env.CLERK_JWT_ISSUER_DOMAIN ?? '';

// Clerk Backend API secret -- used to look up user metadata when the JWT
// does not include a `plan` claim (i.e. standard session token, no template).
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? '';

// Module-scope JWKS resolver -- cached across warm invocations.
// jose handles key rotation and caching internally.
// Exported so server/_shared/auth-session.ts can reuse the same singleton
// (avoids duplicate JWKS HTTP fetches on cold start).
// Reads CLERK_JWT_ISSUER_DOMAIN lazily (not from module-scope const) so that
// tests that set the env var after import still get a valid JWKS.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
export function getJWKS() {
  if (!_jwks) {
    const issuerDomain = process.env.CLERK_JWT_ISSUER_DOMAIN;
    if (issuerDomain) {
      const jwksUrl = new URL('/.well-known/jwks.json', issuerDomain);
      _jwks = createRemoteJWKSet(jwksUrl);
    }
  }
  return _jwks;
}

export interface SessionResult {
  valid: boolean;
  userId?: string;
  role?: 'free' | 'pro';
}

function getAllowedAudiences(): string[] {
  const configured = [
    process.env.CLERK_JWT_AUDIENCE,
    process.env.CLERK_PUBLISHABLE_KEY,
  ]
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set(['convex', ...configured]));
}

export function getClerkJwtVerifyOptions() {
  return {
    issuer: CLERK_JWT_ISSUER_DOMAIN,
    audience: getAllowedAudiences(),
    algorithms: ['RS256'],
  };
}

// Short-lived in-memory cache for plan lookups (userId → { role, expiresAt }).
// Avoids hammering the Clerk API on every premium request. TTL = 5 min.
const _planCache = new Map<string, { role: 'free' | 'pro'; expiresAt: number }>();
const PLAN_CACHE_TTL_MS = 5 * 60 * 1_000;

async function lookupPlanFromClerk(userId: string): Promise<'free' | 'pro'> {
  const cached = _planCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) return cached.role;

  if (!CLERK_SECRET_KEY) return 'free';
  try {
    const resp = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
      headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}` },
    });
    if (!resp.ok) return 'free';
    const user = (await resp.json()) as { public_metadata?: Record<string, unknown> };
    const role: 'free' | 'pro' = user.public_metadata?.plan === 'pro' ? 'pro' : 'free';
    _planCache.set(userId, { role, expiresAt: Date.now() + PLAN_CACHE_TTL_MS });
    return role;
  } catch {
    return 'free';
  }
}

/**
 * Validate a Clerk-issued bearer token using local JWKS verification.
 * Accepts both custom-template tokens (with `plan` claim) and standard
 * session tokens (plan looked up via Clerk Backend API).
 * Fails closed: invalid/expired/unverifiable tokens return { valid: false }.
 */
export async function validateBearerToken(token: string): Promise<SessionResult> {
  const jwks = getJWKS();
  if (!jwks) return { valid: false };

  try {
    // Try with audience first (Clerk 'convex' template tokens include aud).
    // Fall back without audience for standard Clerk session tokens (no aud claim).
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, jwks, getClerkJwtVerifyOptions()));
    } catch (audErr) {
      if ((audErr as Error).message?.includes('missing required "aud"')) {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer: CLERK_JWT_ISSUER_DOMAIN,
          algorithms: ['RS256'],
        }));
      } else {
        throw audErr;
      }
    }

    const userId = payload.sub as string | undefined;
    if (!userId) return { valid: false };

    // `plan` claim is present only in 'convex' template tokens. For standard
    // session tokens we fall back to a cached Clerk API lookup.
    const rawPlan = (payload as Record<string, unknown>).plan;
    const role: 'free' | 'pro' =
      rawPlan !== undefined
        ? rawPlan === 'pro'
          ? 'pro'
          : 'free'
        : await lookupPlanFromClerk(userId);

    return { valid: true, userId, role };
  } catch {
    // Signature verification failed, expired, wrong issuer, etc.
    return { valid: false };
  }
}
