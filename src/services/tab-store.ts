import type { PanelConfig } from '@/types';
import { SITE_VARIANT } from '@/config/variant';
import { ALL_PANELS } from '@/config/panels';
import { isDynamicPanel, resetMissionPresetState } from '@/services/mission-presets';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/utils/safe-storage';
import { normalizeScope, type TabScope } from '../../shared/tab-scope';
import { normalizePanelFilters, type PanelFilters } from './panel-filters';

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
  /**
   * Set when the tab was opened from, or shared as, a team dashboard
   * (src/services/team-dashboards.ts): that dashboard's id and the version
   * this tab holds.
   */
  team?: { id: string; version: number };
  /**
   * Dashboard focus (#10453): the countries (and optional date window) this
   * tab is about. Unlike panel settings it is never snapshotted from live
   * state; `PanelLayoutManager` writes it here when the user changes it, and
   * `src/services/tab-focus.ts` holds the active tab's copy at runtime.
   */
  scope?: TabScope;
  /**
   * Panels' own filter choices (forecast region, webcam region; #10453
   * phase 2). Written by `PanelLayoutManager` when a panel reports a change,
   * applied when the tab becomes active, and shared with a team dashboard.
   */
  panelFilters?: PanelFilters;
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

/**
 * Shape-check a decoded tabs payload the way `loadTabsState` does for the
 * stored one: drop malformed tabs, fall back to the first tab when the active
 * id is unknown, and return null when nothing usable remains. Shared with the
 * settings import so a backup is admitted under the same rules the app reads
 * storage with, rather than a second, drifting copy of them.
 */
export function normalizeTabsState(parsed: unknown): TabsState | null {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as TabsState).tabs)) return null;
  const candidate = parsed as TabsState;
  const tabs = candidate.tabs.filter((t): t is PanelTab =>
    !!t && typeof t.id === 'string' && typeof t.name === 'string'
    && !!t.panelSettings && typeof t.panelSettings === 'object'
    && Array.isArray(t.panelOrder) && Array.isArray(t.bottomSet));
  if (tabs.length === 0) return null;
  for (const tab of tabs) {
    const team = tab.team as unknown;
    if (team === undefined) continue;
    const ok = !!team && typeof team === 'object'
      && typeof (team as { id?: unknown }).id === 'string'
      && Number.isInteger((team as { version?: unknown }).version);
    if (!ok) delete tab.team;
  }
  for (const tab of tabs) {
    if (tab.scope === undefined) continue;
    const scope = normalizeScope(tab.scope);
    if (scope) tab.scope = scope;
    else delete tab.scope;
  }
  for (const tab of tabs) {
    if (tab.panelFilters === undefined) continue;
    const filters = normalizePanelFilters(tab.panelFilters);
    if (filters) tab.panelFilters = filters;
    else delete tab.panelFilters;
  }
  const activeTabId = tabs.some((t) => t.id === candidate.activeTabId)
    ? candidate.activeTabId
    : tabs[0]!.id;
  return { activeTabId, tabs };
}

export function loadTabsState(): TabsState | null {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return null;
    return normalizeTabsState(JSON.parse(raw));
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

export type TabPanels = Pick<PanelTab, 'panelSettings' | 'panelOrder'>;

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

// Its own key rather than a TabsState field: every tab switch in every open
// window rewrites the whole tabs blob from that window's memory, so a field
// there would be reverted by any other window and dropped by an older bundle.
const NEW_TAB_PANELS_STORAGE_KEY = `worldmonitor-new-tab-panels-v1:${SITE_VARIANT}`;

/**
 * One panel as the saved tab showed it. Deliberately not a PanelConfig: no
 * `proGated` marker survives, so the clamp at creation re-derives the gate from
 * the current tier. A panel the free-tier gate had hidden is saved hidden: on a
 * free account the gate hides dozens of default panels the user never chose,
 * and new tabs must not surface panels the saved tab never showed.
 */
export interface NewTabPanelChoice {
  key: string;
  on: boolean;
}

/** What new tabs start with. Array order is grid order. */
export type NewTabPanels = NewTabPanelChoice[];

/**
 * Parse a stored or imported value. Keeps `{ key, on }` entries, first
 * occurrence of a key wins, extra fields are dropped. Null when nothing usable
 * remains, so an empty list and no list mean the same thing.
 */
export function normalizeNewTabPanels(parsed: unknown): NewTabPanels | null {
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<string>();
  const out: NewTabPanels = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const { key, on } = entry as Partial<NewTabPanelChoice>;
    if (typeof key !== 'string' || key === '' || typeof on !== 'boolean' || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, on });
  }
  return out.length > 0 ? out : null;
}

function loadNewTabPanels(): NewTabPanels | null {
  const raw = safeStorageGet(NEW_TAB_PANELS_STORAGE_KEY);
  if (!raw) return null;
  try {
    return normalizeNewTabPanels(JSON.parse(raw));
  } catch {
    return null;
  }
}

function captureNewTabPanels(from: TabPanels): NewTabPanels {
  const keys = new Set([...from.panelOrder, ...Object.keys(from.panelSettings)]);
  const out: NewTabPanels = [];
  for (const key of keys) {
    const config = from.panelSettings[key];
    if (!config) continue;
    out.push({ key, on: config.enabled });
  }
  return out;
}

export function hasNewTabPanels(): boolean {
  return loadNewTabPanels() !== null;
}

/**
 * Remember a tab's panels as what new tabs start with, replacing any earlier
 * save. `persisted` reads the value back, so it is false for a null store, a
 * throwing getter and a full quota alike.
 */
export function saveNewTabPanels(from: TabPanels): TabsPersistReceipt {
  const json = JSON.stringify(captureNewTabPanels(from));
  safeStorageSet(NEW_TAB_PANELS_STORAGE_KEY, json);
  return { persisted: safeStorageGet(NEW_TAB_PANELS_STORAGE_KEY) === json };
}

export function clearNewTabPanels(): void {
  safeStorageRemove(NEW_TAB_PANELS_STORAGE_KEY);
}

/**
 * Panels for a fresh tab: the variant's default panels (dynamic panels keep
 * their live config) with the saved choices laid over them.
 *
 * Returns the raw selection. The caller applies the free-tier clamp once the
 * tier is known; nothing here reads the entitlement or rewrites the saved list.
 * A saved key the live settings no longer hold (a deleted widget) is skipped,
 * and so is one that is neither a known panel nor a dynamic one, so a stale
 * key cannot take a free-cap slot.
 */
export function buildNewTabPanels(currentPanelSettings: Record<string, PanelConfig>): TabPanels {
  return overlayPanelChoices(currentPanelSettings, loadNewTabPanels() ?? []);
}

/**
 * The variant's default panels (dynamic panels keep their live config) with a
 * list of panel choices laid over them, in the list's order. Shared by saved
 * new-tab panels and team dashboards.
 */
export function overlayPanelChoices(
  currentPanelSettings: Record<string, PanelConfig>,
  choices: readonly NewTabPanelChoice[],
): TabPanels {
  const base = resetMissionPresetState(currentPanelSettings);
  const order: string[] = [];
  for (const { key, on } of choices) {
    // Own-property checks: a stored or imported key such as `__proto__` or
    // `constructor` reads an inherited member through a plain lookup.
    if (!hasOwn(base.panelSettings, key) || !(hasOwn(ALL_PANELS, key) || isDynamicPanel(key))) continue;
    const config = base.panelSettings[key]!;
    const next: PanelConfig = { ...config, enabled: on };
    delete next.proGated;
    base.panelSettings[key] = next;
    if (key !== 'map') order.push(key);
  }
  return { panelSettings: base.panelSettings, panelOrder: order.length > 0 ? order : base.panelOrder };
}
