/**
 * The bar shown while desktop sign-in continues in the browser (#9396
 * follow-up). Without it the only feedback was a transient toast, and a
 * closed browser tab left the app waiting silently for five minutes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { showDesktopSignInWaiting } from '@/utils/desktop-sign-in-waiting';

describe('showDesktopSignInWaiting', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('tells the user where to look and announces it', () => {
    showDesktopSignInWaiting({ onCancel: vi.fn(), onInApp: vi.fn() });
    const bar = document.querySelector('.wm-desktop-sign-in-waiting');
    expect(bar?.getAttribute('role')).toBe('status');
    expect(bar?.textContent).toContain('Continue signing in in your browser.');
  });

  it('runs the chosen action once and removes itself', () => {
    const onCancel = vi.fn();
    const onInApp = vi.fn();
    showDesktopSignInWaiting({ onCancel, onInApp });
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.wm-desktop-sign-in-waiting button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Sign in here instead', 'Cancel']);

    buttons[0]!.click();
    expect(onInApp).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.querySelector('.wm-desktop-sign-in-waiting')).toBeNull();
  });

  it('is dismissed by the returned function and never stacks', () => {
    showDesktopSignInWaiting({ onCancel: vi.fn(), onInApp: vi.fn() });
    const dismiss = showDesktopSignInWaiting({ onCancel: vi.fn(), onInApp: vi.fn() });
    expect(document.querySelectorAll('.wm-desktop-sign-in-waiting')).toHaveLength(1);
    dismiss();
    expect(document.querySelector('.wm-desktop-sign-in-waiting')).toBeNull();
  });
});
