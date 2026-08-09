import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectCompleteHydratedMarketQuotes } from '../src/services/market-hydration.ts';

const meta = (symbol: string) => ({ symbol, name: symbol, display: symbol });
const quote = (symbol: string) => ({ symbol, price: 100 });

describe('selectCompleteHydratedMarketQuotes', () => {
  it('filters unrelated quotes and orders the complete subset by effective selection', () => {
    const selected = selectCompleteHydratedMarketQuotes(
      [meta('SAP'), meta('AAPL')],
      [quote('AAPL'), quote('UNRELATED'), quote('SAP')],
    );
    assert.deepEqual(selected?.map((entry) => entry.symbol), ['SAP', 'AAPL']);
  });

  it('returns null when any requested symbol is absent so the live parameterized path runs', () => {
    assert.equal(
      selectCompleteHydratedMarketQuotes([meta('SAP'), meta('PLTR')], [quote('SAP'), quote('AAPL')]),
      null,
    );
  });
});
