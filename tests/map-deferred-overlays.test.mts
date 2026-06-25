import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Structural guard for the mobile SVG-map first-paint deferral (#4429). The full
// MapComponent is not instantiated in unit tests (heavy d3/topojson/canvas/DOM) — the
// repo verifies Map.ts behavior via source-structure assertions (see
// globe-default-map-mode.test.mts). Runtime/perf verification is the prod mobile
// Lighthouse re-read (Map-*.js boot scripting vs the ~1277 ms baseline).
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const mapSrc = readFileSync(resolve(root, 'src/components/Map.ts'), 'utf-8');

describe('mobile SVG map: defer dynamic overlays off first paint (#4429)', () => {
  it('imports the first-paint scheduler and declares the one-time flags', () => {
    assert.match(
      mapSrc,
      /import \{ scheduleAfterFirstPaint \} from '@\/utils\/after-paint'/,
      'Map.ts must import scheduleAfterFirstPaint for the deferral',
    );
    assert.match(mapSrc, /private initialDynamicRendered = false/);
    assert.match(mapSrc, /private initialDynamicScheduled = false/);
  });

  it('gates the dynamic-overlay pass behind the first-paint defer with a single schedule + early return', () => {
    // The gate: on first render, schedule once and return before the dynamic block.
    assert.match(
      mapSrc,
      /if \(!this\.initialDynamicRendered\) \{[\s\S]*?if \(!this\.initialDynamicScheduled\) \{[\s\S]*?this\.initialDynamicScheduled = true;[\s\S]*?scheduleAfterFirstPaint\(\(\) => \{[\s\S]*?this\.initialDynamicRendered = true;[\s\S]*?this\.render\(\);[\s\S]*?\}\);[\s\S]*?\}[\s\S]*?return;[\s\S]*?\}/,
      'render() must schedule the dynamic pass once via scheduleAfterFirstPaint and return on first render',
    );
  });

  it('keeps the base layer (countries) synchronous — rendered BEFORE the defer gate (LCP-critical)', () => {
    const baseIdx = mapSrc.indexOf('this.renderCountries(this.baseLayerGroup');
    const gateIdx = mapSrc.indexOf('if (!this.initialDynamicRendered)');
    assert.ok(baseIdx > 0, 'renderCountries must exist in render()');
    assert.ok(gateIdx > 0, 'the defer gate must exist');
    assert.ok(
      baseIdx < gateIdx,
      'renderCountries (base/LCP) must run before the dynamic-defer gate',
    );
  });

  it('guards render() against running on a destroyed instance (deferred callback safety)', () => {
    assert.match(mapSrc, /private destroyed = false/);
    assert.match(mapSrc, /public destroy\(\): void \{\s*\n\s*this\.destroyed = true;/);
    assert.match(
      mapSrc,
      /public render\(\): void \{\s*\n\s*if \(this\.destroyed\) return;/,
      'render() must early-return when destroyed so the deferred first-paint callback cannot run on a torn-down instance',
    );
    assert.match(
      mapSrc,
      /scheduleAfterFirstPaint\(\(\) => \{\s*\n\s*if \(this\.destroyed\) return;\s*\n\s*this\.initialDynamicRendered = true;/,
      'the deferred callback must not mutate render state after destroy()',
    );
  });

  it('applies the current map transform before returning from the first-paint gate', () => {
    assert.match(
      mapSrc,
      /if \(!this\.initialDynamicRendered\) \{[\s\S]*?scheduleAfterFirstPaint\(\(\) => \{[\s\S]*?if \(this\.destroyed\) return;[\s\S]*?this\.render\(\);[\s\S]*?\}\);\s*\n\s*\}\s*\n\s*this\.applyTransform\(\);\s*\n\s*return;\s*\n\s*\}/,
      'applyTransform must run immediately before the first-paint gate returns',
    );
  });

  it('defers the heavy dynamic layers — they run AFTER the gate', () => {
    const gateIdx = mapSrc.indexOf('if (!this.initialDynamicRendered)');
    for (const marker of [
      'this.renderClusterLayer(projection)',
      'this.renderOverlays(projection)',
      'this.renderCables(projection)',
    ]) {
      const idx = mapSrc.indexOf(marker);
      assert.ok(idx > 0, `${marker} must exist`);
      assert.ok(idx > gateIdx, `${marker} must run after the defer gate (deferred off first paint)`);
    }
  });
});
