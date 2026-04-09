import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecord, buildIndex, buildOilStocksAnalysis } from '../scripts/seed-iea-oil-stocks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/iea-stocks-sample.json'), 'utf-8'));
const FIXED_TS = '2026-04-05T08:00:00.000Z';

describe('IEA fixture matches upstream shape', () => {
  it('latest response has year and month', () => {
    assert.equal(typeof fixture.latest.year, 'number');
    assert.equal(typeof fixture.latest.month, 'number');
  });

  it('monthly is an array of records', () => {
    assert.ok(Array.isArray(fixture.monthly));
    assert.ok(fixture.monthly.length > 0);
  });

  it('each record has the fields the seeder reads', () => {
    const requiredFields = ['countryName', 'yearMonth', 'total', 'industry', 'publicData', 'abroadIndustry', 'abroadPublic'];
    for (const record of fixture.monthly) {
      for (const field of requiredFields) {
        assert.ok(field in record, `record for ${record.countryName} missing field: ${field}`);
      }
    }
  });
});

describe('IEA fixture parsed through seeder parseRecord', () => {
  const nonTotalRecords = fixture.monthly.filter(r => !r.countryName?.startsWith('Total'));
  const parsed = nonTotalRecords.map(r => parseRecord(r, FIXED_TS)).filter(Boolean);

  it('parses at least 5 valid members from the fixture', () => {
    assert.ok(parsed.length >= 5, `expected >= 5, got ${parsed.length}`);
  });

  it('Total records are skipped by having no COUNTRY_MAP entry', () => {
    const totalRecord = fixture.monthly.find(r => r.countryName === 'Total');
    assert.ok(totalRecord, 'fixture must include a Total row');
    assert.equal(parseRecord(totalRecord, FIXED_TS), null);
  });

  it('Germany parsed with correct daysOfCover and breakdown', () => {
    const de = parsed.find(m => m.iso2 === 'DE');
    assert.ok(de);
    assert.equal(de.daysOfCover, 130);
    assert.equal(de.netExporter, false);
    assert.equal(de.industryDays, 110);
    assert.equal(de.publicDays, 20);
    assert.equal(de.abroadDays, 5);
  });

  it('Norway parsed as net exporter', () => {
    const no = parsed.find(m => m.iso2 === 'NO');
    assert.ok(no);
    assert.equal(no.netExporter, true);
    assert.equal(no.daysOfCover, null);
  });

  it('Greece parsed below obligation', () => {
    const gr = parsed.find(m => m.iso2 === 'GR');
    assert.ok(gr);
    assert.equal(gr.belowObligation, true);
    assert.equal(gr.daysOfCover, 75);
  });

  it('Estonia parsed as anomaly (total > 500)', () => {
    const ee = parsed.find(m => m.iso2 === 'EE');
    assert.ok(ee);
    assert.equal(ee.anomaly, true);
    assert.equal(ee.daysOfCover, null);
  });

  it('buildIndex produces valid shape from fixture', () => {
    const index = buildIndex(parsed, '2025-11', FIXED_TS);
    assert.equal(index.dataMonth, '2025-11');
    assert.ok(Array.isArray(index.members));
    assert.ok(index.members.length >= 5);
    for (const m of index.members) {
      assert.ok('iso2' in m);
      assert.ok('daysOfCover' in m);
      assert.ok('netExporter' in m);
      assert.ok('belowObligation' in m);
    }
  });

  it('buildOilStocksAnalysis produces valid shape from fixture', () => {
    const analysis = buildOilStocksAnalysis(parsed, '2025-11', FIXED_TS);
    assert.ok(Array.isArray(analysis.ieaMembers));
    assert.ok(analysis.ieaMembers.length > 0);
    assert.ok(analysis.regionalSummary);
    assert.ok(analysis.regionalSummary.europe);
    assert.ok(analysis.regionalSummary.asiaPacific);
    assert.ok(analysis.regionalSummary.northAmerica);
    assert.ok(Array.isArray(analysis.belowObligation));
    assert.ok(analysis.belowObligation.includes('GR'));
  });
});
