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
import { captureTabRecord } from '../src/services/tab-sync-merge.ts';
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
const HELD_KEY = `worldmonitor-tabs-held-v1:${SITE_VARIANT}`;
const SIGNED_IN_KEY = `worldmonitor-tabs-signed-in-v1:${SITE_VARIANT}`;
const DEPARTED_KEY = `worldmonitor-tabs-departed-v1:${SITE_VARIANT}`;
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
  const { willSync } = prepareTabSyncSignIn(userId, true, host);
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

  /** The account already holds 50 tabs from other devices. */
  function fillToCap(s: FakeServer) {
    for (let i = 0; i < 50; i += 1) {
      const id = `tab-r${i}-zz`;
      s.rows.set(id, { tabId: id, version: 1, deleted: false, record: { name: `Remote ${i}`, panels: [] }, createdAt: i, updatedAt: i });
    }
  }

  it('does not retry a tab the server refused for the cap while the account is full', async () => {
    fillToCap(server);
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    server.nextResult = { ok: true, results: [{ tabId: 'tab-a-1', ok: false, reason: 'TAB_LIMIT', limit: 50 }] };
    signIn('user_a', host);
    await settle();
    const before = server.calls.length;
    server.emit();
    await settle();
    assert.equal(server.calls.length, before);
  });

  it('retries a tab refused for the cap once a delete makes room', async () => {
    fillToCap(server);
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    server.nextResult = { ok: true, results: [{ tabId: 'tab-a-1', ok: false, reason: 'TAB_LIMIT', limit: 50 }] };
    signIn('user_a', host);
    await settle();
    assert.equal(server.rows.has('tab-a-1'), false);
    // Another device deletes a tab.
    const freed = server.rows.get('tab-r0-zz')!;
    server.rows.set('tab-r0-zz', { tabId: 'tab-r0-zz', version: freed.version + 1, deleted: true, createdAt: freed.createdAt, updatedAt: 99 });
    server.emit();
    await settle();
    assert.equal(server.rows.get('tab-a-1')?.deleted, false, 'uploaded once there was room');
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

  it('a delete the previous account never received reaches it at its next sign-in', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const serverA = server;
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), tab('tab-a-2')] });
    signIn('user_a', host);
    await settle();
    host.state.tabs = host.state.tabs.filter((t) => t.id !== 'tab-a-2');
    recordTabDeleted('tab-a-2'); // inside the debounce: not pushed yet

    useServer(new FakeServer());
    signIn('user_b', host);
    await settle();
    signOutTabSync(host);

    useServer(serverA);
    signIn('user_a', host);
    await settle();
    assert.equal(serverA.rows.get('tab-a-2')!.deleted, true);
    assert.ok(!host.state.tabs.some((t) => t.id === 'tab-a-2'));
  });

  /** A transport for `s` whose writes wait until `release` is called. */
  function gated(s: FakeServer) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setTabSyncTransportForTests(async (userId) => {
      const t = s.transport(userId);
      return { ...t, sync: async (args) => { await gate; return t.sync(args); } };
    });
    return () => release();
  }

  it('an edit made during the first upload is not lost to that upload across a switch', async () => {
    const serverA = server;
    const release = gated(serverA);
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1', 'Draft')] });
    signIn('user_a', host);
    await settle();
    host.state.tabs[0]!.name = 'Final';

    useServer(new FakeServer());
    signIn('user_b', host);
    release(); // A's first upload lands after A's session is gone
    await settle();
    assert.equal(serverA.rows.get('tab-a-1')!.record!.name, 'Draft');
    signOutTabSync(host);

    useServer(serverA);
    signIn('user_a', host);
    await settle();
    assert.equal(host.state.tabs.find((t) => t.id === 'tab-a-1')!.name, 'Final');
    assert.equal(serverA.rows.get('tab-a-1')!.record!.name, 'Final');
  });

  it('a tab deleted during its first upload stays deleted after a sign-out', async () => {
    const release = gated(server);
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), tab('tab-a-2')] });
    signIn('user_a', host);
    await settle();
    host.state.tabs = host.state.tabs.filter((t) => t.id !== 'tab-a-2');
    recordTabDeleted('tab-a-2');
    signOutTabSync(host);
    release();
    await settle();
    assert.equal(server.rows.get('tab-a-2')!.deleted, false, 'the insert landed');

    useServer(server);
    signIn('user_a', host);
    await settle();
    assert.equal(server.rows.get('tab-a-2')!.deleted, true);
    assert.ok(!host.state.tabs.some((t) => t.id === 'tab-a-2'));
  });

  it("tabs made under an account whose sync never ran stay that account's", async () => {
    const serverA = server;
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    signOutTabSync(host, 'user_a');

    // Next load: user_b signs in, but tab sync cannot reach the deployment.
    __resetTabSyncForTests();
    __setTabSyncTransportForTests(async () => null);
    signIn('user_b', host);
    await settle();
    host.state.tabs.push(tab('tab-b-1', 'B private'));
    host.state.tabs[0]!.name = 'B renamed A';
    signOutTabSync(host, 'user_b');

    __resetTabSyncForTests();
    useServer(serverA);
    signIn('user_a', host);
    await settle();
    const sentToA = serverA.calls.flatMap((c) => c.changes.map((ch) => ch.record?.name));
    assert.ok(!sentToA.includes('B private') && !sentToA.includes('B renamed A'), JSON.stringify(sentToA));
    assert.ok(!host.state.tabs.some((t) => t.name === 'B private' || t.name === 'B renamed A'), 'not shown to user_a');
    assert.equal(host.state.tabs.find((t) => t.id === 'tab-a-1')!.name, 'Tab tab-a-1');
    signOutTabSync(host, 'user_a');

    const serverB = new FakeServer();
    useServer(serverB);
    signIn('user_b', host);
    await settle();
    assert.ok(host.state.tabs.some((t) => t.name === 'B private'), "back for user_b");
    assert.ok(serverB.calls.some((c) => c.changes.some((ch) => ch.record?.name === 'B private')));
  });

  it("a direct switch back keeps out tabs made under an account whose sync never ran", async () => {
    const serverA = server;
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    __resetTabSyncForTests();
    __setTabSyncTransportForTests(async () => null);
    signIn('user_b', host);
    await settle();
    host.state.tabs.push(tab('tab-b-1', 'B private'));
    __resetTabSyncForTests();
    useServer(serverA);
    signIn('user_a', host);
    await settle();
    assert.ok(serverA.calls.every((c) => c.changes.every((ch) => ch.record?.name !== 'B private')));
    assert.ok(!host.state.tabs.some((t) => t.name === 'B private'));
  });

  it("on a device that never synced, an unsynced account's tabs do not go to the next account", async () => {
    __setTabSyncTransportForTests(async () => null);
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1', 'Before anyone')] });
    signIn('user_b', host);
    await settle();
    host.state.tabs.push(tab('tab-b-1', 'B private'));
    signOutTabSync(host, 'user_b');

    __resetTabSyncForTests();
    const serverC = new FakeServer();
    useServer(serverC);
    signIn('user_c', host);
    await settle();
    assert.ok(serverC.calls.every((c) => c.changes.every((ch) => ch.record?.name !== 'B private')));
    assert.ok(!host.state.tabs.some((t) => t.name === 'B private'));
  });

  it("an owner's edit made without a sync pass is not filed under the next unsynced account", async () => {
    const serverA = server;
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    // Next load: user_a is back, but sync cannot run; it edits, then user_b signs in directly.
    __resetTabSyncForTests();
    __setTabSyncTransportForTests(async () => null);
    signIn('user_a', host);
    await settle();
    host.state.tabs[0]!.name = 'A edit';
    __resetTabSyncForTests();
    __setTabSyncTransportForTests(async () => null);
    signIn('user_b', host);
    await settle();
    host.state.tabs.push(tab('tab-b-1', 'B private'));

    __resetTabSyncForTests();
    useServer(new FakeServer());
    signIn('user_c', host);
    await settle();
    signOutTabSync(host, 'user_c');
    const held = JSON.parse(localStorage.getItem(`worldmonitor-tabs-held-v1:${SITE_VARIANT}`) ?? '{}');
    assert.deepEqual(held.user_a?.records.map((r: { id: string }) => r.id), ['tab-a-1']);
    assert.deepEqual(held.user_b?.records.map((r: { id: string }) => r.id), ['tab-b-1']);
  });

  it('records a departure seen before the tabs load at the first pass', async () => {
    const serverA = server;
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    __resetTabSyncForTests();
    __setTabSyncTransportForTests(async () => null);
    signIn('user_b', host);
    await settle();
    host.state.tabs.push(tab('tab-b-1', 'B private'));

    // Next load: user_a signs in before the layout has its tabs.
    __resetTabSyncForTests();
    useServer(serverA);
    class LateHost extends FakeHost {
      ready = false;
      override captureTabs(): TabsState { return this.ready ? super.captureTabs() : (null as unknown as TabsState); }
    }
    const late = new LateHost(host.state);
    assert.equal(prepareTabSyncSignIn('user_a', true, late).willSync, true);
    late.ready = true;
    startTabSync('user_a', late);
    await settle();
    assert.ok(serverA.calls.every((c) => c.changes.every((ch) => ch.record?.name !== 'B private')));
    assert.ok(!late.state.tabs.some((t) => t.name === 'B private'));
  });

  it('keeps every tab on the device when they do not all fit in the held store', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    stopTabSync();
    for (let i = 0; i < 51; i += 1) host.state.tabs.push(tab(`tab-u${i}-qq`, `Unpushed ${i}`));
    const serverB = new FakeServer();
    useServer(serverB);
    signIn('user_b', host);
    await settle();
    assert.equal(host.state.tabs.filter((t) => t.name.startsWith('Unpushed')).length, 51);
    assert.ok(serverB.calls.every((c) => c.changes.every((ch) => !ch.record?.name.startsWith('Unpushed'))));
  });

  it('two failures before a reconnect leave one subscription', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let onError!: (err: Error) => void;
    let subscribes = 0;
    __setTabSyncTransportForTests(async (userId) => {
      const t = server.transport(userId);
      return {
        ...t,
        subscribe: (variant, onRows, err) => { subscribes += 1; onError = err; return t.subscribe(variant, onRows, err); },
      };
    });
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    server.throwOnSync = new Error('network');
    signIn('user_a', host);
    await settle();
    onError(new Error('socket closed')); // a second failure before the first reconnect
    server.throwOnSync = null;
    mock.timers.tick(60_000);
    await settle();
    mock.timers.tick(60_000);
    await settle();
    assert.equal(subscribes, 2, 'one reconnect');
    assert.equal(server.listeners.size, 1);
  });

  it('keeps the held copy until the restored tab is stored or synced', async () => {
    const heldKey = `worldmonitor-tabs-held-v1:${SITE_VARIANT}`;
    const serverA = server;
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    host.state.tabs.push(tab('tab-a-2', 'A unpushed'));
    useServer(new FakeServer());
    signIn('user_b', host);
    await settle();
    signOutTabSync(host);
    assert.match(localStorage.getItem(heldKey) ?? '', /A unpushed/);

    // user_a returns, but the layout cannot store the tabs and the push is refused.
    class NoStoreHost extends FakeHost {
      override applyTabs(next: TabsState, activeChanged: boolean): boolean {
        super.applyTabs(next, activeChanged);
        return false;
      }
    }
    const noStore = new NoStoreHost(host.state);
    useServer(serverA);
    serverA.nextResult = { ok: false, reason: 'RATE_LIMITED', retryAfterMs: 1000 } as SyncDashboardTabsResult;
    signIn('user_a', noStore);
    await settle();
    assert.match(localStorage.getItem(heldKey) ?? '', /A unpushed/, 'still held');
  });

  it('a recreated tab survives a pass that runs before the subscription shows it', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), tab('tab-a-2')] });
    signIn('user_a', host);
    await settle();
    const r = server.rows.get('tab-a-1')!;
    const staleTombstone = [{ tabId: 'tab-a-1', version: r.version + 1, deleted: true, createdAt: r.createdAt, updatedAt: r.updatedAt + 1 }, server.rows.get('tab-a-2')!];
    server.rows.delete('tab-a-1'); // the marker was evicted on the server
    server.emit = () => {}; // the subscription lags behind the writes below
    host.state.tabs[0]!.name = 'Mine';
    server.listeners.forEach((l) => l(structuredClone(staleTombstone)));
    await settle();
    assert.equal(server.rows.get('tab-a-1')!.record!.name, 'Mine', 'recreated');
    mock.timers.tick(30_000); // a periodic pass, still on the stale rows
    await settle();
    assert.ok(host.state.tabs.some((t) => t.id === 'tab-a-1' && t.name === 'Mine'));
  });

  /** Make writes of keys starting with `prefix` throw, `times` times (default: always). */
  function failWrites(prefix: string, times = Infinity) {
    const store = localStorage as unknown as MemoryStorage;
    const setItem = MemoryStorage.prototype.setItem.bind(store);
    let left = times;
    store.setItem = (key, value) => {
      if (key.startsWith(prefix) && left > 0) {
        left -= 1;
        throw new Error('QuotaExceededError');
      }
      setItem(key, value);
    };
    return () => { store.setItem = setItem; };
  }

  /** A layout that has not loaded its tabs: nothing to read. */
  class UnreadyHost extends FakeHost {
    override captureTabs(): TabsState { return null as unknown as TabsState; }
  }

  const sentNames = (s: FakeServer) => s.calls.flatMap((c) => c.changes.map((ch) => ch.record?.name));

  it("a sign-out that cannot read the tabs keeps the account's unpushed work out of the next account", async () => {
    class ToggleHost extends FakeHost {
      ready = true;
      override captureTabs(): TabsState { return this.ready ? super.captureTabs() : (null as unknown as TabsState); }
    }
    const host = new ToggleHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    host.state.tabs.push(tab('tab-a-9', 'A unpushed')); // never pushed: the sign-out comes first
    host.ready = false;
    signOutTabSync(host, 'user_a');
    host.ready = true;

    __resetTabSyncForTests();
    const serverB = new FakeServer();
    useServer(serverB);
    signIn('user_b', host);
    await settle();
    assert.ok(!sentNames(serverB).includes('A unpushed'), JSON.stringify(sentNames(serverB)));
    assert.ok(!host.state.tabs.some((t) => t.name === 'A unpushed'), 'held, not shown to user_b');
  });

  it('a sign-out that cannot read the tabs records the departure at the next pass', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    signOutTabSync(host, 'user_a');
    // Next load: user_b signs in, but its sync never runs a pass.
    __resetTabSyncForTests();
    __setTabSyncTransportForTests(async () => null);
    signIn('user_b', host);
    await settle();
    host.state.tabs.push(tab('tab-b-1', 'B private'));
    signOutTabSync(new UnreadyHost(host.state), 'user_b');

    __resetTabSyncForTests();
    const serverC = new FakeServer();
    useServer(serverC);
    signIn('user_c', host);
    await settle();
    assert.ok(!sentNames(serverC).includes('B private'), JSON.stringify(sentNames(serverC)));
    const held = JSON.parse(localStorage.getItem(`worldmonitor-tabs-held-v1:${SITE_VARIANT}`) ?? '{}');
    assert.deepEqual(held.user_b?.records.map((r: { id: string }) => r.id), ['tab-b-1']);
  });

  it('a departure whose marks cannot be stored waits instead of handing the tabs on', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    signOutTabSync(host, 'user_a');
    __resetTabSyncForTests();
    __setTabSyncTransportForTests(async () => null);
    signIn('user_b', host);
    await settle();
    host.state.tabs.push(tab('tab-b-1', 'B private'));

    // Next load: user_c signs in directly; the marks for user_b fail to save once.
    __resetTabSyncForTests();
    const serverC = new FakeServer();
    useServer(serverC);
    const restore = failWrites(META_KEY, 1);
    signIn('user_c', host);
    await settle();
    restore();
    assert.ok(!sentNames(serverC).includes('B private'), JSON.stringify(sentNames(serverC)));
    assert.ok(!host.state.tabs.some((t) => t.name === 'B private'), 'held for user_b');
  });

  it("an account switch whose tabs cannot be stored commits none of the new account's state", async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host);
    await settle();
    host.state.tabs[0]!.name = 'A private';
    notifyTabsChangedLocally(); // still inside the debounce at the switch

    class NoStoreHost extends FakeHost {
      override applyTabs(): boolean { return false; }
    }
    const serverB = new FakeServer();
    useServer(serverB);
    const stopped: string[] = [];
    signIn('user_b', new NoStoreHost(host.state), (r) => stopped.push(r));
    for (let i = 0; i < 3; i += 1) {
      await settle();
      mock.timers.tick(60_000);
    }
    await settle();
    assert.deepEqual(stopped, ['error'], 'stops after the reconnects');
    assert.equal(loadTabSyncMeta()!.userId, 'user_a', "the device still holds user_a's tabs");

    // Next load, storage works again: still a switch from user_a.
    __resetTabSyncForTests();
    useServer(serverB);
    signIn('user_b', host);
    await settle();
    assert.ok(!sentNames(serverB).includes('A private'), JSON.stringify(sentNames(serverB)));
    assert.ok(!host.state.tabs.some((t) => t.name === 'A private'));
  });

  it('a switch whose sync state cannot be stored after the tabs keeps the new account\'s tabs out of the previous one', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1', 'A synced')] });
    signIn('user_a', host);
    await settle();
    const serverA = server;
    const serverB = new FakeServer();
    const record = captureTabRecord(tab('tab-b-1', 'B synced'));
    serverB.rows.set('tab-b-1', { tabId: 'tab-b-1', version: 1, deleted: false, record, createdAt: 1, updatedAt: 1 });
    useServer(serverB);
    assert.equal(prepareTabSyncSignIn('user_b', true, host).willSync, true);
    // The layout is stored; the new account's sync state is not.
    const store = localStorage as unknown as MemoryStorage;
    const setItem = MemoryStorage.prototype.setItem.bind(store);
    store.setItem = (key, value) => {
      if (key === META_KEY && JSON.parse(value).userId === 'user_b') throw new Error('QuotaExceededError');
      setItem(key, value);
    };
    startTabSync('user_b', host);
    await settle();
    assert.ok(host.state.tabs.some((t) => t.id === 'tab-b-1'));
    __resetTabSyncForTests(); // the page closes
    store.setItem = setItem;
    assert.equal(loadTabSyncMeta()!.userId, 'user_a');
    useServer(serverB);
    signIn('user_b', host);
    await settle();
    __resetTabSyncForTests();
    useServer(serverA);
    signIn('user_a', host);
    await settle();
    const toA = serverA.calls.flatMap((c) => c.changes.map((ch) => ch.record?.name));
    assert.ok(!toA.includes('B synced'), `sent to user_a: ${JSON.stringify(toA)}`);
    assert.ok(host.state.tabs.some((t) => t.name === 'A synced'));
  });

  it('a signed-in marker that cannot move does not hand the new account\'s work to the previous one', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1', 'A synced')] });
    signIn('user_a', host);
    await settle();
    __resetTabSyncForTests();
    const serverB = new FakeServer();
    useServer(serverB);
    const restore = failWrites(SIGNED_IN_KEY);
    const first = prepareTabSyncSignIn('user_b', true, host).willSync;
    // A run of user_b's sync on this load (old behaviour) stops later.
    if (first) startTabSync('user_b', host);
    await settle();
    stopTabSync();
    restore();
    // user_b works with sync off, then the next load can store the marker.
    host.state.tabs.push(tab('tab-b-9', 'B work'));
    signIn('user_b', host);
    await settle();
    const held = JSON.parse(localStorage.getItem(HELD_KEY) ?? '{}');
    assert.ok(!(held.user_a?.records ?? []).some((r: { id: string }) => r.id === 'tab-b-9'), 'held for user_a');
    assert.equal(first, false, 'no sync while the marker is stuck');
    assert.ok(host.state.tabs.some((t) => t.id === 'tab-b-9'));
    assert.ok(serverB.calls.some((c) => c.changes.some((ch) => ch.record?.name === 'B work')));
  });

  it('a departure recorded for an account whose sync never ran is not recorded again', async () => {
    // user_a signed in before its first pass; its tab is marked as its own at the switch.
    localStorage.setItem(SIGNED_IN_KEY, 'user_a');
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1', 'A draft')] });
    const restore = failWrites(SIGNED_IN_KEY);
    assert.equal(prepareTabSyncSignIn('user_b', true, host).willSync, false);
    restore();
    host.state.tabs.push(tab('tab-b-9', 'B work'));
    signIn('user_b', host);
    await settle();
    const held = JSON.parse(localStorage.getItem(HELD_KEY) ?? '{}');
    assert.deepEqual((held.user_a?.records ?? []).map((r: { id: string }) => r.id), ['tab-a-1']);
    assert.ok(host.state.tabs.some((t) => t.id === 'tab-b-9'));
  });

  it('a delete made after a recorded departure does not reach the account that left', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1', 'One'), tab('tab-a-2', 'Two')] });
    signIn('user_a', host);
    await settle();
    __resetTabSyncForTests();
    const restore = failWrites(SIGNED_IN_KEY);
    prepareTabSyncSignIn('user_b', true, host);
    restore();
    assert.equal(localStorage.getItem(SIGNED_IN_KEY), 'user_a');
    host.state.tabs = host.state.tabs.filter((t) => t.id !== 'tab-a-2');
    recordTabDeleted('tab-a-2');
    assert.ok(!loadTabSyncMeta()!.tombstones.includes('tab-a-2'));
  });

  it('a departure another window has recorded is not recorded again from this page', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1', 'A synced')] });
    signIn('user_a', host);
    await settle();
    __resetTabSyncForTests();
    const serverB = new FakeServer();
    useServer(serverB);
    // This window prepares user_b before its layout has tabs: user_a waits in the list.
    assert.equal(prepareTabSyncSignIn('user_b', true, new UnreadyHost(host.state)).willSync, true);
    // Another window records user_a and finishes user_b's switch.
    localStorage.setItem(DEPARTED_KEY, '');
    localStorage.setItem(META_KEY, JSON.stringify({ userId: 'user_b', base: {}, tombstones: [], carried: {} }));
    host.state.tabs = [tab('tab-b-2', 'B new')];
    host.state.activeTabId = 'tab-b-2';
    startTabSync('user_b', host);
    await settle();
    const held = JSON.parse(localStorage.getItem(HELD_KEY) ?? '{}');
    assert.ok(!(held.user_a?.records ?? []).some((r: { id: string }) => r.id === 'tab-b-2'), 'held for user_a');
    assert.ok(host.state.tabs.some((t) => t.id === 'tab-b-2'));
    assert.ok(serverB.calls.some((c) => c.changes.some((ch) => ch.record?.name === 'B new')));
  });

  it('a pass does not run while another account is signed in on this browser', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1', 'A synced')] });
    signIn('user_a', host);
    await settle();
    const before = server.calls.length;
    localStorage.setItem(SIGNED_IN_KEY, 'user_c'); // signed in elsewhere since
    host.state.tabs.push(tab('tab-a-2', 'Later'));
    notifyTabsChangedLocally();
    mock.timers.tick(2_000);
    await settle();
    assert.equal(server.calls.length, before, 'nothing pushed');
    assert.equal(localStorage.getItem(SIGNED_IN_KEY), 'user_c');
    assert.equal(loadTabSyncMeta()!.foreign, undefined, 'no departure recorded');
  });

  it('a delete made while signed out does not reach the account', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), tab('tab-a-2')] });
    signIn('user_a', host);
    await settle();
    signOutTabSync(host, 'user_a');
    host.state.tabs = host.state.tabs.filter((t) => t.id !== 'tab-a-2');
    recordTabDeleted('tab-a-2');

    __resetTabSyncForTests();
    useServer(server);
    signIn('user_a', host);
    await settle();
    assert.equal(server.rows.get('tab-a-2')!.deleted, false);
    assert.ok(host.state.tabs.some((t) => t.id === 'tab-a-2'), 'restored from the account');
  });

  it("a delete made under another account does not reach the stored account", async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), tab('tab-a-2')] });
    signIn('user_a', host);
    await settle();
    // Next load: user_b signs in with sync off and deletes the tab.
    __resetTabSyncForTests();
    assert.equal(prepareTabSyncSignIn('user_b', false, host).willSync, false);
    host.state.tabs = host.state.tabs.filter((t) => t.id !== 'tab-a-2');
    recordTabDeleted('tab-a-2');
    assert.deepEqual(loadTabSyncMeta()!.tombstones, []);
  });

  it('a delete made with sync off still reaches the account signed in', async () => {
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), tab('tab-a-2')] });
    signIn('user_a', host);
    await settle();
    stopTabSync(); // sync gave up; user_a is still signed in
    host.state.tabs = host.state.tabs.filter((t) => t.id !== 'tab-a-2');
    recordTabDeleted('tab-a-2');
    __resetTabSyncForTests();
    useServer(server);
    signIn('user_a', host);
    await settle();
    assert.equal(server.rows.get('tab-a-2')!.deleted, true);
  });

  it('releases only the held copy that was put back', async () => {
    const heldKey = `worldmonitor-tabs-held-v1:${SITE_VARIANT}`;
    const draft = tab('tab-a-2', 'Draft');
    localStorage.setItem(META_KEY, JSON.stringify({ userId: 'user_a', base: {}, tombstones: [], carried: {} }));
    localStorage.setItem(heldKey, JSON.stringify({
      user_a: { records: [{ id: 'tab-a-2', record: captureTabRecord(draft) }], base: {}, tombstones: [], sent: {} },
    }));
    const release = gated(server);
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1'), draft] });
    signIn('user_a', host);
    await settle();
    // Another window holds a newer copy for user_a while this upload is on the way.
    const held = JSON.parse(localStorage.getItem(heldKey)!);
    held.user_a.records[0].record = captureTabRecord(tab('tab-a-2', 'Final'));
    localStorage.setItem(heldKey, JSON.stringify(held));
    release();
    await settle();
    assert.equal(server.rows.get('tab-a-2')!.record!.name, 'Draft');
    assert.match(localStorage.getItem(heldKey) ?? '', /Final/, 'the newer copy stays held');
  });

  it('a record the server refuses as invalid stops sync without reconnecting', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const stopped: string[] = [];
    let connects = 0;
    __setTabSyncTransportForTests(async (userId) => { connects += 1; return server.transport(userId); });
    server.throwOnSync = Object.assign(new Error('[CONVEX M] Uncaught ConvexError'), { data: { kind: 'INVALID_TAB', field: 'record.name' } });
    const host = new FakeHost({ activeTabId: 'tab-a-1', tabs: [tab('tab-a-1')] });
    signIn('user_a', host, (r) => stopped.push(r));
    await settle();
    mock.timers.tick(120_000);
    await settle();
    assert.deepEqual(stopped, ['invalid']);
    assert.equal(connects, 1);
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
