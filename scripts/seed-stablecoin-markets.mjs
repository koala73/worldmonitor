#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';

const stablecoinConfig = loadSharedConfig('stablecoins.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:stablecoins:v1';
const CACHE_TTL = 5400; // 90min — 1h buffer over 10min cron cadence (was 60min = 50min buffer)

const STABLECOIN_IDS = stablecoinConfig.ids.join(',');

async function fetchWithRateLimitRetry(url, maxAttempts = 5, headers = { Accept: 'application/json', 'User-Agent': CHROME_UA }) {
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 429) {
      const wait = Math.min(10_000 * (i + 1), 60_000);
      console.warn(`  CoinGecko 429 — waiting ${wait / 1000}s (attempt ${i + 1}/${maxAttempts})`);
      await sleep(wait);
      continue;
    }
    if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
    return resp;
  }
  throw new Error('CoinGecko rate limit exceeded after retries');
}

const COINPAPRIKA_ID_MAP = stablecoinConfig.coinpaprika;

async function fetchFromCoinGecko() {
  const apiKey = process.env.COINGECKO_API_KEY;
  const baseUrl = apiKey
    ? 'https://pro-api.coingecko.com/api/v3'
    : 'https://api.coingecko.com/api/v3';
  const url = `${baseUrl}/coins/markets?vs_currency=usd&ids=${STABLECOIN_IDS}&order=market_cap_desc&sparkline=false&price_change_percentage=7d`;
  const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

  const resp = await fetchWithRateLimitRetry(url, 5, headers);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('CoinGecko returned no stablecoin data');
  }
  return data;
}

async function fetchFromCoinPaprika() {
  console.log('  [CoinPaprika] Falling back to CoinPaprika...');
  const ids = STABLECOIN_IDS.split(',');
  const paprikaIds = new Set(ids.map((id) => COINPAPRIKA_ID_MAP[id]).filter(Boolean));
  if (paprikaIds.size === 0) throw new Error('No CoinPaprika ID mapping for stablecoins');

  const resp = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD', {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`CoinPaprika HTTP ${resp.status}`);
  const allTickers = await resp.json();
  const reverseMap = new Map(Object.entries(COINPAPRIKA_ID_MAP).map(([g, p]) => [p, g]));
  return allTickers
    .filter((t) => paprikaIds.has(t.id))
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

async function fetchStablecoinMarkets() {
  let data;
  try {
    data = await fetchFromCoinGecko();
  } catch (err) {
    console.warn(`  [CoinGecko] Failed: ${err.message}`);
    data = await fetchFromCoinPaprika();
  }

  const stablecoins = data.map((coin) => {
    const price = coin.current_price || 0;
    const deviation = Math.abs(price - 1.0);
    let pegStatus;
    if (deviation <= 0.005) pegStatus = 'ON PEG';
    else if (deviation <= 0.01) pegStatus = 'SLIGHT DEPEG';
    else pegStatus = 'DEPEGGED';

    return {
      id: coin.id,
      symbol: (coin.symbol || '').toUpperCase(),
      name: coin.name,
      price,
      deviation: +(deviation * 100).toFixed(3),
      pegStatus,
      marketCap: coin.market_cap || 0,
      volume24h: coin.total_volume || 0,
      change24h: coin.price_change_percentage_24h || 0,
      change7d: coin.price_change_percentage_7d_in_currency || 0,
      image: coin.image || '',
    };
  });

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

runSeed('market', 'stablecoins', CANONICAL_KEY, fetchStablecoinMarkets, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'coingecko-stablecoins',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
