/**
 * Guards the CMD+K premium-layer gate (#6045).
 *
 * Before this, search-manager gated layers only on variant + isLayerExecutable
 * (renderer/DeckGL). That let anonymous users enable `resilienceScore` via
 * CMD+K / `view:resilience`, leaving a checked+disabled checkbox and
 * evicting free-tier `ciiChoropleth` via mutual exclusion.
 *
 * Data still never leaked (data-loader + PREMIUM_RPC_PATHS hold), but the
 * control state stuck. These assertions pin the load-bearing wires so a
 * future refactor can't re-open the free-user activation path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const searchManagerSrc = readFileSync(resolve(__dirname, '../src/app/search-manager.ts'), 'utf-8');
const mapLayerDefsSrc = readFileSync(resolve(__dirname, '../src/config/map-layer-definitions.ts'), 'utf-8');
const deckglSrc = readFileSync(resolve(__dirname, '../src/components/DeckGLMap.ts'), 'utf-8');

describe('CMD+K premium layer gate wiring (#6045)', () => {
  it('map-layer-definitions exports isLayerEntitled for locked premium layers', () => {
    assert.match(mapLayerDefsSrc, /export function isLayerEntitled\s*\(/,
      'isLayerEntitled must be the shared locked-premium predicate');
    assert.match(mapLayerDefsSrc, /premium === ['"]locked['"]/,
      'isLayerEntitled must gate on premium === "locked" (not enhanced)');
  });

  it('map-layer-definitions exports sanitizeLockedLayers for stuck-state heal', () => {
    assert.match(mapLayerDefsSrc, /export function sanitizeLockedLayers\s*\(/,
      'sanitizeLockedLayers must clear locked layers for free users');
  });

  it('SearchManager imports isLayerEntitled and hasPremiumAccess', () => {
    assert.match(searchManagerSrc, /isLayerEntitled/,
      'SearchManager must consult isLayerEntitled');
    assert.match(searchManagerSrc, /hasPremiumAccess/,
      'SearchManager must consult hasPremiumAccess for the entitlement signal');
  });

  it('setLayerExecutableFn gates on isLayerEntitled (hides locked layers from free users)', () => {
    // The palette filter callback must mention isLayerEntitled so locked
    // layers are not *surfaced* to free users — not only blocked on dispatch.
    const filterBlock = searchManagerSrc.match(
      /setLayerExecutableFn\(\(layerKey\)\s*=>\s*\{[\s\S]*?\}\);/,
    );
    assert.ok(filterBlock, 'setLayerExecutableFn callback must exist');
    assert.match(filterBlock[0], /isLayerEntitled/,
      'setLayerExecutableFn must gate on isLayerEntitled');
  });

  it('layers:* preset path gates on isLayerEntitled', () => {
    // The layers:all / layers:infra executable predicate must include entitlement.
    assert.match(
      searchManagerSrc,
      /isLayerExecutable\([^)]+\)[\s\S]{0,80}isLayerEntitled|isLayerEntitled[\s\S]{0,80}isLayerExecutable/,
      'layers:* executable path must combine isLayerExecutable with isLayerEntitled',
    );
  });

  it('layer:* toggle and view:resilience require entitlement to enable', () => {
    // Both activation paths that can turn resilienceScore on must call
    // isLayerEntitled (or hasPremiumAccess + locked check).
    assert.match(searchManagerSrc, /case 'layer':[\s\S]*?isLayerEntitled/,
      'layer:* handler must gate enable on isLayerEntitled');
    assert.match(searchManagerSrc, /action === 'resilience'[\s\S]*?isLayerEntitled|isLayerEntitled[\s\S]*?action === 'resilience'/,
      'view:resilience shortcut must gate on isLayerEntitled');
  });

  it('DeckGLMap enableLayer refuses locked layers without premium', () => {
    // Defense in depth: even if a caller reaches enableLayer, locked layers
    // stay off for free users.
    const enableBlock = deckglSrc.match(/public enableLayer\(layer:[^{]+\{[\s\S]{0,400}/);
    assert.ok(enableBlock, 'enableLayer must exist');
    assert.match(enableBlock[0], /hasPremiumAccess|isLayerEntitled|premium === ['"]locked['"]/,
      'enableLayer must refuse locked layers without premium');
  });

  it('DeckGLMap and MapContainer setLayers strip locked layers for free users', () => {
    const mapContainerSrc = readFileSync(resolve(__dirname, '../src/components/MapContainer.ts'), 'utf-8');
    const eventHandlersSrc = readFileSync(resolve(__dirname, '../src/app/event-handlers.ts'), 'utf-8');
    assert.match(deckglSrc, /setLayers\(layers: MapLayers\): void \{[\s\S]{0,500}sanitizeLockedLayers/,
      'DeckGLMap.setLayers must sanitize locked layers');
    assert.match(mapContainerSrc, /setLayers\(layers: MapLayers\): void \{[\s\S]{0,600}sanitizeLockedLayers/,
      'MapContainer.setLayers must sanitize locked layers');
    assert.match(eventHandlersSrc, /filterMissionLayersForCurrentRenderer[\s\S]*?sanitizeLockedLayers/,
      'mission preset path must sanitize locked layers before persist');
  });
});
