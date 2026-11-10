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
    assert.equal(eiaWeeklySpotProvenance(at('2026-10-30'), at('2026-11-13T00:01Z')).stale, true);
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
