import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyMigrationChain,
  buildMigrations,
  CANONICAL_PANEL_ORDER_KEY,
  LEGACY_PANEL_ORDER_KEY,
  migrateLegacyPanelOrderStorage,
  migratePanelOrderV3,
} from '../src/utils/cloud-prefs-migrations.ts';
import {
  addCloudPrefsAppliedListener,
  CLOUD_PREFS_APPLIED_EVENT,
  dispatchCloudPrefsAppliedEvent,
} from '../src/utils/cloud-prefs-events.ts';
import { CLOUD_SYNC_KEYS } from '../src/utils/sync-keys.ts';
import { resolveDefaultPanelOrder, resolveSavedPanelOrder } from '../src/app/panel-order.ts';
import { normalizeStoredPanelSettings } from '../src/app/panel-settings-storage.ts';
import { applyPreferenceStorageChanges } from '../src/app/preference-storage-sync.ts';
import { STORAGE_KEYS } from '../src/config/variants/base.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readSource = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf-8');

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.has(key) ? this.values.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

describe('cloud prefs panel order sync keys', () => {
  it('syncs the runtime panel order keys and not the legacy key', () => {
    const keys: readonly string[] = CLOUD_SYNC_KEYS;
    assert.ok(keys.includes('panel-order'));
    assert.ok(keys.includes('panel-order-bottom-set'));
    assert.equal(keys.includes('worldmonitor-panel-order'), false);
  });
});

describe('cloud prefs schema-3 panel order migration', () => {
  it('renames the legacy panel order key to the canonical runtime key', () => {
    const blob = {
      'worldmonitor-panel-order': '["live-news","markets"]',
      'worldmonitor-panels': '{"keep":true}',
    };
    const migrated = migratePanelOrderV3(blob);

    assert.notEqual(migrated, blob);
    assert.equal(migrated['panel-order'], '["live-news","markets"]');
    assert.equal('worldmonitor-panel-order' in migrated, false);
    assert.equal(migrated['worldmonitor-panels'], '{"keep":true}');
    assert.equal('panel-order' in blob, false, 'input blob must not be mutated');
  });

  it('does not overwrite an existing canonical panel order', () => {
    const migrated = migratePanelOrderV3({
      'worldmonitor-panel-order': '["legacy"]',
      'panel-order': '["canonical"]',
    });

    assert.equal(migrated['panel-order'], '["canonical"]');
    assert.equal('worldmonitor-panel-order' in migrated, false);
  });

  it('is wired as the schema v3 migration after disabled-feed recovery', () => {
    const migrations = buildMigrations({});
    const migrated = applyMigrationChain(
      { 'worldmonitor-panel-order': '["legacy"]' },
      2,
      3,
      migrations,
    );

    assert.equal(migrated['panel-order'], '["legacy"]');
    assert.equal('worldmonitor-panel-order' in migrated, false);
  });

  it('cleans orphan local legacy panel-order storage without overwriting canonical storage', () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_PANEL_ORDER_KEY, '["legacy"]');

    assert.equal(migrateLegacyPanelOrderStorage(storage), true);
    assert.equal(storage.getItem(CANONICAL_PANEL_ORDER_KEY), '["legacy"]');
    assert.equal(storage.getItem(LEGACY_PANEL_ORDER_KEY), null);

    storage.setItem(CANONICAL_PANEL_ORDER_KEY, '["canonical"]');
    storage.setItem(LEGACY_PANEL_ORDER_KEY, '["legacy-again"]');

    assert.equal(migrateLegacyPanelOrderStorage(storage), true);
    assert.equal(storage.getItem(CANONICAL_PANEL_ORDER_KEY), '["canonical"]');
    assert.equal(storage.getItem(LEGACY_PANEL_ORDER_KEY), null);
  });
});

describe('cloud prefs live-restore wiring', () => {
  it('dispatches a same-tab cloud prefs applied event only when keys changed', () => {
    const events: CustomEvent[] = [];
    const target = {
      dispatchEvent(event: Event): boolean {
        events.push(event as CustomEvent);
        return true;
      },
    };

    dispatchCloudPrefsAppliedEvent([], target);
    assert.equal(events.length, 0);

    dispatchCloudPrefsAppliedEvent(['panel-order', 'panel-order', STORAGE_KEYS.panels], target);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, CLOUD_PREFS_APPLIED_EVENT);
    assert.deepEqual(events[0]!.detail, {
      keys: ['panel-order', STORAGE_KEYS.panels],
    });
  });

  it('listens for same-tab cloud prefs applied events and extracts changed keys', () => {
    const target = new EventTarget();
    const observed: string[][] = [];
    const remove = addCloudPrefsAppliedListener(target, (keys) => {
      observed.push(keys);
    });

    target.dispatchEvent(new CustomEvent(CLOUD_PREFS_APPLIED_EVENT, {
      detail: { keys: ['panel-order', 42, STORAGE_KEYS.disabledFeeds] },
    }));
    assert.deepEqual(observed, [['panel-order', STORAGE_KEYS.disabledFeeds]]);

    remove();
    target.dispatchEvent(new CustomEvent(CLOUD_PREFS_APPLIED_EVENT, {
      detail: { keys: [STORAGE_KEYS.panels] },
    }));
    assert.deepEqual(observed, [['panel-order', STORAGE_KEYS.disabledFeeds]]);
  });

  it('applies cloud-restored preference keys to live app state', () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
    try {
      storage.setItem(STORAGE_KEYS.panels, JSON.stringify({
        map: { name: 'Map', enabled: false, priority: 1 },
        'live-news': { name: 'Live News', enabled: true, priority: 1 },
      }));
      storage.setItem(STORAGE_KEYS.disabledFeeds, JSON.stringify(['feed-a', 'feed-b']));

      const calls = {
        applyPanelSettings: 0,
        refreshPanelToggles: 0,
        refreshSourceToggles: 0,
        updateSearchIndex: 0,
        reloadPanelOrderFromStorage: 0,
      };
      const ctx = {
        panelSettings: {
          map: { name: 'Map', enabled: true, priority: 1 },
        },
        disabledSources: new Set<string>(),
        PANEL_ORDER_KEY: 'panel-order',
        unifiedSettings: {
          refreshPanelToggles: () => { calls.refreshPanelToggles += 1; },
          refreshSourceToggles: () => { calls.refreshSourceToggles += 1; },
        },
      };

      applyPreferenceStorageChanges(ctx, [
        STORAGE_KEYS.panels,
        STORAGE_KEYS.disabledFeeds,
        'panel-order',
      ], {
        applyPanelSettings: () => { calls.applyPanelSettings += 1; },
        updateSearchIndex: () => { calls.updateSearchIndex += 1; },
        reloadPanelOrderFromStorage: () => { calls.reloadPanelOrderFromStorage += 1; },
      }, {
        loadPanelSettingsFromStorage: () => ({
          map: { name: 'Map', enabled: false, priority: 1 },
          'live-news': { name: 'Live News', enabled: true, priority: 1 },
        }),
      });

      assert.equal(ctx.panelSettings.map?.enabled, false);
      assert.equal(ctx.panelSettings['live-news']?.enabled, true);
      assert.deepEqual([...ctx.disabledSources], ['feed-a', 'feed-b']);
      assert.deepEqual(calls, {
        applyPanelSettings: 1,
        refreshPanelToggles: 1,
        refreshSourceToggles: 1,
        updateSearchIndex: 1,
        reloadPanelOrderFromStorage: 1,
      });
    } finally {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  it('keeps cloud sync installation after startup writes and before auth subscription', () => {
    const appSrc = readSource('src/App.ts');
    const installCall = 'installCloudPrefsSync(SITE_VARIANT);';
    const installCalls = appSrc.match(new RegExp(installCall.replace(/[()]/g, '\\$&'), 'g')) ?? [];
    const startupOrder = /this\.enforceFreeTierLimits\(\);\s*installCloudPrefsSync\(SITE_VARIANT\);[\s\S]*?this\.unsubFreeTier = subscribeAuthState\(/;

    assert.equal(installCalls.length, 1, 'cloud prefs install call must remain unique');
    assert.match(
      appSrc,
      startupOrder,
      'cloud sync must install after startup local writes and before auth subscription',
    );
  });

  it('keeps Convex fallback schema version aligned with the browser client', () => {
    const convexSrc = readSource('convex/constants.ts');
    assert.match(convexSrc, /CURRENT_PREFS_SCHEMA_VERSION = 3/);
  });
});

describe('cloud prefs live-restore behavior helpers', () => {
  it('rebuilds default panel settings when the cloud blob removes worldmonitor-panels', () => {
    const allPanels = {
      map: { name: 'Map', enabled: true, priority: 1 },
      'live-news': { name: 'Live News', enabled: true, priority: 1 },
      markets: { name: 'Markets', enabled: false, priority: 2 },
    };
    const settings = normalizeStoredPanelSettings(undefined, [
      { id: 'cw-cloud-restore', name: 'Cloud Widget' },
      { id: 'mcp-cloud-restore', name: 'Cloud MCP' },
    ], {
      allPanels,
      variant: 'full',
      variantDefaults: { full: ['map', 'live-news'] },
      getPanelConfig: (key: string) => allPanels[key as keyof typeof allPanels] ?? { name: key, enabled: false, priority: 2 },
    });

    assert.equal(settings.map?.enabled, true);
    assert.equal(settings['live-news']?.enabled, true);
    assert.deepEqual(settings['cw-cloud-restore'], {
      name: 'Cloud Widget',
      enabled: true,
      priority: 3,
    });
    assert.deepEqual(settings['mcp-cloud-restore'], {
      name: 'Cloud MCP',
      enabled: true,
      priority: 3,
    });
  });

  it('resolves deleted panel-order back to startup default order instead of stale in-memory order', () => {
    const staleOrder = ['markets', 'live-webcams', 'live-news', 'runtime-config'];
    const defaultOrder = resolveDefaultPanelOrder(staleOrder, {
      variant: 'full',
      variantDefaults: { full: ['live-news', 'live-webcams', 'markets', 'runtime-config'] },
      isDesktopApp: true,
    });

    assert.deepEqual(defaultOrder.slice(0, 3), ['live-news', 'runtime-config', 'live-webcams']);
    assert.notDeepEqual(defaultOrder.slice(0, 3), staleOrder.slice(0, 3));
  });

  it('uses cold-boot saved-order rules when runtime restore omits monitors', () => {
    const activePanels = ['live-news', 'markets', 'monitors', 'world-clock'];
    const defaultOrder = ['live-news', 'markets', 'world-clock', 'monitors'];

    assert.deepEqual(
      resolveSavedPanelOrder(activePanels, ['markets'], defaultOrder, { variant: 'full' }),
      ['live-news', 'markets', 'world-clock', 'monitors'],
    );
    assert.deepEqual(
      resolveSavedPanelOrder(activePanels, ['markets', 'monitors'], defaultOrder, { variant: 'full' }),
      ['live-news', 'markets', 'world-clock', 'monitors'],
    );
  });

  it('preserves the happy-variant monitors exclusion from cold boot', () => {
    assert.deepEqual(
      resolveSavedPanelOrder(
        ['positive-events', 'monitors', 'world-clock'],
        ['monitors', 'world-clock'],
        ['positive-events', 'world-clock', 'monitors'],
        { variant: 'happy' },
      ),
      ['positive-events', 'world-clock'],
    );
  });

  it('does not rewrite unchanged panel-order storage during savePanelOrder', () => {
    const layout = readSource('src/app/panel-layout.ts');

    assert.match(
      layout,
      /if \(localStorage\.getItem\(this\.ctx\.PANEL_ORDER_KEY\) !== orderJson\) \{[\s\S]*?localStorage\.setItem\(this\.ctx\.PANEL_ORDER_KEY, orderJson\);[\s\S]*?\}/,
      'panel-order writes must be skipped when the serialized order is unchanged',
    );
    assert.match(
      layout,
      /if \(localStorage\.getItem\(bottomSetKey\) !== bottomSetJson\) \{[\s\S]*?localStorage\.setItem\(bottomSetKey, bottomSetJson\);[\s\S]*?\}/,
      'panel-order bottom-set writes must be skipped when unchanged',
    );
  });

  it('eagerly loads the Live News panel after registering its lazy loader', () => {
    const layout = readSource('src/app/panel-layout.ts');
    assert.match(
      layout,
      /this\.lazyPanel\('live-news'[\s\S]*?new m\.LiveNewsPanel\(\);[\s\S]*?\n\s*\}\),\n\s*\);\n\s*this\.triggerPanelLoad\('live-news'\);/,
      'live-news should not stay as a viewport-gated skeleton on startup',
    );
  });
});
