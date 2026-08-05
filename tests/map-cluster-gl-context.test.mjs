import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClusterGlContext } from '../src/components/map-cluster-gl.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mapSrc = readFileSync(join(root, 'src', 'components', 'Map.ts'), 'utf-8');

// WORLDMONITOR-YG / WORLDMONITOR-YH (11 events, production, Chrome 149/Linux):
//
//   TypeError: this.clusterGl.clearColor is not a function
//     at x.clearClusterCanvas   (Map.ts clearClusterCanvas)
//     at x.renderClusterLayer
//     at Array.<anonymous>      (renderDynamicLayers)
//     at x.renderDynamicLayers
//     at x.renderWithSize / x.render
//     at async x.renderInitialDynamicPass
//
// `canvas.getContext('webgl')` is specified to return `null` when WebGL is
// unavailable, and `if (!gl) return` was the whole guard. But canvas
// fingerprint-blocking extensions and hardened browsers hand back a TRUTHY
// stub object that passes the null check while exposing none of the GL
// methods. The affected session also logged "[MapContainer] Initializing SVG
// map (globe fallback mode)" — i.e. WebGL was already degraded on that device.
//
// The throw is not cosmetic: `clearClusterCanvas()` sits on the synchronous
// render path, so it aborted the entire dynamic-layer pass. That user lost
// every overlay on the map (earthquakes, alerts, markers), not just a canvas
// clear that had nothing to draw anyway.

/** The exact shape observed in production: truthy, but not a GL context. */
function fingerprintBlockerStub() {
  return { canvas: null, drawingBufferWidth: 0, drawingBufferHeight: 0 };
}

/** Minimal real-shaped context exposing only what clearClusterCanvas() calls. */
function workingGlStub() {
  const calls = [];
  return {
    COLOR_BUFFER_BIT: 0x00004000,
    clearColor(...args) { calls.push(['clearColor', ...args]); },
    clear(...args) { calls.push(['clear', ...args]); },
    calls,
  };
}

function canvasReturning(context) {
  return { getContext: (id) => (id === 'webgl' ? context : null) };
}

/** Mirror of Map.ts clearClusterCanvas(), driven by whatever the guard stored. */
function clearClusterCanvas(clusterGl) {
  if (!clusterGl) return;
  clusterGl.clearColor(0, 0, 0, 0);
  clusterGl.clear(clusterGl.COLOR_BUFFER_BIT);
}

describe('cluster canvas WebGL context guard (WORLDMONITOR-YG/YH)', () => {
  it('rejects a truthy non-GL stub from getContext("webgl")', () => {
    assert.equal(
      resolveClusterGlContext(canvasReturning(fingerprintBlockerStub())),
      null,
      'a truthy object without GL methods must not be stored as the cluster context',
    );
  });

  it('does not throw out of the render path when getContext returns a stub', () => {
    const clusterGl = resolveClusterGlContext(canvasReturning(fingerprintBlockerStub()));
    // This is the production crash: clearClusterCanvas() threw here and took
    // the whole dynamic-layer render pass down with it.
    assert.doesNotThrow(() => clearClusterCanvas(clusterGl));
  });

  it('still returns and drives a genuine WebGL context', () => {
    const gl = workingGlStub();
    const resolved = resolveClusterGlContext(canvasReturning(gl));
    assert.equal(resolved, gl, 'a usable context must still be stored');
    clearClusterCanvas(resolved);
    assert.deepEqual(gl.calls, [
      ['clearColor', 0, 0, 0, 0],
      ['clear', 0x00004000],
    ], 'the canvas clear must still run on a real context');
  });

  it('returns null when WebGL is genuinely unavailable', () => {
    assert.equal(resolveClusterGlContext(canvasReturning(null)), null);
  });

  it('rejects a context missing any single member clearClusterCanvas() uses', () => {
    const missing = [
      ['clearColor', { clear() {}, COLOR_BUFFER_BIT: 0x4000 }],
      ['clear', { clearColor() {}, COLOR_BUFFER_BIT: 0x4000 }],
      ['COLOR_BUFFER_BIT', { clearColor() {}, clear() {} }],
    ];
    for (const [name, stub] of missing) {
      assert.equal(
        resolveClusterGlContext(canvasReturning(stub)),
        null,
        `a context without ${name} must be rejected`,
      );
    }
  });

  it('keeps Map.ts on the shared guard instead of a bare null check', () => {
    // The predicate is only load-bearing if Map.ts actually routes through it.
    const init = mapSrc.match(/private initClusterRenderer\(\): void \{[\s\S]*?\n {2}\}/);
    assert.ok(init, 'could not locate initClusterRenderer() body');
    assert.match(
      init[0],
      /resolveClusterGlContext\(/,
      'initClusterRenderer() must acquire the context via resolveClusterGlContext()',
    );
    assert.doesNotMatch(
      init[0],
      /getContext\(/,
      'initClusterRenderer() must not call getContext() directly — the shape check lives in resolveClusterGlContext()',
    );
  });
});
