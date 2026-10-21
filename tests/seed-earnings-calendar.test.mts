import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { filterNqEarnings } from '../src/components/nq-catalysts-content.ts';
import { NQ_INFLUENCE_SYMBOLS } from '../src/config/nq-context.ts';
import {
  boundEarningsCalendar,
  EARNINGS_CALENDAR_CAP,
  NQ_INFLUENCE_EARNINGS_SYMBOLS,
} from '../scripts/seed-earnings-calendar.mjs';

const now = new Date('2026-08-31T14:00:00.000Z');

function generalEntry(index: number, date = '2026-09-01') {
  return {
    symbol: `GEN${String(index + 1).padStart(3, '0')}`,
    company: `General ${index + 1}`,
    date,
    hour: 'amc',
    revenueEstimate: 20_000_000 - index,
  };
}

function nqEntry(symbol: string, date: string) {
  return {
    symbol,
    company: symbol,
    date,
    hour: 'bmo',
    revenueEstimate: 50_000_000_000,
  };
}

describe('earnings calendar bound', () => {
  it('keeps the seed reserved names aligned with the NQ influence basket', () => {
    assert.deepEqual([...NQ_INFLUENCE_EARNINGS_SYMBOLS], [...NQ_INFLUENCE_SYMBOLS]);
  });

  it('retains a later NQ influence report when more than 100 earlier general rows would consume the cap', () => {
    const earlier = Array.from({ length: EARNINGS_CALENDAR_CAP + 5 }, (_, index) => generalEntry(index));
    const lateNq = nqEntry('NVDA', '2026-09-10');
    const naive = [...earlier, lateNq].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (b.revenueEstimate ?? 0) - (a.revenueEstimate ?? 0);
    }).slice(0, EARNINGS_CALENDAR_CAP);
    assert.equal(naive.some((entry) => entry.symbol === 'NVDA'), false);

    const bounded = boundEarningsCalendar([...earlier, lateNq]);
    assert.equal(bounded.length, EARNINGS_CALENDAR_CAP);
    assert.ok(bounded.some((entry) => entry.symbol === 'NVDA'));
    assert.equal(bounded.filter((entry) => entry.symbol.startsWith('GEN')).length, EARNINGS_CALENDAR_CAP - 1);
    assert.deepEqual(filterNqEarnings(bounded, now).map((entry) => entry.symbol), ['NVDA']);
  });

  it('reserves every matching NQ influence entry and fills the remaining bounded calendar', () => {
    const earlier = Array.from({ length: EARNINGS_CALENDAR_CAP + 8 }, (_, index) => generalEntry(index));
    const lateNq = NQ_INFLUENCE_SYMBOLS.map((symbol) => nqEntry(symbol, '2026-09-10'));
    const bounded = boundEarningsCalendar([...earlier, ...lateNq]);
    assert.equal(bounded.length, EARNINGS_CALENDAR_CAP);
    const panel = filterNqEarnings(bounded, now).map((entry) => entry.symbol);
    assert.deepEqual(panel, [...NQ_INFLUENCE_SYMBOLS].sort((a, b) => a.localeCompare(b)));
    assert.equal(
      bounded.filter((entry) => entry.symbol.startsWith('GEN')).length,
      EARNINGS_CALENDAR_CAP - NQ_INFLUENCE_SYMBOLS.length,
    );
  });
});
