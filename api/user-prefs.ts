/**
 * User preferences sync endpoint.
 *
 * GET  /api/user-prefs?variant=<variant>  — returns current cloud prefs for signed-in user
 * POST /api/user-prefs                     — saves prefs blob for signed-in user
 *
 * Authentication: Clerk Bearer token in Authorization header.
 * Requires CONVEX_URL + CLERK_JWT_ISSUER_DOMAIN env vars.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
import { ConvexHttpClient } from 'convex/browser';
import { validateBearerToken } from '../server/auth-session';

export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403);
  }

  const cors = getCorsHeaders(req, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
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

  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    return jsonResponse({ error: 'Service unavailable' }, 503, cors);
  }

  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const variant = url.searchParams.get('variant') ?? 'full';

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prefs = await client.query('userPreferences:getPreferences' as any, { variant });
      return jsonResponse(prefs ?? null, 200, cors);
    } catch (err) {
      console.error('[user-prefs] GET error:', err);
      captureSilentError(err, { tags: { route: 'api/user-prefs', method: 'GET' }, ctx });
      return jsonResponse({ error: 'Failed to fetch preferences' }, 500, cors);
    }
  }

  // POST — save prefs
  let body: { variant?: unknown; data?: unknown; expectedSyncVersion?: unknown; schemaVersion?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
  }

  if (
    typeof body.variant !== 'string' ||
    body.data === undefined ||
    typeof body.expectedSyncVersion !== 'number'
  ) {
    return jsonResponse({ error: 'MISSING_FIELDS' }, 400, cors);
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.mutation('userPreferences:setPreferences' as any, {
      variant: body.variant,
      data: body.data,
      expectedSyncVersion: body.expectedSyncVersion,
      schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : undefined,
    });
    return jsonResponse(result, 200, cors);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('CONFLICT')) {
      return jsonResponse({ error: 'CONFLICT' }, 409, cors);
    }
    if (msg.includes('BLOB_TOO_LARGE')) {
      return jsonResponse({ error: 'BLOB_TOO_LARGE' }, 400, cors);
    }
    console.error('[user-prefs] POST error:', err);
    captureSilentError(err, { tags: { route: 'api/user-prefs', method: 'POST' }, ctx });
    return jsonResponse({ error: 'Failed to save preferences' }, 500, cors);
  }
}
