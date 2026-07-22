const buildVariant = (() => {
  try {
    return import.meta.env.VITE_VARIANT || 'full';
  } catch {
    return 'full';
  }
})();

function loadStoredVariant(): string | null {
  try {
    return localStorage.getItem('worldmonitor-variant');
  } catch {
    return null;
  }
}

export const SITE_VARIANT: string = (() => {
  if (typeof window === 'undefined') return buildVariant;

  const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
  if (isTauri) {
    const stored = loadStoredVariant();
    if (stored === 'tech' || stored === 'full' || stored === 'finance' || stored === 'happy' || stored === 'commodity' || stored === 'energy' || stored === 'india' || stored === 'cinema') return stored;
    return buildVariant;
  }

  const h = location.hostname;
  if (h.startsWith('tech.')) return 'tech';
  if (h.startsWith('finance.')) return 'finance';
  if (h.startsWith('happy.')) return 'happy';
  if (h.startsWith('commodity.')) return 'commodity';
  if (h.startsWith('energy.')) return 'energy';
  if (h.startsWith('india.')) return 'india';
  if (h.startsWith('cinema.')) return 'cinema';

  if (h === 'localhost' || h === '127.0.0.1') {
    // An explicit `VITE_VARIANT` (e.g. `npm run dev:india`) wins over any
    // previously stored variant so local variant testing is predictable.
    if (buildVariant !== 'full') return buildVariant;
    const stored = loadStoredVariant();
    if (stored === 'tech' || stored === 'full' || stored === 'finance' || stored === 'happy' || stored === 'commodity' || stored === 'energy' || stored === 'india' || stored === 'cinema') return stored;
    return buildVariant;
  }

  return 'full';
})();
