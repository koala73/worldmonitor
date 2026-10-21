/**
 * `hasExplicitDesktopSignals()` must differ from `detectDesktopRuntime()` on
 * exactly ONE input: a bare secure-loopback origin.
 *
 * That is the whole reason it exists — `https://localhost` is ambiguous between
 * a Tauri window that has not exposed its bridge globals yet and a dev server
 * running over HTTPS, and the API-base guard in `runtime.ts` must read it as
 * the latter. Every other desktop signal has to agree between the two.
 *
 * Stated as an agreement contract rather than a list of expected booleans so a
 * signal added to one function and not the other fails here, instead of
 * silently narrowing the guard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectDesktopRuntime, hasExplicitDesktopSignals } from '@/services/desktop-runtime';

type Probe = Parameters<typeof detectDesktopRuntime>[0];

function probeOf(overrides: Partial<Probe>): Probe {
  return {
    hasTauriGlobals: false,
    userAgent: 'Mozilla/5.0',
    locationProtocol: 'https:',
    locationHost: 'worldmonitor.app',
    locationOrigin: 'https://worldmonitor.app',
    ...overrides,
  };
}

/** Puts the probe on the globals both functions read, then evaluates the live one. */
function explicitSignalsFor(probe: Probe): boolean {
  if (probe.hasTauriGlobals) vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.stubGlobal('navigator', { userAgent: probe.userAgent });
  vi.stubGlobal('location', {
    protocol: probe.locationProtocol,
    host: probe.locationHost,
    hostname: probe.locationHost.split(':')[0],
    origin: probe.locationOrigin,
  });
  return hasExplicitDesktopSignals();
}

const UNAMBIGUOUS: Array<[string, Partial<Probe>]> = [
  ['tauri bridge globals', { hasTauriGlobals: true }],
  ['Tauri in the user agent', { userAgent: 'Mozilla/5.0 Tauri/2.0' }],
  ['tauri: protocol', {
    locationProtocol: 'tauri:',
    locationHost: 'localhost',
    locationOrigin: 'tauri://localhost',
  }],
  ['asset: protocol', {
    locationProtocol: 'asset:',
    locationHost: 'localhost',
    locationOrigin: 'asset://localhost',
  }],
  ['tauri.localhost host', {
    locationHost: 'tauri.localhost',
    locationOrigin: 'https://tauri.localhost',
  }],
  ['a tauri.localhost subdomain', {
    locationHost: 'app.tauri.localhost',
    locationOrigin: 'https://app.tauri.localhost',
  }],
  ['a tauri:// origin reported without the protocol', {
    locationProtocol: '',
    locationHost: 'localhost',
    locationOrigin: 'tauri://localhost',
  }],
];

const NON_DESKTOP: Array<[string, Partial<Probe>]> = [
  ['a deployed web page', {}],
  ['an http loopback dev server', {
    locationProtocol: 'http:',
    locationHost: 'localhost:5173',
    locationOrigin: 'http://localhost:5173',
  }],
];

const AMBIGUOUS: Array<[string, Partial<Probe>]> = [
  ['https://localhost', {
    locationHost: 'localhost',
    locationOrigin: 'https://localhost',
  }],
  ['https://127.0.0.1 with a port', {
    locationHost: '127.0.0.1:5173',
    locationOrigin: 'https://127.0.0.1:5173',
  }],
];

describe('hasExplicitDesktopSignals agrees with detectDesktopRuntime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const [name, overrides] of UNAMBIGUOUS) {
    it(`treats ${name} as desktop, like the detector`, () => {
      const probe = probeOf(overrides);

      expect(detectDesktopRuntime(probe)).toBe(true);
      expect(explicitSignalsFor(probe)).toBe(true);
    });
  }

  for (const [name, overrides] of NON_DESKTOP) {
    it(`treats ${name} as web, like the detector`, () => {
      const probe = probeOf(overrides);

      expect(detectDesktopRuntime(probe)).toBe(false);
      expect(explicitSignalsFor(probe)).toBe(false);
    });
  }

  for (const [name, overrides] of AMBIGUOUS) {
    it(`deliberately disagrees with the detector about ${name}`, () => {
      const probe = probeOf(overrides);

      expect(detectDesktopRuntime(probe)).toBe(true);
      expect(explicitSignalsFor(probe)).toBe(false);
    });
  }
});
