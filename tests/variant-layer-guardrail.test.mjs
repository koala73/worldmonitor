/**
 * Guardrail: every layer enabled by default in a variant's MapLayers
 * MUST be in VARIANT_LAYER_ORDER (DeckGL/Globe toggle) or SVG_ONLY_LAYERS
 * (SVG fallback toggle). Layers in VARIANT_LAYER_ORDER must have at least
 * one DeckGL/Globe renderer so getLayersForVariant() returns them.
 *
 * Without this, layers render but have no UI toggle → users can't turn them off.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = new URL('../src/config/', import.meta.url);

const layerDefsSource = readFileSync(new URL('map-layer-definitions.ts', SRC), 'utf8');
const panelsSource = readFileSync(new URL('panels.ts', SRC), 'utf8');

function extractRecordBlock(source, name) {
  const re = new RegExp(`(?:const|export const)\\s+${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`);
  const match = source.match(re);
  if (!match) return null;
  const body = match[1];
  const result = {};
  const variantRe = /(\w+):\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = variantRe.exec(body)) !== null) {
    const keys = m[2].match(/'(\w+)'/g)?.map(s => s.replace(/'/g, '')) ?? [];
    result[m[1]] = new Set(keys);
  }
  return result;
}

function extractLayerRenderers(source) {
  const result = {};
  const registryMatch = source.match(/LAYER_REGISTRY[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!registryMatch) throw new Error('Could not find LAYER_REGISTRY');
  const body = registryMatch[1];
  const defRe = /def\(\s*'(\w+)'[^)]*\)/g;
  let m;
  while ((m = defRe.exec(body)) !== null) {
    const key = m[1];
    const fullCall = m[0];
    const renderersMatch = fullCall.match(/\[([^\]]*)\]\s*(?:,\s*(?:'[^']*'|undefined))?\s*\)/);
    if (renderersMatch) {
      const renderers = renderersMatch[1].match(/'(\w+)'/g)?.map(s => s.replace(/'/g, '')) ?? [];
      result[key] = renderers;
    } else {
      result[key] = ['flat', 'globe'];
    }
  }
  return result;
}

function extractEnabledLayers(source, constName) {
  const re = new RegExp(`const ${constName}[^=]*=\\s*\\{([\\s\\S]*?)\\};`);
  const match = source.match(re);
  if (!match) throw new Error(`Could not find ${constName}`);
  const enabled = [];
  const lineRe = /(\w+):\s*true/g;
  let m;
  while ((m = lineRe.exec(match[1])) !== null) {
    enabled.push(m[1]);
  }
  return enabled;
}

const variantOrder = extractRecordBlock(layerDefsSource, 'VARIANT_LAYER_ORDER');
const svgOnlyLayers = extractRecordBlock(layerDefsSource, 'SVG_ONLY_LAYERS') ?? {};
const layerRenderers = extractLayerRenderers(layerDefsSource);

function getAllowedForVariant(variant) {
  const allowed = new Set(variantOrder[variant] ?? []);
  for (const k of svgOnlyLayers[variant] ?? []) allowed.add(k);
  return allowed;
}

const VARIANT_DEFAULTS = {
  full:      { desktop: 'FULL_MAP_LAYERS',      mobile: 'FULL_MOBILE_MAP_LAYERS' },
  tech:      { desktop: 'TECH_MAP_LAYERS',      mobile: 'TECH_MOBILE_MAP_LAYERS' },
  finance:   { desktop: 'FINANCE_MAP_LAYERS',    mobile: 'FINANCE_MOBILE_MAP_LAYERS' },
  happy:     { desktop: 'HAPPY_MAP_LAYERS',      mobile: 'HAPPY_MOBILE_MAP_LAYERS' },
  commodity: { desktop: 'COMMODITY_MAP_LAYERS',  mobile: 'COMMODITY_MOBILE_MAP_LAYERS' },
};

describe('variant layer guardrail', () => {
  for (const [variant, { desktop, mobile }] of Object.entries(VARIANT_DEFAULTS)) {
    const allowed = getAllowedForVariant(variant);
    if (allowed.size === 0) continue;

    it(`${variant} desktop: no enabled layer without a toggle`, () => {
      const enabled = extractEnabledLayers(panelsSource, desktop);
      const orphans = enabled.filter(k => !allowed.has(k));
      assert.deepStrictEqual(
        orphans, [],
        `${variant} desktop has layers enabled but NOT in VARIANT_LAYER_ORDER or SVG_ONLY_LAYERS (no toggle): ${orphans.join(', ')}`,
      );
    });

    it(`${variant} mobile: no enabled layer without a toggle`, () => {
      const enabled = extractEnabledLayers(panelsSource, mobile);
      const orphans = enabled.filter(k => !allowed.has(k));
      assert.deepStrictEqual(
        orphans, [],
        `${variant} mobile has layers enabled but NOT in VARIANT_LAYER_ORDER or SVG_ONLY_LAYERS (no toggle): ${orphans.join(', ')}`,
      );
    });
  }

  it('every layer in VARIANT_LAYER_ORDER has at least one DeckGL/Globe renderer', () => {
    const noRenderer = [];
    for (const [variant, keys] of Object.entries(variantOrder)) {
      for (const key of keys) {
        const renderers = layerRenderers[key];
        if (!renderers || renderers.length === 0) {
          noRenderer.push(`${variant}:${key}`);
        }
      }
    }
    assert.deepStrictEqual(
      noRenderer, [],
      `Layers in VARIANT_LAYER_ORDER with empty renderers (getLayersForVariant filters them out → no toggle): ${noRenderer.join(', ')}`,
    );
  });
});
