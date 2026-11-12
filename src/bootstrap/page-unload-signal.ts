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
 * `beforeunload` fires synchronously inside `location.reload()` and every
 * navigation, before the browser aborts those fetches, so it is set before any
 * of the rejections run. The window is bounded because `beforeunload` also
 * fires for navigations that never happen (a cancelled prompt, a download
 * link); a failure after the window reports normally. `pageshow` clears it
 * when a bfcache page comes back.
 */
const UNLOAD_WINDOW_MS = 3_000;

let unloadStartedAt: number | null = null;
let installed = false;

type UnloadTarget = Pick<Window, 'addEventListener'>;

export function installPageUnloadSignal(target: UnloadTarget | undefined = typeof window === 'undefined' ? undefined : window): void {
  if (installed || !target) return;
  installed = true;
  const mark = (): void => { unloadStartedAt = Date.now(); };
  target.addEventListener('beforeunload', mark);
  target.addEventListener('pagehide', mark);
  target.addEventListener('pageshow', () => { unloadStartedAt = null; });
}

export function isPageUnloading(now: number = Date.now()): boolean {
  return unloadStartedAt !== null && now - unloadStartedAt >= 0 && now - unloadStartedAt <= UNLOAD_WINDOW_MS;
}

export function _resetPageUnloadSignalForTests(): void {
  unloadStartedAt = null;
  installed = false;
}
