const buildVariant = (() => {
  try {
    return import.meta.env?.VITE_VARIANT || 'full';
  } catch {
    return 'full';
  }
})();

export const SITE_VARIANT: string = (() => {
  if (typeof window === 'undefined') return buildVariant;

  const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
  if (isTauri) {
    const stored = localStorage.getItem('worldmonitor-variant');
    if (stored === 'tech' || stored === 'full' || stored === 'finance' || stored === 'happy' || stored === 'commodity' || stored === 'energy') return stored;
    return buildVariant;
  }

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
  const stored = localStorage.getItem('worldmonitor-variant');
  if (stored === 'tech' || stored === 'full' || stored === 'finance' || stored === 'happy' || stored === 'commodity' || stored === 'energy') return stored;
  return buildVariant;
})();
