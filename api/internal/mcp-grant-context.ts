/**
 * GET /api/internal/mcp-grant-context?nonce=<n>
 *
 * Read-only companion to `api/internal/mcp-grant-mint.ts` (U3). The apex
 * `/mcp-grant` SPA calls this on mount to render the REAL `client_name`
 * + `redirect_host` extracted from the registered OAuth client metadata,
 * so the user can spot consent-phishing attempts (a malicious client
 * cannot lie about its display name to a Pro user).
 *
 * Validation matches the mint endpoint exactly — a tier-0 caller MUST
 * not receive client metadata they could exfiltrate, and a missing
 * nonce MUST return the same INVALID_NONCE shape the mint emits. This
 * keeps the SPA's error handling on a single canonical contract.
 *
 * Errors:
 *   - UNAUTHENTICATED              401  no/invalid Clerk JWT
 *   - INVALID_REQUEST              400  missing nonce
 *   - INVALID_NONCE                400  Redis nonce miss / expired
 *   - UNKNOWN_CLIENT               400  Redis client miss
 *   - INSUFFICIENT_TIER            403  user tier < 1 or expired (do NOT
 *                                       leak client_name to non-Pro callers)
 *   - NONCE_CLAIMED_BY_OTHER_USER  403  the nonce has been claimed by a
 *                                       different Clerk userId (F2 — the
 *                                       apex page must NOT render context
 *                                       for a hijacked nonce).
 *   - SERVICE_UNAVAILABLE          503  Redis transport failure
 *
 * Cache-Control: no-store on every path.
 */

export const config = { runtime: 'edge' };

import { resolveClerkSession } from '../../server/_shared/auth-session';
import { getEntitlements } from '../../server/_shared/entitlement-check';

const NO_STORE_JSON: Record<string, string> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function jsonError(error: string, error_description: string, status: number): Response {
  return new Response(JSON.stringify({ error, error_description }), { status, headers: NO_STORE_JSON });
}

interface NonceData {
  client_id: string;
  redirect_uri: string;
}

interface ClientData {
  client_name?: string;
}

async function rawRedisGet(key: string): Promise<unknown | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = await resp.json() as { result?: string | null };
  if (!data?.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

export interface ContextDeps {
  resolveUserId: (req: Request) => Promise<string | null>;
  redisGet: (key: string) => Promise<unknown | null>;
  getEntitlements: (userId: string) => Promise<{ features: { tier: number; mcpAccess?: boolean }; validUntil: number } | null>;
  now: () => number;
}

export async function grantContextHandler(req: Request, deps: ContextDeps): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), {
      status: 405, headers: { ...NO_STORE_JSON, Allow: 'GET' },
    });
  }

  const userId = await deps.resolveUserId(req);
  if (!userId) {
    return jsonError('UNAUTHENTICATED', 'A valid Clerk session is required.', 401);
  }

  const url = new URL(req.url);
  const nonce = url.searchParams.get('nonce') ?? '';
  if (!nonce) {
    return jsonError('INVALID_REQUEST', 'Missing `nonce` query parameter.', 400);
  }

  // Pro gate BEFORE leaking any client_name — a tier-0 caller probing the
  // endpoint must not see whether a given nonce/client exists.
  //
  // Mirror the downstream MCP-edge gate (api/mcp.ts runProPreChecks): both
  // tier ≥ 1 AND mcpAccess === true are required. Reviewer round-2 finding
  // P2 — gating on tier alone here lets a tier-1 user without mcpAccess
  // complete OAuth, get a tokenId, then have every tools/call fail at the
  // gateway. The two gates must agree.
  const ent = await deps.getEntitlements(userId);
  if (
    !ent ||
    ent.features.tier < 1 ||
    ent.features.mcpAccess !== true ||
    ent.validUntil < deps.now()
  ) {
    return jsonError('INSUFFICIENT_TIER', 'A WorldMonitor Pro subscription is required.', 403);
  }

  // F2 (U7+U8 review pass): if `mcp-grant:<n>` exists with a userId that
  // doesn't match the Clerk session's userId, the nonce has been claimed
  // by another user. The apex SPA MUST refuse to render context for a
  // hijacked nonce — otherwise the SPA would happily display the
  // attacker-mintable client_name and let the victim "Approve". We
  // surface 403 NONCE_CLAIMED_BY_OTHER_USER so the SPA can show a clear
  // anti-hijack message rather than the normal consent UI. Absence of
  // the record (no claim yet) is acceptable — the victim's page renders
  // the consent UI normally and the FIRST mint (theirs) will claim the
  // nonce.
  let claim: { userId?: unknown } | null;
  try {
    claim = (await deps.redisGet(`mcp-grant:${nonce}`)) as { userId?: unknown } | null;
  } catch {
    return jsonError('SERVICE_UNAVAILABLE', 'Authorization storage is temporarily unavailable.', 503);
  }
  if (claim && typeof claim.userId === 'string' && claim.userId !== userId) {
    return jsonError(
      'NONCE_CLAIMED_BY_OTHER_USER',
      'This authorization request has already been claimed by another account.',
      403,
    );
  }

  let nonceData: NonceData | null;
  try {
    nonceData = (await deps.redisGet(`oauth:nonce:${nonce}`)) as NonceData | null;
  } catch {
    return jsonError('SERVICE_UNAVAILABLE', 'Authorization storage is temporarily unavailable.', 503);
  }
  if (!nonceData || typeof nonceData.client_id !== 'string' || typeof nonceData.redirect_uri !== 'string') {
    return jsonError('INVALID_NONCE', 'The authorization nonce is missing or expired.', 400);
  }

  let clientData: ClientData | null;
  try {
    clientData = (await deps.redisGet(`oauth:client:${nonceData.client_id}`)) as ClientData | null;
  } catch {
    return jsonError('SERVICE_UNAVAILABLE', 'Authorization storage is temporarily unavailable.', 503);
  }
  if (!clientData) {
    return jsonError('UNKNOWN_CLIENT', 'The OAuth client is not registered.', 400);
  }

  let redirectHost = '';
  try {
    redirectHost = new URL(nonceData.redirect_uri).hostname;
  } catch {
    // Already validated at registration time; defense-in-depth catch.
    return jsonError('INVALID_REDIRECT_URI', 'The registered redirect URI is malformed.', 400);
  }

  const client_name = typeof clientData.client_name === 'string' && clientData.client_name.length > 0
    ? clientData.client_name
    : 'Unknown Client';

  return new Response(JSON.stringify({ client_name, redirect_host: redirectHost }), {
    status: 200, headers: NO_STORE_JSON,
  });
}

export default async function handler(req: Request): Promise<Response> {
  return grantContextHandler(req, {
    resolveUserId: async (r) => (await resolveClerkSession(r))?.userId ?? null,
    redisGet: rawRedisGet,
    getEntitlements: (userId) => getEntitlements(userId),
    now: () => Date.now(),
  });
}
