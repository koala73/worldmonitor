const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/(.*\.)?worldmonitor\.app$/,
  // Vercel preview deployments under the "eliewm" team scope, e.g.
  //   worldmonitor-git-<branch>-eliewm.vercel.app  (git-branch alias)
  //   worldmonitor-<hash>-eliewm.vercel.app        (deployment URL)
  // Tight on purpose: never a bare *.vercel.app (this is a security allowlist).
  /^https:\/\/worldmonitor-[a-z0-9-]+-eliewm\.vercel\.app$/,
  // Google Translate proxy hosts our dashboard at
  //   https://www-worldmonitor-app.translate.goog
  // (dots in the real hostname become hyphens). Readers there cannot mint a
  // session today because the origin matches none of the first-party patterns,
  // so every credentialed API call fails (#6411).
  //
  // Policy: admit these origins for anonymous dashboard reads. SameSite=Lax
  // session cookies are not sent on cross-site fetches from translate.goog, so
  // existing first-party auth cookies do not ride along; the client falls back
  // to the freely-mintable anonymous wms_ header token. Do NOT widen this to
  // bare *.translate.goog — only WorldMonitor's rewritten hostnames.
  /^https:\/\/(?:[a-z0-9-]+-)*worldmonitor-app\.translate\.goog$/,
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
  // Only allow bare localhost/127.0.0.1 in non-production (matches server/cors.ts)
  ...(process.env.NODE_ENV === 'production' ? [] : [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  ]),
];

const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-WorldMonitor-Key',
  'X-Api-Key',
  'X-Widget-Key',
  'X-Pro-Key',
  'X-WorldMonitor-Desktop-Timestamp',
  'X-WorldMonitor-Desktop-Signature',
  'Idempotency-Key',
  'Mcp-Session-Id',
  'MCP-Protocol-Version',
  'Last-Event-ID',
].join(', ');

const EXPOSED_HEADERS = [
  'Mcp-Session-Id',
  'WWW-Authenticate',
  'Retry-After',
  'Idempotency-Key',
  'Idempotent-Replayed',
  // Billing-verification denials (server/_shared/entitlement-check.ts) carry
  // the reason here alongside `Retry-After`. Docs advertise the header
  // (docs/usage-errors.mdx) but it was not exposed, so a cross-origin browser
  // client — the Tauri desktop shell, widget embeds, anything on
  // api.worldmonitor.app — could not read it and had to parse `code` from the
  // body to tell a retryable verification blip from a terminal lapse (#5622).
  'X-Billing-Verification',
  // IETF RateLimit fields (draft-ietf-httpapi-ratelimit-headers): RateLimit-Policy
  // + RateLimit-Limit are advertised on every API response (vercel.json); the
  // combined RateLimit member and RateLimit-Remaining/Reset appear on a 429.
  // Exposed so browser-context agents can read them cross-origin and self-throttle.
  'RateLimit',
  'RateLimit-Policy',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  // Legacy X-RateLimit-* retained for back-compat with existing consumers.
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'X-WorldMonitor-Bbox',
  'X-WorldMonitor-Bbox-Missing',
  'X-WorldMonitor-Bbox-Invalid',
  'X-Military-Bbox',
].join(', ');

/**
 * Browsers occasionally emit the FQDN form of a hostname (trailing DNS dot),
 * e.g. `https://tech.worldmonitor.app.`. Allowlist patterns are anchored at `$`,
 * so that form would otherwise be refused even though it is first-party (#6411).
 * Normalize only for matching; callers still echo the raw Origin into ACAO
 * because browsers compare ACAO to the request Origin byte-for-byte.
 */
function originForAllowlistMatch(origin) {
  if (!origin) return '';
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/\.+$/, '');
    if (!host || host === url.hostname) return origin;
    url.hostname = host;
    return url.origin;
  } catch {
    return origin;
  }
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  const candidate = originForAllowlistMatch(origin);
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(candidate));
}

export function getCorsHeaders(req, methods = 'GET, OPTIONS') {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = isAllowedOrigin(origin) ? origin : 'https://worldmonitor.app';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Access-Control-Max-Age': '3600',
    'Vary': 'Origin',
  };
}

/**
 * CORS headers for an explicit origin refusal.
 *
 * `getCorsHeaders` falls back to `https://worldmonitor.app` for disallowed
 * origins, which makes a 403 opaque to the calling browser (same class of blind
 * spot as WORLDMONITOR-WG: the client cannot tell "refused" from "never
 * arrived"). Echo the request Origin with credentials so a credentials:include
 * fetch can read the status. Safe only for refusal bodies — never use this for
 * successful authenticated responses (#6411).
 */
export function getOriginDeniedCorsHeaders(req, methods = 'GET, OPTIONS') {
  const origin = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': origin || 'https://worldmonitor.app',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Access-Control-Max-Age': '3600',
    'Vary': 'Origin',
  };
}

/**
 * CORS headers for public cacheable responses (seeded data, no per-user variation).
 * Uses ACAO: * so Vercel edge stores ONE cache entry per URL instead of one per
 * unique Origin. Eliminates Vary: Origin cache fragmentation that multiplies
 * origin hits by the number of distinct client origins.
 *
 * Safe to use when isDisallowedOrigin() has already blocked unauthorized origins.
 */
export function getPublicCorsHeaders(methods = 'GET, OPTIONS') {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Access-Control-Max-Age': '3600',
  };
}

export function isDisallowedOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  return !isAllowedOrigin(origin);
}
