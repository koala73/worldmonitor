import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { markLcpDebug } from '../src/utils/lcp-debug';

type MarkRecord = { name: string };

function withStubbedEnv(
  windowValue: unknown,
  performanceValue: unknown,
  fn: () => void,
): void {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const perfDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowValue });
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: performanceValue });
  try {
    fn();
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else delete (globalThis as typeof globalThis & { window?: unknown }).window;
    if (perfDescriptor) Object.defineProperty(globalThis, 'performance', perfDescriptor);
    else delete (globalThis as typeof globalThis & { performance?: unknown }).performance;
  }
}

function makePerformance(): { marks: string[]; mark: (name: string) => void; now: () => number } {
  const marks: string[] = [];
  return {
    marks,
    mark: (name: string) => { marks.push(name); },
    now: () => 123,
  };
}

describe('markLcpDebug production gating (#4512)', () => {
  afterEach(() => { /* env restored per-call by withStubbedEnv */ });

  it('does NOT call performance.mark when the recorder is not installed', () => {
    const perf = makePerformance();
    // window present, but no __wmLcpDebug recorder (the default for all prod traffic)
    withStubbedEnv({}, perf, () => {
      markLcpDebug('wm:boot:app-init-start');
      markLcpDebug('wm:data:initial-fanout-start', { categories: 4 });
    });
    assert.deepEqual(perf.marks, [], 'native performance.mark must not fire when debug is disabled');
  });

  it('does NOT call performance.mark when recorder exists but is disabled', () => {
    const perf = makePerformance();
    withStubbedEnv({ __wmLcpDebug: { enabled: false, marks: [] } }, perf, () => {
      markLcpDebug('wm:boot:app-init-start');
    });
    assert.deepEqual(perf.marks, [], 'native performance.mark must not fire when enabled is false');
  });

  it('records both a native mark and an in-memory mark when enabled', () => {
    const perf = makePerformance();
    const recorder: { enabled: boolean; marks: MarkRecord[] } = { enabled: true, marks: [] };
    withStubbedEnv({ __wmLcpDebug: recorder }, perf, () => {
      markLcpDebug('wm:boot:app-init-start', { settled: true });
    });
    assert.deepEqual(perf.marks, ['wm:boot:app-init-start'], 'native mark should fire when enabled');
    assert.equal(recorder.marks.length, 1);
    assert.equal(recorder.marks[0].name, 'wm:boot:app-init-start');
  });

  it('is a no-op without throwing when window is undefined', () => {
    const perf = makePerformance();
    withStubbedEnv(undefined, perf, () => {
      assert.doesNotThrow(() => markLcpDebug('wm:boot:app-init-start'));
    });
    assert.deepEqual(perf.marks, [], 'no marks without a window');
  });
});
