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
      const msg = err instanceof Error ? err.message : String(err);
      // UNAUTHENTICATED on this path means the Clerk token PASSED our edge's
      // `validateBearerToken` but Convex still rejected it — i.e. genuine
      // auth/audience/issuer drift between our Clerk JWKS validation and
      // Convex's auth config (a Clerk JWKS rotation lag, an audience mismatch,
      // a stale CLERK_JWT_ISSUER_DOMAIN env var). User-bad-token cases are
      // caught earlier (the `validateBearerToken` 401 above) and never reach
      // this catch. Capture before returning 401 so the drift surfaces under
      // a stable Sentry bucket instead of silently 401'ing every request.
      if (msg.includes('UNAUTHENTICATED')) {
        console.error('[user-prefs] GET convex auth drift:', err);
        captureSilentError(err, buildSentryContext(err, msg, {
          method: 'GET', convexFn: 'userPreferences:getPreferences',
          userId: session.userId, variant, ctx,
        }));
        return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
      }
      console.error('[user-prefs] GET error:', err);
      captureSilentError(err, buildSentryContext(err, msg, {
        method: 'GET', convexFn: 'userPreferences:getPreferences',
        userId: session.userId, variant, ctx,
      }));
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
    if (msg.includes('UNAUTHENTICATED')) {
      // See GET branch above — UNAUTHENTICATED here means Clerk-vs-Convex
      // auth drift (token already passed validateBearerToken). Capture
      // before returning 401 so the drift is visible.
      console.error('[user-prefs] POST convex auth drift:', err);
      captureSilentError(err, buildSentryContext(err, msg, {
        method: 'POST', convexFn: 'userPreferences:setPreferences',
        userId: session.userId, variant: body.variant, ctx,
        schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : null,
        expectedSyncVersion: body.expectedSyncVersion,
        blobSize: body.data !== undefined ? JSON.stringify(body.data).length : 0,
      }));
      return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
    }
    console.error('[user-prefs] POST error:', err);
    captureSilentError(err, buildSentryContext(err, msg, {
      method: 'POST', convexFn: 'userPreferences:setPreferences',
      userId: session.userId, variant: body.variant, ctx,
      schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : null,
      expectedSyncVersion: body.expectedSyncVersion,
      blobSize: body.data !== undefined ? JSON.stringify(body.data).length : 0,
    }));
    return jsonResponse({ error: 'Failed to save preferences' }, 500, cors);
  }
}

/**
 * Build a captureSilentError context that carries enough provenance to triage
 * a 500 from this endpoint without re-running the request:
 *   - `convex_request_id` tag: the `[Request ID: X]` from Convex's error message,
 *     queryable in Sentry and grep-able against Convex's dashboard logs.
 *   - `error_shape` tag: classifies what KIND of failure this is so a single
 *     Sentry filter splits "Convex internal 500" from "transport timeout" from
 *     "everything else", instead of every flavor sharing the same opaque bucket.
 *   - Stable `fingerprint`: forces Sentry to group by (route, method, error_shape)
 *     rather than by the ever-varying request-id-bearing message — without this,
 *     each request_id would create a new "issue" and drown the dashboard.
 */
function buildSentryContext(
  err: unknown,
  msg: string,
  opts: {
    method: 'GET' | 'POST';
    convexFn: string;
    userId: string;
    variant?: unknown;
    ctx?: { waitUntil: (p: Promise<unknown>) => void };
    schemaVersion?: number | null;
    expectedSyncVersion?: unknown;
    blobSize?: number;
  },
): {
  tags: Record<string, string | number>;
  extra: Record<string, unknown>;
  fingerprint: string[];
  ctx?: { waitUntil: (p: Promise<unknown>) => void };
} {
  const errName = err instanceof Error ? err.name : 'unknown';
  const requestIdMatch = msg.match(/\[Request ID:\s*([a-f0-9]+)\]/i);
  const convexRequestId = requestIdMatch?.[1];
  // Order matters: UNAUTHENTICATED is more specific than the request-id
  // server-error shape and must be checked first. Auth drift is its own bucket
  // so it groups separately from genuine Convex 5xx in the Sentry dashboard.
  const errorShape = /UNAUTHENTICATED/.test(msg) ? 'convex_auth_drift'
    : /\[Request ID:\s*[a-f0-9]+\]\s*Server Error/i.test(msg) ? 'convex_server_error'
    : /timeout|timed out|aborted/i.test(msg) ? 'transport_timeout'
    : /fetch failed|network|ECONN|ENOTFOUND|getaddrinfo/i.test(msg) ? 'transport_network'
    : 'unknown';

  return {
    tags: {
      route: 'api/user-prefs',
      method: opts.method,
      convex_fn: opts.convexFn,
      error_shape: errorShape,
      ...(convexRequestId ? { convex_request_id: convexRequestId } : {}),
      // Skip the minified `errName` (e.g. 'I') — it's noise, not signal — but
      // keep meaningful names like ConvexError / TypeError / SyntaxError.
      // `> 1` is the minimal guard for single-character noise; all real built-in
      // error class names are well above that.
      ...(errName !== 'unknown' && errName !== 'Error' && errName.length > 1
        ? { error_name: errName }
        : {}),
    },
    extra: {
      userId: opts.userId,
      variant: typeof opts.variant === 'string' ? opts.variant : 'unknown',
      messageHead: msg.slice(0, 300),
      ...(opts.schemaVersion !== undefined ? { schemaVersion: opts.schemaVersion } : {}),
      ...(opts.expectedSyncVersion !== undefined ? { expectedSyncVersion: opts.expectedSyncVersion } : {}),
      ...(opts.blobSize !== undefined ? { blobSize: opts.blobSize } : {}),
    },
    fingerprint: ['api/user-prefs', opts.method, errorShape],
    ctx: opts.ctx,
  };
}
