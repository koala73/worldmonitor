/**
 * /pro: the Sign in escape on Clerk's sign-up code card. An existing account
 * typed into sign-up never gets a code under strict enumeration protection, so
 * the escape reopens sign-in with the email filled in and, when the form was
 * opened for checkout, the same return URL so the checkout still resumes.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  createSignInEscape,
  setAuthReturnUrls,
  type LoadedClerk,
} from '../pro-test/src/services/clerk.ts';

function fakeClerk(emailAddress: string | null) {
  const calls: Array<{ op: string; props?: unknown }> = [];
  const instance = {
    client: { signUp: { emailAddress } },
    closeSignUp: () => calls.push({ op: 'closeSignUp' }),
    closeSignIn: () => calls.push({ op: 'closeSignIn' }),
    openSignIn: (props?: unknown) => {
      calls.push({ op: 'openSignIn', props });
      mounted = true; // the sign-in modal stays on screen
      signIn = true;
      mountedFrames = Number.POSITIVE_INFINITY;
    },
  } as unknown as LoadedClerk;
  return { instance, calls };
}

// Clerk keeps sign-up mounted for the first frame, unmounts it, then mounts
// sign-in on the frame after openSignIn.
const frames: Array<() => void> = [];
let clock = 0;
let mounted = true;
let signIn = false;
let mountedFrames = 0;
const switchDeps = {
  authSurfaceMounted: () => mounted,
  signInMounted: () => signIn,
  now: () => clock,
  nextFrame: (cb: () => void) => { frames.push(cb); },
};
const runFrame = () => {
  clock += 16;
  frames.shift()?.();
  if (mountedFrames > 0) mountedFrames -= 1;
  else mounted = false;
};
const MAX_FRAMES = 300; // past both two-second waits at 16 ms a frame
const nextTask = async () => {
  for (let i = 0; frames.length && i < MAX_FRAMES; i++) runFrame();
  assert.equal(frames.length, 0, 'the switch ends within its wait caps');
};

beforeEach(() => {
  frames.length = 0;
  clock = 0;
  mounted = true;
  signIn = false;
  mountedFrames = 0;
});
afterEach(() => setAuthReturnUrls(null));

describe('pro sign-up code card escape', () => {
  it('closes both forms, then opens sign-in once sign-up has unmounted, with the email and the checkout return URLs', async () => {
    const returnUrl = 'https://www.worldmonitor.app/pro?checkout=api_starter#pricing';
    setAuthReturnUrls({ afterSignInUrl: returnUrl, afterSignUpUrl: returnUrl });
    const { instance, calls } = fakeClerk('existing-buyer@example.com');
    mountedFrames = 1;
    createSignInEscape(instance, switchDeps)();
    // Clerk ignores openSignIn while the modal that hosts sign-up is mounted.
    assert.deepEqual(calls, [{ op: 'closeSignUp' }, { op: 'closeSignIn' }]);
    runFrame();
    assert.equal(calls.length, 2, 'still mounted: sign-in not opened yet');
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
    createSignInEscape(instance, switchDeps)();
    await nextTask();
    assert.deepEqual(calls[2], { op: 'openSignIn', props: {} });
  });

  it('ignores a second click while the switch runs', async () => {
    const { instance, calls } = fakeClerk('existing-buyer@example.com');
    const signInEscape = createSignInEscape(instance, switchDeps);
    signInEscape();
    signInEscape();
    await nextTask();
    assert.deepEqual(calls.map((c) => c.op), ['closeSignUp', 'closeSignIn', 'openSignIn']);
  });
});
