import { getRpcBaseUrl } from '@/services/rpc-client';
import type { AnalyzeStockResponse } from '@/generated/client/worldmonitor/market/v1/service_client';
import { premiumFetch } from '@/services/premium-fetch';
import { MarketServiceClient } from '@/services/generated-rpc-clients';

export type StockAnalysisSnapshot = AnalyzeStockResponse;
export type StockAnalysisHistory = Record<string, StockAnalysisSnapshot[]>;

const client = new MarketServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });

const DEFAULT_LIMIT_PER_SYMBOL = 4;
const MAX_SNAPSHOTS_PER_SYMBOL = 32;
export const STOCK_ANALYSIS_FRESH_MS = 15 * 60 * 1000;

async function getTargetSymbols(limitOverride?: number): Promise<string[]> {
  const { getStockAnalysisTargets } = await import('./stock-analysis');
  return getStockAnalysisTargets(limitOverride).map((target) => target.symbol);
}

function compareSnapshots(a: StockAnalysisSnapshot, b: StockAnalysisSnapshot): number {
  const aTime = Date.parse(a.generatedAt || '') || 0;
  const bTime = Date.parse(b.generatedAt || '') || 0;
  return bTime - aTime;
}

function isSameSnapshot(a: StockAnalysisSnapshot, b: StockAnalysisSnapshot): boolean {
  return a.symbol === b.symbol
    && a.generatedAt === b.generatedAt
    && a.signal === b.signal
    && a.ratingSignal === b.ratingSignal
    && a.signalScore === b.signalScore
    && a.compositeScore === b.compositeScore
    && a.currentPrice === b.currentPrice;
}

export function mergeStockAnalysisHistory(
  existing: StockAnalysisHistory,
  incoming: StockAnalysisSnapshot[],
  maxSnapshotsPerSymbol = MAX_SNAPSHOTS_PER_SYMBOL,
): StockAnalysisHistory {
  const next: StockAnalysisHistory = { ...existing };

  for (const snapshot of incoming) {
    if (!snapshot?.symbol || !snapshot.available) continue;
    const symbol = snapshot.symbol;
    const current = next[symbol] ? [...next[symbol]!] : [];
    if (!current.some((item) => isSameSnapshot(item, snapshot))) {
      current.push(snapshot);
    }
    current.sort(compareSnapshots);
    next[symbol] = current.slice(0, maxSnapshotsPerSymbol);
  }

  return next;
}

export function getLatestStockAnalysisSnapshots(history: StockAnalysisHistory, limit?: number): StockAnalysisSnapshot[] {
  const snapshots = Object.values(history)
    .map((items) => items[0])
    .filter((item): item is StockAnalysisSnapshot => !!item?.available)
    .sort(compareSnapshots);
  return limit != null ? snapshots.slice(0, limit) : snapshots;
}

// Snapshots written before the analyst/fundamentals rollouts can still be
// time-fresh while missing the richer Pro payload. Treat them as stale so the
// first post-deploy load refreshes them instead of hiding the new section for
// the remainder of the normal 15-minute freshness window. An empty
// fundamentals object is valid when Yahoo has no values for a symbol.
function hasCurrentStockAnalysisSchema(snapshot: StockAnalysisSnapshot | undefined): boolean {
  if (!snapshot) return false;
  const hasAnalystFields = snapshot.analystConsensus !== undefined || snapshot.priceTarget !== undefined;
  const hasCompositeScore = typeof snapshot.compositeScore === 'number'
    && Number.isFinite(snapshot.compositeScore);
  const hasRatingNarrative = typeof snapshot.ratingSummary === 'string'
    && snapshot.ratingSummary.length > 0
    && typeof snapshot.ratingAction === 'string'
    && snapshot.ratingAction.length > 0
    && typeof snapshot.ratingConfidence === 'string'
    && snapshot.ratingConfidence.length > 0
    && typeof snapshot.ratingWhyNow === 'string'
    && snapshot.ratingWhyNow.length > 0
    && Array.isArray(snapshot.ratingBullishFactors)
    && Array.isArray(snapshot.ratingRiskFactors);
  return hasAnalystFields
    && snapshot.fundamentals !== undefined
    && hasCompositeScore
    && typeof snapshot.ratingSignal === 'string'
    && snapshot.ratingSignal.length > 0
    && hasRatingNarrative;
}

function isFreshSnapshot(
  snapshot: StockAnalysisSnapshot | undefined,
  now: number,
  maxAgeMs: number,
): boolean {
  if (!snapshot?.available) return false;
  const ts = Date.parse(snapshot.generatedAt || '');
  if (!Number.isFinite(ts) || (now - ts) > maxAgeMs) return false;
  if (!hasCurrentStockAnalysisSchema(snapshot)) return false;
  return true;
}

export function hasFreshStockAnalysisHistory(
  history: StockAnalysisHistory,
  symbols: string[],
  maxAgeMs = STOCK_ANALYSIS_FRESH_MS,
): boolean {
  if (symbols.length === 0) return false;
  const now = Date.now();
  return symbols.every((symbol) => isFreshSnapshot(history[symbol]?.[0], now, maxAgeMs));
}

export function getMissingOrStaleStockAnalysisSymbols(
  history: StockAnalysisHistory,
  symbols: string[],
  maxAgeMs = STOCK_ANALYSIS_FRESH_MS,
): string[] {
  const now = Date.now();
  return symbols.filter((symbol) => !isFreshSnapshot(history[symbol]?.[0], now, maxAgeMs));
}

export async function fetchStockAnalysisHistory(
  limitOverride?: number,
  limitPerSymbol = DEFAULT_LIMIT_PER_SYMBOL,
): Promise<StockAnalysisHistory> {
  const symbols = await getTargetSymbols(limitOverride);
  const response = await client.getStockAnalysisHistory({
    symbols,
    limitPerSymbol,
    includeNews: true,
  });

  const history: StockAnalysisHistory = {};
  for (const item of response.items) {
    history[item.symbol] = [...item.snapshots].sort(compareSnapshots);
  }
  return history;
}
