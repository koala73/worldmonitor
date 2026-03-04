#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:stablecoins:v1';
const CACHE_TTL = 3600; // 1 hour

const STABLECOIN_IDS = 'tether,usd-coin,dai,first-digital-usd,ethena-usde';

async function fetchStablecoinMarkets() {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${STABLECOIN_IDS}&order=market_cap_desc&sparkline=false&price_change_percentage=7d`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);

  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('CoinGecko returned no stablecoin data');
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
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
