/**
 * Server-side session validation for the Vercel edge gateway.
 *
 * Validates Clerk-issued bearer tokens using local JWT verification
 * with jose + cached JWKS. No Convex round-trip needed.
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
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
  if (!_jwks && CLERK_JWT_ISSUER_DOMAIN) {
    const jwksUrl = new URL('/.well-known/jwks.json', CLERK_JWT_ISSUER_DOMAIN);
    _jwks = createRemoteJWKSet(jwksUrl);
  }
  return _jwks;
}

export interface SessionResult {
  valid: boolean;
  userId?: string;
  role?: 'free' | 'pro';
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
    // Verify signature and issuer. We intentionally skip the audience check so
    // that both 'convex' template tokens (aud='convex') and standard Clerk
    // session tokens (aud=publishable key) are accepted. The issuer check is
    // sufficient to prevent cross-app token reuse since each Clerk instance
    // has its own JWKS endpoint.
    const { payload } = await jwtVerify(token, jwks, {
      issuer: CLERK_JWT_ISSUER_DOMAIN,
      algorithms: ['RS256'],
    });

    const userId = payload.sub;
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
