import type {
  AnalyzeStockRequest,
  AnalyzeStockResponse,
  AnalystConsensus,
  EarningsEntry,
  PriceTarget,
  UpgradeDowngrade,
  ServerContext,
  StockAnalysisHeadline,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { callLlm } from '../../../_shared/llm';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { CHROME_UA, yahooGate } from '../../../_shared/constants';
import { UPSTREAM_TIMEOUT_MS, sanitizeSymbol } from './_shared';
import { storeStockAnalysisSnapshot } from './premium-stock-store';
import { searchRecentStockHeadlines } from './stock-news-search';

export type Candle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type TrendStatus = 'Strong bull' | 'Bull' | 'Weak bull' | 'Consolidation' | 'Weak bear' | 'Bear' | 'Strong bear';
type VolumeStatus = 'Heavy volume up' | 'Heavy volume down' | 'Shrink volume up' | 'Shrink volume down' | 'Normal';
type Signal = 'Strong buy' | 'Buy' | 'Hold' | 'Watch' | 'Sell' | 'Strong sell';
type MacdStatus = 'Golden cross above zero' | 'Golden cross' | 'Bullish' | 'Crossing up' | 'Crossing down' | 'Bearish' | 'Death cross';
type RsiStatus = 'Overbought' | 'Strong buy' | 'Neutral' | 'Weak' | 'Oversold';

export type TechnicalSnapshot = {
  currentPrice: number;
  changePercent: number;
  currency: string;
  ma5: number;
  ma10: number;
  ma20: number;
  ma60: number;
  biasMa5: number;
  biasMa10: number;
  biasMa20: number;
  trendStatus: TrendStatus;
  trendStrength: number;
  maAlignment: string;
  volumeStatus: VolumeStatus;
  volumeRatio5d: number;
  volumeTrend: string;
  supportLevels: number[];
  resistanceLevels: number[];
  supportMa5: boolean;
  supportMa10: boolean;
  macdDif: number;
  macdDea: number;
  macdBar: number;
  macdStatus: MacdStatus;
  macdSignal: string;
  rsi6: number;
  rsi12: number;
  rsi24: number;
  rsiStatus: RsiStatus;
  rsiSignal: string;
  signal: Signal;
  signalScore: number;
  bullishFactors: string[];
  riskFactors: string[];
  realizedVolatility: number;
  atr: number;
  maxDrawdown: number;
};

export type AiOverlay = {
  summary: string;
  action: string;
  confidence: string;
  whyNow: string;
  technicalSummary: string;
  newsSummary: string;
  bullishFactors: string[];
  riskFactors: string[];
  provider: string;
  model: string;
  fallback: boolean;
};

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      meta?: {
        currency?: string;
        regularMarketPrice?: number;
        previousClose?: number;
        chartPreviousClose?: number;
        currentTradingPeriod?: {
          pre?: { start?: number; end?: number };
          regular?: { start?: number; end?: number };
          post?: { start?: number; end?: number };
        };
      };
      events?: {
        dividends?: Record<string, { amount?: number; date?: number }>;
      };
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
  };
};

type YahooRecommendationEntry = {
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
  period?: string;
};

type YahooUpgradeEntry = {
  firm?: string;
  toGrade?: string;
  fromGrade?: string;
  action?: string;
  epochGradeDate?: number;
};

type YahooQuoteSummaryResponse = {
  quoteSummary?: {
    result?: Array<{
      recommendationTrend?: {
        trend?: YahooRecommendationEntry[];
      };
      financialData?: {
        financialCurrency?: string;
        targetHighPrice?: { raw?: number };
        targetLowPrice?: { raw?: number };
        targetMeanPrice?: { raw?: number };
        targetMedianPrice?: { raw?: number };
        currentPrice?: { raw?: number };
        numberOfAnalystOpinions?: { raw?: number };
        // Fundamentals returned in the same module but previously discarded (#5445-adjacent richness).
        profitMargins?: { raw?: number };
        grossMargins?: { raw?: number };
        operatingMargins?: { raw?: number };
        returnOnEquity?: { raw?: number };
        returnOnAssets?: { raw?: number };
        revenueGrowth?: { raw?: number };
        earningsGrowth?: { raw?: number };
        debtToEquity?: { raw?: number };
        totalCash?: { raw?: number };
        totalDebt?: { raw?: number };
        freeCashflow?: { raw?: number };
        ebitda?: { raw?: number };
      };
      upgradeDowngradeHistory?: {
        history?: YahooUpgradeEntry[];
      };
    }>;
  };
};

// Quality / growth / leverage fundamentals parsed from Yahoo's financialData
// module (already fetched for price targets). Any field may be absent.
export type StockFundamentals = {
  profitMargin?: number;
  grossMargin?: number;
  operatingMargin?: number;
  returnOnEquity?: number;
  returnOnAssets?: number;
  revenueGrowth?: number;
  earningsGrowth?: number;
  debtToEquity?: number;
  totalCash?: number;
  totalDebt?: number;
  freeCashflow?: number;
  ebitda?: number;
  financialCurrency?: string;
};

export type AnalystData = {
  analystConsensus: AnalystConsensus;
  priceTarget: PriceTarget;
  recentUpgrades: UpgradeDowngrade[];
  fundamentals: StockFundamentals;
};

export type DividendProfile = {
  dividendYield: number;
  trailingAnnualDividendRate: number;
  exDividendDate: number;
  payoutRatio?: number;
  dividendFrequency: string;
  dividendCagr: number;
};

const EMPTY_DIVIDEND_PROFILE: DividendProfile = {
  dividendYield: 0,
  trailingAnnualDividendRate: 0,
  exDividendDate: 0,
  dividendFrequency: '',
  dividendCagr: 0,
};

type YahooSummaryDetailResponse = {
  quoteSummary?: {
    result?: Array<{
      summaryDetail?: {
        payoutRatio?: { raw?: number };
      };
    }>;
  };
};

async function fetchPayoutRatio(symbol: string): Promise<number | undefined> {
  try {
    await yahooGate();
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail`;
    const response = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const data = await response.json() as YahooSummaryDetailResponse;
    const raw = data.quoteSummary?.result?.[0]?.summaryDetail?.payoutRatio?.raw;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

function inferDividendFrequency(paymentsPerYear: number): string {
  if (paymentsPerYear >= 10) return 'Monthly';
  if (paymentsPerYear >= 3) return 'Quarterly';
  if (paymentsPerYear >= 1.5) return 'Semi-annual';
  if (paymentsPerYear >= 0.5) return 'Annual';
  return '';
}

/**
 * Implied payments-per-year from the median gap between dividends. More
 * robust than counting payments inside a 365.25-day window: quarterly
 * payers whose last-year-Q1 payment falls just outside the window (common
 * after mid-April each year) were misclassified as Semi-annual.
 *
 * Scopes gaps to the most recent `windowSec` seconds so a cadence change
 * (e.g. quarterly → annual) is reflected within one window rather than
 * being averaged over 5 years of history. Falls back to the full series
 * when the recent window has fewer than 2 usable entries.
 */
function paymentsPerYearFromInterval(
  sortedEntries: ReadonlyArray<{ date?: number }>,
  nowSec: number = Math.floor(Date.now() / 1000),
  windowSec: number = 2 * 365.25 * 24 * 3600,
): number {
  if (sortedEntries.length < 2) return 0;
  const cutoff = nowSec - windowSec;
  const recent = sortedEntries.filter((e) => typeof e.date === 'number' && e.date >= cutoff);
  const series = recent.length >= 2 ? recent : sortedEntries;
  const gaps: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.date;
    const curr = series[i]!.date;
    if (typeof prev !== 'number' || typeof curr !== 'number') continue;
    const gapDays = (curr - prev) / (24 * 3600);
    if (gapDays > 0) gaps.push(gapDays);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  // True median (average of two middles for even-length arrays) — avoids
  // upper-bias at thresholds when the trailing-year sample is small.
  const mid = Math.floor(gaps.length / 2);
  const medianGapDays = gaps.length % 2 === 1
    ? gaps[mid]!
    : (gaps[mid - 1]! + gaps[mid]!) / 2;
  if (medianGapDays <= 0) return 0;
  return 365.25 / medianGapDays;
}

function computeDividendCagr(annualTotals: Map<number, number>): number {
  if (annualTotals.size < 2) return 0;
  const years = [...annualTotals.keys()].sort((a, b) => a - b);
  const currentYear = new Date().getFullYear();

  // Treat any year strictly earlier than the current calendar year as
  // complete — all scheduled dividends for that year have been paid.
  // Exclude the current (in-progress) year since it may be missing
  // payments that haven't landed yet. Month-count gating (the previous
  // approach) silently dropped the first/last year for every non-monthly
  // payer (quarterly = 4 months, semiannual = 2, annual = 1), collapsing
  // CAGR to 0 for most ordinary dividend stocks.
  const fullYears = years.filter(y => y < currentYear);

  if (fullYears.length < 2) return 0;
  const earliest = annualTotals.get(fullYears[0]!) ?? 0;
  const latest = annualTotals.get(fullYears[fullYears.length - 1]!) ?? 0;
  if (earliest <= 0 || latest <= 0) return 0;
  const span = fullYears[fullYears.length - 1]! - fullYears[0]!;
  if (span < 1) return 0;
  return ((latest / earliest) ** (1 / span) - 1) * 100;
}

export async function fetchDividendProfile(symbol: string, currentPrice: number): Promise<DividendProfile> {
  try {
    await yahooGate();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1mo&includePrePost=true&events=div`;
    const [chartResponse, payoutRatio] = await Promise.all([
      fetch(url, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      }),
      fetchPayoutRatio(symbol),
    ]);
    if (!chartResponse.ok) return EMPTY_DIVIDEND_PROFILE;

    const data = await chartResponse.json() as YahooChartResponse;
    const result = data.chart?.result?.[0];
    const dividendEvents = result?.events?.dividends;
    if (!dividendEvents || Object.keys(dividendEvents).length === 0) return EMPTY_DIVIDEND_PROFILE;

    const entries = Object.values(dividendEvents)
      .filter((d) => typeof d.amount === 'number' && d.amount > 0 && typeof d.date === 'number')
      .sort((a, b) => (a.date ?? 0) - (b.date ?? 0));

    if (entries.length === 0) return EMPTY_DIVIDEND_PROFILE;

    const annualTotals = new Map<number, number>();
    for (const entry of entries) {
      const year = new Date((entry.date ?? 0) * 1000).getFullYear();
      annualTotals.set(year, (annualTotals.get(year) ?? 0) + (entry.amount ?? 0));
    }

    const now = Date.now();
    const oneYearAgo = now - 365.25 * 24 * 3600 * 1000;
    const recentDivs = entries.filter((d) => (d.date ?? 0) * 1000 >= oneYearAgo);
    // `let`, not `const`: the recent=0 branch below backfills these from the
    // INDICATED annual rate when it detects an active low-frequency payer that
    // is merely between scheduled payments (last payment just outside the
    // trailing-365-day window). Without that, an annual payer past its
    // anniversary would read "Annual / $0 rate / 0% yield".
    let trailingAnnual = recentDivs.reduce((sum, d) => sum + (d.amount ?? 0), 0);
    let dividendYield = currentPrice > 0 ? (trailingAnnual / currentPrice) * 100 : 0;
    // Suppress frequency entirely when the program is genuinely suspended: no
    // payment in the trailing year AND the last payment too old to be a
    // between-payments gap (see the recent=0 branch). Then dividendYield/
    // trailingAnnualRate stay 0, and emitting a frequency badge derived from
    // stale history would contradict the accompanying zeros in the UI.
    // Frequency reconciliation:
    //   recent=0          → program suspended, leave frequency empty
    //   recent >= 3       → trust interval (robust to calendar-boundary drift)
    //   recent 1..2       → ambiguous. Use the most recent gap to decide:
    //                         large recent gap (> 180d) = regime slowdown →
    //                           trust the count (quarterly → annual shift)
    //                         small recent gap (<= 180d) = calendar drift →
    //                           trust the interval (steady quarterly whose
    //                           prior-year Q1 fell outside the 365d window)
    let paymentsPerYear = 0;
    if (recentDivs.length >= 3) {
      // Use the trailing-year window directly. Scoping the median to
      // ≥3 trailing-year entries (= 2+ gaps) reflects the CURRENT cadence,
      // so regime changes like monthly → quarterly (whose 2-year median
      // would still skew to monthly from prior-year history) are caught.
      const byInterval = paymentsPerYearFromInterval(recentDivs);
      paymentsPerYear = byInterval > 0
        ? byInterval
        : (recentDivs.length || (entries.length / Math.max(1, annualTotals.size)));
    } else if (recentDivs.length > 0) {
      // 1..2 recent payments: reach into the 2-year history to decide
      // between calendar drift and regime slowdown. Most-recent gap
      // > 180d means a real slowdown → trust the count.
      const lastTwo = entries.slice(-2);
      const mostRecentGapDays =
        lastTwo.length === 2
          ? ((lastTwo[1]!.date ?? 0) - (lastTwo[0]!.date ?? 0)) / (24 * 3600)
          : Number.POSITIVE_INFINITY;
      if (mostRecentGapDays > 180) {
        paymentsPerYear = recentDivs.length;
      } else {
        const byInterval = paymentsPerYearFromInterval(entries);
        paymentsPerYear = byInterval > 0 ? byInterval : recentDivs.length;
      }
    } else {
      // recentDivs.length === 0: no payment in the trailing 365 days. This is
      // EITHER a suspended program OR a low-frequency payer (annual / semi-
      // annual) observed BETWEEN scheduled payments — its last payment fell
      // just outside the 365-day window and the next one is still pending.
      // Distinguish the two by recency relative to the payer's OWN historical
      // cadence: a last payment within ~1.5x its median interval is between
      // payments, not suspended. Quarterly/monthly payers with a >365-day gap
      // have skipped many payments, so they blow past 1.5x their (much
      // shorter) interval and correctly stay '' (see the suspended-program
      // test). Without this, annual payers collapse to '' for the weeks each
      // year after their payment anniversary — the trailing-year window is
      // empty even though the program is healthy.
      const byInterval = paymentsPerYearFromInterval(entries);
      if (byInterval > 0) {
        const expectedGapDays = 365.25 / byInterval;
        const daysSinceLast =
          (now / 1000 - (entries[entries.length - 1]!.date ?? 0)) / (24 * 3600);
        if (daysSinceLast <= expectedGapDays * 1.5) {
          paymentsPerYear = byInterval;
          // The trailing-12-month window is empty for this between-payments
          // payer, so trailingAnnual/dividendYield computed above are both 0.
          // Backfill them with the INDICATED annual rate — the most recent
          // regular payment(s) annualized — so the badge, rate, and yield are
          // mutually coherent instead of "Annual / $0 / 0%". Genuinely
          // suspended payers never reach here (paymentsPerYear stays 0), so
          // their zeros are preserved.
          const indicatedPayments = Math.max(1, Math.round(paymentsPerYear));
          const indicatedAnnual = entries
            .slice(-indicatedPayments)
            .reduce((sum, e) => sum + (e.amount ?? 0), 0);
          if (indicatedAnnual > 0) {
            trailingAnnual = indicatedAnnual;
            dividendYield = currentPrice > 0 ? (indicatedAnnual / currentPrice) * 100 : 0;
          }
        }
      }
    }

    const latestEntry = entries[entries.length - 1]!;
    const exDividendDate = (latestEntry.date ?? 0) * 1000;

    const cagr = computeDividendCagr(annualTotals);

    return {
      dividendYield: round(dividendYield),
      trailingAnnualDividendRate: round(trailingAnnual),
      exDividendDate,
      payoutRatio,
      dividendFrequency: inferDividendFrequency(paymentsPerYear),
      dividendCagr: round(cagr),
    };
  } catch {
    return EMPTY_DIVIDEND_PROFILE;
  }
}

const CACHE_TTL_SECONDS = 900;
const NEWS_LIMIT = 5;
const BIAS_THRESHOLD = 5;
const VOLUME_SHRINK_RATIO = 0.7;
const VOLUME_HEAVY_RATIO = 1.5;
const MA_SUPPORT_TOLERANCE = 0.02;
export const STOCK_ANALYSIS_ENGINE_VERSION = 'v2';

function round(value: number, digits = 2): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function signalDirection(signal: string): 'long' | 'short' | null {
  const normalized = signal.toLowerCase();
  if (normalized.includes('buy')) return 'long';
  if (normalized.includes('sell')) return 'short';
  return null;
}

export function deriveTradeLevels(
  signal: string,
  entryPrice: number,
  supports: number[],
  resistances: number[],
): { stopLoss: number; takeProfit: number } {
  const direction = signalDirection(signal);
  if (direction === 'short') {
    const stopLoss = resistances.find((level) => level > entryPrice) || entryPrice * 1.05;
    const takeProfit = supports.find((level) => level > 0 && level < entryPrice) || entryPrice * 0.92;
    return { stopLoss: round(stopLoss), takeProfit: round(takeProfit) };
  }

  const stopLoss = supports.find((level) => level > 0 && level < entryPrice) || entryPrice * 0.95;
  const takeProfit = resistances.find((level) => level > entryPrice) || entryPrice * 1.08;
  return { stopLoss: round(stopLoss), takeProfit: round(takeProfit) };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function smaSeries(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(Number.NaN);
  let rolling = 0;
  for (let i = 0; i < values.length; i++) {
    rolling += values[i] ?? 0;
    if (i >= period) rolling -= values[i - period] ?? 0;
    if (i >= period - 1) out[i] = rolling / period;
  }
  return out;
}

function emaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  const multiplier = 2 / (period + 1);
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? prev;
    prev = i === 0 ? value : ((value - prev) * multiplier) + prev;
    out.push(prev);
  }
  return out;
}

function wilderSmoothing(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(Number.NaN);
  let sum = 0;
  for (let i = 1; i <= period && i < values.length; i++) sum += values[i] ?? 0;
  if (period < values.length) out[period] = sum / period;
  for (let i = period + 1; i < values.length; i++) {
    const prev = out[i - 1] ?? 0;
    out[i] = (prev * (period - 1) + (values[i] ?? 0)) / period;
  }
  return out;
}

function rsiSeries(values: number[], period: number): number[] {
  const deltas = values.map((value, index) => index === 0 ? 0 : value - (values[index - 1] ?? value));
  const gains = deltas.map((delta) => delta > 0 ? delta : 0);
  const losses = deltas.map((delta) => delta < 0 ? -delta : 0);
  const avgGains = wilderSmoothing(gains, period);
  const avgLosses = wilderSmoothing(losses, period);
  return values.map((_, index) => {
    const avgGain = avgGains[index] ?? Number.NaN;
    const avgLoss = avgLosses[index] ?? Number.NaN;
    if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) return 50;
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  });
}

function latestFinite(values: number[]): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (Number.isFinite(values[i])) return values[i] as number;
  }
  return 0;
}

function uniqueRounded(values: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const value of values) {
    const rounded = round(value);
    if (!rounded || seen.has(rounded)) continue;
    seen.add(rounded);
    out.push(rounded);
  }
  return out;
}

// ── Risk analytics ──────────────────────────────────────────────────────────
// Pure functions over the daily candles already fetched by fetchYahooHistory —
// no extra upstream call. Exported for unit tests.

const TRADING_DAYS_PER_YEAR = 252;
const ATR_PERIOD = 14;

/**
 * Sample standard deviation (Bessel-corrected, n − 1). Returns 0 for a series
 * with fewer than two values.
 */
function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Annualized realized volatility: the sample standard deviation of daily log
 * returns scaled by √252, expressed as a fractional ratio (0.25 means 25%).
 * Returns 0 when fewer than two usable closes are supplied.
 * @param closes Chronological close prices.
 */
export function computeRealizedVolatility(closes: number[]): number {
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (prev === undefined || curr === undefined || prev <= 0 || curr <= 0) continue;
    logReturns.push(Math.log(curr / prev));
  }
  if (logReturns.length < 2) return 0;
  return stdev(logReturns) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Wilder's Average True Range over `period` bars, in the candles' price units.
 * True range is max(high − low, |high − prevClose|, |low − prevClose|); the
 * first bar seeds on high − low. The window is seeded with the simple average
 * of the first `period` true ranges, then Wilder-smoothed. Returns 0 when fewer
 * than two aligned bars are supplied.
 * @param highs Chronological high prices.
 * @param lows Chronological low prices, index-aligned with `highs`.
 * @param closes Chronological close prices, index-aligned with `highs`.
 * @param period Averaging window (defaults to 14).
 */
export function computeAtr(highs: number[], lows: number[], closes: number[], period = ATR_PERIOD): number {
  const length = Math.min(highs.length, lows.length, closes.length);
  if (period < 1 || length < period) return 0;
  const trueRanges: number[] = [];
  for (let i = 0; i < length; i++) {
    const high = highs[i];
    const low = lows[i];
    if (high === undefined || low === undefined) continue;
    const prevClose = i > 0 ? closes[i - 1] : undefined;
    if (i === 0 || prevClose === undefined) {
      trueRanges.push(high - low);
      continue;
    }
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trueRanges.length === 0) return 0;
  if (trueRanges.length < period) return 0;
  let atr = mean(trueRanges.slice(0, period));
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + (trueRanges[i] ?? 0)) / period;
  }
  return atr;
}

/**
 * Maximum peak-to-trough drawdown over the series, as a non-positive fractional
 * ratio (−0.25 means a 25% decline from a prior peak). Returns 0 for an empty,
 * single-point, or monotonically non-decreasing series.
 * @param closes Chronological close prices.
 */
export function computeMaxDrawdown(closes: number[]): number {
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const close of closes) {
    if (!Number.isFinite(close)) continue;
    if (close > peak) peak = close;
    if (peak > 0) {
      const drawdown = (close - peak) / peak;
      if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    }
  }
  return maxDrawdown;
}

// ── US-equity market session (#4922d) ───────────────────────────────────────
// TypeScript twin of scripts/shared/market-hours.cjs — the single source of
// truth for relays/seeders. Server code must NOT import that .cjs (Vercel
// bundling), so the ~40 lines of session rules are duplicated here. Keep the
// boundaries in lockstep: pre 04:00–09:30, regular 09:30–16:00, post
// 16:00–20:00 ET; early-close days end regular at 13:00 with post
// 13:00–17:00; weekends + full NYSE holidays closed all day.
// tests/market-hours.test.mjs cross-checks both implementations.

export type UsEquitySession = 'regular' | 'pre' | 'post' | 'closed';

const ET_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function etDow(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number {
  return 1 + ((weekday - etDow(year, month, 1) + 7) % 7) + (n - 1) * 7;
}

function shiftDays(year: number, month: number, day: number, delta: number): { month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function observedHoliday(year: number, month: number, day: number): { month: number; day: number } {
  const w = etDow(year, month, day);
  if (w === 6) return shiftDays(year, month, day, -1); // Sat → Fri
  if (w === 0) return shiftDays(year, month, day, 1);  // Sun → Mon
  return { month, day };
}

function isNyseFullHoliday(year: number, month: number, day: number): boolean {
  const key = month * 100 + day;
  const holidays = new Set<number>();
  // New Year's Day — no Sat→Fri shift (NYSE stays open the preceding Friday).
  const nyDow = etDow(year, 1, 1);
  if (nyDow === 0) holidays.add(102);
  else if (nyDow !== 6) holidays.add(101);
  holidays.add(100 + nthWeekdayOfMonth(year, 1, 1, 3));  // MLK
  holidays.add(200 + nthWeekdayOfMonth(year, 2, 1, 3));  // Presidents
  // Good Friday — anonymous Gregorian computus (Meeus/Jones/Butcher).
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easterMonth = Math.floor((h + l - 7 * m + 114) / 31);
  const easterDay = ((h + l - 7 * m + 114) % 31) + 1;
  const gf = shiftDays(year, easterMonth, easterDay, -2);
  holidays.add(gf.month * 100 + gf.day);
  const lastDayMay = new Date(Date.UTC(year, 5, 0)).getUTCDate();
  holidays.add(500 + lastDayMay - ((etDow(year, 5, lastDayMay) - 1 + 7) % 7)); // Memorial
  const jt = observedHoliday(year, 6, 19);
  holidays.add(jt.month * 100 + jt.day);                 // Juneteenth
  const ind = observedHoliday(year, 7, 4);
  holidays.add(ind.month * 100 + ind.day);               // Independence
  holidays.add(900 + nthWeekdayOfMonth(year, 9, 1, 1));  // Labor
  holidays.add(1100 + nthWeekdayOfMonth(year, 11, 4, 4)); // Thanksgiving
  const xmas = observedHoliday(year, 12, 25);
  holidays.add(xmas.month * 100 + xmas.day);             // Christmas
  return holidays.has(key);
}

function isNyseEarlyCloseDay(year: number, month: number, day: number): boolean {
  const w = etDow(year, month, day);
  if (w === 0 || w === 6 || isNyseFullHoliday(year, month, day)) return false;
  if (month === 7 && day === 3) return true;
  if (month === 12 && day === 24) return true;
  if (month === 11 && day === nthWeekdayOfMonth(year, 11, 4, 4) + 1) return true;
  return false;
}

export function getUsEquitySessionAt(date: Date = new Date()): UsEquitySession {
  const parts: Record<string, string> = {};
  for (const part of ET_PARTS_FMT.formatToParts(date)) parts[part.type] = part.value;
  const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return 'closed';
  if (isNyseFullHoliday(year, month, day)) return 'closed';
  const early = isNyseEarlyCloseDay(year, month, day);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const closeMin = early ? 13 * 60 : 16 * 60;
  const postEndMin = early ? 17 * 60 : 20 * 60;
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 'pre';
  if (minutes >= 9 * 60 + 30 && minutes < closeMin) return 'regular';
  if (minutes >= closeMin && minutes < postEndMin) return 'post';
  return 'closed';
}

// US market-hours semantics apply to US listings only: Yahoo reports USD for
// them, and non-US listings carry an exchange suffix (RELIANCE.NS, BMW.DE, …).
// USD without a suffix covers NYSE/Nasdaq stocks, US indices (^GSPC) and
// US-listed ADRs (TSM, NVO) — for everything else marketSession stays ''.
export function usEquityHoursApply(symbol: string, currency: string): boolean {
  return currency === 'USD' && !/\.[A-Za-z]+$/.test(symbol);
}

export type ExtendedHoursQuote = { price: number; changePercent: number };

/**
 * Latest pre/post-market print for a US symbol via the Yahoo 5-minute chart
 * (`includePrePost=true`). Returns the newest finite close inside the CURRENT
 * session's own [start, end) window from meta.currentTradingPeriod[session] —
 * so an early-pre-market range=1d chart carrying the prior session's candles
 * can't leak yesterday's close in as today's pre-market print — with the change
 * measured against the last REGULAR close (meta.regularMarketPrice, falling
 * back to chartPreviousClose). Null when Yahoo has no candle in that window or
 * no usable trading-period metadata.
 */
export async function fetchExtendedHoursQuote(
  symbol: string,
  session: 'pre' | 'post',
): Promise<ExtendedHoursQuote | null> {
  try {
    await yahooGate();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=true`;
    const response = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const data = await response.json() as YahooChartResponse;
    const result = data.chart?.result?.[0];
    const period = result?.meta?.currentTradingPeriod?.[session];
    const windowStart = period?.start;
    const windowEnd = period?.end;
    // Require the CURRENT session's own [start, end) bounds. Gating pre only on
    // `ts < regularStart` was unbounded below: in early pre-market, before
    // today's pre candles publish, a range=1d chart still carries the prior
    // session's candles (all older than today's regular start), so the newest
    // match would be yesterday's post-market close returned as today's pre.
    if (typeof windowStart !== 'number' || typeof windowEnd !== 'number') return null;
    const lastRegularClose = [result?.meta?.regularMarketPrice, result?.meta?.chartPreviousClose]
      .find((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
    if (lastRegularClose === undefined) return null;

    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    for (let i = timestamps.length - 1; i >= 0; i--) {
      const ts = timestamps[i];
      const close = closes[i];
      if (typeof ts !== 'number' || typeof close !== 'number' || !Number.isFinite(close) || close <= 0) continue;
      if (ts < windowStart || ts >= windowEnd) continue; // outside this session's window
      return {
        price: round(close),
        changePercent: round(((close - lastRegularClose) / lastRegularClose) * 100),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchYahooHistory(symbol: string): Promise<{ candles: Candle[]; currency: string } | null> {
  await yahooGate();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d&includePrePost=true&events=div,splits`;
  const response = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) return null;

  const data = await response.json() as YahooChartResponse;
  const result = data.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = quote?.close ?? [];
  const opens = quote?.open ?? [];
  const highs = quote?.high ?? [];
  const lows = quote?.low ?? [];
  const volumes = quote?.volume ?? [];

  const candles: Candle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    const open = opens[i];
    const high = highs[i];
    const low = lows[i];
    if (![close, open, high, low].every(
      (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
    )) continue;
    if ((high as number) < Math.max(open as number, close as number, low as number)
      || (low as number) > Math.min(open as number, close as number, high as number)) continue;
    candles.push({
      timestamp: (timestamps[i] ?? 0) * 1000,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: typeof volumes[i] === 'number' && Number.isFinite(volumes[i]) ? (volumes[i] as number) : 0,
    });
  }

  if (candles.length < 30) return null;
  return { candles, currency: result?.meta?.currency || 'USD' };
}

function safeRaw(field: { raw?: number } | undefined): number {
  return typeof field?.raw === 'number' && Number.isFinite(field.raw) ? field.raw : 0;
}

function optionalPositive(field: { raw?: number } | undefined): number | undefined {
  const raw = field?.raw;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

// Like optionalPositive but keeps negatives — margins, growth and returns can
// legitimately be below zero, so they must not be dropped as "missing".
function optionalFinite(field: { raw?: number } | undefined): number | undefined {
  const raw = field?.raw;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function optionalYahooDebtToEquity(field: { raw?: number } | undefined): number | undefined {
  const raw = optionalFinite(field);
  // Yahoo expresses this field in percentage points (150 means 1.5x).
  return raw === undefined ? undefined : raw / 100;
}

function optionalFinancialCurrency(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : undefined;
}

const EMPTY_ANALYST_DATA: AnalystData = {
  analystConsensus: { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, total: 0, period: '' },
  priceTarget: { numberOfAnalysts: 0 },
  recentUpgrades: [],
  fundamentals: {},
};

export async function fetchYahooAnalystData(symbol: string): Promise<AnalystData> {
  try {
    await yahooGate();
    const modules = 'recommendationTrend,financialData,upgradeDowngradeHistory';
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return EMPTY_ANALYST_DATA;

    const data = await response.json() as YahooQuoteSummaryResponse;
    const result = data.quoteSummary?.result?.[0];
    if (!result) return EMPTY_ANALYST_DATA;

    const currentPeriod = result.recommendationTrend?.trend?.find((t) => t.period === '0m') || result.recommendationTrend?.trend?.[0];
    const analystConsensus: AnalystConsensus = currentPeriod ? {
      strongBuy: typeof currentPeriod.strongBuy === 'number' ? currentPeriod.strongBuy : 0,
      buy: typeof currentPeriod.buy === 'number' ? currentPeriod.buy : 0,
      hold: typeof currentPeriod.hold === 'number' ? currentPeriod.hold : 0,
      sell: typeof currentPeriod.sell === 'number' ? currentPeriod.sell : 0,
      strongSell: typeof currentPeriod.strongSell === 'number' ? currentPeriod.strongSell : 0,
      total: (typeof currentPeriod.strongBuy === 'number' ? currentPeriod.strongBuy : 0)
        + (typeof currentPeriod.buy === 'number' ? currentPeriod.buy : 0)
        + (typeof currentPeriod.hold === 'number' ? currentPeriod.hold : 0)
        + (typeof currentPeriod.sell === 'number' ? currentPeriod.sell : 0)
        + (typeof currentPeriod.strongSell === 'number' ? currentPeriod.strongSell : 0),
      period: currentPeriod.period || '0m',
    } : EMPTY_ANALYST_DATA.analystConsensus;

    const fd = result.financialData;
    const priceTarget: PriceTarget = fd ? {
      high: optionalPositive(fd.targetHighPrice),
      low: optionalPositive(fd.targetLowPrice),
      mean: optionalPositive(fd.targetMeanPrice),
      median: optionalPositive(fd.targetMedianPrice),
      current: optionalPositive(fd.currentPrice),
      numberOfAnalysts: safeRaw(fd.numberOfAnalystOpinions),
    } : EMPTY_ANALYST_DATA.priceTarget;

    const rawHistory = result.upgradeDowngradeHistory?.history ?? [];
    const recentUpgrades: UpgradeDowngrade[] = rawHistory.slice(0, 5).map((entry) => ({
      firm: typeof entry.firm === 'string' ? entry.firm : '',
      toGrade: typeof entry.toGrade === 'string' ? entry.toGrade : '',
      fromGrade: typeof entry.fromGrade === 'string' ? entry.fromGrade : '',
      action: typeof entry.action === 'string' ? entry.action : '',
      epochGradeDate: typeof entry.epochGradeDate === 'number' ? entry.epochGradeDate : 0,
    })).filter((u) => u.firm);

    // Quality/growth/leverage fundamentals from the same financialData module.
    const fundamentals: StockFundamentals = fd ? {
      profitMargin: optionalFinite(fd.profitMargins),
      grossMargin: optionalFinite(fd.grossMargins),
      operatingMargin: optionalFinite(fd.operatingMargins),
      returnOnEquity: optionalFinite(fd.returnOnEquity),
      returnOnAssets: optionalFinite(fd.returnOnAssets),
      revenueGrowth: optionalFinite(fd.revenueGrowth),
      earningsGrowth: optionalFinite(fd.earningsGrowth),
      debtToEquity: optionalYahooDebtToEquity(fd.debtToEquity),
      totalCash: optionalFinite(fd.totalCash),
      totalDebt: optionalFinite(fd.totalDebt),
      freeCashflow: optionalFinite(fd.freeCashflow),
      ebitda: optionalFinite(fd.ebitda),
      financialCurrency: optionalFinancialCurrency(fd.financialCurrency),
    } : {};

    return { analystConsensus, priceTarget, recentUpgrades, fundamentals };
  } catch {
    return EMPTY_ANALYST_DATA;
  }
}

export function buildTechnicalSnapshot(candles: Candle[]): TechnicalSnapshot {
  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const volumes = candles.map((candle) => candle.volume);

  const ma5Series = smaSeries(closes, 5);
  const ma10Series = smaSeries(closes, 10);
  const ma20Series = smaSeries(closes, 20);
  const ma60Series = candles.length >= 60 ? smaSeries(closes, 60) : ma20Series.slice();
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdDifSeries = closes.map((_, index) => (ema12[index] ?? 0) - (ema26[index] ?? 0));
  const macdDeaSeries = emaSeries(macdDifSeries, 9);
  const macdBarSeries = macdDifSeries.map((value, index) => (value - (macdDeaSeries[index] ?? 0)) * 2);
  const rsi6Series = rsiSeries(closes, 6);
  const rsi12Series = rsiSeries(closes, 12);
  const rsi24Series = rsiSeries(closes, 24);

  const latestIndex = closes.length - 1;
  const prevIndex = Math.max(0, latestIndex - 1);
  const spreadIndex = Math.max(0, latestIndex - 4);

  const currentPrice = closes[latestIndex] ?? 0;
  const previousClose = closes[prevIndex] ?? currentPrice;
  const ma5 = latestFinite(ma5Series);
  const ma10 = latestFinite(ma10Series);
  const ma20 = latestFinite(ma20Series);
  const ma60 = latestFinite(ma60Series);
  const macdDif = macdDifSeries[latestIndex] ?? 0;
  const macdDea = macdDeaSeries[latestIndex] ?? 0;
  const macdBar = macdBarSeries[latestIndex] ?? 0;
  const rsi6 = rsi6Series[latestIndex] ?? 50;
  const rsi12 = rsi12Series[latestIndex] ?? 50;
  const rsi24 = rsi24Series[latestIndex] ?? 50;

  let trendStatus: TrendStatus = 'Consolidation';
  let trendStrength = 50;
  let maAlignment = 'Moving averages are compressed and direction is unclear.';

  if (ma5 > ma10 && ma10 > ma20) {
    const prevSpread = ((ma5Series[spreadIndex] ?? ma5) - (ma20Series[spreadIndex] ?? ma20)) / Math.max(ma20Series[spreadIndex] ?? ma20, 0.0001) * 100;
    const currSpread = (ma5 - ma20) / Math.max(ma20, 0.0001) * 100;
    if (currSpread > prevSpread && currSpread > 5) {
      trendStatus = 'Strong bull';
      trendStrength = 90;
      maAlignment = 'MA5 > MA10 > MA20 with expanding separation.';
    } else {
      trendStatus = 'Bull';
      trendStrength = 75;
      maAlignment = 'MA5 > MA10 > MA20 confirms a bullish stack.';
    }
  } else if (ma5 > ma10 && ma10 <= ma20) {
    trendStatus = 'Weak bull';
    trendStrength = 55;
    maAlignment = 'Short-term trend is positive but MA20 still lags.';
  } else if (ma5 < ma10 && ma10 < ma20) {
    const prevSpread = ((ma20Series[spreadIndex] ?? ma20) - (ma5Series[spreadIndex] ?? ma5)) / Math.max(ma5Series[spreadIndex] ?? ma5, 0.0001) * 100;
    const currSpread = (ma20 - ma5) / Math.max(ma5, 0.0001) * 100;
    if (currSpread > prevSpread && currSpread > 5) {
      trendStatus = 'Strong bear';
      trendStrength = 10;
      maAlignment = 'MA5 < MA10 < MA20 with widening downside separation.';
    } else {
      trendStatus = 'Bear';
      trendStrength = 25;
      maAlignment = 'MA5 < MA10 < MA20 confirms a bearish stack.';
    }
  } else if (ma5 < ma10 && ma10 >= ma20) {
    trendStatus = 'Weak bear';
    trendStrength = 40;
    maAlignment = 'Short-term momentum is weak while MA20 still props the trend.';
  }

  const biasMa5 = ((currentPrice - ma5) / Math.max(ma5, 0.0001)) * 100;
  const biasMa10 = ((currentPrice - ma10) / Math.max(ma10, 0.0001)) * 100;
  const biasMa20 = ((currentPrice - ma20) / Math.max(ma20, 0.0001)) * 100;

  const prevFiveVolume = volumes.slice(Math.max(0, volumes.length - 6), volumes.length - 1).filter((value) => value > 0);
  const volumeRatio5d = prevFiveVolume.length > 0 ? (volumes[latestIndex] ?? 0) / mean(prevFiveVolume) : 0;
  const dayChange = ((currentPrice - previousClose) / Math.max(previousClose, 0.0001)) * 100;

  let volumeStatus: VolumeStatus = 'Normal';
  let volumeTrend = 'Volume is close to the recent baseline.';
  if (volumeRatio5d >= VOLUME_HEAVY_RATIO) {
    if (dayChange > 0) {
      volumeStatus = 'Heavy volume up';
      volumeTrend = 'Price rose on strong participation.';
    } else {
      volumeStatus = 'Heavy volume down';
      volumeTrend = 'Selling pressure expanded sharply.';
    }
  } else if (volumeRatio5d <= VOLUME_SHRINK_RATIO) {
    if (dayChange > 0) {
      volumeStatus = 'Shrink volume up';
      volumeTrend = 'Price pushed higher but participation stayed light.';
    } else {
      volumeStatus = 'Shrink volume down';
      volumeTrend = 'Pullback happened on lighter volume, which often signals digestion instead of panic.';
    }
  }

  const supportLevels: number[] = [];
  let supportMa5 = false;
  let supportMa10 = false;
  const ma5Distance = Math.abs(currentPrice - ma5) / Math.max(ma5, 0.0001);
  if (ma5Distance <= MA_SUPPORT_TOLERANCE && currentPrice >= ma5) {
    supportMa5 = true;
    supportLevels.push(ma5);
  }
  const ma10Distance = Math.abs(currentPrice - ma10) / Math.max(ma10, 0.0001);
  if (ma10Distance <= MA_SUPPORT_TOLERANCE && currentPrice >= ma10) {
    supportMa10 = true;
    supportLevels.push(ma10);
  }
  if (currentPrice >= ma20) supportLevels.push(ma20);
  const recentHigh = Math.max(...highs.slice(-20));
  const resistanceLevels = recentHigh > currentPrice ? [recentHigh] : [];

  const prevMacdGap = (macdDifSeries[prevIndex] ?? 0) - (macdDeaSeries[prevIndex] ?? 0);
  const currMacdGap = macdDif - macdDea;
  const isGoldenCross = prevMacdGap <= 0 && currMacdGap > 0;
  const isDeathCross = prevMacdGap >= 0 && currMacdGap < 0;
  const prevZero = macdDifSeries[prevIndex] ?? 0;
  const isCrossingUp = prevZero <= 0 && macdDif > 0;
  const isCrossingDown = prevZero >= 0 && macdDif < 0;

  let macdStatus: MacdStatus = 'Bullish';
  let macdSignal = 'MACD is neutral.';
  if (isGoldenCross && macdDif > 0) {
    macdStatus = 'Golden cross above zero';
    macdSignal = 'MACD flashed a golden cross above the zero line.';
  } else if (isCrossingUp) {
    macdStatus = 'Crossing up';
    macdSignal = 'MACD moved back above the zero line.';
  } else if (isGoldenCross) {
    macdStatus = 'Golden cross';
    macdSignal = 'MACD turned up with a fresh golden cross.';
  } else if (isDeathCross) {
    macdStatus = 'Death cross';
    macdSignal = 'MACD rolled over into a death cross.';
  } else if (isCrossingDown) {
    macdStatus = 'Crossing down';
    macdSignal = 'MACD slipped below the zero line.';
  } else if (macdDif > 0 && macdDea > 0) {
    macdStatus = 'Bullish';
    macdSignal = 'MACD remains above zero and constructive.';
  } else if (macdDif < 0 && macdDea < 0) {
    macdStatus = 'Bearish';
    macdSignal = 'MACD remains below zero and defensive.';
  }

  let rsiStatus: RsiStatus = 'Neutral';
  let rsiSignal = `RSI(12) is ${round(rsi12, 1)}.`;
  if (rsi12 > 70) {
    rsiStatus = 'Overbought';
    rsiSignal = `RSI(12) at ${round(rsi12, 1)} suggests stretched momentum.`;
  } else if (rsi12 > 60) {
    rsiStatus = 'Strong buy';
    rsiSignal = `RSI(12) at ${round(rsi12, 1)} confirms strong upside momentum.`;
  } else if (rsi12 >= 40) {
    rsiStatus = 'Neutral';
    rsiSignal = `RSI(12) at ${round(rsi12, 1)} sits in the neutral zone.`;
  } else if (rsi12 >= 30) {
    rsiStatus = 'Weak';
    rsiSignal = `RSI(12) at ${round(rsi12, 1)} shows weak momentum but not washout.`;
  } else {
    rsiStatus = 'Oversold';
    rsiSignal = `RSI(12) at ${round(rsi12, 1)} is deeply oversold.`;
  }

  let signalScore = 0;
  const bullishFactors: string[] = [];
  const riskFactors: string[] = [];

  const trendScores: Record<TrendStatus, number> = {
    'Strong bull': 30,
    'Bull': 26,
    'Weak bull': 18,
    'Consolidation': 12,
    'Weak bear': 8,
    'Bear': 4,
    'Strong bear': 0,
  };
  signalScore += trendScores[trendStatus];
  if (trendStatus === 'Strong bull' || trendStatus === 'Bull') bullishFactors.push(`${trendStatus}: trend structure stays in buyers' favor.`);
  if (trendStatus === 'Bear' || trendStatus === 'Strong bear') riskFactors.push(`${trendStatus}: moving-average structure is still working against longs.`);

  const effectiveThreshold = trendStatus === 'Strong bull' && trendStrength >= 70 ? BIAS_THRESHOLD * 1.5 : BIAS_THRESHOLD;
  if (biasMa5 < 0) {
    if (biasMa5 > -3) {
      signalScore += 20;
      bullishFactors.push(`Price is only ${round(biasMa5, 1)}% below MA5, a controlled pullback.`);
    } else if (biasMa5 > -5) {
      signalScore += 16;
      bullishFactors.push(`Price is testing MA5 support at ${round(biasMa5, 1)}% below the line.`);
    } else {
      signalScore += 8;
      riskFactors.push(`Price is ${round(biasMa5, 1)}% below MA5, which raises breakdown risk.`);
    }
  } else if (biasMa5 < 2) {
    signalScore += 18;
    bullishFactors.push(`Price is hugging MA5 with only ${round(biasMa5, 1)}% extension.`);
  } else if (biasMa5 < BIAS_THRESHOLD) {
    signalScore += 14;
    bullishFactors.push(`Price is modestly extended at ${round(biasMa5, 1)}% above MA5.`);
  } else if (biasMa5 > effectiveThreshold) {
    signalScore += 4;
    riskFactors.push(`Price is ${round(biasMa5, 1)}% above MA5, which is a chasing setup.`);
  } else {
    signalScore += 10;
    bullishFactors.push(`Strong trend gives some room for the current ${round(biasMa5, 1)}% extension.`);
  }

  const volumeScores: Record<VolumeStatus, number> = {
    'Shrink volume down': 15,
    'Heavy volume up': 12,
    'Normal': 10,
    'Shrink volume up': 6,
    'Heavy volume down': 0,
  };
  signalScore += volumeScores[volumeStatus];
  if (volumeStatus === 'Shrink volume down') bullishFactors.push('Pullback volume is light, which supports the consolidation thesis.');
  if (volumeStatus === 'Heavy volume down') riskFactors.push('Downside move arrived with heavy volume.');

  if (supportMa5) {
    signalScore += 5;
    bullishFactors.push('Price is holding the MA5 support area.');
  }
  if (supportMa10) {
    signalScore += 5;
    bullishFactors.push('Price is holding the MA10 support area.');
  }

  const macdScores: Record<MacdStatus, number> = {
    'Golden cross above zero': 15,
    'Golden cross': 12,
    'Crossing up': 10,
    'Bullish': 8,
    'Bearish': 2,
    'Crossing down': 0,
    'Death cross': 0,
  };
  signalScore += macdScores[macdStatus];
  if (macdStatus === 'Golden cross above zero' || macdStatus === 'Golden cross') bullishFactors.push(macdSignal);
  else if (macdStatus === 'Death cross' || macdStatus === 'Crossing down') riskFactors.push(macdSignal);
  else bullishFactors.push(macdSignal);

  const rsiScores: Record<RsiStatus, number> = {
    'Oversold': 10,
    'Strong buy': 8,
    'Neutral': 5,
    'Weak': 3,
    'Overbought': 0,
  };
  signalScore += rsiScores[rsiStatus];
  if (rsiStatus === 'Oversold' || rsiStatus === 'Strong buy') bullishFactors.push(rsiSignal);
  else if (rsiStatus === 'Overbought') riskFactors.push(rsiSignal);
  else bullishFactors.push(rsiSignal);

  signalScore = clamp(Math.round(signalScore), 0, 100);

  let signal: Signal = 'Sell';
  if (signalScore >= 75 && (trendStatus === 'Strong bull' || trendStatus === 'Bull')) signal = 'Strong buy';
  else if (signalScore >= 60 && (trendStatus === 'Strong bull' || trendStatus === 'Bull' || trendStatus === 'Weak bull')) signal = 'Buy';
  else if (signalScore >= 45) signal = 'Hold';
  else if (signalScore >= 30) signal = 'Watch';
  else if (trendStatus === 'Bear' || trendStatus === 'Strong bear') signal = 'Strong sell';

  const realizedVolatility = computeRealizedVolatility(closes);
  const atr = computeAtr(highs, lows, closes);
  const maxDrawdown = computeMaxDrawdown(closes);

  return {
    currentPrice: round(currentPrice),
    changePercent: round(((currentPrice - previousClose) / Math.max(previousClose, 0.0001)) * 100),
    currency: 'USD',
    ma5: round(ma5),
    ma10: round(ma10),
    ma20: round(ma20),
    ma60: round(ma60),
    biasMa5: round(biasMa5),
    biasMa10: round(biasMa10),
    biasMa20: round(biasMa20),
    trendStatus,
    trendStrength,
    maAlignment,
    volumeStatus,
    volumeRatio5d: round(volumeRatio5d),
    volumeTrend,
    supportLevels: uniqueRounded(supportLevels),
    resistanceLevels: uniqueRounded(resistanceLevels),
    supportMa5,
    supportMa10,
    macdDif: round(macdDif, 4),
    macdDea: round(macdDea, 4),
    macdBar: round(macdBar, 4),
    macdStatus,
    macdSignal,
    rsi6: round(rsi6, 1),
    rsi12: round(rsi12, 1),
    rsi24: round(rsi24, 1),
    rsiStatus,
    rsiSignal,
    signal,
    signalScore,
    bullishFactors: bullishFactors.slice(0, 6),
    riskFactors: riskFactors.slice(0, 6),
    realizedVolatility: round(realizedVolatility, 4),
    atr: round(atr, 2),
    maxDrawdown: round(maxDrawdown, 4),
  };
}

// Shared earnings-calendar seed (scripts/seed-earnings-calendar.mjs): a bulk
// list of upcoming/recent reporters, TTL 36h. analyze-stock joins the current
// symbol against it to surface the next-earnings catalyst.
const EARNINGS_CALENDAR_CACHE_KEY = 'market:earnings-calendar:v1';

export type UpcomingEarnings = {
  nextEarningsDate: string;
  consensusEps?: number;
  consensusRevenue?: number;
};

/**
 * Pick the next upcoming earnings event for `symbol` from the earnings-calendar
 * seed. The seed window looks back 7 days, so it also holds already-reported
 * events — this returns only the earliest entry dated `todayStr` or later that
 * has not yet reported (hasActuals === false), and omits absent/zero estimates.
 * Returns null when the symbol has no upcoming entry.
 */
export function selectEarningsForSymbol(
  earnings: readonly EarningsEntry[],
  symbol: string,
  todayStr: string,
): UpcomingEarnings | null {
  let pick: EarningsEntry | null = null;
  for (const entry of earnings) {
    if (entry.symbol !== symbol || entry.hasActuals || !entry.date || entry.date < todayStr) continue;
    if (!pick || entry.date < pick.date) pick = entry;
  }
  if (!pick) return null;
  const result: UpcomingEarnings = { nextEarningsDate: pick.date };
  if (Number.isFinite(pick.epsEstimate) && pick.epsEstimate !== 0) result.consensusEps = pick.epsEstimate;
  if (Number.isFinite(pick.revenueEstimate) && pick.revenueEstimate > 0) result.consensusRevenue = pick.revenueEstimate;
  return result;
}

/** Read the shared earnings-calendar seed; returns [] when absent or unreachable. */
async function fetchUpcomingEarnings(): Promise<EarningsEntry[]> {
  try {
    const cached = await getCachedJson(EARNINGS_CALENDAR_CACHE_KEY, true) as { earnings?: EarningsEntry[] } | null;
    return cached?.earnings ?? [];
  } catch {
    return [];
  }
}

export function getFallbackOverlay(name: string, technical: TechnicalSnapshot, headlines: StockAnalysisHeadline[]): AiOverlay {
  const technicalSummary = `${technical.maAlignment} ${technical.volumeTrend} ${technical.macdSignal} ${technical.rsiSignal}`;
  const newsSummary = headlines.length > 0
    ? `Recent coverage is led by ${headlines[0]?.source || 'market press'}: ${headlines[0]?.title || 'no headline available'}`
    : 'No material recent headlines were pulled into the report.';
  const actionMap: Record<Signal, string> = {
    'Strong buy': 'Build or add on controlled pullbacks.',
    'Buy': 'Accumulate selectively while the trend holds.',
    'Hold': 'Keep exposure but wait for a cleaner entry or confirmation.',
    'Watch': 'Stay patient until the setup improves.',
    'Sell': 'Reduce exposure into strength.',
    'Strong sell': 'Exit or avoid new long exposure.',
  };
  const confidence = technical.signalScore >= 75 ? 'High' : technical.signalScore >= 55 ? 'Medium' : 'Low';
  return {
    summary: `${name} screens as ${technical.signal.toLowerCase()} with a ${technical.trendStatus.toLowerCase()} setup and a ${technical.signalScore}/100 score.`,
    action: actionMap[technical.signal],
    confidence,
    whyNow: `Price sits ${technical.biasMa5}% versus MA5, MACD is ${technical.macdStatus.toLowerCase()}, and RSI(12) is ${technical.rsi12}.`,
    technicalSummary,
    newsSummary,
    bullishFactors: technical.bullishFactors.slice(0, 4),
    riskFactors: technical.riskFactors.slice(0, 4),
    provider: 'rules',
    model: '',
    fallback: true,
  };
}

async function buildAiOverlay(
  symbol: string,
  name: string,
  technical: TechnicalSnapshot,
  headlines: StockAnalysisHeadline[],
  fundamentals: StockFundamentals,
): Promise<AiOverlay> {
  const fallback = getFallbackOverlay(name, technical, headlines);
  const hasFundamentals = Object.values(fundamentals).some((v) => typeof v === 'number');
  const llm = await callLlm({
    messages: [
      {
        role: 'system',
        content: 'You are a disciplined stock analyst. Weigh the fundamentals alongside the technicals and news — do not judge on price action alone. All margin, return, growth, and debtToEquity values are decimal ratios (0.25 means 25%; debtToEquity 1.5 means debt is 1.5x equity). totalCash, totalDebt, freeCashflow, and ebitda are denominated in fundamentals.financialCurrency. Treat missing values as unknown. Return strict JSON only with keys: summary, action, confidence, whyNow, technicalSummary, newsSummary, bullishFactors, riskFactors. Keep it concise, factual, and free of disclaimers.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          symbol,
          name,
          technical: {
            signal: technical.signal,
            signalScore: technical.signalScore,
            trendStatus: technical.trendStatus,
            maAlignment: technical.maAlignment,
            currentPrice: technical.currentPrice,
            changePercent: technical.changePercent,
            ma5: technical.ma5,
            ma10: technical.ma10,
            ma20: technical.ma20,
            ma60: technical.ma60,
            biasMa5: technical.biasMa5,
            volumeStatus: technical.volumeStatus,
            volumeRatio5d: technical.volumeRatio5d,
            macdStatus: technical.macdStatus,
            macdSignal: technical.macdSignal,
            rsi12: technical.rsi12,
            rsiStatus: technical.rsiStatus,
            bullishFactors: technical.bullishFactors,
            riskFactors: technical.riskFactors,
            supportLevels: technical.supportLevels,
            resistanceLevels: technical.resistanceLevels,
          },
          headlines: headlines.map((headline) => ({
            title: headline.title,
            source: headline.source,
            publishedAt: headline.publishedAt,
          })),
          // Only sent when present; JSON.stringify drops undefined members.
          fundamentals: hasFundamentals ? fundamentals : undefined,
        }),
      },
    ],
    temperature: 0.2,
    maxTokens: 500,
    timeoutMs: 20_000,
    stage: 'analyze-stock',
    providerOrder: ['openrouter', 'generic'],
    validate: (content) => {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        return typeof parsed.summary === 'string' && typeof parsed.action === 'string';
      } catch {
        return false;
      }
    },
  });

  if (!llm) return fallback;

  try {
    const parsed = JSON.parse(llm.content) as {
      summary?: string;
      action?: string;
      confidence?: string;
      whyNow?: string;
      technicalSummary?: string;
      newsSummary?: string;
      bullishFactors?: string[];
      riskFactors?: string[];
    };

    return {
      summary: parsed.summary?.trim() || fallback.summary,
      action: parsed.action?.trim() || fallback.action,
      confidence: parsed.confidence?.trim() || fallback.confidence,
      whyNow: parsed.whyNow?.trim() || fallback.whyNow,
      technicalSummary: parsed.technicalSummary?.trim() || fallback.technicalSummary,
      newsSummary: parsed.newsSummary?.trim() || fallback.newsSummary,
      bullishFactors: Array.isArray(parsed.bullishFactors) && parsed.bullishFactors.length > 0 ? parsed.bullishFactors.slice(0, 4) : fallback.bullishFactors,
      riskFactors: Array.isArray(parsed.riskFactors) && parsed.riskFactors.length > 0 ? parsed.riskFactors.slice(0, 4) : fallback.riskFactors,
      provider: llm.provider,
      model: llm.model,
      fallback: false,
    };
  } catch {
    return fallback;
  }
}

export function buildAnalysisResponse(params: {
  symbol: string;
  name: string;
  currency: string;
  technical: TechnicalSnapshot;
  headlines: StockAnalysisHeadline[];
  overlay: AiOverlay;
  analystData: AnalystData;
  includeNews: boolean;
  analysisAt: number;
  generatedAt: string;
  analysisId?: string;
  dividend?: DividendProfile;
  marketSession?: string;
  extended?: ExtendedHoursQuote;
  earnings?: UpcomingEarnings | null;
}): AnalyzeStockResponse {
  const {
    symbol,
    name,
    currency,
    technical,
    headlines,
    overlay,
    analystData,
    includeNews,
    analysisAt,
    generatedAt,
    dividend,
    marketSession,
    extended,
    earnings,
  } = params;
  const analysisId = params.analysisId || `stock:${STOCK_ANALYSIS_ENGINE_VERSION}:${symbol}:${analysisAt}:${includeNews ? 'news' : 'core'}`;
  const { stopLoss, takeProfit } = deriveTradeLevels(
    technical.signal,
    technical.currentPrice,
    technical.supportLevels,
    technical.resistanceLevels,
  );

  return {
    available: true,
    symbol,
    name,
    display: symbol,
    currency,
    currentPrice: technical.currentPrice,
    changePercent: technical.changePercent,
    signalScore: technical.signalScore,
    signal: technical.signal,
    trendStatus: technical.trendStatus,
    volumeStatus: technical.volumeStatus,
    macdStatus: technical.macdStatus,
    rsiStatus: technical.rsiStatus,
    summary: overlay.summary,
    action: overlay.action,
    confidence: overlay.confidence,
    technicalSummary: overlay.technicalSummary,
    newsSummary: overlay.newsSummary,
    whyNow: overlay.whyNow,
    bullishFactors: overlay.bullishFactors,
    riskFactors: overlay.riskFactors,
    supportLevels: technical.supportLevels,
    resistanceLevels: technical.resistanceLevels,
    headlines,
    ma5: technical.ma5,
    ma10: technical.ma10,
    ma20: technical.ma20,
    ma60: technical.ma60,
    biasMa5: technical.biasMa5,
    biasMa10: technical.biasMa10,
    biasMa20: technical.biasMa20,
    volumeRatio5d: technical.volumeRatio5d,
    rsi12: technical.rsi12,
    macdDif: technical.macdDif,
    macdDea: technical.macdDea,
    macdBar: technical.macdBar,
    realizedVolatility: technical.realizedVolatility,
    atr: technical.atr,
    maxDrawdown: technical.maxDrawdown,
    provider: overlay.provider,
    model: overlay.model,
    fallback: overlay.fallback,
    newsSearched: includeNews,
    generatedAt,
    analysisId,
    analysisAt,
    stopLoss,
    takeProfit,
    engineVersion: STOCK_ANALYSIS_ENGINE_VERSION,
    analystConsensus: analystData.analystConsensus,
    priceTarget: analystData.priceTarget,
    recentUpgrades: analystData.recentUpgrades,
    fundamentals: analystData.fundamentals,
    dividendYield: dividend?.dividendYield ?? 0,
    trailingAnnualDividendRate: dividend?.trailingAnnualDividendRate ?? 0,
    exDividendDate: dividend?.exDividendDate ?? 0,
    payoutRatio: dividend?.payoutRatio,
    dividendFrequency: dividend?.dividendFrequency ?? '',
    dividendCagr: dividend?.dividendCagr ?? 0,
    marketSession: marketSession ?? '',
    // Optional proto fields OMIT their keys when unset — never explicit null.
    ...(extended ? { extendedPrice: extended.price, extendedChangePercent: extended.changePercent } : {}),
    ...(earnings ? {
      nextEarningsDate: earnings.nextEarningsDate,
      ...(earnings.consensusEps != null ? { consensusEps: earnings.consensusEps } : {}),
      ...(earnings.consensusRevenue != null ? { consensusRevenue: earnings.consensusRevenue } : {}),
    } : {}),
  };
}

function buildEmptyAnalysisResponse(symbol: string, name: string, includeNews: boolean): AnalyzeStockResponse {
  return {
    available: false,
    symbol,
    name,
    display: symbol,
    currency: '',
    currentPrice: 0,
    changePercent: 0,
    signalScore: 0,
    signal: '',
    trendStatus: '',
    volumeStatus: '',
    macdStatus: '',
    rsiStatus: '',
    summary: '',
    action: '',
    confidence: '',
    technicalSummary: '',
    newsSummary: '',
    whyNow: '',
    bullishFactors: [],
    riskFactors: [],
    supportLevels: [],
    resistanceLevels: [],
    headlines: [],
    ma5: 0,
    ma10: 0,
    ma20: 0,
    ma60: 0,
    biasMa5: 0,
    biasMa10: 0,
    biasMa20: 0,
    volumeRatio5d: 0,
    rsi12: 0,
    macdDif: 0,
    macdDea: 0,
    macdBar: 0,
    realizedVolatility: 0,
    atr: 0,
    maxDrawdown: 0,
    provider: '',
    model: '',
    fallback: true,
    newsSearched: includeNews,
    generatedAt: '',
    analysisId: '',
    analysisAt: 0,
    stopLoss: 0,
    takeProfit: 0,
    engineVersion: STOCK_ANALYSIS_ENGINE_VERSION,
    analystConsensus: EMPTY_ANALYST_DATA.analystConsensus,
    priceTarget: EMPTY_ANALYST_DATA.priceTarget,
    recentUpgrades: [],
    dividendYield: 0,
    trailingAnnualDividendRate: 0,
    exDividendDate: 0,
    dividendFrequency: '',
    dividendCagr: 0,
    // No data — US-hours detection can't be applied, so the required
    // marketSession field carries its documented "not applicable" value.
    marketSession: '',
  };
}

export type AnalyzeStockOptions = {
  now?: Date;
};

export async function analyzeStock(
  _ctx: ServerContext,
  req: AnalyzeStockRequest,
  options: AnalyzeStockOptions = {},
): Promise<AnalyzeStockResponse> {
  const symbol = sanitizeSymbol(req.symbol || '');
  if (!symbol) {
    return buildEmptyAnalysisResponse('', '', false);
  }

  const name = (req.name || symbol).trim().slice(0, 120) || symbol;
  const includeNews = req.includeNews === true;
  const nameSuffix = name !== symbol ? `:${name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 30).toLowerCase()}` : '';
  // v5 -> v6: risk analytics add required response fields. Never replay a
  // pre-contract response without them into the Pro UI or API.
  const cacheKey = `market:analyze-stock:v6:${symbol}:${includeNews ? 'news' : 'no-news'}${nameSuffix}`;

  const fetchFreshAnalysis = async (): Promise<AnalyzeStockResponse | null> => {
    const [history, analystData] = await Promise.all([
      fetchYahooHistory(symbol),
      fetchYahooAnalystData(symbol),
    ]);
    if (!history) return null;

    const technical = buildTechnicalSnapshot(history.candles);
    technical.currency = history.currency || 'USD';
    // Session at analysis time (#4922d); '' when US hours don't apply to the
    // listing. The extended-hours fetch runs ONLY in pre/post — during the
    // regular session the current price is already live, and while closed
    // there is no extended tape.
    const marketSession = usEquityHoursApply(symbol, history.currency || 'USD')
      ? getUsEquitySessionAt(options.now)
      : '';
    const [headlines, dividend, extendedQuote, earningsCalendar] = await Promise.all([
      includeNews ? searchRecentStockHeadlines(symbol, name, NEWS_LIMIT).then((r) => r.headlines) : Promise.resolve([]),
      fetchDividendProfile(symbol, technical.currentPrice),
      (marketSession === 'pre' || marketSession === 'post')
        ? fetchExtendedHoursQuote(symbol, marketSession)
        : Promise.resolve(null),
      fetchUpcomingEarnings(),
    ]);
    const overlay = await buildAiOverlay(symbol, name, technical, headlines, analystData.fundamentals);
    const analysisAt = history.candles[history.candles.length - 1]?.timestamp || Date.now();
    const earnings = selectEarningsForSymbol(earningsCalendar, symbol, (options.now ?? new Date()).toISOString().slice(0, 10));
    const response = buildAnalysisResponse({
      symbol,
      name,
      currency: history.currency || 'USD',
      technical,
      headlines,
      overlay,
      analystData,
      includeNews,
      analysisAt,
      generatedAt: new Date().toISOString(),
      dividend,
      marketSession,
      extended: extendedQuote ?? undefined,
      earnings,
    });
    await storeStockAnalysisSnapshot(response, includeNews);
    return response;
  };

  const cached = options.now
    ? await fetchFreshAnalysis()
    : await cachedFetchJson<AnalyzeStockResponse>(cacheKey, CACHE_TTL_SECONDS, fetchFreshAnalysis, undefined, {
        // Worst-case fetcher budget: 2× UPSTREAM_TIMEOUT_MS sequenced (10s+10s for
        // history/analyst then headlines/dividend) + 20s LLM overlay + small
        // overhead. 60s safely sits above this so the cache safety net (#3539)
        // doesn't pre-empt the caller's own per-stage timeouts.
        timeoutMs: 60_000,
      });

  if (cached) return cached;

  return buildEmptyAnalysisResponse(symbol, name, includeNews);
}
