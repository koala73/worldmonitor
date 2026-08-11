import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VARIANT_DEFAULTS, enforceFreePanelLimit, getEffectivePanelConfig } from '../src/config/panels.ts';
import {
  FULL_DEFAULT_COLLAPSED_PANEL_KEYS,
  prioritizeFullPanelKeys,
  shouldSeedFullEconomyDefaultCollapse,
} from '../src/config/full-layout-defaults.ts';
import { latestFreshProviderObservation } from '../src/services/realtime-observation.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8');

describe('Phase 8 full-dashboard priority and truthful degradation', () => {
  it('puts market/stock work ahead of macro, logistics, news and posture on a fresh full layout', () => {
    const order = VARIANT_DEFAULTS.full;

    assert.deepEqual(order.slice(0, 5), [
      'markets',
      'stock-analysis',
      'stock-backtest',
      'daily-market-brief',
      'market-implications',
    ]);
    assert.ok(order.indexOf('economic') < order.indexOf('supply-chain'));
    assert.ok(order.indexOf('supply-chain') < order.indexOf('live-news'));
    assert.ok(order.indexOf('live-news') < order.indexOf('disaster-correlation'));
    for (const key of FULL_DEFAULT_COLLAPSED_PANEL_KEYS) {
      assert.ok(order.indexOf(key) > order.indexOf('disaster-correlation'), `${key} must remain below disaster/infrastructure`);
    }
    assert.equal(new Set(order).size, order.length, 'default order must not duplicate a panel');
  });

  it('keeps unknown future panels while placing known provider-dependent keys last', () => {
    assert.deepEqual(
      prioritizeFullPanelKeys(['military-correlation', 'future-panel', 'markets', 'airline-intel']),
      ['markets', 'future-panel', 'military-correlation', 'airline-intel'],
    );
  });

  it('seeds collapsed military/aviation defaults only where no user order exists', () => {
    assert.equal(shouldSeedFullEconomyDefaultCollapse('full', false), true);
    assert.equal(shouldSeedFullEconomyDefaultCollapse('full', true), false);
    assert.equal(shouldSeedFullEconomyDefaultCollapse('finance', false), false);
  });

  it('keeps military configuration notices reachable within the free-panel cap', () => {
    const fullDefaults = Object.fromEntries(
      VARIANT_DEFAULTS.full.map((key) => [key, { ...getEffectivePanelConfig(key, 'full') }]),
    );
    const clamped = enforceFreePanelLimit(fullDefaults, false);

    assert.equal(clamped['military-correlation']?.enabled, true);
    assert.equal(clamped['escalation-correlation']?.enabled, true);
  });

  it('does not mistake a layer toggle, stale sample, future timestamp, or blank source for a fresh observation', () => {
    const now = Date.UTC(2026, 7, 11, 14, 0, 0);
    const fresh = latestFreshProviderObservation([
      { source: 'OpenSky', observedAt: new Date(now - 10_000) },
      { source: 'Old source', observedAt: new Date(now - 10 * 60_000) },
      { source: '', observedAt: new Date(now - 1_000) },
      { source: 'Future source', observedAt: new Date(now + 1_000) },
    ], now);
    assert.equal(fresh?.source, 'OpenSky');
    assert.equal(fresh?.ageMs, 10_000);
    assert.equal(latestFreshProviderObservation([{ source: 'OpenSky', observedAt: new Date(now - 301_000) }], now), null);
  });

  it('uses the existing dashboard and exposes the native stock workspace from the market surface', () => {
    const layout = source('src/app/panel-layout.ts');
    const market = source('src/components/MarketPanel.ts');
    const app = source('src/App.ts');
    const military = source('src/components/MilitaryCorrelationPanel.ts');
    const airline = source('src/components/AirlineIntelPanel.ts');

    assert.match(layout, /SITE_VARIANT !== 'happy' && SITE_VARIANT !== 'full'/);
    assert.match(market, /stockWorkspaceLink\.href = stockWorkspaceUrl\('AAPL'\)/);
    assert.match(app, /FULL_ECONOMY_LAYOUT_MIGRATION_KEY/);
    assert.match(app, /if \(!\(key in collapsed\)\) savePanelCollapsed\(key, true\)/);
    assert.match(military, /this\.requestRender\(\);\s*if \(!this\.officialActivity\) void this\.hydrateOfficialActivity\(\)/);
    assert.match(airline, /latestFreshProviderObservation\(this\.trackingData\)/);
  });
});
