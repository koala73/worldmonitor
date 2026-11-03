/**
 * Short-lived, panel-scoped grants (`wmg_…`) for the partner-embed frame.
 *
 * The frame exchanges its `wme_` key for one of these ONCE at boot and then
 * polls the composed endpoint with the grant. The exchange exists because a
 * `wm_`-family key on every poll enters the per-account daily meter
 * (`server/gateway.ts`): five endpoints at a ten-minute cadence is 720
 * requests/day against API Starter's 1,000, so a single wall display would
 * spend a customer's REST allowance on rendering itself. A grant is not a
 * `wm_` key, resolves only on the embed surface, and never reaches that meter.
 *
 * Stateless HMAC rather than a stored session: there is nothing to revoke that
 * the 30-minute TTL does not already close, and a Redis round-trip on the
 * cached free path would defeat the point of caching it.
 *
 * Signed with WM_SESSION_SECRET — the same secret as the `wms_` browser
 * session, but domain-separated by {@link GRANT_SIGNING_DOMAIN}. The two token
 * families therefore cannot be converted into one another by re-labelling the
 * prefix: a `wms_` body carries a signature over the bare body, which fails
 * here, and a `wmg_` body carries one over the domain-prefixed message, which
 * fails in `api/_session.js`. That is why this needs no new env var.
 */

import { isEmbedPanelId, type EmbedPanelId } from '../../shared/embed-panels';

const PREFIX = 'wmg_';
const GRANT_SIGNING_DOMAIN = 'wmg.v1.';
export const EMBED_GRANT_TTL_MS = 30 * 60 * 1000;

const enc = new TextEncoder();

export interface EmbedGrantClaims {
  panel: EmbedPanelId;
  accountId: string;
  issuedAt: number;
  expiresAt: number;
}

/** Wire payload. Short keys keep the token compact; it rides in a header. */
interface EmbedGrantPayload {
  p: string;
  a: string;
  iat: number;
  exp: number;
}

function getSecret(): string {
  const secret = process.env.WM_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('WM_SESSION_SECRET must be set (min 32 chars)');
  }
  return secret;
}

async function importHmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(getSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function bufferToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const pad = (4 - (value.length % 4)) % 4;
  const b64 = (value + '='.repeat(pad)).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function stringToBase64Url(value: string): string {
  return bufferToBase64Url(enc.encode(value).buffer as ArrayBuffer);
}

function base64UrlToString(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

async function sign(body: string): Promise<string> {
  const key = await importHmacKey();
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${GRANT_SIGNING_DOMAIN}${body}`));
  return bufferToBase64Url(sig);
}

export function isEmbedGrantShape(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.startsWith(PREFIX);
}

/**
 * Mint a grant for one panel and one account.
 *
 * `accountId` is the embed key's owning userId. It stays inside the frame —
 * the grant lives in the iframe's JS memory on our own origin, never in the
 * iframe URL or a cookie — so a cross-origin parent cannot read it back out.
 */
export async function mintEmbedGrant(
  claims: { panel: EmbedPanelId; accountId: string },
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = now + EMBED_GRANT_TTL_MS;
  const payload: EmbedGrantPayload = {
    p: claims.panel,
    a: claims.accountId,
    iat: now,
    exp: expiresAt,
  };
  const body = stringToBase64Url(JSON.stringify(payload));
  return { token: `${PREFIX}${body}.${await sign(body)}`, expiresAt };
}

/**
 * Verify a grant and return its claims, or null for ANY failure — bad shape,
 * bad signature, unparseable payload, unknown panel, or expiry. Fails closed
 * when WM_SESSION_SECRET is unset or short, exactly as `wms_` does.
 */
export async function verifyEmbedGrant(
  token: string | null | undefined,
  now: number = Date.now(),
): Promise<EmbedGrantClaims | null> {
  if (!isEmbedGrantShape(token)) return null;
  const tail = (token as string).slice(PREFIX.length);
  const dot = tail.indexOf('.');
  if (dot < 0) return null;
  const body = tail.slice(0, dot);
  const providedSig = tail.slice(dot + 1);
  if (!body || !providedSig) return null;

  let expectedSig: string;
  try {
    expectedSig = await sign(body);
  } catch {
    return null;
  }

  let providedBytes: Uint8Array;
  try {
    providedBytes = base64UrlToBytes(providedSig);
  } catch {
    return null;
  }

  // Require canonical base64url: the trailing character can carry unused
  // padding bits, so a tampered signature string can decode to the same bytes
  // and pass the comparison below without this (PR #3557 review finding).
  if (bufferToBase64Url(providedBytes.buffer as ArrayBuffer) !== providedSig) return null;

  const expectedBytes = base64UrlToBytes(expectedSig);
  if (expectedBytes.length !== providedBytes.length) return null;
  let diff = 0;
  for (let i = 0; i < expectedBytes.length; i++) {
    diff |= (expectedBytes[i] as number) ^ (providedBytes[i] as number);
  }
  if (diff !== 0) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlToString(body));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const { p, a, iat, exp } = payload as Partial<EmbedGrantPayload>;
  if (typeof p !== 'string' || !isEmbedPanelId(p)) return null;
  if (typeof a !== 'string' || a.length === 0) return null;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (now >= exp) return null;
  // A forged far-future `exp` cannot reach here (the signature covers it), but
  // a grant minted by a wrongly-clocked isolate could. Cap the window at the
  // TTL this module actually issues so such a token cannot outlive its policy.
  if (exp - iat > EMBED_GRANT_TTL_MS) return null;

  return { panel: p, accountId: a, issuedAt: iat, expiresAt: exp };
}
