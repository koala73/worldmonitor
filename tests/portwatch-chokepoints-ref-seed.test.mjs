import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const src = readFileSync(resolve(root, 'scripts/seed-portwatch-chokepoints-ref.mjs'), 'utf-8');

// ── seeder source assertions ──────────────────────────────────────────────────

describe('seed-portwatch-chokepoints-ref.mjs exports', () => {
  it('exports fetchAll', () => {
    assert.match(src, /export\s+async\s+function\s+fetchAll/);
  });

  it('exports validateFn', () => {
    assert.match(src, /export\s+function\s+validateFn/);
  });

  it('writes to portwatch:chokepoints:ref:v1', () => {
    assert.match(src, /portwatch:chokepoints:ref:v1/);
  });

  it('uses ArcGIS PortWatch_chokepoints_database endpoint', () => {
    assert.match(src, /PortWatch_chokepoints_database.*FeatureServer/);
  });

  it('has TTL of 604800 (7 days)', () => {
    assert.match(src, /604[_\s]*800|7\s*\*\s*24\s*\*\s*3600/);
  });

  it('fetches lat, lon fields', () => {
    assert.match(src, /'lat'/);
    assert.match(src, /'lon'/);
  });

  it('fetches vesselCountTanker (vessel_count_tanker)', () => {
    assert.match(src, /vessel_count_tanker/);
  });

  it('fetches share_country_maritime_import and share_country_maritime_export', () => {
    assert.match(src, /share_country_maritime_import/);
    assert.match(src, /share_country_maritime_export/);
  });

  it('fetches industry_top1, industry_top2, industry_top3', () => {
    assert.match(src, /industry_top1/);
    assert.match(src, /industry_top2/);
    assert.match(src, /industry_top3/);
  });

  it('wraps runSeed in isMain guard', () => {
    assert.match(src, /isMain.*=.*process\.argv/s);
    assert.match(src, /if\s*\(isMain\)/);
  });
});

describe('ArcGIS 429 proxy fallback', () => {
  it('imports resolveProxyForConnect and httpsProxyFetchRaw', () => {
    assert.match(src, /resolveProxyForConnect/);
    assert.match(src, /httpsProxyFetchRaw/);
  });

  it('fetchAll checks resp.status === 429', () => {
    assert.match(src, /resp\.status\s*===\s*429/);
  });

  it('calls resolveProxyForConnect() on 429', () => {
    assert.match(src, /resolveProxyForConnect\(\)/);
  });

  it('calls httpsProxyFetchRaw with proxy auth on 429', () => {
    assert.match(src, /httpsProxyFetchRaw\(.*proxyAuth/s);
  });

  it('throws if 429 and no proxy configured', () => {
    assert.match(src, /429.*rate limited/);
  });
});

// ── unit tests for chokepoint reference data building ─────────────────────────

function buildEntry(a) {
  const portId = String(a.portid);
  const industries = [a.industry_top1, a.industry_top2, a.industry_top3].filter(Boolean);
  return {
    portId,
    portName: String(a.portname || ''),
    fullName: String(a.fullname || ''),
    lat: Number(a.lat ?? 0),
    lon: Number(a.lon ?? 0),
    vesselCountTanker: Number(a.vessel_count_tanker ?? 0),
    shareMaritimeImport: Number(a.share_country_maritime_import ?? 0),
    shareMaritimeExport: Number(a.share_country_maritime_export ?? 0),
    industries,
  };
}

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

function validateFn(data) {
  return data != null && typeof data === 'object' && Object.keys(data).length === 28;
}

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
