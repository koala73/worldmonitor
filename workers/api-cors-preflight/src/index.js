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
  /^https:\/\/worldmonitor-[a-z0-9-]+-elie-[a-z0-9]+\.vercel\.app$/,
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

// Keep in sync with api/_cors.js#getCorsHeaders Access-Control-Allow-Headers.
const ALLOW_HEADERS = 'Content-Type, Authorization, X-WorldMonitor-Key, X-Api-Key, X-Widget-Key, X-Pro-Key, X-WorldMonitor-Desktop-Timestamp, X-WorldMonitor-Desktop-Signature';

export function isAllowedOrigin(origin) {
  return Boolean(origin) && ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(origin));
}

export function buildCorsHeaders(origin) {
  const allowOrigin = isAllowedOrigin(origin) ? origin : 'https://worldmonitor.app';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    // Required because the app fetch interceptor sends credentials: 'include'
    // (HttpOnly session cookies, see src/services/wm-session.ts). Browsers
    // reject credentialed requests if this header is missing OR if
    // Access-Control-Allow-Origin is '*'.
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
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
