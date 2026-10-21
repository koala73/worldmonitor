import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnifiedSettings } from '@/components/UnifiedSettings';

/**
 * Android WebView with DOM storage disabled exposes `window.localStorage` as
 * `null` instead of throwing, so a bare `localStorage.removeItem(...)` is a
 * TypeError there rather than a catchable storage failure (WORLDMONITOR-122).
 */
function withNullLocalStorage(): void {
  vi.stubGlobal('localStorage', null);
}

function createSettings(): UnifiedSettings {
  return new UnifiedSettings({
    getPanelSettings: () => ({}),
    savePanelSettings: () => {},
    getDisabledSources: () => new Set<string>(),
    toggleSource: () => {},
    setSourcesEnabled: () => {},
    getAllSourceNames: () => [],
    getLocalizedPanelName: (_key: string, fallback: string) => fallback,
    resetLayout: () => {},
    isDesktopApp: false,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UnifiedSettings under a null localStorage', () => {
  it('closes without throwing', () => {
    const settings = createSettings();
    withNullLocalStorage();

    expect(() => settings.close()).not.toThrow();
  });

  it('opens without throwing', () => {
    const settings = createSettings();
    withNullLocalStorage();

    expect(() => settings.open()).not.toThrow();
  });
});
