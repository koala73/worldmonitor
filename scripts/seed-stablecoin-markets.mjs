#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { loadEnvFile, loadSharedConfig, runSeed, fetchCoinPaprikaTickersById, coingeckoEndpoint, fetchCoinGeckoWithRetryBudget } from './_seed-utils.mjs';
// scripts/shared/ mirror (NOT ../shared/): this seeder deploys via Railway
// rootDirectory=scripts, where the repo-root shared/ folder does not exist.
// The mirror is byte-locked to shared/ by tests/scripts-shared-mirror.test.mjs.
import { classifyStablecoin } from './shared/stablecoin-classifier.cjs';

const stablecoinConfig = loadSharedConfig('stablecoins.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:stablecoins:v1';
const CACHE_TTL = 5400; // 90min — 1h buffer over 10min cron cadence (was 60min = 50min buffer)

const STABLECOIN_IDS = stablecoinConfig.ids.join(',');
const COINPAPRIKA_ID_MAP = stablecoinConfig.coinpaprika;
const COINPAPRIKA_IDS = stablecoinConfig.ids.map((id) => COINPAPRIKA_ID_MAP[id]).filter(Boolean);

export const REQUEST_TIMEOUT_MS = 15_000;
// Ceiling on the whole CoinGecko phase, in-flight request included. Sized so
// that this plus COINPAPRIKA_WORST_CASE_MS fits the bundle section timeout
// that SIGTERMs this seeder; tests/seed-fetch-budget.test.mjs gates that
// arithmetic against the manifest, so when it trips lower this rather than
// raise timeoutMs.
export const COINGECKO_RETRY_BUDGET_MS = 45_000;
// The fallback runs COINPAPRIKA_IDS in rounds of COINPAPRIKA_CONCURRENCY, each
// round bounded by one request timeout. Both values are passed to the helper
// explicitly so this derivation describes the call as made, and mapping a new
// stablecoin widens the budget instead of silently breaking the invariant.
const COINPAPRIKA_CONCURRENCY = 4;
export const COINPAPRIKA_WORST_CASE_MS = Math.ceil(COINPAPRIKA_IDS.length / COINPAPRIKA_CONCURRENCY) * REQUEST_TIMEOUT_MS;

async function fetchFromCoinGecko() {
  const { baseUrl, headers } = coingeckoEndpoint();
  const url = `${baseUrl}/coins/markets?vs_currency=usd&ids=${STABLECOIN_IDS}&order=market_cap_desc&sparkline=false&price_change_percentage=7d`;

  const resp = await fetchCoinGeckoWithRetryBudget(url, {
    headers,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    budgetMs: COINGECKO_RETRY_BUDGET_MS,
  });
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('CoinGecko returned no stablecoin data');
  }
  return data;
}

async function fetchFromCoinPaprika() {
  console.log('  [CoinPaprika] Falling back to CoinPaprika...');
  if (COINPAPRIKA_IDS.length === 0) throw new Error('No CoinPaprika ID mapping for stablecoins');

  const tickers = await fetchCoinPaprikaTickersById(COINPAPRIKA_IDS, {
    concurrency: COINPAPRIKA_CONCURRENCY,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const reverseMap = new Map(Object.entries(COINPAPRIKA_ID_MAP).map(([g, p]) => [p, g]));
  return tickers
    .map((t) => ({
      id: reverseMap.get(t.id) || t.id,
      current_price: t.quotes.USD.price,
      price_change_percentage_24h: t.quotes.USD.percent_change_24h,
      price_change_percentage_7d_in_currency: t.quotes.USD.percent_change_7d,
      market_cap: t.quotes.USD.market_cap,
      total_volume: t.quotes.USD.volume_24h,
      symbol: t.symbol.toLowerCase(),
      name: t.name,
      image: '',
    }));
}

export async function fetchStablecoinMarkets() {
  let data;
  try {
    data = await fetchFromCoinGecko();
  } catch (err) {
    console.warn(`  [CoinGecko] Failed: ${err.message}`);
    data = await fetchFromCoinPaprika();
  }

  // Shared with the relay's backup seeder and with the RPC handler, which
  // classifies coins this seed does not carry. Three producers shaping rows
  // with three private copies of this logic would let the same coin read a
  // different peg status from each path. (#6308, #6319)
  const stablecoins = data.map((coin) => classifyStablecoin(coin));

  const totalMarketCap = stablecoins.reduce((sum, c) => sum + c.marketCap, 0);
  const totalVolume24h = stablecoins.reduce((sum, c) => sum + c.volume24h, 0);
  const depeggedCount = stablecoins.filter((c) => c.pegStatus === 'DEPEGGED').length;

  return {
    timestamp: new Date().toISOString(),
    summary: {
      totalMarketCap,
      totalVolume24h,
      coinCount: stablecoins.length,
      depeggedCount,
      healthStatus: depeggedCount === 0 ? 'HEALTHY' : depeggedCount === 1 ? 'CAUTION' : 'WARNING',
    },
    stablecoins,
  };
}

function validate(data) {
  return (
    Array.isArray(data?.stablecoins) &&
    data.stablecoins.length >= 1 &&
    data.summary?.coinCount > 0
  );
}

export function declareRecords(data) {
  return Array.isArray(data?.stablecoins) ? data.stablecoins.length : 0;
}

// isMain guard — required so tests can `import` the budget exports without
// firing runSeed on module load (which would touch Redis and process.exit).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runSeed('market', 'stablecoins', CANONICAL_KEY, fetchStablecoinMarkets, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'coingecko-stablecoins',

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 60,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
