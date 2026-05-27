import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyMigrationChain,
  buildMigrations,
  migratePanelOrderV3,
} from '../src/utils/cloud-prefs-migrations.ts';
import { CLOUD_SYNC_KEYS } from '../src/utils/sync-keys.ts';
import { resolveDefaultPanelOrder } from '../src/app/panel-order.ts';
import { normalizeStoredPanelSettings } from '../src/app/panel-settings-storage.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readSource = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf-8');

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
});

describe('cloud prefs live-restore wiring', () => {
  it('dispatches and handles the same-tab cloud prefs applied event', () => {
    const syncSrc = readSource('src/utils/cloud-prefs-sync.ts');
    const eventsSrc = readSource('src/app/event-handlers.ts');

    assert.match(syncSrc, /CURRENT_PREFS_SCHEMA_VERSION = 3/);
    assert.match(syncSrc, /CLOUD_PREFS_APPLIED_EVENT = 'wm:cloud-prefs-applied'/);
    assert.match(syncSrc, /dispatchCloudPrefsApplied\(changedKeys\)/);
    assert.match(eventsSrc, /addEventListener\(CLOUD_PREFS_APPLIED_EVENT/);
    assert.match(eventsSrc, /refreshPanelToggles\(\)/);
    assert.match(eventsSrc, /refreshSourceToggles\(\)/);
    assert.match(eventsSrc, /reloadPanelOrderFromStorage\?\.\(\)/);
  });

  it('keeps cloud sync installation after startup writes and before auth subscription', () => {
    const appSrc = readSource('src/App.ts');
    const enforceIdx = appSrc.indexOf('this.enforceFreeTierLimits();');
    const installIdx = appSrc.indexOf('installCloudPrefsSync(SITE_VARIANT);');
    const subscribeIdx = appSrc.indexOf('this.unsubFreeTier = subscribeAuthState');

    assert.notEqual(enforceIdx, -1, 'free-tier enforcement call must exist');
    assert.notEqual(installIdx, -1, 'cloud prefs install call must exist');
    assert.notEqual(subscribeIdx, -1, 'auth subscription must exist');
    assert.ok(enforceIdx < installIdx, 'cloud sync must install after startup local writes');
    assert.ok(installIdx < subscribeIdx, 'cloud sync must install before auth subscription');
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
});
