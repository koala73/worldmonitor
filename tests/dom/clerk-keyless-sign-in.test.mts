/**
 * A build with no Clerk publishable key (a self-host or a local dev build)
 * cannot sign anyone in. Every Sign In and Create account button in the app
 * ends at openSignIn or openSignUp, so the click must say why nothing opens
 * instead of doing nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', '');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  document.body.replaceChildren();
});

const toast = () => document.querySelector('.toast-notification')?.textContent ?? null;

describe('sign-in in a build without Clerk', () => {
  it('reports that sign-in is unavailable on Sign In and Create account', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clerk = await import('@/services/clerk');
    expect(clerk.isClerkAuthEnabled()).toBe(false);

    clerk.openSignIn();
    await vi.waitFor(() => expect(toast()).toBe('Sign-in is not available in this build.'));

    document.body.replaceChildren();
    clerk.openSignUp();
    await vi.waitFor(() => expect(toast()).toBe('Sign-in is not available in this build.'));
  });
});
