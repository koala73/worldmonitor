#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:crypto:v1';
const CACHE_TTL = 3600; // 1 hour

const CRYPTO_IDS = ['bitcoin', 'ethereum', 'solana', 'ripple'];
const CRYPTO_META = {
  bitcoin: { name: 'Bitcoin', symbol: 'BTC' },
  ethereum: { name: 'Ethereum', symbol: 'ETH' },
  solana: { name: 'Solana', symbol: 'SOL' },
  ripple: { name: 'XRP', symbol: 'XRP' },
};

async function fetchCryptoQuotes() {
  const ids = CRYPTO_IDS.join(',');
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=true&price_change_percentage=24h`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);

  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('CoinGecko returned no data');
  }

  const byId = new Map(data.map((c) => [c.id, c]));
  const quotes = [];

  for (const id of CRYPTO_IDS) {
    const coin = byId.get(id);
    if (!coin) continue;
    const meta = CRYPTO_META[id];
    const prices = coin.sparkline_in_7d?.price;
    const sparkline = prices && prices.length > 24 ? prices.slice(-48) : (prices || []);

    quotes.push({
      name: meta?.name || id,
      symbol: meta?.symbol || id.toUpperCase(),
      price: coin.current_price ?? 0,
      change: coin.price_change_percentage_24h ?? 0,
      sparkline,
    });
  }

  if (quotes.every((q) => q.price === 0)) {
    throw new Error('CoinGecko returned all-zero prices');
  }

  return { quotes };
}

function validate(data) {
  return (
    Array.isArray(data?.quotes) &&
    data.quotes.length >= 1 &&
    data.quotes.some((q) => q.price > 0)
  );
}

runSeed('market', 'crypto', CANONICAL_KEY, fetchCryptoQuotes, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'coingecko-markets',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
