import { describe, expect, it, vi } from 'vitest';

import { createAccountMenuItems } from '@/services/clerk';

describe('account menu', () => {
  it('keeps profile, billing, settings, and sign-out actions in Clerk’s user menu', () => {
    const openBilling = vi.fn();
    const openSettings = vi.fn();
    const items = createAccountMenuItems({
      onBillingClick: openBilling,
      onSettingsClick: openSettings,
    });

    expect(items.map((item) => item.label)).toEqual([
      'Plan & billing',
      'Settings',
    ]);

    items[0]?.onClick?.();
    items[1]?.onClick?.();
    expect(openBilling).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it('mounts quiet decorative icons without exposing them to assistive technology', () => {
    const items = createAccountMenuItems({
      onBillingClick: () => {},
      onSettingsClick: () => {},
    });

    for (const item of items) {
      const iconMount = document.createElement('div');
      item.mountIcon?.(iconMount);

      const svg = iconMount.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(svg?.getAttribute('fill')).toBe('none');

      item.unmountIcon?.(iconMount);
      expect(iconMount.childElementCount).toBe(0);
    }
  });

  it('omits unavailable destinations instead of rendering dead menu items', () => {
    expect(createAccountMenuItems({})).toEqual([]);
  });
});
