/**
 * Signed-out /pro checkout asks the buyer to pick sign-up or sign-in, then
 * opens that form (#10842). Each must stay a plain `openSignUp`/`openSignIn`:
 * Clerk's combined flow (`withSignUp`) hid new-email sign-ups under strict
 * enumeration protection (#10493, see tests/clerk-signin-with-signup.test.mts).
 * The desktop account switch stays a sign-in, since that buyer already holds
 * an account.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const src = readFileSync(new URL('../pro-test/src/services/checkout.ts', import.meta.url), 'utf8');

function body(name: string): string {
  const start = src.search(new RegExp(`\\bfunction ${name}\\(`));
  assert.ok(start >= 0, `${name} must exist in checkout.ts`);
  const next = src.slice(start + 1).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

describe('/pro checkout auth form', () => {
  it('never uses the combined sign-in/sign-up flow', () => {
    assert.doesNotMatch(src, /withSignUp/);
  });

  it('opens the chosen form with both return URLs for a signed-out click', () => {
    const inner = body('startCheckoutInner');
    assert.match(inner, /askCheckoutAuthForm\(\)/);
    assert.match(inner, /c\.openSignUp\(\{\s*afterSignUpUrl:\s*returnUrl,\s*afterSignInUrl:\s*returnUrl\s*\}\)/);
    assert.match(inner, /c\.openSignIn\(\{\s*afterSignInUrl:\s*returnUrl,\s*afterSignUpUrl:\s*returnUrl\s*\}\)/);
  });

  it('keeps the desktop account switch on sign-in', () => {
    assert.match(body('confirmDesktopAccount'), /c\.openSignIn\(\{\s*afterSignInUrl:\s*returnUrl/);
  });
});
