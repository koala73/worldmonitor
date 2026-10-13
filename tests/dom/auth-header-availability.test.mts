import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ enabled: false, signIn: vi.fn(), signUp: vi.fn() }));
vi.mock('@/services/clerk', () => ({
  isClerkAuthEnabled: () => auth.enabled,
  openSignIn: auth.signIn,
  openSignUp: auth.signUp,
  mountUserButton: vi.fn(),
}));
vi.mock('@/services/auth-state', () => ({
  subscribeAuthState: (callback: (state: unknown) => void) => {
    callback({ user: null, isPending: false });
    return () => {};
  },
}));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));

import { AuthHeaderWidget } from '@/components/AuthHeaderWidget';

describe('auth header availability', () => {
  beforeEach(() => { auth.enabled = false; vi.clearAllMocks(); });

  it('omits unusable account actions when Clerk is not configured', () => {
    const widget = new AuthHeaderWidget();
    expect(widget.getElement().querySelectorAll('button')).toHaveLength(0);
    widget.destroy();
  });

  it('keeps sign-in and sign-up working when Clerk is configured', () => {
    auth.enabled = true;
    const widget = new AuthHeaderWidget();
    widget.getElement().querySelector<HTMLButtonElement>('.auth-signin-btn')!.click();
    widget.getElement().querySelector<HTMLButtonElement>('.auth-signup-link')!.click();
    expect(auth.signIn).toHaveBeenCalledOnce();
    expect(auth.signUp).toHaveBeenCalledOnce();
    widget.destroy();
  });
});
