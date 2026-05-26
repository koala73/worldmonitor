// HMAC URL signer for scripts/ cron code.
//
// Port of the sign path in server/_shared/brief-url.ts. The edge
// route still owns verify (that code runs unchanged); the digest
// cron only needs to mint magazine URLs to embed in notification
// bodies.
//
// Kept in parity with the TS module — any change to the signing
// formula MUST happen in both places in the same PR. A regression
// test in tests/brief-url-sign.test.mjs produces a token with this
// helper and verifies it via the edge's verifyBriefToken.
//
// No node:crypto — Web Crypto (crypto.subtle + btoa) only. That lets
// the same helper run on Node 18+, Vercel Edge, Cloudflare Workers,
// and Tauri if ever needed from a non-cron path.

const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// YYYY-MM-DD-HHMM issue slot (local hour+minute of the compose run,
// in the user's tz). Slot-per-run gives each digest dispatch its own
// frozen magazine URL; same-day reruns no longer collide.
const ISSUE_DATE_RE = /^\d{4}-\d{2}-\d{2}-\d{4}$/;

export class BriefUrlError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'BriefUrlError';
  }
}

function assertShape(userId, issueDate) {
  if (!USER_ID_RE.test(userId)) {
    throw new BriefUrlError('invalid_user_id', 'userId must match [A-Za-z0-9_-]{1,128}');
  }
  if (!ISSUE_DATE_RE.test(issueDate)) {
    throw new BriefUrlError('invalid_issue_date', 'issueDate must match YYYY-MM-DD-HHMM');
  }
}

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(secret, message) {
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
 * Deterministically sign `${userId}:${issueDate}` and return a
 * base64url-encoded token (43 chars, no padding).
 * @param {string} userId @param {string} issueDate @param {string} secret
 * @returns {Promise<string>}
 */
export async function signBriefToken(userId, issueDate, secret) {
  assertShape(userId, issueDate);
  if (!secret) {
    throw new BriefUrlError('missing_secret', 'BRIEF_URL_SIGNING_SECRET is not configured');
  }
  const sig = await hmacSha256(secret, `${userId}:${issueDate}`);
  return base64url(sig);
}

/**
 * @param {{ userId: string; issueDate: string; baseUrl: string; secret: string }} opts
 * @returns {Promise<string>}
 */
export async function signBriefUrl({ userId, issueDate, baseUrl, secret }) {
  const token = await signBriefToken(userId, issueDate, secret);
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/api/brief/${encodeURIComponent(userId)}/${encodeURIComponent(issueDate)}?t=${token}`;
}
