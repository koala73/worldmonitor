import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_STORAGE_KEY,
  FONT_SCALE_STEPS,
  normalizeFontScale,
  parseFontScale,
} from '../src/services/font-scale-settings.ts';
import { __testing__ as settingsPersistenceTesting } from '../src/utils/settings-persistence.ts';
import { CLOUD_SYNC_KEYS } from '../src/utils/sync-keys.ts';

describe('font scale settings', () => {
  it('offers the bounded discrete scale used by global and panel controls', () => {
    assert.deepEqual(FONT_SCALE_STEPS, [0.9, 1, 1.1, 1.25, 1.5, 2]);
    assert.equal(DEFAULT_FONT_SCALE, 1);
  });

  it('accepts only exact offered steps and falls back safely', () => {
    for (const step of FONT_SCALE_STEPS) {
      assert.equal(parseFontScale(step), step);
      assert.equal(parseFontScale(String(step)), step);
      assert.equal(normalizeFontScale(step), step);
      assert.equal(normalizeFontScale(String(step)), step);
    }

    for (const invalid of [undefined, null, '', '1.2', 1.2, 'Infinity', Number.NaN, {}]) {
      assert.equal(parseFontScale(invalid), undefined);
      assert.equal(normalizeFontScale(invalid), DEFAULT_FONT_SCALE);
    }
  });

  it('includes the global preference in cloud sync and settings export/import filtering', () => {
    assert.ok(CLOUD_SYNC_KEYS.includes(FONT_SCALE_STORAGE_KEY));
    assert.equal(settingsPersistenceTesting.isSettingsKey(FONT_SCALE_STORAGE_KEY), true);
  });
});
