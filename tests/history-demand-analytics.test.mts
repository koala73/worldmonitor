/**
 * Demand readout for server-side playback (#11410). The question is "what
 * share of sessions ever does X", so each action is sent at most once per page
 * load. Dragging the slider fires `input` per pixel and must not flood Umami.
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

describe('history demand analytics', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('sends one playback-action per action per page load, with a snapshot band on open', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const calls = installWindow();

    analytics.trackPlaybackAction('open', 0);
    analytics.trackPlaybackAction('open', 40);
    analytics.trackPlaybackAction('step');
    analytics.trackPlaybackAction('step');
    analytics.trackPlaybackAction('live');
    analytics.trackPlaybackAction('live');

    assert.deepEqual(
      calls.filter((c) => c.name === 'playback-action').map((c) => c.data),
      [{ action: 'open', snapshots: '0' }, { action: 'step' }, { action: 'live' }],
    );
  });

  it('keeps a blocked open separate, so a later working open still reports', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const calls = installWindow();

    analytics.trackPlaybackAction('open', null);
    analytics.trackPlaybackAction('open', null);
    analytics.trackPlaybackAction('open', 10);

    assert.deepEqual(
      calls.filter((c) => c.name === 'playback-action').map((c) => c.data),
      [{ action: 'open', snapshots: 'blocked' }, { action: 'open', snapshots: '1-95' }],
    );
  });

  it('bands the local snapshot count instead of sending the raw number', async () => {
    const analytics = await import('../src/services/analytics.ts');
    const bands: unknown[] = [];
    for (const count of [0, 1, 95, 96, 671, 672, 5000]) {
      analytics.resetAnalyticsForTesting();
      const calls = installWindow();
      analytics.trackPlaybackAction('open', count);
      bands.push(calls[0]?.data?.snapshots);
    }
    // One snapshot per 15 minutes of open dashboard: 96 is a day of open time,
    // 672 is a full 7-day retention window.
    assert.deepEqual(bands, ['0', '1-95', '1-95', '96-671', '96-671', '672+', '672+']);
  });

  it('sends one country-history-action per action per page load', async () => {
    const analytics = await import('../src/services/analytics.ts');
    analytics.resetAnalyticsForTesting();
    const calls = installWindow();

    analytics.trackCountryHistoryAction('window-change', { days: 90 });
    analytics.trackCountryHistoryAction('window-change', { days: 365 });
    analytics.trackCountryHistoryAction('date-select');
    analytics.trackCountryHistoryAction('date-select');

    assert.deepEqual(
      calls.filter((c) => c.name === 'country-history-action').map((c) => c.data),
      [
        { action: 'window-change', days: 90 },
        { action: 'date-select' },
      ],
    );
  });
});
