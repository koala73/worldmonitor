import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { imfSdmxFetchIndicator } from '../scripts/_seed-utils.mjs';

// Import only the pure compute function (no Redis, no fetch side-effects)
import { computeEntries, fetchTreasury, weoYearWindow } from '../scripts/seed-national-debt.mjs';
import { debtAt } from '../scripts/live-pages/national-debt.mjs';
import weoFiscalPeriods from '../scripts/shared/weo-fiscal-periods.mjs';

// WEO gross debt is an end-of-year stock, so 2024 data is anchored at the end of 2024.
const BASELINE_TS = Date.UTC(2025, 0, 1);

describe('computeEntries formula', () => {
  it('calculates debt_usd from IMF debt % and GDP dollars', () => {
    const debtPct = { USA: { '2024': '120', '2023': '110' } };
    const gdp = { USA: { '2024': 28_000_000_000_000 } }; // $28T
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
    const gdp = { JPN: { '2024': 4_000_000_000_000 } }; // $4T
    const deficit = { JPN: { '2024': '-4' } };

    const entries = computeEntries(debtPct, gdp, deficit, null);
    assert.equal(entries.length, 1);
    const jpn = entries[0];

    const expectedPerSec = (0.04 * 4000e9) / (365.25 * 86400);
    assert.ok(Math.abs(jpn.perSecondRate - expectedPerSec) < 1, `perSecondRate=${jpn.perSecondRate}`);
  });

  it('calculates annual_growth correctly', () => {
    const debtPct = { DEU: { '2024': '66', '2023': '60' } };
    const gdp = { DEU: { '2024': 4_500_000_000_000 } };
    const deficit = {};

    const entries = computeEntries(debtPct, gdp, deficit, null);
    assert.equal(entries.length, 1);
    const deu = entries[0];

    // annualGrowth = (66-60)/60 * 100 = 10%
    assert.ok(Math.abs(deu.annualGrowth - 10) < 0.01, `annualGrowth=${deu.annualGrowth}`);
  });

  it('sets correct baseline_ts (end of 2024 UTC)', () => {
    const debtPct = { GBR: { '2024': '100' } };
    const gdp = { GBR: { '2024': 3_100_000_000_000 } };

    const entries = computeEntries(debtPct, gdp, {}, null);
    assert.equal(entries[0].baselineTs, BASELINE_TS);
  });
});

describe('source label derives year from SDMX response', () => {
  it('uses max year present when 2025 is returned', () => {
    const debtPct = { GBR: { '2024': '100', '2025': '102' } };
    const gdp = { GBR: { '2024': 3_100_000_000_000, '2025': 3_200_000_000_000 } };

    const entries = computeEntries(debtPct, gdp, {}, null);
    assert.equal(entries[0].source, 'IMF WEO 2025');
  });

  it('falls back to 2024 when only 2024 is present', () => {
    const debtPct = { FRA: { '2024': '110' } };
    const gdp = { FRA: { '2024': 2_900_000_000_000 } };

    const entries = computeEntries(debtPct, gdp, {}, null);
    assert.equal(entries[0].source, 'IMF WEO 2024');
  });

  it('combines WEO year with Treasury label for USA override', () => {
    const debtPct = { USA: { '2024': '120', '2025': '124' } };
    const gdp = { USA: { '2024': 28_000_000_000_000, '2025': 29_000_000_000_000 } };
    const entries = computeEntries(debtPct, gdp, {}, { debtUsd: 36e12, date: '2025-01-01' });
    assert.equal(entries[0].source, 'IMF WEO 2025 + US Treasury FiscalData');
  });

  it('tracks future WEO vintages (2026) when SDMX returns them', () => {
    const debtPct = { DEU: { '2024': '66', '2026': '68' } };
    const gdp = { DEU: { '2024': 4_500_000_000_000, '2026': 4_800_000_000_000 } };
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
      USA: { '2024': 28_000_000_000_000 },
      WEOWORLD: { '2024': 100_000_000_000_000 },
      EURO: { '2024': 15_000_000_000_000 },
      G20: { '2024': 50_000_000_000_000 },
      G7Q: { '2024': 30_000_000_000_000 },
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
    const gdp = { ABW: { '2024': 3_000_000_000 }, PRI: { '2024': 100_000_000_000 }, WBG: { '2024': 10_000_000_000 }, BRA: { '2024': 2_000_000_000_000 } };

    const entries = computeEntries(debtPct, gdp, {}, null);
    const codes = entries.map(e => e.iso3);
    assert.ok(!codes.includes('ABW'), 'ABW should be excluded');
    assert.ok(!codes.includes('PRI'), 'PRI should be excluded');
    assert.ok(!codes.includes('WBG'), 'WBG should be excluded');
    assert.ok(codes.includes('BRA'), 'BRA should be included');
  });

  it('excludes non-3-char codes', () => {
    const debtPct = { US: { '2024': '120' }, USAA: { '2024': '120' }, USA: { '2024': '120' } };
    const gdp = { US: { '2024': 28_000_000_000_000 }, USAA: { '2024': 28_000_000_000_000 }, USA: { '2024': 28_000_000_000_000 } };

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
    const gdp = { USA: { '2024': 28_000_000_000_000 } };
    const treasuryDebtUsd = 36_000_000_000_000; // $36T from Treasury

    const entries = computeEntries(debtPct, gdp, {}, { debtUsd: treasuryDebtUsd, date: '2024-12-31' });
    assert.equal(entries.length, 1);
    assert.ok(Math.abs(entries[0].debtUsd - treasuryDebtUsd) < 1e6, `debtUsd should be Treasury value`);
    assert.ok(entries[0].source.includes('Treasury'), 'source should mention Treasury');
  });

  it('reads debt to the penny from the fiscal_service v2 endpoint (v1 returns 404)', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => {
      assert.match(String(url), /\/services\/api\/fiscal_service\/v2\/accounting\/od\/debt_to_penny\?/);
      return Response.json({ data: [{ record_date: '2026-10-15', tot_pub_debt_out_amt: '40388317675071.91' }] });
    });
    assert.deepEqual(await fetchTreasury(), { date: '2026-10-15', debtUsd: 40388317675071.91 });
  });

  it('falls back to IMF when Treasury returns null', () => {
    const debtPct = { USA: { '2024': '120' } };
    const gdp = { USA: { '2024': 28_000_000_000_000 } };

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
      gdp[code] = { '2024': 500_000_000_000 };
    }

    const entries = computeEntries(debtPct, gdp, {}, null);
    assert.ok(entries.length >= 150, `Expected >=150 entries, got ${entries.length}`);
  });
});

describe('current-year selection (IMF DataMapper parity)', () => {
  // WEO October 2026 rows as the SDMX fetch returns them for weoYearWindow().
  const NOW = new Date(Date.UTC(2026, 9, 19));
  const debtPct = {
    SDN: { '2025': 270, '2026': 334.410808, '2027': 274.123118 },
    BHR: { '2025': 150, '2026': 162.844629, '2027': 150.327256 },
    ITA: { '2025': 137.104554, '2026': 137.866401, '2027': 137.61663 },
    LBN: { '2025': 139.413732 },
    XFC: { '2027': 500 },
  };
  const gdp = {
    SDN: { '2026': 40e9, '2027': 50e9 },
    BHR: { '2026': 48e9, '2027': 52.5e9 },
    ITA: { '2026': 2.4e12, '2027': 2.5e12 },
    LBN: { '2025': 20e9 },
    XFC: { '2027': 1e9 },
  };
  const deficit = {
    BHR: { '2026': -6, '2027': -4 },
    LBN: { '2025': -2 },
  };
  const byIso = (entries) => Object.fromEntries(entries.map(e => [e.iso3, e]));

  it('uses the current year, not next year\'s forecast', () => {
    const e = byIso(computeEntries(debtPct, gdp, deficit, null, NOW));
    assert.equal(e.BHR.debtToGdp, 162.844629);
    assert.equal(e.SDN.debtToGdp, 334.410808);
    assert.equal(e.BHR.source, 'IMF WEO 2026');
    assert.equal(e.BHR.baselineTs, Date.UTC(2027, 0, 1));
  });

  it('pairs debt % with GDP and deficit from the same year', () => {
    const { BHR } = byIso(computeEntries(debtPct, gdp, deficit, null, NOW));
    assert.equal(BHR.gdpUsd, 48e9);
    assert.ok(Math.abs(BHR.debtUsd - 1.62844629 * 48e9) < 1);
    assert.ok(Math.abs(BHR.perDayRate - 0.06 * 48e9 / 365.25) < 1e-6);
  });

  it('measures annual growth from last year to the current year', () => {
    const { BHR } = byIso(computeEntries(debtPct, gdp, deficit, null, NOW));
    assert.ok(Math.abs(BHR.annualGrowth - ((162.844629 - 150) / 150) * 100) < 1e-9);
  });

  it('labels a country without current-year data with the year it has', () => {
    const { LBN } = byIso(computeEntries(debtPct, gdp, deficit, null, NOW));
    assert.equal(LBN.debtToGdp, 139.413732);
    assert.equal(LBN.source, 'IMF WEO 2025');
    assert.equal(LBN.baselineTs, Date.UTC(2026, 0, 1));
  });

  it('counts the data year\'s deficit once: the ticker reaches the year-end stock on Dec 31', () => {
    // GGXWDG_NGDP is debt at the END of the year, so it already contains that
    // year's deficit. The ticker must interpolate up to it, not add the deficit on top.
    const { BHR } = byIso(computeEntries(debtPct, gdp, deficit, null, NOW));
    const yearEndStock = 1.62844629 * 48e9;
    const yearDeficit = 0.06 * 48e9;
    assert.ok(Math.abs(debtAt(BHR, Date.UTC(2027, 0, 1)) - yearEndStock) < 1);
    // 365.25-day accrual year vs 365-day 2026: allow 0.1% of the deficit.
    assert.ok(Math.abs(debtAt(BHR, Date.UTC(2026, 0, 1)) - (yearEndStock - yearDeficit)) < yearDeficit * 1e-3);
    assert.ok(debtAt(BHR, NOW.getTime()) < yearEndStock);
  });

  it('does not accrue another year\'s deficit when the data year has none', () => {
    const entries = computeEntries(
      { GBR: { '2026': 102 } },
      { GBR: { '2026': 3.2e12 } },
      { GBR: { '2025': -4 } },
      null, NOW,
    );
    assert.equal(entries[0].perSecondRate, 0);
    assert.equal(entries[0].perDayRate, 0);
  });

  it('steps back to the latest year that has both debt % and GDP', () => {
    const entries = computeEntries(
      { GBR: { '2025': 100, '2026': 102 } },
      { GBR: { '2025': 3e12 } },
      { GBR: { '2025': -4, '2026': -5 } },
      null, NOW,
    );
    assert.equal(entries[0].debtToGdp, 100);
    assert.equal(entries[0].debtUsd, 3e12);
    assert.equal(entries[0].source, 'IMF WEO 2025');
    assert.ok(Math.abs(entries[0].perDayRate - 0.04 * 3e12 / 365.25) < 1e-6);
  });

  it('starts the US ticker at the Treasury record date when Treasury overrides debt', () => {
    const entries = computeEntries(
      { USA: { '2026': 125 } },
      { USA: { '2026': 31e12 } },
      { USA: { '2026': -6 } },
      { debtUsd: 38e12, date: '2026-10-16' },
      NOW,
    );
    assert.equal(entries[0].debtUsd, 38e12);
    assert.equal(entries[0].baselineTs, Date.UTC(2026, 9, 16));
  });

  it('drops countries that only have forecast years', () => {
    const e = byIso(computeEntries(debtPct, gdp, deficit, null, NOW));
    assert.equal(e.XFC, undefined);
  });

  it('ranks Bahrain 4th behind Sudan, Japan and Singapore', () => {
    const entries = computeEntries(
      { ...debtPct, JPN: { '2026': 199.369134, '2027': 196.365546 }, SGP: { '2026': 166.419895, '2027': 167.13876 } },
      { ...gdp, JPN: { '2026': 4e12 }, SGP: { '2026': 0.55e12 } },
      deficit, null, NOW,
    );
    const ranked = entries.slice().sort((a, b) => b.debtToGdp - a.debtToGdp).map(e => e.iso3);
    assert.deepEqual(ranked.slice(0, 4), ['SDN', 'JPN', 'SGP', 'BHR']);
  });
});

describe('WEO fiscal-period anchors', () => {
  const NOW = new Date('2026-10-19T00:00:00Z');
  function entryFor(iso3, year = 2026, treasury = null) {
    return computeEntries(
      { [iso3]: { [year - 1]: 75, [year]: 80 } },
      { [iso3]: { [year]: 1e12 } },
      { [iso3]: { [year]: -5 } },
      treasury, NOW,
    )[0];
  }

  it('reaches Egypt\'s WEO stock at the close of June in the labelled year', () => {
    const entry = entryFor('EGY');
    const periodEnd = Date.UTC(2026, 6, 1);
    assert.equal(entry.baselineTs, periodEnd);
    assert.equal(debtAt(entry, periodEnd), 800e9);
    assert.ok(debtAt(entry, periodEnd - 86400_000) < entry.debtUsd);
    assert.ok(debtAt(entry, periodEnd + 86400_000) > entry.debtUsd);
  });

  it('reaches India\'s WEO stock at the close of March in the following year', () => {
    const entry = entryFor('IND');
    const periodEnd = Date.UTC(2027, 3, 1);
    assert.equal(entry.baselineTs, periodEnd);
    assert.equal(debtAt(entry, periodEnd), 800e9);
    assert.ok(debtAt(entry, Date.UTC(2027, 0, 1)) < entry.debtUsd);
  });

  it('uses the selected data year for a country with no current-year observation', () => {
    const entry = entryFor('EGY', 2025);
    assert.equal(entry.baselineTs, Date.UTC(2025, 6, 1));
    assert.equal(entry.source, 'IMF WEO 2025');
  });

  it('keeps calendar-year and unmapped country anchors at the close of December', () => {
    for (const iso3 of ['DEU', 'USA', 'ZZZ']) {
      const entry = entryFor(iso3);
      assert.equal(entry.baselineTs, Date.UTC(2027, 0, 1), iso3);
      assert.equal(debtAt(entry, entry.baselineTs), entry.debtUsd);
    }
  });

  it('changes only the baseline, preserving the debt figures and rates', () => {
    const calendarEntry = entryFor('DEU');
    for (const iso3 of ['EGY', 'IND']) {
      const entry = entryFor(iso3);
      assert.notEqual(entry.baselineTs, calendarEntry.baselineTs);
      assert.deepEqual(
        { ...entry, iso3: calendarEntry.iso3, baselineTs: calendarEntry.baselineTs },
        calendarEntry,
      );
    }
  });

  it('keeps a valid Treasury record date ahead of the WEO period anchor', () => {
    const entry = entryFor('USA', 2026, { debtUsd: 900e9, date: '2026-10-16' });
    assert.equal(entry.baselineTs, Date.UTC(2026, 9, 16));
    assert.equal(debtAt(entry, entry.baselineTs), 900e9);
  });

  it('anchors every WEO Online Table F government-finance economy at its period end', () => {
    // [iso3, WEO 2026 period end (exclusive, midnight UTC after the last day)]
    const cases = [
      ['PAK', Date.UTC(2026, 6, 1)], // FY(t-1/t) = CY(t), July/June
      ['THA', Date.UTC(2026, 9, 1)], // Thai FY Y ends September of Y
      ['NPL', Date.UTC(2026, 6, 16)], // ends July 15
      ['BWA', Date.UTC(2027, 3, 1)], // FY(t/t+1) = CY(t), April/March
      ['HKG', Date.UTC(2027, 3, 1)],
      ['IRN', Date.UTC(2027, 2, 21)], // Iranian year ends March 20
      ['DMA', Date.UTC(2027, 6, 1)], // FY(t/t+1) = CY(t), July/June
      ['FJI', Date.UTC(2027, 7, 1)], // August/July
    ];
    for (const [iso3, periodEnd] of cases) {
      const entry = entryFor(iso3);
      assert.equal(entry.baselineTs, periodEnd, iso3);
      assert.equal(debtAt(entry, periodEnd), entry.debtUsd, iso3);
    }
  });

  describe('after a fiscal period closes', () => {
    // NOW is 2026-10-19: Bangladesh's FY2025/26 (WEO 2026) closed on June 30,
    // so the clock is running through FY2026/27 (WEO 2027).
    function bangladesh(deficit2027) {
      return computeEntries(
        { BGD: { 2025: 38, 2026: 40, 2027: 42 } },
        { BGD: { 2026: 500e9, 2027: 550e9 } },
        { BGD: { 2026: -5, 2027: deficit2027 } },
        null, NOW,
      )[0];
    }

    it('accrues at the next period\'s projected deficit and GDP', () => {
      const entry = bangladesh(-8);
      assert.equal(entry.baselineTs, Date.UTC(2026, 6, 1));
      assert.equal(entry.debtToGdp, 40, 'the closed period\'s stock still anchors the clock');
      assert.ok(Math.abs(entry.perDayRate - 0.08 * 550e9 / 365.25) < 1e-6);
    });

    it('stops ticking when the next period is projected in surplus', () => {
      const entry = bangladesh(1);
      assert.equal(entry.perSecondRate, 0);
      assert.equal(entry.perDayRate, 0);
    });

    it('keeps the closed period\'s rate when the next period has no deficit or GDP', () => {
      const entry = computeEntries(
        { BGD: { 2026: 40 } }, { BGD: { 2026: 500e9 } }, { BGD: { 2026: -5 } }, null, NOW,
      )[0];
      assert.ok(Math.abs(entry.perDayRate - 0.05 * 500e9 / 365.25) < 1e-6);
    });

    it('leaves periods still in progress on their own year\'s deficit', () => {
      for (const iso3 of ['IND', 'DEU']) { // India ends March 2027; calendar 2026 ends January 2027
        const entry = computeEntries(
          { [iso3]: { 2026: 80, 2027: 82 } },
          { [iso3]: { 2026: 1e12, 2027: 1.1e12 } },
          { [iso3]: { 2026: -5, 2027: -9 } },
          null, NOW,
        )[0];
        assert.ok(Math.abs(entry.perDayRate - 0.05 * 1e12 / 365.25) < 1e-6, iso3);
      }
    });
  });

  it('keeps Singapore on the calendar fallback: WEO blends its fiscal years into calendar years', () => {
    assert.equal(entryFor('SGP').baselineTs, Date.UTC(2027, 0, 1));
  });
});

describe('WEO fiscal-period table', () => {
  const table = weoFiscalPeriods;
  // WEO Oct 2026 Online Table F, government finance column. Puerto Rico is a
  // territory the seeder excludes; Singapore's WEO calendar years blend two
  // fiscal years (CY(t) = 0.25*FY(t-1/t) + 0.75*FY(t/t+1)), so no label fits.
  const TABLE_F = ['AFG', 'BHS', 'BGD', 'BRB', 'BTN', 'BWA', 'DMA', 'EGY', 'SWZ', 'ETH', 'FJI', 'HTI', 'HKG', 'IND',
    'IRN', 'JAM', 'LSO', 'MHL', 'MUS', 'FSM', 'MMR', 'NRU', 'NPL', 'PAK', 'PLW', 'PRI', 'WSM', 'SGP', 'LCA', 'THA', 'TON', 'TTO'];
  const EXCLUDED = new Set(['PRI', 'SGP']);

  it('covers every Table F economy except the documented exclusions', () => {
    assert.deepEqual(Object.keys(table.countries).sort(), TABLE_F.filter((c) => !EXCLUDED.has(c)).sort());
  });

  it('gives every row a real period end, a label convention, a name and an IMF citation', () => {
    for (const [iso3, row] of Object.entries(table.countries)) {
      assert.ok(Number.isInteger(row.endMonth) && row.endMonth >= 1 && row.endMonth <= 12, iso3);
      const daysInMonth = new Date(Date.UTC(2027, row.endMonth, 0)).getUTCDate();
      assert.ok(Number.isInteger(row.endDay) && row.endDay >= 1 && row.endDay <= daysInMonth, iso3);
      assert.ok(row.endMonth !== 12 || row.endDay !== 31, `${iso3} is calendar-year and belongs on the fallback`);
      assert.ok(['end', 'start'].includes(row.yearLabel), iso3);
      assert.ok(typeof row.name === 'string' && row.name.length > 1, iso3);
      assert.match(row.labelSourceUrl, /^https:\/\/(api|www)\.imf\.org\//, iso3);
      assert.ok(row.labelEvidence.length > 20, iso3);
    }
  });

  it('labels each row the way its quoted WEO mapping says', () => {
    for (const [iso3, row] of Object.entries(table.countries)) {
      const evidence = row.labelEvidence.replace(/\s+/g, '');
      if (/[FS]Y\(t-1\/t\)=CY\(t\)/.test(evidence)) assert.equal(row.yearLabel, 'end', iso3);
      else if (/[FS]Y\(t\/t\+1\)=CY\(t\)/.test(evidence)) assert.equal(row.yearLabel, 'start', iso3);
      else assert.ok(['HKG', 'THA'].includes(iso3), `${iso3} cites no WEO mapping and has no staff-report check`);
    }
  });

  it('ends each row in the month its quoted WEO reporting year ends', () => {
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    let checked = 0;
    for (const [iso3, row] of Object.entries(table.countries)) {
      const quoted = row.labelEvidence.match(/(?:reporting year|reports) ([A-Z][a-z]+)(?:\/| to )([A-Z][a-z]+)/);
      if (!quoted) continue;
      assert.equal(months[row.endMonth - 1], quoted[2], iso3);
      checked += 1;
    }
    assert.ok(checked >= 20, `only ${checked} rows quote their reporting months`);
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
    const gdp = { FRA: { '2026': 3_000_000_000_000 } };
    const entries = computeEntries(debtPct, gdp, {}, null);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source, 'IMF WEO 2026');
    assert.ok(Math.abs(entries[0].debtToGdp - 112) < 0.001);
    // baseline should track the data year's end, not be pinned to 2024
    assert.equal(entries[0].baselineTs, Date.UTC(2027, 0, 1));
  });
});


describe('IMF SDMX dollar contract', () => {
  it('preserves raw NGDPD dollars in GDP, debt, and deficit rates', async (t) => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/national-debt/imf-ngdpd.json', import.meta.url), 'utf8'));
    t.mock.method(globalThis, 'fetch', async (url) => {
      assert.match(String(url), /dataflow\/IMF\.RES\/WEO\/\+\/\*\.NGDPD\.A/);
      return Response.json(fixture);
    });
    const gdp = await imfSdmxFetchIndicator('NGDPD', { years: ['2027'] });
    assert.equal(gdp.CHN['2027'], 22_939_132_112_000);
    assert.equal(gdp.USA['2027'], 34_441_606_777_000);
    const entries = computeEntries(
      { CHN: { '2027': 100 }, USA: { '2027': 100 } },
      gdp,
      { CHN: { '2027': -5 }, USA: { '2027': -5 } },
      null,
      new Date(Date.UTC(2027, 5, 1)),
    );
    assert.deepEqual(entries.map(entry => entry.iso3).sort(), ['CHN', 'USA']);
    for (const entry of entries) {
      const expectedGdp = gdp[entry.iso3]['2027'];
      assert.equal(entry.gdpUsd, expectedGdp);
      assert.equal(entry.debtUsd, expectedGdp);
      assert.equal(entry.perDayRate, expectedGdp * 0.05 / 365.25);
      assert.equal(entry.perSecondRate, expectedGdp * 0.05 / (365.25 * 86400));
    }
  });
});
