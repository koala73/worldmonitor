const PUBLIC_SHARED_RPC_PATHS = new Set([
  '/api/news/v1/list-feed-digest',
  '/api/displacement/v1/get-displacement-summary',
  '/api/forecast/v1/get-forecasts',
]);

const NEWS_VARIANTS = new Set(['full', 'tech', 'finance', 'happy', 'commodity', 'energy']);
const NEWS_LANGUAGES = new Set([
  'en', 'bg', 'cs', 'fr', 'de', 'el', 'es', 'hr', 'hu', 'it', 'pl', 'pt', 'nl',
  'sv', 'ru', 'ar', 'fa', 'zh', 'ja', 'ko', 'ro', 'tr', 'th', 'vi', 'hi',
]);
const NEWS_QUERY_KEYS = new Set(['variant', 'lang', 'public']);
// Exact raw-query contract (no leading `?`): exactly one public displacement shape,
// so the CDN key space stays at one entry. Compared against the raw search string —
// order- and encoding-sensitive by design (see stripRouterInjectedRpcEcho).
const DISPLACEMENT_PUBLIC_SEARCH = 'flow_limit=50&public=1';

// The forecast feed the dashboard refreshes every 30 minutes. The client sends no
// filters (domain/region are empty and the generated client omits zero values), so
// the ONE public shape is the bare marker. A caller that filters by domain/region
// gets a per-caller response and must use the credentialed URL — keeping the CDN key
// space at a single entry.
//
// This refresh is why the key is expensive: getHydratedData() is one-shot, so every
// 30-minute tick fell through to this RPC, which had no CDN shield — ~17.5k uncached
// origin reads/day of a 188 KB payload (#5300).
const FORECASTS_PUBLIC_SEARCH = 'public=1';

function hasSingleValue(params: URLSearchParams, key: string): boolean {
  return params.getAll(key).length === 1;
}

/**
 * Vercel serves these routes through `api/<domain>/v1/[rpc].ts` and its filesystem router
 * echoes the matched segment back as `?rpc=<lastPathSegment>`. The function therefore
 * sees a query the caller never sent, which fails the exhaustive shape checks below
 * and silently 401'd every public RPC in production (#5285). `server/_shared/
 * mcp-internal-hmac.ts` strips the same echo before signing, for the same reason.
 *
 * Returns the RAW search string (no leading `?`) with the echo removed. Raw, not a
 * re-serialised URLSearchParams, because the displacement contract is an exact-string
 * compare: re-encoding would normalise `flow_limit=%35%30` into `flow_limit=50` and
 * silently widen the accepted shape.
 *
 * Strips `rpc` ONLY when every value equals the final path segment — i.e. only the
 * router's own echo. A caller-appended `?rpc=<anything-else>` is left in place and
 * still fails the shape check, so this is not a bypass vector.
 */
function stripRouterInjectedRpcEcho(url: URL): string {
  const raw = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  if (!raw) return '';

  const segments = url.pathname.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? '';
  const echo = `rpc=${lastSegment}`;

  const parts = raw.split('&');
  const rpcParts = parts.filter((part) => part === 'rpc' || part.startsWith('rpc='));
  if (rpcParts.length === 0) return raw;
  if (!rpcParts.every((part) => part === echo)) return raw;

  return parts.filter((part) => part !== echo).join('&');
}

function hasOnlyKeys(params: URLSearchParams, allowed: Set<string>): boolean {
  return Array.from(params.keys()).every((key) => allowed.has(key));
}

function isNewsDigestShape(params: URLSearchParams): boolean {
  return hasOnlyKeys(params, NEWS_QUERY_KEYS)
    && hasSingleValue(params, 'variant')
    && hasSingleValue(params, 'lang')
    && NEWS_VARIANTS.has(params.get('variant') ?? '')
    && NEWS_LANGUAGES.has(params.get('lang') ?? '');
}

export function isPublicSharedRpcRequest(urlLike: string | URL, method = 'GET'): boolean {
  if (method.toUpperCase() !== 'GET') return false;

  let url: URL;
  try {
    url = urlLike instanceof URL
      ? urlLike
      : new URL(urlLike, 'https://worldmonitor.invalid');
  } catch {
    return false;
  }

  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (!PUBLIC_SHARED_RPC_PATHS.has(pathname)) return false;

  // Shape-check the caller's query, not the router's echo of the path segment.
  const search = stripRouterInjectedRpcEcho(url);
  const params = new URLSearchParams(search);
  if (!hasSingleValue(params, 'public') || params.get('public') !== '1') return false;

  if (pathname === '/api/news/v1/list-feed-digest') return isNewsDigestShape(params);
  if (pathname === '/api/forecast/v1/get-forecasts') return search === FORECASTS_PUBLIC_SEARCH;
  return search === DISPLACEMENT_PUBLIC_SEARCH;
}

export function addPublicSharedRpcMarker(urlLike: string | URL): string {
  const original = String(urlLike);
  const relative = original.startsWith('/');
  const base = typeof location === 'undefined' ? 'https://worldmonitor.invalid' : location.href;
  const url = new URL(original, base);

  if (!PUBLIC_SHARED_RPC_PATHS.has(url.pathname)) {
    throw new Error(`not an allowlisted public RPC: ${url.pathname}`);
  }
  url.searchParams.set('public', '1');
  if (!isPublicSharedRpcRequest(url)) {
    throw new Error(`not an allowlisted public RPC shape: ${url.pathname}${url.search}`);
  }

  return relative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}
