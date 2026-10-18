/**
 * `openSignUp()` consults the sign-up resume hook before Clerk's modal (#8577).
 * A resumable attempt must land on the verify card, never on the start card
 * whose Continue creates a second attempt and sends a second email.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  __setClerkInstanceForTests,
  openSignUp,
  registerSignUpResumeHook,
} from '../src/services/clerk.ts';

function installFakeClerk(): { opens: number } {
  const counter = { opens: 0 };
  __setClerkInstanceForTests({
    openSignUp: () => { counter.opens += 1; },
    user: null,
  } as never);
  return counter;
}

afterEach(() => {
  registerSignUpResumeHook(null);
  __setClerkInstanceForTests(null);
});

describe('openSignUp routing', () => {
  it('opens Clerk\'s modal when no hook is registered', () => {
    const clerk = installFakeClerk();
    openSignUp();
    assert.equal(clerk.opens, 1);
  });

  it('does not open Clerk\'s modal when the hook takes the click', () => {
    const clerk = installFakeClerk();
    let consulted = 0;
    registerSignUpResumeHook(() => { consulted += 1; return true; });
    openSignUp();
    assert.equal(consulted, 1);
    assert.equal(clerk.opens, 0);
  });

  it('opens Clerk\'s modal when the hook declines', () => {
    const clerk = installFakeClerk();
    registerSignUpResumeHook(() => false);
    openSignUp();
    assert.equal(clerk.opens, 1);
  });

  it('hands the hook a fallback that opens Clerk\'s modal later', () => {
    const clerk = installFakeClerk();
    let fallback: (() => void) | null = null;
    registerSignUpResumeHook((openClerk) => { fallback = openClerk; return true; });
    openSignUp();
    assert.equal(clerk.opens, 0);
    fallback!();
    assert.equal(clerk.opens, 1);
  });
});
