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
 *         asOf, yearAgo,
 *         daily90?: { asOf, latest, anchor: { date, value }, sessions,
 *                     noiseShare, reliable, source, yahooNoiseShare? } },
 *       ...
 *     ],
 *     fetchedAt: "<iso>",
 *   }
 *
 * Railway: deploy as cron service running daily (e.g. `30 6 * * *`),
 * NIXPACKS builder, startCommand `node scripts/seed-fx-yoy.mjs`.
 */

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { fetchFallbackWindows, fallbackDailyQuotes } from './_currency-api.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';
import { tokensToContentMeta, DAY_MIN } from './_content-age-helpers.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:fx:yoy:v1';
const CACHE_TTL = 25 * 3600; // 25h covers a daily cron + 1h drift buffer
// Content-age budget — `asOf` is the newest Yahoo daily bar date. 7 days
// absorbs a long weekend + market holidays; a frozen Yahoo feed flips
// /api/health to STALE_CONTENT within ~5 trading days. See issue #3845.
const FX_YOY_MAX_CONTENT_AGE_MIN = 7 * DAY_MIN;

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
// AGENTS.md: stagger Yahoo Finance requests by 150 ms. This ran at 120 ms with
// a bare fetch and no retry, so one 429 in the 60-currency sweep dropped that
// currency for the run. fetchYahooJson adds the retry/backoff and the curl
// proxy fallback every other Yahoo seeder already uses.
export const PER_CURRENCY_DELAY_MS = 150;

async function fetchYahooHistory(currency) {
  const symbol = `${currency}USD=X`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1mo`;
  const data = await fetchYahooJson(url, { label: `${symbol} fx-yoy`, timeoutMs: FETCH_TIMEOUT_MS });
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

// Daily closes for the CII currency member. Yahoo's cross rates carry quote
// noise that a monthly close cannot be cleaned of: QARUSD=X flips between the
// 3.64 peg and a level 3.6% away on about four days in ten, and SARUSD=X
// prints isolated 3% spikes. cleanDailyQuotes removes what a median can and
// flags the rest, so no reader mistakes a bad print for a devaluation.
async function fetchYahooDaily(currency) {
  const symbol = `${currency}USD=X`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`;
  // One attempt, no backoff: this request is optional, and the second source
  // covers a currency it misses. The caller also caps its total time.
  const data = await fetchYahooJson(url, { label: `${symbol} fx-daily`, timeoutMs: FETCH_TIMEOUT_MS, maxRetries: 0 });
  const result = data?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
    throw new Error('Yahoo chart payload missing timestamp/close arrays');
  }
  return {
    timeZone: result.meta?.exchangeTimezoneName || 'UTC',
    points: timestamps.map((ts, i) => ({ t: ts * 1000, close: closes[i] })),
  };
}

const DAY_MS = 86_400_000;
export const FX_DAILY_WINDOW_DAYS = 90;
export const FX_DAILY_MEDIAN_POINTS = 5;
// A move of more than 1% that is undone within three sessions is a quote
// error, not a price. Measured 2026-11-13 over 133 sessions: QAR 0.43, BHD
// 0.37, PKR 0.14, SAR 0.06, every other currency at or below 0.04; EGP had 16
// moves above 1% and none reverted. 0.10 sits in the gap.
export const FX_NOISE_MOVE = 0.01;
export const FX_NOISE_RETURN = 0.003;
export const FX_NOISE_LOOKAHEAD = 3;
export const FX_MAX_NOISE_SHARE = 0.10;
const FX_DAILY_MIN_POINTS = 70;
const FX_ANCHOR_MAX_GAP_DAYS = 7;
const FX_WINDOW_MAX_SPAN_DAYS = 12;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Clean a daily close series and derive the 90-day change inputs.
 * Returns null when the series cannot support a 90-day comparison.
 * `reliable: false` means the quotes are too noisy to compare at all; the
 * reader must treat the currency as unmeasured, never as unchanged.
 */
export function cleanDailyQuotes(points, timeZone = 'UTC') {
  const series = (Array.isArray(points) ? points : [])
    .filter((p) => Number.isFinite(p?.t) && typeof p.close === 'number' && Number.isFinite(p.close) && p.close > 0)
    .sort((a, b) => a.t - b.t);
  if (series.length < FX_DAILY_MIN_POINTS) return null;
  const closes = series.map((p) => p.close);

  // A move above 1% that returns to its starting level within three sessions
  // is a quote error. Count it, and drop the sessions it covers so that a run
  // of bad prints at either end of the window cannot set a median.
  const excursion = new Array(closes.length).fill(false);
  let reverted = 0;
  for (let i = 1; i < closes.length; i++) {
    if (Math.abs(closes[i] / closes[i - 1] - 1) <= FX_NOISE_MOVE) continue;
    for (let j = i + 1; j <= Math.min(closes.length - 1, i + FX_NOISE_LOOKAHEAD); j++) {
      if (Math.abs(closes[j] / closes[i - 1] - 1) < FX_NOISE_RETURN) {
        reverted += 1;
        for (let k = i; k < j; k++) excursion[k] = true;
        break;
      }
    }
  }
  const noiseShare = Math.round((reverted / closes.length) * 1000) / 1000;
  const reliable = noiseShare <= FX_MAX_NOISE_SHARE;
  let dayFormat;
  try {
    dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  const day = (p) => dayFormat.format(new Date(p.t));
  // A series too noisy to compare still reports why, so the second source is tried.
  const unusable = reliable ? null : { asOf: day(series.at(-1)), latest: null, anchor: null, sessions: closes.length, noiseShare, reliable: false, source: 'yahoo' };

  const clean = series.filter((_, i) => !excursion[i]);
  const half = FX_DAILY_MEDIAN_POINTS >> 1;
  const last = clean.length - 1;
  if (clean.length < FX_DAILY_MEDIAN_POINTS * 2) return unusable;
  let anchorIdx = -1;
  for (let i = last; i >= 0; i--) {
    if (clean[i].t <= clean[last].t - FX_DAILY_WINDOW_DAYS * DAY_MS) { anchorIdx = i; break; }
  }
  if (anchorIdx < half || anchorIdx + half > last) return unusable;
  if (clean[last].t - FX_DAILY_WINDOW_DAYS * DAY_MS - clean[anchorIdx].t > FX_ANCHOR_MAX_GAP_DAYS * DAY_MS) return unusable;
  // Five sessions normally span five to seven calendar days. A wider window
  // means the feed had a hole, and its median would mix old quotes with new.
  const lateWindow = clean.slice(-FX_DAILY_MEDIAN_POINTS);
  const anchorWindow = clean.slice(anchorIdx - half, anchorIdx + half + 1);
  const span = (w) => (w.at(-1).t - w[0].t) / DAY_MS;
  if (span(lateWindow) > FX_WINDOW_MAX_SPAN_DAYS || span(anchorWindow) > FX_WINDOW_MAX_SPAN_DAYS) return unusable;

  return {
    asOf: day(clean[last]),
    latest: median(lateWindow.map((p) => p.close)),
    anchor: { date: day(clean[anchorIdx]), value: median(anchorWindow.map((p) => p.close)) },
    sessions: closes.length,
    noiseShare,
    reliable,
    source: 'yahoo',
  };
}

// The producer drops a currency observation older than seven days, so a block
// that is noisy, empty or stale all need the second source.
const FX_DAILY_MAX_AGE_DAYS = 7;
export function needsFallback(daily90, nowMs = Date.now()) {
  if (!daily90 || daily90.reliable !== true || !Number.isFinite(daily90.latest)) return true;
  const asOfMs = Date.parse(daily90.asOf);
  return !Number.isFinite(asOfMs) || nowMs - asOfMs > FX_DAILY_MAX_AGE_DAYS * DAY_MS;
}

// The daily series is optional; the YoY rows the resilience score reads are
// not. runSeed rejects the whole fetch at its deadline and publishes nothing,
// so the optional request is skipped unless its worst case fits beside the
// remaining required requests (at the slowest pace seen so far) and a publish
// reserve. Its worst case is a hard cap: one direct attempt plus the proxy
// fallback, cut off at FX_OPTIONAL_CAP_MS.
const FX_PUBLISH_RESERVE_MS = 15_000;
export const FX_OPTIONAL_CAP_MS = 20_000;
export function hasTimeForOptionalFetch({ nowMs, deadlineAtMs, remainingRequired, slowestRequestMs }) {
  if (!Number.isFinite(deadlineAtMs)) return true;
  const perRequired = slowestRequestMs + PER_CURRENCY_DELAY_MS;
  return nowMs + FX_OPTIONAL_CAP_MS + perRequired * remainingRequired + FX_PUBLISH_RESERVE_MS <= deadlineAtMs;
}

/** Reject after `capMs` so an optional request can never run past its reserved time. */
export function withTimeCap(promise, capMs, label) {
  let timer;
  const cap = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${capMs} ms`)), capMs); });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

function computeYoy(series) {
  const latest = series[series.length - 1];
  // For range=2y, look back 12 bars from the end to get the YoY anchor.
  const yearAgoIdx = Math.max(0, series.length - 13);
  const yearAgo = series[yearAgoIdx];
  const yoyChange = ((latest.close - yearAgo.close) / yearAgo.close) * 100;

  // Worst peak-to-trough drawdown over the available window using a
  // running-peak scan. For USD pairs in the form {CCY}USD=X, the close
  // is the price of 1 unit of CCY in USD — so a drop = currency
  // depreciation against USD.
  //
  // A naive "global max → min after global max" approach erases earlier
  // crashes that were followed by a partial recovery to a new high
  // (e.g. series [10, 6, 11, 10] — true worst drawdown is 10→6=-40%, but
  // global-peak-after picks 11→10=-9.1%). Track the running peak as we
  // sweep forward and record the largest drop from that peak to any
  // subsequent point — exactly what max-drawdown means in a time series.
  let runningPeak = series[0];
  let worstDrawdown = 0;
  let peakAtWorst = series[0];
  let troughAtWorst = series[0];
  for (const bar of series) {
    if (bar.close > runningPeak.close) runningPeak = bar;
    const dd = ((bar.close - runningPeak.close) / runningPeak.close) * 100;
    if (dd < worstDrawdown) {
      worstDrawdown = dd;
      peakAtWorst = runningPeak;
      troughAtWorst = bar;
    }
  }
  const drawdown24m = worstDrawdown;
  const peak = peakAtWorst;
  const trough = troughAtWorst;

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

async function fetchFxYoy({ fetchDeadlineAtMs = Infinity } = {}) {
  const rates = [];
  const failures = [];
  const dailyFailures = [];
  const currencies = Object.entries(CURRENCY_COUNTRY);
  let done = 0;
  let slowestRequestMs = 0;
  for (const [currency, countryCode] of Object.entries(CURRENCY_COUNTRY)) {
    done += 1;
    try {
      const startedAt = Date.now();
      let series;
      try {
        series = await fetchYahooHistory(currency);
      } finally {
        // A failed required request sets the pace too: it is the slow case.
        slowestRequestMs = Math.max(slowestRequestMs, Date.now() - startedAt);
      }
      const yoy = computeYoy(series);
      // A failed, thin or skipped daily series costs the CII member only; the
      // YoY row the resilience score reads is still published.
      let daily90 = null;
      if (!hasTimeForOptionalFetch({ nowMs: Date.now(), deadlineAtMs: fetchDeadlineAtMs, remainingRequired: currencies.length - done, slowestRequestMs })) {
        dailyFailures.push({ currency, error: 'skipped: time budget' });
      } else {
        await new Promise((r) => setTimeout(r, PER_CURRENCY_DELAY_MS));
        try {
          const daily = await withTimeCap(fetchYahooDaily(currency), FX_OPTIONAL_CAP_MS, `${currency} fx-daily`);
          daily90 = cleanDailyQuotes(daily.points, daily.timeZone);
          if (!daily90) dailyFailures.push({ currency, error: 'insufficient daily history' });
        } catch (err) {
          dailyFailures.push({ currency, error: err instanceof Error ? err.message : String(err) });
        }
      }
      rates.push({ countryCode, currency, ...yoy, ...(daily90 ? { daily90 } : {}) });
    } catch (err) {
      failures.push({ currency, error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((r) => setTimeout(r, PER_CURRENCY_DELAY_MS));
  }
  console.log(`  FX YoY: ${rates.length}/${Object.keys(CURRENCY_COUNTRY).length} currencies`);
  const noisy = rates.filter((r) => r.daily90 && !r.daily90.reliable).map((r) => `${r.currency}(${r.daily90.noiseShare})`);
  console.log(`  FX daily: ${rates.filter((r) => r.daily90).length} cleaned, unreliable quotes: ${noisy.join(', ') || 'none'}`);
  // Never let a noisy, missing or frozen Yahoo series cost a country its
  // currency member while a clean second source has it.
  const needFallback = rates.filter((r) => needsFallback(r.daily90));
  if (needFallback.length > 0) {
    let windows = null;
    try {
      if (Date.now() + FX_PUBLISH_RESERVE_MS * 2 > fetchDeadlineAtMs) throw new Error('skipped: time budget');
      windows = await fetchFallbackWindows(Date.now(), { windowDays: FX_DAILY_WINDOW_DAYS, points: FX_DAILY_MEDIAN_POINTS });
    } catch (err) {
      console.log(`  FX fallback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const recovered = [];
    for (const row of needFallback) {
      const fallback = fallbackDailyQuotes(row.currency, windows);
      if (!fallback) continue;
      row.daily90 = { ...fallback, ...(row.daily90 ? { yahooNoiseShare: row.daily90.noiseShare } : {}) };
      recovered.push(row.currency);
    }
    console.log(`  FX fallback (currency-api): recovered ${recovered.join(', ') || 'none'} of ${needFallback.map((r) => r.currency).join(', ')}`);
  }
  if (dailyFailures.length > 0) {
    console.log(`  Daily failures: ${dailyFailures.map((f) => `${f.currency}(${f.error})`).join(', ')}`);
  }
  if (failures.length > 0) {
    console.log(`  Failures: ${failures.map((f) => `${f.currency}(${f.error})`).join(', ')}`);
  }
  if (rates.length === 0) {
    throw new Error('All Yahoo FX history fetches failed');
  }
  return { rates, fetchedAt: new Date().toISOString() };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
export function declareRecords(data) {
  return Array.isArray(data?.rates) ? data.rates.length : 0;
}

// Content-age contract: the newest `asOf` bar date across all currency pairs.
// Detects a frozen Yahoo feed that seeder-liveness checks cannot — see
// scripts/_content-age-helpers.mjs.
export function fxYoyContentMeta(data) {
  return tokensToContentMeta((Array.isArray(data?.rates) ? data.rates : []).map((r) => r?.asOf));
}

if (isMain) {
  await runSeed('economic', 'fx-yoy', CANONICAL_KEY, fetchFxYoy, {
    ttlSeconds: CACHE_TTL,
    validateFn: (data) => Array.isArray(data?.rates) && data.rates.length >= 10,
    recordCount: (data) => data?.rates?.length ?? 0,
    sourceVersion: 'yahoo-fx-yoy-v1',

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 1500,
    contentMeta: fxYoyContentMeta,
    maxContentAgeMin: FX_YOY_MAX_CONTENT_AGE_MIN,
  });
}

export { CURRENCY_COUNTRY, computeYoy, fetchFxYoy };
