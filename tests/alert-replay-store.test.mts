import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SortedSets } from './helpers/alert-replay-harness.mts';

function filled(count: number) {
  const store = new SortedSets();
  for (let i = 0; i < count; i++) store.run(['ZADD', 'k', String(i), `m${i}`]);
  return store;
}

test('the replay store trims by rank as Redis does when the stop lands before the start', () => {
  const store = filled(501);
  assert.equal(store.run(['ZREMRANGEBYRANK', 'k', 0, -1001]), 0);
  assert.equal((store.run(['ZRANGEBYSCORE', 'k', '-inf', '+inf']) as string[]).length, 501);
});

test('the replay store trims the oldest members past the cap', () => {
  const store = filled(1005);
  assert.equal(store.run(['ZREMRANGEBYRANK', 'k', 0, -1001]), 5);
  assert.deepEqual((store.run(['ZRANGEBYSCORE', 'k', '-inf', '+inf']) as string[]).slice(0, 1), ['m5']);
});
