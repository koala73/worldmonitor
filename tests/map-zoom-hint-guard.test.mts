/**
 * Zoom-hint scan suppression (#7776).
 *
 * `updateZoomHints()` runs on every `updateLayers()` pass — including the
 * trade-animation's every-other-frame `render()`. These tests drive the real
 * `ZoomHintGuard` against a real DOM toggle list and count hint scans (full
 * passes over the toggle rows), proving suppression is keyed on the actual
 * visibility inputs rather than only inspecting output classes.
 *
 * The guard lives in src/components/map/zoom-hint-guard.ts so it is
 * unit-testable without DOM/WebGL; DeckGLMap.updateZoomHints() wires it in.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

import { ZoomHintGuard } from '../src/components/map/zoom-hint-guard.ts';
import type { MapLayers } from '../src/types/index.ts';

// Visibility thresholds mirrored from DeckGLMap.LAYER_ZOOM_THRESHOLDS for the
// acceptance cases: nuclear/base/economic at zoom 3, irradiators at 4,
// datacenters at 5.
const MIN_ZOOM: Partial<Record<string, number>> = {
  bases: 3,
  nuclear: 3,
  economic: 3,
  irradiators: 4,
  datacenters: 5,
  conflicts: 1,
};

const HINT_KEYS = ['bases', 'nuclear', 'economic', 'irradiators', 'datacenters', 'conflicts'];

function makeLayers(overrides: Partial<Record<string, boolean>> = {}): MapLayers {
  const layers = {} as Record<string, boolean>;
  for (const key of HINT_KEYS) layers[key] = true;
  Object.assign(layers, overrides);
  return layers as MapLayers;
}

function buildToggleList(document: Document, keys: string[]): Element {
  const list = document.createElement('div');
  list.className = 'toggle-list';
  for (const key of keys) {
    const toggle = document.createElement('label');
    toggle.className = 'layer-toggle';
    toggle.setAttribute('data-layer', key);
    list.appendChild(toggle);
  }
  return list;
}

/** Faithful copy of the DeckGLMap.updateZoomHints() scan body. */
function scanHints(toggleList: Element, layers: MapLayers, zoom: number): void {
  scanCount += 1;
  for (const key of HINT_KEYS) {
    const toggle = toggleList.querySelector(`.layer-toggle[data-layer="${key}"]`);
    if (!toggle) continue;
    const enabled = layers[key as keyof MapLayers] ?? false;
    const threshold = MIN_ZOOM[key] ?? 0;
    const zoomHidden = enabled && zoom < threshold;
    toggle.classList.toggle('zoom-hidden', zoomHidden);
  }
}

let scanCount = 0;

function guardedPass(guard: ZoomHintGuard, toggleList: Element, layers: MapLayers, zoom: number): void {
  if (!guard.shouldScan({ zoom, layers }, toggleList)) return;
  scanHints(toggleList, layers, zoom);
  guard.markScanned({ zoom, layers }, toggleList);
}

function hintState(toggleList: Element, key: string): boolean {
  return toggleList.querySelector(`.layer-toggle[data-layer="${key}"]`)?.classList.contains('zoom-hidden') ?? false;
}

function freshDom(): Document {
  const window = new Window({ url: 'https://worldmonitor.app/' });
  return window.document as unknown as Document;
}

describe('zoom-hint guard (#7776)', () => {
  it('scans once, then suppresses an unchanged 61-frame animation sequence', () => {
    const document = freshDom();
    const toggleList = buildToggleList(document, HINT_KEYS);
    const guard = new ZoomHintGuard();
    const layers = makeLayers();
    scanCount = 0;

    guardedPass(guard, toggleList, layers, 2);
    for (let frame = 0; frame < 61; frame++) {
      guardedPass(guard, toggleList, layers, 2);
    }
    assert.equal(scanCount, 1, '61 unchanged frames must cause zero additional hint scans');
  });

  it('updates hints in both directions across all configured visibility thresholds', () => {
    const document = freshDom();
    const toggleList = buildToggleList(document, HINT_KEYS);
    const guard = new ZoomHintGuard();
    const layers = makeLayers();
    scanCount = 0;

    const cases: Array<{ key: string; hiddenZoom: number; visibleZoom: number }> = [
      { key: 'nuclear', hiddenZoom: 2, visibleZoom: 3 },
      { key: 'bases', hiddenZoom: 2, visibleZoom: 3 },
      { key: 'economic', hiddenZoom: 2, visibleZoom: 3 },
      { key: 'irradiators', hiddenZoom: 3, visibleZoom: 4 },
      { key: 'datacenters', hiddenZoom: 4, visibleZoom: 5 },
    ];
    for (const { key, hiddenZoom, visibleZoom } of cases) {
      guardedPass(guard, toggleList, layers, hiddenZoom);
      assert.equal(hintState(toggleList, key), true, `${key} must warn below its threshold`);
      guardedPass(guard, toggleList, layers, visibleZoom);
      assert.equal(hintState(toggleList, key), false, `${key} must clear at its threshold`);
    }
    assert.ok(scanCount > 0, 'threshold crossings must scan');
    const before = scanCount;
    guardedPass(guard, toggleList, layers, 5);
    assert.equal(scanCount, before, 'repeating the same zoom must not scan again');
  });

  it("rescans on layer enable/disable and clears disabled layers' stale warnings", () => {
    const document = freshDom();
    const toggleList = buildToggleList(document, HINT_KEYS);
    const guard = new ZoomHintGuard();
    scanCount = 0;

    // Nuclear enabled below its threshold: warning set.
    guardedPass(guard, toggleList, makeLayers({ nuclear: true }), 2);
    assert.equal(hintState(toggleList, 'nuclear'), true);
    // Disable nuclear at the same zoom: must rescan and drop the stale warning.
    guardedPass(guard, toggleList, makeLayers({ nuclear: false }), 2);
    assert.equal(hintState(toggleList, 'nuclear'), false, 'disabled layers must not retain an enabled-layer zoom warning');
    // Re-enable at the same zoom: warning returns.
    guardedPass(guard, toggleList, makeLayers({ nuclear: true }), 2);
    assert.equal(hintState(toggleList, 'nuclear'), true);
  });

  it('invalidates on toggle-list rebuild and missing rows even when inputs match', () => {
    const document = freshDom();
    const layers = makeLayers();
    const guard = new ZoomHintGuard();
    scanCount = 0;

    const first = buildToggleList(document, HINT_KEYS);
    guardedPass(guard, first, layers, 2);
    assert.equal(scanCount, 1);

    // Locale/layout reconstruction replaces the row nodes with identical keys.
    const rebuilt = buildToggleList(document, HINT_KEYS);
    assert.equal(guard.shouldScan({ zoom: 2, layers }, rebuilt), true, 'rebuilt rows must invalidate the guard');
    guardedPass(guard, rebuilt, layers, 2);
    assert.equal(scanCount, 2);
    // Same rebuilt list, same inputs: suppressed again.
    guardedPass(guard, rebuilt, layers, 2);
    assert.equal(scanCount, 2);

    // A row is missing entirely: the row set changed, so rescan.
    const missing = buildToggleList(document, HINT_KEYS.filter((key) => key !== 'datacenters'));
    assert.equal(guard.shouldScan({ zoom: 2, layers }, missing), true, 'missing rows must invalidate the guard');
  });

  it('zoom alone is not a complete key: layer flips at constant zoom rescan', () => {
    const document = freshDom();
    const toggleList = buildToggleList(document, HINT_KEYS);
    const guard = new ZoomHintGuard();
    scanCount = 0;

    const enabled = makeLayers({ datacenters: true });
    guardedPass(guard, toggleList, enabled, 4);
    assert.equal(hintState(toggleList, 'datacenters'), true);
    const disabled = makeLayers({ datacenters: false });
    assert.equal(
      guard.shouldScan({ zoom: 4, layers: disabled }, toggleList),
      true,
      'zoom-only keys would miss a layer flip at constant zoom',
    );
    guardedPass(guard, toggleList, disabled, 4);
    assert.equal(hintState(toggleList, 'datacenters'), false);
  });

  it('invalidate() forces the next pass to rescan', () => {
    const document = freshDom();
    const toggleList = buildToggleList(document, HINT_KEYS);
    const guard = new ZoomHintGuard();
    const layers = makeLayers();
    scanCount = 0;

    guardedPass(guard, toggleList, layers, 2);
    guardedPass(guard, toggleList, layers, 2);
    assert.equal(scanCount, 1);
    guard.invalidate();
    assert.equal(guard.shouldScan({ zoom: 2, layers }, toggleList), true);
    guardedPass(guard, toggleList, layers, 2);
    assert.equal(scanCount, 2);
  });

  it('wires the guard into DeckGLMap.updateZoomHints with the isLayerVisible zoom source', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const deckGlMapSrc = readFileSync(resolve(here, '../src/components/DeckGLMap.ts'), 'utf-8');
    const start = deckGlMapSrc.indexOf('private updateZoomHints');
    assert.ok(start >= 0, 'DeckGLMap.updateZoomHints must exist');
    const body = deckGlMapSrc.slice(start, deckGlMapSrc.indexOf('\n  }\n', start));
    assert.match(body, /this\.zoomHintGuard\.shouldScan\(/, 'updateZoomHints must consult the guard before scanning');
    assert.match(body, /this\.zoomHintGuard\.markScanned\(/, 'updateZoomHints must record the scanned inputs');
    // The guard key must mirror isLayerVisible()'s `getZoom() || 2` source;
    // `?? state.zoom` would disagree at zoom 0 and stale-gate the hints.
    assert.match(body, /getZoom\(\) \|\| 2/, 'guard zoom must mirror isLayerVisible getZoom() || 2 source');
  });
});
