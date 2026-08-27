import {
  ApiError,
  type AnalyzeStockResponse,
  type BacktestStockEvaluation,
  type BacktestStockResponse,
  type MarketServiceHandler,
  type ServerContext,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { attachApiErrorHttpResponseMetadata } from '../../../error-mapper';
import { cachedFetchJsonWithMeta, runRedisPipeline } from '../../../_shared/redis';
import {
  BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT,
  BACKTEST_STOCK_PROVIDER_QUOTA_EXCEEDED_MESSAGE,
  BACKTEST_STOCK_PROVIDER_QUOTA_UNAVAILABLE_MESSAGE,
  backtestStockQuotaUserId,
  reserveBacktestStockProviderQuota,
  type BacktestStockQuotaReservation,
} from '../../../_shared/backtest-stock-quota';
import {
  buildAnalysisResponse,
  buildTechnicalSnapshot,
  fetchYahooHistoryOutcome,
  getFallbackOverlay,
  signalDirection,
  type Candle,
  type AnalystData,
} from './analyze-stock';
import {
  getStoredHistoricalBacktestAnalyses,
  storeHistoricalBacktestAnalysisRecords,
  storeStockBacktestSnapshot,
} from './premium-stock-store';
import { sanitizeSymbol } from './_shared';

const CACHE_TTL_SECONDS = 900;
const DEFAULT_WINDOW_DAYS = 10;
const MIN_REQUIRED_BARS = 80;
const MAX_EVALUATIONS = 8;
const MIN_ANALYSIS_BARS = 60;
export const STOCK_BACKTEST_ENGINE_VERSION = 'v3-technical-only';
export const STOCK_BACKTEST_RATING_BASIS = 'technical_only';

export function stockBacktestCacheKey(symbol: string, evalWindowDays: number): string {
  return `market:backtest:v3:${symbol}:${evalWindowDays}`;
}

function unavailableBacktest(
  symbol: string,
  name: string,
  evalWindowDays: number,
  summary: string,
): BacktestStockResponse {
  return {
    available: false,
    symbol,
    name,
    display: symbol,
    currency: 'USD',
    evalWindowDays,
    evaluationsRun: 0,
    actionableEvaluations: 0,
    winRate: 0,
    directionAccuracy: 0,
    avgSimulatedReturnPct: 0,
    cumulativeSimulatedReturnPct: 0,
    latestSignal: '',
    latestSignalScore: 0,
    summary,
    generatedAt: new Date().toISOString(),
    evaluations: [],
    engineVersion: STOCK_BACKTEST_ENGINE_VERSION,
    ratingBasis: STOCK_BACKTEST_RATING_BASIS,
  };
}

function throwProviderQuotaFailure(
  reservation: Extract<BacktestStockQuotaReservation, { ok: false }>,
): never {
  if (reservation.reason === 'cap-exceeded') {
    const err = new ApiError(429, BACKTEST_STOCK_PROVIDER_QUOTA_EXCEEDED_MESSAGE, '');
    (err as ApiError & { retryAfter: number }).retryAfter = reservation.retryAfterSec;
    throw attachApiErrorHttpResponseMetadata(err, {
      envelope: 'error',
      rateLimit: {
        limit: BACKTEST_STOCK_DAILY_PROVIDER_QUOTA_LIMIT,
        remaining: 0,
        resetMs: Date.now() + (reservation.retryAfterSec * 1000),
        windowSec: 86_400,
      },
    });
  }
  const err = new ApiError(503, BACKTEST_STOCK_PROVIDER_QUOTA_UNAVAILABLE_MESSAGE, '');
  (err as ApiError & { retryAfter: number; exposeMessage: boolean }).retryAfter = reservation.retryAfterSec;
  (err as ApiError & { exposeMessage: boolean }).exposeMessage = true;
  throw attachApiErrorHttpResponseMetadata(err, { envelope: 'error' });
}

function isProviderQuotaFailure(error: unknown): boolean {
  return error instanceof ApiError
    && (
      error.message === BACKTEST_STOCK_PROVIDER_QUOTA_EXCEEDED_MESSAGE
      || error.message === BACKTEST_STOCK_PROVIDER_QUOTA_UNAVAILABLE_MESSAGE
    );
}

async function reserveProviderWork(request: Request | undefined): Promise<{ rollback: () => Promise<void> } | null> {
  const userId = backtestStockQuotaUserId(request);
  // Operator enterprise keys have no user id; the 60/min fail-closed route
  // policy remains the bound. Identified callers must prove a reservation.
  if (!userId) return null;
  const reservation = await reserveBacktestStockProviderQuota({
    userId,
    pipeline: (cmds) => runRedisPipeline(cmds, true),
  });
  if (!reservation.ok) throwProviderQuotaFailure(reservation);
  return reservation;
}

function round(value: number, digits = 2): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

function compareByAnalysisAtDesc<T extends { analysisAt: number }>(a: T, b: T): number {
  return (b.analysisAt || 0) - (a.analysisAt || 0);
}

function simulateEvaluation(
  analysis: AnalyzeStockResponse,
  forwardBars: Candle[],
): BacktestStockEvaluation | null {
  const direction = signalDirection(analysis.signal);
  if (!direction) return null;

  const entryPrice = analysis.currentPrice;
  const stopLoss = analysis.stopLoss;
  const takeProfit = analysis.takeProfit;
  if (!entryPrice || !stopLoss || !takeProfit) return null;

  let exitPrice = forwardBars[forwardBars.length - 1]?.close ?? entryPrice;
  let outcome = 'window_close';

  for (const bar of forwardBars) {
    if (direction === 'long') {
      if (bar.low <= stopLoss) {
        exitPrice = stopLoss;
        outcome = 'stop_loss';
        break;
      }
      if (bar.high >= takeProfit) {
        exitPrice = takeProfit;
        outcome = 'take_profit';
        break;
      }
      continue;
    }

    if (bar.high >= stopLoss) {
      exitPrice = stopLoss;
      outcome = 'stop_loss';
      break;
    }
    if (bar.low <= takeProfit) {
      exitPrice = takeProfit;
      outcome = 'take_profit';
      break;
    }
  }

  const simulatedReturnPct = direction === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;

  return {
    analysisId: analysis.analysisId,
    analysisAt: analysis.analysisAt,
    signal: analysis.signal,
    signalScore: round(analysis.signalScore),
    entryPrice: round(entryPrice),
    exitPrice: round(exitPrice),
    simulatedReturnPct: round(simulatedReturnPct),
    directionCorrect: simulatedReturnPct > 0,
    outcome,
    stopLoss: round(stopLoss),
    takeProfit: round(takeProfit),
  };
}

const ledgerInFlight = new Map<string, Promise<AnalyzeStockResponse[]>>();

async function ensureHistoricalAnalysisLedger(
  symbol: string,
  name: string,
  currency: string,
  candles: Candle[],
): Promise<AnalyzeStockResponse[]> {
  const existing = ledgerInFlight.get(symbol);
  if (existing) return existing;
  const promise = _ensureHistoricalAnalysisLedger(symbol, name, currency, candles);
  ledgerInFlight.set(symbol, promise);
  try {
    return await promise;
  } finally {
    ledgerInFlight.delete(symbol);
  }
}

async function _ensureHistoricalAnalysisLedger(
  symbol: string,
  name: string,
  currency: string,
  candles: Candle[],
): Promise<AnalyzeStockResponse[]> {
  const existing = await getStoredHistoricalBacktestAnalyses(symbol);
  const latestStoredAt = existing[0]?.analysisAt || 0;
  const latestCandleAt = candles[candles.length - 1]?.timestamp || 0;
  if (existing.length > 0 && latestStoredAt >= latestCandleAt) {
    return existing.sort(compareByAnalysisAtDesc);
  }

  const generated: AnalyzeStockResponse[] = [];
  for (let index = MIN_ANALYSIS_BARS - 1; index < candles.length; index++) {
    const analysisWindow = candles.slice(0, index + 1);
    const technical = buildTechnicalSnapshot(analysisWindow);
    technical.currency = currency;
    const analysisAt = candles[index]?.timestamp || 0;
    if (!analysisAt) continue;

    const emptyAnalyst: AnalystData = {
      analystConsensus: { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, total: 0, period: '' },
      priceTarget: { high: 0, low: 0, mean: 0, median: 0, current: 0, numberOfAnalysts: 0 },
      recentUpgrades: [],
      fundamentals: {},
    };
    generated.push(buildAnalysisResponse({
      symbol,
      name,
      currency,
      technical,
      headlines: [],
      overlay: getFallbackOverlay(name, technical, []),
      analystData: emptyAnalyst,
      includeNews: false,
      analysisAt,
      generatedAt: new Date(analysisAt).toISOString(),
      analysisId: `ledger:${STOCK_BACKTEST_ENGINE_VERSION}:${symbol}:${analysisAt}`,
      engineVersion: STOCK_BACKTEST_ENGINE_VERSION,
    }));
  }

  await storeHistoricalBacktestAnalysisRecords(generated);
  return generated.sort(compareByAnalysisAtDesc);
}

export const backtestStock: MarketServiceHandler['backtestStock'] = async (
  ctx: ServerContext,
  req,
): Promise<BacktestStockResponse> => {
  const symbol = sanitizeSymbol(req.symbol || '');
  if (!symbol) {
    return unavailableBacktest('', req.name || '', req.evalWindowDays || DEFAULT_WINDOW_DAYS, 'No symbol provided.');
  }

  const evalWindowDays = Math.max(3, Math.min(30, req.evalWindowDays || DEFAULT_WINDOW_DAYS));
  const cacheKey = stockBacktestCacheKey(symbol, evalWindowDays);

  let definitiveInvalidSymbol = false;
  const computeBacktest = async (): Promise<BacktestStockResponse | null> => {
    const historyOutcome = await fetchYahooHistoryOutcome(symbol);
    if (historyOutcome.status === 'invalid-symbol') {
      definitiveInvalidSymbol = true;
      return null;
    }
    if (historyOutcome.status !== 'success') return null;
    const history = historyOutcome.history;
    if (history.candles.length < MIN_REQUIRED_BARS) return null;

    const analyses = await ensureHistoricalAnalysisLedger(
      symbol,
      req.name || symbol,
      history.currency || 'USD',
      history.candles,
    );
    if (analyses.length === 0) return null;

    const candleIndexByTimestamp = new Map<number, number>();
    history.candles.forEach((candle, index) => {
      candleIndexByTimestamp.set(candle.timestamp, index);
    });

    const evaluations = analyses
      .map((analysis) => {
        const candleIndex = candleIndexByTimestamp.get(analysis.analysisAt);
        if (candleIndex == null) return null;
        const forwardBars = history.candles.slice(candleIndex + 1, candleIndex + 1 + evalWindowDays);
        if (forwardBars.length < evalWindowDays) return null;
        return simulateEvaluation(analysis, forwardBars);
      })
      .filter((evaluation): evaluation is BacktestStockEvaluation => !!evaluation)
      .sort(compareByAnalysisAtDesc);

    if (evaluations.length === 0) return null;

    const actionableEvaluations = evaluations.length;
    const profitable = evaluations.filter((evaluation) => evaluation.simulatedReturnPct > 0);
    const winRate = (profitable.length / actionableEvaluations) * 100;
    const directionAccuracy = (evaluations.filter((evaluation) => evaluation.directionCorrect).length / actionableEvaluations) * 100;
    const avgSimulatedReturnPct = evaluations.reduce((sum, evaluation) => sum + evaluation.simulatedReturnPct, 0) / actionableEvaluations;
    const cumulativeSimulatedReturnPct = evaluations.reduce((sum, evaluation) => sum + evaluation.simulatedReturnPct, 0);
    const latest = evaluations[0]!;
    const response: BacktestStockResponse = {
      available: true,
      symbol,
      name: req.name || symbol,
      display: symbol,
      currency: history.currency || 'USD',
      evalWindowDays,
      evaluationsRun: analyses.length,
      actionableEvaluations,
      winRate: round(winRate),
      directionAccuracy: round(directionAccuracy),
      avgSimulatedReturnPct: round(avgSimulatedReturnPct),
      cumulativeSimulatedReturnPct: round(cumulativeSimulatedReturnPct),
      latestSignal: latest.signal,
      latestSignalScore: round(latest.signalScore),
      summary: `Validated ${actionableEvaluations} technical-only signal records over ${evalWindowDays} trading days with ${round(winRate)}% win rate and ${round(avgSimulatedReturnPct)}% average simulated return. Point-in-time fundamentals are not included.`,
      generatedAt: new Date().toISOString(),
      evaluations: evaluations.slice(0, MAX_EVALUATIONS),
      engineVersion: STOCK_BACKTEST_ENGINE_VERSION,
      ratingBasis: STOCK_BACKTEST_RATING_BASIS,
    };
    await storeStockBacktestSnapshot(response);
    return response;
  };

  const quotaHold: { reservation: { rollback: () => Promise<void> } | null } = { reservation: null };
  try {
    const result = await cachedFetchJsonWithMeta<BacktestStockResponse>(
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        // Reserve only once this isolate is the fetch leader. Cache hits and
        // in-flight followers never enter the fetcher, so they cannot 429 a
        // same-symbol stampede near the daily cap.
        quotaHold.reservation = await reserveProviderWork(ctx.request);
        return computeBacktest();
      },
      120,
      {
        usage: {
          provider: 'yahoo-finance',
          operation: 'backtest-history',
          host: 'query1.finance.yahoo.com',
        },
        cacheFetcherErrors: false,
        isCallerLocalError: isProviderQuotaFailure,
      },
    );
    if (quotaHold.reservation && (definitiveInvalidSymbol || result.source !== 'fresh' || !result.leader)) {
      await quotaHold.reservation.rollback();
    }
    if (result.data) return result.data;
  } catch (err) {
    if (quotaHold.reservation) {
      await quotaHold.reservation.rollback();
    }
    if (err instanceof ApiError) throw err;
    console.warn(`[backtestStock] ${symbol} failed:`, (err as Error).message);
  }

  return unavailableBacktest(symbol, req.name || symbol, evalWindowDays, 'Backtest unavailable for this symbol.');
};
