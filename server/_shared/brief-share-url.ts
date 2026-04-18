/**
 * HMAC-derived public-share hash for the WorldMonitor Brief.
 *
 * The hosted per-user magazine at /api/brief/{userId}/{issueDate} is
 * bound to a specific reader via a signed token. Sharing that URL
 * leaks the recipient's identity to whoever reopens the link, so
 * "just copy the URL" is not a viable share action.
 *
 * Instead the Share button generates a separate public URL at
 * /api/brief/public/{hash} where {hash} is a deterministic 12-char
 * HMAC over (userId, issueDate). The unauth'd public route reads a
 * pointer key (brief:public:{hash}) that maps back to the original
 * per-user brief, and renders it in "public mode" — whyMatters and
 * the user's name are stripped before HTML emission.
 *
 * Secret hygiene:
 *   - BRIEF_SHARE_SECRET is distinct from BRIEF_URL_SIGNING_SECRET so
 *     a leak of one doesn't automatically unmask per-user tokens.
 *   - No rotation helper (_PREV variant) yet; share URLs have a 7-day
 *     TTL and rotating the secret invalidates in-flight share links,
 *     which is acceptable since share is a growth vector, not the
 *     primary delivery channel. Add a PREV shim here if we ever need
 *     graceful rotation.
 *
 * All crypto goes through Web Crypto so this module runs unchanged in
 * Vercel Edge, Node 18+, and Tauri.
 */

const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ISSUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 12 base64url chars = 72 bits — enough to prevent brute-force
// enumeration of active share URLs even at aggressive rates.
const HASH_RE = /^[A-Za-z0-9_-]{12}$/;

export class BriefShareUrlError extends Error {
  readonly code: 'invalid_user_id' | 'invalid_issue_date' | 'missing_secret' | 'invalid_hash';

  constructor(code: BriefShareUrlError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'BriefShareUrlError';
  }
}

function assertShape(userId: string, issueDate: string): void {
  if (!USER_ID_RE.test(userId)) {
    throw new BriefShareUrlError('invalid_user_id', 'userId must match [A-Za-z0-9_-]{1,128}');
  }
  if (!ISSUE_DATE_RE.test(issueDate)) {
    throw new BriefShareUrlError('invalid_issue_date', 'issueDate must match YYYY-MM-DD');
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

/**
 * Deterministic 12-char base64url hash of (userId, issueDate). Two
 * calls with the same arguments always return the same hash; an
 * attacker who does not hold BRIEF_SHARE_SECRET cannot guess a valid
 * hash for any {userId, issueDate} pair.
 *
 * The hash is intentionally short (72 bits) so URLs stay copy-paste-
 * friendly on social channels. Given the per-hash pointer has a 7-day
 * TTL and lives in Redis (not indexed anywhere), 72 bits is well
 * above the brute-force threshold for any practical attacker.
 */
export async function deriveShareHash(
  userId: string,
  issueDate: string,
  secret: string,
): Promise<string> {
  assertShape(userId, issueDate);
  if (!secret) {
    throw new BriefShareUrlError('missing_secret', 'BRIEF_SHARE_SECRET is not configured');
  }
  const bytes = await hmacSha256(secret, `${userId}:${issueDate}`);
  // Take first 9 bytes = 72 bits → 12 base64url chars (no padding).
  return base64url(bytes.slice(0, 9));
}

/**
 * Shape check only. Cannot validate the hash cryptographically from
 * outside — that requires the secret and the referenced {userId,
 * issueDate}, which the public route recovers from the Redis pointer.
 */
export function isValidShareHashShape(hash: unknown): hash is string {
  return typeof hash === 'string' && HASH_RE.test(hash);
}

/**
 * Compose the full public share URL.
 *
 * Consumers should always go through this helper so the path shape
 * and the hash derivation stay in lockstep. The optional `refCode`
 * attaches a referral query parameter for signup attribution when
 * the recipient clicks the magazine's subscribe CTA.
 */
export async function buildPublicBriefUrl({
  userId,
  issueDate,
  baseUrl,
  secret,
  refCode,
}: {
  userId: string;
  issueDate: string;
  baseUrl: string;
  secret: string;
  refCode?: string;
}): Promise<{ url: string; hash: string }> {
  const hash = await deriveShareHash(userId, issueDate, secret);
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const qs = refCode ? `?ref=${encodeURIComponent(refCode)}` : '';
  return {
    url: `${trimmedBase}/api/brief/public/${hash}${qs}`,
    hash,
  };
}

/**
 * Opaque pointer value format used in Redis under brief:public:{hash}.
 * Kept as a simple colon-delimited string to mirror other per-user
 * brief key conventions and avoid an envelope round-trip for what is
 * structurally just a pointer.
 */
export function encodePublicPointer(userId: string, issueDate: string): string {
  assertShape(userId, issueDate);
  return `${userId}:${issueDate}`;
}

/**
 * Parse the pointer value written by encodePublicPointer. Returns
 * null on any shape mismatch — the public route treats that as a
 * "pointer missing" condition (same 404 path as a Redis miss).
 */
export function decodePublicPointer(raw: unknown): { userId: string; issueDate: string } | null {
  if (typeof raw !== 'string') return null;
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const userId = raw.slice(0, idx);
  const issueDate = raw.slice(idx + 1);
  try {
    assertShape(userId, issueDate);
  } catch {
    return null;
  }
  return { userId, issueDate };
}

export const BRIEF_PUBLIC_POINTER_PREFIX = 'brief:public:';
