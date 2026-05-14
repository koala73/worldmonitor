/**
 * Stock symbol search — backs the watchlist editor's typeahead.
 *
 * GET /api/symbol-search?q=<query>  → { results: [{ symbol, name, display }] }
 *
 * Thin passthrough to Finnhub's symbol-search endpoint. Used by every user
 * (the market watchlist is not a PRO feature), so there is no entitlement
 * gate — just CORS + rate limiting. The client debounces keystrokes, so
 * Finnhub's free-tier quota (60 req/min) is not a concern in practice.
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

  try {
    const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
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
    return jsonResponse({ results }, 200, cors);
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
