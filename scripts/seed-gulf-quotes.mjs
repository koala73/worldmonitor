#!/usr/bin/env node

import { loadEnvFile, loadSharedConfig, runSeed, sleep } from './_seed-utils.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';
import { fetchAvPhysicalCommodity, fetchAvFxDaily } from './_shared-av.mjs';

const gulfConfig = loadSharedConfig('gulf.json');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:gulf-quotes:v1';
const CACHE_TTL = 5400; // 90min — 1h buffer over 10min cron cadence (was 60min = 50min buffer)
const YAHOO_DELAY_MS = 200;

const GULF_SYMBOLS = gulfConfig.symbols;

function parseYahooChart(data, meta) {
  const result = data?.chart?.result?.[0];
  const chartMeta = result?.meta;
  if (!chartMeta) return null;

  const price = chartMeta.regularMarketPrice;
  const prevClose = chartMeta.chartPreviousClose || chartMeta.previousClose || price;
  const change = ((price - prevClose) / prevClose) * 100;

  const closes = result.indicators?.quote?.[0]?.close;
  const sparkline = (closes || []).filter((v) => v != null);

  return {
    symbol: meta.symbol,
    name: meta.name,
    country: meta.country,
    flag: meta.flag,
    type: meta.type,
    price,
    change: +change.toFixed(2),
    sparkline,
  };
}

async function fetchGulfQuotes() {
  const quotes = [];
  let misses = 0;
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;
  const covered = new Set();

  // --- Primary: Alpha Vantage ---
  if (avKey) {
    for (const meta of GULF_SYMBOLS) {
      if (meta.type === 'oil') {
        const q = await fetchAvPhysicalCommodity(meta.symbol, avKey);
        if (q) {
          quotes.push({ symbol: meta.symbol, name: meta.name, country: meta.country, flag: meta.flag, type: meta.type, price: q.price, change: +q.change.toFixed(2), sparkline: q.sparkline });
          covered.add(meta.symbol);
          console.log(`  [AV:physical] ${meta.symbol}: $${q.price} (${q.change > 0 ? '+' : ''}${q.change.toFixed(2)}%)`);
        }
      } else if (meta.type === 'currency') {
        const fromCurrency = meta.symbol.replace('USD=X', ''); // 'SARUSD=X' → 'SAR'
        const q = await fetchAvFxDaily(fromCurrency, avKey);
        if (q) {
          quotes.push({ symbol: meta.symbol, name: meta.name, country: meta.country, flag: meta.flag, type: meta.type, price: q.price, change: +q.change.toFixed(2), sparkline: q.sparkline });
          covered.add(meta.symbol);
          console.log(`  [AV:fx] ${meta.symbol}: ${q.price} (${q.change > 0 ? '+' : ''}${q.change.toFixed(2)}%)`);
        }
      }
      // type === 'index' → no AV equivalent, falls through to Yahoo
    }
  }

  // --- Fallback: Yahoo (for indices and any AV misses) ---
  let yahooIdx = 0;
  for (let i = 0; i < GULF_SYMBOLS.length; i++) {
    const meta = GULF_SYMBOLS[i];
    if (covered.has(meta.symbol)) continue;
    if (yahooIdx > 0) await sleep(YAHOO_DELAY_MS);
    yahooIdx++;

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(meta.symbol)}`;
      let chart;
      try {
        chart = await fetchYahooJson(url, { label: meta.symbol });
      } catch {
        misses++;
        continue;
      }
      const parsed = parseYahooChart(chart, meta);
      if (parsed) {
        quotes.push(parsed);
        covered.add(meta.symbol);
        console.log(`  [Yahoo] ${meta.symbol}: $${parsed.price} (${parsed.change > 0 ? '+' : ''}${parsed.change}%)`);
      } else {
        misses++;
      }
    } catch (err) {
      console.warn(`  [Yahoo] ${meta.symbol} error: ${err.message}`);
      misses++;
    }
  }

  if (quotes.length === 0) {
    throw new Error(`All Gulf quote fetches failed (${misses} misses)`);
  }

  return { quotes, rateLimited: false };
}

function validate(data) {
  return Array.isArray(data?.quotes) && data.quotes.length >= 1;
}

export function declareRecords(data) {
  return Array.isArray(data?.quotes) ? data.quotes.length : 0;
}

runSeed('market', 'gulf-quotes', CANONICAL_KEY, fetchGulfQuotes, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'alphavantage+yahoo-chart',

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 30,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
