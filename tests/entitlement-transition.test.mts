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

  it('redirect-return from checkout with webhook already landed: seeded as free → first pro snapshot reloads', () => {
    // When handleCheckoutReturn() fires, panel-layout seeds lastEntitled=false
    // instead of null. Otherwise a fast webhook (pro snapshot arrives as the
    // first snapshot after reload) would be swallowed as "legacy-pro".
    let last: boolean | null = false; // seeded because returnedFromCheckout=true
    let reloadCount = 0;

    if (shouldReloadOnEntitlementChange(last, true)) reloadCount += 1;
    last = true;
    // WS reconnects and re-emits pro — no further reload.
    if (shouldReloadOnEntitlementChange(last, true)) reloadCount += 1;

    assert.equal(reloadCount, 1);
  });

  it('redirect-return when webhook is still pending: seeded false → free → pro sequence reloads exactly once', () => {
    let last: boolean | null = false;
    let reloadCount = 0;

    // First snapshot comes back as free (webhook not landed yet).
    if (shouldReloadOnEntitlementChange(last, false)) reloadCount += 1;
    last = false;
    // Webhook lands, pro snapshot arrives.
    if (shouldReloadOnEntitlementChange(last, true)) reloadCount += 1;
    last = true;

    assert.equal(reloadCount, 1);
  });
});
