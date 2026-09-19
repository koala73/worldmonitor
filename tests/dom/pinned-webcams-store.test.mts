import { describe, expect, it, vi } from 'vitest';

import {
  getActiveWebcams,
  getPinnedWebcams,
  onPinnedChange,
  pinWebcam,
} from '@/services/webcams/pinned-store';

const STORAGE_KEY = 'wm-pinned-webcams';

describe('pinned webcam storage', () => {
  it('treats non-array JSON as an empty list instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ webcamId: 'nope' }));

    expect(() => getActiveWebcams()).not.toThrow();
    expect(getActiveWebcams()).toEqual([]);
    expect(getPinnedWebcams()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('[]');
  });

  it('refreshes subscribers when cloud prefs rewrite the stored list', () => {
    const seen = vi.fn();
    const unsubscribe = onPinnedChange(seen);
    pinWebcam({
      webcamId: 'cam-1',
      title: 'Harbor',
      lat: 1,
      lng: 2,
      category: 'traffic',
      country: 'JP',
      playerUrl: 'https://example.test/player',
    });
    seen.mockClear();

    const imported = [{
      webcamId: 'cam-2',
      title: 'Port',
      lat: 3,
      lng: 4,
      category: 'port',
      country: 'NL',
      playerUrl: 'https://example.test/port',
      active: true,
      pinnedAt: 10,
    }];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(imported));
    window.dispatchEvent(new CustomEvent('wm:cloud-prefs-applied', {
      detail: { keys: [STORAGE_KEY] },
    }));

    expect(seen).toHaveBeenCalled();
    expect(getPinnedWebcams().map((webcam) => webcam.webcamId)).toEqual(['cam-2']);
    unsubscribe();
  });
});
