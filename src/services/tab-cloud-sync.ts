import type { PanelConfig } from '@/types';
import { SITE_VARIANT } from '@/config/variant';
import { getConvexApi, getConvexClient, waitForConvexAuthForUser } from '@/services/convex-client';
import type { TabsState } from '@/services/tab-store';
import { safeStorageGetChecked, safeStorageSet } from '@/utils/safe-storage';
import {
  MAX_DASHBOARD_TAB_CHANGES_PER_CALL,
  type DashboardTabChange,
  type DashboardTabRow,
  type SyncDashboardTabsResult,
} from '../../shared/dashboard-tab-sync';
import {
  captureTabRecord,
  emptyTabSyncMeta,
  hashTabRecord,
  mergeTabs,
  type MergeMode,
  type PendingTabChange,
  type TabSyncMeta,
} from './tab-sync-merge';

/**
 * Dashboard tab sync driver (#11141). Keeps this device's tabs and the
 * signed-in account's `userDashboardTabs` rows in step: subscribes to the
 * rows, merges (src/services/tab-sync-merge.ts), applies the result through
 * the layout manager, and pushes local edits.
 *
 * Failure is quiet: an error reconnects a couple of times and then stops
 * sync, and tabs keep working locally. `onStopped` lets App hand the blob's
 * panel keys back to cloud-prefs, so a missing deployment never loses panel
 * sync.
 *
 * Each window keeps its own copy of the sync state in memory and only writes
 * it to storage for the next load. Two windows of one account share storage,
 * so reading another window's bases would make each one see its own older
 * tabs as edits and push them back and forth.
 */

/** What the layout manager provides. */
export interface TabSyncHost {
  /**
   * The tabs, with the active tab refreshed from live state. Must not write
   * any cloud-synced preference key (panel order included).
   */
  captureTabs(): TabsState | null;
  /** Store and show a merged state; re-apply the active tab when `activeChanged`. */
  applyTabs(next: TabsState, activeChanged: boolean): void;
  currentPanelSettings(): Record<string, PanelConfig>;
  defaultTabName(): string;
  /** The panel order before anyone moved a panel, for the untouched-tab test. */
  defaultPanelOrder(): readonly string[];
  newTabId(): string;
}

export interface TabSyncTransport {
  subscribe(variant: string, onRows: (rows: DashboardTabRow[]) => void, onError: (err: Error) => void): () => void;
  sync(args: { variant: string; expectedUserId: string; changes: DashboardTabChange[] }): Promise<SyncDashboardTabsResult>;
}

export type TabSyncStopReason = 'error' | 'unavailable' | 'wrong-account';

const META_KEY = `worldmonitor-tabs-sync-v1:${SITE_VARIANT}`;
// cloud-prefs-sync.ts records the account at every sign-in. It is read
// before that sign-in overwrites it, as the previous account when this
// browser has no tab-sync state yet.
const LAST_SIGNED_IN_AS_KEY = 'wm-last-signed-in-as';
const PUSH_DEBOUNCE_MS = 2_000;
const ACTIVE_CHECK_INTERVAL_MS = 30_000;
/** Waits before each reconnect after an error; then sync stops for the page. */
const RECONNECT_DELAYS_MS = [15_000, 60_000];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Parse stored sync state; null when absent, unreadable or unusable. */
export function loadTabSyncMeta(): TabSyncMeta | null {
  return parseTabSyncMeta(safeStorageGetChecked(META_KEY).value);
}

function parseTabSyncMeta(raw: string | null): TabSyncMeta | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const userId = typeof parsed.userId === 'string' ? parsed.userId : null;
    const base: TabSyncMeta['base'] = {};
    if (isRecord(parsed.base)) {
      for (const [id, entry] of Object.entries(parsed.base)) {
        if (isRecord(entry) && Number.isInteger(entry.version) && typeof entry.hash === 'string') {
          base[id] = { version: entry.version as number, hash: entry.hash };
        }
      }
    }
    const tombstones = Array.isArray(parsed.tombstones)
      ? parsed.tombstones.filter((id): id is string => typeof id === 'string')
      : [];
    const carried: TabSyncMeta['carried'] = {};
    if (isRecord(parsed.carried)) {
      for (const [id, list] of Object.entries(parsed.carried)) {
        if (!Array.isArray(list)) continue;
        const entries = list.filter((p): p is { key: string; on: boolean; bottom?: boolean } =>
          isRecord(p) && typeof p.key === 'string' && typeof p.on === 'boolean');
        if (entries.length > 0) carried[id] = entries;
      }
    }
    const heldBack = Array.isArray(parsed.heldBack)
      ? parsed.heldBack.filter((id): id is string => typeof id === 'string')
      : [];
    return { userId, base, tombstones, carried, ...(heldBack.length > 0 ? { heldBack } : {}) };
  } catch {
    return null;
  }
}

function saveTabSyncMeta(meta: TabSyncMeta): void {
  safeStorageSet(META_KEY, JSON.stringify(meta));
}

async function convexTransport(userId: string): Promise<TabSyncTransport | 'auth-timeout' | null> {
  const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
  if (!client || !api) return null;
  if (!await waitForConvexAuthForUser(userId)) return 'auth-timeout';
  return {
    subscribe(variant, onRows, onError) {
      const teardown = client.onUpdate(
        api.userPreferences.listDashboardTabs,
        { variant: variant as 'full' },
        (rows) => onRows(Array.isArray(rows) ? rows : []),
        onError,
      );
      return typeof teardown === 'function' ? teardown : () => {};
    },
    sync(args) {
      return client.mutation(api.userPreferences.syncDashboardTabs, {
        ...args,
        variant: args.variant as 'full',
      });
    },
  };
}

type TransportFactory = (userId: string) => Promise<TabSyncTransport | 'auth-timeout' | null>;
let transportFactory: TransportFactory = convexTransport;

/** Test seam: replace the Convex transport. */
export function __setTabSyncTransportForTests(factory: TransportFactory | null): void {
  transportFactory = factory ?? convexTransport;
}

interface Pending {
  userId: string;
  mode: MergeMode;
  previousSyncKnown: boolean;
  /** For an account switch: the previous account's sync state. */
  previousMeta: TabSyncMeta;
}

interface Session {
  userId: string;
  generation: number;
  host: TabSyncHost;
  onStopped: (reason: TabSyncStopReason) => void;
  pending: Pending | null;
  /** This window's sync state, from its first pass on. */
  meta: TabSyncMeta | null;
  rows: DashboardTabRow[] | null;
  /**
   * Rows this session wrote or was handed in a conflict, newer than the
   * subscription has shown yet. A pass merges against rows with these laid
   * over, or it would undo its own landed writes.
   */
  learned: Map<string, DashboardTabRow>;
  /** Tabs deleted here while they had no base yet (first push in flight). */
  deletedUnsynced: Set<string>;
  reconnects: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  unsubscribe: (() => void) | null;
  transport: TabSyncTransport | null;
  running: boolean;
  rerun: boolean;
  debounce: ReturnType<typeof setTimeout> | null;
  interval: ReturnType<typeof setInterval> | null;
  localOnly: Set<string>;
  onVisibility: (() => void) | null;
}

let generation = 0;
let session: Session | null = null;
let prepared: Pending | null = null;
/** Set when the deployment lacks the functions; sync stays off for the page. */
let unavailableForPage = false;

/**
 * Read which account this browser's tabs belong to, before cloud-prefs
 * records the new sign-in. Returns whether tab sync will run, so App can
 * hand the blob's panel keys to tab records from the first moment.
 */
export function prepareTabSyncSignIn(userId: string, enabled: boolean): { willSync: boolean } {
  prepared = null;
  // A direct switch: stop the previous account's session first, so the
  // state it stores (and the tabs it held back) is what this sign-in reads.
  if (session && session.userId !== userId) stopTabSync();
  if (!enabled || unavailableForPage) return { willSync: false };
  // An unreadable key would look like "no previous account" and pick the
  // wrong merge mode; tabs stay local instead.
  const stored = safeStorageGetChecked(META_KEY);
  if (!stored.ok) return { willSync: false };
  const meta = parseTabSyncMeta(stored.value);
  let previous: string | null;
  let previousSyncKnown: boolean;
  if (meta?.userId) {
    previous = meta.userId;
    previousSyncKnown = true;
  } else {
    const last = safeStorageGetChecked(LAST_SIGNED_IN_AS_KEY);
    if (!last.ok) return { willSync: false };
    previous = last.value;
    previousSyncKnown = false;
  }
  let mode: MergeMode;
  if (previous && previous !== userId) mode = 'account-switch';
  else if (meta?.userId === userId) mode = 'normal';
  else mode = 'first-sync';
  prepared = {
    userId,
    mode,
    previousSyncKnown,
    previousMeta: meta ?? emptyTabSyncMeta(previous),
  };
  return { willSync: true };
}

export function startTabSync(
  userId: string,
  host: TabSyncHost,
  onStopped: (reason: TabSyncStopReason) => void = () => {},
): void {
  stopTabSync();
  if (unavailableForPage) return;
  const pending = prepared?.userId === userId ? prepared : null;
  prepared = null;
  if (!pending) return;
  generation += 1;
  const current: Session = {
    userId,
    generation,
    host,
    onStopped,
    pending,
    meta: null,
    rows: null,
    learned: new Map(),
    deletedUnsynced: new Set(),
    reconnects: 0,
    reconnectTimer: null,
    unsubscribe: null,
    transport: null,
    running: false,
    rerun: false,
    debounce: null,
    interval: null,
    localOnly: new Set(),
    onVisibility: null,
  };
  session = current;
  void connect(current);
}

function isCurrent(s: Session): boolean {
  return session === s && s.generation === generation;
}

/** The deployment has no tab-sync functions: retrying cannot help. */
function isMissingFunction(err: unknown): boolean {
  return err instanceof Error && /Could not find public function/i.test(err.message);
}

function fail(s: Session, reason: TabSyncStopReason, err?: unknown): void {
  if (!isCurrent(s)) return;
  if (reason === 'error' && isMissingFunction(err)) reason = 'unavailable';
  if (reason === 'error' && s.reconnects < RECONNECT_DELAYS_MS.length) {
    if (err) console.warn('[tab-sync] reconnecting:', err instanceof Error ? err.message : err);
    disconnect(s);
    const delay = RECONNECT_DELAYS_MS[s.reconnects]!;
    s.reconnects += 1;
    s.reconnectTimer = setTimeout(() => {
      s.reconnectTimer = null;
      if (isCurrent(s)) void connect(s);
    }, delay);
    return;
  }
  if (reason !== 'wrong-account') unavailableForPage = true;
  if (err) console.warn('[tab-sync] stopped:', err instanceof Error ? err.message : err);
  stopTabSync();
  s.onStopped(reason);
}

/** Drop the subscription and timers; the session itself stays current. */
function disconnect(s: Session): void {
  try { s.unsubscribe?.(); } catch { /* already gone */ }
  s.unsubscribe = null;
  s.transport = null;
  s.rows = null;
  if (s.debounce) clearTimeout(s.debounce);
  s.debounce = null;
  if (s.interval) clearInterval(s.interval);
  s.interval = null;
  if (s.onVisibility && typeof document !== 'undefined') document.removeEventListener('visibilitychange', s.onVisibility);
  s.onVisibility = null;
}

async function connect(s: Session): Promise<void> {
  let transport: TabSyncTransport | 'auth-timeout' | null;
  try {
    transport = await transportFactory(s.userId);
  } catch (err) {
    fail(s, 'error', err);
    return;
  }
  if (!isCurrent(s)) return;
  if (transport === 'auth-timeout') {
    fail(s, 'error', new Error('Convex auth was not ready for this account'));
    return;
  }
  if (!transport) {
    fail(s, 'unavailable');
    return;
  }
  s.transport = transport;
  try {
    s.unsubscribe = transport.subscribe(
      SITE_VARIANT,
      (rows) => {
        if (!isCurrent(s)) return;
        s.rows = rows;
        void runPass(s);
      },
      (err) => fail(s, 'error', err),
    );
  } catch (err) {
    fail(s, 'error', err);
    return;
  }
  if (typeof document !== 'undefined') {
    s.onVisibility = () => {
      if (document.visibilityState === 'hidden') void runPass(s);
    };
    document.addEventListener('visibilitychange', s.onVisibility);
  }
  s.interval = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') void runPass(s);
  }, ACTIVE_CHECK_INTERVAL_MS);
}

export function stopTabSync(): void {
  const s = session;
  session = null;
  generation += 1;
  if (!s) return;
  disconnect(s);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.meta) saveTabSyncMeta({ ...s.meta, heldBack: unpushedTabs(s, s.meta) });
}

/**
 * Tabs holding this account's work that never reached it: new since the
 * last push, or edited. An account switch leaves them out of the next
 * account, where tabs made later (while signed out) still go.
 */
function unpushedTabs(s: Session, meta: TabSyncMeta): string[] {
  let local: TabsState | null;
  try {
    local = s.host.captureTabs();
  } catch {
    return [];
  }
  if (!local) return [];
  return local.tabs
    .filter((t) => {
      const base = meta.base[t.id];
      return !base || base.hash !== hashTabRecord(captureTabRecord(t, meta.carried[t.id]));
    })
    .map((t) => t.id);
}

/** Test seam: forget page-level state between cases. */
export function __resetTabSyncForTests(): void {
  stopTabSync();
  prepared = null;
  unavailableForPage = false;
}

export function isTabSyncActive(): boolean {
  return session !== null;
}

/** A tab changed on this device. Edits are found by hash; this only shortens the wait. */
export function notifyTabsChangedLocally(): void {
  const s = session;
  if (!s) return;
  if (s.debounce) clearTimeout(s.debounce);
  s.debounce = setTimeout(() => {
    s.debounce = null;
    void runPass(s);
  }, PUSH_DEBOUNCE_MS);
}

/**
 * The user deleted a tab on this device. Only an explicit delete reaches
 * other devices; a tab that just goes missing from storage is restored.
 */
export function recordTabDeleted(tabId: string): void {
  // Recorded even while signed out: the delete reaches the account that
  // synced the tab at its next sign-in. A tab never synced has nothing to delete.
  const s = session;
  const meta = s?.meta ?? loadTabSyncMeta();
  if (!meta) return;
  if (!meta.base[tabId]) {
    // Its first push may be on the way; settle turns that into a delete.
    s?.deletedUnsynced.add(tabId);
    return;
  }
  if (!meta.tombstones.includes(tabId)) meta.tombstones.push(tabId);
  saveTabSyncMeta(meta);
  notifyTabsChangedLocally();
}

function metaForPass(s: Session): TabSyncMeta {
  if (s.pending?.mode === 'account-switch') return s.pending.previousMeta;
  if (s.meta) return s.meta;
  const stored = loadTabSyncMeta();
  return stored && stored.userId === s.userId ? stored : emptyTabSyncMeta(s.userId);
}

/** The subscription's rows with this session's newer writes laid over. */
function currentRows(s: Session): DashboardTabRow[] {
  const byId = new Map((s.rows ?? []).map((r) => [r.tabId, r]));
  for (const [id, row] of s.learned) {
    const shown = byId.get(id);
    if (shown && shown.version >= row.version) s.learned.delete(id);
    else byId.set(id, row);
  }
  return [...byId.values()];
}

function learn(s: Session, row: DashboardTabRow): void {
  const known = s.learned.get(row.tabId);
  if (!known || known.version < row.version) s.learned.set(row.tabId, row);
}

async function runPass(s: Session): Promise<void> {
  if (!isCurrent(s) || !s.rows || !s.transport) return;
  if (s.running) {
    s.rerun = true;
    return;
  }
  s.running = true;
  try {
    await passOnce(s, true);
  } catch (err) {
    fail(s, 'error', err);
  } finally {
    s.running = false;
  }
  if (isCurrent(s) && s.rerun) {
    s.rerun = false;
    void runPass(s);
  }
}

async function passOnce(s: Session, mayRetry: boolean): Promise<void> {
  const local = s.host.captureTabs();
  if (!local) return;
  const pending = s.pending;
  const result = mergeTabs({
    local,
    meta: metaForPass(s),
    rows: currentRows(s),
    currentPanelSettings: s.host.currentPanelSettings(),
    defaultName: s.host.defaultTabName(),
    defaultPanelOrder: s.host.defaultPanelOrder(),
    mode: pending?.mode ?? 'normal',
    newTabId: () => s.host.newTabId(),
    userId: s.userId,
    previousSyncKnown: pending?.previousSyncKnown ?? true,
    localOnly: s.localOnly,
  });
  s.pending = null;
  const meta = { ...result.meta, userId: s.userId };
  s.meta = meta;
  if (result.changed) {
    s.host.applyTabs(result.state, result.activeChanged);
    if (result.activeChanged) rebaseAppliedActiveTab(s, meta, result.changes);
  }
  saveTabSyncMeta(meta);
  if (result.changes.length === 0) return;

  let conflicts = 0;
  for (let i = 0; i < result.changes.length; i += MAX_DASHBOARD_TAB_CHANGES_PER_CALL) {
    const chunk = result.changes.slice(i, i + MAX_DASHBOARD_TAB_CHANGES_PER_CALL);
    const outcome = await s.transport!.sync({
      variant: SITE_VARIANT,
      expectedUserId: s.userId,
      changes: chunk.map((c) => c.change),
    });
    if (!isCurrent(s)) return;
    if (!outcome.ok) {
      if (outcome.reason === 'WRONG_ACCOUNT') fail(s, 'wrong-account');
      // RATE_LIMITED: the edits are still unsynced by hash; the next tick resends them.
      return;
    }
    conflicts += settle(s, chunk, outcome.results);
  }

  if (conflicts > 0 && mayRetry) await passOnce(s, false);
}

/**
 * The layout places some panels itself, so the active tab can read back in a
 * different order (or with defaults for panels the record lacks) than the
 * record it just applied. That reading is this device's view of the same
 * record: store it as the base, or the next pass pushes it back, and two
 * devices that place panels differently would bounce it between them.
 */
function rebaseAppliedActiveTab(s: Session, meta: TabSyncMeta, changes: readonly PendingTabChange[]): void {
  const shown = s.host.captureTabs();
  const active = shown?.tabs.find((t) => t.id === shown.activeTabId);
  if (!active) return;
  const base = meta.base[active.id];
  // A tab with an edit on its way keeps the base the push will settle.
  if (!base || changes.some((c) => c.change.tabId === active.id)) return;
  meta.base[active.id] = { version: base.version, hash: hashTabRecord(captureTabRecord(active, meta.carried[active.id])) };
}

/** Record what the server accepted. Returns how many changes conflicted. */
function settle(
  s: Session,
  chunk: PendingTabChange[],
  results: Extract<SyncDashboardTabsResult, { ok: true }>['results'],
): number {
  const meta = s.meta ?? emptyTabSyncMeta(s.userId);
  s.meta = meta;
  const byId = new Map(chunk.map((c) => [c.change.tabId, c]));
  const now = Date.now();
  let conflicts = 0;
  for (const result of results) {
    const pending = byId.get(result.tabId);
    if (!pending) continue;
    if (result.ok) {
      const { record } = pending.change;
      if (record === null) {
        delete meta.base[result.tabId];
        delete meta.carried[result.tabId];
        meta.tombstones = meta.tombstones.filter((id) => id !== result.tabId);
        if (result.version > 0) learn(s, { tabId: result.tabId, version: result.version, deleted: true, createdAt: now, updatedAt: now });
      } else if (pending.hash) {
        meta.base[result.tabId] = { version: result.version, hash: pending.hash };
        learn(s, { tabId: result.tabId, version: result.version, deleted: false, record, createdAt: now, updatedAt: now });
        if (s.deletedUnsynced.delete(result.tabId) && !meta.tombstones.includes(result.tabId)) {
          meta.tombstones.push(result.tabId);
          notifyTabsChangedLocally();
        }
      }
    } else if (result.reason === 'CONFLICT') {
      conflicts += 1;
      if (result.row) learn(s, result.row);
    } else {
      s.localOnly.add(result.tabId);
    }
  }
  saveTabSyncMeta(meta);
  return conflicts;
}
