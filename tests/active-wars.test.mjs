import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { activeWarsReading, palestineLocator } from '../scripts/active-wars.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SEPT = Date.UTC(2026, 8, 15);
const AUG = Date.UTC(2026, 7, 20);
const CAPTURED = Date.UTC(2026, 10, 2);

function event(country, deathsBest, overrides = {}) {
  return {
    dateStart: SEPT,
    country,
    sideA: `Government of ${country}`,
    sideB: 'Rebels',
    deathsBest,
    violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
    ...overrides,
  };
}

describe('activeWarsReading', () => {
  it('ranks countries with 25+ state-based deaths in the latest month only', () => {
    const reading = activeWarsReading([
      event('Sudan', 30),
      event('Ukraine', 100),
      event('Mali', 24),
      event('Mali', 200, { violenceType: 'UCDP_VIOLENCE_TYPE_ONE_SIDED' }),
      event('Chad', 500, { dateStart: AUG }),
    ], CAPTURED);
    assert.equal(reading.referenceMonth, '2026-09');
    assert.equal(reading.latestEventDate, '2026-09-15');
    assert.deepEqual(reading.conflicts.map((row) => [row.name, row.deaths]), [['Ukraine', 100], ['Sudan', 30]]);
    assert.equal(reading.countryCount, 2);
    assert.equal(reading.belowThresholdCount, 1, 'Mali counts below; Chad is outside the month');
  });

  it('uses current country and actor names and resolves the country code', () => {
    const [row] = activeWarsReading([
      event('Yemen (North Yemen)', 40, { sideA: 'Government of Yemen (North Yemen)' }),
    ], CAPTURED).conflicts;
    assert.deepEqual(
      { name: row.name, code: row.code, sideA: row.sideA },
      { name: 'Yemen', code: 'YE', sideA: 'Government of Yemen' },
    );
  });

  it('names the deadliest pair, and leaves it unnamed when UCDP has not identified it', () => {
    const [nigeria] = activeWarsReading([
      event('Nigeria', 95, { sideA: 'XXX475', sideB: 'XXX475' }),
      event('Nigeria', 51, { sideB: 'IS' }),
    ], CAPTURED).conflicts;
    assert.equal(nigeria.deaths, 146);
    assert.deepEqual([nigeria.sideA, nigeria.sideB], ['', '']);
  });

  it('counts fighting UCDP files under Israel where it happened', () => {
    const inPalestine = palestineLocator(REPO_ROOT);
    const at = (latitude, longitude, deathsBest) => event('Israel', deathsBest, {
      sideB: 'Hamas',
      location: { latitude, longitude },
    });
    const reading = activeWarsReading([
      at(31.50, 34.47, 30), // Gaza City
      at(31.53, 35.10, 10), // Hebron, West Bank
      at(32.08, 34.78, 20), // Tel Aviv
      at(32.79, 34.99, 10), // Haifa
    ], CAPTURED, { inPalestine });
    assert.deepEqual(
      reading.conflicts.map((row) => [row.name, row.code, row.deaths]),
      [['Palestine', 'PS', 40], ['Israel', 'IL', 30]],
    );
  });

  it('refuses an empty list and a month the candidate feed stopped publishing after', () => {
    assert.throws(() => activeWarsReading([], CAPTURED), /no dated events/);
    assert.throws(() => activeWarsReading([event('Ukraine', 50)], Date.UTC(2027, 0, 1)), /ended \d+ days before capture/);
  });
});
