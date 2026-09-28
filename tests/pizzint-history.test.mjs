import assert from 'node:assert/strict';
import { test } from 'node:test';
import history from '../scripts/shared/pizzint-history.cjs';

const { buildPizzintHistoryWrite, decodePizzintHistoryRecord, evaluatePizzintHistory, SUSPECT_ZERO_MIN_BASELINE } = history;

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

// The archive must not inherit the DEFCON scorer's dead-sensor inference.
// scorePizzintLocations runs one line before recordPizzintHistory and stamps
// noLiveSignal on any open venue reading 0 against a forecast >= 20, so reusing
// that field destroyed exactly the genuine zeros an empirical baseline needs.
test('archives a genuine zero even when the caller marked it noLiveSignal', () => {
  const capturedAt = '2026-06-10T18:05:00.000Z';
  const write = buildPizzintHistoryWrite({
    provider: 'pizzint', capturedAt, locations: [{
      placeId: 'venue-a', currentPopularity: 0, forecastPopularity: 40,
      dataFreshness: 'DATA_FRESHNESS_FRESH', isClosedNow: false, recordedAt: capturedAt,
      // Both fields are set by the relay's scorer. The archive must ignore them.
      noLiveSignal: true, hasBaseline: true,
    }],
  });
  const decoded = decodePizzintHistoryRecord(write.records[0].value);
  assert.equal(decoded.quality, 'available', 'an empty venue is an observation, not a missing reading');
  assert.equal(decoded.live, 0);
  assert.equal(decoded.providerForecast, 40);
  assert.equal(decoded.suspectZero, true, 'the doubt is recorded, not acted on');
});

test('classifies each zero-reading shape by what the provider returned', () => {
  const capturedAt = '2026-06-10T18:05:00.000Z';
  const at = (extra) => decodePizzintHistoryRecord(buildPizzintHistoryWrite({
    provider: 'pizzint', capturedAt, locations: [{
      placeId: 'venue-a', dataFreshness: 'DATA_FRESHNESS_FRESH', isClosedNow: false,
      recordedAt: capturedAt, ...extra,
    }],
  }).records[0].value);

  const quiet = at({ currentPopularity: 0, forecastPopularity: 5 });
  assert.equal(quiet.quality, 'available');
  assert.equal(quiet.suspectZero, false, 'a zero below the baseline floor is unremarkable');

  // A 0/0 ratio is an absent baseline, not a baseline of zero. The reading is
  // still usable: the archive is building its own baseline, not reusing theirs.
  const noBaseline = at({ currentPopularity: 0, forecastPopularity: 0 });
  assert.equal(noBaseline.quality, 'available');
  assert.equal(noBaseline.live, 0);
  assert.equal(noBaseline.providerForecast, null);
  assert.equal(noBaseline.suspectZero, false);

  // No number at all is the only genuine "missing".
  assert.equal(at({ currentPopularity: null, forecastPopularity: 40 }).quality, 'missing');
  assert.equal(at({ forecastPopularity: 40 }).quality, 'missing');
  assert.equal(at({ currentPopularity: -1, forecastPopularity: 40 }).quality, 'missing');
  assert.equal(at({ currentPopularity: 0, forecastPopularity: 40, isClosedNow: true }).quality, 'closed');
});

test('withholds suspect zeros by default but keeps them recoverable', () => {
  // One venue-hour, 12 same-weekday dates, truly empty half the time.
  const records = [];
  for (let week = 0; week < 12; week++) {
    const iso = new Date(Date.parse('2026-06-03T18:05:00.000Z') + week * 7 * 86400000).toISOString();
    records.push(row(iso, week % 2 ? 40 : 0, { providerForecast: 40 }));
  }
  const options = { asOf: '2026-08-25T00:00:00.000Z', days: 90 };

  const withheld = evaluatePizzintHistory(records, options);
  const a = withheld.cohorts[0];
  assert.equal(a.status, 'ready');
  assert.equal(a.baseline, 40, 'default policy still matches the live index');
  assert.equal(a.suspectZeroCount, 6, 'but the withholding is disclosed per cohort');
  assert.equal(a.observationCount, 6);
  assert.equal(withheld.exclusions.suspect_zero, 6, 'counted apart from outages');
  assert.equal(withheld.exclusions.unavailable_quality, 0);
  assert.equal(withheld.provenance.suspectZeroPolicy, 'withheld');
  assert.equal(
    withheld.counts.included + withheld.counts.excluded, withheld.counts.input,
    'every input is still accounted for',
  );

  const included = evaluatePizzintHistory(records, { ...options, includeSuspectZeros: true });
  const b = included.cohorts[0];
  assert.equal(b.baseline, 20, 'the same stored records answer the other policy');
  assert.equal(b.suspectZeroCount, 0);
  assert.equal(b.observationCount, 12);
  assert.equal(included.provenance.suspectZeroPolicy, 'included');
});

test('a venue-hour that is entirely suspect zeros still appears in the report', () => {
  const records = [];
  for (let week = 0; week < 8; week++) {
    const iso = new Date(Date.parse('2026-06-03T18:05:00.000Z') + week * 7 * 86400000).toISOString();
    records.push(row(iso, 0, { providerForecast: 40 }));
  }
  const report = evaluatePizzintHistory(records, { asOf: '2026-08-25T00:00:00.000Z', days: 90 });
  assert.equal(report.cohorts.length, 1, 'suppressing every reading must not hide the venue-hour');
  assert.equal(report.cohorts[0].observationCount, 0);
  assert.equal(report.cohorts[0].suspectZeroCount, 8);
  assert.equal(report.cohorts[0].baseline, null);
  assert.equal(report.cohorts[0].status, 'insufficient_history');
});

test('the suspect-zero baseline floor is exact and published in the report', () => {
  const capturedAt = '2026-06-10T18:05:00.000Z';
  const suspectAt = (forecastPopularity) => decodePizzintHistoryRecord(buildPizzintHistoryWrite({
    provider: 'pizzint', capturedAt, locations: [{
      placeId: 'venue-a', currentPopularity: 0, forecastPopularity,
      dataFreshness: 'DATA_FRESHNESS_FRESH', isClosedNow: false, recordedAt: capturedAt,
    }],
  }).records[0].value).suspectZero;

  assert.equal(SUSPECT_ZERO_MIN_BASELINE, 20);
  assert.equal(suspectAt(SUSPECT_ZERO_MIN_BASELINE - 1), false, 'just below the floor is a plain zero');
  assert.equal(suspectAt(SUSPECT_ZERO_MIN_BASELINE), true, 'the floor itself is suspect');
  assert.equal(
    evaluatePizzintHistory([], { asOf: capturedAt }).provenance.suspectZeroMinBaseline,
    SUSPECT_ZERO_MIN_BASELINE,
    'the report states the threshold that produced it',
  );
});
