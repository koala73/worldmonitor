import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHOKEPOINTS,
  CANONICAL_KEY,
  CHOKEPOINT_TTL_SECONDS,
  buildPayload,
  validateFn,
} from '../scripts/seed-chokepoint-baselines.mjs';

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
