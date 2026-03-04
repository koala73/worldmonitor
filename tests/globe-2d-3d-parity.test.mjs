/**
 * Tests for 2D ↔ 3D globe completeness parity (PR: feat/3d-globe-view).
 *
 * Covers:
 * - MapContainer globe routing: setAisData and setFlightDelays delegate to globeMap
 * - GlobeMap AIS implementation: setAisData produces correct marker fields
 * - dayNight toggle suppressed in globe mode (three-point enforcement)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

// ========================================================================
// 1. MapContainer globe routing
// ========================================================================

describe('MapContainer globe routing', () => {
  const src = readSrc('src/components/MapContainer.ts');

  it('delegates setAisData to globeMap when useGlobe is true', () => {
    // Expect the globe guard immediately inside setAisData
    assert.match(
      src,
      /setAisData\(disruptions[^)]*\)[^{]*\{[^}]*if \(this\.useGlobe\)[^}]*this\.globeMap\?\.setAisData\(disruptions, density\)/s,
      'setAisData should delegate to globeMap when useGlobe=true'
    );
  });

  it('delegates setFlightDelays to globeMap when useGlobe is true', () => {
    assert.match(
      src,
      /setFlightDelays\(delays[^)]*\)[^{]*\{[^}]*if \(this\.useGlobe\)[^}]*this\.globeMap\?\.setFlightDelays\(delays\)/s,
      'setFlightDelays should delegate to globeMap when useGlobe=true'
    );
  });
});

// ========================================================================
// 2. GlobeMap AIS implementation
// ========================================================================

describe('GlobeMap AIS ship traffic markers', () => {
  const src = readSrc('src/components/GlobeMap.ts');

  it('imports AisDisruptionEvent and AisDisruptionType from @/types', () => {
    assert.match(src, /AisDisruptionEvent.*AisDisruptionType/,
      'GlobeMap should import AIS types');
  });

  it('defines AisDisruptionMarker interface with required fields', () => {
    assert.match(src, /interface AisDisruptionMarker extends BaseMarker/,
      'AisDisruptionMarker interface must exist');
    assert.match(src, /_kind: 'aisDisruption'/,
      'AisDisruptionMarker must have _kind discriminator');
    assert.match(src, /type: AisDisruptionType/,
      'AisDisruptionMarker must carry type field');
    assert.match(src, /severity: AisDisruptionEvent\['severity'\]/,
      'AisDisruptionMarker must carry severity field');
  });

  it('includes AisDisruptionMarker in GlobeMarker union', () => {
    // Union spans multiple lines — check that AisDisruptionMarker appears in the union block
    const unionMatch = src.match(/type GlobeMarker =[\s\S]*?;/);
    assert.ok(unionMatch, 'GlobeMarker union must exist');
    assert.ok(unionMatch[0].includes('AisDisruptionMarker'),
      'GlobeMarker union must include AisDisruptionMarker');
  });

  it('flushMarkers gates aisMarkers behind layers.ais', () => {
    assert.match(src, /if \(this\.layers\.ais\)[^\n]*this\.aisMarkers/,
      'aisMarkers must be gated behind layers.ais in flushMarkers');
  });

  it('setAisData maps disruptions to aisMarkers with correct fields', () => {
    assert.match(src, /this\.aisMarkers = \(disruptions/,
      'setAisData must populate this.aisMarkers');
    assert.match(src, /_kind: 'aisDisruption' as const/,
      'setAisData must set _kind to aisDisruption');
    assert.match(src, /type: d\.type/,
      'setAisData must copy type field');
    assert.match(src, /severity: d\.severity/,
      'setAisData must copy severity field');
    assert.match(src, /description: d\.description/,
      'setAisData must copy description field');
  });

  it('buildMarkerElement renders aisDisruption with severity-appropriate color', () => {
    assert.match(src, /d\._kind === 'aisDisruption'/,
      'buildMarkerElement must handle aisDisruption case');
    // Color is severity-based
    assert.match(src, /d\.severity === 'high'.*#ff2020.*d\.severity === 'elevated'.*#ff8800/s,
      'aisDisruption marker should use red for high, orange for elevated');
  });

  it('showMarkerTooltip renders aisDisruption with name/type/severity fields', () => {
    // Find the aisDisruption tooltip block
    const tooltipIdx = src.indexOf("d._kind === 'aisDisruption'", src.indexOf('showMarkerTooltip'));
    assert.ok(tooltipIdx !== -1, 'showMarkerTooltip must handle aisDisruption');
    const tooltipBlock = src.slice(tooltipIdx, tooltipIdx + 400);
    assert.ok(tooltipBlock.includes('typeLabel'), 'tooltip must show type label');
    assert.ok(tooltipBlock.includes('d.name'), 'tooltip must show vessel name');
    assert.ok(tooltipBlock.includes('d.severity'), 'tooltip must show severity');
  });
});

// ========================================================================
// 3. dayNight toggle suppressed in globe mode
// ========================================================================

describe('dayNight toggle suppressed on globe', () => {
  const src = readSrc('src/components/GlobeMap.ts');

  it('initGlobe sets layers.dayNight to false after init', () => {
    assert.match(src, /this\.layers\.dayNight = false/,
      'initGlobe must hard-disable dayNight layer');
  });

  it('initGlobe removes dayNight toggle from UI', () => {
    assert.match(src, /this\.hideLayerToggle\('dayNight'\)/,
      'initGlobe must call hideLayerToggle for dayNight');
  });

  it('setLayers overrides incoming dayNight to false', () => {
    assert.match(src, /\{ \.\.\.layers, dayNight: false \}/,
      'setLayers must force dayNight:false regardless of incoming state');
  });

  it('enableLayer ignores dayNight calls', () => {
    assert.match(src, /if \(layer === 'dayNight'\) return/,
      'enableLayer must short-circuit dayNight calls');
  });
});
