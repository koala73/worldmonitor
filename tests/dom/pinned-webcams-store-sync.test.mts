import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPinnedWebcams, onPinnedChange, type PinnedWebcam } from '@/services/webcams/pinned-store';

// #8367 / #8598: an open PinnedWebcamsPanel must re-render when another tab
// or a cloud-prefs apply rewrites the stored list.
const STORAGE_KEY = 'wm-pinned-webcams';
const CLOUD_PREFS_APPLIED_EVENT = 'wm:cloud-prefs-applied';

const disposers: Array<() => void> = [];

function webcam(webcamId: string, pinnedAt: number): PinnedWebcam {
  return {
    webcamId,
    title: `Cam ${webcamId}`,
    lat: 10,
    lng: 20,
    category: 'city',
    country: 'US',
    playerUrl: `https://webcams.windy.com/webcams/public/embed/player/${webcamId}/day`,
    active: true,
    pinnedAt,
  };
}

function subscribe() {
  const handler = vi.fn();
  const dispose = onPinnedChange(handler);
  disposers.push(dispose);
  return { handler, dispose };
}

function ids(): string[] {
  return getPinnedWebcams().map(w => w.webcamId);
}

// Seed the old list and prime the one-frame cache, then write a new list
// directly, the way another tab or the cloud-prefs apply path would.
function primeThenRewrite(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([webcam('old-cam', 1)]));
  expect(ids()).toEqual(['old-cam']);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([webcam('new-cam', 2)]));
}

describe('pinned webcams store external sync', () => {
  beforeEach(async () => {
    localStorage.clear();
    // Let the store's one-frame cache from the previous test expire.
    await new Promise(resolve => requestAnimationFrame(resolve));
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    localStorage.clear();
  });

  it('notifies and serves fresh data on a storage event for its key', () => {
    const { handler } = subscribe();
    primeThenRewrite();
    window.dispatchEvent(new StorageEvent('storage', { storageArea: localStorage, key: STORAGE_KEY }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(['new-cam']);
  });

  it('notifies on a storage event with a null key (storage cleared)', () => {
    const { handler } = subscribe();
    primeThenRewrite();
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { storageArea: localStorage, key: null }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual([]);
  });

  it('ignores storage events for unrelated keys', () => {
    const { handler } = subscribe();
    primeThenRewrite();
    window.dispatchEvent(new StorageEvent('storage', { storageArea: localStorage, key: 'worldmonitor-theme' }));
    expect(handler).not.toHaveBeenCalled();
    // Cache was not invalidated, so the primed list is still served this frame.
    expect(ids()).toEqual(['old-cam']);
  });

  it.each([null, STORAGE_KEY])('ignores session-storage events for key %s', key => {
    const { handler } = subscribe();
    primeThenRewrite();
    window.dispatchEvent(new StorageEvent('storage', { storageArea: sessionStorage, key }));
    expect(handler).not.toHaveBeenCalled();
    expect(ids()).toEqual(['old-cam']);
  });

  it('notifies and serves fresh data when cloud prefs apply its key', () => {
    const { handler } = subscribe();
    primeThenRewrite();
    window.dispatchEvent(new CustomEvent(CLOUD_PREFS_APPLIED_EVENT, { detail: { keys: [STORAGE_KEY] } }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(['new-cam']);
  });

  it('ignores cloud prefs applies that do not include its key', () => {
    const { handler } = subscribe();
    primeThenRewrite();
    window.dispatchEvent(new CustomEvent(CLOUD_PREFS_APPLIED_EVENT, { detail: { keys: ['worldmonitor-theme'] } }));
    window.dispatchEvent(new CustomEvent(CLOUD_PREFS_APPLIED_EVENT));
    expect(handler).not.toHaveBeenCalled();
    expect(ids()).toEqual(['old-cam']);
  });

  it('stops notifying after unsubscribe', () => {
    const { handler, dispose } = subscribe();
    dispose();
    window.dispatchEvent(new StorageEvent('storage', { storageArea: localStorage, key: STORAGE_KEY }));
    window.dispatchEvent(new CustomEvent(CLOUD_PREFS_APPLIED_EVENT, { detail: { keys: [STORAGE_KEY] } }));
    window.dispatchEvent(new CustomEvent('wm-pinned-webcams-changed'));
    expect(handler).not.toHaveBeenCalled();
  });
});
