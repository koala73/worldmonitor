/**
 * Dashboard focus (#10453): a panel never silently ignores the focus. Every
 * panel declares whether it filters by country, is global by nature, or is not
 * supported yet; the last two show "Not filtered" in their header.
 *
 * This fails when a panel is added to any variant without a declaration, and
 * when the registry keeps a key no variant has any more.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ALL_PANELS, VARIANT_DEFAULTS } from '../src/config/panels.ts';
import { PANEL_SCOPE_BEHAVIOUR, PANEL_SCOPE_REASONS, getPanelScopeBehaviour } from '../src/config/panel-scope.ts';

const BEHAVIOURS = new Set(['filters', 'global', 'unsupported']);

describe('PANEL_SCOPE_BEHAVIOUR', () => {
  it('declares a behaviour for every panel of every variant', () => {
    const variantKeys = Object.values(VARIANT_DEFAULTS).flat();
    const keys = new Set([...Object.keys(ALL_PANELS), ...variantKeys]);
    const missing = [...keys].filter((key) => !Object.prototype.hasOwnProperty.call(PANEL_SCOPE_BEHAVIOUR, key));
    assert.deepEqual(missing, [], `declare a focus behaviour in src/config/panel-scope.ts for: ${missing.join(', ')}`);
  });

  it('holds no key that is not a panel', () => {
    const stale = Object.keys(PANEL_SCOPE_BEHAVIOUR).filter((key) => !Object.prototype.hasOwnProperty.call(ALL_PANELS, key));
    assert.deepEqual(stale, [], `remove from src/config/panel-scope.ts: ${stale.join(', ')}`);
  });

  it('uses only the three behaviours', () => {
    for (const [key, behaviour] of Object.entries(PANEL_SCOPE_BEHAVIOUR)) {
      assert.ok(BEHAVIOURS.has(behaviour), `${key}: ${behaviour}`);
    }
  });

  it('marks markets and prices global, and the Phase 1 panels as filtering', () => {
    for (const key of ['markets', 'commodities', 'crypto', 'fear-greed', 'yield-curve']) {
      assert.equal(getPanelScopeBehaviour(key), 'global', key);
    }
    for (const key of ['politics', 'security-advisories', 'ucdp-events', 'airline-intel']) {
      assert.equal(getPanelScopeBehaviour(key), 'filters', key);
    }
  });

  it('declares as filtering exactly the panels whose class filters (news regions, advisories, UCDP, aviation, and the phase 2 panels)', () => {
    const filtering = Object.entries(PANEL_SCOPE_BEHAVIOUR)
      .filter(([, behaviour]) => behaviour === 'filters')
      .map(([key]) => key)
      .sort();
    assert.deepEqual(filtering, [
      'africa', 'airline-intel', 'asia', 'cii', 'disaster-correlation', 'disease-outbreaks', 'displacement',
      'economic-correlation', 'energy-disruptions', 'escalation-correlation', 'europe', 'fuel-shortages',
      'intel', 'internet-disruptions', 'latam', 'middleeast', 'military-correlation', 'politics',
      'radiation-watch', 'security-advisories', 'ucdp-events', 'us',
    ]);
  });

  it('does not claim filtering for regional zones or a pre-cut worldwide slice', () => {
    assert.equal(getPanelScopeBehaviour('climate'), 'unsupported');
    assert.equal(getPanelScopeBehaviour('population-exposure'), 'unsupported');
  });
});

describe('PANEL_SCOPE_REASONS', () => {
  it('explains only panels that are real and still not supported', () => {
    for (const [key, reason] of Object.entries(PANEL_SCOPE_REASONS)) {
      assert.ok(Object.prototype.hasOwnProperty.call(ALL_PANELS, key), `${key} is not a panel`);
      assert.equal(getPanelScopeBehaviour(key), 'unsupported', `${key} filters now: remove its reason`);
      assert.ok(reason.length > 20, `${key} needs a real reason`);
    }
  });
});

describe('getPanelScopeBehaviour', () => {
  it('treats custom widgets, MCP panels and unknown keys as not supported', () => {
    assert.equal(getPanelScopeBehaviour('cw-abc123'), 'unsupported');
    assert.equal(getPanelScopeBehaviour('mcp-weather'), 'unsupported');
    assert.equal(getPanelScopeBehaviour('runtime-config'), 'unsupported');
    assert.equal(getPanelScopeBehaviour('no-such-panel'), 'unsupported');
  });

  it('does not answer for inherited object members', () => {
    assert.equal(getPanelScopeBehaviour('constructor'), 'unsupported');
    assert.equal(getPanelScopeBehaviour('__proto__'), 'unsupported');
  });
});
