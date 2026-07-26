import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { composeMarketPanelContent } from '../src/components/market-panel-content';

describe('MarketPanel market/disclosure co-rendering (#5577)', () => {
  it('keeps disclosures visible while market data retries and restores both surfaces', () => {
    const retry = composeMarketPanelContent({
      hasMarkets: false,
      marketsHtml: '',
      disclosureHtml: '',
      unavailableMessage: 'Market data unavailable',
    });
    assert.deepEqual(retry, { kind: 'retry', message: 'Market data unavailable' });

    const disclosuresDuringRetry = composeMarketPanelContent({
      hasMarkets: false,
      marketsHtml: '',
      disclosureHtml: '<section class="market-disclosures">Official exchange disclosures</section>',
      unavailableMessage: 'Market data unavailable',
    });
    assert.equal(disclosuresDuringRetry.kind, 'content');
    if (disclosuresDuringRetry.kind === 'content') {
      assert.match(disclosuresDuringRetry.html, /market-data-unavailable/);
      assert.match(disclosuresDuringRetry.html, /Official exchange disclosures/);
    }

    const restoredMarkets = composeMarketPanelContent({
      hasMarkets: true,
      marketsHtml: '<div class="market-item market-item-clickable" data-market-chart="0">SSE Composite</div>',
      disclosureHtml: '<section class="market-disclosures">Official exchange disclosures</section>',
      unavailableMessage: 'Market data unavailable',
    });
    assert.equal(restoredMarkets.kind, 'content');
    if (restoredMarkets.kind === 'content') {
      assert.match(restoredMarkets.html, /SSE Composite/);
      assert.match(restoredMarkets.html, /data-market-chart="0"/);
      assert.match(restoredMarkets.html, /Official exchange disclosures/);
      assert.doesNotMatch(restoredMarkets.html, /market-data-unavailable/);
    }
  });
});
