import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveGridClock, GRID_CLOCK_MAX_AGE_MS, isGridClockSnapshot } from '../shared/grid-disruption-clock.js';
import reports from './fixtures/grid-clock/reports.json' with { type: 'json' };

const time = Date.parse;
const dayMs = 24 * 60 * 60_000;
const california = { code: 'CA', current: null, history: [], warnings: [], warningSources: [], warningsCheckedAt: null };
const tennessee = { ...california, code: 'TN' };

// Fixtures retain the publication time (when known) separately from the observation.
// Supplemental geographies exercise the same derivation without adding live coverage.
function point(sourceUrl, observedAt, customersOut, coverageLabel, extra = {}) {
  return {
    sourceUrl, observedAt: time(observedAt), customersOut, coverageLabel, coverageKey: coverageLabel,
    sourceName: 'U.S. Department of Energy', customersTracked: null, ...extra,
  };
}

function warningRegion(report, kind, sourceName, checkedAt) {
  const publisher = { kind, sourceName, sourceUrl: report.notice };
  return {
    ...california,
    warnings: [{ ...publisher, title: report.title, issuedAt: time(report.noticeIssued), expiresAt: time(report.noticeExpires) }],
    warningSources: [{ ...publisher, status: 'available', checkedAt }],
    warningsCheckedAt: checkedAt,
  };
}

test('California heat emergency: a grid notice opens a watch without asserting statewide customer loss', () => {
  const report = reports.california;
  const now = time(report.noticeIssued);
  const region = warningRegion(report, 'grid', 'California ISO', now);
  const reading = deriveGridClock(region, now);
  assert.equal(reading.phase, 'watch');
  assert.equal(reading.activeWarnings[0].kind, 'grid');
  assert.equal(reading.freshness, 'unavailable');
  assert.equal(reading.changeCustomers, null);
});

test('Gannon G5: a verified geomagnetic warning does not promote the hazard into an electric outage', () => {
  const { gannon } = reports;
  const now = time(gannon.atG5Publication);
  const region = warningRegion(gannon, 'space-weather', 'NOAA SWPC', now);
  const reading = deriveGridClock(region, now);
  assert.equal(reading.phase, 'watch');
  assert.equal(reading.activeWarnings.length, 1);
  assert.equal(reading.changeCustomers, null);
  assert.equal(deriveGridClock(region, time(gannon.noticeExpires)).phase, 'unknown');
});

test('Puerto Rico on Maria day 91: restored load supports partial recovery with unknown customer count', () => {
  const report = reports.maria;
  const published = time(report.published);
  assert.equal(Math.floor((published - time(report.landfall)) / dayMs), 91);
  const current = point(report.source, report.summaryAsOf, report.customersOut, report.coverage, {
    peakLoadRestoredPct: report.peakLoadRestoredPct,
    detail: `${report.partiallyEnergizedMunicipalities} of ${report.totalMunicipalities} municipalities at least partly energized.`,
  });
  const reading = deriveGridClock({ ...california, code: 'PR', current }, published);
  assert.equal(current.customersOut, null);
  assert.equal(reading.phase, 'recovering');
  assert.equal(reading.changeCustomers, null);
  assert.equal(deriveGridClock({ ...california, current }, published + dayMs).phase, 'unknown');
});

test('Tennessee through Helene: show the dated counts and preserve the unknown when the table drops TN', () => {
  const { helene } = reports;
  const readings = [];
  const history = [];
  for (const report of helene.reports) {
    const current = point(report.source, report.observed, report.customersOut, helene.coverage);
    const region = { ...tennessee, current, history: [...history] };
    assert.ok(isGridClockSnapshot({ regions: [california, region] }));
    const reading = deriveGridClock(region, time(report.published));
    readings.push([current.customersOut, reading.phase, reading.changeCustomers]);
    history.push(current);
  }
  assert.deepEqual(readings, [[17_260, 'disrupted', null], [10_628, 'disrupted', null], [null, 'unknown', null]]);
});

test('Texas winter storm: publish the observed partial-footprint count without a statewide denominator', () => {
  const report = reports.uri;
  const current = point(report.source, report.observed, report.customersOut, report.coverage);
  const reading = deriveGridClock({ ...tennessee, code: 'TX', current }, current.observedAt);
  assert.equal(current.customersOut, 3_341_984);
  assert.equal(current.customersTracked, null);
  assert.equal(reading.phase, 'disrupted');
  assert.equal(reading.changeCustomers, null);
});

test('Iberia: an operator-confirmed blackout can establish disruption with no customer count or precursor', () => {
  const report = reports.iberia;
  const current = point(report.source, report.observed, report.customersOut, report.coverage, {
    impact: 'disrupted', sourceName: 'ENTSO-E',
  });
  const region = { ...california, code: 'Iberia', current };
  assert.equal(deriveGridClock(region, current.observedAt - 1).phase, 'unknown');
  assert.equal(deriveGridClock(region, current.observedAt).phase, 'disrupted');
  assert.equal(current.customersOut, null);
});

const initial = point('https://example.org/report', '2026-11-13T00:00:00Z', 1_200, 'Participating utilities');
const previous = { ...initial, customersOut: 1_500, observedAt: initial.observedAt - 600_000 };

test('a numerical decrease is a net change over an identified interval, independent of an explicit restoration claim', () => {
  const region = { ...tennessee, current: initial, history: [previous, initial] };
  const reading = deriveGridClock(region, initial.observedAt);
  assert.equal(reading.phase, 'disrupted');
  assert.equal(reading.changeCustomers, -300);
  assert.equal(reading.comparisonAt, previous.observedAt);
  const restored = { ...initial, customersOut: 0, impact: 'restored' };
  assert.equal(deriveGridClock({ ...region, current: restored }, initial.observedAt).phase, 'restored');
});

test('coverages, gaps, old observations, equal timestamps and missing values break change calculations', () => {
  for (const observation of [
    { ...previous, coverageKey: 'different' }, { ...previous, customersTracked: 50_000 },
    { ...previous, partial: true },
    { ...previous, sourceName: 'Another publisher' }, { ...previous, customersOut: null },
    { ...previous, observedAt: initial.observedAt }, { ...previous, observedAt: initial.observedAt + 1 },
    { ...previous, observedAt: initial.observedAt - GRID_CLOCK_MAX_AGE_MS - 1 },
  ]) {
    assert.equal(deriveGridClock({ ...california, current: initial, history: [observation] }, initial.observedAt).changeCustomers, null);
  }
  const gap = { ...california, current: initial, history: [previous], lastImpactGapAt: previous.observedAt + 1 };
  assert.equal(deriveGridClock(gap, initial.observedAt).changeCustomers, null);
  assert.equal(deriveGridClock({ ...california, current: { ...initial, partial: true }, history: [previous] }, initial.observedAt).changeCustomers, null);
});

test('unknown, explicit zero, stale counts and partial warning coverage have distinct results', () => {
  const now = initial.observedAt;
  const weather = { kind: 'weather', sourceName: 'NWS', sourceUrl: 'https://weather.gov', status: 'available', checkedAt: now };
  const missing = { kind: 'grid', sourceName: 'California ISO', sourceUrl: 'https://caiso.com', status: 'unavailable', checkedAt: null };
  const zero = { ...california, current: { ...initial, customersOut: 0 }, warningsCheckedAt: now, warningSources: [weather] };
  assert.equal(deriveGridClock(zero, now).phase, 'monitoring');
  assert.equal(deriveGridClock({ ...zero, current: { ...zero.current, partial: true } }, now).phase, 'unknown');
  assert.equal(deriveGridClock({ ...zero, current: null }, now).phase, 'unknown');
  const stale = deriveGridClock(zero, now + GRID_CLOCK_MAX_AGE_MS + 1);
  assert.deepEqual([stale.phase, stale.freshness, stale.warningsFresh], ['unknown', 'stale', false]);
  const warning = { ...weather, issuedAt: now - 60_000, expiresAt: now + 60_000, title: 'Ice storm warning' };
  const partial = { ...zero, warningSources: [weather, missing], warningsCheckedAt: null, warnings: [warning] };
  const reading = deriveGridClock(partial, now);
  assert.equal(reading.phase, 'watch');
  assert.equal(reading.warningsFresh, false);
  assert.equal(deriveGridClock({ ...partial, warnings: [], recentWarnings: [warning] }, now).phase, 'unknown');
  assert.equal(deriveGridClock({ ...partial, warnings: [{ ...warning, kind: 'grid' }] }, now).phase, 'unknown');
});

test('wire validation rejects duplicate regions, unsafe source URLs and invalid counts', () => {
  assert.ok(isGridClockSnapshot({ regions: [california, tennessee] }));
  assert.equal(isGridClockSnapshot({ regions: [california, california] }), false);
  for (const current of [
    { ...initial, sourceUrl: 'javascript:alert(1)' }, { ...initial, sourceUrl: 'https://user:password@example.com' },
    { ...initial, customersOut: -1 }, { ...initial, customersOut: '0' }, { ...initial, customersTracked: 5 },
  ]) {
    assert.equal(isGridClockSnapshot({ regions: [{ ...california, current }, tennessee] }), false);
  }
});
