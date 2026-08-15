import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isStockResearchPath,
  normalizeStockResearchSymbol,
  stockResearchSymbolFromPath,
  stockResearchUrl,
} from '../src/features/stock-research/stock-research-route.ts';

describe('stock research route', () => {
  it('normalizes /stocks/AAPL and /stocks/aapl to AAPL', () => {
    assert.equal(normalizeStockResearchSymbol('aapl'), 'AAPL');
    assert.equal(stockResearchSymbolFromPath('/stocks/AAPL'), 'AAPL');
    assert.equal(stockResearchSymbolFromPath('/stocks/aapl/'), 'AAPL');
    assert.equal(stockResearchUrl('msft'), '/stocks/MSFT');
  });

  it('rejects paths that are not a ticker', () => {
    assert.equal(isStockResearchPath('/maritime-logistics'), false);
    assert.equal(stockResearchSymbolFromPath('/stocks/not a ticker'), null);
    assert.equal(stockResearchSymbolFromPath('/story'), null);
    assert.equal(normalizeStockResearchSymbol(''), null);
  });

  it('treats /stocks with no symbol as a path but not a symbol', () => {
    assert.equal(isStockResearchPath('/stocks'), true);
    assert.equal(stockResearchSymbolFromPath('/stocks'), null);
  });
});
