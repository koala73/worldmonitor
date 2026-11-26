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
  signOutTabSync,
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
        // Like Convex: a call that wrote nothing sends no update.
        if (results.some((r) => r.ok)) queueMicrotask(() => this.emit());
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
  defaultPanelOrder(): string[] { return tab('tab-x-1').panelOrder; }
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

  it('a conflict retry keeps the edits and deletes the same push landed', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), tab('tab-a-2'), tab('tab-a-3')] });
    signIn('user_a', host);
    await settle();
    const stale = server.snapshot();
    const row = server.rows.get('tab-a-1')!;
    server.rows.set('tab-a-1', { ...row, version: 5, record: { ...row.record!, name: 'Theirs' } });
    host.state.tabs[0]!.name = 'Mine';
    host.state.tabs[1]!.name = 'Renamed';
    host.state.tabs = host.state.tabs.filter((t) => t.id !== 'tab-a-3');
    recordTabDeleted('tab-a-3');
    // A pass on rows from before the other device's edit.
    const appliedBefore = host.applied.length;
    server.listeners.forEach((l) => l(stale));
    await settle();
    // No pass may show the landed rename undone or the deleted tab back.
    for (const { state } of host.applied.slice(appliedBefore)) {
      assert.deepEqual(state.tabs.map((t) => [t.id, t.name]), [['tab-a-1', 'Mine'], ['tab-a-2', 'Renamed']]);
    }
    assert.equal(server.rows.get('tab-a-1')!.record!.name, 'Mine');
    assert.equal(server.rows.get('tab-a-2')!.record!.name, 'Renamed');
    assert.equal(server.rows.get('tab-a-3')!.deleted, true);
    assert.deepEqual(host.state.tabs.map((t) => [t.id, t.name]), [['tab-a-1', 'Mine'], ['tab-a-2', 'Renamed']]);
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

  it('a deployment without the functions stops sync for the page', async () => {
    const stopped: string[] = [];
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    server.throwOnSync = new Error('Could not find public function for userPreferences:syncDashboardTabs');
    signIn('user_a', host, (r) => stopped.push(r));
    await settle();
    assert.deepEqual(stopped, ['unavailable']);
    assert.equal(host.state.tabs.length, 1);
    assert.equal(prepareTabSyncSignIn('user_a', true).willSync, false);
  });

  it('reconnects after an error, and stops after repeated failures', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const stopped: string[] = [];
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    server.throwOnSync = new Error('Server Error');
    signIn('user_a', host, (r) => stopped.push(r));
    await settle();
    assert.deepEqual(stopped, [], 'not yet: a reconnect is pending');
    server.throwOnSync = null;
    mock.timers.tick(15_000);
    await settle();
    assert.equal(server.rows.get('tab-a-1')!.record!.name, 'Tab tab-a-1', 'the reconnect pushed');

    // A clean pass resets the budget: two more failures are retried again.
    server.throwOnSync = new Error('Server Error');
    host.state.tabs[0]!.name = 'Edit';
    notifyTabsChangedLocally();
    mock.timers.tick(2_000);
    await settle();
    mock.timers.tick(15_000);
    await settle();
    assert.deepEqual(stopped, [], 'a fresh budget after the clean pass');
    mock.timers.tick(60_000);
    await settle();
    assert.deepEqual(stopped, ['error'], 'three failures in a row');
  });

  it('an auth handshake that is not ready is retried, not latched off', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let attempts = 0;
    __setTabSyncTransportForTests(async (userId) => (attempts += 1) === 1 ? 'auth-timeout' : server.transport(userId));
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    assert.equal(server.rows.size, 0);
    mock.timers.tick(15_000);
    await settle();
    assert.equal(server.rows.size, 1);
  });

  it('a subscription error reconnects', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let fireError!: (err: Error) => void;
    let subscriptions = 0;
    __setTabSyncTransportForTests(async (userId) => {
      const t = server.transport(userId);
      return { ...t, subscribe: (v, onRows, onError) => { subscriptions += 1; fireError = onError; return t.subscribe(v, onRows, onError); } };
    });
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    fireError(new Error('socket closed'));
    assert.equal(server.listeners.size, 0, 'the old subscription is dropped');
    mock.timers.tick(15_000);
    await settle();
    assert.equal(subscriptions, 2);
    assert.equal(server.listeners.size, 1);
  });

  it('pushes an edit when the page is hidden, before the debounce', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const doc = new EventTarget() as EventTarget & { visibilityState: string };
    doc.visibilityState = 'visible';
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
    try {
      const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
      signIn('user_a', host);
      await settle();
      host.state.tabs[0]!.name = 'Closing';
      notifyTabsChangedLocally();
      doc.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
      await settle();
      assert.equal(server.rows.get('tab-a-1')!.record!.name, 'Closing');
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it('two windows of one account converge instead of pushing back and forth', async () => {
    // A second window: its own module instance, sharing this storage. Its
    // subscription is delivered by hand, after window 1 has its result, as
    // happens when the two windows' connections deliver at different times.
    const w2 = await import('../src/services/tab-cloud-sync.ts?window2') as typeof import('../src/services/tab-cloud-sync.ts');
    let deliver2!: (rows: DashboardTabRow[]) => void;
    w2.__setTabSyncTransportForTests(async (userId) => ({
      ...server.transport(userId),
      subscribe: (_v, onRows) => { deliver2 = onRows; return () => {}; },
    }));
    try {
      const host1 = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
      signIn('user_a', host1);
      await settle();
      const host2 = new FakeHost(structuredClone(host1.state));
      assert.equal(w2.prepareTabSyncSignIn('user_a', true).willSync, true);
      w2.startTabSync('user_a', host2);
      await settle();
      deliver2(server.snapshot());
      await settle();

      const before = server.calls.length;
      host1.state.tabs[0]!.name = 'From window 1';
      server.emit();
      await settle();
      deliver2(server.snapshot());
      await settle();
      server.emit();
      await settle();
      assert.equal(server.calls.length, before + 1, 'one push, no echo');
      assert.equal(server.rows.get('tab-a-1')!.record!.name, 'From window 1');
      assert.equal(host2.state.tabs[0]!.name, 'From window 1');
    } finally {
      w2.__resetTabSyncForTests();
    }
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
    signOutTabSync(hostA);
    hostA.state.tabs.push(tab('tab-s-1', 'Signed out'));

    const serverB = new FakeServer();
    useServer(serverB);
    const hostB = new FakeHost(hostA.state);
    signIn('user_b', hostB);
    await settle();
    assert.deepEqual(serverB.calls.flatMap((c) => c.changes.map((ch) => ch.tabId)), ['tab-s-1']);
  });

  it("an edit the previous account never received stays out of the next account", async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const hostA = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', hostA);
    await settle();
    // Edited and a tab added inside the debounce, then a direct switch.
    hostA.state.tabs[0]!.name = 'A private';
    hostA.state.tabs.push(tab('tab-a-9', 'A new'));
    notifyTabsChangedLocally();

    const serverB = new FakeServer();
    useServer(serverB);
    const hostB = hostA;
    signIn('user_b', hostB);
    await settle();
    const sent = serverB.calls.flatMap((c) => c.changes.map((ch) => ch.record?.name));
    assert.ok(!sent.includes('A private') && !sent.includes('A new'), JSON.stringify(sent));
  });

  it('held tabs come back when the previous account signs in again', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const serverA = server;
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    host.state.tabs[0]!.name = 'A private';
    host.state.tabs.push(tab('tab-a-9', 'A new'));
    notifyTabsChangedLocally();

    const serverB = new FakeServer();
    useServer(serverB);
    signIn('user_b', host);
    await settle();
    assert.ok(!host.state.tabs.some((t) => t.name === 'A private' || t.name === 'A new'), 'not on screen for B');
    signOutTabSync(host);

    useServer(serverA);
    signIn('user_a', host);
    await settle();
    assert.equal(serverA.rows.get('tab-a-1')!.record!.name, 'A private');
    assert.equal(serverA.rows.get('tab-a-9')!.record!.name, 'A new');
    assert.ok(serverB.calls.every((c) => c.changes.every((ch) => ch.record?.name !== 'A private' && ch.record?.name !== 'A new')));
  });

  it('a tab refused for the cap stays with its account across a switch', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    host.state.tabs.push(tab('tab-a-51', 'Over the cap'));
    server.nextResult = { ok: true, results: [{ tabId: 'tab-a-51', ok: false, reason: 'TAB_LIMIT', limit: 50 }] };
    notifyTabsChangedLocally();
    server.emit();
    await settle();
    signOutTabSync(host);

    const serverB = new FakeServer();
    useServer(serverB);
    signIn('user_b', host);
    await settle();
    assert.ok(serverB.calls.every((c) => c.changes.every((ch) => ch.tabId !== 'tab-a-51')));
    assert.ok(!host.state.tabs.some((t) => t.id === 'tab-a-51'));
    signOutTabSync(host);

    useServer(server);
    signIn('user_a', host);
    await settle();
    assert.ok(host.state.tabs.some((t) => t.id === 'tab-a-51' && t.name === 'Over the cap'), 'back on its account');
  });

  it('an edit made after sync stopped on an error stays out of the next account', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    stopTabSync(); // sync gave up; the account is still signed in
    host.state.tabs[0]!.name = 'A while sync was off';

    const serverB = new FakeServer();
    useServer(serverB);
    signIn('user_b', host);
    await settle();
    assert.ok(serverB.calls.every((c) => c.changes.every((ch) => ch.record?.name !== 'A while sync was off')));
  });

  it('a conflict that finds no server row hides the stale row for the retry', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    const stale = server.snapshot();
    server.rows.delete('tab-a-1'); // gone on the server (an evicted delete marker)
    host.state.tabs[0]!.name = 'Mine';
    const before = server.calls.length;
    server.listeners.forEach((l) => l(stale));
    await settle();
    const pushes = server.calls.slice(before).map((c) => c.changes[0]!.baseVersion);
    assert.deepEqual(pushes, [1, undefined], 'the retry creates the tab instead of repeating the conflict');
    assert.equal(server.rows.get('tab-a-1')!.record!.name, 'Mine');
  });

  it('signing back in clears the last sign-out, even if sync never runs a pass', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    signOutTabSync(host);
    // Next load: user_a is back but tab sync cannot reach the deployment.
    __resetTabSyncForTests();
    __setTabSyncTransportForTests(async () => null);
    signIn('user_a', host);
    await settle();
    host.state.tabs[0]!.name = 'A secret edit';
    // Next load: a direct switch to user_b.
    __resetTabSyncForTests();
    const serverB = new FakeServer();
    useServer(serverB);
    signIn('user_b', host);
    await settle();
    assert.ok(serverB.calls.every((c) => c.changes.every((ch) => ch.record?.name !== 'A secret edit')));
  });

  it('signing back in clears the last sign-out when sync is off for the page', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    signOutTabSync(host);
    assert.equal(prepareTabSyncSignIn('user_a', false).willSync, false);
    assert.equal(loadTabSyncMeta()!.signedOut, undefined);
  });

  it('does not overwrite a held store it cannot parse', async () => {
    const key = `worldmonitor-tabs-held-v1:${SITE_VARIANT}`;
    localStorage.setItem(key, '{not json');
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    host.state.tabs.push(tab('tab-a-2', 'Unpushed'));
    useServer(new FakeServer());
    signIn('user_b', host);
    await settle();
    assert.equal(localStorage.getItem(key), '{not json');
    assert.ok(host.state.tabs.some((t) => t.name === 'Unpushed'), 'kept on the device');
  });

  it("keeps a pre-sync account's tabs for it instead of dropping them", async () => {
    localStorage.setItem('wm-last-signed-in-as', 'user_a');
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1', 'A work')] });
    signIn('user_b', host);
    await settle();
    assert.ok(!host.state.tabs.some((t) => t.name === 'A work'), 'not shown to user_b');
    signOutTabSync(host);
    useServer(new FakeServer());
    signIn('user_a', host);
    await settle();
    assert.ok(host.state.tabs.some((t) => t.name === 'A work'));
  });

  it('shows a remote edit to a tab recreated after a conflict found no row', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), tab('tab-a-2')] });
    signIn('user_a', host);
    await settle();
    for (const name of ['x2', 'x3']) { host.state.tabs[0]!.name = name; server.emit(); await settle(); }
    const stale = server.snapshot();
    server.rows.delete('tab-a-1');
    host.state.tabs[0]!.name = 'Mine';
    server.listeners.forEach((l) => l(stale));
    await settle();
    assert.equal(server.rows.get('tab-a-1')!.version, 1, 'recreated');
    const r = server.rows.get('tab-a-1')!;
    server.rows.set('tab-a-1', { ...r, version: 2, record: { ...r.record!, name: 'Remote edit' } });
    server.emit();
    await settle();
    assert.equal(host.state.tabs.find((t) => t.id === 'tab-a-1')!.name, 'Remote edit');
  });

  it('keeps the tabs on the device when they cannot be held for the previous account', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    host.state.tabs[0]!.name = 'A unpushed';
    const store = localStorage as unknown as MemoryStorage;
    const setItem = store.setItem.bind(store);
    store.setItem = (key, value) => {
      if (key.startsWith('worldmonitor-tabs-held-v1')) throw new Error('QuotaExceededError');
      setItem(key, value);
    };
    const serverB = new FakeServer();
    useServer(serverB);
    signIn('user_b', host);
    await settle();
    assert.ok(host.state.tabs.some((t) => t.name === 'A unpushed'), 'still on the device');
    assert.ok(serverB.calls.every((c) => c.changes.every((ch) => ch.record?.name !== 'A unpushed')));
  });

  it('holds compact records, not whole tabs', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    host.state.tabs.push(tab('tab-a-2', 'Unpushed'));
    useServer(new FakeServer());
    signIn('user_b', host);
    await settle();
    const raw = localStorage.getItem(`worldmonitor-tabs-held-v1:${SITE_VARIANT}`)!;
    assert.ok(raw.length < JSON.stringify(tab('tab-a-2')).length / 2, `${raw.length} bytes`);
  });

  it('a tab deleted while its first push is on the way stays deleted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setTabSyncTransportForTests(async (userId) => {
      const t = server.transport(userId);
      return { ...t, sync: async (args) => { await gate; return t.sync(args); } };
    });
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), tab('tab-a-2')] });
    signIn('user_a', host);
    await settle();
    host.state.tabs = host.state.tabs.filter((t) => t.id !== 'tab-a-2');
    recordTabDeleted('tab-a-2');
    release();
    await settle();
    server.emit();
    await settle();
    assert.equal(server.rows.get('tab-a-2')!.deleted, true);
    assert.deepEqual(host.state.tabs.map((t) => t.id), ['tab-a-1']);
  });

  it('stays local when the sync state cannot be read', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, writable: true,
      value: { getItem() { throw new Error('SecurityError'); }, setItem() {}, removeItem() {} },
    });
    assert.equal(prepareTabSyncSignIn('user_a', true).willSync, false);
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
