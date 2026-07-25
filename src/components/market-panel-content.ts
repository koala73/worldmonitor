import { escapeHtml } from '@/utils/sanitize';

export type MarketPanelContent =
  | { kind: 'retry'; message: string }
  | { kind: 'content'; html: string };

export function composeMarketPanelContent({
  hasMarkets,
  marketsHtml,
  disclosureHtml,
  unavailableMessage,
}: {
  hasMarkets: boolean;
  marketsHtml: string;
  disclosureHtml: string;
  unavailableMessage: string;
}): MarketPanelContent {
  if (!hasMarkets && !disclosureHtml) {
    return { kind: 'retry', message: unavailableMessage };
  }
  const unavailableHtml = hasMarkets
    ? ''
    : `<div class="market-data-unavailable">${escapeHtml(unavailableMessage)}</div>`;
  return {
    kind: 'content',
    html: marketsHtml + unavailableHtml + disclosureHtml,
  };
}
