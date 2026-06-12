export const PANEL_SPANS_KEY = 'worldmonitor-panel-spans';
export const PANEL_COL_SPANS_KEY = 'worldmonitor-panel-col-spans';
export const PANEL_COLLAPSED_KEY = 'worldmonitor-panel-collapsed';

let panelSpansCache: Readonly<Record<string, number>> | null = null;
let panelColSpansCache: Readonly<Record<string, number>> | null = null;
let panelCollapsedCache: Readonly<Record<string, boolean>> | null = null;
let storageInvalidationListenerInstalled = false;

function ensurePanelStorageCacheInvalidationListener(): void {
  if (storageInvalidationListenerInstalled) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === null) {
      invalidatePanelStorageCacheForKeys([PANEL_SPANS_KEY, PANEL_COL_SPANS_KEY, PANEL_COLLAPSED_KEY]);
      return;
    }
    invalidatePanelStorageCacheForKeys([event.key]);
  });
  storageInvalidationListenerInstalled = true;
}

function readStorageMap<T>(key: string): Record<string, T> {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, T>
      : {};
  } catch {
    return {};
  }
}

function freezeStorageMap<T>(map: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(map);
}

function writeStorageMap<T>(key: string, map: Record<string, T>): void {
  localStorage.setItem(key, JSON.stringify(map));
}

function removeStorageMap(key: string): void {
  localStorage.removeItem(key);
}

export function loadPanelSpans(): Readonly<Record<string, number>> {
  ensurePanelStorageCacheInvalidationListener();
  panelSpansCache ??= freezeStorageMap(readStorageMap<number>(PANEL_SPANS_KEY));
  return panelSpansCache;
}

export function savePanelSpan(panelId: string, span: number): void {
  ensurePanelStorageCacheInvalidationListener();
  const next = { ...loadPanelSpans(), [panelId]: span };
  writeStorageMap(PANEL_SPANS_KEY, next);
  panelSpansCache = freezeStorageMap(next);
}

// resetHeight historically persisted an empty aggregate map instead of removing
// the row-span key, so the default keeps that exact behavior for callers.
export function clearPanelSpan(panelId: string, options: { removeWhenEmpty?: boolean } = {}): void {
  ensurePanelStorageCacheInvalidationListener();
  const spans = loadPanelSpans();
  if (!(panelId in spans)) return;
  const next = { ...spans };
  delete next[panelId];
  if (options.removeWhenEmpty && Object.keys(next).length === 0) {
    removeStorageMap(PANEL_SPANS_KEY);
    panelSpansCache = freezeStorageMap(next);
    return;
  }
  writeStorageMap(PANEL_SPANS_KEY, next);
  panelSpansCache = freezeStorageMap(next);
}

export function clearPanelSpans(): void {
  ensurePanelStorageCacheInvalidationListener();
  removeStorageMap(PANEL_SPANS_KEY);
  panelSpansCache = freezeStorageMap({});
}

export function loadPanelColSpans(): Readonly<Record<string, number>> {
  ensurePanelStorageCacheInvalidationListener();
  panelColSpansCache ??= freezeStorageMap(readStorageMap<number>(PANEL_COL_SPANS_KEY));
  return panelColSpansCache;
}

export function savePanelColSpan(panelId: string, span: number): void {
  ensurePanelStorageCacheInvalidationListener();
  const next = { ...loadPanelColSpans(), [panelId]: span };
  writeStorageMap(PANEL_COL_SPANS_KEY, next);
  panelColSpansCache = freezeStorageMap(next);
}

// Column-span cleanup historically removed the aggregate key when the last
// entry disappeared, unlike row-span reset. Keep that legacy default explicit.
export function clearPanelColSpan(panelId: string, { removeWhenEmpty = true }: { removeWhenEmpty?: boolean } = {}): void {
  ensurePanelStorageCacheInvalidationListener();
  const spans = loadPanelColSpans();
  if (!(panelId in spans)) return;
  const next = { ...spans };
  delete next[panelId];
  if (removeWhenEmpty && Object.keys(next).length === 0) {
    removeStorageMap(PANEL_COL_SPANS_KEY);
    panelColSpansCache = freezeStorageMap(next);
    return;
  }
  writeStorageMap(PANEL_COL_SPANS_KEY, next);
  panelColSpansCache = freezeStorageMap(next);
}

export function clearPanelColSpans(): void {
  ensurePanelStorageCacheInvalidationListener();
  removeStorageMap(PANEL_COL_SPANS_KEY);
  panelColSpansCache = freezeStorageMap({});
}

export function loadPanelCollapsed(): Readonly<Record<string, boolean>> {
  ensurePanelStorageCacheInvalidationListener();
  panelCollapsedCache ??= freezeStorageMap(readStorageMap<boolean>(PANEL_COLLAPSED_KEY));
  return panelCollapsedCache;
}

export function savePanelCollapsed(panelId: string, collapsed: boolean): void {
  ensurePanelStorageCacheInvalidationListener();
  const next = { ...loadPanelCollapsed() };
  if (collapsed) {
    next[panelId] = true;
  } else {
    delete next[panelId];
  }
  if (Object.keys(next).length === 0) {
    removeStorageMap(PANEL_COLLAPSED_KEY);
  } else {
    writeStorageMap(PANEL_COLLAPSED_KEY, next);
  }
  panelCollapsedCache = freezeStorageMap(next);
}

export function clearPanelSpanEntry(panelId: string): void {
  try {
    clearPanelSpan(panelId, { removeWhenEmpty: true });
  } catch {
    // Ignore corrupt or unavailable storage, matching the previous cleanup path.
  }
}

export function clearPanelColSpanEntry(panelId: string): void {
  try {
    clearPanelColSpan(panelId, { removeWhenEmpty: true });
  } catch {
    // Ignore corrupt or unavailable storage, matching the previous cleanup path.
  }
}

export function invalidatePanelStorageCacheForKeys(keys: Iterable<string>): void {
  for (const key of keys) {
    if (key === PANEL_SPANS_KEY) panelSpansCache = null;
    else if (key === PANEL_COL_SPANS_KEY) panelColSpansCache = null;
    else if (key === PANEL_COLLAPSED_KEY) panelCollapsedCache = null;
  }
}
