/**
 * #6305: a requested symbol that produced no quote must be visible in the
 * Markets panel, not silently absent from the rendered rows.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MarketQuoteUnavailable } from '../src/generated/client/worldmonitor/market/v1/service_client';
import {
  UNAVAILABLE_SYMBOLS_SHOWN,
  composeMarketPanelContent,
  groupUnavailableSymbols,
} from '../src/components/market-panel-content';

const unavailable = (symbol: string, reason: MarketQuoteUnavailable['reason']): MarketQuoteUnavailable => ({
  symbol,
  reason,
});

const NOT_FOUND = 'MARKET_QUOTE_UNAVAILABLE_REASON_NOT_FOUND';
const PROVIDER_ERROR = 'MARKET_QUOTE_UNAVAILABLE_REASON_PROVIDER_ERROR';

describe('groupUnavailableSymbols', () => {
  it('groups by reason and preserves response order within each group', () => {
    const groups = groupUnavailableSymbols([
      unavailable('RIVN', NOT_FOUND),
      unavailable('FUBO', PROVIDER_ERROR),
      unavailable('LCID', NOT_FOUND),
    ]);

    assert.deepEqual(groups, [
      { reason: NOT_FOUND, symbols: ['RIVN', 'LCID'], overflow: 0 },
      { reason: PROVIDER_ERROR, symbols: ['FUBO'], overflow: 0 },
    ]);
  });

  it('counts the tail beyond the shown limit instead of listing every symbol', () => {
    const many = Array.from({ length: UNAVAILABLE_SYMBOLS_SHOWN + 4 }, (_, i) =>
      unavailable(`SYM${i}`, NOT_FOUND),
    );

    const [group] = groupUnavailableSymbols(many);

    assert.equal(group?.symbols.length, UNAVAILABLE_SYMBOLS_SHOWN);
    assert.equal(group?.overflow, 4);
  });

  it('returns nothing for an absent or empty list', () => {
    assert.deepEqual(groupUnavailableSymbols(undefined), []);
    assert.deepEqual(groupUnavailableSymbols([]), []);
  });

  it('skips malformed entries without a symbol', () => {
    assert.deepEqual(groupUnavailableSymbols([unavailable('', NOT_FOUND), unavailable('OK', NOT_FOUND)]), [
      { reason: NOT_FOUND, symbols: ['OK'], overflow: 0 },
    ]);
  });
});

describe('composeMarketPanelContent unavailable-symbol notice', () => {
  const marketsHtml = '<div class="market-item">AAPL</div>';

  it('renders the notice alongside the quotes that did resolve', () => {
    const content = composeMarketPanelContent({
      hasMarkets: true,
      marketsHtml,
      disclosureHtml: '',
      unavailableMessage: 'Market data unavailable',
      unavailableSymbolLines: ['RIVN, LCID — no quote available'],
    });

    assert.equal(content.kind, 'content');
    if (content.kind === 'content') {
      assert.match(content.html, /market-symbols-unavailable/);
      assert.match(content.html, /RIVN, LCID/);
      assert.match(content.html, /AAPL/);
    }
  });

  it('escapes the notice text', () => {
    const content = composeMarketPanelContent({
      hasMarkets: true,
      marketsHtml,
      disclosureHtml: '',
      unavailableMessage: 'Market data unavailable',
      unavailableSymbolLines: ['<img src=x onerror=alert(1)> — no quote available'],
    });

    assert.equal(content.kind, 'content');
    if (content.kind === 'content') {
      assert.doesNotMatch(content.html, /<img/);
      assert.match(content.html, /&lt;img/);
    }
  });

  it('suppresses the per-symbol notice when no quotes rendered at all', () => {
    // The whole-panel retry/unavailable state already covers this; repeating
    // every requested symbol would bury it.
    const content = composeMarketPanelContent({
      hasMarkets: false,
      marketsHtml: '',
      disclosureHtml: '<section class="market-disclosures">Disclosures</section>',
      unavailableMessage: 'Market data unavailable',
      unavailableSymbolLines: ['AAPL, MSFT — market data temporarily unavailable'],
    });

    assert.equal(content.kind, 'content');
    if (content.kind === 'content') {
      assert.doesNotMatch(content.html, /market-symbols-unavailable/);
      assert.match(content.html, /market-data-unavailable/);
    }
  });

  it('renders nothing extra when every requested symbol resolved', () => {
    const content = composeMarketPanelContent({
      hasMarkets: true,
      marketsHtml,
      disclosureHtml: '',
      unavailableMessage: 'Market data unavailable',
    });

    assert.equal(content.kind, 'content');
    if (content.kind === 'content') {
      assert.doesNotMatch(content.html, /market-symbols-unavailable/);
    }
  });
});
