// @ts-expect-error — JS module, no declaration file
import { keyFingerprint, sha256Hex } from './_crypto.js';
// @ts-expect-error — JS module, no declaration file
import { getRedisCredentials } from './_upstash-json.js';

/**
 * Bearer-to-context resolver for the OAuth + MCP edge.
 *
 * U6 of plan 2026-05-10-001 (`feat-pro-mcp-clerk-auth-quota-plan`) introduced
 * the discriminated `McpAuthContext` union — the same `oauth:token:<uuid>`
 * Redis namespace now stores TWO disjoint shapes:
 *
 *   Legacy (env-key issued, written by `storeNewTokens` / `storeLegacyToken`
 *   in `api/oauth/token.js`): a bare JSON-string holding either a 64-hex
 *   SHA-256 of a `wm_*` key (authorization_code / refresh) or a 16-char
 *   key-fingerprint (client_credentials).
 *     stored = "abc123..."           // typeof === 'string'
 *
 *   Pro (Clerk-grant issued, written by `storeProTokens` in
 *   `api/oauth/token.js` after U5's `/oauth/authorize-pro` flow): a JSON
 *   object carrying the Convex `mcpProTokens` row id and the user id.
 *     stored = { kind: 'pro', userId: 'user_abc', mcpTokenId: 'k57...' }
 *
 * Both shapes coexist forever — there is no migration. Resolver dispatches
 * on `typeof raw` then on `raw.kind`.
 *
 * Public surface:
 *   - `resolveBearerToContext(token)` — preferred. Returns the discriminated
 *     `McpAuthContext` union, or null on miss / malformed / unknown shape.
 *   - `resolveApiKeyFromBearer(token)` — legacy thin wrapper retained for
 *     callers that only know how to handle the env-key path. Returns the
 *     cleartext `wm_*` key for `kind:'env_key'`, null for `kind:'pro'`
 *     (callers expecting a key string have no contract for the Pro shape).
 *     U7's MCP edge will switch to `resolveBearerToContext` directly.
 */

async function fetchOAuthToken(uuid) {
  const creds = getRedisCredentials();
  if (!creds) return null;

  const resp = await fetch(`${creds.url}/get/${encodeURIComponent(`oauth:token:${uuid}`)}`, {
    headers: { Authorization: `Bearer ${creds.token}` },
    signal: AbortSignal.timeout(3_000),
  });
  // Throw on HTTP error so callers can distinguish Redis failure (→ 503) from missing token (→ 401).
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);

  const data = await resp.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

// Legacy: 16-char fingerprint for client_credentials tokens (backward compat)
export async function resolveApiKeyFromFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !fingerprint) return null;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  for (const k of validKeys) {
    if (await keyFingerprint(k) === fingerprint) return k;
  }
  return null;
}

// New: full SHA-256 (64 hex chars) for authorization_code / refresh_token issued tokens
export async function resolveApiKeyFromHash(fullHash) {
  if (typeof fullHash !== 'string' || fullHash.length !== 64) return null;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  for (const k of validKeys) {
    if (await sha256Hex(k) === fullHash) return k;
  }
  return null;
}

/**
 * Resolve a bearer token to the `McpAuthContext` discriminated union.
 *
 *   { kind: 'env_key', apiKey: string }
 *   | { kind: 'pro',   userId: string, mcpTokenId: string }
 *   | null
 *
 * Branch logic:
 *   - typeof raw === 'string' → legacy bare-string. Length-dispatches to
 *     `resolveApiKeyFromHash` (64) or `resolveApiKeyFromFingerprint` (16).
 *   - raw.kind === 'pro' (with valid string `userId` + `mcpTokenId`) →
 *     `kind:'pro'` context. NOTE: this resolver does NOT call Convex
 *     `validateProMcpToken` — that revocation check belongs at the
 *     dispatcher (U7 / MCP edge / per-tool gate). Resolver only proves
 *     the bearer DECODES to a Pro identity; downstream proves the row
 *     is still active.
 *   - Anything else (bare-string with bad length, object with unknown
 *     `kind`, missing fields, unknown shape) → null. Defensive: future
 *     additions to the union must explicitly opt-in here, not implicitly
 *     leak through as a falsy / undefined branch.
 *
 * Throws on Redis HTTP failure (mirrors `fetchOAuthToken`) — callers map
 * that to 503. Returns null on Redis miss + JSON-parse failure (existing
 * behavior preserved; both indistinguishable from "bad bearer" upstream).
 */
export async function resolveBearerToContext(token) {
  if (!token || typeof token !== 'string') return null;
  const raw = await fetchOAuthToken(token);
  if (raw == null) return null;

  // Legacy bare-string: env-key path.
  if (typeof raw === 'string') {
    if (!raw) return null;
    let apiKey = null;
    if (raw.length === 64) apiKey = await resolveApiKeyFromHash(raw);
    else if (raw.length === 16) apiKey = await resolveApiKeyFromFingerprint(raw);
    return apiKey ? { kind: 'env_key', apiKey } : null;
  }

  // New Pro object shape — defensive shape-check before trusting.
  if (raw && typeof raw === 'object' && raw.kind === 'pro') {
    const userId = typeof raw.userId === 'string' ? raw.userId : '';
    const mcpTokenId = typeof raw.mcpTokenId === 'string' ? raw.mcpTokenId : '';
    if (!userId || !mcpTokenId) return null;
    return { kind: 'pro', userId, mcpTokenId };
  }

  // Unknown / future / malformed shape → null (no implicit pass-through).
  return null;
}

/**
 * Backward-compat wrapper. Returns the cleartext `wm_*` API key for the
 * legacy env-key path; null for the Pro path (legacy callers have no
 * contract for `{userId, mcpTokenId}` and would mis-handle a Pro bearer).
 *
 * U7's MCP edge will call `resolveBearerToContext` directly. Until then,
 * the only caller (`api/mcp.ts`) keeps the env-key-only contract — Pro
 * bearers correctly resolve to "no API key" and 401 at that layer, which
 * is a safe interim posture (Pro flow can't reach the MCP server until
 * U7 ships the union-aware path).
 */
export async function resolveApiKeyFromBearer(token) {
  const ctx = await resolveBearerToContext(token);
  if (!ctx) return null;
  if (ctx.kind === 'env_key') return ctx.apiKey;
  return null;
}
