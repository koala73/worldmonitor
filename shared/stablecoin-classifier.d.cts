// Type declarations for shared/stablecoin-classifier.cjs.
//
// The return shape matches the generated `Stablecoin` message
// (src/generated/server/worldmonitor/market/v1/service_server.ts) field for
// field — the classifier is what produces the rows that message describes,
// both in the Redis snapshot and in RPC gap lookups.

/** CoinGecko /coins/markets row shape (CoinPaprika rows are pre-mapped to it). */
export interface StablecoinProviderRow {
  id: string;
  symbol?: unknown;
  name?: unknown;
  image?: unknown;
  current_price?: unknown;
  market_cap?: unknown;
  total_volume?: unknown;
  price_change_percentage_24h?: unknown;
  price_change_percentage_7d_in_currency?: unknown;
}

export interface StablecoinPegThresholds {
  onPegMaxDeviation: number;
  slightDepegMaxDeviation: number;
}

export interface ClassifiedStablecoin {
  id: string;
  symbol: string;
  name: string;
  price: number;
  deviation: number;
  pegStatus: string;
  marketCap: number;
  volume24h: number;
  change24h: number;
  change7d: number;
  image: string;
}

export function classifyStablecoin(
  row: StablecoinProviderRow,
  thresholds?: StablecoinPegThresholds,
): ClassifiedStablecoin;
