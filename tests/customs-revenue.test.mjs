import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

describe('Customs revenue handler', () => {
  const handlerSrc = readFileSync(join(root, 'server/worldmonitor/trade/v1/get-customs-revenue.ts'), 'utf-8');

  it('reads from Redis with raw key mode (true)', () => {
    assert.match(handlerSrc, /getCachedJson\(\s*CUSTOMS_KEY\s*,\s*true\s*\)/);
  });

  it('returns upstreamUnavailable: true when cache is empty', () => {
    assert.match(handlerSrc, /upstreamUnavailable:\s*true/);
  });

  it('uses the correct Redis key', () => {
    assert.match(handlerSrc, /trade:customs-revenue:v1/);
  });
});

describe('Customs revenue seed', () => {
  const seedSrc = readFileSync(join(root, 'scripts/seed-supply-chain-trade.mjs'), 'utf-8');

  it('fetches from Treasury Fiscal Data API', () => {
    assert.match(seedSrc, /api\.fiscaldata\.treasury\.gov/);
  });

  it('filters for Customs Duties classification', () => {
    assert.match(seedSrc, /classification_desc:eq:Customs%20Duties/);
  });

  it('uses AbortSignal.timeout for safety', () => {
    assert.match(seedSrc, /AbortSignal\.timeout\(15_000\)/);
  });

  it('validates row count before writing', () => {
    assert.match(seedSrc, /rows\.length > 100/);
  });

  it('converts amounts from dollars to billions', () => {
    assert.match(seedSrc, /\/\s*1e9/);
  });

  it('reverses to ascending order after fetching desc', () => {
    assert.match(seedSrc, /\.reverse\(\)/);
  });

  it('writes customs revenue as extra key with seed-meta', () => {
    assert.match(seedSrc, /writeExtraKeyWithMeta\(KEYS\.customsRevenue/);
  });

  it('seed-meta key strips :v1 for health.js compatibility', () => {
    const healthSrc = readFileSync(join(root, 'api/health.js'), 'utf-8');
    assert.match(healthSrc, /seed-meta:trade:customs-revenue/);
    assert.match(seedSrc, /trade:customs-revenue:v1/);
  });
});

describe('Customs revenue panel (WTO gate fix)', () => {
  const panelSrc = readFileSync(join(root, 'src/components/TradePolicyPanel.ts'), 'utf-8');

  it('includes revenue in TabId type', () => {
    assert.match(panelSrc, /type TabId\s*=.*'revenue'/);
  });

  it('has updateRevenue method', () => {
    assert.match(panelSrc, /public updateRevenue\(/);
  });

  it('does NOT have panel-wide early return for missing WTO key', () => {
    assert.doesNotMatch(panelSrc, /if \(isDesktopRuntime\(\) && !isFeatureAvailable\('wtoTrade'\)\)\s*\{[\s\S]*?return;\s*\}/);
  });

  it('uses per-tab wtoAvailable gating', () => {
    assert.match(panelSrc, /const wtoAvailable = !isDesktopRuntime\(\) \|\| isFeatureAvailable\('wtoTrade'\)/);
  });

  it('defaults to revenue tab when WTO key is missing (comtrade exempt)', () => {
    assert.match(panelSrc, /if \(!wtoAvailable && this\.activeTab !== 'revenue' && this\.activeTab !== 'comtrade'\)/);
  });

  it('shows localized Treasury source for revenue tab', () => {
    assert.match(panelSrc, /activeTab === 'revenue' \? t\('components\.tradePolicy\.sourceTreasury'\)/);
  });

  it('computes FYTD comparison with same month count from prior fiscal year', () => {
    assert.match(panelSrc, /priorFyAll\.slice\(0, currentFyCount\)/);
  });
});

describe('Customs revenue client service', () => {
  const serviceSrc = readFileSync(join(root, 'src/services/trade/index.ts'), 'utf-8');

  it('does NOT gate fetchCustomsRevenue behind wtoTrade feature flag', () => {
    const fnMatch = serviceSrc.match(/export async function fetchCustomsRevenue[\s\S]*?^}/m);
    assert.ok(fnMatch, 'fetchCustomsRevenue function not found');
    assert.doesNotMatch(fnMatch[0], /isFeatureAvailable\('wtoTrade'\)/);
  });

  it('uses bootstrap hydration inside fetchCustomsRevenue', () => {
    assert.match(serviceSrc, /getHydratedData\('customsRevenue'\)/);
  });

  it('re-exports CustomsRevenueMonth type', () => {
    assert.match(serviceSrc, /export type \{[^}]*CustomsRevenueMonth/);
  });

  it('re-exports GetCustomsRevenueResponse type', () => {
    assert.match(serviceSrc, /export type \{[^}]*GetCustomsRevenueResponse/);
  });
});
