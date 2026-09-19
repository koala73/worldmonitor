import { bucketPanelKeyForAnalytics } from './analytics-panel-key';

const UTM_SOURCE = 'worldmonitor';
const UTM_MEDIUM = 'referral';

function isExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === window.location.origin) return false;
    if (['t.me', 'telegram.me', 'slack.com'].some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) return false;
    return ![...parsed.searchParams.keys()].some(key => !key.startsWith('utm_'));
  } catch {
    return false;
  }
}

function detectCampaign(anchor: HTMLElement): string {
  const panel = anchor.closest('[data-panel]');
  if (panel) return bucketPanelKeyForAnalytics((panel as HTMLElement).dataset.panel || 'unknown');

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
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const anchor = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[target="_blank"]') : null;
    if (!anchor) return;
    if (anchor.hasAttribute('download') || anchor.hasAttribute('referrerpolicy')) return;

    const href = anchor.href;
    if (!href || !isExternalUrl(href)) return;

    const campaign = detectCampaign(anchor);
    const destination = appendUtmParams(href, campaign);
    if (destination === href) return;
    e.preventDefault();
    window.open(destination, '_blank', 'noopener,noreferrer');
  });
}
