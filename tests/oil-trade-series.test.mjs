import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  lastCompleteMonth,
  monthRange,
  compareOilWindows,
  compactCountry,
  expandCountry,
} from '../shared/oil-trade-windows.js';
import {
  OIL_TRADE_COUNTRIES,
  buildEiaSeries,
  buildJodiSeries,
  buildMirrorSeries,
  buildAisSeries,
  mirrorRowsFromComtrade,
  fetchJodiRows,
  carryForwardFailedSources,
  trimMirrorReporters,
  assembleCountry,
  validate,
  CRUDE_ORIGIN_GULF_PARTNERS,
  crudeImportOriginPeriods,
  buildCrudeImportOrigin,
  crudeImportOriginSection,
  fetchCrudeImportOriginRows,
} from '../scripts/seed-oil-trade-series.mjs';
import { GULF_PARTNER_CODES } from '../server/worldmonitor/intelligence/v1/_shock-compute.ts';
import { PRE_CRISIS_WINDOW } from '../shared/hormuz-crisis.js';

const NOW = Date.parse('2026-10-18T12:00:00Z');

// EIA STEO PAPR_TC (UAE crude oil and liquid fuels supply, mb/d), pulled
// 2026-10-18. The 6-vs-6 below is the answer the original question needed.
const EIA_AE = {
  '2025-04': 4.1548, '2025-05': 4.2748, '2025-06': 4.2453, '2025-07': 4.4152, '2025-08': 4.455, '2025-09': 4.5252,
  '2025-10': 4.495, '2025-11': 4.56, '2025-12': 4.5053, '2026-01': 4.5398, '2026-02': 4.6001, '2026-03': 2.6366,
  '2026-04': 2.7363, '2026-05': 2.9561, '2026-06': 4.5166, '2026-07': 4.596563635, '2026-08': 4.366826444,
  '2026-09': 4.436965302, '2026-10': 4.576726735, '2026-11': 4.746854872,
};
const eiaRows = (series, values) => Object.entries(values)
  .map(([period, value]) => ({ seriesId: series, period, value: String(value), unit: 'million barrels per day' }));

describe('window arithmetic', () => {
  it('the last complete month is the month before the read month (UTC)', () => {
    assert.equal(lastCompleteMonth(NOW), '2026-09');
    assert.equal(lastCompleteMonth(Date.parse('2026-01-01T00:00:00Z')), '2025-12');
  });

  it('monthRange walks across year boundaries', () => {
    assert.deepEqual(monthRange('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('EIA STEO production series', () => {
  it('drops forecast months at or after the read month and flags recent months provisional', () => {
    const series = buildEiaSeries(eiaRows('PAPR_TC', EIA_AE), NOW);
    const ae = series.get('AE');
    assert.equal(ae.get('2026-10'), undefined, 'October 2026 is an STEO forecast on 2026-10-18');
    assert.equal(ae.get('2026-09').kbd, 4437);
    assert.equal(ae.get('2026-09').provisional, true);
    assert.equal(ae.get('2026-04').provisional, false);
  });
});

describe('6-vs-6 comparison (the failed question)', () => {
  function uaeCountry() {
    return assembleCountry({
      spec: OIL_TRADE_COUNTRIES.find((c) => c.iso2 === 'AE'),
      eia: buildEiaSeries(eiaRows('PAPR_TC', EIA_AE), NOW).get('AE'),
      jodi: new Map(),
      mirror: new Map(),
      ais: { months: new Map(), datasetMaxDate: null },
      nowMs: NOW,
    });
  }

  it('returns the day-weighted Apr-Sep 2026 vs Oct 2025-Mar 2026 production averages', () => {
    const result = compareOilWindows(uaeCountry(), { nowMs: NOW, windowMonths: 6 });
    assert.deepEqual(result.windows.current, { from: '2026-04', to: '2026-09' });
    assert.deepEqual(result.windows.prior, { from: '2025-10', to: '2026-03' });
    assert.deepEqual(result.windows.yearAgo, { from: '2025-04', to: '2025-09' });
    const p = result.metrics.production;
    assert.equal(Math.round(p.current.kbd), 3936);
    assert.equal(Math.round(p.prior.kbd), 4215);
    assert.equal(Math.round(p.yearAgo.kbd), 4346);
    assert.equal(p.changePct.toFixed(1), '-6.6');
    assert.equal(p.current.monthsCovered, 6);
    assert.equal(p.complete, true);
  });

  it('a source with no months is null, never zero', () => {
    const result = compareOilWindows(uaeCountry(), { nowMs: NOW, windowMonths: 6 });
    const jodi = result.metrics.jodiCrudeExports;
    assert.equal(jodi.current.kbd, null);
    assert.equal(jodi.current.monthsCovered, 0);
    assert.equal(jodi.changePct, null);
  });
});

describe('JODI history', () => {
  const row = (iso2, month, product, flow, value, code = '3') =>
    ({ REF_AREA: iso2, TIME_PERIOD: month, ENERGY_PRODUCT: product, FLOW_BREAKDOWN: flow, UNIT_MEASURE: 'KBD', OBS_VALUE: value, ASSESSMENT_CODE: code });

  it('keeps every month of reported crude and product exports, code 3 included', () => {
    const series = buildJodiSeries([
      row('SA', '2026-04', 'CRUDEOIL', 'TOTEXPSB', '3986.8'),
      row('SA', '2026-05', 'CRUDEOIL', 'TOTEXPSB', '3434.9032'),
      row('SA', '2026-05', 'TOTPRODS', 'TOTEXPSB', '1084'),
      row('SA', '2026-05', 'CRUDEOIL', 'INDPROD', '7100', '1'),
    ]);
    const sa = series.get('SA');
    assert.equal(sa.get('2026-04').crudeExportsKbd, 3986.8);
    assert.equal(sa.get('2026-05').crudeExportsKbd, 3434.9032);
    assert.equal(sa.get('2026-05').productExportsKbd, 1084);
    assert.equal(sa.get('2026-05').crudeProductionKbd, 7100);
  });

  it('a country filing only placeholders (the UAE since 2019) has no months and reports not_reported', () => {
    const series = buildJodiSeries([
      row('AE', '2026-07', 'CRUDEOIL', 'TOTEXPSB', '-'),
      row('AE', '2026-07', 'TOTPRODS', 'TOTEXPSB', '..'),
    ]);
    assert.equal(series.get('AE'), undefined);
    const country = assembleCountry({
      spec: OIL_TRADE_COUNTRIES.find((c) => c.iso2 === 'AE'),
      eia: new Map(), jodi: series.get('AE') ?? new Map(), mirror: new Map(),
      ais: { months: new Map(), datasetMaxDate: null }, nowMs: NOW,
    });
    assert.equal(country.sources.jodi.status, 'not_reported');
    assert.equal(country.sources.jodi.lastObserved, null);
  });
});

describe('Comtrade mirror imports', () => {
  // netWgt is kilograms. Japan's 2026-04 crude imports from the UAE: 3,254 kt.
  const ct = (reporterISO, period, cmdCode, netWgtKg) => ({ reporterISO, period, cmdCode, netWgt: netWgtKg });

  it('maps raw Comtrade rows: keeps isAggregate country totals, drops rows without an ISO3 and the exporter itself', () => {
    // Shape of the live 2026-04 partner=784 response (includeDesc=true).
    const raw = [
      { reporterCode: 392, reporterISO: 'JPN', period: 202604, cmdCode: '2709', netWgt: 3254308476.0, isAggregate: true },
      { reporterCode: 699, reporterISO: 'IND', period: 202604, cmdCode: '2709', netWgt: 2165493417.0, isAggregate: true },
      { reporterCode: 784, reporterISO: 'ARE', period: 202604, cmdCode: '2709', netWgt: 1e6, isAggregate: true },
      { reporterCode: 764, reporterISO: null, period: 202604, cmdCode: '2709', netWgt: 1621911183.0, isAggregate: true },
    ];
    const rows = mirrorRowsFromComtrade(raw, OIL_TRADE_COUNTRIES.find((c) => c.iso2 === 'AE'));
    assert.deepEqual(rows.map((r) => r.reporterISO), ['JPN', 'IND']);
    assert.equal(rows[0].period, '202604');
    assert.equal(buildMirrorSeries(rows).get('2026-04').reporters.JPN.crudeKbd > 0, true);
  });

  it('converts tonnes to kb/d and lists reporters per month', () => {
    const series = buildMirrorSeries([
      ct('JPN', '202604', '2709', 3_254_310_000),
      ct('IND', '202604', '2709', 2_165_490_000),
      ct('IND', '202604', '2710', 130_000_000),
    ]);
    const apr = series.get('2026-04');
    assert.equal(Math.round(apr.reporters.JPN.crudeKbd), 795); // 3,254,310 t x 7.33 bbl/t / 30 d
    assert.equal(Math.round(apr.crudeKbd), Math.round(apr.reporters.JPN.crudeKbd + apr.reporters.IND.crudeKbd));
    assert.ok(apr.productsKbd > 0);
  });

  it('keeps a lumpy cargo month: one product cargo can be 10x a buyer\'s median', () => {
    const rows = [['202501', 50e6], ['202502', 40e6], ['202503', 60e6], ['202504', 55e6], ['202505', 573e6]]
      .map(([period, kg]) => ct('IND', period, '2710', kg));
    assert.ok(buildMirrorSeries(rows).get('2025-05').reporters.IND.productsKbd > 0);
  });

  it('drops a buyer-month larger than the exporter\'s whole production that month', () => {
    // 66.5 Mt in a month is ~16 mb/d of crude from the UAE, which produced ~4.3 mb/d.
    const rows = [ct('THA', '202411', '2709', 66.5e9), ct('THA', '202410', '2709', 2.23e9)];
    const production = new Map([['2024-11', { kbd: 4340 }], ['2024-10', { kbd: 4340 }]]);
    const series = buildMirrorSeries(rows, { production });
    assert.equal(series.get('2024-11'), undefined);
    assert.ok(series.get('2024-10').reporters.THA.crudeKbd > 0);
  });

  it('without production data, drops a reporter-month 20x+ its own median (Thailand 2024-11 unit error)', () => {
    const rows = [];
    for (const [period, kg] of [['202410', 2.23e9], ['202501', 1.98e9], ['202502', 1.67e9], ['202503', 2.03e9], ['202411', 66.5e9]]) {
      rows.push(ct('THA', period, '2709', kg));
    }
    const series = buildMirrorSeries(rows);
    assert.equal(series.get('2024-11'), undefined, 'the 66.5 Mt month is a unit error, not 30x imports');
    assert.ok(series.get('2024-10').reporters.THA.crudeKbd > 0);
  });

  it('compares windows on reporters present in every covered month, so a buyer that stops filing is not a collapse', () => {
    const months = {};
    for (const m of monthRange('2025-10', '2026-09')) months[m] = {};
    // Japan and India file throughout Oct-Jul; Korea files only in the prior window.
    for (const m of monthRange('2025-10', '2026-07')) { months[m].JPN = 3.5e9; months[m].IND = 2.2e9; }
    for (const m of monthRange('2025-10', '2025-12')) months[m].KOR = 0.7e9;
    const rows = Object.entries(months).flatMap(([m, byReporter]) =>
      Object.entries(byReporter).map(([r, kg]) => ct(r, m.replace('-', ''), '2709', kg)));
    const country = assembleCountry({
      spec: OIL_TRADE_COUNTRIES.find((c) => c.iso2 === 'AE'),
      eia: new Map(), jodi: new Map(), mirror: buildMirrorSeries(rows),
      ais: { months: new Map(), datasetMaxDate: null }, nowMs: NOW,
    });
    const m = compareOilWindows(country, { nowMs: NOW, windowMonths: 6 }).metrics.mirrorCrudeImports;
    assert.deepEqual(m.basis.reporters, ['IND', 'JPN']);
    assert.equal(m.current.monthsCovered, 4, 'Aug and Sep have no filings yet');
    assert.equal(m.complete, false);
    assert.ok(Math.abs(m.changePct) < 1, `same monthly tonnage on the matched basis is ~0% (day-count only), got ${m.changePct}`);
  });
});

describe('mirror matched basis under filing lag', () => {
  // The live UAE pattern: Japan files through August, India only through July,
  // Malaysia throughout, Singapore stops after April 2026.
  const ct = (reporterISO, period, netWgtKg) => ({ reporterISO, period, cmdCode: '2709', netWgt: netWgtKg });
  function uae() {
    const rows = [];
    for (const m of monthRange('2025-10', '2026-08')) rows.push(ct('JPN', m.replace('-', ''), 3.4e9));
    for (const m of monthRange('2025-10', '2026-07')) rows.push(ct('IND', m.replace('-', ''), 2.2e9));
    for (const m of monthRange('2025-10', '2026-08')) rows.push(ct('MYS', m.replace('-', ''), 0.2e9));
    for (const m of monthRange('2025-10', '2026-04')) rows.push(ct('SGP', m.replace('-', ''), 1.9e9));
    return assembleCountry({
      spec: OIL_TRADE_COUNTRIES.find((c) => c.iso2 === 'AE'),
      eia: new Map(), jodi: new Map(), mirror: buildMirrorSeries(rows),
      ais: { months: new Map(), datasetMaxDate: null }, nowMs: NOW,
    });
  }

  it('drops the not-yet-filed month, not the buyer that files a month late', () => {
    const m = compareOilWindows(uae(), { nowMs: NOW, windowMonths: 6 }).metrics.mirrorCrudeImports;
    assert.deepEqual(m.basis.reporters, ['IND', 'JPN', 'MYS'], 'India stays; Singapore stopped filing and leaves');
    assert.equal(m.current.monthsCovered, 4, 'Apr-Jul: every basis buyer filed');
    assert.equal(m.prior.monthsCovered, 6);
    assert.ok(Math.abs(m.changePct) < 1, `constant tonnage reads ~0%, got ${m.changePct}`);
  });
});

describe('PortWatch AIS loadings and the freshness gate', () => {
  const feature = (year, month, exportTankerT, maxDate) =>
    ({ attributes: { year, month, exportTankerT, tankerCalls: 100, maxDate, rows: 450 } });

  it('a stalled feed ends at its last complete month: later months are absent, not zero, and the source is stale', () => {
    // The 2026-08-21 stall: rows stop mid-August.
    const ais = buildAisSeries([
      feature(2026, 6, 4_531_678, '2026-06-30'),
      feature(2026, 7, 2_187_331, '2026-07-31'),
      feature(2026, 8, 1_200_000, '2026-08-21'),
    ]);
    assert.equal(ais.months.get('2026-08').complete, false);
    const country = assembleCountry({
      spec: OIL_TRADE_COUNTRIES.find((c) => c.iso2 === 'AE'),
      eia: new Map(), jodi: new Map(), mirror: new Map(), ais, nowMs: NOW,
    });
    assert.equal(country.sources.ais.status, 'stale');
    assert.equal(country.sources.ais.lastObserved, '2026-07');
    const sep = country.months.find((m) => m.month === '2026-09');
    assert.equal(sep.ais, null, 'a month after the stall is unavailable, never 0');
    const aug = country.months.find((m) => m.month === '2026-08');
    assert.equal(aug.ais.loadingsKbd, null, 'a partial month carries no loading rate');

    const cmp = compareOilWindows(country, { nowMs: NOW, windowMonths: 6 }).metrics.aisTankerLoadings;
    assert.equal(cmp.current.monthsCovered, 2);
    assert.equal(cmp.complete, false);
  });

  it('a current feed is ok and converts export tonnes to kb/d', () => {
    const ais = buildAisSeries([
      feature(2026, 9, 3_060_863, '2026-09-30'),
      feature(2026, 10, 803_852, '2026-10-09'),
    ]);
    const country = assembleCountry({
      spec: OIL_TRADE_COUNTRIES.find((c) => c.iso2 === 'AE'),
      eia: new Map(), jodi: new Map(), mirror: new Map(), ais, nowMs: NOW,
    });
    assert.equal(country.sources.ais.status, 'ok');
    assert.equal(Math.round(country.months.find((m) => m.month === '2026-09').ais.loadingsKbd), 748);
    assert.equal(country.months.at(-1).month, '2026-09', 'the series ends at the last complete month');
  });
});

describe('storage form', () => {
  it('compact -> expand keeps every comparison and every null', () => {
    const rows = [];
    for (const m of monthRange('2025-10', '2026-07')) {
      rows.push({ reporterISO: 'JPN', period: m.replace('-', ''), cmdCode: '2709', netWgt: 3.4e9 });
      rows.push({ reporterISO: 'IND', period: m.replace('-', ''), cmdCode: '2709', netWgt: 2.1e9 });
    }
    const country = assembleCountry({
      spec: OIL_TRADE_COUNTRIES.find((c) => c.iso2 === 'AE'),
      eia: buildEiaSeries(eiaRows('PAPR_TC', EIA_AE), NOW).get('AE'),
      jodi: new Map(),
      mirror: buildMirrorSeries(rows),
      ais: buildAisSeries([{ attributes: { year: 2026, month: 9, exportTankerT: 3_060_863, tankerCalls: 265, maxDate: '2026-09-30' } }]),
      nowMs: NOW,
    });
    const stored = JSON.parse(JSON.stringify(compactCountry(country)));
    const restored = expandCountry(stored);
    assert.equal(restored.months.length, 24);
    assert.equal(restored.months.find((m) => m.month === '2026-08').ais, null);
    assert.equal(restored.months.find((m) => m.month === '2026-09').production.provisional, true);
    const a = compareOilWindows(country, { nowMs: NOW }).metrics;
    const b = compareOilWindows(restored, { nowMs: NOW }).metrics;
    for (const name of Object.keys(a)) {
      for (const w of ['current', 'prior', 'yearAgo']) {
        assert.equal(b[name][w].monthsCovered, a[name][w].monthsCovered, `${name}.${w}`);
        if (a[name][w].kbd === null) assert.equal(b[name][w].kbd, null);
        else assert.ok(Math.abs(b[name][w].kbd - a[name][w].kbd) < 0.1, `${name}.${w}`);
      }
    }
    assert.ok(JSON.stringify(stored).length < 6000, `one country must stay small, got ${JSON.stringify(stored).length} bytes`);
  });
});

describe('mirrored module', () => {
  // Railway builds the energy bundle from scripts/ only, so the seeder imports
  // the scripts/shared copy and the MCP tool the root copy. They must not drift.
  it('shared/oil-trade-windows is byte-identical to its scripts/shared mirror', () => {
    const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    assert.equal(read('shared/oil-trade-windows.js'), read('scripts/shared/oil-trade-windows.js'));
    assert.equal(read('shared/oil-trade-windows.d.ts'), read('scripts/shared/oil-trade-windows.d.ts'));
  });
});

describe('review findings (#9393)', () => {
  it('a null or blank EIA value is absent, not zero', () => {
    const series = buildEiaSeries([
      { seriesId: 'PAPR_TC', period: '2026-08', value: null },
      { seriesId: 'PAPR_TC', period: '2026-07', value: '' },
      { seriesId: 'PAPR_TC', period: '2026-06', value: ' ' },
      { seriesId: 'PAPR_TC', period: '2026-05', value: '2.9561' },
    ], NOW).get('AE');
    assert.deepEqual([...series.keys()], ['2026-05']);
  });

  it('a null PortWatch export total is absent, not zero', () => {
    const ais = buildAisSeries([{ attributes: { year: 2026, month: 9, exportTankerT: null, tankerCalls: null, maxDate: '2026-09-30' } }]);
    const sep = ais.months.get('2026-09');
    assert.equal(sep.loadingsKbd, null);
    assert.equal(sep.exportTankerKt, null);
    assert.equal(sep.tankerCalls, null);
  });

  it('JODI keeps prior-year history when the current-year files are not published yet', async () => {
    const csv = (rows) => ['REF_AREA,TIME_PERIOD,ENERGY_PRODUCT,FLOW_BREAKDOWN,UNIT_MEASURE,OBS_VALUE,ASSESSMENT_CODE', ...rows].join('\n');
    const fetchYear = async (kind, year) => (year === 2026
      ? { ok: false, text: '', error: 'HTTP 404' }
      : { ok: true, text: kind === 'primary' ? csv([`SA,${year}-12,CRUDEOIL,TOTEXPSB,KBD,6988.3871,3`]) : csv([]) });
    const rows = await fetchJodiRows(Date.parse('2026-01-05T00:00:00Z'), { fetchYear });
    assert.ok(rows.some((r) => r.REF_AREA === 'SA' && r.TIME_PERIOD === '2025-12'));
  });

  it('JODI fails only when no year file loads at all', async () => {
    const fetchYear = async () => ({ ok: false, text: '', error: 'HTTP 503' });
    await assert.rejects(() => fetchJodiRows(NOW, { fetchYear }), /no JODI year file/);
  });

  it('a failed source keeps its last good months from the previous publish, marked unavailable', () => {
    const spec = OIL_TRADE_COUNTRIES.find((c) => c.iso2 === 'AE');
    const PREV = Date.parse('2026-09-20T12:00:00Z'); // previous publish: series ran to 2026-08
    const mirrorRows = monthRange('2025-10', '2026-08').map((m) => ({ reporterISO: 'JPN', period: m.replace('-', ''), cmdCode: '2709', netWgt: 3.4e9 }));
    const previous = compactCountry(assembleCountry({
      spec, eia: new Map(), jodi: new Map(), mirror: buildMirrorSeries(mirrorRows),
      ais: { months: new Map(), datasetMaxDate: null }, nowMs: PREV,
    }));
    const current = compactCountry(assembleCountry({
      spec, eia: buildEiaSeries(eiaRows('PAPR_TC', EIA_AE), NOW).get('AE'), jodi: new Map(), mirror: new Map(),
      ais: { months: new Map(), datasetMaxDate: null }, nowMs: NOW, failed: new Set(['mirror']),
    }));
    const merged = expandCountry(carryForwardFailedSources(current, previous));
    assert.equal(merged.sources.mirror.status, 'unavailable');
    assert.equal(merged.sources.mirror.lastObserved, '2026-08', 'the last good observation month survives');
    assert.ok(merged.months.find((m) => m.month === '2026-08').mirror.reporters.JPN.crudeKbd > 0, 'months shift by one and still align');
    assert.equal(merged.months.find((m) => m.month === '2026-09').mirror, null, 'nothing is invented past the old series');
    assert.equal(merged.months.find((m) => m.month === '2026-09').production.kbd, 4437, 'healthy sources are untouched');
  });

  it('mirror metrics return the current-window average behind yoyPct', () => {
    const rows = [];
    for (const m of monthRange('2025-04', '2026-09')) rows.push({ reporterISO: 'JPN', period: m.replace('-', ''), cmdCode: '2709', netWgt: 3.4e9 });
    for (const m of monthRange('2025-10', '2026-09')) rows.push({ reporterISO: 'IND', period: m.replace('-', ''), cmdCode: '2709', netWgt: 2.2e9 });
    const country = assembleCountry({
      spec: OIL_TRADE_COUNTRIES.find((c) => c.iso2 === 'AE'), eia: new Map(), jodi: new Map(),
      mirror: buildMirrorSeries(rows), ais: { months: new Map(), datasetMaxDate: null }, nowMs: NOW,
    });
    const m = compareOilWindows(country, { nowMs: NOW }).metrics.mirrorCrudeImports;
    assert.deepEqual(m.basis.reporters, ['IND', 'JPN']);
    assert.deepEqual(m.basis.yoyReporters, ['JPN'], 'India did not file a year ago');
    assert.ok(m.currentForYoy.kbd < m.current.kbd, 'the YoY current average covers Japan only');
    assert.equal(m.currentForYoy.monthsCovered, 6);
    assert.ok(Math.abs(m.yoyPct - ((m.currentForYoy.kbd - m.yearAgo.kbd) / m.yearAgo.kbd) * 100) < 1e-9);
  });
});

describe('review findings, round 2 (#9393)', () => {
  it('the buyer cap keeps recent filers over heavier buyers that stopped filing', () => {
    const rows = [];
    // Eight large buyers that filed only in the oldest months (China-style).
    for (const r of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH']) {
      for (const m of monthRange('2024-10', '2025-03')) rows.push({ reporterISO: r, period: m.replace('-', ''), cmdCode: '2709', netWgt: 9e9 });
    }
    // A smaller buyer that files through both comparison windows.
    for (const m of monthRange('2025-10', '2026-09')) rows.push({ reporterISO: 'JPN', period: m.replace('-', ''), cmdCode: '2709', netWgt: 1e9 });
    const mirror = trimMirrorReporters(buildMirrorSeries(rows), 8, '2026-09');
    assert.ok(mirror.get('2026-09').reporters.JPN, 'JPN must keep its own series');
    const country = assembleCountry({
      spec: OIL_TRADE_COUNTRIES.find((c) => c.iso2 === 'AE'), eia: new Map(), jodi: new Map(), mirror,
      ais: { months: new Map(), datasetMaxDate: null }, nowMs: NOW,
    });
    assert.deepEqual(compareOilWindows(country, { nowMs: NOW }).metrics.mirrorCrudeImports.basis.reporters, ['JPN']);
  });

  it('AIS lastObserved is the newest complete month with a loading value', () => {
    const ais = buildAisSeries([
      { attributes: { year: 2026, month: 8, exportTankerT: 2_392_849, tankerCalls: 258, maxDate: '2026-08-31' } },
      { attributes: { year: 2026, month: 9, exportTankerT: null, tankerCalls: null, maxDate: '2026-09-30' } },
    ]);
    const country = assembleCountry({
      spec: OIL_TRADE_COUNTRIES.find((c) => c.iso2 === 'AE'), eia: new Map(), jodi: new Map(), mirror: new Map(), ais, nowMs: NOW,
    });
    assert.equal(country.sources.ais.lastObserved, '2026-08');
  });
});

describe('publish gate', () => {
  it('refuses a payload with too few countries carrying any declared source', () => {
    assert.equal(validate({ countries: {} }), false);
  });
});

// ── Importer-declared crude origin (pre-crisis and current-flows baselines) ──

// Two keyed Comtrade calls recorded 2026-10-28 (HS 2709 imports from World and
// the seven Hormuz-loading exporters, every reporter); JPN, IND, USA and KOR rows.
const CRUDE_ORIGIN_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/energy-shock/comtrade-crude-origin-2026-10-28.json', import.meta.url), 'utf8'));
const ORIGIN_NOW = Date.parse('2026-10-28T12:00:00Z');

const windowShare = (importer, months, from, to) => {
  let gulf = 0;
  let world = 0;
  months.forEach((m, i) => {
    if (m < from || m > to || importer.worldUsdM[i] == null) return;
    gulf += importer.gulfUsdM[i];
    world += importer.worldUsdM[i];
  });
  return gulf / world;
};

describe('crude import origin (importer-declared Comtrade monthly)', () => {
  it('uses the same seven Gulf partners as the shock model', () => {
    assert.deepEqual(CRUDE_ORIGIN_GULF_PARTNERS.map((c) => String(c).padStart(3, '0')).sort(), [...GULF_PARTNER_CODES].sort());
  });

  it('requests the fixed pre-crisis window and the recent months after it: two calls', () => {
    const periods = crudeImportOriginPeriods(ORIGIN_NOW);
    assert.equal(periods.length, 2);
    assert.deepEqual(periods[0], monthRange(PRE_CRISIS_WINDOW.startMonth, PRE_CRISIS_WINDOW.endMonth));
    assert.deepEqual(periods[1], monthRange('2026-02', '2026-09'));
    // A year on, the recent call still spans at most 12 months.
    const later = crudeImportOriginPeriods(Date.parse('2027-08-15T00:00:00Z'));
    assert.deepEqual(later[1], monthRange('2026-08', '2027-07'));
    assert.ok(later.every((p) => p.length <= 12));
  });

  it('builds per-importer value columns from the recorded rows: Japan 92.7% pre-crisis, 60.5% in Jun-Aug 2026', () => {
    const months = crudeImportOriginPeriods(ORIGIN_NOW).flat();
    const importers = buildCrudeImportOrigin(CRUDE_ORIGIN_FIXTURE.rows, months);
    assert.deepEqual(Object.keys(importers).sort(), ['IN', 'JP', 'KR', 'US']);
    const jp = importers.JP;
    assert.equal(jp.worldUsdM.length, months.length);
    assert.ok(Math.abs(windowShare(jp, months, '2025-02', '2026-01') - 0.927) < 0.001);
    assert.ok(Math.abs(windowShare(jp, months, '2026-06', '2026-08') - 0.605) < 0.001);
    assert.ok(Math.abs(windowShare(importers.IN, months, '2025-02', '2026-01') - 0.482) < 0.001);
    assert.ok(Math.abs(windowShare(importers.US, months, '2025-02', '2026-01') - 0.089) < 0.001);
    // Korea files nothing after 2025-12, and Japan nothing for 2026-09 yet:
    // those months are null, never zero.
    assert.equal(importers.KR.worldUsdM[months.indexOf('2026-01')], null);
    assert.equal(importers.KR.gulfUsdM[months.indexOf('2026-03')], null);
    assert.equal(jp.worldUsdM[months.indexOf('2026-09')], null);
  });

  it('a filed month without Gulf rows is a Gulf value of 0; a month without a World row is not an observation', () => {
    const months = ['2025-02', '2025-03', '2025-04'];
    const rows = [
      { reporterISO: 'DEU', partnerCode: 0, period: '202502', cmdCode: '2709', flowCode: 'M', primaryValue: 2e9 },
      { reporterISO: 'DEU', partnerCode: 0, period: '202503', cmdCode: '2709', flowCode: 'M', primaryValue: 2e9 },
      { reporterISO: 'DEU', partnerCode: 682, period: '202503', cmdCode: '2709', flowCode: 'M', primaryValue: 5e8 },
      // Partner rows with no World total for the month.
      { reporterISO: 'DEU', partnerCode: 784, period: '202504', cmdCode: '2709', flowCode: 'M', primaryValue: 1e8 },
      // Not crude, not an import, not a Gulf partner: ignored.
      { reporterISO: 'DEU', partnerCode: 682, period: '202502', cmdCode: '2710', flowCode: 'M', primaryValue: 9e9 },
      { reporterISO: 'DEU', partnerCode: 682, period: '202502', cmdCode: '2709', flowCode: 'X', primaryValue: 9e9 },
      { reporterISO: 'DEU', partnerCode: 512, period: '202502', cmdCode: '2709', flowCode: 'M', primaryValue: 9e8 },
    ];
    const { DE } = buildCrudeImportOrigin(rows, months);
    assert.deepEqual(DE.worldUsdM, [2000, 2000, null]);
    assert.deepEqual(DE.gulfUsdM, [0, 500, null]);
  });

  it('drops a month whose Gulf rows exceed the World total (a filing error)', () => {
    const rows = [
      { reporterISO: 'THA', partnerCode: 0, period: '202502', cmdCode: '2709', flowCode: 'M', primaryValue: 1e9 },
      { reporterISO: 'THA', partnerCode: 784, period: '202502', cmdCode: '2709', flowCode: 'M', primaryValue: 3e9 },
    ];
    assert.deepEqual(buildCrudeImportOrigin(rows, ['2025-02']).TH, undefined, 'no observed month, no importer row');
  });

  it('a failed fetch carries the previous section forward instead of publishing an empty one', () => {
    const months = ['2025-02'];
    const ok = crudeImportOriginSection({
      months,
      rows: [{ reporterISO: 'JPN', partnerCode: 0, period: '202502', cmdCode: '2709', flowCode: 'M', primaryValue: 1e9 }],
      fetchedAt: '2026-10-21T03:00:00.000Z',
    });
    assert.equal(ok.status, 'ok');
    assert.deepEqual(ok.months, months);
    assert.deepEqual(ok.importers.JP.worldUsdM, [1000]);
    assert.match(ok.source, /UN Comtrade/);

    const failed = crudeImportOriginSection({ months, error: new Error('Comtrade HTTP 503'), fetchedAt: '2026-10-28T03:00:00.000Z', previous: ok });
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.carriedForward, true);
    assert.equal(failed.fetchedAt, '2026-10-21T03:00:00.000Z', 'the carried data keeps the date it was fetched');
    assert.deepEqual(failed.importers, ok.importers);

    // A requested window that comes back empty would silently drop its baseline
    // (pre-crisis or current) for every importer: keep the previous section.
    const emptyWindow = crudeImportOriginSection({
      months,
      rows: [{ reporterISO: 'JPN', partnerCode: 0, period: '202502', cmdCode: '2709', flowCode: 'M', primaryValue: 2e9 }],
      windowRowCounts: [1, 0],
      fetchedAt: '2026-10-28T03:00:00.000Z',
      previous: ok,
    });
    assert.equal(emptyWindow.status, 'unavailable');
    assert.equal(emptyWindow.carriedForward, true);
    assert.deepEqual(emptyWindow.importers, ok.importers);

    const none = crudeImportOriginSection({ months, error: new Error('Comtrade HTTP 503'), fetchedAt: '2026-10-28T03:00:00.000Z' });
    assert.equal(none.status, 'unavailable');
    assert.deepEqual(none.importers, {});
    assert.equal(none.carriedForward, undefined);
  });
});

describe('crude import origin fetch', () => {
  it('fails over to the next configured Comtrade key when one key fails', async () => {
    const calls = [];
    const fetchJson = async (url, key) => {
      calls.push(key);
      if (key === 'revoked') throw new Error('Comtrade HTTP 401');
      return [{ reporterISO: 'JPN', partnerCode: 0, period: new URL(url).searchParams.get('period').split(',')[0], cmdCode: '2709', flowCode: 'M', primaryValue: 1e9 }];
    };
    const { rows, windowRowCounts } = await fetchCrudeImportOriginRows([['2025-02'], ['2026-03']], ['revoked', 'good'], { fetchJson, retries: 0 });
    assert.deepEqual(windowRowCounts, [1, 1]);
    assert.equal(rows.length, 2);
    assert.deepEqual(calls, ['revoked', 'good', 'revoked', 'good']);
  });

  it('throws only when every key fails', async () => {
    const fetchJson = async () => { throw new Error('Comtrade rate limited (429)'); };
    await assert.rejects(fetchCrudeImportOriginRows([['2025-02']], ['a', 'b'], { fetchJson, retries: 0 }), /429/);
  });

  it('moves to the next key at once on HTTP 401 or 403, and still retries a 5xx on the same key', async () => {
    const saved = process.env.WM_SEED_RETRY_DELAY_MS;
    process.env.WM_SEED_RETRY_DELAY_MS = '0';
    try {
      const row = (url) => [{ reporterISO: 'JPN', partnerCode: 0, period: new URL(url).searchParams.get('period').split(',')[0], cmdCode: '2709', flowCode: 'M', primaryValue: 1e9 }];
      const calls = [];
      const rejected = async (url, key) => {
        calls.push(key);
        if (key === 'revoked') throw new Error('Comtrade HTTP 401');
        if (key === 'forbidden') throw new Error('Comtrade HTTP 403');
        return row(url);
      };
      await fetchCrudeImportOriginRows([['2025-02'], ['2026-03']], ['revoked', 'forbidden', 'good'], { fetchJson: rejected, retries: 3 });
      assert.deepEqual(calls, ['revoked', 'forbidden', 'good', 'revoked', 'forbidden', 'good']);

      let attempts = 0;
      const flaky = async (url) => {
        attempts += 1;
        if (attempts < 3) throw new Error('Comtrade HTTP 503');
        return row(url);
      };
      const { windowRowCounts } = await fetchCrudeImportOriginRows([['2025-02']], ['only'], { fetchJson: flaky, retries: 3 });
      assert.equal(attempts, 3);
      assert.deepEqual(windowRowCounts, [1]);
    } finally {
      if (saved === undefined) delete process.env.WM_SEED_RETRY_DELAY_MS;
      else process.env.WM_SEED_RETRY_DELAY_MS = saved;
    }
  });
});
