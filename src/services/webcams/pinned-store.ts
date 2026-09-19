import { safeStorageGet, safeStorageSet, safeStorageSetChecked } from '@/utils/safe-storage';

const STORAGE_KEY = 'wm-pinned-webcams';
const CHANGE_EVENT = 'wm-pinned-webcams-changed';
const CLOUD_PREFS_APPLIED_EVENT = 'wm:cloud-prefs-applied';
const MAX_ACTIVE = 4;

export interface PinnedWebcam {
  webcamId: string;
  title: string;
  lat: number;
  lng: number;
  category: string;
  country: string;
  playerUrl: string;
  active: boolean;
  pinnedAt: number;
}

let _cachedList: PinnedWebcam[] | null = null;
let _cacheFrame: number | null = null;

function isPinnedWebcam(value: unknown): value is PinnedWebcam {
  if (!value || typeof value !== 'object') return false;
  const webcam = value as Record<string, unknown>;
  return typeof webcam.webcamId === 'string'
    && typeof webcam.title === 'string'
    && typeof webcam.lat === 'number'
    && Number.isFinite(webcam.lat)
    && typeof webcam.lng === 'number'
    && Number.isFinite(webcam.lng)
    && typeof webcam.category === 'string'
    && typeof webcam.country === 'string'
    && typeof webcam.playerUrl === 'string'
    && typeof webcam.active === 'boolean'
    && typeof webcam.pinnedAt === 'number'
    && Number.isFinite(webcam.pinnedAt);
}

function parseStored(raw: string | null): PinnedWebcam[] | null {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isPinnedWebcam)) return null;
  return parsed;
}

function notifyChange(): void {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

function load(): PinnedWebcam[] {
  if (_cachedList !== null) return _cachedList;
  let list: PinnedWebcam[] = [];
  let invalid = false;
  try {
    const parsed = parseStored(safeStorageGet(STORAGE_KEY));
    if (parsed) list = parsed;
    else invalid = true;
  } catch {
    invalid = true;
  }
  _cachedList = list;
  if (invalid) {
    safeStorageSet(STORAGE_KEY, '[]');
    notifyChange();
  }
  if (_cacheFrame === null) {
    _cacheFrame = requestAnimationFrame(() => { _cachedList = null; _cacheFrame = null; });
  }
  return _cachedList;
}

function invalidateExternal(): void {
  if (_cacheFrame !== null) {
    cancelAnimationFrame(_cacheFrame);
    _cacheFrame = null;
  }
  _cachedList = null;
  notifyChange();
}

function installExternalListeners(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === STORAGE_KEY) invalidateExternal();
  });
  window.addEventListener(CLOUD_PREFS_APPLIED_EVENT, (event) => {
    const keys: unknown = (event as CustomEvent<{ keys?: unknown }>).detail?.keys;
    if (Array.isArray(keys) && keys.includes(STORAGE_KEY)) invalidateExternal();
  });
}

installExternalListeners();

function showToast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'wm-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function save(webcams: PinnedWebcam[]): void {
  if (!safeStorageSetChecked(STORAGE_KEY, JSON.stringify(webcams))) {
    console.warn('[pinned-webcams] save failed: storage rejected the write');
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
  const activeCount = list.filter(w => w.active).length;
  list.push({
    ...webcam,
    active: activeCount < MAX_ACTIVE,
    pinnedAt: Date.now(),
  });
  save(list);
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
  window.addEventListener(CHANGE_EVENT, wrapped);
  return () => window.removeEventListener(CHANGE_EVENT, wrapped);
}
