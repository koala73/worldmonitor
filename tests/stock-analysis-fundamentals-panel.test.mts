import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildFundamentalDisplayCells } from '../src/services/stock-fundamentals-display.ts';

describe('stock analysis fundamentals panel formatting', () => {
  it('formats normalized ratios and preserves sub-billion statement-currency values', () => {
    const cells = buildFundamentalDisplayCells({
      profitMargin: 0.249,
      operatingMargin: -0.031,
      returnOnEquity: 0.4,
      revenueGrowth: 0.12,
      earningsGrowth: -0.03,
      debtToEquity: 1.5,
      freeCashflow: 49_000_000,
      financialCurrency: 'CNY',
    }, 'USD');

    assert.deepEqual(cells, [
      { label: 'Profit Margin', value: '24.9%', color: '#16a34a' },
      { label: 'Oper. Margin', value: '-3.1%', color: '#dc2626' },
      { label: 'ROE', value: '40.0%', color: '#16a34a' },
      { label: 'Rev. Growth', value: '12.0%', color: '#16a34a' },
      { label: 'EPS Growth', value: '-3.0%', color: '#dc2626' },
      { label: 'Debt/Equity', value: '1.50' },
      { label: 'Free Cash Flow', value: 'CNY 49.0M', color: undefined },
    ]);
  });

  it('uses quote currency as a compatibility fallback and preserves negative magnitude', () => {
    const cells = buildFundamentalDisplayCells({
      freeCashflow: -49_000_000,
    }, 'USD');

    assert.deepEqual(cells, [
      { label: 'Free Cash Flow', value: '-$49.0M', color: '#dc2626' },
    ]);
  });

  it('omits the section when fundamentals are absent or non-numeric', () => {
    assert.deepEqual(buildFundamentalDisplayCells(undefined), []);
    assert.deepEqual(buildFundamentalDisplayCells({
      profitMargin: Number.NaN,
      financialCurrency: 'EUR',
    }), []);
  });
});
