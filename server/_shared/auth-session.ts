/**
 * Gateway-level JWT verification for Clerk bearer tokens.
 *
 * Extracts and verifies the `Authorization: Bearer <token>` header using the
 * shared bearer-token validator from `server/auth-session.ts`. Returns the
 * resolved identity, null for invalid credentials, or an unverifiable result.
 *
 * Shares the same JWKS cache as `validateBearerToken` — no duplicate
 * key fetches on cold start.
 *
 * Activated by setting CLERK_JWT_ISSUER_DOMAIN env var. When not set,
 * bearer verification is unavailable; requests without a bearer can still
 * use API-key-only auth.
 */

import { validateBearerToken } from '../auth-session';
import { renderBillingVerificationDenial, unverifiableEntitlementDenial } from './entitlement-check';

export interface ClerkSession {
  userId: string;
  orgId: string | null;
  role: 'free' | 'pro';
}

export interface UnverifiableSession {
  reason: 'unverifiable';
  userId: null;
  orgId: null;
  role: null;
}

const UNVERIFIABLE: UnverifiableSession = { reason: 'unverifiable', userId: null, orgId: null, role: null };

export function sessionVerificationUnavailableResponse(headers: Record<string, string> = {}): Response {
  return renderBillingVerificationDenial(unverifiableEntitlementDenial(), {
    ...headers, 'Cache-Control': 'no-store',
  });
}

/**
 * Extracts and verifies a bearer token from the request.
 * Returns identity on success, null for invalid credentials, and preserves outages.
 *
 * Verification errors fail closed and remain retryable.
 */
export async function resolveClerkSession(request: Request): Promise<ClerkSession | UnverifiableSession | null> {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;

    const session = await validateBearerToken(authHeader.slice(7));
    if (!session.valid) return session.reason === 'unverifiable' ? UNVERIFIABLE : null;
    if (!session.userId) return null;

    return {
      userId: session.userId,
      orgId: session.orgId ?? null,
      role: session.role ?? 'free',
    };
  } catch (err) {
    // sentry-coverage-ok Verification failures become retryable 503 responses; no credential failure is inferred.
    console.warn(
      '[auth-session] JWT verification failed:',
      err instanceof Error ? err.message : String(err),
    );
    return UNVERIFIABLE;
  }
}

/**
 * Resolve an endpoint identity or a retryable response when verification is unavailable.
 */
export async function resolveSessionUserId(request: Request): Promise<string | Response | null> {
  const session = await resolveClerkSession(request);
  if (session && 'reason' in session) return sessionVerificationUnavailableResponse();
  return session?.userId ?? null;
}
