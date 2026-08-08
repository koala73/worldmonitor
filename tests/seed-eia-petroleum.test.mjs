import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_KEY,
  SERIES,
  parseSeries,
  countSeries,
  validatePetroleum,
  declareRecords,
} from '../scripts/seed-eia-petroleum.mjs';

describe('seed-eia-petroleum constants', () => {
  it('CANONICAL_KEY is versioned under energy:', () => {
    assert.equal(CANONICAL_KEY, 'energy:eia-petroleum:v1');
  });

  it('SERIES maps the four expected indicators to EIA series ids', () => {
    assert.deepEqual(Object.keys(SERIES).sort(), ['brent', 'inventory', 'production', 'wti']);
    assert.equal(SERIES.wti, 'PET.RWTC.W');
    assert.equal(SERIES.brent, 'PET.RBRTE.W');
    assert.equal(SERIES.production, 'PET.WCRFPUS2.W');
    assert.equal(SERIES.inventory, 'PET.WCESTUS1.W');
  });
});

describe('parseSeries', () => {
  const shape = (values) => ({ response: { data: values } });

  it('returns current/previous/date/unit from a 2-row response', () => {
    const parsed = parseSeries(shape([
      { value: '76.23', period: '2026-04-11', unit: 'dollars per barrel' },
      { value: '75.10', period: '2026-04-04', unit: 'dollars per barrel' },
    ]));
    assert.deepEqual(parsed, {
      current: 76.23,
      previous: 75.10,
      date: '2026-04-11',
      unit: 'dollars per barrel',
    });
  });

  it('falls back to null previous when only one value is returned', () => {
    const parsed = parseSeries(shape([
      { value: '76.23', period: '2026-04-11', unit: 'dollars per barrel' },
    ]));
    assert.equal(parsed?.current, 76.23);
    assert.equal(parsed?.previous, null);
  });

  it('coerces numeric values expressed as strings', () => {
    const parsed = parseSeries(shape([{ value: '13100', period: '2026-04-11', unit: 'MBBL' }]));
    assert.equal(parsed?.current, 13100);
    assert.equal(typeof parsed?.current, 'number');
  });

  it('returns null when response.data is missing', () => {
    assert.equal(parseSeries(undefined), null);
    assert.equal(parseSeries({}), null);
    assert.equal(parseSeries({ response: {} }), null);
  });

  it('returns null when response.data is empty', () => {
    assert.equal(parseSeries(shape([])), null);
  });

  it('returns null when the first value is non-numeric', () => {
    assert.equal(parseSeries(shape([{ value: 'N/A', period: '2026-04-11', unit: 'x' }])), null);
  });

  it('tolerates a non-numeric previous and returns null for it', () => {
    const parsed = parseSeries(shape([
      { value: '76.23', period: '2026-04-11', unit: 'u' },
      { value: 'withheld', period: '2026-04-04', unit: 'u' },
    ]));
    assert.equal(parsed?.current, 76.23);
    assert.equal(parsed?.previous, null);
  });
});

describe('countSeries + validatePetroleum + declareRecords', () => {
  const point = { current: 1, previous: 0, date: '2026-04-11', unit: 'u' };

  it('countSeries returns 0 for null/undefined/empty', () => {
    assert.equal(countSeries(null), 0);
    assert.equal(countSeries(undefined), 0);
    assert.equal(countSeries({}), 0);
  });

  it('countSeries counts only present series', () => {
    assert.equal(countSeries({ wti: point }), 1);
    assert.equal(countSeries({ wti: point, brent: point }), 2);
    assert.equal(countSeries({ wti: point, brent: point, production: point, inventory: point }), 4);
  });

  it('validatePetroleum accepts any non-empty aggregate (1-of-4 is OK)', () => {
    assert.equal(validatePetroleum({ wti: point }), true);
    assert.equal(validatePetroleum({ wti: point, brent: point, production: point, inventory: point }), true);
  });

  it('validatePetroleum rejects fully-empty aggregates', () => {
    assert.equal(validatePetroleum({}), false);
    assert.equal(validatePetroleum(null), false);
    assert.equal(validatePetroleum(undefined), false);
  });

  it('declareRecords returns the series count (drives contract-mode OK vs RETRY)', () => {
    assert.equal(declareRecords({}), 0);
    assert.equal(declareRecords({ wti: point }), 1);
    assert.equal(declareRecords({ wti: point, brent: point, production: point, inventory: point }), 4);
  });
});
