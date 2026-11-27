/**
 * Dashboard focus (#10453): the tab carries its scope, the tabs blob persists
 * it, and `tab-focus` holds the active tab's scope as the runtime source.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { loadTabsState, normalizeTabsState, saveTabsState, type PanelTab, type TabsState } from '../src/services/tab-store.ts';
import {
  getActiveScope,
  getResolvedScope,
  restoreActiveScope,
  setActiveScope,
  subscribeScope,
  type ResolvedScope,
} from '../src/services/tab-focus.ts';

class MemoryStorage {
  readonly store = new Map<string, string>();
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

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: new MemoryStorage() });
  restoreActiveScope(null);
});

afterEach(() => {
  restoreActiveScope(null);
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

function tab(id: string, extra: Partial<PanelTab> = {}): PanelTab {
  return { id, name: id, panelSettings: {}, panelOrder: [], bottomSet: [], ...extra };
}

const SEA = { countries: ['TH', 'VN', 'ID'], neighbours: true, start: '2026-11-14', end: '2026-11-18' };

describe('normalizeTabsState: scope', () => {
  it('keeps a valid scope in normalized form', () => {
    const state = normalizeTabsState({
      activeTabId: 'a',
      tabs: [tab('a', { scope: { countries: ['th', 'VN', 'TH'], neighbours: false } as PanelTab['scope'] })],
    });
    assert.deepEqual(state?.tabs[0]?.scope, { countries: ['TH', 'VN'], neighbours: false });
  });

  it('drops an invalid scope but keeps the tab', () => {
    const state = normalizeTabsState({
      activeTabId: 'a',
      tabs: [
        tab('a', { scope: { countries: [], neighbours: true } }),
        tab('b', { scope: { countries: 'TH' } as unknown as PanelTab['scope'] }),
        tab('c', { scope: { countries: Array.from({ length: 13 }, (_, i) => ['TH', 'VN', 'ID', 'MY', 'SG', 'PH', 'KH', 'LA', 'MM', 'BN', 'TL', 'CN', 'IN'][i]!) } }),
      ],
    });
    assert.equal(state?.tabs.length, 3);
    for (const t of state!.tabs) assert.equal('scope' in t, false, `${t.id} kept an invalid scope`);
  });

  it('leaves a tab without a scope unchanged', () => {
    const state = normalizeTabsState({ activeTabId: 'a', tabs: [tab('a')] });
    assert.equal('scope' in state!.tabs[0]!, false);
  });
});

describe('tabs blob round trip', () => {
  it('persists each tab scope through save and load', () => {
    const state: TabsState = {
      activeTabId: 'b',
      tabs: [tab('a'), tab('b', { scope: { ...SEA, countries: [...SEA.countries] } })],
    };
    assert.equal(saveTabsState(state).persisted, true);
    const loaded = loadTabsState();
    assert.equal(loaded?.activeTabId, 'b');
    assert.deepEqual(loaded?.tabs[1]?.scope, SEA);
    assert.equal(loaded?.tabs[0]?.scope, undefined);
  });
});

describe('tab-focus service', () => {
  it('starts with no scope', () => {
    assert.equal(getActiveScope(), null);
    assert.equal(getResolvedScope(), null);
  });

  it('refuses to set a focus without the entitlement and leaves the scope alone', () => {
    const seen: Array<ResolvedScope | null> = [];
    const off = subscribeScope((r) => seen.push(r));
    assert.equal(setActiveScope(SEA, false), false);
    assert.equal(getActiveScope(), null);
    assert.deepEqual(seen, []);
    off();
  });

  it('sets, resolves and notifies when entitled', () => {
    const seen: Array<ResolvedScope | null> = [];
    const off = subscribeScope((r) => seen.push(r));
    assert.equal(setActiveScope(SEA, true), true);
    assert.deepEqual(getActiveScope(), SEA);
    const resolved = getResolvedScope();
    assert.deepEqual(resolved?.chosen, ['TH', 'VN', 'ID']);
    assert.ok(resolved!.neighbours.includes('LA'), 'Laos borders Thailand and Vietnam');
    assert.ok(resolved!.neighbours.includes('MY'), 'Malaysia borders Thailand and Indonesia');
    assert.ok(!resolved!.neighbours.includes('TH'), 'a chosen country is never its own neighbour');
    assert.equal(seen.length, 1);
    assert.equal(seen[0], resolved);
    off();
  });

  it('switching neighbours off resolves to the chosen countries only', () => {
    setActiveScope({ ...SEA, neighbours: false }, true);
    assert.deepEqual(getResolvedScope()?.neighbours, []);
  });

  it('rejects an invalid scope even when entitled', () => {
    assert.equal(setActiveScope({ countries: ['XX'], neighbours: true }, true), false);
    assert.equal(getActiveScope(), null);
  });

  it('clearing needs no entitlement', () => {
    setActiveScope(SEA, true);
    assert.equal(setActiveScope(null, false), true);
    assert.equal(getActiveScope(), null);
    assert.equal(getResolvedScope(), null);
  });

  it('restore applies a stored scope without the gate (tab switch, reload, shared dashboard)', () => {
    const seen: Array<ResolvedScope | null> = [];
    const off = subscribeScope((r) => seen.push(r));
    assert.deepEqual(restoreActiveScope(SEA), SEA);
    assert.deepEqual(getActiveScope(), SEA);
    assert.equal(restoreActiveScope({ countries: 'nope' }), null);
    assert.equal(getActiveScope(), null);
    assert.equal(seen.length, 2);
    off();
  });

  it('does not notify when the scope is unchanged', () => {
    restoreActiveScope(SEA);
    const seen: Array<ResolvedScope | null> = [];
    const off = subscribeScope((r) => seen.push(r));
    restoreActiveScope({ ...SEA, countries: [...SEA.countries] });
    restoreActiveScope(SEA);
    assert.equal(seen.length, 0);
    restoreActiveScope(null);
    restoreActiveScope(null);
    assert.equal(seen.length, 1);
    off();
  });

  it('hands out copies, so a caller cannot mutate the active scope', () => {
    restoreActiveScope(SEA);
    getActiveScope()!.countries.push('MY');
    assert.deepEqual(getActiveScope()?.countries, ['TH', 'VN', 'ID']);
  });

  it('unsubscribe stops notifications', () => {
    const seen: unknown[] = [];
    const off = subscribeScope((r) => seen.push(r));
    off();
    restoreActiveScope(SEA);
    assert.equal(seen.length, 0);
  });
});
