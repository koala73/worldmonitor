#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';

const sectorsConfig = loadSharedConfig('crypto-sectors.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:crypto-sectors:v1';
const CACHE_TTL = 3600;

const SECTORS = sectorsConfig.sectors;

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

async function fetchSectorData() {
  const allIds = [...new Set(SECTORS.flatMap(s => s.tokens))];

  const apiKey = process.env.COINGECKO_API_KEY;
  const baseUrl = apiKey ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
  const url = `${baseUrl}/coins/markets?vs_currency=usd&ids=${allIds.join(',')}&order=market_cap_desc&sparkline=false&price_change_percentage=24h`;
  const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

  const resp = await fetchWithRateLimitRetry(url, 5, headers);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error('CoinGecko returned no data');

  const byId = new Map(data.map(c => [c.id, c.price_change_percentage_24h]));

  const sectors = SECTORS.map(sector => {
    const changes = sector.tokens
      .map(id => byId.get(id))
      .filter(v => typeof v === 'number' && isFinite(v));
    const change = changes.length > 0 ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
    return { id: sector.id, name: sector.name, change };
  });

  return { sectors };
}

function validate(data) {
  return Array.isArray(data?.sectors) && data.sectors.length > 0;
}

runSeed('market', 'crypto-sectors', CANONICAL_KEY, fetchSectorData, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'coingecko-sectors',
}).catch(err => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
