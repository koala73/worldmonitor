import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = join(import.meta.dirname, '..');
const deckGLMapSrc = readFileSync(join(root, 'src', 'components', 'DeckGLMap.ts'), 'utf-8');
const mapContainerSrc = readFileSync(join(root, 'src', 'components', 'MapContainer.ts'), 'utf-8');

describe('Pulsing chokepoint markers', () => {
  it('createHighlightedChokepointMarkers method exists', () => {
    assert.ok(
      deckGLMapSrc.includes('createHighlightedChokepointMarkers'),
      'DeckGLMap must have createHighlightedChokepointMarkers method',
    );
  });

  it('returns null when highlightedRouteIds is empty', () => {
    const defIdx = deckGLMapSrc.indexOf('private createHighlightedChokepointMarkers');
    assert.ok(defIdx !== -1);
    const method = deckGLMapSrc.slice(defIdx, defIdx + 2500);
    assert.ok(
      method.includes('highlightedRouteIds.size === 0') && method.includes('return null'),
      'Must return null when no routes highlighted',
    );
  });

  it('collects chokepoint IDs from ROUTE_WAYPOINTS_MAP', () => {
    const defIdx = deckGLMapSrc.indexOf('private createHighlightedChokepointMarkers');
    const method = deckGLMapSrc.slice(defIdx, defIdx + 2500);
    assert.ok(
      method.includes('ROUTE_WAYPOINTS_MAP'),
      'Must use ROUTE_WAYPOINTS_MAP to collect chokepoint IDs',
    );
  });

  it('uses disruption score for color coding', () => {
    const defIdx = deckGLMapSrc.indexOf('private createHighlightedChokepointMarkers');
    const method = deckGLMapSrc.slice(defIdx, defIdx + 2500);
    assert.ok(method.includes('score >= 70'), 'Must check score >= 70 for critical');
    assert.ok(method.includes('score > 30'), 'Must check score > 30 for elevated');
  });

  it('uses tradeAnimationTime for pulse effect', () => {
    const defIdx = deckGLMapSrc.indexOf('private createHighlightedChokepointMarkers');
    const method = deckGLMapSrc.slice(defIdx, defIdx + 2500);
    assert.ok(
      method.includes('tradeAnimationTime'),
      'Must use tradeAnimationTime for pulsing',
    );
  });

  it('layer is inserted in buildAllLayers when routes are highlighted', () => {
    const buildIdx = deckGLMapSrc.indexOf('createTradeChokepointsLayer()');
    assert.ok(buildIdx !== -1);
    const after = deckGLMapSrc.slice(buildIdx, buildIdx + 500);
    assert.ok(
      after.includes('createHighlightedChokepointMarkers'),
      'Must insert highlighted markers layer after trade chokepoints in buildAllLayers',
    );
  });
});

describe('Bypass arcs layer', () => {
  it('bypassArcData field exists on DeckGLMap', () => {
    assert.ok(
      deckGLMapSrc.includes('bypassArcData'),
      'DeckGLMap must have bypassArcData field',
    );
  });

  it('setBypassRoutes method exists', () => {
    assert.ok(
      deckGLMapSrc.includes('setBypassRoutes('),
      'DeckGLMap must have setBypassRoutes method',
    );
  });

  it('clearBypassRoutes method exists', () => {
    assert.ok(
      deckGLMapSrc.includes('clearBypassRoutes'),
      'DeckGLMap must have clearBypassRoutes method',
    );
  });

  it('createBypassArcsLayer returns null when no data', () => {
    const defIdx = deckGLMapSrc.indexOf('private createBypassArcsLayer');
    assert.ok(defIdx !== -1);
    const method = deckGLMapSrc.slice(defIdx, defIdx + 1000);
    assert.ok(
      method.includes('bypassArcData.length === 0') && method.includes('return null'),
      'Must return null when bypassArcData is empty',
    );
  });

  it('bypass arcs use green color', () => {
    const defIdx = deckGLMapSrc.indexOf('private createBypassArcsLayer');
    const method = deckGLMapSrc.slice(defIdx, defIdx + 1000);
    assert.ok(
      method.includes('[60, 200, 120'),
      'Bypass arcs must use green color',
    );
  });

  it('bypass arcs use greatCircle rendering', () => {
    const defIdx = deckGLMapSrc.indexOf('private createBypassArcsLayer');
    const method = deckGLMapSrc.slice(defIdx, defIdx + 1000);
    assert.ok(
      method.includes('greatCircle: true'),
      'Bypass arcs must use greatCircle rendering',
    );
  });

  it('bypass arcs layer is inserted in buildAllLayers', () => {
    const buildIdx = deckGLMapSrc.indexOf('createHighlightedChokepointMarkers');
    assert.ok(buildIdx !== -1);
    const after = deckGLMapSrc.slice(buildIdx, buildIdx + 500);
    assert.ok(
      after.includes('createBypassArcsLayer'),
      'Must insert bypass arcs layer after highlighted chokepoint markers',
    );
  });
});

describe('MapContainer dispatch methods', () => {
  it('setBypassRoutes dispatches to deckGLMap', () => {
    assert.ok(
      mapContainerSrc.includes('setBypassRoutes('),
      'MapContainer must have setBypassRoutes method',
    );
    const defIdx = mapContainerSrc.indexOf('setBypassRoutes(');
    const method = mapContainerSrc.slice(defIdx, defIdx + 200);
    assert.ok(
      method.includes('deckGLMap?.setBypassRoutes'),
      'MapContainer.setBypassRoutes must dispatch to deckGLMap',
    );
  });

  it('clearBypassRoutes dispatches to deckGLMap', () => {
    assert.ok(
      mapContainerSrc.includes('clearBypassRoutes'),
      'MapContainer must have clearBypassRoutes method',
    );
    const defIdx = mapContainerSrc.indexOf('clearBypassRoutes()');
    const method = mapContainerSrc.slice(defIdx, defIdx + 200);
    assert.ok(
      method.includes('deckGLMap?.clearBypassRoutes'),
      'MapContainer.clearBypassRoutes must dispatch to deckGLMap',
    );
  });
});
