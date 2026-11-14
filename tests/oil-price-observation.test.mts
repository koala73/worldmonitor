import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eiaWeeklySpotProvenance, isStaleOilPrice, oilTapeMaxAgeMs } from '../shared/oil-price-observation.ts';

const at = (iso: string) => Date.parse(iso);
const tapeStale = (priceAt: string, now: string, basis = 'futures') => {
  const clock = at(now);
  return isStaleOilPrice(at(priceAt), oilTapeMaxAgeMs(basis, clock), clock);
};

describe('oil price observation freshness', () => {
  it('keeps the latest weekly EIA observation fresh through release lag and a holiday delay', () => {
    for (const now of ['2026-11-09T12:00Z', '2026-11-10T12:00Z', '2026-11-12T20:00Z']) {
      assert.equal(eiaWeeklySpotProvenance(at('2026-10-30'), at(now)).stale, false, now);
    }
    assert.equal(eiaWeeklySpotProvenance(at('2026-10-30'), at('2026-11-13T17:00:00.001Z')).stale, true);
  });

  it('waits for the shifted Christmas 2025 release plus a daily refresh grace', () => {
    for (const now of ['2025-12-26T00:01Z', '2025-12-28T12:00Z', '2025-12-29T21:59Z', '2025-12-30T22:00Z']) {
      assert.equal(eiaWeeklySpotProvenance(at('2025-12-12'), at(now)).stale, false, now);
    }
    assert.equal(eiaWeeklySpotProvenance(at('2025-12-12'), at('2025-12-30T22:00:00.001Z')).stale, true);
  });

  it('detects a missed normal release on Thursday, without expiring the newly published week', () => {
    assert.equal(eiaWeeklySpotProvenance(at('2026-11-06'), at('2026-11-19T15:30Z')).stale, false);
    assert.equal(eiaWeeklySpotProvenance(at('2026-11-06'), at('2026-11-19T15:30:00.001Z')).stale, true);
    assert.equal(eiaWeeklySpotProvenance(at('2026-11-13'), at('2026-11-19T23:59Z')).stale, false);
  });

  it('uses Eastern daylight time for a normal EIA release and applies year-end shifts', () => {
    assert.equal(eiaWeeklySpotProvenance(at('2026-03-06'), at('2026-03-19T14:30Z')).stale, false);
    assert.equal(eiaWeeklySpotProvenance(at('2026-03-06'), at('2026-03-19T14:30:00.001Z')).stale, true);
    assert.equal(eiaWeeklySpotProvenance(at('2024-12-20'), at('2025-01-03T16:00Z')).stale, false);
    assert.equal(eiaWeeklySpotProvenance(at('2024-12-20'), at('2025-01-03T16:00:00.001Z')).stale, true);
  });

  it('preserves holiday closing quotes until reopening, but rejects quotes old before the halt', () => {
    const sessions = [
      // CME energy halts at 13:30 Central (14:30 Eastern), not 13:30 Eastern.
      ['2026-11-26T19:29Z', '2026-11-26T20:00Z', '2026-11-26T23:00Z'],
      ['2026-11-27T19:44Z', '2026-11-28T12:00Z', '2026-11-29T23:00Z'],
      ['2026-12-24T18:44Z', '2026-12-26T12:00Z', '2026-12-27T23:00Z'],
      ['2027-03-25T20:59Z', '2027-03-26T14:00Z', '2027-03-28T22:00Z'],
      ['2027-01-18T19:29Z', '2027-01-18T20:00Z', '2027-01-18T23:00Z'],
    ];
    for (const [close, during, reopen] of sessions) {
      assert.equal(tapeStale(close, during), false, during);
      assert.equal(tapeStale(close, new Date(at(reopen) + 20 * 60_000).toISOString()), false, reopen);
      assert.equal(tapeStale(close, new Date(at(reopen) + 31 * 60_000).toISOString()), true, reopen);
      assert.equal(tapeStale(new Date(at(close) - 31 * 60_000).toISOString(), during), true, during);
    }
    assert.equal(tapeStale('2027-01-18T18:29Z', '2027-01-18T19:01Z'), true, 'still trading before the energy halt');
  });

  it('keeps the Friday close fresh on Saturday and through the Sunday reopen grace', () => {
    for (const now of ['2026-11-07T15:00Z', '2026-11-08T22:59Z', '2026-11-08T23:20Z']) {
      assert.equal(tapeStale('2026-11-06T21:59Z', now), false, now);
    }
    assert.equal(tapeStale('2026-11-06T21:59Z', '2026-11-08T23:31Z'), true);
    assert.equal(tapeStale('2026-11-06T19:00Z', '2026-11-07T15:00Z'), true);
  });

  it('allows the daily break but detects a two-hour-old Tuesday quote during trading', () => {
    assert.equal(tapeStale('2026-11-10T21:31Z', '2026-11-10T22:02Z'), false);
    assert.equal(tapeStale('2026-11-10T21:29Z', '2026-11-10T22:02Z'), true);
    assert.equal(tapeStale('2026-11-10T21:59Z', '2026-11-10T22:50Z'), false);
    assert.equal(tapeStale('2026-11-10T21:59Z', '2026-11-10T23:20Z'), false);
    assert.equal(tapeStale('2026-11-10T21:59Z', '2026-11-10T23:31Z'), true);
    assert.equal(tapeStale('2026-11-10T12:00Z', '2026-11-10T14:00Z'), true);
  });

  it('uses New York session times across daylight saving changes', () => {
    assert.equal(tapeStale('2026-07-10T20:59Z', '2026-07-12T22:20Z'), false);
    assert.equal(tapeStale('2026-07-10T20:59Z', '2026-07-12T22:31Z'), true);
    assert.equal(tapeStale('2026-10-30T20:59Z', '2026-11-01T23:20Z'), false);
    assert.equal(tapeStale('2026-10-30T20:59Z', '2026-11-01T23:31Z'), true);
  });

  it('keeps invalid, missing, future and old observations stale', () => {
    const now = at('2026-11-07T15:00Z');
    for (const priceAt of [undefined, NaN, Infinity, 0, -1, now + 1]) {
      assert.equal(isStaleOilPrice(priceAt, oilTapeMaxAgeMs('futures', now), now), true);
      assert.equal(eiaWeeklySpotProvenance(priceAt, now).stale, true);
    }
    assert.equal(tapeStale('2026-10-30T21:59Z', '2026-11-07T15:00Z'), true);
  });

  it('preserves the daily spot budget and conservative unknown-basis budget', () => {
    assert.equal(tapeStale('2026-11-03T00:00Z', '2026-11-07T00:00Z', 'spot'), false);
    assert.equal(tapeStale('2026-11-03T00:00Z', '2026-11-07T00:01Z', 'spot'), true);
    assert.equal(tapeStale('2026-11-06T21:59Z', '2026-11-07T15:00Z', 'unknown'), true);
  });
});
