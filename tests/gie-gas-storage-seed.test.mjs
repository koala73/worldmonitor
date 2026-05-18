// Tests for scripts/seed-gie-gas-storage.mjs (EU AGSI+ aggregate).
//
// Regression target: the previously-stringified `seededAt` (e.g.
// "1715990400000") was unparseable by Date.parse(), and the payload's
// `updatedAt` field carries the GIE *data date* — not the fetch time. The
// regional-snapshot freshness classifier
// (scripts/regional-snapshot/freshness.mjs::extractTimestamp) therefore
// resolved the timestamp to the data date, which lags 24–72h every weekend
// when GIE doesn't publish. Under #3728's tighter freshness gate that
// flipped the input to STALE even on the same minute as a successful seed
// run. The fix emits a numeric `fetchedAt` (canonical first-priority field)
// and an ISO `seededAt` so the classifier resolves real fetch time.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildEuGasStoragePayload } from '../scripts/seed-gie-gas-storage.mjs';
import { classifyInputs } from '../scripts/regional-snapshot/freshness.mjs';

function makeEntries(today = '2024-05-20', yesterday = '2024-05-19') {
  return [
    { gasDayStart: today, full: '62.4', gasInStorage: '720.5' },
    { gasDayStart: yesterday, full: '61.9', gasInStorage: '714.0' },
  ];
}

describe('buildEuGasStoragePayload — freshness fields (#3728 latent bug)', () => {
  it('emits seededAt as a Date.parse()-able ISO string close to now', () => {
    const before = Date.now();
    const payload = buildEuGasStoragePayload(makeEntries());
    const after = Date.now();

    assert.equal(typeof payload.seededAt, 'string',
      'seededAt must be a string (ISO), not a stringified epoch');
    const parsed = Date.parse(payload.seededAt);
    assert.ok(Number.isFinite(parsed),
      `Date.parse(seededAt=${payload.seededAt}) must be finite — the legacy ` +
      'String(Date.now()) shape returns NaN here');
    // Within 5s of the wall clock at construction time — proves it is real
    // fetch time, not the GIE data date.
    assert.ok(parsed >= before - 5_000 && parsed <= after + 5_000,
      `seededAt (${parsed}) must be within 5s of now (${before}..${after})`);
  });

  it('emits fetchedAt as numeric epoch ms close to now', () => {
    // fetchedAt is the field extractTimestamp checks FIRST. Without it on
    // the payload, the classifier would fall to updatedAt (the data date),
    // which lags by 24–72h every weekend.
    const before = Date.now();
    const payload = buildEuGasStoragePayload(makeEntries());
    const after = Date.now();

    assert.equal(typeof payload.fetchedAt, 'number');
    assert.ok(Number.isFinite(payload.fetchedAt));
    assert.ok(payload.fetchedAt >= before && payload.fetchedAt <= after,
      `fetchedAt (${payload.fetchedAt}) must be within the build window ` +
      `(${before}..${after})`);
  });

  it('classifies as fresh through the regional-snapshot classifier even on a stale data date', () => {
    // End-to-end proof: take the actual production classifier and feed it
    // the payload. The 5-day-old `updatedAt` ("2024-05-20" vs. today)
    // would otherwise dominate and produce STALE for this key (maxAgeMin
    // = 2880 = 48h).
    const payload = buildEuGasStoragePayload(makeEntries('2024-05-20', '2024-05-19'));
    const { fresh, stale, missing } = classifyInputs({
      'economic:eu-gas-storage:v1': payload,
    });
    assert.ok(fresh.includes('economic:eu-gas-storage:v1'),
      `payload must classify FRESH; got fresh=${JSON.stringify(fresh)} ` +
      `stale=${JSON.stringify(stale)} missing=${JSON.stringify(missing)}`);
    assert.ok(!stale.includes('economic:eu-gas-storage:v1'));
  });
});

describe('buildEuGasStoragePayload — shape and derivations', () => {
  it('throws when entries is empty', () => {
    assert.throws(() => buildEuGasStoragePayload([]), /empty data array/);
  });

  it('throws when entries is not an array', () => {
    assert.throws(() => buildEuGasStoragePayload(null), /empty data array/);
  });

  it('throws on out-of-range fillPct', () => {
    assert.throws(
      () => buildEuGasStoragePayload([{ gasDayStart: '2024-05-20', full: '120' }]),
      /invalid fillPct/,
    );
    assert.throws(
      () => buildEuGasStoragePayload([{ gasDayStart: '2024-05-20', full: '0' }]),
      /invalid fillPct/,
    );
  });

  it('sorts entries by gasDayStart descending and picks the most recent', () => {
    const out = buildEuGasStoragePayload([
      { gasDayStart: '2024-05-18', full: '60.0', gasInStorage: '700' },
      { gasDayStart: '2024-05-20', full: '62.5', gasInStorage: '720' },
      { gasDayStart: '2024-05-19', full: '61.0', gasInStorage: '710' },
    ]);
    assert.equal(out.updatedAt, '2024-05-20');
    assert.equal(out.fillPct, 62.5);
    assert.equal(out.history[0].date, '2024-05-20');
  });

  it('derives trend from 1d change', () => {
    const inj = buildEuGasStoragePayload([
      { gasDayStart: '2024-05-20', full: '62.5' },
      { gasDayStart: '2024-05-19', full: '62.0' },
    ]);
    assert.equal(inj.trend, 'injecting');

    const wd = buildEuGasStoragePayload([
      { gasDayStart: '2024-05-20', full: '60.0' },
      { gasDayStart: '2024-05-19', full: '62.0' },
    ]);
    assert.equal(wd.trend, 'withdrawing');

    const stable = buildEuGasStoragePayload([
      { gasDayStart: '2024-05-20', full: '62.0' },
      { gasDayStart: '2024-05-19', full: '62.0' },
    ]);
    assert.equal(stable.trend, 'stable');
  });

  it('does not mutate the caller-provided entries array', () => {
    const entries = [
      { gasDayStart: '2024-05-18', full: '60' },
      { gasDayStart: '2024-05-20', full: '62' },
    ];
    const snapshot = entries.map((e) => ({ ...e }));
    buildEuGasStoragePayload(entries);
    assert.deepEqual(entries, snapshot,
      'buildEuGasStoragePayload must not sort the caller array in place');
  });
});
