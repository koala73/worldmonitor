import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHOKEPOINTS,
  CANONICAL_KEY,
  CHOKEPOINT_TTL_SECONDS,
  buildPayload,
  validateFn,
} from '../scripts/seed-chokepoint-baselines.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, 'fixtures/chokepoint-baselines-sample.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));

describe('buildPayload', () => {
  it('returns all 7 chokepoints', () => {
    const payload = buildPayload();
    assert.equal(payload.chokepoints.length, 7);
  });

  it('includes required top-level fields', () => {
    const payload = buildPayload();
    assert.ok(payload.source);
    assert.equal(payload.referenceYear, 2023);
    assert.ok(typeof payload.updatedAt === 'string');
    assert.ok(Array.isArray(payload.chokepoints));
  });

  it('each chokepoint has id, name, mbd, lat, lon fields', () => {
    const payload = buildPayload();
    for (const cp of payload.chokepoints) {
      assert.ok('id' in cp, `Missing id: ${JSON.stringify(cp)}`);
      assert.ok('name' in cp, `Missing name: ${JSON.stringify(cp)}`);
      assert.ok('mbd' in cp, `Missing mbd: ${JSON.stringify(cp)}`);
      assert.ok('lat' in cp, `Missing lat: ${JSON.stringify(cp)}`);
      assert.ok('lon' in cp, `Missing lon: ${JSON.stringify(cp)}`);
    }
  });

  it('all mbd values are positive numbers', () => {
    const payload = buildPayload();
    for (const cp of payload.chokepoints) {
      assert.equal(typeof cp.mbd, 'number', `mbd not a number for ${cp.id}`);
      assert.ok(cp.mbd > 0, `mbd not positive for ${cp.id}`);
    }
  });

  it('Hormuz has the highest mbd (21.0)', () => {
    const payload = buildPayload();
    const hormuz = payload.chokepoints.find(cp => cp.id === 'hormuz');
    assert.ok(hormuz, 'Hormuz entry missing');
    assert.equal(hormuz.mbd, 21.0);
    const maxMbd = Math.max(...payload.chokepoints.map(cp => cp.mbd));
    assert.equal(hormuz.mbd, maxMbd);
  });

  it('Panama has the lowest mbd (0.9)', () => {
    const payload = buildPayload();
    const panama = payload.chokepoints.find(cp => cp.id === 'panama');
    assert.ok(panama, 'Panama entry missing');
    assert.equal(panama.mbd, 0.9);
    const minMbd = Math.min(...payload.chokepoints.map(cp => cp.mbd));
    assert.equal(panama.mbd, minMbd);
  });
});

describe('CANONICAL_KEY', () => {
  it('is energy:chokepoint-baselines:v1', () => {
    assert.equal(CANONICAL_KEY, 'energy:chokepoint-baselines:v1');
  });
});

describe('CHOKEPOINT_TTL_SECONDS', () => {
  it('is at least 1 year in seconds', () => {
    const oneYearSeconds = 365 * 24 * 3600;
    assert.ok(CHOKEPOINT_TTL_SECONDS >= oneYearSeconds, `TTL ${CHOKEPOINT_TTL_SECONDS} < 1 year`);
  });
});

describe('CHOKEPOINTS', () => {
  it('exports 7 chokepoint entries', () => {
    assert.equal(CHOKEPOINTS.length, 7);
  });
});

describe('validateFn', () => {
  it('returns false for null', () => {
    assert.equal(validateFn(null), false);
  });

  it('returns false for empty object', () => {
    assert.equal(validateFn({}), false);
  });

  it('returns false when chokepoints array is empty', () => {
    assert.equal(validateFn({ chokepoints: [] }), false);
  });

  it('returns false when chokepoints has fewer than 7 entries', () => {
    assert.equal(validateFn({ chokepoints: [1, 2, 3] }), false);
  });

  it('returns true for correct shape with 7 chokepoints', () => {
    const payload = buildPayload();
    assert.equal(validateFn(payload), true);
  });
});

// Fixture-parity guard (plan §L #8 / V5-7 golden fixtures). The fixture at
// tests/fixtures/chokepoint-baselines-sample.json snapshots the expected
// buildPayload output shape (excluding the volatile updatedAt). Any change
// to CHOKEPOINTS that drifts from the fixture is now a deliberate action
// requiring a fixture update — not a silent schema shift.
describe('fixture parity (tests/fixtures/chokepoint-baselines-sample.json)', () => {
  it('fixture has the same top-level shape (source, referenceYear, chokepoints[])', () => {
    const payload = buildPayload();
    assert.equal(fixture.source, payload.source);
    assert.equal(fixture.referenceYear, payload.referenceYear);
    assert.ok(Array.isArray(fixture.chokepoints));
    assert.equal(fixture.chokepoints.length, payload.chokepoints.length);
  });

  it('fixture chokepoints match buildPayload().chokepoints on every contracted field', () => {
    // Validate against the seeded PAYLOAD (the actual wire-level contract
    // the cron writes to Redis), not against the raw CHOKEPOINTS constant.
    // This matters because buildPayload could transform entries in a
    // future refactor (coercion, ordering, normalization) — we want the
    // fixture to track the emitted shape, not the internal source array.
    //
    // Validates every field the fixture carries: id, relayId, name, mbd,
    // lat, lon. Previously only id/relayId/mbd were checked, leaving
    // lat/lon/name drifts invisible despite being in the fixture.
    const payload = buildPayload();
    for (let i = 0; i < payload.chokepoints.length; i++) {
      const seed = payload.chokepoints[i];
      const fix = fixture.chokepoints[i];
      assert.equal(fix.id,       seed.id,       `position ${i}: id drift (seed=${seed.id} fixture=${fix.id})`);
      assert.equal(fix.relayId,  seed.relayId,  `${seed.id}: relayId drift`);
      assert.equal(fix.name,     seed.name,     `${seed.id}: name drift (seed="${seed.name}" fixture="${fix.name}")`);
      assert.equal(fix.mbd,      seed.mbd,      `${seed.id}: mbd drift (seed=${seed.mbd} fixture=${fix.mbd})`);
      assert.equal(fix.lat,      seed.lat,      `${seed.id}: lat drift (seed=${seed.lat} fixture=${fix.lat})`);
      assert.equal(fix.lon,      seed.lon,      `${seed.id}: lon drift (seed=${seed.lon} fixture=${fix.lon})`);
    }
  });

  it('fixture entry key set matches buildPayload entry key set exactly', () => {
    // Catches the case where a future buildPayload adds a new field
    // (e.g. mbd_source, last_reviewed) without updating the fixture —
    // or vice versa. Keeps schema evolution deliberate and reviewed.
    const payload = buildPayload();
    const seedKeys  = Object.keys(payload.chokepoints[0]).sort();
    const fixKeys   = Object.keys(fixture.chokepoints[0]).sort();
    assert.deepEqual(fixKeys, seedKeys,
      `entry key set drift — seed keys: [${seedKeys.join(', ')}], fixture keys: [${fixKeys.join(', ')}]`);
  });

  it('fixture carries a non-empty updatedAt placeholder (format only, not value)', () => {
    assert.ok(typeof fixture.updatedAt === 'string');
    assert.ok(Number.isFinite(Date.parse(fixture.updatedAt)),
      `fixture updatedAt must be ISO-parseable, got "${fixture.updatedAt}"`);
  });
});
