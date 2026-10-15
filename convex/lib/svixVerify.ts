/**
 * Svix / Standard Webhooks signature verification, shared by every webhook
 * handler that receives one (#8491).
 *
 * Clerk and Resend deliver through Svix (`svix-id` / `svix-timestamp` /
 * `svix-signature`); Dodo Payments uses the vendored standardwebhooks scheme
 * with `webhook-*` header names. The wire format is otherwise identical:
 * a `whsec_` + base64 secret, HMAC-SHA256 over `${id}.${timestamp}.${body}`,
 * and a space-separated list of `v1,<base64>` candidates, one per active
 * signing key.
 *
 * Before this module each handler carried its own copy, and three separate
 * hardening measures each landed in exactly one of them: the anchored secret
 * prefix strip (Clerk only), the bounded candidate loop (Clerk only) and the
 * malformed-candidate guard (Resend only). Folding them here means a fix to
 * the verifier reaches every webhook at once.
 */

export const SVIX_SECRET_PREFIX = "whsec_";

/** Replay window every caller uses unless it asks for another. */
export const DEFAULT_SVIX_SKEW_SECONDS = 300;

/**
 * Most `v1` signatures considered per delivery. Svix sends one per active
 * signing key, so this comfortably covers a key rotation while capping the
 * crypto an unauthenticated caller can make an endpoint perform: each
 * candidate costs a key generation plus two HMAC signs.
 */
export const MAX_SIGNATURE_CANDIDATES = 5;

export type SvixHeaderNames = {
  id: string;
  timestamp: string;
  signature: string;
};

/** Svix proper (Clerk, Resend). */
export const SVIX_HEADER_NAMES: SvixHeaderNames = {
  id: "svix-id",
  timestamp: "svix-timestamp",
  signature: "svix-signature",
};

/** Standard Webhooks spelling (Dodo Payments). */
export const STANDARD_WEBHOOK_HEADER_NAMES: SvixHeaderNames = {
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
};

export type SvixVerifyFailure =
  | "missing_headers"
  | "invalid_timestamp"
  | "timestamp_too_old"
  | "timestamp_too_new"
  | "no_matching_signature";

export type SvixVerifyResult =
  | { ok: true }
  | { ok: false; reason: SvixVerifyFailure };

export type SvixVerifyOptions = {
  skewSeconds?: number;
  headerNames?: SvixHeaderNames;
  maxCandidates?: number;
  /** Injected for tests; seconds since the epoch. */
  nowSeconds?: number;
};

/**
 * Constant-time string comparison for secrets and signatures.
 *
 * Both inputs are run through the same fresh HMAC key so the comparison
 * happens over fixed-length digests: neither the length difference nor the
 * position of the first mismatching byte leaks through timing.
 */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign("HMAC", keyMaterial, enc.encode(a)),
    crypto.subtle.sign("HMAC", keyMaterial, enc.encode(b)),
  ]);
  const aArr = new Uint8Array(sigA);
  const bArr = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < aArr.length; i++) diff |= aArr[i]! ^ bArr[i]!;
  return diff === 0;
}

/**
 * Raw HMAC key bytes from a `whsec_…` secret.
 *
 * Anchored strip: `String.replace` removes the first occurrence anywhere, so
 * a secret whose base64 body happened to contain the prefix would be silently
 * corrupted into a different key, and every delivery would then fail
 * verification for a reason no log would explain. A secret without the
 * prefix is accepted as the bare base64 body.
 */
export function decodeSvixSecret(secret: string): Uint8Array<ArrayBuffer> {
  const body = secret.startsWith(SVIX_SECRET_PREFIX)
    ? secret.slice(SVIX_SECRET_PREFIX.length)
    : secret;
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

/**
 * The `v1` candidates from a signature header, in order, bounded.
 *
 * A candidate must be exactly `version,value`: a part with a missing or
 * extra field is skipped rather than partially parsed. Anything past the cap
 * is dropped, so a real signature buried behind padding fails closed instead
 * of making the endpoint do the work.
 */
export function collectSignatureCandidates(
  signatureHeader: string,
  maxCandidates: number = MAX_SIGNATURE_CANDIDATES,
): string[] {
  const candidates: string[] = [];
  for (const part of signatureHeader.split(" ")) {
    const fields = part.split(",");
    if (fields.length !== 2) continue;
    const [version, value] = fields;
    if (version !== "v1" || !value) continue;
    candidates.push(value);
    if (candidates.length >= maxCandidates) break;
  }
  return candidates;
}

/** Base64 HMAC-SHA256 of `${id}.${timestamp}.${payload}` under the secret. */
export async function computeSvixSignature(
  secret: string,
  id: string,
  timestamp: string,
  payload: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    decodeSvixSecret(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${payload}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/**
 * Timestamps on the wire are integer seconds. Neither `Number()` (accepts
 * `1e9`, `1.5`, padding) nor `parseInt` (accepts `123abc`) was the right
 * parser, and the three copies disagreed on which to use.
 */
function parseTimestampSeconds(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

/**
 * Verify one delivery. Never throws on bad input: the result names why a
 * delivery failed so a caller can log or map it (Dodo maps the reasons onto
 * the SDK's error messages) without re-deriving the checks.
 */
export async function verifySvixSignature(
  payload: string,
  headers: Headers,
  secret: string,
  options: SvixVerifyOptions = {},
): Promise<SvixVerifyResult> {
  const names = options.headerNames ?? SVIX_HEADER_NAMES;
  const skewSeconds = options.skewSeconds ?? DEFAULT_SVIX_SKEW_SECONDS;
  const maxCandidates = options.maxCandidates ?? MAX_SIGNATURE_CANDIDATES;

  const id = headers.get(names.id);
  const timestamp = headers.get(names.timestamp);
  const signatureHeader = headers.get(names.signature);
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, reason: "missing_headers" };
  }

  const ts = parseTimestampSeconds(timestamp);
  if (ts === null) return { ok: false, reason: "invalid_timestamp" };
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now - ts > skewSeconds) return { ok: false, reason: "timestamp_too_old" };
  if (ts - now > skewSeconds) return { ok: false, reason: "timestamp_too_new" };

  const expected = await computeSvixSignature(secret, id, timestamp, payload);
  for (const candidate of collectSignatureCandidates(signatureHeader, maxCandidates)) {
    if (await timingSafeEqualStrings(candidate, expected)) return { ok: true };
  }
  return { ok: false, reason: "no_matching_signature" };
}
