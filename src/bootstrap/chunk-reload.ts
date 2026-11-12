// Reload once when the running bundle cannot load one of its own chunks.
//
// After a deploy, a tab on the old build asks for chunk filenames the new
// deploy no longer serves, and Vite dispatches `vite:preloadError`. One reload
// fetches the new index.html and recovers. A failure that survives that reload
// is not deploy skew (an ad blocker, a privacy proxy, a broken network path),
// and reloading again cannot fix it, so the guard allows ONE reload per build.
//
// The record of that reload must outlive the reload itself. It lives in
// sessionStorage, or in localStorage where sessionStorage is missing (Android
// WebView exposes `window.sessionStorage === null`). When neither can hold it,
// the guard does not reload at all: an in-memory flag dies with the page, so
// reloading on it would loop forever.
//
// The record is never cleared on a successful boot. Clearing it there re-armed
// the guard on every load, so a chunk that fails AFTER boot on every load (the
// deferred Sentry chunk behind an ad blocker) reloaded the page every ~10 s.
// A tab that stays open across a later deploy is recovered by
// stale-bundle-check.ts instead.
//
// A listener that calls `preventDefault()` on the event claims the failure as
// not deploy skew (sentry-defer.ts does this for its own chunk). The guard
// decides after every listener has run, so registration order does not matter.
//
// The reload does not wait for an open modal: see RELOAD_GUARD_EXEMPT in
// scripts/enforce-overlay-reload-policy.mjs (#8662).

interface EventTargetLike {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

interface ChunkReloadGuardOptions {
  eventTarget?: EventTargetLike;
  /**
   * Where the spent reload is recorded, most preferred first. Defaults to
   * sessionStorage then localStorage. Empty means nothing can persist the
   * record, and the guard never reloads.
   */
  storages?: readonly StorageLike[];
  eventName?: string;
  reload?: () => void;
}

/** Holds the build hash whose one reload has been spent. */
export const CHUNK_RELOAD_STORAGE_KEY = 'wm-chunk-reload';

function browserStorages(): StorageLike[] {
  const out: StorageLike[] = [];
  for (const name of ['sessionStorage', 'localStorage'] as const) {
    try {
      // Null on Android WebView without DOM storage; throws in sandboxed frames
      // or when cookies are blocked.
      const storage = window[name];
      if (storage) out.push(storage);
    } catch {
      // Try the next one.
    }
  }
  return out;
}

/**
 * Record that `version` spent its reload. False when it already had, or when
 * no storage could keep the record across the reload.
 */
function claimReload(storages: readonly StorageLike[], version: string): boolean {
  for (const storage of storages) {
    try {
      if (storage.getItem(CHUNK_RELOAD_STORAGE_KEY) === version) return false;
      storage.setItem(CHUNK_RELOAD_STORAGE_KEY, version);
      if (storage.getItem(CHUNK_RELOAD_STORAGE_KEY) === version) return true;
    } catch {
      // Read-only or quota-exceeded storage: try the next one.
    }
  }
  return false;
}

export function installChunkReloadGuard(version: string, options: ChunkReloadGuardOptions = {}): void {
  const eventName = options.eventName ?? 'vite:preloadError';
  const eventTarget = options.eventTarget ?? window;
  const reload = options.reload ?? (() => window.location.reload());

  eventTarget.addEventListener(eventName, (event) => {
    // Vite reads `defaultPrevented` synchronously after dispatch, so a
    // microtask runs after every listener had its chance to claim the event.
    queueMicrotask(() => {
      if (event.defaultPrevented) return;
      if (!claimReload(options.storages ?? browserStorages(), version)) return;
      reload();
    });
  });
}
