/**
 * Internal MCP HMAC service-auth — sign helper (U7) + canonicalisation
 * primitives shared with verify (U8).
 *
 * U7 of plan 2026-05-10-001 (`feat-pro-mcp-clerk-auth-quota-plan`).
 *
 * Why this module exists
 * ----------------------
 * When `api/mcp.ts` dispatches a tool _execute fetch on behalf of a Pro
 * user, the downstream gateway has no `wm_*` API key to validate against
 * (the OAuth bearer carries a `mcpProTokens` row id, not a key). Instead,
 * the MCP edge signs an HMAC of the *outbound* request shape and the
 * gateway re-canonicalises + verifies on the way in. The verified userId
 * is what the gateway then trusts for entitlement / premium semantics.
 *
 * The signed payload binds the request shape so a captured signature for
 * `/api/news/v1/list-feed-digest?lang=en` cannot be replayed against
 * `/api/intelligence/v1/deduct-situation` (Codex round-2 review finding).
 *
 *   payload   = `${ts}:${method}:${pathname}:${queryHash}:${bodyHash}:${userId}`
 *   queryHash = SHA-256(canonicalQueryString(URL))
 *   bodyHash  = SHA-256(bodyBytes)        // SHA-256("") for GET / no body
 *   sig       = HMAC-SHA-256(secret, payload)
 *   header    = `${ts}.${base64url(sig)}`
 *
 * SINGLE SOURCE OF TRUTH — both U7's signer and U8's verifier MUST import
 * `canonicalQueryString` and `sha256Hex` from THIS module. Drift between
 * sign and verify produces silent 401s for legitimate Pro tool fetches
 * and is the failure mode the Codex review flagged.
 */

// ---------------------------------------------------------------------------
// Header / payload constants
// ---------------------------------------------------------------------------

/** Header carrying `<ts>.<base64url-sig>`. */
export const INTERNAL_MCP_SIG_HEADER = 'X-WM-MCP-Internal';

/** Header carrying the userId the signature claims to represent. */
export const INTERNAL_MCP_USER_ID_HEADER = 'X-WM-MCP-User-Id';

/** Trusted markers set by the gateway AFTER successful verify. Downstream
 *  handlers (`isCallerPremium`) read these — never the inbound headers. */
export const INTERNAL_MCP_VERIFIED_HEADER = 'x-wm-mcp-internal-verified';
export const TRUSTED_USER_ID_HEADER = 'x-user-id';

/** Timestamp window (seconds) for replay defense. Default per plan: 30s.
 *  Loosen via env if production observes clock skew. */
export const INTERNAL_MCP_TIMESTAMP_WINDOW_SECONDS = 30;

// ---------------------------------------------------------------------------
// Canonicalisation primitives — exported so U8's verifier produces byte-
// identical bytes for HMAC compare. Do NOT inline these elsewhere.
// ---------------------------------------------------------------------------

/**
 * Hex-encoded SHA-256 of a UTF-8 string. Edge-runtime safe (uses WebCrypto).
 * Mirror of `api/_crypto.js::sha256Hex` so server/_shared callers don't
 * need to reach into api/.
 */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Canonical query-string form for HMAC payload binding.
 *
 * Algorithm (deterministic, AWS SigV4-inspired):
 *   1. Parse the query string (with or without leading "?") via URLSearchParams.
 *   2. Sort entries lexicographically by key (stable: equal keys keep insertion order).
 *   3. URL-encode each key and value with encodeURIComponent.
 *   4. Join as `${key}=${value}` pairs separated by `&`.
 *
 * Empty / missing query → empty string (NOT "?", NOT undefined).
 *
 * Both `?a=1&b=2` and `?b=2&a=1` produce the SAME canonical string —
 * documented and tested behavior. Reordering query params at any hop
 * (CDN, proxy, browser) does not invalidate the signature.
 */
export function canonicalQueryString(searchOrUrl: string | URL): string {
  let search: string;
  if (searchOrUrl instanceof URL) {
    search = searchOrUrl.search;
  } else if (typeof searchOrUrl === 'string') {
    // Accept either "?a=1&b=2" or "a=1&b=2" or a full URL.
    if (searchOrUrl.startsWith('http://') || searchOrUrl.startsWith('https://')) {
      try {
        search = new URL(searchOrUrl).search;
      } catch {
        return '';
      }
    } else {
      search = searchOrUrl;
    }
  } else {
    return '';
  }
  if (!search || search === '?') return '';
  const trimmed = search.startsWith('?') ? search.slice(1) : search;
  if (!trimmed) return '';
  const params = new URLSearchParams(trimmed);
  const entries: [string, string][] = [];
  for (const [k, v] of params) entries.push([k, v]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * Build the HMAC payload string from request components. Both signer and
 * verifier MUST produce byte-identical strings here.
 *
 * Pathname is taken VERBATIM (no re-encoding) because URL.pathname is
 * already canonical for the Vercel edge runtime — re-encoding would
 * double-escape literals like `:` and `/` and break the compare.
 */
export function buildHmacPayload(args: {
  ts: number;
  method: string;
  pathname: string;
  queryHash: string;
  bodyHash: string;
  userId: string;
}): string {
  return `${args.ts}:${args.method.toUpperCase()}:${args.pathname}:${args.queryHash}:${args.bodyHash}:${args.userId}`;
}

// ---------------------------------------------------------------------------
// HMAC-SHA-256 + base64url helpers (edge-safe via WebCrypto)
// ---------------------------------------------------------------------------

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function bufferToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sign a payload string → base64url(HMAC-SHA-256(secret, payload)). */
export async function hmacSha256Base64Url(secret: string, payload: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return bufferToBase64Url(sig);
}

// ---------------------------------------------------------------------------
// Public sign API — used by U7 (api/mcp.ts) and importable by U8's tests
// to construct fixture headers without re-implementing the algorithm.
// ---------------------------------------------------------------------------

export interface SignedInternalMcpHeaders {
  /** Header value: `<ts>.<base64url-sig>`. Sent as `X-WM-MCP-Internal`. */
  signature: string;
  /** UserId the signature claims; sent as `X-WM-MCP-User-Id`. */
  userId: string;
  /** Unix-seconds timestamp embedded in the signature payload. */
  ts: number;
}

/**
 * Sign an outbound internal-MCP request. Returns header values to set on
 * the `fetch()` call — the caller is responsible for actually attaching them.
 *
 * @param method  HTTP method (case-insensitive; payload uppercases).
 * @param url     Full URL including query string. Pathname + canonicalised query
 *                are extracted for the signed payload.
 * @param body    Raw outbound body. Pass `null`/`undefined` for GET / no body.
 *                Strings, ArrayBuffers, and Uint8Arrays are accepted; everything
 *                else is `JSON.stringify`'d (mirrors fetch's own body handling
 *                for the common case of objects passed via `body: JSON.stringify(x)`
 *                — the caller must pass the SAME bytes they actually send).
 * @param userId  The Pro userId being attributed to this request.
 * @param secret  `MCP_INTERNAL_HMAC_SECRET`. The function does NOT read env
 *                directly — caller passes it explicitly so tests can inject.
 * @param now     Override Unix-seconds (test injection); defaults to `Date.now()/1000`.
 */
export async function signInternalMcpRequest(args: {
  method: string;
  url: string | URL;
  body?: BodyInit | null | undefined;
  userId: string;
  secret: string;
  now?: number;
}): Promise<SignedInternalMcpHeaders> {
  if (!args.userId) throw new Error('signInternalMcpRequest: userId is required');
  if (!args.secret) throw new Error('signInternalMcpRequest: secret is required');

  const url = args.url instanceof URL ? args.url : new URL(args.url);
  const ts = Math.floor(args.now ?? Date.now() / 1000);
  const queryHash = await sha256Hex(canonicalQueryString(url));
  const bodyHash = await sha256Hex(await coerceBodyToString(args.body));
  const payload = buildHmacPayload({
    ts,
    method: args.method,
    pathname: url.pathname,
    queryHash,
    bodyHash,
    userId: args.userId,
  });
  const sig = await hmacSha256Base64Url(args.secret, payload);
  return { signature: `${ts}.${sig}`, userId: args.userId, ts };
}

/**
 * Body coercion mirrors the caller's actual `fetch()` body handling. The
 * signer's view of the body MUST match the bytes that hit the wire — if
 * the caller `JSON.stringify`'s an object before calling `fetch`, they
 * MUST pass the same string here.
 *
 * For convenience we handle the common shapes:
 *   - null / undefined → empty string (matches GET / no-body convention)
 *   - string → as-is
 *   - Uint8Array / ArrayBuffer → utf-8 decoded
 *   - object → JSON.stringify (LAST RESORT — prefer caller-side stringify
 *     so the signer and the wire bytes are guaranteed identical)
 */
async function coerceBodyToString(body: BodyInit | null | undefined): Promise<string> {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  // Blob / FormData / URLSearchParams / ReadableStream — punt: the caller
  // should pre-serialize. We don't currently have any internal-MCP fetch
  // path that uses those shapes.
  if (body instanceof URLSearchParams) return body.toString();
  // Catch-all: assume the caller's `fetch` will JSON-stringify a plain
  // object the same way we do. Browsers / Node WILL do this, but the
  // pretty-print / key-order assumptions can drift — caller-side stringify
  // is preferred.
  try {
    return JSON.stringify(body);
  } catch {
    return '';
  }
}

/**
 * Build the headers dict to attach to a Pro-context internal-MCP fetch.
 * Caller composes with their other headers (Content-Type, User-Agent, ...).
 */
export function buildInternalMcpHeaders(signed: SignedInternalMcpHeaders): Record<string, string> {
  return {
    [INTERNAL_MCP_SIG_HEADER]: signed.signature,
    [INTERNAL_MCP_USER_ID_HEADER]: signed.userId,
  };
}
