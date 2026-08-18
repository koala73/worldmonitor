#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { loadEnvFile, runSeed, sleep as defaultSleep } from './_seed-utils.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';

const MARKET_CORRELATION_KEY = 'market:correlation-series:v1';
const MARKET_CORRELATION_TTL = 7 * 24 * 60 * 60;
const YAHOO_DELAY_MS = 150;

export const MARKET_CORRELATION_SERIES = Object.freeze([
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^IXIC', label: 'Nasdaq Composite' },
  { symbol: 'BTC-USD', label: 'Bitcoin' },
  { symbol: 'ETH-USD', label: 'Ethereum' },
  { symbol: 'GC=F', label: 'Gold' },
  { symbol: 'CL=F', label: 'WTI Crude' },
]);

export function normalizeYahooSeries(symbol, label, payload) {
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) return null;

  const points = [];
  const length = Math.min(timestamps.length, closes.length);
  for (let i = 0; i < length; i += 1) {
    const seconds = Number(timestamps[i]);
    const value = Number(closes[i]);
    if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(value) || value <= 0) continue;
    points.push({
      timestamp: new Date(seconds * 1000).toISOString(),
      value,
    });
  }

  return points.length > 0 ? { symbol, label, points } : null;
}

export async function fetchMarketCorrelationSeries({
  markets = MARKET_CORRELATION_SERIES,
  fetchJson = fetchYahooJson,
  sleep = defaultSleep,
  now = () => new Date(),
} = {}) {
  const series = [];
  const failures = [];

  for (let i = 0; i < markets.length; i += 1) {
    const market = markets[i];
    if (i > 0) await sleep(YAHOO_DELAY_MS);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(market.symbol)}?range=14d&interval=1h&includePrePost=false&events=div%2Csplits`;
    try {
      const payload = await fetchJson(url, {
        label: market.symbol,
        timeoutMs: 15_000,
        maxRetries: 0,
      });
      const normalized = normalizeYahooSeries(market.symbol, market.label, payload);
      if (!normalized) throw new Error('empty or malformed chart');
      series.push(normalized);
      console.log(`  ${market.symbol}: ${normalized.points.length} timestamped hourly closes`);
    } catch (error) {
      failures.push({ symbol: market.symbol, reason: 'upstream-unavailable' });
      console.warn(`  ${market.symbol}: unavailable (${error?.message || error})`);
    }
  }

  if (series.length === 0) {
    throw new Error('All market correlation series fetches failed');
  }

  return {
    updatedAt: now().toISOString(),
    range: '14d',
    interval: '1h',
    series,
    failures,
  };
}

export function declareRecords(data) {
  return Array.isArray(data?.series)
    ? data.series.filter((item) => Array.isArray(item?.points) && item.points.length > 0).length
    : 0;
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  loadEnvFile(import.meta.url);
  runSeed('market', 'correlation-series', MARKET_CORRELATION_KEY, fetchMarketCorrelationSeries, {
    ttlSeconds: MARKET_CORRELATION_TTL,
    validateFn: (data) => Array.isArray(data?.series) && data.series.length > 0 && declareRecords(data) > 0,
    declareRecords,
    schemaVersion: 1,
    sourceVersion: 'yahoo-hourly-correlation-v1',
    maxStaleMin: 45,
  }).catch((error) => {
    console.error('FATAL:', error?.message || error);
    process.exit(1);
  });
}
