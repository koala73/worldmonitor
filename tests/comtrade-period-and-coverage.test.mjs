// Regression coverage for the PR #5641 review follow-ups.
//
// The original fix pinned ONE annual period. That restored the feed but left
// two ways for a reporter to silently vanish again — it files later than
// (y-2), or the UTC year rolls over — plus no way for an operator to tell a
// 3-of-197 run from a 197-of-197 one. These tests pin the behaviour, not the
// constants: each asserts an outcome or a relationship that a wrong value
// would break, rather than re-stating a literal from the source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  candidatePeriods,
  periodWindow,
  recentPeriod,
} from '../scripts/shared/comtrade-period.mjs';
import {
  periodCandidates,
  coverageStatus,
  groupByProduct,
  MIN_COUNTRY_COVERAGE,
  recentPeriod as seederRecentPeriod,
} from '../scripts/seed-comtrade-bilateral-hs4.mjs';
import { recentPeriod as flowsRecentPeriod } from '../scripts/seed-trade-flows.mjs';

const root = join(import.meta.dirname, '..');

// --- period arithmetic ------------------------------------------------------

test('recentPeriod: pins y-2 and rolls forward exactly at the UTC year boundary', () => {
  assert.equal(recentPeriod(new Date('2026-07-26T00:00:00Z')), '2024');
  assert.equal(recentPeriod(new Date('2026-12-31T23:59:59Z')), '2024');
  assert.equal(recentPeriod(new Date('2027-01-01T00:00:00Z')), '2025');
  assert.equal(recentPeriod(new Date('2027-01-01T00:00:00Z'), 3), '2024');
});

test('candidatePeriods: offers an older fallback for single-period endpoints', () => {
  assert.deepEqual(candidatePeriods(new Date('2026-07-26T00:00:00Z')), ['2024', '2023']);
});

test('periodWindow: keeps older years reachable across the year rollover', () => {
  // The whole point of the window: on Jan 1 the freshest year rolls to one
  // almost nobody has filed, but the request still carries the years that ARE
  // filed. A single pinned period cannot do this, which is the late-reporter /
  // New-Year drop the review flagged.
  const beforeRollover = periodWindow(new Date('2026-12-31T23:59:59Z')).split(',');
  const afterRollover = periodWindow(new Date('2027-01-01T00:00:00Z')).split(',');

  assert.equal(beforeRollover[0], '2024');
  assert.equal(afterRollover[0], '2025');
  // A reporter whose newest filing is 2023 survives the rollover.
  assert.ok(afterRollover.includes('2023'), `expected 2023 to remain in ${afterRollover}`);
  assert.ok(afterRollover.length >= 4, 'window must span enough years to cover late filers');
});

test('the three Comtrade consumers share ONE recentPeriod implementation', () => {
  // Identity, not equality: if any consumer reintroduces its own copy this
  // fails, which is what let seed-trade-flows.mjs carry a year-boundary
  // fallback the other two silently lacked.
  assert.equal(seederRecentPeriod, recentPeriod, 'bilateral seeder must reuse the shared helper');
  assert.equal(flowsRecentPeriod, recentPeriod, 'trade-flows must reuse the shared helper');
});

// --- route-dependent period selection ---------------------------------------

test('periodCandidates: the public preview route retries SINGLE years in sequence', () => {
  // That route answers HTTP 400 to a comma-separated period (probed
  // 2026-07-26), so it cannot use a window — it falls back sequentially, and
  // the per-country loop plus REQUEST_BUDGET bound the doubled request cost.
  const periods = periodCandidates(true, new Date('2026-07-26T00:00:00Z'));

  assert.deepEqual(periods, ['2024', '2023']);
  assert.ok(periods.every(p => !p.includes(',')), 'preview route cannot take a period list');
});

test('periodCandidates: the authenticated route covers the years in ONE request', () => {
  // Verified against the live authenticated endpoint 2026-07-26: a 4-year
  // comma list returns HTTP 200 with rows spanning all four periods. One entry
  // means the fallback loop runs once, so no reporter costs extra quota.
  const periods = periodCandidates(false, new Date('2026-07-26T00:00:00Z'));

  assert.equal(periods.length, 1, 'a window needs no second round trip');
  assert.deepEqual(periods[0].split(','), ['2024', '2023', '2022', '2021']);
});

test('periodCandidates: the two routes never get the same strategy', () => {
  // Pins the branch itself. The live value resolves at import from the
  // environment, so a test process only ever exercises one side; inverting the
  // branch in place previously left every test green.
  const now = new Date('2026-07-26T00:00:00Z');
  assert.notDeepEqual(periodCandidates(true, now), periodCandidates(false, now));
});

// --- multi-year aggregation safety -----------------------------------------

test('groupByProduct: newest year wins, even when an older year has a bigger value', () => {
  // Guards the hazard the window introduces. Before the fix this compared on
  // value alone, so a larger 2021 number would outrank the real 2024 figure
  // and the snapshot would silently blend years.
  const products = groupByProduct([
    { cmdCode: '2709', partnerCode: '156', primaryValue: 999, year: 2021 },
    { cmdCode: '2709', partnerCode: '156', primaryValue: 100, year: 2024 },
  ]);

  assert.equal(products.length, 1);
  assert.equal(products[0].year, 2024);
  assert.equal(products[0].topExporters[0].value, 100, 'must take the 2024 figure, not the larger 2021 one');
});

test('groupByProduct: within one year the larger value still wins', () => {
  const products = groupByProduct([
    { cmdCode: '2709', partnerCode: '156', primaryValue: 100, year: 2024 },
    { cmdCode: '2709', partnerCode: '156', primaryValue: 900, year: 2024 },
  ]);

  assert.equal(products[0].topExporters[0].value, 900);
});

test('groupByProduct: a partner absent from the newest year is excluded, not blended', () => {
  // The cross-partner half of the hazard, and the one that survived the first
  // attempt at this fix. Deduping newest-year-per-partner is not enough: a
  // lapsed relationship (traded in 2021, nothing since) would otherwise be
  // summed into totalValue and ranked into topExporters, taking most of the
  // "share" of a snapshot labelled 2024 — a year it did not trade in.
  const products = groupByProduct([
    { cmdCode: '2709', partnerCode: '156', primaryValue: 100, year: 2024 },
    { cmdCode: '2709', partnerCode: '643', primaryValue: 900, year: 2021 },
  ]);

  assert.equal(products.length, 1);
  assert.equal(products[0].year, 2024);
  assert.equal(products[0].totalValue, 100, 'the 2021 partner must not inflate the 2024 total');
  assert.deepEqual(products[0].topExporters.map(e => e.partnerCode), [156]);
  assert.equal(products[0].topExporters[0].share, 1);
});

test('groupByProduct: a late filer keeps every partner at its own newest year', () => {
  // The mirror case — the filter must not punish a reporter whose whole
  // filing sits at an older year. All rows share 2022, so 2022 IS the max.
  const products = groupByProduct([
    { cmdCode: '8542', partnerCode: '156', primaryValue: 300, year: 2022 },
    { cmdCode: '8542', partnerCode: '410', primaryValue: 200, year: 2022 },
  ]);

  assert.equal(products[0].year, 2022);
  assert.equal(products[0].totalValue, 500);
  assert.equal(products[0].topExporters.length, 2);
});

test('groupByProduct: several products x partners x years stay separated', () => {
  const products = groupByProduct([
    { cmdCode: '2709', partnerCode: '156', primaryValue: 10, year: 2024 },
    { cmdCode: '2709', partnerCode: '643', primaryValue: 99, year: 2021 },
    { cmdCode: '8542', partnerCode: '410', primaryValue: 40, year: 2023 },
    { cmdCode: '8542', partnerCode: '156', primaryValue: 60, year: 2023 },
    { cmdCode: '8542', partnerCode: '392', primaryValue: 77, year: 2022 },
  ]);

  const byHs4 = Object.fromEntries(products.map(p => [p.hs4, p]));
  assert.equal(byHs4['2709'].totalValue, 10, '2021 partner excluded from the 2024 product');
  assert.equal(byHs4['8542'].year, 2023);
  assert.equal(byHs4['8542'].totalValue, 100, 'only the two 2023 partners count');
  assert.deepEqual(byHs4['8542'].topExporters.map(e => e.partnerCode), [156, 410]);
});

test('groupByProduct: records with no usable year do not produce -Infinity', () => {
  // parseRecords writes year: 0 when the response carries neither period nor
  // refYear. Math.max(...[]) is -Infinity, which is truthy, so a `|| fallback`
  // would pass it straight through and JSON.stringify would emit null.
  const products = groupByProduct([
    { cmdCode: '2709', partnerCode: '156', primaryValue: 100, year: 0 },
  ]);

  assert.equal(products.length, 1);
  assert.ok(Number.isFinite(products[0].year), `year must be finite, got ${products[0].year}`);
  assert.equal(JSON.parse(JSON.stringify(products[0])).year, products[0].year);
});

// --- coverage floor ---------------------------------------------------------

test('coverageStatus: truth table around the floor', () => {
  assert.equal(coverageStatus(MIN_COUNTRY_COVERAGE), 'ok');
  assert.equal(coverageStatus(MIN_COUNTRY_COVERAGE + 1), 'ok');
  assert.equal(coverageStatus(MIN_COUNTRY_COVERAGE - 1), 'partial');
  // The exact shape of the outage this PR fixes: a run that "succeeds" having
  // written nothing must never report ok.
  assert.equal(coverageStatus(0), 'partial');
});

test('the coverage floor is the same number in the seeder and both health registries', () => {
  const compactHealth = readFileSync(join(root, 'api', 'health.js'), 'utf8');
  const seedHealth = readFileSync(join(root, 'api', 'seed-health.js'), 'utf8');

  const healthFloor = compactHealth.match(
    /comtradeBilateralHs4:\s*\{[^}]*minRecordCount:\s*(\d+)/,
  );
  const seedFloor = seedHealth.match(
    /'comtrade:bilateral-hs4':\s*\{[^}]*minRecordCount:\s*(\d+)/,
  );

  assert.ok(healthFloor, 'api/health.js must declare minRecordCount for comtradeBilateralHs4');
  assert.ok(seedFloor, 'api/seed-health.js must declare minRecordCount for comtrade:bilateral-hs4');
  assert.equal(Number(healthFloor[1]), MIN_COUNTRY_COVERAGE);
  assert.equal(Number(seedFloor[1]), MIN_COUNTRY_COVERAGE);
});

test('the coverage floor stays below the country roster it is measured against', () => {
  // A floor at or above the roster size can never be met, which would pin
  // /api/health to a permanent COVERAGE_PARTIAL warn that no operator can clear.
  const clusters = JSON.parse(
    readFileSync(join(root, 'scripts', 'shared', 'country-port-clusters.json'), 'utf8'),
  );
  const roster = Object.keys(clusters).filter(k => k !== '_comment' && k.length === 2).length;

  assert.ok(roster > 0, 'roster must be non-empty');
  assert.ok(
    MIN_COUNTRY_COVERAGE < roster,
    `floor ${MIN_COUNTRY_COVERAGE} must stay under the ${roster}-country roster`,
  );
});
