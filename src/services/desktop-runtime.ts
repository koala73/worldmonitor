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

export function detectDesktopRuntime(probe: RuntimeProbe): boolean {
  const tauriInUserAgent = probe.userAgent.includes('Tauri');
  const secureLocalhostOrigin = (
    probe.locationProtocol === 'https:' && (
      probe.locationHost === 'localhost' ||
      probe.locationHost.startsWith('localhost:') ||
      probe.locationHost === '127.0.0.1' ||
      probe.locationHost.startsWith('127.0.0.1:')
    )
  );

  // Tauri production windows can expose tauri-like hosts/schemes without
  // always exposing bridge globals at first paint.
  const tauriLikeLocation = (
    probe.locationProtocol === 'tauri:' ||
    probe.locationProtocol === 'asset:' ||
    probe.locationHost === 'tauri.localhost' ||
    probe.locationHost.endsWith('.tauri.localhost') ||
    probe.locationOrigin.startsWith('tauri://') ||
    secureLocalhostOrigin
  );

  return probe.hasTauriGlobals || tauriInUserAgent || tauriLikeLocation;
}

export function isDesktopRuntime(): boolean {
  if (FORCE_DESKTOP_RUNTIME) {
    return true;
  }

  if (typeof window === 'undefined') {
    return false;
  }

  return detectDesktopRuntime({
    hasTauriGlobals: '__TAURI_INTERNALS__' in window || '__TAURI__' in window,
    userAgent: window.navigator?.userAgent ?? '',
    locationProtocol: window.location?.protocol ?? '',
    locationHost: window.location?.host ?? '',
    locationOrigin: window.location?.origin ?? '',
  });
}
