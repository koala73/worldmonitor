/**
 * Signed-out header chrome (#10464): one Sign In action, free-account reason,
 * and Create account removed from the header (folded into Clerk sign-in).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type AuthSession = { isPending: boolean; user: null };

const { openSignIn, openSignUp, subscribeAuthState } = vi.hoisted(() => ({
  openSignIn: vi.fn(),
  openSignUp: vi.fn(),
  subscribeAuthState: vi.fn((cb: (state: AuthSession) => void) => {
    cb({ isPending: false, user: null });
    return () => {};
  }),
}));

vi.mock('@/services/auth-state', () => ({ subscribeAuthState }));
vi.mock('@/services/clerk', () => ({
  mountUserButton: () => () => {},
  openSignIn,
  openSignUp,
}));
vi.mock('@/services/i18n', () => ({
  t: (key: string) => {
    if (key === 'auth.signIn') return 'Sign In';
    if (key === 'auth.freeReason') return 'Free: save your layout, follow countries, get alerts';
    if (key === 'auth.createAccount') return 'Create account';
    return key;
  },
}));

const { AuthHeaderWidget } = await import('@/components/AuthHeaderWidget');

describe('AuthHeaderWidget signed-out chrome', () => {
  afterEach(() => {
    openSignIn.mockClear();
    openSignUp.mockClear();
    subscribeAuthState.mockReset();
    subscribeAuthState.mockImplementation((cb: (state: AuthSession) => void) => {
      cb({ isPending: false, user: null });
      return () => {};
    });
  });

  it('renders one Sign In action with a free-account reason and no Create account', () => {
    const widget = new AuthHeaderWidget();
    const root = widget.getElement();

    expect(root.querySelectorAll('.auth-signin-btn')).toHaveLength(1);
    expect(root.querySelector('.auth-signin-btn')?.textContent).toBe('Sign In');
    expect(root.querySelector('.auth-free-reason')?.textContent).toBe(
      'Free: save your layout, follow countries, get alerts',
    );
    expect(root.querySelector<HTMLElement>('.auth-free-reason')?.title).toBe(
      'Free: save your layout, follow countries, get alerts',
    );
    expect(root.querySelector('.auth-signup-link')).toBeNull();

    root.querySelector<HTMLButtonElement>('.auth-signin-btn')!.click();
    expect(openSignIn).toHaveBeenCalledTimes(1);
    expect(openSignUp).not.toHaveBeenCalled();

    widget.destroy();
  });

  it('reserves pending chrome with sign-in and reason skeletons', () => {
    subscribeAuthState.mockImplementation((cb: (state: AuthSession) => void) => {
      cb({ isPending: true, user: null });
      return () => {};
    });

    const widget = new AuthHeaderWidget();
    const root = widget.getElement();
    expect(root.querySelectorAll('.auth-header-skeleton')).toHaveLength(2);
    expect(root.querySelector('.auth-header-skeleton-signin')).not.toBeNull();
    expect(root.querySelector('.auth-header-skeleton-reason')).not.toBeNull();
    expect(root.querySelector('.auth-header-skeleton-signup')).toBeNull();
    widget.destroy();
  });
});
