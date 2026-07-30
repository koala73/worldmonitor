import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PANEL_CATEGORY_MAP, VARIANT_DEFAULTS, getVariantPanelCategories, getProPanelKeys } from '../src/config/panels';
import type { PanelConfig } from '../src/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

// getVariantPanelCategories feeds both the UnifiedSettings panel-tab filter
// and the mobile category nav (MobilePanelNav). Regression target: the
// mobile nav must only surface categories the user can actually browse —
// variant-scoped and with at least one enabled panel.

function settings(entries: Record<string, boolean>): Record<string, PanelConfig> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, enabled]) => [key, { name: key, enabled }]),
  );
}

describe('getVariantPanelCategories', () => {
  it('drops categories with no enabled panel', () => {
    const result = getVariantPanelCategories(settings({ cii: false, intel: false }), 'full');
    assert.equal(result.length, 0);
  });

  it('includes a category once any of its panels is enabled', () => {
    const result = getVariantPanelCategories(settings({ cii: true, intel: false }), 'full');
    assert.deepEqual(result.map((c) => c.key), ['intelligence']);
    assert.equal(result[0]!.labelKey, PANEL_CATEGORY_MAP['intelligence']!.labelKey);
    assert.deepEqual(result[0]!.panelKeys, PANEL_CATEGORY_MAP['intelligence']!.panelKeys);
  });

  it('panels absent from settings never activate a category', () => {
    // cii enabled=true but the category lookup goes through settings — a
    // panel key that is missing entirely must not count as enabled.
    const result = getVariantPanelCategories(settings({ 'not-a-real-panel': true }), 'full');
    assert.equal(result.length, 0);
  });

  it('respects variant scoping (gulfMena is finance-only)', () => {
    const enabled = settings({ 'gulf-economies': true });
    assert.ok(PANEL_CATEGORY_MAP['gulfMena']!.variants?.includes('finance'), 'fixture assumption');
    const forFull = getVariantPanelCategories(enabled, 'full');
    const forFinance = getVariantPanelCategories(enabled, 'finance');
    assert.ok(!forFull.some((c) => c.key === 'gulfMena'));
    assert.ok(forFinance.some((c) => c.key === 'gulfMena'));
  });

  it('unscoped categories (core) are available to every variant', () => {
    assert.equal(PANEL_CATEGORY_MAP['core']!.variants, undefined, 'core stays unscoped');
    const enabled = settings({ 'live-news': true });
    for (const variant of ['full', 'tech', 'finance', 'commodity', 'energy', 'happy']) {
      const result = getVariantPanelCategories(enabled, variant);
      assert.ok(
        result.some((c) => c.key === 'core'),
        `variant ${variant} should see the core category`,
      );
    }
  });

  // Chip-clutter guardrail: before the variants tags were populated, every
  // variant surfaced 10-15 categories (incl. two distinct chips both labeled
  // "Markets") because cross-variant panel keys lit up foreign categories.
  // The mobile nav and the settings filter both depend on this curation.
  it('variant defaults yield the curated category set, free of duplicate labels', () => {
    const expected: Record<string, string[]> = {
      full: ['core', 'intelligence', 'correlation', 'regionalNews', 'marketsFinance', 'topical', 'dataTracking'],
      tech: ['core', 'techAi', 'startupsVc', 'securityPolicy', 'techMarkets'],
      finance: ['core', 'finMarkets', 'fixedIncomeFx', 'finCommodities', 'cryptoDigital', 'centralBanksEcon', 'dealsInstitutional', 'gulfMena'],
      commodity: ['core', 'commodityPrices', 'miningIndustry', 'commodityEcon'],
      energy: ['core', 'marketsFinance', 'topical', 'dataTracking'],
      happy: ['core', 'happyNews', 'happyPlanet'],
    };
    for (const [variant, expectedKeys] of Object.entries(expected)) {
      const enabledDefaults = settings(
        Object.fromEntries((VARIANT_DEFAULTS[variant] ?? []).map((k: string) => [k, true])),
      );
      const result = getVariantPanelCategories(enabledDefaults, variant);
      assert.deepEqual(result.map((c) => c.key), expectedKeys, `variant ${variant}`);
      const labels = result.map((c) => c.labelKey);
      assert.equal(new Set(labels).size, labels.length, `duplicate category labels for ${variant}`);
    }
  });

  it('preserves PANEL_CATEGORY_MAP declaration order', () => {
    const all = settings(
      Object.fromEntries(
        Object.values(PANEL_CATEGORY_MAP).flatMap((def) => def.panelKeys.map((k) => [k, true])),
      ),
    );
    const keys = getVariantPanelCategories(all, 'full').map((c) => c.key);
    const expected = Object.keys(PANEL_CATEGORY_MAP).filter((k) => keys.includes(k));
    assert.deepEqual(keys, expected);
  });
});

describe('getProPanelKeys (mobile nav PRO chip)', () => {
  // NOTE: runs on the web surface (no Tauri under tsx) — desktop-only
  // premium fields (`_desktop && {...}` in panels.ts) are absent here, so
  // assertions cover the web gating shape.
  it('includes enabled premium panels, excludes free and disabled ones', () => {
    const result = getProPanelKeys(settings({
      'stock-analysis': true,   // premium: 'locked' on all surfaces
      'chat-analyst': true,     // premium: 'locked' on all surfaces
      'daily-market-brief': false, // premium but disabled
      intel: true,              // free panel
    }), 'full');
    assert.deepEqual(result.sort(), ['chat-analyst', 'stock-analysis']);
  });

  it('drops unknown keys (custom widgets / MCP panels)', () => {
    const result = getProPanelKeys(settings({ 'cw-abc123': true, 'mcp-panel-1': true }), 'full');
    assert.deepEqual(result, []);
  });

  it('full-variant defaults surface a non-empty premium suite', () => {
    const enabledDefaults = settings(
      Object.fromEntries((VARIANT_DEFAULTS['full'] ?? []).map((k: string) => [k, true])),
    );
    const result = getProPanelKeys(enabledDefaults, 'full');
    assert.ok(result.includes('stock-analysis'));
    assert.ok(result.includes('chat-analyst'));
    assert.ok(result.length >= 5, `expected a meaningful premium suite, got ${result.join(', ')}`);
  });
});

describe('mobile nav i18n contract', () => {
  it('every category labelKey resolves in en.json', () => {
    const en = JSON.parse(readFileSync(resolve(__dirname, '../src/locales/en.json'), 'utf-8'));
    const lookup = (path: string): unknown =>
      path.split('.').reduce<unknown>((node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined, en);

    for (const [key, def] of Object.entries(PANEL_CATEGORY_MAP)) {
      assert.equal(typeof lookup(def.labelKey), 'string', `missing en.json key ${def.labelKey} (category ${key})`);
    }
    // The "all" chip both consumers prepend:
    assert.equal(typeof lookup('header.sourceRegionAll'), 'string');
    // The nav's accessible name:
    assert.equal(typeof lookup('components.mobileNav.panelCategories'), 'string');
  });
});
