import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCountryHoverQueryController,
  resolveCountryForPointerInteraction,
  shouldRenderTradeAnimationFrame,
  shouldRunInputSensitiveMapWork,
  type CancelableFrameTask,
} from '@/components/map/input-delay-interactions';

function createManualFrameScheduler(): {
  scheduleFrame: (run: () => void) => CancelableFrameTask;
  flush: () => void;
  hasQueuedFrame: () => boolean;
} {
  let queued: (() => void) | null = null;
  return {
    scheduleFrame(run: () => void): CancelableFrameTask {
      const task = (() => { queued = run; }) as CancelableFrameTask;
      task.cancel = () => { queued = null; };
      return task;
    },
    flush(): void {
      const run = queued;
      queued = null;
      run?.();
    },
    hasQueuedFrame(): boolean {
      return queued !== null;
    },
  };
}

test('shouldRunInputSensitiveMapWork skips work only while input is pending (#5042 U2)', () => {
  assert.equal(shouldRunInputSensitiveMapWork(() => false), true);
  assert.equal(shouldRunInputSensitiveMapWork(() => true), false);
});

test('shouldRenderTradeAnimationFrame keeps the every-other-frame gate and input skip (#5042 U2)', () => {
  assert.equal(shouldRenderTradeAnimationFrame(1, () => false), false, 'odd frames stay skipped');
  assert.equal(shouldRenderTradeAnimationFrame(2, () => false), true, 'even frames render without input pressure');
  assert.equal(shouldRenderTradeAnimationFrame(2, () => true), false, 'even frames skip while input is pending');
});

test('country hover query controller coalesces mouse moves so the latest point wins (#5042 U3)', () => {
  const frames = createManualFrameScheduler();
  const queried: number[] = [];
  const controller = createCountryHoverQueryController<number>(frames.scheduleFrame, (point) => {
    queried.push(point);
  });

  controller.queue(1);
  controller.queue(2);

  assert.equal(controller.isPending(), true);
  assert.equal(frames.hasQueuedFrame(), true);
  frames.flush();
  assert.deepEqual(queried, [2], 'only the latest queued point is queried');
  assert.equal(controller.isPending(), false);
});

test('country hover query controller cancels queued work on mouseout/destroy (#5042 U3)', () => {
  const frames = createManualFrameScheduler();
  const queried: string[] = [];
  const controller = createCountryHoverQueryController<string>(frames.scheduleFrame, (point) => {
    queried.push(point);
  });

  controller.queue('inside-country');
  controller.cancel();

  assert.equal(controller.isPending(), false);
  assert.equal(frames.hasQueuedFrame(), false);
  frames.flush();
  assert.deepEqual(queried, [], 'cancelled hover query must not re-highlight after pointer exit');
});

test('pointer country resolution uses cached hover only when no hover query is pending', () => {
  let fallbackCalls = 0;
  const fallback = () => {
    fallbackCalls += 1;
    return { code: 'CA', name: 'Canada' };
  };

  assert.deepEqual(
    resolveCountryForPointerInteraction({ code: 'US', name: 'United States' }, false, fallback),
    { code: 'US', name: 'United States' },
  );
  assert.equal(fallbackCalls, 0, 'fresh hover cache should avoid sync coordinate lookup');

  assert.deepEqual(
    resolveCountryForPointerInteraction({ code: 'US', name: 'United States' }, true, fallback),
    { code: 'CA', name: 'Canada' },
  );
  assert.equal(fallbackCalls, 1, 'pending hover cache is stale and must fall back to the click coordinate');
});
