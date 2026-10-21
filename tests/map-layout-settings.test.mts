import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ as settingsPersistenceTesting } from '../src/utils/settings-persistence.ts';

describe('map layout settings persistence', () => {
  // #6417: each of these keys must keep its SETTINGS_KEY_PREFIXES entry.
  // Removing a prefix silently drops the key from settings export/import -
  // the split layout's mode-scoped state (map-split-height), column width,
  // and side preference would stop traveling between installs with no
  // failing test, so pin them through the same assertion surface the
  // font-scale precedent uses.
  it('keeps the map layout keys in settings export/import filtering', () => {
    for (const key of ['map-height', 'map-split-height', 'map-col-width', 'map-side']) {
      assert.equal(settingsPersistenceTesting.isSettingsKey(key), true);
    }
  });
});
