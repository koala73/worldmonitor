/**
 * Phase 5 news-to-session evidence primitives.
 *
 * Alignment is deterministic exchange-calendar bookkeeping.  It deliberately
 * does not infer that an article caused a price movement, sentiment, category,
 * relevance score or forecast.  Those require a separately configured and
 * provenance-bearing analysis provider.
 */

import type {
  MarketSession,
  StockNewsAlignment,
  StockNewsAnalysis,
  StockNewsItem,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { resolveUsEquityMarketState } from './market-calendar';

const NY_TIME_ZONE = 'America/New_York';

type NewYorkParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
};

function nyParts(timestampUtc: number): NewYorkParts {
  const date = new Date(timestampUtc);
  if (!Number.isFinite(date.getTime())) throw new Error('published_at_utc must be a valid timestamp');
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date);
  const lookup = Object.fromEntries(values.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return {
    year: Number(lookup.year), month: Number(lookup.month), day: Number(lookup.day),
    hour: Number(lookup.hour), minute: Number(lookup.minute), second: Number(lookup.second), weekday: String(lookup.weekday),
  };
}

function isoLocalDate(parts: Pick<NewYorkParts, 'year' | 'month' | 'day'>): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function nextCalendarDate(date: string): string {
  const next = new Date(`${date}T12:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** Resolve the next normal US equity date without treating a weekday as open. */
export function nextUsEquityTradingDate(fromDate: string): string {
  let candidate = fromDate;
  for (let attempts = 0; attempts < 14; attempts += 1) {
    candidate = nextCalendarDate(candidate);
    // 16:00Z is daytime in New York in both standard and daylight time, which
    // allows the existing exchange-calendar implementation to decide holidays.
    const state = resolveUsEquityMarketState(new Date(`${candidate}T16:00:00.000Z`));
    if (state.session === 'MARKET_SESSION_REGULAR') return candidate;
  }
  throw new Error(`could not resolve next US equity trading date after ${fromDate}`);
}

function isUsEquityTradingDate(date: string): boolean {
  return resolveUsEquityMarketState(new Date(`${date}T16:00:00.000Z`)).session === 'MARKET_SESSION_REGULAR';
}

/**
 * Map a timestamp to NYSE/Nasdaq publication session and aligned trading date.
 * Pre-market and regular-session articles align to that date; after-hours,
 * weekends and holidays align to the next actual exchange trading day.
 */
export function alignUsEquityNewsTimestamp(publishedAtUtc: number): StockNewsAlignment {
  const parts = nyParts(publishedAtUtc);
  const localDate = isoLocalDate(parts);
  const state = resolveUsEquityMarketState(new Date(publishedAtUtc));
  const tradingDate = isUsEquityTradingDate(localDate)
    ? localDate
    : nextUsEquityTradingDate(localDate);
  const marketSessionAtPublish: MarketSession = state.session;
  const minuteOfDay = (parts.hour * 60) + parts.minute;
  const afterRegularClose = state.session === 'MARKET_SESSION_AFTER' || minuteOfDay >= (20 * 60);
  const alignedTradingDate = afterRegularClose || !isUsEquityTradingDate(localDate)
    ? nextUsEquityTradingDate(localDate)
    : tradingDate;

  let alignmentRule = 'PREMARKET_SAME_TRADING_DAY';
  if (!isUsEquityTradingDate(localDate)) alignmentRule = 'NON_TRADING_DAY_NEXT_TRADING_DAY';
  else if (state.session === 'MARKET_SESSION_REGULAR') alignmentRule = 'REGULAR_SESSION_SAME_TRADING_DAY';
  else if (state.session === 'MARKET_SESSION_AFTER') alignmentRule = 'AFTER_HOURS_NEXT_TRADING_DAY';
  else if (minuteOfDay >= (20 * 60)) alignmentRule = 'POST_SESSION_NEXT_TRADING_DAY';
  else if (state.session === 'MARKET_SESSION_CLOSED') alignmentRule = 'PREMARKET_SAME_TRADING_DAY';

  return {
    exchangeTimezone: NY_TIME_ZONE,
    publishedAtExchangeTz: `${localDate}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}[${NY_TIME_ZONE}]`,
    alignedTradingDate,
    alignmentRule,
    marketSessionAtPublish,
  };
}

/** Explicit disabled analysis state; zero is not a neutral score or causality claim. */
export function notConfiguredStockNewsAnalysis(): StockNewsAnalysis {
  return {
    available: false,
    status: 'NOT_CONFIGURED',
    reason: 'No configured evidence-bearing news-analysis model produced sentiment, relevance, category, causal confidence, or realized-return evaluation.',
    modelSentiment: 'NEWS_SENTIMENT_UNAVAILABLE',
    sentimentReason: 'Model sentiment was not evaluated.',
    relevance: 0,
    relevanceReason: 'Relevance score is unavailable; 0 is a transport placeholder, not a measured relevance score.',
    causalConfidence: 0,
    causalReason: 'No causal claim is made. Temporal alignment and correlation alone do not establish causality.',
    category: '',
    categoryReason: 'Category is unavailable until an evidence-bearing analysis runs.',
    modelProvider: '',
    modelVersion: '',
    promptVersion: '',
    generatedAtUtc: 0,
    realizedReturns: [],
  };
}

/** Enrich a source-validated news item without changing its source fact fields. */
export function enrichStockNewsItem(item: Omit<StockNewsItem, 'alignment' | 'analysis'>): StockNewsItem {
  return {
    ...item,
    alignment: alignUsEquityNewsTimestamp(item.publishedAtUtc),
    analysis: notConfiguredStockNewsAnalysis(),
  };
}
