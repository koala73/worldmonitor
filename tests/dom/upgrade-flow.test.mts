/**
 * The shared "Upgrade to Pro" helper opens the /pro plan picker. It used to
 * start a Pro Monthly checkout, which hid annual, Pro Business and the API
 * plans from every dashboard CTA.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternalUrl, startCheckout } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(async () => 'opened'),
  startCheckout: vi.fn(async () => true),
}));
let desktop = false;

vi.mock('@/services/external-navigation', () => ({ openExternalUrl }));
vi.mock('@/services/checkout', () => ({ startCheckout }));
vi.mock('@/services/runtime', () => ({ isDesktopRuntime: () => desktop }));

const { openUpgradePlans } = await import('@/services/upgrade-flow');

beforeEach(() => {
  openExternalUrl.mockClear();
  startCheckout.mockClear();
});

afterEach(() => {
  desktop = false;
});

describe('openUpgradePlans', () => {
  it('opens the pricing section on the web and starts no checkout', async () => {
    await openUpgradePlans();
    expect(openExternalUrl).toHaveBeenCalledWith('https://worldmonitor.app/pro#pricing');
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it('carries mission attribution to /pro, which passes it into its checkout', async () => {
    await openUpgradePlans({ missionId: 'crisis-desk', panelKey: 'cii' });
    const url = new URL(openExternalUrl.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/pro');
    expect(url.hash).toBe('#pricing');
    expect(url.searchParams.get('wm_checkout_mission')).toBe('crisis-desk');
    expect(url.searchParams.get('wm_checkout_panel')).toBe('cii');
  });

  it('marks the desktop handoff so /pro returns the purchase to the app', async () => {
    desktop = true;
    await openUpgradePlans();
    expect(openExternalUrl).toHaveBeenCalledWith('https://worldmonitor.app/pro?wm_checkout_handoff=desktop#pricing');
  });
});
