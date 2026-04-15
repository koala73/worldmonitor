import type {
  AnalyzeStockResponse,
  BacktestStockResponse,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { getCachedJsonBatch, runRedisPipeline, setCachedJson } from '../../../_shared/redis';
import { sanitizeSymbol } from './_shared';

const ANALYSIS_HISTORY_LIMIT = 32;
const ANALYSIS_HISTORY_TTL_SECONDS = 90 * 24 * 60 * 60;
const BACKTEST_LEDGER_LIMIT = 192;
const BACKTEST_LEDGER_TTL_SECONDS = 90 * 24 * 60 * 60;
const BACKTEST_STORE_TTL_SECONDS = 30 * 24 * 60 * 60;

type AnalysisHistoryRecord = Record<string, AnalyzeStockResponse[]>;

function compareAnalysisDesc<T extends { analysisAt: number; generatedAt: string }>(a: T, b: T): number {
  const aTime = a.analysisAt || Date.parse(a.generatedAt || '') || 0;
  const bTime = b.analysisAt || Date.parse(b.generatedAt || '') || 0;
  return bTime - aTime;
}

function analysisHistoryIndexKey(symbol: string, includeNews: boolean): string {
  // v3: bumped to rotate pre-PR snapshots missing new dividend fields.
  // Live analyze-stock cache is also v3 (see analyze-stock.ts).
  return `market:stock-analysis-history:index:v3:${sanitizeSymbol(symbol)}:${includeNews ? 'news' : 'core'}`;
}

function analysisItemKey(analysisId: string): string {
  // v3: see analysisHistoryIndexKey note.
  return `market:stock-analysis-history:item:v3:${analysisId}`;
}

function backtestSnapshotKey(symbol: string, evalWindowDays: number): string {
  return `market:stock-backtest-store:v2:${sanitizeSymbol(symbol)}:${evalWindowDays}`;
}

function backtestLedgerIndexKey(symbol: string): string {
  return `market:stock-analysis-ledger:index:v1:${sanitizeSymbol(symbol)}`;
}

function backtestLedgerItemKey(analysisId: string): string {
  return `market:stock-analysis-ledger:item:v1:${analysisId}`;
}

function normalizeSymbolList(symbols: string[]): string[] {
  return [...new Set(symbols.map(sanitizeSymbol).filter(Boolean))];
}

function normalizeAnalysisRecord(
  snapshot: AnalyzeStockResponse,
  includeNews: boolean,
): AnalyzeStockResponse | null {
  if (!snapshot.available || !snapshot.symbol) return null;

  const symbol = sanitizeSymbol(snapshot.symbol);
  const analysisAt = snapshot.analysisAt || Date.parse(snapshot.generatedAt || '') || 0;
  if (!analysisAt) return null;

  const engineVersion = snapshot.engineVersion || 'v1';
  const analysisId = snapshot.analysisId || `stock:${engineVersion}:${symbol}:${analysisAt}:${includeNews ? 'news' : 'core'}`;

  return {
    ...snapshot,
    symbol,
    analysisId,
    analysisAt,
    engineVersion,
  };
}

function normalizeLedgerRecord(snapshot: AnalyzeStockResponse): AnalyzeStockResponse | null {
  if (!snapshot.available || !snapshot.symbol) return null;

  const symbol = sanitizeSymbol(snapshot.symbol);
  const analysisAt = snapshot.analysisAt || Date.parse(snapshot.generatedAt || '') || 0;
  if (!analysisAt) return null;

  const engineVersion = snapshot.engineVersion || 'v1';
  const analysisId = snapshot.analysisId || `ledger:${engineVersion}:${symbol}:${analysisAt}`;

  return {
    ...snapshot,
    symbol,
    analysisId,
    analysisAt,
    engineVersion,
  };
}

async function zrevrange(key: string, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const data = await runRedisPipeline([
    ['ZREVRANGE', key, 0, Math.max(0, limit - 1)],
  ]);
  return Array.isArray(data[0]?.result)
    ? data[0]!.result!.map((item) => String(item))
    : [];
}

async function loadAnalysisRecords(ids: string[], itemKeyFor: (analysisId: string) => string): Promise<AnalyzeStockResponse[]> {
  if (ids.length === 0) return [];
  const itemKeys = ids.map(itemKeyFor);
  const cached = await getCachedJsonBatch(itemKeys);

  return ids
    .map((_, index) => cached.get(itemKeys[index]!) as AnalyzeStockResponse | undefined)
    .filter((item): item is AnalyzeStockResponse => !!item?.available)
    .sort(compareAnalysisDesc);
}

async function trimIndexTail(indexKey: string, ids: string[], keepLimit: number): Promise<void> {
  if (ids.length <= keepLimit) return;
  const overflow = ids.slice(keepLimit);
  await runRedisPipeline([
    ['ZREM', indexKey, ...overflow],
  ]);
}

export async function storeStockAnalysisSnapshot(
  snapshot: AnalyzeStockResponse,
  includeNews: boolean,
): Promise<void> {
  const record = normalizeAnalysisRecord(snapshot, includeNews);
  if (!record) return;

  const indexKey = analysisHistoryIndexKey(record.symbol, includeNews);
  const itemKey = analysisItemKey(record.analysisId);

  await runRedisPipeline([
    ['SET', itemKey, JSON.stringify(record), 'EX', ANALYSIS_HISTORY_TTL_SECONDS],
    ['ZADD', indexKey, record.analysisAt, record.analysisId],
    ['EXPIRE', indexKey, ANALYSIS_HISTORY_TTL_SECONDS],
  ]);

  const ids = await zrevrange(indexKey, ANALYSIS_HISTORY_LIMIT + 4);
  await trimIndexTail(indexKey, ids, ANALYSIS_HISTORY_LIMIT);
}

export async function getStoredStockAnalysisHistory(
  symbols: string[],
  includeNews: boolean,
  limitPerSymbol = ANALYSIS_HISTORY_LIMIT,
): Promise<AnalysisHistoryRecord> {
  const normalized = normalizeSymbolList(symbols);
  const clampedLimit = Math.max(1, Math.min(ANALYSIS_HISTORY_LIMIT, limitPerSymbol));
  const out: AnalysisHistoryRecord = {};

  await Promise.all(normalized.map(async (symbol) => {
    const ids = await zrevrange(analysisHistoryIndexKey(symbol, includeNews), clampedLimit);
    out[symbol] = await loadAnalysisRecords(ids, analysisItemKey);
  }));

  return out;
}

export async function storeHistoricalBacktestAnalysisRecords(
  snapshots: AnalyzeStockResponse[],
): Promise<void> {
  const commands: Array<Array<string | number>> = [];
  const touchedSymbols = new Set<string>();

  for (const snapshot of snapshots) {
    const record = normalizeLedgerRecord(snapshot);
    if (!record) continue;

    const indexKey = backtestLedgerIndexKey(record.symbol);
    commands.push(
      ['SET', backtestLedgerItemKey(record.analysisId), JSON.stringify(record), 'EX', BACKTEST_LEDGER_TTL_SECONDS],
      ['ZADD', indexKey, record.analysisAt, record.analysisId],
      ['EXPIRE', indexKey, BACKTEST_LEDGER_TTL_SECONDS],
    );
    touchedSymbols.add(record.symbol);
  }

  if (commands.length === 0) return;
  const PIPELINE_CHUNK = 200;
  for (let i = 0; i < commands.length; i += PIPELINE_CHUNK) {
    await runRedisPipeline(commands.slice(i, i + PIPELINE_CHUNK));
  }

  await Promise.all([...touchedSymbols].map(async (symbol) => {
    const ids = await zrevrange(backtestLedgerIndexKey(symbol), BACKTEST_LEDGER_LIMIT + 8);
    await trimIndexTail(backtestLedgerIndexKey(symbol), ids, BACKTEST_LEDGER_LIMIT);
  }));
}

export async function getStoredHistoricalBacktestAnalyses(
  symbol: string,
  limit = BACKTEST_LEDGER_LIMIT,
): Promise<AnalyzeStockResponse[]> {
  const normalized = sanitizeSymbol(symbol);
  if (!normalized) return [];
  const ids = await zrevrange(backtestLedgerIndexKey(normalized), Math.max(1, limit));
  return loadAnalysisRecords(ids, backtestLedgerItemKey);
}

export async function storeStockBacktestSnapshot(
  snapshot: BacktestStockResponse,
): Promise<void> {
  if (!snapshot.available || !snapshot.symbol) return;
  const key = backtestSnapshotKey(snapshot.symbol, snapshot.evalWindowDays || 10);
  await setCachedJson(key, {
    ...snapshot,
    symbol: sanitizeSymbol(snapshot.symbol),
  }, BACKTEST_STORE_TTL_SECONDS);
}

export async function getStoredStockBacktestSnapshots(
  symbols: string[],
  evalWindowDays: number,
): Promise<BacktestStockResponse[]> {
  const normalized = normalizeSymbolList(symbols);
  const keys = normalized.map((symbol) => backtestSnapshotKey(symbol, evalWindowDays));
  const cached = await getCachedJsonBatch(keys);

  return normalized
    .map((_, index) => cached.get(keys[index]!) as BacktestStockResponse | undefined)
    .filter((item): item is BacktestStockResponse => !!item?.available)
    .sort((a, b) => (Date.parse(b.generatedAt || '') || 0) - (Date.parse(a.generatedAt || '') || 0));
}
