import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Structural guard for the mobile SVG-map first-paint deferral (#4429) + chunking (#4442).
// The full MapComponent is not instantiated in unit tests (heavy d3/topojson/canvas/DOM) —
// the repo verifies Map.ts behavior via source-structure assertions (see
// globe-default-map-mode.test.mts). Runtime/perf verification is the prod mobile Lighthouse
// re-read (Map-*.js boot scripting + TBT vs the ~1277 ms / ~1.5 s baselines).
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const mapSrc = readFileSync(resolve(root, 'src/components/Map.ts'), 'utf-8');

describe('mobile SVG map: defer + chunk dynamic overlays off first paint (#4429/#4442)', () => {
  it('declares the one-time + re-entrancy-token flags', () => {
    assert.match(mapSrc, /private initialDynamicRendered = false/);
    assert.match(mapSrc, /private initialDynamicScheduled = false/);
    assert.match(mapSrc, /private dynamicRenderToken = 0/, 'needs the re-entrancy token for the chunked pass');
  });

  it('gates the first dynamic pass behind scheduleAfterFirstPaint → renderInitialDynamicPass with an early return', () => {
    assert.match(
      mapSrc,
      /if \(!this\.initialDynamicRendered\) \{[\s\S]*?if \(!this\.initialDynamicScheduled\) \{[\s\S]*?this\.initialDynamicScheduled = true;[\s\S]*?scheduleAfterFirstPaint\(\(\) => \{ void this\.renderInitialDynamicPass\(\); \}\);[\s\S]*?\}[\s\S]*?return;[\s\S]*?\}/,
      'render() must schedule renderInitialDynamicPass once and return on first render',
    );
  });

  it('first-paint pass builds the dynamic layers CHUNKED (off critical path, sub-50ms tasks)', () => {
    assert.match(
      mapSrc,
      /private async renderInitialDynamicPass\(\): Promise<void> \{[\s\S]*?this\.initialDynamicRendered = true;[\s\S]*?await this\.renderDynamicLayers\(width, height, true\);/,
      'renderInitialDynamicPass must set the flag and await the chunked renderDynamicLayers',
    );
  });

  it('renderDynamicLayers yields between layers when chunking and bails when superseded', () => {
    assert.match(mapSrc, /private async renderDynamicLayers\(width: number, height: number, chunk = false\): Promise<void>/);
    assert.match(
      mapSrc,
      /for \(let i = 0; i < steps\.length; i\+\+\) \{[\s\S]*?if \(chunk && \(this\.destroyed \|\| token !== this\.dynamicRenderToken\)\) return;[\s\S]*?steps\[i\]\?\.\(\);[\s\S]*?if \(chunk && i < steps\.length - 1\) await yieldToMain\(\);/,
      'the layer loop must yield between steps when chunking, skip the final yield, and bail on token mismatch / destroy',
    );
  });

  it('steady-state render() builds the dynamic layers synchronously (no chunking on interactions)', () => {
    assert.match(
      mapSrc,
      /Steady state[\s\S]*?void this\.renderDynamicLayers\(width, height\);/,
      'post-first-paint render() must call renderDynamicLayers without the chunk flag (synchronous)',
    );
  });

  it('keeps the base layer (countries) synchronous — rendered BEFORE the defer gate (LCP-critical)', () => {
    const baseIdx = mapSrc.indexOf('this.renderCountries(this.baseLayerGroup');
    const gateIdx = mapSrc.indexOf('if (!this.initialDynamicRendered)');
    assert.ok(baseIdx > 0 && gateIdx > 0);
    assert.ok(baseIdx < gateIdx, 'renderCountries (base/LCP) must run before the dynamic-defer gate');
  });

  it('guards render() and the deferred pass against running on a destroyed instance', () => {
    assert.match(mapSrc, /private destroyed = false/);
    assert.match(mapSrc, /public render\(\): void \{\s*\n\s*if \(this\.destroyed\) return;/);
    assert.match(mapSrc, /private async renderInitialDynamicPass\(\): Promise<void> \{\s*\n\s*if \(this\.destroyed \|\| !this\.svg\) return;/);
  });
});
