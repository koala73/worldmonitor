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

  it('returns null when highlightedMarkers cache is empty', () => {
    const defIdx = deckGLMapSrc.indexOf('private createHighlightedChokepointMarkers');
    assert.ok(defIdx !== -1);
    const method = deckGLMapSrc.slice(defIdx, defIdx + 2500);
    assert.ok(
      method.includes('highlightedMarkers.length === 0') && method.includes('return null'),
      'Must return null when cached markers array is empty',
    );
  });

  it('rebuildHighlightedMarkers collects IDs from ROUTE_WAYPOINTS_MAP', () => {
    const defIdx = deckGLMapSrc.indexOf('private rebuildHighlightedMarkers');
    assert.ok(defIdx !== -1, 'rebuildHighlightedMarkers must exist');
    const method = deckGLMapSrc.slice(defIdx, defIdx + 1500);
    assert.ok(
      method.includes('ROUTE_WAYPOINTS_MAP'),
      'rebuildHighlightedMarkers must use ROUTE_WAYPOINTS_MAP',
    );
  });

  it('highlightRoute calls rebuildHighlightedMarkers', () => {
    const defIdx = deckGLMapSrc.indexOf('public highlightRoute(');
    assert.ok(defIdx !== -1);
    const method = deckGLMapSrc.slice(defIdx, defIdx + 300);
    assert.ok(
      method.includes('rebuildHighlightedMarkers'),
      'highlightRoute must call rebuildHighlightedMarkers',
    );
  });

  it('setChokepointData calls rebuildHighlightedMarkers', () => {
    const defIdx = deckGLMapSrc.indexOf('public setChokepointData(');
    assert.ok(defIdx !== -1);
    const method = deckGLMapSrc.slice(defIdx, defIdx + 300);
    assert.ok(
      method.includes('rebuildHighlightedMarkers'),
      'setChokepointData must call rebuildHighlightedMarkers',
    );
  });

  it('uses disruption score for color coding', () => {
    const defIdx = deckGLMapSrc.indexOf('private createHighlightedChokepointMarkers');
    const method = deckGLMapSrc.slice(defIdx, defIdx + 2500);
    assert.ok(method.includes('score >= 70'), 'Must check score >= 70 for critical');
    assert.ok(method.includes('score > 30'), 'Must check score > 30 for elevated');
  });

  it('uses CHOKEPOINT_PULSE_FREQ and CHOKEPOINT_PULSE_AMP constants', () => {
    assert.ok(
      deckGLMapSrc.includes('const CHOKEPOINT_PULSE_FREQ'),
      'Must define CHOKEPOINT_PULSE_FREQ constant',
    );
    assert.ok(
      deckGLMapSrc.includes('const CHOKEPOINT_PULSE_AMP'),
      'Must define CHOKEPOINT_PULSE_AMP constant',
    );
    const defIdx = deckGLMapSrc.indexOf('private createHighlightedChokepointMarkers');
    const method = deckGLMapSrc.slice(defIdx, defIdx + 2500);
    assert.ok(
      method.includes('CHOKEPOINT_PULSE_FREQ') && method.includes('CHOKEPOINT_PULSE_AMP'),
      'createHighlightedChokepointMarkers must use extracted constants',
    );
  });

  it('uses HighlightedMarker type in accessor callbacks', () => {
    assert.ok(
      deckGLMapSrc.includes('type HighlightedMarker'),
      'Must define HighlightedMarker type',
    );
    const defIdx = deckGLMapSrc.indexOf('private createHighlightedChokepointMarkers');
    const method = deckGLMapSrc.slice(defIdx, defIdx + 2500);
    assert.ok(
      method.includes('(d: HighlightedMarker)'),
      'Accessor callbacks must use HighlightedMarker type',
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

describe('Layer cache cleanup', () => {
  it('cleans highlighted-chokepoint-markers when trade routes disabled', () => {
    const elseIdx = deckGLMapSrc.indexOf("this.layerCache.delete('trade-chokepoints-layer')");
    assert.ok(elseIdx !== -1);
    const after = deckGLMapSrc.slice(elseIdx, elseIdx + 300);
    assert.ok(
      after.includes("this.layerCache.delete('highlighted-chokepoint-markers')"),
      'Must delete highlighted-chokepoint-markers from layerCache',
    );
  });

  it('cleans bypass-arcs-layer when trade routes disabled', () => {
    const elseIdx = deckGLMapSrc.indexOf("this.layerCache.delete('trade-chokepoints-layer')");
    assert.ok(elseIdx !== -1);
    const after = deckGLMapSrc.slice(elseIdx, elseIdx + 300);
    assert.ok(
      after.includes("this.layerCache.delete('bypass-arcs-layer')"),
      'Must delete bypass-arcs-layer from layerCache',
    );
  });
});

describe('Bypass arcs layer', () => {
  it('BypassArcDatum interface is defined', () => {
    assert.ok(
      deckGLMapSrc.includes('interface BypassArcDatum'),
      'Must define BypassArcDatum interface',
    );
  });

  it('bypassArcData uses BypassArcDatum type', () => {
    assert.ok(
      deckGLMapSrc.includes('bypassArcData: BypassArcDatum[]'),
      'bypassArcData field must use BypassArcDatum type',
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

  it('bypass arcs use BypassArcDatum in accessors', () => {
    const defIdx = deckGLMapSrc.indexOf('private createBypassArcsLayer');
    const method = deckGLMapSrc.slice(defIdx, defIdx + 1000);
    assert.ok(
      method.includes('(d: BypassArcDatum)'),
      'Accessor callbacks must use BypassArcDatum type',
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
