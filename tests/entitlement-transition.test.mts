/**
 * Unit tests for shouldReloadOnEntitlementChange.
 *
 * This helper drives the post-payment reload in src/app/panel-layout.ts.
 * A bug here is exactly what caused duplicate subscriptions in the
 * 2026-04-18 incident (customer cus_0NcmwcAWw0jhVBHVOK58C): the prior
 * skipInitialSnapshot guard swallowed the first pro snapshot unconditionally,
 * even when it arrived mid-session after a successful Dodo webhook.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldReloadOnEntitlementChange } from '@/services/entitlements';

describe('shouldReloadOnEntitlementChange', () => {
  it('does not reload on the first snapshot when user is free', () => {
    assert.equal(shouldReloadOnEntitlementChange(null, false), false);
  });

  it('does not reload on the first snapshot when user is already pro', () => {
    // Legacy-pro user on page load — avoid reload loop.
    assert.equal(shouldReloadOnEntitlementChange(null, true), false);
  });

  it('does not reload free → free (idempotent free-tier update)', () => {
    assert.equal(shouldReloadOnEntitlementChange(false, false), false);
  });

  it('does not reload pro → pro (renewal, metadata refresh)', () => {
    assert.equal(shouldReloadOnEntitlementChange(true, true), false);
  });

  it('does not reload pro → free (expiration, revocation) — handled elsewhere', () => {
    // Revocation paths are handled by re-rendering; no forced reload.
    assert.equal(shouldReloadOnEntitlementChange(true, false), false);
  });

  it('reloads on free → pro (post-payment activation — the incident case)', () => {
    assert.equal(shouldReloadOnEntitlementChange(false, true), true);
  });

  it('simulates the incident sequence: free-tier default snapshot followed by authed pro snapshot → reload exactly once', () => {
    // Before PR 1, this sequence produced no reload because skipInitialSnapshot
    // swallowed the first snapshot. After the fix, the transition triggers a
    // reload and the user's panels unlock without manual intervention.
    let last: boolean | null = null;
    let reloadCount = 0;

    const snapshots = [false, true, true];
    for (const entitled of snapshots) {
      if (shouldReloadOnEntitlementChange(last, entitled)) reloadCount += 1;
      last = entitled;
    }

    assert.equal(reloadCount, 1);
  });

  it('legacy-pro user reconnecting WS: pro, pro, pro → zero reloads', () => {
    let last: boolean | null = null;
    let reloadCount = 0;

    for (const entitled of [true, true, true]) {
      if (shouldReloadOnEntitlementChange(last, entitled)) reloadCount += 1;
      last = entitled;
    }

    assert.equal(reloadCount, 0);
  });
});
