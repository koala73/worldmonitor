export type FontStyle = 'mono' | 'system';

const STORAGE_KEY = 'worldmonitor-font';
const DEFAULT_FONT: FontStyle = 'mono';

/**
 * Read the stored font preference from localStorage.
 * Returns 'mono' or 'system' if valid, otherwise DEFAULT_FONT.
 */
export function getFontPreference(): FontStyle {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === 'mono' || stored === 'system') return stored;
    } catch { /* noop */ }
    return DEFAULT_FONT;
}

/**
 * Set the active font style: update DOM attribute, persist to localStorage,
 * and dispatch a custom event for any listeners.
 */
export function setFontPreference(pref: FontStyle): void {
    try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* noop */ }
    document.documentElement.setAttribute('data-font', pref);
    window.dispatchEvent(new CustomEvent('font-changed', { detail: { font: pref } }));
}

/**
 * Apply the stored font preference to the document before components mount.
 * Safety net for cases where the inline script in index.html didn't run.
 */
export function applyStoredFont(): void {
    const pref = getFontPreference();
    document.documentElement.setAttribute('data-font', pref);
}
