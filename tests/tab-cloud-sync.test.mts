/**
 * Dashboard tab sync driver (#11141): src/services/tab-cloud-sync.ts with a
 * fake Convex transport and a fake layout-manager host.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { PanelConfig } from '../src/types/index.ts';
import { resetMissionPresetState } from '../src/services/mission-presets.ts';
import { SITE_VARIANT } from '../src/config/variant.ts';
import type { PanelTab, TabsState } from '../src/services/tab-store.ts';
import type {
  DashboardTabChange,
  DashboardTabRow,
  SyncDashboardTabsResult,
} from '../shared/dashboard-tab-sync.ts';
import {
  __resetTabSyncForTests,
  __setTabSyncTransportForTests,
  loadTabSyncMeta,
  notifyTabsChangedLocally,
  prepareTabSyncSignIn,
  recordTabDeleted,
  startTabSync,
  stopTabSync,
  type TabSyncHost,
  type TabSyncTransport,
} from '../src/services/tab-cloud-sync.ts';

class MemoryStorage {
  readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
}
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

const META_KEY = `worldmonitor-tabs-sync-v1:${SITE_VARIANT}`;
const defaults = (): Record<string, PanelConfig> => resetMissionPresetState({}).panelSettings;

function tab(id: string, name = `Tab ${id}`): PanelTab {
  const panelSettings = defaults();
  return { id, name, panelSettings, panelOrder: Object.keys(panelSettings).filter((k) => k !== 'map'), bottomSet: [] };
}

/** A server that behaves like convex/userPreferences.ts for one account. */
class FakeServer {
  rows = new Map<string, DashboardTabRow>();
  calls: Array<{ expectedUserId: string; changes: DashboardTabChange[] }> = [];
  listeners = new Set<(rows: DashboardTabRow[]) => void>();
  nextResult: SyncDashboardTabsResult | null = null;
  throwOnSync: Error | null = null;
  clock = 1;

  snapshot(): DashboardTabRow[] {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
  emit(): void {
    for (const l of this.listeners) l(this.snapshot());
  }
  transport(userId: string): TabSyncTransport {
    return {
      subscribe: (_variant, onRows) => {
        this.listeners.add(onRows);
        queueMicrotask(() => onRows(this.snapshot()));
        return () => this.listeners.delete(onRows);
      },
      sync: async (args) => {
        this.calls.push({ expectedUserId: args.expectedUserId, changes: structuredClone(args.changes) });
        if (this.throwOnSync) throw this.throwOnSync;
        if (this.nextResult) {
          const r = this.nextResult;
          this.nextResult = null;
          return r;
        }
        if (args.expectedUserId !== userId) return { ok: false, reason: 'WRONG_ACCOUNT' };
        const results = args.changes.map((change) => {
          const row = this.rows.get(change.tabId);
          if (row?.version !== change.baseVersion) {
            return { tabId: change.tabId, ok: false as const, reason: 'CONFLICT' as const, row: row ? structuredClone(row) : null };
          }
          const version = (row?.version ?? 0) + 1;
          const now = (this.clock += 1);
          this.rows.set(change.tabId, change.record
            ? { tabId: change.tabId, version, deleted: false, record: change.record, createdAt: row?.createdAt ?? now, updatedAt: now }
            : { tabId: change.tabId, version, deleted: true, createdAt: row?.createdAt ?? now, updatedAt: now });
          return { tabId: change.tabId, ok: true as const, version };
        });
        queueMicrotask(() => this.emit());
        return { ok: true, results };
      },
    };
  }
}

class FakeHost implements TabSyncHost {
  applied: Array<{ state: TabsState; activeChanged: boolean }> = [];
  constructor(public state: TabsState) {}
  captureTabs(): TabsState { return structuredClone(this.state); }
  applyTabs(next: TabsState, activeChanged: boolean): void {
    this.state = structuredClone(next);
    this.applied.push({ state: structuredClone(next), activeChanged });
  }
  currentPanelSettings(): Record<string, PanelConfig> { return defaults(); }
  defaultTabName(): string { return 'Main'; }
  private n = 0;
  newTabId(): string { return `tab-host${(this.n += 1)}-qq`; }
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

let server: FakeServer;
function useServer(s: FakeServer) {
  __setTabSyncTransportForTests(async (userId) => s.transport(userId));
}

function signIn(userId: string, host: FakeHost, onStopped: (reason: string) => void = () => {}) {
  const { willSync } = prepareTabSyncSignIn(userId, true);
  assert.equal(willSync, true);
  startTabSync(userId, host, onStopped);
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: new MemoryStorage() });
  server = new FakeServer();
  useServer(server);
});

afterEach(() => {
  __resetTabSyncForTests();
  __setTabSyncTransportForTests(null);
  mock.timers.reset();
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('tab sync driver', () => {
  it('a first sign-in uploads local tabs and records the account', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), tab('tab-a-2')] });
    signIn('user_a', host);
    await settle();
    assert.equal(server.calls.length, 1);
    assert.deepEqual(server.calls[0]!.changes.map((c) => c.tabId).sort(), ['tab-a-1', 'tab-a-2']);
    assert.equal(server.calls[0]!.expectedUserId, 'user_a');
    const meta = loadTabSyncMeta()!;
    assert.equal(meta.userId, 'user_a');
    assert.equal(meta.base['tab-a-1']!.version, 1);
    // The echo from the subscription is a no-op.
    assert.equal(server.calls.length, 1);
  });

  it('applies a remote edit through the host', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), tab('tab-a-2')] });
    signIn('user_a', host);
    await settle();
    const row = server.rows.get('tab-a-2')!;
    server.rows.set('tab-a-2', { ...row, version: row.version + 1, record: { ...row.record!, name: 'From phone' } });
    server.emit();
    await settle();
    assert.equal(host.state.tabs[1]!.name, 'From phone');
    assert.equal(host.state.activeTabId, 'tab-a-1');
    assert.equal(host.applied.at(-1)!.activeChanged, false);
  });

  it('does not echo a remote edit the layout shows in its own panel order', async () => {
    // The real layout places some panels itself (the map's neighbours), so the
    // active tab can read back in a different order than the record it applied.
    // Pushing that back would bounce between devices that place panels differently.
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    class ReorderingHost extends FakeHost {
      override applyTabs(next: TabsState, activeChanged: boolean): void {
        super.applyTabs(next, activeChanged);
        const active = this.state.tabs.find((t) => t.id === this.state.activeTabId)!;
        if (activeChanged) active.panelOrder = [...active.panelOrder.slice(-1), ...active.panelOrder.slice(0, -1)];
      }
    }
    const host = new ReorderingHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    const before = server.calls.length;
    const row = server.rows.get('tab-a-1')!;
    server.rows.set('tab-a-1', { ...row, version: row.version + 1, record: { ...row.record!, name: 'From phone' } });
    server.emit();
    await settle();
    assert.equal(host.state.tabs[0]!.name, 'From phone');
    notifyTabsChangedLocally();
    mock.timers.tick(30_000);
    await settle();
    assert.equal(server.calls.length, before, 'the applied edit is not pushed back');

    // A real edit afterwards still goes out.
    host.state.tabs[0]!.name = 'Edited here';
    notifyTabsChangedLocally();
    mock.timers.tick(2_000);
    await settle();
    assert.equal(server.calls.length, before + 1);
    assert.equal(server.calls.at(-1)!.changes[0]!.record!.name, 'Edited here');
  });

  it('pushes a local change once after the debounce', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    const before = server.calls.length;
    host.state.tabs[0]!.name = 'Renamed';
    notifyTabsChangedLocally();
    notifyTabsChangedLocally();
    await settle();
    assert.equal(server.calls.length, before, 'nothing before the debounce');
    mock.timers.tick(2_000);
    await settle();
    assert.equal(server.calls.length, before + 1);
    assert.equal(server.calls.at(-1)!.changes[0]!.record!.name, 'Renamed');
  });

  it('re-merges and retries once on a conflict', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    // Another device bumped the row; this device edited too.
    const row = server.rows.get('tab-a-1')!;
    server.rows.set('tab-a-1', { ...row, version: 5, record: { ...row.record!, name: 'Theirs' } });
    host.state.tabs[0]!.name = 'Mine';
    const before = server.calls.length;
    // Trigger a pass with stale rows (the subscription has not caught up).
    server.listeners.forEach((l) => l([row]));
    await settle();
    const pushes = server.calls.slice(before);
    assert.equal(pushes[0]!.changes[0]!.baseVersion, row.version);
    assert.equal(pushes[1]!.changes[0]!.baseVersion, 5);
    assert.equal(server.rows.get('tab-a-1')!.record!.name, 'Mine');
  });

  it('keeps edits after RATE_LIMITED and resends them later', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    server.nextResult = { ok: false, reason: 'RATE_LIMITED', limit: 30, reset: 0 };
    signIn('user_a', host);
    await settle();
    assert.equal(server.rows.size, 0);
    server.emit();
    await settle();
    assert.equal(server.rows.size, 1, 'the next pass resends');
  });

  it('does not retry a tab the server refused for the cap', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    server.nextResult = { ok: true, results: [{ tabId: 'tab-a-1', ok: false, reason: 'TAB_LIMIT', limit: 50 }] };
    signIn('user_a', host);
    await settle();
    const before = server.calls.length;
    server.emit();
    await settle();
    assert.equal(server.calls.length, before);
  });

  it('a thrown error stops sync quietly and reports it', async () => {
    const stopped: string[] = [];
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    server.throwOnSync = new Error('Could not find public function for userPreferences:syncDashboardTabs');
    signIn('user_a', host, (r) => stopped.push(r));
    await settle();
    assert.deepEqual(stopped, ['error']);
    assert.equal(host.state.tabs.length, 1);
    // Off for the rest of the page.
    assert.equal(prepareTabSyncSignIn('user_a', true).willSync, false);
  });

  it('a result for a signed-out session is discarded', async () => {
    let release!: (r: SyncDashboardTabsResult) => void;
    const slow: TabSyncTransport = {
      subscribe: (_v, onRows) => { queueMicrotask(() => onRows([])); return () => {}; },
      sync: () => new Promise((resolve) => { release = resolve; }),
    };
    __setTabSyncTransportForTests(async () => slow);
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    stopTabSync();
    release({ ok: true, results: [{ tabId: 'tab-a-1', ok: true, version: 1 }] });
    await settle();
    assert.equal(loadTabSyncMeta()!.base['tab-a-1'], undefined);
  });

  it("an account switch never sends the previous account's tabs", async () => {
    const hostA = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), tab('tab-a-2')] });
    signIn('user_a', hostA);
    await settle();
    stopTabSync();

    const serverB = new FakeServer();
    useServer(serverB);
    const hostB = new FakeHost(hostA.state);
    signIn('user_b', hostB);
    await settle();
    const sent = serverB.calls.flatMap((c) => c.changes.map((ch) => ch.tabId));
    assert.ok(!sent.includes('tab-a-1') && !sent.includes('tab-a-2'));
    assert.equal(hostB.state.tabs.length, 1);
    assert.equal(loadTabSyncMeta()!.userId, 'user_b');
  });

  it('a tab made while signed out goes to the next account, alone', async () => {
    const hostA = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', hostA);
    await settle();
    stopTabSync();
    hostA.state.tabs.push(tab('tab-s-1', 'Signed out'));

    const serverB = new FakeServer();
    useServer(serverB);
    const hostB = new FakeHost(hostA.state);
    signIn('user_b', hostB);
    await settle();
    assert.deepEqual(serverB.calls.flatMap((c) => c.changes.map((ch) => ch.tabId)), ['tab-s-1']);
  });

  it('falls back to the last signed-in account when no tab sync state exists', async () => {
    localStorage.setItem('wm-last-signed-in-as', 'user_a');
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1', 'A work')] });
    signIn('user_b', host);
    await settle();
    assert.ok(server.calls.every((c) => c.changes.every((ch) => ch.tabId !== 'tab-a-1')));
  });

  it('WRONG_ACCOUNT stops the driver', async () => {
    const stopped: string[] = [];
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    server.nextResult = { ok: false, reason: 'WRONG_ACCOUNT' };
    signIn('user_a', host, (r) => stopped.push(r));
    await settle();
    assert.deepEqual(stopped, ['wrong-account']);
    assert.equal(prepareTabSyncSignIn('user_a', true).willSync, true, 'a restart is allowed');
  });

  it('only an explicit delete propagates', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), tab('tab-a-2'), tab('tab-a-3')] });
    signIn('user_a', host);
    await settle();
    // tab-a-2 deleted by the user; tab-a-3 lost to a stale window's save.
    host.state.tabs = host.state.tabs.filter((t) => t.id === 'tab-a-1');
    recordTabDeleted('tab-a-2');
    server.emit();
    await settle();
    assert.equal(server.rows.get('tab-a-2')!.deleted, true);
    assert.equal(server.rows.get('tab-a-3')!.deleted, false);
    assert.deepEqual(host.state.tabs.map((t) => t.id), ['tab-a-1', 'tab-a-3']);
  });

  it('a tabs blob imported between loads uploads at the next start', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    stopTabSync();
    // An import replaced the tab's contents while the page was closed.
    host.state.tabs[0]!.name = 'Imported';
    signIn('user_a', host);
    await settle();
    assert.equal(server.rows.get('tab-a-1')!.record!.name, 'Imported');
  });

  it('stays off when cloud sync is disabled', () => {
    assert.equal(prepareTabSyncSignIn('user_a', false).willSync, false);
    assert.equal(localStorage.getItem(META_KEY), null);
  });
});
