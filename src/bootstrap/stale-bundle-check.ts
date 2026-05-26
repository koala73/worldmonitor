// Force-reload tabs running a stale frontend bundle when a newer deploy is
// live. Catches the class of bug where users keep a tab open across a
// wire-shape change (e.g. PR #3466 fixing the setPreferences CONFLICT
// propagation) and end up in a permanent retry loop against the new server
// because their JS doesn't understand the new response shape.
//
// Mechanism: on tab focus, fetch /build-hash.txt (a static asset emitted by
// the Vite plugin in vite.config.ts at build time, content = the deployed
// SHA) and compare against __BUILD_HASH__ baked into the running bundle.
// Mismatch → hard reload.
//
// /build-hash.txt is intentionally NOT under /api/* so installWebApiRedirect
// does NOT rewrite it to the canonical API host — it stays same-origin with
// the bundle, which is the correct comparison target.

interface EventTargetLike {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

interface DocumentLike {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  visibilityState?: string;
}

interface StaleBundleCheckOptions {
  /** Hash baked into the running bundle (default: __BUILD_HASH__). */
  currentHash?: string;
  /** Override fetch (for tests). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Override window-level event target (default: window). */
  eventTarget?: EventTargetLike;
  /** Override document for visibilitychange (default: document). */
  documentTarget?: DocumentLike;
  /** Override setInterval (for tests). Default: globalThis.setInterval. */
  setInterval?: (cb: () => void, ms: number) => unknown;
  /** Override reload (for tests). Default: window.location.reload(). */
  reload?: () => void;
  /** Override clock (for tests). Default: Date.now. */
  now?: () => number;
  /**
   * Minimum interval between checks. Multiple events within this window
   * collapse to one fetch.
   */
  minIntervalMs?: number;
  /**
   * Wall-clock cadence of the periodic background check. Catches stuck
   * tabs that never fire focus/visibilitychange (e.g. a tab pinned in
   * the background of another window). Browsers throttle background
   * setIntervals to ~1min minimum resolution, so values below that are
   * effectively the same as 60_000ms.
   */
  periodicIntervalMs?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 60_000;
/** Wall-clock periodic check. 10min is plenty for stale-bundle detection
 *  (we don't need second-level latency to reload an old bundle) and
 *  respects browser background-tab throttling. */
const DEFAULT_PERIODIC_INTERVAL_MS = 10 * 60_000;

/**
 * Install listeners that compare the running bundle's hash against the
 * deployed hash and reload on mismatch. Three trigger paths:
 *   1. window `focus` — user switches BACK to the tab
 *   2. document `visibilitychange` — tab goes background→foreground
 *      (fires for some background→foreground transitions that don't
 *      raise window focus, e.g. tab activation within the same window)
 *   3. periodic setInterval — catches tabs pinned in the background of
 *      another window that never receive focus/visibilitychange. Browser
 *      background throttling means actual cadence is ~1min minimum, but
 *      that's fine for stale-bundle detection.
 *
 * All three paths funnel through a `check()` that's deduped by
 * `minIntervalMs` — multiple triggers within the dedupe window collapse
 * to one fetch.
 *
 * The `focus`-only design from PR #3499 missed background-tab users:
 * one user (Sentry user_id user_3Cu7uZZJEeVSoUjv9SBn4BEv1...) hammered
 * setPreferences at ~16 calls/min from 2026-04-30 04:20 UTC onward with
 * a constant `actualSyncVersion: 20`, never refocusing the tab and so
 * never triggering the reload. Adding visibilitychange + setInterval
 * closes the gap.
 *
 * Returns a disposer function that clears the periodic timer (used in
 * tests).
 */
export function installStaleBundleCheck(options: StaleBundleCheckOptions = {}): () => void {
  const currentHash = options.currentHash ?? (typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev');
  // Arrow-function wrapper instead of fetch.bind(globalThis) (banned per
  // AGENTS.md §Critical Conventions). Same effect — preserves the global
  // `this` for fetch — without the brittle .bind() form.
  const fetchImpl: typeof globalThis.fetch =
    options.fetch ?? ((...args) => globalThis.fetch(...args));
  const eventTarget = options.eventTarget ?? window;
  const documentTarget = options.documentTarget ?? (typeof document !== 'undefined' ? document : undefined);
  const setIntervalImpl = options.setInterval ?? ((cb: () => void, ms: number) => globalThis.setInterval(cb, ms));
  const reload = options.reload ?? (() => window.location.reload());
  const now = options.now ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const periodicIntervalMs = options.periodicIntervalMs ?? DEFAULT_PERIODIC_INTERVAL_MS;

  // 'dev' marker means we're running a local build that didn't get a real
  // SHA injected. Skip the check entirely in that case — comparing 'dev'
  // against any deployed SHA would force-reload every dev tab on focus.
  if (currentHash === 'dev') {
    return () => {};
  }

  let lastCheckedAt = 0;
  let inflight = false;

  const check = async (): Promise<void> => {
    const t = now();
    if (t - lastCheckedAt < minIntervalMs) return;
    if (inflight) return;
    lastCheckedAt = t;
    inflight = true;
    try {
      // Cache-bust to defeat any intermediate proxy that might serve a
      // stale build-hash.txt (the file itself is emitted with the deploy).
      const res = await fetchImpl(`/build-hash.txt?t=${t}`, { cache: 'no-store' });
      if (!res.ok) return;
      const deployedHash = (await res.text()).trim();
      if (!deployedHash || deployedHash === 'dev') return;
      if (deployedHash !== currentHash) {
        // eslint-disable-next-line no-console
        console.warn('[stale-bundle] reload:', currentHash, '→', deployedHash);
        reload();
      }
    } catch {
      // Offline, network error, or non-OK response — silently skip.
      // The next trigger will retry.
    } finally {
      inflight = false;
    }
  };

  const focusHandler: EventListener = () => {
    void check();
  };
  eventTarget.addEventListener('focus', focusHandler);

  // visibilitychange fires when the tab becomes visible again. We only
  // want to trigger on the visible side (not on hide), so gate with the
  // documentTarget's visibilityState. Closure references documentTarget so
  // the predicate uses the live state at fire time, not at install time.
  const visibilityHandler: EventListener = documentTarget
    ? () => {
        if (documentTarget.visibilityState === 'visible') void check();
      }
    : () => {};
  if (documentTarget) {
    documentTarget.addEventListener('visibilitychange', visibilityHandler);
  }

  // Periodic safety net for background tabs that never receive
  // focus/visibilitychange (e.g. pinned in a background window).
  const intervalHandle = setIntervalImpl(() => void check(), periodicIntervalMs);

  return () => {
    // Full cleanup. Production currently calls installStaleBundleCheck
    // exactly once at boot, but a complete disposer protects against
    // future hot-reload / test-helper reuse where double-install would
    // otherwise leave orphaned listeners firing against stale targets.
    eventTarget.removeEventListener('focus', focusHandler);
    if (documentTarget) {
      documentTarget.removeEventListener('visibilitychange', visibilityHandler);
    }
    if (intervalHandle && typeof clearInterval === 'function') {
      clearInterval(intervalHandle as unknown as ReturnType<typeof setInterval>);
    }
  };
}
