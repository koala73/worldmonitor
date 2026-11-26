/**
 * The layout side of dashboard tab sync (#11141): what PanelLayoutManager
 * hands the sync driver and how it shows tabs merged from the account. The
 * layout needs the whole app to construct, so the methods run on a minimal
 * stand-in `this`, as panel-layout-filter-choice.test.mts does.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PanelLayoutManager } from '@/app/panel-layout';
import { publishOrShareAsNew } from '@/services/team-dashboards-store';
import type { PanelTab, TabsState } from '@/services/tab-store';
import { initTestI18n } from './helpers/i18n.mts';

vi.mock('@/services/team-dashboards-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/team-dashboards-store')>()),
  publishOrShareAsNew: vi.fn(),
}));

beforeAll(initTestI18n);
afterEach(() => {
  localStorage.clear();
  document.querySelectorAll('.toast-notification').forEach((el) => el.remove());
  vi.restoreAllMocks();
});

const method = <T extends (...args: never[]) => unknown>(name: string): T =>
  Reflect.get(PanelLayoutManager.prototype, name) as T;

const TABS_KEY = 'worldmonitor-tabs-v1:full';
const META_KEY = 'worldmonitor-tabs-sync-v1:full';

function tab(id: string, name: string, enabled: boolean): PanelTab {
  return {
    id,
    name,
    panelSettings: { markets: { name: 'Markets', enabled, priority: 1 } },
    panelOrder: ['markets'],
    bottomSet: [],
  };
}

describe('PanelLayoutManager tab sync host', () => {
  it('reads the active tab from live state without writing any storage key', () => {
    const state: TabsState = { activeTabId: 'tab-a1-b1', tabs: [tab('tab-a1-b1', 'Main', false), tab('tab-a2-b2', 'Energy', true)] };
    const self = {
      tabsState: state,
      ctx: { panelSettings: { markets: { name: 'Markets', enabled: true, priority: 1 } } },
      resolvedPanelOrder: ['markets'],
      bottomSetMemory: new Set(['live-news']),
      livePanelOrder: () => ['live-news', 'markets'],
      panelOrderForSync(this: { livePanelOrder: () => string[]; resolvedPanelOrder: string[] }) {
        return method<() => string[]>('panelOrderForSync').call(this);
      },
    };
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    const captured = method<() => TabsState | null>('captureTabsForSync').call(self)!;

    expect(setItem).not.toHaveBeenCalled();
    const active = captured.tabs.find((t) => t.id === 'tab-a1-b1')!;
    expect(active.panelSettings.markets!.enabled).toBe(true);
    expect(active.panelOrder).toEqual(['live-news', 'markets']);
    expect(active.bottomSet).toEqual(['live-news']);
    // A copy: the merge must not edit the layout's own state.
    expect(state.tabs[0]!.panelSettings.markets!.enabled).toBe(false);
    expect(captured.tabs[1]).toEqual(state.tabs[1]);
  });

  it('places panels not mounted yet where they will mount', () => {
    // insertByOrder mounts a lazy panel before the next resolved panel in the
    // grid; capturing it anywhere else would read as an edit once it mounts.
    const order = method<() => string[]>('panelOrderForSync').call({
      resolvedPanelOrder: ['a', 'lazy1', 'b', 'lazy2', 'c', 'tail'],
      livePanelOrder: () => ['b', 'a', 'c'],
    });
    expect(order).toEqual(['lazy1', 'b', 'a', 'lazy2', 'c', 'tail']);
    expect(method<() => string[]>('panelOrderForSync').call({
      resolvedPanelOrder: ['a', 'b'],
      livePanelOrder: () => null,
    })).toEqual(['a', 'b']);
  });

  it('stores merged tabs and re-applies the active tab only when it changed', () => {
    const calls: string[] = [];
    const self = {
      tabsState: { activeTabId: 'tab-a1-b1', tabs: [tab('tab-a1-b1', 'Main', false)] } as TabsState,
      ctx: { isDestroyed: false },
      applyTabPanelFilters: vi.fn(() => calls.push('filters')),
      applyTabPanelState: vi.fn(() => calls.push('panels')),
      healStoredTabSnapshots: vi.fn(() => calls.push('heal')),
      panelTabBar: { refresh: vi.fn(() => calls.push('refresh')) },
      updateTabCapLock: vi.fn(() => calls.push('cap')),
    };
    const apply = method<(next: TabsState, activeChanged: boolean) => void>('applySyncedTabs');

    const renamed: TabsState = { activeTabId: 'tab-a1-b1', tabs: [tab('tab-a1-b1', 'Main', false), tab('tab-a2-b2', 'From laptop', true)] };
    apply.call(self, renamed, false);
    expect(self.tabsState).toBe(renamed);
    expect(JSON.parse(localStorage.getItem(TABS_KEY)!)).toEqual(renamed);
    expect(self.applyTabPanelState).not.toHaveBeenCalled();
    expect(calls).toEqual(['heal', 'refresh', 'cap']);

    calls.length = 0;
    const edited: TabsState = { activeTabId: 'tab-a1-b1', tabs: [tab('tab-a1-b1', 'Main', true)] };
    apply.call(self, edited, true);
    expect(self.applyTabPanelState).toHaveBeenCalledWith(edited.tabs[0]!.panelSettings, ['markets'], []);
    expect(calls).toEqual(['filters', 'panels', 'heal', 'refresh', 'cap']);
  });

  it('reports whether the merged tabs were stored', () => {
    const self = {
      tabsState: { activeTabId: 'tab-a1-b1', tabs: [tab('tab-a1-b1', 'Main', false)] } as TabsState,
      ctx: { isDestroyed: false },
      healStoredTabSnapshots: vi.fn(),
      panelTabBar: { refresh: vi.fn() },
      updateTabCapLock: vi.fn(),
    };
    const apply = method<(next: TabsState, activeChanged: boolean) => boolean>('applySyncedTabs');
    const next: TabsState = { activeTabId: 'tab-a1-b1', tabs: [tab('tab-a1-b1', 'Main', true)] };
    expect(apply.call(self, next, false)).toBe(true);
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try {
      expect(apply.call(self, { ...next, tabs: [tab('tab-a1-b1', 'Renamed', true)] }, false)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    // Not stored, not shown: the tabs on screen stay the ones kept for the next load.
    expect(self.tabsState).toBe(next);
    expect(self.panelTabBar.refresh).toHaveBeenCalledTimes(1);
    expect(apply.call({ ...self, ctx: { isDestroyed: true } }, next, false)).toBe(false);
  });

  it('ignores a merge that lands after the layout is torn down', () => {
    const self = {
      tabsState: { activeTabId: 'tab-a1-b1', tabs: [tab('tab-a1-b1', 'Main', false)] } as TabsState,
      ctx: { isDestroyed: true },
      applyTabPanelState: vi.fn(),
    };
    method<(next: TabsState, activeChanged: boolean) => void>('applySyncedTabs')
      .call(self, { activeTabId: 'tab-a1-b1', tabs: [tab('tab-a1-b1', 'Main', true)] }, true);
    expect(self.applyTabPanelState).not.toHaveBeenCalled();
    expect(localStorage.getItem(TABS_KEY)).toBeNull();
  });

  it('records a deleted synced tab for the account before saving', () => {
    localStorage.setItem('worldmonitor-tabs-signed-in-v1:full', 'user_1');
    localStorage.setItem(META_KEY, JSON.stringify({
      userId: 'user_1',
      base: { 'tab-a2-b2': { version: 3, hash: 'h' } },
      tombstones: [],
      carried: {},
    }));
    const self = {
      tabsState: { activeTabId: 'tab-a1-b1', tabs: [tab('tab-a1-b1', 'Main', false), tab('tab-a2-b2', 'Energy', true)] } as TabsState,
      panelTabBar: { refresh: vi.fn() },
      updateTabCapLock: vi.fn(),
    };

    method<(id: string) => unknown>('deleteTab').call(self, 'tab-a2-b2');

    expect(JSON.parse(localStorage.getItem(META_KEY)!).tombstones).toEqual(['tab-a2-b2']);
    expect(JSON.parse(localStorage.getItem(TABS_KEY)!).tabs.map((t: PanelTab) => t.id)).toEqual(['tab-a1-b1']);
  });

  it('does not record a delete made while signed out', () => {
    localStorage.setItem(META_KEY, JSON.stringify({
      userId: 'user_1',
      base: { 'tab-a2-b2': { version: 3, hash: 'h' } },
      tombstones: [],
      carried: {},
    }));
    const self = {
      tabsState: { activeTabId: 'tab-a1-b1', tabs: [tab('tab-a1-b1', 'Main', false), tab('tab-a2-b2', 'Energy', true)] } as TabsState,
      panelTabBar: { refresh: vi.fn() },
      updateTabCapLock: vi.fn(),
    };

    method<(id: string) => unknown>('deleteTab').call(self, 'tab-a2-b2');

    expect(JSON.parse(localStorage.getItem(META_KEY)!).tombstones).toEqual([]);
  });

  it("shows a tab's own panel order even when the order cannot be saved", () => {
    const self = {
      ctx: { panelSettings: {}, PANEL_ORDER_KEY: 'panel-order', unifiedSettings: null },
      isProTierResolvedOrFallback: () => false,
      applyPanelSettings: vi.fn(),
      applySavedPanelOrder: vi.fn(),
      mountLiveNewsIfReady: vi.fn(),
      scheduleLoadAllData: vi.fn(),
    };
    localStorage.setItem('panel-order', JSON.stringify(['markets', 'live-news']));
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try {
      method<(s: Record<string, unknown>, o: string[], b: string[]) => void>('applyTabPanelState').call(
        self, { markets: { name: 'Markets', enabled: true } }, ['live-news', 'markets'], ['markets'],
      );
    } finally {
      spy.mockRestore();
    }
    expect(self.applySavedPanelOrder).toHaveBeenCalledWith(['live-news', 'markets'], ['markets']);
  });

  it('exposes the host App hands to the sync driver', () => {
    const self = {
      ctx: { panelSettings: { markets: { name: 'Markets', enabled: true, priority: 1 } } },
      firstRunOrder: ['live-news', 'markets'],
      captureTabsForSync: vi.fn(() => null),
      applySyncedTabs: vi.fn(),
    };
    const host = method<() => import('@/services/tab-cloud-sync').TabSyncHost>('getTabSyncHost').call(self);
    expect(host.currentPanelSettings()).toBe(self.ctx.panelSettings);
    expect(host.defaultTabName()).toBe('Main');
    expect(host.defaultPanelOrder()).toEqual(['live-news', 'markets']);
    expect(host.newTabId()).toMatch(/^tab-[a-z0-9]+-[a-z0-9]+$/);
    host.captureTabs();
    host.applyTabs({ activeTabId: 'tab-a1-b1', tabs: [] }, true);
    expect(self.captureTabsForSync).toHaveBeenCalled();
    expect(self.applySyncedTabs).toHaveBeenCalledWith({ activeTabId: 'tab-a1-b1', tabs: [] }, true);
  });

  it('keeps a team link made while tab sync replaced the tabs', async () => {
    let release!: (link: { id: string; version: number }) => void;
    vi.mocked(publishOrShareAsNew).mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const original = tab('tab-a1-b1', 'Main', true);
    const self = {
      team: { userId: 'user_1', dashboards: { team: { kind: 'business', focus: false }, dashboards: [] }, reload: vi.fn(async () => {}) },
      teamBusy: false,
      tabsState: { activeTabId: 'tab-a1-b1', tabs: [original] } as TabsState,
      ctx: { map: null, isDestroyed: false },
      panelTabBar: { refresh: vi.fn() },
      captureCurrentTabState: () => ({ snapshot: { panelSettings: original.panelSettings, panelOrder: ['markets'], bottomSet: [] }, persisted: true }),
      activeTab(): PanelTab | undefined { return this.tabsState.tabs.find((t) => t.id === this.tabsState.activeTabId); },
    };

    const sharing = method<() => Promise<void>>('shareActiveTabWithTeam').call(self);
    // A sync pass lands during the publish round trip.
    self.tabsState = { activeTabId: 'tab-a1-b1', tabs: [tab('tab-a1-b1', 'Main', true)] };
    release({ id: 'dash1', version: 1 });
    await sharing;

    expect(self.tabsState.tabs[0]!.team).toEqual({ id: 'dash1', version: 1 });
    expect(JSON.parse(localStorage.getItem(TABS_KEY)!).tabs[0].team).toEqual({ id: 'dash1', version: 1 });
  });
});
