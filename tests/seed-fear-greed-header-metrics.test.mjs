import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aaiiHeaderMetrics } from '../scripts/seed-fear-greed.mjs';

test('AAII header metrics keep the survey decimal', () => {
  assert.deepEqual(aaiiHeaderMetrics({ bull: 33.3, bear: 42.2 }), {
    aaiBull: { value: 33.3, context: '33.3%' },
    aaiBear: { value: 42.2, context: '42.2%' },
  });
});

test('AAII header metrics are null when the survey is unavailable', () => {
  assert.deepEqual(aaiiHeaderMetrics(null), { aaiBull: null, aaiBear: null });
});
