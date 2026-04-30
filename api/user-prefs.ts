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
// @ts-expect-error — JS module, no declaration file
import { extractConvexErrorKind, readConvexErrorNumber } from './_convex-error.js';
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
      const kind = extractConvexErrorKind(err, msg);
      // UNAUTHENTICATED on this path means the Clerk token PASSED our edge's
      // `validateBearerToken` but Convex still rejected it — i.e. genuine
      // auth/audience/issuer drift between our Clerk JWKS validation and
      // Convex's auth config (a Clerk JWKS rotation lag, an audience mismatch,
      // a stale CLERK_JWT_ISSUER_DOMAIN env var). User-bad-token cases are
      // caught earlier (the `validateBearerToken` 401 above) and never reach
      // this catch. Capture before returning 401 so the drift surfaces under
      // a stable Sentry bucket instead of silently 401'ing every request.
      if (kind === 'UNAUTHENTICATED') {
        console.error('[user-prefs] GET convex auth drift:', err);
        captureSilentError(err, buildSentryContext(err, msg, {
          method: 'GET', convexFn: 'userPreferences:getPreferences',
          userId: session.userId, variant, ctx,
        }));
        return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
      }
      if (kind === 'SERVICE_UNAVAILABLE') {
        // Convex platform-level 503 — transient and self-recovering. Map to
        // 503 with `Retry-After` so the client backs off rather than treating
        // it as a permanent 500. Still capture so we can spot regressions /
        // sustained outages, but use the typed `convex_service_unavailable`
        // shape so it groups distinctly from real internal 500s.
        console.warn('[user-prefs] GET convex service unavailable:', msg);
        captureSilentError(err, buildSentryContext(err, msg, {
          method: 'GET', convexFn: 'userPreferences:getPreferences',
          userId: session.userId, variant, ctx,
        }));
        return jsonResponse({ error: 'SERVICE_UNAVAILABLE' }, 503, { ...cors, 'Retry-After': '5' });
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
    const kind = extractConvexErrorKind(err, msg);
    if (kind === 'CONFLICT') {
      return handleConflictResponse(err, msg, {
        userId: session.userId,
        variant: body.variant,
        ctx,
        schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : null,
        expectedSyncVersion: body.expectedSyncVersion,
        blobSize: body.data !== undefined ? JSON.stringify(body.data).length : 0,
        cors,
      });
    }
    if (kind === 'BLOB_TOO_LARGE') {
      return jsonResponse({ error: 'BLOB_TOO_LARGE' }, 400, cors);
    }
    if (kind === 'UNAUTHENTICATED') {
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
    if (kind === 'SERVICE_UNAVAILABLE') {
      // See GET branch above — Convex 503, transient. 503 + Retry-After
      // so the client backs off rather than burning a 500-failed-write.
      console.warn('[user-prefs] POST convex service unavailable:', msg);
      captureSilentError(err, buildSentryContext(err, msg, {
        method: 'POST', convexFn: 'userPreferences:setPreferences',
        userId: session.userId, variant: body.variant, ctx,
        schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : null,
        expectedSyncVersion: body.expectedSyncVersion,
        blobSize: body.data !== undefined ? JSON.stringify(body.data).length : 0,
      }));
      return jsonResponse({ error: 'SERVICE_UNAVAILABLE' }, 503, { ...cors, 'Retry-After': '5' });
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
 * 409-CONFLICT response builder for setPreferences. Captures every
 * CONFLICT to Sentry so we can detect stuck-bundle users (constant
 * `actual_sync_version` across timestamps with no success interleaved
 * → one client looping; broadly-distributed `user_id` → real concurrency).
 * The CAS guard itself is intentional behavior, but we lose all per-user
 * attribution if we don't record it — Convex Insights surfaces a count but
 * no userId. Also: PR 1 ships a stale-bundle force-reload (build-hash
 * mismatch) to drain stuck-bundle users; this capture is how we verify
 * the storm decays.
 *
 * Echoes `actualSyncVersion` from the structured ConvexError when present
 * and numeric so the client can refresh its local sync state without a
 * follow-up GET. Type-guarded — drops non-numeric values rather than
 * forwarding them as `unknown`.
 */
function handleConflictResponse(
  err: unknown,
  msg: string,
  opts: {
    userId: string;
    variant: unknown;
    ctx?: { waitUntil: (p: Promise<unknown>) => void };
    schemaVersion: number | null;
    expectedSyncVersion: unknown;
    blobSize: number;
    cors: Record<string, string>;
  },
): Response {
  const actualSyncVersion = readConvexErrorNumber(err, 'actualSyncVersion');
  captureSilentError(err, buildSentryContext(err, msg, {
    method: 'POST',
    convexFn: 'userPreferences:setPreferences',
    userId: opts.userId,
    variant: opts.variant,
    ctx: opts.ctx,
    schemaVersion: opts.schemaVersion,
    expectedSyncVersion: opts.expectedSyncVersion,
    blobSize: opts.blobSize,
    errorShapeOverride: 'setPreferences_conflict',
    extraTags: actualSyncVersion !== undefined ? { actual_sync_version: actualSyncVersion } : undefined,
  }));
  return jsonResponse(
    actualSyncVersion !== undefined ? { error: 'CONFLICT', actualSyncVersion } : { error: 'CONFLICT' },
    409,
    opts.cors,
  );
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
 *
 * Exported for unit tests. The Vercel edge runtime ignores non-default
 * exports, so this has no production-side effect.
 */
export function buildSentryContext(
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
    // Override the message-pattern classification when the caller already
    // knows the error shape (e.g. CONFLICT, where the throw is intentional
    // and routing through msg-pattern matching would mis-classify it as
    // 'unknown'). Skipped through the same `errorShape` field so
    // fingerprint and tags stay stable.
    errorShapeOverride?: string;
    // Additional tags (queryable in Sentry, unlike `extra`). Used e.g. to
    // pass `actual_sync_version` so on-call can group/filter by it.
    extraTags?: Record<string, string | number>;
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
  // SERVICE_UNAVAILABLE (Convex platform 503) is also its own bucket — it
  // would otherwise fall into 'unknown' and conflate transient outages with
  // genuinely-novel failure modes that haven't been classified yet.
  const errorShape = opts.errorShapeOverride
    ?? (/UNAUTHENTICATED/.test(msg) ? 'convex_auth_drift'
      : /"code":"ServiceUnavailable"/.test(msg) ? 'convex_service_unavailable'
      : /\[Request ID:\s*[a-f0-9]+\]\s*Server Error/i.test(msg) ? 'convex_server_error'
      : /timeout|timed out|aborted/i.test(msg) ? 'transport_timeout'
      : /fetch failed|network|ECONN|ENOTFOUND|getaddrinfo/i.test(msg) ? 'transport_network'
      : 'unknown');

  return {
    tags: {
      route: 'api/user-prefs',
      method: opts.method,
      convex_fn: opts.convexFn,
      error_shape: errorShape,
      // Promote userId from `extra` to `tags` so Sentry can group conflicts
      // by user. Clerk user IDs are opaque strings (e.g. `user_2x8K3...`),
      // not numbers — pass through as-is.
      user_id: opts.userId,
      ...(convexRequestId ? { convex_request_id: convexRequestId } : {}),
      // Skip the minified `errName` (e.g. 'I') — it's noise, not signal — but
      // keep meaningful names like ConvexError / TypeError / SyntaxError.
      // `> 1` is the minimal guard for single-character noise; all real built-in
      // error class names are well above that.
      ...(errName !== 'unknown' && errName !== 'Error' && errName.length > 1
        ? { error_name: errName }
        : {}),
      ...(opts.extraTags ?? {}),
    },
    extra: {
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
