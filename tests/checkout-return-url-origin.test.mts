import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isTrustedReturnUrlOrigin } from '../convex/payments/returnUrlOrigin.ts';

/**
 * WORLDMONITOR-K7 / -Q4: `_createCheckoutSession()` enumerated the origins allowed
 * as a post-payment `returnUrl`, but the list drifted from the set of hosts that
 * actually serve the app. Vercel serves the deployment on EVERY attached domain, so
 * `https://api.worldmonitor.app/dashboard` returns the real dashboard (verified HTTP
 * 200, `<title>World Monitor - Real-Time Global Intelligence Dashboard</title>`)
 * while `api.worldmonitor.app` was absent from the allowlist. 12 distinct signed-in
 * users were handed a 500 from /api/create-checkout instead of a Dodo checkout page.
 *
 * The guard exists to stop open redirects, so widening it to a blanket
 * `*.worldmonitor.app` suffix match is NOT safe: several subdomains are vendor-owned
 * CNAMEs (clerk., abacus.) and must never be post-payment redirect targets. The list
 * stays enumerated; these tests pin both directions.
 */

describe('checkout returnUrl origin allowlist', () => {
  it('accepts the API host, which serves the app on every Vercel-attached domain', () => {
    // Red before the fix: api.worldmonitor.app was missing from allowedOrigins.
    assert.equal(isTrustedReturnUrlOrigin('https://api.worldmonitor.app'), true);
  });

  it('accepts the apex, www, app and every variant host', () => {
    for (const origin of [
      'https://worldmonitor.app',
      'https://www.worldmonitor.app',
      'https://app.worldmonitor.app',
      'https://tech.worldmonitor.app',
      'https://finance.worldmonitor.app',
      'https://commodity.worldmonitor.app',
      'https://happy.worldmonitor.app',
      'https://energy.worldmonitor.app',
    ]) {
      assert.equal(isTrustedReturnUrlOrigin(origin), true, `expected trusted: ${origin}`);
    }
  });

  it('rejects vendor-owned worldmonitor.app subdomains', () => {
    // These resolve to third-party infrastructure (Clerk, Umami). A suffix-based
    // widening would silently make them valid redirect targets.
    for (const origin of [
      'https://clerk.worldmonitor.app',
      'https://abacus.worldmonitor.app',
    ]) {
      assert.equal(isTrustedReturnUrlOrigin(origin), false, `expected rejected: ${origin}`);
    }
  });

  it('rejects look-alike and hostile origins', () => {
    for (const origin of [
      'https://evilworldmonitor.app',
      'https://worldmonitor.app.evil.com',
      'https://www.worldmonitor.app.evil.com',
      'http://worldmonitor.app',
      'https://attacker.example.com',
      'https://worldmonitor.app:8443',
      '',
    ]) {
      assert.equal(isTrustedReturnUrlOrigin(origin), false, `expected rejected: ${origin}`);
    }
  });
});
