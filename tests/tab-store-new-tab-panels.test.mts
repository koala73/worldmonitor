import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { PanelConfig } from '../src/types/index.ts';
import {
  countFreePanelCapUsage,
  enforceFreePanelLimit,
  FREE_MAX_PANELS,
} from '../src/config/panels.ts';
import { resetMissionPresetState } from '../src/services/mission-presets.ts';
import {
  buildNewTabPanels,
  clearNewTabPanels,
  hasNewTabPanels,
  normalizeNewTabPanels,
  saveNewTabPanels,
  saveTabsState,
} from '../src/services/tab-store.ts';

const NEW_TAB_PANELS_KEY = 'worldmonitor-new-tab-panels-v1:full';

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

class QuotaStorage extends MemoryStorage {
  override setItem(_key: string, _value: string): void {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  }
}

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let storage: MemoryStorage;

function useStorage(value: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value });
}

beforeEach(() => {
  storage = new MemoryStorage();
  useStorage(storage);
});

afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Live settings as a fresh dashboard has them, plus any extra entries. */
function liveSettings(extra: Record<string, PanelConfig> = {}): Record<string, PanelConfig> {
  return { ...resetMissionPresetState({}).panelSettings, ...extra };
}

function defaultTab(live: Record<string, PanelConfig>) {
  const reset = resetMissionPresetState(live);
  return { panelSettings: reset.panelSettings, panelOrder: reset.panelOrder };
}

function widget(name: string, enabled: boolean): PanelConfig {
  return { name, enabled, priority: 2 };
}

describe('buildNewTabPanels with nothing saved', () => {
  it('matches the variant default new tab', () => {
    const live = liveSettings({ 'cw-live': widget('Live widget', true) });
    assert.equal(hasNewTabPanels(), false);
    assert.deepEqual(buildNewTabPanels(live), defaultTab(live));
  });
});

describe('saveNewTabPanels then buildNewTabPanels', () => {
  it('carries the saved tab\'s shown panels, hidden panels and order', () => {
    const live = liveSettings();
    const saved = clone(defaultTab(live));
    saved.panelSettings['live-news']!.enabled = false;
    saved.panelSettings['positive-feed']!.enabled = true;
    const savedOrder = ['positive-feed', 'insights', 'map', 'live-news'];
    saved.panelOrder = savedOrder;

    assert.deepEqual(saveNewTabPanels(saved), { persisted: true });
    assert.equal(hasNewTabPanels(), true);

    const built = buildNewTabPanels(live);
    assert.equal(built.panelSettings['live-news']!.enabled, false);
    assert.equal(built.panelSettings['positive-feed']!.enabled, true);
    assert.deepEqual(built.panelOrder.slice(0, 3), ['positive-feed', 'insights', 'live-news']);
    assert.equal(built.panelOrder.includes('map'), false);
  });

  it('saves what the tab shows, so a panel the free-tier gate hid stays hidden in new tabs', () => {
    const live = liveSettings({ 'cw-pro': { ...widget('Pro widget', false), proGated: true } });
    const saved = clone(defaultTab(live));
    for (const key of Object.keys(saved.panelSettings)) saved.panelSettings[key]!.enabled = true;
    saved.panelSettings.insights = { ...saved.panelSettings.insights!, enabled: false, proGated: true };
    saved.panelSettings['cw-pro'] = { ...widget('Pro widget', false), proGated: true };
    saveNewTabPanels(saved);

    const built = buildNewTabPanels(live);
    assert.equal(built.panelSettings.insights!.enabled, false);
    assert.equal('proGated' in built.panelSettings.insights!, false);
    assert.equal(built.panelSettings['cw-pro']!.enabled, false);
    assert.equal(built.panelSettings['live-news']!.enabled, true);
  });

  it('leaves the free-tier clamp to creation when the saved panels exceed the cap', () => {
    const live = liveSettings({ 'cw-pro': widget('Pro widget', true) });
    const saved = clone(defaultTab(live));
    for (const key of Object.keys(saved.panelSettings)) saved.panelSettings[key]!.enabled = true;
    saved.panelSettings['cw-pro'] = widget('Pro widget', true);
    saveNewTabPanels(saved);

    const built = buildNewTabPanels(live);
    assert.ok(countFreePanelCapUsage(built.panelSettings) > FREE_MAX_PANELS);

    const free = enforceFreePanelLimit(built.panelSettings, false);
    assert.ok(countFreePanelCapUsage(free) <= FREE_MAX_PANELS);
    assert.equal(free['cw-pro']!.enabled, false);

    const pro = enforceFreePanelLimit(built.panelSettings, true);
    assert.equal(pro['cw-pro']!.enabled, true);
    assert.equal(countFreePanelCapUsage(pro), countFreePanelCapUsage(built.panelSettings));
  });

  it('never writes a clamp back into the saved list', () => {
    const live = liveSettings();
    const saved = clone(defaultTab(live));
    for (const key of Object.keys(saved.panelSettings)) saved.panelSettings[key]!.enabled = true;
    saveNewTabPanels(saved);
    const before = storage.getItem(NEW_TAB_PANELS_KEY);

    enforceFreePanelLimit(buildNewTabPanels(live).panelSettings, false);

    assert.equal(storage.getItem(NEW_TAB_PANELS_KEY), before);
  });

  it('follows the live widget set: saved widgets keep their choice, new ones their live config, deleted ones stay gone', () => {
    const atSave = liveSettings({ 'cw-kept': widget('Kept', true), 'cw-gone': widget('Gone', true) });
    saveNewTabPanels(defaultTab(atSave));

    const live = liveSettings({ 'cw-kept': widget('Kept', false), 'cw-new': widget('New', true) });
    const built = buildNewTabPanels(live);

    assert.equal(built.panelSettings['cw-kept']!.enabled, true);
    assert.deepEqual(built.panelSettings['cw-new'], widget('New', true));
    assert.equal('cw-gone' in built.panelSettings, false);
    assert.equal(built.panelOrder.includes('cw-gone'), false);
  });

  it('keeps a saved key that is neither a known panel nor a widget off', () => {
    const saved = defaultTab(liveSettings());
    saved.panelSettings['retired-panel'] = widget('Retired', true);
    saveNewTabPanels(saved);

    const built = buildNewTabPanels(liveSettings({ 'retired-panel': widget('Retired', true) }));

    assert.equal(built.panelSettings['retired-panel']?.enabled ?? false, false);
  });

  it('ignores saved keys that name inherited object members', () => {
    storage.setItem(NEW_TAB_PANELS_KEY, JSON.stringify([
      { key: '__proto__', on: true },
      { key: 'constructor', on: true },
      { key: 'toString', on: false },
      { key: 'live-news', on: false },
    ]));

    const built = buildNewTabPanels(liveSettings());

    assert.equal(Object.getPrototypeOf(built.panelSettings), Object.prototype);
    for (const key of ['__proto__', 'constructor', 'toString']) {
      assert.equal(Object.prototype.hasOwnProperty.call(built.panelSettings, key), false, key);
      assert.equal(built.panelOrder.includes(key), false, key);
    }
    assert.equal(built.panelSettings['live-news']!.enabled, false);
  });

  it('gives a built-in panel missing from the saved list its variant default', () => {
    const live = liveSettings();
    const saved = clone(defaultTab(live));
    for (const key of Object.keys(saved.panelSettings)) saved.panelSettings[key]!.enabled = false;
    delete saved.panelSettings['live-news'];
    delete saved.panelSettings['positive-feed'];
    saved.panelOrder = saved.panelOrder.filter((key) => key !== 'live-news');
    saveNewTabPanels(saved);

    const built = buildNewTabPanels(live);
    assert.equal(built.panelSettings.insights!.enabled, false);
    assert.equal(built.panelSettings['live-news']!.enabled, true);
    assert.equal(built.panelSettings['positive-feed']!.enabled, false);
  });

  it('hides the map in new tabs when it was hidden on the saved tab', () => {
    const live = liveSettings();
    const saved = clone(defaultTab(live));
    saved.panelSettings.map!.enabled = false;
    saveNewTabPanels(saved);

    assert.equal(buildNewTabPanels(live).panelSettings.map!.enabled, false);
  });

  it('replaces the stored value whole, so saving twice stores the same thing', () => {
    const live = liveSettings();
    saveNewTabPanels(defaultTab(live));
    const first = storage.getItem(NEW_TAB_PANELS_KEY);
    saveNewTabPanels(defaultTab(live));
    assert.equal(storage.getItem(NEW_TAB_PANELS_KEY), first);
  });

  it('survives a tabs-state write from another window', () => {
    const live = liveSettings();
    const saved = clone(defaultTab(live));
    saved.panelSettings['live-news']!.enabled = false;
    saveNewTabPanels(saved);

    saveTabsState({ activeTabId: 'tab-a-1', tabs: [{ id: 'tab-a-1', name: 'Main', ...defaultTab(live), bottomSet: [] }] });

    assert.equal(hasNewTabPanels(), true);
    assert.equal(buildNewTabPanels(live).panelSettings['live-news']!.enabled, false);
  });
});

describe('clearNewTabPanels', () => {
  it('returns new tabs to the default panels', () => {
    const live = liveSettings();
    const saved = clone(defaultTab(live));
    saved.panelSettings['live-news']!.enabled = false;
    saveNewTabPanels(saved);

    clearNewTabPanels();

    assert.equal(hasNewTabPanels(), false);
    assert.deepEqual(buildNewTabPanels(live), defaultTab(live));
  });

  it('is safe to call when nothing is saved', () => {
    assert.doesNotThrow(() => clearNewTabPanels());
    assert.equal(hasNewTabPanels(), false);
  });
});

describe('unusable storage', () => {
  for (const [label, make] of [
    ['a store that rejects writes', () => new QuotaStorage()],
    ['localStorage = null', () => null],
  ] as const) {
    it(`reports ${label} as not saved and keeps building the default`, () => {
      useStorage(make());
      const live = liveSettings();
      const saved = clone(defaultTab(live));
      saved.panelSettings['live-news']!.enabled = false;

      assert.deepEqual(saveNewTabPanels(saved), { persisted: false });
      assert.equal(hasNewTabPanels(), false);
      assert.deepEqual(buildNewTabPanels(live), defaultTab(live));
      assert.doesNotThrow(() => clearNewTabPanels());
    });
  }
});

describe('stored garbage', () => {
  for (const [label, raw] of [
    ['invalid JSON', '{not json'],
    ['an object', '{"key":"live-news","on":false}'],
    ['an empty list', '[]'],
    ['entries without a string key or boolean on', '[{"key":3,"on":false},{"key":"live-news","on":"no"},null,"x"]'],
  ] as const) {
    it(`reads ${label} as nothing saved`, () => {
      storage.setItem(NEW_TAB_PANELS_KEY, raw);
      const live = liveSettings();
      assert.equal(hasNewTabPanels(), false);
      assert.deepEqual(buildNewTabPanels(live), defaultTab(live));
    });
  }

  it('normalizeNewTabPanels keeps the first entry for a key and drops extra fields', () => {
    assert.deepEqual(
      normalizeNewTabPanels([
        { key: 'live-news', on: false, proGated: true, name: 'News' },
        { key: 'live-news', on: true },
        { key: 'insights', on: true },
      ]),
      [{ key: 'live-news', on: false }, { key: 'insights', on: true }],
    );
    assert.equal(normalizeNewTabPanels({ tabs: [] }), null);
    assert.equal(normalizeNewTabPanels([{ key: '', on: true }]), null);
  });
});
