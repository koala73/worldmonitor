import assert from 'node:assert/strict';
import { test } from 'node:test';
import history from '../scripts/shared/pizzint-history.cjs';

const { buildPizzintHistoryWrite, decodePizzintHistoryRecord, evaluatePizzintHistory } = history;

function row(date, live, extra = {}) {
  return {
    version: 1, provider: 'pizzint', placeId: 'venue-a', capturedAt: date,
    sourceRecordedAt: date, live, providerForecast: 20, quality: 'available',
    sourceClock: 'provider', ...extra,
  };
}

test('builds one bounded UTC-bucket write with no address data', () => {
  const write = buildPizzintHistoryWrite({
    provider: 'besttime', capturedAt: '2026-09-28T23:59:01.000Z', locations: [{
      placeId: 'venue-a', currentPopularity: 0, forecastPopularity: 40,
      dataFreshness: 'DATA_FRESHNESS_FRESH', isClosedNow: false, noLiveSignal: false,
      name: 'secret name', address: 'secret address', recordedAt: 'invented poll time',
    }],
  });
  assert.equal(write.keys[0], 'intelligence:pizzint:history:v1:besttime:2026-09-28');
  assert.equal(write.records.length, 1);
  assert.match(write.records[0].field, /^venue-a\|2026-09-28T23:50Z$/);
  const decoded = decodePizzintHistoryRecord(write.records[0].value);
  assert.equal(decoded.live, 0);
  assert.equal(decoded.sourceRecordedAt, null);
  assert.equal(decoded.sourceClock, 'collection');
  assert.doesNotMatch(write.records[0].value, /secret/);
});

test('rejects unbounded polls and invalid record fields', () => {
  assert.throws(() => buildPizzintHistoryWrite({ provider: 'pizzint', capturedAt: new Date().toISOString(), locations: Array.from({ length: 25 }, (_, i) => ({ placeId: `v${i}` })) }), /at most 24/);
  assert.throws(() => decodePizzintHistoryRecord('{"v":1,"p":"pizzint"}'), /invalid history record/);
});

test('uses date medians, needs six dates, permits zero, and ignores forecasts', () => {
  const records = [];
  for (const [index, date] of ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06'].entries()) {
    records.push(row(`${date}T14:05:00.000Z`, index === 5 ? 100 : 0, { providerForecast: null }));
    records.push(row(`${date}T14:15:00.000Z`, index === 5 ? 100 : 0, { providerForecast: null }));
  }
  const result = evaluatePizzintHistory(records, { asOf: '2026-07-20T14:30:00.000Z' });
  const cohort = result.cohorts.find((entry) => entry.provider === 'pizzint' && entry.placeId === 'venue-a' && entry.weekday === 1 && entry.hour === 10);
  assert.equal(cohort.status, 'ready');
  assert.equal(cohort.baseline, 0);
  assert.equal(cohort.mad, 0);
  assert.equal(cohort.dateCount, 6);
});

test('keeps providers separate and excludes current-date, future, stale, and duplicate source rows', () => {
  const records = [
    row('2026-09-21T14:00:00Z', 10),
    row('2026-09-21T14:00:00Z', 90, { capturedAt: '2026-09-21T14:09:00Z' }),
    row('2026-09-28T14:00:00Z', 20),
    row('2026-10-05T14:00:00Z', 30),
    row('2026-09-14T14:00:00Z', 40, { quality: 'stale' }),
    row('2026-09-07T14:00:00Z', 50, { provider: 'besttime', sourceRecordedAt: null, sourceClock: 'collection' }),
  ];
  const result = evaluatePizzintHistory(records, { asOf: '2026-09-28T15:00:00Z' });
  assert.deepEqual(result.counts, { input: 6, included: 2, excluded: 4 });
  assert.equal(result.exclusions.duplicate_source_time, 1);
  assert.equal(result.cohorts.length, 2);
  assert.ok(result.cohorts.every((entry) => entry.status === 'insufficient_history'));
});

test('uses New York DST cohorts and exact 90-day read retention', () => {
  const result = evaluatePizzintHistory([
    row('2026-03-02T15:00:00Z', 10),
    row('2026-03-09T14:00:00Z', 20),
    row('2025-12-01T15:00:00Z', 30),
  ], { asOf: '2026-03-16T15:00:00Z' });
  assert.equal(result.cohorts.length, 1);
  assert.equal(result.cohorts[0].hour, 10);
  assert.equal(result.exclusions.outside_retention, 1);
});

test('rejects malformed expanded numeric values and clock provenance', () => {
  for (const extra of [{ sourceClock: 'invented' }, { providerForecast: '20' }, { live: '10' }]) {
    const result = evaluatePizzintHistory([row('2026-09-21T14:00:00Z', 10, extra)], { asOf: '2026-09-28T15:00:00Z' });
    assert.equal(result.exclusions.invalid, 1);
  }
});

test('duplicate source timestamps use the earliest capture independent of input order', () => {
  const records = [row('2026-09-21T14:00:00Z', 10), row('2026-09-21T14:00:00Z', 90, { capturedAt: '2026-09-21T14:09:00Z' })];
  const options = { asOf: '2026-09-28T15:00:00Z' };
  assert.deepEqual(evaluatePizzintHistory(records, options), evaluatePizzintHistory([...records].reverse(), options));
  assert.equal(evaluatePizzintHistory(records, options).cohorts[0].daily[0].median, 10);
});

test('each date has equal weight despite uneven sampling', () => {
  const records = ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29'].map((date) => row(`${date}T14:05:00Z`, 10));
  for (let minute = 0; minute < 50; minute++) records.push(row(`2026-07-06T14:${String(minute).padStart(2, '0')}:00Z`, 100));
  const result = evaluatePizzintHistory(records, { asOf: '2026-07-20T14:30:00Z' });
  assert.equal(result.cohorts[0].baseline, 10);
  assert.equal(result.cohorts[0].dateCount, 6);
});
