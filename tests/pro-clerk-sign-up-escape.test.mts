/**
 * /pro: the Sign in escape on Clerk's sign-up code card. An existing account
 * typed into sign-up never gets a code under strict enumeration protection, so
 * the escape reopens sign-in with the email filled in and, when the form was
 * opened for checkout, the same return URL so the checkout still resumes.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  openSignInInsteadOfSignUp,
  setAuthReturnUrls,
  type LoadedClerk,
} from '../pro-test/src/services/clerk.ts';

function fakeClerk(emailAddress: string | null) {
  const calls: Array<{ op: string; props?: unknown }> = [];
  const instance = {
    client: { signUp: { emailAddress } },
    closeSignUp: () => calls.push({ op: 'closeSignUp' }),
    closeSignIn: () => calls.push({ op: 'closeSignIn' }),
    openSignIn: (props?: unknown) => calls.push({ op: 'openSignIn', props }),
  } as unknown as LoadedClerk;
  return { instance, calls };
}

// Clerk has already unmounted sign-up by the first frame.
const frames: Array<() => void> = [];
const switchDeps = { authSurfaceMounted: () => false, now: () => 0, nextFrame: (cb: () => void) => { frames.push(cb); } };
const nextTask = async () => { while (frames.length) frames.shift()!(); };

afterEach(() => setAuthReturnUrls(null));

describe('pro sign-up code card escape', () => {
  it('closes both forms, then opens sign-in on the next task with the email and the checkout return URLs', async () => {
    const returnUrl = 'https://www.worldmonitor.app/pro?checkout=api_starter#pricing';
    setAuthReturnUrls({ afterSignInUrl: returnUrl, afterSignUpUrl: returnUrl });
    const { instance, calls } = fakeClerk('existing-buyer@example.com');
    openSignInInsteadOfSignUp(instance, switchDeps);
    // Clerk ignores openSignIn while the modal that hosts sign-up is mounted.
    assert.deepEqual(calls, [{ op: 'closeSignUp' }, { op: 'closeSignIn' }]);
    await nextTask();
    assert.deepEqual(calls, [
      { op: 'closeSignUp' },
      { op: 'closeSignIn' },
      {
        op: 'openSignIn',
        props: {
          afterSignInUrl: returnUrl,
          afterSignUpUrl: returnUrl,
          initialValues: { emailAddress: 'existing-buyer@example.com' },
        },
      },
    ]);
  });

  it('nav sign-in carries no checkout return URL, and a missing email leaves the field empty', async () => {
    setAuthReturnUrls({ afterSignInUrl: 'https://stale.example/', afterSignUpUrl: 'https://stale.example/' });
    setAuthReturnUrls(null);
    const { instance, calls } = fakeClerk(null);
    openSignInInsteadOfSignUp(instance, switchDeps);
    await nextTask();
    assert.deepEqual(calls[2], { op: 'openSignIn', props: {} });
  });
});
