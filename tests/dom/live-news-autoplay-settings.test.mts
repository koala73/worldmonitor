import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getLiveNewsAutoplay,
  getLiveStreamsAlwaysOn,
  getLiveStreamSettings,
  LIVE_NEWS_AUTOPLAY_STORAGE_KEY,
  setLiveNewsAutoplay,
  setLiveStreamsAlwaysOn,
  subscribeLiveNewsAutoplayChange,
} from '@/services/live-stream-settings';
import { CLOUD_SYNC_KEYS, ABSENCE_TOLERANT_SYNC_KEYS, resolveCloudBlobKeyAction } from '@/utils/sync-keys';
import { __testing__ as settingsPersistenceTesting } from '@/utils/settings-persistence';

const ALWAYS_ON_KEY = 'wm-live-streams-always-on';

function setSaveData(saveData: boolean | undefined): void {
  Object.defineProperty(navigator, 'connection', {
    configurable: true,
    value: saveData === undefined ? undefined : { saveData },
  });
}

describe('Live News autoplay preference', () => {
  beforeEach(() => {
    localStorage.clear();
    setSaveData(undefined);
  });
  afterEach(() => {
    localStorage.clear();
    setSaveData(undefined);
  });

  it('autoplays Live News by default while webcams stay click-to-play', () => {
    expect(getLiveNewsAutoplay()).toBe(true);
    expect(getLiveStreamsAlwaysOn()).toBe(false);
    expect(getLiveStreamSettings()).toMatchObject({ newsAutoplay: true, alwaysOn: false });
  });

  it('does not autoplay by default when the browser asks to save data', () => {
    setSaveData(true);
    expect(getLiveNewsAutoplay()).toBe(false);
    setSaveData(false);
    expect(getLiveNewsAutoplay()).toBe(true);
  });

  it('respects a viewer who had switched the old shared toggle off', () => {
    localStorage.setItem(ALWAYS_ON_KEY, 'false');
    expect(getLiveNewsAutoplay()).toBe(false);
  });

  it('keeps Live News on for viewers who had opted into the old shared toggle', () => {
    localStorage.setItem(ALWAYS_ON_KEY, 'true');
    setSaveData(true);
    expect(getLiveNewsAutoplay()).toBe(true);
  });

  it('keeps Live News autoplay when the webcam toggle is switched on and off again', () => {
    setLiveStreamsAlwaysOn(true);
    setLiveStreamsAlwaysOn(false);
    expect(getLiveStreamsAlwaysOn()).toBe(false);
    expect(getLiveNewsAutoplay()).toBe(true);
    expect(localStorage.getItem(LIVE_NEWS_AUTOPLAY_STORAGE_KEY)).toBe('true');
  });

  it('keeps a legacy opt-out when the webcam toggle changes', () => {
    localStorage.setItem(ALWAYS_ON_KEY, 'false');
    setLiveStreamsAlwaysOn(true);
    expect(getLiveNewsAutoplay()).toBe(false);
  });

  it('lets the saved Live News choice win over every default', () => {
    setLiveNewsAutoplay(false);
    expect(localStorage.getItem(LIVE_NEWS_AUTOPLAY_STORAGE_KEY)).toBe('false');
    expect(getLiveNewsAutoplay()).toBe(false);

    localStorage.setItem(ALWAYS_ON_KEY, 'false');
    setSaveData(true);
    setLiveNewsAutoplay(true);
    expect(getLiveNewsAutoplay()).toBe(true);
    // The webcam preference is a separate setting.
    expect(getLiveStreamsAlwaysOn()).toBe(false);
  });

  it('notifies on a local change, another tab, or a cloud row, and only when the value changes', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeLiveNewsAutoplayChange(cb);

    setLiveNewsAutoplay(false);
    expect(cb).toHaveBeenLastCalledWith(false);
    setLiveNewsAutoplay(false);
    expect(cb).toHaveBeenCalledTimes(1);

    localStorage.setItem(LIVE_NEWS_AUTOPLAY_STORAGE_KEY, 'true');
    window.dispatchEvent(new StorageEvent('storage', { key: LIVE_NEWS_AUTOPLAY_STORAGE_KEY }));
    expect(cb).toHaveBeenLastCalledWith(true);

    localStorage.setItem(LIVE_NEWS_AUTOPLAY_STORAGE_KEY, 'false');
    window.dispatchEvent(new CustomEvent('wm:cloud-prefs-applied', { detail: { keys: [LIVE_NEWS_AUTOPLAY_STORAGE_KEY] } }));
    expect(cb).toHaveBeenLastCalledWith(false);
    expect(cb).toHaveBeenCalledTimes(3);

    unsubscribe();
    setLiveNewsAutoplay(true);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('syncs across devices and is kept when a cloud row from an older client lacks it', () => {
    expect(CLOUD_SYNC_KEYS).toContain(LIVE_NEWS_AUTOPLAY_STORAGE_KEY);
    expect(settingsPersistenceTesting.isSettingsKey(LIVE_NEWS_AUTOPLAY_STORAGE_KEY)).toBe(true);
    expect(ABSENCE_TOLERANT_SYNC_KEYS.has(LIVE_NEWS_AUTOPLAY_STORAGE_KEY)).toBe(true);
    expect(resolveCloudBlobKeyAction(LIVE_NEWS_AUTOPLAY_STORAGE_KEY, { 'worldmonitor-theme': 'dark' })).toEqual({ kind: 'keep' });
    expect(resolveCloudBlobKeyAction(LIVE_NEWS_AUTOPLAY_STORAGE_KEY, { [LIVE_NEWS_AUTOPLAY_STORAGE_KEY]: 'false' }))
      .toEqual({ kind: 'set', value: 'false' });
  });
});
