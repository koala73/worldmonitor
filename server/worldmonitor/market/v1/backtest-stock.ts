import type {
  AnalyzeStockResponse,
  BacktestStockResponse,
  BacktestStockEvaluation,
  MarketServiceHandler,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import {
  buildAnalysisResponse,
  buildTechnicalSnapshot,
  fetchYahooHistory,
  getFallbackOverlay,
  signalDirection,
  type Candle,
  STOCK_ANALYSIS_ENGINE_VERSION,
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

    generated.push(buildAnalysisResponse({
      symbol,
      name,
      currency,
      technical,
      headlines: [],
      overlay: getFallbackOverlay(name, technical, []),
      includeNews: false,
      analysisAt,
      generatedAt: new Date(analysisAt).toISOString(),
      analysisId: `ledger:${STOCK_ANALYSIS_ENGINE_VERSION}:${symbol}:${analysisAt}`,
    }));
  }

  await storeHistoricalBacktestAnalysisRecords(generated);
  return generated.sort(compareByAnalysisAtDesc);
}

export const backtestStock: MarketServiceHandler['backtestStock'] = async (
  _ctx,
  req,
): Promise<BacktestStockResponse> => {
  const symbol = sanitizeSymbol(req.symbol || '');
  if (!symbol) {
    return {
      available: false,
      symbol: '',
      name: req.name || '',
      display: '',
      currency: 'USD',
      evalWindowDays: req.evalWindowDays || DEFAULT_WINDOW_DAYS,
      evaluationsRun: 0,
      actionableEvaluations: 0,
      winRate: 0,
      directionAccuracy: 0,
      avgSimulatedReturnPct: 0,
      cumulativeSimulatedReturnPct: 0,
      latestSignal: '',
      latestSignalScore: 0,
      summary: 'No symbol provided.',
      generatedAt: new Date().toISOString(),
      evaluations: [],
      engineVersion: STOCK_ANALYSIS_ENGINE_VERSION,
    };
  }

  const evalWindowDays = Math.max(3, Math.min(30, req.evalWindowDays || DEFAULT_WINDOW_DAYS));
  const cacheKey = `market:backtest:v2:${symbol}:${evalWindowDays}`;

  try {
    const cached = await cachedFetchJson<BacktestStockResponse>(cacheKey, CACHE_TTL_SECONDS, async () => {
      const history = await fetchYahooHistory(symbol);
      if (!history || history.candles.length < MIN_REQUIRED_BARS) return null;

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
        summary: `Validated ${actionableEvaluations} stored analysis records over ${evalWindowDays} trading days with ${round(winRate)}% win rate and ${round(avgSimulatedReturnPct)}% average simulated return.`,
        generatedAt: new Date().toISOString(),
        evaluations: evaluations.slice(0, MAX_EVALUATIONS),
        engineVersion: STOCK_ANALYSIS_ENGINE_VERSION,
      };
      await storeStockBacktestSnapshot(response);
      return response;
    });
    if (cached) return cached;
  } catch (err) {
    console.warn(`[backtestStock] ${symbol} failed:`, (err as Error).message);
  }

  return {
    available: false,
    symbol,
    name: req.name || symbol,
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
    summary: 'Backtest unavailable for this symbol.',
    generatedAt: new Date().toISOString(),
    evaluations: [],
    engineVersion: STOCK_ANALYSIS_ENGINE_VERSION,
  };
};
