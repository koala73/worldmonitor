const DESKTOP_ORIGIN_PATTERNS = [
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

const BROWSER_ORIGIN_PATTERNS = [
  /^https:\/\/worldmonitor\.app$/,
  /^https:\/\/(tech|finance|happy|api)\.worldmonitor\.app$/,
  /^https:\/\/worldmonitor-[a-z0-9-]+\.vercel\.app$/,
  ...(process.env.NODE_ENV === 'production' ? [] : [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  ]),
];

function isDesktopOrigin(origin) {
  return Boolean(origin) && DESKTOP_ORIGIN_PATTERNS.some(p => p.test(origin));
}

function isTrustedBrowserOrigin(origin) {
  return Boolean(origin) && BROWSER_ORIGIN_PATTERNS.some(p => p.test(origin));
}

/**
 * Constant-time string comparison that always iterates both strings fully,
 * preventing timing oracles that reveal key validity character-by-character.
 * Edge Runtime has no Node crypto.timingSafeEqual, so we implement it manually.
 */
function safeEqual(a, b) {
  let result = a.length === b.length ? 0 : 1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}

/**
 * Check if the given key matches any entry in the valid-keys list.
 * Always performs at least one comparison so that an empty list is
 * indistinguishable from a single-entry list in timing — prevents a
 * side-channel revealing "no keys configured" vs "wrong key".
 */
function isValidKey(key, validKeys) {
  // Ensure a minimum of one safeEqual call regardless of list length.
  const candidates = validKeys.length > 0 ? validKeys : ['\x00'];
  let matched = false;
  for (const k of candidates) {
    if (safeEqual(k.trim(), key)) matched = true; // no break — always check all
  }
  return matched && validKeys.length > 0;
}

function extractOriginFromReferer(referer) {
  if (!referer) return '';
  try {
    return new URL(referer).origin;
  } catch {
    return '';
  }
}

export function validateApiKey(req) {
  const key = req.headers.get('X-WorldMonitor-Key');
  // Same-origin browser requests don't send Origin (per CORS spec).
  // Fall back to Referer to identify trusted same-origin callers.
  const origin = req.headers.get('Origin') || extractOriginFromReferer(req.headers.get('Referer')) || '';

  // Parse valid keys once for this request.
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);

  // Desktop app — always require API key
  if (isDesktopOrigin(origin)) {
    if (!key) return { valid: false, required: true, error: 'API key required for desktop access' };
    if (!isValidKey(key, validKeys)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true };
  }

  // Trusted browser origin (worldmonitor.app, Vercel previews, localhost dev) — no key needed
  if (isTrustedBrowserOrigin(origin)) {
    if (key && !isValidKey(key, validKeys)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: false };
  }

  // Explicit key provided from unknown origin — validate it
  if (key) {
    if (!isValidKey(key, validKeys)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true };
  }

  // No origin, no key — require API key (blocks unauthenticated curl/scripts)
  return { valid: false, required: true, error: 'API key required' };
}
