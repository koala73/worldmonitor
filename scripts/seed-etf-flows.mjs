#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, runSeed } from './_seed-utils.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';
import { fetchAvBulkQuotes } from './_shared-av.mjs';

const etfConfig = loadSharedConfig('etfs.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:etf-flows:v1';
const CACHE_TTL = 5400; // 90min — 1h buffer over 15min cron cadence (was 60min = 45min buffer)
const YAHOO_DELAY_MS = 200;

const ETF_LIST = etfConfig.btcSpot;

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
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;
  const covered = new Set();

  // --- Primary: Alpha Vantage REALTIME_BULK_QUOTES ---
  if (avKey) {
    const tickers = ETF_LIST.map(e => e.ticker);
    const avData = await fetchAvBulkQuotes(tickers, avKey);
    for (const { ticker, issuer } of ETF_LIST) {
      const av = avData.get(ticker);
      if (!av) continue;
      const { price, change: priceChange, volume } = av;
      const direction = priceChange > 0.1 ? 'inflow' : priceChange < -0.1 ? 'outflow' : 'neutral';
      const estFlow = Math.round(volume * price * (priceChange > 0 ? 1 : -1) * 0.1);
      // avgVolume and volumeRatio require 5-day history not available from REALTIME_BULK_QUOTES
      etfs.push({ ticker, issuer, price: +price.toFixed(2), priceChange: +priceChange.toFixed(2), volume, avgVolume: 0, volumeRatio: 0, direction, estFlow });
      covered.add(ticker);
      console.log(`  [AV] ${ticker}: $${price.toFixed(2)} (${direction})`);
    }
  }

  // --- Fallback: Yahoo (for any ETFs not covered by AV) ---
  let yahooIdx = 0;
  for (let i = 0; i < ETF_LIST.length; i++) {
    const { ticker, issuer } = ETF_LIST[i];
    if (covered.has(ticker)) continue;
    if (yahooIdx > 0) await sleep(YAHOO_DELAY_MS);
    yahooIdx++;

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5d&interval=1d`;
      let chart;
      try {
        chart = await fetchYahooJson(url, { label: ticker });
      } catch {
        misses++;
        continue;
      }
      const parsed = parseEtfChartData(chart, ticker, issuer);
      if (parsed) {
        etfs.push(parsed);
        covered.add(ticker);
        console.log(`  [Yahoo] ${ticker}: $${parsed.price} (${parsed.direction})`);
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

export function declareRecords(data) {
  return Array.isArray(data?.etfs) ? data.etfs.length : 0;
}

runSeed('market', 'etf-flows', CANONICAL_KEY, fetchEtfFlows, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'alphavantage+yahoo-chart-5d',

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 60,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
