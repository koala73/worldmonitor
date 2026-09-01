import type { MarketSymbol } from '@/types';
import { AUXILIARY_STOCK_CATALOG } from '@/config/markets';

export const NQ_PULSE_DISCLOSURE = 'Context data · 5-minute refresh · not execution-grade';

export const NQ_PULSE_ORDER = ['NQ=F', 'QQQ', '^VXN', '^TNX'] as const;
export type NqPulseSymbol = (typeof NQ_PULSE_ORDER)[number];

export const NQ_INFLUENCE_SYMBOLS = [
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOGL',
  'META',
  'AVGO',
  'TSLA',
] as const;

const AUX_BY_SYMBOL = new Map(AUXILIARY_STOCK_CATALOG.map((entry) => [entry.symbol, entry]));

function requiredAux(symbol: NqPulseSymbol): MarketSymbol {
  const entry = AUX_BY_SYMBOL.get(symbol);
  if (!entry) throw new Error(`NQ Pulse auxiliary symbol missing from stocks.json: ${symbol}`);
  return entry;
}

export const NQ_PULSE_BASKET: MarketSymbol[] = NQ_PULSE_ORDER.map(requiredAux);

export const NQ_MACRO_WINDOW_DAYS = 7;
export const NQ_EARNINGS_WINDOW_DAYS = 14;
export const NQ_CURRENT_MAX_MS = 10 * 60 * 1000;
export const NQ_DELAYED_MAX_MS = 30 * 60 * 1000;
/** Calendar seed cadence is 12h; stay Current through a healthy cycle. */
export const NQ_CATALYST_CURRENT_MAX_MS = 12 * 60 * 60 * 1000;
/** Calendar health budget is 24h; Delayed until that seed-meta ceiling. */
export const NQ_CATALYST_DELAYED_MAX_MS = 24 * 60 * 60 * 1000;
