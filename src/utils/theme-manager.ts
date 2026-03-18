import { invalidateColorCache } from './theme-colors';

export type Theme = 'dark' | 'light';
export type ThemePreference = 'auto' | 'dark' | 'light';

const STORAGE_KEY = 'worldmonitor-theme';
const DEFAULT_THEME: Theme = 'dark';

function resolveThemeColor(theme: Theme, variant: string | undefined): string {
  if (theme === 'dark') return variant === 'happy' ? '#1A2332' : '#0a0f0a';
  return variant === 'happy' ? '#FAFAF5' : '#f8f9fa';
}

function updateThemeMetaColor(theme: Theme, variant = document.documentElement.dataset.variant): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = resolveThemeColor(theme, variant);
}

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

export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'auto' || stored === 'dark' || stored === 'light') return stored;
  } catch { /* noop */ }
  return 'auto';
}

function resolveAutoTheme(): Theme {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

let autoMediaQuery: MediaQueryList | null = null;
let autoMediaHandler: (() => void) | null = null;

function teardownAutoListener(): void {
  if (autoMediaQuery && autoMediaHandler) {
    autoMediaQuery.removeEventListener('change', autoMediaHandler);
    autoMediaQuery = null;
    autoMediaHandler = null;
  }
}

export function setThemePreference(pref: ThemePreference): void {
  try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* noop */ }
  teardownAutoListener();
  const effective: Theme = pref === 'auto' ? resolveAutoTheme() : pref;
  setTheme(effective);
  if (pref === 'auto' && typeof window !== 'undefined' && window.matchMedia) {
    autoMediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    autoMediaHandler = () => setTheme(resolveAutoTheme());
    autoMediaQuery.addEventListener('change', autoMediaHandler);
  }
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
  updateThemeMetaColor(theme);
  window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme } }));
}

/**
 * Apply the stored theme preference to the document before components mount.
 * Only sets the data-theme attribute and meta theme-color — does NOT dispatch
 * events or invalidate the color cache (components aren't mounted yet).
 *
 * The inline script in index.html already handles the fast FOUC-free path.
 * This is a safety net for cases where the inline script didn't run.
 */
export function applyStoredTheme(): void {
  const variant = document.documentElement.dataset.variant;

  // Check raw localStorage to distinguish "no preference" from "explicitly chose dark"
  let raw: string | null = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* noop */ }
  const hasExplicitPreference = raw === 'dark' || raw === 'light' || raw === 'auto';

  let effective: Theme;
  if (raw === 'auto') {
    effective = resolveAutoTheme();
  } else if (hasExplicitPreference) {
    effective = raw as Theme;
  } else {
    // No stored preference: happy defaults to light, others to dark
    effective = variant === 'happy' ? 'light' : DEFAULT_THEME;
  }

  document.documentElement.dataset.theme = effective;
  updateThemeMetaColor(effective, variant);
}
