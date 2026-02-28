export const SITE_VARIANT: string = (() => {
  const env = import.meta.env.VITE_VARIANT || 'full';
  // Build-time variant (non-full) takes priority — each deployment is variant-specific.
  // Only fall back to localStorage when env is 'full' (allows desktop app variant switching).
  if (env !== 'full') return env;
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('worldmonitor-variant');
    if (stored === 'tech' || stored === 'full' || stored === 'finance' || stored === 'happy' || stored === 'opensens') return stored;
  }
  return env;
})();
