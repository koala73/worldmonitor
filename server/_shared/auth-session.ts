/**
 * Gateway-level JWT verification for Clerk bearer tokens.
 *
 * Extracts and verifies the `Authorization: Bearer <token>` header using
 * the JWKS endpoint from CLERK_JWT_ISSUER_DOMAIN. Returns the userId
 * (JWT `sub` claim) on success, or null on any failure (fail-open).
 *
 * Activated by setting CLERK_JWT_ISSUER_DOMAIN env var. When not set,
 * all calls return null and the gateway falls back to API-key-only auth.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

// Cached JWKS — singleton per cold start, refreshed by jose internally.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> | null {
  if (_jwks) return _jwks;

  const issuerDomain = process.env.CLERK_JWT_ISSUER_DOMAIN;
  if (!issuerDomain) return null;

  const jwksUrl = new URL('/.well-known/jwks.json', issuerDomain);
  _jwks = createRemoteJWKSet(jwksUrl);
  return _jwks;
}

/**
 * Extracts and verifies a bearer token from the request.
 * Returns the userId (sub claim) on success, null on any failure.
 *
 * Fail-open: errors are logged but never thrown.
 */
export async function resolveSessionUserId(request: Request): Promise<string | null> {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;

    const token = authHeader.slice(7);
    if (!token) return null;

    const jwks = getJwks();
    if (!jwks) return null; // CLERK_JWT_ISSUER_DOMAIN not configured

    const issuerDomain = process.env.CLERK_JWT_ISSUER_DOMAIN!;
    const { payload } = await jwtVerify(token, jwks, {
      issuer: issuerDomain,
      algorithms: ['RS256'],
    });

    return (payload.sub as string) ?? null;
  } catch (err) {
    console.warn(
      '[auth-session] JWT verification failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
