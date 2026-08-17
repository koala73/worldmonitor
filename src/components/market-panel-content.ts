import { escapeHtml } from '@/utils/sanitize';
import type { MarketQuoteUnavailable, MarketQuoteUnavailableReason } from '@/generated/client/worldmonitor/market/v1/service_client';

export type MarketPanelContent =
  | { kind: 'retry'; message: string }
  | { kind: 'content'; html: string };

/** Symbols shown by name in one notice line before the rest are counted. */
export const UNAVAILABLE_SYMBOLS_SHOWN = 6;

export interface UnavailableSymbolGroup {
  reason: MarketQuoteUnavailableReason;
  /** Up to UNAVAILABLE_SYMBOLS_SHOWN symbols, in response order. */
  symbols: string[];
  /** How many further symbols share this reason. */
  overflow: number;
}

/**
 * Group the response's unavailable symbols by reason, preserving order.
 *
 * Pure and i18n-free so the grouping is testable without a DOM or a loaded
 * locale — the panel maps each reason to a translated phrase. A seed-wide
 * outage marks every requested symbol unavailable, so each line is bounded:
 * the notice tells the user which of THEIR tickers is missing, and a
 * whole-panel failure is already covered by the retry state.
 */
export function groupUnavailableSymbols(
  unavailable: readonly MarketQuoteUnavailable[] | undefined,
  shown: number = UNAVAILABLE_SYMBOLS_SHOWN,
): UnavailableSymbolGroup[] {
  const groups = new Map<MarketQuoteUnavailableReason, UnavailableSymbolGroup>();

  for (const entry of unavailable ?? []) {
    if (!entry?.symbol) continue;
    let group = groups.get(entry.reason);
    if (!group) {
      group = { reason: entry.reason, symbols: [], overflow: 0 };
      groups.set(entry.reason, group);
    }
    if (group.symbols.length < shown) group.symbols.push(entry.symbol);
    else group.overflow += 1;
  }

  return [...groups.values()];
}

export function composeMarketPanelContent({
  hasMarkets,
  marketsHtml,
  disclosureHtml,
  unavailableMessage,
  unavailableSymbolLines = [],
}: {
  hasMarkets: boolean;
  marketsHtml: string;
  disclosureHtml: string;
  unavailableMessage: string;
  /** Already-translated per-reason lines from `groupUnavailableSymbols`. */
  unavailableSymbolLines?: readonly string[];
}): MarketPanelContent {
  if (!hasMarkets && !disclosureHtml) {
    return { kind: 'retry', message: unavailableMessage };
  }
  const unavailableHtml = hasMarkets
    ? ''
    : `<div class="market-data-unavailable">${escapeHtml(unavailableMessage)}</div>`;
  // Only rendered alongside real quotes: without them the retry state above
  // already tells the whole story, and repeating every symbol would bury it.
  const symbolNoticeHtml = hasMarkets && unavailableSymbolLines.length > 0
    ? `<div class="market-symbols-unavailable">${unavailableSymbolLines
        .map((line) => `<div>${escapeHtml(line)}</div>`)
        .join('')}</div>`
    : '';
  return {
    kind: 'content',
    html: marketsHtml + unavailableHtml + symbolNoticeHtml + disclosureHtml,
  };
}
