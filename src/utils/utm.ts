const UTM_SOURCE = 'worldmonitor';
const UTM_MEDIUM = 'referral';

function isExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function detectCampaign(anchor: HTMLElement): string {
  const panel = anchor.closest('[data-panel]');
  if (panel) return (panel as HTMLElement).dataset.panel || 'unknown';

  const popup = anchor.closest('.maplibregl-popup, .mapboxgl-popup');
  if (popup) return 'map-popup';

  const modal = anchor.closest('.modal, [role="dialog"]');
  if (modal) return 'modal';

  return 'general';
}

function appendUtmParams(url: string, campaign: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('utm_source')) return url;
    parsed.searchParams.set('utm_source', UTM_SOURCE);
    parsed.searchParams.set('utm_medium', UTM_MEDIUM);
    parsed.searchParams.set('utm_campaign', campaign);
    return parsed.toString();
  } catch {
    return url;
  }
}

export function installUtmInterceptor(): void {
  document.addEventListener('click', (e) => {
    const anchor = (e.target as HTMLElement).closest('a[target="_blank"]') as HTMLAnchorElement | null;
    if (!anchor) return;

    const href = anchor.href;
    if (!href || !isExternalUrl(href)) return;

    const campaign = detectCampaign(anchor);
    anchor.href = appendUtmParams(href, campaign);
  }, true);
}
