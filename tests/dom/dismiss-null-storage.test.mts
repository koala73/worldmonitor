import { afterEach, describe, expect, it, vi } from 'vitest';

import { MobileWarningModal } from '@/components/MobileWarningModal';
import { getDismissed, setDismissed } from '@/utils/cross-domain-storage';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('dismissal under a null localStorage', () => {
  it('closes the mobile warning when the user ticks "don’t show again"', () => {
    const modal = new MobileWarningModal();
    modal.show();

    const overlay = document.querySelector('.mobile-warning-overlay');
    const remember = document.querySelector<HTMLInputElement>('#mobileWarningRemember');
    const gotIt = document.querySelector<HTMLButtonElement>('.mobile-warning-btn');
    expect(overlay?.classList.contains('active')).toBe(true);

    remember!.checked = true;
    vi.stubGlobal('localStorage', null);
    gotIt!.click();

    expect(overlay?.classList.contains('active')).toBe(false);
  });

  it('records and reads a dismissal without throwing', () => {
    vi.stubGlobal('localStorage', null);

    expect(() => setDismissed('wm-test-dismissed')).not.toThrow();
    expect(() => getDismissed('wm-test-dismissed')).not.toThrow();
    expect(getDismissed('wm-test-dismissed')).toBe(false);
  });
});
