/**
 * Stock symbol search — backs the watchlist editor's typeahead.
 *
 * GET /api/symbol-search?q=<query>  → { results: [{ symbol, name, display }] }
 *
 * Thin Finnhub-search wrapper with a short Upstash cache. Used by every user
 * (the market watchlist is not a PRO feature), so there's no entitlement
 * gate — just CORS + rate limiting + a 10-minute cache on the normalized
 * query. The cache is the real quota guard: Finnhub's free-tier 60/min is
 * per-key (shared across all users), not per-user, so client-side debounce
 * alone wouldn't protect it. The cache is best-effort — any Upstash hiccup
 * falls through to a direct Finnhub call.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from './_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
// @ts-expect-error — JS module, no declaration file
import { readRawJsonFromUpstash, setCachedData } from './_upstash-json.js';

interface FinnhubSearchResult {
  symbol?: string;
  displaySymbol?: string;
  description?: string;
  type?: string;
}

export interface SymbolSearchResult {
  symbol: string;
  name: string;
  display: string;
}

const MAX_RESULTS = 12;
const UPSTREAM_TIMEOUT_MS = 8_000;
// Shared cache for the symbol-search results. The Finnhub free-tier quota
// (60/min) is per-key, NOT per-user — client-side debounce only protects
// each tab. Without a server cache, two concurrent users typing the same
// query (or one user typing across two tabs) can race to exhaust the
// shared quota. Symbol→company mappings are stable; a 10-minute TTL is
// a comfortable margin. Empty results are cached too, so a typo query
// can't repeatedly hammer Finnhub.
const CACHE_KEY_PREFIX = 'symsearch:v1:';
const CACHE_TTL_SECONDS = 600;
// Honest UA identifying ourselves to Finnhub. The AGENTS.md Critical
// Conventions section requires UA on server-side fetches; matches the
// `worldmonitor-edge/1.0` convention used by api/notify.ts and
// api/notification-channels.ts.
const FETCH_USER_AGENT = 'worldmonitor-edge/1.0';

// Finnhub `type` values worth offering in the watchlist editor. Finnhub also
// returns crypto, FX, bonds, warrants, etc. — excluding those keeps the
// editor to instruments the stock-analysis pipeline can actually report on.
// An empty/missing type is allowed through (Finnhub omits it for some plain
// US listings) rather than silently dropped.
const ALLOWED_TYPES = new Set([
  'Common Stock', 'ADR', 'GDR', 'ETP', 'ETF', 'REIT', 'Unit', 'Equity', '',
]);

/**
 * Map + filter raw Finnhub results to our shape. Exported for unit tests —
 * the Vercel edge runtime ignores non-default exports, so this has no
 * production-side effect.
 */
export function mapFinnhubResults(raw: FinnhubSearchResult[]): SymbolSearchResult[] {
  const seen = new Set<string>();
  const out: SymbolSearchResult[] = [];
  for (const r of raw) {
    const symbol = (r.symbol || '').trim();
    if (!symbol || seen.has(symbol)) continue;
    if (r.type !== undefined && !ALLOWED_TYPES.has(r.type)) continue;
    seen.add(symbol);
    out.push({
      symbol,
      name: (r.description || symbol).trim(),
      display: (r.displaySymbol || symbol).trim(),
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403);
  }

  const cors = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const keyCheck = await validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return jsonResponse({ error: keyCheck.error }, 401, cors);
  }

  const rateLimitResponse = await checkRateLimit(req, cors);
  if (rateLimitResponse) return rateLimitResponse;

  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
  if (!q) {
    return jsonResponse({ results: [] }, 200, cors);
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'SYMBOL_SEARCH_UNAVAILABLE' }, 503, cors);
  }

  // Normalize query for the cache key — case-insensitive, whitespace-folded.
  // The Finnhub upstream is case-insensitive, so 'NVDA', 'nvda', '  nvda '
  // all yield the same result set; share one cache entry.
  const cacheKey = CACHE_KEY_PREFIX + q.toLowerCase().replace(/\s+/g, ' ');

  // Cache-first. A miss / Upstash hiccup / decode failure all fall through
  // to Finnhub — the cache is best-effort, never load-bearing.
  try {
    const cached = await readRawJsonFromUpstash(cacheKey);
    if (cached && typeof cached === 'object' && Array.isArray((cached as { results?: unknown }).results)) {
      return jsonResponse(cached, 200, cors);
    }
  } catch {
    // Treat Upstash unavailability as a cache miss; do not 5xx the user.
  }

  try {
    const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': FETCH_USER_AGENT },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // 429 from Finnhub = quota exhausted; surface as 503 so the client
      // backs off rather than treating it as a permanent failure.
      const status = resp.status === 429 ? 503 : 502;
      console.warn(`[symbol-search] Finnhub HTTP ${resp.status} for q="${q}"`);
      captureSilentError(new Error(`Finnhub search HTTP ${resp.status}`), {
        tags: { route: 'api/symbol-search', step: 'finnhub_fetch' },
        extra: { q, finnhubStatus: resp.status },
        level: 'warning',
        ctx,
      });
      return jsonResponse({ error: 'SYMBOL_SEARCH_UNAVAILABLE' }, status, cors);
    }
    const data = (await resp.json()) as { result?: FinnhubSearchResult[] };
    const results = mapFinnhubResults(Array.isArray(data.result) ? data.result : []);
    const payload = { results };

    // Fire-and-forget write — never block the response on the cache fill.
    // Use ctx.waitUntil when Vercel provides it (keeps the function alive
    // until the SET completes); fall back to bare `void` for environments
    // (tests, local invokes) that don't pass ctx.
    const writePromise = setCachedData(cacheKey, payload, CACHE_TTL_SECONDS).catch(() => false);
    if (ctx) ctx.waitUntil(writePromise);
    else void writePromise;

    return jsonResponse(payload, 200, cors);
  } catch (err) {
    console.error('[symbol-search] error:', err);
    captureSilentError(err, {
      tags: { route: 'api/symbol-search', step: 'handler' },
      extra: { q },
      ctx,
    });
    return jsonResponse({ error: 'SYMBOL_SEARCH_FAILED' }, 500, cors);
  }
}
