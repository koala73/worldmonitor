export const PANEL_SPANS_KEY = 'worldmonitor-panel-spans';
export const PANEL_COL_SPANS_KEY = 'worldmonitor-panel-col-spans';
export const PANEL_COLLAPSED_KEY = 'worldmonitor-panel-collapsed';

let panelSpansCache: Record<string, number> | null = null;
let panelColSpansCache: Record<string, number> | null = null;
let panelCollapsedCache: Record<string, boolean> | null = null;

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

function writeStorageMap<T>(key: string, map: Record<string, T>): void {
  localStorage.setItem(key, JSON.stringify(map));
}

function removeStorageMap(key: string): void {
  localStorage.removeItem(key);
}

export function loadPanelSpans(): Readonly<Record<string, number>> {
  panelSpansCache ??= readStorageMap<number>(PANEL_SPANS_KEY);
  return panelSpansCache;
}

export function savePanelSpan(panelId: string, span: number): void {
  const next = { ...loadPanelSpans(), [panelId]: span };
  writeStorageMap(PANEL_SPANS_KEY, next);
  panelSpansCache = next;
}

export function clearPanelSpan(panelId: string, options: { removeWhenEmpty?: boolean } = {}): void {
  const spans = loadPanelSpans();
  if (!(panelId in spans)) return;
  const next = { ...spans };
  delete next[panelId];
  if (options.removeWhenEmpty && Object.keys(next).length === 0) {
    removeStorageMap(PANEL_SPANS_KEY);
    panelSpansCache = next;
    return;
  }
  writeStorageMap(PANEL_SPANS_KEY, next);
  panelSpansCache = next;
}

export function clearPanelSpans(): void {
  removeStorageMap(PANEL_SPANS_KEY);
  panelSpansCache = {};
}

export function loadPanelColSpans(): Readonly<Record<string, number>> {
  panelColSpansCache ??= readStorageMap<number>(PANEL_COL_SPANS_KEY);
  return panelColSpansCache;
}

export function savePanelColSpan(panelId: string, span: number): void {
  const next = { ...loadPanelColSpans(), [panelId]: span };
  writeStorageMap(PANEL_COL_SPANS_KEY, next);
  panelColSpansCache = next;
}

export function clearPanelColSpan(panelId: string, options: { removeWhenEmpty?: boolean } = { removeWhenEmpty: true }): void {
  const spans = loadPanelColSpans();
  if (!(panelId in spans)) return;
  const next = { ...spans };
  delete next[panelId];
  if (options.removeWhenEmpty && Object.keys(next).length === 0) {
    removeStorageMap(PANEL_COL_SPANS_KEY);
    panelColSpansCache = next;
    return;
  }
  writeStorageMap(PANEL_COL_SPANS_KEY, next);
  panelColSpansCache = next;
}

export function clearPanelColSpans(): void {
  removeStorageMap(PANEL_COL_SPANS_KEY);
  panelColSpansCache = {};
}

export function loadPanelCollapsed(): Readonly<Record<string, boolean>> {
  panelCollapsedCache ??= readStorageMap<boolean>(PANEL_COLLAPSED_KEY);
  return panelCollapsedCache;
}

export function savePanelCollapsed(panelId: string, collapsed: boolean): void {
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
  panelCollapsedCache = next;
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
