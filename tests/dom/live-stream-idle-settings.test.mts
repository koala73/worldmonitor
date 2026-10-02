import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getLiveMediaIdleStop,
  getLiveStreamSettings,
  LIVE_MEDIA_IDLE_STOP_STORAGE_KEY,
  setLiveMediaIdleStop,
  setLiveStreamsAlwaysOn,
  subscribeLiveStreamsAlwaysOnChange,
  subscribeLiveStreamsSettingsChange,
  type LiveStreamSettings,
} from '@/services/live-stream-settings';

const ALWAYS_ON_KEY = 'wm-live-streams-always-on';

function dispatchStorage(key: string | null): void {
  window.dispatchEvent(new StorageEvent('storage', { key }));
}

function dispatchCloudApplied(keys: unknown): void {
  window.dispatchEvent(new CustomEvent('wm:cloud-prefs-applied', { detail: { keys } }));
}

describe('live stream settings storage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to one hour for users who never saved autoplay', () => {
    expect(getLiveMediaIdleStop()).toBe(60);
    localStorage.setItem(ALWAYS_ON_KEY, 'false');
    expect(getLiveMediaIdleStop()).toBe(60);
  });

  it('keeps legacy always-on users exempt from the idle stop without a migration write', () => {
    localStorage.setItem(ALWAYS_ON_KEY, 'true');
    expect(getLiveMediaIdleStop()).toBe('never');
    expect(localStorage.getItem(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY)).toBeNull();
  });

  it('lets a stored idle value win over the legacy default', () => {
    localStorage.setItem(ALWAYS_ON_KEY, 'true');
    localStorage.setItem(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY, '15');
    expect(getLiveMediaIdleStop()).toBe(15);
    localStorage.setItem(ALWAYS_ON_KEY, 'false');
    localStorage.setItem(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY, 'never');
    expect(getLiveMediaIdleStop()).toBe('never');
  });

  it('treats an unrecognised stored value like an absent one', () => {
    localStorage.setItem(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY, 'forever');
    expect(getLiveMediaIdleStop()).toBe(60);
  });

  it('writes the concrete value and reports it in the snapshot', () => {
    setLiveMediaIdleStop('never');
    expect(localStorage.getItem(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY)).toBe('never');
    setLiveMediaIdleStop(240);
    expect(localStorage.getItem(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY)).toBe('240');
    expect(getLiveStreamSettings()).toEqual({ alwaysOn: false, idleStop: 240 });
  });

  it('pins the effective idle value before turning autoplay on, so the idle select does not flip', () => {
    setLiveStreamsAlwaysOn(true);
    expect(localStorage.getItem(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY)).toBe('60');
    expect(getLiveStreamSettings()).toEqual({ alwaysOn: true, idleStop: 60 });
  });

  it('pins a legacy always-on user at never before turning autoplay off', () => {
    localStorage.setItem(ALWAYS_ON_KEY, 'true');
    setLiveStreamsAlwaysOn(false);
    expect(getLiveStreamSettings()).toEqual({ alwaysOn: false, idleStop: 'never' });
  });

  it('never overwrites an idle value the user already chose', () => {
    localStorage.setItem(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY, '30');
    setLiveStreamsAlwaysOn(true);
    setLiveStreamsAlwaysOn(false);
    expect(localStorage.getItem(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY)).toBe('30');
  });
});

describe('live stream settings subscription', () => {
  const seen: LiveStreamSettings[] = [];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    seen.length = 0;
    unsubscribe = subscribeLiveStreamsSettingsChange((settings) => seen.push(settings));
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    localStorage.clear();
  });

  it('delivers a fresh snapshot for local writes', () => {
    setLiveMediaIdleStop(15);
    setLiveStreamsAlwaysOn(true);
    expect(seen).toEqual([
      { alwaysOn: false, idleStop: 15 },
      { alwaysOn: true, idleStop: 15 },
    ]);
  });

  it('fires for another tab writing either of its keys, reading the value from storage', () => {
    localStorage.setItem(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY, 'never');
    dispatchStorage(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY);
    localStorage.setItem(ALWAYS_ON_KEY, 'true');
    dispatchStorage(ALWAYS_ON_KEY);
    expect(seen).toEqual([
      { alwaysOn: false, idleStop: 'never' },
      { alwaysOn: true, idleStop: 'never' },
    ]);
  });

  it('fires when another tab clears storage', () => {
    dispatchStorage(null);
    expect(seen).toEqual([{ alwaysOn: false, idleStop: 60 }]);
  });

  it('ignores storage events for unrelated keys', () => {
    dispatchStorage('wm-stream-quality');
    expect(seen).toEqual([]);
  });

  it('fires when a cloud row applies either of its keys, and only then', () => {
    dispatchCloudApplied(['worldmonitor-theme']);
    dispatchCloudApplied(undefined);
    dispatchCloudApplied('wm-live-media-idle-stop');
    expect(seen).toEqual([]);

    localStorage.setItem(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY, '120');
    dispatchCloudApplied(['worldmonitor-theme', LIVE_MEDIA_IDLE_STOP_STORAGE_KEY]);
    dispatchCloudApplied([ALWAYS_ON_KEY]);
    expect(seen).toEqual([
      { alwaysOn: false, idleStop: 120 },
      { alwaysOn: false, idleStop: 120 },
    ]);
  });

  it('delivers only autoplay changes to an always-on subscriber, whatever the source', () => {
    const alwaysOnChanges: boolean[] = [];
    const stop = subscribeLiveStreamsAlwaysOnChange((alwaysOn) => alwaysOnChanges.push(alwaysOn));

    setLiveMediaIdleStop(15);
    localStorage.setItem(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY, '30');
    dispatchStorage(LIVE_MEDIA_IDLE_STOP_STORAGE_KEY);
    dispatchCloudApplied([LIVE_MEDIA_IDLE_STOP_STORAGE_KEY]);
    expect(alwaysOnChanges).toEqual([]);

    setLiveStreamsAlwaysOn(true);
    setLiveStreamsAlwaysOn(true);
    localStorage.setItem(ALWAYS_ON_KEY, 'false');
    dispatchStorage(ALWAYS_ON_KEY);
    localStorage.setItem(ALWAYS_ON_KEY, 'true');
    dispatchCloudApplied([ALWAYS_ON_KEY]);
    expect(alwaysOnChanges).toEqual([true, false, true]);

    stop();
    setLiveStreamsAlwaysOn(false);
    expect(alwaysOnChanges).toEqual([true, false, true]);
  });

  it('stops delivering after unsubscribe, and unsubscribe is idempotent', () => {
    unsubscribe?.();
    unsubscribe?.();
    const listener = vi.fn();
    const second = subscribeLiveStreamsSettingsChange(listener);
    second();
    setLiveMediaIdleStop(30);
    dispatchStorage(ALWAYS_ON_KEY);
    dispatchCloudApplied([ALWAYS_ON_KEY]);
    expect(seen).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });
});
