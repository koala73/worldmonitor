import { acceptQuality, isKnownPublicPagePath, originNotFoundResponse } from './src/config/agent-not-found';
import {
  DOCS_PUBLIC_ORIGIN,
  DOCS_UPSTREAM_ORIGIN,
  DOCS_UPSTREAM_TIMEOUT_MS,
  isDocsFullDocumentRequest,
  isDocsHtmlDocumentPath,
  rewriteDocsLocaleHtml,
  shouldTransformDocsUpstreamHtml,
} from './src/config/docs-locale-seo';
import { getRootlessDocsDestination } from './src/config/docs-root-redirects';
import agentRequestPolicy from './shared/agent-request-policy.json';
import { isMcpAliasRequest, normalizeMcpHost } from './shared/mcp-host-policy';
import { chokepointStatusViewModel } from './scripts/crawlable-live-tools.mjs';
import {
  chokepointPulseRecord,
  renderChokepointLiveSection,
  replaceChokepointLiveSection,
} from './scripts/crawlable-chokepoint-live.mjs';
import { liveTopicPageForPath, liveTopicReading } from './scripts/live-pages/index.mjs';
import { replaceLiveSection } from './scripts/live-pages/common.mjs';
import {
  CSP_NONCE_PLACEHOLDER,
  STAMPED_DOCUMENT_CACHE_CONTROL,
  STAMPED_DOCUMENT_CDN_CACHE_CONTROL,
  stampCspDocument,
} from './shared/csp-nonce.mjs';
import vercelConfig from './vercel.json';

type LiveTopicPage = NonNullable<ReturnType<typeof liveTopicPageForPath>>;

const DASHBOARD_CSP_SOURCE = '/((?!docs|embed|embed\\.html|wm-widget-sandbox\\.html).*)';
const DOCUMENT_STAMP_TIMEOUT_MS = 4_000;
// Inner fetches of a document (the nonce stamp and the live pages) carry this
// query marker so they skip both the live branch and stamping. A URL rather than
// a header keeps the raw document under its own cache key: Cloudflare caches
// query-free www documents by URL and never sees a request header in the key,
// and its corpus rule excludes query-bearing URLs. A client that sends it
// receives the built page with the placeholder still in place, which the static
// CSP does not allow.
const BUILT_PAGE_PARAM = 'wm-built';
// Fixed request headers for the stamp's inner fetch. Forwarding the client's
// would carry If-None-Match / Range, and a 304 or 206 is not a document to stamp.
const DOCUMENT_STAMP_USER_AGENT = 'Mozilla/5.0 (compatible; WorldMonitorDocumentStamp/1.0)';

type VercelRewrite = { source: string; destination: string };

// Page-shaped paths that vercel.json rewrites to a function or another origin.
// Stamping re-fetches the document, which would run that handler twice: a
// one-shot GET such as /oauth/authorize-pro would spend its grant on the inner
// fetch and answer the real request "Authorization Expired".
const NON_DOCUMENT_REWRITES = (vercelConfig.rewrites as VercelRewrite[])
  .filter(({ destination }) => destination.startsWith('/api/') || /^https?:\/\//.test(destination))
  .map(({ source }) => {
    const cut = source.search(/[:(]/);
    return cut === -1 ? { exact: source } : { prefix: source.slice(0, cut) };
  })
  // `/:mdPath(...).md` has no literal prefix. Its paths end in `.md`, which
  // shouldStampDocument already refuses.
  .filter((rule) => rule.exact !== undefined || rule.prefix !== '/');

// SPA routes whose last segment may contain a dot (`/stocks/GLEN.L`). The
// generic matcher skips dotted segments as static files, so each prefix is also
// listed in config.matcher.
const DOTTED_DOCUMENT_PREFIXES = (vercelConfig.rewrites as VercelRewrite[])
  .filter(({ source, destination }) => source.includes(':') && destination.endsWith('.html'))
  .map(({ source }) => source.slice(0, source.indexOf(':')));

function isNonDocumentRewrite(path: string): boolean {
  return NON_DOCUMENT_REWRITES.some((rule) =>
    rule.exact !== undefined ? path === rule.exact : path.startsWith(rule.prefix));
}

function usesDashboardContentSecurityPolicy(pathname: string): boolean {
  const rest = pathname.replace(/^\/+/, '');
  return !/^(?:docs|embed|embed\.html|wm-widget-sandbox\.html)/.test(rest);
}

function dashboardContentSecurityPolicy(): string {
  const headers = vercelConfig.headers as Array<{
    source: string;
    headers?: Array<{ key: string; value: string }>;
  }>;
  const policy = headers
    .find((entry) => entry.source === DASHBOARD_CSP_SOURCE)
    ?.headers?.find((header) => header.key === 'Content-Security-Policy')?.value;
  if (!policy) throw new Error('dashboard Content-Security-Policy missing from vercel.json');
  return policy;
}

// Requests Cloudflare's document cache rule never stores or answers from cache
// (NEGOTIATED_MEDIA_TYPES and RSC_REQUEST_HEADERS in
// scripts/cloudflare-cache-rule.mjs; tests/csp-nonce.test.mts keeps the two in
// step). They ask for a non-HTML representation, so passing one through cannot
// seed the shared cache with an unstamped document.
const UNCACHED_NEGOTIATED_MEDIA_TYPES = ['text/markdown', 'text/plain', 'text/x-component'];
const UNCACHED_NEGOTIATION_HEADERS = ['rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-router-segment-prefetch'];

function negotiatesUncachedRepresentation(request: Request): boolean {
  if (UNCACHED_NEGOTIATION_HEADERS.some((name) => request.headers.has(name))) return true;
  const accept = (request.headers.get('accept') ?? '').toLowerCase();
  return UNCACHED_NEGOTIATED_MEDIA_TYPES.some((type) => accept.includes(type));
}

// Any other GET is stamped, with or without Accept: text/html. A placeholder
// document passed through carries vercel.json's shared-cache headers, and
// Cloudflare would store it for every visitor (a missing Accept, */* or
// application/json all pass its guard). The inner fetch forwards Accept, so a
// negotiated non-HTML answer is still passed through.
function shouldStampDocument(request: Request, url: URL): boolean {
  if (request.method !== 'GET') return false;
  if (negotiatesUncachedRepresentation(request)) return false;
  if (url.searchParams.has(BUILT_PAGE_PARAM)) return false;
  const path = url.pathname;
  if (path === '/api' || path.startsWith('/api/')) return false;
  if (!usesDashboardContentSecurityPolicy(path)) return false;
  if (path === '/mcp' || path.startsWith('/mcp/')) return false;
  if (isNonDocumentRewrite(path)) return false;
  const last = path.split('/').pop() ?? '';
  if (last.includes('.') && !last.endsWith('.html')
    && !DOTTED_DOCUMENT_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  return true;
}

function builtDocumentUrl(url: URL): URL {
  const built = new URL(url);
  built.searchParams.set(BUILT_PAGE_PARAM, '1');
  return built;
}

// The document could not be fetched. Passing through would serve the
// placeholder page, which runs no script and which the CDN may store under the
// public URL; a 503 is never stored and the refresh retries it.
function documentUnavailableResponse(): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>World Monitor</title><p>World Monitor is reloading. This page retries in a few seconds.</p>',
    {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Retry-After': '5',
        'Cache-Control': STAMPED_DOCUMENT_CACHE_CONTROL,
        'CDN-Cache-Control': STAMPED_DOCUMENT_CDN_CACHE_CONTROL,
        'Vercel-CDN-Cache-Control': STAMPED_DOCUMENT_CDN_CACHE_CONTROL,
      },
    },
  );
}

function deliverHtmlDocument(body: string, headers: Headers, status = 200): Response {
  const stamped = stampCspDocument(body, dashboardContentSecurityPolicy());
  if (!stamped) return new Response(body, { status, headers });
  const next = new Headers(headers);
  for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'etag', 'last-modified']) {
    next.delete(name);
  }
  next.set('content-security-policy', stamped.policy);
  next.set('cache-control', STAMPED_DOCUMENT_CACHE_CONTROL);
  next.set('cdn-cache-control', STAMPED_DOCUMENT_CDN_CACHE_CONTROL);
  next.set('vercel-cdn-cache-control', STAMPED_DOCUMENT_CDN_CACHE_CONTROL);
  return new Response(stamped.html, { status, headers: next });
}

function stampOriginDocument(request: Request, url: URL): Promise<Response | undefined> {
  return fetch(builtDocumentUrl(url), {
    method: 'GET',
    headers: {
      accept: request.headers.get('accept') || 'text/html',
      'user-agent': DOCUMENT_STAMP_USER_AGENT,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(DOCUMENT_STAMP_TIMEOUT_MS),
  }).then(async (upstream) => {
    if (upstream.status !== 200) return undefined;
    const contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return undefined;
    const html = await upstream.text();
    if (!html.includes(CSP_NONCE_PLACEHOLDER)) return undefined;
    return deliverHtmlDocument(html, upstream.headers);
  }).catch(() => documentUnavailableResponse());
}

const AGENT_UA = new RegExp(`(?:^|[^a-z0-9-])(?:${agentRequestPolicy.userAgents.join('|')})(?:$|[^a-z0-9-])`, 'i');

const BOT_UA =
  /bot|crawl|spider|slurp|archiver|wget|curl\/|python-requests|scrapy|httpclient|go-http|java\/|libwww|perl|ruby|php\/|ahrefsbot|semrushbot|mj12bot|dotbot|baiduspider|yandexbot|sogou|bytespider|petalbot|gptbot|claudebot|ccbot/i;

const SOCIAL_PREVIEW_UA =
  /twitterbot|facebookexternalhit|linkedinbot|slackbot|telegrambot|whatsapp|discordbot|redditbot/i;

const SOCIAL_PREVIEW_PATHS = new Set(['/api/story', '/api/og-story']);
const LEGACY_DASHBOARD_ROOT_QUERY_KEYS = ['lat', 'lon', 'zoom', 'view', 'timeRange', 'layers', 'c', 'country', 'chokepoint'] as const;
const UNBOUNDED_DASHBOARD_ROOT_QUERY_KEYS = ['lat', 'lon', 'zoom'] as const;

// Paths that bypass bot/script UA filtering below. Each must carry its own
// auth (API key, shared secret, or intentionally-public semantics) because
// this list disables the middleware's generic bot gate.
// - /api/version, /api/health: intentionally public, monitoring-friendly.
// - /api/seed-contract-probe: requires RELAY_SHARED_SECRET header; called by
//   UptimeRobot + ops curl. Was blocked by the curl/bot UA regex before this
//   exception landed (Vercel log 2026-04-15: "Middleware 403 Forbidden" on
//   /api/seed-contract-probe).
// - /api/internal/brief-why-matters: requires RELAY_SHARED_SECRET Bearer
//   (subtle-crypto HMAC timing-safe compare in server/_shared/internal-auth.ts).
//   Called from the Railway digest-notifications cron whose fetch() uses the
//   Node undici default UA, which is short enough to trip the "no UA or
//   suspiciously short" 403 below (Railway log 2026-04-21 post-#3248 merge:
//   every cron call returned 403 and silently fell back to legacy Gemini).
// - /api/llms.txt: static, intentionally-public agent-discovery document
//   (the section-level llms.txt for the developer/API surface, served from
//   public/api/llms.txt). It MUST bypass the bot gate — AI crawlers (ClaudeBot,
//   GPTBot, PerplexityBot, CCBot, …) are the entire audience for an llms.txt,
//   yet every one of those UAs matches BOT_UA and would otherwise 403.
// - /api/product-catalog: public read-only pricing catalog (Redis-cached,
//   keyless, advertised as service-meta in /.well-known/api-catalog). Agents
//   evaluating the product are a primary audience; an agent-journey run (#4854)
//   got 403 here and concluded the endpoint didn't exist.
// - /api/download.md: curated static markdown twin of GET /api/download.
//   Kept on the exact allowlist so a future glob refactor cannot drop the
//   sampled URL. All other GET/HEAD /api/**/*.md twins bypass via
//   isPublicApiMarkdownTwin() below — the protocol is site-wide .md twins,
//   not one sampled path.
const PUBLIC_API_PATHS = new Set([
  '/api/version',
  '/api/health',
  '/api/seed-contract-probe',
  '/api/internal/brief-why-matters',
  '/api/llms.txt',
  '/api/product-catalog',
  '/api/download.md',
]);

function isPublicApiMarkdownTwin(pathname: string, method: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (!pathname.startsWith('/api/') || !pathname.endsWith('.md')) return false;
  if (pathname.includes('..') || pathname.includes('//')) return false;
  return pathname.length > '/api/.md'.length;
}

const SOCIAL_IMAGE_UA =
  /Slack-ImgProxy|Slackbot|twitterbot|facebookexternalhit|linkedinbot|telegrambot|whatsapp|discordbot|redditbot/i;

// Must match the exact route shape enforced by
// api/brief/carousel/[userId]/[issueDate]/[page].ts:
//   /api/brief/carousel/<userId>/YYYY-MM-DD-HHMM/<0|1|2>
// The issueDate segment is a per-run slot (date + HHMM in the user's
// tz) so same-day digests produce distinct carousel URLs.
// pageFromIndex() in brief-carousel-render.ts accepts only 0/1/2, so
// the trailing segment is tightly bounded.
const BRIEF_CAROUSEL_PATH_RE =
  /^\/api\/brief\/carousel\/[^/]+\/\d{4}-\d{2}-\d{2}-\d{4}\/[0-2]\/?$/;

const VARIANT_HOST_MAP: Record<string, string> = {
  'tech.worldmonitor.app': 'tech',
  'finance.worldmonitor.app': 'finance',
  'commodity.worldmonitor.app': 'commodity',
  'happy.worldmonitor.app': 'happy',
  'energy.worldmonitor.app': 'energy',
};

function hasLegacyDashboardRootState(searchParams: URLSearchParams): boolean {
  return LEGACY_DASHBOARD_ROOT_QUERY_KEYS.some((key) => searchParams.has(key));
}

function hasUnboundedDashboardRootState(searchParams: URLSearchParams): boolean {
  return UNBOUNDED_DASHBOARD_ROOT_QUERY_KEYS.some((key) => searchParams.has(key));
}

/** Query keys that create duplicate index entries without changing document identity. */
const INDEX_NOISE_QUERY_KEYS = new Set([
  'ref',
  'wm_referral',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
]);

/**
 * The one URL a crawler should be spending its budget on for this request, or
 * null when it already asked for it.
 *
 * Two collapses, applied together so a URL carrying both costs one hop:
 *
 *  - Index-noise query keys (`ref`, `wm_referral`, `utm_*`) are dropped. They
 *    change nothing about document identity (#7380).
 *  - A legacy root deep link (`/?lat=…&zoom=…&layers=…`) becomes the
 *    param-free `/dashboard`. That query is map state, and any lat/lon/zoom/
 *    layer combination is a distinct URL, so forwarding it into the redirect
 *    published an unbounded redirect space: Search Console's "Page with
 *    redirect" bucket grew 199 -> 1,271 in three months, 301 of the exported
 *    URLs being map states (#7660). `/dashboard` is already the rel=canonical
 *    for every one of them, so a crawler loses nothing by going straight there.
 *    Note this collapse reaches www only: Vercel applies vercel.json
 *    `redirects` before middleware, and the variant hosts have their own
 *    `/` -> `/dashboard` host redirect, so on those hosts robots.variant.txt
 *    is what keeps a crawler off the space (probed against production).
 * Bounded root entity links also move to `/dashboard`, retaining their state
 * in the same hop as attribution cleanup.
 *
 * Humans are deliberately excluded from the second collapse — the params are
 * what makes a shared or bookmarked legacy link open the view it encodes, and
 * they still reach `/dashboard` with the state intact below. That split is why
 * the redirect built from this must carry `Vary: User-Agent` and no-store.
 *
 * The caller gates this on BOT_UA, which is broader than "search crawler" — it
 * also matches generic HTTP clients (curl, python-requests, wget). Accepted:
 * map state only renders in a JS-executing browser, so a script fetching
 * `/?lat=…` receives the same SPA shell either way, and the user-triggered
 * assistant agents (ChatGPT-User, Claude-User, Perplexity-User) do not match
 * BOT_UA at all — they take the human branch and keep the state.
 */
function crawlerCanonicalUrl(url: URL): URL | null {
  let changed = false;
  const next = new URL(url);
  for (const key of [...next.searchParams.keys()]) {
    if (INDEX_NOISE_QUERY_KEYS.has(key) || key.toLowerCase().startsWith('utm_')) {
      next.searchParams.delete(key);
      changed = true;
    }
  }
  if (next.pathname === '/' && hasUnboundedDashboardRootState(next.searchParams)) {
    next.pathname = '/dashboard';
    for (const key of [...LEGACY_DASHBOARD_ROOT_QUERY_KEYS, 'expanded', 't', 'ts']) {
      next.searchParams.delete(key);
    }
    changed = true;
  } else if (next.pathname === '/' && hasLegacyDashboardRootState(next.searchParams)) {
    next.pathname = '/dashboard';
    changed = true;
  }
  return changed ? next : null;
}
/**
 * Headers for a 308 whose Location was chosen by User-Agent.
 *
 * `Cache-Control` alone is not enough at this edge: vercel.json gives `/` a
 * `CDN-Cache-Control` / `Vercel-CDN-Cache-Control` of `public, s-maxage=600`,
 * and those take priority over `Cache-Control` for the shared cache — so the
 * CDN could store one User-Agent's Location and replay it to the other for ten
 * minutes, silently undoing the split. Every layer that could store this
 * response has to be told not to, and `Vary` alone cannot protect a sibling
 * response that omitted it (RFC 9111).
 */
function uaConditionedRedirectHeaders(location: URL): Record<string, string> {
  return {
    Location: location.toString(),
    Vary: 'User-Agent',
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store',
  };
}

export default function middleware(request: Request) {
  const url = new URL(request.url);
  const ua = request.headers.get('user-agent') ?? '';
  const path = url.pathname;
  const host = normalizeMcpHost(request.headers.get('host') ?? url.hostname);
  const aliasMcpRequest = isMcpAliasRequest(url.hostname, path)
    || isMcpAliasRequest(request.headers.get('host') ?? '', path);

  // Product MCP aliases are migration-only surfaces. Let every policy request
  // reach the handler so it returns the protocol-shaped response and emits one
  // bounded migration event. This bypass must precede generic crawler/API bot
  // gates, which otherwise turn direct alias transport calls into a 403.
  // The handler repeats the policy because dotted well-known paths bypass this
  // middleware matcher.
  if (aliasMcpRequest) return;

  // Bots indexing ?ref= / utm_* dashboard URLs as distinct pages (#7380), and
  // map-state deep links as an unbounded redirect space (#7660). Humans still
  // receive both so referral-capture, analytics, and shared map views keep
  // working; crawlers are 308'd to the clean canonical document URL.
  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    !path.startsWith('/api/') &&
    BOT_UA.test(ua)
  ) {
    const cleaned = crawlerCanonicalUrl(url);
    if (cleaned) {
      // Built by hand rather than via Response.redirect() so the response can
      // carry Vary + no-store. This redirect is decided by User-Agent; a 308
      // is cacheable by default (RFC 9110 §15.4.9). Without those headers a
      // crawler can warm the tagged URL and a shared edge cache can replay
      // the clean Location to a human, stripping `ref` before referral capture
      // or dropping the map state out of a shared link (#7660).
      return new Response(null, { status: 308, headers: uaConditionedRedirectHeaders(cleaned) });
    }
  }

  // Preserve the complete state and attribution in a person's legacy link.
  // Crawlers have already reached /dashboard through crawlerCanonicalUrl(),
  // retaining bounded entity state but collapsing coordinate combinations.
  //
  // Built by hand rather than via Response.redirect() so it can carry Vary. The
  // same request URL now yields two different Locations depending on the
  // User-Agent, and a 308 is cacheable by default (RFC 9110 §15.4.9): a shared
  // cache that stored this one without Vary would replay `/dashboard?<map
  // state>` to the crawler the branch above exists to keep off that URL. This
  // is the rule docs/solutions/integration-issues/mcp-crawler-get-and-method-
  // aware-canonical-redirects.md states: cacheable(response) implies Vary
  // covers every header the branch read.
  if (path === '/' && hasLegacyDashboardRootState(url.searchParams)) {
    const dashboardUrl = new URL(request.url);
    dashboardUrl.pathname = '/dashboard';
    return new Response(null, { status: 308, headers: uaConditionedRedirectHeaders(dashboardUrl) });
  }

  const accept = request.headers.get('accept');
  const markdownQuality = acceptQuality(accept, 'text/markdown') ?? 0;
  const wantsHomepageMarkdown = /(?:^|,)\s*text\/markdown\s*(?:;|,|$)/i.test(accept ?? '') &&
    markdownQuality > 0 && markdownQuality >= (acceptQuality(accept, 'text/html', true) ?? 0);

  if (
    path === '/' &&
    (host === 'www.worldmonitor.app' || host === 'worldmonitor.app') &&
    (request.method === 'GET' || request.method === 'HEAD') &&
    url.searchParams.get('mode') !== 'agent' &&
    (AGENT_UA.test(ua) || wantsHomepageMarkdown)
  ) {
    return new Response(null, {
      headers: {
        'x-middleware-rewrite': new URL('/pro/home.md', url).toString(),
        'Content-Type': 'text/markdown; charset=utf-8',
        Vary: 'User-Agent, Accept',
        'Cache-Control': 'private, no-store',
        'CDN-Cache-Control': 'no-store',
        'Vercel-CDN-Cache-Control': 'no-store',
      },
    });
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    const docsDestination = getRootlessDocsDestination(path);
    if (docsDestination) {
      const canonicalUrl = new URL(docsDestination);
      canonicalUrl.search = url.search;
      return Response.redirect(canonicalUrl.toString(), 308);
    }

    // Mintlify rewrite cannot set zh-Hans <html lang> or reciprocal hreflang
    // for /docs/zh/* (issue #7378). Proxy full-document HTML only — leave RSC
    // flights and static assets on the direct Mintlify rewrite.
    if (isDocsHtmlDocumentPath(path) && isDocsFullDocumentRequest(request)) {
      return proxyDocsLocaleHtml(request, url, host);
    }

    // Real HTTP 404 for unknown pages. Agents get markdown (orank
    // `agent-friendly-404`); browsers that send Accept: text/html get HTML.
    // A rewrite to a static file would 200. Non-html extensions skip this
    // matcher and fall through to public/404.html. .html stays here so the
    // nonce stamp runs, and an unknown .html file still uses the platform 404.
    if (path.endsWith('.html') && path !== '/api' && !path.startsWith('/api/')) {
      if (shouldStampDocument(request, url)) return stampOriginDocument(request, url);
      return;
    }

    if (!isKnownPublicPagePath(path)) {
      return originNotFoundResponse(path, request);
    }

    if (isLiveHtmlRequest(request, url)) {
      if (CHOKEPOINT_PAGE_PATH.test(url.pathname)) return liveChokepointPage(url);
      const topic = liveTopicPageForPath(url.pathname);
      if (topic) return liveTopicPage(url, topic);
    }
  }

  // Only apply bot filtering to /api/* paths.
  //
  // /favico/* is deliberately NOT gated: it serves public static brand
  // assets (favicons, app icons, the email logo) that must be retrievable
  // by ANY client — browsers, email clients and their image proxies, link
  // unfurlers, preview scrapers. Bot-gating it broke the logo in
  // transactional emails when a client/proxy fetched with a script-like UA
  // (the same reason Cloudflare's "Block API Bots" rule was narrowed to
  // /api/* only). /favico/* is also removed from the matcher below so the
  // middleware never runs on it.
  if (!path.startsWith('/api/')) {
    if (shouldStampDocument(request, url)) return stampOriginDocument(request, url);
    return;
  }

  // Allow social preview/image bots on OG image assets.
  //
  // Image-returning API routes that don't end in `.png` also need
  // an explicit carve-out — otherwise server-side fetches from
  // Slack / Telegram / Discord / LinkedIn / WhatsApp / Facebook /
  // Twitter / Reddit all trip the BOT_UA gate below. Telegram
  // surfaces it as error 400 "WEBPAGE_CURL_FAILED" on sendMediaGroup;
  // the others silently drop the preview image.
  //
  // Only the brief carousel route shape is allowlisted — a strict
  // regex (same shape enforced by the handler) prevents a future
  // /api/brief/carousel/admin or similar sibling from accidentally
  // inheriting this bypass. HMAC token in the URL is the real auth;
  // this allowlist is defence-in-depth for any well-shaped request
  // whose UA happens to be in SOCIAL_IMAGE_UA.
  if (
    path.endsWith('.png') ||
    BRIEF_CAROUSEL_PATH_RE.test(path)
  ) {
    if (SOCIAL_IMAGE_UA.test(ua)) {
      return;
    }
  }

  // Allow social preview bots on exact OG routes only
  if (SOCIAL_PREVIEW_UA.test(ua) && SOCIAL_PREVIEW_PATHS.has(path)) {
    return;
  }

  // Public endpoints bypass all bot filtering
  if (PUBLIC_API_PATHS.has(path) || isPublicApiMarkdownTwin(path, request.method)) {
    return;
  }

  // Authenticated Pro API clients bypass UA filtering. This is a cheap
  // edge heuristic, not auth — real validation (SHA-256 hash vs Convex
  // userApiKeys + entitlement) happens in server/gateway.ts. To keep the
  // bot-UA shield meaningful, require the `wm_` prefix plus 40–64 lowercase
  // hex chars. User keys are 40 hex chars; enterprise keys may be longer.
  // A random scraper would still have to guess this format, and spoofed-but-
  // well-shaped keys still 401 at the gateway.
  const WM_KEY_SHAPE = /^wm_[a-f0-9]{40,64}$/;
  const apiKey =
    request.headers.get('x-worldmonitor-key') ??
    request.headers.get('x-api-key') ??
    '';
  if (WM_KEY_SHAPE.test(apiKey)) {
    return;
  }

  if (BOT_UA.test(ua) || !ua || ua.length < 10) {
    return Response.json(agentRequestPolicy.blockedResponse, {
      status: 403,
      headers: {
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
}

function docsResponseHeaders(upstream: Response, host: string): Headers {
  const headers = new Headers(upstream.headers);
  if (host !== new URL(DOCS_PUBLIC_ORIGIN).hostname) {
    const robots = headers.get('x-robots-tag');
    headers.set('x-robots-tag', robots ? `noindex, ${robots}` : 'noindex');
  }
  const varyParts = new Set(
    (headers.get('vary') ?? '').split(',').map((part) => part.trim().toLowerCase()).filter(Boolean),
  );
  for (const name of ['host', 'accept', 'rsc', 'next-router-state-tree', 'next-router-prefetch']) {
    varyParts.add(name);
  }
  headers.set('vary', [...varyParts].join(', '));
  return headers;
}

// Chokepoint pages are built from a weekly pulse snapshot. Crawlers run no
// hydrate script, so an answer engine asking "is Hormuz open right now?" read
// that week-old capture. Full-document GETs get the built page with its live
// section re-rendered from the current public reading; any failure serves the
// built page unchanged.
const CHOKEPOINT_PAGE_PATH = /^\/chokepoints\/[a-z0-9-]+\/$/;
const LIVE_PAGE_FETCH_TIMEOUT_MS = 4_000;
// The reading refreshes every few minutes; the built page's hour-long browser
// cache would hold it for an hour. A built page that carries the CSP nonce
// placeholder is stamped, and the stamp's no-store replaces these.
const LIVE_PAGE_CACHE_CONTROL = 'public, max-age=300, must-revalidate';
const LIVE_PAGE_CDN_CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=60';
// Must pass the /api/* bot gate below: no BOT_UA token, at least 10 chars.
const LIVE_PAGE_USER_AGENT = 'Mozilla/5.0 (compatible; WorldMonitorLivePages/1.0)';
const CHOKEPOINT_STATUS_PUBLIC_PATH = '/api/supply-chain/v1/get-chokepoint-status?public=1';

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function sectionAttribute(html: string, name: string): string | null {
  const match = html.match(new RegExp(`<section[^>]*\\sdata-live-chokepoint\\b[^>]*\\s${name}="([^"]*)"`));
  return match ? decodeAttribute(match[1] ?? '') : null;
}

const passThroughToOrigin = () => new Response(null, { headers: { 'x-middleware-next': '1' } });

function isLiveHtmlRequest(request: Request, url: URL): boolean {
  if (request.method !== 'GET' || url.searchParams.has(BUILT_PAGE_PARAM)) return false;
  const accept = request.headers.get('accept');
  return !accept || (acceptQuality(accept, 'text/html', true) ?? 0) > 0;
}

async function fetchPublicReading(url: URL, statusPath: string): Promise<unknown> {
  const status = await fetch(new URL(statusPath, url), {
    headers: { accept: 'application/json', 'user-agent': LIVE_PAGE_USER_AGENT },
    signal: AbortSignal.timeout(LIVE_PAGE_FETCH_TIMEOUT_MS),
  });
  if (!status.ok) throw new Error(`public reading ${status.status}`);
  return status.json();
}

/**
 * Serves the built page with its live section re-rendered by `render`, which
 * returns the new HTML or null to keep the built reading. A render failure
 * serves the built page, a missing built page falls through to the origin, and
 * a failed fetch answers 503 rather than an unstamped page.
 */
async function liveHtmlPage(url: URL, kind: string, render: (html: string) => Promise<string | null>): Promise<Response> {
  let page: Response;
  let html: string;
  const builtUrl = new URL(url.pathname, url);
  builtUrl.searchParams.set(BUILT_PAGE_PARAM, '1');
  try {
    page = await fetch(builtUrl, {
      headers: {
        accept: 'text/html',
        'user-agent': LIVE_PAGE_USER_AGENT,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(LIVE_PAGE_FETCH_TIMEOUT_MS),
    });
    if (page.status !== 200) return passThroughToOrigin();
    html = await page.text();
  } catch {
    return documentUnavailableResponse();
  }

  const headers = new Headers(page.headers);
  // fetch() already decoded the body; framing headers do not describe the new string.
  for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) {
    headers.delete(name);
  }
  // Also on the fallback, so a browser re-asks once the reading recovers.
  headers.set('cache-control', LIVE_PAGE_CACHE_CONTROL);
  headers.set('cdn-cache-control', LIVE_PAGE_CDN_CACHE_CONTROL);
  headers.set('vercel-cdn-cache-control', LIVE_PAGE_CDN_CACHE_CONTROL);
  const builtPage = () => deliverHtmlDocument(html, headers);

  try {
    const live = await render(html);
    if (live === null) return builtPage();
    headers.set('x-wm-live-page', kind);
    // The built file's validators describe a different body.
    headers.delete('etag');
    headers.delete('last-modified');
    return deliverHtmlDocument(live, headers);
  } catch {
    return builtPage();
  }
}

function liveChokepointPage(url: URL): Promise<Response> {
  return liveHtmlPage(url, 'chokepoint', async (html) => {
    const id = sectionAttribute(html, 'data-chokepoint-id');
    const displayName = sectionAttribute(html, 'data-chokepoint-name');
    if (!id || !displayName) return null;
    // Missing row, stale snapshot, or out-of-range score: the view model throws
    // rather than return a reading it cannot vouch for.
    const view = chokepointStatusViewModel(await fetchPublicReading(url, CHOKEPOINT_STATUS_PUBLIC_PATH), id);
    const section = renderChokepointLiveSection({
      chokepoint: { id, displayName },
      pulse: chokepointPulseRecord(view),
      live: true,
    });
    return replaceChokepointLiveSection(html, section);
  });
}

function liveTopicPage(url: URL, topic: LiveTopicPage): Promise<Response> {
  return liveHtmlPage(url, topic.slug, async (html) => {
    const record = liveTopicReading(topic, await fetchPublicReading(url, topic.statusPath));
    // An unpublishable reading (stale, empty) keeps the built page's dated one.
    if (record === null) return null;
    return replaceLiveSection(html, topic.slug, topic.renderSection(record, { live: true }));
  });
}

async function proxyDocsLocaleHtml(request: Request, url: URL, host: string): Promise<Response> {
  const upstreamUrl = `${DOCS_UPSTREAM_ORIGIN}${url.pathname}${url.search}`;
  const forwardHeaders = new Headers();
  for (const name of ['accept', 'accept-language', 'user-agent', 'if-none-match', 'if-modified-since']) {
    const value = request.headers.get(name);
    if (value) forwardHeaders.set(name, value);
  }
  if (!forwardHeaders.has('user-agent')) {
    forwardHeaders.set('user-agent', 'WorldMonitorDocsLocaleProxy/1.0');
  }

  let upstream: Response;
  let html: string;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: forwardHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(DOCS_UPSTREAM_TIMEOUT_MS),
    });

    const contentType = upstream.headers.get('content-type');
    if (upstream.status !== 304 && (
      upstream.status !== 200 || !shouldTransformDocsUpstreamHtml(url.pathname, contentType)
    )) {
      return upstream;
    }
    if (upstream.status === 304 || request.method === 'HEAD') {
      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: docsResponseHeaders(upstream, host),
      });
    }

    html = await upstream.text();
  } catch {
    return new Response('Docs upstream unavailable', { status: 502 });
  }

  const rewritten = rewriteDocsLocaleHtml(html, url.pathname);
  const headers = docsResponseHeaders(upstream, host);
  // Fetch already decoded the body; hop-by-hop / recomputed framing must not
  // be forwarded onto the rewritten string response (Mintlify serves br).
  for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) {
    headers.delete(name);
  }
  headers.set('x-wm-docs-locale-seo', '1');
  return new Response(rewritten, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export const config = {
  matcher: [
    '/mcp',
    '/api/:path*',
    '/((?!api(?:/|$)|mcp(?:/|$)|.*\\.(?!html$)[^/]+$).*)',
    // DOTTED_DOCUMENT_PREFIXES: SPA routes whose symbol may contain a dot.
    '/stocks/:path*',
  ],
};
