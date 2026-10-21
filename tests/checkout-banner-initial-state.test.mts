/**
 * Unit tests for the banner timing constants. DOM-level state transitions
 * (pending → active → timeout) are async + event-driven and are covered
 * by manual verification.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXTENDED_UNLOCK_TIMEOUT_MS,
  CLASSIC_AUTO_DISMISS_MS,
  ENTITLEMENT_POLL_MS,
  LATE_ACTIVATION_GRACE_MS,
} from '../src/services/checkout-banner-state.ts';

describe('banner timing constants', () => {
  it('EXTENDED_UNLOCK_TIMEOUT_MS is 30s — covers webhook/propagation long tail', () => {
    assert.equal(EXTENDED_UNLOCK_TIMEOUT_MS, 30_000);
  });

  it('CLASSIC_AUTO_DISMISS_MS is 5s — fast fade when unlock is already guaranteed', () => {
    assert.equal(CLASSIC_AUTO_DISMISS_MS, 5_000);
  });

  it('classic auto-dismiss is strictly shorter than extended timeout', () => {
    // If this ever flips, the non-extended flow would outlive the
    // entitlement-wait flow, which defeats the "fast fade" intent.
    assert.ok(CLASSIC_AUTO_DISMISS_MS < EXTENDED_UNLOCK_TIMEOUT_MS);
  });

  it('ENTITLEMENT_POLL_MS is 1s', () => {
    assert.equal(ENTITLEMENT_POLL_MS, 1_000);
  });

  it('LATE_ACTIVATION_GRACE_MS is 5min', () => {
    assert.equal(LATE_ACTIVATION_GRACE_MS, 300_000);
  });

  it('the poll fits several times inside the deadline', () => {
    // A poll interval at or near the deadline would make the poll pointless —
    // the deadline re-check would always beat it (WORLDMONITOR-PZ).
    assert.ok(ENTITLEMENT_POLL_MS * 5 <= EXTENDED_UNLOCK_TIMEOUT_MS);
  });

  it('the late-activation grace outlives the deadline', () => {
    // The grace window exists to catch activations SLOWER than the deadline.
    // A grace shorter than the wait itself would close before those land.
    assert.ok(LATE_ACTIVATION_GRACE_MS > EXTENDED_UNLOCK_TIMEOUT_MS);
  });
});
