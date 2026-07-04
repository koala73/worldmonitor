import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { __resetForTest, measure, mutate } from '../src/utils/layout-batch.ts';

type RafCallback = (timestamp: number) => void;

function installRafHarness() {
  const savedRaf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const frames: RafCallback[] = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: RafCallback) => {
      frames.push(callback);
      return frames.length;
    },
  });
  return {
    get pendingFrames() {
      return frames.length;
    },
    runNextFrame: () => {
      const callback = frames.shift();
      assert.ok(callback, 'expected a queued animation frame');
      callback(0);
    },
    restore: () => {
      if (savedRaf) Object.defineProperty(globalThis, 'requestAnimationFrame', savedRaf);
      else delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    },
  };
}

describe('layout batch', () => {
  beforeEach(() => {
    __resetForTest();
  });
  it('runs all measures before mutates while preserving phase ordering', () => {
    const raf = installRafHarness();
    try {
      const order: string[] = [];
      mutate(() => order.push('mutate-1'));
      measure(() => order.push('measure-1'));
      mutate(() => order.push('mutate-2'));
      measure(() => order.push('measure-2'));

      assert.equal(raf.pendingFrames, 1, 'callbacks in the same turn coalesce behind one frame');
      raf.runNextFrame();

      assert.deepEqual(order, ['measure-1', 'measure-2', 'mutate-1', 'mutate-2']);
    } finally {
      raf.restore();
    }
  });

  it('runs callbacks queued during a measure in the same frame mutate phase', () => {
    const raf = installRafHarness();
    try {
      const order: string[] = [];
      measure(() => {
        order.push('measure-1');
        mutate(() => order.push('nested-mutate'));
      });
      mutate(() => order.push('mutate-1'));

      raf.runNextFrame();

      assert.deepEqual(order, ['measure-1', 'mutate-1', 'nested-mutate']);
      assert.equal(raf.pendingFrames, 0, 'nested mutates should not schedule a redundant follow-up frame');
    } finally {
      raf.restore();
    }
  });

  it('defers callbacks queued during a mutate to the next frame', () => {
    const raf = installRafHarness();
    try {
      const order: string[] = [];
      mutate(() => {
        order.push('mutate-1');
        measure(() => order.push('nested-measure'));
      });

      raf.runNextFrame();
      assert.deepEqual(order, ['mutate-1']);
      assert.equal(raf.pendingFrames, 1, 'nested measure schedules a follow-up frame');

      raf.runNextFrame();
      assert.deepEqual(order, ['mutate-1', 'nested-measure']);
    } finally {
      raf.restore();
    }
  });


  it('continues flushing other callbacks when one callback throws', () => {
    const raf = installRafHarness();
    const savedReportError = Object.getOwnPropertyDescriptor(globalThis, 'reportError');
    const errors: unknown[] = [];
    Object.defineProperty(globalThis, 'reportError', {
      configurable: true,
      value: (error: unknown) => {
        errors.push(error);
      },
    });
    try {
      const order: string[] = [];
      const error = new Error('measure failed');
      measure(() => {
        order.push('measure-before');
        throw error;
      });
      measure(() => order.push('measure-after'));
      mutate(() => order.push('mutate-after'));

      raf.runNextFrame();

      assert.deepEqual(order, ['measure-before', 'measure-after', 'mutate-after']);
      assert.deepEqual(errors, [error]);
    } finally {
      if (savedReportError) Object.defineProperty(globalThis, 'reportError', savedReportError);
      else delete (globalThis as { reportError?: unknown }).reportError;
      raf.restore();
    }
  });

  it('skips cancelled callbacks', () => {
    const raf = installRafHarness();
    try {
      const order: string[] = [];
      measure(() => order.push('measure-1'));
      const cancelMeasure = measure(() => order.push('cancelled-measure'));
      const cancelMutate = mutate(() => order.push('cancelled-mutate'));
      mutate(() => order.push('mutate-1'));
      cancelMeasure();
      cancelMutate();

      raf.runNextFrame();

      assert.deepEqual(order, ['measure-1', 'mutate-1']);
    } finally {
      raf.restore();
    }
  });

  it('falls back to a timer when animation frames are unavailable', async () => {
    const savedRaf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
    if (savedRaf) delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    try {
      const order: string[] = [];
      measure(() => order.push('measure'));
      mutate(() => order.push('mutate'));

      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.deepEqual(order, ['measure', 'mutate']);
    } finally {
      if (savedRaf) Object.defineProperty(globalThis, 'requestAnimationFrame', savedRaf);
    }
  });
});
