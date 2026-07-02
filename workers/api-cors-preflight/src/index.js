// Cloudflare Worker: api-cors-preflight
//
// Bound to: api.worldmonitor.app/*
// Source of truth for CORS on api.worldmonitor.app. Short-circuits OPTIONS
// preflights at the edge (skip Vercel) and stamps the same CORS headers onto
// non-OPTIONS responses on the way back to the browser.
//
// HISTORICAL NOTE: this Worker is the third layer of CORS configuration
// alongside api/_cors.js + vercel.json. Because it lives outside the repo
// in production, a 2026-05-27 outage went unfixed for hours: PR #3923 fixed
// the repo-side CORS correctly, but every credentialed request still failed
// because this Worker's OPTIONS response was missing
// `Access-Control-Allow-Credentials: true`. Moving the source in-repo makes
// the Worker visible to code review, greptile, and CI guardrails.
//
// See: docs/architecture/pro-monetization.md (CORS section)
//      ~/.claude/skills/worldmonitor-architecture-gotchas/reference/
//        cloudflare-worker-overrides-vercel-cors-for-preflight.md

// Keep in sync with api/_cors.js#ALLOWED_ORIGIN_PATTERNS and
// server/cors.ts#PRODUCTION_PATTERNS. The Worker's allowlist must be a
// superset of (or identical to) the function-side allowlist; if it's narrower,
// origins that the function would accept get the canonical fallback origin
// echoed back and fail CORS at the browser.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/(.*\.)?worldmonitor\.app$/,
  // Vercel previews under the "eliewm" team scope, e.g.
  //   worldmonitor-git-<branch>-eliewm.vercel.app / worldmonitor-<hash>-eliewm.vercel.app
  // Mirror of api/_cors.js + server/cors.ts (see superset note above).
  /^https:\/\/worldmonitor-[a-z0-9-]+-eliewm\.vercel\.app$/,
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

// Keep in sync with api/_cors.js#getCorsHeaders Access-Control-Allow-Headers.
const ALLOW_HEADERS = 'Content-Type, Authorization, X-WorldMonitor-Key, X-Api-Key, X-Widget-Key, X-Pro-Key, X-WorldMonitor-Desktop-Timestamp, X-WorldMonitor-Desktop-Signature';

// Keep in sync with api/_cors.js#getCorsHeaders Access-Control-Expose-Headers.
const EXPOSE_HEADERS = 'Mcp-Session-Id, WWW-Authenticate, Retry-After, X-WorldMonitor-Bbox, X-WorldMonitor-Bbox-Missing, X-WorldMonitor-Bbox-Invalid, X-Military-Bbox';

// Superset of every method any api/* route advertises. The Worker stamps ONE
// fixed Allow-Methods on every preflight, so if a route handles DELETE but
// Allow-Methods omits it, the browser rejects the preflight before the
// authenticated DELETE can reach Vercel. Current union across api/*:
//   - api/product-catalog.js handles GET + DELETE (`'GET, DELETE, OPTIONS'`)
//   - most route handlers respond to GET, POST, HEAD, OPTIONS
//   - HEAD is technically a "simple method" so browsers don't require it in
//     Allow-Methods, but listing it costs nothing and avoids a different
//     preflight from a stricter future client.
const ALLOW_METHODS = 'GET, POST, DELETE, HEAD, OPTIONS';

// Paths whose Vercel functions own a DIFFERENT CORS policy than this Worker
// (intentionally wider — e.g. MCP/OAuth endpoints accept https://claude.ai +
// https://claude.com via getPublicCorsHeaders() ACAO: '*' or per-endpoint
// origin validation). The Worker MUST NOT intercept these:
//   - OPTIONS preflights must reach Vercel so the function's own policy
//     applies (otherwise external clients like claude.ai see the canonical
//     worldmonitor.app fallback echo and get blocked by the browser).
//   - Non-OPTIONS responses must pass through unmodified — the Worker's
//     header.set() loop would otherwise overwrite the function's ACAO with
//     the Worker's origin echo (or canonical fallback) and break CORS.
//
// Keep this list in sync with:
//   - api/oauth/register.js, api/oauth/token.ts, api/mcp/handler.ts
//     (use getPublicCorsHeaders() with ACAO: '*' + their own Claude origin
//     validation in the handler body)
//   - api/oauth/authorize.js, api/oauth-protected-resource.ts
//     (hardcoded ACAO: '*')
//   - api/security/report.js (CSP/COOP/COEP reports from any origin)
//   - api/geo.js, api/version.js (public, no credentials)
const PUBLIC_CORS_PATHS = new Set([
  '/api/mcp',
  '/api/oauth-protected-resource',
  '/api/security/report',
  '/api/geo',
  '/api/version',
]);
const PUBLIC_CORS_PREFIXES = [
  '/api/mcp/',
  '/api/oauth/',
];

function hasPublicCorsPolicy(pathname) {
  if (PUBLIC_CORS_PATHS.has(pathname)) return true;
  return PUBLIC_CORS_PREFIXES.some((p) => pathname.startsWith(p));
}

export function isAllowedOrigin(origin) {
  return Boolean(origin) && ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(origin));
}

export { hasPublicCorsPolicy };

export function buildCorsHeaders(origin) {
  const allowOrigin = isAllowedOrigin(origin) ? origin : 'https://worldmonitor.app';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    // Required because the app fetch interceptor sends credentials: 'include'
    // (HttpOnly session cookies, see src/services/wm-session.ts). Browsers
    // reject credentialed requests if this header is missing OR if
    // Access-Control-Allow-Origin is '*'.
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Expose-Headers': EXPOSE_HEADERS,
    'Access-Control-Max-Age': '3600',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return fetch(request);
    }

    // Paths whose Vercel handler owns a wider CORS policy (MCP, OAuth,
    // discovery, security reports, public utilities) must reach Vercel
    // untouched. If the Worker short-circuited the OPTIONS preflight here,
    // external clients like https://claude.ai would see the canonical
    // worldmonitor.app fallback origin echo and the browser would block.
    if (hasPublicCorsPolicy(url.pathname)) {
      return fetch(request);
    }

    const origin = request.headers.get('Origin') || '';
    const corsHeaders = buildCorsHeaders(origin);

    // OPTIONS preflight — return immediately, skip Vercel.
    // The browser's CORS gate is the preflight response, not the actual
    // request response, so this is the load-bearing branch.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // All other methods — pass through to Vercel, then stamp CORS headers
    // onto the response on the way back. The .set() loop intentionally
    // overrides any function-set CORS headers so the Worker is the single
    // source of truth.
    try {
      const response = await fetch(request);
      const newHeaders = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeaders)) {
        newHeaders.set(k, v);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Origin unavailable' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  },
};
