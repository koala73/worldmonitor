import type { PanelConfig } from '@/types';
import { STORAGE_KEYS } from '@/config/variants/base';

interface UnifiedSettingsRefreshTarget {
  refreshPanelToggles?: () => void;
  refreshSourceToggles?: () => void;
}

export interface PreferenceStorageSyncContext {
  panelSettings: Record<string, PanelConfig>;
  disabledSources: Set<string>;
  unifiedSettings: UnifiedSettingsRefreshTarget | null;
  readonly PANEL_ORDER_KEY: string;
}

export interface PreferenceStorageSyncCallbacks {
  applyPanelSettings: () => void;
  updateSearchIndex: () => void;
  reloadPanelOrderFromStorage?: () => void;
}

export interface PreferenceStorageSyncLoaders {
  loadPanelSettingsFromStorage: () => Record<string, PanelConfig>;
  loadDisabledSourcesFromStorage?: () => Set<string>;
}

function loadJsonFromStorage<T>(key: string, defaultValue: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) as T : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function loadDisabledSourcesFromStorage(): Set<string> {
  return new Set(loadJsonFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []));
}

export function applyPreferenceStorageChanges(
  ctx: PreferenceStorageSyncContext,
  keys: Iterable<string | null>,
  callbacks: PreferenceStorageSyncCallbacks,
  loaders: PreferenceStorageSyncLoaders,
): void {
  const changedKeys = new Set<string>();
  for (const key of keys) {
    if (typeof key === 'string') changedKeys.add(key);
  }
  if (changedKeys.size === 0) return;

  if (changedKeys.has(STORAGE_KEYS.panels)) {
    ctx.panelSettings = loaders.loadPanelSettingsFromStorage();
    callbacks.applyPanelSettings();
    ctx.unifiedSettings?.refreshPanelToggles?.();
    callbacks.updateSearchIndex();
  }

  if (changedKeys.has(STORAGE_KEYS.disabledFeeds)) {
    ctx.disabledSources = loaders.loadDisabledSourcesFromStorage?.() ?? loadDisabledSourcesFromStorage();
    ctx.unifiedSettings?.refreshSourceToggles?.();
  }

  if (
    changedKeys.has(ctx.PANEL_ORDER_KEY) ||
    changedKeys.has(`${ctx.PANEL_ORDER_KEY}-bottom-set`)
  ) {
    callbacks.reloadPanelOrderFromStorage?.();
  }
}
