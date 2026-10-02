import type {
  AnalyzeStockResponse,
  BacktestStockResponse,
  GetStockAnalysisHistoryResponse,
  ListStoredStockBacktestsResponse,
} from '../../../src/generated/server/worldmonitor/market/v1/service_server';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk, RpcValidationError } from '../billing-denial';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';

const OPERATIONS = {
  analysis: '/api/market/v1/analyze-stock',
  backtest: '/api/market/v1/backtest-stock',
  history: '/api/market/v1/get-stock-analysis-history',
  'stored-backtests': '/api/market/v1/list-stored-stock-backtests',
} as const;

type StockData = AnalyzeStockResponse | BacktestStockResponse
  | GetStockAnalysisHistoryResponse | ListStoredStockBacktestsResponse;

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    available: { type: 'boolean' }, symbol: { type: 'string' }, name: { type: 'string' },
    currency: { type: 'string' }, currentPrice: { type: 'number' }, changePercent: { type: 'number' },
    signal: { type: 'string' }, signalScore: { type: 'number' }, ratingSignal: { type: 'string' },
    compositeScore: { type: 'number' }, fundamentalScore: { type: 'number' },
    generatedAt: { type: 'string' }, analysisAt: { type: 'number' }, analysisId: { type: 'string' },
    engineVersion: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, fallback: { type: 'boolean' },
    summary: { type: 'string' }, action: { type: 'string' }, confidence: { type: 'string' },
    technicalSummary: { type: 'string' }, newsSummary: { type: 'string' }, whyNow: { type: 'string' },
    bullishFactors: { type: 'array', items: { type: 'string' } }, riskFactors: { type: 'array', items: { type: 'string' } },
    supportLevels: { type: 'array', items: { type: 'number' } }, resistanceLevels: { type: 'array', items: { type: 'number' } },
    headlines: { type: 'array', items: { type: 'object' } },
    fundamentals: { type: 'object' }, analystConsensus: { type: 'object' }, priceTarget: { type: 'object' },
  },
};
const BACKTEST_SCHEMA = {
  type: 'object',
  properties: {
    available: { type: 'boolean' }, symbol: { type: 'string' }, currency: { type: 'string' },
    evalWindowDays: { type: 'number' }, evaluationsRun: { type: 'number' }, actionableEvaluations: { type: 'number' },
    winRate: { type: 'number' }, directionAccuracy: { type: 'number' }, avgSimulatedReturnPct: { type: 'number' },
    cumulativeSimulatedReturnPct: { type: 'number' }, latestSignal: { type: 'string' }, latestSignalScore: { type: 'number' },
    summary: { type: 'string' }, generatedAt: { type: 'string' }, engineVersion: { type: 'string' }, ratingBasis: { type: 'string' },
    evaluations: { type: 'array', items: { type: 'object', properties: {
      analysisAt: { type: 'number' }, signal: { type: 'string' }, signalScore: { type: 'number' },
      entryPrice: { type: 'number' }, exitPrice: { type: 'number' }, simulatedReturnPct: { type: 'number' },
      directionCorrect: { type: 'boolean' }, outcome: { type: 'string' }, stopLoss: { type: 'number' },
      takeProfit: { type: 'number' }, analysisId: { type: 'string' },
    } } },
  },
};

export const STOCK_TOOLS: ToolDef[] = [{
  name: 'get_stock_research',
  _outputBudgetBytes: 524288,
  description: 'Stock research through the existing subscription gateway: current analysis, technical backtest, saved analysis history, or saved backtests. Analyze or backtest one symbol; retrieve stored results for a watchlist. Default no news, four history snapshots per symbol, and a ten-trading-day evaluation window. Preserve availability, observation dates, model/fallback provenance, ratingBasis and engineVersion. Technical backtests omit point-in-time fundamentals and are simulations, not trading results or forecasts. Cold analysis may invoke upstream data and an LLM; Existing provider quotas and billing denials apply; account calls use the daily MCP meter, while env-key calls retain their existing rate limit. Analysis/backtest generation may save shared research snapshots. No trading or account changes. For large histories use fewer symbols/snapshots or a jmespath projection.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: Object.keys(OPERATIONS), description: 'Select current analysis, technical backtest, stored analysis history, or stored backtests.' },
      symbols: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 32 }, description: 'Stock symbols; exactly one for analysis/backtest, up to 50 for stored results. Whitespace around a symbol is removed and letters are uppercased.' },
      include_news: { type: 'boolean', default: false, description: 'Include the existing news overlay for analysis/history only.' },
      limit_per_symbol: { type: 'integer', minimum: 1, maximum: 32, default: 4, description: 'History only: maximum snapshots per symbol.' },
      eval_window_days: { type: 'integer', minimum: 3, maximum: 30, default: 10, description: 'Backtest/stored-backtests only: trading-day evaluation window.' },
    },
    required: ['operation', 'symbols'],
  },
  outputSchema: {
    type: 'object', required: ['operation', 'data'],
    properties: {
      operation: { type: 'string', enum: Object.keys(OPERATIONS) },
      data: { anyOf: [ANALYSIS_SCHEMA, BACKTEST_SCHEMA, {
        type: 'object', required: ['items'], properties: { items: { type: 'array', items: { anyOf: [BACKTEST_SCHEMA, {
          type: 'object', required: ['symbol', 'snapshots'], properties: {
            symbol: { type: 'string' }, snapshots: { type: 'array', items: ANALYSIS_SCHEMA },
          },
        }] } } },
      }] },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _execute: async (params, base, context, execution) => {
    const invalid = (field: string, description: string): never => {
      throw new RpcValidationError('get_stock_research', [{ field, description }]);
    };
    const operation = params.operation;
    if (typeof operation !== 'string' || !Object.prototype.hasOwnProperty.call(OPERATIONS, operation)) {
      invalid('operation', 'Select a supported stock research operation.');
    }
    const selected = operation as keyof typeof OPERATIONS;
    const single = selected === 'analysis' || selected === 'backtest';
    const rawSymbols = params.symbols;
    if (!Array.isArray(rawSymbols) || rawSymbols.length < 1 || rawSymbols.length > 50 || (single && rawSymbols.length !== 1)) {
      invalid('symbols', 'Use exactly one symbol for analysis/backtest, or 1 through 50 for stored results.');
    }
    const symbols = (rawSymbols as unknown[]).map(raw => {
      if (typeof raw !== 'string' || !/^[A-Z0-9^][A-Z0-9.^=-]{0,31}$/i.test(raw.trim())) {
        invalid('symbols', 'Each symbol must contain 1 through 32 ticker characters.');
      }
      return (raw as string).trim().toUpperCase();
    });
    const news = selected === 'analysis' || selected === 'history';
    if (params.include_news !== undefined && (!news || typeof params.include_news !== 'boolean')) {
      invalid('include_news', 'A boolean news option is supported for analysis/history only.');
    }
    if (params.limit_per_symbol !== undefined && selected !== 'history') invalid('limit_per_symbol', 'This option is only supported for history.');
    if (params.eval_window_days !== undefined && news) invalid('eval_window_days', 'This option is only supported for backtest/stored-backtests.');
    const limit = params.limit_per_symbol ?? 4;
    const window = params.eval_window_days ?? 10;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 32) invalid('limit_per_symbol', 'Expected an integer from 1 through 32.');
    if (typeof window !== 'number' || !Number.isInteger(window) || window < 3 || window > 30) invalid('eval_window_days', 'Expected an integer from 3 through 30.');
    const query = new URLSearchParams();
    if (single) query.set('symbol', symbols[0]!);
    else symbols.forEach(symbol => query.append('symbols', symbol));
    if (news) query.set('include_news', String(params.include_news ?? false));
    if (selected === 'history') query.set('limit_per_symbol', String(limit));
    if (!news) query.set('eval_window_days', String(window));
    const url = `${base}${OPERATIONS[selected]}?${query}`;
    const auth = await buildAuthHeaders(context, 'GET', url, null);
    const response = await fetchMcpDownstream(url, {
      headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
      signal: AbortSignal.timeout(55_000),
    }, execution);
    await assertToolFetchOk(response, 'get_stock_research', { preserveBackoff: true });
    const data = await response.json() as StockData;
    return { operation: selected, data };
  },
  _apiPaths: Object.values(OPERATIONS).map(path => `GET ${path}`),
}];
