/**
 * Theme management utilities for World Monitor
 * Handles dark/light mode switching with persistence and DOM synchronization
 * @module utils/theme-manager
 */

import { invalidateColorCache } from './theme-colors';

/** Valid theme values */
export type Theme = 'dark' | 'light';

/** localStorage key for theme preference */
const STORAGE_KEY = 'worldmonitor-theme';

/** Default theme when no preference is stored */
const DEFAULT_THEME: Theme = 'dark';

/**
 * Retrieves the user's stored theme preference from localStorage.
 * Falls back to DEFAULT_THEME if no valid preference exists or if localStorage is unavailable.
 * 
 * @returns {Theme} The stored theme ('dark' | 'light') or default
 * @example
 * const theme = getStoredTheme();
 * // Returns: 'dark' or 'light' based on user preference
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
 * Gets the currently active theme from the DOM.
 * Reads the data-theme attribute from the document root element.
 * 
 * @returns {Theme} The current active theme
 * @example
 * const currentTheme = getCurrentTheme();
 * console.log(currentTheme); // 'dark' or 'light'
 */
export function getCurrentTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  if (value === 'dark' || value === 'light') return value;
  return DEFAULT_THEME;
}

/**
 * Applies a theme to the application with full synchronization.
 * 
 * This function:
 * - Updates the DOM data-theme attribute
 * - Invalidates the color cache for theme-aware components
 * - Persists the preference to localStorage
 * - Updates the meta theme-color for mobile browsers
 * - Dispatches a 'theme-changed' event for reactive components
 * 
 * @param {Theme} theme - The theme to apply ('dark' | 'light')
 * @returns {void}
 * @example
 * setTheme('light');
 * // Applies light theme, updates localStorage, fires theme-changed event
 */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  invalidateColorCache();
  
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage unavailable (e.g., private browsing)
  }
  
  // Update meta theme-color for mobile browser theming
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    const variant = document.documentElement.dataset.variant;
    const darkColor = variant === 'happy' ? '#1A2332' : '#0a0f0a';
    const lightColor = variant === 'happy' ? '#FAFAF5' : '#f8f9fa';
    meta.content = theme === 'dark' ? darkColor : lightColor;
  }
  
  // Notify components that theme has changed
  window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme } }));
}
