/**
 * "Am I running inside the Tauri desktop shell?" — and nothing else.
 *
 * This detector lives in config because configuration is its lowest consumer:
 * variant and basemap selection both run before the services layer is ready.
 * Keep it dependency-free so those modules remain safe at first paint.
 */

// Named keys only, never the whole `import.meta.env` object, so no unrelated
// build-time value can reach client code. Enforced by
// tests/runtime-env-guards.test.mjs.
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
