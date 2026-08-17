// The ONE deviation → peg-status mapping and provider-row shaping for
// `market:stablecoins:v1`, shared by all three writers of that key:
//
//   - scripts/ais-relay.cjs            (backup seeder, CJS: requireShared)
//   - scripts/seed-stablecoin-markets.mjs (primary seeder, ESM: static import
//     of the scripts/shared/ mirror)
//   - server/worldmonitor/market/v1/list-stablecoin-markets.ts (gap lookups,
//     TS: sibling .d.cts carries the types)
//
// #6308 unified the threshold NUMBERS into stablecoins.json; this module
// unifies the logic that applies them (#6319). The two seeders write the SAME
// Redis key, so a private variant here means the stored value depends on
// which writer ran last.
//
// CJS deliberately: require()-able from the relay, importable from ESM via
// Node's CJS named-export detection, and bundleable from TS. Mirrored
// byte-for-byte at scripts/shared/stablecoin-classifier.cjs for the Railway
// rootDirectory=scripts deploys (locked by tests/scripts-shared-mirror.test.mjs).

// Sibling resolution works in BOTH homes: shared/stablecoins.json and
// scripts/shared/stablecoins.json are themselves mirror-locked.
const { pegThresholds: DEFAULT_PEG_THRESHOLDS } = require('./stablecoins.json');

// Provider numerics arrive as JSON of unknown shape; a string or missing
// price must not become NaN in the stored payload.
function toFiniteNumber(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Shape one CoinGecko-format market row (CoinPaprika rows are pre-mapped to
 * this format by both seeders) into the stablecoin object stored in
 * `market:stablecoins:v1` and returned by ListStablecoinMarkets.
 *
 * `deviation` is stored as a percentage rounded to 3 decimals; `pegStatus`
 * compares the RAW deviation against the thresholds, so rounding can never
 * move a coin across a peg boundary.
 */
function classifyStablecoin(row, thresholds = DEFAULT_PEG_THRESHOLDS) {
  const price = toFiniteNumber(row.current_price);
  const deviation = Math.abs(price - 1.0);
  return {
    id: row.id,
    symbol: String(row.symbol || '').toUpperCase(),
    name: String(row.name || ''),
    price,
    deviation: +(deviation * 100).toFixed(3),
    pegStatus: deviation <= thresholds.onPegMaxDeviation
      ? 'ON PEG'
      : deviation <= thresholds.slightDepegMaxDeviation
        ? 'SLIGHT DEPEG'
        : 'DEPEGGED',
    marketCap: toFiniteNumber(row.market_cap),
    volume24h: toFiniteNumber(row.total_volume),
    change24h: toFiniteNumber(row.price_change_percentage_24h),
    change7d: toFiniteNumber(row.price_change_percentage_7d_in_currency),
    image: String(row.image || ''),
  };
}

module.exports = { classifyStablecoin };
