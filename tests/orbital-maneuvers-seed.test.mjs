// The candidate-manoeuvre seeder (#9110) reads the R2 orbit-element history, fails the run on
// any R2 problem instead of publishing an empty list, counts only satellites it could judge,
// and ships dark with Orbital Watch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { HISTORY_SCHEMA } from '../scripts/_orbital-history.mjs';
import { semiMajorAxisKm } from '../scripts/_orbital-maneuvers.mjs';
import {
  buildManeuverPayload,
  buildSeedOptions,
  makeFetchManeuvers,
  maneuversEnabled,
  ORBITAL_MANEUVERS_ACTIVATION_KEY,
  ORBITAL_MANEUVERS_KEY,
} from '../scripts/seed-orbital-maneuvers.mjs';

const DAY_MS = 86_400_000;
const MU = 398_600.4418;
const T0 = Date.parse('2026-10-20T06:00:00Z');
const NOW = T0 + 20.25 * DAY_MS;
const meanMotionFor = (aKm) => (Math.sqrt(MU / aKm ** 3) * 86_400) / (2 * Math.PI);

/** A quiet satellite with a fixed node, and one that raises its orbit by 1.5 km on day 15. */
function historyWithBurn() {
  const entries = [];
  for (let day = 0; day <= 20; day++) {
    const wobble = ((day * 7919) % 11) / 1000 - 0.005;
    entries.push({ noradId: 1, epoch: T0 + day * DAY_MS, meanMotion: meanMotionFor(7000 + wobble), eccentricity: 0.001, inclination: 0.04, raan: 0, bstar: 0 });
    entries.push({ noradId: 2, epoch: T0 + day * DAY_MS, meanMotion: meanMotionFor(6793 + wobble + (day >= 15 ? 1.5 : 0)), eccentricity: 0.0005, inclination: 0.04, raan: 0, bstar: 0 });
  }
  return { schema: HISTORY_SCHEMA, windowDays: 30, updatedAt: NOW - 3_600_000, entries };
}

describe('buildManeuverPayload', () => {
  it('lists the candidate with both element sets, the threshold and the method used', () => {
    const payload = buildManeuverPayload(historyWithBurn(), NOW);
    assert.equal(payload.schema, 1);
    assert.equal(payload.evaluatedSatellites, 2);
    assert.equal(payload.history.entries, 42);
    assert.equal(payload.candidates.length, 1);
    const [candidate] = payload.candidates;
    assert.equal(candidate.kind, 'candidate');
    assert.equal(candidate.noradId, 2);
    assert.equal(candidate.element, 'semiMajorAxis');
    assert.ok(candidate.after.semiMajorAxisKm - candidate.before.semiMajorAxisKm > 1.4);
    assert.ok(candidate.threshold > 0);
    assert.equal(payload.method.floors.leo.semiMajorAxis, 0.2);
    assert.match(payload.method.drag, /not flagged/);
    assert.ok(Math.abs(semiMajorAxisKm(candidate.after.meanMotion) - candidate.after.semiMajorAxisKm) < 0.01);
  });

  it('evaluates nothing when there is no history yet', () => {
    const payload = buildManeuverPayload(null, NOW);
    assert.equal(payload.evaluatedSatellites, 0);
    assert.deepEqual(payload.candidates, []);
  });

  it('refuses a history of an unknown shape', () => {
    assert.throws(() => buildManeuverPayload({ schema: 9, entries: [] }, NOW), /unreadable shape/);
  });
});

describe('makeFetchManeuvers', () => {
  it('fails the run without R2 config or when R2 fails, so nothing is published', async () => {
    await assert.rejects(makeFetchManeuvers({ storageConfig: null })(), /R2 storage is not configured/);
    const failing = makeFetchManeuvers({ storageConfig: { mode: 'api' }, readHistory: async () => { throw new Error('R2 get failed: HTTP 503'); } });
    await assert.rejects(failing(), /HTTP 503/);
  });

  it('reads the history from the configured store', async () => {
    let seen = null;
    const fetch = makeFetchManeuvers({ storageConfig: { mode: 'api' }, readHistory: async (config) => { seen = config; return historyWithBurn(); }, now: () => NOW });
    const payload = await fetch();
    assert.deepEqual(seen, { mode: 'api' });
    assert.equal(payload.candidates.length, 1);
  });
});

describe('seed options and registration', () => {
  it('counts evaluated satellites, so an unjudgeable history is never an empty all-clear', () => {
    const options = buildSeedOptions();
    const empty = buildManeuverPayload(null, NOW);
    assert.equal(options.validateFn(empty), true);
    assert.equal(options.declareRecords(empty), 0);
    assert.equal(options.declareRecords(buildManeuverPayload(historyWithBurn(), NOW)), 2);
    assert.equal(options.zeroIsValid, undefined);
  });

  it('ships dark until ORBITAL_WATCH_ENABLED=true', () => {
    assert.equal(maneuversEnabled({}), false);
    assert.equal(maneuversEnabled({ ORBITAL_WATCH_ENABLED: 'false' }), false);
    assert.equal(maneuversEnabled({ ORBITAL_WATCH_ENABLED: ' TRUE ' }), true);
  });

  it('is registered in health, the climate bundle and the Railway watch paths', () => {
    const health = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
    assert.match(health, new RegExp(`orbitalManeuvers: '${ORBITAL_MANEUVERS_KEY}'`));
    assert.match(health, /orbitalManeuvers: \{ key: 'seed-meta:orbital:maneuvers', maxStaleMin: 1440/);
    assert.ok(health.includes(`activationKey: '${ORBITAL_MANEUVERS_ACTIVATION_KEY}'`));
    assert.match(health, /ORBITAL_WATCH_ENABLED \? \[\] : \[[^\]]*'orbitalManeuvers'[^\]]*\]/);
    const bundle = readFileSync(new URL('../scripts/seed-bundle-climate.mjs', import.meta.url), 'utf8');
    assert.ok(bundle.indexOf("'seed-orbital-catalog.mjs'") < bundle.indexOf("'seed-orbital-maneuvers.mjs'"), 'runs after the catalog that feeds its history');
    const railway = readFileSync(new URL('../scripts/railway-services.json', import.meta.url), 'utf8');
    for (const file of ['seed-orbital-maneuvers.mjs', '_orbital-maneuvers.mjs', '_orbital-history.mjs', '_r2-storage.mjs']) {
      assert.ok(railway.includes(`"scripts/${file}"`), `${file} is in the climate service watch paths`);
    }
  });
});
