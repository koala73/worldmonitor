// ListSatelliteManeuvers (#9110) serves the seeded candidate list unchanged in substance, filters
// to one satellite on request, and reads stale with no list or an old one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  noradIdFilter,
  ORBITAL_MANEUVERS_MAX_STALE_MINUTES,
  toManeuversResponse,
} from '../server/worldmonitor/orbital/v1/list-satellite-maneuvers.ts';
import { ORBITAL_MANEUVERS_KEY } from '../server/_shared/cache-keys.ts';
import { buildManeuverPayload, ORBITAL_MANEUVERS_KEY as SEEDED_KEY } from '../scripts/seed-orbital-maneuvers.mjs';
import { HISTORY_SCHEMA } from '../scripts/_orbital-history.mjs';

const DAY_MS = 86_400_000;
const MU = 398_600.4418;
const T0 = Date.parse('2026-10-20T06:00:00Z');
const NOW = T0 + 20.25 * DAY_MS;
const meanMotionFor = (aKm: number) => (Math.sqrt(MU / aKm ** 3) * 86_400) / (2 * Math.PI);

function stored() {
  const entries = [];
  for (let day = 0; day <= 20; day++) {
    const wobble = ((day * 7919) % 11) / 1000 - 0.005;
    for (const [noradId, aKm, step] of [[1, 7000, 0], [2, 6793, 1.5], [3, 6850, 1.2]] as const) {
      entries.push({ noradId, epoch: T0 + day * DAY_MS, meanMotion: meanMotionFor(aKm + wobble + (day >= 15 ? step : 0)), eccentricity: 0.0005, inclination: 0.04, raan: 0, bstar: 0 });
    }
  }
  return buildManeuverPayload({ schema: HISTORY_SCHEMA, windowDays: 30, updatedAt: NOW, entries }, NOW);
}

describe('toManeuversResponse', () => {
  it('serves every candidate with both element sets and each satellite status', () => {
    const response = toManeuversResponse(stored(), NOW);
    assert.equal(response.stale, false);
    // Satellites 2 and 3 burned on day 15, which restarts their trend: only satellite 1 judged its newest step.
    assert.equal(response.evaluatedSatellites, 1);
    assert.deepEqual(response.candidates.map((c) => c.noradId).sort(), [2, 3]);
    const [first] = response.candidates;
    assert.equal(first.element, 'semiMajorAxis');
    assert.equal(first.unit, 'km');
    assert.ok(first.threshold > 0 && first.residual > first.threshold);
    assert.ok(first.after!.semiMajorAxisKm > first.before!.semiMajorAxisKm);
    assert.match(response.methodNote, /not flagged/);
    assert.deepEqual(response.satellites.map((s) => [s.noradId, s.status]), [[1, 'evaluated'], [2, 'insufficient-baseline'], [3, 'insufficient-baseline']]);
  });

  it('narrows to one satellite', () => {
    const response = toManeuversResponse(stored(), NOW, 2);
    assert.deepEqual(response.candidates.map((c) => c.noradId), [2]);
    assert.deepEqual(response.satellites.map((s) => s.noradId), [2]);
    assert.equal(response.evaluatedSatellites, 0);
    assert.deepEqual(toManeuversResponse(stored(), NOW, 999).satellites, []);
  });

  it('is stale without a list, with an unreadable one, or past the health limit', () => {
    for (const value of [null, 'x', { candidates: [] }, { candidates: [], satellites: [], generatedAt: 'soon' }]) {
      const response = toManeuversResponse(value, NOW);
      assert.equal(response.stale, true);
      assert.equal(response.generatedAt, 0);
      assert.deepEqual(response.candidates, []);
    }
    const old = toManeuversResponse(stored(), NOW + ORBITAL_MANEUVERS_MAX_STALE_MINUTES * 60_000 + 1);
    assert.equal(old.stale, true);
    assert.equal(old.candidates.length, 2, 'a stale list is still served, marked stale');
  });

  it('drops rows that are not candidates or lack an element set', () => {
    const value = stored();
    value.candidates.push({ ...value.candidates[0], kind: 'confirmed' }, { ...value.candidates[0], after: null });
    assert.equal(toManeuversResponse(value, NOW).candidates.length, 2);
  });
});

const refusesNoradId = (error: unknown) => (error as { violations?: Array<{ field: string; description: string }> }).violations?.[0]?.field === 'norad_id';

describe('review round 2 (#10868)', () => {
  it('serves every epoch as Unix milliseconds', () => {
    const [first] = toManeuversResponse(stored(), NOW).candidates;
    for (const value of [first.fromEpoch, first.toEpoch, first.confirmedByEpoch, first.before!.epoch, first.after!.epoch]) {
      assert.equal(typeof value, 'number');
      assert.ok(value > T0 && value <= NOW);
    }
    assert.equal(first.after!.epoch, first.toEpoch);
  });

  it('drops a candidate whose element sets or epochs are incomplete instead of serving zeros', () => {
    const value = stored();
    const good = value.candidates[0];
    value.candidates.push(
      { ...good, before: {}, after: {} },
      { ...good, after: { ...good.after, raan: null } },
      { ...good, after: { ...good.after, inclination: '98.5' } },
      { ...good, toEpoch: 'soon' },
    );
    assert.equal(toManeuversResponse(value, NOW).candidates.length, 2);
    const unknownDrag = { ...good, after: { ...good.after, bstar: null } };
    assert.equal(toManeuversResponse({ ...value, candidates: [unknownDrag] }, NOW).candidates[0].after!.bstar, 0);
  });

  it('refuses a norad_id that is not a positive integer, never reading it as every satellite', () => {
    const at = (q: string) => `https://www.worldmonitor.app/api/orbital/v1/list-satellite-maneuvers${q}`;
    assert.equal(noradIdFilter(at('')), 0);
    assert.equal(noradIdFilter(at('?norad_id=0')), 0);
    assert.equal(noradIdFilter(at('?norad_id=40697')), 40697);
    for (const bad of ['abc', '-1', '2.5', '', '1e3', '040697', '1234567890']) {
      assert.throws(() => noradIdFilter(at(`?norad_id=${encodeURIComponent(bad)}`)), refusesNoradId, bad);
    }
    assert.throws(() => noradIdFilter(at('?norad_id=1&norad_id=2')), refusesNoradId);
  });
});

describe('registration', () => {
  it('reads the key the seeder writes, with the health freshness limit', () => {
    assert.equal(ORBITAL_MANEUVERS_KEY, SEEDED_KEY);
    const health = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
    const limit = Number(health.match(/orbitalManeuvers: \{ key: 'seed-meta:orbital:maneuvers', maxStaleMin: (\d+)/)?.[1]);
    assert.equal(ORBITAL_MANEUVERS_MAX_STALE_MINUTES, limit);
  });
});
