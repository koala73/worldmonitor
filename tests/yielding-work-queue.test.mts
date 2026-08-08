import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createYieldingWorkQueue } from '@/utils/yielding-work-queue';

test('serializes work behind a cooperative yield', async () => {
  const starts: string[] = [];
  let active = 0;
  let maxActive = 0;
  let yields = 0;
  const enqueue = createYieldingWorkQueue(async () => { yields += 1; });

  await Promise.all([
    enqueue(async () => {
      starts.push('first');
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    }),
    enqueue(async () => {
      starts.push('second');
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    }),
  ]);

  assert.deepEqual(starts, ['first', 'second']);
  assert.equal(maxActive, 1);
  assert.equal(yields, 2);
});

test('continues after a rejected item', async () => {
  const enqueue = createYieldingWorkQueue(async () => {});
  await assert.rejects(enqueue(async () => { throw new Error('expected'); }));
  assert.equal(await enqueue(() => 'next'), 'next');
});
