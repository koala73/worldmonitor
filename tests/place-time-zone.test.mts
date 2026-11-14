import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { placeTimeZone, placeTimeZoneLabel } from '../src/utils/place-time-zone.ts';

const winter = Date.UTC(2026, 10, 13, 12);
const summer = Date.UTC(2026, 6, 13, 12);

describe('place time zone', () => {
  it('names the zone and its offset at Palm Jumeirah', () => {
    const tz = placeTimeZone({ lat: 25.112, lon: 55.139 }, winter);
    assert.deepEqual(tz, { zone: 'Asia/Dubai', abbr: 'UTC+4' });
    assert.equal(placeTimeZoneLabel(tz!), 'ASIA/DUBAI · UTC+4');
  });

  it('follows daylight saving at the moment asked for', () => {
    const park = { lat: 40.781, lon: -73.966 };
    assert.equal(placeTimeZoneLabel(placeTimeZone(park, winter)!), 'AMERICA/NEW YORK · EST');
    assert.equal(placeTimeZone(park, summer)!.abbr, 'EDT');
  });

  it('shows only the offset over open sea', () => {
    const tz = placeTimeZone({ lat: 0, lon: -140 }, winter)!;
    assert.match(tz.zone, /^Etc\/GMT/);
    assert.equal(placeTimeZoneLabel(tz), 'UTC-9');
  });

  it('returns null for a point off the globe', () => {
    assert.equal(placeTimeZone({ lat: 95, lon: 0 }, winter), null);
  });
});
