import { isSessionTokenShape, validateSessionToken } from './_session.js';

const DESKTOP_ORIGIN_PATTERNS = [
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

function isDesktopOrigin(origin) {
  return Boolean(origin) && DESKTOP_ORIGIN_PATTERNS.some(p => p.test(origin));
}

function isValidEnterpriseKey(key) {
  if (!key) return false;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  return validKeys.includes(key);
}

// Note: HTTP headers like Origin / Referer / Sec-Fetch-Site are entirely
// client-controlled at the wire level (see issue #3541 / closed PR #3554).
// Trusting any of them as a "this is a real browser" signal is forgeable by
// curl in one line. The previous Referer-origin fallback and Origin-pattern
// no-key trust path are both gone. Browsers now authenticate via:
//   1. A short-lived wms_-prefixed session token (HMAC-signed by /api/wm-session).
//      Kind: 'session'. Anonymous; satisfies basic gate, but downstream
//      entitlement / premium checks must STILL run (a session token is freely
//      mintable by anyone who can hit /api/wm-session — it is NOT proof of a
//      paying user). Rejected when forceKey=true.
//   2. A wm_-prefixed user API key (validated against the user-key table by gateway).
//      Kind: 'user'. Returns required:true/valid:false here so the gateway's
//      fallback at server/gateway.ts:~440 triggers validateUserApiKey().
//   3. An enterprise key (WORLDMONITOR_VALID_KEYS). Kind: 'enterprise'. The
//      ONLY kind that bypasses entitlement checks (operator-issued).
// Tauri desktop continues to authenticate via enterprise key.
//
// Async because session validation uses Web Crypto (crypto.subtle.sign).
// All call sites await this — see grep for migration history.
export async function validateApiKey(req, options = {}) {
  const forceKey = options.forceKey === true;
  const key = req.headers.get('X-WorldMonitor-Key') || req.headers.get('X-Api-Key');
  const origin = req.headers.get('Origin') || '';

  // Desktop app — always require an enterprise key.
  if (isDesktopOrigin(origin)) {
    if (!key) return { valid: false, required: true, error: 'API key required for desktop access' };
    if (!isValidEnterpriseKey(key)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true, kind: 'enterprise' };
  }

  // Browser anonymous session: HMAC-signed token from /api/wm-session.
  // Validation is purely cryptographic — no DB lookup, no header trust.
  if (isSessionTokenShape(key)) {
    // Anonymous session tokens are NOT proof of any specific user identity
    // — anyone can mint one via POST /api/wm-session. Reject when the caller
    // demands a "real" key (premium / tier-gated endpoints set forceKey=true
    // exactly because they need user-bound auth or a Pro-grade Bearer JWT).
    if (forceKey) {
      return { valid: false, required: true, error: 'Pro authentication required' };
    }
    if (await validateSessionToken(key)) {
      return { valid: true, required: false, kind: 'session' };
    }
    return { valid: false, required: true, error: 'Invalid session token' };
  }

  // wm_-prefixed user API keys — gateway re-validates against the user-key
  // table. We must return required:true / valid:false for the gateway's
  // fallback at server/gateway.ts:~440 to trigger validateUserApiKey().
  if (key && key.startsWith('wm_')) {
    return { valid: false, required: true, error: 'User API key requires gateway validation' };
  }

  // Enterprise key (WORLDMONITOR_VALID_KEYS).
  if (key) {
    if (!isValidEnterpriseKey(key)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true, kind: 'enterprise' };
  }

  // No credentials at all.
  return { valid: false, required: true, error: 'API key required' };
}
