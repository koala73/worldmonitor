import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { saveTabsState, type TabsState } from '../src/services/tab-store.ts';

type GlobalSnapshot = { exists: boolean; value: unknown };

function snapshotGlobal(name: string): GlobalSnapshot {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: (globalThis as Record<string, unknown>)[name],
  };
}

function restoreGlobal(name: string, snapshot: GlobalSnapshot): void {
  if (snapshot.exists) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: snapshot.value,
    });
    return;
  }
  delete (globalThis as Record<string, unknown>)[name];
}

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

class ThrowingStorage extends MemoryStorage {
  override setItem(_key: string, _value: string): void {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  }
}

const localStorageSnapshot = snapshotGlobal('localStorage');

const sample: TabsState = {
  activeTabId: 'tab-main01-abc123',
  tabs: [{
    id: 'tab-main01-abc123',
    name: 'Main',
    panelSettings: {},
    panelOrder: [],
    bottomSet: [],
  }],
};

afterEach(() => {
  restoreGlobal('localStorage', localStorageSnapshot);
});

describe('saveTabsState persist receipt', () => {
  it('returns persisted: true when localStorage accepts the write', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: new MemoryStorage(),
    });
    assert.deepEqual(saveTabsState(sample), { persisted: true });
  });

  it('returns persisted: false when localStorage.setItem throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: new ThrowingStorage(),
    });
    assert.deepEqual(saveTabsState(sample), { persisted: false });
  });
});
