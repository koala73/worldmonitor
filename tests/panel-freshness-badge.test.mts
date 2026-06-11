import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createMinimalPanelHarness } from './helpers/minimal-panel-harness.mjs';

const harness = await createMinimalPanelHarness();
const dataFreshness = harness.dataFreshness;

after(() => {
  harness.cleanup();
});

type SeedStatus = 'OK' | 'STALE_SEED' | 'STALE_CONTENT' | 'EMPTY' | 'REDIS_DOWN';

function setSeedHealth(
  sourceId: string,
  status: SeedStatus,
  options: {
    seedAgeMin?: number;
    maxStaleMin?: number;
    records?: number;
    checkedAtMs?: number;
  } = {},
): void {
  dataFreshness.setEnabled(sourceId, true);
  dataFreshness.recordSeedHealth([{
    sourceId,
    status,
    records: options.records ?? (status === 'EMPTY' || status === 'REDIS_DOWN' ? 0 : 3),
    seedAgeMin: options.seedAgeMin ?? 5,
    maxStaleMin: options.maxStaleMin ?? 60,
    checkedAtMs: options.checkedAtMs ?? Date.now(),
  }]);
}

function primePolymarket(status: SeedStatus = 'OK', checkedAtMs = Date.now()): void {
  setSeedHealth('polymarket', 'OK', { seedAgeMin: 5, maxStaleMin: 60, records: 4, checkedAtMs });
  setSeedHealth('predictions', status, { seedAgeMin: 5, maxStaleMin: 60, records: 7, checkedAtMs });
}

describe('dataFreshness panel summaries', () => {
  it('returns null for unmapped panels', () => {
    assert.equal(dataFreshness.getPanelFreshness('minimal-test'), null);
  });

  it('aggregates multiple mapped sources to the worst active status', () => {
    primePolymarket('STALE_SEED');

    const summary = dataFreshness.getPanelFreshness('polymarket');
    assert.equal(summary?.status, 'stale');
    assert.match(summary?.label ?? '', /^Stale/);
    assert.match(summary?.title ?? '', /Prediction Markets/);
    assert.match(summary?.title ?? '', /Predictions Feed/);
    assert.equal(summary?.sources.length, 2);
  });

  it('keeps an all-disabled panel disabled without letting one disabled source hide active data', () => {
    setSeedHealth('polymarket', 'OK');
    dataFreshness.setEnabled('predictions', false);

    assert.equal(dataFreshness.getPanelFreshness('polymarket')?.status, 'fresh');

    dataFreshness.setEnabled('giving', false);
    assert.equal(dataFreshness.getPanelFreshness('giving')?.status, 'disabled');
    dataFreshness.setEnabled('predictions', true);
    dataFreshness.setEnabled('giving', true);
  });

  it('surfaces no data when a mapped source has no usable timestamp', () => {
    setSeedHealth('giving', 'EMPTY', { records: 0 });

    const summary = dataFreshness.getPanelFreshness('giving');
    assert.equal(summary?.status, 'no_data');
    assert.equal(summary?.label, 'No data');
    assert.match(summary?.title ?? '', /never updated/);
  });

  it('keeps health and error details human-readable in tooltip text', () => {
    setSeedHealth('polymarket', 'OK');
    setSeedHealth('predictions', 'REDIS_DOWN');

    const redisSummary = dataFreshness.getPanelFreshness('polymarket');
    assert.match(redisSummary?.title ?? '', /freshness store unavailable/);
    assert.doesNotMatch(redisSummary?.title ?? '', /REDIS_DOWN/);

    dataFreshness.recordError('polymarket', 'provider token expired');
    const errorSummary = dataFreshness.getPanelFreshness('polymarket');
    assert.match(errorSummary?.title ?? '', /source error reported/);
    assert.doesNotMatch(errorSummary?.title ?? '', /provider token expired/);
  });
});

describe('Panel freshness badge', () => {
  it('renders a separate compact header badge for mapped panels', () => {
    primePolymarket('OK');
    const panel = harness.createFreshnessPanel();
    try {
      const root = panel.getElement();
      const badge = root.querySelector('.panel-freshness-badge');

      assert.ok(badge, 'freshness badge is rendered');
      assert.match(badge.textContent ?? '', /^Fresh/);
      assert.ok(badge.classList.contains('panel-freshness-fresh'));
      assert.match(badge.getAttribute('aria-label') ?? '', /Data freshness: Fresh/);
    } finally {
      panel.destroy();
    }
  });

  it('coexists with the existing live/cached/unavailable panel data badge and header controls', () => {
    primePolymarket('OK');
    const panel = harness.createFreshnessPanel();
    try {
      panel.publicDataBadge('cached', 'SWR');
      panel.setCount(7);

      const root = panel.getElement();
      assert.ok(root.querySelector('.panel-freshness-badge'), 'freshness badge remains visible');
      assert.ok(root.querySelector('.panel-data-badge.cached'), 'existing data badge remains visible');
      assert.equal(root.querySelector('.panel-count')?.textContent, '7');
      assert.ok(root.querySelector('.panel-collapse-btn'), 'collapse control remains visible');
      assert.ok(root.querySelector('.panel-close-btn'), 'close control remains visible');
    } finally {
      panel.destroy();
    }
  });

  it('updates after dataFreshness changes and stops updating after destroy', () => {
    primePolymarket('OK');
    const panel = harness.createFreshnessPanel();
    const root = panel.getElement();
    const badge = root.querySelector('.panel-freshness-badge');
    assert.ok(badge, 'freshness badge is rendered');

    setSeedHealth('predictions', 'STALE_SEED');
    assert.match(badge.textContent ?? '', /^Stale/);
    assert.ok(badge.classList.contains('panel-freshness-stale'));

    panel.destroy();
    const textAfterDestroy = badge.textContent;
    setSeedHealth('predictions', 'REDIS_DOWN');
    assert.equal(badge.textContent, textAfterDestroy);
  });

  it('refreshes time-derived stale state on the badge timer tick', () => {
    const originalNow = Date.now;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const baseMs = originalNow();
    const intervalCallbacks: Array<() => void> = [];
    const clearedTimers: unknown[] = [];

    Date.now = () => baseMs;
    globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
      assert.equal(delay, 60_000);
      intervalCallbacks.push(callback as () => void);
      return 3296 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = ((timer: unknown) => {
      clearedTimers.push(timer);
    }) as typeof clearInterval;

    try {
      setSeedHealth('polymarket', 'OK', { seedAgeMin: 10, maxStaleMin: 15, checkedAtMs: baseMs });
      setSeedHealth('predictions', 'OK', { seedAgeMin: 10, maxStaleMin: 15, checkedAtMs: baseMs });
      const panel = harness.createFreshnessPanel();
      const badge = panel.getElement().querySelector('.panel-freshness-badge');
      assert.ok(badge, 'freshness badge is rendered');
      assert.match(badge.textContent ?? '', /^Fresh/);
      assert.equal(intervalCallbacks.length, 1);

      Date.now = () => baseMs + 6 * 60_000;
      intervalCallbacks[0]!();
      assert.match(badge.textContent ?? '', /^Stale/);
      assert.ok(badge.classList.contains('panel-freshness-stale'));

      panel.destroy();
      assert.deepEqual(clearedTimers, [3296]);
    } finally {
      Date.now = originalNow;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });
});
