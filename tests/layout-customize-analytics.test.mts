/**
 * Layout customization discovery (#6420): the metric is "share of sessions
 * with at least one event of kind X", so each kind is sent at most once per
 * page load. Keyboard arrow presses on a resize handle must not spam Umami.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

type TrackedCall = { name: string; data?: Record<string, unknown> };

function installWindow(): TrackedCall[] {
  const calls: TrackedCall[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      umami: {
        track: (name: string, data?: Record<string, unknown>) => calls.push({ name, data }),
        identify: () => {},
      },
    },
  });
  return calls;
}

describe('trackLayoutCustomized', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('sends one layout-customize event per kind per page load', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const calls = installWindow();

    analytics.trackLayoutCustomized('panel-resize');
    analytics.trackLayoutCustomized('panel-resize');
    analytics.trackLayoutCustomized('panel-resize');
    analytics.trackLayoutCustomized('map-divider');
    analytics.trackLayoutCustomized('panel-reorder');
    analytics.trackLayoutCustomized('map-divider');

    assert.deepEqual(
      calls.filter((c) => c.name === 'layout-customize').map((c) => c.data),
      [{ kind: 'panel-resize' }, { kind: 'map-divider' }, { kind: 'panel-reorder' }],
    );
  });
});
