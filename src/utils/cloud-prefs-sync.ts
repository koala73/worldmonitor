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

import { CLOUD_SYNC_KEYS, type CloudSyncKey } from './sync-keys';
import { isDesktopRuntime } from '@/services/runtime';
import { getClerkToken } from '@/services/clerk';
import { FEEDS } from '@/config/feeds';
import { applyMigrationChain, buildMigrations } from './cloud-prefs-migrations';

const ENABLED = import.meta.env.VITE_CLOUD_PREFS_ENABLED === 'true';

// localStorage state keys — never uploaded to cloud
const KEY_SYNC_VERSION = 'wm-cloud-sync-version';
const KEY_LAST_SYNC_AT = 'wm-last-sync-at';
const KEY_SYNC_STATE = 'wm-cloud-sync-state';
const KEY_LAST_SIGNED_IN_AS = 'wm-last-signed-in-as';
// Tracks the schema version of the LOCAL blob (i.e. what's in localStorage
// right now). Distinct from the cloud row's schemaVersion. Required because
// uploads can post local data without first fetching cloud (uploadNow,
// post-conflict retry, onSignIn else-branch when local is at-or-ahead of
// cloud). Without local tracking, those post sites would stamp the new
// schemaVersion onto unmigrated local data — cementing the poisoning at
// the new schema version. Defaults to 1 when missing (assumes oldest).
const KEY_LOCAL_SCHEMA_VERSION = 'wm-cloud-prefs-local-schema-version';

const CURRENT_PREFS_SCHEMA_VERSION = 2;

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
const MIGRATIONS = buildMigrations(FEEDS);

type SyncState = 'synced' | 'pending' | 'syncing' | 'conflict' | 'offline' | 'signed-out' | 'error';

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _currentVariant = 'full';
let _installed = false;
let _suppressPatch = false; // prevents applyCloudBlob from re-triggering upload
let _cachedToken: string | null = null; // synchronous token cache for flush()

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
let _authGeneration = 0;

function clearRetryTimer(): void {
  if (_retryTimer !== null) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
}

// ── Guards ────────────────────────────────────────────────────────────────────

function isEnabled(): boolean {
  return ENABLED && !isDesktopRuntime();
}

export function isCloudSyncEnabled(): boolean {
  return isEnabled();
}

// ── State helpers ─────────────────────────────────────────────────────────────

function getSyncVersion(): number {
  return parseInt(localStorage.getItem(KEY_SYNC_VERSION) ?? '0', 10) || 0;
}

function setSyncVersion(v: number): void {
  // Use direct Storage.prototype.setItem to bypass our patch (state key, not a pref key)
  Storage.prototype.setItem.call(localStorage, KEY_SYNC_VERSION, String(v));
}

function setState(s: SyncState): void {
  Storage.prototype.setItem.call(localStorage, KEY_SYNC_STATE, s);
}

// ── Blob helpers ──────────────────────────────────────────────────────────────

function buildCloudBlob(): Record<string, string> {
  const blob: Record<string, string> = {};
  for (const key of CLOUD_SYNC_KEYS) {
    const val = localStorage.getItem(key);
    if (val !== null) blob[key] = val;
  }
  return blob;
}

function applyCloudBlob(data: Record<string, unknown>): void {
  _suppressPatch = true;
  try {
    for (const key of CLOUD_SYNC_KEYS) {
      const val = data[key];
      if (typeof val === 'string') {
        localStorage.setItem(key, val);
      } else if (!(key in data)) {
        localStorage.removeItem(key);
      }
    }
  } finally {
    _suppressPatch = false;
  }
}

function applyMigrations(
  data: Record<string, unknown>,
  fromVersion: number,
): Record<string, unknown> {
  return applyMigrationChain(data, fromVersion, CURRENT_PREFS_SCHEMA_VERSION, MIGRATIONS);
}

function getLocalSchemaVersion(): number {
  const raw = localStorage.getItem(KEY_LOCAL_SCHEMA_VERSION);
  if (raw === null) return 1; // No marker yet → assume oldest, run migrations
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function setLocalSchemaVersion(v: number): void {
  Storage.prototype.setItem.call(localStorage, KEY_LOCAL_SCHEMA_VERSION, String(v));
}

/**
 * Ensure the local blob is migrated to CURRENT_PREFS_SCHEMA_VERSION before
 * upload. Idempotent — when local schema is already current, returns the
 * existing blob unchanged. Otherwise runs pending migrations, writes the
 * cleaned data back to localStorage, and bumps the local schema marker.
 *
 * Must be called before EVERY post path: onSignIn else-branch (when local
 * is at-or-ahead of cloud), uploadNow normal path, uploadNow conflict
 * retry. Otherwise the post would stamp CURRENT_PREFS_SCHEMA_VERSION onto
 * unmigrated local data, "upgrading" the cloud row to the new schema with
 * stale poisoning — the failure mode flagged in PR #3524 review.
 */
function migrateLocalBlobIfNeeded(): Record<string, string> {
  const localSchema = getLocalSchemaVersion();
  const blob = buildCloudBlob();
  if (localSchema >= CURRENT_PREFS_SCHEMA_VERSION) return blob;
  const migrated = applyMigrations(blob, localSchema) as Record<string, string>;
  if (migrated !== blob) applyCloudBlob(migrated);
  setLocalSchemaVersion(CURRENT_PREFS_SCHEMA_VERSION);
  return migrated;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function showUndoToast(prevBlobJson: string): void {
  document.querySelector('.wm-sync-restore-toast')?.remove();

  const toast = document.createElement('div');
  toast.className = 'wm-sync-restore-toast update-toast';
  toast.innerHTML = `
    <div class="update-toast-body">
      <div class="update-toast-title">Settings restored</div>
      <div class="update-toast-detail">Your preferences were loaded from the cloud.</div>
    </div>
    <button class="update-toast-action" data-action="undo">Undo</button>
    <button class="update-toast-dismiss" data-action="dismiss" aria-label="Dismiss">\u00d7</button>
  `;

  const autoTimer = setTimeout(() => toast.remove(), 5000);

  toast.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest('[data-action]')?.getAttribute('data-action');
    if (action === 'undo') {
      const prev = JSON.parse(prevBlobJson) as Record<string, string>;
      _suppressPatch = true;
      try {
        for (const [k, v] of Object.entries(prev)) {
          if (CLOUD_SYNC_KEYS.includes(k as CloudSyncKey)) localStorage.setItem(k, v);
        }
      } finally {
        _suppressPatch = false;
      }
      toast.remove();
      clearTimeout(autoTimer);
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
 * Typed 503 from the edge — Convex platform-level outage. Callers detect
 * this via `instanceof ServiceUnavailableError` and back off using
 * `retryAfterSec` instead of treating it as a permanent error.
 */
export class ServiceUnavailableError extends Error {
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(`service unavailable (retry after ${retryAfterSec}s)`);
    this.name = 'ServiceUnavailableError';
    this.retryAfterSec = retryAfterSec;
  }
}

// Bounds on the Retry-After value we'll honor. Lower bound prevents a
// retry storm if the server sends 0 or a malformed value; upper bound
// caps the delay so a misconfigured/extreme header doesn't strand sync
// for minutes.
const RETRY_AFTER_MIN_SEC = 1;
const RETRY_AFTER_MAX_SEC = 60;
const RETRY_AFTER_DEFAULT_SEC = 5;

/**
 * Parse the `Retry-After` header per RFC 7231: either delta-seconds or an
 * HTTP-date. Returns a clamped number of seconds, with the configured
 * default for missing/malformed values. Exported for testability.
 */
export function parseRetryAfterSeconds(headers: Headers): number {
  const raw = headers.get('Retry-After');
  if (!raw) return RETRY_AFTER_DEFAULT_SEC;
  const trimmed = raw.trim();
  // delta-seconds form: digits only.
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return RETRY_AFTER_DEFAULT_SEC;
    return Math.min(Math.max(n, RETRY_AFTER_MIN_SEC), RETRY_AFTER_MAX_SEC);
  }
  // HTTP-date form: parse and convert to delta-seconds from now.
  // `Date.parse` is permissive — `Date.parse("-5")` parses as year -5 BCE,
  // and other garbage strings can produce finite timestamps that then
  // clamp to RETRY_AFTER_MIN_SEC, retrying in 1s instead of the safer
  // default. Require the input to look like a real HTTP-date (must
  // contain both a 4-digit year and a `:` time separator) so non-date
  // garbage falls into the default-seconds branch instead.
  if (!/\b\d{4}\b/.test(trimmed) || !trimmed.includes(':')) return RETRY_AFTER_DEFAULT_SEC;
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return RETRY_AFTER_DEFAULT_SEC;
  const delta = Math.round((t - Date.now()) / 1000);
  return Math.min(Math.max(delta, RETRY_AFTER_MIN_SEC), RETRY_AFTER_MAX_SEC);
}

async function fetchCloudPrefs(token: string, variant: string): Promise<CloudPrefs | null> {
  const res = await fetch(`/api/user-prefs?variant=${encodeURIComponent(variant)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) return null;
  if (res.status === 503) throw new ServiceUnavailableError(parseRetryAfterSeconds(res.headers));
  if (!res.ok) throw new Error(`fetch prefs: ${res.status}`);
  return (await res.json()) as CloudPrefs | null;
}

async function postCloudPrefs(
  token: string,
  variant: string,
  data: Record<string, string>,
  expectedSyncVersion: number,
): Promise<{ syncVersion: number } | { conflict: true; actualSyncVersion?: number }> {
  const res = await fetch('/api/user-prefs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ variant, data, expectedSyncVersion, schemaVersion: CURRENT_PREFS_SCHEMA_VERSION }),
  });
  if (res.status === 409) {
    // Server now echoes the row's current syncVersion in the 409 body
    // (when available) so we can advance local state without a follow-up
    // GET. Fall back to undefined for older edge deploys that don't yet
    // include the field — the existing re-fetch path still handles those.
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    const actualSyncVersion = typeof body.actualSyncVersion === 'number' ? body.actualSyncVersion : undefined;
    return { conflict: true, actualSyncVersion };
  }
  if (res.status === 503) throw new ServiceUnavailableError(parseRetryAfterSeconds(res.headers));
  if (!res.ok) throw new Error(`post prefs: ${res.status}`);
  return (await res.json()) as { syncVersion: number };
}

// ── Core logic ────────────────────────────────────────────────────────────────

export async function onSignIn(userId: string, variant: string): Promise<void> {
  if (!isEnabled()) return;

  // New onSignIn entry — invalidate any pending 503 retry so a stale
  // closure can't fire mid-flight, and bump generation so any timer that
  // was already scheduled (and not yet caught by clearRetryTimer) bails
  // when it fires.
  clearRetryTimer();
  _authGeneration += 1;
  const myGeneration = _authGeneration;

  _currentVariant = variant;
  setState('syncing');

  const token = await getClerkToken();
  if (!token) { setState('error'); return; }
  _cachedToken = token;

  try {
    const cloud = await fetchCloudPrefs(token, variant);

    if (cloud && cloud.syncVersion > getSyncVersion()) {
      const isFirstEverSync = getSyncVersion() === 0;
      const prevBlobJson = isFirstEverSync ? JSON.stringify(buildCloudBlob()) : null;

      const migrated = applyMigrations(cloud.data, cloud.schemaVersion ?? 1);
      const migrationChanged = (cloud.schemaVersion ?? 1) < CURRENT_PREFS_SCHEMA_VERSION;
      applyCloudBlob(migrated);
      setSyncVersion(cloud.syncVersion);
      // After applyCloudBlob, local data IS at CURRENT schema (applyMigrations
      // ran every step from cloud.schemaVersion to CURRENT). Mark it so the
      // post paths don't redundantly re-run migrations on already-clean data.
      setLocalSchemaVersion(CURRENT_PREFS_SCHEMA_VERSION);
      // If applyMigrations advanced the schema, force an upload so the cloud
      // row's schemaVersion catches up. Without this, the cloud blob stays at
      // the old schemaVersion and the migration re-runs on every load until
      // any user pref change happens to fire schedulePrefUpload organically.
      // Idempotent migrations make that harmless but wasteful and noisy.
      if (migrationChanged) schedulePrefUpload(variant);
      Storage.prototype.setItem.call(localStorage, KEY_LAST_SYNC_AT, String(Date.now()));

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
      const blob = migrateLocalBlobIfNeeded();
      const result = await postCloudPrefs(token, variant, blob, getSyncVersion());

      if ('conflict' in result) {
        setState('conflict');
        const fresh = await fetchCloudPrefs(token, variant);
        if (fresh) {
          const migrated = applyMigrations(fresh.data, fresh.schemaVersion ?? 1);
          applyCloudBlob(migrated);
          setSyncVersion(fresh.syncVersion);
          setLocalSchemaVersion(CURRENT_PREFS_SCHEMA_VERSION);
          setState('synced');
        } else {
          setState('error');
        }
      } else {
        setSyncVersion(result.syncVersion);
        Storage.prototype.setItem.call(localStorage, KEY_LAST_SYNC_AT, String(Date.now()));
        setState('synced');
      }
    }

    Storage.prototype.setItem.call(localStorage, KEY_LAST_SIGNED_IN_AS, userId);
  } catch (err) {
    if (err instanceof ServiceUnavailableError) {
      // Convex platform 503 — transient. Set 'pending' (not 'error') and
      // re-attempt sign-in sync after the server-suggested delay. This is
      // the user-facing "transient outage shouldn't be permanent" fix
      // (PR #3479): without this branch the catch would fall through to
      // 'error' and the user's prefs would silently not sync until they
      // reload.
      //
      // Generation guard: cancel any prior pending retry, then schedule a
      // new one whose callback bails if `_authGeneration` has advanced
      // (sign-out, user-switch, or another onSignIn invocation since this
      // attempt began). Without the guard, a 5s delayed retry from user A
      // could fire after sign-out (no token) or after user B signed in
      // (wrong token in cache).
      console.warn(`[cloud-prefs] onSignIn 503; retrying in ${err.retryAfterSec}s`);
      setState('pending');
      clearRetryTimer();
      _retryTimer = setTimeout(() => {
        _retryTimer = null;
        if (_authGeneration !== myGeneration) return;
        void onSignIn(userId, variant);
      }, err.retryAfterSec * 1000);
      return;
    }
    console.warn('[cloud-prefs] onSignIn failed:', err);
    setState(!navigator.onLine || (err instanceof TypeError && err.message.includes('fetch')) ? 'offline' : 'error');
  }
}

export function onSignOut(): void {
  if (!isEnabled()) return;

  if (_debounceTimer !== null && _cachedToken) {
    // Flush pending upload synchronously before clearing credentials
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
    const blob = buildCloudBlob();
    fetch('/api/user-prefs', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_cachedToken}` },
      body: JSON.stringify({ variant: _currentVariant, data: blob, expectedSyncVersion: getSyncVersion(), schemaVersion: CURRENT_PREFS_SCHEMA_VERSION }),
    }).catch(() => { /* best-effort on sign-out */ });
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
  _authGeneration += 1;
  _cachedToken = null;

  // Preserve prefs; only clear sync metadata
  localStorage.removeItem(KEY_SYNC_VERSION);
  localStorage.removeItem(KEY_LAST_SYNC_AT);
  setState('signed-out');
}

async function uploadNow(variant: string): Promise<void> {
  // Capture the auth generation at entry. If sign-out / user-switch happens
  // while we're awaiting fetch, the generation guard on any 503 retry below
  // will detect it and abort the scheduled retry. We do NOT increment the
  // generation here — uploadNow runs WITHIN an existing auth context (it's
  // called by the debounced upload path), so we want to inherit the current
  // generation, not start a new one.
  const myGeneration = _authGeneration;

  const token = await getClerkToken();
  if (!token) return;
  _cachedToken = token;

  setState('syncing');

  try {
    const result = await postCloudPrefs(token, variant, migrateLocalBlobIfNeeded(), getSyncVersion());

    if ('conflict' in result) {
      setState('conflict');
      const fresh = await fetchCloudPrefs(token, variant);
      if (fresh) {
        const migrated = applyMigrations(fresh.data, fresh.schemaVersion ?? 1);
        applyCloudBlob(migrated);
        setSyncVersion(fresh.syncVersion);
        // applyCloudBlob just put migrated data into local at CURRENT schema.
        setLocalSchemaVersion(CURRENT_PREFS_SCHEMA_VERSION);
        const retryResult = await postCloudPrefs(token, variant, buildCloudBlob(), fresh.syncVersion);
        if (!('conflict' in retryResult)) {
          setSyncVersion(retryResult.syncVersion);
          Storage.prototype.setItem.call(localStorage, KEY_LAST_SYNC_AT, String(Date.now()));
          setState('synced');
        } else {
          setState('conflict');
        }
      } else {
        setState('error');
      }
    } else {
      setSyncVersion(result.syncVersion);
      Storage.prototype.setItem.call(localStorage, KEY_LAST_SYNC_AT, String(Date.now()));
      setState('synced');
    }
  } catch (err) {
    if (err instanceof ServiceUnavailableError) {
      // Convex platform 503 — transient. Re-queue the upload after the
      // server-suggested delay so the unsaved blob isn't lost. Setting
      // 'pending' state matches the existing schedulePrefUpload UX.
      //
      // Generation guard: same as the onSignIn branch — if the user signs
      // out or switches accounts during the retry window, the timer fires
      // but the closure's captured `myGeneration` no longer matches, so
      // the retry aborts. Without this, the upload would re-fire against
      // a now-empty token cache or a different user's token.
      console.warn(`[cloud-prefs] uploadNow 503; retrying in ${err.retryAfterSec}s`);
      setState('pending');
      clearRetryTimer();
      _retryTimer = setTimeout(() => {
        _retryTimer = null;
        if (_authGeneration !== myGeneration) return;
        void uploadNow(variant);
      }, err.retryAfterSec * 1000);
      return;
    }
    console.warn('[cloud-prefs] uploadNow failed:', err);
    setState(!navigator.onLine || (err instanceof TypeError && err.message.includes('fetch')) ? 'offline' : 'error');
  }
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

export function getSyncState(): SyncState {
  return (localStorage.getItem(KEY_SYNC_STATE) as SyncState) || 'signed-out';
}

export function getLastSyncAt(): number {
  return parseInt(localStorage.getItem(KEY_LAST_SYNC_AT) ?? '0', 10) || 0;
}

// ── install ───────────────────────────────────────────────────────────────────

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
      schedulePrefUpload(_currentVariant);
    }
  };

  const originalRemoveItem = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function removeItem(key: string) {
    originalRemoveItem.call(this, key);
    if (this === localStorage && !_suppressPatch && CLOUD_SYNC_KEYS.includes(key as CloudSyncKey)) {
      schedulePrefUpload(_currentVariant);
    }
  };

  // Multi-tab: another tab wrote a newer syncVersion — cancel our pending upload
  window.addEventListener('storage', (e) => {
    if (e.key === KEY_SYNC_VERSION && e.newValue !== null) {
      const newV = parseInt(e.newValue, 10);
      if (newV > getSyncVersion()) {
        if (_debounceTimer !== null) {
          clearTimeout(_debounceTimer);
          _debounceTimer = null;
          setState('synced');
        }
        Storage.prototype.setItem.call(localStorage, KEY_SYNC_VERSION, e.newValue);
      }
    }
  });

  // Tab close: flush pending debounce via fetch with keepalive
  // (sendBeacon cannot send Authorization headers)
  const flushOnUnload = (): void => {
    if (_debounceTimer === null || !_cachedToken) return;
    clearTimeout(_debounceTimer);
    _debounceTimer = null;

    // Same defensive migration as the synchronous post paths — never stamp
    // CURRENT_PREFS_SCHEMA_VERSION onto unmigrated local data, even on
    // best-effort unload flush.
    const blob = migrateLocalBlobIfNeeded();
    const payload = JSON.stringify({ variant: _currentVariant, data: blob, expectedSyncVersion: getSyncVersion(), schemaVersion: CURRENT_PREFS_SCHEMA_VERSION });
    fetch('/api/user-prefs', {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${_cachedToken}`,
      },
      body: payload,
    }).catch(() => { /* best-effort on unload */ });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnUnload();
  });
  window.addEventListener('pagehide', flushOnUnload);
}
