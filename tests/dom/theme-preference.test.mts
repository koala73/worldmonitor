import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyStoredTheme, getCurrentTheme, getThemePreference, setTheme, setThemePreference } from '@/utils/theme-manager';

let light = false;
let listeners: Set<() => void>;
beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.variant = 'full';
  listeners = new Set();
  light = false;
  vi.spyOn(window, 'matchMedia').mockImplementation(() => ({
    get matches() { return light; },
    addEventListener: (_type: string, handler: () => void) => { listeners.add(handler); },
    removeEventListener: (_type: string, handler: () => void) => { listeners.delete(handler); },
  } as unknown as MediaQueryList));
});
afterEach(() => { setTheme('dark'); vi.restoreAllMocks(); localStorage.clear(); });

function changeSystemTheme(matches: boolean) {
  light = matches;
  for (const listener of [...listeners]) listener();
}

describe('Auto theme preference', () => {
  it('preserves Auto while applying and following the system theme', () => {
    setThemePreference('auto');
    expect(getThemePreference()).toBe('auto');
    expect(getCurrentTheme()).toBe('dark');
    changeSystemTheme(true);
    expect(getCurrentTheme()).toBe('light');
    expect(getThemePreference()).toBe('auto');
  });

  it('restores one listener at startup and releases it for an explicit theme', () => {
    localStorage.setItem('worldmonitor-theme', 'auto');
    const changed = vi.fn();
    window.addEventListener('theme-changed', changed);
    try {
      applyStoredTheme();
      applyStoredTheme();
      expect(listeners.size).toBe(1);
      expect(changed).not.toHaveBeenCalled();
      changeSystemTheme(true);
      expect(getCurrentTheme()).toBe('light');
      expect(changed).toHaveBeenCalledTimes(1);
      setTheme('dark');
      expect(getThemePreference()).toBe('dark');
      expect(listeners.size).toBe(0);
      changeSystemTheme(true);
      expect(getCurrentTheme()).toBe('dark');
    } finally { window.removeEventListener('theme-changed', changed); }
  });

  it('retains the first-visit Happy light default', () => {
    document.documentElement.dataset.variant = 'happy';
    applyStoredTheme();
    expect(getCurrentTheme()).toBe('light');
    expect(localStorage.getItem('worldmonitor-theme')).toBeNull();
  });
});
