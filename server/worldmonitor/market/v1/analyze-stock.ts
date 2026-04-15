import type {
  AnalyzeStockRequest,
  AnalyzeStockResponse,
  AnalystConsensus,
  PriceTarget,
  UpgradeDowngrade,
  ServerContext,
  StockAnalysisHeadline,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { callLlm } from '../../../_shared/llm';
import { cachedFetchJson } from '../../../_shared/redis';
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
        targetHighPrice?: { raw?: number };
        targetLowPrice?: { raw?: number };
        targetMeanPrice?: { raw?: number };
        targetMedianPrice?: { raw?: number };
        currentPrice?: { raw?: number };
        numberOfAnalystOpinions?: { raw?: number };
      };
      upgradeDowngradeHistory?: {
        history?: YahooUpgradeEntry[];
      };
    }>;
  };
};

export type AnalystData = {
  analystConsensus: AnalystConsensus;
  priceTarget: PriceTarget;
  recentUpgrades: UpgradeDowngrade[];
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
  return (Math.pow(latest / earliest, 1 / span) - 1) * 100;
}

export async function fetchDividendProfile(symbol: string, currentPrice: number): Promise<DividendProfile> {
  try {
    await yahooGate();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1mo&includePrePost=false&events=div`;
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
    const trailingAnnual = recentDivs.reduce((sum, d) => sum + (d.amount ?? 0), 0);
    const dividendYield = currentPrice > 0 ? (trailingAnnual / currentPrice) * 100 : 0;
    const paymentsPerYear = recentDivs.length || (entries.length / Math.max(1, annualTotals.size));

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

export async function fetchYahooHistory(symbol: string): Promise<{ candles: Candle[]; currency: string } | null> {
  await yahooGate();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d&includePrePost=false&events=div,splits`;
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
    if (![close, open, high, low].every((value) => typeof value === 'number' && Number.isFinite(value))) continue;
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

const EMPTY_ANALYST_DATA: AnalystData = {
  analystConsensus: { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, total: 0, period: '' },
  priceTarget: { numberOfAnalysts: 0 },
  recentUpgrades: [],
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

    return { analystConsensus, priceTarget, recentUpgrades };
  } catch {
    return EMPTY_ANALYST_DATA;
  }
}

export function buildTechnicalSnapshot(candles: Candle[]): TechnicalSnapshot {
  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
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
  };
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
): Promise<AiOverlay> {
  const fallback = getFallbackOverlay(name, technical, headlines);
  const llm = await callLlm({
    messages: [
      {
        role: 'system',
        content: 'You are a disciplined stock analyst. Return strict JSON only with keys: summary, action, confidence, whyNow, technicalSummary, newsSummary, bullishFactors, riskFactors. Keep it concise, factual, and free of disclaimers.',
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
        }),
      },
    ],
    temperature: 0.2,
    maxTokens: 500,
    timeoutMs: 20_000,
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
    dividendYield: dividend?.dividendYield ?? 0,
    trailingAnnualDividendRate: dividend?.trailingAnnualDividendRate ?? 0,
    exDividendDate: dividend?.exDividendDate ?? 0,
    payoutRatio: dividend?.payoutRatio,
    dividendFrequency: dividend?.dividendFrequency ?? '',
    dividendCagr: dividend?.dividendCagr ?? 0,
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
  };
}

export async function analyzeStock(
  _ctx: ServerContext,
  req: AnalyzeStockRequest,
): Promise<AnalyzeStockResponse> {
  const symbol = sanitizeSymbol(req.symbol || '');
  if (!symbol) {
    return buildEmptyAnalysisResponse('', '', false);
  }

  const name = (req.name || symbol).trim().slice(0, 120) || symbol;
  const includeNews = req.includeNews === true;
  const nameSuffix = name !== symbol ? `:${name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 30).toLowerCase()}` : '';
  const cacheKey = `market:analyze-stock:v3:${symbol}:${includeNews ? 'news' : 'no-news'}${nameSuffix}`;

  const cached = await cachedFetchJson<AnalyzeStockResponse>(cacheKey, CACHE_TTL_SECONDS, async () => {
    const [history, analystData] = await Promise.all([
      fetchYahooHistory(symbol),
      fetchYahooAnalystData(symbol),
    ]);
    if (!history) return null;

    const technical = buildTechnicalSnapshot(history.candles);
    technical.currency = history.currency || 'USD';
    const [headlines, dividend] = await Promise.all([
      includeNews ? searchRecentStockHeadlines(symbol, name, NEWS_LIMIT).then((r) => r.headlines) : Promise.resolve([]),
      fetchDividendProfile(symbol, technical.currentPrice),
    ]);
    const overlay = await buildAiOverlay(symbol, name, technical, headlines);
    const analysisAt = history.candles[history.candles.length - 1]?.timestamp || Date.now();
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
    });
    await storeStockAnalysisSnapshot(response, includeNews);
    return response;
  });

  if (cached) return cached;

  return buildEmptyAnalysisResponse(symbol, name, includeNews);
}
