import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FREE_DELIVERY_CHANNELS,
  FREE_DELIVERY_SEVERITIES,
  FREE_EXCLUDED_EVENT_TYPES,
  freeTierAllowsChannel,
  freeTierAllowsEvent,
  freeTierAllowsEventType,
} from '../scripts/lib/free-tier-delivery.cjs';
import { ORBITAL_SITE_ALERT_EVENT_TYPES } from '../shared/alert-rule-shape.ts';

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

  it('free tier never receives Pro-only orbital event types (Strix 3e984e61)', () => {
    // Orbital events are stamped critical and carry no country attribution,
    // so this rung is the only thing between a downgraded account's leftover
    // rule and the paid stream.
    assert.deepEqual([...FREE_EXCLUDED_EVENT_TYPES].sort(), [...ORBITAL_SITE_ALERT_EVENT_TYPES].sort());
    for (const type of ORBITAL_SITE_ALERT_EVENT_TYPES) {
      assert.equal(freeTierAllowsEventType(0, type), false, type);
    }
    assert.equal(freeTierAllowsEventType(0, 'military_conflict'), true);
    assert.equal(freeTierAllowsEventType(0, undefined), true);
  });

  it('paid tiers are never clamped', () => {
    for (const tier of [1, 2, 3]) {
      assert.equal(freeTierAllowsEvent(tier, 'low'), true);
      assert.equal(freeTierAllowsChannel(tier, 'webhook'), true);
      for (const type of ORBITAL_SITE_ALERT_EVENT_TYPES) {
        assert.equal(freeTierAllowsEventType(tier, type), true, `${tier}:${type}`);
      }
    }
  });
});

describe('free-tier country scope clamp (#4273, Greptile P1)', async () => {
  const { freeTierCountryScope, FREE_DELIVERY_MAX_COUNTRIES } = await import('../scripts/lib/free-tier-delivery.cjs');

  it('free worldwide (missing or empty countries) does not deliver', () => {
    assert.deepEqual(freeTierCountryScope(0, undefined), { ok: false, countries: [] });
    assert.deepEqual(freeTierCountryScope(0, []), { ok: false, countries: [] });
  });

  it('free over-cap legacy scopes clamp to the first entries', () => {
    const scope = freeTierCountryScope(0, ['UA', 'TW', 'LB', 'IL', 'PL']);
    assert.equal(scope.ok, true);
    assert.deepEqual(scope.countries, ['UA', 'TW', 'LB']);
    assert.equal(scope.countries.length, FREE_DELIVERY_MAX_COUNTRIES);
  });

  it('paid tiers keep their scope, worldwide included', () => {
    assert.deepEqual(freeTierCountryScope(1, undefined), { ok: true, countries: undefined });
    assert.deepEqual(freeTierCountryScope(2, ['UA']), { ok: true, countries: ['UA'] });
  });
});
