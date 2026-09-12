import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByProduct } from '../scripts/seed-comtrade-bilateral-hs4.mjs';

for (const [code, iso] of [[842, 'US'], [251, 'FR'], [579, 'NO'], [840, 'US'], [250, 'FR'], [578, 'NO'], [124, 'CA'], [490, ''], [899, ''], [9999, '']]) {
  test(`bilateral projection retains provider partner ${code} as ${iso || 'unresolved'}`, () => {
    const [product] = groupByProduct([{ cmdCode: '2804', partnerCode: String(code), primaryValue: 392, year: 2024 }]);
    assert.equal(product.topExporters[0].partnerIso2, iso);
    assert.equal(product.topExporters[0].partnerCode, code);
    assert.equal(product.topExporters[0].value, 392);
  });
}
test('world total is not a country candidate', () => {
  assert.deepEqual(groupByProduct([{cmdCode:'2804',partnerCode:'0',primaryValue:100,year:2024}]), []);
});

import { parseRecords } from '../scripts/shared/comtrade.mjs';
for (const body of [{}, {data:{}}, {data:[{cmdCode:'2804',partnerCode:842,primaryValue:'not-a-number',period:2024}]}]) {
  test('malformed upstream data cannot be recorded as valid empty', () => assert.throws(() => parseRecords(body), /Malformed/));
}

test('a capped provider response is incomplete, not a complete country snapshot', () => {
  const row={cmdCode:'2804',partnerCode:842,primaryValue:392,period:2024};
  assert.throws(()=>parseRecords({data:[row,row]},2),/Incomplete/);
});

test('new ingestion uses the World denominator without double-counting aggregate partners', () => {
  const records=[['0',1000],['899',100],['842',392],['634',100]].map(([partnerCode,primaryValue])=>({cmdCode:'2804',partnerCode,primaryValue,year:2024}));
  const product=groupByProduct(records)[0];
  assert.equal(product.totalValue,1000);
  assert.equal(product.topExporters.find(p=>p.partnerCode===842).share,0.392);
  assert(!product.topExporters.some(p=>p.partnerCode===0));
  assert.equal(product.denominatorBasis,'reported_world');
});

test('new ingestion rejects partner values exceeding the World denominator', () => {
  assert.throws(() => groupByProduct([
    { cmdCode: '2804', partnerCode: '0', primaryValue: 100, year: 2024 },
    { cmdCode: '2804', partnerCode: '842', primaryValue: 150, year: 2024 },
  ]), /partner values exceed World total/);
});

test('without a World row the denominator is the observed partner sum', () => {
  const [product] = groupByProduct([
    { cmdCode: '2804', partnerCode: '842', primaryValue: 300, year: 2024 },
    { cmdCode: '2804', partnerCode: '634', primaryValue: 100, year: 2024 },
  ]);
  assert.equal(product.denominatorBasis, 'observed_partners');
  assert.equal(product.totalValue, 400);
  assert.equal(product.topExporters.find(p => p.partnerCode === 842).share, 0.75);
});

test('a World row from an older year is not used as the denominator', () => {
  const [product] = groupByProduct([
    { cmdCode: '2804', partnerCode: '0', primaryValue: 10_000, year: 2023 },
    { cmdCode: '2804', partnerCode: '842', primaryValue: 300, year: 2024 },
    { cmdCode: '2804', partnerCode: '634', primaryValue: 100, year: 2024 },
  ]);
  assert.equal(product.denominatorBasis, 'observed_partners');
  assert.equal(product.totalValue, 400);
  assert.equal(product.year, 2024);
});

import { comtradeFailureState, PREVIEW_MAX_RECORDS } from '../scripts/shared/comtrade.mjs';
import { createComtradeBilateralCatalogue } from '../scripts/shared/comtrade-bilateral.mjs';

const thrown = (fn) => { try { fn(); } catch (error) { return error; } assert.fail('expected a throw'); };

test('response failures are classified by type, not by message text', () => {
  const row = { cmdCode: '2804', partnerCode: 842, primaryValue: 392, period: 2024 };
  assert.equal(comtradeFailureState(thrown(() => parseRecords({}))), 'malformed');
  assert.equal(comtradeFailureState(thrown(() => parseRecords({ data: [row, row] }, 2))), 'incomplete');
  assert.equal(comtradeFailureState(thrown(() => groupByProduct([
    { cmdCode: '2804', partnerCode: '0', primaryValue: 100, year: 2024 },
    { cmdCode: '2804', partnerCode: '842', primaryValue: 150, year: 2024 },
  ]))), 'incomplete');
  // A network or budget error that happens to start with the same word must
  // not be reported as a provider data defect.
  assert.equal(comtradeFailureState(new Error('Malformed proxy response')), 'unavailable');
  assert.equal(comtradeFailureState(new Error('Incomplete TLS handshake')), 'unavailable');
});

test('the preview record cap matches the documented public-route limit', () => {
  assert.equal(PREVIEW_MAX_RECORDS, 500);
});

test('catalogue batches derive from the per-request cap and never include an empty request', () => {
  const identity = (code) => ({ iso2: '', kind: 'unknown', label: String(code), note: '' });
  const codes = (n) => Array.from({ length: n }, (_, i) => String(1000 + i));
  const catalogue = (n) => createComtradeBilateralCatalogue(
    { products: codes(n).map(code => ({ bilateralHs4Code: code, label: code })) },
    { commodities: [] },
    identity,
  );
  assert.deepEqual(catalogue(3).HS4_BATCHES, [codes(3)]);
  const split = catalogue(25);
  assert.deepEqual(split.HS4_BATCHES.map(batch => batch.length), [split.MAX_HS4_CODES_PER_BATCH, 25 - split.MAX_HS4_CODES_PER_BATCH]);
  assert.throws(() => catalogue(split.MAX_HS4_CODES_PER_BATCH * 2 + 1), /two-request budget/);
});

// ---------------------------------------------------------------------------
// Weight, quantity and the threshold partner list (plan 2026-09-11-001, U2).
// The brief needs every origin above 1% with its volume; the canonical payload
// and every scorer that sums topExporters must keep the leading-5 contract.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import {
  MAX_PARTNERS,
  MIN_PARTNER_SHARE,
  MIN_PARTNERS,
  leadingExporters,
  quantityUnitAbbr,
  selectPartners,
} from '../scripts/shared/comtrade.mjs';
import { computeProductImportHhi } from '../scripts/seed-supply-vulnerability.mjs';

const QUANTITY_UNITS = JSON.parse(
  readFileSync(new URL('../scripts/shared/comtrade-quantity-units.json', import.meta.url), 'utf8'),
);

/** One upstream row with the provider's field names, defaults filled in. */
const upstreamRow = (overrides = {}) => ({
  cmdCode: '2804', partnerCode: '842', primaryValue: 392, period: 2024, ...overrides,
});
const parsedRow = (overrides = {}) => parseRecords({ data: [upstreamRow(overrides)] })[0];

test('a reported net weight is carried and the provider estimate flag with it', () => {
  const row = parsedRow({ netWgt: 839, isNetWgtEstimated: true });
  assert.equal(row.netWeightKg, 839);
  assert.equal(row.netWeightEstimated, true);
});

test('an unreported net weight is null, never zero', () => {
  // Comtrade writes 0 for "not reported" (Qatar's 2804 world exports), so a
  // zero that reached the brief would read as "this origin ships nothing".
  assert.equal(parsedRow({ netWgt: 0 }).netWeightKg, null);
  assert.equal(parsedRow({ netWgt: null }).netWeightKg, null);
  assert.equal(parsedRow({ netWgt: 'heavy' }).netWeightKg, null);
  assert.equal(parsedRow().netWeightKg, null);
  assert.equal(parsedRow().netWeightEstimated, false);
});

test('quantity is carried only with a unit code the pinned registry names', () => {
  const kilos = parsedRow({ qty: 1250, qtyUnitCode: 8 });
  assert.equal(kilos.quantity, 1250);
  assert.equal(kilos.quantityUnitCode, 8);

  for (const unreported of [{ qty: 1250, qtyUnitCode: -1 }, { qty: 1250, qtyUnitCode: 999 }, { qty: 0, qtyUnitCode: 8 }, {}]) {
    const row = parsedRow(unreported);
    assert.equal(row.quantity, null, `quantity for ${JSON.stringify(unreported)}`);
    assert.equal(row.quantityUnitCode, null, `unit code for ${JSON.stringify(unreported)}`);
  }
});

test('the pinned quantity-unit registry resolves abbreviations and drops the not-available code', () => {
  assert.equal(Object.keys(QUANTITY_UNITS.units).length, 40);
  assert.equal(QUANTITY_UNITS.units['8'].abbr, 'kg');
  assert.equal(QUANTITY_UNITS.units['8'].description, 'Weight in kilograms');
  assert.equal(QUANTITY_UNITS.units['-1'], undefined);
  assert.equal(QUANTITY_UNITS.sourceUrl, 'https://comtradeapi.un.org/files/v1/app/reference/QuantityUnits.json');
  assert.equal(quantityUnitAbbr(8), 'kg');
  assert.equal(quantityUnitAbbr('8'), 'kg');
  assert.equal(quantityUnitAbbr(-1), null);
  assert.equal(quantityUnitAbbr(999), null);
});

/** `count` ranked partners for one heading, in the shape parseRecords emits. */
function partnerRows(count, value, { start = 101 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    cmdCode: '2804',
    partnerCode: String(start + i),
    primaryValue: typeof value === 'function' ? value(i) : value,
    year: 2024,
  }));
}

test('the full ranked partner list travels beside the leading five', () => {
  const [product] = groupByProduct([
    { cmdCode: '2804', partnerCode: '0', primaryValue: 3000, year: 2024 },
    ...partnerRows(30, i => 100 - i),
  ]);
  assert.equal(product.topExporters.length, 5);
  assert.equal(product.partners.length, 30);
  assert.deepEqual(product.partners.slice(0, 5), product.topExporters.map(e => ({
    ...e, netWeightKg: null, netWeightEstimated: false, quantity: null, quantityUnitCode: null,
  })));
  assert.equal(product.denominatorBasis, 'reported_world');
});

test('partner and World weight and quantity survive parsing and grouping', () => {
  const [product] = groupByProduct(parseRecords({
    data: [
      upstreamRow({ partnerCode: '0', primaryValue: 1000, netWgt: 691_380 }),
      upstreamRow({ partnerCode: '842', primaryValue: 900, netWgt: 839, qty: 700, qtyUnitCode: 8 }),
      upstreamRow({ partnerCode: '634', primaryValue: 100, netWgt: 0, qty: 0, qtyUnitCode: 8 }),
    ],
  }));
  assert.deepEqual(product.partners.map(p => [p.partnerCode, p.netWeightKg, p.quantity, p.quantityUnitCode]), [
    [842, 839, 700, 8],
    [634, null, null, null],
  ]);
  assert.equal(product.worldNetWeightKg, 691_380);
  assert.equal(product.denominatorBasis, 'reported_world');
});

test('a World row that reports no weight leaves worldNetWeightKg null', () => {
  const [product] = groupByProduct(parseRecords({
    data: [
      upstreamRow({ partnerCode: '0', primaryValue: 1000, netWgt: 0 }),
      upstreamRow({ partnerCode: '842', primaryValue: 300, netWgt: 120 }),
    ],
  }));
  assert.equal(product.worldNetWeightKg, null);
  assert.equal(product.partners[0].netWeightKg, 120);
});

test('partner retention keeps every origin at or above one percent', () => {
  assert.equal(MIN_PARTNER_SHARE, 0.01);
  assert.equal(MIN_PARTNERS, 5);
  assert.equal(MAX_PARTNERS, 25);

  // 12 partners at 80 (8.03% each) and 18 at 2 (0.20% each): 996 in total.
  const [product] = groupByProduct([...partnerRows(12, 80), ...partnerRows(18, 2, { start: 121 })]);
  const selected = selectPartners(product);
  assert.equal(selected.partners.length, 12);
  assert.equal(selected.omittedCount, 18);
  assert.equal(selected.omittedShare, 0.036);
  assert.deepEqual(selected.partners.map(p => p.partnerCode), product.partners.slice(0, 12).map(p => p.partnerCode));
});

test('partner retention pads a thin heading up to five origins', () => {
  // Three partners at 100 (33.1%) and four at 0.5 (0.17%): only 3 clear 1%.
  const [product] = groupByProduct([...partnerRows(3, 100), ...partnerRows(4, 0.5, { start: 111 })]);
  const selected = selectPartners(product);
  assert.equal(selected.partners.length, MIN_PARTNERS);
  assert.equal(selected.omittedCount, 2);
});

test('partner retention never pads past the ranked list it was given', () => {
  const [product] = groupByProduct(partnerRows(3, 100));
  const selected = selectPartners(product);
  assert.equal(selected.partners.length, 3);
  assert.equal(selected.omittedCount, 0);
  assert.equal(selected.omittedShare, 0);
});

test('partner retention caps a broad heading at twenty-five origins', () => {
  // 40 equal partners: every one holds 2.5%, so the cap, not the threshold, binds.
  const [product] = groupByProduct(partnerRows(40, 100));
  const selected = selectPartners(product);
  assert.equal(selected.partners.length, MAX_PARTNERS);
  assert.equal(selected.omittedCount, 15);
  assert.equal(selected.omittedShare, 0.375);
});

test('a partner rounded up to one percent is still omitted', () => {
  // 0.96% displays as 0.01 after three-decimal rounding; retention reads the
  // unrounded ratio so the rounding cannot promote it into the brief.
  const [product] = groupByProduct([...partnerRows(5, 200), ...partnerRows(1, 9.7, { start: 111 })]);
  const borderline = product.partners.find(p => p.partnerCode === 111);
  assert.equal(borderline.share, 0.01);
  assert.equal(selectPartners(product).partners.length, 5);
  assert.equal(selectPartners(product).omittedCount, 1);
});

test('selectPartners thresholds are tunable without touching the defaults', () => {
  const [product] = groupByProduct(partnerRows(30, 100));
  const selected = selectPartners(product, { minShare: 0.05, minPartners: 2, maxPartners: 10 });
  assert.equal(selected.partners.length, 2);
  assert.equal(selected.omittedCount, 28);
});

test('the canonical slice stays exactly the leading five of the ranked list', () => {
  const [product] = groupByProduct(partnerRows(30, i => 100 - i));
  assert.deepEqual(leadingExporters(product), product.topExporters);
  assert.equal(leadingExporters(product).length, 5);
  assert.equal(leadingExporters(product, 3).length, 3);
});

test('the leading-five projection is byte-identical to the pre-change output', () => {
  // The 842/251/579 fixtures the rest of this file pins, now read through a
  // 30-partner response: widening the catalogue must not move topExporters.
  const [product] = groupByProduct([
    { cmdCode: '2804', partnerCode: '0', primaryValue: 1000, year: 2024 },
    { cmdCode: '2804', partnerCode: '842', primaryValue: 392, year: 2024 },
    { cmdCode: '2804', partnerCode: '251', primaryValue: 251, year: 2024 },
    { cmdCode: '2804', partnerCode: '579', primaryValue: 157, year: 2024 },
    { cmdCode: '2804', partnerCode: '124', primaryValue: 100, year: 2024 },
    { cmdCode: '2804', partnerCode: '490', primaryValue: 50, year: 2024 },
    ...partnerRows(25, 2),
  ]);
  assert.deepEqual(product.topExporters, [
    { partnerCode: 842, partnerIso2: 'US', value: 392, share: 0.392 },
    { partnerCode: 251, partnerIso2: 'FR', value: 251, share: 0.251 },
    { partnerCode: 579, partnerIso2: 'NO', value: 157, share: 0.157 },
    { partnerCode: 124, partnerIso2: 'CA', value: 100, share: 0.1 },
    { partnerCode: 490, partnerIso2: '', value: 50, share: 0.05 },
  ]);
  assert.equal(product.totalValue, 1000);
  assert.equal(product.year, 2024);
});

test('import concentration still scores the leading five when the product carries 25 partners', () => {
  // AE3. The seeder writes the canonical key from topExporters; the wider
  // `partners` list must be inert for every scorer that sums topExporters.
  const [product] = groupByProduct([
    { cmdCode: '2804', partnerCode: '0', primaryValue: 4000, year: 2024 },
    ...partnerRows(25, i => 200 - i * 5),
  ]);
  assert.equal(product.partners.length, 25);

  const { partners, worldNetWeightKg, ...leadingFive } = product;
  const scored = computeProductImportHhi(product);
  assert.deepEqual(scored, computeProductImportHhi(leadingFive));
  assert.deepEqual(scored, computeProductImportHhi({ topExporters: leadingExporters(product) }));

  // Teeth: the same scorer over the full 25-partner list is a different number,
  // so the assertions above would fail if `partners` ever replaced topExporters.
  assert.notDeepEqual(scored, computeProductImportHhi({ topExporters: partners }));
});

test('both comtrade adapters expose the same names', () => {
  // Node needs `with { type: 'json' }` and the Vercel/Vite bundle needs the bare
  // form, so the two adapters are hand-kept twins; a name added to one only is
  // an import that resolves in tests and is undefined in production.
  const exportNames = (file) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const names = new Set();
    for (const block of source.matchAll(/\bexport\s+(?:const\s+)?\{([^}]*)\}/g)) {
      for (const entry of block[1].split(',')) {
        const name = entry.trim().split(/\s+as\s+/).pop().trim();
        if (name) names.add(name);
      }
    }
    return [...names].sort();
  };
  const mjs = exportNames('../scripts/shared/comtrade.mjs');
  assert.deepEqual(mjs, exportNames('../scripts/shared/comtrade.ts'));
  for (const name of ['selectPartners', 'leadingExporters', 'toCanonicalProduct', 'toPartnersProduct', 'quantityUnitAbbr', 'groupWorldExports', 'MIN_PARTNER_SHARE', 'MIN_PARTNERS', 'MAX_PARTNERS']) {
    assert.ok(mjs.includes(name), `comtrade adapters must export ${name}`);
  }
});

// ─── World exports (flowCode=X, partnerCode=0) ───────────────────────────────
//
// One request per catalogue batch answers "who exports this heading, and how
// much" for every reporter at once. The brief reads the result to state a
// supplier's scale and rank, so the ordering IS the published fact.

import { groupWorldExports } from '../scripts/shared/comtrade.mjs';

test('parseRecords carries the reporter code a world-exports response adds', () => {
  const [row] = parseRecords({ data: [{ cmdCode: '2804', reporterCode: 156, partnerCode: '0', primaryValue: 10, period: 2024 }] });
  assert.equal(row.reporterCode, '156');
  const [importRow] = parseRecords({ data: [{ cmdCode: '2804', partnerCode: '842', primaryValue: 10, period: 2024 }] });
  assert.equal('reporterCode' in importRow, false, 'an import row must not gain an empty reporter code');
});

test('world exports rank 118 reporters by value and report an unstated weight as null', () => {
  // The 2026-09-11 probe returned 118 reporters for HS 2804 in one request.
  // primaryValue ascends with the index so a list that merely echoes the input
  // order fails, and the lowest-valued reporter carries the absent weight.
  const records = Array.from({ length: 118 }, (_, i) => ({
    cmdCode: '2804',
    reporterCode: String(100 + i),
    partnerCode: '0',
    primaryValue: 1000 + i,
    year: 2024,
    netWeightKg: i === 0 ? null : 10 * (i + 1),
  }));

  const headings = groupWorldExports(records);

  assert.deepEqual(Object.keys(headings), ['2804']);
  assert.equal(headings['2804'].year, 2024);
  assert.equal(headings['2804'].unrankedReporterCount, 0);
  const { exporters } = headings['2804'];
  assert.equal(exporters.length, 118);
  assert.equal(exporters[0].valueUsd, 1117, 'rank 1 must be the largest exporter');
  assert.equal(exporters[117].valueUsd, 1000);
  assert.equal(exporters[117].netWeightKg, null, 'a provider 0/absent weight must stay null, never 0');
  assert.ok(exporters.every((e, i) => i === 0 || exporters[i - 1].valueUsd > e.valueUsd));
});

test('world exports resolve the reporter iso2 and ignore bilateral rows', () => {
  const headings = groupWorldExports([
    { cmdCode: '2804', reporterCode: '156', partnerCode: '0', primaryValue: 2107, year: 2024, netWeightKg: 875_000 },
    { cmdCode: '2804', reporterCode: '842', partnerCode: '0', primaryValue: 1809, year: 2024, netWeightKg: null },
    { cmdCode: '2804', reporterCode: '634', partnerCode: '0', primaryValue: 1398, year: 2024, netWeightKg: null },
    { cmdCode: '2804', reporterCode: '490', partnerCode: '0', primaryValue: 5, year: 2024, netWeightKg: null },
    // A partner-specific row from the same response: counting it as a world
    // total would rank the reporter on one corridor.
    { cmdCode: '2804', reporterCode: '156', partnerCode: '842', primaryValue: 9999, year: 2024, netWeightKg: 1 },
  ]);

  assert.deepEqual(headings['2804'].exporters, [
    { reporterCode: 156, iso2: 'CN', valueUsd: 2107, netWeightKg: 875_000 },
    { reporterCode: 842, iso2: 'US', valueUsd: 1809, netWeightKg: null },
    { reporterCode: 634, iso2: 'QA', valueUsd: 1398, netWeightKg: null },
    { reporterCode: 490, iso2: '', valueUsd: 5, netWeightKg: null },
  ]);
});

test('world exports rank only the newest year and count the larger late filer they leave out', () => {
  // Same rule as groupByProduct: a reporter whose newest row predates the
  // heading year would date-stamp an observation it did not make. Leaving it
  // out moves every rank below it, so the count of reporters left out travels
  // with the ranking: 842 exported 900 in 2023 and would rank first if it had
  // filed 2024, which makes CN's rank 1 a rank among 2024 filers only.
  const headings = groupWorldExports([
    { cmdCode: '2804', reporterCode: '156', partnerCode: '0', primaryValue: 100, year: 2023, netWeightKg: null },
    { cmdCode: '2804', reporterCode: '156', partnerCode: '0', primaryValue: 200, year: 2024, netWeightKg: null },
    { cmdCode: '2804', reporterCode: '842', partnerCode: '0', primaryValue: 900, year: 2023, netWeightKg: null },
  ]);

  assert.deepEqual(headings['2804'], {
    year: 2024,
    exporters: [{ reporterCode: 156, iso2: 'CN', valueUsd: 200, netWeightKg: null }],
    unrankedReporterCount: 1,
  });
});

test('a heading every reporter filed in the same year leaves no reporter unranked', () => {
  const headings = groupWorldExports([
    { cmdCode: '2804', reporterCode: '156', partnerCode: '0', primaryValue: 200, year: 2024, netWeightKg: null },
    { cmdCode: '2804', reporterCode: '842', partnerCode: '0', primaryValue: 900, year: 2024, netWeightKg: null },
  ]);
  assert.equal(headings['2804'].unrankedReporterCount, 0);
});

// ─── One row shape per key, shared by both writers ───────────────────────────
//
// The scheduled seeder and the lazy fetch both write the canonical key and
// the sibling partners key, and one reader treats either writer's row as the
// same type with no runtime validation. The shapes therefore come from one
// function each, and these tests pin them.

import { toCanonicalProduct, toPartnersProduct } from '../scripts/shared/comtrade.mjs';

const sevenPartners = () => groupByProduct([
  { cmdCode: '2804', partnerCode: '0', primaryValue: 2000, year: 2024, netWeightKg: 5000, netWeightEstimated: false, quantity: null, quantityUnitCode: null },
  ...[842, 490, 156, 276, 250, 392, 410].map((code, i) => ({
    cmdCode: '2804', partnerCode: String(code), primaryValue: 300 - i * 40, year: 2024,
    netWeightKg: i === 0 ? 1200 : null, netWeightEstimated: false, quantity: null, quantityUnitCode: null,
  })),
]);

test('the canonical row keeps the leading five origins and none of the partner detail', () => {
  const [product] = sevenPartners();
  const row = toCanonicalProduct(product);
  assert.deepEqual(Object.keys(row).sort(), ['denominatorBasis', 'description', 'hs4', 'topExporters', 'totalValue', 'year']);
  assert.equal(row.topExporters.length, 5);
  assert.deepEqual(Object.keys(row.topExporters[0]).sort(), ['partnerCode', 'partnerIso2', 'share', 'value']);
});

test('the sibling row carries the threshold origins with weight and the omitted tail', () => {
  const [product] = sevenPartners();
  const row = toPartnersProduct(product);
  assert.deepEqual(Object.keys(row).sort(), ['denominatorBasis', 'hs4', 'omittedCount', 'omittedShare', 'partners', 'totalValue', 'worldNetWeightKg', 'year']);
  assert.equal(row.worldNetWeightKg, 5000);
  assert.equal(row.partners[0].netWeightKg, 1200);
  assert.equal(row.partners.length + row.omittedCount, 7);
  // A product with no World weight states null, never an absent key.
  assert.equal(toPartnersProduct({ ...product, worldNetWeightKg: undefined }).worldNetWeightKg, null);
});

test('world exports keep one entry per heading', () => {
  const headings = groupWorldExports([
    { cmdCode: '2804', reporterCode: '156', partnerCode: '0', primaryValue: 100, year: 2024, netWeightKg: null },
    { cmdCode: '2709', reporterCode: '842', partnerCode: '0', primaryValue: 900, year: 2024, netWeightKg: null },
    // No reporter code: nothing to rank, and a '' key would collide.
    { cmdCode: '2709', partnerCode: '0', primaryValue: 5, year: 2024, netWeightKg: null },
  ]);
  assert.deepEqual(Object.keys(headings).sort(), ['2709', '2804']);
  assert.deepEqual(headings['2709'].exporters.map(e => e.reporterCode), [842]);
});
