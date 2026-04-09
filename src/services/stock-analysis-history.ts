import { getRpcBaseUrl } from '@/services/rpc-client';
import {
  MarketServiceClient,
  type AnalyzeStockResponse,
} from '@/generated/client/worldmonitor/market/v1/service_client';
import { premiumFetch } from '@/services/premium-fetch';

export type StockAnalysisSnapshot = AnalyzeStockResponse;
export type StockAnalysisHistory = Record<string, StockAnalysisSnapshot[]>;

const client = new MarketServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });

const DEFAULT_LIMIT = 4;
const DEFAULT_LIMIT_PER_SYMBOL = 4;
const MAX_SNAPSHOTS_PER_SYMBOL = 32;
export const STOCK_ANALYSIS_FRESH_MS = 15 * 60 * 1000;

async function getTargetSymbols(limit: number): Promise<string[]> {
  const { getStockAnalysisTargets } = await import('./stock-analysis');
  return getStockAnalysisTargets(limit).map((target) => target.symbol);
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
    && a.signalScore === b.signalScore
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

export function getLatestStockAnalysisSnapshots(history: StockAnalysisHistory, limit = DEFAULT_LIMIT): StockAnalysisSnapshot[] {
  return Object.values(history)
    .map((items) => items[0])
    .filter((item): item is StockAnalysisSnapshot => !!item?.available)
    .sort(compareSnapshots)
    .slice(0, limit);
}

export function hasFreshStockAnalysisHistory(
  history: StockAnalysisHistory,
  symbols: string[],
  maxAgeMs = STOCK_ANALYSIS_FRESH_MS,
): boolean {
  if (symbols.length === 0) return false;
  const now = Date.now();
  return symbols.every((symbol) => {
    const latest = history[symbol]?.[0];
    const ts = Date.parse(latest?.generatedAt || '');
    return !!latest?.available && Number.isFinite(ts) && (now - ts) <= maxAgeMs;
  });
}

export function getMissingOrStaleStockAnalysisSymbols(
  history: StockAnalysisHistory,
  symbols: string[],
  maxAgeMs = STOCK_ANALYSIS_FRESH_MS,
): string[] {
  const now = Date.now();
  return symbols.filter((symbol) => {
    const latest = history[symbol]?.[0];
    const ts = Date.parse(latest?.generatedAt || '');
    return !(latest?.available && Number.isFinite(ts) && (now - ts) <= maxAgeMs);
  });
}

export async function fetchStockAnalysisHistory(
  limit = DEFAULT_LIMIT,
  limitPerSymbol = DEFAULT_LIMIT_PER_SYMBOL,
): Promise<StockAnalysisHistory> {
  const symbols = await getTargetSymbols(limit);
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
