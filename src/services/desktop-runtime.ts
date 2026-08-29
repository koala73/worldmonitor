/**
 * "Am I running inside the Tauri desktop shell?" — and nothing else.
 *
 * Extracted from `runtime.ts` (#5911) because that module also owns API base
 * URLs and the desktop fetch patch, so it imports `@/config/variant` and
 * `@/services/clerk`. Anything that needs only this boolean — the external-URL
 * router, checkout — would otherwise drag that whole graph in, which both
 * widens bundles and makes the module unimportable in test harnesses that stub
 * a partial browser environment (`config/variant.ts` reads `location` at
 * module scope).
 *
 * `runtime.ts` re-exports both functions, so existing importers are unaffected
 * and there is still one implementation.
 */

// Same guarded allow-list wrapper as `runtime.ts`: named keys only, never the
// whole `import.meta.env` object, so no unrelated build-time value can reach
// client code. Enforced for both files by tests/runtime-env-guards.test.mjs.
const ENV = (() => {
  try {
    return {
      VITE_DESKTOP_RUNTIME: import.meta.env.VITE_DESKTOP_RUNTIME,
    };
  } catch {
    return {} as Record<string, string | undefined>;
  }
})();

const FORCE_DESKTOP_RUNTIME = ENV.VITE_DESKTOP_RUNTIME === '1';

export type RuntimeProbe = {
  hasTauriGlobals: boolean;
  userAgent: string;
  locationProtocol: string;
  locationHost: string;
  locationOrigin: string;
};

/**
 * Signals an ordinary web page cannot produce.
 *
 * Sole owner of the list. Both public detectors below derive from it, so a
 * signal added here reaches each of them and the two cannot drift apart —
 * `tests/dom/desktop-runtime-explicit-signals.test.mts` holds them to that.
 */
function hasUnambiguousDesktopSignals(probe: RuntimeProbe): boolean {
  return probe.hasTauriGlobals
    || probe.userAgent.includes('Tauri')
    // Tauri production windows can expose tauri-like hosts/schemes without
    // always exposing bridge globals at first paint.
    || probe.locationProtocol === 'tauri:'
    || probe.locationProtocol === 'asset:'
    || probe.locationHost === 'tauri.localhost'
    || probe.locationHost.endsWith('.tauri.localhost')
    || probe.locationOrigin.startsWith('tauri://');
}

/**
 * A bare `https://localhost` origin — which a Tauri window may serve from
 * before its bridge globals appear, and which a dev server run over HTTPS is
 * equally entitled to. Desktop-ish, but never proof of desktop on its own.
 */
function isSecureLoopbackOrigin(probe: RuntimeProbe): boolean {
  return probe.locationProtocol === 'https:' && (
    probe.locationHost === 'localhost' ||
    probe.locationHost.startsWith('localhost:') ||
    probe.locationHost === '127.0.0.1' ||
    probe.locationHost.startsWith('127.0.0.1:')
  );
}

export function detectDesktopRuntime(probe: RuntimeProbe): boolean {
  return hasUnambiguousDesktopSignals(probe) || isSecureLoopbackOrigin(probe);
}

function currentProbe(): RuntimeProbe {
  return {
    hasTauriGlobals: '__TAURI_INTERNALS__' in window || '__TAURI__' in window,
    userAgent: window.navigator?.userAgent ?? '',
    locationProtocol: window.location?.protocol ?? '',
    locationHost: window.location?.host ?? '',
    locationOrigin: window.location?.origin ?? '',
  };
}

/**
 * Desktop signals an ordinary web page cannot produce.
 *
 * `detectDesktopRuntime` also accepts a bare `https://localhost` origin,
 * because a Tauri production window can serve from one before its bridge
 * globals appear at first paint. That heuristic cannot tell the shell apart
 * from a dev server running over HTTPS, so a caller that must distinguish
 * those two — rather than merely "might be desktop" — uses this instead.
 *
 * Shipped desktop builds set `VITE_DESKTOP_RUNTIME=1`
 * (.github/workflows/build-desktop.yml), so they answer true here without
 * relying on the location heuristic at all.
 */
export function hasExplicitDesktopSignals(): boolean {
  if (FORCE_DESKTOP_RUNTIME) {
    return true;
  }

  if (typeof window === 'undefined') {
    return false;
  }

  return hasUnambiguousDesktopSignals(currentProbe());
}

export function isDesktopRuntime(): boolean {
  if (FORCE_DESKTOP_RUNTIME) {
    return true;
  }

  if (typeof window === 'undefined') {
    return false;
  }

  return detectDesktopRuntime(currentProbe());
}
