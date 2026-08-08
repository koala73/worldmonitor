/**
 * POST /api/user/mcp-revoke
 *
 * Clerk-authenticated endpoint that revokes a Pro MCP token row owned by
 * the caller and invalidates any in-flight bearer cache.
 *
 * Tenancy model:
 *   The `userId` forwarded to Convex's `internal-revoke-pro-mcp-token` HTTP
 *   action is taken from the freshly-verified Clerk session — never from
 *   the request body. The Convex `internalRevokeProMcpToken` mutation
 *   asserts `row.userId === userId` (NOT_FOUND otherwise), so a Pro user
 *   cannot revoke another user's token even if they craft the body.
 *
 *   We deliberately call the INTERNAL HTTP route rather than the public
 *   `revokeProMcpToken` Convex mutation. Two reasons:
 *     1. Memory `convex-httpclient-no-default-timeout-bypasses-typed-503`:
 *        instantiating `ConvexHttpClient` from the edge with no default
 *        fetch timeout is a known foot-gun. The internal route is plain
 *        fetch with `AbortSignal.timeout` — same posture as U2's helper.
 *     2. Atomicity with the negative-cache invalidation: after Convex
 *        revokes successfully, we set `pro-mcp-token-neg:<tokenId>` so
 *        any in-flight Pro MCP request whose bearer points to this row
 *        gets a 401 within the 60s neg-cache window.
 *
 * Request:  { tokenId: string }
 * Response: { ok: true }
 *
 * Status codes:
 *   - 200 success
 *   - 400 missing/empty tokenId
 *   - 401 missing/invalid Clerk session
 *   - 404 Convex returned NOT_FOUND (caller does not own this row, OR the
 *         row id is malformed/never-existed — collapsed per anti-enumeration)
 *   - 405 non-POST
 *   - 409 Convex returned ALREADY_REVOKED
 *   - 503 Convex network/transient error (Retry-After: 5)
 *
 * Cache-Control: no-store.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
import { resolveClerkSession } from '../../server/_shared/auth-session';
import { invalidateProMcpTokenCache } from '../../server/_shared/pro-mcp-token';

/** Convex internal HTTP-action call timeout. Mirrors U2's pro-mcp-token.ts. */
const CONVEX_TIMEOUT_MS = 3_000;

/** Inner handler — exported for unit tests with injected deps. */
export interface RevokeDeps {
  /** Resolves the Clerk userId from the request's Bearer header. Null = unauth. */
  resolveUserId: (req: Request) => Promise<string | null>;
  /**
   * Calls Convex `/api/internal-revoke-pro-mcp-token` server-to-server.
   * Returns the discriminated outcome:
   *   - ok: 200 from Convex
   *   - not-found: 404 (NOT_FOUND or invalid id)
   *   - already-revoked: 409
   *   - network: 5xx, transport error, timeout, or env unset
   */
  convexRevoke: (
    userId: string,
    tokenId: string,
  ) => Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'already-revoked' | 'network' }>;
  /**
   * Best-effort negative-cache write. Failures are logged but do NOT mask
   * the success — the revoke is already authoritative on Convex; the cache
   * sentinel is a defensive optimisation that shrinks the staleness window
   * for already-resolved bearers from "next bearer-resolution" to "next
   * negative-cache read".
   */
  invalidateCache: (tokenId: string) => Promise<void>;
}

async function callConvexRevoke(
  userId: string,
  tokenId: string,
): Promise<
  { ok: true } | { ok: false; reason: 'not-found' | 'already-revoked' | 'network' }
> {
  const siteUrl = process.env.CONVEX_SITE_URL;
  const sharedSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
  if (!siteUrl || !sharedSecret) {
    return { ok: false, reason: 'network' };
  }

  let resp: Response;
  try {
    resp = await fetch(`${siteUrl}/api/internal-revoke-pro-mcp-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-gateway/1.0',
        'x-convex-shared-secret': sharedSecret,
      },
      body: JSON.stringify({ userId, tokenId }),
      signal: AbortSignal.timeout(CONVEX_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(
      '[mcp-revoke] Convex fetch failed:',
      err instanceof Error ? err.message : String(err),
    );
    captureSilentError(err, {
      tags: { route: 'api/user/mcp-revoke', step: 'convex-fetch' },
    });
    return { ok: false, reason: 'network' };
  }

  if (resp.ok) return { ok: true };
  if (resp.status === 404) return { ok: false, reason: 'not-found' };
  if (resp.status === 409) return { ok: false, reason: 'already-revoked' };
  return { ok: false, reason: 'network' };
}

export async function revokeHandler(req: Request, deps: RevokeDeps): Promise<Response> {
  const cors = getCorsHeaders(req);
  const jsonHeaders = {
    ...cors,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...jsonHeaders, Allow: 'POST, OPTIONS' },
    });
  }

  const userId = await deps.resolveUserId(req);
  if (!userId) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: jsonHeaders,
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const tokenId = (body as { tokenId?: unknown })?.tokenId;
  if (typeof tokenId !== 'string' || tokenId.length === 0) {
    return new Response(JSON.stringify({ error: 'missing_token_id' }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  // userId here is ALWAYS from the Clerk session — never trust client input.
  const result = await deps.convexRevoke(userId, tokenId);

  if (result.ok) {
    // Best-effort cache invalidation. Failures are swallowed here AND
    // inside invalidateProMcpTokenCache (writeNegCache logs + returns).
    // The revoke succeeded on Convex, which is the authoritative state —
    // surfacing a Redis blip as a 5xx would mislead the user about whether
    // the revoke actually landed (it did). The 60s neg-cache window is
    // still bounded by the read side: U2's validate path always Convex-
    // round-trips on cache miss, so a missed sentinel write only delays
    // bearer-revocation propagation by exactly one fetch.
    try {
      await deps.invalidateCache(tokenId);
    } catch (err) {
      console.warn(
        '[mcp-revoke] invalidateCache failed (revoke still succeeded):',
        err instanceof Error ? err.message : String(err),
      );
      captureSilentError(err, {
        tags: { route: 'api/user/mcp-revoke', step: 'invalidate-cache' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: jsonHeaders });
  }

  if (result.reason === 'not-found') {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: jsonHeaders,
    });
  }
  if (result.reason === 'already-revoked') {
    return new Response(JSON.stringify({ error: 'already_revoked' }), {
      status: 409,
      headers: jsonHeaders,
    });
  }
  // network → 503 + Retry-After (mirrors U7's typed-503 posture).
  return new Response(JSON.stringify({ error: 'service_unavailable' }), {
    status: 503,
    headers: { ...jsonHeaders, 'Retry-After': '5' },
  });
}

export default async function handler(req: Request): Promise<Response> {
  return revokeHandler(req, {
    resolveUserId: async (r) => (await resolveClerkSession(r))?.userId ?? null,
    convexRevoke: callConvexRevoke,
    invalidateCache: invalidateProMcpTokenCache,
  });
}
