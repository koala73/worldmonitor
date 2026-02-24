export const SITE_VARIANT: string = (() => {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('worldmonitor-variant');
    if (stored === 'tech' || stored === 'full' || stored === 'finance') return stored;
  }
  return import.meta.env.VITE_VARIANT || 'full';
})();
