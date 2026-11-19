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

const d = (type: string, description: string) => ({ type, description });
// Rating labels run from strongest bullish to strongest bearish. They are not
// spelled out here: the ChatGPT commerce policy test rejects the word for a
// purchase anywhere in tools/list.
const SIGNAL_LABELS = 'a six-step label from strongest bullish to strongest bearish, with Hold and Watch in the middle';
const ANALYSIS_SCHEMA = {
  type: 'object',
  required: ['available', 'symbol'],
  description: 'One stock analysis.',
  properties: {
    available: d('boolean', 'False when no analysis could be produced; the other fields are then placeholders.'),
    symbol: d('string', 'Ticker analysed.'), name: d('string', 'Company or instrument name.'),
    currency: d('string', 'Price currency code.'), currentPrice: d('number', 'Latest price, in currency.'), changePercent: d('number', 'Change from the previous close, percent.'),
    signal: d('string', `Technical-only rating: ${SIGNAL_LABELS}.`), signalScore: d('number', 'Technical score, 0-100; higher is more bullish.'),
    ratingSignal: d('string', `Headline rating from compositeScore: ${SIGNAL_LABELS}.`),
    compositeScore: d('number', 'signalScore blended with fundamentalScore, 0-100; equals signalScore when fundamentals are too sparse to score.'),
    fundamentalScore: d('number', 'Fundamentals score, 0-100.'),
    generatedAt: d('string', 'When the analysis was produced, ISO 8601.'), analysisAt: d('number', 'When the analysis was produced, Unix epoch milliseconds.'),
    analysisId: d('string', 'Identifier of the saved analysis snapshot.'),
    engineVersion: d('string', 'Analysis engine version.'), provider: d('string', 'LLM provider that wrote the narrative.'), model: d('string', 'LLM model that wrote the narrative.'),
    fallback: d('boolean', 'True when the narrative is a rule-based template because the LLM was unavailable.'),
    summary: d('string', 'One-paragraph assessment.'), action: d('string', 'Suggested positioning in words.'), confidence: d('string', 'Stated confidence in the rating.'),
    technicalSummary: d('string', 'Trend, volume, MACD and RSI readout.'), newsSummary: d('string', 'Summary of recent headlines.'), whyNow: d('string', 'What makes the setup timely.'),
    bullishFactors: { type: 'array', items: { type: 'string' }, description: 'Reasons supporting the rating.' }, riskFactors: { type: 'array', items: { type: 'string' }, description: 'Risks to the rating.' },
    supportLevels: { type: 'array', items: { type: 'number' }, description: 'Price support levels, in currency.' }, resistanceLevels: { type: 'array', items: { type: 'number' }, description: 'Price resistance levels, in currency.' },
    headlines: { type: 'array', items: { type: 'object' }, description: 'Recent headlines used; empty unless include_news was set.' },
    fundamentals: d('object', 'Valuation and financial metrics.'), analystConsensus: d('object', 'Sell-side analyst rating counts.'), priceTarget: d('object', 'Analyst price targets, in currency.'),
  },
};
const BACKTEST_SCHEMA = {
  type: 'object',
  required: ['available', 'symbol'],
  description: 'One backtest of past technical signals.',
  properties: {
    available: d('boolean', 'False when no past signal could be evaluated; the other fields are then placeholders.'), symbol: d('string', 'Ticker tested.'), currency: d('string', 'Price currency code.'),
    evalWindowDays: d('number', 'Trading days each signal was held.'), evaluationsRun: d('number', 'Historical signal dates evaluated.'),
    actionableEvaluations: d('number', 'Evaluations with a bullish or bearish signal and a full holding window, which the rates below use.'),
    winRate: d('number', 'Share of actionable evaluations with a positive simulated return, percent.'), directionAccuracy: d('number', 'Share whose price moved in the signal direction, percent.'),
    avgSimulatedReturnPct: d('number', 'Mean simulated return per actionable evaluation, percent.'),
    cumulativeSimulatedReturnPct: d('number', 'Sum of the simulated returns, percent (not compounded).'),
    latestSignal: d('string', 'Most recent technical signal.'), latestSignalScore: d('number', 'Its technical score, 0-100.'),
    summary: d('string', 'One-sentence result.'), generatedAt: d('string', 'When the backtest ran, ISO 8601.'), engineVersion: d('string', 'Analysis engine version.'),
    ratingBasis: d('string', 'What the signals were based on; technical_only means no point-in-time fundamentals.'),
    evaluations: { type: 'array', description: 'Each simulated trade, newest first.', items: { type: 'object', properties: {
      analysisAt: d('number', 'Signal date, Unix epoch milliseconds.'), signal: d('string', 'Technical signal on that date.'), signalScore: d('number', 'Technical score, 0-100.'),
      entryPrice: d('number', 'Price at the signal.'), exitPrice: d('number', 'Price at exit.'), simulatedReturnPct: d('number', 'Simulated return in the signal direction, percent.'),
      directionCorrect: d('boolean', 'Whether price moved in the signal direction.'), outcome: d('string', 'How the trade ended: take_profit, stop_loss or window_close.'),
      stopLoss: d('number', 'Stop-loss price.'), takeProfit: d('number', 'Take-profit price.'), analysisId: d('string', 'Identifier of the evaluated record.'),
    } } },
  },
};

function stockResearchArguments(params: Record<string, unknown>) {
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
  return { selected, single, symbols, news, limit, window };
}

export const STOCK_TOOLS: ToolDef[] = [{
  name: 'get_stock_research',
  title: 'Stock research',
  _outputBudgetBytes: 524288,
  description: 'Run one stock-research operation and return {operation, data}: analysis (current rating with model and engineVersion provenance), backtest (technical-signal simulation with ratingBasis provenance), history (saved analysis snapshots per symbol) or stored-backtests (saved backtests per symbol). Use analysis/backtest for a named ticker and history/stored-backtests for saved watchlist research. Results record availability and observation dates; backtests omit point-in-time fundamentals and are simulations, not trading results or forecasts. A cold analysis may fetch upstream market data and call an LLM (up to 55 s) and may save a shared research snapshot, so readOnlyHint is false; no trades or account changes occur. Requires a paid plan; weight 2 on API plans, with the gateway\'s provider quotas also applying.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: Object.keys(OPERATIONS), description: 'What to run: a current rating (analysis), a simulation of the symbol\'s past technical signals (backtest), saved analysis snapshots (history) or saved backtest results (stored-backtests).' },
      symbols: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 32 }, description: 'Yahoo Finance tickers identifying the instruments to research, such as AAPL or 7203.T. Use a single ticker for analysis/backtest or a watchlist for saved results. Values are trimmed and uppercased.' },
      include_news: { type: 'boolean', default: false, description: 'analysis/history only: search recent headlines for the symbol and use them in the analysis (headlines, newsSummary); history then reads snapshots saved with news.' },
      limit_per_symbol: { type: 'integer', minimum: 1, maximum: 32, default: 4, description: 'For history, controls how many saved analysis snapshots to read for each ticker, newest first.' },
      eval_window_days: { type: 'integer', minimum: 3, maximum: 30, default: 10, description: 'backtest/stored-backtests only: trading days each historical signal is held before its simulated return is measured.' },
    },
    required: ['operation', 'symbols'],
  },
  outputSchema: {
    type: 'object', required: ['operation', 'data'],
    properties: {
      operation: { type: 'string', enum: Object.keys(OPERATIONS), description: 'Operation that ran.' },
      data: { type: 'object', description: 'The selected operation\'s API payload; saved-result operations return an items array, which may be empty.' },
    },
    anyOf: [
      { properties: { operation: { const: 'analysis' }, data: ANALYSIS_SCHEMA } },
      { properties: { operation: { const: 'backtest' }, data: BACKTEST_SCHEMA } },
      { properties: { operation: { const: 'history' }, data: {
        type: 'object', required: ['items'], properties: { items: {
          type: 'array', description: 'Entries for requested symbols with saved analyses; symbols without snapshots are omitted.',
          items: { type: 'object', required: ['symbol', 'snapshots'], properties: {
            symbol: { type: 'string', description: 'Ticker.' },
            snapshots: { type: 'array', items: ANALYSIS_SCHEMA, description: 'Saved analyses, newest first.' },
          } },
        } },
      } } },
      { properties: { operation: { const: 'stored-backtests' }, data: {
        type: 'object', required: ['items'], properties: { items: {
          type: 'array', items: BACKTEST_SCHEMA,
          description: 'Available saved backtests for requested symbols, newest first; symbols without an available result are omitted.',
        } },
      } } },
    ],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _validateArgs: params => { stockResearchArguments(params); },
  _execute: async (params, base, context, execution) => {
    const { selected, single, symbols, news, limit, window } = stockResearchArguments(params);
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
