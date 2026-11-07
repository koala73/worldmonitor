import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FREE_DELIVERY_CHANNELS,
  FREE_DELIVERY_SEVERITIES,
  freeTierAllowsChannel,
  freeTierAllowsEvent,
} from '../scripts/lib/free-tier-delivery.cjs';

// Delivery-time clamp for the free alert ladder (#4273). These constants
// mirror shared/alert-capabilities.ts (the relay is CJS); the sets below are
// asserted literally so a drift in either file fails one of the two suites.

describe('free-tier delivery clamp (#4273)', () => {
  it('mirrors the shared free ladder exactly', () => {
    assert.deepEqual([...FREE_DELIVERY_CHANNELS].sort(), ['email', 'web_push']);
    assert.deepEqual([...FREE_DELIVERY_SEVERITIES], ['critical']);
  });

  it('free tier delivers critical events only', () => {
    assert.equal(freeTierAllowsEvent(0, 'critical'), true);
    assert.equal(freeTierAllowsEvent(0, 'high'), false);
    assert.equal(freeTierAllowsEvent(0, 'medium'), false);
    assert.equal(freeTierAllowsEvent(0, undefined), false);
  });

  it('free tier delivers over web push and email only', () => {
    assert.equal(freeTierAllowsChannel(0, 'web_push'), true);
    assert.equal(freeTierAllowsChannel(0, 'email'), true);
    for (const channel of ['slack', 'discord', 'telegram', 'teams', 'webhook']) {
      assert.equal(freeTierAllowsChannel(0, channel), false, channel);
    }
  });

  it('paid tiers are never clamped', () => {
    for (const tier of [1, 2, 3]) {
      assert.equal(freeTierAllowsEvent(tier, 'low'), true);
      assert.equal(freeTierAllowsChannel(tier, 'webhook'), true);
    }
  });
});
