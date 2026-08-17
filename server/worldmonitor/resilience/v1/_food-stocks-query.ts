export const FOOD_STOCKS_CANONICAL_KEY = 'resilience:food-stocks:v1';
export const FOOD_STOCKS_WORLD_KEY = '_world';
export const KNOWN_COMMODITIES = new Set(['wheat', 'corn', 'rice', 'soybeans', 'barley', 'palmOil']);

const COMMODITY_ALIASES: Record<string, string> = {
  wheat: 'wheat',
  corn: 'corn',
  maize: 'corn',
  rice: 'rice',
  soy: 'soybeans',
  soybean: 'soybeans',
  soybeans: 'soybeans',
  barley: 'barley',
  palmoil: 'palmOil',
  palm_oil: 'palmOil',
  'palm-oil': 'palmOil',
};

export function normalizeFoodStocksCommodity(raw: string): string | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const slug = COMMODITY_ALIASES[trimmed.toLowerCase().replace(/\s+/g, '')];
  if (slug && KNOWN_COMMODITIES.has(slug)) return slug;
  if (KNOWN_COMMODITIES.has(trimmed)) return trimmed;
  return null;
}

export function normalizeFoodStocksCountry(raw: string): string | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const upper = trimmed.toUpperCase();
  if (upper === 'WORLD' || upper === 'WLD' || upper === '_WORLD') return FOOD_STOCKS_WORLD_KEY;
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return null;
}

/**
 * Flatten the Redis snapshot into wire rows. Lives here, not in the handler,
 * so it is directly unit-testable without mocking Redis — the handler-private
 * copy it replaces had no test at all.
 */
export function flattenSnapshot(
  snapshot: Record<string, unknown>,
  countryCode?: string,
  commodity?: string,
): Array<{
  countryCode: string;
  commodity: string;
  marketingYear: string;
  stocksToUse: number;
  hasStocksToUse: boolean;
  endingStocksTmt: number;
  hasEndingStocks: boolean;
  totalUseTmt: number;
  productionTmt: number;
  consumptionTmt: number;
  importsTmt: number;
  exportsTmt: number;
  unit: string;
  source: string;
}> {
  const rows = [];
  for (const [iso2, entry] of Object.entries(snapshot)) {
    if (iso2 === 'fetchedAt' || iso2 === 'stageNotes') continue;
    if (countryCode && iso2 !== countryCode) continue;
    const commodities = (entry as { commodities?: Record<string, Record<string, unknown>> })?.commodities;
    if (!commodities || typeof commodities !== 'object') continue;
    for (const [slug, rec] of Object.entries(commodities)) {
      if (commodity && slug !== commodity) continue;
      const consumption = Number(rec.consumption) || 0;
      const exports = Number(rec.exports) || 0;
      const ratio = Number(rec.stocksToUseRatio);
      // Presence, computed from the seeded record BEFORE the null -> 0 coercion
      // below. `null` is what the parser writes when USDA published no stocks
      // series for this country-commodity; `0` is what proto3 forces onto the
      // wire, and the two are otherwise indistinguishable to every consumer.
      const hasStocksToUse = rec.stocksToUseRatio != null && Number.isFinite(ratio);
      const endingStocksRaw = Number(rec.endingStocks);
      const hasEndingStocks = rec.endingStocks != null && Number.isFinite(endingStocksRaw);
      // Prefer the persisted denominator. `_world` excludes exports (they are
      // internal transfers), so recomputing `consumption + exports` here would
      // publish a totalUseTmt that disagrees with stocksToUse on every world row.
      const persistedTotalUse = Number(rec.totalUse);
      rows.push({
        countryCode: iso2,
        commodity: slug,
        marketingYear: String(rec.marketingYear ?? ''),
        stocksToUse: hasStocksToUse ? ratio : 0,
        hasStocksToUse,
        endingStocksTmt: hasEndingStocks ? endingStocksRaw : 0,
        hasEndingStocks,
        totalUseTmt: Number.isFinite(persistedTotalUse)
          ? persistedTotalUse
          : (iso2 === FOOD_STOCKS_WORLD_KEY ? consumption : consumption + exports),
        productionTmt: Number(rec.production) || 0,
        consumptionTmt: consumption,
        importsTmt: Number(rec.imports) || 0,
        exportsTmt: exports,
        unit: String(rec.unit ?? '1000 MT'),
        source: String(rec.source ?? ''),
      });
    }
  }
  return rows;
}
