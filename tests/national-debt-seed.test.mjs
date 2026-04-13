import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Import only the pure compute function (no Redis, no fetch side-effects)
import { computeEntries, weoYearWindow } from '../scripts/seed-national-debt.mjs';

const BASELINE_TS = Date.UTC(2024, 0, 1);

describe('computeEntries formula', () => {
  it('calculates debt_usd from IMF debt % and GDP billions', () => {
    const debtPct = { USA: { '2024': '120', '2023': '110' } };
    const gdp = { USA: { '2024': '28000' } }; // $28T in billions
    const deficit = { USA: { '2024': '-5' } };

    const entries = computeEntries(debtPct, gdp, deficit, null);
    assert.equal(entries.length, 1);
    const usa = entries[0];
    assert.equal(usa.iso3, 'USA');

    // debtUsd = (120/100) * 28000e9 = 33.6T
    assert.ok(Math.abs(usa.debtUsd - 33_600_000_000_000) < 1e6, `debtUsd=${usa.debtUsd}`);
    assert.ok(Math.abs(usa.gdpUsd - 28_000_000_000_000) < 1e6, `gdpUsd=${usa.gdpUsd}`);
    assert.ok(Math.abs(usa.debtToGdp - 120) < 0.001, `debtToGdp=${usa.debtToGdp}`);
  });

  it('calculates per_second_rate from deficit %', () => {
    const debtPct = { JPN: { '2024': '260' } };
    const gdp = { JPN: { '2024': '4000' } }; // $4T
    const deficit = { JPN: { '2024': '-4' } };

    const entries = computeEntries(debtPct, gdp, deficit, null);
    assert.equal(entries.length, 1);
    const jpn = entries[0];

    const expectedPerSec = (0.04 * 4000e9) / (365.25 * 86400);
    assert.ok(Math.abs(jpn.perSecondRate - expectedPerSec) < 1, `perSecondRate=${jpn.perSecondRate}`);
  });

  it('calculates annual_growth correctly', () => {
    const debtPct = { DEU: { '2024': '66', '2023': '60' } };
    const gdp = { DEU: { '2024': '4500' } };
    const deficit = {};

    const entries = computeEntries(debtPct, gdp, deficit, null);
    assert.equal(entries.length, 1);
    const deu = entries[0];

    // annualGrowth = (66-60)/60 * 100 = 10%
    assert.ok(Math.abs(deu.annualGrowth - 10) < 0.01, `annualGrowth=${deu.annualGrowth}`);
  });

  it('sets correct baseline_ts (2024-01-01 UTC)', () => {
    const debtPct = { GBR: { '2024': '100' } };
    const gdp = { GBR: { '2024': '3100' } };

    const entries = computeEntries(debtPct, gdp, {}, null);
    assert.equal(entries[0].baselineTs, BASELINE_TS);
  });
});

describe('source label derives year from SDMX response', () => {
  it('uses max year present when 2025 is returned', () => {
    const debtPct = { GBR: { '2024': '100', '2025': '102' } };
    const gdp = { GBR: { '2024': '3100' } };

    const entries = computeEntries(debtPct, gdp, {}, null);
    assert.equal(entries[0].source, 'IMF WEO 2025');
  });

  it('falls back to 2024 when only 2024 is present', () => {
    const debtPct = { FRA: { '2024': '110' } };
    const gdp = { FRA: { '2024': '2900' } };

    const entries = computeEntries(debtPct, gdp, {}, null);
    assert.equal(entries[0].source, 'IMF WEO 2024');
  });

  it('combines WEO year with Treasury label for USA override', () => {
    const debtPct = { USA: { '2024': '120', '2025': '124' } };
    const gdp = { USA: { '2024': '28000' } };
    const entries = computeEntries(debtPct, gdp, {}, { debtUsd: 36e12, date: '2025-01-01' });
    assert.equal(entries[0].source, 'IMF WEO 2025 + US Treasury FiscalData');
  });

  it('tracks future WEO vintages (2026) when SDMX returns them', () => {
    const debtPct = { DEU: { '2024': '66', '2026': '68' } };
    const gdp = { DEU: { '2024': '4500' } };
    const entries = computeEntries(debtPct, gdp, {}, null);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source, 'IMF WEO 2026');
  });
});

describe('aggregate filtering', () => {
  it('excludes regional aggregate codes', () => {
    const debtPct = {
      USA: { '2024': '120' },
      WEOWORLD: { '2024': '90' },
      EURO: { '2024': '85' },
      G20: { '2024': '100' },
      G7Q: { '2024': '100' }, // ends in Q
    };
    const gdp = {
      USA: { '2024': '28000' },
      WEOWORLD: { '2024': '100000' },
      EURO: { '2024': '15000' },
      G20: { '2024': '50000' },
      G7Q: { '2024': '30000' },
    };

    const entries = computeEntries(debtPct, gdp, {}, null);
    const codes = entries.map(e => e.iso3);
    assert.ok(codes.includes('USA'), 'USA should be included');
    assert.ok(!codes.includes('WEOWORLD'), 'WEOWORLD should be excluded');
    assert.ok(!codes.includes('EURO'), 'EURO should be excluded');
    assert.ok(!codes.includes('G20'), 'G20 should be excluded');
    assert.ok(!codes.includes('G7Q'), 'G7Q (ends in Q) should be excluded');
  });

  it('excludes territories (ABW, PRI, WBG)', () => {
    const debtPct = { ABW: { '2024': '50' }, PRI: { '2024': '50' }, WBG: { '2024': '50' }, BRA: { '2024': '90' } };
    const gdp = { ABW: { '2024': '3' }, PRI: { '2024': '100' }, WBG: { '2024': '10' }, BRA: { '2024': '2000' } };

    const entries = computeEntries(debtPct, gdp, {}, null);
    const codes = entries.map(e => e.iso3);
    assert.ok(!codes.includes('ABW'), 'ABW should be excluded');
    assert.ok(!codes.includes('PRI'), 'PRI should be excluded');
    assert.ok(!codes.includes('WBG'), 'WBG should be excluded');
    assert.ok(codes.includes('BRA'), 'BRA should be included');
  });

  it('excludes non-3-char codes', () => {
    const debtPct = { US: { '2024': '120' }, USAA: { '2024': '120' }, USA: { '2024': '120' } };
    const gdp = { US: { '2024': '28000' }, USAA: { '2024': '28000' }, USA: { '2024': '28000' } };

    const entries = computeEntries(debtPct, gdp, {}, null);
    const codes = entries.map(e => e.iso3);
    assert.ok(!codes.includes('US'), '2-char code excluded');
    assert.ok(!codes.includes('USAA'), '4-char code excluded');
    assert.ok(codes.includes('USA'), '3-char code included');
  });
});

describe('US Treasury override', () => {
  it('uses Treasury debtUsd for USA when provided', () => {
    const debtPct = { USA: { '2024': '120' } };
    const gdp = { USA: { '2024': '28000' } };
    const treasuryDebtUsd = 36_000_000_000_000; // $36T from Treasury

    const entries = computeEntries(debtPct, gdp, {}, { debtUsd: treasuryDebtUsd, date: '2024-12-31' });
    assert.equal(entries.length, 1);
    assert.ok(Math.abs(entries[0].debtUsd - treasuryDebtUsd) < 1e6, `debtUsd should be Treasury value`);
    assert.ok(entries[0].source.includes('Treasury'), 'source should mention Treasury');
  });

  it('falls back to IMF when Treasury returns null', () => {
    const debtPct = { USA: { '2024': '120' } };
    const gdp = { USA: { '2024': '28000' } };

    const entries = computeEntries(debtPct, gdp, {}, null);
    const expectedDebt = (120 / 100) * 28000e9;
    assert.ok(Math.abs(entries[0].debtUsd - expectedDebt) < 1e6, 'fallback to IMF formula');
    assert.ok(!entries[0].source.includes('Treasury'), 'source should not mention Treasury');
  });
});

describe('country count with realistic fixture', () => {
  it('produces at least 150 entries from realistic IMF data', () => {
    // Simulate 188 IMF WEO country entries (3-char codes, not aggregates)
    const SAMPLE_CODES = [
      'AFG','ALB','DZA','AGO','ARG','ARM','AUS','AUT','AZE','BHS',
      'BHR','BGD','BLR','BEL','BLZ','BEN','BTN','BOL','BIH','BWA',
      'BRA','BRN','BGR','BFA','BDI','CPV','KHM','CMR','CAN','CAF',
      'TCD','CHL','CHN','COL','COM','COD','COG','CRI','CIV','HRV',
      'CYP','CZE','DNK','DJI','DOM','ECU','EGY','SLV','GNQ','ERI',
      'EST','SWZ','ETH','FJI','FIN','FRA','GAB','GMB','GEO','DEU',
      'GHA','GRC','GTM','GIN','GNB','GUY','HTI','HND','HKG','HUN',
      'ISL','IND','IDN','IRN','IRQ','IRL','ISR','ITA','JAM','JPN',
      'JOR','KAZ','KEN','PRK','KOR','KWT','KGZ','LAO','LVA','LBN',
      'LSO','LBR','LBY','LTU','LUX','MAC','MDG','MWI','MYS','MDV',
      'MLI','MLT','MRT','MUS','MEX','MDA','MNG','MNE','MAR','MOZ',
      'MMR','NAM','NPL','NLD','NZL','NIC','NER','NGA','MKD','NOR',
      'OMN','PAK','PAN','PNG','PRY','PER','PHL','POL','PRT','QAT',
      'ROU','RUS','RWA','SAU','SEN','SRB','SLE','SGP','SVK','SVN',
      'SOM','ZAF','SSD','ESP','LKA','SDN','SUR','SWE','CHE','SYR',
      'TWN','TJK','TZA','THA','TLS','TGO','TTO','TUN','TUR','TKM',
      'UGA','UKR','ARE','GBR','USA','URY','UZB','VEN','VNM','YEM',
      'ZMB','ZWE',
    ];

    const debtPct = {};
    const gdp = {};
    for (const code of SAMPLE_CODES) {
      debtPct[code] = { '2024': '80' };
      gdp[code] = { '2024': '500' };
    }

    const entries = computeEntries(debtPct, gdp, {}, null);
    assert.ok(entries.length >= 150, `Expected >=150 entries, got ${entries.length}`);
  });
});

describe('rolling WEO year window', () => {
  it('includes current year and spans prev 2 and next 1', () => {
    const now = new Date(Date.UTC(2026, 5, 1));
    assert.deepEqual(weoYearWindow(now), ['2024', '2025', '2026', '2027']);
  });

  it('picks latest year per country, not hardcoded 2024', () => {
    // Simulates a 2026 WEO vintage landing with 2025+2026 debt data and no 2024
    const debtPct = { FRA: { '2025': '110', '2026': '112' } };
    const gdp = { FRA: { '2026': '3000' } };
    const entries = computeEntries(debtPct, gdp, {}, null);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source, 'IMF WEO 2026');
    assert.ok(Math.abs(entries[0].debtToGdp - 112) < 0.001);
    // baseline should track the vintage year, not be pinned to 2024
    assert.equal(entries[0].baselineTs, Date.UTC(2026, 0, 1));
  });
});
