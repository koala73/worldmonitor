import { formatChange, formatPrice, getChangeClass } from '@/utils/market-format';
import { escapeHtml } from '@/utils/sanitize';
import { miniSparkline } from '@/utils/sparkline';
import type { MarketData, MarketSymbol } from '@/types';
import {
  NQ_CURRENT_MAX_MS,
  NQ_DELAYED_MAX_MS,
  NQ_PULSE_BASKET,
  NQ_PULSE_DISCLOSURE,
  NQ_PULSE_ORDER,
  type NqPulseSymbol,
} from '@/config/nq-context';

export type NqFreshnessLabel = 'Current' | 'Delayed' | 'Stale' | 'Freshness unavailable';

export type NqPulseRow =
  | {
    kind: 'quote';
    symbol: NqPulseSymbol;
    name: string;
    display: string;
    price: number;
    change: number;
    sparkline?: number[];
  }
  | {
    kind: 'unavailable';
    symbol: NqPulseSymbol;
    name: string;
    display: string;
  };

export function freshnessLabelForAsOf(
  asOf: string | null | undefined,
  nowMs: number,
): NqFreshnessLabel {
  if (!asOf) return 'Freshness unavailable';
  const ts = Date.parse(asOf);
  if (!Number.isFinite(ts)) return 'Freshness unavailable';
  const age = nowMs - ts;
  if (!Number.isFinite(age) || age < 0) return 'Freshness unavailable';
  if (age <= NQ_CURRENT_MAX_MS) return 'Current';
  if (age <= NQ_DELAYED_MAX_MS) return 'Delayed';
  return 'Stale';
}

export function orderNqPulseRows(
  quotes: readonly MarketData[],
  basket: readonly MarketSymbol[] = NQ_PULSE_BASKET,
): NqPulseRow[] {
  const bySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  return basket.map((meta) => {
    const symbol = meta.symbol as NqPulseSymbol;
    const quote = bySymbol.get(meta.symbol);
    if (
      quote
      && quote.price != null
      && Number.isFinite(quote.price)
      && quote.change != null
      && Number.isFinite(quote.change)
    ) {
      return {
        kind: 'quote',
        symbol,
        name: meta.name,
        display: meta.display,
        price: quote.price,
        change: quote.change,
        sparkline: quote.sparkline,
      };
    }
    return {
      kind: 'unavailable',
      symbol,
      name: meta.name,
      display: meta.display,
    };
  });
}

export function composeNqPulseHtml(input: {
  rows: readonly NqPulseRow[];
  freshness: NqFreshnessLabel;
  asOfLabel: string;
  nowMs?: number;
}): string {
  const rowsHtml = input.rows.map((row) => {
    if (row.kind === 'unavailable') {
      return `
      <div class="market-item nq-pulse-row nq-pulse-row--unavailable">
        <div class="market-info">
          <span class="market-name">${escapeHtml(row.name)}</span>
          <span class="market-symbol">${escapeHtml(row.display)}</span>
        </div>
        <div class="market-data">
          <span class="market-price">Unavailable</span>
        </div>
      </div>`;
    }
    return `
      <div class="market-item nq-pulse-row">
        <div class="market-info">
          <span class="market-name">${escapeHtml(row.name)}</span>
          <span class="market-symbol">${escapeHtml(row.display)}</span>
        </div>
        <div class="market-data">
          ${miniSparkline(row.sparkline, row.change)}
          <span class="market-price">${formatPrice(row.price)}</span>
          <span class="market-change ${getChangeClass(row.change)}">${formatChange(row.change)}</span>
        </div>
      </div>`;
  }).join('');

  return `${rowsHtml}
    <div class="nq-pulse-status">
      <span class="nq-pulse-freshness">${escapeHtml(input.freshness)}</span>
      <span class="nq-pulse-asof">${escapeHtml(input.asOfLabel)}</span>
    </div>
    <div class="nq-pulse-disclosure">${escapeHtml(NQ_PULSE_DISCLOSURE)}</div>`;
}

export function nqPulseAsOfLabel(asOf: string | null | undefined, freshness: NqFreshnessLabel): string {
  if (freshness === 'Freshness unavailable' || !asOf) return 'As of: Freshness unavailable';
  return `As of ${asOf}`;
}

export function displayOrderSymbols(): readonly NqPulseSymbol[] {
  return NQ_PULSE_ORDER;
}
