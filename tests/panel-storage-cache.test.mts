import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMinimalPanelHarness } from './helpers/minimal-panel-harness.mjs';
import {
  clearPanelColSpan,
  invalidatePanelStorageCacheForKeys,
  loadPanelColSpans,
  loadPanelSpans,
  PANEL_COL_SPANS_KEY,
  PANEL_COLLAPSED_KEY,
  PANEL_SPANS_KEY,
} from '../src/utils/panel-storage';

const PANEL_COUNT = 86;

function invalidateAllPanelStorageCaches(): void {
  invalidatePanelStorageCacheForKeys([PANEL_SPANS_KEY, PANEL_COL_SPANS_KEY, PANEL_COLLAPSED_KEY]);
}

function wrapGetItemCounter(storage: Storage) {
  const originalGetItem = storage.getItem.bind(storage);
  const counts = new Map<string, number>();
  storage.getItem = ((key: string) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return originalGetItem(key);
  }) as Storage['getItem'];

  return {
    count(key: string): number {
      return counts.get(key) ?? 0;
    },
  };
}

async function withHarness<T>(callback: (harness: Awaited<ReturnType<typeof createMinimalPanelHarness>>) => T | Promise<T>): Promise<T> {
  const harness = await createMinimalPanelHarness();
  try {
    return await callback(harness);
  } finally {
    harness.cleanup();
  }
}

function click(element: Element): void {
  element.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
}

describe('Panel storage cache', () => {
  it('reads each aggregate storage map once across repeated Panel construction', async () => {
    await withHarness((harness) => {
      const spanMap = Object.fromEntries(Array.from({ length: PANEL_COUNT }, (_, index) => [`panel-${index}`, 2]));
      const colSpanMap = Object.fromEntries(Array.from({ length: PANEL_COUNT }, (_, index) => [`panel-${index}`, 2]));
      const collapsedMap = Object.fromEntries(Array.from({ length: PANEL_COUNT }, (_, index) => [`panel-${index}`, true]));
      harness.localStorage.setItem(PANEL_SPANS_KEY, JSON.stringify(spanMap));
      harness.localStorage.setItem(PANEL_COL_SPANS_KEY, JSON.stringify(colSpanMap));
      harness.localStorage.setItem(PANEL_COLLAPSED_KEY, JSON.stringify(collapsedMap));

      const counter = wrapGetItemCounter(harness.localStorage);

      for (let index = 0; index < PANEL_COUNT; index++) {
        const panel = harness.createPanel({ id: `panel-${index}`, collapsible: true });
        const root = panel.getElement();
        assert.equal(root.classList.contains('panel-collapsed'), true);
        assert.equal(root.classList.contains('span-2'), true);
        assert.equal(root.classList.contains('col-span-2'), true);
      }

      assert.equal(counter.count(PANEL_COLLAPSED_KEY), 1);
      assert.equal(counter.count(PANEL_SPANS_KEY), 1);
      assert.equal(counter.count(PANEL_COL_SPANS_KEY), 1);
    });
  });

  it('hydrates persisted collapsed, row-span, and column-span state', async () => {
    await withHarness((harness) => {
      harness.localStorage.setItem(PANEL_SPANS_KEY, JSON.stringify({ hydrate: 3 }));
      harness.localStorage.setItem(PANEL_COL_SPANS_KEY, JSON.stringify({ hydrate: 2 }));
      harness.localStorage.setItem(PANEL_COLLAPSED_KEY, JSON.stringify({ hydrate: true }));

      const panel = harness.createPanel({ id: 'hydrate', collapsible: true });
      const root = panel.getElement();
      const collapseButton = root.querySelector('.panel-collapse-btn');

      assert.equal(root.classList.contains('panel-collapsed'), true);
      assert.equal(panel.content.style.display, 'none');
      assert.equal(collapseButton?.getAttribute('aria-expanded'), 'false');
      assert.equal(root.classList.contains('span-3'), true);
      assert.equal(root.classList.contains('col-span-2'), true);
    });
  });

  it('retries saved column-span reconciliation until the connected grid has width', async () => {
    await withHarness((harness) => {
      invalidateAllPanelStorageCaches();
      harness.localStorage.setItem(PANEL_COL_SPANS_KEY, JSON.stringify({ delayed: 3 }));

      const grid = harness.document.createElement('div');
      grid.className = 'panels-grid';
      let gridWidth = 0;
      Object.defineProperty(grid, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ width: gridWidth, height: 0, top: 0, left: 0, right: gridWidth, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }),
      });
      harness.window.getComputedStyle = () => ({
        display: '',
        visibility: '',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        columnGap: '0',
      });

      const frames: Array<() => void> = [];
      globalThis.requestAnimationFrame = ((callback: () => void) => {
        frames.push(callback);
        return frames.length;
      }) as typeof requestAnimationFrame;
      globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

      const panel = harness.createPanel({ id: 'delayed' });
      const root = panel.getElement();
      assert.equal(root.classList.contains('col-span-3'), true);
      assert.equal(frames.length, 1);

      grid.appendChild(root);
      harness.document.body.appendChild(grid);
      frames.shift()?.();
      assert.equal(root.classList.contains('col-span-3'), true);
      assert.equal(frames.length, 1);

      gridWidth = 560;
      frames.shift()?.();
      assert.equal(root.classList.contains('col-span-3'), false);
      assert.equal(root.classList.contains('col-span-2'), true);
    });
  });

  it('keeps the warmed cache fresh after collapse and reset mutations', async () => {
    await withHarness((harness) => {
      harness.localStorage.setItem(PANEL_SPANS_KEY, JSON.stringify({ mutable: 4 }));
      harness.localStorage.setItem(PANEL_COL_SPANS_KEY, JSON.stringify({ mutable: 2 }));
      harness.localStorage.setItem(PANEL_COLLAPSED_KEY, JSON.stringify({ mutable: true }));

      const panel = harness.createPanel({ id: 'mutable', collapsible: true });
      const root = panel.getElement();
      assert.equal(root.classList.contains('panel-collapsed'), true);
      assert.equal(root.classList.contains('span-4'), true);
      assert.equal(root.classList.contains('col-span-2'), true);

      const collapseButton = root.querySelector('.panel-collapse-btn');
      assert.ok(collapseButton, 'collapse button is rendered for collapsible panel');
      click(collapseButton);
      assert.equal(harness.localStorage.getItem(PANEL_COLLAPSED_KEY), null);

      panel.resetHeight();
      assert.equal(harness.localStorage.getItem(PANEL_SPANS_KEY), '{}');

      panel.resetWidth();
      assert.equal(harness.localStorage.getItem(PANEL_COL_SPANS_KEY), null);

      const laterPanel = harness.createPanel({ id: 'mutable', collapsible: true });
      const laterRoot = laterPanel.getElement();
      assert.equal(laterRoot.classList.contains('panel-collapsed'), false);
      assert.equal(laterRoot.classList.contains('span-4'), false);
      assert.equal(laterRoot.classList.contains('col-span-2'), false);
    });
  });

  it('bounds reads and falls back safely for corrupt or throwing storage', async () => {
    await withHarness((harness) => {
      harness.localStorage.setItem(PANEL_SPANS_KEY, '{bad json');
      harness.localStorage.setItem(PANEL_COL_SPANS_KEY, '[]');
      harness.localStorage.setItem(PANEL_COLLAPSED_KEY, '{bad json');
      const counter = wrapGetItemCounter(harness.localStorage);

      for (let index = 0; index < 3; index++) {
        const panel = harness.createPanel({ id: `corrupt-${index}`, collapsible: true });
        const root = panel.getElement();
        assert.equal(root.classList.contains('panel-collapsed'), false);
        assert.equal(root.classList.contains('span-2'), false);
        assert.equal(root.classList.contains('col-span-2'), false);
      }

      assert.equal(counter.count(PANEL_COLLAPSED_KEY), 1);
      assert.equal(counter.count(PANEL_SPANS_KEY), 1);
      assert.equal(counter.count(PANEL_COL_SPANS_KEY), 1);
    });

    await withHarness((harness) => {
      const originalGetItem = harness.localStorage.getItem.bind(harness.localStorage);
      const counts = new Map<string, number>();
      harness.localStorage.getItem = ((key: string) => {
        if ([PANEL_SPANS_KEY, PANEL_COL_SPANS_KEY, PANEL_COLLAPSED_KEY].includes(key)) {
          counts.set(key, (counts.get(key) ?? 0) + 1);
          throw new Error('storage unavailable');
        }
        return originalGetItem(key);
      }) as Storage['getItem'];

      for (let index = 0; index < 3; index++) {
        assert.doesNotThrow(() => harness.createPanel({ id: `throwing-${index}`, collapsible: true }));
      }

      assert.equal(counts.get(PANEL_COLLAPSED_KEY), 1);
      assert.equal(counts.get(PANEL_SPANS_KEY), 1);
      assert.equal(counts.get(PANEL_COL_SPANS_KEY), 1);
    });
  });

  it('invalidates warmed maps when another tab changes panel storage', () => {
    invalidateAllPanelStorageCaches();
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const values = new Map<string, string>();
    let storageListener: ((event: Event & { key: string | null }) => void) | null = null;

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        addEventListener(type: string, listener: EventListener) {
          if (type === 'storage') {
            storageListener = listener as (event: Event & { key: string | null }) => void;
          }
        },
      },
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem(key: string) {
          return values.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          values.set(key, String(value));
        },
        removeItem(key: string) {
          values.delete(key);
        },
      },
    });

    try {
      values.set(PANEL_SPANS_KEY, JSON.stringify({ crossTab: 1 }));
      assert.equal(loadPanelSpans().crossTab, 1);
      assert.ok(storageListener, 'panel storage installs a storage-event invalidation listener');

      values.set(PANEL_SPANS_KEY, JSON.stringify({ crossTab: 3 }));
      assert.equal(loadPanelSpans().crossTab, 1, 'cache remains warm before the cross-tab event');

      const event = new Event('storage') as Event & { key: string | null };
      Object.defineProperty(event, 'key', { value: PANEL_SPANS_KEY });
      storageListener(event);

      assert.equal(loadPanelSpans().crossTab, 3, 'storage event invalidates the warmed map');
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('returns frozen cached maps so callers cannot mutate tab-wide storage state', async () => {
    await withHarness((harness) => {
      invalidateAllPanelStorageCaches();
      harness.localStorage.setItem(PANEL_SPANS_KEY, JSON.stringify({ immutable: 2 }));

      const spans = loadPanelSpans();
      assert.equal(Object.isFrozen(spans), true);
      assert.throws(() => {
        (spans as Record<string, number>).poisoned = 5;
      }, TypeError);

      assert.equal(loadPanelSpans().poisoned, undefined);
      assert.equal(loadPanelSpans().immutable, 2);
    });
  });

  it('keeps column-span removeWhenEmpty default when options object is empty', async () => {
    await withHarness((harness) => {
      invalidateAllPanelStorageCaches();
      harness.localStorage.setItem(PANEL_COL_SPANS_KEY, JSON.stringify({ compact: 2 }));

      assert.equal(loadPanelColSpans().compact, 2);
      clearPanelColSpan('compact', {});

      assert.equal(harness.localStorage.getItem(PANEL_COL_SPANS_KEY), null);
      assert.equal(Object.keys(loadPanelColSpans()).length, 0);
    });
  });

  it('invalidates cached panel maps after direct storage replacement', async () => {
    await withHarness((harness) => {
      invalidateAllPanelStorageCaches();
      harness.localStorage.setItem(PANEL_SPANS_KEY, JSON.stringify({ imported: 1 }));
      assert.equal(loadPanelSpans().imported, 1);

      harness.localStorage.setItem(PANEL_SPANS_KEY, JSON.stringify({ imported: 3 }));
      assert.equal(loadPanelSpans().imported, 1, 'cache stays warm until the writer reports replacement');

      invalidatePanelStorageCacheForKeys([PANEL_SPANS_KEY]);
      assert.equal(loadPanelSpans().imported, 3);
    });
  });
});
