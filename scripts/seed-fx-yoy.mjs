#!/usr/bin/env node

/**
 * Wider-coverage FX year-over-year + peak-to-trough drawdown seed.
 *
 * Yahoo Finance historical chart API (range=2y, interval=1mo) per currency.
 * For each currency we compute:
 *   - yoyChange:    % change between the bar 12 months ago and the latest
 *   - drawdown24m:  worst peak-to-trough % loss over the last 24 monthly bars
 *
 * Why both: a rolling 12-month window slices through the middle of historic
 * crises (Egypt's March 2024 devaluation, Nigeria's June 2023 devaluation
 * etc. all fall outside an April→April YoY window by 2026). The 24-month
 * peak-to-trough signal captures the actual crisis magnitude even when the
 * crisis anniversary has passed.
 *
 * Why this exists: BIS WS_EER (`economic:bis:eer:v1`) only covers 12 G10 +
 * select EM economies — none of which experience the FX moves the resilience
 * methodology's FX Stress family actually targets (Argentina, Egypt, Turkey,
 * Pakistan, Nigeria, etc. are absent from BIS coverage). Yahoo Finance
 * covers the full set of currencies needed for this signal.
 *
 * Output key `economic:fx:yoy:v1` shape:
 *   {
 *     rates: [
 *       { countryCode: "AR", currency: "ARS",
 *         currentRate, yearAgoRate, yoyChange,
 *         drawdown24m, peakRate, peakDate, troughRate, troughDate,
 *         asOf, yearAgo },
 *       ...
 *     ],
 *     fetchedAt: "<iso>",
 *   }
 *
 * Railway: deploy as cron service running daily (e.g. `30 6 * * *`),
 * NIXPACKS builder, startCommand `node scripts/seed-fx-yoy.mjs`.
 */

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:fx:yoy:v1';
const CACHE_TTL = 25 * 3600; // 25h covers a daily cron + 1h drift buffer

// Currency → primary ISO2 country. Multi-country currencies (EUR, XOF, XAF,
// XCD, XPF) are intentionally omitted because shared-currency depreciation
// shouldn't flag any individual member as country-specific FX stress.
const CURRENCY_COUNTRY = {
  // Americas
  CAD: 'CA', MXN: 'MX', BRL: 'BR', ARS: 'AR', COP: 'CO', CLP: 'CL',
  // Europe (non-EUR)
  GBP: 'GB', CHF: 'CH', NOK: 'NO', SEK: 'SE', DKK: 'DK',
  PLN: 'PL', CZK: 'CZ', HUF: 'HU', RON: 'RO', UAH: 'UA',
  // Asia-Pacific
  CNY: 'CN', JPY: 'JP', KRW: 'KR', AUD: 'AU', NZD: 'NZ',
  SGD: 'SG', HKD: 'HK', TWD: 'TW', THB: 'TH', MYR: 'MY',
  IDR: 'ID', PHP: 'PH', VND: 'VN', INR: 'IN', PKR: 'PK',
  // Middle East
  AED: 'AE', SAR: 'SA', QAR: 'QA', KWD: 'KW', BHD: 'BH',
  OMR: 'OM', JOD: 'JO', EGP: 'EG', LBP: 'LB', ILS: 'IL',
  TRY: 'TR',
  // Africa
  ZAR: 'ZA', NGN: 'NG', KES: 'KE',
};

const FETCH_TIMEOUT_MS = 10_000;
const PER_CURRENCY_DELAY_MS = 120;

async function fetchYahooHistory(currency) {
  const symbol = `${currency}USD=X`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1mo`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
  const data = await resp.json();
  const result = data?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
    throw new Error('Yahoo chart payload missing timestamp/close arrays');
  }
  const series = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (typeof close === 'number' && Number.isFinite(close) && close > 0) {
      series.push({ t: timestamps[i] * 1000, close });
    }
  }
  if (series.length < 13) throw new Error(`Insufficient bars (${series.length})`);
  return series;
}

function computeYoy(series) {
  const latest = series[series.length - 1];
  // For range=2y, look back 12 bars from the end to get the YoY anchor.
  const yearAgoIdx = Math.max(0, series.length - 13);
  const yearAgo = series[yearAgoIdx];
  const yoyChange = ((latest.close - yearAgo.close) / yearAgo.close) * 100;

  // Peak-to-trough drawdown over the available 24-month window. For USD
  // pairs in the form {CCY}USD=X, the close is the price of 1 unit of CCY
  // in USD — so a drop = currency depreciation against USD. We find the
  // peak first, then the lowest point AFTER the peak.
  let peak = series[0];
  for (const bar of series) {
    if (bar.close > peak.close) peak = bar;
  }
  let trough = peak;
  for (const bar of series) {
    if (bar.t > peak.t && bar.close < trough.close) trough = bar;
  }
  const drawdown24m = peak.close > 0
    ? ((trough.close - peak.close) / peak.close) * 100
    : 0;

  return {
    currentRate: latest.close,
    yearAgoRate: yearAgo.close,
    yoyChange: Math.round(yoyChange * 10) / 10,
    drawdown24m: Math.round(drawdown24m * 10) / 10,
    peakRate: peak.close,
    peakDate: new Date(peak.t).toISOString().slice(0, 10),
    troughRate: trough.close,
    troughDate: new Date(trough.t).toISOString().slice(0, 10),
    asOf: new Date(latest.t).toISOString().slice(0, 10),
    yearAgo: new Date(yearAgo.t).toISOString().slice(0, 10),
  };
}

async function fetchFxYoy() {
  const rates = [];
  const failures = [];
  for (const [currency, countryCode] of Object.entries(CURRENCY_COUNTRY)) {
    try {
      const series = await fetchYahooHistory(currency);
      const yoy = computeYoy(series);
      rates.push({ countryCode, currency, ...yoy });
    } catch (err) {
      failures.push({ currency, error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((r) => setTimeout(r, PER_CURRENCY_DELAY_MS));
  }
  console.log(`  FX YoY: ${rates.length}/${Object.keys(CURRENCY_COUNTRY).length} currencies`);
  if (failures.length > 0) {
    console.log(`  Failures: ${failures.map((f) => `${f.currency}(${f.error})`).join(', ')}`);
  }
  if (rates.length === 0) {
    throw new Error('All Yahoo FX history fetches failed');
  }
  return { rates, fetchedAt: new Date().toISOString() };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  await runSeed('economic', 'fx-yoy', CANONICAL_KEY, fetchFxYoy, {
    ttlSeconds: CACHE_TTL,
    validateFn: (data) => Array.isArray(data?.rates) && data.rates.length >= 10,
    recordCount: (data) => data?.rates?.length ?? 0,
    sourceVersion: 'yahoo-fx-yoy-v1',
  });
}

export { CURRENCY_COUNTRY, computeYoy, fetchFxYoy };
