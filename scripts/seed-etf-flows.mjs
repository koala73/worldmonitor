#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:etf-flows:v1';
const CACHE_TTL = 3600;
const YAHOO_DELAY_MS = 200;

const ETF_LIST = [
  { ticker: 'IBIT', issuer: 'BlackRock' },
  { ticker: 'FBTC', issuer: 'Fidelity' },
  { ticker: 'ARKB', issuer: 'ARK/21Shares' },
  { ticker: 'BITB', issuer: 'Bitwise' },
  { ticker: 'GBTC', issuer: 'Grayscale' },
  { ticker: 'HODL', issuer: 'VanEck' },
  { ticker: 'BRRR', issuer: 'Valkyrie' },
  { ticker: 'EZBC', issuer: 'Franklin' },
  { ticker: 'BTCO', issuer: 'Invesco' },
  { ticker: 'BTCW', issuer: 'WisdomTree' },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseEtfChartData(chart, ticker, issuer) {
  const result = chart?.chart?.result?.[0];
  if (!result) return null;

  const quote = result.indicators?.quote?.[0];
  const closes = quote?.close || [];
  const volumes = quote?.volume || [];

  const validCloses = closes.filter((p) => p != null);
  const validVolumes = volumes.filter((v) => v != null);

  if (validCloses.length < 2) return null;

  const latestPrice = validCloses[validCloses.length - 1];
  const prevPrice = validCloses[validCloses.length - 2];
  const priceChange = prevPrice ? ((latestPrice - prevPrice) / prevPrice) * 100 : 0;

  const latestVolume = validVolumes.length > 0 ? validVolumes[validVolumes.length - 1] : 0;
  const avgVolume =
    validVolumes.length > 1
      ? validVolumes.slice(0, -1).reduce((a, b) => a + b, 0) / (validVolumes.length - 1)
      : latestVolume;

  const volumeRatio = avgVolume > 0 ? latestVolume / avgVolume : 1;
  const direction = priceChange > 0.1 ? 'inflow' : priceChange < -0.1 ? 'outflow' : 'neutral';
  const estFlowMagnitude = latestVolume * latestPrice * (priceChange > 0 ? 1 : -1) * 0.1;

  return {
    ticker,
    issuer,
    price: +latestPrice.toFixed(2),
    priceChange: +priceChange.toFixed(2),
    volume: latestVolume,
    avgVolume: Math.round(avgVolume),
    volumeRatio: +volumeRatio.toFixed(2),
    direction,
    estFlow: Math.round(estFlowMagnitude),
  };
}

async function fetchEtfFlows() {
  const etfs = [];
  let misses = 0;

  for (let i = 0; i < ETF_LIST.length; i++) {
    const { ticker, issuer } = ETF_LIST[i];
    if (i > 0) await sleep(YAHOO_DELAY_MS);

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5d&interval=1d`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        console.warn(`  [Yahoo] ${ticker} HTTP ${resp.status}`);
        misses++;
        continue;
      }
      const chart = await resp.json();
      const parsed = parseEtfChartData(chart, ticker, issuer);
      if (parsed) {
        etfs.push(parsed);
        console.log(`  ${ticker}: $${parsed.price} (${parsed.direction})`);
      } else {
        misses++;
      }
    } catch (err) {
      console.warn(`  [Yahoo] ${ticker} error: ${err.message}`);
      misses++;
    }

    if (misses >= 3 && etfs.length === 0) break;
  }

  if (etfs.length === 0) {
    throw new Error(`All ETF fetches failed (${misses} misses)`);
  }

  const totalVolume = etfs.reduce((sum, e) => sum + e.volume, 0);
  const totalEstFlow = etfs.reduce((sum, e) => sum + e.estFlow, 0);
  const inflowCount = etfs.filter((e) => e.direction === 'inflow').length;
  const outflowCount = etfs.filter((e) => e.direction === 'outflow').length;

  etfs.sort((a, b) => b.volume - a.volume);

  return {
    timestamp: new Date().toISOString(),
    summary: {
      etfCount: etfs.length,
      totalVolume,
      totalEstFlow,
      netDirection: totalEstFlow > 0 ? 'NET INFLOW' : totalEstFlow < 0 ? 'NET OUTFLOW' : 'NEUTRAL',
      inflowCount,
      outflowCount,
    },
    etfs,
    rateLimited: false,
  };
}

function validate(data) {
  return Array.isArray(data?.etfs) && data.etfs.length >= 1;
}

runSeed('market', 'etf-flows', CANONICAL_KEY, fetchEtfFlows, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'yahoo-chart-5d',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
