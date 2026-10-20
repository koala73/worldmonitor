import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOOTSTRAP_CACHE_KEYS, bootstrapTierKeyNames } from '../shared/bootstrap-tier-keys.js';
import { IDU_CANONICAL_KEY } from '../scripts/seed-idmc-idu-displacement.mjs';
import { toDisplacementEventsData } from '../src/services/displacement/idu-events.ts';

// Rows as scripts/seed-idmc-idu-displacement.mjs publishes them.
const event = (overrides: Record<string, unknown>) => ({
  id: '1', countryCode: 'PHL', countryName: 'Philippines', displacementType: 'Disaster', figure: 100, qualifier: 'total',
  displacementDate: '2026-10-01', startDate: '2026-09-30', endDate: '2026-10-01', eventId: '9', eventName: 'Philippines: Storm',
  category: 'Weather related', hazardType: 'Storm', locationName: 'Calabarzon, Philippines', locationAccuracy: 'ADM1',
  sources: 'DSWD', createdAt: '2026-10-02', location: { latitude: 14.16, longitude: 121.35 },
  ...overrides,
});
const country = (overrides: Record<string, unknown>) => ({
  countryCode: 'SDN', countryName: 'Sudan', displaced30d: 0, conflict30d: 0, disaster30d: 0, events30d: 0,
  newlyReported7d: 0, latestDisplacementDate: '2026-08-25', baselineMonthly: 42_710, surge: false,
  ...overrides,
});
const philippines = country({ countryCode: 'PHL', countryName: 'Philippines', displaced30d: 400_000, conflict30d: 1_000, disaster30d: 399_000, events30d: 2, baselineMonthly: 20_000, surge: true });
const snapshot = {
  source: 'IDMC Internal Displacement Updates (via HDX)',
  windowFrom: '2026-04-24',
  missingCountries: [],
  countries: [philippines, country({})],
  events: [
    event({ id: '1', figure: 399_000 }),
    event({ id: '2', displacementType: 'Conflict', figure: 1_000, hazardType: 'Violence', location: { latitude: 7.1, longitude: 125.6 } }),
    event({ id: '3', countryCode: 'SDN', countryName: 'Sudan', displacementType: 'Conflict', figure: 16_076, displacementDate: '2026-07-30', locationName: 'Khartoum, Sudan', location: { latitude: 15.55, longitude: 32.53 } }),
  ],
};

test('the on-demand bootstrap key reads the key the seeder writes', () => {
  assert.equal(BOOTSTRAP_CACHE_KEYS.idmcIduDisplacement, IDU_CANONICAL_KEY);
  assert.ok(bootstrapTierKeyNames('on-demand').includes('idmcIduDisplacement'), 'about 2.5 MB: never tier freight');
});

test('lists only countries with recent or newly reported figures, surges first', () => {
  const quiet = country({ countryCode: 'COD', countryName: 'DR Congo', displaced30d: 57_000, conflict30d: 57_000 });
  const lateOnly = country({ countryCode: 'MMR', countryName: 'Myanmar', newlyReported7d: 3_000 });
  const data = toDisplacementEventsData({ ...snapshot, countries: [quiet, philippines, country({}), lateOnly] });
  assert.deepEqual(data.countries.map((c) => [c.countryCode, c.surge]), [['PHL', true], ['COD', false], ['MMR', false]]);
  // Map focus is the country's largest located figure.
  assert.deepEqual([data.countries[0]!.lat, data.countries[0]!.lon], [14.16, 121.35]);
  assert.equal(data.countries[1]!.lat, undefined);
});

test('points keep located figures, largest first, with the country name and conflict flag', () => {
  const unlocated = event({ id: '4', figure: 5_000_000, location: undefined });
  const zero = event({ id: '5', figure: 0 });
  const data = toDisplacementEventsData({ ...snapshot, events: [...snapshot.events, unlocated, zero] });
  assert.deepEqual(data.points.map((p) => [p.id, p.figure, p.conflict, p.countryName]), [
    ['1', 399_000, false, 'Philippines'],
    ['3', 16_076, true, 'Sudan'],
    ['2', 1_000, true, 'Philippines'],
  ]);
});

test('carries failed country files and the snapshot date for the panel note', () => {
  const data = toDisplacementEventsData({ ...snapshot, missingCountries: ['AFG', 'YEM', 7] });
  assert.deepEqual(data.missingCountries, ['AFG', 'YEM']);
  // windowFrom is the first of 180 dates ending on the snapshot date.
  assert.equal(data.asOf, '2026-10-20');
  assert.equal(toDisplacementEventsData({ ...snapshot, windowFrom: 'bad' }).asOf, '');
});

test('country totals without located figures still reach the panel', () => {
  const data = toDisplacementEventsData({ ...snapshot, events: [event({ location: undefined })] });
  assert.deepEqual(data.points, []);
  assert.deepEqual(data.countries.map((c) => c.countryCode), ['PHL']);
});

test('a missing or malformed snapshot maps to empty data', () => {
  const empty = { countries: [], points: [], missingCountries: [], asOf: '' };
  for (const value of [undefined, null, 'x', {}, { countries: [] }, { events: [] }, { countries: {}, events: [] }]) {
    assert.deepEqual(toDisplacementEventsData(value), empty);
  }
});
