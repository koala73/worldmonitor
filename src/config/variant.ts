export const SITE_VARIANT: string = (() => {
  const env = import.meta.env.VITE_VARIANT || 'full';
  // Desktop app: always respect localStorage so variant switcher works
  // (desktop builds may inherit VITE_VARIANT from .env.local).
  if (typeof window !== 'undefined') {
    const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
    if (isTauri) {
      const stored = localStorage.getItem('worldmonitor-variant');
      if (stored === 'tech' || stored === 'full' || stored === 'finance' || stored === 'happy') return stored;
    }
  }
  // Web deployments: build-time variant (non-full) takes priority — each deployment is variant-specific.
  if (env !== 'full') return env;
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('worldmonitor-variant');
    if (stored === 'tech' || stored === 'full' || stored === 'finance' || stored === 'happy') return stored;
  }
  return env;
})();
