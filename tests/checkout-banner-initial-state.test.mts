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
});
