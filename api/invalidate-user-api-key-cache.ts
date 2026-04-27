/**
 * POST /api/invalidate-user-api-key-cache
 *
 * Deletes the Redis cache entry for a revoked user API key so the gateway
 * stops accepting it immediately instead of waiting for TTL expiry.
 *
 * Authentication: Clerk Bearer token (any signed-in user).
 * Body: { keyHash: string }
 *
 * Ownership is verified via Convex — the keyHash must belong to the caller.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
import { validateBearerToken } from '../server/auth-session';
import { invalidateApiKeyCache } from '../server/_shared/user-api-key';

export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403);
  }

  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
  }

  const session = await validateBearerToken(token);
  if (!session.valid || !session.userId) {
    return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
  }

  let body: { keyHash?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 422, cors);
  }

  const { keyHash } = body;
  if (typeof keyHash !== 'string' || !/^[a-f0-9]{64}$/.test(keyHash)) {
    return jsonResponse({ error: 'Invalid keyHash' }, 422, cors);
  }

  // Verify the keyHash belongs to the calling user (tenancy boundary).
  // Fail-closed: if ownership cannot be verified, reject the request.
  const convexSiteUrl = process.env.CONVEX_SITE_URL;
  const convexSharedSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
  if (!convexSiteUrl || !convexSharedSecret) {
    console.warn('[invalidate-cache] Missing CONVEX_SITE_URL or CONVEX_SERVER_SHARED_SECRET');
    return jsonResponse({ error: 'Service unavailable' }, 503, cors);
  }

  try {
    const ownerResp = await fetch(`${convexSiteUrl}/api/internal-get-key-owner`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-convex-shared-secret': convexSharedSecret,
      },
      body: JSON.stringify({ keyHash }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!ownerResp.ok) {
      console.warn(`[invalidate-cache] Convex ownership check HTTP ${ownerResp.status}`);
      return jsonResponse({ error: 'Service unavailable' }, 503, cors);
    }
    const ownerData = await ownerResp.json() as { userId?: string } | null;
    if (!ownerData) {
      // Hash not in DB — nothing to invalidate, but not an error
      return jsonResponse({ ok: true }, 200, cors);
    }
    if (ownerData.userId !== session.userId) {
      return jsonResponse({ error: 'FORBIDDEN' }, 403, cors);
    }
  } catch (err) {
    // Fail-closed: ownership check failed — reject to surface the issue
    console.warn('[invalidate-cache] Ownership check failed:', err instanceof Error ? err.message : String(err));
    captureSilentError(err, {
      tags: { route: 'api/invalidate-user-api-key-cache', step: 'ownership-check' },
      ctx,
    });
    return jsonResponse({ error: 'Service unavailable' }, 503, cors);
  }

  await invalidateApiKeyCache(keyHash);

  return jsonResponse({ ok: true }, 200, cors);
}
