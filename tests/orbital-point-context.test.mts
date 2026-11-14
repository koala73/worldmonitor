import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EVENT_RADIUS_KM, loadPointContext, type FeedRecord, type LiveRecord, type PointContextSources } from '../src/services/orbital/point-context.ts';
import { daylightSpans } from '../src/services/orbital/pass-job.ts';
import { zonedClock } from '../src/services/orbital/local-time.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 13, 12);
const WINDOW = { startMs: NOW - 7 * DAY, endMs: NOW + 72 * HOUR };
const POINT = { lat: 25.2048, lon: 55.2708 };
const KM_PER_DEG_LAT = 111.2;

const north = (km: number) => ({ lat: POINT.lat + km / KM_PER_DEG_LAT, lon: POINT.lon });
const record = (id: string, km: number, timeMs: number, extra: Partial<FeedRecord> = {}): FeedRecord => ({ id, ...north(km), timeMs, label: id, ...extra });
const live = (id: string, km: number): LiveRecord => ({ id, ...north(km), label: id });

function sources(over: Partial<{ events: Partial<PointContextSources['events']>; live: Partial<PointContextSources['live']> }> = {}): PointContextSources {
  const none = async () => [];
  return {
    events: { conflict: none, fires: none, unrest: none, outages: none, ...over.events },
    live: { vessels: none, 'military-flights': none, 'gps-jamming': none, ...over.live },
    countryAt: async () => 'AE',
  };
}

describe('point context around a picked point', () => {
  it('keeps a fire 3 km away yesterday and drops an event 400 km away', async () => {
    const yesterday = NOW - 20 * HOUR;
    const context = await loadPointContext(POINT, WINDOW, NOW, sources({
      events: { fires: async () => [record('near', 3, yesterday), record('far', 400, yesterday)] },
    }));
    const fires = context.events.fires;
    assert.equal(fires.status, 'ok');
    assert.deepEqual(fires.status === 'ok' && fires.events.map((e) => e.id), ['near']);
    assert.ok(fires.status === 'ok' && Math.abs(fires.events[0]!.distanceKm! - 3) < 0.5);
    assert.ok(400 > EVENT_RADIUS_KM);
  });

  it('marks the fire feed as keeping only today and yesterday', async () => {
    const context = await loadPointContext(POINT, WINDOW, NOW, sources());
    const fires = context.events.fires;
    assert.deepEqual(fires.status === 'ok' && fires.retained, { startMs: Date.UTC(2026, 10, 12), endMs: NOW });
  });

  it('ends conflict history at the newest event in the whole feed, because that feed trails by weeks', async () => {
    const newest = NOW - 30 * DAY;
    const context = await loadPointContext(POINT, WINDOW, NOW, sources({
      events: { conflict: async () => [record('old', 2000, NOW - 300 * DAY), record('latest', 2000, newest)] },
    }));
    const conflict = context.events.conflict;
    assert.equal(conflict.status === 'ok' && conflict.retained?.endMs, newest);
    assert.deepEqual(conflict.status === 'ok' && conflict.events, []);
  });

  it('matches an outage by its distance from the point, not by the country it sits in', async () => {
    const context = await loadPointContext(POINT, WINDOW, NOW, sources({
      events: { outages: async () => [
        record('near', 12, NOW - DAY, { countryCode: 'AE' }),
        record('same-country-far', 300, NOW - DAY, { countryCode: 'AE' }),
        record('other-country-near', 20, NOW - DAY, { countryCode: 'OM' }),
      ] },
    }));
    const outages = context.events.outages;
    assert.deepEqual(outages.status === 'ok' && outages.events.map((e) => e.id).sort(), ['near', 'other-country-near']);
    assert.ok(outages.status === 'ok' && outages.events.every((e) => e.distanceKm !== null));
  });

  it('falls back to the country only for a record with no location', async () => {
    const unplaced = (id: string, countryCode: string): FeedRecord => ({ id, lat: Number.NaN, lon: Number.NaN, timeMs: NOW - DAY, label: id, countryCode });
    const context = await loadPointContext(POINT, WINDOW, NOW, sources({
      events: { outages: async () => [unplaced('ae', 'ae'), unplaced('ir', 'IR')] },
    }));
    const outages = context.events.outages;
    assert.deepEqual(outages.status === 'ok' && outages.events.map((e) => [e.id, e.distanceKm]), [['ae', null]]);
  });

  it('leaves events outside the window out of the lane', async () => {
    const context = await loadPointContext(POINT, WINDOW, NOW, sources({
      events: { unrest: async () => [record('before', 1, WINDOW.startMs - HOUR), record('inside', 1, NOW - HOUR)] },
    }));
    const unrest = context.events.unrest;
    assert.deepEqual(unrest.status === 'ok' && unrest.events.map((e) => e.id), ['inside']);
  });

  it('marks a failing source unavailable without failing the others', async () => {
    const context = await loadPointContext(POINT, WINDOW, NOW, sources({
      events: { unrest: async () => { throw new Error('down'); }, fires: async () => [record('near', 3, NOW - HOUR)] },
      live: { 'gps-jamming': async () => { throw new Error('down'); } },
    }));
    assert.deepEqual(context.events.unrest, { status: 'unavailable' });
    assert.deepEqual(context.live['gps-jamming'], { status: 'unavailable' });
    assert.equal(context.events.fires.status, 'ok');
  });

  it('keeps live-only context as a nearest-first snapshot with no time', async () => {
    const context = await loadPointContext(POINT, WINDOW, NOW, sources({
      live: { vessels: async () => [live('far', 500), live('second', 60), live('first', 10)] },
    }));
    const vessels = context.live.vessels;
    assert.deepEqual(vessels.status === 'ok' && vessels.items.map((item) => item.id), ['first', 'second']);
    assert.ok(vessels.status === 'ok' && vessels.items.every((item) => !('timeMs' in item)));
  });
});

describe('daylight at the point', () => {
  it('gives a polar point in continuous daylight one unbroken span', () => {
    const june = Date.UTC(2026, 5, 21);
    const window = { startMs: june - 7 * DAY, endMs: june + 72 * HOUR };
    assert.deepEqual(daylightSpans({ lat: 80, lon: 15 }, window), [window]);
  });

  it('gives a mid-latitude point one span per day', () => {
    const spans = daylightSpans(POINT, WINDOW);
    assert.ok(spans.length >= 10 && spans.length <= 11, `${spans.length} spans`);
    for (const span of spans.slice(1, -1)) {
      const hours = (span.endMs - span.startMs) / HOUR;
      assert.ok(hours > 9 && hours < 13, `${hours} hours of daylight in November`);
    }
  });
});

describe('local time in an injected zone', () => {
  it('labels days and finds local midnights in that zone', () => {
    const clock = zonedClock('Asia/Dubai', 'en-US', NOW);
    assert.equal(clock.abbreviation, 'UTC+4');
    assert.equal(clock.day(Date.UTC(2026, 10, 6, 20)), 'Sat 7 Nov');
    assert.deepEqual(clock.midnights(Date.UTC(2026, 10, 6, 12), Date.UTC(2026, 10, 8, 12)), [Date.UTC(2026, 10, 6, 20), Date.UTC(2026, 10, 7, 20)]);
    assert.equal(zonedClock('Asia/Kolkata', 'en-US', NOW).abbreviation, 'UTC+5:30');
    assert.equal(zonedClock(null, 'en-US', NOW).abbreviation, 'UTC');
  });
});

describe('local midnights across a daylight-saving change', () => {
  it('finds Sydney midnight on the day clocks go forward', () => {
    const clock = zonedClock('Australia/Sydney', 'en-US', Date.UTC(2026, 9, 1));
    const midnights = clock.midnights(Date.UTC(2026, 9, 2, 12), Date.UTC(2026, 9, 4, 12));
    assert.deepEqual(midnights.map((ms) => clock.day(ms)), ['Sat 3 Oct', 'Sun 4 Oct']);
    assert.deepEqual(midnights, [Date.UTC(2026, 9, 2, 14), Date.UTC(2026, 9, 3, 14)]);
  });
});
