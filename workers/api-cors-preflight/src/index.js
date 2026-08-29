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

import {
  classifyPublicBootstrapRequest,
  classifyPublicBootstrapUrl,
} from '../../../api/_bootstrap-public-tier.js';
import { maybeShadowKvRead } from './kv-shadow.js';
import { maybeServeBootstrapFromKv } from './kv-serve.js';

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
const ALLOW_HEADERS = 'Content-Type, Authorization, X-WorldMonitor-Key, X-Api-Key, X-Widget-Key, X-Pro-Key, X-WorldMonitor-Desktop-Timestamp, X-WorldMonitor-Desktop-Signature, Idempotency-Key, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID';

// Keep in sync with api/_cors.js#getCorsHeaders Access-Control-Expose-Headers.
const EXPOSE_HEADERS = 'Mcp-Session-Id, WWW-Authenticate, Retry-After, Idempotency-Key, Idempotent-Replayed, X-Billing-Verification, RateLimit, RateLimit-Policy, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Mode, X-WorldMonitor-Bbox, X-WorldMonitor-Bbox-Missing, X-WorldMonitor-Bbox-Invalid, X-Military-Bbox, Link, Deprecation, Sunset';

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

// Absolute URL: this Worker serves api.worldmonitor.app, where a
// root-relative /api-versioning.md would 404. Keep in sync with
// server/_shared/deprecation-policy.ts.
const DEPRECATION_POLICY_LINK =
  '<https://www.worldmonitor.app/api-versioning.md>; rel="deprecation"; type="text/markdown"';
const DEPRECATION_REL = /(?:^|,)\s*<[^>]+>\s*;[^,]*\brel="deprecation"/;

function appendDeprecationPolicyLink(headers) {
  if (headers instanceof Headers) {
    const existing = headers.get('Link');
    if (existing && DEPRECATION_REL.test(existing)) return;
    headers.set('Link', existing ? `${existing}, ${DEPRECATION_POLICY_LINK}` : DEPRECATION_POLICY_LINK);
    return;
  }
  const existing = headers.Link;
  if (existing && DEPRECATION_REL.test(existing)) return;
  headers.Link = existing ? `${existing}, ${DEPRECATION_POLICY_LINK}` : DEPRECATION_POLICY_LINK;
}

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
//   - api/fwdstart.js, api/gpsjam.js, api/reverse-geocode.js,
//     api/product-catalog.js (cacheable public GET responses use ACAO: '*';
//     product-catalog also owns the CORS policy for its credentialed DELETE)
//
// Do not let the Worker replace these endpoints' response headers with its
// credentialed, Origin-varying policy. That would make a cached public
// response origin-specific again and overwrite the endpoint's ACAO: '*'.
const PUBLIC_CORS_PATHS = new Set([
  '/api/mcp',
  '/api/oauth-protected-resource',
  '/api/security/report',
  '/api/geo',
  '/api/version',
  '/api/fwdstart',
  '/api/gpsjam',
  '/api/reverse-geocode',
  '/api/product-catalog',
]);
const PUBLIC_CORS_PREFIXES = [
  '/api/mcp/',
  '/api/oauth/',
];

function hasPublicCorsPolicy(pathname) {
  if (PUBLIC_CORS_PATHS.has(pathname)) return true;
  return PUBLIC_CORS_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Strip trailing DNS dots before allowlist match (#6411). Keep in sync with
 * api/_cors.js / server/cors.ts. ACAO still echoes the raw Origin.
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

/**
 * Decode Google Translate hostname rewrite; require reconstructed host to be
 * worldmonitor.app / *.worldmonitor.app. Keep in sync with api/_cors.js (#6411).
 */
function isWorldMonitorGoogleTranslateOrigin(origin) {
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

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (isWorldMonitorGoogleTranslateOrigin(origin)) return true;
  const candidate = originForAllowlistMatch(origin);
  return ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(candidate));
}

export { hasPublicCorsPolicy };

function corsHeaderBag(allowOrigin) {
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

export function buildCorsHeaders(origin) {
  const allowOrigin = isAllowedOrigin(origin) ? origin : 'https://worldmonitor.app';
  return corsHeaderBag(allowOrigin);
}

/**
 * The response shape `api/bootstrap.js` uses for a `&public=1` URL
 * (`getPublicBootstrapHeaders()` -> `getPublicCorsHeaders()` + TAO): ACAO `*`,
 * no `Access-Control-Allow-Credentials`, no `Vary: Origin`.
 *
 * The payload behind those URLs is the shared seed bundle — one answer for
 * every caller — so keying it by Origin buys nothing and costs a cache entry
 * per origin, while `Allow-Credentials: true` advertises credentialed access on
 * a response no credential can change. The origin honours that distinction for
 * public auth kinds; before #7308 the edge did not, and stamped its
 * credentialed bag over both the KV-served bytes and the origin pass-through.
 *
 * Allow-Methods / Allow-Headers / Expose-Headers stay the Worker's own
 * supersets (the origin publishes `GET, OPTIONS` and a narrower expose list);
 * a superset is what this Worker's allowlist contract already promises
 * everywhere else, and none of the three is part of the caching or credential
 * question this shape answers.
 *
 * Reimplemented rather than imported from `api/_cors.js#getPublicCorsHeaders`,
 * even though this file imports `api/_bootstrap-public-tier.js` two lines up:
 * that module was kept dependency-free precisely so both sides could share it,
 * while `api/_cors.js` reads `process.env.NODE_ENV` at module scope, and this
 * Worker declares no `nodejs_compat` flag — importing it would throw at cold
 * start for every request on api.worldmonitor.app.
 */
function buildPublicBootstrapCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Expose-Headers': EXPOSE_HEADERS,
    'Access-Control-Max-Age': '3600',
  };
}

// A disallowed Origin is excluded from the public shape on purpose — both by the
// preflight predicate below and by publicBootstrapShape in fetch(). api/bootstrap.js
// refuses those with 403 (isDisallowedOrigin), so answering one with ACAO `*` would
// make the seed bundle browser-readable to a page the origin turns away. Those
// requests keep the credentialed bag, whose canonical-fallback ACAO is what actually
// denies the read: the origin's 403 cannot be relied on for it, because the public
// tier ships `CDN-Cache-Control: public, s-maxage=600` and a warm CDN entry answers
// before isDisallowedOrigin ever runs.
//
// This is policy consistency with the origin, not an access-control boundary — the
// payload is public, and any caller CORS refuses reads the same bytes server-side or
// by omitting the Origin header. That is precisely why it must not cost anything to
// enforce; see the KV routing note in fetch().

/**
 * Whether this OPTIONS request is the preflight for a public-tier bootstrap GET.
 *
 * The preflight leg has to agree with the response leg or the contract is split
 * in half: advertising `Allow-Credentials: true` while clearing a request whose
 * answer is ACAO `*` with no credentials is the same mismatch #7308 fixed one
 * layer down, and it is the combination browsers reject when a caller does send
 * credentials. The preflight's own method is OPTIONS, so the GET-gated request
 * predicate cannot answer this — the URL shape plus `Access-Control-Request-Method`
 * can. Anything other than a declared GET keeps the credentialed bag, as does a
 * disallowed Origin, whose echo is load-bearing for observing origin_403 (#6411).
 */
function preflightsPublicBootstrapShape(request, url, origin) {
  if (classifyPublicBootstrapUrl(url) === null) return false;
  if ((request.headers.get('Access-Control-Request-Method') || '').toUpperCase() !== 'GET') return false;
  return !origin || isAllowedOrigin(origin);
}

/**
 * OPTIONS preflight for disallowed origins must echo the request Origin so the
 * browser will send the actual request. Otherwise origin_403 stays an opaque
 * network error (#6411). Success responses still use the allowlist via
 * buildCorsHeaders / buildResponseCorsHeaders.
 */
export function buildPreflightCorsHeaders(origin) {
  return corsHeaderBag(origin || 'https://worldmonitor.app');
}

/**
 * Stamp CORS onto an origin response. Allowed origins are echoed; disallowed
 * origins get a readable ACAO only on explicit auth/origin refusals so the
 * client can observe 401/403, while successful bodies stay opaque.
 */
export function buildResponseCorsHeaders(origin, status) {
  if (isAllowedOrigin(origin)) return buildCorsHeaders(origin);
  if (status === 401 || status === 403) return buildPreflightCorsHeaders(origin);
  return buildCorsHeaders(origin);
}

function mergeHeaderNames(...values) {
  const seen = new Set();
  const merged = [];
  for (const value of values) {
    for (const name of (value || '').split(',')) {
      const trimmed = name.trim();
      const normalized = trimmed.toLowerCase();
      if (!trimmed || seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(trimmed);
    }
  }
  return merged.join(', ');
}

// /api/story intentionally varies cacheable crawler HTML from browser redirects
// by User-Agent. Cloudflare evaluates origin Vary headers while resolving this
// subrequest, before the Worker can merge response headers below, so declare the
// expected variant here. Unknown future Vary headers bypass cache by default;
// the intentional User-Agent variant uses the raw value as its cache key.
const STORY_FETCH_OPTIONS = {
  cf: {
    vary: {
      default: { action: 'bypass' },
      headers: {
        'user-agent': { action: 'passthrough' },
      },
    },
  },
};

// The single origin path: fetch Vercel, stamp the Worker's canonical CORS onto the response, and
// preserve the bootstrap route's function-owned exposed headers. Shared by the normal pass-through
// AND the U-K4 hedge, so there is exactly one origin+CORS implementation to keep correct.
async function passThroughToOrigin(request, url, corsHeadersForStatus) {
  try {
    const response = url.pathname === '/api/story'
      ? await fetch(request, STORY_FETCH_OPTIONS)
      : await fetch(request);
    const corsHeaders = typeof corsHeadersForStatus === 'function'
      ? corsHeadersForStatus(response.status)
      : corsHeadersForStatus;
    const newHeaders = new Headers(response.headers);
    const originExposedHeaders = newHeaders.get('Access-Control-Expose-Headers');
    const originVary = newHeaders.get('Vary');
    for (const [k, v] of Object.entries(corsHeaders)) {
      newHeaders.set(k, v);
    }
    // A shape that omits Allow-Credentials must actively clear one the origin
    // supplied: setting ACAO `*` while leaving `Allow-Credentials: true` behind
    // is the combination browsers reject outright.
    if (!('Access-Control-Allow-Credentials' in corsHeaders)) {
      newHeaders.delete('Access-Control-Allow-Credentials');
    }
    // The public bootstrap shape contributes no Vary at all. Merging two empty
    // inputs yields '', and `set('Vary', '')` is a present-but-empty header
    // rather than an absent one — enough to fail a contract check that reads
    // "no Vary" as `null`, and a needless header on every such response.
    const mergedVary = mergeHeaderNames(originVary, corsHeaders.Vary);
    if (mergedVary) newHeaders.set('Vary', mergedVary);
    else newHeaders.delete('Vary');
    // Bootstrap temporarily exposes U3a timing and cache-classifier headers.
    // Preserve only that route's function-owned additions while retaining
    // the Worker's canonical baseline. Replacing this header outright made
    // those diagnostics invisible to browser JavaScript in production.
    if (url.pathname === '/api/bootstrap' && originExposedHeaders) {
      newHeaders.set(
        'Access-Control-Expose-Headers',
        mergeHeaderNames(EXPOSE_HEADERS, originExposedHeaders),
      );
    }
    appendDeprecationPolicyLink(newHeaders);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (err) {
    const corsHeaders = typeof corsHeadersForStatus === 'function'
      ? corsHeadersForStatus(502)
      : corsHeadersForStatus;
    const errorHeaders = { 'Content-Type': 'application/json', ...corsHeaders };
    appendDeprecationPolicyLink(errorHeaders);
    return new Response(JSON.stringify({ error: 'Origin unavailable' }), {
      status: 502,
      headers: errorHeaders,
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // KV shadow measurement (U-K2, #5338). Self-gating: no-op unless BOOTSTRAP_KV_SHADOW==='1'
    // and this is a public-tier bootstrap GET. Runs in ctx.waitUntil — never touches the
    // response or the CORS logic below. Kept entirely in kv-shadow.js so CORS stays untouched.
    maybeShadowKvRead(request, url, env, ctx);

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
    // OPTIONS must echo the request Origin even when disallowed so the browser
    // will send the actual request; otherwise origin_403 is an opaque network
    // error (#6411). Non-OPTIONS responses still use the allowlist, with a
    // readable echo only on 401/403 refusals.
    if (request.method === 'OPTIONS') {
      const headers = preflightsPublicBootstrapShape(request, url, origin)
        ? buildPublicBootstrapCorsHeaders()
        : buildPreflightCorsHeaders(origin);
      appendDeprecationPolicyLink(headers);
      return new Response(null, { status: 204, headers });
    }

    // Scoped to CORS on purpose. The browser CACHE directive still differs by path (KV `no-store`,
    // origin `TIER_CACHE[tier]`) and that is deliberate, for reasons that belong to the KV path
    // rather than this one — see kv-serve.js#serveFromKv. Do not read this as a caching invariant.
    const publicBootstrap = classifyPublicBootstrapRequest(request, url);
    const publicBootstrapShape = publicBootstrap !== null && (!origin || isAllowedOrigin(origin));
    const publicTier = publicBootstrap?.authKind === 'public-tier' ? publicBootstrap.tier : null;
    const corsPolicy = publicBootstrapShape
      ? buildPublicBootstrapCorsHeaders()
      : (status) => buildResponseCorsHeaders(origin, status);
    // KV always mints a 200, and serveFromKv spreads what it is handed — resolve the union here so
    // the bag it receives is a bag, never a status function whose spread would yield no CORS at all.
    const kvCorsHeaders = publicBootstrapShape ? corsPolicy : buildCorsHeaders(origin);
    // serveFromKv spreads this bag and never enters passThroughToOrigin, so the
    // policy Link has to live on the bag itself. Production is
    // BOOTSTRAP_KV_SERVE="all".
    appendDeprecationPolicyLink(kvCorsHeaders);
    // The single origin path for this request. maybeServeBootstrapFromKv (U-K4) may invoke it once
    // internally when it hedges/falls back; every other request runs it directly below. Either way
    // origin is fetched at most once.
    const fetchOrigin = () => passThroughToOrigin(request, url, corsPolicy);

    // KV serving (U-K4, #5338 / #7291): for a public-tier bootstrap GET with BOOTSTRAP_KV_SERVE
    // on, serve the tier straight from KV (never touching Vercel/Redis). A slow KV read is hedged
    // against origin and any non-servable outcome uses the origin response — strictly additive
    // (KTD3), so the worst case is origin pass-through. Returns null for non-servable requests
    // (flag off, not a bootstrap GET), which then run the normal pass-through. Production is
    // BOOTSTRAP_KV_SERVE="all"; "slow" and "off" remain kill-switches.
    //
    // Gated on the tier predicate ALONE, deliberately — not on publicBootstrapShape. Which CORS bag
    // a disallowed Origin gets is a header decision; whether its bytes come from KV is a routing
    // one, and the two must not be fused. The KV bytes are caller-invariant, so serving them under
    // the credentialed fallback bag denies the browser read just as effectively while keeping the
    // request off Vercel/Redis. Gating the route instead would hand any unauthenticated caller an
    // origin-forcing lever: one bogus `Origin:` header on every request re-opens exactly the Redis
    // egress this path exists to eliminate, and buys nothing — the same caller reads the same bytes
    // from KV by simply omitting the header.
    const bootstrapKv = publicTier !== null
      ? await maybeServeBootstrapFromKv(request, url, env, ctx, kvCorsHeaders, fetchOrigin)
      : null;
    if (bootstrapKv) return bootstrapKv;

    // All other methods/paths — pass through to Vercel with the Worker's canonical CORS stamped.
    return fetchOrigin();
  },
};
