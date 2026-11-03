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

import { validateBearerToken, type ValidateBearerTokenOptions } from '../auth-session';
import { renderBillingVerificationDenial, unverifiableEntitlementDenial } from './entitlement-check';

export interface ClerkSession {
  userId: string;
  orgId: string | null;
  role: 'free' | 'pro';
  /**
   * Clerk `sid`; null when the token carries none (machine tokens). A route
   * that trades the bearer for a credential outliving it (desktop sign-in
   * ticket, Pro MCP grant) must pass this to `verifyClerkSessionActive` —
   * after its rate limit — since signature verification alone would let a
   * revoked session (sign-out, "sign out other devices", admin revoke) be
   * laundered into a fresh credential until `exp`.
   */
  sessionId?: string | null;
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
export async function resolveClerkSession(
  request: Request,
  options: ValidateBearerTokenOptions = {},
): Promise<ClerkSession | UnverifiableSession | null> {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;

    const session = await validateBearerToken(authHeader.slice(7), options);
    if (!session.valid) return session.reason === 'unverifiable' ? UNVERIFIABLE : null;
    if (!session.userId) return null;

    return {
      userId: session.userId,
      orgId: session.orgId ?? null,
      role: session.role ?? 'free',
      sessionId: session.sessionId ?? null,
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

/**
 * The bearer's identity from the local JWKS check alone — no outbound call —
 * as the retryable-denial contract: null = 401, Response = the token could not
 * be verified. Cheap enough to gate a per-user rate limiter; a route that then
 * needs the session live calls `verifyClerkSessionActive` on `sessionId` after
 * the limiter, so a limited caller never spends the shared Clerk quota.
 */
export async function resolveVerifiedClerkSession(request: Request): Promise<ClerkSession | Response | null> {
  // No plan lookup: these routes never read `role`, and a standard session
  // token (no `plan` claim) would otherwise cost one Clerk call per request
  // ahead of the limiter. Only the cached JWKS fetch remains.
  const session = await resolveClerkSession(request, { resolvePlan: false });
  if (!session) return null;
  if ('reason' in session) return sessionVerificationUnavailableResponse();
  return session;
}
