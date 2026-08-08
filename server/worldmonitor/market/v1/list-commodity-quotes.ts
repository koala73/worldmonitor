/**
 * RPC: ListCommodityQuotes -- reads seeded commodity data from Railway seed cache.
 * All external quote fetching happens in seed-commodity-quotes.mjs on Railway.
 *
 * Contract (narrowed, see #6307):
 *   - Empty `symbols` returns the full configured default commodity set.
 *   - Only symbols in the configured commodity set (shared/commodities.json)
 *     are supported. Requesting an unsupported symbol returns HTTP 400.
 *   - Symbols are normalized (trim, de-whitespace, upper), deduplicated, and
 *     capped before the seed read. Results preserve seed/bootstrap order.
 */

import type {
  ServerContext,
  ListCommodityQuotesRequest,
  ListCommodityQuotesResponse,
  CommodityQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { parseStringArray } from './_shared';
import { getCachedJson } from '../../../_shared/redis';
import commodityConfig from '../../../../shared/commodities.json';

const BOOTSTRAP_KEY = 'market:commodities-bootstrap:v1';
const MAX_SYMBOLS = 64;

/** Yahoo symbols supported by the seeded commodity set (source of truth). */
export const SUPPORTED_COMMODITY_SYMBOLS: ReadonlySet<string> = new Set(
  commodityConfig.commodities.map((c) => c.symbol),
);

export function normalizeCommoditySymbol(raw: string): string {
  return raw.trim().replace(/\s+/g, '').slice(0, 32).toUpperCase();
}

/**
 * Throw the generated ValidationError for unsupported requested symbols.
 *
 * ValidationError is the documented 400 shape: the sebuf generated dispatch
 * (service_server.ts) catches instanceof ValidationError and serializes it as
 * `{ violations: [...] }` — matching the published OpenAPI 400 `ValidationError`
 * schema. A bare `{ message }` 400 (e.g. an error carrying statusCode=400 via
 * the error mapper) is NOT in that operation's 400 oneOf, so using it here
 * would document a response shape the handler never actually returns.
 */
export function throwUnsupportedCommodityError(symbols: string[]): never {
  throw new ValidationError([
    {
      field: 'symbols',
      description: `Unsupported commodity symbol${symbols.length === 1 ? '' : 's'}: ${symbols.join(', ')}`,
    },
  ]);
}

/**
 * Resolve requested symbols against the supported commodity set.
 * - Empty request → `{ symbols: [] }` (caller returns the full default set).
 * - Caps cardinality (over-cap is truncated) and deduplicates in request order.
 * - Throws ValidationError (→ HTTP 400 `{ violations }`) on any requested
 *   symbol that is not in the supported set — unsupported symbols are
 *   explicit, never silent.
 */
export function resolveCommodityQuery(
  rawSymbols: string[],
  supported: ReadonlySet<string> = SUPPORTED_COMMODITY_SYMBOLS,
  maxSymbols: number = MAX_SYMBOLS,
): { symbols: string[]; overCap: boolean } {
  const symbols: string[] = [];
  const seen = new Set<string>();
  const unsupported: string[] = [];
  for (const raw of rawSymbols) {
    const symbol = normalizeCommoditySymbol(raw);
    // Present-but-blank after normalize (e.g. whitespace-only) is a client error.
    // Without this, resolve returns symbols=[] and the filter path returns the
    // full seed set — looking like empty→defaults for a non-empty request.
    if (!symbol) {
      if (String(raw).length > 0 && !unsupported.includes('<blank>')) {
        unsupported.push('<blank>');
      }
      continue;
    }
    if (seen.has(symbol)) continue;
    if (!supported.has(symbol)) {
      unsupported.push(symbol);
      continue;
    }
    seen.add(symbol);
    symbols.push(symbol);
  }
  if (unsupported.length > 0) throwUnsupportedCommodityError(unsupported);
  return { symbols: symbols.slice(0, maxSymbols), overCap: symbols.length > maxSymbols };
}

/** Filter seed quotes to the requested symbols, preserving seed order. */
export function filterCommoditySeed(
  quotes: CommodityQuote[],
  symbols: string[],
): CommodityQuote[] {
  if (symbols.length === 0) return quotes;
  const wanted = new Set(symbols);
  return quotes.filter((q) => wanted.has(q.symbol));
}

export async function listCommodityQuotes(
  _ctx: ServerContext,
  req: ListCommodityQuotesRequest,
): Promise<ListCommodityQuotesResponse> {
  const parsed = parseStringArray(req.symbols);

  // Validation happens before any seed read: an unsupported symbol 400s even
  // when the seed is unavailable, so the rejection is explicit and never
  // masked (never a silent partial success). Empty symbols pass validation
  // and resolve to [] → filterCommoditySeed returns the full configured set.
  const { symbols } = resolveCommodityQuery(parsed);

  try {
    const bootstrap = await getCachedJson(BOOTSTRAP_KEY, true) as ListCommodityQuotesResponse | null;
    if (!bootstrap?.quotes?.length) return { quotes: [] };
    return { quotes: filterCommoditySeed(bootstrap.quotes, symbols) };
  } catch {
    return { quotes: [] };
  }
}
