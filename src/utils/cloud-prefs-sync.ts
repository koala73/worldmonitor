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

const ENABLED = import.meta.env.VITE_CLOUD_PREFS_ENABLED === 'true';

// localStorage state keys — never uploaded to cloud
const KEY_SYNC_VERSION = 'wm-cloud-sync-version';
const KEY_LAST_SYNC_AT = 'wm-last-sync-at';
const KEY_SYNC_STATE = 'wm-cloud-sync-state';
const KEY_LAST_SIGNED_IN_AS = 'wm-last-signed-in-as';

const CURRENT_PREFS_SCHEMA_VERSION = 1;
const MIGRATIONS: Record<number, (data: Record<string, unknown>) => Record<string, unknown>> = {
  // Future: MIGRATIONS[2] = (data) => { ...transform... }
};

type SyncState = 'synced' | 'pending' | 'syncing' | 'conflict' | 'offline' | 'signed-out' | 'error';

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _currentVariant = 'full';
let _installed = false;
let _suppressPatch = false; // prevents applyCloudBlob from re-triggering upload
let _cachedToken: string | null = null; // synchronous token cache for flush()

// ── Guards ────────────────────────────────────────────────────────────────────

function isEnabled(): boolean {
  return ENABLED && !isDesktopRuntime();
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
  let result = data;
  for (let v = fromVersion + 1; v <= CURRENT_PREFS_SCHEMA_VERSION; v++) {
    result = MIGRATIONS[v]?.(result) ?? result;
  }
  return result;
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

async function fetchCloudPrefs(token: string, variant: string): Promise<CloudPrefs | null> {
  const res = await fetch(`/api/user-prefs?variant=${encodeURIComponent(variant)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`fetch prefs: ${res.status}`);
  return (await res.json()) as CloudPrefs | null;
}

async function postCloudPrefs(
  token: string,
  variant: string,
  data: Record<string, string>,
  expectedSyncVersion: number,
): Promise<{ syncVersion: number } | { conflict: true }> {
  const res = await fetch('/api/user-prefs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ variant, data, expectedSyncVersion, schemaVersion: CURRENT_PREFS_SCHEMA_VERSION }),
  });
  if (res.status === 409) return { conflict: true };
  if (!res.ok) throw new Error(`post prefs: ${res.status}`);
  return (await res.json()) as { syncVersion: number };
}

// ── Core logic ────────────────────────────────────────────────────────────────

export async function onSignIn(userId: string, variant: string): Promise<void> {
  if (!isEnabled()) return;

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
      applyCloudBlob(migrated);
      setSyncVersion(cloud.syncVersion);
      Storage.prototype.setItem.call(localStorage, KEY_LAST_SYNC_AT, String(Date.now()));

      if (isFirstEverSync && prevBlobJson && Object.keys(cloud.data).length > 0) {
        showUndoToast(prevBlobJson);
      }

      setState('synced');
    } else {
      const blob = buildCloudBlob();
      const result = await postCloudPrefs(token, variant, blob, getSyncVersion());

      if ('conflict' in result) {
        setState('conflict');
        const fresh = await fetchCloudPrefs(token, variant);
        if (fresh) {
          const migrated = applyMigrations(fresh.data, fresh.schemaVersion ?? 1);
          applyCloudBlob(migrated);
          setSyncVersion(fresh.syncVersion);
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
  _cachedToken = null;

  // Preserve prefs; only clear sync metadata
  localStorage.removeItem(KEY_SYNC_VERSION);
  localStorage.removeItem(KEY_LAST_SYNC_AT);
  setState('signed-out');
}

async function uploadNow(variant: string): Promise<void> {
  const token = await getClerkToken();
  if (!token) return;
  _cachedToken = token;

  setState('syncing');

  try {
    const result = await postCloudPrefs(token, variant, buildCloudBlob(), getSyncVersion());

    if ('conflict' in result) {
      setState('conflict');
      const fresh = await fetchCloudPrefs(token, variant);
      if (fresh) {
        const migrated = applyMigrations(fresh.data, fresh.schemaVersion ?? 1);
        applyCloudBlob(migrated);
        setSyncVersion(fresh.syncVersion);
        const retryResult = await postCloudPrefs(token, variant, buildCloudBlob(), fresh.syncVersion);
        if (!('conflict' in retryResult)) {
          setSyncVersion(retryResult.syncVersion);
          Storage.prototype.setItem.call(localStorage, KEY_LAST_SYNC_AT, String(Date.now()));
        }
        setState('synced');
      } else {
        setState('error');
      }
    } else {
      setSyncVersion(result.syncVersion);
      Storage.prototype.setItem.call(localStorage, KEY_LAST_SYNC_AT, String(Date.now()));
      setState('synced');
    }
  } catch (err) {
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

    const blob = buildCloudBlob();
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
