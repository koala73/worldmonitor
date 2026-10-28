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

import { validateBearerToken, verifyClerkSessionActive } from '../auth-session';
import { renderBillingVerificationDenial, unverifiableEntitlementDenial } from './entitlement-check';

export interface ClerkSession {
  userId: string;
  orgId: string | null;
  role: 'free' | 'pro';
  /** Clerk `sid`; null when the token carries none (machine tokens). */
  sessionId?: string | null;
}

/** A session Clerk confirmed live for this request — see `resolveLiveClerkSession`. */
export interface LiveClerkSession {
  userId: string;
  sessionId: string;
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
 * Like `resolveClerkSession`, but the session must still be live at Clerk.
 *
 * For routes that trade the bearer for a credential that outlives it (the
 * desktop sign-in ticket, the Pro MCP grant). Signature verification alone
 * would let a token whose session was revoked — sign-out, "sign out other
 * devices", an admin revoke — be laundered into a fresh session until `exp`.
 *
 * Null (401) when the token carries no `sid` or Clerk reports the session
 * inactive; a retryable 503 when Clerk could not answer. Never minted on.
 */
export async function resolveLiveClerkSession(request: Request): Promise<LiveClerkSession | Response | null> {
  const session = await resolveClerkSession(request);
  if (!session) return null;
  if ('reason' in session) return sessionVerificationUnavailableResponse();
  if (!session.sessionId) return null;
  const check = await verifyClerkSessionActive(session.sessionId, session.userId);
  if (check === 'unavailable') return sessionVerificationUnavailableResponse();
  if (check !== 'active') return null;
  return { userId: session.userId, sessionId: session.sessionId };
}

/** `resolveSessionUserId` with the live-session requirement of `resolveLiveClerkSession`. */
export async function resolveLiveSessionUserId(request: Request): Promise<string | Response | null> {
  const session = await resolveLiveClerkSession(request);
  if (session instanceof Response) return session;
  return session?.userId ?? null;
}
