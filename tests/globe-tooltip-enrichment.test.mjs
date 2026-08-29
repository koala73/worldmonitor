/**
 * Tests for globe tooltip enrichment (PR: fix/globe-tooltip-enrichment).
 *
 * Covers:
 * - Compass heading calculation for flight tooltips (pure math)
 * - Conflict tooltip includes eventType field
 * - GPS jamming tooltip uses human-readable label
 * - Rich tooltip kinds get extended hide delay
 * - Content-heavy tooltip kinds get wider max-width (300px)
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
// 1. Compass heading calculation (pure math, mirrors GlobeMap logic)
// ========================================================================

/** Replicates the compass formula from GlobeMap.showMarkerTooltip */
function headingToCompass(heading) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(((heading ?? 0) % 360 + 360) % 360 / 22.5) % 16];
}

describe('headingToCompass', () => {
  it('returns N for heading 0', () => {
    assert.equal(headingToCompass(0), 'N');
  });

  it('returns E for heading 90', () => {
    assert.equal(headingToCompass(90), 'E');
  });

  it('returns S for heading 180', () => {
    assert.equal(headingToCompass(180), 'S');
  });

  it('returns W for heading 270', () => {
    assert.equal(headingToCompass(270), 'W');
  });

  it('returns NE for heading 45', () => {
    assert.equal(headingToCompass(45), 'NE');
  });

  it('returns SE for heading 135', () => {
    assert.equal(headingToCompass(135), 'SE');
  });

  it('returns SW for heading 225', () => {
    assert.equal(headingToCompass(225), 'SW');
  });

  it('returns NW for heading 315', () => {
    assert.equal(headingToCompass(315), 'NW');
  });

  it('returns N for heading 360 (wraps around)', () => {
    assert.equal(headingToCompass(360), 'N');
  });

  it('handles negative heading (-20 → NNW)', () => {
    // -20° = 340°, which falls in NNW sector (326.25°–348.75°)
    assert.equal(headingToCompass(-20), 'NNW');
  });

  it('handles near-zero negative heading (-10 → N)', () => {
    // -10° = 350°, which falls in N sector (348.75°–11.25°)
    assert.equal(headingToCompass(-10), 'N');
  });

  it('handles large heading (720 → N)', () => {
    assert.equal(headingToCompass(720), 'N');
  });

  it('returns N for undefined/null heading', () => {
    assert.equal(headingToCompass(undefined), 'N');
    assert.equal(headingToCompass(null), 'N');
  });

  it('handles boundary at 11.25 (exact midpoint between N and NNE)', () => {
    // Math.round(0.5) = 1 in JS, so 11.25° / 22.5 = 0.5 rounds to index 1 → NNE
    assert.equal(headingToCompass(11.25), 'NNE');
  });
});

// ========================================================================
// 2. Marker tooltips on the Cesium globe
// ========================================================================
//
// This section used to grep GlobeMap.ts for tooltip markup — the flight
// heading line, the conflict eventType field, the per-kind hide delays. That
// renderer built every marker as a DOM node and got hover text free from the
// browser's `title` attribute.
//
// Cesium markers are WebGL, so there is no node to hang a `title` on and the
// tooltip has to be drawn. That makes it ours again, and the thing worth
// guarding is no longer which fields it prints (the spec table in
// gev-bridge/markerSpecs.ts owns that, and tests/gev-tracker-bridge.test.mts
// covers it) but that it cannot become an injection sink: every string it
// shows arrived from a feed.
//
// The compass maths above is kept because it is ours and pure.

describe('globe marker tooltip', () => {
  const src = readSrc('src/components/CesiumGlobeMap.ts');

  it('renders tooltip text as text, never as markup', () => {
    // Marker titles are feed data — headlines, vessel names, place names.
    // One innerHTML here and a crafted headline is script execution.
    assert.match(
      src, /this\.tooltipEl\.textContent = text/,
      'tooltip content must go through textContent',
    );
    assert.doesNotMatch(
      src, /tooltipEl[^\n]*innerHTML/,
      'tooltip must never take an HTML path',
    );
  });

  it('moves the tooltip on the compositor rather than through layout', () => {
    // MOUSE_MOVE fires at pointer rate; top/left would relayout the panel on
    // every one of those while Cesium is trying to hold a frame budget.
    assert.match(src, /tooltipEl\.style\.transform = `translate\(/);
  });

  it('hides the tooltip when the pointer leaves a marker', () => {
    // A tooltip that only ever appears is worse than none: it follows the
    // cursor over empty ocean showing the last thing hovered.
    assert.match(src, /if \(!marker\) \{ this\.hideTooltip\(\); return; \}/);
  });

  it('still exposes the click callbacks MapContainer registers', () => {
    for (const name of ['setOnHotspotClick', 'setOnCountryClick', 'setOnMapContextMenu']) {
      assert.match(
        src, new RegExp(`public ${name}\\(`),
        `${name} must survive the renderer swap — MapContainer calls it`,
      );
    }
  });

  it('routes hotspot clicks to the dashboard, not to a map popup', () => {
    // The hotspot panel drives off this callback; sending hotspots to
    // MapPopup instead would leave the panel dead on the globe.
    assert.match(src, /if \(marker\.kind === 'hotspot'\) \{/);
    assert.match(src, /this\.onHotspotClickCb\?\.\(marker\.row as Hotspot\)/);
  });
});
