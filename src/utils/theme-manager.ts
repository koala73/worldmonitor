import { invalidateColorCache } from './theme-colors';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'worldmonitor-theme';
const DEFAULT_THEME: Theme = 'dark';

/**
 * Read the stored theme preference from localStorage.
 * Returns 'dark' or 'light' if valid, otherwise DEFAULT_THEME.
 */
export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // localStorage unavailable (e.g., sandboxed iframe, private browsing)
  }
  return DEFAULT_THEME;
}

/**
 * Read the current theme from the document root's data-theme attribute.
 */
export function getCurrentTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  if (value === 'dark' || value === 'light') return value;
  return DEFAULT_THEME;
}

/**
 * Set the active theme: update DOM attribute, invalidate color cache,
 * persist to localStorage, update meta theme-color, and dispatch event.
 */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  invalidateColorCache();
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage unavailable
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.content = theme === 'dark' ? '#0a0f0a' : '#f8f9fa';
  }
  window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme } }));
}

/**
 * Apply the stored theme preference to the document before components mount.
 * Only sets the data-theme attribute and meta theme-color — does NOT dispatch
 * events or invalidate the color cache (components aren't mounted yet).
 */
export function applyStoredTheme(): void {
  const theme = getStoredTheme();
  if (theme !== DEFAULT_THEME) {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) {
      meta.content = '#f8f9fa';
    }
  }
}
