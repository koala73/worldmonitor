/**
 * HMAC-signed URL helpers for the WorldMonitor Brief magazine route.
 *
 * The hosted magazine at /api/brief/{userId}/{issueDate} is auth-less
 * in the traditional sense (no Clerk session, no cookie). The signed
 * token IS the credential: a recipient with the URL can read the
 * magazine; without it, no. This matches the push / email delivery
 * model where the token is delivered to the user through an already-
 * authenticated channel.
 *
 * Secret rotation is supported: set BRIEF_URL_SIGNING_SECRET_PREV to
 * the outgoing secret for the overlap window. `verifyBriefToken` will
 * accept a token signed with either, so producers can roll the primary
 * secret without invalidating in-flight notifications.
 *
 * Rotation runbook:
 *   - Normal roll: set PREV = current, then replace SECRET with a
 *     fresh value. Keep PREV set for at least the envelope TTL
 *     (7 days) plus the push/email-delivery window so in-flight
 *     notifications remain valid.
 *   - Emergency kill switch (suspected secret leak): rotate SECRET
 *     and do NOT set PREV. This invalidates every outstanding token
 *     immediately. Accept the breakage of in-flight notifications
 *     as the cost of containment.
 *
 * All crypto goes through Web Crypto (`crypto.subtle`) so this module
 * runs unchanged in Vercel Edge, Node 18+, and Tauri.
 */

const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ISSUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // base64url(sha256) = 43 chars, no padding

export class BriefUrlError extends Error {
  readonly code: 'invalid_user_id' | 'invalid_issue_date' | 'missing_secret';

  constructor(code: BriefUrlError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'BriefUrlError';
  }
}

function assertShape(userId: string, issueDate: string): void {
  if (!USER_ID_RE.test(userId)) {
    throw new BriefUrlError('invalid_user_id', 'userId must match [A-Za-z0-9_-]{1,128}');
  }
  if (!ISSUE_DATE_RE.test(issueDate)) {
    throw new BriefUrlError('invalid_issue_date', 'issueDate must match YYYY-MM-DD');
  }
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

/** Constant-time byte comparison. Returns false on length mismatch. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Deterministically sign `${userId}:${issueDate}` and return a
 * base64url-encoded token. Throws BriefUrlError on malformed inputs or
 * missing secret.
 */
export async function signBriefToken(
  userId: string,
  issueDate: string,
  secret: string,
): Promise<string> {
  assertShape(userId, issueDate);
  if (!secret) {
    throw new BriefUrlError('missing_secret', 'BRIEF_URL_SIGNING_SECRET is not configured');
  }
  const sig = await hmacSha256(secret, `${userId}:${issueDate}`);
  return base64url(sig);
}

/**
 * Verify a token against userId + issueDate. Accepts the primary
 * secret and (if provided) a previous secret during rotation. Returns
 * `true` only on a byte-for-byte match under either secret.
 *
 * The token is rejected without ever touching crypto if its shape is
 * invalid (wrong length, illegal chars). userId and issueDate are
 * shape-validated before any HMAC computation to prevent probing.
 */
export async function verifyBriefToken(
  userId: string,
  issueDate: string,
  token: string,
  secret: string,
  prevSecret?: string,
): Promise<boolean> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
  try {
    assertShape(userId, issueDate);
  } catch {
    return false;
  }
  if (!secret) {
    throw new BriefUrlError('missing_secret', 'BRIEF_URL_SIGNING_SECRET is not configured');
  }

  const tokenBytes = base64urlDecode(token);
  if (!tokenBytes) return false;

  const message = `${userId}:${issueDate}`;
  const primary = await hmacSha256(secret, message);
  if (constantTimeEqual(primary, tokenBytes)) return true;

  if (prevSecret) {
    const legacy = await hmacSha256(prevSecret, message);
    if (constantTimeEqual(legacy, tokenBytes)) return true;
  }
  return false;
}

function base64urlDecode(token: string): Uint8Array | null {
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice((b64.length + 3) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Compose the full magazine URL with signed token.
 *
 * Producers should always go through this helper rather than string-
 * concatenating URLs by hand. Example:
 *
 *   const url = await signBriefUrl({
 *     userId: 'user_abc',
 *     issueDate: '2026-04-17',
 *     baseUrl: 'https://worldmonitor.app',
 *     secret: process.env.BRIEF_URL_SIGNING_SECRET!,
 *   });
 */
export async function signBriefUrl({
  userId,
  issueDate,
  baseUrl,
  secret,
}: {
  userId: string;
  issueDate: string;
  baseUrl: string;
  secret: string;
}): Promise<string> {
  const token = await signBriefToken(userId, issueDate, secret);
  const encodedUser = encodeURIComponent(userId);
  const encodedDate = encodeURIComponent(issueDate);
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  return `${trimmedBase}/api/brief/${encodedUser}/${encodedDate}?t=${token}`;
}
