import type { PanelConfig } from '@/types';
import { ALL_PANELS } from '@/config/panels';
import { isDynamicPanel } from '@/services/mission-presets';
import { overlayPanelChoices, type PanelTab, type TabsState } from '@/services/tab-store';
import { captureScope } from '@/services/team-dashboards';
import { filtersFromEntries, filtersToEntries } from '@/services/panel-filters';
import { normalizeScope } from '../../shared/tab-scope';
import {
  DASHBOARD_TAB_NAME_MAX_LENGTH,
  type DashboardTabChange,
  type DashboardTabRecord,
  type DashboardTabRecordPanel,
  type DashboardTabRow,
} from '../../shared/dashboard-tab-sync';

/**
 * Dashboard tab sync (#11141): the pure part. Converts tabs to the stored
 * record and back, and merges local tabs with the server's rows one tab at a
 * time. No storage, network or DOM here; src/services/tab-cloud-sync.ts
 * drives it.
 *
 * Rules (the plan's decision table):
 * - A present tab is edited locally when its record hash differs from the
 *   hash last agreed with the server (`meta.base`). Every mutation path is
 *   caught this way without hooking it.
 * - A delete propagates only from an explicit tombstone (`meta.tombstones`,
 *   written by the tab bar's delete). A tab merely missing from local storage
 *   (a stale window, an older bundle) is restored from the server.
 * - Edits beat deletes; when both sides edited, the local edit is pushed over
 *   the server's version.
 */

/** What this device last agreed with the server for one tab. */
export interface TabSyncBase {
  version: number;
  hash: string;
}

export interface TabSyncMeta {
  /** The account these bases belong to. Kept across sign-out. */
  userId: string | null;
  base: Record<string, TabSyncBase>;
  /** Tabs deleted on this device whose delete has not reached the server. */
  tombstones: string[];
  /** Per tab: record entries this device cannot render, carried on every push. */
  carried: Record<string, DashboardTabRecordPanel[]>;
}

export function emptyTabSyncMeta(userId: string | null): TabSyncMeta {
  return { userId, base: {}, tombstones: [], carried: {} };
}

// Mirrors the server's key rule (convex/lib/teamDashboardLayout.ts KEY_RE)
// so a capture never sends something the mutation would refuse.
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;
const MAX_RECORD_PANELS = 400;
const FALLBACK_TAB_NAME = 'Tab';

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

function recordName(name: string): string {
  const trimmed = name.trim().slice(0, DASHBOARD_TAB_NAME_MAX_LENGTH).trim();
  return trimmed.length > 0 ? trimmed : FALLBACK_TAB_NAME;
}

/**
 * The tab as the server stores it. A panel the free-tier gate turned off
 * (`proGated`) is recorded as on: the gate is this device's tier, not the
 * user's choice, and the receiving device applies its own gate.
 */
export function captureTabRecord(tab: PanelTab, carried: readonly DashboardTabRecordPanel[] = []): DashboardTabRecord {
  const bottom = new Set(tab.bottomSet);
  const keys = new Set([...tab.panelOrder, ...Object.keys(tab.panelSettings)]);
  const panels: DashboardTabRecordPanel[] = [];
  for (const key of keys) {
    const config = hasOwn(tab.panelSettings, key) ? tab.panelSettings[key] : undefined;
    if (!config || !KEY_RE.test(key)) continue;
    const entry: DashboardTabRecordPanel = { key, on: config.enabled || config.proGated === true };
    if (bottom.has(key)) entry.bottom = true;
    panels.push(entry);
  }
  const present = new Set(panels.map((p) => p.key));
  for (const entry of carried) {
    if (present.has(entry.key) || !KEY_RE.test(entry.key)) continue;
    present.add(entry.key);
    panels.push(entry.bottom ? { key: entry.key, on: entry.on, bottom: true } : { key: entry.key, on: entry.on });
  }

  const record: DashboardTabRecord = { name: recordName(tab.name), panels: panels.slice(0, MAX_RECORD_PANELS) };
  const scope = captureScope(tab.scope);
  if (scope) record.scope = scope;
  const filters = filtersToEntries(tab.panelFilters);
  if (filters.length > 0) record.panelFilters = filters;
  if (tab.team && typeof tab.team.id === 'string' && Number.isInteger(tab.team.version) && tab.team.version >= 1) {
    record.team = { id: tab.team.id, version: tab.team.version };
  }
  return record;
}

/** Stable: records are built with a fixed field order. */
export function hashTabRecord(record: DashboardTabRecord): string {
  return JSON.stringify(record);
}

function defaultTabPanels(currentPanelSettings: Record<string, PanelConfig>) {
  return overlayPanelChoices(currentPanelSettings, []);
}

/**
 * Lay a server record over this device's copy of the tab, or over the
 * variant defaults for a tab this device has never had. Only visibility,
 * order and dock come from the record; every other panel field (display
 * name, font scale) stays this device's. Panels this device holds that the
 * record lacks stay, after the record's panels. Record entries this device
 * cannot render come back as `carried` so the next push keeps them.
 */
export function applyTabRecord(
  local: PanelTab | undefined,
  record: DashboardTabRecord,
  currentPanelSettings: Record<string, PanelConfig>,
  newId?: string,
): { tab: PanelTab; carried: DashboardTabRecordPanel[] } {
  const defaults = defaultTabPanels(currentPanelSettings);
  const panelSettings: Record<string, PanelConfig> = local
    ? structuredClone(local.panelSettings)
    : defaults.panelSettings;
  const localOrder = local ? local.panelOrder : defaults.panelOrder;
  const localBottom = local ? local.bottomSet : [];

  const carried: DashboardTabRecordPanel[] = [];
  const recordKeys = new Set<string>();
  const order: string[] = [];
  const bottomSet: string[] = [];
  for (const entry of record.panels) {
    const { key } = entry;
    if (recordKeys.has(key)) continue;
    recordKeys.add(key);
    const known = hasOwn(ALL_PANELS, key) || isDynamicPanel(key);
    const config = hasOwn(panelSettings, key) ? panelSettings[key]
      : hasOwn(defaults.panelSettings, key) ? defaults.panelSettings[key] : undefined;
    if (!known || !config) {
      carried.push(entry.bottom ? { key, on: entry.on, bottom: true } : { key, on: entry.on });
      continue;
    }
    const next: PanelConfig = { ...config, enabled: entry.on };
    // The receiving device re-derives the gate from its own tier.
    delete next.proGated;
    panelSettings[key] = next;
    if (key === 'map') continue;
    order.push(key);
    if (entry.bottom) bottomSet.push(key);
  }
  for (const key of localOrder) {
    if (key === 'map' || recordKeys.has(key) || order.includes(key)) continue;
    order.push(key);
  }
  for (const key of localBottom) {
    if (!recordKeys.has(key) && !bottomSet.includes(key)) bottomSet.push(key);
  }

  const id = local?.id ?? newId;
  if (!id) throw new Error('applyTabRecord needs an id for a new tab');
  const tab: PanelTab = { id, name: record.name, panelSettings, panelOrder: order, bottomSet };
  const scope = record.scope ? normalizeScope(record.scope) : null;
  if (scope) tab.scope = scope;
  const filters = filtersFromEntries(record.panelFilters);
  if (filters && Object.keys(filters).length > 0) tab.panelFilters = filters;
  if (record.team) tab.team = { ...record.team };
  return { tab, carried };
}

export type MergeMode = 'normal' | 'first-sync' | 'account-switch';

export interface MergeInput {
  local: TabsState;
  /** This device's sync state; for an account switch, the previous account's. */
  meta: TabSyncMeta;
  rows: DashboardTabRow[];
  currentPanelSettings: Record<string, PanelConfig>;
  /** The localized name of the auto-created tab, for the untouched test. */
  defaultName: string;
  mode: MergeMode;
  newTabId: () => string;
  /** The account signing in. Required for an account switch. */
  userId?: string;
  /**
   * Account switch only: false when the previous account's sync bases are
   * unknown (it signed in on a build without tab sync). Every local tab is
   * then treated as the previous account's.
   */
  previousSyncKnown?: boolean;
  /** Tabs the server refused for the tab cap this session; never pushed. */
  localOnly?: ReadonlySet<string>;
}

export interface PendingTabChange {
  change: DashboardTabChange;
  /** The pushed record's hash, stored as the base once the server accepts it. */
  hash: string | null;
}

export interface MergeResult {
  state: TabsState;
  meta: TabSyncMeta;
  changes: PendingTabChange[];
  /** The active tab is a different tab, or its content changed. */
  activeChanged: boolean;
  /** Anything in `state` differs from the input. */
  changed: boolean;
}

function freshDefaultTab(input: MergeInput): PanelTab {
  const { panelSettings, panelOrder } = defaultTabPanels(input.currentPanelSettings);
  return { id: input.newTabId(), name: input.defaultName, panelSettings, panelOrder, bottomSet: [] };
}

function onKeys(record: DashboardTabRecord): Set<string> {
  return new Set(record.panels.filter((p) => p.on && p.key !== 'map').map((p) => p.key));
}

/**
 * The tab this device made on its first run and nobody changed: the default
 * name, no focus, filters or team link, and exactly the default panels on.
 * Decided from content, so a device that predates tab sync qualifies too.
 */
function isUntouchedDefault(tab: PanelTab, input: MergeInput): boolean {
  if (tab.name.trim() !== input.defaultName || tab.scope || tab.team) return false;
  if (tab.panelFilters && Object.keys(tab.panelFilters).length > 0) return false;
  const defaults = defaultTabPanels(input.currentPanelSettings);
  const mine = onKeys(captureTabRecord(tab));
  const expected = onKeys(captureTabRecord({ id: tab.id, name: tab.name, ...defaults, bottomSet: [] }));
  return mine.size === expected.size && [...mine].every((key) => expected.has(key));
}

export function mergeTabs(input: MergeInput): MergeResult {
  const originalActive = input.local.activeTabId;
  let tabs = input.local.tabs.map((t) => t);
  let meta: TabSyncMeta = {
    userId: input.meta.userId,
    base: { ...input.meta.base },
    tombstones: [...input.meta.tombstones],
    carried: { ...input.meta.carried },
  };
  let changed = false;
  let activeContentChanged = false;
  const liveRows = input.rows.filter((r) => !r.deleted && r.record);

  if (input.mode === 'account-switch') {
    // The previous account's synced tabs are its own and stay in its cloud.
    // What was made or edited since (for example while signed out) is the
    // device user's work and becomes the new account's, minus team links,
    // which belong to the previous account's team.
    const prev = meta;
    const kept = input.previousSyncKnown === false ? [] : tabs.filter((t) => {
      const base = prev.base[t.id];
      return !base || base.hash !== hashTabRecord(captureTabRecord(t, prev.carried[t.id]));
    });
    tabs = kept.map((t) => {
      if (!t.team) return t;
      const copy = { ...t };
      delete copy.team;
      return copy;
    });
    changed = tabs.length !== input.local.tabs.length || kept.some((t) => t.team);
    meta = emptyTabSyncMeta(input.userId ?? null);
  } else if (input.mode === 'first-sync') {
    const only = tabs.length === 1 ? tabs[0]! : null;
    if (only && Object.keys(meta.base).length === 0 && liveRows.length > 0 && isUntouchedDefault(only, input)) {
      tabs = [];
      changed = true;
    }
  }

  const localById = new Map(tabs.map((t) => [t.id, t]));
  const rowById = new Map(input.rows.map((r) => [r.tabId, r]));
  const tombstones = new Set(meta.tombstones);
  const changes: PendingTabChange[] = [];
  const removed = new Set<string>();
  const replaced = new Map<string, PanelTab>();
  const added: DashboardTabRow[] = [];

  const push = (tab: PanelTab, baseVersion: number | undefined) => {
    if (input.localOnly?.has(tab.id)) return;
    const record = captureTabRecord(tab, meta.carried[tab.id]);
    changes.push({
      change: { tabId: tab.id, ...(baseVersion !== undefined ? { baseVersion } : {}), record },
      hash: hashTabRecord(record),
    });
  };
  const adopt = (local: PanelTab | undefined, row: DashboardTabRow): PanelTab => {
    const { tab, carried } = applyTabRecord(local, row.record!, input.currentPanelSettings, row.tabId);
    if (carried.length > 0) meta.carried[row.tabId] = carried;
    else delete meta.carried[row.tabId];
    meta.base[row.tabId] = { version: row.version, hash: hashTabRecord(captureTabRecord(tab, carried)) };
    return tab;
  };
  const forget = (id: string) => {
    delete meta.base[id];
    delete meta.carried[id];
  };

  const allIds = new Set<string>([...localById.keys(), ...Object.keys(meta.base), ...tombstones, ...rowById.keys()]);
  for (const id of allIds) {
    const local = localById.get(id);
    const row = rowById.get(id);
    const base = meta.base[id];
    const remoteLive = !!row && !row.deleted && !!row.record;

    if (tombstones.has(id) && !local) {
      if (remoteLive && base && row!.version === base.version) {
        changes.push({ change: { tabId: id, baseVersion: base.version, record: null }, hash: null });
      } else if (remoteLive) {
        // Edited elsewhere after this device deleted it: the edit wins.
        tombstones.delete(id);
        added.push(row!);
      } else {
        tombstones.delete(id);
        forget(id);
      }
      continue;
    }
    tombstones.delete(id);

    if (local) {
      const localHash = hashTabRecord(captureTabRecord(local, meta.carried[id]));
      const edited = !base || base.hash !== localHash;
      if (!edited) {
        if (remoteLive && row!.version !== base!.version) {
          replaced.set(id, adopt(local, row!));
        } else if (!remoteLive && (row?.deleted || !row)) {
          removed.add(id);
          forget(id);
        }
        continue;
      }
      if (!base) {
        if (!row) push(local, undefined);
        else if (remoteLive) {
          // The server holds this tab but this device has no base for it (lost
          // sync state): the server's copy is the known-good one.
          replaced.set(id, adopt(local, row));
        } else push(local, row.version);
        continue;
      }
      if (!row) push(local, undefined);
      else if (row.version === base.version) push(local, base.version);
      else push(local, row.version);
      continue;
    }

    // Absent locally, no tombstone.
    if (remoteLive) added.push(row!);
    else forget(id);
  }
  meta.tombstones = [...tombstones];

  if (removed.size > 0 || replaced.size > 0 || added.length > 0) changed = true;
  tabs = tabs.filter((t) => !removed.has(t.id)).map((t) => replaced.get(t.id) ?? t);
  added.sort((x, y) => x.createdAt - y.createdAt);
  for (const row of added) tabs.push(adopt(undefined, row));

  // Pick the active tab: keep it when it survived, else its neighbour, as
  // deleteTab does.
  let activeTabId = originalActive;
  if (!tabs.some((t) => t.id === activeTabId)) {
    const originalIndex = input.local.tabs.findIndex((t) => t.id === originalActive);
    const survivorsBefore = input.local.tabs.slice(0, Math.max(0, originalIndex)).filter((t) => tabs.some((x) => x.id === t.id));
    activeTabId = survivorsBefore.length > 0 ? survivorsBefore[survivorsBefore.length - 1]!.id : tabs[0]?.id ?? '';
  }
  if (tabs.length === 0) {
    const fresh = freshDefaultTab(input);
    tabs.push(fresh);
    activeTabId = fresh.id;
    push(fresh, undefined);
    changed = true;
  }
  if (replaced.has(activeTabId)) activeContentChanged = true;

  return {
    state: { activeTabId, tabs },
    meta,
    changes,
    activeChanged: activeTabId !== originalActive || activeContentChanged,
    changed,
  };
}
