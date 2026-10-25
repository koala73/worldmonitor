import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AsOfError, resolveAsOf } from '../server/_shared/as-of.ts';

const observations = [
  { observed_at: '2026-10-17T12:00:00Z', value: 20, formulaVersion: 'v1' },
  { observed_at: '2026-10-17T10:00:00Z', value: 10, formulaVersion: 'v0' },
  { observed_at: '2026-10-17T14:00:00Z', value: 30, formulaVersion: 'v2' },
];
const options = { granularity: 3_600_000, now: Date.parse('2026-10-18T00:00:00Z') };

describe('resolveAsOf history convention', () => {
  it('returns an exact observation with zero offset', () => {
    const result = resolveAsOf(observations, '2026-10-17T12:00:00Z', options);
    assert.equal(result.observation, observations[0]);
    assert.deepEqual(result.asOf, { requested: '2026-10-17T12:00:00Z', matchedObservedAt: '2026-10-17T12:00:00Z', matchOffsetSeconds: 0, formulaVersion: 'v1' });
  });
  it('finds the latest at-or-before row regardless of order, without interpolation', () => {
    const result = resolveAsOf(observations, '2026-10-17T13:30:00.500Z', options);
    assert.equal(result.observation.value, 20);
    assert.equal(result.asOf.matchOffsetSeconds, 5400.5);
    assert.equal(result.cacheAsOf, '2026-10-17T13:00:00.000Z');
    assert.equal('stale' in result, false);
    assert.deepEqual(observations.map(row => row.value), [20, 10, 30]);
  });
  it('floors equivalent requests to the observation granularity for cache identity', () => {
    const a = resolveAsOf(observations, '2026-10-17T12:00:01Z', options);
    const b = resolveAsOf(observations, '2026-10-17T12:59:59Z', options);
    assert.equal(a.cacheAsOf, b.cacheAsOf);
    assert.equal(a.asOf.requested, '2026-10-17T12:00:01Z');
    assert.equal(b.asOf.matchOffsetSeconds, 3599);
  });
  it('returns before_history_start and the earliest available observation', () => {
    assert.throws(() => resolveAsOf(observations, '2026-10-17T09:59:59Z', options), error => {
      assert.ok(error instanceof AsOfError);
      assert.equal(error.code, -32602);
      assert.deepEqual(error.data, { reason: 'before_history_start', historyStart: '2026-10-17T10:00:00Z' });
      return true;
    });
    assert.throws(() => resolveAsOf([], '2026-10-17T12:00:00Z', options), { data: { reason: 'before_history_start', historyStart: null } });
  });
  it('rejects a future request before granularity flooring could hide it', () => {
    assert.throws(() => resolveAsOf(observations, '2026-10-18T00:00:00.001Z', options), { code: -32602, data: { reason: 'as_of_in_future' } });
  });
  it('rejects invalid or non-UTC timestamps and invalid store granularity', () => {
    for (const asOf of ['bad', '2026-02-30T00:00:00Z', '2026-10-17', '2026-10-17T12:00:00+02:00']) {
      assert.throws(() => resolveAsOf(observations, asOf, options), { code: -32602, data: { reason: 'invalid_as_of' } });
    }
    for (const granularity of [0, -1, NaN, Infinity, 0.5]) {
      assert.throws(() => resolveAsOf(observations, '2026-10-17T12:00:00Z', { ...options, granularity }), RangeError);
    }
  });
  it('does not add a formula version to observations that do not have one', () => {
    const result = resolveAsOf([{ observed_at: '2026-10-17T12:00:00Z', value: 1 }], '2026-10-17T12:00:00Z', options);
    assert.equal('formulaVersion' in result.asOf, false);
  });
  it('rejects duplicate observation times in either input order', () => {
    const rows = [observations[0], { observed_at: '2026-10-17T12:00:00.000Z', value: 99, formulaVersion: 'v2' }];
    for (const history of [rows, [...rows].reverse()]) {
      assert.throws(() => resolveAsOf(history, '2026-10-17T13:00:00Z', options), {
        name: 'TypeError', message: 'History observations must have unique observed_at timestamps',
      });
    }
  });
  it('rejects an interval that would alias different observations into the same cache key', () => {
    const rows = [{ observed_at: '2026-10-17T12:30:00Z' }];
    assert.throws(() => resolveAsOf(rows, '2026-10-17T12:59:00Z', options), TypeError);
    assert.equal(resolveAsOf(rows, '2026-10-17T12:59:00Z', { ...options, granularity: 1 }).observation, rows[0]);
  });
});
