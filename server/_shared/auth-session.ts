/**
 * Gateway-level JWT verification for Clerk bearer tokens.
 *
 * Extracts and verifies the `Authorization: Bearer <token>` header using the
 * shared bearer-token validator from `server/auth-session.ts`. Returns the
 * resolved session identity on success, or null on any failure.
 *
 * Shares the same JWKS cache as `validateBearerToken` — no duplicate
 * key fetches on cold start.
 *
 * Activated by setting CLERK_JWT_ISSUER_DOMAIN env var. When not set,
 * all calls return null and the gateway falls back to API-key-only auth.
 */

import { validateBearerToken } from '../auth-session';

export interface ClerkSession {
  userId: string;
  orgId: string | null;
  role: 'free' | 'pro';
}

/**
 * Extracts and verifies a bearer token from the request.
 * Returns { userId, orgId, role } on success, null on any failure.
 *
 * Fail-open: errors are logged but never thrown.
 */
export async function resolveClerkSession(request: Request): Promise<ClerkSession | null> {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;

    const session = await validateBearerToken(authHeader.slice(7));
    if (!session.valid || !session.userId) return null;

    return {
      userId: session.userId,
      orgId: session.orgId ?? null,
      role: session.role ?? 'free',
    };
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
