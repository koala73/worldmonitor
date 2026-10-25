import { normalizePinnedWebcam, normalizePinnedWebcams, normalizePinnedWebcamList, MAX_PINNED_WEBCAMS, MAX_ACTIVE_WEBCAMS, type PinnedWebcam } from '../../../shared/pinned-webcams';
import { safeStorageSet } from '../../utils/safe-storage';
import type { CloudPrefsAppliedDetail } from '../../utils/cloud-prefs-sync';
export type { PinnedWebcam } from '../../../shared/pinned-webcams';

const STORAGE_KEY = 'wm-pinned-webcams';
const CHANGE_EVENT = 'wm-pinned-webcams-changed';
// Mirrors CLOUD_PREFS_APPLIED_EVENT; importing the value would pull clerk and feeds into this store.
const CLOUD_PREFS_APPLIED_EVENT = 'wm:cloud-prefs-applied';
const MAX_ACTIVE = MAX_ACTIVE_WEBCAMS;

let _cachedList: PinnedWebcam[] | null = null;
let _cacheFrame: number | null = null;

function invalidateCache(): void {
  _cachedList = null;
}

function load(): PinnedWebcam[] {
  if (_cachedList !== null) return _cachedList;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _cachedList = normalizePinnedWebcams(raw);
    const normalized = JSON.stringify(_cachedList);
    if (raw !== null && raw !== normalized) {
      safeStorageSet(STORAGE_KEY, normalized);
    }
  } catch {
    _cachedList = [];
  }
  if (_cacheFrame === null) {
    _cacheFrame = requestAnimationFrame(() => { _cachedList = null; _cacheFrame = null; });
  }
  return _cachedList;
}

function showToast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'wm-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function save(webcams: PinnedWebcam[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizePinnedWebcamList(webcams)));
  } catch (err) {
    console.warn('[pinned-webcams] localStorage save failed:', err);
    showToast('Could not save pinned webcams — storage full');
  }
  _cachedList = null;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function getPinnedWebcams(): PinnedWebcam[] {
  return load();
}

export function getActiveWebcams(): PinnedWebcam[] {
  return load()
    .filter(w => w.active)
    .sort((a, b) => a.pinnedAt - b.pinnedAt)
    .slice(0, MAX_ACTIVE);
}

export function isPinned(webcamId: string): boolean {
  return load().some(w => w.webcamId === webcamId);
}

export function pinWebcam(webcam: Omit<PinnedWebcam, 'active' | 'pinnedAt'>): void {
  const list = load();
  if (list.some(w => w.webcamId === webcam.webcamId)) return;
  if (list.length >= MAX_PINNED_WEBCAMS) {
    showToast(`You can pin up to ${MAX_PINNED_WEBCAMS} webcams`);
    return;
  }
  const activeCount = list.filter(w => w.active).length;
  const pinned = normalizePinnedWebcam({
    ...webcam,
    active: activeCount < MAX_ACTIVE,
    pinnedAt: Date.now(),
  });
  if (!pinned) return;
  const next = normalizePinnedWebcamList([...list, pinned]);
  if (next.length === list.length) {
    showToast('Could not pin webcam because the saved webcam size limit was reached');
    return;
  }
  save(next);
}

export function unpinWebcam(webcamId: string): void {
  const list = load().filter(w => w.webcamId !== webcamId);
  save(list);
}

export function toggleWebcam(webcamId: string): void {
  const list = load();
  const target = list.find(w => w.webcamId === webcamId);
  if (!target) return;
  if (!target.active) {
    const activeList = list
      .filter(w => w.active)
      .sort((a, b) => a.pinnedAt - b.pinnedAt);
    if (activeList.length >= MAX_ACTIVE && activeList[0]) {
      activeList[0].active = false;
    }
    target.active = true;
  } else {
    target.active = false;
  }
  save(list);
}

export function onPinnedChange(handler: () => void): () => void {
  const wrapped = () => handler();
  // Another tab wrote the list, or cleared storage (key === null).
  const onStorage = (e: StorageEvent) => {
    if (e.storageArea !== localStorage) return;
    if (e.key !== null && e.key !== STORAGE_KEY) return;
    invalidateCache();
    handler();
  };
  // Cloud sign-in, merge or undo-restore rewrote the list in this tab.
  const onCloudApplied = (e: Event) => {
    const keys = (e as CustomEvent<CloudPrefsAppliedDetail>).detail?.keys;
    if (!keys?.includes(STORAGE_KEY)) return;
    invalidateCache();
    handler();
  };
  window.addEventListener(CHANGE_EVENT, wrapped);
  window.addEventListener('storage', onStorage);
  window.addEventListener(CLOUD_PREFS_APPLIED_EVENT, onCloudApplied);
  return () => {
    window.removeEventListener(CHANGE_EVENT, wrapped);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CLOUD_PREFS_APPLIED_EVENT, onCloudApplied);
  };
}
