/**
 * Gateway-level JWT verification for Clerk bearer tokens.
 *
 * Extracts and verifies the `Authorization: Bearer <token>` header using
 * the shared JWKS singleton from `server/auth-session.ts`. Returns the userId
 * (JWT `sub` claim) on success, or null on any failure.
 *
 * Shares the same JWKS cache as `validateBearerToken` — no duplicate
 * key fetches on cold start.
 *
 * Activated by setting CLERK_JWT_ISSUER_DOMAIN env var. When not set,
 * all calls return null and the gateway falls back to API-key-only auth.
 */

import { jwtVerify } from 'jose';
import { getClerkJwtVerifyOptions, getJWKS } from '../auth-session';

export interface ClerkSession {
  userId: string;
  orgId: string | null;
}

/**
 * Extracts and verifies a bearer token from the request.
 * Returns { userId, orgId } on success, null on any failure.
 *
 * Fail-open: errors are logged but never thrown.
 */
export async function resolveClerkSession(request: Request): Promise<ClerkSession | null> {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;

    const token = authHeader.slice(7);
    if (!token) return null;

    const jwks = getJWKS();
    if (!jwks) return null; // CLERK_JWT_ISSUER_DOMAIN not configured

    const issuerDomain = process.env.CLERK_JWT_ISSUER_DOMAIN!;
    const { payload } = await jwtVerify(token, jwks, {
      ...getClerkJwtVerifyOptions(),
      issuer: issuerDomain,
    });

    const userId = (payload.sub as string) ?? null;
    if (!userId) return null;

    const orgClaim = (payload as Record<string, unknown>).org as
      | Record<string, unknown>
      | undefined;
    const orgId =
      (typeof orgClaim?.id === 'string' ? orgClaim.id : null) ??
      (typeof (payload as Record<string, unknown>).org_id === 'string'
        ? ((payload as Record<string, unknown>).org_id as string)
        : null);

    return { userId, orgId };
  } catch (err) {
    console.warn(
      '[auth-session] JWT verification failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Back-compat wrapper. Prefer resolveClerkSession() for new callers.
 */
export async function resolveSessionUserId(request: Request): Promise<string | null> {
  const session = await resolveClerkSession(request);
  return session?.userId ?? null;
}
