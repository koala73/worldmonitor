import assert from 'node:assert/strict';
import test from 'node:test';
import { chinaSummaryState, toObservedDate } from '../src/app/china-summary-state';

const signal = (stale: boolean) => ({
  label: 'label',
  value: 'value',
  source: 'source',
  stale,
});

test('chinaSummaryState reports unavailable for an empty group', () => {
  assert.equal(chinaSummaryState([], 2), 'unavailable');
});

test('chinaSummaryState reports stale when every signal is stale', () => {
  assert.equal(chinaSummaryState([signal(true)], 1), 'stale');
  assert.equal(chinaSummaryState([signal(true), signal(true)], 2), 'stale');
});

test('chinaSummaryState reports partial when signals are missing', () => {
  assert.equal(chinaSummaryState([signal(false)], 2), 'partial');
  assert.equal(chinaSummaryState([signal(false), signal(false)], 3), 'partial');
});

test('chinaSummaryState reports partial when some (but not all) signals are stale', () => {
  assert.equal(chinaSummaryState([signal(false), signal(true)], 2), 'partial');
});

test('chinaSummaryState reports available only for a full complement of fresh signals', () => {
  assert.equal(chinaSummaryState([signal(false), signal(false)], 2), 'available');
});

test('toObservedDate trims retrieval timestamps to the date but preserves source dates', () => {
  assert.equal(toObservedDate('2026-07-14T09:31:22.123Z'), '2026-07-14');
  assert.equal(toObservedDate('2026-06'), '2026-06');
  assert.equal(toObservedDate('2025-Q4'), '2025-Q4');
  assert.equal(toObservedDate('2026'), '2026');
});
