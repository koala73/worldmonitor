/**
 * POST /api/internal/mcp-grant-mint
 *
 * Apex-domain edge function. Bridges the Clerk session at
 * `worldmonitor.app/mcp-grant` to the api-subdomain consent flow at
 * `api.worldmonitor.app/oauth/authorize-pro` (U5).
 *
 * Flow:
 *   1. Caller is the Clerk-authenticated apex page; sends Bearer JWT +
 *      JSON `{nonce}` (nonce minted by `api/oauth/authorize.js` and
 *      stored at `oauth:nonce:<n>`).
 *   2. Resolve userId via Clerk JWKS verify. 401 on miss.
 *   3. Validate `oauth:nonce:<n>` exists (DO NOT consume — U5 consumes).
 *   4. Validate `oauth:client:<client_id>` exists.
 *   5. Re-validate the client's `redirect_uri` against the same
 *      allowlist DCR enforced (defense-in-depth).
 *   6. Check `getEntitlements(userId).features.tier >= 1` (Pro gate).
 *   7. Mint a HMAC-signed grant token over `{userId, nonce, exp:+5min}`
 *      and store a one-shot `mcp-grant:<n>` Redis record with the same
 *      `{userId, exp}` payload (5-min TTL).
 *   8. Return JSON `{redirect: '<fixed url>?nonce=<n>&grant=<token>'}`.
 *
 * The redirect URL host is FIXED to `https://api.worldmonitor.app` —
 * never user-controllable — to defeat the consent-phishing class
 * (see plan Risks: "Cross-subdomain CSRF / consent phishing").
 *
 * All responses set Cache-Control: no-store. Errors return structured
 * JSON `{error, error_description}` with stable error codes:
 *   - UNAUTHENTICATED              401  no/invalid Clerk JWT
 *   - INVALID_REQUEST              400  malformed body / missing nonce
 *   - INVALID_NONCE                400  Redis nonce miss / expired
 *   - UNKNOWN_CLIENT               400  Redis client miss
 *   - INVALID_REDIRECT_URI         400  client redirect_uri no longer allowlisted
 *   - INSUFFICIENT_TIER            403  user tier < 1 or expired
 *   - NONCE_CLAIMED_BY_OTHER_USER  403  nonce already claimed by a different
 *                                       Clerk userId (anti-hijack — see F2)
 *   - SERVICE_UNAVAILABLE          503  Redis SETEX failure
 *   - CONFIGURATION_ERROR          500  MCP_PRO_GRANT_HMAC_SECRET unset
 *
 * F2 (U7+U8 review pass) — anti-hijack semantics:
 *   `oauth:nonce:<n>` carries no Clerk userId binding. Without F2, any
 *   Pro user could mint a grant for any nonce, then deliver the redirect
 *   URL to a victim, who would exchange it for a bearer bound to the
 *   ATTACKER's userId. F2 introduces a SET-NX-style claim on
 *   `mcp-grant:<n>` itself: the FIRST mint atomically claims the nonce
 *   and writes the userId into the record; subsequent mints from a
 *   DIFFERENT userId are refused with NONCE_CLAIMED_BY_OTHER_USER. Mints
 *   from the SAME userId (multi-tab) succeed idempotently. The
 *   companion check at `/api/internal/mcp-grant-context` returns the
 *   same 403 so the apex page also refuses to render context for a
 *   hijacked nonce.
 */

export const config = { runtime: 'edge' };

import { resolveClerkSession } from '../../server/_shared/auth-session';
import { getEntitlements } from '../../server/_shared/entitlement-check';
// @ts-expect-error — JS module, no declaration file
import { isAllowedRedirectUri } from '../oauth/register.js';
import { GrantConfigError, signGrant } from '../_mcp-grant-hmac';

// Fixed return URL — NOT user-controllable (anti-phishing).
const AUTHORIZE_PRO_URL = 'https://api.worldmonitor.app/oauth/authorize-pro';

/** 5-minute exp for the signed grant + matching Redis one-shot. */
const GRANT_TTL_MS = 5 * 60 * 1000;
const GRANT_TTL_SECONDS = 300;

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
  code_challenge: string;
  state?: string;
  created_at?: number;
}

interface ClientData {
  client_name?: string;
  redirect_uris?: unknown;
}

// ---------------------------------------------------------------------------
// Redis helpers — read raw `oauth:*` keys via Upstash REST. These keys are
// written by api/oauth/authorize.js and api/oauth/register.js with NO
// deployment prefix, so we MUST match their on-the-wire format.
// ---------------------------------------------------------------------------

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

async function rawRedisSetEx(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', ttlSeconds]]),
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return false;
    const results = await resp.json().catch(() => null);
    return Array.isArray(results) && results[0]?.result === 'OK';
  } catch { return false; }
}

/**
 * Atomic SET with NX (only set if key does not exist) + EX TTL.
 *
 * F2 (U7+U8 review pass): used to claim `mcp-grant:<n>` for a userId.
 * Returns `true` if the key was claimed (SET NX returned OK), `false` if
 * the key already existed (SET NX returned nil) OR on any transport
 * failure. Caller then GETs the existing record to compare userIds.
 *
 * Upstash REST returns `{result: "OK"}` on success and `{result: null}`
 * on NX-collision. We check string equality on the result.
 */
async function rawRedisSetNxEx(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', ttlSeconds, 'NX']]),
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) return false;
    const results = await resp.json().catch(() => null);
    return Array.isArray(results) && results[0]?.result === 'OK';
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Inner handler — exported for unit tests with injected deps.
// ---------------------------------------------------------------------------

export interface MintDeps {
  /** Resolves the Clerk userId from the request's Bearer header. Null = unauth. */
  resolveUserId: (req: Request) => Promise<string | null>;
  /** Reads a raw `oauth:*` or `mcp-grant:*` key from Redis. Throws on transport failure. */
  redisGet: (key: string) => Promise<unknown | null>;
  /** Writes a raw `mcp-grant:*` key with TTL. Returns false on failure. */
  redisSetEx: (key: string, value: unknown, ttlSeconds: number) => Promise<boolean>;
  /**
   * F2: atomic SET NX EX of `mcp-grant:<n>`. Returns true if the key was
   * claimed (no prior record), false if a prior record exists OR on
   * transport failure. Caller decides whether to GET-and-compare or 503.
   */
  redisSetNxEx: (key: string, value: unknown, ttlSeconds: number) => Promise<boolean>;
  /** Returns Pro entitlement info or null. */
  getEntitlements: (userId: string) => Promise<{ features: { tier: number; mcpAccess?: boolean }; validUntil: number } | null>;
  /** Same allowlist DCR uses. */
  isAllowedRedirectUri: (uri: string) => boolean;
  /** Signs the wire-format grant token. Throws GrantConfigError if env unset. */
  signGrant: (payload: { userId: string; nonce: string; exp: number }) => Promise<string>;
  /** Injectable for deterministic tests. */
  now: () => number;
}

export async function mintGrantHandler(req: Request, deps: MintDeps): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), {
      status: 405, headers: { ...NO_STORE_JSON, Allow: 'POST' },
    });
  }

  const userId = await deps.resolveUserId(req);
  if (!userId) {
    return jsonError('UNAUTHENTICATED', 'A valid Clerk session is required.', 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('INVALID_REQUEST', 'Request body must be JSON.', 400);
  }
  const nonce = (body as { nonce?: unknown })?.nonce;
  if (typeof nonce !== 'string' || nonce.length === 0) {
    return jsonError('INVALID_REQUEST', 'Missing or empty `nonce`.', 400);
  }

  // Redis: read nonce + client. Both throws on transport failure are
  // surfaced as 503 — distinct from the 400 "no such key" miss.
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

  // Defense-in-depth: re-validate the redirect_uri the nonce committed to
  // is still on the allowlist (DCR allowlist could be tightened post-
  // registration — fail closed).
  const uris = Array.isArray(clientData.redirect_uris) ? clientData.redirect_uris : [];
  if (!uris.includes(nonceData.redirect_uri) || !deps.isAllowedRedirectUri(nonceData.redirect_uri)) {
    return jsonError('INVALID_REDIRECT_URI', 'The redirect URI is no longer permitted.', 400);
  }

  const ent = await deps.getEntitlements(userId);
  const now = deps.now();
  // Mirror downstream MCP-edge gate: both tier ≥ 1 AND mcpAccess === true
  // are required. Reviewer round-2 P2 — gating on tier alone here lets a
  // tier-1 user without mcpAccess get a token row, then 401 every call.
  if (
    !ent ||
    ent.features.tier < 1 ||
    ent.features.mcpAccess !== true ||
    ent.validUntil < now
  ) {
    return jsonError('INSUFFICIENT_TIER', 'A WorldMonitor Pro subscription is required.', 403);
  }

  // Mint the signed grant first (cheaper to fail before the Redis write).
  const exp = now + GRANT_TTL_MS;
  let grantToken: string;
  try {
    grantToken = await deps.signGrant({ userId, nonce, exp });
  } catch (err) {
    if (err instanceof GrantConfigError) {
      console.warn('[mcp-grant-mint] missing MCP_PRO_GRANT_HMAC_SECRET');
      return jsonError('CONFIGURATION_ERROR', 'Pro MCP authorization is misconfigured.', 500);
    }
    throw err;
  }

  // F2: claim the nonce atomically via SET NX. The FIRST mint that
  // reaches Redis writes `{userId, exp}` and wins. Subsequent mints
  // either:
  //   - same userId (multi-tab / retry on the same Clerk session) →
  //     idempotently re-issue the redirect with a fresh grant token
  //     pointing at the existing claim. The old grant exp is preserved
  //     so the existing record stays valid; we re-sign with a NEW exp
  //     (also +5min from now) — but the redis record already holds the
  //     claim's exp, so `/oauth/authorize-pro` strictly compares them
  //     (line 293) and would 401 a "different exp" mint. To keep the
  //     idempotent path working, we re-sign with the EXISTING claim's
  //     exp from Redis, not a fresh one.
  //   - different userId (attacker tries to mint for victim's nonce) →
  //     403 NONCE_CLAIMED_BY_OTHER_USER.
  //
  // The SET NX path makes this race-safe: two concurrent mints from
  // different users for the same nonce can't both win. The loser's GET
  // sees the winner's record and either succeeds (same userId) or 403s.
  const grantKey = `mcp-grant:${nonce}`;
  const claim = { userId, exp };
  const claimed = await deps.redisSetNxEx(grantKey, claim, GRANT_TTL_SECONDS);
  if (!claimed) {
    // Either NX collision or transport failure. Disambiguate via GET.
    let existing: { userId?: unknown; exp?: unknown } | null;
    try {
      existing = (await deps.redisGet(grantKey)) as { userId?: unknown; exp?: unknown } | null;
    } catch {
      return jsonError('SERVICE_UNAVAILABLE', 'Could not persist the authorization grant.', 503);
    }
    if (!existing || typeof existing.userId !== 'string' || typeof existing.exp !== 'number') {
      // No prior record + SET NX failed → genuine transport failure.
      return jsonError('SERVICE_UNAVAILABLE', 'Could not persist the authorization grant.', 503);
    }
    if (existing.userId !== userId) {
      // F2 anti-hijack: the nonce has been claimed by a DIFFERENT Clerk
      // user. Refuse — the legitimate user must start a fresh OAuth
      // flow (which mints a fresh oauth:nonce + mcp-grant pair).
      return jsonError(
        'NONCE_CLAIMED_BY_OTHER_USER',
        'This authorization request has already been claimed by another account.',
        403,
      );
    }
    // Same userId — idempotent multi-tab retry. Re-sign the grant with
    // the EXISTING claim's exp so `/oauth/authorize-pro`'s strict tuple
    // equality on (userId, exp) succeeds against the Redis record.
    try {
      grantToken = await deps.signGrant({
        userId,
        nonce,
        exp: existing.exp as number,
      });
    } catch (err) {
      if (err instanceof GrantConfigError) {
        console.warn('[mcp-grant-mint] missing MCP_PRO_GRANT_HMAC_SECRET on idempotent re-sign');
        return jsonError('CONFIGURATION_ERROR', 'Pro MCP authorization is misconfigured.', 500);
      }
      throw err;
    }
  }

  const redirect = `${AUTHORIZE_PRO_URL}?nonce=${encodeURIComponent(nonce)}&grant=${encodeURIComponent(grantToken)}`;
  return new Response(JSON.stringify({ redirect }), { status: 200, headers: NO_STORE_JSON });
}

// ---------------------------------------------------------------------------
// Production handler — wires up the real deps.
// ---------------------------------------------------------------------------

export default async function handler(req: Request): Promise<Response> {
  return mintGrantHandler(req, {
    resolveUserId: async (r) => (await resolveClerkSession(r))?.userId ?? null,
    redisGet: rawRedisGet,
    redisSetEx: rawRedisSetEx,
    redisSetNxEx: rawRedisSetNxEx,
    getEntitlements: (userId) => getEntitlements(userId),
    isAllowedRedirectUri,
    signGrant: (payload) => signGrant(payload),
    now: () => Date.now(),
  });
}
