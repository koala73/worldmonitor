/**
 * Header auth keeps a single Sign In action (#10464). New visitors reach
 * Create account through the Sign In modal's "Don't have an account? Sign up"
 * footer link, and a pending email-code sign-up must still resume on that click.
 *
 * The modal must not use `withSignUp: true`. Under strict user enumeration
 * protection the clerk-js 6.13.0 + @clerk/ui 1.42.4 pair production serves
 * falls back to a plain strict sign-in: an unknown email gets a "Sign in
 * attempt, no account found" notice instead of a sign-up code, and the
 * footer Sign up link is hidden. Daily sign-ups fell from ~100 to ~18 the
 * hour #10493 shipped it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const CLERK_SRC = new URL('../src/services/clerk.ts', import.meta.url);

describe('openSignIn sign-up path', () => {
  it('opens the plain sign-in modal so its footer Sign up link stays visible', () => {
    const src = readFileSync(CLERK_SRC, 'utf8');
    assert.match(
      src,
      /clerkInstance\?\.openSignIn\(\{\s*appearance:\s*getAppearance\(\)\s*\}\)/,
      'openLoadedClerkSignIn must open the plain sign-in modal',
    );
    assert.doesNotMatch(
      src,
      /withSignUp\s*:/,
      'withSignUp turns new-email sign-ups into "no account found" notices under strict enumeration protection',
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
