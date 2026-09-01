import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  NQ_INFLUENCE_SYMBOLS,
  selectEarningsForPublication,
} from '../scripts/seed-earnings-calendar.mjs';

function report({
  symbol,
  date = '2026-09-01',
  hour = 'bmo',
  revenueEstimate = 100_000_000,
  epsEstimate = 1,
} = {}) {
  return {
    symbol,
    company: symbol,
    date,
    hour,
    revenueEstimate,
    epsEstimate,
    epsActual: null,
    revenueActual: null,
    hasActuals: false,
    surpriseDirection: '',
  };
}

describe('earnings calendar publication selection', () => {
  it('keeps the script influence basket pinned to the NQ UI contract', () => {
    const source = readFileSync(new URL('../src/config/nq-context.ts', import.meta.url), 'utf8');
    const literal = source.match(/export const NQ_INFLUENCE_SYMBOLS = \[([\s\S]*?)\] as const/);
    assert.ok(literal, 'NQ influence symbol contract must remain present');
    const uiSymbols = [...literal[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(NQ_INFLUENCE_SYMBOLS, uiSymbols);
  });

  it('reserves a bounded slot for a later NQ influence report', () => {
    const general = Array.from({ length: 105 }, (_, index) => report({
      symbol: `GEN${String(index).padStart(3, '0')}`,
      revenueEstimate: 1_000_000_000 - index * 1_000_000,
    }));
    const tracked = report({
      symbol: 'NVDA',
      date: '2026-09-14',
      hour: 'amc',
      revenueEstimate: 50_000_000_000,
    });

    const selected = selectEarningsForPublication([...general, tracked, { ...tracked }]);

    assert.equal(selected.length, 100);
    assert.equal(selected.filter((entry) => entry.symbol === 'NVDA').length, 1);
    assert.equal(selected.at(-1).symbol, 'NVDA');
    assert.deepEqual(
      selected.slice(0, -1).map((entry) => entry.symbol),
      general.slice(0, 99).map((entry) => entry.symbol),
    );
  });

  it('retains a tracked report even when it does not pass the general coverage filter', () => {
    const tracked = report({ symbol: 'AAPL', revenueEstimate: null, epsEstimate: null });
    const untracked = report({ symbol: 'TINY', revenueEstimate: 1_000_000, epsEstimate: null });

    assert.deepEqual(selectEarningsForPublication([tracked, untracked]), [tracked]);
  });
});
