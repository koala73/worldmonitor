import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelLayoutManager } from '@/app/panel-layout';
import type { AppContext } from '@/app/app-context';
import type { PanelTab, TabsState } from '@/services/tab-store';
import { exportSettings, importSettings } from '@/utils/settings-persistence';
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
