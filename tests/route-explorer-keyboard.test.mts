/**
 * RouteExplorer module-surface tests.
 *
 * Sprint 3 added real service imports (@/services/resilience, @/services/panel-gating)
 * which depend on import.meta.env.DEV at module top-level via @/utils/proxy.
 * Node's tsx test runner does not provide Vite's import.meta.env, so dynamic
 * import of RouteExplorer.ts crashes in node:test.
 *
 * Pure formatting/filtering/url-state logic is covered by the sibling test files
 * (route-explorer-pickers, route-explorer-url-state). This file covers the
 * route-utils formatters only.
 *
 * The modal lifecycle, keyboard bindings, and focus trap are NOT covered. This
 * file used to name e2e/route-explorer.spec.ts as their home; no such spec
 * exists and nothing under e2e/ references RouteExplorer, so the claim read as
 * coverage that was never written.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('RouteExplorer route-utils formatters', () => {
  it('route-utils formatters import cleanly in node', async () => {
    const mod = await import('../src/components/RouteExplorer/tabs/route-utils.ts');
    assert.equal(typeof mod.formatTransitRange, 'function');
    assert.equal(typeof mod.formatFreightRange, 'function');
    assert.equal(typeof mod.formatCostDelta, 'function');
    assert.equal(typeof mod.warRiskTierLabel, 'function');
    assert.equal(typeof mod.corridorStatusLabel, 'function');
  });

  it('formatTransitRange renders a range', async () => {
    const { formatTransitRange } = await import('../src/components/RouteExplorer/tabs/route-utils.ts');
    assert.match(formatTransitRange({ min: 14, max: 18 }), /14.*18/);
    assert.equal(formatTransitRange(undefined), '\u2014');
  });

  it('formatCostDelta formats +Xd / +Y%', async () => {
    const { formatCostDelta } = await import('../src/components/RouteExplorer/tabs/route-utils.ts');
    assert.match(formatCostDelta(12, 1.18), /\+12d.*\+18%/);
  });

  it('warRiskTierLabel maps enum to human label', async () => {
    const { warRiskTierLabel } = await import('../src/components/RouteExplorer/tabs/route-utils.ts');
    assert.equal(warRiskTierLabel('WAR_RISK_TIER_CRITICAL'), 'Critical');
    assert.equal(warRiskTierLabel('WAR_RISK_TIER_NORMAL'), 'Normal');
  });

  it('corridorStatusLabel maps enum to display text', async () => {
    const { corridorStatusLabel } = await import('../src/components/RouteExplorer/tabs/route-utils.ts');
    assert.equal(corridorStatusLabel('CORRIDOR_STATUS_PROPOSED'), '(proposed)');
    assert.equal(corridorStatusLabel('CORRIDOR_STATUS_UNAVAILABLE'), '(unavailable)');
    assert.equal(corridorStatusLabel('CORRIDOR_STATUS_ACTIVE'), '');
  });
});
