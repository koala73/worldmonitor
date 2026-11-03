// Hormuz LNG supplier shares from UN Comtrade HS 271111 partner rows.
//
// The fixtures are the three all-reporter responses recorded on 2026-10-28
// (tests/fixtures/energy-shock/comtrade-lng-271111-*.json), trimmed to the
// reporters asserted here. Expected shares were computed independently from
// the raw responses before this module existed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HORMUZ_LNG_PARTNER_CODES,
  LNG_CMD_CODE,
  MAX_UNATTRIBUTED_SHARE,
  MIN_LNG_PRE_CRISIS_COUNTRIES,
  buildLngOriginShares,
  lngOriginRequests,
  parseLngRows,
} from '../scripts/shared/comtrade-lng-origin.mjs';
import { normalizeComtradePartner } from '../scripts/shared/comtrade.mjs';
import { ComtradeResponseError } from '../scripts/shared/comtrade-bilateral.mjs';

const fixture = (name) => JSON.parse(readFileSync(
  new URL(`./fixtures/energy-shock/comtrade-lng-271111-${name}-2026-10-28.json`, import.meta.url), 'utf8'));

const REPORTER_OVERRIDES = { 490: 'TW', 381: 'IT' };
const options = {
  reporterIso2: (code) => REPORTER_OVERRIDES[code] ?? normalizeComtradePartner(code).iso2,
  partnerKind: (code) => normalizeComtradePartner(code).kind,
};

const recorded = () => ({
  annual: parseLngRows(fixture('annual')),
  preCrisis: parseLngRows(fixture('pre-crisis')),
  current: parseLngRows(fixture('current')),
});

// Shares are stored to four decimals; the analysis script's one-decimal
// percentages are noted beside each expectation.

describe('lngOriginRequests', () => {
  it('asks for the pre-crisis calendar year and the year before, the 12 pre-crisis months, and crisis months since 2026-03', () => {
    const requests = lngOriginRequests(new Date('2026-10-28T08:00:00Z'));
    assert.deepEqual(requests, [
      { id: 'annual', frequency: 'A', periods: ['2025', '2024'] },
      {
        id: 'preCrisis', frequency: 'M',
        periods: ['202502', '202503', '202504', '202505', '202506', '202507', '202508', '202509', '202510', '202511', '202512', '202601'],
      },
      { id: 'current', frequency: 'M', periods: ['202603', '202604', '202605', '202606', '202607', '202608', '202609'] },
    ]);
  });

  it('caps the current request at the 12 latest complete months', () => {
    const current = lngOriginRequests(new Date('2027-08-02T00:00:00Z')).find((r) => r.id === 'current');
    assert.equal(current.periods.length, 12);
    assert.equal(current.periods[0], '202608');
    assert.equal(current.periods.at(-1), '202707');
  });

  it('skips the current request before the first full crisis month has closed', () => {
    const ids = lngOriginRequests(new Date('2026-03-15T00:00:00Z')).map((r) => r.id);
    assert.deepEqual(ids, ['annual', 'preCrisis']);
  });

  it('sets a snapshot floor well below the 114 pre-crisis shares observed on 2026-10-28', () => {
    assert.ok(MIN_LNG_PRE_CRISIS_COUNTRIES >= 20 && MIN_LNG_PRE_CRISIS_COUNTRIES <= 60);
  });

  it('counts Qatar and the UAE as Hormuz loadings and leaves Oman out', () => {
    assert.equal(LNG_CMD_CODE, '271111');
    assert.deepEqual([...HORMUZ_LNG_PARTNER_CODES].sort(), ['634', '784']);
    assert.ok(!HORMUZ_LNG_PARTNER_CODES.includes('512'), "Oman's Qalhat terminal is outside the Strait");
  });
});

describe('parseLngRows', () => {
  it('keeps the aggregate LNG rows of a recorded response', () => {
    const rows = parseLngRows(fixture('annual'));
    assert.ok(rows.length > 300);
    assert.ok(rows.every((r) => r.cmdCode === undefined || r.cmdCode === LNG_CMD_CODE));
    const jpWorld2025 = rows.find((r) => r.reporterCode === '392' && r.partnerCode === '0' && r.period === '2025');
    assert.equal(Math.round(jpWorld2025.netWeightKg / 1e7) / 100, 64.98, 'Japan 2025 LNG imports, Mt');
  });

  it('rejects a body without a data array as malformed', () => {
    assert.throws(() => parseLngRows({ count: 1 }), (err) => err instanceof ComtradeResponseError && err.kind === 'malformed');
  });

  it('rejects a response that fills the record cap as incomplete', () => {
    const body = { data: [{ reporterCode: 392, partnerCode: 0, period: '2025', cmdCode: '271111', primaryValue: 1 }] };
    assert.throws(() => parseLngRows(body, 1), (err) => err instanceof ComtradeResponseError && err.kind === 'incomplete');
  });

  it('rejects a row for another heading or with a malformed period', () => {
    for (const bad of [{ cmdCode: '2711' }, { period: '20251' }, { primaryValue: null }, { partnerCode: 'QA' }]) {
      const row = { reporterCode: 392, partnerCode: 634, period: '2025', cmdCode: '271111', primaryValue: 10, ...bad };
      assert.throws(() => parseLngRows({ data: [row] }), (err) => err.kind === 'malformed', JSON.stringify(bad));
    }
  });
});

describe('buildLngOriginShares on the recorded 2026-10-28 responses', () => {
  const { countries } = buildLngOriginShares(recorded(), options);

  it('uses the 12 pre-crisis months by weight for monthly filers', () => {
    const jp = countries.JP;
    assert.deepEqual(
      { basis: jp.preCrisis.basis, fromMonth: jp.preCrisis.fromMonth, toMonth: jp.preCrisis.toMonth, monthsCovered: jp.preCrisis.monthsCovered, measure: jp.preCrisis.measure },
      { basis: 'comtrade_monthly', fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12, measure: 'weight' },
    );
    assert.equal(jp.preCrisis.share, 0.064); // 6.4%
    assert.equal(countries.IN.preCrisis.share, 0.5824); // 58.2%
    assert.equal(countries.PK.preCrisis.share, 0.9924); // 99.2%
    assert.equal(countries.SG.preCrisis.share, 0.4829); // 48.3%
    assert.equal(countries.TH.preCrisis.share, 0.1981); // 19.8%
  });

  it('falls back to annual 2025 when the monthly window is incomplete or absent', () => {
    // Korea filed 11 of the 12 pre-crisis months; China files no monthly data.
    assert.deepEqual(
      [countries.KR.preCrisis.basis, countries.KR.preCrisis.fromMonth, countries.KR.preCrisis.toMonth, countries.KR.preCrisis.share],
      ['comtrade_annual', '2025-01', '2025-12', 0.1545], // 15.4%; Korea Customs reports the same 2025 split
    );
    assert.deepEqual(
      [countries.CN.preCrisis.basis, countries.CN.preCrisis.fromMonth, countries.CN.preCrisis.share],
      ['comtrade_annual', '2025-01', 0.2898], // 29.0%
    );
    assert.equal(countries.US.preCrisis.basis, 'comtrade_annual', 'the US filed 11 pre-crisis months');
  });

  it('falls back to annual 2024 for a reporter that has not filed 2025', () => {
    assert.deepEqual(
      [countries.TW.preCrisis.basis, countries.TW.preCrisis.fromMonth, countries.TW.preCrisis.toMonth, countries.TW.preCrisis.share],
      ['comtrade_annual', '2024-01', '2024-12', 0.2398], // 24.0%
    );
  });

  it('switches the whole window to value when any month lacks a usable weight', () => {
    // Spain 2025-04 and Italy 2025-10 / 2026-01 report value with no weight.
    assert.equal(countries.ES.preCrisis.basis, 'comtrade_monthly');
    assert.equal(countries.ES.preCrisis.measure, 'value');
    assert.equal(countries.IT.preCrisis.measure, 'value');
    assert.equal(countries.JP.preCrisis.measure, 'weight');
  });

  it('refuses a share when Comtrade withholds the partners', () => {
    // Germany reports all LNG imports under 899 "Areas, nes", Austria under
    // 839 "Special categories": the World total is real, the origin is not.
    for (const iso2 of ['DE', 'AT']) {
      assert.equal(countries[iso2].preCrisis, null, iso2);
      assert.equal(countries[iso2].preCrisisUnavailable, 'partners_unattributed', iso2);
      assert.equal(countries[iso2].current, null, iso2);
    }
    assert.ok(MAX_UNATTRIBUTED_SHARE > 0 && MAX_UNATTRIBUTED_SHARE < 0.5);
  });

  it('reports current flows as the latest three monthly observations since 2026-03', () => {
    assert.deepEqual(
      [countries.JP.current.fromMonth, countries.JP.current.toMonth, countries.JP.current.monthsCovered, countries.JP.current.share],
      ['2026-06', '2026-08', 3, 0.0044], // 0.4%
    );
    assert.deepEqual(
      [countries.IN.current.fromMonth, countries.IN.current.toMonth, countries.IN.current.share, countries.IN.current.measure],
      ['2026-05', '2026-07', 0.1612, 'weight'], // 16.1%
    );
    assert.deepEqual(
      [countries.SG.current.fromMonth, countries.SG.current.toMonth, countries.SG.current.monthsCovered],
      ['2026-03', '2026-03', 1],
    );
  });

  it('marks current flows unavailable for reporters with no monthly crisis rows', () => {
    for (const iso2 of ['KR', 'CN', 'TW']) {
      assert.equal(countries[iso2].current, null, iso2);
      assert.equal(countries[iso2].currentUnavailable, 'no_rows', iso2);
    }
  });

  it('keys countries by ISO2, including override-only reporter codes', () => {
    assert.ok(countries.TW, 'reporter 490 is Taiwan through the reporter overrides');
    assert.ok(countries.IT, 'reporter 380 is Italy');
    assert.equal(countries[''], undefined);
  });
});

describe('buildLngOriginShares edge cases', () => {
  const row = (reporterCode, partnerCode, period, value, weight) => ({ reporterCode, partnerCode, period, value, netWeightKg: weight });

  it('ignores a period whose partner rows exceed the World total', () => {
    const preCrisis = [];
    for (const period of ['202502', '202503', '202504', '202505', '202506', '202507', '202508', '202509', '202510', '202511', '202512', '202601']) {
      preCrisis.push(row('392', '0', period, 100, 100), row('392', '634', period, period === '202507' ? 200 : 10, 10), row('392', '36', period, 90, 90));
    }
    const annual = [row('392', '0', '2025', 1200, 1200), row('392', '634', '2025', 120, 120), row('392', '36', '2025', 1080, 1080)];
    const { countries } = buildLngOriginShares({ annual, preCrisis, current: [] }, options);
    assert.equal(countries.JP.preCrisis.basis, 'comtrade_annual', 'an inconsistent month leaves the monthly window incomplete');
  });

  it('keeps the larger of two duplicate partner rows instead of summing them', () => {
    const annual = [row('392', '0', '2025', 100, 100), row('392', '634', '2025', 10, 10), row('392', '634', '2025', 20, 20), row('392', '36', '2025', 80, 80)];
    const { countries } = buildLngOriginShares({ annual, preCrisis: [], current: [] }, options);
    assert.equal(countries.JP.preCrisis.share, 0.2);
  });

  it('counts World value missing from the partner rows as unattributed and withholds the share', () => {
    // Partner rows cover 60% of the World total: dividing by the full total
    // would understate the Hormuz share by up to 40 points.
    const annual = [row('392', '0', '2025', 100, 100), row('392', '634', '2025', 10, 10), row('392', '36', '2025', 50, 50)];
    const { countries } = buildLngOriginShares({ annual, preCrisis: [], current: [] }, options);
    assert.equal(countries.JP.preCrisis, null);
    assert.equal(countries.JP.preCrisisUnavailable, 'partners_unattributed');
  });

  it('keeps a share whose partner rows cover the World total within the threshold, and reports the gap', () => {
    const annual = [row('392', '0', '2025', 100, 100), row('392', '634', '2025', 10, 10), row('392', '36', '2025', 85, 85)];
    const { countries } = buildLngOriginShares({ annual, preCrisis: [], current: [] }, options);
    assert.equal(countries.JP.preCrisis.share, 0.1);
    assert.equal(countries.JP.preCrisis.measure, 'value', 'partner weights 95 of 100 fail the 2% weight check');
    assert.equal(countries.JP.preCrisis.unattributedShare, 0.05);
  });

  it('reports no_rows for a pre-crisis window with neither monthly nor annual data', () => {
    const current = ['202606', '202607', '202608'].flatMap((p) => [row('392', '0', p, 100, 100), row('392', '36', p, 100, 100)]);
    const { countries } = buildLngOriginShares({ annual: [], preCrisis: [], current }, options);
    assert.equal(countries.JP.preCrisis, null);
    assert.equal(countries.JP.preCrisisUnavailable, 'no_rows');
    assert.equal(countries.JP.current.share, 0);
  });
});
