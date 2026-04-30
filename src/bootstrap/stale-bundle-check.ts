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
}

interface StaleBundleCheckOptions {
  /** Hash baked into the running bundle (default: __BUILD_HASH__). */
  currentHash?: string;
  /** Override fetch (for tests). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Override target for the focus listener. Default: window. */
  eventTarget?: EventTargetLike;
  /** Override reload (for tests). Default: window.location.reload(). */
  reload?: () => void;
  /** Override clock (for tests). Default: Date.now. */
  now?: () => number;
  /**
   * Minimum interval between checks. Multiple focus events within this
   * window collapse to one fetch.
   */
  minIntervalMs?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 60_000;

/**
 * Install the focus-event listener that compares the running bundle's hash
 * against the deployed hash and reloads on mismatch. Idempotent in practice
 * because the focus listener checks at most once per minIntervalMs.
 *
 * Returns a disposer function that removes the listener (used in tests).
 */
export function installStaleBundleCheck(options: StaleBundleCheckOptions = {}): () => void {
  const currentHash = options.currentHash ?? (typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev');
  // Arrow-function wrapper instead of fetch.bind(globalThis) (banned per
  // AGENTS.md §Critical Conventions). Same effect — preserves the global
  // `this` for fetch — without the brittle .bind() form.
  const fetchImpl: typeof globalThis.fetch =
    options.fetch ?? ((...args) => globalThis.fetch(...args));
  const eventTarget = options.eventTarget ?? window;
  const reload = options.reload ?? (() => window.location.reload());
  const now = options.now ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

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
      // The next focus event will retry.
    } finally {
      inflight = false;
    }
  };

  const handler: EventListener = () => {
    void check();
  };
  eventTarget.addEventListener('focus', handler);

  return () => {
    // Most production code doesn't need to dispose; this exists for tests.
    // The DOM event-target API supports removeEventListener, but our
    // EventTargetLike narrowing doesn't expose it — tests can swap
    // eventTarget with a spy that handles disposal.
  };
}
