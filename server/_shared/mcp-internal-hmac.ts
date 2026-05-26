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
 *  handlers (`isCallerPremium`) read these — never the inbound headers.
 *
 *  The verified-marker value is a per-process-startup random nonce
 *  (`getInternalMcpVerifiedNonce()`), NOT the constant `'1'`. This is
 *  defense-in-depth against the case where the trusted markers leak past
 *  a non-gateway entry point (e.g. a direct edge function `api/foo.ts`
 *  that doesn't route through `createDomainGateway` and therefore doesn't
 *  run the strip step). An attacker who sends a guessable marker value
 *  from outside cannot satisfy `isCallerPremium`'s check because they do
 *  not know the per-process nonce. The gateway's strip step still runs
 *  for gateway-routed traffic so even the nonce never round-trips. */
export const INTERNAL_MCP_VERIFIED_HEADER = 'x-wm-mcp-internal-verified';
export const TRUSTED_USER_ID_HEADER = 'x-user-id';

let _verifiedNonce: string | null = null;
/**
 * Returns a stable per-process-startup nonce used as the value of
 * `x-wm-mcp-internal-verified` on requests rebuilt by the gateway after
 * HMAC verification. `isCallerPremium` compares with timing-safe equality.
 *
 * Generated lazily on first call (cheap; one 16-byte WebCrypto draw),
 * cached for the lifetime of the edge function instance. Not exported
 * outside server/_shared — outside callers should treat it as opaque. */
export function getInternalMcpVerifiedNonce(): string {
  if (_verifiedNonce !== null) return _verifiedNonce;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Hex encode — short enough for an HTTP header, no base64 padding to deal with.
  _verifiedNonce = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return _verifiedNonce;
}

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
  for (const byte of bytes) binary += String.fromCharCode(byte);
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
  if (body instanceof URLSearchParams) return body.toString();
  // F10 (U7+U8 review pass): Blob / FormData / ReadableStream — refuse
  // explicitly. The previous JSON.stringify catch-all silently produced
  // wrong hashes (e.g. `JSON.stringify(formData) === '{}'`) that would
  // 401 at the verifier with no obvious signal at the signer. Caller
  // must pre-stringify these shapes.
  //
  // We use `globalThis.<X>` lookups because edge runtimes don't always
  // expose the constructor on the global scope at module-eval time;
  // optional chaining keeps this safe in Node test environments too.
  const G = globalThis as { Blob?: { new (): unknown }; FormData?: { new (): unknown }; ReadableStream?: { new (): unknown } };
  if (G.Blob && body instanceof G.Blob) {
    throw new Error('signInternalMcpRequest: unsupported body shape (Blob); pre-stringify before signing');
  }
  if (G.FormData && body instanceof G.FormData) {
    throw new Error('signInternalMcpRequest: unsupported body shape (FormData); pre-stringify before signing');
  }
  if (G.ReadableStream && body instanceof G.ReadableStream) {
    throw new Error('signInternalMcpRequest: unsupported body shape (ReadableStream); pre-stringify before signing');
  }
  // Final catch-all for plain objects passed by mistake — same loud failure.
  // The bad-old behavior was `JSON.stringify` here; that produced silent
  // sign/wire drift if the caller's `fetch` serialised differently.
  throw new Error('signInternalMcpRequest: unsupported body shape; pre-stringify before signing');
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

// ---------------------------------------------------------------------------
// Verify side (U8) — gateway pre-check for inbound internal-MCP requests.
//
// Mirrors the sign side byte-for-byte. ANY drift (canonicalisation, body
// coercion, payload shape, ts encoding) produces silent 401s for legitimate
// Pro tool fetches. The U7 sign helpers and the U8 verify helper MUST share
// this module — do NOT re-implement.
// ---------------------------------------------------------------------------

export interface VerifiedInternalMcpRequest {
  /** UserId carried by the verified `X-WM-MCP-User-Id` header. */
  userId: string;
}

/**
 * Constant-time equal-length string comparison. Both inputs are first hashed
 * to fixed-size SHA-256 digests so unequal lengths cannot leak via early-exit
 * timing. Mirrors `api/_crypto.js::timingSafeIncludes` for a single candidate.
 */
async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const aHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a)));
  const bHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < aHash.length; i++) diff |= aHash[i]! ^ bHash[i]!;
  return diff === 0;
}

/**
 * Parse the `X-WM-MCP-Internal` header value into `{ts, sigB64u}`.
 * Returns null on any structural malformation. Single dot only — `<ts>.<sig>`.
 */
function parseSignatureHeader(value: string | null): { ts: number; sigB64u: string } | null {
  if (!value) return null;
  const dotIdx = value.indexOf('.');
  // Reject missing dot, leading dot, trailing dot, multiple dots.
  if (dotIdx <= 0 || dotIdx === value.length - 1) return null;
  if (value.indexOf('.', dotIdx + 1) !== -1) return null;
  const tsStr = value.slice(0, dotIdx);
  const sigB64u = value.slice(dotIdx + 1);
  // F11 (U7+U8 review pass): bound the numeric width. `^[0-9]+$` would
  // accept arbitrarily long inputs; future ms-precision timestamps could
  // silently truncate through `Number()` to lose precision. 1-15 digits
  // covers Unix seconds (10 digits today) and ms epoch (13 digits) with
  // margin for the year-9999 boundary; rejects pathological lengths.
  if (!/^[0-9]{1,15}$/.test(tsStr)) return null;
  // base64url charset only — `+` `/` `=` not allowed.
  if (!/^[A-Za-z0-9_-]+$/.test(sigB64u)) return null;
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || ts < 0) return null;
  return { ts, sigB64u };
}

/**
 * Verify an inbound internal-MCP request signed by U7's sign helpers.
 *
 * Reads `X-WM-MCP-Internal` (`<ts>.<base64url-sig>`) and `X-WM-MCP-User-Id`
 * from the request. Re-canonicalises the inbound request the SAME way the
 * signer did — exporting/importing canonicalQueryString, sha256Hex,
 * buildHmacPayload from this module is the single-source-of-truth invariant.
 *
 * Body handling: `req.clone().bytes()` reads the body as raw bytes; cloning
 * preserves the original body for the downstream handler. Body-less requests
 * (GET) hash to SHA-256("") consistently between sign and verify.
 *
 * Returns `{userId}` on success, `null` on ANY verification failure
 * (missing headers, malformed signature, timestamp out of window, signature
 * mismatch). The gateway treats null as 401 `invalid_internal_mcp_signature`
 * and MUST NOT fall through to other auth paths.
 *
 * @param req     The inbound `Request` (edge runtime).
 * @param secret  `MCP_INTERNAL_HMAC_SECRET`. Caller provides explicitly so
 *                tests can inject without env mutation.
 * @param now     Override Unix-seconds (test injection); defaults to
 *                `Math.floor(Date.now()/1000)`.
 */
export async function verifyInternalMcpRequest(
  req: Request,
  secret: string,
  now?: number,
): Promise<VerifiedInternalMcpRequest | null> {
  if (!secret) return null;

  const sigHeader = req.headers.get(INTERNAL_MCP_SIG_HEADER);
  const userId = req.headers.get(INTERNAL_MCP_USER_ID_HEADER);
  if (!sigHeader || !userId) return null;

  const parsed = parseSignatureHeader(sigHeader);
  if (!parsed) return null;
  const { ts, sigB64u } = parsed;

  const nowSec = Math.floor(now ?? Date.now() / 1000);
  if (Math.abs(nowSec - ts) > INTERNAL_MCP_TIMESTAMP_WINDOW_SECONDS) return null;

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return null;
  }

  // Body must be cloned BEFORE reading so the downstream handler can still
  // read it — Web Fetch API contract: a body can only be consumed once on
  // any given Request/Response.
  let bodyBytes: Uint8Array;
  try {
    const buf = await req.clone().arrayBuffer();
    bodyBytes = new Uint8Array(buf);
  } catch {
    return null;
  }
  // sha256Hex takes a string; coerce raw bytes via TextDecoder. Empty body →
  // empty string → SHA-256(""), matching the signer's `coerceBodyToString`.
  const bodyAsString = bodyBytes.length === 0 ? '' : new TextDecoder().decode(bodyBytes);

  const queryHash = await sha256Hex(canonicalQueryString(url));
  const bodyHash = await sha256Hex(bodyAsString);

  const expectedPayload = buildHmacPayload({
    ts,
    method: req.method,
    pathname: url.pathname,
    queryHash,
    bodyHash,
    userId,
  });
  const expectedSig = await hmacSha256Base64Url(secret, expectedPayload);

  const ok = await timingSafeStringEqual(expectedSig, sigB64u);
  if (!ok) return null;
  return { userId };
}
