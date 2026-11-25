/**
 * Whether the page is being torn down, so `beforeSend` can drop the network
 * failures the teardown itself causes.
 *
 * A reload or navigation aborts every in-flight fetch, and WebKit rejects each
 * one with `TypeError: Load failed`. A first-party call site that claimed its
 * failure with a `kind` tag then reports a real-looking outage in the same
 * millisecond the page goes away (Sentry WORLDMONITOR-1AY: the update toast's
 * reload, the stale-bundle reload, and a tab close all produced it).
 *
 * The listeners mark the page at `beforeunload` and `pagehide`. That was
 * meant to land before the aborted fetches reject, but on WebKit it did not:
 * after a `[stale-bundle] reload`, every in-flight API fetch failed within
 * milliseconds and the scorecard capture still went out 828 ms later with the
 * flag unset (WORLDMONITOR-1AY). So the three bootstrap updaters
 * (stale-bundle-check, chunk-reload, sw-update) call `markPageUnloading()`
 * immediately before `reload()`; other reloads and navigations still rely on
 * the events. The window is bounded because a marked
 * navigation can fail to happen (a cancelled prompt, a download link, a
 * blocked reload); a failure after the window reports normally. `pageshow`
 * clears it when a bfcache page comes back.
 */
const UNLOAD_WINDOW_MS = 3_000;

let unloadStartedAt: number | null = null;
let installed = false;

type UnloadTarget = Pick<Window, 'addEventListener'>;

export function installPageUnloadSignal(target: UnloadTarget | undefined = typeof window === 'undefined' ? undefined : window): void {
  if (installed || !target) return;
  installed = true;
  const mark = (): void => { markPageUnloading(); };
  target.addEventListener('beforeunload', mark);
  target.addEventListener('pagehide', mark);
  target.addEventListener('pageshow', () => { unloadStartedAt = null; });
}

/** Open the unload window now. Call immediately before a first-party reload. */
export function markPageUnloading(now: number = Date.now()): void {
  unloadStartedAt = now;
}

export function isPageUnloading(now: number = Date.now()): boolean {
  return unloadStartedAt !== null && now - unloadStartedAt >= 0 && now - unloadStartedAt <= UNLOAD_WINDOW_MS;
}

export function _resetPageUnloadSignalForTests(): void {
  unloadStartedAt = null;
  installed = false;
}
