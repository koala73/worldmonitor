/**
 * Header auth keeps a single Sign In action (#10464). Create account is folded
 * into Clerk's sign-in-or-up flow via `withSignUp: true` on openSignIn, and
 * pending email-code resume must still run on that click.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const CLERK_SRC = new URL('../src/services/clerk.ts', import.meta.url);

describe('openSignIn withSignUp', () => {
  it('passes withSignUp when opening the Clerk sign-in modal', () => {
    const src = readFileSync(CLERK_SRC, 'utf8');
    assert.match(
      src,
      /openSignIn\(\{\s*appearance:\s*getAppearance\(\),\s*withSignUp:\s*true\s*\}\)/,
      'openLoadedClerkSignIn must open sign-in-or-up so Create account stays available without a second header CTA',
    );
  });

  it('consults the sign-up resume hook for every auth surface open', () => {
    const src = readFileSync(CLERK_SRC, 'utf8');
    assert.match(
      src,
      /if \(signUpResumeHook\?\.\(openClerk, intent\)\) return;/,
      'openSignIn must resume a pending email-code attempt after Create account was removed from the header',
    );
    assert.doesNotMatch(
      src,
      /action === 'open-sign-up' && signUpResumeHook/,
      'resume must not be limited to openSignUp after header Create account was folded into Sign In',
    );
  });
});
