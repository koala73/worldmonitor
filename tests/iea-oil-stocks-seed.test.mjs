import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTRY_MAP,
  IEA_90_DAY_OBLIGATION,
  parseRecord,
  buildIndex,
  CANONICAL_KEY,
} from '../scripts/seed-iea-oil-stocks.mjs';

const FIXED_TS = '2026-04-05T08:00:00.000Z';

describe('CANONICAL_KEY', () => {
  it('is energy:iea-oil-stocks:v1:index', () => {
    assert.equal(CANONICAL_KEY, 'energy:iea-oil-stocks:v1:index');
  });
});

describe('COUNTRY_MAP', () => {
  it('has exactly 32 entries', () => {
    assert.equal(Object.keys(COUNTRY_MAP).length, 32);
  });

  it('maps ASCII Turkiye (IEA live payload spelling) to TR', () => {
    assert.equal(COUNTRY_MAP['Turkiye'], 'TR');
    assert.equal(COUNTRY_MAP['Türkiye'], undefined);
  });
});

describe('parseRecord', () => {
  it('parses a normal country record correctly', () => {
    const record = {
      countryName: 'Germany',
      total: '130',
      industry: '130',
      publicData: '0',
      abroadIndustry: '0',
      abroadPublic: '0',
      yearMonth: 202511,
    };
    const result = parseRecord(record, FIXED_TS);
    assert.ok(result !== null);
    assert.equal(result.iso2, 'DE');
    assert.equal(result.dataMonth, '2025-11');
    assert.equal(result.daysOfCover, 130);
    assert.equal(result.netExporter, false);
    assert.equal(result.industryDays, 130);
    assert.equal(result.publicDays, 0);
    assert.equal(result.abroadDays, 0);
    assert.equal(result.belowObligation, false);
    assert.equal(result.obligationThreshold, IEA_90_DAY_OBLIGATION);
    assert.equal(result.seededAt, FIXED_TS);
  });

  it('parses net exporter record correctly', () => {
    const record = {
      countryName: 'Norway',
      total: 'Net Exporter',
      industry: '0',
      publicData: '0',
      abroadIndustry: '0',
      abroadPublic: '0',
      yearMonth: 202511,
    };
    const result = parseRecord(record, FIXED_TS);
    assert.ok(result !== null);
    assert.equal(result.iso2, 'NO');
    assert.equal(result.daysOfCover, null);
    assert.equal(result.netExporter, true);
    assert.equal(result.belowObligation, false);
  });

  it('sets anomaly true and daysOfCover null when total > 500', () => {
    const record = {
      countryName: 'Estonia',
      total: '11111',
      industry: '11111',
      publicData: '0',
      abroadIndustry: '0',
      abroadPublic: '0',
      yearMonth: 202511,
    };
    const result = parseRecord(record, FIXED_TS);
    assert.ok(result !== null);
    assert.equal(result.iso2, 'EE');
    assert.equal(result.daysOfCover, null);
    assert.equal(result.anomaly, true);
    assert.equal(result.netExporter, false);
    assert.equal(result.belowObligation, false);
  });

  it('sets belowObligation true when daysOfCover < 90', () => {
    const record = {
      countryName: 'Greece',
      total: '75',
      industry: '75',
      publicData: '0',
      abroadIndustry: '0',
      abroadPublic: '0',
      yearMonth: 202511,
    };
    const result = parseRecord(record, FIXED_TS);
    assert.ok(result !== null);
    assert.equal(result.belowObligation, true);
    assert.equal(result.daysOfCover, 75);
  });

  it('sets belowObligation false when daysOfCover >= 90', () => {
    const record = {
      countryName: 'France',
      total: '90',
      industry: '90',
      publicData: '0',
      abroadIndustry: '0',
      abroadPublic: '0',
      yearMonth: 202511,
    };
    const result = parseRecord(record, FIXED_TS);
    assert.ok(result !== null);
    assert.equal(result.belowObligation, false);
    assert.equal(result.daysOfCover, 90);
  });

  it('returns null for unknown country name', () => {
    const record = {
      countryName: 'Atlantis',
      total: '100',
      industry: '100',
      publicData: '0',
      abroadIndustry: '0',
      abroadPublic: '0',
      yearMonth: 202511,
    };
    assert.equal(parseRecord(record, FIXED_TS), null);
  });
});

describe('buildIndex', () => {
  it('aggregates members array correctly', () => {
    const members = [
      { iso2: 'DE', daysOfCover: 130, netExporter: false, belowObligation: false, industryDays: 130, publicDays: 0, abroadDays: 0, obligationThreshold: 90, seededAt: FIXED_TS, dataMonth: '2025-11' },
      { iso2: 'NO', daysOfCover: null, netExporter: true, belowObligation: false, industryDays: null, publicDays: null, abroadDays: null, obligationThreshold: 90, seededAt: FIXED_TS, dataMonth: '2025-11' },
      { iso2: 'GR', daysOfCover: 75, netExporter: false, belowObligation: true, industryDays: 75, publicDays: 0, abroadDays: 0, obligationThreshold: 90, seededAt: FIXED_TS, dataMonth: '2025-11' },
    ];
    const index = buildIndex(members, '2025-11', FIXED_TS);

    assert.equal(index.dataMonth, '2025-11');
    assert.equal(index.updatedAt, FIXED_TS);
    assert.equal(index.members.length, 3);

    const de = index.members.find(m => m.iso2 === 'DE');
    assert.ok(de);
    assert.equal(de.daysOfCover, 130);
    assert.equal(de.netExporter, false);
    assert.equal(de.belowObligation, false);

    const no = index.members.find(m => m.iso2 === 'NO');
    assert.ok(no);
    assert.equal(no.daysOfCover, null);
    assert.equal(no.netExporter, true);

    const gr = index.members.find(m => m.iso2 === 'GR');
    assert.ok(gr);
    assert.equal(gr.belowObligation, true);
  });

  it('index members only have iso2, daysOfCover, netExporter, belowObligation', () => {
    const members = [
      { iso2: 'US', daysOfCover: 200, netExporter: false, belowObligation: false, industryDays: 200, publicDays: 0, abroadDays: 0, seededAt: FIXED_TS, dataMonth: '2025-11' },
    ];
    const index = buildIndex(members, '2025-11', FIXED_TS);
    const keys = Object.keys(index.members[0]);
    assert.deepEqual(keys.sort(), ['belowObligation', 'daysOfCover', 'iso2', 'netExporter'].sort());
  });
});
