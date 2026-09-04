import type { PanelConfig } from '@/types';
import { SITE_VARIANT } from '@/config/variant';
import { resetMissionPresetState } from '@/services/mission-presets';

/**
 * Dashboard tabs — named, persistent panel workspaces.
 *
 * Each tab stores a full snapshot of panel settings plus the panel order.
 * The ACTIVE tab's snapshot is only authoritative while the tab is inactive:
 * while a tab is active, the live global state (STORAGE_KEYS.panels +
 * PANEL_ORDER_KEY) is the source of truth, and the snapshot is refreshed
 * when the user switches away (see PanelLayoutManager.snapshotActiveTab).
 */
export interface PanelTab {
  id: string;
  name: string;
  panelSettings: Record<string, PanelConfig>;
  panelOrder: string[];
  bottomSet: string[];
}

export interface TabsState {
  activeTabId: string;
  tabs: PanelTab[];
}

/** Matches the dashboard tab rename input (`maxLength` on the visible control). */
export const DASHBOARD_TAB_NAME_MAX_LENGTH = 40;

/**
 * Stable tab IDs from `generateTabId()`. Agents must use these, never display names.
 * `Date.now().toString(36)` and the random suffix are lowercase base36.
 */
export const DASHBOARD_TAB_ID_PATTERN = '^tab-[a-z0-9]+-[a-z0-9]+$';
export const DASHBOARD_TAB_ID_RE = new RegExp(DASHBOARD_TAB_ID_PATTERN);

// Per-variant key: each variant has its own default panel set, so tabs
// built on one variant must not leak into another.
const TABS_STORAGE_KEY = `worldmonitor-tabs-v1:${SITE_VARIANT}`;

export function generateTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isDashboardTabId(value: unknown): value is string {
  return typeof value === 'string' && DASHBOARD_TAB_ID_RE.test(value);
}

export function loadTabsState(): TabsState | null {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TabsState;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    const tabs = parsed.tabs.filter((t): t is PanelTab =>
      !!t && typeof t.id === 'string' && typeof t.name === 'string'
      && !!t.panelSettings && typeof t.panelSettings === 'object'
      && Array.isArray(t.panelOrder) && Array.isArray(t.bottomSet));
    if (tabs.length === 0) return null;
    const activeTabId = tabs.some((t) => t.id === parsed.activeTabId)
      ? parsed.activeTabId
      : tabs[0]!.id;
    return { activeTabId, tabs };
  } catch {
    return null;
  }
}

export interface TabsPersistReceipt {
  persisted: boolean;
}

export function saveTabsState(state: TabsState): TabsPersistReceipt {
  try {
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(state));
    return { persisted: true };
  } catch {
    // Storage unavailable (private mode / quota) — tabs still work this session.
    return { persisted: false };
  }
}

/**
 * Panel selection for a fresh tab: the variant's default panels.
 * Reuses the mission-preset reset path so dynamic panels (custom widgets,
 * MCP panels, desktop runtime-config) survive with their current config.
 */
export function buildDefaultTabPanels(
  currentPanelSettings: Record<string, PanelConfig>,
): { panelSettings: Record<string, PanelConfig>; panelOrder: string[] } {
  const reset = resetMissionPresetState(currentPanelSettings);
  return { panelSettings: reset.panelSettings, panelOrder: reset.panelOrder };
}
