import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { filterNqEarnings } from '../src/components/nq-catalysts-content.ts';
import { NQ_INFLUENCE_SYMBOLS } from '../src/config/nq-context.ts';
import {
  boundEarningsCalendar,
  EARNINGS_CALENDAR_CAP,
  fetchAll,
  NQ_INFLUENCE_EARNINGS_SYMBOLS,
} from '../scripts/seed-earnings-calendar.mjs';
import { buildEarningsCalendarResponse } from '../server/worldmonitor/market/v1/list-earnings-calendar.ts';

const now = new Date('2026-08-31T14:00:00.000Z');
const today = '2026-08-31';

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

  it('serves ordinary upcoming reports when a busy past week exceeds the cap', () => {
    const past = Array.from({ length: EARNINGS_CALENDAR_CAP + 5 }, (_, index) => generalEntry(index, '2026-08-25'));
    const upcoming = [generalEntry(202, today), generalEntry(200, today), generalEntry(201, '2026-09-14')];

    const earnings = boundEarningsCalendar([...past, ...upcoming], { today });
    const response = buildEarningsCalendarResponse({ earnings }, { fromDate: today, toDate: '2026-09-14' });

    assert.equal(response.total, 3);
    assert.deepEqual(response.earnings.map((entry) => entry.symbol), ['GEN201', 'GEN203', 'GEN202']);
    assert.equal(earnings.length, EARNINGS_CALENDAR_CAP);
  });

  it('keeps recent results and prioritizes upcoming reports when both windows exceed the cap', () => {
    const older = Array.from({ length: EARNINGS_CALENDAR_CAP + 5 }, (_, index) => generalEntry(index, '2026-08-25'));
    const recent = { ...generalEntry(200, '2026-08-30'), epsActual: 2, hasActuals: true, surpriseDirection: 'beat' };
    const upcoming = Array.from({ length: EARNINGS_CALENDAR_CAP + 5 }, (_, index) => generalEntry(index + 300, today));
    const lateNq = nqEntry('NVDA', '2026-09-14');

    const earnings = boundEarningsCalendar([...older, recent, ...upcoming.reverse(), lateNq], { today });
    const response = buildEarningsCalendarResponse({ earnings }, { fromDate: today, toDate: '2026-09-14' });

    assert.equal(earnings.length, EARNINGS_CALENDAR_CAP);
    assert.equal(response.total, 75);
    assert.equal(response.earnings[0]?.symbol, 'GEN301');
    assert.equal(response.earnings.at(-2)?.symbol, 'GEN374');
    assert.equal(response.earnings.at(-1)?.symbol, 'NVDA');
    assert.ok(earnings.some((entry) => entry.symbol === recent.symbol && entry.surpriseDirection === 'beat'));
  });

  it('spreads upcoming reports across every day of the panel range, largest first per day', () => {
    const past = Array.from({ length: EARNINGS_CALENDAR_CAP + 5 }, (_, index) => generalEntry(index, '2026-08-25'));
    const days = [today, '2026-09-03', '2026-09-07', '2026-09-10', '2026-09-14'];
    const upcoming = days.flatMap((date, day) =>
      Array.from({ length: 40 }, (_, index) => generalEntry(1000 + day * 100 + index, date)));

    const earnings = boundEarningsCalendar([...past, ...upcoming.reverse()], { today });
    const response = buildEarningsCalendarResponse({ earnings }, { fromDate: today, toDate: '2026-09-14' });

    assert.equal(response.total, 75);
    for (const [day, date] of days.entries()) {
      const rows = response.earnings.filter((entry) => entry.date === date).map((entry) => entry.symbol);
      assert.equal(rows.length, 15, date);
      assert.equal(rows[0], `GEN${1001 + day * 100}`, date);
      assert.equal(rows.at(-1), `GEN${1015 + day * 100}`, date);
    }
  });

  it('retains a later NQ influence report when more than 100 earlier general rows would consume the cap', () => {
    const earlier = Array.from({ length: EARNINGS_CALENDAR_CAP + 5 }, (_, index) => generalEntry(index));
    const lateNq = nqEntry('NVDA', '2026-09-10');
    const naive = [...earlier, lateNq].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (b.revenueEstimate ?? 0) - (a.revenueEstimate ?? 0);
    }).slice(0, EARNINGS_CALENDAR_CAP);
    assert.equal(naive.some((entry) => entry.symbol === 'NVDA'), false);

    const bounded = boundEarningsCalendar([...earlier, lateNq], { today });
    assert.equal(bounded.length, EARNINGS_CALENDAR_CAP);
    assert.ok(bounded.some((entry) => entry.symbol === 'NVDA'));
    assert.equal(bounded.filter((entry) => entry.symbol.startsWith('GEN')).length, EARNINGS_CALENDAR_CAP - 1);
    assert.deepEqual(filterNqEarnings(bounded, now).map((entry) => entry.symbol), ['NVDA']);
  });

  it('reserves every matching NQ influence entry and fills the remaining bounded calendar', () => {
    const earlier = Array.from({ length: EARNINGS_CALENDAR_CAP + 8 }, (_, index) => generalEntry(index));
    const lateNq = NQ_INFLUENCE_SYMBOLS.map((symbol) => nqEntry(symbol, '2026-09-10'));
    const bounded = boundEarningsCalendar([...earlier, ...lateNq], { today });
    assert.equal(bounded.length, EARNINGS_CALENDAR_CAP);
    const panel = filterNqEarnings(bounded, now).map((entry) => entry.symbol);
    assert.deepEqual(panel, [...NQ_INFLUENCE_SYMBOLS].sort((a, b) => a.localeCompare(b)));
    assert.equal(
      bounded.filter((entry) => entry.symbol.startsWith('GEN')).length,
      EARNINGS_CALENDAR_CAP - NQ_INFLUENCE_SYMBOLS.length,
    );
  });
});

describe('earnings calendar profile enrichment (#11269)', () => {
  const calendar = {
    earningsCalendar: [
      { symbol: 'DIDIY', date: '2026-11-26', hour: 'bmo', epsEstimate: -0.35, revenueEstimate: 66_724_743_120 },
      { symbol: 'AAPL', date: '2026-11-26', hour: 'amc', epsEstimate: 1.5, revenueEstimate: 124_000_000_000 },
      { symbol: 'XYZQ', date: '2026-11-26', hour: 'amc', epsEstimate: 0.4, revenueEstimate: 50_000_000 },
    ],
  };
  const profiles: Record<string, unknown> = {
    DIDIY: { ticker: 'DIDIY', name: 'DiDi Global Inc', currency: 'CNY', estimateCurrency: 'CNY' },
    AAPL: { ticker: 'AAPL', name: 'Apple Inc', currency: 'USD', estimateCurrency: 'USD' },
  };

  async function fakeFetch(input: string | URL | Request): Promise<Response> {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/calendar/earnings')) return Response.json(calendar);
    const profile = profiles[url.searchParams.get('symbol') ?? ''];
    return profile ? Response.json(profile) : new Response('', { status: 404 });
  }

  it('stores the Finnhub company name and estimate currency on each row', async () => {
    const previousKey = process.env.FINNHUB_API_KEY;
    process.env.FINNHUB_API_KEY = 'test-key';
    try {
      const data = await fetchAll({
        fetchFn: fakeFetch as typeof fetch,
        sleepFn: async () => {},
        now: new Date('2026-11-25T00:00:00Z'),
      });
      const bySymbol = new Map(data.earnings.map((entry) => [entry.symbol, entry]));
      assert.equal(bySymbol.get('DIDIY')?.company, 'DiDi Global Inc');
      assert.equal(bySymbol.get('DIDIY')?.revenueCurrency, 'CNY');
      assert.equal(bySymbol.get('AAPL')?.revenueCurrency, 'USD');
      assert.equal(bySymbol.get('XYZQ')?.company, 'XYZQ');
      assert.equal(bySymbol.get('XYZQ')?.revenueCurrency, '');

      const response = buildEarningsCalendarResponse(data, { fromDate: '2026-11-18', toDate: '2026-12-09' });
      assert.equal(response.earnings.find((entry) => entry.symbol === 'DIDIY')?.revenueCurrency, 'CNY');
    } finally {
      if (previousKey === undefined) delete process.env.FINNHUB_API_KEY;
      else process.env.FINNHUB_API_KEY = previousKey;
    }
  });
});
