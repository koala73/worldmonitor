import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const mapSrc = readFileSync(resolve(root, 'src/components/Map.ts'), 'utf-8');

function sliceBetween(start, end) {
  const startIdx = mapSrc.indexOf(start);
  const endIdx = mapSrc.indexOf(end, startIdx + start.length);
  assert.ok(startIdx >= 0, `missing start marker: ${start}`);
  assert.ok(endIdx > startIdx, `missing end marker after ${start}: ${end}`);
  return mapSrc.slice(startIdx, endIdx);
}

describe('mobile SVG map feature caps and label reflow skip (#4463 / U7)', () => {
  it('declares the signed-off mobile caps as named constants', () => {
    assert.match(mapSrc, /private static readonly MOBILE_MIN_EARTHQUAKE_MAGNITUDE = 5/);
    assert.match(mapSrc, /private static readonly MOBILE_MAX_IRAN_EVENTS = 50/);
  });

  it('applies the mobile M5.0 earthquake cutoff after the time-range filter and before marker DOM creation', () => {
    const block = sliceBetween('// Earthquakes (magnitude-based sizing)', '// Economic Centers');

    const timeFilterIdx = block.indexOf('const filteredQuakes =');
    const mobileFilterIdx = block.indexOf('const quakesForRender = this.isMobile');
    const markerLoopIdx = block.indexOf('quakesForRender.forEach((eq) => {');
    const markerDomIdx = block.indexOf("document.createElement('div')");

    assert.ok(timeFilterIdx >= 0, 'earthquake time-range filter should exist');
    assert.ok(mobileFilterIdx > timeFilterIdx, 'mobile cutoff should run after the time-range filter');
    assert.ok(markerLoopIdx > mobileFilterIdx, 'marker loop should use the capped render list');
    assert.ok(markerDomIdx > markerLoopIdx, 'mobile cutoff should run before marker DOM creation');
    assert.match(
      block,
      /filteredQuakes\.filter\(\(eq\) => eq\.magnitude >= MapComponent\.MOBILE_MIN_EARTHQUAKE_MAGNITUDE\)/,
      'mobile path must filter earthquakes at the named M5.0 threshold',
    );
    assert.match(block, /: filteredQuakes;/, 'desktop path must keep the full time-range-filtered list');
  });

  it('applies the mobile Iran event cap before projection and marker DOM creation', () => {
    const block = sliceBetween('// Iran events (severity-colored circles matching DeckGL layer)', '// Hotspots');

    const capIdx = block.indexOf('const iranEventsForRender = this.isMobile');
    const loopIdx = block.indexOf('iranEventsForRender.forEach((ev) => {');
    const projectionIdx = block.indexOf('const pos = projection([ev.longitude, ev.latitude])');
    const markerDomIdx = block.indexOf("document.createElement('div')");

    assert.ok(capIdx >= 0, 'Iran render list should be capped on mobile');
    assert.ok(loopIdx > capIdx, 'Iran marker loop should use the capped render list');
    assert.ok(projectionIdx > loopIdx, 'Iran cap should run before per-event projection');
    assert.ok(markerDomIdx > projectionIdx, 'Iran cap should run before marker DOM creation');
    assert.match(
      block,
      /this\.iranEvents\.slice\(0, MapComponent\.MOBILE_MAX_IRAN_EVENTS\)/,
      'mobile path must cap Iran events at the named 50-event threshold',
    );
    assert.match(block, /: this\.iranEvents;/, 'desktop path must keep the full Iran event list');
  });

  it('keeps label overlap measurement disabled on mobile until the first direct map interaction', () => {
    assert.match(mapSrc, /private mobileLabelVisibilityArmed = false/);
    assert.match(mapSrc, /this\.mobileLabelVisibilityArmed = !this\.isMobile/);
    assert.match(
      mapSrc,
      /private shouldUpdateLabelVisibility\(\): boolean \{\s*return !this\.isMobile \|\| this\.mobileLabelVisibilityArmed;\s*\}/,
      'desktop should keep label measurement enabled while mobile waits for the resume trigger',
    );

    const applyBlock = sliceBetween('private applyTransform(rebuildOnZoomVisibilityChange = true): void {', 'private shouldUpdateLabelVisibility(): boolean');
    const guardIdx = applyBlock.indexOf('if (this.shouldUpdateLabelVisibility()) this.updateLabelVisibility(zoom);');
    const zoomVisibilityIdx = applyBlock.indexOf('this.updateZoomLayerVisibility();');
    const emitIdx = applyBlock.indexOf('this.emitStateChange();');
    assert.ok(guardIdx >= 0, 'applyTransform should guard label visibility measurement');
    assert.ok(zoomVisibilityIdx > guardIdx, 'zoom-layer visibility should still run after the label guard');
    assert.ok(emitIdx > zoomVisibilityIdx, 'state emission should still run after the label guard');
  });

  it('resumes mobile label measurement once from valid pointer or touch starts', () => {
    assert.match(
      mapSrc,
      /addEventListener\('pointerdown', \(e\) => \{\s*if \(shouldIgnoreInteractionStart\(e\.target\)\) return;\s*this\.resumeMobileLabelVisibility\(\);\s*\}, \{ signal \}\)/,
      'pointerdown should resume label visibility only for direct map interactions',
    );
    assert.match(
      mapSrc,
      /addEventListener\('touchstart', \(e\) => \{\s*if \(shouldIgnoreInteractionStart\(e\.target\)\) return;\s*this\.resumeMobileLabelVisibility\(\);/,
      'touchstart should resume label visibility only for direct map interactions',
    );
    assert.match(
      mapSrc,
      /private resumeMobileLabelVisibility\(\): void \{\s*if \(!this\.isMobile \|\| this\.mobileLabelVisibilityArmed\) return;\s*this\.mobileLabelVisibilityArmed = true;\s*this\.updateLabelVisibility\(this\.state\.zoom\);\s*\}/,
      'resume should be mobile-only, idempotent, and run one immediate label pass',
    );
  });
});
