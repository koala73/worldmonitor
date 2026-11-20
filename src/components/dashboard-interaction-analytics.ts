import { trackDashboardFirstInteraction, type DashboardInteractionTarget } from '@/services/analytics';

/** Most specific controls win over their surrounding panel or map. */
export function dashboardInteractionTarget(target: Element): DashboardInteractionTarget | undefined {
  if (target.closest('.auth-signin-btn, .auth-signup-link, [data-dashboard-interaction="signin"]')) return 'signin';
  if (target.closest('.pro-banner-cta, [data-dashboard-interaction="upgrade"], a[href*="/pro#pricing"]')) return 'upgrade';
  if (target.closest('.variant-option, .mobile-menu-variant')) return 'switcher';
  if (target.closest('#searchBtn, #mobileSearchBtn, [data-mobile-tab="search"], .search-modal')) return 'search';
  if (target.closest('[data-panel="live-news"]')) return 'live-news';
  if (target.closest('.panel[data-panel]')) return 'panel';
  if (target.closest('#mapSection, [data-mobile-tab="map"]')) return 'map';
}

export function observeDashboardFirstInteraction(root: HTMLElement): () => void {
  let frameFocusTimer: ReturnType<typeof setTimeout> | undefined;
  // Cross-origin player clicks do not bubble out of the iframe. Focus moves
  // into it while the document stays focused; switching tabs must not count.
  const onFrameFocus = () => {
    clearTimeout(frameFocusTimer);
    frameFocusTimer = setTimeout(() => {
      const active = root.ownerDocument.activeElement;
      if (root.ownerDocument.hasFocus() && active?.tagName === 'IFRAME'
        && root.contains(active) && dashboardInteractionTarget(active) === 'live-news') {
        trackDashboardFirstInteraction('live-news');
        stop();
      }
    }, 0);
  };
  const stop = () => {
    clearTimeout(frameFocusTimer);
    root.ownerDocument.defaultView?.removeEventListener('blur', onFrameFocus);
    for (const type of ['click', 'pointerdown', 'wheel']) root.ownerDocument.removeEventListener(type, onInteraction, true);
    root.ownerDocument.removeEventListener('keydown', onInteraction, true);
  };
  const onInteraction = (event: Event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    let target = dashboardInteractionTarget(event.target);
    if (event instanceof KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'k') target = 'search';
      else if (event.key !== 'Enter' && event.key !== ' ') return;
    }
    // Wheel zooms and drags interact with the map without producing a click.
    if ((event.type === 'wheel' || event.type === 'pointerdown') && target !== 'map') return;
    if (target) {
      trackDashboardFirstInteraction(target);
      stop();
    }
  };
  const events = ['click', 'pointerdown', 'wheel'] as const;
  // Settings and other dashboard overlays are portalled outside the app root.
  for (const type of events) root.ownerDocument.addEventListener(type, onInteraction, { capture: true, passive: true });
  root.ownerDocument.addEventListener('keydown', onInteraction, { capture: true });
  root.ownerDocument.defaultView?.addEventListener('blur', onFrameFocus);
  return stop;
}
