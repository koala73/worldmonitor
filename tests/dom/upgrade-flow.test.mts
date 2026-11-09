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
let desktop = false;
let referral: string | null = null;
let authUser: { id: string } | null = null;

vi.mock('@/services/external-navigation', () => ({ openExternalUrl }));
vi.mock('@/services/checkout', () => ({ startCheckout }));
vi.mock('@/services/runtime', () => ({ isDesktopRuntime: () => desktop }));
vi.mock('@/services/checkout-error-toast', () => ({ showCheckoutErrorToast }));
vi.mock('@/services/referral-capture', () => ({ loadActiveReferral: () => referral }));
vi.mock('@/services/auth-state', () => ({ getAuthState: () => ({ user: authUser, isPending: false }) }));

// The desktop branch must never fall back to a WebView popup.
const NO_POPUP = { desktopPopupFallback: false };

const { openUpgradePlans } = await import('@/services/upgrade-flow');

beforeEach(() => {
  openExternalUrl.mockClear();
  startCheckout.mockClear();
  showCheckoutErrorToast.mockClear();
});

afterEach(() => {
  desktop = false;
  referral = null;
  authUser = null;
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

  it('marks the desktop handoff so /pro returns the purchase to the app', async () => {
    desktop = true;
    await openUpgradePlans();
    expect(openExternalUrl).toHaveBeenCalledWith('https://worldmonitor.app/pro?wm_checkout_handoff=desktop#pricing', null, NO_POPUP);
  });

  it('binds the desktop handoff to the signed-in desktop account (#10342)', async () => {
    // sha256("user_1") prefix, pinned in tests/checkout-account-fingerprint.test.mts.
    desktop = true;
    authUser = { id: 'user_1' };
    await openUpgradePlans();
    const url = new URL(openExternalUrl.mock.calls[0]![0]);
    expect(url.searchParams.get('wm_checkout_handoff')).toBe('desktop');
    expect(url.searchParams.get('wm_checkout_account')).toBe('79b0aa0042b3c056');
    expect(url.toString()).not.toContain('user_1');
  });

  it('sends a signed-out desktop user to /pro with no account binding', async () => {
    desktop = true;
    await openUpgradePlans();
    const url = new URL(openExternalUrl.mock.calls[0]![0]);
    expect(url.searchParams.has('wm_checkout_account')).toBe(false);
  });

  it('never stamps the account fingerprint on the web', async () => {
    authUser = { id: 'user_1' };
    await openUpgradePlans();
    expect(openExternalUrl).toHaveBeenCalledWith('https://worldmonitor.app/pro#pricing', null, NO_POPUP);
  });

  it('carries the captured affiliate referral to /pro as ?ref=', async () => {
    referral = 'partner42';
    await openUpgradePlans();
    const url = new URL(openExternalUrl.mock.calls[0]![0]);
    expect(url.searchParams.get('ref')).toBe('partner42');
    expect(url.hash).toBe('#pricing');
  });
});
