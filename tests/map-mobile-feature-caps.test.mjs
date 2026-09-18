import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const mapSrc = readFileSync(resolve(root, 'src/components/Map.ts'), 'utf-8');
const cssSrc = readFileSync(resolve(root, 'src/styles/main.css'), 'utf-8');
const containerSrc = readFileSync(resolve(root, 'src/components/MapContainer.ts'), 'utf-8');
const capsSrc = readFileSync(resolve(root, 'src/utils/mobile-feature-caps.ts'), 'utf-8');

function sliceBetweenIn(src, start, end) {
  const startIdx = src.indexOf(start);
  assert.ok(startIdx >= 0, `missing start marker: ${start}`);
  const endIdx = src.indexOf(end, startIdx + start.length);
  assert.ok(endIdx > startIdx, `missing end marker after ${start}: ${end}`);
  return src.slice(startIdx, endIdx);
}

function sliceBetween(start, end) {
  return sliceBetweenIn(mapSrc, start, end);
}

describe('mobile SVG map feature caps and label reflow skip (#4463 / U7)', () => {
  it('declares the signed-off mobile caps as named constants, in one shared home', () => {
    // #4545: these were `private static readonly` on MapComponent, which is why
    // only the SVG renderer enforced them. The behaviour of the predicates is
    // covered executably in tests/mobile-feature-caps.test.mts.
    assert.match(capsSrc, /export const MOBILE_MIN_EARTHQUAKE_MAGNITUDE = 5;/);
    assert.match(capsSrc, /export const MOBILE_MAX_IRAN_EVENTS = 50;/);
    assert.doesNotMatch(
      mapSrc,
      /private static readonly MOBILE_(MIN_EARTHQUAKE_MAGNITUDE|MAX_IRAN_EVENTS)/,
      'a renderer-private copy of a cap is how #4545 happened; keep the thresholds shared',
    );
    assert.match(
      mapSrc,
      /import \{ capEarthquakesForMobile, capIranEventsForMobile \} from '@\/utils\/mobile-feature-caps';/,
      'the SVG renderer must consume the shared predicates',
    );
  });

  it('applies the mobile M5.0 earthquake cutoff after the time-range filter and before marker DOM creation', () => {
    // The caps moved out of renderOverlays into overlayFeedSlices() (#7112) so
    // the marker budget plans on exactly the slice the loops draw. The ordering
    // invariant is unchanged and still asserted, just in its new home.
    const slices = sliceBetween('private overlayFeedSlices(): {', 'private planOverlayMarkerBudget(');

    const timeFilterIdx = slices.indexOf('const filteredQuakes = withinTimeRange(activeQuakes);');
    const mobileFilterIdx = slices.indexOf('quakes: capEarthquakesForMobile(');

    assert.match(
      slices,
      /const activeQuakes = layers\.natural \? this\.earthquakes : \[\];/,
      'a layer that is off must contribute no markers before any filtering runs',
    );
    assert.ok(timeFilterIdx >= 0, 'earthquake time-range filter should exist');
    assert.ok(mobileFilterIdx > timeFilterIdx, 'mobile cutoff should run after the time-range filter');
    assert.match(
      slices,
      /quakes: capEarthquakesForMobile\(filteredQuakes, this\.isMobile\),/,
      'mobile path must filter earthquakes through the shared M5.0 predicate',
    );

    // The slice is computed once, before any marker is built, and both the
    // budget plan and the render loop read that same slice — planning on the
    // raw field instead would spend the layer's share on events the cutoff
    // discards and render none of the ones that survive it (#7112).
    const overlays = sliceBetween(
      'private renderOverlays(projection: d3.GeoProjection): void {',
      'private renderConflictEventMarkers(',
    );
    const slicesIdx = overlays.indexOf('const slices = this.overlayFeedSlices();');
    const planIdx = overlays.indexOf('this.planOverlayMarkerBudget(projection, slices);');
    const markerLoopIdx = overlays.indexOf('quakesForRender.forEach((eq) => {');
    const markerDomIdx = overlays.indexOf("document.createElement('div')");

    assert.ok(slicesIdx >= 0, 'renderOverlays should derive its feed slices once');
    assert.ok(planIdx > slicesIdx, 'the marker budget should be planned from those slices');
    assert.ok(markerLoopIdx > planIdx, 'marker loop should run after the budget plan');
    assert.ok(markerDomIdx > slicesIdx, 'mobile cutoff should run before marker DOM creation');
    assert.match(
      overlays,
      /const quakesForRender = slices\.quakes;/,
      'the earthquake loop must iterate the shared slice',
    );
    assert.match(
      sliceBetween('private planOverlayMarkerBudget(', 'private isOverlayMarkerCut('),
      /add\('natural', slices\.quakes,/,
      'the budget must plan on the same earthquake slice the loop draws',
    );
  });

  it('applies the mobile Iran event cap before projection and marker DOM creation', () => {
    const slices = sliceBetween('private overlayFeedSlices(): {', 'private planOverlayMarkerBudget(');
    assert.match(
      slices,
      /iranEvents: capIranEventsForMobile\(activeIranEvents, this\.isMobile\),/,
      'mobile path must cap Iran events through the shared 50-event predicate',
    );

    const block = sliceBetween('// Iran events (severity-colored circles matching DeckGL layer)', '// Hotspots');
    const loopIdx = block.indexOf('slices.iranEvents.forEach((ev) => {');
    const projectionIdx = block.indexOf('const pos = projection([ev.longitude, ev.latitude])');
    const markerDomIdx = block.indexOf("document.createElement('div')");

    assert.ok(loopIdx >= 0, 'Iran marker loop should use the capped render slice');
    assert.ok(projectionIdx > loopIdx, 'Iran cap should run before per-event projection');
    assert.ok(markerDomIdx > projectionIdx, 'Iran cap should run before marker DOM creation');
    assert.match(
      sliceBetween('private planOverlayMarkerBudget(', 'private isOverlayMarkerCut('),
      /add\('iranAttacks', slices\.iranEvents\);/,
      'the budget must plan on the same Iran slice the loop draws',
    );
  });

  it('caps the feeds MapContainer dispatches to the renderers that have no cap of their own (#4545)', () => {
    // MapContainer.useGlobe carries no isMobile term — neither the persisted
    // preference in the constructor nor switchToGlobe() — so a phone reaches
    // GlobeMap, which maps whole arrays. Without a cap here, mobile 3D rendered
    // up to GLOBE_MARKER_BUDGET_MOBILE.perLayer (150) of exactly the markers
    // these caps exist to remove.
    assert.match(
      containerSrc,
      /import \{ capEarthquakesForMobile, capIranEventsForMobile \} from '@\/utils\/mobile-feature-caps';/,
    );
    assert.doesNotMatch(
      containerSrc,
      /this\.useGlobe = [^;]*isMobile/,
      'globe selection is deliberately independent of isMobile; the cap, not the renderer choice, is the fix',
    );

    const quakeSetter = sliceBetweenIn(
      containerSrc,
      'public setEarthquakes(earthquakes: Earthquake[]): void {',
      'public setImageryScenes(',
    );
    const capIdx = quakeSetter.indexOf('capEarthquakesForMobile(earthquakes, this.isMobile)');
    const globeIdx = quakeSetter.indexOf('this.globeMap?.setEarthquakes(capped)');
    const deckIdx = quakeSetter.indexOf('this.deckGLMap?.setEarthquakes(capped)');
    assert.ok(capIdx >= 0, 'the earthquake setter must apply the shared cap');
    assert.ok(globeIdx > capIdx, 'the globe branch must dispatch the capped feed');
    assert.ok(deckIdx > capIdx, 'the deck branch must dispatch the capped feed');
    assert.match(
      quakeSetter,
      /this\.cachedEarthquakes = earthquakes;/,
      'the replay cache must hold the raw feed, since a 2D⇄3D switch re-enters this setter',
    );
    assert.match(
      quakeSetter,
      /this\.svgMap\?\.setEarthquakes\(earthquakes\)/,
      'SVG caps at render time and drops empty payloads, so pre-capping it would pin stale markers',
    );

    const iranSetter = sliceBetweenIn(
      containerSrc,
      'public setIranEvents(events: IranEvent[]): void {',
      'public setNewsLocations(',
    );
    const iranCapIdx = iranSetter.indexOf('capIranEventsForMobile(events, this.isMobile)');
    const iranGlobeIdx = iranSetter.indexOf('this.globeMap?.setIranEvents(capped)');
    const iranDeckIdx = iranSetter.indexOf('this.deckGLMap?.setIranEvents(capped)');
    assert.ok(iranCapIdx >= 0, 'the Iran setter must apply the shared cap');
    assert.ok(iranGlobeIdx > iranCapIdx, 'the globe branch must dispatch the capped feed');
    assert.ok(iranDeckIdx > iranCapIdx, 'the deck branch must dispatch the capped feed');
    assert.match(
      iranSetter,
      /this\.cachedIranEvents = events;/,
      'the replay cache must hold the raw feed',
    );
    assert.match(iranSetter, /this\.svgMap\?\.setIranEvents\(events\)/);
  });

  it('no longer claims mobile always uses the SVG renderer', () => {
    // globe-marker-budget.ts asserted this as the justification for its mobile
    // ceiling; the false premise is the documentation half of #4545.
    const budgetSrc = readFileSync(resolve(root, 'src/utils/globe-marker-budget.ts'), 'utf-8');
    assert.doesNotMatch(budgetSrc, /Mobile always uses the SVG renderer/);
  });

  it('keeps label overlap measurement disabled on mobile until movement or zoom needs it', () => {
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

  it('keeps mobile label measurement out of the tap-start window and resumes it on real movement', () => {
    assert.doesNotMatch(
      mapSrc,
      /this\.container\.addEventListener\('pointerdown'[\s\S]*?resumeMobileLabelVisibility\(\)/,
      'pointerdown is part of the tap INP window and must not arm label measurement',
    );
    const touchStartBlock = sliceBetween("this.container.addEventListener('touchstart', (e) => {", "this.container.addEventListener('touchmove'");
    assert.doesNotMatch(
      touchStartBlock,
      /resumeMobileLabelVisibility\(\)/,
      'touchstart is part of the tap INP window and must not arm label measurement',
    );
    const touchMoveBlock = sliceBetween("this.container.addEventListener('touchmove', (e) => {", "this.container.addEventListener('touchend'");
    assert.match(
      touchMoveBlock,
      /if \(e\.touches\.length === 2[\s\S]*?this\.resumeMobileLabelVisibility\(\);[\s\S]*?this\.applyTransform\(\);/,
      'pinch movement should arm label measurement before the transform pass that needs it',
    );
    assert.match(
      touchMoveBlock,
      /touchDragActive = true;[\s\S]*?this\.resumeMobileLabelVisibility\(\);[\s\S]*?this\.applyTransform\(\);/,
      'single-finger panning should arm label measurement only after the drag threshold is crossed',
    );
    assert.match(
      mapSrc,
      /private resumeMobileLabelVisibility\(\): void \{\s*if \(!this\.isMobile \|\| this\.mobileLabelVisibilityArmed\) return;\s*this\.mobileLabelVisibilityArmed = true;\s*this\.updateLabelVisibility\(this\.state\.zoom\);\s*\}/,
      'resume should remain mobile-only, idempotent, and run one label pass when movement/zoom arms it',
    );
    const fitCountryBlock = sliceBetween('public fitCountry(code: string): void {', 'public getState(): MapState {');
    assert.equal(
      fitCountryBlock.match(/this\.setCenter\(midLat, midLon\);\s*this\.resumeMobileLabelVisibility\(\);/g)?.length,
      2,
      'fitCountry should re-arm mobile label measurement after both country-fit center paths',
    );
  });

  it('isolates mobile tap paint and removes marker transform transitions in the touch map', () => {
    assert.match(
      cssSrc,
      /\.map-container\s*\{[\s\S]*?contain:\s*layout paint;/,
      'the map container should contain map-triggered layout and paint work',
    );
    assert.match(
      cssSrc,
      /#mapOverlays\s*\{[\s\S]*?contain:\s*layout paint;/,
      'the overlay layer should isolate marker paint from the rest of the page',
    );
    const mobileTouchBlock = cssSrc.slice(
      cssSrc.indexOf('Mobile Touch Optimization'),
      cssSrc.indexOf('/* Extra small screens */'),
    );
    assert.match(
      mobileTouchBlock,
      /\.nat-event-marker,\s*\.conflict-click-area\s*\{[\s\S]*?transition:\s*opacity 0\.2s ease;/,
      'mobile marker tap targets should keep opacity fades while avoiding transform transitions',
    );
    const mobileMarkerTransitionBlock =
      mobileTouchBlock.match(/\.nat-event-marker,\s*\.conflict-click-area\s*\{[\s\S]*?\}/)?.[0] ?? '';
    assert.doesNotMatch(
      mobileMarkerTransitionBlock,
      /transform/,
      'mobile marker tap target transitions must not include transform',
    );
    assert.match(
      mobileTouchBlock,
      /\.nat-event-marker:hover\s*\{[\s\S]*?transform:\s*translate\(-50%, -50%\) scale\(var\(--marker-scale, 1\)\);/,
      'mobile natural-event hover should preserve the current transform instead of scaling on tap',
    );
  });
});
