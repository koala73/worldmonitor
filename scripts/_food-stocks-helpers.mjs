// Pure PSD / FAOSTAT food-stocks parsers shared by seed-food-stocks.mjs and tests.
//
// Shape contract: one Redis payload at resilience:food-stocks:v1 keyed by ISO-2
// (plus `_world`). Each country holds per-commodity balances whose clock is the
// marketing-year label, never a calendar year. FAOSTAT may fill production for
// countries PSD does not cover; it never overwrites PSD and never invents stocks.

export const FOOD_STOCKS_CANONICAL_KEY = 'resilience:food-stocks:v1';
export const FOOD_STOCKS_WORLD_KEY = '_world';
export const FOOD_STOCKS_SOURCE_VERSION = 'food-stocks-v1';

// Monthly WASDE cycle. Health fetch-age uses 2x the 30-day bundle-section
// interval (60d). Content-age is 4 WASDE cycles (120d), not 3: the clock now
// tracks the OLDEST world commodity rather than the newest, so the budget has to
// absorb a genuinely late marketing-year roll on the laggiest commodity without
// paging. A 90d budget left ~1 day of margin in that case.
export const FOOD_STOCKS_MAX_STALE_MIN = 60 * 24 * 60;
export const FOOD_STOCKS_MAX_CONTENT_AGE_MIN = 120 * 24 * 60;
export const FOOD_STOCKS_TTL_SECONDS = 90 * 24 * 3600;

export const PSD_COMMODITIES = {
  wheat: { slug: 'wheat', code: '0410000', name: 'Wheat', unit: '1000 MT', faostatItem: 15 },
  corn: { slug: 'corn', code: '0440000', name: 'Corn', unit: '1000 MT', faostatItem: 56 },
  rice: { slug: 'rice', code: '0422110', name: 'Rice, Milled', unit: '1000 MT', faostatItem: 27 },
  soybeans: { slug: 'soybeans', code: '2222000', name: 'Oilseed, Soybean', unit: '1000 MT', faostatItem: 236 },
  barley: { slug: 'barley', code: '0430000', name: 'Barley', unit: '1000 MT', faostatItem: 44 },
  palmOil: { slug: 'palmOil', code: '4243000', name: 'Oil, Palm', unit: '1000 MT', faostatItem: 257 },
};

export const PSD_ATTRIBUTES = {
  BEGINNING_STOCKS: 20,
  PRODUCTION: 28,
  IMPORTS: 57,
  TOTAL_SUPPLY: 86,
  EXPORTS: 88,
  DOMESTIC_CONSUMPTION: 125,
  ENDING_STOCKS: 176,
  TOTAL_DISTRIBUTION: 178,
};

// FAO Food Balance / USDA handbook kcal per kg. Used only for the country
// aggregate; raw PSD units stay on each commodity row.
export const COMMODITY_KCAL_PER_KG = {
  wheat: 3340,
  corn: 3650,
  rice: 3600,
  soybeans: 1470,
  barley: 3320,
  palmOil: 8840,
};

export function normalizePsdCommodityCode(code) {
  const digits = String(code ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.padStart(7, '0');
}

export function commoditySlugFromCode(code) {
  const padded = normalizePsdCommodityCode(code);
  return Object.values(PSD_COMMODITIES).find((item) => item.code === padded)?.slug ?? null;
}

export function formatMarketingYear(marketYear) {
  if (typeof marketYear === 'string' && /^\d{4}\/\d{2}$/.test(marketYear)) return marketYear;
  const year = Number.parseInt(String(marketYear ?? ''), 10);
  if (!Number.isInteger(year) || year < 1960 || year > 2100) return null;
  return `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
}

export function parseMarketingYearStart(label) {
  if (typeof label !== 'string' || !/^\d{4}\/\d{2}$/.test(label)) return null;
  const start = Number.parseInt(label.slice(0, 4), 10);
  return Number.isInteger(start) ? start : null;
}

export function normalizePsdCountryCode(code) {
  const raw = String(code ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  // Live api.fas.usda.gov world rows use "00"; older fixtures and mocks use 0 / "0".
  if (upper === 'WORLD' || upper === 'WLD' || /^0+$/.test(raw)) return FOOD_STOCKS_WORLD_KEY;
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return null;
}

/**
 * Stocks-to-use = ending stocks / total use.
 *
 * For a COUNTRY, total use is domestic consumption + exports: grain shipped out
 * has genuinely left that country's balance sheet.
 *
 * For the WORLD aggregate, `excludeExports` must be set. World exports are
 * internal transfers between countries — they net against world imports and are
 * already counted inside the importer's domestic consumption, so adding them
 * double-counts and understates the ratio. USDA/WASDE publish world
 * stocks-to-use as ending stocks / total domestic consumption for this reason.
 */
export function computeStocksToUseRatio(endingStocks, consumption, exports, { excludeExports = false } = {}) {
  if (!Number.isFinite(endingStocks)) return null;
  if (consumption != null && !Number.isFinite(consumption)) return null;
  if (exports != null && !Number.isFinite(exports)) return null;
  const countedExports = excludeExports ? 0 : (Number.isFinite(exports) ? exports : 0);
  const use = (Number.isFinite(consumption) ? consumption : 0) + countedExports;
  if (use <= 0) return null;
  return endingStocks / use;
}

/** Total use matching computeStocksToUseRatio's denominator, for wire payloads. */
export function computeTotalUse(consumption, exports, { excludeExports = false } = {}) {
  const countedExports = excludeExports ? 0 : (Number.isFinite(Number(exports)) ? Number(exports) : 0);
  return (Number.isFinite(Number(consumption)) ? Number(consumption) : 0) + countedExports;
}

export function bucketKey(record) {
  return `${record.countryCode}:${record.commodity}:${record.marketingYear}`;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function vintageRank(calendarYear, month) {
  const year = Number(calendarYear);
  const mo = Number(month);
  if (!Number.isInteger(year)) return -1;
  const safeMonth = Number.isInteger(mo) && mo >= 1 && mo <= 12 ? mo : 0;
  return year * 100 + safeMonth;
}

/**
 * Collapse a PSD attribute-row array into one record per country × marketing year.
 * Rows from an older WASDE vintage of the same country-MY are dropped.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {{ commodity?: string }} [opts]
 */
export function parsePsdForecastRows(rows, opts = {}) {
  if (!Array.isArray(rows)) return [];
  /** @type {Map<string, { countryCode: string, commodity: string, marketingYear: string, marketYear: number, forecastYear: number, forecastMonth: number, values: Record<number, number>, unitId: number | null }>} */
  const groups = new Map();

  for (const row of rows) {
    const countryCode = normalizePsdCountryCode(row?.countryCode);
    const marketingYear = formatMarketingYear(row?.marketYear);
    const commodity = opts.commodity || commoditySlugFromCode(row?.commodityCode);
    if (!countryCode || !marketingYear || !commodity) continue;

    const key = `${countryCode}:${commodity}:${marketingYear}`;
    const rank = vintageRank(row?.calendarYear, row?.month);
    let group = groups.get(key);
    if (!group) {
      group = {
        countryCode,
        commodity,
        marketingYear,
        marketYear: Number.parseInt(String(row.marketYear), 10),
        forecastYear: Number(row?.calendarYear) || 0,
        forecastMonth: Number(row?.month) || 0,
        vintage: rank,
        values: {},
        // Vintage of the row that supplied each attribute. Tracked per attribute
        // rather than per group so a WASDE revision that restates only SOME
        // attributes updates exactly those and leaves the rest of the balance
        // sheet intact. The previous per-group reset cleared `values` on any
        // vintage bump, so a production-only revision nulled consumption,
        // exports and ending stocks and dropped stocksToUseRatio to null.
        attrVintage: {},
        unitId: Number.isFinite(Number(row?.unitId)) ? Number(row.unitId) : null,
      };
      groups.set(key, group);
    } else if (rank > group.vintage) {
      group.vintage = rank;
      group.forecastYear = Number(row?.calendarYear) || 0;
      group.forecastMonth = Number(row?.month) || 0;
    }

    const attr = Number(row?.attributeId);
    const value = Number(row?.value);
    if (Number.isInteger(attr) && Number.isFinite(value)) {
      // Per-attribute newest-wins. `>=` keeps last-write-wins within one vintage,
      // matching the previous behavior for same-vintage duplicate rows.
      const seen = group.attrVintage[attr];
      if (seen === undefined || rank >= seen) {
        group.values[attr] = value;
        group.attrVintage[attr] = rank;
        if (attr === PSD_ATTRIBUTES.PRODUCTION || attr === PSD_ATTRIBUTES.ENDING_STOCKS) {
          group.unitId = Number.isFinite(Number(row?.unitId)) ? Number(row.unitId) : group.unitId;
        }
      }
    }
  }

  const records = [];
  for (const group of groups.values()) {
    const production = finiteOrNull(group.values[PSD_ATTRIBUTES.PRODUCTION]);
    const consumption = finiteOrNull(group.values[PSD_ATTRIBUTES.DOMESTIC_CONSUMPTION]);
    const imports = finiteOrNull(group.values[PSD_ATTRIBUTES.IMPORTS]);
    const exports = finiteOrNull(group.values[PSD_ATTRIBUTES.EXPORTS]);
    const endingStocks = finiteOrNull(group.values[PSD_ATTRIBUTES.ENDING_STOCKS]);
    if (production == null && consumption == null && endingStocks == null) continue;
    // World exports are internal transfers; see computeStocksToUseRatio.
    const isWorld = group.countryCode === FOOD_STOCKS_WORLD_KEY;
    records.push({
      countryCode: group.countryCode,
      commodity: group.commodity,
      marketingYear: group.marketingYear,
      marketYear: group.marketYear,
      forecastYear: group.forecastYear,
      forecastMonth: group.forecastMonth,
      production,
      consumption,
      imports,
      exports,
      endingStocks,
      stocksToUseRatio: computeStocksToUseRatio(endingStocks, consumption, exports, { excludeExports: isWorld }),
      totalUse: computeTotalUse(consumption, exports, { excludeExports: isWorld }),
      unit: PSD_COMMODITIES[group.commodity]?.unit ?? '1000 MT',
      source: 'psd',
    });
  }
  return records;
}

function faostatRows(input) {
  if (input == null || input instanceof Error) return null;
  if (!Array.isArray(input)) return null;
  return input;
}

/**
 * Add FAOSTAT production for countries PSD missed. A null/Error fill is a
 * no-op so a failed FAOSTAT stage cannot damage the PSD snapshot.
 *
 * @param {Array<Record<string, unknown>>} psdRecords
 * @param {Array<Record<string, unknown>> | Error | null} faostatRecords
 * @param {{ commodity: string }} opts
 */
export function applyFaostatProductionFill(psdRecords, faostatRecords, opts) {
  const base = Array.isArray(psdRecords) ? psdRecords.slice() : [];
  const fill = faostatRows(faostatRecords);
  if (!fill) return base;

  const commodity = opts?.commodity;
  const covered = new Set(
    base.filter((rec) => rec.commodity === commodity).map((rec) => rec.countryCode),
  );
  const fallbackYear = base
    .filter((rec) => rec.commodity === commodity)
    .map((rec) => rec.marketingYear)
    .sort()
    .at(-1) ?? formatMarketingYear(new Date().getUTCFullYear() - 1);

  for (const row of fill) {
    const countryCode = normalizePsdCountryCode(row?.countryCode);
    const rowCommodity = row?.commodity || commodity;
    if (!countryCode || rowCommodity !== commodity) continue;
    if (covered.has(countryCode)) continue;
    const production = finiteOrNull(Number(row?.production));
    if (production == null) continue;
    covered.add(countryCode);
    base.push({
      countryCode,
      commodity,
      marketingYear:
        formatMarketingYear(row?.marketingYear)
        || formatMarketingYear(row?.calendarYear)
        || fallbackYear,
      production,
      consumption: null,
      imports: null,
      exports: null,
      endingStocks: null,
      stocksToUseRatio: null,
      totalUse: 0,
      unit: PSD_COMMODITIES[commodity]?.unit ?? '1000 MT',
      source: 'faostat',
    });
  }
  return base;
}

export function computeCalorieWeightedStocksToUse(commodities) {
  if (!commodities || typeof commodities !== 'object') return null;
  let weighted = 0;
  let weight = 0;
  for (const [slug, rec] of Object.entries(commodities)) {
    const kcal = COMMODITY_KCAL_PER_KG[slug];
    const consumption = rec?.consumption;
    const ratio = rec?.stocksToUseRatio;
    if (!Number.isFinite(kcal) || !Number.isFinite(consumption) || consumption <= 0 || !Number.isFinite(ratio)) {
      continue;
    }
    const w = consumption * kcal;
    weighted += ratio * w;
    weight += w;
  }
  return weight > 0 ? weighted / weight : null;
}

export function toCommodityPayload(record) {
  return {
    marketingYear: record.marketingYear,
    production: record.production,
    consumption: record.consumption,
    imports: record.imports,
    exports: record.exports,
    endingStocks: record.endingStocks,
    stocksToUseRatio: record.stocksToUseRatio,
    // Denominator actually used for stocksToUseRatio. Persisted so the RPC does
    // not have to re-derive it — the world row excludes exports, so a consumer
    // recomputing `consumption + exports` would disagree with the ratio.
    totalUse: record.totalUse ?? computeTotalUse(
      record.consumption,
      record.exports,
      { excludeExports: record.countryCode === FOOD_STOCKS_WORLD_KEY },
    ),
    unit: record.unit,
    source: record.source,
  };
}

export function buildCountryRecord(countryCode, commodities) {
  return {
    countryCode,
    commodities,
    aggregate: {
      calorieWeightedStocksToUse: computeCalorieWeightedStocksToUse(commodities),
    },
  };
}

/**
 * Fold flat parser rows into the Redis snapshot: ISO-2 / `_world` →
 * `{ commodities, aggregate }`.
 *
 * @param {Array<Record<string, unknown>>} records
 */
export function assembleFoodStocksSnapshot(records) {
  /** @type {Map<string, Record<string, ReturnType<typeof toCommodityPayload>>>} */
  const byCountry = new Map();
  for (const rec of records) {
    const countryCode = normalizePsdCountryCode(rec.countryCode) || rec.countryCode;
    if (!countryCode || !rec.commodity || !rec.marketingYear) continue;
    if (!byCountry.has(countryCode)) byCountry.set(countryCode, {});
    const existing = byCountry.get(countryCode)[rec.commodity];
    if (!existing || String(rec.marketingYear) > String(existing.marketingYear)) {
      byCountry.get(countryCode)[rec.commodity] = toCommodityPayload(rec);
    }
  }

  /** @type {Record<string, ReturnType<typeof buildCountryRecord>>} */
  const snapshot = {};
  for (const [countryCode, commodities] of byCountry) {
    snapshot[countryCode] = buildCountryRecord(countryCode, commodities);
  }
  return snapshot;
}

// Marketing-year end per commodity as [monthIndex, day] of the ENDING year.
// A single hardcoded 31 Aug (the previous behavior) is right for corn/soybeans
// but ~30 days early for palm oil's Oct-Sep year, which under a min() reduction
// eats a third of the content-age budget and fires on a merely-late MY roll.
// Unknown slugs default to the latest end in the table so the clock never fires
// early on a commodity added without a matching entry.
const MARKETING_YEAR_END = {
  wheat: [4, 31], // Jun-May
  corn: [7, 31], // Sep-Aug
  rice: [6, 31], // Aug-Jul
  soybeans: [7, 31], // Sep-Aug
  barley: [4, 31], // Jun-May
  palmOil: [8, 30], // Oct-Sep
};
const DEFAULT_MARKETING_YEAR_END = [8, 30];

export function marketingYearEndMs(label, commoditySlug) {
  const start = parseMarketingYearStart(label);
  if (start == null) return null;
  const [month, day] = MARKETING_YEAR_END[commoditySlug] ?? DEFAULT_MARKETING_YEAR_END;
  return Date.UTC(start + 1, month, day, 23, 59, 59, 999);
}

/**
 * Oldest marketing-year end across the `_world` commodities.
 *
 * `_world` specifically, and reduced with min:
 *  - min, because six PSD commodity feeds freeze INDEPENDENTLY. A max() lets one
 *    still-updating commodity mask five dead ones — the exact failure
 *    docs/solutions/design-patterns/multi-source-freshness-clock-must-reduce-with-min.md
 *    describes ("which single upstream can stop publishing without changing
 *    newestItemAt?").
 *  - `_world` only, because it is provably PSD-sourced: applyFaostatProductionFill
 *    skips already-covered countries and resolveIso2 has no WORLD mapping, so no
 *    FAOSTAT row can normalize into it. FAOSTAT rows carry a marketing year
 *    derived from a CALENDAR year 1-3 years back, so reducing over the whole
 *    snapshot would report ~2 years of content age on perfectly healthy data.
 */
export function worldContentClock(snapshot, nowMs = Date.now()) {
  const world = snapshot?.[FOOD_STOCKS_WORLD_KEY]?.commodities
    ?? (snapshot?.commodities && !snapshot?.[FOOD_STOCKS_WORLD_KEY] ? snapshot.commodities : null);
  if (!world || typeof world !== 'object') return null;
  const nowYear = new Date(nowMs).getUTCFullYear();
  let oldestEnd = null;
  let counted = 0;
  for (const [slug, rec] of Object.entries(world)) {
    const start = parseMarketingYearStart(rec?.marketingYear);
    if (start == null) continue;
    // Plausibility guard on the START, not the end: a marketing year that is
    // currently RUNNING legitimately ends in the future, so rejecting any
    // future end would discard every healthy snapshot. Only a label starting
    // more than a year ahead of now is not a real PSD marketing year — drop it
    // rather than let it pin the clock.
    if (start > nowYear + 1) continue;
    const end = marketingYearEndMs(rec.marketingYear, slug);
    if (end == null) continue;
    counted += 1;
    if (oldestEnd == null || end < oldestEnd) oldestEnd = end;
  }
  return counted > 0 ? { oldestEnd, counted } : null;
}

/**
 * Content-age signal for runSeed. The clock is marketing-year presence, not the
 * seeder's fetchedAt, and it tracks the OLDEST world commodity so a single fresh
 * feed cannot mask a frozen one.
 *
 * Returning null fails CLOSED: runSeed still writes maxContentAgeMin with
 * newestItemAt null and health reads that as STALE_CONTENT.
 *
 * @param {Record<string, unknown>} data
 * @param {number} [nowMs]
 */
export function foodStocksContentMeta(data, nowMs = Date.now()) {
  // Implausible future labels are dropped inside worldContentClock; if that
  // leaves nothing datable we return null, which fails CLOSED (health reads a
  // null newestItemAt as STALE_CONTENT).
  const clock = worldContentClock(data, nowMs);
  if (!clock) return null;
  // A running marketing year clamps to now and reports age 0; an abandoned one
  // ages from its own end date.
  const newestItemAt = Math.min(clock.oldestEnd, nowMs);
  return { newestItemAt, oldestItemAt: newestItemAt };
}
