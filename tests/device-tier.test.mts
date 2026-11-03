import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOW_END_DEVICE_CLASS,
  applyDeviceTierClass,
  classifyDeviceTier,
  getDeviceTier,
  resetDeviceTierForTesting,
} from '../src/utils/device-tier.ts';
import {
  MAP_OVERLAY_MARKER_BUDGET_LOW_END,
  MAP_OVERLAY_MARKER_BUDGET_MOBILE,
} from '../src/utils/globe-marker-budget.ts';

function withNavigator<T>(value: unknown, run: () => T): T {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value });
  resetDeviceTierForTesting();
  try {
    return run();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete (globalThis as Record<string, unknown>).navigator;
    resetDeviceTierForTesting();
  }
}

describe('device tier', () => {
  it('treats Chrome deviceMemory buckets of 4 GB and below as low-end', () => {
    for (const memory of [0.25, 0.5, 1, 2, 4]) {
      assert.equal(classifyDeviceTier({ deviceMemory: memory }), 'low', `${memory} GB`);
    }
    assert.equal(classifyDeviceTier({ deviceMemory: 8 }), 'standard');
  });

  it('never classifies an absent or malformed value as low-end (Safari, iOS)', () => {
    assert.equal(classifyDeviceTier(undefined), 'unknown');
    assert.equal(classifyDeviceTier({}), 'unknown');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2', null]) {
      assert.equal(classifyDeviceTier({ deviceMemory: bad }), 'unknown', String(bad));
    }
  });

  it('reads navigator once and toggles the root class to match', () => {
    const tokens = new Set<string>();
    const root = { classList: { toggle: (token: string, force?: boolean) => (force ? tokens.add(token) : tokens.delete(token)) } };
    withNavigator({ deviceMemory: 2 }, () => {
      assert.equal(getDeviceTier(), 'low');
      applyDeviceTierClass(root);
      assert.ok(tokens.has(LOW_END_DEVICE_CLASS));
    });
    withNavigator({ deviceMemory: 8 }, () => {
      applyDeviceTierClass(root);
      assert.equal(tokens.has(LOW_END_DEVICE_CLASS), false);
    });
    withNavigator({}, () => {
      applyDeviceTierClass(root);
      assert.equal(tokens.has(LOW_END_DEVICE_CLASS), false);
    });
  });

  it('gives low-end devices a smaller map marker budget than mobile', () => {
    assert.ok(MAP_OVERLAY_MARKER_BUDGET_LOW_END.perLayer < MAP_OVERLAY_MARKER_BUDGET_MOBILE.perLayer);
    assert.ok(MAP_OVERLAY_MARKER_BUDGET_LOW_END.total < MAP_OVERLAY_MARKER_BUDGET_MOBILE.total);
  });
});
