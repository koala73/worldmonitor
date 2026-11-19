/**
 * #5912: `SITE_VARIANT` used to decide "am I on desktop?" with a raw
 * `'__TAURI__' in window` check, while the in-app variant switcher
 * (src/app/event-handlers.ts) writes `worldmonitor-variant` behind
 * `isDesktopRuntime()`. The two disagree exactly where a Tauri window has no
 * bridge globals yet — first paint on a `tauri.localhost` origin, the
 * `desktop:dev` early-boot path — so the stored variant the switcher had just
 * written was read back as web and ignored.
 *
 * These tests import `@/config/variant` fresh under each probe. They assert
 * agreement with the detector rather than a fixed truth table, so a signal
 * added to `desktop-runtime.ts` cannot re-open the split.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type Probe = { protocol: string; host: string; origin: string; tauriGlobals: boolean };

const TAURI_HOST_NO_GLOBALS: Probe = {
  protocol: 'https:',
  host: 'tauri.localhost',
  origin: 'https://tauri.localhost',
  tauriGlobals: false,
};
const WEB: Probe = {
  protocol: 'https:',
  host: 'worldmonitor.app',
  origin: 'https://worldmonitor.app',
  tauriGlobals: false,
};

/**
 * `variant.ts` reads the bare `localStorage` global. Under this Node runtime
 * that global is Node's own experimental Web Storage stub (no methods until
 * `--localstorage-file` is set), not happy-dom's `window.localStorage`, so the
 * test owns the store: a Map-backed Storage installed on the global.
 */
function memoryStorage(seed: Record<string, string>): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key); },
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
  } as Storage;
}

function installProbe(probe: Probe, stored: string | null): void {
  vi.stubGlobal('localStorage', memoryStorage(stored ? { 'worldmonitor-variant': stored } : {}));
  vi.stubGlobal('location', {
    protocol: probe.protocol,
    host: probe.host,
    hostname: probe.host.split(':')[0],
    origin: probe.origin,
  });
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0' });
  if (probe.tauriGlobals) vi.stubGlobal('__TAURI_INTERNALS__', {});
}

async function siteVariantUnder(probe: Probe, stored: string | null): Promise<{ variant: string; desktop: boolean }> {
  installProbe(probe, stored);
  vi.resetModules();
  const [{ SITE_VARIANT }, { isDesktopRuntime }] = await Promise.all([
    import('@/config/variant'),
    import('@/services/desktop-runtime'),
  ]);
  return { variant: SITE_VARIANT, desktop: isDesktopRuntime() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SITE_VARIANT desktop detection converges on isDesktopRuntime (#5912)', () => {
  it('honours the stored variant on a Tauri host whose bridge globals have not attached yet', async () => {
    const { variant, desktop } = await siteVariantUnder(TAURI_HOST_NO_GLOBALS, 'finance');
    // Premise guard: the detector must call this origin desktop, or the case
    // is not exercising the split the raw check had.
    expect(desktop).toBe(true);
    expect(variant).toBe('finance');
  });

  it('falls back to the build variant on desktop when nothing is stored', async () => {
    const { variant } = await siteVariantUnder(TAURI_HOST_NO_GLOBALS, null);
    expect(variant).toBe('full');
  });

  it('ignores a stored variant on the public web origin and resolves from the hostname', async () => {
    const { variant, desktop } = await siteVariantUnder(WEB, 'finance');
    expect(desktop).toBe(false);
    expect(variant).toBe('full');
  });

  it('agrees with the detector on whether a stored variant is honoured, for every probe', async () => {
    const probes: Probe[] = [
      TAURI_HOST_NO_GLOBALS,
      WEB,
      { protocol: 'tauri:', host: 'localhost', origin: 'tauri://localhost', tauriGlobals: false },
      { protocol: 'https:', host: 'tech.worldmonitor.app', origin: 'https://tech.worldmonitor.app', tauriGlobals: false },
      { protocol: 'https:', host: 'worldmonitor.app', origin: 'https://worldmonitor.app', tauriGlobals: true },
    ];
    for (const probe of probes) {
      const { variant, desktop } = await siteVariantUnder(probe, 'energy');
      expect(variant === 'energy', `probe ${probe.origin} globals=${probe.tauriGlobals}`).toBe(desktop);
    }
  });
});
