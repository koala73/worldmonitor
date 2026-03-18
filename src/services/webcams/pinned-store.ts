const STORAGE_KEY = 'wm-pinned-webcams';
const CHANGE_EVENT = 'wm-pinned-webcams-changed';
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

function load(): PinnedWebcam[] {
  if (_cachedList !== null) return _cachedList;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _cachedList = raw ? (JSON.parse(raw) as PinnedWebcam[]) : [];
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(webcams));
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
