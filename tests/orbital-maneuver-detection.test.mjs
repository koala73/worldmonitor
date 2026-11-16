// Candidate manoeuvre detection (#9110): known burns are flagged once, with both element sets
// and the threshold; refits, re-entry decay and storm drag are not; and every satellite the
// detector cannot judge says why instead of reporting "no manoeuvre".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  detectCandidateManeuvers,
  detectSatelliteManeuvers,
  historyEntryFromOmm,
  j2RaanRateDegPerDay,
  orbitRegime,
  semiMajorAxisKm,
} from '../scripts/_orbital-maneuvers.mjs';

const DAY_MS = 86_400_000;
const MU = 398_600.4418;
const { records } = JSON.parse(readFileSync(new URL('./fixtures/orbital/celestrak-gp-2026-11-13.json', import.meta.url), 'utf8'));
const SENTINEL_2A = records.find((omm) => omm.OBJECT_NAME === 'SENTINEL-2A');
const T0 = Date.parse('2026-10-20T06:00:00Z');

function rng(seed) {
  let s = seed >>> 0;
  const uniform = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform() || 1e-12)) * Math.cos(2 * Math.PI * uniform());
}

const meanMotionFor = (aKm) => (Math.sqrt(MU / aKm ** 3) * 86_400) / (2 * Math.PI);

/**
 * A synthetic history: one epoch per `stepDays`, semi-major axis decaying at `decayKmPerDay`,
 * RAAN regressing under J2, Gaussian noise on each element, and `events` applied from their day
 * on (`once: true` applies to that epoch only, as an element-set refit does).
 */
function history({
  noradId = 99_001, aKm, eccentricity = 0.0001, inclination = 98.56, raan = 30, days = 20, stepDays = 1,
  decayKmPerDay = 0, noise = { sma: 0.02, inc: 0.0005, raan: 0.001 }, events = [], skipDays = [], seed = 1,
} = {}) {
  const gauss = rng(seed);
  const out = [];
  let node = raan;
  let prev = null;
  for (let day = 0; day <= days; day += stepDays) {
    let a = aKm + decayKmPerDay * day;
    let inc = inclination;
    let dNode = 0;
    for (const event of events) {
      const applies = event.once ? day === event.day : day >= event.day;
      if (!applies) continue;
      a += event.dSma ?? 0;
      inc += event.dInc ?? 0;
      dNode += event.dRaan ?? 0;
    }
    const entry = { noradId, epoch: T0 + day * DAY_MS, meanMotion: meanMotionFor(a), eccentricity, inclination: inc, raan: 0, bstar: 0.0001 };
    if (prev) node += ((j2RaanRateDegPerDay(prev) + j2RaanRateDegPerDay(entry)) / 2) * stepDays;
    prev = entry;
    if (skipDays.includes(day)) continue;
    out.push({
      ...entry,
      meanMotion: meanMotionFor(a + gauss() * noise.sma),
      inclination: inc + gauss() * noise.inc,
      raan: (((node + dNode + gauss() * noise.raan) % 360) + 360) % 360,
    });
  }
  return out;
}

const nowAfter = (entries) => entries.at(-1).epoch + 6 * 3_600_000;
const run = (entries, extra = {}) => detectSatelliteManeuvers(entries, { nowMs: nowAfter(entries), ...extra });

describe('orbit helpers', () => {
  it('converts mean motion to semi-major axis', () => {
    assert.ok(Math.abs(semiMajorAxisKm(1.00273791) - 42_164) < 1);
    assert.ok(Math.abs(semiMajorAxisKm(meanMotionFor(7000)) - 7000) < 1e-6);
  });

  it('gives a sun-synchronous orbit the sun-synchronous nodal rate', () => {
    const entry = historyEntryFromOmm(SENTINEL_2A);
    assert.ok(Math.abs(j2RaanRateDegPerDay(entry) - 0.9856) < 0.01);
  });

  it('classifies orbit regimes', () => {
    assert.equal(orbitRegime({ meanMotion: 15.5, eccentricity: 0.0005 }), 'leo');
    assert.equal(orbitRegime({ meanMotion: 2.0056, eccentricity: 0.005 }), 'meo');
    assert.equal(orbitRegime({ meanMotion: 1.0027, eccentricity: 0.0002 }), 'geo');
    assert.equal(orbitRegime({ meanMotion: 2.006, eccentricity: 0.72 }), 'heo');
  });

  it('reads a history entry from an OMM record and rejects an incomplete one', () => {
    const entry = historyEntryFromOmm(SENTINEL_2A);
    assert.deepEqual(entry, {
      noradId: 40_697,
      epoch: Date.parse('2026-11-11T15:03:05.963Z'),
      meanMotion: 14.30821442,
      eccentricity: 0.0001182,
      inclination: 98.5619,
      raan: 28.3134,
      bstar: 0.00012902,
    });
    assert.equal(historyEntryFromOmm({ ...SENTINEL_2A, MEAN_MOTION: undefined }), null);
    assert.equal(historyEntryFromOmm({ ...SENTINEL_2A, EPOCH: 'not a date' }), null);
  });
});

describe('known manoeuvres are flagged once', () => {
  it('a LEO reboost of 1.2 km against steady drag decay', () => {
    const entries = history({ aKm: 6793, inclination: 51.64, decayKmPerDay: -0.05, events: [{ day: 15, dSma: 1.2 }] });
    const result = run(entries);
    assert.equal(result.status, 'evaluated');
    assert.equal(result.candidates.length, 1);
    const [found] = result.candidates;
    assert.equal(found.kind, 'candidate');
    assert.equal(found.element, 'semiMajorAxis');
    assert.equal(found.regime, 'leo');
    assert.equal(found.toEpoch, new Date(T0 + 15 * DAY_MS).toISOString());
    assert.equal(found.fromEpoch, new Date(T0 + 14 * DAY_MS).toISOString());
    assert.ok(Math.abs(found.residual - 1.2) < 0.15, `residual ${found.residual}`);
    assert.ok(found.threshold >= 0.2 && found.threshold < 1.2);
    assert.equal(found.before.epoch, found.fromEpoch);
    assert.equal(found.after.epoch, found.toEpoch);
    assert.ok(found.after.semiMajorAxisKm - found.before.semiMajorAxisKm > 1);
  });

  it('an inclination trim on a sun-synchronous orbit', () => {
    const base = historyEntryFromOmm(SENTINEL_2A);
    const entries = history({ aKm: semiMajorAxisKm(base.meanMotion), inclination: base.inclination, raan: base.raan, events: [{ day: 13, dInc: -0.03 }] });
    const result = run(entries);
    assert.deepEqual(result.candidates.map((c) => [c.element, c.toEpoch]), [['inclination', new Date(T0 + 13 * DAY_MS).toISOString()]]);
    assert.ok(Math.abs(result.candidates[0].residual + 0.03) < 0.005);
  });

  it('a node shift beyond J2 regression', () => {
    const entries = history({ aKm: 7071, inclination: 98.2, events: [{ day: 14, dRaan: 0.15 }] });
    const result = run(entries);
    assert.deepEqual(result.candidates.map((c) => c.element), ['raan']);
    assert.ok(Math.abs(result.candidates[0].residual - 0.15) < 0.01);
  });

  it('two burns, the second only after a full baseline has built up behind the first', () => {
    const events = [{ day: 11, dSma: 1.2 }, { day: 23, dSma: 1.0 }, { day: 27, dSma: 1.0 }];
    const entries = history({ aKm: 6793, inclination: 51.64, decayKmPerDay: -0.05, days: 30, events });
    const result = run(entries);
    assert.deepEqual(result.candidates.map((c) => c.toEpoch), [11, 23].map((day) => new Date(T0 + day * DAY_MS).toISOString()));
  });

  it('a GEO station-keeping burn, without comparing the ill-defined node of a near-equatorial orbit', () => {
    const entries = history({
      aKm: 42_164, inclination: 0.05, eccentricity: 0.0002,
      noise: { sma: 0.2, inc: 0.002, raan: 2 }, events: [{ day: 12, dSma: 4 }],
    });
    const result = run(entries);
    assert.equal(result.regime, 'geo');
    assert.deepEqual(result.candidates.map((c) => c.element), ['semiMajorAxis']);
  });
});

describe('known false positives are not flagged', () => {
  it('nothing on real fixture orbits propagated with their own drag terms and J2', () => {
    const entries = records.flatMap((omm, i) => {
      const base = historyEntryFromOmm(omm);
      const decayKmPerDay = -(2 / 3) * semiMajorAxisKm(base.meanMotion) * ((2 * Number(omm.MEAN_MOTION_DOT)) / base.meanMotion);
      return history({
        noradId: base.noradId, aKm: semiMajorAxisKm(base.meanMotion), eccentricity: base.eccentricity,
        inclination: base.inclination, raan: base.raan, decayKmPerDay, seed: 100 + i,
      });
    });
    const result = detectCandidateManeuvers(entries, { nowMs: T0 + 20.25 * DAY_MS });
    assert.equal(result.satellites.length, records.length);
    assert.ok(result.satellites.every((s) => s.status === 'evaluated'), JSON.stringify(result.satellites));
    assert.deepEqual(result.candidates, []);
  });

  it('a one-epoch element-set refit that the next epoch does not repeat', () => {
    const entries = history({ aKm: 6900, inclination: 97.4, events: [{ day: 15, dSma: 0.8, dInc: 0.05, once: true }] });
    assert.deepEqual(run(entries).candidates, []);
  });

  it('a step on the newest epoch waits for the next epoch to confirm it', () => {
    const entries = history({ aKm: 6793, inclination: 51.64, events: [{ day: 20, dSma: 1.5 }] });
    const result = run(entries);
    assert.equal(result.status, 'evaluated');
    assert.deepEqual(result.candidates, []);
  });

  it('a geomagnetic-storm drag spike, unless drag is known to be quiet', () => {
    const entries = history({ aKm: 6778, inclination: 53, decayKmPerDay: -0.04, events: [{ day: 15, dSma: -0.6 }] });
    assert.deepEqual(run(entries).candidates, [], 'no drag answer');
    assert.deepEqual(run(entries, { dragDisturbed: () => null }).candidates, [], 'unknown drag');
    assert.deepEqual(run(entries, { dragDisturbed: () => true }).candidates, [], 'storm');
    const quiet = run(entries, { dragDisturbed: () => false });
    assert.deepEqual(quiet.candidates.map((c) => c.element), ['semiMajorAxis']);
    assert.ok(quiet.candidates[0].residual < 0);
  });

  it('decay towards re-entry', () => {
    const entries = history({ aKm: 6378.137 + 200, inclination: 51.6, decayKmPerDay: -1.5, events: [{ day: 15, dSma: 2 }] });
    const result = run(entries);
    assert.equal(result.status, 'decaying');
    assert.deepEqual(result.candidates, []);
  });
});

describe('fails closed', () => {
  it('without a full baseline window', () => {
    const entries = history({ aKm: 6793, inclination: 51.64, days: 8, events: [{ day: 6, dSma: 2 }] });
    const result = run(entries);
    assert.equal(result.status, 'insufficient-baseline');
    assert.deepEqual(result.candidates, []);
  });

  it('when the newest epoch is stale', () => {
    const entries = history({ aKm: 6793, inclination: 51.64, events: [{ day: 15, dSma: 1.2 }] });
    const result = detectSatelliteManeuvers(entries, { nowMs: entries.at(-1).epoch + 5 * DAY_MS });
    assert.equal(result.status, 'stale');
    assert.deepEqual(result.candidates, []);
  });

  it('across a gap between the compared epochs', () => {
    const entries = history({ aKm: 6793, inclination: 51.64, events: [{ day: 15, dSma: 1.2 }], skipDays: [12, 13, 14] });
    assert.deepEqual(run(entries).candidates, []);
  });

  it('needs nowMs and tolerates junk entries', () => {
    assert.throws(() => detectSatelliteManeuvers(history({ aKm: 7000 })), /nowMs/);
    assert.deepEqual(detectSatelliteManeuvers([null, { noradId: 1 }], { nowMs: T0 }), { noradId: null, status: 'no-history', candidates: [] });
  });
});

describe('detectCandidateManeuvers', () => {
  it('groups by satellite, reports each status, and lists candidates newest first', () => {
    const burnEarly = history({ noradId: 3, aKm: 6793, inclination: 51.64, events: [{ day: 12, dSma: 1.2 }], seed: 3 });
    const burnLate = history({ noradId: 1, aKm: 7071, inclination: 98.2, events: [{ day: 16, dInc: 0.04 }], seed: 4 });
    const short = history({ noradId: 2, aKm: 7000, days: 4, seed: 5 });
    const nowMs = T0 + 20.25 * DAY_MS;
    const result = detectCandidateManeuvers([...burnEarly, ...short, ...burnLate].reverse(), { nowMs });
    assert.equal(result.version, 1);
    assert.deepEqual(result.satellites.map((s) => [s.noradId, s.status, s.candidateCount]), [
      [1, 'evaluated', 1],
      [2, 'stale', 0],
      [3, 'evaluated', 1],
    ]);
    assert.deepEqual(result.candidates.map((c) => [c.noradId, c.element]), [[1, 'inclination'], [3, 'semiMajorAxis']]);
  });
});
