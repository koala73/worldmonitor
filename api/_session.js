// Server-issued, HMAC-signed session tokens for anonymous browser access.
//
// Replaces the previous Origin/Referer header-based "trusted browser" trust
// path (issue #3541). HTTP headers are entirely client-controlled at the wire
// level — Origin, Sec-Fetch-Site, Referer, etc. are all forgeable by curl /
// Node http / raw socket. Only cryptographic proof closes that bypass class.
//
// Tokens are HMAC-SHA256(secret, base64url(payload)) with payload {iat,exp,n}.
// The frontend fetches one at app boot via POST /api/wm-session and includes
// it on subsequent API calls via the X-WorldMonitor-Key header. Curl can't
// manufacture one without WM_SESSION_SECRET (server-only). It CAN replay a
// stolen one, but session-start is rate-limited and tokens are short-lived.
//
// Uses Web Crypto API (crypto.subtle) — works in both Vercel Edge runtime
// and Node.js test environment without `node:crypto` (which the bundle check
// rejects under --platform=browser).

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PREFIX = 'wms_';
const enc = new TextEncoder();

function getSecret() {
  const s = process.env.WM_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error('WM_SESSION_SECRET must be set (min 32 chars)');
  }
  return s;
}

async function importHmacKey() {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(getSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function bufferToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s) {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = (s + '='.repeat(pad)).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function stringToBase64Url(s) {
  return bufferToBase64Url(enc.encode(s).buffer);
}

function base64UrlToString(s) {
  const bytes = base64UrlToBytes(s);
  return new TextDecoder().decode(bytes);
}

function randomNonceHex(byteLen = 8) {
  const arr = new Uint8Array(byteLen);
  crypto.getRandomValues(arr);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
  return s;
}

export async function issueSessionToken() {
  const payload = {
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    n: randomNonceHex(8),
  };
  const body = stringToBase64Url(JSON.stringify(payload));
  const key = await importHmacKey();
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const sig = bufferToBase64Url(sigBuf);
  return { token: `${PREFIX}${body}.${sig}`, exp: payload.exp };
}

export function isSessionTokenShape(token) {
  return typeof token === 'string' && token.startsWith(PREFIX);
}

// Returns true ONLY if: prefix matches, signature verifies (constant-time),
// payload parses, and exp is in the future. Any failure mode returns false.
// Crucially, fails closed if WM_SESSION_SECRET is unset/short.
export async function validateSessionToken(token) {
  if (!isSessionTokenShape(token)) return false;
  const tail = token.slice(PREFIX.length);
  const dot = tail.indexOf('.');
  if (dot < 0) return false;
  const body = tail.slice(0, dot);
  const sig = tail.slice(dot + 1);
  if (!body || !sig) return false;

  let key;
  try { key = await importHmacKey(); } catch { return false; }

  let expectedBuf;
  try { expectedBuf = await crypto.subtle.sign('HMAC', key, enc.encode(body)); } catch { return false; }

  let providedBytes;
  try { providedBytes = base64UrlToBytes(sig); } catch { return false; }

  // Enforce canonical base64url encoding: re-encode the decoded bytes and
  // require an exact match. Without this, the trailing base64 character can
  // carry up to 4 unused padding bits — flipping them yields a *different*
  // string that decodes to the *same* bytes, allowing a tampered signature
  // string to pass HMAC verification (PR #3557 review finding).
  if (bufferToBase64Url(providedBytes.buffer) !== sig) return false;

  const expected = new Uint8Array(expectedBuf);
  if (expected.length !== providedBytes.length) return false;

  // Constant-time comparison. Don't short-circuit on first mismatch.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ providedBytes[i];
  if (diff !== 0) return false;

  let payload;
  try { payload = JSON.parse(base64UrlToString(body)); } catch { return false; }
  if (typeof payload.exp !== 'number') return false;
  if (Date.now() > payload.exp) return false;
  return true;
}
