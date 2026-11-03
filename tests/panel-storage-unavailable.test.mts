// Regression guard for WORLDMONITOR-11X.
//
// Android WebViews built with `setDomStorageEnabled(false)` expose `localStorage`
// as **null** rather than throwing on access, so an unguarded `localStorage.setItem`
// raises `TypeError: Cannot read properties of null (reading 'setItem')`. Panel
// resize/collapse persistence runs straight out of a `touchend` handler, so that
// throw escaped to `onunhandledrejection` and aborted the gesture.
//
// The read path (`readStorageMap`) has always been try/caught. These tests pin the
// write and remove paths to the same contract, and the positive-control block keeps
// the guard from degenerating into "swallow everything".

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clearPanelColSpan,
  clearPanelColSpans,
  clearPanelSpan,
  clearPanelSpans,
  invalidatePanelStorageCacheForKeys,
  loadPanelColSpans,
  loadPanelSpans,
  savePanelCollapsed,
  savePanelColSpan,
  savePanelSpan,
  PANEL_COL_SPANS_KEY,
  PANEL_COLLAPSED_KEY,
  PANEL_SPANS_KEY,
} from '../src/utils/panel-storage';

const ALL_KEYS = [PANEL_SPANS_KEY, PANEL_COL_SPANS_KEY, PANEL_COLLAPSED_KEY];

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

/**
 * Swap the `localStorage` global for the duration of `run`. Panel storage keeps
 * module-level caches, so both edges invalidate them — otherwise a cache warmed
 * under one storage would leak into the next case.
 */
function withLocalStorage<T>(storage: Storage | null, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  invalidatePanelStorageCacheForKeys(ALL_KEYS);
  try {
    return run();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, 'localStorage', original);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
    invalidatePanelStorageCacheForKeys(ALL_KEYS);
  }
}

describe('Panel storage with unavailable localStorage', () => {
  it('does not throw out of the span write path when localStorage is null', () => {
    withLocalStorage(null, () => {
      assert.doesNotThrow(() => savePanelSpan('panel-a', 3));
      assert.doesNotThrow(() => savePanelColSpan('panel-a', 2));
    });
  });

  it('does not throw out of the span clear paths when localStorage is null', () => {
    withLocalStorage(null, () => {
      assert.doesNotThrow(() => clearPanelSpans());
      assert.doesNotThrow(() => clearPanelColSpans());
      assert.doesNotThrow(() => clearPanelSpan('panel-a'));
      assert.doesNotThrow(() => clearPanelColSpan('panel-a'));
    });
  });

  it('reports failure instead of throwing when collapse state cannot persist', () => {
    withLocalStorage(null, () => {
      assert.equal(savePanelCollapsed('panel-a', true), false);
    });
  });

  it('reads degrade to empty maps when localStorage is null', () => {
    withLocalStorage(null, () => {
      assert.deepEqual(loadPanelSpans(), {});
      assert.deepEqual(loadPanelColSpans(), {});
    });
  });

  // Positive control: the guard must not silently disable persistence when
  // storage genuinely works. A regression that swallowed every write would pass
  // the null-storage cases above and fail here.
  it('still persists through a working storage', () => {
    const storage = createMemoryStorage();
    withLocalStorage(storage, () => {
      assert.equal(savePanelSpan('panel-a', 3), true);
      assert.equal(savePanelColSpan('panel-a', 2), true);
      assert.equal(savePanelCollapsed('panel-a', true), true);

      assert.equal(loadPanelSpans()['panel-a'], 3);
      assert.equal(loadPanelColSpans()['panel-a'], 2);

      assert.deepEqual(JSON.parse(storage.getItem(PANEL_SPANS_KEY) ?? '{}'), { 'panel-a': 3 });
      assert.deepEqual(JSON.parse(storage.getItem(PANEL_COL_SPANS_KEY) ?? '{}'), { 'panel-a': 2 });
      assert.deepEqual(JSON.parse(storage.getItem(PANEL_COLLAPSED_KEY) ?? '{}'), { 'panel-a': true });

      clearPanelSpans();
      assert.equal(storage.getItem(PANEL_SPANS_KEY), null);
      assert.deepEqual(loadPanelSpans(), {});
    });
  });

  // A quota/SecurityError throw (Safari private mode) must degrade the same way
  // as the null-storage case — the guard is on the operation, not on one shape
  // of broken storage.
  it('degrades when storage throws instead of being null', () => {
    const storage = createMemoryStorage();
    storage.setItem = () => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    };
    withLocalStorage(storage, () => {
      assert.doesNotThrow(() => savePanelSpan('panel-a', 3));
      assert.equal(savePanelSpan('panel-b', 4), false);
      assert.equal(savePanelCollapsed('panel-a', true), false);
    });
  });
});
