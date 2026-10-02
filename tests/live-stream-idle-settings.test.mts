import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LIVE_MEDIA_IDLE_STOP,
  formatIdleStopMinutes,
  LIVE_MEDIA_IDLE_STOP_MINUTES,
  LIVE_MEDIA_IDLE_STOP_OPTIONS,
  LIVE_MEDIA_IDLE_STOP_STORAGE_KEY,
  parseLiveMediaIdleStop,
} from '../src/services/live-stream-settings.ts';
import { __testing__ as settingsPersistenceTesting } from '../src/utils/settings-persistence.ts';
import { CLOUD_SYNC_KEYS, resolveCloudBlobKeyAction } from '../src/utils/sync-keys.ts';

describe('live media idle-stop preference', () => {
  it('offers bounded durations plus never, defaulting to one hour', () => {
    assert.deepEqual(LIVE_MEDIA_IDLE_STOP_OPTIONS, [15, 30, 60, 120, 240, 'never']);
    assert.equal(DEFAULT_LIVE_MEDIA_IDLE_STOP, 60);
  });

  it('parses only the offered values', () => {
    for (const option of LIVE_MEDIA_IDLE_STOP_OPTIONS) {
      assert.equal(parseLiveMediaIdleStop(option), option);
      assert.equal(parseLiveMediaIdleStop(String(option)), option);
    }
    for (const invalid of [undefined, null, '', ' 60', '60.0', '45', 45, 0, 'Never', 'true', {}, Number.NaN]) {
      assert.equal(parseLiveMediaIdleStop(invalid), undefined, `rejects ${String(invalid)}`);
    }
  });

  it('names durations in whole hours once they reach an hour, in the reader language', () => {
    assert.deepEqual(
      LIVE_MEDIA_IDLE_STOP_MINUTES.map((minutes) => formatIdleStopMinutes(minutes, 'en')),
      ['15 minutes', '30 minutes', '1 hour', '2 hours', '4 hours'],
    );
    assert.equal(formatIdleStopMinutes(90, 'en'), '90 minutes');
    assert.equal(formatIdleStopMinutes(60, 'fr'), '1 heure');
  });

  it('syncs across devices and survives a cloud row written by an older client', () => {
    assert.ok(CLOUD_SYNC_KEYS.includes(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY));
    assert.equal(settingsPersistenceTesting.isSettingsKey(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY), true);
    assert.deepEqual(
      resolveCloudBlobKeyAction(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY, { 'worldmonitor-theme': 'dark' }),
      { kind: 'keep' },
    );
    assert.deepEqual(
      resolveCloudBlobKeyAction(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY, { [LIVE_MEDIA_IDLE_STOP_STORAGE_KEY]: 'never' }),
      { kind: 'set', value: 'never' },
    );
  });
});
