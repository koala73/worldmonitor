/**
 * Locks the plan-name whitelist. Reasons:
 *   1. Safety: the 409 server payload's `subscription.planKey` is
 *      technically "just a string from the server" — the dialog uses
 *      this function as the guard that prevents arbitrary server text
 *      from reaching the user.
 *   2. Forward compat: if Dodo adds a new planKey before this client
 *      ships to match, the fallback "Pro" must still render something
 *      coherent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePlanDisplayName } from '../src/services/checkout-plan-names.ts';

describe('resolvePlanDisplayName', () => {
  it('maps shipped plan keys to their display names', () => {
    const cases = [
      ['pro_monthly', 'Pro Monthly'],
      ['pro_annual', 'Pro Annual'],
      ['pro_business_monthly', 'Pro Business Monthly'],
      ['pro_business_annual', 'Pro Business Annual'],
      ['api_starter', 'API Starter'],
      ['api_business', 'API Business'],
    ] as const;

    for (const [planKey, displayName] of cases) {
      assert.equal(resolvePlanDisplayName(planKey), displayName);
    }
  });

  it('falls back to "Pro" for unknown or invalid keys', () => {
    for (const value of ['new_tier_2027', undefined, null, '', 42, { planKey: 'pro_monthly' }, true]) {
      assert.equal(resolvePlanDisplayName(value), 'Pro');
    }
  });

  it('never returns server-provided text for unknown keys', () => {
    // Even if the server sends a plausible-looking string, we don't
    // render it — this is the privacy/safety invariant.
    const hostile = 'DROP TABLE users; --';
    const result = resolvePlanDisplayName(hostile);
    assert.ok(!result.includes('DROP'));
    assert.ok(!result.includes('users'));
    assert.equal(result, 'Pro');
  });

});
