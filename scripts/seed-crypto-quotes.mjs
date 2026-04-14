#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';

const cryptoConfig = loadSharedConfig('crypto.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:crypto:v1';
const CACHE_TTL = 7200; // 2h — 1h buffer over 5min cron cadence (was 60min = 55min buffer)

const CRYPTO_IDS = cryptoConfig.ids;
const CRYPTO_META = cryptoConfig.meta;

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

const COINPAPRIKA_ID_MAP = cryptoConfig.coinpaprika;

async function fetchFromCoinGecko() {
  const ids = CRYPTO_IDS.join(',');
  const apiKey = process.env.COINGECKO_API_KEY;
  const baseUrl = apiKey
    ? 'https://pro-api.coingecko.com/api/v3'
    : 'https://api.coingecko.com/api/v3';
  const url = `${baseUrl}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=true&price_change_percentage=24h`;
  const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

  // Capped at 2 attempts (10+20=30s budget) so the fallback path itself
  // cannot recreate the 150s>120s bundle-timeout overrun this PR fixes.
  // CoinGecko's free-tier 429s are exactly why CoinPaprika is now primary;
  // a long retry budget here would just defer the same failure mode.
  const resp = await fetchWithRateLimitRetry(url, 2, headers);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('CoinGecko returned no data');
  }
  return data;
}

async function fetchFromCoinPaprika() {
  console.log('  [CoinPaprika] Fetching tickers...');
  const resp = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD', {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`CoinPaprika HTTP ${resp.status}`);
  const allTickers = await resp.json();
  const paprikaIds = new Set(CRYPTO_IDS.map((id) => COINPAPRIKA_ID_MAP[id]).filter(Boolean));
  const reverseMap = new Map(Object.entries(COINPAPRIKA_ID_MAP).map(([g, p]) => [p, g]));
  return allTickers
    .filter((t) => paprikaIds.has(t.id))
    .map((t) => ({
      id: reverseMap.get(t.id) || t.id,
      current_price: t.quotes.USD.price,
      price_change_percentage_24h: t.quotes.USD.percent_change_24h,
      sparkline_in_7d: undefined,
      symbol: t.symbol.toLowerCase(),
      name: t.name,
    }));
}

async function fetchCryptoQuotes() {
  // CoinPaprika is the PRIMARY source — CoinGecko's free tier 429s frequently
  // and its 5-step retry budget (10+20+30+40+50=150s) overruns the bundle's
  // 120s timeout, killing the section before the fallback can fire (Railway
  // bundle log 2026-04-14 07:17 UTC). CoinGecko is retained as fallback for
  // its sparkline_in_7d data, which CoinPaprika does not provide.
  let data;
  try {
    data = await fetchFromCoinPaprika();
  } catch (err) {
    console.warn(`  [CoinPaprika] Failed: ${err.message} — falling back to CoinGecko`);
    data = await fetchFromCoinGecko();
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
    throw new Error('All sources returned all-zero prices');
  }

  return { quotes };
}

/**
 * Require full coverage of the configured CRYPTO_IDS set with positive prices.
 *
 * On a fixed-cardinality top-N feed, accepting partial snapshots (e.g. 9/10)
 * is silent data loss — health stays green while one tracked asset
 * disappears from the panel. If CoinPaprika drops or renames a mapped
 * ticker, this validator forces the seeder to fail loudly so the broken
 * mapping is caught at the next cycle instead of weeks later.
 */
function validate(data) {
  if (!Array.isArray(data?.quotes)) return false;
  if (data.quotes.length !== CRYPTO_IDS.length) return false;
  if (!data.quotes.every((q) => Number.isFinite(q?.price) && q.price > 0)) return false;
  // Verify every configured ID is represented (defends against duplicate
  // IDs masquerading as full coverage).
  const expected = new Set(CRYPTO_IDS.map((id) => CRYPTO_META[id]?.symbol || id.toUpperCase()));
  const actual = new Set(data.quotes.map((q) => q.symbol));
  for (const sym of expected) {
    if (!actual.has(sym)) return false;
  }
  return true;
}

runSeed('market', 'crypto', CANONICAL_KEY, fetchCryptoQuotes, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'coinpaprika-tickers+coingecko-fallback',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
