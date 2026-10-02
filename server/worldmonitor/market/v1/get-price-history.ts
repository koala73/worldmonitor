/**
 * RPC: GetPriceHistory
 * Dated daily closes from Yahoo Finance for up to four symbols already carried
 * by the commodity, market and Gulf quote sets.
 */

import type {
  ServerContext,
  GetPriceHistoryRequest,
  GetPriceHistoryResponse,
  PriceSeries,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import commodityConfig from '../../../../shared/commodities.json';
import stockConfig from '../../../../shared/stocks.json';
import gulfConfig from '../../../../shared/gulf.json';
import { UPSTREAM_TIMEOUT_MS, type YahooChartResponse } from './_shared';
import { CHROME_UA, yahooGate } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const CACHE_TTL_SECONDS = 3 * 60 * 60;
const DEFAULT_RANGE = '3mo';
// The widget relay abandons a data fetch after 15 s; answer before that with
// whatever finished. Same NODE_TEST_CONTEXT knob as yahooGate.
const RESPONSE_BUDGET_MS = process.env.NODE_TEST_CONTEXT ? 300 : 12_000;

// Commodities come last so their names win where a symbol is listed twice (CL=F).
export const TRACKED_SYMBOL_NAMES: ReadonlyMap<string, string> = new Map(
  [...gulfConfig.symbols, ...stockConfig.auxiliarySymbols, ...stockConfig.symbols, ...commodityConfig.commodities]
    .map(({ symbol, name }) => [symbol, name]),
);

function fetchSeries(symbol: string, name: string, range: string): Promise<PriceSeries | null> {
  return cachedFetchJson<PriceSeries>(`market:price-history:v1:${symbol}:${range}`, CACHE_TTL_SECONDS, async () => {
    await yahooGate();
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`,
      { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
    );
    if (!res.ok) return null;

    const data: YahooChartResponse = await res.json();
    const result = data?.chart?.result?.[0];
    const rawCloses = result?.indicators?.quote?.[0]?.close ?? [];
    const timestamps: number[] = [];
    const closes: number[] = [];
    (result?.timestamp ?? []).forEach((seconds, i) => {
      const close = rawCloses[i];
      if (typeof close !== 'number' || !Number.isFinite(close)) return;
      timestamps.push(seconds * 1000);
      closes.push(close);
    });
    // Yahoo serves some local Gulf indices (^TASI.SR, DFMGI.AE) as a single
    // current bar at every range; one point is not a history.
    if (closes.length < 2) return null;

    return { symbol, name, currency: result?.meta?.currency || 'USD', timestamps, closes };
  });
}

export async function getPriceHistory(
  ctx: ServerContext,
  req: GetPriceHistoryRequest,
): Promise<GetPriceHistoryResponse> {
  const range = req.range || DEFAULT_RANGE;
  const requested = [...new Set(req.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];

  let budget: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => { budget = setTimeout(() => resolve(null), RESPONSE_BUDGET_MS); });
  const results = await Promise.all(requested.map(async (symbol) => {
    const name = TRACKED_SYMBOL_NAMES.get(symbol);
    if (!name) return { symbol, series: null, tracked: false };
    const series = await Promise.race([fetchSeries(symbol, name, range).catch(() => null), expired]);
    return { symbol, series, tracked: true };
  }));
  clearTimeout(budget);

  const response: GetPriceHistoryResponse = {
    range,
    series: results.flatMap((r) => (r.series ? [r.series] : [])),
    unavailable: results.filter((r) => !r.series).map((r) => r.symbol),
  };
  // A tracked symbol missing here is a transient upstream failure or a timeout;
  // keep it out of the CDN so it is retried after Redis's short negative cache.
  return results.some((r) => r.tracked && !r.series) ? markNoStoreFallbackResponse(ctx.request, response) : response;
}
