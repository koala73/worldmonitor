import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { POSTURE_THEATERS as ENGINE_THEATERS } from '../shared/analysis-military-posture-data.ts';
import {
  POSTURE_THEATERS,
  VESSEL_HISTORY_MAX_ENTRIES,
  VESSEL_HISTORY_MIN_GAP_MS,
  appendVesselHistory,
  calculateTheaterPostures,
  countUsniVesselsInBounds,
} from '../scripts/shared/theater-posture.js';

const theater = (id) => POSTURE_THEATERS.find((t) => t.id === id);
const flightsIn = (id, count, extra = {}) => {
  const { bounds } = theater(id);
  const lat = (bounds.north + bounds.south) / 2;
  const lon = (bounds.east + bounds.west) / 2;
  return Array.from({ length: count }, (_, i) => ({ id: `${id}-${i}`, lat, lon, aircraftType: 'transport', ...extra }));
};
const level = (postures, id) => postures.find((p) => p.theater === id).postureLevel;

describe('theater posture rule (the one rule the relay publishes)', () => {
  it('rates aircraft against the theater thresholds', () => {
    const postures = calculateTheaterPostures([...flightsIn('iran-theater', 8), ...flightsIn('baltic-theater', 12)], new Map());
    assert.equal(level(postures, 'iran-theater'), 'elevated');
    assert.equal(level(postures, 'baltic-theater'), 'critical');
    assert.equal(level(postures, 'taiwan-theater'), 'normal');
  });

  it('caps the vessel contribution at half the elevated threshold, so ships alone never raise a level', () => {
    // Baltic: elevated at 5 aircraft, cap floor(5/2) = 2 ships. 19 strict-military ships alone stay normal.
    const shipsOnly = calculateTheaterPostures([], new Map([['baltic-theater', 19]]));
    assert.equal(level(shipsOnly, 'baltic-theater'), 'normal');
    assert.equal(shipsOnly.find((p) => p.theater === 'baltic-theater').trackedVessels, 19, 'the full count is still reported');
    // 3 aircraft + 2 capped ships = 5 reaches elevated.
    const mixed = calculateTheaterPostures(flightsIn('baltic-theater', 3), new Map([['baltic-theater', 19]]));
    assert.equal(level(mixed, 'baltic-theater'), 'elevated');
  });

  it('never uses a country instability score: Yemen with no assets is normal', () => {
    const postures = calculateTheaterPostures([], new Map());
    assert.equal(level(postures, 'yemen-redsea-theater'), 'normal');
  });

  it('marks naval presence and strike capability from the inputs', () => {
    const strike = [
      ...flightsIn('iran-theater', 2, { aircraftType: 'tanker' }),
      ...flightsIn('iran-theater', 1, { aircraftType: 'awacs' }),
      ...flightsIn('iran-theater', 5, { aircraftType: 'fighter' }),
    ];
    const iran = calculateTheaterPostures(strike, new Map([['iran-theater', 1]])).find((p) => p.theater === 'iran-theater');
    assert.deepEqual(iran.activeOperations, ['strike_capable', 'aerial_refueling', 'airborne_early_warning', 'naval_presence']);
  });

  it('keeps the same theater table as the dashboard engine, so the two cannot drift', () => {
    assert.deepEqual(
      POSTURE_THEATERS.map(({ id, bounds, thresholds, strikeIndicators }) => ({ id, bounds, thresholds, strikeIndicators })),
      ENGINE_THEATERS.map(({ id, bounds, thresholds, strikeIndicators }) => ({ id, bounds, thresholds, strikeIndicators })),
    );
  });
});

describe('USNI roster count', () => {
  const iran = theater('iran-theater').bounds;
  const usni = [
    { name: 'USS Abraham Lincoln', hullNumber: 'CVN-72', regionLat: 24, regionLon: 58, deploymentStatus: 'deployed' },
    { name: 'USS Spruance', hullNumber: 'DDG-111', regionLat: 25, regionLon: 56, deploymentStatus: 'underway' },
    { name: 'USS Tripoli', hullNumber: 'LHA-7', regionLat: 35.3, regionLon: 139.7, deploymentStatus: 'in-port' },
    { name: 'USS Boxer', hullNumber: 'LHD-4', regionLat: 26, regionLon: 52, deploymentStatus: 'in-port' },
    { name: 'USS Nowhere', hullNumber: 'DDG-1', deploymentStatus: 'deployed' },
  ];

  it('counts deployed and underway ships with a position in the theater, not ships in port', () => {
    assert.equal(countUsniVesselsInBounds(usni, iran, new Set()), 2);
  });

  it('does not count a ship the AIS stream already counted under the same name', () => {
    assert.equal(countUsniVesselsInBounds(usni, iran, new Set(['USS ABRAHAM LINCOLN'])), 1);
    assert.equal(countUsniVesselsInBounds(usni, iran, new Set(['  uss   spruance '])), 1);
  });

  it('treats a missing or malformed roster as no ships', () => {
    assert.equal(countUsniVesselsInBounds(null, iran, new Set()), 0);
    assert.equal(countUsniVesselsInBounds([null, 'x', {}], iran, new Set()), 0);
  });
});

describe('vessel history (the series ship thresholds will be calibrated on)', () => {
  const entry = (at) => ({ at, theaters: { 'baltic-theater': { ais: 15, usni: 0 } } });

  it('keeps at most one entry per hour', () => {
    const t0 = Date.UTC(2026, 10, 24, 12);
    let history = appendVesselHistory([], entry(t0));
    history = appendVesselHistory(history, entry(t0 + 10 * 60_000));
    assert.equal(history.length, 1);
    history = appendVesselHistory(history, entry(t0 + VESSEL_HISTORY_MIN_GAP_MS));
    assert.equal(history.length, 2);
  });

  it('keeps 30 days of hourly entries and drops the oldest', () => {
    const t0 = Date.UTC(2026, 10, 1);
    let history = [];
    for (let i = 0; i < VESSEL_HISTORY_MAX_ENTRIES + 5; i += 1) history = appendVesselHistory(history, entry(t0 + i * 3_600_000));
    assert.equal(history.length, VESSEL_HISTORY_MAX_ENTRIES);
    assert.equal(history[0].at, t0 + 5 * 3_600_000);
    assert.ok(VESSEL_HISTORY_MAX_ENTRIES >= 30 * 24);
  });

  it('ignores a malformed stored history instead of failing the publish', () => {
    assert.equal(appendVesselHistory('junk', entry(1)).length, 1);
    assert.equal(appendVesselHistory([null, { at: 'x' }], entry(2)).length, 1);
  });
});

describe('one writer', () => {
  it('only the relay writes the theater posture keys and their freshness marker', () => {
    const seeder = readFileSync(new URL('../scripts/seed-military-flights.mjs', import.meta.url), 'utf8');
    for (const key of ['theater-posture:sebuf:v1', 'theater_posture:sebuf:stale:v1', 'theater-posture:sebuf:backup:v1', 'seed-meta:theater-posture']) {
      assert.ok(!seeder.includes(`'${key}'`), `seed-military-flights.mjs still names ${key}`);
    }
    const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
    assert.match(relay, /require\('\.\/shared\/theater-posture\.js'\)/);
    assert.doesNotMatch(relay, /^const POSTURE_THEATERS = \[/m, 'the relay keeps its own copy of the theater table');
  });
});
