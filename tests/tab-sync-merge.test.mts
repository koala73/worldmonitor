/**
 * Dashboard tab sync merge rules (#11141): src/services/tab-sync-merge.ts.
 * One case per row of the plan's decision table, plus the invariants
 * (gate-intent capture, lossless round trips, never zero tabs).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { PanelConfig } from '../src/types/index.ts';
import { resetMissionPresetState } from '../src/services/mission-presets.ts';
import type { PanelTab, TabsState } from '../src/services/tab-store.ts';
import type { DashboardTabRecord, DashboardTabRow } from '../shared/dashboard-tab-sync.ts';
import {
  applyTabRecord,
  captureTabRecord,
  emptyTabSyncMeta,
  hashTabRecord,
  mergeTabs,
  type MergeInput,
  type TabSyncMeta,
} from '../src/services/tab-sync-merge.ts';

class MemoryStorage {
  readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
}
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: new MemoryStorage() });
});
afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

const DEFAULT_NAME = 'Main';

function defaults(): Record<string, PanelConfig> {
  return resetMissionPresetState({}).panelSettings;
}
function realKeys(n: number): string[] {
  const keys = Object.keys(defaults()).filter((k) => k !== 'map');
  assert.ok(keys.length >= n);
  return keys.slice(0, n);
}

let idCounter = 0;
const nextId = () => `tab-new${(idCounter += 1).toString(36)}-zz`;

/** A tab whose panels are the defaults with `on` keys enabled, in `order`. */
function tab(id: string, opts: { name?: string; on?: string[]; order?: string[]; bottom?: string[]; extra?: Record<string, PanelConfig> } = {}): PanelTab {
  const panelSettings = { ...defaults(), ...(opts.extra ?? {}) };
  if (opts.on) {
    for (const key of Object.keys(panelSettings)) panelSettings[key] = { ...panelSettings[key]!, enabled: key === 'map' || opts.on.includes(key) };
  }
  const order = opts.order ?? Object.keys(panelSettings).filter((k) => k !== 'map');
  return { id, name: opts.name ?? 'Tab ' + id, panelSettings, panelOrder: order, bottomSet: opts.bottom ?? [] };
}

function row(id: string, version: number, record: DashboardTabRecord | null, createdAt = 1): DashboardTabRow {
  return record
    ? { tabId: id, version, deleted: false, record, createdAt, updatedAt: createdAt }
    : { tabId: id, version, deleted: true, createdAt, updatedAt: createdAt };
}

/** Meta as if `tabs` were synced at `version`. */
function syncedMeta(tabs: PanelTab[], version = 1, userId = 'user_a'): TabSyncMeta {
  const meta = emptyTabSyncMeta(userId);
  for (const t of tabs) meta.base[t.id] = { version, hash: hashTabRecord(captureTabRecord(t)) };
  return meta;
}

function input(partial: Partial<MergeInput> & Pick<MergeInput, 'local' | 'rows'>): MergeInput {
  return {
    meta: emptyTabSyncMeta('user_a'),
    currentPanelSettings: defaults(),
    defaultName: DEFAULT_NAME,
    mode: 'normal',
    newTabId: nextId,
    ...partial,
  };
}

const ids = (state: TabsState) => state.tabs.map((t) => t.id);

describe('captureTabRecord', () => {
  it('records gate-clamped panels as on, so a free-tier clamp is not an edit', () => {
    const [a, b] = realKeys(2) as [string, string];
    const open = tab('tab-a-1', { on: [a, b], order: [a, b] });
    const clamped = structuredClone(open);
    clamped.panelSettings[b] = { ...clamped.panelSettings[b]!, enabled: false, proGated: true };
    assert.equal(hashTabRecord(captureTabRecord(clamped)), hashTabRecord(captureTabRecord(open)));
    // A deliberate hide (no gate marker) is an edit.
    const hidden = structuredClone(open);
    hidden.panelSettings[b] = { ...hidden.panelSettings[b]!, enabled: false };
    assert.notEqual(hashTabRecord(captureTabRecord(hidden)), hashTabRecord(captureTabRecord(open)));
  });

  it('keeps grid order, dock, scope, filters and team link, and trims the name', () => {
    const [a, b] = realKeys(2) as [string, string];
    const t: PanelTab = {
      ...tab('tab-a-1', { name: '  Gulf  ', on: [a, b], order: [b, a], bottom: [a] }),
      scope: { countries: ['AE', 'SA'], neighbours: false },
      panelFilters: { forecast: 'mena' },
      team: { id: 'dash1', version: 3 },
    };
    const record = captureTabRecord(t);
    assert.equal(record.name, 'Gulf');
    assert.deepEqual(record.panels.slice(0, 2), [{ key: b, on: true }, { key: a, on: true, bottom: true }]);
    assert.deepEqual(record.scope, { countries: ['AE', 'SA'], neighbours: false });
    assert.deepEqual(record.panelFilters, [{ key: 'forecast', value: 'mena' }]);
    assert.deepEqual(record.team, { id: 'dash1', version: 3 });
  });
});

describe('applyTabRecord', () => {
  it('keeps local-only fields and panels, and carries entries this device cannot render', () => {
    const [a, b, c] = realKeys(3) as [string, string, string];
    const local = tab('tab-a-1', {
      on: [a, b, 'cw-mine'],
      order: [a, b, 'cw-mine'],
      extra: { 'cw-mine': { name: 'My widget', enabled: true } },
    });
    local.panelSettings[a] = { ...local.panelSettings[a]!, fontScale: 1.5 };
    const record: DashboardTabRecord = {
      name: 'Remote',
      panels: [{ key: c, on: true }, { key: a, on: false }, { key: 'cw-theirs', on: true }, { key: 'future-panel', on: true }],
    };
    const { tab: next, carried } = applyTabRecord(local, record, defaults());
    assert.equal(next.name, 'Remote');
    assert.equal(next.panelSettings[a]!.enabled, false);
    assert.equal(next.panelSettings[a]!.fontScale, 1.5, 'font scale is device-local');
    assert.equal(next.panelSettings[c]!.enabled, true);
    assert.equal(next.panelSettings['cw-mine']!.enabled, true, 'local-only widget survives');
    assert.deepEqual(next.panelOrder.slice(0, 2), [c, a]);
    assert.ok(next.panelOrder.includes('cw-mine'));
    assert.deepEqual(carried.map((p) => p.key), ['cw-theirs', 'future-panel']);
    // Carried entries ride along on the next push.
    const pushed = captureTabRecord(next, carried);
    assert.ok(pushed.panels.some((p) => p.key === 'future-panel'));
  });

  it('builds a new tab from the variant defaults', () => {
    const [a] = realKeys(1) as [string];
    const { tab: next } = applyTabRecord(undefined, { name: 'New', panels: [{ key: a, on: true }] }, defaults(), 'tab-r-1');
    assert.equal(next.id, 'tab-r-1');
    assert.equal(next.panelOrder[0], a);
    assert.equal(next.panelSettings[a]!.enabled, true);
  });
});

describe('mergeTabs decision table', () => {
  const [a, b, c] = ['x', 'y', 'z'].map((_, i) => realKeys(3)[i]!) as [string, string, string];

  it('nothing changed on either side: no changes', () => {
    const t1 = tab('tab-a-1', { on: [a] });
    const out = mergeTabs(input({ local: { activeTabId: t1.id, tabs: [t1] }, meta: syncedMeta([t1]), rows: [row(t1.id, 1, captureTabRecord(t1))] }));
    assert.deepEqual(out.changes, []);
    assert.equal(out.changed, false);
  });

  it('unchanged locally, edited remotely: applies the remote record and settles', () => {
    const t1 = tab('tab-a-1', { on: [a] });
    const t2 = tab('tab-a-2', { on: [a] });
    const remote: DashboardTabRecord = { ...captureTabRecord(t2), name: 'Renamed' };
    const meta = syncedMeta([t1, t2]);
    const rows = [row(t1.id, 1, captureTabRecord(t1)), row(t2.id, 2, remote)];
    const out = mergeTabs(input({ local: { activeTabId: t1.id, tabs: [t1, t2] }, meta, rows }));
    assert.equal(out.state.tabs[1]!.name, 'Renamed');
    assert.equal(out.state.activeTabId, t1.id, 'active tab is per device');
    assert.equal(out.activeChanged, false);
    assert.deepEqual(out.changes, []);
    assert.equal(out.meta.base[t2.id]!.version, 2);
    // Fixed point: merging again with the same rows changes nothing.
    const again = mergeTabs(input({ local: out.state, meta: out.meta, rows }));
    assert.deepEqual(again.changes, []);
    assert.equal(again.changed, false);
  });

  it('a record this device renders differently reaches a fixed point', () => {
    const local = tab('tab-a-1', { on: [a, 'cw-mine'], order: [a, 'cw-mine'], extra: { 'cw-mine': { name: 'W', enabled: true } } });
    const remote: DashboardTabRecord = { name: 'R', panels: [{ key: b, on: true }, { key: 'future-panel', on: true }] };
    const rows = [row(local.id, 2, remote)];
    const out = mergeTabs(input({ local: { activeTabId: local.id, tabs: [local] }, meta: syncedMeta([local]), rows }));
    assert.deepEqual(out.changes, []);
    assert.equal(out.activeChanged, true, 'the active tab content changed');
    const again = mergeTabs(input({ local: out.state, meta: out.meta, rows }));
    assert.deepEqual(again.changes, []);
  });

  it('unchanged locally, deleted remotely (or evicted): removes the tab', () => {
    const t1 = tab('tab-a-1');
    const t2 = tab('tab-a-2');
    const t3 = tab('tab-a-3');
    const meta = syncedMeta([t1, t2, t3]);
    const rows = [row(t1.id, 1, captureTabRecord(t1)), row(t2.id, 2, null)];
    const out = mergeTabs(input({ local: { activeTabId: t1.id, tabs: [t1, t2, t3] }, meta, rows }));
    assert.deepEqual(ids(out.state), [t1.id]);
    assert.equal(out.meta.base[t2.id], undefined);
    assert.equal(out.meta.base[t3.id], undefined);
    assert.deepEqual(out.changes, []);
  });

  it('edited locally, unchanged remotely: pushes against the base version', () => {
    const t1 = tab('tab-a-1', { on: [a] });
    const meta = syncedMeta([t1], 4);
    const edited = { ...t1, name: 'Edited' };
    const out = mergeTabs(input({ local: { activeTabId: t1.id, tabs: [edited] }, meta, rows: [row(t1.id, 4, captureTabRecord(t1))] }));
    assert.equal(out.changes.length, 1);
    assert.equal(out.changes[0]!.change.baseVersion, 4);
    assert.equal(out.changes[0]!.change.record!.name, 'Edited');
  });

  it('new local tab with no base: pushes an insert', () => {
    const t1 = tab('tab-a-1');
    const out = mergeTabs(input({ local: { activeTabId: t1.id, tabs: [t1] }, rows: [] }));
    assert.equal(out.changes.length, 1);
    assert.equal(out.changes[0]!.change.baseVersion, undefined);
  });

  it('edited on both sides: the local edit is pushed against the remote version', () => {
    const t1 = tab('tab-a-1', { on: [a] });
    const meta = syncedMeta([t1], 1);
    const out = mergeTabs(input({
      local: { activeTabId: t1.id, tabs: [{ ...t1, name: 'Mine' }] },
      meta,
      rows: [row(t1.id, 3, { ...captureTabRecord(t1), name: 'Theirs' })],
    }));
    assert.equal(out.changes[0]!.change.baseVersion, 3);
    assert.equal(out.changes[0]!.change.record!.name, 'Mine');
    assert.equal(out.state.tabs[0]!.name, 'Mine');
  });

  it('edited locally, deleted remotely: the edit resurrects the tab', () => {
    const t1 = tab('tab-a-1');
    const out = mergeTabs(input({
      local: { activeTabId: t1.id, tabs: [{ ...t1, name: 'Kept' }] },
      meta: syncedMeta([t1], 1),
      rows: [row(t1.id, 2, null)],
    }));
    assert.deepEqual(ids(out.state), [t1.id]);
    assert.equal(out.changes[0]!.change.baseVersion, 2);
    assert.ok(out.changes[0]!.change.record);
  });

  it('edited locally, row evicted: pushes a fresh insert', () => {
    const t1 = tab('tab-a-1');
    const out = mergeTabs(input({
      local: { activeTabId: t1.id, tabs: [{ ...t1, name: 'Kept' }] },
      meta: syncedMeta([t1], 5),
      rows: [],
    }));
    assert.equal(out.changes[0]!.change.baseVersion, undefined);
    assert.ok(out.changes[0]!.change.record);
  });

  it('local delete, remote unchanged: pushes the delete', () => {
    const t1 = tab('tab-a-1');
    const t2 = tab('tab-a-2');
    const meta = { ...syncedMeta([t1, t2], 2), tombstones: [t2.id] };
    const out = mergeTabs(input({
      local: { activeTabId: t1.id, tabs: [t1] },
      meta,
      rows: [row(t1.id, 2, captureTabRecord(t1)), row(t2.id, 2, captureTabRecord(t2))],
    }));
    assert.deepEqual(out.changes.map((c) => c.change), [{ tabId: t2.id, baseVersion: 2, record: null }]);
    assert.deepEqual(ids(out.state), [t1.id]);
  });

  it('local delete, remote edited: the edit wins and the tab comes back', () => {
    const t1 = tab('tab-a-1');
    const t2 = tab('tab-a-2');
    const meta = { ...syncedMeta([t1, t2], 2), tombstones: [t2.id] };
    const out = mergeTabs(input({
      local: { activeTabId: t1.id, tabs: [t1] },
      meta,
      rows: [row(t1.id, 2, captureTabRecord(t1)), row(t2.id, 3, { ...captureTabRecord(t2), name: 'Edited there' })],
    }));
    assert.deepEqual(out.changes, []);
    assert.deepEqual(out.meta.tombstones, []);
    assert.equal(out.state.tabs.find((t) => t.id === t2.id)?.name, 'Edited there');
  });

  it('local delete, remote already deleted or gone: nothing to push', () => {
    const t1 = tab('tab-a-1');
    const meta = { ...syncedMeta([t1], 2), tombstones: ['tab-a-2', 'tab-a-3'] };
    meta.base['tab-a-2'] = { version: 2, hash: 'h' };
    const out = mergeTabs(input({
      local: { activeTabId: t1.id, tabs: [t1] },
      meta,
      rows: [row(t1.id, 2, captureTabRecord(t1)), row('tab-a-2', 3, null)],
    }));
    assert.deepEqual(out.changes, []);
    assert.deepEqual(out.meta.tombstones, []);
    assert.equal(out.meta.base['tab-a-2'], undefined);
  });

  it('a tab missing locally without a tombstone is restored, not deleted', () => {
    const t1 = tab('tab-a-1');
    const t2 = tab('tab-a-2');
    const out = mergeTabs(input({
      local: { activeTabId: t1.id, tabs: [t1] },
      meta: syncedMeta([t1, t2], 1),
      rows: [row(t1.id, 1, captureTabRecord(t1)), row(t2.id, 1, captureTabRecord(t2))],
    }));
    assert.deepEqual(ids(out.state), [t1.id, t2.id]);
    assert.deepEqual(out.changes, []);
  });

  it('new remote tabs are appended in creation order; remote tombstones for unseen tabs are ignored', () => {
    const t1 = tab('tab-a-1');
    const r1 = tab('tab-b-1', { name: 'Second' });
    const r2 = tab('tab-b-2', { name: 'First' });
    const out = mergeTabs(input({
      local: { activeTabId: t1.id, tabs: [t1] },
      meta: syncedMeta([t1], 1),
      rows: [row(t1.id, 1, captureTabRecord(t1)), row(r1.id, 1, captureTabRecord(r1), 20), row(r2.id, 1, captureTabRecord(r2), 10), row('tab-b-3', 2, null)],
    }));
    assert.deepEqual(ids(out.state), [t1.id, r2.id, r1.id]);
    assert.equal(out.meta.base[r1.id]!.version, 1);
    assert.deepEqual(out.changes, []);
  });

  it('concurrent creates on two devices both survive', () => {
    const mine = tab('tab-a-1');
    const theirs = tab('tab-b-1');
    const out = mergeTabs(input({ local: { activeTabId: mine.id, tabs: [mine] }, rows: [row(theirs.id, 1, captureTabRecord(theirs))], mode: 'first-sync' }));
    assert.deepEqual(new Set(ids(out.state)), new Set([mine.id, theirs.id]));
    assert.equal(out.changes.length, 1);
    assert.equal(out.changes[0]!.change.tabId, mine.id);
  });

  it('a remote delete of the active tab moves to its neighbour', () => {
    const t1 = tab('tab-a-1');
    const t2 = tab('tab-a-2');
    const t3 = tab('tab-a-3');
    const out = mergeTabs(input({
      local: { activeTabId: t2.id, tabs: [t1, t2, t3] },
      meta: syncedMeta([t1, t2, t3]),
      rows: [row(t1.id, 1, captureTabRecord(t1)), row(t2.id, 2, null), row(t3.id, 1, captureTabRecord(t3))],
    }));
    assert.equal(out.state.activeTabId, t1.id);
    assert.equal(out.activeChanged, true);
  });

  it('never leaves zero tabs', () => {
    const t1 = tab('tab-a-1');
    const out = mergeTabs(input({
      local: { activeTabId: t1.id, tabs: [t1] },
      meta: syncedMeta([t1]),
      rows: [row(t1.id, 2, null)],
    }));
    assert.equal(out.state.tabs.length, 1);
    assert.equal(out.state.tabs[0]!.name, DEFAULT_NAME);
    assert.equal(out.state.activeTabId, out.state.tabs[0]!.id);
    assert.equal(out.changes.length, 1, 'the replacement default is uploaded');
  });

  it('does not push tabs the server refused for the tab cap', () => {
    const t1 = tab('tab-a-1');
    const out = mergeTabs(input({ local: { activeTabId: t1.id, tabs: [t1] }, rows: [], localOnly: new Set([t1.id]) }));
    assert.deepEqual(out.changes, []);
  });
});

describe('mergeTabs first sync', () => {
  const defaultOn = () => Object.entries(defaults()).filter(([k, c]) => k !== 'map' && c.enabled).map(([k]) => k);

  it('adopts cloud tabs over a lone untouched default tab, with no metadata', () => {
    const lone = tab('tab-l-1', { name: DEFAULT_NAME, on: defaultOn() });
    const cloud = tab('tab-c-1', { name: 'Markets' });
    const out = mergeTabs(input({ local: { activeTabId: lone.id, tabs: [lone] }, rows: [row(cloud.id, 1, captureTabRecord(cloud))], mode: 'first-sync' }));
    assert.deepEqual(ids(out.state), [cloud.id]);
    assert.equal(out.state.activeTabId, cloud.id);
    assert.equal(out.activeChanged, true);
    assert.deepEqual(out.changes, []);
  });

  it('keeps both when the lone tab was renamed or its panels differ from the defaults', () => {
    const cloud = tab('tab-c-1', { name: 'Markets' });
    const renamed = tab('tab-l-1', { name: 'Mine', on: defaultOn() });
    const [a] = realKeys(1) as [string];
    const customized = tab('tab-l-2', { name: DEFAULT_NAME, on: [a] });
    for (const lone of [renamed, customized]) {
      const out = mergeTabs(input({ local: { activeTabId: lone.id, tabs: [lone] }, rows: [row(cloud.id, 1, captureTabRecord(cloud))], mode: 'first-sync' }));
      assert.deepEqual(ids(out.state), [lone.id, cloud.id]);
      assert.equal(out.state.activeTabId, lone.id);
      assert.equal(out.changes.length, 1);
    }
  });

  it('uploads the lone default when the account has no cloud tabs', () => {
    const lone = tab('tab-l-1', { name: DEFAULT_NAME, on: defaultOn() });
    const out = mergeTabs(input({ local: { activeTabId: lone.id, tabs: [lone] }, rows: [], mode: 'first-sync' }));
    assert.deepEqual(ids(out.state), [lone.id]);
    assert.equal(out.changes.length, 1);
  });
});

describe('mergeTabs account switch', () => {
  it("drops the previous account's synced tabs and never uploads them", () => {
    const a1 = tab('tab-a-1', { name: 'A one' });
    const a2 = { ...tab('tab-a-2', { name: 'A two' }), team: { id: 'dashA', version: 2 } };
    const prev = syncedMeta([a1, a2], 3, 'user_a');
    const out = mergeTabs(input({ local: { activeTabId: a1.id, tabs: [a1, a2] }, meta: prev, rows: [], mode: 'account-switch', userId: 'user_b' }));
    assert.equal(out.state.tabs.length, 1);
    assert.ok(![a1.id, a2.id].includes(out.state.tabs[0]!.id));
    assert.equal(out.state.tabs[0]!.team, undefined);
    assert.equal(out.meta.userId, 'user_b');
    assert.ok(out.changes.every((c) => c.change.tabId !== a1.id && c.change.tabId !== a2.id));
  });

  it("adopts the new account's cloud tabs", () => {
    const a1 = tab('tab-a-1');
    const b1 = tab('tab-b-1', { name: 'B tab' });
    const out = mergeTabs(input({
      local: { activeTabId: a1.id, tabs: [a1] },
      meta: syncedMeta([a1], 1, 'user_a'),
      rows: [row(b1.id, 4, captureTabRecord(b1))],
      mode: 'account-switch',
      userId: 'user_b',
    }));
    assert.deepEqual(ids(out.state), [b1.id]);
    assert.equal(out.state.activeTabId, b1.id);
    assert.deepEqual(out.changes, []);
  });

  it('treats every local tab as the previous account\'s when its sync history is unknown', () => {
    const a1 = tab('tab-a-1', { name: 'A one' });
    const out = mergeTabs(input({
      local: { activeTabId: a1.id, tabs: [a1] },
      meta: emptyTabSyncMeta('user_a'),
      rows: [],
      mode: 'account-switch',
      userId: 'user_b',
      previousSyncKnown: false,
    }));
    assert.notEqual(out.state.tabs[0]!.id, a1.id);
    assert.ok(out.changes.every((c) => c.change.tabId !== a1.id));
  });

  it('keeps tabs created or edited after the last sync, without their team link', () => {
    const a1 = tab('tab-a-1');
    const later = { ...tab('tab-s-1', { name: 'Signed-out work' }), team: { id: 'dashA', version: 1 } };
    const out = mergeTabs(input({
      local: { activeTabId: later.id, tabs: [a1, later] },
      meta: syncedMeta([a1], 1, 'user_a'),
      rows: [],
      mode: 'account-switch',
      userId: 'user_b',
    }));
    assert.deepEqual(ids(out.state), [later.id]);
    assert.equal(out.state.tabs[0]!.team, undefined);
    assert.deepEqual(out.changes.map((c) => c.change.tabId), [later.id]);
    assert.equal(out.changes[0]!.change.record!.team, undefined);
  });
});
