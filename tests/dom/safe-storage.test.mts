import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isStorageAvailable,
  safeStorageGet,
  safeStorageKeys,
  safeStorageRemove,
  safeStorageRemoveChecked,
  safeStorageSet,
  safeStorageSetChecked,
} from '@/utils/safe-storage';

/** Android WebView with DOM storage disabled: the property itself is null. */
function stubNullStorage(): void {
  vi.stubGlobal('localStorage', null);
}

/** Sandboxed iframe or blocked cookies: reading the property throws. */
function stubThrowingStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: access is denied for this document');
    },
  });
}

/** Storage is present but full, so only the write throws. */
function stubFullStorage(): void {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {},
  });
}

/**
 * A working, Map-backed Storage. The suite's afterEach DELETES
 * globalThis.localStorage, so any test that needs a live store has to install
 * one rather than assume happy-dom still provides it.
 */
function stubWorkingStorage(): void {
  const backing = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() { return backing.size; },
    key: (i: number) => [...backing.keys()][i] ?? null,
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => { backing.set(k, String(v)); },
    removeItem: (k: string) => { backing.delete(k); },
    clear: () => backing.clear(),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('safe storage', () => {
  it('round-trips a value when storage works', () => {
    safeStorageSet('wm-test-key', '1');
    expect(safeStorageGet('wm-test-key')).toBe('1');

    safeStorageRemove('wm-test-key');
    expect(safeStorageGet('wm-test-key')).toBeNull();
  });

  it('reports a missing key as null rather than undefined', () => {
    expect(safeStorageGet('wm-key-that-was-never-set')).toBeNull();
  });

  for (const [shape, stub] of [
    ['null storage', stubNullStorage],
    ['throwing storage', stubThrowingStorage],
  ] as const) {
    it(`degrades to no-op reads and writes under ${shape}`, () => {
      stub();

      expect(() => safeStorageSet('wm-test-key', '1')).not.toThrow();
      expect(() => safeStorageRemove('wm-test-key')).not.toThrow();
      expect(safeStorageGet('wm-test-key')).toBeNull();
    });
  }

  it('swallows a quota failure on write', () => {
    stubFullStorage();

    expect(() => safeStorageSet('wm-test-key', '1')).not.toThrow();
  });
});

describe('safeStorageKeys', () => {
  beforeEach(stubWorkingStorage);

  it('snapshots keys so a delete-while-iterating caller cannot skip one', () => {
    // The index-shifting bug this helper's contract exists to prevent: a live
    // `for (i = 0; i < localStorage.length; i++) localStorage.key(i)` loop that
    // removes as it goes walks past half its matches. Both real call sites
    // (persistent-cache prefix invalidation, settings export) have that shape.
    for (const key of ['wm-x-1', 'wm-x-2', 'wm-x-3', 'wm-x-4', 'keep-me']) {
      localStorage.setItem(key, '1');
    }

    for (const key of safeStorageKeys()) {
      if (key.startsWith('wm-x-')) safeStorageRemove(key);
    }

    expect(safeStorageKeys().filter((k) => k.startsWith('wm-x-'))).toEqual([]);
    expect(safeStorageGet('keep-me')).toBe('1');
  });

  it('returns [] rather than throwing on both broken-storage shapes', () => {
    stubNullStorage();
    expect(safeStorageKeys()).toEqual([]);
    vi.unstubAllGlobals();
    stubThrowingStorage();
    expect(safeStorageKeys()).toEqual([]);
  });
});

describe('checked writes', () => {
  beforeEach(stubWorkingStorage);

  it('reports a quota rejection instead of swallowing it', () => {
    stubFullStorage();
    // The distinction the cloud-prefs sync-version guard depends on: a usable
    // store that REJECTED the write must be false, so the caller does not go
    // on to record durable state claiming the value landed.
    expect(safeStorageSetChecked('wm-test-key', 'v')).toBe(false);
    // The swallowing variant stays silent on the same input.
    expect(() => safeStorageSet('wm-test-key', 'v')).not.toThrow();
  });

  it('reports success when there is no store to write to', () => {
    // Nothing was written, but nothing durable disagrees either — the marker
    // the caller writes next is equally inert. Returning false here would make
    // every sign-in on a null-storage device report an error.
    stubNullStorage();
    expect(safeStorageSetChecked('wm-test-key', 'v')).toBe(true);
    expect(safeStorageRemoveChecked('wm-test-key')).toBe(true);
  });

  it('reports success on a working store', () => {
    expect(safeStorageSetChecked('wm-test-key', 'v')).toBe(true);
    expect(safeStorageGet('wm-test-key')).toBe('v');
    expect(safeStorageRemoveChecked('wm-test-key')).toBe(true);
    expect(safeStorageGet('wm-test-key')).toBeNull();
  });
});

describe('isStorageAvailable', () => {
  beforeEach(stubWorkingStorage);

  it('separates an empty store from an unusable one', () => {
    expect(isStorageAvailable()).toBe(true);
    stubNullStorage();
    expect(isStorageAvailable()).toBe(false);
    vi.unstubAllGlobals();
    stubThrowingStorage();
    expect(isStorageAvailable()).toBe(false);
  });
});

describe('checked-write call-site contract (#7833 review)', () => {
  beforeEach(stubWorkingStorage);

  it('lets a caller record only the writes that landed', () => {
    // The shape both applyCloudBlob and showUndoToast's undo handler use: the
    // "did this change?" read happens BEFORE the write, so without the checked
    // result a rejected write still gets announced as applied.
    const backing = new Map<string, string>([['a', 'old'], ['b', 'old']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k === 'b') throw new Error('QuotaExceededError');
        backing.set(k, v);
      },
      removeItem: (k: string) => { backing.delete(k); },
    });

    const applied: string[] = [];
    let allLanded = true;
    for (const key of ['a', 'b']) {
      const wasDifferent = safeStorageGet(key) !== 'new';
      if (safeStorageSetChecked(key, 'new')) {
        if (wasDifferent) applied.push(key);
      } else {
        allLanded = false;
      }
    }

    expect(applied).toEqual(['a']);
    expect(allLanded).toBe(false);
    expect(backing.get('b')).toBe('old');
  });
});

describe('checked writes under a THROWING storage property (#7833 review)', () => {
  it('reports success, because an unreachable store is not a rejection', () => {
    // The distinction the cloud-prefs callers now branch on. Reading the
    // `localStorage` property itself throws in a sandboxed iframe or with
    // cookies blocked; folding that into the write's own catch reported it as
    // a REJECTED write, so every cloud-pref write looked rejected and sign-in
    // terminated in an error state on those surfaces (the embed runs in an
    // iframe). Only a store that was actually obtained and refused the write
    // returns false.
    stubThrowingStorage();

    expect(safeStorageSetChecked('wm-test-key', 'v')).toBe(true);
    expect(safeStorageRemoveChecked('wm-test-key')).toBe(true);
    expect(isStorageAvailable()).toBe(false);
  });
});
