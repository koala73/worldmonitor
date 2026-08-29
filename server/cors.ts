/**
 * CORS header generation -- TypeScript port of api/_cors.js.
 *
 * Identical ALLOWED_ORIGIN_PATTERNS and logic, with methods set
 * to 'GET, POST, OPTIONS' (sebuf routes support GET and POST).
 */

const PRODUCTION_PATTERNS: RegExp[] = [
  /^https:\/\/(.*\.)?worldmonitor\.app$/,
  // Vercel preview deployments under the "eliewm" team scope, e.g.
  //   worldmonitor-git-<branch>-eliewm.vercel.app  (git-branch alias)
  //   worldmonitor-<hash>-eliewm.vercel.app        (deployment URL)
  // Tight on purpose: never a bare *.vercel.app (this is a security allowlist).
  /^https:\/\/worldmonitor-[a-z0-9-]+-eliewm\.vercel\.app$/,
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

const DEV_PATTERNS: RegExp[] = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

const ALLOWED_ORIGIN_PATTERNS: RegExp[] =
  process.env.NODE_ENV === 'production'
    ? PRODUCTION_PATTERNS
    : [...PRODUCTION_PATTERNS, ...DEV_PATTERNS];

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
  'Location',
  // See api/_cors.js — the gateway emits this on every billing-verification
  // denial and cross-origin clients could not read it (#5622).
  'X-Billing-Verification',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  // Fail-open limiter degradation marker. Parity with api/_cors.js (#7270):
  // the Limit/Remaining/Reset triplet is not enough for browser JS to read Mode.
  'X-RateLimit-Mode',
  // IETF draft-ietf-httpapi-ratelimit-headers fields — emitted by the
  // per-account API-key limiter; docs/usage-rate-limits.mdx tells browser
  // clients to self-throttle on these, so they must be readable cross-origin
  // (parity with api/_cors.js).
  'RateLimit',
  'RateLimit-Policy',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'X-WorldMonitor-Bbox',
  'X-WorldMonitor-Bbox-Missing',
  'X-WorldMonitor-Bbox-Invalid',
  'X-Military-Bbox',
  // RFC 9745 / RFC 8594 lifecycle signals. Link rel="deprecation" is present
  // on current responses for policy discovery; Deprecation and Sunset appear
  // only when a surface is actually deprecated.
  'Link',
  'Deprecation',
  'Sunset',
].join(', ');

/**
 * Strip trailing DNS dots before allowlist match so
 * `https://tech.worldmonitor.app.` is treated as first-party (#6411).
 * Matching only — ACAO still echoes the raw Origin.
 */
function originForAllowlistMatch(origin: string): string {
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

/**
 * Decode Google Translate's hostname rewrite and require the reconstructed
 * host to be worldmonitor.app / *.worldmonitor.app. Suffix-matching the
 * encoded label would admit evil--worldmonitor-app.translate.goog (#6411).
 * Keep in sync with api/_cors.js and workers/api-cors-preflight.
 */
function isWorldMonitorGoogleTranslateOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/\.+$/, '');
    const suffix = '.translate.goog';
    if (!host.endsWith(suffix)) return false;
    const encoded = host.slice(0, -suffix.length);
    if (!encoded || encoded.includes('.')) return false;
    const decoded = encoded.replace(/--/g, '\0').replace(/-/g, '.').replace(/\0/g, '-');
    return decoded === 'worldmonitor.app' || decoded.endsWith('.worldmonitor.app');
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (isWorldMonitorGoogleTranslateOrigin(origin)) return true;
  const candidate = originForAllowlistMatch(origin);
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(candidate));
}

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = isAllowedOrigin(origin) ? origin : 'https://worldmonitor.app';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Access-Control-Max-Age': '3600',
    'Vary': 'Origin',
  };
}

/**
 * Echo the caller's Origin on an explicit origin_403 so credentials:include
 * fetches can read the status instead of seeing an opaque network failure.
 * Refusal bodies only — keep in sync with api/_cors.js (#6411).
 */
export function getOriginDeniedCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': origin || 'https://worldmonitor.app',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Access-Control-Max-Age': '3600',
    'Vary': 'Origin',
  };
}

export function isDisallowedOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  return !isAllowedOrigin(origin);
}
