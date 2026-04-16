/**
 * POST /api/invalidate-user-api-key-cache
 *
 * Deletes the Redis cache entry for a revoked user API key so the gateway
 * stops accepting it immediately instead of waiting for TTL expiry.
 *
 * Authentication: Clerk Bearer token (any signed-in user).
 * Body: { keyHash: string }
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
import { validateBearerToken } from '../server/auth-session';
import { invalidateApiKeyCache } from '../server/_shared/user-api-key';

export default async function handler(req: Request): Promise<Response> {
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

  await invalidateApiKeyCache(keyHash);

  return jsonResponse({ ok: true }, 200, cors);
}
