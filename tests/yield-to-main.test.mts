import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { yieldToMain } from '../src/utils/after-paint.ts';

describe('yieldToMain', () => {
  it('returns a Promise', () => {
    const p = yieldToMain();
    assert.ok(p instanceof Promise);
    return p;
  });

  it('yields to the macrotask queue (resolves after an earlier-queued timer)', async () => {
    const order: string[] = [];
    setTimeout(() => order.push('earlier-timer'), 0);
    await yieldToMain();
    order.push('after-yield');
    // A microtask-based yield would resolve before the earlier setTimeout(0) fired.
    // yieldToMain is a macrotask (setTimeout(0)), so the earlier timer runs first.
    assert.deepEqual(order, ['earlier-timer', 'after-yield']);
  });

  it('can be awaited repeatedly in order', async () => {
    const order: number[] = [];
    await yieldToMain();
    order.push(1);
    await yieldToMain();
    order.push(2);
    assert.deepEqual(order, [1, 2]);
  });
});
