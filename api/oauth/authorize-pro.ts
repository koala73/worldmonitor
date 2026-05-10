/**
 * GET /oauth/authorize-pro
 *
 * U5 of plan 2026-05-10-001 — receives the bounce-back from the apex
 * `/mcp-grant` flow (U3) and finishes the OAuth authorization on the
 * api subdomain. This endpoint:
 *
 *   1. HMAC-verifies the signed grant FIRST (via `verifyGrant` from
 *      `api/_mcp-grant-hmac.ts`). On any failure (malformed / bad-sig /
 *      expired / invalid-payload) → vague HTML error. Never reveal which
 *      piece failed (avoids enumeration).
 *   2. Asserts the grant payload's `nonce` matches the URL `?nonce=` query
 *      parameter (defense vs grant-payload-swap forgery class).
 *   3. Atomically `GETDEL mcp-grant:<n>` → recovers `{userId, exp}` written
 *      by U3. Strict equality check against grant payload's `userId` AND
 *      `exp` (defense vs grant-without-redis-record forgery + token cloning
 *      across users).
 *   4. Atomically `GETDEL oauth:nonce:<n>` → recovers
 *      `{client_id, redirect_uri, code_challenge, state}` written by
 *      `api/oauth/authorize.js`. One-shot — replay fails on the second hit.
 *   5. Reads (does NOT consume) `oauth:client:<client_id>` for client_name
 *      + redirect_uri allowlist re-check (defense-in-depth; DCR validated
 *      this at register time but allowlist could be tightened since).
 *   6. Re-fetches `getEntitlements(userId)` from Convex — the grant could
 *      be up to 5 minutes old; tier may have lapsed since mint.
 *   7. Calls `issueProMcpTokenForUser` to insert a Convex `mcpProTokens`
 *      row. NO `wm_` key, NO `WORLDMONITOR_VALID_KEYS` write — Pro identity
 *      lives only in Convex, the OAuth code carries the row id.
 *   8. Writes `oauth:code:<code>` = `{kind:'pro', userId, mcpTokenId,
 *      client_id, redirect_uri, code_challenge, scope:'mcp_pro'}` with
 *      10-min TTL (matches the legacy authorize.js code TTL).
 *   9. On `oauth:code` SETEX failure: best-effort `revokeProMcpToken`
 *      rollback (does NOT throw per U2's contract) so we don't leave
 *      orphaned `mcpProTokens` rows.
 *  10. 302 → `redirect_uri?code=<code>` (+ optional `state`). Cache-Control:
 *      no-store on every response (memory `warmping-origin-trust-cdn-401-poisoning`:
 *      CF can poison-cache 4xx; we never want intermediate caches holding
 *      either the redirect or an error page).
 *
 * Security invariants:
 *   - HMAC verify happens BEFORE any Redis call. Forged grants never burn
 *     the one-shot Redis nonces.
 *   - Both `mcp-grant:<n>` and `oauth:nonce:<n>` are GETDEL'd (one-shot).
 *     Replay of either fails the second time.
 *   - `oauth:code` value uses `kind:'pro'` discriminator — U6's bearer
 *     resolver branches on this. The shape is load-bearing for U6.
 *
 * Discriminated `oauth:code:<code>` shape (LOAD-BEARING — see U6):
 *
 *   {
 *     kind: 'pro',
 *     userId: string,
 *     mcpTokenId: string,
 *     client_id: string,
 *     redirect_uri: string,
 *     code_challenge: string,
 *     scope: 'mcp_pro',
 *   }
 *
 * Errors return HTML (browser-facing flow). All errors set Cache-Control:
 * no-store. The error copy is intentionally vague to avoid leaking which
 * security check tripped.
 */

export const config = { runtime: 'edge' };

import { verifyGrant, GrantConfigError } from '../_mcp-grant-hmac';
import { getEntitlements } from '../../server/_shared/entitlement-check';
import {
  issueProMcpTokenForUser,
  revokeProMcpToken,
  ProMcpIssueFailed,
} from '../../server/_shared/pro-mcp-token';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';

/** OAuth authorization-code TTL — matches `api/oauth/authorize.js:10`. */
const CODE_TTL_SECONDS = 600;

const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

const GLOBE_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * HTML error response — mirrors the visual style of
 * `api/oauth/authorize.js::htmlError` (line 89). Kept identical so the
 * user experience is consistent between the legacy API-key path and the
 * Pro Clerk path. Status defaults to 400; pass 500/503 for server-side
 * issues so monitoring distinguishes them, but copy is vague to the user.
 */
function htmlError(title: string, detail: string, status: number = 400): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Error &#x2014; WorldMonitor MCP</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:ui-monospace,'SF Mono','Cascadia Code',monospace;background:#0a0a0a;color:#e8e8e8;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1.5rem}.wm-logo{display:flex;align-items:center;gap:.5rem;margin-bottom:2rem;text-decoration:none}.wm-logo svg{color:#2d8a6e}.wm-logo-text{font-size:.75rem;color:#555;letter-spacing:.1em;text-transform:uppercase}.card{width:100%;max-width:420px;background:#111;border:1px solid #1e1e1e;padding:2rem}h1{font-size:.95rem;font-weight:600;color:#ef4444;margin-bottom:.75rem;letter-spacing:.02em}p{font-size:.85rem;color:#666;line-height:1.6}.back{display:inline-block;margin-top:1.5rem;font-size:.75rem;color:#444;text-decoration:none;letter-spacing:.03em}.back:hover{color:#888}.footer{margin-top:1.5rem;font-size:.7rem;color:#2a2a2a;text-align:center}.footer a{color:#333;text-decoration:none}.footer a:hover{color:#555}</style></head>
<body><a href="https://www.worldmonitor.app" class="wm-logo" target="_blank" rel="noopener">${GLOBE_SVG}<span class="wm-logo-text">WorldMonitor MCP</span></a>
<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><a href="javascript:history.back()" class="back">&#8592; go back</a></div>
<p class="footer"><a href="https://www.worldmonitor.app" target="_blank" rel="noopener">worldmonitor.app</a></p>
</body></html>`,
    { status, headers: PAGE_HEADERS },
  );
}

// ---------------------------------------------------------------------------
// Redis helpers — match the on-the-wire format used by api/oauth/authorize.js
// (raw `oauth:*` and `mcp-grant:*` keys, no env prefix).
// ---------------------------------------------------------------------------

async function rawRedisGetDel(key: string): Promise<unknown | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
  const resp = await fetch(`${url}/getdel/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = (await resp.json()) as { result?: string | null };
  if (!data?.result) return null;
  try {
    return JSON.parse(data.result);
  } catch {
    return null;
  }
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
  const data = (await resp.json()) as { result?: string | null };
  if (!data?.result) return null;
  try {
    return JSON.parse(data.result);
  } catch {
    return null;
  }
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
    const results = (await resp.json().catch(() => null)) as Array<{ result?: string }> | null;
    return Array.isArray(results) && results[0]?.result === 'OK';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Inner handler — exported for unit tests with injected deps.
// ---------------------------------------------------------------------------

export interface NonceData {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  created_at?: number;
}

export interface ClientData {
  client_name?: string;
  redirect_uris?: unknown;
}

export interface GrantRedisData {
  userId: string;
  exp: number;
}

export interface AuthorizeProDeps {
  /** Atomic GETDEL on a raw `mcp-grant:*` or `oauth:nonce:*` key. */
  redisGetDel: (key: string) => Promise<unknown | null>;
  /** Non-consuming read of the `oauth:client:<id>` row. */
  redisGet: (key: string) => Promise<unknown | null>;
  /** SETEX of `oauth:code:<code>`. Returns false on failure (caller rolls back). */
  redisSetEx: (key: string, value: unknown, ttlSeconds: number) => Promise<boolean>;
  /** Verifies the wire-format HMAC grant. */
  verifyGrant: typeof verifyGrant;
  /** Returns Pro entitlement info or null. */
  getEntitlements: (userId: string) => Promise<{ features: { tier: number; mcpAccess?: boolean }; validUntil: number } | null>;
  /** Issues the Convex mcpProTokens row. Throws ProMcpIssueFailed on failure. */
  issueProMcpTokenForUser: typeof issueProMcpTokenForUser;
  /** Best-effort revoke for the rollback path. Must NOT throw (matches U2 contract). */
  revokeProMcpToken: typeof revokeProMcpToken;
  /** Random code generator — injectable for deterministic tests. */
  randomCode: () => string;
  /** Wall clock — injectable for deterministic tests. */
  now: () => number;
}

export async function authorizeProHandler(req: Request, deps: AuthorizeProDeps): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response(null, {
      status: 405,
      headers: { Allow: 'GET', 'Cache-Control': 'no-store' },
    });
  }

  const url = new URL(req.url);
  const nonce = url.searchParams.get('nonce') ?? '';
  const grantToken = url.searchParams.get('grant') ?? '';

  if (!nonce || !grantToken) {
    // Edge: missing params → HTML error WITHOUT touching Redis.
    return htmlError(
      'Invalid Authorization Request',
      'The authorization link is missing required parameters. Please start over from your dashboard.',
    );
  }

  // ----- 1. HMAC-verify FIRST (cheap; saves Redis round-trips on forged tokens) -----
  let verifyResult: Awaited<ReturnType<typeof verifyGrant>>;
  try {
    verifyResult = await deps.verifyGrant(grantToken, undefined, deps.now());
  } catch (err) {
    if (err instanceof GrantConfigError) {
      console.warn('[authorize-pro] missing MCP_PRO_GRANT_HMAC_SECRET');
      return htmlError(
        'Service Unavailable',
        'Pro MCP authorization is temporarily unavailable. Please try again shortly.',
        500,
      );
    }
    throw err;
  }
  if (!verifyResult.ok) {
    // Vague copy — do NOT distinguish malformed / bad-sig / expired / invalid-payload.
    return htmlError(
      'Authorization Expired',
      'This authorization link is no longer valid. Please start over from your dashboard.',
    );
  }
  const grantPayload = verifyResult.payload;

  // ----- 2. Grant payload's nonce MUST match the URL nonce -----
  // Defense vs grant-payload-swap: an attacker who captures a grant for one
  // nonce can't paste it onto a different nonce's URL.
  if (grantPayload.nonce !== nonce) {
    return htmlError(
      'Authorization Mismatch',
      'This authorization link is no longer valid. Please start over from your dashboard.',
    );
  }

  // ----- 3. Atomic GETDEL mcp-grant:<n> -----
  let grantRedis: GrantRedisData | null;
  try {
    grantRedis = (await deps.redisGetDel(`mcp-grant:${nonce}`)) as GrantRedisData | null;
  } catch {
    return htmlError(
      'Service Unavailable',
      'Authorization service is temporarily unavailable. Please try again shortly.',
      503,
    );
  }
  if (!grantRedis || typeof grantRedis.userId !== 'string' || typeof grantRedis.exp !== 'number') {
    // Replay (already consumed) or never minted → vague.
    return htmlError(
      'Authorization Expired',
      'This authorization link is no longer valid. Please start over from your dashboard.',
    );
  }
  // Strict tuple equality with the signed payload. Even a valid HMAC can't
  // forge a record that doesn't exist in Redis under the matching userId+exp.
  if (grantRedis.userId !== grantPayload.userId || grantRedis.exp !== grantPayload.exp) {
    return htmlError(
      'Authorization Mismatch',
      'This authorization link is no longer valid. Please start over from your dashboard.',
    );
  }
  const userId = grantPayload.userId;

  // ----- 4. Atomic GETDEL oauth:nonce:<n> -----
  let nonceData: NonceData | null;
  try {
    nonceData = (await deps.redisGetDel(`oauth:nonce:${nonce}`)) as NonceData | null;
  } catch {
    return htmlError(
      'Service Unavailable',
      'Authorization service is temporarily unavailable. Please try again shortly.',
      503,
    );
  }
  if (
    !nonceData ||
    typeof nonceData.client_id !== 'string' ||
    typeof nonceData.redirect_uri !== 'string' ||
    typeof nonceData.code_challenge !== 'string'
  ) {
    return htmlError(
      'Session Expired',
      'Your authorization session has expired. Please start over from your dashboard.',
    );
  }
  const { client_id, redirect_uri, code_challenge } = nonceData;
  const state = typeof nonceData.state === 'string' ? nonceData.state : '';

  // ----- 5. Read oauth:client:<client_id> (no consume) -----
  let clientData: ClientData | null;
  try {
    clientData = (await deps.redisGet(`oauth:client:${client_id}`)) as ClientData | null;
  } catch {
    return htmlError(
      'Service Unavailable',
      'Authorization service is temporarily unavailable. Please try again shortly.',
      503,
    );
  }
  if (!clientData) {
    return htmlError(
      'Unknown Client',
      'The OAuth client registration has expired. Please re-register the client.',
    );
  }

  // ----- 6. Defense-in-depth: redirect_uri allowlist re-check -----
  const uris = Array.isArray(clientData.redirect_uris) ? clientData.redirect_uris : [];
  if (!uris.includes(redirect_uri)) {
    return htmlError(
      'Redirect URI Mismatch',
      'The redirect_uri does not match any registered redirect URI for this client.',
    );
  }

  // ----- 7. Re-fetch entitlement (grant could be up to 5min old; tier may have lapsed) -----
  // Mirror downstream MCP-edge gate: both tier ≥ 1 AND mcpAccess === true
  // are required. Reviewer round-2 P2 — without the mcpAccess check here,
  // a tier-1 user lacking mcpAccess could complete OAuth + get a token
  // row, then have every tools/call fail at the gateway.
  const ent = await deps.getEntitlements(userId);
  const now = deps.now();
  if (
    !ent ||
    ent.features.tier < 1 ||
    ent.features.mcpAccess !== true ||
    ent.validUntil < now
  ) {
    return htmlError(
      'Pro Subscription Required',
      'A WorldMonitor Pro subscription is required for this connection. Please subscribe and try again.',
      403,
    );
  }

  // ----- 8. Issue the Convex mcpProTokens row -----
  const clientName = (typeof clientData.client_name === 'string' && clientData.client_name) || 'Unknown Client';
  let issueResult: { tokenId: string };
  try {
    issueResult = await deps.issueProMcpTokenForUser(userId, client_id, `Connected via ${clientName}`);
  } catch (err) {
    if (err instanceof ProMcpIssueFailed) {
      if (err.kind === 'pro-required') {
        return htmlError(
          'Pro Subscription Required',
          'A WorldMonitor Pro subscription is required for this connection. Please subscribe and try again.',
          403,
        );
      }
      if (err.kind === 'invalid-user-id') {
        return htmlError(
          'Authorization Failed',
          'Could not complete authorization. Please sign out, sign in again, and try again.',
          400,
        );
      }
      if (err.kind === 'config') {
        console.warn('[authorize-pro] Convex config missing for issue helper');
        return htmlError(
          'Service Unavailable',
          'Pro MCP authorization is temporarily unavailable. Please try again shortly.',
          500,
        );
      }
      // network / unknown
      return htmlError(
        'Service Unavailable',
        'Pro MCP authorization is temporarily unavailable. Please try again shortly.',
        503,
      );
    }
    throw err;
  }

  // ----- 9. Mint OAuth code + write oauth:code:<code> -----
  const code = deps.randomCode();
  const codeData = {
    kind: 'pro' as const,
    userId,
    mcpTokenId: issueResult.tokenId,
    client_id,
    redirect_uri,
    code_challenge,
    scope: 'mcp_pro' as const,
  };

  let codeStored = false;
  try {
    codeStored = await deps.redisSetEx(`oauth:code:${code}`, codeData, CODE_TTL_SECONDS);
  } catch {
    codeStored = false;
  }

  if (!codeStored) {
    // ----- 10. Best-effort rollback of the just-issued mcpProTokens row -----
    // U2's revokeProMcpToken does NOT throw — returns {ok, reason}. We log
    // outcome but do NOT mask the original storage failure: even if revoke
    // fails, the user sees "Server Error" + the orphaned row will get cleaned
    // up by the per-user 5-row cap rotation in U1 over time.
    try {
      const rollback = await deps.revokeProMcpToken(userId, issueResult.tokenId);
      if (!rollback.ok) {
        console.warn(
          `[authorize-pro] orphaned mcpProTokens row ${issueResult.tokenId} for user ${userId}: revoke failed (${rollback.reason})`,
        );
      }
    } catch (err) {
      // Defensive: U2's contract says no-throw, but if a future change breaks
      // that we still complete the error response.
      console.warn(
        `[authorize-pro] revoke rollback unexpectedly threw for token ${issueResult.tokenId}:`,
        err instanceof Error ? err.message : String(err),
      );
      captureSilentError(err, {
        tags: { route: 'api/oauth/authorize-pro', step: 'rollback-revoke' },
      });
    }
    return htmlError(
      'Server Error',
      'Failed to store authorization code. Please try again.',
      500,
    );
  }

  // ----- 11. 302 redirect -----
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectUrl.toString(),
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}

// ---------------------------------------------------------------------------
// Production handler — wires up the real deps.
// ---------------------------------------------------------------------------

export default async function handler(req: Request): Promise<Response> {
  return authorizeProHandler(req, {
    redisGetDel: rawRedisGetDel,
    redisGet: rawRedisGet,
    redisSetEx: rawRedisSetEx,
    verifyGrant,
    getEntitlements,
    issueProMcpTokenForUser,
    revokeProMcpToken,
    randomCode: () => crypto.randomUUID(),
    now: () => Date.now(),
  });
}
