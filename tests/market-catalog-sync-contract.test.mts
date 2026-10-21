import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLOUD_SYNC_KEYS } from '../src/utils/sync-keys.ts';
import { __testing__ as settingsTesting } from '../src/utils/settings-persistence.ts';
import { mergeCloudWithLocalDirty } from '../src/utils/cloud-prefs-migrations.ts';

const CATALOG_KEY = 'wm-market-catalog-selection-v1';

describe('market catalog preference persistence contract', () => {
  it('is included in cloud sync and settings export/import allowlists', () => {
    assert.ok(CLOUD_SYNC_KEYS.includes(CATALOG_KEY));
    assert.equal(settingsTesting.isSettingsKey(CATALOG_KEY), true);
  });

  it('round-trips a local catalog edit through conflict-aware cloud merge', () => {
    const cloud = { [CATALOG_KEY]: '["AAPL"]' };
    const local = { [CATALOG_KEY]: '["SAP","ASML"]' };
    assert.deepEqual(
      mergeCloudWithLocalDirty(cloud, local, [CATALOG_KEY]),
      local,
    );
  });
});
