import type { PanelConfig } from '@/types';
import { SITE_VARIANT } from '@/config/variant';
import { getConvexApi, getConvexClient, waitForConvexAuthForUser } from '@/services/convex-client';
import type { TabsState } from '@/services/tab-store';
import { safeStorageGetChecked, safeStorageSet, safeStorageSetChecked } from '@/utils/safe-storage';
import {
  MAX_DASHBOARD_TAB_CHANGES_PER_CALL,
  type DashboardTabChange,
  type DashboardTabRecord,
  type DashboardTabRow,
  type SyncDashboardTabsResult,
} from '../../shared/dashboard-tab-sync';
import {
  captureTabRecord,
  emptyHeldTabs,
  emptyTabSyncMeta,
  hashTabRecord,
  applyTabRecord,
  mergeTabs,
  type HeldTabs,
  type MergeMode,
  type PendingTabChange,
  type SentWrite,
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
  /**
   * Store and show a merged state; re-apply the active tab when
   * `activeChanged`. Returns false when the tabs could not be stored.
   */
  applyTabs(next: TabsState, activeChanged: boolean): boolean | void;
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
// Per account: tabs an account switch took off this device before they
// reached that account. They come back at its next sign-in.
const HELD_KEY = `worldmonitor-tabs-held-v1:${SITE_VARIANT}`;
const MAX_HELD_TABS = 50;
const MAX_HELD_ACCOUNTS = 5;
// The account signed in on this device now, written at sign-in and cleared at
// sign-out. When the next sign-in finds another account here, that account
// left without tab sync seeing it go.
const SIGNED_IN_KEY = `worldmonitor-tabs-signed-in-v1:${SITE_VARIANT}`;
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
    const sent = parseSent(parsed.sent);
    const foreign: Record<string, string> = {};
    if (isRecord(parsed.foreign)) {
      for (const [id, owner] of Object.entries(parsed.foreign)) if (typeof owner === 'string') foreign[id] = owner;
    }
    return {
      userId, base, tombstones, carried,
      ...(heldBack.length > 0 ? { heldBack } : {}),
      ...(parsed.signedOut === true ? { signedOut: true } : {}),
      ...(Object.keys(sent).length > 0 ? { sent } : {}),
      ...(Object.keys(foreign).length > 0 ? { foreign } : {}),
    };
  } catch {
    return null;
  }
}

function parseSent(value: unknown): Record<string, SentWrite> {
  const sent: Record<string, SentWrite> = {};
  if (isRecord(value)) {
    for (const [id, entry] of Object.entries(value)) {
      if (isRecord(entry) && Number.isInteger(entry.version) && typeof entry.hash === 'string') {
        sent[id] = { version: entry.version as number, hash: entry.hash };
      }
    }
  }
  return sent;
}

function saveTabSyncMeta(meta: TabSyncMeta): boolean {
  return safeStorageSetChecked(META_KEY, JSON.stringify(meta));
}

/**
 * Held tabs as stored: each tab's record (what the server would hold, a few
 * hundred bytes) and its sync base, plus deletes that never reached the
 * account. A held tab is rebuilt from its record when it comes back.
 */
interface StoredHeld {
  records: Array<{ id: string; record: DashboardTabRecord }>;
  base: TabSyncMeta['base'];
  tombstones: string[];
  sent: Record<string, SentWrite>;
}

/** The held store; null when it exists but cannot be read, so no write replaces it. */
function loadHeld(): Record<string, StoredHeld> | null {
  const read = safeStorageGetChecked(HELD_KEY);
  if (!read.ok) return null;
  const raw = read.value;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const out: Record<string, StoredHeld> = {};
    for (const [userId, entry] of Object.entries(parsed)) {
      if (!isRecord(entry)) continue;
      const records = (Array.isArray(entry.records) ? entry.records : []).filter((r): r is StoredHeld['records'][number] =>
        isRecord(r) && typeof r.id === 'string' && isRecord(r.record)
        && typeof r.record.name === 'string' && Array.isArray(r.record.panels));
      const tombstones = Array.isArray(entry.tombstones)
        ? entry.tombstones.filter((id): id is string => typeof id === 'string')
        : [];
      if (records.length === 0 && tombstones.length === 0) continue;
      const base = parseTabSyncMeta(JSON.stringify({ base: entry.base }))?.base ?? {};
      out[userId] = { records, base, tombstones, sent: parseSent(entry.sent) };
    }
    return out;
  } catch {
    return null;
  }
}

function saveHeld(held: Record<string, StoredHeld>): boolean {
  return safeStorageSetChecked(HELD_KEY, JSON.stringify(held));
}

const pick = <T>(map: Record<string, T>, keep: ReadonlySet<string>): Record<string, T> =>
  Object.fromEntries(Object.entries(map).filter(([id]) => keep.has(id)));

/**
 * Keep accounts' held tabs and deletes, replacing older copies, in one
 * write. Returns false when they could not all be stored: the caller must
 * then keep them on the device.
 */
function holdTabs(add: Record<string, HeldTabs>): boolean {
  const all = loadHeld();
  if (!all) return false;
  for (const [userId, held] of Object.entries(add)) {
    const prev = all[userId] ?? { records: [], base: {}, tombstones: [], sent: {} };
    const records = held.tabs.map((t) => ({ id: t.id, record: captureTabRecord(t, held.carried[t.id]) }));
    const fresh = new Set([...records.map((r) => r.id), ...held.tombstones]);
    const merged = [...prev.records.filter((r) => !fresh.has(r.id)), ...records];
    // Dropping one would lose it: refuse the whole hold instead.
    if (merged.length > MAX_HELD_TABS) return false;
    const tombstones = [...prev.tombstones.filter((id) => !fresh.has(id)), ...held.tombstones];
    const keep = new Set([...merged.map((r) => r.id), ...tombstones]);
    delete all[userId];
    all[userId] = {
      records: merged,
      base: pick({ ...prev.base, ...held.base }, keep),
      tombstones,
      sent: pick({ ...prev.sent, ...held.sent }, keep),
    };
  }
  // The accounts held for longest go first.
  for (const key of Object.keys(all).slice(0, Math.max(0, Object.keys(all).length - MAX_HELD_ACCOUNTS))) delete all[key];
  return saveHeld(all);
}

/** Forget held tabs and deletes the device now holds itself. */
function releaseHeld(userId: string, ids: Iterable<string>): void {
  const gone = new Set(ids);
  const all = loadHeld();
  const entry = all?.[userId];
  if (!all || !entry || gone.size === 0) return;
  const records = entry.records.filter((r) => !gone.has(r.id));
  const tombstones = entry.tombstones.filter((id) => !gone.has(id));
  if (records.length === 0 && tombstones.length === 0) delete all[userId];
  else {
    const keep = new Set([...records.map((r) => r.id), ...tombstones]);
    all[userId] = { records, base: pick(entry.base, keep), tombstones, sent: pick(entry.sent, keep) };
  }
  saveHeld(all);
}

/** Rebuild held tabs for the merge from their records. */
function heldForMerge(stored: StoredHeld, currentPanelSettings: Record<string, PanelConfig>): HeldTabs {
  const held = emptyHeldTabs();
  for (const { id, record } of stored.records) {
    const { tab, carried } = applyTabRecord(undefined, record, currentPanelSettings, id);
    held.tabs.push(tab);
    if (carried.length > 0) held.carried[id] = carried;
  }
  held.base = { ...stored.base };
  held.sent = { ...stored.sent };
  held.tombstones = [...stored.tombstones];
  return held;
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
  /** This account's tabs an earlier switch held, to put back. */
  restore: StoredHeld | null;
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
  /**
   * Tabs a conflict reported the server has no row for, with the creation
   * time of the row the subscription still shows. That row is hidden until
   * the subscription shows a different one (a recreation gets a new time).
   */
  absent: Map<string, number>;
  /** Held tabs put back this session whose held copy is not yet released. */
  unreleased: Set<string>;
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
/** An account that left before its tabs could be read; recorded at the first pass. */
let departure: string | null = null;

/**
 * Read which account this browser's tabs belong to, before cloud-prefs
 * records the new sign-in. Returns whether tab sync will run, so App can
 * hand the blob's panel keys to tab records from the first moment.
 */
export function prepareTabSyncSignIn(userId: string, enabled: boolean, host?: TabSyncHost): { willSync: boolean } {
  prepared = null;
  // A direct switch: stop the previous account's session first, so the
  // state it stores (and the tabs it held back) is what this sign-in reads.
  if (session && session.userId !== userId) stopTabSync();
  // An unreadable key would look like "no previous account" and pick the
  // wrong merge mode; tabs stay local instead.
  const signedIn = safeStorageGetChecked(SIGNED_IN_KEY);
  if (!signedIn.ok) return { willSync: false };
  // Before the layout has its tabs the departure cannot be read; the first
  // pass records it, and the stored account changes only once it is.
  departure = null;
  if (signedIn.value && signedIn.value !== userId && !recordDeparture(signedIn.value, host)) departure = signedIn.value;
  else safeStorageSet(SIGNED_IN_KEY, userId);
  const stored = safeStorageGetChecked(META_KEY);
  if (!stored.ok) return { willSync: false };
  const meta = parseTabSyncMeta(stored.value);
  if (meta?.userId === userId && (meta.signedOut || meta.heldBack)) {
    // This account is back: the marks from its last sign-out no longer
    // describe this device, whether or not sync runs this time.
    delete meta.signedOut;
    delete meta.heldBack;
    saveTabSyncMeta(meta);
  }
  if (!enabled || unavailableForPage) return { willSync: false };
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
    previousMeta: meta?.userId ? meta : { ...emptyTabSyncMeta(previous), ...(meta?.foreign ? { foreign: meta.foreign } : {}) },
    restore: loadHeld()?.[userId] ?? null,
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
    absent: new Map(),
    unreleased: new Set(),
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
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
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
  return unpushedOf(s.host, meta);
}

function unpushedOf(host: TabSyncHost, meta: TabSyncMeta): string[] {
  let local: TabsState | null;
  try {
    local = host.captureTabs();
  } catch {
    return [];
  }
  return local ? unpushedIn(local, meta) : [];
}

function unpushedIn(local: TabsState, meta: TabSyncMeta): string[] {
  return local.tabs
    .filter((t) => {
      const base = meta.base[t.id];
      return !base || base.hash !== hashTabRecord(captureTabRecord(t, meta.carried[t.id]));
    })
    .map((t) => t.id);
}

/**
 * `leaver` signed in here and is gone. Its work that never reached its
 * account is marked as its own, so a later sign-in holds it for it:
 * - when the stored state is the leaver's, as `heldBack` (unless it signed
 *   out, which wrote that already);
 * - otherwise (its sync never finished a pass), in `foreign`, leaving the
 *   work the state's own account left behind (`heldBack`) to that account.
 * Returns false when the tabs could not be read, so the caller tries again.
 */
function recordDeparture(leaver: string, host: TabSyncHost | undefined): boolean {
  if (!host) return false;
  const read = safeStorageGetChecked(META_KEY);
  if (!read.ok) return false;
  let local: TabsState | null;
  try {
    local = host.captureTabs();
  } catch {
    local = null;
  }
  if (!local) return false;
  const meta = parseTabSyncMeta(read.value) ?? emptyTabSyncMeta(null);
  const foreign = { ...(meta.foreign ?? {}) };
  const unpushed = unpushedIn(local, meta).filter((id) => !foreign[id]);
  if (meta.userId === leaver) {
    if (meta.signedOut) return true;
    meta.heldBack = unpushed;
    saveTabSyncMeta(meta);
    return true;
  }
  const theirs = new Set(meta.heldBack ?? []);
  let marked = false;
  for (const id of unpushed) {
    if (theirs.has(id)) continue;
    foreign[id] = leaver;
    marked = true;
  }
  if (!marked) return true;
  meta.foreign = foreign;
  saveTabSyncMeta(meta);
  return true;
}

/**
 * The account signed out. Stops sync and marks the stored state, so tabs
 * made or edited from now on go to whichever account signs in next, while
 * this account's unpushed work stays held for it.
 */
export function signOutTabSync(host: TabSyncHost, userId?: string | null): void {
  const running = session !== null && session.meta !== null;
  stopTabSync();
  // An earlier account's departure still waiting for the tabs: record it now.
  if (departure && departure !== userId && recordDeparture(departure, host)) departure = null;
  const signedIn = safeStorageGetChecked(SIGNED_IN_KEY);
  const leaver = userId ?? (signedIn.ok ? signedIn.value : null);
  if (signedIn.ok && signedIn.value) safeStorageSet(SIGNED_IN_KEY, '');
  const meta = loadTabSyncMeta();
  if (leaver && meta?.userId !== leaver) {
    recordDeparture(leaver, host);
    return;
  }
  if (!meta?.userId) return;
  if (!running) meta.heldBack = unpushedOf(host, meta);
  meta.signedOut = true;
  saveTabSyncMeta(meta);
}

/** Test seam: forget page-level state between cases. */
export function __resetTabSyncForTests(): void {
  stopTabSync();
  prepared = null;
  unavailableForPage = false;
  departure = null;
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
  // Never written to the server: nothing to delete. A write still
  // unanswered (`sent`) may have landed; the merge deletes it if so.
  if (!meta.base[tabId] && !meta.sent?.[tabId]) return;
  if (!meta.tombstones.includes(tabId)) meta.tombstones.push(tabId);
  saveTabSyncMeta(meta);
  notifyTabsChangedLocally();
}

function metaForPass(s: Session): TabSyncMeta {
  if (s.pending?.mode === 'account-switch') return s.pending.previousMeta;
  if (s.meta) return s.meta;
  const stored = loadTabSyncMeta();
  if (stored && stored.userId === s.userId) return stored;
  // Another account's state (or none): only its marks of whose tabs are whose carry over.
  return { ...emptyTabSyncMeta(s.userId), ...(stored?.foreign ? { foreign: stored.foreign } : {}) };
}

/** The subscription's rows with this session's newer writes laid over. */
function currentRows(s: Session): DashboardTabRow[] {
  const byId = new Map((s.rows ?? []).map((r) => [r.tabId, r]));
  for (const [id, staleCreatedAt] of s.absent) {
    const shown = byId.get(id);
    if (shown && shown.createdAt === staleCreatedAt) byId.delete(id);
    else s.absent.delete(id);
  }
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
    if (isCurrent(s)) s.reconnects = 0;
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
  if (departure && departure !== s.userId) {
    if (!recordDeparture(departure, s.host)) return;
    departure = null;
    safeStorageSet(SIGNED_IN_KEY, s.userId);
    // The switch was prepared before the marks existed.
    if (s.pending) {
      const marked = loadTabSyncMeta();
      s.pending.previousMeta = { ...s.pending.previousMeta, ...(marked?.foreign ? { foreign: marked.foreign } : {}) };
      if (s.pending.previousMeta.userId === marked?.userId && marked?.heldBack) s.pending.previousMeta.heldBack = marked.heldBack;
    }
  }
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
    restore: pending?.restore ? heldForMerge(pending.restore, s.host.currentPanelSettings()) : null,
  });
  // Store held tabs before the layout drops them. If they cannot be stored,
  // nothing is applied or pushed: they stay on the device.
  if (result.held && !holdTabs(result.held)) {
    throw new Error("could not keep another account's tabs on this device");
  }
  s.pending = null;
  for (const id of [...result.restored, ...result.heldPresent]) s.unreleased.add(id);
  const meta = { ...result.meta, userId: s.userId };
  s.meta = meta;
  let stored = true;
  if (result.changed) {
    stored = s.host.applyTabs(result.state, result.activeChanged) !== false;
    if (result.activeChanged) rebaseAppliedActiveTab(s, meta, result.changes);
  }
  // A write can land with its answer lost (the session stops first); note
  // the version it would give each tab that has no base yet.
  for (const { change, hash } of result.changes) {
    if (change.record && hash && !meta.base[change.tabId]) {
      (meta.sent ??= {})[change.tabId] = { version: (change.baseVersion ?? 0) + 1, hash };
    }
  }
  // Put-back tabs leave the held store once this pass stored them here;
  // otherwise once the server holds them.
  if (saveTabSyncMeta(meta) && stored && result.changed) releaseRestored(s, null, result.restored);
  if (result.changes.length === 0) {
    releaseRestored(s, meta);
    return;
  }

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
  releaseRestored(s, s.meta);

  if (conflicts > 0 && mayRetry) await passOnce(s, false);
}

/**
 * Release put-back tabs from the held store: `only` (just stored on this
 * device), or, with `synced`, those the server now holds as on screen and
 * the deletes that reached it.
 */
function releaseRestored(s: Session, synced: TabSyncMeta | null, only?: readonly string[]): void {
  if (s.unreleased.size === 0) return;
  let ids = only ? only.filter((id) => s.unreleased.has(id)) : [...s.unreleased];
  if (synced) {
    const local = s.host.captureTabs();
    const byId = new Map((local?.tabs ?? []).map((t) => [t.id, t]));
    ids = ids.filter((id) => {
      const tab = byId.get(id);
      const base = synced.base[id];
      if (!tab) return !synced.tombstones.includes(id) && !base;
      return !!base && base.hash === hashTabRecord(captureTabRecord(tab, synced.carried[id]));
    });
  }
  if (ids.length === 0) return;
  releaseHeld(s.userId, ids);
  for (const id of ids) s.unreleased.delete(id);
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
        if (meta.sent) delete meta.sent[result.tabId];
        if (result.version > 0) learn(s, { tabId: result.tabId, version: result.version, deleted: true, createdAt: now, updatedAt: now });
      } else if (pending.hash) {
        meta.base[result.tabId] = { version: result.version, hash: pending.hash };
        if (meta.sent) delete meta.sent[result.tabId];
        learn(s, { tabId: result.tabId, version: result.version, deleted: false, record, createdAt: now, updatedAt: now });
        // Deleted here while this write was on the way: send the delete now.
        if (meta.tombstones.includes(result.tabId)) notifyTabsChangedLocally();
      }
    } else if (result.reason === 'CONFLICT') {
      conflicts += 1;
      if (result.row) learn(s, result.row);
      else {
        s.learned.delete(result.tabId);
        const shown = s.rows?.find((r) => r.tabId === result.tabId);
        if (shown) s.absent.set(result.tabId, shown.createdAt);
      }
    } else {
      s.localOnly.add(result.tabId);
    }
  }
  saveTabSyncMeta(meta);
  return conflicts;
}
