const buildVariant = (() => {
  try {
    return import.meta.env?.VITE_VARIANT || 'full';
  } catch {
    return 'full';
  }
})();

const VARIANTS = new Set([
  'tech', 'full', 'finance', 'happy', 'commodity', 'energy', 'usachina',
]);

/**
 * The stored variant override, or null.
 *
 * Guarded because this module is evaluated at import time and everything
 * imports it: an exception here happens before a single pixel is drawn and
 * takes the whole application with it. `localStorage` does not merely return
 * null when storage is unavailable — the ACCESSOR THROWS, in Safari with
 * "Block All Cookies", in a third-party iframe whose storage is partitioned
 * away, and in some webview privacy modes. The self-hosted branch below was
 * added for an OpenEye iframe, which is exactly one of those contexts.
 *
 * Same defensive shape as readSeen() in src/boot/boot-mode.ts, and for the
 * same reason: losing a preference is a nuisance, losing the app is not.
 */
function storedVariant(): string | null {
  try {
    const stored = localStorage.getItem('worldmonitor-variant');
    return stored && VARIANTS.has(stored) ? stored : null;
  } catch {
    return null;
  }
}

export const SITE_VARIANT: string = (() => {
  if (typeof window === 'undefined') return buildVariant;

  const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
  if (isTauri) return storedVariant() ?? buildVariant;

  const h = location.hostname;
  if (h.startsWith('tech.')) return 'tech';
  if (h.startsWith('finance.')) return 'finance';
  if (h.startsWith('happy.')) return 'happy';
  if (h.startsWith('commodity.')) return 'commodity';
  if (h.startsWith('energy.')) return 'energy';

  // Any other hostname is a self-hosted deployment (LAN IPs, AALICE:OpenEYE
  // iframe) — no variant subdomains exist there, so honor the same stored
  // override the Tauri/localhost paths use. Hosted worldmonitor.app domains
  // never reach this branch: their subdomains matched above.
  return storedVariant() ?? buildVariant;
})();
