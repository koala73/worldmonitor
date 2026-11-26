import type { PanelConfig } from '@/types';
import { ALL_PANELS } from '@/config/panels';
import { isDynamicPanel } from '@/services/mission-presets';
import { overlayPanelChoices, type PanelTab, type TabsState } from '@/services/tab-store';
import { captureScope } from '@/services/team-dashboards';
import { filtersFromEntries, filtersToEntries } from '@/services/panel-filters';
import { normalizeScope } from '../../shared/tab-scope';
import {
  DASHBOARD_KEY_RE,
  DASHBOARD_TAB_NAME_MAX_LENGTH,
  MAX_DASHBOARD_PANELS,
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
  carried: Record<string, CarriedPanel[]>;
  /**
   * Written when sync stops: tabs with this account's work that never
   * reached it. An account switch keeps them for this account.
   */
  heldBack?: string[];
  /**
   * Set when this account's departure is recorded (sign-out or a switch).
   * Tabs edited after it are the device user's and go to the next account;
   * only `heldBack` stays this account's. Without it every unpushed tab is
   * this account's.
   */
  signedOut?: boolean;
  /**
   * Per tab with no base: its last write, by the lowest version it can get
   * (1 for a new tab) and the record's hash. A write whose answer never
   * arrived (the session stopped) may still have landed; a row at or past
   * that version is this device's write or a later edit of it, and only a
   * row with the same hash is that write.
   */
  sent?: Record<string, SentWrite>;
  /**
   * Tabs made or edited under another account that signed in here but never
   * finished a sync pass, by that account. They are its work, not `userId`'s.
   */
  foreign?: Record<string, string>;
  /**
   * Accounts whose `foreign` marks are recorded on this state. Recording one
   * again would mark work done since as theirs.
   */
  departed?: string[];
}

export interface SentWrite {
  version: number;
  hash: string;
}

/**
 * A record entry this device cannot render. `after` is the record key it
 * followed (null: first), so a push puts it back where the record had it.
 */
export type CarriedPanel = DashboardTabRecordPanel & { after?: string | null };

/** Tabs kept for an account that is not signed in, with their sync bases. */
export interface HeldTabs {
  tabs: PanelTab[];
  base: Record<string, TabSyncBase>;
  carried: Record<string, CarriedPanel[]>;
  /** Deletes that never reached the account. */
  tombstones: string[];
  sent: Record<string, SentWrite>;
}

export function emptyTabSyncMeta(userId: string | null): TabSyncMeta {
  return { userId, base: {}, tombstones: [], carried: {} };
}

export function emptyHeldTabs(): HeldTabs {
  return { tabs: [], base: {}, carried: {}, tombstones: [], sent: {} };
}

// The server's key rule, so a capture never sends something the mutation refuses.
const KEY_RE = DASHBOARD_KEY_RE;
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
export function captureTabRecord(tab: PanelTab, carried: readonly CarriedPanel[] = []): DashboardTabRecord {
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

  // At the cap, a local addition gives way before an entry another device
  // put in the record: dropping that entry would delete it everywhere.
  const carriedEntries: CarriedPanel[] = [];
  const present = new Set(panels.map((p) => p.key));
  for (const entry of carried) {
    if (present.has(entry.key) || !KEY_RE.test(entry.key)) continue;
    present.add(entry.key);
    carriedEntries.push(entry);
  }
  const room = Math.max(0, MAX_DASHBOARD_PANELS - carriedEntries.length);
  const out = panels.slice(0, room);
  // Each carried entry goes back after the key it followed in the record
  // (entries are in record order, so one carried entry can follow another);
  // a rename or a move elsewhere in the tab does not shift it.
  let head = 0;
  for (const entry of carriedEntries.slice(0, MAX_DASHBOARD_PANELS)) {
    const plain: DashboardTabRecordPanel = entry.bottom ? { key: entry.key, on: entry.on, bottom: true } : { key: entry.key, on: entry.on };
    const at = entry.after === null ? head : entry.after === undefined ? -1 : out.findIndex((p) => p.key === entry.after) + 1;
    if (at <= 0 && entry.after !== null) out.push(plain);
    else out.splice(at, 0, plain);
    if (entry.after === null) head += 1;
  }
  const record: DashboardTabRecord = {
    name: recordName(tab.name),
    panels: out.slice(0, MAX_DASHBOARD_PANELS),
  };
  const scope = captureScope(tab.scope);
  if (scope) record.scope = scope;
  const filters = filtersToEntries(tab.panelFilters);
  if (filters.length > 0) record.panelFilters = filters;
  if (tab.team && typeof tab.team.id === 'string' && Number.isInteger(tab.team.version) && tab.team.version >= 1) {
    record.team = { id: tab.team.id, version: tab.team.version };
  }
  return record;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const field = (value as Record<string, unknown>)[key];
    if (field !== undefined) out[key] = canonical(field);
  }
  return out;
}

/** Field order does not count: a record read back from the server hashes as the one sent. */
export function hashTabRecord(record: DashboardTabRecord): string {
  return JSON.stringify(canonical(record));
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
): { tab: PanelTab; carried: CarriedPanel[] } {
  const defaults = defaultTabPanels(currentPanelSettings);
  const panelSettings: Record<string, PanelConfig> = local
    ? structuredClone(local.panelSettings)
    : defaults.panelSettings;
  const localOrder = local ? local.panelOrder : defaults.panelOrder;
  const localBottom = local ? local.bottomSet : [];

  const carried: CarriedPanel[] = [];
  const recordKeys = new Set<string>();
  const order: string[] = [];
  const bottomSet: string[] = [];
  let previous: string | null = null;
  for (const entry of record.panels) {
    const { key } = entry;
    if (recordKeys.has(key)) continue;
    recordKeys.add(key);
    const after = previous;
    previous = key;
    const known = hasOwn(ALL_PANELS, key) || isDynamicPanel(key);
    const config = hasOwn(panelSettings, key) ? panelSettings[key]
      : hasOwn(defaults.panelSettings, key) ? defaults.panelSettings[key] : undefined;
    if (!known || !config) {
      carried.push(entry.bottom ? { key, on: entry.on, bottom: true, after } : { key, on: entry.on, after });
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
  /** The panel order a first-run tab shows; omitted, order is not compared. */
  defaultPanelOrder?: readonly string[];
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
  /** Tabs an account switch kept for this account, put back now. */
  restore?: HeldTabs | null;
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
  /**
   * By account: work that never reached it (the previous account's at a
   * switch, or `meta.foreign` tabs), taken out of `state`.
   */
  held: Record<string, HeldTabs> | null;
  /** Ids from `restore` put back into `state` or `meta`. */
  restored: string[];
  /**
   * Ids from `restore` the device already had, or deleted here since. Their
   * held copy can go once the device's own state has reached the server.
   */
  heldPresent: string[];
}

function freshDefaultTab(input: MergeInput): PanelTab {
  const { panelSettings, panelOrder } = defaultTabPanels(input.currentPanelSettings);
  return { id: input.newTabId(), name: input.defaultName, panelSettings, panelOrder, bottomSet: [] };
}

/** The tab fields a first-run tab has; any other field set means the user set it. */
const FIRST_RUN_TAB_FIELDS = new Set(['id', 'name', 'panelSettings', 'panelOrder', 'bottomSet']);

const isEmptyField = (value: unknown): boolean =>
  value === undefined || value === null || (isPlainObject(value) && Object.keys(value).length === 0);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * PanelConfig fields by who sets them. The build sets name, priority and
 * premium, and the tier gate sets proGated; the user sets visibility and
 * text size. A field in neither list counts as a user's choice.
 */
const BUILD_PANEL_FIELDS = new Set(['name', 'priority', 'premium', 'proGated']);
const USER_PANEL_FIELDS = new Set(['enabled', 'fontScale']);

/** Whether a panel's user-set fields match the first-run config. */
function sameChoices(mine: PanelConfig | undefined, expected: PanelConfig | undefined): boolean {
  const on = (c: PanelConfig | undefined) => !!c && (c.enabled || c.proGated === true);
  if (on(mine) !== on(expected)) return false;
  if (mine?.fontScale !== expected?.fontScale) return false;
  for (const [field, value] of Object.entries(mine ?? {})) {
    if (!BUILD_PANEL_FIELDS.has(field) && !USER_PANEL_FIELDS.has(field) && value !== undefined) return false;
  }
  return true;
}

/**
 * The tab this device made on its first run and nobody changed: the default
 * name, no other tab field set, no panel the user made, every panel's
 * user-set fields (visibility, the map's included, and text size) as the
 * defaults have them, none docked, and the visible panels in this device's
 * first-run order. Decided from content, so a device that predates tab sync
 * qualifies too.
 */
function isUntouchedDefault(tab: PanelTab, input: MergeInput): boolean {
  if (tab.name.trim() !== input.defaultName) return false;
  for (const [field, value] of Object.entries(tab)) {
    if (!FIRST_RUN_TAB_FIELDS.has(field) && !isEmptyField(value)) return false;
  }
  if (tab.bottomSet.length > 0) return false;
  const defaults = defaultTabPanels(input.currentPanelSettings).panelSettings;
  const keys = new Set([...Object.keys(tab.panelSettings), ...Object.keys(defaults)]);
  for (const key of keys) {
    // Custom widgets and MCP panels are made by the user.
    if (key.startsWith('cw-') || key.startsWith('mcp-')) return false;
    const mine = hasOwn(tab.panelSettings, key) ? tab.panelSettings[key] : undefined;
    const expected = hasOwn(defaults, key) ? defaults[key] : undefined;
    if (!sameChoices(mine, expected)) return false;
  }
  if (!input.defaultPanelOrder) return true;
  // Panels the free tier hides are placed by the layout, not the user, so
  // only the panels on screen are compared.
  const rank = new Map(input.defaultPanelOrder.map((key, i) => [key, i]));
  const visible = tab.panelOrder.filter((key) => key !== 'map' && tab.panelSettings[key]?.enabled === true);
  const firstRun = [...visible].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
  return visible.every((key, i) => key === firstRun[i]);
}

export function mergeTabs(input: MergeInput): MergeResult {
  const originalActive = input.local.activeTabId;
  let tabs = input.local.tabs.map((t) => t);
  let meta: TabSyncMeta = {
    userId: input.meta.userId,
    base: { ...input.meta.base },
    tombstones: [...input.meta.tombstones],
    carried: { ...input.meta.carried },
    ...(input.meta.sent ? { sent: { ...input.meta.sent } } : {}),
  };
  let changed = false;
  let activeContentChanged = false;
  const liveRows = input.rows.filter((r) => !r.deleted && r.record);

  const heldBy: Record<string, HeldTabs> = {};
  const holdFor = (owner: string, t: PanelTab, from: TabSyncMeta | null) => {
    const held = (heldBy[owner] ??= emptyHeldTabs());
    held.tabs.push(t);
    if (input.meta.carried[t.id]) held.carried[t.id] = input.meta.carried[t.id]!;
    if (!from) return;
    if (from.base[t.id]) held.base[t.id] = from.base[t.id]!;
    if (from.sent?.[t.id]) held.sent[t.id] = from.sent[t.id]!;
  };

  // Work done under an account whose sync never ran is that account's. Its
  // bases (if any) are another account's versions, so none go with it.
  const foreign = input.meta.foreign ?? {};
  const ownForeign = new Set<string>();
  if (Object.keys(foreign).length > 0) {
    tabs = tabs.filter((t) => {
      const owner = foreign[t.id];
      if (!owner) return true;
      if (owner === input.userId) {
        ownForeign.add(t.id);
        return true;
      }
      holdFor(owner, t, null);
      return false;
    });
    if (tabs.length !== input.local.tabs.length) changed = true;
  }

  if (input.mode === 'account-switch') {
    // The previous account's synced tabs are its own and stay in its cloud.
    // Its work that never reached it (unpushed edits, new tabs, tabs over the
    // cap) is held for its next sign-in. Only what was made or edited after
    // its sign-out is the device user's and becomes the new account's, minus
    // team links, which belong to the previous account's team.
    const prev = meta;
    const heldBack = input.meta.signedOut ? new Set(input.meta.heldBack ?? []) : null;
    const kept: PanelTab[] = [];
    const hold: PanelTab[] = [];
    if (input.previousSyncKnown === false) {
      // The previous account signed in before tab sync: nothing says which
      // tabs it synced, so all of them are kept for it.
      for (const t of tabs) (ownForeign.has(t.id) ? kept : hold).push(t);
    } else {
      for (const t of tabs) {
        if (ownForeign.has(t.id)) {
          kept.push(t);
          continue;
        }
        const base = prev.base[t.id];
        const synced = !!base && base.hash === hashTabRecord(captureTabRecord(t, prev.carried[t.id]));
        if (synced) continue;
        if (!heldBack || heldBack.has(t.id)) hold.push(t);
        else kept.push(t);
      }
    }
    if (prev.userId) {
      for (const t of hold) holdFor(prev.userId, t, prev);
      // Its deletes that never reached it go with it too.
      for (const id of prev.tombstones) {
        if (!prev.base[id] && !prev.sent?.[id]) continue;
        const held = (heldBy[prev.userId] ??= emptyHeldTabs());
        held.tombstones.push(id);
        if (prev.base[id]) held.base[id] = prev.base[id]!;
        if (prev.sent?.[id]) held.sent[id] = prev.sent[id]!;
      }
    }
    tabs = kept.map((t) => {
      if (!t.team) return t;
      const copy = { ...t };
      delete copy.team;
      return copy;
    });
    if (tabs.length !== input.local.tabs.length || kept.some((t) => t.team)) changed = true;
    meta = emptyTabSyncMeta(input.userId ?? null);
  } else if (input.mode === 'first-sync') {
    const only = tabs.length === 1 ? tabs[0]! : null;
    if (only && Object.keys(meta.base).length === 0 && liveRows.length > 0 && isUntouchedDefault(only, input)) {
      tabs = [];
      changed = true;
    }
  }

  const restored: string[] = [];
  const heldPresent: string[] = [];
  if (input.restore) {
    const restore = input.restore;
    const present = new Set(tabs.map((t) => t.id));
    const sync = (id: string) => {
      const base = restore.base[id];
      if (base && !meta.base[id]) meta.base[id] = base;
      const sent = restore.sent[id];
      if (sent && !meta.sent?.[id]) (meta.sent ??= {})[id] = sent;
    };
    for (const t of restore.tabs) {
      if (present.has(t.id) || meta.tombstones.includes(t.id)) {
        heldPresent.push(t.id);
        continue;
      }
      restored.push(t.id);
      present.add(t.id);
      tabs.push(t);
      changed = true;
      sync(t.id);
      const carried = restore.carried[t.id];
      if (carried && !meta.carried[t.id]) meta.carried[t.id] = carried;
    }
    for (const id of restore.tombstones) {
      if (present.has(id) || meta.tombstones.includes(id)) {
        heldPresent.push(id);
        continue;
      }
      restored.push(id);
      meta.tombstones.push(id);
      sync(id);
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
    if (meta.sent) delete meta.sent[row.tabId];
    return tab;
  };
  const forget = (id: string) => {
    delete meta.base[id];
    delete meta.carried[id];
    if (meta.sent) delete meta.sent[id];
  };

  const allIds = new Set<string>([...localById.keys(), ...Object.keys(meta.base), ...tombstones, ...rowById.keys()]);
  for (const id of allIds) {
    const local = localById.get(id);
    const row = rowById.get(id);
    const base = meta.base[id];
    const remoteLive = !!row && !row.deleted && !!row.record;

    const sent = meta.sent?.[id];
    if (tombstones.has(id) && !local) {
      if (remoteLive && base && row!.version === base.version) {
        changes.push({ change: { tabId: id, baseVersion: base.version, record: null }, hash: null });
      } else if (remoteLive && !base && sent && row!.version >= sent.version && hashTabRecord(row!.record!) === sent.hash) {
        // Deleted while its first write was unanswered, and the row is that
        // write: same content. Another device's row at that version is not.
        changes.push({ change: { tabId: id, baseVersion: row!.version, record: null }, hash: null });
      } else if (remoteLive) {
        // Edited elsewhere after this device deleted it: the edit wins.
        tombstones.delete(id);
        if (meta.sent) delete meta.sent[id];
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
        else if (remoteLive && sent && row.version >= sent.version && localHash !== sent.hash) {
          // This device's unanswered write landed, and the tab was edited
          // here since: that later work is pushed over the row.
          push(local, row.version);
        } else if (remoteLive) {
          // The row is this device's landed write (or a later edit of it
          // elsewhere), or this device lost its sync state: take the row.
          replaced.set(id, adopt(local, row));
        } else if (sent && row.version >= sent.version && localHash === sent.hash) {
          // This device's unanswered write landed and was deleted elsewhere
          // since, with no edit here after it: the delete wins.
          removed.add(id);
          forget(id);
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
  if (meta.sent && Object.keys(meta.sent).length === 0) delete meta.sent;

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
    held: Object.keys(heldBy).length > 0 ? heldBy : null,
    restored,
    heldPresent,
  };
}
