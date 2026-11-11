/** Window width at event creation, never device/screen width or flush time. */
export function viewportAnalyticsFields(): { vw?: 'phone' | 'stacked' | 'narrow-split' | 'wide' } {
  if (typeof window === 'undefined' || !Number.isFinite(window.innerWidth)) return {};
  const width = window.innerWidth;
  if (width < 768) return { vw: 'phone' };
  if (width < 900) return { vw: 'stacked' };
  if (width < 1300) return { vw: 'narrow-split' };
  return { vw: 'wide' };
}
