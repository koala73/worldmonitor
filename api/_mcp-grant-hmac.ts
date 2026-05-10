/**
 * HMAC sign / verify helpers for the Pro-MCP cross-subdomain grant token.
 *
 * Used by:
 *   - U3 `api/internal/mcp-grant-mint.ts` — signs `{userId, nonce, exp}`
 *     after a Clerk-authenticated Pro user clicks "Authorize" on the apex
 *     consent page, returns a redirect URL whose `grant=` query parameter
 *     carries the signed payload.
 *   - U5 `api/oauth/authorize-pro.ts` — verifies the grant on the api
 *     subdomain before consuming the matching `mcp-grant:<nonce>` Redis
 *     one-shot and issuing the OAuth code.
 *
 * Token wire format (load-bearing — U3 and U5 MUST agree):
 *
 *   <base64url(payloadJson)>.<base64url(sigBytes)>
 *
 *   payloadJson = JSON.stringify({ userId: string, nonce: string, exp: number })
 *   sigBytes    = HMAC-SHA-256(secret, UTF-8 bytes of payloadJson)
 *
 * The signature is computed over the *exact JSON bytes* the verifier will
 * read after base64url-decoding — NOT over a re-serialised object. This
 * makes verification independent of JSON key ordering, whitespace, or
 * future field additions: whatever bytes were signed are exactly the
 * bytes verified. Same approach as the JWS compact serialisation pattern.
 *
 * `exp` is absolute epoch milliseconds (Date.now() + 5 * 60 * 1000 at
 * mint time). Verifier compares against Date.now(); mint-time clock skew
 * is bounded by the Redis nonce TTL anyway.
 *
 * Secret env: MCP_PRO_GRANT_HMAC_SECRET (32-byte+ random, base64 OK).
 * Missing env throws — handlers MUST surface this as 500
 * `CONFIGURATION_ERROR` (NOT 401/403, which would let an attacker
 * confuse "missing secret in prod" with "expired grant").
 *
 * Edge-runtime safe: uses Web Crypto API only. No node:crypto imports.
 */

const ENC = new TextEncoder();
const DEC = new TextDecoder();

export interface GrantPayload {
  userId: string;
  nonce: string;
  /** Absolute epoch milliseconds. */
  exp: number;
}

export class GrantConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantConfigError';
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    ENC.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Reads the env var. Throws GrantConfigError if missing/empty. */
export function readGrantSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.MCP_PRO_GRANT_HMAC_SECRET ?? '';
  if (!secret) {
    throw new GrantConfigError('MCP_PRO_GRANT_HMAC_SECRET is not set');
  }
  return secret;
}

/**
 * Sign a grant payload. Returns the wire-format token
 * `<base64url(payloadJson)>.<base64url(sig)>`.
 *
 * Deterministic for a given (payload, secret) pair: stringifies once,
 * signs the exact bytes, encodes both halves with base64url-no-pad.
 */
export async function signGrant(payload: GrantPayload, secret?: string): Promise<string> {
  const sec = secret ?? readGrantSecret();
  const json = JSON.stringify({ userId: payload.userId, nonce: payload.nonce, exp: payload.exp });
  const payloadBytes = ENC.encode(json);
  const key = await importHmacKey(sec);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, payloadBytes));
  return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(sig)}`;
}

export type GrantVerifyResult =
  | { ok: true; payload: GrantPayload }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' | 'invalid-payload' };

/**
 * Verify a wire-format grant token against the configured HMAC secret.
 *
 *   - 'malformed':       wrong shape (missing dot, non-base64url halves)
 *   - 'bad-signature':   HMAC mismatch (uses Web Crypto verify, constant-time)
 *   - 'invalid-payload': decoded payload is not the expected shape
 *   - 'expired':         payload.exp <= Date.now()
 *
 * Caller MUST treat any non-ok result as 400 `INVALID_GRANT` and refuse
 * to consume the matching Redis nonce. Distinct status codes leak intel.
 */
export async function verifyGrant(token: string, secret?: string, now: number = Date.now()): Promise<GrantVerifyResult> {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'malformed' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  // Stricter than RFC 7515: we only emit base64url-no-pad, so anything
  // outside [A-Za-z0-9_-] is malformed.
  if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || !/^[A-Za-z0-9_-]+$/.test(sigB64)) {
    return { ok: false, reason: 'malformed' };
  }

  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    payloadBytes = base64UrlDecode(payloadB64);
    sigBytes = base64UrlDecode(sigB64);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const sec = secret ?? readGrantSecret();
  const key = await importHmacKey(sec);
  // crypto.subtle.verify accepts BufferSource. The lib.dom.d.ts signature
  // narrows the buffer type to ArrayBuffer (vs SharedArrayBuffer); explicit
  // cast keeps strict-mode TS happy without changing runtime behaviour.
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes as BufferSource, payloadBytes as BufferSource);
  if (!ok) return { ok: false, reason: 'bad-signature' };

  let payload: unknown;
  try {
    payload = JSON.parse(DEC.decode(payloadBytes));
  } catch {
    return { ok: false, reason: 'invalid-payload' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'invalid-payload' };
  const p = payload as Record<string, unknown>;
  if (typeof p.userId !== 'string' || p.userId.length === 0) return { ok: false, reason: 'invalid-payload' };
  if (typeof p.nonce !== 'string' || p.nonce.length === 0) return { ok: false, reason: 'invalid-payload' };
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return { ok: false, reason: 'invalid-payload' };
  if (p.exp <= now) return { ok: false, reason: 'expired' };

  return { ok: true, payload: { userId: p.userId, nonce: p.nonce, exp: p.exp } };
}
