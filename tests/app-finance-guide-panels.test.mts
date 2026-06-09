import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appSource = fs.readFileSync('/Users/lab2/AI/AI_1/worldmonitor/src/App.ts', 'utf8');

test('finance variant force-enables portfolio guide panels during app init', () => {
  assert.match(appSource, /currentVariant === 'finance'/);
  assert.match(appSource, /\['portfolio-impact', 'idea-radar'\] as const/);
  assert.match(appSource, /config && config\.enabled === false/);
  assert.match(appSource, /panelSettings\[key\] = \{ \.\.\.config, enabled: true \}/);
  assert.match(appSource, /saveToStorage\(STORAGE_KEYS\.panels, panelSettings\)/);
});

test('finance variant disables noisy retry-prone panels once during app init', () => {
  assert.match(appSource, /FINANCE_NOISY_PANELS_FIX_KEY = 'worldmonitor-finance-noisy-panels-v5'/);
  assert.match(appSource, /const noisyFinanceKeys = \[/);
  assert.match(appSource, /'macro-tiles'/);
  assert.match(appSource, /'fear-greed'/);
  assert.match(appSource, /'market-breadth'/);
  assert.match(appSource, /'yield-curve'/);
  assert.match(appSource, /'crypto-heatmap'/);
  assert.match(appSource, /'centralbanks'/);
  assert.match(appSource, /'pipeline-status'/);
  assert.match(appSource, /'insights'/);
  assert.match(appSource, /'economic'/);
  assert.match(appSource, /'sanctions-pressure'/);
  assert.match(appSource, /'supply-chain'/);
  assert.match(appSource, /'economic-news'/);
  assert.match(appSource, /'live-webcams'/);
  assert.match(appSource, /'markets-news'/);
  assert.match(appSource, /'commodities-news'/);
  assert.match(appSource, /'crypto-news'/);
  assert.match(appSource, /'ipo'/);
  assert.match(appSource, /'derivatives'/);
  assert.match(appSource, /'fintech'/);
  assert.match(appSource, /'fin-regulation'/);
  assert.match(appSource, /'institutional'/);
  assert.match(appSource, /'analysis'/);
  assert.match(appSource, /'etf-flows'/);
  assert.match(appSource, /'stablecoins'/);
  assert.match(appSource, /'gcc-investments'/);
  assert.match(appSource, /'gccNews'/);
  assert.match(appSource, /'airline-intel'/);
  assert.match(appSource, /'monitors'/);
  assert.match(appSource, /config\?\.enabled/);
  assert.match(appSource, /panelSettings\[key\] = \{ \.\.\.config, enabled: false \}/);
});

test('finance variant promotes guide and core market panels to the top of saved order once', () => {
  assert.match(appSource, /FINANCE_PANEL_ORDER_FIX_KEY = 'worldmonitor-finance-panel-order-v6'/);
  assert.match(appSource, /const priorityFinancePanels = \['portfolio-impact', 'idea-radar', 'markets', 'macro-signals', 'live-news'\]/);
  assert.match(appSource, /const nextOrder = priorityFinancePanels\.filter\(\(key\) => order\.includes\(key\)\);/);
  assert.match(appSource, /nextOrder\.push\(\.\.\.order\.filter\(\(key\) => !priorityFinancePanels\.includes\(key\)\)\);/);
  assert.match(appSource, /localStorage\.setItem\(PANEL_ORDER_KEY, JSON\.stringify\(nextOrder\)\);/);
});

test('full variant promotes global intel panels to the top of saved order once', () => {
  assert.match(appSource, /FULL_PANEL_ORDER_FIX_KEY = 'worldmonitor-full-panel-order-v1'/);
  assert.match(appSource, /const priorityFullPanels = \['live-news', 'insights', 'strategic-posture', 'forecast', 'strategic-risk', 'markets'\]/);
  assert.match(appSource, /const nextOrder = priorityFullPanels\.filter\(\(key\) => order\.includes\(key\)\);/);
  assert.match(appSource, /nextOrder\.push\(\.\.\.order\.filter\(\(key\) => !priorityFullPanels\.includes\(key\)\)\);/);
  assert.match(appSource, /localStorage\.setItem\(FULL_PANEL_ORDER_FIX_KEY, 'done'\);/);
});

test('full variant disables noisy external panels once during app init', () => {
  assert.match(appSource, /FULL_NOISY_PANELS_FIX_KEY = 'worldmonitor-full-noisy-panels-v1'/);
  assert.match(appSource, /const noisyFullKeys = \[/);
  assert.match(appSource, /'satellite-fires'/);
  assert.match(appSource, /'fear-greed'/);
  assert.match(appSource, /'market-breadth'/);
  assert.match(appSource, /'liquidity-shifts'/);
  assert.match(appSource, /'positioning-247'/);
  assert.match(appSource, /'gold-intelligence'/);
  assert.match(appSource, /'pipeline-status'/);
  assert.match(appSource, /'storage-facility-map'/);
  assert.match(appSource, /'fuel-shortages'/);
  assert.match(appSource, /'energy-disruptions'/);
  assert.match(appSource, /'etf-flows'/);
  assert.match(appSource, /'stablecoins'/);
  assert.match(appSource, /'ucdp-events'/);
  assert.match(appSource, /'disease-outbreaks'/);
  assert.match(appSource, /'social-velocity'/);
  assert.match(appSource, /'sanctions-pressure'/);
});

test('tech, energy, and commodity variants promote their core panels to the top once', () => {
  assert.match(appSource, /worldmonitor-tech-panel-order-v1/);
  assert.match(appSource, /worldmonitor-energy-panel-order-v1/);
  assert.match(appSource, /worldmonitor-commodity-panel-order-v1/);
  assert.match(appSource, /panels: \['live-news', 'insights', 'tech-readiness', 'security', 'service-status', 'markets'\]/);
  assert.match(appSource, /panels: \['energy-risk-overview', 'chokepoint-strip', 'pipeline-status', 'energy-complex', 'live-news', 'insights'\]/);
  assert.match(appSource, /panels: \['live-news', 'insights', 'markets', 'commodities', 'macro-signals', 'supply-chain'\]/);
  assert.match(appSource, /const nextOrder = variantPriorityMigration\.panels\.filter\(\(key\) => order\.includes\(key\)\);/);
  assert.match(appSource, /nextOrder\.push\(\.\.\.order\.filter\(\(key\) => !variantPriorityMigration\.panels\.includes\(key\)\)\);/);
});
