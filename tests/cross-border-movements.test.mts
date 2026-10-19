import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectCrossBorderSnapshots } from '../server/worldmonitor/displacement/v1/cross-border-data.ts';
const NOW = Date.parse('2026-10-19T00:00:00Z');
const envelope = (data: unknown, fetchedAt = NOW - 60_000) => ({ _seed: { fetchedAt }, data });
const uk = { routes: [{ id: 'english-channel', name: 'English Channel', kind: 'arrival', measure: 'daily', countryCode: 'GB', asOf: '2026-10-18', period: 'day', latestCount: 0, last7Days: 0, last30Days: 3000, surge: false, latitude: 51, longitude: 1 }] };
const odp = { situations: [{ id: 'sudan', name: 'Sudan', sourceUrl: 'https://data.unhcr.org/en/situations/sudansituation', origin: 'SD', asOf: '2026-10-18', flows: [{ kind: 'outflow', measure: 'stock', label: 'Refugees', total: 10, countries: [{ country: 'Chad', iso2: 'TD', date: '2026-01-01', individuals: 10 }] }] }], unavailable: [] };

test('one stale source cannot hide healthy explicitly reported zeros or change stock into arrivals', () => {
  const data = projectCrossBorderSnapshots({ odp: envelope(odp), uk: envelope(uk) }, NOW);
  assert.equal(data.dataAvailable, true);
  assert.equal(data.movements.length, 2);
  assert.equal(data.movements.find(r => r.kind === 'outflow')?.stale, true);
  assert.equal(data.movements.find(r => r.kind === 'arrival')?.count, 0);
  assert.equal(data.movements.find(r => r.kind === 'arrival')?.last30Days, 3000);
  assert.equal(data.sources.find(s => s.id === 'cbp')?.status, 'unavailable');
});

test('retained envelopes use original fetch and content clocks', () => {
  const data = projectCrossBorderSnapshots({ uk: envelope(uk, NOW - 3 * 86400000) }, NOW);
  assert.equal(data.movements[0]?.stale, true);
  assert.equal(data.sources.find(s => s.id === 'uk')?.status, 'stale');
  assert.equal(data.sources.find(s => s.id === 'uk')?.fetchedAt, NOW - 3 * 86400000);
});

test('unpublished sources are unavailable, not a confirmed zero', () => {
  const data = projectCrossBorderSnapshots({}, NOW);
  assert.equal(data.dataAvailable, false);
  assert.ok(data.sources.every(s => s.status === 'unavailable'));
  assert.deepEqual(data.movements, []);
});

test('malformed monthly rows cannot label a year-to-date total as a month or a surge', () => {
  const row = structuredClone(odp);
  Object.assign(row.situations[0]!.flows[0]!, { kind: 'arrival', measure: 'monthly' });
  Object.assign(row.situations[0]!.flows[0]!.countries[0]!, { date: '2026-10-18', accelerating: true });
  const data = projectCrossBorderSnapshots({ odp: envelope(row) }, NOW);
  assert.deepEqual(data.movements, []);
  assert.equal(data.sources[0]?.status, 'stale');
});

test('source-confirmed arrival surge expires with its report and never applies to stocks', () => {
  for (const patch of [{}, { asOf: '2026-01-01' }, { kind: 'outflow' }]) {
    const routes = [{ ...uk.routes[0], latestCount: 1500, last7Days: 7000, surge: true, ...patch }];
    const data = projectCrossBorderSnapshots({ uk: envelope({ routes }) }, NOW);
    assert.equal(data.movements[0]?.surge, Object.keys(patch).length === 0);
  }
});

test('a report on the final day completes that month while a mid-month report does not', () => {
  const source = structuredClone(odp);
  const country = source.situations[0]!.flows[0]!.countries[0]!;
  Object.assign(source.situations[0]!.flows[0]!, { kind: 'arrival', measure: 'monthly' });
  Object.assign(country, { date: '2026-09-30', individuals: 78128, months: [{ month: '2026-10', individuals: 349 }, { month: '2026-09', individuals: 12033 }, { month: '2026-08', individuals: 11676 }] });
  let result = projectCrossBorderSnapshots({ odp: envelope(source) }, NOW);
  assert.equal(result.movements[0]?.period, '2026-09');
  assert.equal(result.movements[0]?.count, 12033);
  country.date = '2026-09-06';
  result = projectCrossBorderSnapshots({ odp: envelope(source) }, NOW);
  assert.equal(result.movements[0]?.period, '2026-08');
});

test('stock deltas retain their original interval rather than becoming new arrivals', () => {
  const source = structuredClone(odp);
  Object.assign(source.situations[0]!.flows[0]!.countries[0]!, { date: '2026-10-18', change: { since: '2026-10-04', delta: 9126 } });
  const result = projectCrossBorderSnapshots({ odp: envelope(source) }, NOW);
  assert.equal(result.movements[0]?.stockChange, 9126);
  assert.equal(result.movements[0]?.stockChangeSince, '2026-10-04');
  assert.equal(result.movements[0]?.kind, 'outflow');
  assert.equal(result.movements[0]?.last7Days, undefined);
  assert.equal(result.movements[0]?.surge, false);
});
