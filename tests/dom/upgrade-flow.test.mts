/**
 * The shared "Upgrade to Pro" helper opens the /pro plan picker. It used to
 * start a Pro Monthly checkout, which hid annual, Pro Business and the API
 * plans from every dashboard CTA.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternalUrl, startCheckout, showCheckoutErrorToast } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(async (_url: string, _preopened?: unknown, _options?: unknown): Promise<string> => 'popup'),
  startCheckout: vi.fn(async () => true),
  showCheckoutErrorToast: vi.fn((_message: string) => {}),
}));
let referral: string | null = null;

vi.mock('@/services/external-navigation', () => ({ openExternalUrl }));
vi.mock('@/services/checkout', () => ({ startCheckout }));
vi.mock('@/services/checkout-error-toast', () => ({ showCheckoutErrorToast }));
vi.mock('@/services/referral-capture', () => ({ loadActiveReferral: () => referral }));

// The desktop branch must never fall back to a WebView popup.
const NO_POPUP = { desktopPopupFallback: false };

const { openUpgradePlans } = await import('@/services/upgrade-flow');

beforeEach(() => {
  openExternalUrl.mockClear();
  startCheckout.mockClear();
  showCheckoutErrorToast.mockClear();
});

afterEach(() => {
  referral = null;
});

describe('openUpgradePlans', () => {
  it('opens the pricing section on the web and starts no checkout', async () => {
    await openUpgradePlans();
    expect(openExternalUrl).toHaveBeenCalledWith('https://worldmonitor.app/pro#pricing', null, NO_POPUP);
    expect(startCheckout).not.toHaveBeenCalled();
    expect(showCheckoutErrorToast).not.toHaveBeenCalled();
  });

  it('tells the user when the page could not open, without throwing', async () => {
    openExternalUrl.mockResolvedValueOnce('failed');
    await expect(openUpgradePlans()).resolves.toBeUndefined();
    expect(showCheckoutErrorToast).toHaveBeenCalledWith('The plans page did not open. Please try again.');
  });

  it('tells the user when the navigation itself throws, without rejecting into the callers', async () => {
    // A rejected lazy import or a throwing opener used to reject out of the
    // helper, where the CTAs' catch fallbacks window.open a raw /pro: no
    // attribution, and inside the desktop WebView a second window.
    openExternalUrl.mockRejectedValueOnce(new Error('chunk load failed'));
    await expect(openUpgradePlans()).resolves.toBeUndefined();
    expect(showCheckoutErrorToast).toHaveBeenCalledWith('The plans page did not open. Please try again.');
  });

  it('still resolves when the toast cannot render', async () => {
    openExternalUrl.mockResolvedValueOnce('failed');
    showCheckoutErrorToast.mockImplementationOnce(() => { throw new Error('no document'); });
    await expect(openUpgradePlans()).resolves.toBeUndefined();
  });

  it('carries mission attribution to /pro, which passes it into its checkout', async () => {
    await openUpgradePlans({ missionId: 'crisis-desk', panelKey: 'cii' });
    const url = new URL(openExternalUrl.mock.calls[0]![0]);
    expect(url.pathname).toBe('/pro');
    expect(url.hash).toBe('#pricing');
    expect(url.searchParams.get('wm_checkout_mission')).toBe('crisis-desk');
    expect(url.searchParams.get('wm_checkout_panel')).toBe('cii');
  });

  it('carries the captured affiliate referral to /pro as ?ref=', async () => {
    referral = 'partner42';
    await openUpgradePlans();
    const url = new URL(openExternalUrl.mock.calls[0]![0]);
    expect(url.searchParams.get('ref')).toBe('partner42');
    expect(url.hash).toBe('#pricing');
  });
});
