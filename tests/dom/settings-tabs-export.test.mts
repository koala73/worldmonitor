import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelLayoutManager } from '@/app/panel-layout';
import type { AppContext } from '@/app/app-context';
import type { PanelTab, TabsState } from '@/services/tab-store';
import { exportSettings, importSettings } from '@/utils/settings-persistence';
import { countFreePanelCapUsage, FREE_MAX_PANELS } from '@/config/panels';
import { resetMissionPresetState } from '@/services/mission-presets';
import type { PanelConfig } from '@/types';
import { initTestI18n } from './helpers/i18n.mts';

const tabsKey = 'worldmonitor-tabs-v1:full';
const tab = (id: string, name: string): PanelTab => ({
  id, name, panelSettings: { news: { name: 'News', enabled: true, priority: 1 } }, panelOrder: ['news'], bottomSet: [],
});
const original: TabsState = { activeTabId: 'tab-a-1', tabs: [tab('tab-a-1', 'Original'), tab('tab-b-2', 'Inactive')] };
const restored: TabsState = { activeTabId: 'tab-c-3', tabs: [tab('tab-c-3', 'Imported')] };
const file = (data: Record<string, string>) => new File([JSON.stringify({ version: 1, data })], 'backup.json');

interface LayoutHarness {
  ctx: Pick<AppContext, 'panelSettings' | 'PANEL_ORDER_KEY'>;
  resolvedPanelOrder: string[];
  bottomSetMemory: Set<string>;
  healStoredTabSnapshots: () => void;
  updateTabCapLock: () => void;
  initPanelTabs: () => void;
  unregisterExportFlush: (() => void) | null;
  panelTabBar: { destroy: () => void } | null;
}

let manager: LayoutHarness;
beforeAll(initTestI18n);
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(tabsKey, JSON.stringify(original));
  document.body.innerHTML = '<div id="panelTabsMount"></div><div id="panelsGrid"><div data-panel="markets"></div><div data-panel="news"></div></div><div id="mapBottomGrid"></div>';
  manager = Object.create(PanelLayoutManager.prototype) as LayoutHarness;
  manager.ctx = { panelSettings: { news: { name: 'News', enabled: false, priority: 1 } }, PANEL_ORDER_KEY: 'panel-order' };
  manager.resolvedPanelOrder = ['news'];
  manager.bottomSetMemory = new Set(['markets']);
  manager.healStoredTabSnapshots = vi.fn();
  manager.updateTabCapLock = vi.fn();
  manager.initPanelTabs();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:settings');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  manager.unregisterExportFlush?.();
  manager.panelTabBar?.destroy();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function failStorageWrite(key: string): void {
  const storage = localStorage;
  vi.stubGlobal('localStorage', {
    get length() { return storage.length; },
    key: storage.key.bind(storage),
    getItem: storage.getItem.bind(storage),
    removeItem: storage.removeItem.bind(storage),
    clear: storage.clear.bind(storage),
    setItem(name: string, value: string) {
      if (name === key) throw new DOMException('Full', 'QuotaExceededError');
      storage.setItem(name, value);
    },
  });
}

async function backup(): Promise<Record<string, string>> {
  exportSettings();
  const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
  return (JSON.parse(await blob.text()) as { data: Record<string, string> }).data;
}

describe('live dashboard tab backups', () => {
  it('captures active settings, DOM order and bottom set through the manager hook', async () => {
    const data = await backup();
    const state = JSON.parse(data[tabsKey]!) as TabsState;
    expect(state.tabs[0]!.panelSettings.news!.enabled).toBe(false);
    expect(state.tabs[0]!.panelOrder).toEqual(['markets', 'news']);
    expect(state.tabs[0]!.bottomSet).toEqual(['markets']);
    expect(state.tabs[1]).toEqual(original.tabs[1]);
    expect(JSON.parse(data['panel-order']!)).toEqual(['markets', 'news']);
  });

  it('preserves imported tabs and order when exported before reload', async () => {
    await importSettings(file({ [tabsKey]: JSON.stringify(restored), 'panel-order': '["restored"]' }));
    const data = await backup();
    expect(JSON.parse(data[tabsKey]!)).toEqual(restored);
    expect(data['panel-order']).toBe('["restored"]');
    expect(JSON.parse(localStorage.getItem(tabsKey)!)).toEqual(restored);
  });

  it.each([
    ['panel-order', '["restored"]'],
    ['panel-order-bottom-set', '["restored"]'],
    ['worldmonitor-panels', '{"news":{"name":"News","enabled":true,"priority":1}}'],
  ])('preserves a legacy %s import without a tabs key', async (key, value) => {
    await importSettings(file({ [key]: value }));
    const data = await backup();
    expect(data[key]).toBe(value);
    expect(JSON.parse(data[tabsKey]!)).toEqual(original);
  });

  it('continues capturing live tabs after an unrelated import', async () => {
    await importSettings(file({ 'worldmonitor-theme': 'light' }));
    expect((JSON.parse((await backup())[tabsKey]!) as TabsState).tabs[0]!.panelSettings.news!.enabled).toBe(false);
  });

  it('continues capturing live tabs after importing a different variant', async () => {
    await importSettings(file({ 'worldmonitor-tabs-v1:tech': JSON.stringify(restored) }));
    const data = await backup();
    expect((JSON.parse(data[tabsKey]!) as TabsState).tabs[0]!.panelSettings.news!.enabled).toBe(false);
    expect(JSON.parse(data['worldmonitor-tabs-v1:tech']!)).toEqual(restored);
  });

  it('keeps the live hook when a layout import fails', async () => {
    failStorageWrite(tabsKey);
    await expect(importSettings(file({ [tabsKey]: JSON.stringify(restored) }))).rejects.toThrow('Cannot persist');
    vi.unstubAllGlobals();
    expect((JSON.parse((await backup())[tabsKey]!) as TabsState).tabs[0]!.panelSettings.news!.enabled).toBe(false);
  });

  it.each([tabsKey, 'panel-order', 'panel-order-bottom-set'])('fails export without downloading when %s cannot be saved', key => {
    failStorageWrite(key);
    expect(() => exportSettings()).toThrow('Settings export could not save the current dashboard layout');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('new tabs from saved panels', () => {
  const newTabPanelsKey = 'worldmonitor-new-tab-panels-v1:full';
  let tierResolved: boolean;
  const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!;
  const optionAction = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('#dashboard-tab-options button')).find((b) => b.textContent === label)!;
  const useThisTab = () => {
    button('.dashboard-tab-options').click();
    optionAction("Use this tab's panels").click();
  };
  const addTab = () => button('.dashboard-tab-add').click();
  const newestStoredTab = (): PanelTab => {
    const { tabs } = JSON.parse(localStorage.getItem(tabsKey)!) as TabsState;
    return tabs[tabs.length - 1]!;
  };
  const live = (overrides: Record<string, Partial<PanelConfig>>) => {
    const settings = resetMissionPresetState({}).panelSettings;
    for (const [key, change] of Object.entries(overrides)) settings[key] = { ...settings[key]!, ...change };
    return settings;
  };

  beforeEach(() => {
    tierResolved = false;
    const harness = manager as unknown as Record<string, unknown>;
    harness.updateTabCapLock = vi.fn(() => ({ allowed: true }));
    harness.applyTabPanelState = vi.fn();
    harness.isProTierResolvedOrFallback = () => tierResolved;
    manager.ctx.panelSettings = live({ 'live-news': { enabled: false }, 'positive-feed': { enabled: true } });
  });

  it("starts the next tab with this tab's shown and hidden panels", () => {
    useThisTab();
    addTab();

    const created = newestStoredTab();
    expect(created.id).not.toBe('tab-a-1');
    expect(created.panelSettings['live-news']!.enabled).toBe(false);
    expect(created.panelSettings['positive-feed']!.enabled).toBe(true);
    expect(button('.dashboard-tab-add').title).toBe('New tab (starts with the panels you saved)');
  });

  it('saves the live layout, including changes made since the last tab switch', () => {
    manager.ctx.panelSettings['live-news']!.enabled = true;
    manager.ctx.panelSettings.insights!.enabled = false;
    const grid = document.getElementById('panelsGrid')!;
    grid.replaceChildren(...['positive-feed', 'insights', 'live-news'].map((key) => {
      const el = document.createElement('div');
      el.dataset.panel = key;
      return el;
    }));

    useThisTab();
    addTab();

    const created = newestStoredTab();
    expect(created.panelSettings['live-news']!.enabled).toBe(true);
    expect(created.panelSettings.insights!.enabled).toBe(false);
    expect(created.panelOrder.slice(0, 3)).toEqual(['positive-feed', 'insights', 'live-news']);
  });

  it('clamps a free user\'s new tab without touching the saved panels', () => {
    manager.ctx.panelSettings = live({});
    for (const config of Object.values(manager.ctx.panelSettings)) config.enabled = true;
    useThisTab();
    const savedBefore = localStorage.getItem(newTabPanelsKey);
    tierResolved = true;

    addTab();

    const created = newestStoredTab();
    expect(countFreePanelCapUsage(created.panelSettings)).toBe(FREE_MAX_PANELS);
    expect(Object.values(created.panelSettings).some((config) => config.proGated)).toBe(true);
    expect(localStorage.getItem(newTabPanelsKey)).toBe(savedBefore);
  });

  it('does not clamp while the tier is unresolved', () => {
    manager.ctx.panelSettings = live({});
    for (const config of Object.values(manager.ctx.panelSettings)) config.enabled = true;
    useThisTab();

    addTab();

    expect(countFreePanelCapUsage(newestStoredTab().panelSettings)).toBeGreaterThan(FREE_MAX_PANELS);
  });

  it('goes back to the default panels after "Use the default panels"', () => {
    useThisTab();
    button('.dashboard-tab-options').click();
    optionAction('Use the default panels').click();
    addTab();

    expect(localStorage.getItem(newTabPanelsKey)).toBeNull();
    expect(newestStoredTab().panelSettings['live-news']!.enabled).toBe(true);
    expect(newestStoredTab().panelSettings['positive-feed']!.enabled).toBe(false);
  });

  it('round-trips the saved panels through a settings backup', async () => {
    useThisTab();
    const data = await backup();
    expect(data[newTabPanelsKey]).toBe(localStorage.getItem(newTabPanelsKey));

    localStorage.clear();
    await importSettings(file({ [newTabPanelsKey]: data[newTabPanelsKey]! }));
    addTab();

    expect(newestStoredTab().panelSettings['live-news']!.enabled).toBe(false);
    expect(newestStoredTab().panelSettings['positive-feed']!.enabled).toBe(true);
  });

  it('skips a malformed saved-panels value on import and keeps the rest', async () => {
    await expect(importSettings(file({ [newTabPanelsKey]: '{"key":"live-news"}', 'worldmonitor-theme': 'light' })))
      .resolves.toEqual({ success: true, keysImported: 1 });

    expect(localStorage.getItem(newTabPanelsKey)).toBeNull();
    expect(localStorage.getItem('worldmonitor-theme')).toBe('light');
  });
});
