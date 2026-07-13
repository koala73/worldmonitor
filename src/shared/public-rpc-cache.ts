const PUBLIC_SHARED_RPC_PATHS = new Set([
  '/api/news/v1/list-feed-digest',
  '/api/displacement/v1/get-displacement-summary',
]);

const NEWS_VARIANTS = new Set(['full', 'tech', 'finance', 'happy', 'commodity', 'energy']);
const NEWS_LANGUAGES = new Set([
  'en', 'bg', 'cs', 'fr', 'de', 'el', 'es', 'hr', 'hu', 'it', 'pl', 'pt', 'nl',
  'sv', 'ru', 'ar', 'fa', 'zh', 'ja', 'ko', 'ro', 'tr', 'th', 'vi', 'hi',
]);
const NEWS_QUERY_KEYS = new Set(['variant', 'lang', 'public']);
const DISPLACEMENT_QUERY_KEYS = new Set(['year', 'country_limit', 'flow_limit', 'public']);
const DISPLACEMENT_INTEGER_KEYS = ['year', 'country_limit', 'flow_limit'] as const;

function hasSingleValue(params: URLSearchParams, key: string): boolean {
  return params.getAll(key).length === 1;
}

function isBoundedInteger(value: string | null, min: number, max: number): boolean {
  if (value === null || !/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max;
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

function isDisplacementShape(params: URLSearchParams): boolean {
  if (!hasOnlyKeys(params, DISPLACEMENT_QUERY_KEYS)) return false;

  for (const key of DISPLACEMENT_INTEGER_KEYS) {
    if (params.has(key) && !hasSingleValue(params, key)) return false;
  }
  if (params.has('year') && !isBoundedInteger(params.get('year'), 1950, 2100)) return false;
  if (params.has('country_limit') && !isBoundedInteger(params.get('country_limit'), 1, 500)) return false;
  if (params.has('flow_limit') && !isBoundedInteger(params.get('flow_limit'), 1, 500)) return false;
  return true;
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
  if (!hasSingleValue(url.searchParams, 'public') || url.searchParams.get('public') !== '1') return false;

  if (pathname === '/api/news/v1/list-feed-digest') return isNewsDigestShape(url.searchParams);
  return isDisplacementShape(url.searchParams);
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
