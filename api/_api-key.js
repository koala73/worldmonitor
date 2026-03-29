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

function hasTrustedBrowserFetchMetadata(req) {
  const fetchSite = (req.headers.get('Sec-Fetch-Site') || '').toLowerCase();
  const fetchMode = (req.headers.get('Sec-Fetch-Mode') || '').toLowerCase();

  if (!['same-origin', 'same-site'].includes(fetchSite)) return false;
  if (fetchMode && !['cors', 'same-origin', 'navigate', 'no-cors'].includes(fetchMode)) return false;
  return true;
}

function isTrustedBrowserRequest(req, origin) {
  if (!hasTrustedBrowserFetchMetadata(req)) return false;
  // Require an explicit trusted Origin for browser no-key access.
  // Referer can be forged by non-browser clients and is therefore insufficient.
  return isTrustedBrowserOrigin(origin);
}

export function validateApiKey(req) {
  const key = req.headers.get('X-WorldMonitor-Key');
  const origin = req.headers.get('Origin') || '';
  const validKeys = new Set((process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean));

  // Desktop app — always require API key
  if (isDesktopOrigin(origin)) {
    if (!key) return { valid: false, required: true, error: 'API key required for desktop access' };
    if (!validKeys.has(key)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true };
  }

  // Trusted browser requests must look like real browser fetches, not just spoofed headers.
  if (isTrustedBrowserRequest(req, origin)) {
    if (key && !validKeys.has(key)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: false };
  }

  // Explicit key provided from unknown origin — validate it
  if (key) {
    if (!validKeys.has(key)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true };
  }

  // No origin, no key — require API key (blocks unauthenticated curl/scripts)
  return { valid: false, required: true, error: 'API key required' };
}
