/**
 * Cloud preferences sync service.
 *
 * Syncs CLOUD_SYNC_KEYS to Convex via /api/user-prefs (Vercel edge).
 *
 * Lifecycle hooks:
 *   install(variant)          — call once at startup (patches localStorage.setItem, wires events)
 *   onSignIn(userId, variant) — fetch cloud prefs and merge on sign-in
 *   onSignOut()               — clear sync metadata on sign-out
 *
 * Feature flag: VITE_CLOUD_PREFS_ENABLED=true must be set.
 * Desktop guard: isDesktopRuntime() always skips sync.
 */

import {
  ACCOUNT_PROVENANCE_SYNC_KEYS,
  CLOUD_SYNC_KEYS,
  resolveCloudBlobKeyAction,
  type CloudSyncKey,
} from './sync-keys';
import { isDesktopRuntime } from '@/services/runtime';
import { getClerkToken } from '@/services/clerk';
import {
  computeLegacyDefaultDisabledSources,
  computePreStrategicDefaultDisabledSources,
  CANADA_ARCTIC_OPT_IN_SOURCES,
  CANADA_DEPTH_OPT_IN_SOURCES,
  CRISIS_FLOOR_OPT_IN_SOURCES,
  CURATED_REGIONAL_OPT_IN_SOURCES,
  FEEDS,
  FRONTLINE_EUROPE_PROTECTED_SOURCES,
  getStrategicDefaultSources,
  INTEL_SOURCES,
} from '@/config/feeds';
import { FREE_MAX_SOURCES } from '@/config/panels';
import { computeCapDisabledSources } from '@/services/source-cap';
import {
  buildPreStrategicDefaultDisabledStates,
  buildRegionalFeedRolloutMigrationTargets,
} from '@/services/regional-feed-rollout';
import {
  applyMigrationChainWithSchemaVersion,
  buildMigrations,
  isRegionalFeedRolloutMigrationAmbiguous,
  mergeCloudWithLocalDirty,
  parsePersistedDirtyKeys,
  settledDirtyKeys,
  unionPersistedDirtyKeys,
  withoutPersistedDirtyKeys,
} from './cloud-prefs-migrations';
import {
  isTemporaryCloudPrefsStatus,
  parseRetryAfterSeconds,
  rearmTemporaryCloudPrefsRetry,
} from './cloud-prefs-retry';
import { applyObservableCloudPrefsFlushSuccess } from './cloud-prefs-flush';
import { SerializedAsyncQueue } from './serialized-async-queue';
import { TimeoutError, withTimeout } from './with-timeout';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import {
  safeStorageGet,
  safeStorageGetChecked,
  safeStorageRemove,
  safeStorageRemoveChecked,
  safeStorageSet,
  safeStorageSetChecked,
} from '@/utils/safe-storage';

export { isTemporaryCloudPrefsStatus, parseRetryAfterSeconds } from './cloud-prefs-retry';


const ENABLED = import.meta.env.VITE_CLOUD_PREFS_ENABLED === 'true';
export const CLOUD_PREFS_APPLIED_EVENT = 'wm:cloud-prefs-applied';
export const CLOUD_PREFS_SIGN_IN_TERMINAL_EVENT = 'wm:cloud-prefs-sign-in-terminal';

export interface CloudPrefsAppliedDetail {
  keys: CloudSyncKey[];
  syncVersion?: number;
}

export interface CloudPrefsSignInTerminalDetail {
  accountId: string;
  authGeneration: number;
  handoffGeneration: number;
  origin: 'sign-in';
  outcome: 'synced' | 'error' | 'skipped';
}

export interface CloudPrefsSignInOptions {
  handoffGeneration?: number;
}

// localStorage state keys — never uploaded to cloud
const KEY_SYNC_VERSION = 'wm-cloud-sync-version';
const KEY_LAST_SYNC_AT = 'wm-last-sync-at';
const KEY_SYNC_STATE = 'wm-cloud-sync-state';
const KEY_LAST_SIGNED_IN_AS = 'wm-last-signed-in-as';
const KEY_DIRTY_KEYS = 'wm-cloud-prefs-dirty-keys';
// Tracks the schema version of the LOCAL blob (i.e. what's in localStorage
// right now). Distinct from the cloud row's schemaVersion. Required because
// uploads can post local data without first fetching cloud (uploadNow,
// post-conflict retry, onSignIn else-branch when local is at-or-ahead of
// cloud). Without local tracking, those post sites would stamp the new
// schemaVersion onto unmigrated local data — cementing the poisoning at
// the new schema version. Defaults to 1 when missing (assumes oldest).
const KEY_LOCAL_SCHEMA_VERSION = 'wm-cloud-prefs-local-schema-version';

const CURRENT_PREFS_SCHEMA_VERSION = 9;
const CLOUD_PREFS_REQUEST_TIMEOUT_MS = 15_000;

// Migrations live in cloud-prefs-migrations.ts to keep them testable —
// cloud-prefs-sync.ts has a transitive `import.meta.env.DEV` dep via
// `@/services/clerk` → `proxy.ts` that breaks outside a Vite build. The
// migrations module is dependency-light and importable from node:test.
//
// Schema 2 (2026-05-01): one-shot recovery for the v1 free-tier source-cap
// bug. The pre-PR-3521 alphabetical-slice cap auto-disabled every source
// past position 80 alphabetically, leaving entire late-alphabet categories
// (Layoffs, Semiconductors, IPO, Funding, Product Hunt, …) with 100% of
// their feeds in `disabledFeeds`. PR #3521 added a per-origin localStorage
// migration to recover this, but cloud-prefs sync re-poisoned origins
// every load by overwriting localStorage with the still-bad cloud blob —
// the recovery had to live at the cloud-data layer to be permanent.
//
// This migration runs ONCE per cloud row (gated by schemaVersion < 2),
// detects categories where 100% of sources are in `disabledFeeds`, and
// re-enables them. After the migration completes, schemaVersion bumps to
// 2 and subsequent sync pulls skip recovery — so a user who explicitly
// disables every source in a category POST-migration keeps that
// preference forever.
// Schema 3 (#5963): recover the frontline sources from an untouched legacy
// default blob. The exact-set guard preserves customized source preferences
// and prevents a stale cloud row from re-poisoning a local migration.
// Schema 4 (#6000): re-enable strategic defaults from an untouched pre-flag
// default/cap blob. The same exact-set guard preserves customized preferences.
// Schema 5 (#5975/#5976/#5977/#5980): reconcile regional rollout defaults and
// opt-ins only for exact untouched default/cap states across known locales.
// Schema 6 (#5960): add the Canada/Arctic companion opt-ins to non-empty
// denylist profiles without depending on the ambiguous schema-5 decision.
// Schema 7 (#6604/#6605): add the Canada depth opt-ins the same way.
// Schema 6 already ran; a new App.ts key alone is not enough.
// Schema 8 (#6813-#6830): add the validated crisis-desk opt-in companions.
// Schema 9 (#7748): keep the new curated regional desks opt-in for returners.
let _migrations: ReturnType<typeof buildMigrations> | null = null;
let _regionalRolloutTargets: ReturnType<typeof buildRegionalFeedRolloutMigrationTargets> | null = null;

function getRegionalRolloutTargets(): ReturnType<typeof buildRegionalFeedRolloutMigrationTargets> {
  _regionalRolloutTargets ??= buildRegionalFeedRolloutMigrationTargets(FREE_MAX_SOURCES);
  return _regionalRolloutTargets;
}

function getMigrations(): ReturnType<typeof buildMigrations> {
  if (_migrations) return _migrations;
  const legacyPreStrategicDefaultDisabled = new Set(
    computePreStrategicDefaultDisabledSources(),
  );
  const legacyPreStrategicCapDisabled = computeCapDisabledSources(
    FEEDS,
    INTEL_SOURCES,
    legacyPreStrategicDefaultDisabled,
    FREE_MAX_SOURCES,
  );
  _migrations = buildMigrations(FEEDS, {
    frontline: {
      legacyDefaultDisabled: new Set(computeLegacyDefaultDisabledSources()),
      names: new Set(FRONTLINE_EUROPE_PROTECTED_SOURCES),
      legacyCapDisabled: legacyPreStrategicCapDisabled,
    },
    strategic: {
      names: getStrategicDefaultSources(),
      legacyDisabledStates: buildPreStrategicDefaultDisabledStates(FREE_MAX_SOURCES),
    },
    regionalRollout: {
      targets: getRegionalRolloutTargets(),
    },
    canadaArctic: {
      optInSources: CANADA_ARCTIC_OPT_IN_SOURCES,
    },
    canadaDepth: {
      optInSources: CANADA_DEPTH_OPT_IN_SOURCES,
    },
    crisisDesk: {
      optInSources: CRISIS_FLOOR_OPT_IN_SOURCES,
    },
    curatedRegional: {
      optInSources: CURATED_REGIONAL_OPT_IN_SOURCES,
    },
  });
  return _migrations;
}

type SyncState = 'synced' | 'pending' | 'syncing' | 'conflict' | 'offline' | 'signed-out' | 'error';

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _currentVariant = 'full';
let _installed = false;
let _suppressPatch = false; // prevents applyCloudBlob from re-triggering upload
let _cachedToken: string | null = null; // synchronous token cache for flush()

// Sync keys the user has mutated locally since the last clean upload. On a
// 409 CONFLICT we must NOT overwrite these with the cloud blob — they are
// the edits the user just made (e.g. a watchlist typed seconds ago). The
// install() setItem/removeItem patch records them; a clean upload clears the
// SETTLED ones. See resolveConflictWithMerge + mergeCloudWithLocalDirty.
const _dirtyKeys = new Set<CloudSyncKey>();
let _dirtyKeysUserId: string | null = null;
// Whether the persisted dirty-key sidecar was successfully READ this session.
// An empty in-memory set means 'nothing pending' only when this is true.
let _dirtyKeysHydrated = false;

/**
 * #4746: persistDirtyKeys used to serialize only THIS tab's in-memory set,
 * so two same-user tabs writing different keys clobbered each other's
 * pending markers (last writer wins on the single shared
 * KEY_DIRTY_KEYS entry). The write is now split per call-site semantics:
 *
 *   add    (markDirtyKey)          -> union with the persisted set
 *   settle (clearSettledDirtyKeys) -> targeted remove of the settled keys
 *   reset  (hydrate cleanup,
 *           sign-out)              -> overwrite / remove (persistDirtyKeys)
 *
 * The naive "always union" fix is wrong on purpose: re-reading the disk set
 * inside clearSettledDirtyKeys would resurrect keys the upload just settled
 * (the stale-dirty-key regression class from #3695), so settle removes only
 * what this tab's upload actually durably synced.
 */
function writePersistedDirtyKeys(payload: { userId: string; keys: string[] }): void {
  if (payload.keys.length === 0) {
    safeStorageRemove(KEY_DIRTY_KEYS);
    return;
  }
  safeStorageSet(KEY_DIRTY_KEYS, JSON.stringify(payload));
}

function persistDirtyKeyAddition(key: CloudSyncKey): void {
  if (!_dirtyKeysUserId) return;
  try {
    // Read-modify-write over a sidecar SHARED with other tabs. A read that
    // degrades to null makes the union treat the persisted set as empty, so the
    // write replaces another tab's durable markers with just this key and its
    // unsynced edits become overwritable. Abandon the update instead — the
    // in-memory set still guards this page view (#7833 review).
    const existing = safeStorageGetChecked(KEY_DIRTY_KEYS);
    if (!existing.ok) return;
    writePersistedDirtyKeys(unionPersistedDirtyKeys(
      existing.value,
      CLOUD_SYNC_KEYS,
      _dirtyKeysUserId,
      [key],
    ));
  } catch {
    // localStorage unavailable: keep the in-memory guard for this page view.
  }
}

function persistSettledDirtyKeyRemovals(removals: string[]): void {
  if (!_dirtyKeysUserId) return;
  try {
    // Same shared-sidecar hazard as the addition path: a failed read here would
    // settle the set down to empty, dropping another tab's pending markers.
    const existing = safeStorageGetChecked(KEY_DIRTY_KEYS);
    if (!existing.ok) return;
    writePersistedDirtyKeys(withoutPersistedDirtyKeys(
      existing.value,
      CLOUD_SYNC_KEYS,
      _dirtyKeysUserId,
      removals,
    ));
  } catch {
    // localStorage unavailable: keep the in-memory guard for this page view.
  }
}

function persistDirtyKeys(): void {
  try {
    // Removing on an empty set is only safe when the set is trustworthy — i.e.
    // we actually read the sidecar. Otherwise this deletes markers we never saw.
    if (_dirtyKeys.size === 0 && !_dirtyKeysHydrated) return;
    if (_dirtyKeys.size === 0) {
      safeStorageRemove(KEY_DIRTY_KEYS);
      return;
    }
    if (!_dirtyKeysUserId) return;
    safeStorageSet(KEY_DIRTY_KEYS, JSON.stringify({
      userId: _dirtyKeysUserId,
      keys: [..._dirtyKeys],
    }));
  } catch {
    // localStorage unavailable: keep the in-memory guard for this page view.
  }
}

function hydrateDirtyKeysFromStorage(userId: string): void {
  try {
    _dirtyKeys.clear();
    _dirtyKeysUserId = userId;
    // Not review-reported; found auditing the rest of this class. A failed read
    // degrades to "no persisted markers", and the empty in-memory set is then
    // treated as authoritative — so the sign-out `persistDirtyKeys()` REMOVES
    // the sidecar and another tab's unsynced edits lose their markers.
    const read = safeStorageGetChecked(KEY_DIRTY_KEYS);
    _dirtyKeysHydrated = read.ok;
    const raw = read.value;
    for (const key of parsePersistedDirtyKeys(raw, CLOUD_SYNC_KEYS, userId)) {
      _dirtyKeys.add(key as CloudSyncKey);
    }
    if (raw !== null && _dirtyKeys.size === 0) persistDirtyKeys();
  } catch {
    // localStorage unavailable: the in-memory set remains the best effort.
  }
}

function markDirtyKey(key: CloudSyncKey): void {
  _dirtyKeys.add(key);
  persistDirtyKeyAddition(key);
}

/**
 * Clear dirty keys that a just-succeeded upload actually durably synced —
 * NOT the whole set. A user can mutate another pref *while postCloudPrefs is
 * in flight*: the setItem patch marks it dirty, but it was never in the
 * posted blob. Blanket-clearing would drop that tracking, so a subsequent
 * 409 would see an empty dirty set and mergeCloudWithLocalDirty would let
 * applyCloudBlob clobber the just-made edit — the very bug this set exists
 * to prevent.
 *
 * The "settled" decision is the pure `settledDirtyKeys` (testable without
 * the sync runtime): a key is settled iff the posted value still equals the
 * current local value.
 */
function clearSettledDirtyKeys(postedBlob: Record<string, string>): void {
  const current = buildCloudBlob();
  // A key is settled iff the posted value still equals the CURRENT local value,
  // so a failed re-read cannot answer that. Keeping the keys dirty costs one
  // redundant upload; clearing them on a guess loses the edit.
  if (current === null) return;
  const settled: string[] = [];
  for (const key of settledDirtyKeys(postedBlob, current, _dirtyKeys)) {
    if (_dirtyKeys.delete(key as CloudSyncKey)) settled.push(key);
  }
  if (settled.length > 0) persistSettledDirtyKeyRemovals(settled);
}

// ── 503 retry tracking ───────────────────────────────────────────────────────
//
// _retryTimer holds the single pending 503-retry setTimeout (we cancel and
// re-schedule rather than stacking; only one retry should ever be in flight).
//
// _authGeneration increments on every onSignIn entry and onSignOut so a
// scheduled retry callback can detect "I'm stale, abort." Without this guard,
// a delayed retry from user A could fire after sign-out (calling onSignIn
// with the prior userId but the now-empty Clerk token), or after user B has
// signed in (using B's token but A's userId in the retry closure) — both
// produce a misleading sync attempt and pollute Sentry with confused errors.

let _retryTimer: ReturnType<typeof setTimeout> | null = null;
let _signInRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingSignInRetryGeneration: number | null = null;
let _authGeneration = 0;
const _syncOperations = new SerializedAsyncQueue();
let _activeUploadPromise: Promise<void> | null = null;
let _queuedUploadVariant = 'full';

function clearRetryTimer(): void {
  if (_retryTimer !== null) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
}

function clearSignInRetry(): void {
  if (_signInRetryTimer !== null) {
    clearTimeout(_signInRetryTimer);
    _signInRetryTimer = null;
  }
  _pendingSignInRetryGeneration = null;
}

/**
 * Whether a sign-in sync is waiting on a scheduled 503 retry.
 *
 * `onSignIn`'s promise resolves as soon as the retry is ARMED, not when the
 * cloud blob is finally applied — the catch schedules the timer and returns
 * without awaiting it. A caller that treats that resolution as "the account's
 * preferences have landed" acts on pre-cloud local state (see
 * TierPreferenceHandoff). The 503 branch assigns `_retryTimer` before the
 * queued task returns, so this is already true by the time the promise's
 * `.then` runs.
 */
export function hasPendingCloudPrefsRetry(): boolean {
  return _pendingSignInRetryGeneration === _authGeneration;
}

// ── Guards ────────────────────────────────────────────────────────────────────

function isEnabled(): boolean {
  return ENABLED && !isDesktopRuntime();
}

export function isCloudSyncEnabled(): boolean {
  return isEnabled();
}

// ── State helpers ─────────────────────────────────────────────────────────────

export function getSyncVersion(): number {
  return getSyncVersionChecked() ?? 0;
}

/**
 * The durable sync version, or `null` when it could not be READ.
 *
 * Also not review-reported. Degrading to 0 means "never synced", which decides
 * two things wrongly at once: `cloud.syncVersion > getSyncVersion()` becomes
 * true so the cloud blob is applied OVER local edits, and `isFirstEverSync`
 * becomes true so the undo toast snapshots a "previous" state that is not one.
 */
function getSyncVersionChecked(): number | null {
  const read = safeStorageGetChecked(KEY_SYNC_VERSION);
  if (!read.ok) return null;
  return parseInt(read.value ?? '0', 10) || 0;
}

/**
 * Record the durable sync version. Returns false when a usable store REJECTED
 * the write.
 *
 * The marker is small, so a store that rejects it is nearly full — but the
 * consequence is not cosmetic: callers follow this by settling dirty keys and
 * reporting `synced`, and a stale durable version makes every later upload
 * conflict and every reload re-reconcile. Same contract as applyCloudBlob's,
 * for the same reason (#7833 review).
 */
function setSyncVersion(v: number): boolean {
  // A state key, not a pref key — nothing here should mark the blob dirty.
  return safeStorageSetChecked(KEY_SYNC_VERSION, String(v));
}

function setState(s: SyncState): void {
  safeStorageSet(KEY_SYNC_STATE, s);
}

// ── Blob helpers ──────────────────────────────────────────────────────────────

/**
 * The local values to upload, or `null` when a read failed.
 *
 * The null return is load-bearing. This blob REPLACES the server's, and a key
 * is omitted when its local value is absent — so a read that fails and degrades
 * to `null` is indistinguishable from "the user cleared this", and the upload
 * deletes a preference from the cloud that was only ever unreadable. The raw
 * read here before #7833 threw and aborted the upload; `safeStorageGetChecked`
 * restores that outcome without reintroducing the null-storage crash.
 */
function buildCloudBlob(): Record<string, string> | null {
  const blob: Record<string, string> = {};
  for (const key of CLOUD_SYNC_KEYS) {
    const read = safeStorageGetChecked(key);
    if (!read.ok) return null;
    if (read.value !== null) blob[key] = read.value;
  }
  return blob;
}

function dispatchCloudPrefsApplied(keys: CloudSyncKey[], syncVersion?: number): void {
  if (keys.length === 0 || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<CloudPrefsAppliedDetail>(CLOUD_PREFS_APPLIED_EVENT, {
    detail: { keys, ...(syncVersion === undefined ? {} : { syncVersion }) },
  }));
}

function dispatchCloudPrefsSignInTerminal(
  accountId: string,
  authGeneration: number,
  handoffGeneration: number | undefined,
  outcome: CloudPrefsSignInTerminalDetail['outcome'],
): void {
  if (handoffGeneration === undefined || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<CloudPrefsSignInTerminalDetail>(
    CLOUD_PREFS_SIGN_IN_TERMINAL_EVENT,
    {
      detail: {
        accountId,
        authGeneration,
        handoffGeneration,
        origin: 'sign-in',
        outcome,
      },
    },
  ));
}

/**
 * Returns false when prior-account ownership could not be DETERMINED.
 *
 * Absent legitimately means "no prior account, nothing to clear". A failed read
 * degrading to null is indistinguishable from that, and skipping the cleanup on
 * an account transition leaves account A's ownership sidecars in place for B —
 * so tier reconciliation attributes A's gate decisions to B (#7833 review).
 * Provenance is exactly the kind of question to fail closed on.
 */
function clearForeignOwnershipSidecars(userId: string): boolean {
  const read = safeStorageGetChecked(KEY_LAST_SIGNED_IN_AS);
  if (!read.ok) return false;
  const lastSignedInAs = read.value;
  if (lastSignedInAs === null || lastSignedInAs === userId) return true;

  // Preferences intentionally survive sign-out, but ownership sidecars are
  // account provenance. If the next account has a legacy row that omits them,
  // keeping the prior account's local values attributes A's gate decisions to
  // B. B's explicit cloud values will still be applied later in this attempt.
  for (const key of ACCOUNT_PROVENANCE_SYNC_KEYS) {
    if (!safeStorageRemoveChecked(key)) return false;
  }
  return true;
}

/**
 * Write the cloud blob over local prefs. Returns false when a usable store
 * REJECTED one of the writes.
 *
 * The return value is load-bearing, not decoration. Every caller follows this
 * with `setSyncVersion` / `setLocalSchemaVersion`, and those markers are tiny
 * while the pref values are not — so a `QuotaExceededError` can drop the value
 * and still let the marker land. Local then claims to be at cloud's version
 * while holding stale values, and the next upload posts them back over good
 * cloud data. Before #7833 the raw `setItem` threw and aborted the whole
 * reconciliation, which is the safety this restores.
 *
 * `changedKeys` now records only writes that actually landed, so a consumer of
 * CLOUD_PREFS_APPLIED cannot re-read storage for a key that never changed.
 */
function applyCloudBlob(data: Record<string, unknown>, syncVersion?: number): boolean {
  const changedKeys: CloudSyncKey[] = [];
  let allWritesLanded = true;
  _suppressPatch = true;
  try {
    for (const key of CLOUD_SYNC_KEYS) {
      // An omitted key normally means the user cleared it. A small set of keys
      // instead uses explicit reset values and preserves omission from an old
      // client during rolling deployments. See resolveCloudBlobKeyAction.
      const action = resolveCloudBlobKeyAction(key, data);
      if (action.kind === 'keep') continue;
      // The pre-read decides whether to ANNOUNCE the key, and a failed read
      // degrading to null answers wrongly in both directions: a `set` looks
      // different when it was not, and a `remove` looks absent when it was
      // present — so the deletion lands but is never announced, and consumers
      // keep serving the removed preference until a reload (#7833 review).
      //
      // On an undeterminable pre-read this ANNOUNCES the key rather than
      // aborting, which is a deliberate departure from the suggested fix. The
      // write itself is separately checked, so storage is already correct; a
      // spurious announcement just makes consumers re-read a key that did not
      // change, which is a no-op. Aborting would fail a whole reconciliation
      // over a recoverable read, and announcing self-heals.
      if (action.kind === 'set') {
        const before = safeStorageGetChecked(key);
        const shouldAnnounce = !before.ok || before.value !== action.value;
        if (safeStorageSetChecked(key, action.value)) {
          if (shouldAnnounce) changedKeys.push(key);
        } else {
          allWritesLanded = false;
        }
      } else {
        const before = safeStorageGetChecked(key);
        const shouldAnnounce = !before.ok || before.value !== null;
        if (safeStorageRemoveChecked(key)) {
          if (shouldAnnounce) changedKeys.push(key);
        } else {
          allWritesLanded = false;
        }
      }
    }
  } finally {
    _suppressPatch = false;
  }
  dispatchCloudPrefsApplied(changedKeys, syncVersion);
  return allWritesLanded;
}

interface AppliedMigrations {
  data: Record<string, unknown>;
  schemaVersion: number;
  dataChanged: boolean;
}

function applyMigrationsWithSchemaVersion(
  data: Record<string, unknown>,
  fromVersion: number,
): AppliedMigrations {
  if (fromVersion >= CURRENT_PREFS_SCHEMA_VERSION) {
    return { data, schemaVersion: CURRENT_PREFS_SCHEMA_VERSION, dataChanged: false };
  }
  const migrated = applyMigrationChainWithSchemaVersion(
    data,
    fromVersion,
    CURRENT_PREFS_SCHEMA_VERSION,
    getMigrations(),
    (version, migrationData) => (
      version === 5
      && isRegionalFeedRolloutMigrationAmbiguous(migrationData, getRegionalRolloutTargets())
    ),
    true,
  );
  // Schema 5 intentionally fails closed when a locale-less fingerprint has
  // conflicting outcomes. Schema 6/7/8 are independent additive boundary fixes:
  // they still run so cloud hydration cannot overwrite the local opt-in
  // migrations while schema 5 remains retryable at its prior version.
  return { ...migrated, dataChanged: migrated.data !== data };
}

/**
 * The schema the local blob has reached, or `null` when the marker could not be
 * READ.
 *
 * An absent marker legitimately means "assume oldest, run migrations". A failed
 * read looks identical after degrading to null — and reruns one-shot migrations
 * over already-migrated data, where schema 2 re-enables a whole source category
 * the user may have deliberately disabled since (#7833 review).
 */
function getLocalSchemaVersion(): number | null {
  const read = safeStorageGetChecked(KEY_LOCAL_SCHEMA_VERSION);
  if (!read.ok) return null;
  if (read.value === null) return 1; // No marker yet → assume oldest, run migrations
  const v = parseInt(read.value, 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * Record the schema the LOCAL blob has reached. Returns false when a usable
 * store rejected the write.
 *
 * Same contract as setSyncVersion, and the consequence of skipping it is worse:
 * a stale marker makes one-shot migrations run again, and schema 2 re-enables
 * a whole source category — which a user may have deliberately disabled after
 * the first migration ran (#7833 review).
 */
function setLocalSchemaVersion(v: number): boolean {
  return safeStorageSetChecked(KEY_LOCAL_SCHEMA_VERSION, String(v));
}

/**
 * Migrate the local blob as far as it can be safely migrated before upload.
 * Idempotent — when local schema is already current, returns the existing
 * blob unchanged. Otherwise runs pending migrations, writes any cleaned data
 * back to localStorage, and records the effective schema reached. An
 * ambiguous migration deliberately leaves that marker at the prior schema so
 * the row remains eligible for a later retry.
 *
 * Must be called before EVERY post path: sign-in reconciliation, sign-out,
 * uploadNow, conflict retry, and unload flush. Otherwise the post could stamp
 * CURRENT_PREFS_SCHEMA_VERSION onto unmigrated local data, "upgrading" the
 * cloud row to the new schema with stale poisoning — the failure mode flagged
 * in PR #3524 review.
 */
interface PreparedCloudBlob {
  data: Record<string, string>;
  schemaVersion: number;
}

function migrateLocalBlobIfNeeded(): PreparedCloudBlob | null {
  const localSchema = getLocalSchemaVersion();
  if (localSchema === null) return null;
  const blob = buildCloudBlob();
  if (blob === null) return null;
  if (localSchema >= CURRENT_PREFS_SCHEMA_VERSION) {
    return { data: blob, schemaVersion: CURRENT_PREFS_SCHEMA_VERSION };
  }
  const migrated = applyMigrationsWithSchemaVersion(blob, localSchema);
  const migratedData = migrated.data as Record<string, string>;
  if (migratedData !== blob && !applyCloudBlob(migratedData)) {
    // The migrated blob did not land, so the local state is neither the old
    // snapshot nor the new one. Returning `blob` here — as an earlier round of
    // this fix did — hands callers a VALID PreparedCloudBlob, which they then
    // POST, advance the sync version for, and report as synced.
    return null;
  }
  if (!setLocalSchemaVersion(migrated.schemaVersion)) {
    // Storage took the migrated preference writes but rejected the marker, so
    // `blob` is now a stale pre-migration snapshot. Posting it would overwrite
    // the cloud with values the migration already replaced.
    return null;
  }
  return { data: migratedData, schemaVersion: migrated.schemaVersion };
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function showUndoToast(prevBlobJson: string): void {
  document.querySelector('.wm-sync-restore-toast')?.remove();

  const toast = document.createElement('div');
  toast.className = 'wm-sync-restore-toast update-toast';
  setTrustedHtml(toast, trustedHtml(`
    <div class="update-toast-body">
      <div class="update-toast-title">Settings restored</div>
      <div class="update-toast-detail">Your preferences were loaded from the cloud.</div>
    </div>
    <button class="update-toast-action" data-action="undo">Undo</button>
    <button class="update-toast-dismiss" data-action="dismiss" aria-label="Dismiss">\u00d7</button>
  `, "legacy direct innerHTML migration"));

  const autoTimer = setTimeout(() => toast.remove(), 5000);

  toast.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest('[data-action]')?.getAttribute('data-action');
    if (action === 'undo') {
      // Same checked-write contract as applyCloudBlob, for the same reason: a
      // rejected restore must not be announced as one. `restoredKeys` is built
      // from a read taken BEFORE the write, so an unchecked write would tell
      // every CLOUD_PREFS_APPLIED listener to re-read a key that still holds
      // the cloud value — and dismissing the toast would take away the only
      // affordance the user had to try again.
      const prev = JSON.parse(prevBlobJson) as Record<string, string>;
      const restoredKeys: CloudSyncKey[] = [];
      let allRestored = true;
      _suppressPatch = true;
      try {
        for (const [k, v] of Object.entries(prev)) {
          if (!CLOUD_SYNC_KEYS.includes(k as CloudSyncKey)) continue;
          const key = k as CloudSyncKey;
          // Same announce-on-doubt rule as applyCloudBlob above.
          const before = safeStorageGetChecked(key);
          const shouldAnnounce = !before.ok || before.value !== v;
          if (safeStorageSetChecked(key, v)) {
            if (shouldAnnounce) restoredKeys.push(key);
          } else {
            allRestored = false;
          }
        }
      } finally {
        _suppressPatch = false;
      }
      dispatchCloudPrefsApplied(restoredKeys);
      // Leave the toast up when the undo did not fully land, so the action is
      // still available; the 5s auto-dismiss timer still applies.
      if (allRestored) {
        toast.remove();
        clearTimeout(autoTimer);
      }
    } else if (action === 'dismiss') {
      toast.remove();
      clearTimeout(autoTimer);
    }
  });

  document.body.appendChild(toast);
}

// ── API helpers ───────────────────────────────────────────────────────────────

interface CloudPrefs {
  data: Record<string, unknown>;
  schemaVersion: number;
  syncVersion: number;
}

/**
 * Typed temporary response from the edge. Callers detect
 * this via `instanceof ServiceUnavailableError` and back off using
 * `retryAfterSec` instead of treating it as a permanent error.
 */
export class ServiceUnavailableError extends Error {
  retryAfterSec: number;
  status: number;
  constructor(retryAfterSec: number, status = 503) {
    super(`service temporarily unavailable (${status}; retry after ${retryAfterSec}s)`);
    this.name = 'ServiceUnavailableError';
    this.retryAfterSec = retryAfterSec;
    this.status = status;
  }
}

function asTemporaryCloudPrefsError(error: unknown): never {
  const name = (error as { name?: unknown } | null)?.name;
  if (error instanceof TimeoutError || name === 'TimeoutError' || name === 'AbortError') {
    throw new ServiceUnavailableError(parseRetryAfterSeconds(new Headers()), 504);
  }
  throw error;
}

async function getCloudPrefsToken(): Promise<string | null> {
  try {
    return await withTimeout(
      getClerkToken(),
      CLOUD_PREFS_REQUEST_TIMEOUT_MS,
      'cloud prefs token',
    );
  } catch (error) {
    return asTemporaryCloudPrefsError(error);
  }
}

async function fetchCloudPrefs(token: string, variant: string): Promise<CloudPrefs | null> {
  let res: Response;
  try {
    res = await fetch(`/api/user-prefs?variant=${encodeURIComponent(variant)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CLOUD_PREFS_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return asTemporaryCloudPrefsError(error);
  }
  if (res.status === 401) return null;
  if (isTemporaryCloudPrefsStatus(res.status)) throw new ServiceUnavailableError(parseRetryAfterSeconds(res.headers), res.status);
  if (!res.ok) throw new Error(`fetch prefs: ${res.status}`);
  return (await res.json()) as CloudPrefs | null;
}

async function postCloudPrefs(
  token: string,
  variant: string,
  data: Record<string, string>,
  expectedSyncVersion: number,
  schemaVersion: number = CURRENT_PREFS_SCHEMA_VERSION,
): Promise<{ syncVersion: number } | { conflict: true; actualSyncVersion?: number }> {
  let res: Response;
  try {
    res = await fetch('/api/user-prefs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ variant, data, expectedSyncVersion, schemaVersion }),
      signal: AbortSignal.timeout(CLOUD_PREFS_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return asTemporaryCloudPrefsError(error);
  }
  if (res.status === 409) {
    // Server now echoes the row's current syncVersion in the 409 body
    // (when available) so we can advance local state without a follow-up
    // GET. Fall back to undefined for older edge deploys that don't yet
    // include the field — the existing re-fetch path still handles those.
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    const actualSyncVersion = typeof body.actualSyncVersion === 'number' ? body.actualSyncVersion : undefined;
    return { conflict: true, actualSyncVersion };
  }
  if (isTemporaryCloudPrefsStatus(res.status)) throw new ServiceUnavailableError(parseRetryAfterSeconds(res.headers), res.status);
  if (!res.ok) throw new Error(`post prefs: ${res.status}`);
  return (await res.json()) as { syncVersion: number };
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Resolve a 409 CONFLICT without losing local edits. Fetch the fresh cloud
 * row, merge the user's locally-dirty keys over it (mergeCloudWithLocalDirty),
 * apply the merge to localStorage, and re-post. On success the dirty set is
 * cleared and state goes 'synced'; on a second conflict or a failed fetch the
 * dirty set is preserved so the next pref change / sign-in retries.
 *
 * Replaces the previous "fetch cloud → applyCloudBlob → re-post buildCloudBlob"
 * path, which overwrote localStorage with the cloud blob *before* rebuilding
 * the post body — silently discarding the edit the user had just made (e.g. a
 * watchlist typed seconds earlier, then lost on the debounced upload's 409).
 */
async function resolveConflictWithMerge(token: string, variant: string, callerGeneration: number): Promise<boolean> {
  const fresh = await fetchCloudPrefs(token, variant);
  if (_authGeneration !== callerGeneration) return false;
  if (!fresh) {
    setState('error');
    return false;
  }
  const migratedCloud = applyMigrationsWithSchemaVersion(fresh.data, fresh.schemaVersion ?? 1);
  const localBlob = buildCloudBlob();
  if (localBlob === null) {
    // Merging against a partial local blob would drop the unread keys from the
    // merge result, and this path re-posts that result.
    setState('error');
    return false;
  }
  const merged = mergeCloudWithLocalDirty(migratedCloud.data, localBlob, _dirtyKeys);
  if (!applyCloudBlob(merged, fresh.syncVersion)) {
    // A usable store rejected part of the merge. Advancing the version here
    // would let the next upload post the stale local values back over the
    // cloud row we just fetched (#7833 review).
    setState('error');
    return false;
  }
  // Same ordering rule as the sign-in path: schema marker first, so a rejected
  // marker cannot leave the sync version claiming a reconciliation happened.
  if (!setLocalSchemaVersion(migratedCloud.schemaVersion)) {
    setState('error');
    return false;
  }
  if (!setSyncVersion(fresh.syncVersion)) {
    setState('error');
    return false;
  }
  const retry = await postCloudPrefs(token, variant, merged, fresh.syncVersion, migratedCloud.schemaVersion);
  if (_authGeneration !== callerGeneration) return false;
  if ('conflict' in retry) {
    setState('conflict');
    return false;
  }
  // Generation guard (same vector as uploadNow's success branch): if the
  // signed-in user switched during the awaits above, do not clear/persist
  // settled dirty keys — _dirtyKeys now belongs to another user and the
  // write would durably corrupt their persisted dirty-key entry.
  if (!setSyncVersion(retry.syncVersion)) {
    // As above: do not settle dirty keys against a version that is not durable.
    setState('error');
    return false;
  }
  clearSettledDirtyKeys(merged);
  safeStorageSet(KEY_LAST_SYNC_AT, String(Date.now()));
  setState('synced');
  return true;
}

interface SignInAttempt {
  userId: string;
  variant: string;
  authGeneration: number;
  handoffGeneration?: number;
}

function completeSignInAttempt(
  attempt: SignInAttempt,
  outcome: CloudPrefsSignInTerminalDetail['outcome'],
): void {
  if (_authGeneration !== attempt.authGeneration) return;
  if (_pendingSignInRetryGeneration === attempt.authGeneration) {
    _pendingSignInRetryGeneration = null;
  }
  dispatchCloudPrefsSignInTerminal(
    attempt.userId,
    attempt.authGeneration,
    attempt.handoffGeneration,
    outcome,
  );
}

function runSignInAttempt(attempt: SignInAttempt): Promise<void> {
  const {
    userId,
    variant,
    authGeneration: myGeneration,
  } = attempt;

  return _syncOperations.run(async () => {
    if (_authGeneration !== myGeneration) return;

    _currentVariant = variant;
    setState('syncing');

    try {
      const token = await getCloudPrefsToken();
      if (_authGeneration !== myGeneration) return;
      if (!token) {
        setState('error');
        completeSignInAttempt(attempt, 'error');
        return;
      }
      _cachedToken = token;

      const cloud = await fetchCloudPrefs(token, variant);
      if (_authGeneration !== myGeneration) return;

      const localVersion = getSyncVersionChecked();
      if (localVersion === null) {
        // Cannot tell whether cloud is ahead. Applying it on a guess overwrites
        // local edits; treating it as first-ever sync fabricates an undo state.
        setState('error');
        completeSignInAttempt(attempt, 'error');
        return;
      }
      if (cloud && cloud.syncVersion > localVersion) {
        const isFirstEverSync = localVersion === 0;
        const localBlob = buildCloudBlob();
        if (localBlob === null) {
          // An unreadable local blob cannot be merged over, and the undo
          // snapshot below would record an incomplete "previous" state.
          setState('error');
          completeSignInAttempt(attempt, 'error');
          return;
        }
        const prevBlobJson = isFirstEverSync ? JSON.stringify(localBlob) : null;

        const cloudSchemaVersion = cloud.schemaVersion ?? 1;
        const migrated = applyMigrationsWithSchemaVersion(cloud.data, cloudSchemaVersion);
        const migrationChanged = migrated.schemaVersion > cloudSchemaVersion || migrated.dataChanged;
        // Cloud is ahead, but the user may have un-uploaded local edits — e.g.
        // onSignIn re-fired by a 503 retry after the user changed a pref. Merge
        // those dirty keys over the cloud blob instead of clobbering them.
        const hasDirty = _dirtyKeys.size > 0;
        const toApply = hasDirty
          ? mergeCloudWithLocalDirty(migrated.data, localBlob, _dirtyKeys)
          : migrated.data;
        if (!applyCloudBlob(toApply, cloud.syncVersion)) {
          // Same reasoning as resolveConflictWithMerge: a rejected write must
          // not leave local claiming cloud's version over stale values.
          setState('error');
          completeSignInAttempt(attempt, 'error');
          return;
        }
        // ORDER IS LOAD-BEARING: the schema marker persists BEFORE the sync
        // version. Both writes are checked, but advancing the version first
        // leaves a durable claim that this cloud generation was reconciled
        // while the schema marker is still old — and the next sign-in sees
        // equal versions, takes the local-upload branch, and reruns one-shot
        // migrations over already-migrated data (#7833 review).
        //
        // An ambiguous schema-5 fingerprint deliberately stops at schema 4,
        // so the same row remains eligible for a future disambiguated retry.
        if (!setLocalSchemaVersion(migrated.schemaVersion)) {
          setState('error');
          completeSignInAttempt(attempt, 'error');
          return;
        }
        if (!setSyncVersion(cloud.syncVersion)) {
          setState('error');
          completeSignInAttempt(attempt, 'error');
          return;
        }
        // Force an upload when the cloud row's schemaVersion is behind (so it
        // catches up — otherwise the migration re-runs every load) OR when we
        // merged in local dirty keys the cloud row doesn't have yet.
        if (migrationChanged || hasDirty) schedulePrefUpload(variant);
        safeStorageSet(KEY_LAST_SYNC_AT, String(Date.now()));

        if (isFirstEverSync && prevBlobJson && Object.keys(cloud.data).length > 0) {
          showUndoToast(prevBlobJson);
        }

        setState('synced');
      } else {
        // Local is at-or-ahead of cloud → post local. Migrate first so we
        // never stamp CURRENT_PREFS_SCHEMA_VERSION onto unmigrated local data
        // (the failure mode flagged in PR #3524 review: a user already synced
        // to a poisoned cloud row would skip Branch A's inbound migration on
        // subsequent sign-ins and post the bad blob back at schema 2,
        // cementing the poisoning at the new schema).
        const prepared = migrateLocalBlobIfNeeded();
        if (prepared === null) {
          // A preference could not be read. Posting now would replace the
          // server blob with one that omits it — a deletion, not an update.
          setState('error');
          completeSignInAttempt(attempt, 'error');
          return;
        }
        const result = await postCloudPrefs(
          token,
          variant,
          prepared.data,
          getSyncVersion(),
          prepared.schemaVersion,
        );
        if (_authGeneration !== myGeneration) return;

        if ('conflict' in result) {
          // Merge instead of clobber — see resolveConflictWithMerge. The old
          // path here applied the cloud blob over localStorage and stopped,
          // discarding the local edits this branch was trying to upload.
          if (!await resolveConflictWithMerge(token, variant, myGeneration)) {
            completeSignInAttempt(attempt, 'error');
            return;
          }
        } else if (setSyncVersion(result.syncVersion)) {
          clearSettledDirtyKeys(prepared.data);
          safeStorageSet(KEY_LAST_SYNC_AT, String(Date.now()));
          setState('synced');
        } else {
        // The durable marker did not land. Settling dirty keys and reporting
        // synced on top of a stale version would claim a reconciliation that
        // is not persisted (#7833 review).
          setState('error');
          completeSignInAttempt(attempt, 'error');
          return;
        }
      }

      if (_authGeneration === myGeneration) {
        safeStorageSet(KEY_LAST_SIGNED_IN_AS, userId);
        completeSignInAttempt(attempt, 'synced');
      }
    } catch (err) {
      if (_authGeneration !== myGeneration) return;
      if (err instanceof ServiceUnavailableError) {
        // Temporary edge response — transient. Set 'pending' (not 'error') and
        // re-attempt sign-in sync after the server-suggested delay. This is
        // the user-facing "transient outage shouldn't be permanent" fix
        // (PR #3479): without this branch the catch would fall through to
        // 'error' and the user's prefs would silently not sync until they
        // reload.
        //
        // Keep this attempt logically pending through both the scheduled wait
        // and the recursively invoked request. The handoff expiry consults
        // this generation-scoped marker, so firing the timer must not create
        // an 8-15 second gap where the request is active but looks idle.
        console.warn(`[cloud-prefs] onSignIn ${err.status}; retrying in ${err.retryAfterSec}s`);
        setState('pending');
        clearSignInRetry();
        _pendingSignInRetryGeneration = myGeneration;
        _signInRetryTimer = setTimeout(() => {
          _signInRetryTimer = null;
          if (_authGeneration !== myGeneration) {
            if (_pendingSignInRetryGeneration === myGeneration) {
              _pendingSignInRetryGeneration = null;
            }
            return;
          }
          void runSignInAttempt(attempt);
        }, err.retryAfterSec * 1000);
        return;
      }
      console.warn('[cloud-prefs] onSignIn failed:', err);
      setState(!navigator.onLine || (err instanceof TypeError && err.message.includes('fetch')) ? 'offline' : 'error');
      completeSignInAttempt(attempt, 'error');
    }
  });
}

export function onSignIn(
  userId: string,
  variant: string,
  options: CloudPrefsSignInOptions = {},
): Promise<void> {
  if (!isEnabled()) {
    // The account handoff still needs a real terminal signal when cloud sync
    // is feature-disabled or unavailable in the desktop runtime. Without it,
    // tier-owned preferences remain deferred until the expiry timer fires.
    dispatchCloudPrefsSignInTerminal(
      userId,
      _authGeneration,
      options.handoffGeneration,
      'skipped',
    );
    return Promise.resolve();
  }

  // New onSignIn entry invalidates both upload and sign-in retry closures.
  // Recursive sign-in retries use runSignInAttempt directly, preserving this
  // generation until they reach a real terminal outcome.
  clearRetryTimer();
  clearSignInRetry();
  _authGeneration += 1;
  const myGeneration = _authGeneration;

  // Ownership sidecars describe which changes a particular account's gate
  // produced. Preserve them for a same-account legacy cloud row, but never
  // carry them across an observed account transition.
  if (!clearForeignOwnershipSidecars(userId)) {
    // Provenance is undeterminable, so proceeding could attribute the previous
    // account's gate decisions to this one. Report a terminal error rather than
    // reconcile on a guess.
    setState('error');
    dispatchCloudPrefsSignInTerminal(
      userId,
      myGeneration,
      options.handoffGeneration,
      'error',
    );
    return Promise.resolve();
  }

  // Establish dirty-key ownership synchronously. Preference writes may happen
  // while this sign-in waits behind an older queued writer; hydrating inside
  // the queued callback would then clear those new edits or attribute them to
  // the previous account.
  hydrateDirtyKeysFromStorage(userId);

  return runSignInAttempt({
    userId,
    variant,
    authGeneration: myGeneration,
    ...(options.handoffGeneration === undefined
      ? {}
      : { handoffGeneration: options.handoffGeneration }),
  });
}

export function onSignOut(): void {
  if (!isEnabled()) return;

  const preservePersistedDirtyKeys = _syncOperations.busy && _dirtyKeys.size > 0;
  if (_debounceTimer !== null && _cachedToken) {
    // Flush pending upload synchronously before clearing credentials
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
    // Never launch a second stale-version writer while sign-in reconciliation
    // or a normal upload is already running. Dirty keys remain persisted and
    // the active operation / next sign-in remains the recovery path.
    if (!_syncOperations.busy) {
      const prepared = migrateLocalBlobIfNeeded();
      // Best-effort flush, but "best effort" must not mean "post a blob that
      // deletes an unreadable preference from the cloud". Skip the FLUSH only —
      // returning here would abandon the sign-out cleanup below, leaving the
      // auth generation un-bumped, the retry timers live, and `_cachedToken`
      // holding the signed-out user's token for a later unload handler to use.
      const token = _cachedToken;
      if (prepared !== null) void _syncOperations.run(async () => {
        await fetch('/api/user-prefs', {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ variant: _currentVariant, data: prepared.data, expectedSyncVersion: getSyncVersion(), schemaVersion: prepared.schemaVersion }),
          signal: AbortSignal.timeout(CLOUD_PREFS_REQUEST_TIMEOUT_MS),
        });
      }).catch(() => { /* best-effort on sign-out */ });
    }
  } else if (_debounceTimer !== null) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  // Cancel any pending 503 retry and bump auth-generation so a timer that's
  // already scheduled (and not yet caught by clearRetryTimer) bails when it
  // fires — a delayed retry from the prior auth context must not call
  // onSignIn / uploadNow against the now-empty token cache or, worse, against
  // a different user's token after a fast user switch.
  clearRetryTimer();
  clearSignInRetry();
  _authGeneration += 1;
  _cachedToken = null;
  // Dirty-key tracking is user-scoped. Clear the in-memory owner on sign-out,
  // but retain its persisted marker when an interrupted writer still owns
  // unsynced edits; hydrateDirtyKeysFromStorage validates the user id before
  // restoring it and removes mismatched markers for the next account.
  _dirtyKeys.clear();
  if (!preservePersistedDirtyKeys) persistDirtyKeys();
  _dirtyKeysUserId = null;

  // Preserve prefs; only clear sync metadata
  safeStorageRemove(KEY_SYNC_VERSION);
  safeStorageRemove(KEY_LAST_SYNC_AT);
  setState('signed-out');
}

/**
 * Execute one cloud write while the caller owns the serialized sync queue.
 * The outcome tells the upload drain whether it may replay a mutation that
 * arrived after this pass captured its snapshot.
 */
async function performUploadNow(variant: string): Promise<'completed' | 'retry-deferred' | 'stopped'> {
  // Capture the auth generation at entry. If sign-out / user-switch happens
  // while we're awaiting fetch, the generation guard on any 503 retry below
  // will detect it and abort the scheduled retry. We do NOT increment the
  // generation here — uploadNow runs WITHIN an existing auth context (it's
  // called by the debounced upload path), so we want to inherit the current
  // generation, not start a new one.
  const myGeneration = _authGeneration;

  try {
    const token = await getCloudPrefsToken();
    if (_authGeneration !== myGeneration) return 'stopped';
    if (!token) return 'stopped';
    _cachedToken = token;

    setState('syncing');

    const prepared = migrateLocalBlobIfNeeded();
    if (prepared === null) {
      // Same as the sign-in post path: an unreadable preference would be
      // uploaded as an absent one, deleting it from the cloud row.
      setState('error');
      return 'stopped';
    }
    const postedBlob = prepared.data;
    const result = await postCloudPrefs(
      token,
      variant,
      postedBlob,
      getSyncVersion(),
      prepared.schemaVersion,
    );
    if (_authGeneration !== myGeneration) return 'stopped';

    if ('conflict' in result) {
      setState('conflict');
      // Merge the user's locally-dirty keys over the fresh cloud row instead
      // of overwriting localStorage with cloud (the old path did
      // applyCloudBlob(cloud) then re-posted buildCloudBlob() — which by then
      // WAS the cloud blob, so the user's just-made edit was silently lost).
      if (!await resolveConflictWithMerge(token, variant, myGeneration)) return 'stopped';
    } else {
      // Generation guard: a sign-out / account-switch during the awaits above
      // repoints _dirtyKeys and _dirtyKeysUserId to a different user. Clearing
      // (and now persisting) settled keys here would durably corrupt that
      // user's dirty-key entry using this upload's stale postedBlob. Match the
      // 503 retry branch and the flush-success path — bail if the generation
      // moved.
      if (!setSyncVersion(result.syncVersion)) {
        // Same contract as the sign-in branch: a stale durable version must not
        // be reported as synced with its dirty keys settled.
        setState('error');
        return 'stopped';
      }
      clearSettledDirtyKeys(postedBlob);
      safeStorageSet(KEY_LAST_SYNC_AT, String(Date.now()));
      setState('synced');
    }
  } catch (err) {
    if (_authGeneration !== myGeneration) return 'stopped';
    if (err instanceof ServiceUnavailableError) {
      // Temporary edge response — transient. Re-queue the upload after the
      // server-suggested delay so the unsaved blob isn't lost. Setting
      // 'pending' state matches the existing schedulePrefUpload UX.
      //
      // Generation guard: same as the onSignIn branch — if the user signs
      // out or switches accounts during the retry window, the timer fires
      // but the closure's captured `myGeneration` no longer matches, so
      // the retry aborts. Without this, the upload would re-fire against
      // a now-empty token cache or a different user's token.
      console.warn(`[cloud-prefs] uploadNow ${err.status}; retrying in ${err.retryAfterSec}s`);
      setState('pending');
      clearRetryTimer();
      _retryTimer = setTimeout(() => {
        _retryTimer = null;
        if (_authGeneration !== myGeneration) return;
        void uploadNow(variant);
      }, err.retryAfterSec * 1000);
      return 'retry-deferred';
    }
    console.warn('[cloud-prefs] uploadNow failed:', err);
    setState(!navigator.onLine || (err instanceof TypeError && err.message.includes('fetch')) ? 'offline' : 'error');
    return 'stopped';
  }
  return 'completed';
}

/**
 * Coalesce upload requests behind the shared sign-in/write queue.
 *
 * Calls share one active promise. After a successful pass, dirty-key tracking
 * determines whether a preference changed after its snapshot and needs one
 * more pass; duplicate callers alone never cause a redundant POST.
 */
function uploadNow(variant: string): Promise<void> {
  _queuedUploadVariant = variant;
  if (_activeUploadPromise !== null) {
    setState('pending');
    return _activeUploadPromise;
  }

  const requestedGeneration = _authGeneration;
  const queuedUpload = _syncOperations.run(async () => {
    if (_authGeneration !== requestedGeneration) return;

    while (_authGeneration === requestedGeneration) {
      const outcome = await performUploadNow(_queuedUploadVariant);
      if (outcome !== 'completed' || _dirtyKeys.size === 0) return;
    }
  });
  const activeUpload = queuedUpload.finally(() => {
    if (_activeUploadPromise === activeUpload) _activeUploadPromise = null;
  });
  _activeUploadPromise = activeUpload;
  return activeUpload;
}

function schedulePrefUpload(variant: string): void {
  setState('pending');
  if (_debounceTimer !== null) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(async () => {
    _debounceTimer = null;
    await uploadNow(variant);
  }, 5000);
}

export function onPrefChange(variant: string): void {
  if (!isEnabled()) return;
  _currentVariant = variant;
  schedulePrefUpload(variant);
}

export async function syncNow(): Promise<void> {
  if (!isEnabled()) return;
  if (_debounceTimer !== null) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  await uploadNow(_currentVariant);
}

// The last two DEGRADING reads in this module, and deliberately so. Both feed
// the settings panel's status dot, label, and "Last synced" line
// (preferences-content.ts) and nothing else — no branch, no upload, no
// reconciliation. A failed read renders "Signed out / Never", which is a
// degraded DISPLAY rather than a wrong decision, so a checked read here would
// buy nothing.
//
// Narrower claim than an earlier round of this branch made: the reads that feed
// a decision are checked, but `getSyncVersion()` deliberately still degrades
// for the four `expectedSyncVersion` POST bodies, where a wrong value returns
// 409 and routes into the merge path — loud and self-correcting, unlike the
// storage-event cancellation, which is checked.

export function getSyncState(): SyncState {
  return (safeStorageGet(KEY_SYNC_STATE) as SyncState) || 'signed-out';
}

export function getLastSyncAt(): number {
  return parseInt(safeStorageGet(KEY_LAST_SYNC_AT) ?? '0', 10) || 0;
}

// ── install ───────────────────────────────────────────────────────────────────

/** Apply a validated backup without publishing partial writes to cloud sync. */
export function applyLocalPreferenceImport(entries: Array<[string, string]>): void {
  const previous = entries.map(([key]) => {
    const read = safeStorageGetChecked(key);
    if (!read.ok) throw new Error('Cannot read settings before import.');
    return [key, read.value] as const;
  });
  const wasSuppressed = _suppressPatch;
  _suppressPatch = true;
  let written = 0;
  try {
    try {
      for (const [key, value] of entries) {
        if (!safeStorageSetChecked(key, value)) throw new Error('Cannot persist imported settings.');
        written++;
      }
    } catch (error) {
      // Remove replacements first so restoring a larger old value has its original space.
      for (const [key] of previous.slice(0, written)) {
        if (!safeStorageRemoveChecked(key)) throw new Error('Settings rollback failed.');
      }
      for (const [key, value] of previous.slice(0, written)) {
        if (value !== null && !safeStorageSetChecked(key, value)) throw new Error('Settings rollback failed.');
      }
      throw error;
    }
  } finally {
    _suppressPatch = wasSuppressed;
  }
  if (_installed && !wasSuppressed) {
    for (const [key] of entries) {
      if (CLOUD_SYNC_KEYS.includes(key as CloudSyncKey)) markDirtyKey(key as CloudSyncKey);
    }
    if (entries.some(([key]) => CLOUD_SYNC_KEYS.includes(key as CloudSyncKey))) schedulePrefUpload(_currentVariant);
  }
}

export function install(variant: string): void {
  if (!isEnabled() || _installed) return;
  _installed = true;
  _currentVariant = variant;

  // Patch localStorage.setItem and removeItem to detect pref changes in this tab.
  // Use _suppressPatch to prevent applyCloudBlob from triggering spurious uploads.
  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function setItem(key: string, value: string) {
    originalSetItem.call(this, key, value);
    if (this === localStorage && !_suppressPatch && CLOUD_SYNC_KEYS.includes(key as CloudSyncKey)) {
      markDirtyKey(key as CloudSyncKey);
      schedulePrefUpload(_currentVariant);
    }
  };

  const originalRemoveItem = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function removeItem(key: string) {
    originalRemoveItem.call(this, key);
    if (this === localStorage && !_suppressPatch && CLOUD_SYNC_KEYS.includes(key as CloudSyncKey)) {
      markDirtyKey(key as CloudSyncKey);
      schedulePrefUpload(_currentVariant);
    }
  };

  // Multi-tab: another tab wrote a newer syncVersion — cancel our pending upload
  window.addEventListener('storage', (e) => {
    if (e.key === KEY_SYNC_VERSION && e.newValue !== null) {
      const newV = parseInt(e.newValue, 10);
      // Checked, because this CANCELS a pending upload. Degrading to 0 makes
      // any other tab's version look newer, so this tab's debounced local edit
      // is dropped and reported as synced — silently, unlike the POST sites,
      // where a wrong expectedSyncVersion returns 409 and routes into the
      // merge path (#7833 review).
      const localVersion = getSyncVersionChecked();
      if (localVersion !== null && newV > localVersion) {
        if (_debounceTimer !== null) {
          clearTimeout(_debounceTimer);
          _debounceTimer = null;
          setState('synced');
        }
        safeStorageSet(KEY_SYNC_VERSION, e.newValue);
      }
    }
  });

  // Tab close: flush pending debounce via fetch with keepalive
  // (sendBeacon cannot send Authorization headers)
  const flushOnUnload = (): void => {
    if (_debounceTimer === null || !_cachedToken) return;
    clearTimeout(_debounceTimer);
    _debounceTimer = null;

    // A sign-in reconciliation or upload already owns the current
    // expectedSyncVersion. Fold this final snapshot into that serialized
    // writer instead of launching a competing keepalive POST.
    if (_syncOperations.busy) {
      void uploadNow(_currentVariant);
      return;
    }

    // Same defensive migration as the synchronous post paths — never stamp
    // CURRENT_PREFS_SCHEMA_VERSION onto unmigrated local data, even on
    // best-effort unload flush.
    const prepared = migrateLocalBlobIfNeeded();
    if (prepared === null) return;
    const blob = prepared.data;
    const myGeneration = _authGeneration;
    const payload = JSON.stringify({ variant: _currentVariant, data: blob, expectedSyncVersion: getSyncVersion(), schemaVersion: prepared.schemaVersion });
    void _syncOperations.run(async () => {
      await fetch('/api/user-prefs', {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${_cachedToken}`,
        },
        body: payload,
        signal: AbortSignal.timeout(CLOUD_PREFS_REQUEST_TIMEOUT_MS),
      }).then(async (res) => {
        // The flush's most common trigger is NOT a real unload — it's
        // visibilitychange→hidden on a tab switch, after which the tab stays
        // alive. A successful flush advances the server row's syncVersion, so
        // skipping the response here strands local KEY_SYNC_VERSION one
        // version behind and GUARANTEES a 409 on the next pref save. Adopt
        // the new version when the response is observable (true unloads never
        // get here; the next boot's onSignIn GET heals those instead).
        //
        // Non-2xx: 409 keeps the stale version and dirty keys so the next
        // upload resolves through the conflict-merge path. Temporary 429/5xx
        // responses are observable during tab switches, so re-arm the normal
        // retry machinery instead of stranding the final save.
        if (!res.ok) {
          rearmTemporaryCloudPrefsRetry({
            status: res.status,
            headers: res.headers,
            myGeneration,
            getAuthGeneration: () => _authGeneration,
            setPending: () => setState('pending'),
            clearRetryTimer,
            setRetryTimer: (timer) => { _retryTimer = timer; },
            uploadNow: () => uploadNow(_currentVariant),
          });
          return;
        }
        const body = (await res.json().catch(() => null)) as { syncVersion?: number } | null;
        applyObservableCloudPrefsFlushSuccess({
          syncVersion: body?.syncVersion,
          myGeneration,
          getAuthGeneration: () => _authGeneration,
          getSyncVersion,
          setSyncVersion,
          clearSettledDirtyKeys: () => clearSettledDirtyKeys(blob),
          setLastSyncAt: (timestampMs) => {
            safeStorageSet(KEY_LAST_SYNC_AT, String(timestampMs));
          },
          // Only claim 'synced' when no newer edit re-armed the debounce AND no
          // uploadNow is active or queued (performUploadNow does not start
          // until the keepalive task releases the serialized queue).
          isIdle: () => _debounceTimer === null && _activeUploadPromise === null,
          setSynced: () => setState('synced'),
        });
      });
    }).catch(() => { /* best-effort on unload */ });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnUnload();
  });
  window.addEventListener('pagehide', flushOnUnload);
}
