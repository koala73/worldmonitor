import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildEconomicCalendarResponse } from '../server/worldmonitor/economic/v1/get-economic-calendar.ts';
import { buildEarningsCalendarResponse } from '../server/worldmonitor/market/v1/list-earnings-calendar.ts';
import { addLocalDays, localYmd } from '../src/utils/local-date.ts';

describe('calendar handler ranges', () => {
  it('filters economic events inclusively and echoes the effective request bounds', () => {
    const response = buildEconomicCalendarResponse({
      events: [
        { event: 'old', country: 'US', date: '2026-08-20', impact: '', actual: '', estimate: '', previous: '', unit: '' },
        { event: 'first', country: 'US', date: '2026-08-21', impact: '', actual: '', estimate: '', previous: '', unit: '' },
        { event: 'last', country: 'US', date: '2026-08-22', impact: '', actual: '', estimate: '', previous: '', unit: '' },
      ],
      fromDate: '2026-08-20',
      toDate: '2026-08-22',
      total: 3,
      unavailable: false,
    }, { fromDate: '2026-08-21', toDate: '2026-08-22' });

    assert.deepEqual(response.events.map((event) => event.event), ['first', 'last']);
    assert.deepEqual(
      { fromDate: response.fromDate, toDate: response.toDate, total: response.total, unavailable: response.unavailable },
      { fromDate: '2026-08-21', toDate: '2026-08-22', total: 2, unavailable: false },
    );
  });

  it('returns an available empty earnings window instead of claiming source failure', () => {
    const response = buildEarningsCalendarResponse({
      earnings: [{
        symbol: 'WM', company: 'World Monitor', date: '2026-08-20', hour: '',
        epsEstimate: 1, revenueEstimate: 2, epsActual: 0, revenueActual: 0,
        hasActuals: false, surpriseDirection: '',
      }],
    }, { fromDate: '2026-08-21', toDate: '2026-08-22' });

    assert.deepEqual(response.earnings, []);
    assert.deepEqual(
      { fromDate: response.fromDate, toDate: response.toDate, total: response.total, unavailable: response.unavailable },
      { fromDate: '2026-08-21', toDate: '2026-08-22', total: 0, unavailable: false },
    );
  });

  it('advances local calendar days across fall-back DST without losing a date', () => {
    const previousTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const start = new Date('2026-10-15T04:30:00.000Z');
      assert.equal(localYmd(start), '2026-10-15');
      assert.equal(localYmd(addLocalDays(start, 30)), '2026-11-14');
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });
});
