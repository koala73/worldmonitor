/**
 * Signed-out /pro checkout opens the sign-up form (#10842). It must stay a
 * plain `openSignUp`: Clerk's combined flow (`withSignUp`) hid new-email
 * sign-ups under strict enumeration protection (#10493, see
 * tests/clerk-signin-with-signup.test.mts). The desktop account switch stays a
 * sign-in, since that buyer already holds an account.
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

  it('opens sign-up with both return URLs for a signed-out click', () => {
    const inner = body('startCheckoutInner');
    assert.match(inner, /c\.openSignUp\(\{\s*afterSignUpUrl:\s*returnUrl,\s*afterSignInUrl:\s*returnUrl\s*\}\)/);
    assert.doesNotMatch(inner, /openSignIn\(/);
  });

  it('keeps the desktop account switch on sign-in', () => {
    assert.match(body('confirmDesktopAccount'), /c\.openSignIn\(\{\s*afterSignInUrl:\s*returnUrl/);
  });
});
