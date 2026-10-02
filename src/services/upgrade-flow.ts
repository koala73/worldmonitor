import type { CheckoutAttribution } from './analytics';
import { buildAttributedProUrl } from '../../shared/checkout-attribution';

/**
 * The one upgrade path every locked/preview CTA routes through. Desktop
 * WebViews never open in-app checkout (the /pro page handles it, #5911);
 * web starts the Dodo checkout with optional mission attribution; every
 * failure falls back to the public /pro page. Extracted because three
 * surfaces (Panel locked state, ResilienceWidget, ProPreviewSection) had
 * grown near-identical copies.
 */
export async function openUpgradeCheckout(attribution?: CheckoutAttribution): Promise<void> {
  const [{ DEFAULT_UPGRADE_PRODUCT }, { isDesktopRuntime }] = await Promise.all([
    import('@/config/products'),
    import('@/services/runtime'),
  ]);

  if (isDesktopRuntime()) {
    const { openExternalUrl } = await import('@/services/external-navigation');
    await openExternalUrl(buildAttributedProUrl(
      'https://worldmonitor.app/pro',
      attribution,
      { desktopHandoff: true },
    ));
    return;
  }

  await import('@/services/checkout')
    .then((module) => module.startCheckout(
      DEFAULT_UPGRADE_PRODUCT,
      undefined,
      attribution
        ? { analyticsSurface: 'mission-preview', analyticsAttribution: attribution }
        : undefined,
    ))
    .catch(() => {
      window.open(
        buildAttributedProUrl('https://worldmonitor.app/pro', attribution),
        '_blank',
        'noopener,noreferrer',
      );
    });
}
