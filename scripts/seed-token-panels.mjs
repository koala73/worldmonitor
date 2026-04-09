#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';

const defiConfig = loadSharedConfig('defi-tokens.json');
const aiConfig = loadSharedConfig('ai-tokens.json');
const otherConfig = loadSharedConfig('other-tokens.json');

loadEnvFile(import.meta.url);

const DEFI_KEY = 'market:defi-tokens:v1';
const AI_KEY = 'market:ai-tokens:v1';
const OTHER_KEY = 'market:other-tokens:v1';
const CACHE_TTL = 5400; // 90min — 1h buffer over 30min cron cadence (was 60min = 30min buffer)

const ALL_IDS = [...new Set([...defiConfig.ids, ...aiConfig.ids, ...otherConfig.ids])];
const COINPAPRIKA_ID_MAP = { ...defiConfig.coinpaprika, ...aiConfig.coinpaprika, ...otherConfig.coinpaprika };

async function fetchWithRateLimitRetry(url, maxAttempts = 5, headers = { Accept: 'application/json', 'User-Agent': CHROME_UA }) {
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
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

async function fetchFromCoinGecko() {
  const apiKey = process.env.COINGECKO_API_KEY;
  const baseUrl = apiKey ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
  const url = `${baseUrl}/coins/markets?vs_currency=usd&ids=${ALL_IDS.join(',')}&order=market_cap_desc&sparkline=false&price_change_percentage=24h,7d`;
  const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

  const resp = await fetchWithRateLimitRetry(url, 5, headers);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error('CoinGecko returned no data');
  return data;
}

async function fetchFromCoinPaprika() {
  console.log('  [CoinPaprika] Falling back to CoinPaprika...');
  const resp = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD', {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`CoinPaprika HTTP ${resp.status}`);
  const allTickers = await resp.json();
  const paprikaIds = new Set(ALL_IDS.map((id) => COINPAPRIKA_ID_MAP[id]).filter(Boolean));
  const reverseMap = new Map(Object.entries(COINPAPRIKA_ID_MAP).map(([g, p]) => [p, g]));
  return allTickers
    .filter((t) => paprikaIds.has(t.id))
    .map((t) => ({
      id: reverseMap.get(t.id) || t.id,
      current_price: t.quotes.USD.price,
      price_change_percentage_24h: t.quotes.USD.percent_change_24h,
      price_change_percentage_7d_in_currency: t.quotes.USD.percent_change_7d,
      symbol: t.symbol.toLowerCase(),
      name: t.name,
    }));
}

function mapTokens(ids, meta, byId) {
  const tokens = [];
  for (const id of ids) {
    const coin = byId.get(id);
    if (!coin) continue;
    const m = meta[id];
    tokens.push({
      name: m?.name || coin.name || id,
      symbol: m?.symbol || (coin.symbol || id).toUpperCase(),
      price: coin.current_price ?? 0,
      change24h: coin.price_change_percentage_24h ?? 0,
      change7d: coin.price_change_percentage_7d_in_currency ?? 0,
    });
  }
  return tokens;
}

async function fetchTokenPanels() {
  let raw;
  try {
    raw = await fetchFromCoinGecko();
  } catch (err) {
    console.warn(`  [CoinGecko] Failed: ${err.message}`);
    raw = await fetchFromCoinPaprika();
  }

  const byId = new Map(raw.map((c) => [c.id, c]));
  const defi = { tokens: mapTokens(defiConfig.ids, defiConfig.meta, byId) };
  const ai = { tokens: mapTokens(aiConfig.ids, aiConfig.meta, byId) };
  const other = { tokens: mapTokens(otherConfig.ids, otherConfig.meta, byId) };
  const total = defi.tokens.length + ai.tokens.length + other.tokens.length;

  if (total === 0) throw new Error('All token panels returned empty');

  return { defi, ai, other, total };
}

function validate(data) {
  return (
    Array.isArray(data?.defi?.tokens) &&
    data.defi.tokens.length >= 1 &&
    (data.defi.tokens.some((t) => t.price > 0) ||
      data.ai.tokens.some((t) => t.price > 0) ||
      data.other.tokens.some((t) => t.price > 0))
  );
}

runSeed('market', 'token-panels', DEFI_KEY, fetchTokenPanels, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'coingecko-paprika-fallback',
  recordCount: (data) => data.total,
  publishTransform: (data) => data.defi,
  extraKeys: [
    { key: AI_KEY, transform: (data) => data.ai, ttl: CACHE_TTL },
    { key: OTHER_KEY, transform: (data) => data.other, ttl: CACHE_TTL },
  ],
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
