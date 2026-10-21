import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildEntry, validateFn } from '../scripts/seed-portwatch-chokepoints-ref.mjs';

// The export, Redis-key and ArcGIS-proxy assertions that used to open this file
// restated the seeder's own declarations and call sites. buildEntry was also
// re-implemented here and tested as a copy; it is now exported from the seeder
// and imported, so these tests exercise the row adapter that actually runs.


describe('buildEntry unit tests', () => {
  const sampleAttr = {
    portid: 'chokepoint1',
    portname: 'Hormuz',
    fullname: 'Strait of Hormuz',
    lat: 26.56,
    lon: 56.25,
    vessel_count_tanker: 120,
    share_country_maritime_import: 0.17,
    share_country_maritime_export: 0.21,
    industry_top1: 'Oil & Gas',
    industry_top2: 'LNG',
    industry_top3: null,
  };

  it('builds entry with portId, lat, lon, vesselCountTanker', () => {
    const entry = buildEntry(sampleAttr);
    assert.equal(entry.portId, 'chokepoint1');
    assert.equal(entry.lat, 26.56);
    assert.equal(entry.lon, 56.25);
    assert.equal(entry.vesselCountTanker, 120);
  });

  it('builds industries array filtering out null values', () => {
    const entry = buildEntry(sampleAttr);
    assert.deepEqual(entry.industries, ['Oil & Gas', 'LNG']);
  });

  it('includes all three industries when none are null', () => {
    const entry = buildEntry({ ...sampleAttr, industry_top3: 'Chemicals' });
    assert.equal(entry.industries.length, 3);
    assert.deepEqual(entry.industries, ['Oil & Gas', 'LNG', 'Chemicals']);
  });

  it('returns empty industries array when all are null', () => {
    const entry = buildEntry({ ...sampleAttr, industry_top1: null, industry_top2: null, industry_top3: null });
    assert.deepEqual(entry.industries, []);
  });

  it('includes shareMaritimeImport and shareMaritimeExport', () => {
    const entry = buildEntry(sampleAttr);
    assert.equal(entry.shareMaritimeImport, 0.17);
    assert.equal(entry.shareMaritimeExport, 0.21);
  });

  it('defaults numeric fields to 0 when null', () => {
    const entry = buildEntry({
      ...sampleAttr,
      vessel_count_tanker: null,
      share_country_maritime_import: null,
      share_country_maritime_export: null,
    });
    assert.equal(entry.vesselCountTanker, 0);
    assert.equal(entry.shareMaritimeImport, 0);
    assert.equal(entry.shareMaritimeExport, 0);
  });
});

// ── validateFn unit tests ─────────────────────────────────────────────────────

describe('validateFn', () => {
  it('returns true only when data has exactly 28 chokepoints', () => {
    const data = Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`cp${i}`, {}]));
    assert.equal(validateFn(data), true);
  });

  it('returns false with 27 chokepoints (partial ArcGIS response)', () => {
    const data = Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`cp${i}`, {}]));
    assert.equal(validateFn(data), false);
  });

  it('returns false with 29 chokepoints (unexpected extra rows)', () => {
    const data = Object.fromEntries(Array.from({ length: 29 }, (_, i) => [`cp${i}`, {}]));
    assert.equal(validateFn(data), false);
  });

  it('returns false for null data', () => {
    assert.equal(validateFn(null), false);
  });

  it('returns false for undefined data', () => {
    assert.equal(validateFn(undefined), false);
  });

  it('returns false for empty object', () => {
    assert.equal(validateFn({}), false);
  });
});
