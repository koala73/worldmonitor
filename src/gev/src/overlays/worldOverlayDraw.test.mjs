import test from 'node:test';
import assert from 'node:assert/strict';
import {
  altitudeFade,
  altitudeScale,
  clearWorldOverlayTextMeasureCache,
  combinedOverlayAlpha,
  distanceFade,
  distanceScale,
  destroyWorldOverlayDraw,
  getWorldOverlayTextMeasureCacheSize,
  installWorldOverlayFontInvalidation,
  measureOverlayEntry,
  measureWorldOverlayText,
  paintCard,
  paintDetectionCallout,
  paintLabel,
  paintSelected,
  paintTacticalCard,
  paintThumbnail,
  paintTrack,
  paintTracked,
  placementVariants,
  roundedRectPath,
} from './worldOverlayDraw.js';
import { createCctvThumbnailOverlayEntry, createFrameSlot } from '../data/cctvCards.js';
import {
  CARD_PLATE_ALPHA,
  DETECTION_PLATE_BAND,
  DETECTION_THEME_MAP,
  SKY_PLATE_SCALE,
  WORLD_OVERLAY_STYLE,
} from './worldOverlayTokens.js';

function alphaOf(rgba) {
  const match = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)/.exec(String(rgba));
  assert.ok(match, `expected an rgba() colour, got ${rgba}`);
  return Number(match[1]);
}

function mockContext() {
  const calls = [];
  let strokeStyle = '';
  let lineWidth = 1;
  return {
    calls,
    font: '',
    globalAlpha: 1,
    get strokeStyle() { return strokeStyle; },
    set strokeStyle(value) { strokeStyle = value; calls.push(['strokeStyle', value]); },
    get lineWidth() { return lineWidth; },
    set lineWidth(value) { lineWidth = value; calls.push(['lineWidth', value]); },
    measureCount: 0,
    measureText(text) {
      this.measureCount++;
      return { width: String(text).length * 6 };
    },
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    beginPath() { calls.push(['beginPath']); },
    roundRect(...args) { calls.push(['roundRect', ...args]); },
    moveTo(...args) { calls.push(['moveTo', ...args]); },
    lineTo(...args) { calls.push(['lineTo', ...args]); },
    arcTo(...args) { calls.push(['arcTo', ...args]); },
    closePath() { calls.push(['closePath']); },
    fill() { calls.push(['fill']); },
    stroke() { calls.push(['stroke']); },
    fillRect(...args) { calls.push(['fillRect', ...args]); },
    fillText(...args) { calls.push(['fillText', ...args]); },
    drawImage(...args) { calls.push(['drawImage', ...args]); },
  };
}

test('the tracked card alpha constant stays bound to the card it describes', () => {
  // Every ambient backing is specified as a fraction of the tracked readout
  // card's plate. If the card is ever retuned, this fails first and forces the
  // ambient family to be re-derived rather than silently drifting apart.
  assert.equal(alphaOf(WORLD_OVERLAY_STYLE.background), CARD_PLATE_ALPHA);
});

test('every detection theme carries a callout plate inside the ambient band', () => {
  for (const [name, theme] of Object.entries(DETECTION_THEME_MAP)) {
    const plate = alphaOf(theme.calloutPlate);
    const space = alphaOf(theme.calloutPlateSpace);
    assert.ok(
      plate >= DETECTION_PLATE_BAND.min * CARD_PLATE_ALPHA
        && plate <= DETECTION_PLATE_BAND.max * CARD_PLATE_ALPHA,
      `${name} callout plate ${plate} outside the ambient band`,
    );
    // The owner's spec: satellites read over the lit Earth disc, so the space
    // tier pops slightly harder — but never as heavy as the tracked card.
    assert.ok(space > plate, `${name} space plate must exceed the base plate`);
    assert.ok(space < CARD_PLATE_ALPHA, `${name} space plate must stay under the card`);
    // The scanline wash is a separate token and must not have been repurposed.
    assert.notEqual(theme.calloutPlate, theme.labelBg);
  }
});

test('an ambient detection callout paints its backing plate under its text', () => {
  const ctx = mockContext();
  paintDetectionCallout(ctx, {
    x: 20, y: 30, w: 80, h: 18,
    primaryX: 27, microX: 70, baseline: 42,
    leadFromX: 60, leadFromY: 60, leadToX: 60, leadToY: 48,
    plate: 'rgba(2, 18, 26, 0.52)',
    accent: '#22e0ff',
    label: 'rgba(200, 250, 255, 0.97)',
    primary: 'JA23NF',
    micro: 'FL017',
    font: '10px JetBrains Mono, monospace',
    microFont: '9px JetBrains Mono, monospace',
  }, 1);

  const names = ctx.calls.map(([name]) => name);
  const firstFill = names.indexOf('fill');
  const firstText = names.indexOf('fillText');
  assert.ok(firstFill >= 0, 'the callout must fill a backing plate');
  assert.ok(firstText > firstFill, 'the plate must be painted before the callsign');
  // Plate geometry: a rounded rect covering the whole measured label box.
  assert.deepEqual(
    ctx.calls.find(([name]) => name === 'roundRect'),
    ['roundRect', 20, 30, 80, 18, 3],
  );
  assert.ok(ctx.calls.some(([name, text]) => name === 'fillText' && text === 'JA23NF'));
  assert.ok(ctx.calls.some(([name, text]) => name === 'fillText' && text === 'FL017'));
});

test('a callout with no micro-field paints one text run and still gets a plate', () => {
  const ctx = mockContext();
  paintDetectionCallout(ctx, {
    x: 0, y: 0, w: 40, h: 18,
    primaryX: 7, microX: 30, baseline: 12,
    leadFromX: 20, leadFromY: 30, leadToX: 20, leadToY: 18,
    plate: 'rgba(2, 18, 26, 0.52)',
    accent: '#22e0ff',
    label: '#fff',
    primary: 'N12345',
    micro: '',
    font: '10px mono',
    microFont: '9px mono',
  }, 0.5);

  assert.ok(ctx.calls.some(([name]) => name === 'fill'));
  assert.equal(ctx.calls.filter(([name]) => name === 'fillText').length, 1);
});

test('distance and altitude fades preserve exact boundary/ramp math', () => {
  assert.equal(distanceFade(0, { maxDistance: 1000 }), 1);
  assert.equal(distanceFade(700, { maxDistance: 1000 }), 1);
  assert.equal(distanceFade(850, { maxDistance: 1000 }), 0.5);
  assert.equal(distanceFade(1000, { maxDistance: 1000 }), 0);
  assert.equal(distanceFade(50, { minDistance: 100, maxDistance: 1000 }), 0);
  assert.equal(altitudeFade(6000, { fadeStart: 7500, fadeEnd: 9500 }), 1);
  assert.equal(altitudeFade(8500, { fadeStart: 7500, fadeEnd: 9500 }), 0.5);
  assert.equal(altitudeFade(9500, { fadeStart: 7500, fadeEnd: 9500 }), 0);
});

test('distance scale matches the legacy infrastructure NearFarScalar curve', () => {
  const curve = { near: 250_000, nearValue: 1, far: 9_000_000, farValue: 0.62 };
  assert.equal(distanceScale(0, curve), 1);
  assert.equal(distanceScale(250_000, curve), 1);
  assert.equal(distanceScale(9_000_000, curve), 0.62);
  assert.equal(distanceScale(12_000_000, curve), 0.62);
  assert.ok(Math.abs(distanceScale(4_625_000, curve) - 0.81) < 1e-12);
  assert.equal(distanceScale(1_000_000, null), 1);
});

test('altitude scale preserves CCTV\'s exact smoothstep and linear waypoints', () => {
  const curve = {
    fullEnd: 1800,
    midEnd: 6000,
    end: 9500,
    midValue: 0.45,
    endValue: 0.35,
    smoothToMid: true,
  };
  assert.equal(altitudeScale(0, curve), 1);
  assert.equal(altitudeScale(1800, curve), 1);
  assert.ok(Math.abs(altitudeScale(6000, curve) - 0.45) < 1e-12);
  assert.equal(altitudeScale(9500, curve), 0.35);
  assert.ok(Math.abs(altitudeScale(3900, curve) - 0.725) < 1e-12);
  assert.ok(Math.abs(altitudeScale(7750, curve) - 0.4) < 1e-12);
});

test('the five-channel alpha chain is multiplicative and clamps inputs', () => {
  assert.equal(combinedOverlayAlpha({
    sourceAlpha: 0.5,
    temporalFade: 0.8,
    distanceFade: 0.5,
    altitudeFade: 0.5,
    keyholeEdgeFade: 0.25,
  }), 0.025);
  assert.equal(combinedOverlayAlpha({ sourceAlpha: 2, temporalFade: -1 }), 0);
});

test('placement variants flip below near the top and stay viewport-clamped', () => {
  const nearTop = placementVariants({
    anchorX: 10,
    anchorY: 5,
    width: 80,
    height: 30,
    viewportWidth: 200,
    viewportHeight: 100,
    gap: 10,
  });
  assert.deepEqual(nearTop.map((item) => item.corner), ['below', 'above', 'right', 'left']);
  for (const placement of nearTop) {
    assert.ok(placement.rect.x >= 4);
    assert.ok(placement.rect.y >= 4);
    assert.ok(placement.rect.x + placement.rect.w <= 196);
    assert.ok(placement.rect.y + placement.rect.h <= 96);
  }
  const reused = nearTop.slice();
  assert.equal(placementVariants({
    anchorX: 100,
    anchorY: 80,
    width: 40,
    height: 20,
    viewportWidth: 200,
    viewportHeight: 100,
  }, reused), reused);
  assert.equal(reused[0].corner, 'above');
});

test('tactical cards retain vertical-only placement and sprite-edge leaders', () => {
  const placements = placementVariants({
    anchorX: 100,
    anchorY: 80,
    width: 80,
    height: 30,
    viewportWidth: 200,
    viewportHeight: 120,
    gap: 20,
    leaderOffset: 14,
    verticalOnly: true,
  });
  assert.deepEqual(placements.map(({ corner }) => corner), ['above', 'below']);
  assert.equal(placements[0].leadFromY, 80);
  assert.equal(placements[0].leaderOffset, -14);
  assert.equal(placements[0].leadToY, placements[0].rect.y + placements[0].rect.h);
});

test('edge-clamped CCTV placements keep leaders vertical unless the anchor is outside the card', () => {
  const edgeClamped = placementVariants({
    anchorX: 20,
    anchorY: 160,
    width: 104,
    height: 77,
    viewportWidth: 240,
    viewportHeight: 240,
    gap: 22,
    leaderOffset: 16,
    verticalOnly: true,
  })[0];
  assert.equal(edgeClamped.rect.x, 4, 'card is horizontally clamped at the viewport edge');
  assert.equal(edgeClamped.leadFromX, 20);
  assert.equal(edgeClamped.leadToX, 20, 'leader stays strictly vertical at sx');

  const offRectAnchor = placementVariants({
    anchorX: 2,
    anchorY: 160,
    width: 104,
    height: 77,
    viewportWidth: 240,
    viewportHeight: 240,
    gap: 22,
    leaderOffset: 16,
    verticalOnly: true,
  })[0];
  // RE-SCOPED 2026-08-03. The old contract was `leadToX === 4` here: an anchor
  // outside the (edge-clamped) card rect pulled the leader endpoint to the card,
  // making the stub diagonal. That is branch-new — the shipped leader ran from
  // the anchor's sx to the card edge at the SAME sx, unconditionally — and a
  // slanted stub is exactly what reads as "this card is not attached to that
  // camera". Vertical always, even when the card has been clamped sideways off
  // its anchor.
  assert.equal(offRectAnchor.leadFromX, 2);
  assert.equal(offRectAnchor.leadToX, 2,
    'an off-rect anchor keeps the leader vertical rather than slanting it to the card');
});

test('rounded rectangles use native support and retain a fallback path', () => {
  const native = mockContext();
  roundedRectPath(native, 1, 2, 30, 20, 4);
  assert.deepEqual(native.calls[0], ['roundRect', 1, 2, 30, 20, 4]);

  const fallback = mockContext();
  delete fallback.roundRect;
  roundedRectPath(fallback, 1, 2, 30, 20, 4);
  assert.equal(fallback.calls.filter(([name]) => name === 'arcTo').length, 4);
  assert.equal(fallback.calls.at(-1)[0], 'closePath');
});

test('text measurement cache is font-aware and font hooks follow host lifetime', () => {
  destroyWorldOverlayDraw();
  const ctx = mockContext();
  let loadingDone = null;
  let addCount = 0;
  let removeCount = 0;
  globalThis.document = {
    fonts: {
      ready: new Promise(() => {}),
      addEventListener(name, listener) {
        if (name === 'loadingdone') {
          loadingDone = listener;
          addCount++;
        }
      },
      removeEventListener(name, listener) {
        if (name === 'loadingdone' && listener === loadingDone) removeCount++;
      },
    },
  };

  assert.equal(measureWorldOverlayText(ctx, 'A12', '10px mono'), 18);
  assert.equal(measureWorldOverlayText(ctx, 'A12', '10px mono'), 18);
  assert.equal(ctx.measureCount, 1);
  measureWorldOverlayText(ctx, 'A12', '12px mono');
  assert.equal(ctx.measureCount, 2);
  assert.equal(addCount, 1);
  assert.equal(getWorldOverlayTextMeasureCacheSize(), 2);
  loadingDone();
  assert.equal(getWorldOverlayTextMeasureCacheSize(), 0);
  destroyWorldOverlayDraw();
  assert.equal(removeCount, 1);
  installWorldOverlayFontInvalidation();
  assert.equal(addCount, 2);
  destroyWorldOverlayDraw();
  delete globalThis.document;
});

test('text measurement cache caps LRU retention at 1024 entries', () => {
  clearWorldOverlayTextMeasureCache();
  const ctx = mockContext();
  for (let i = 0; i < 1100; i++) measureWorldOverlayText(ctx, `label-${i}`, '10px mono');
  assert.equal(getWorldOverlayTextMeasureCacheSize(), 1024);
  const measured = ctx.measureCount;
  measureWorldOverlayText(ctx, 'label-0', '10px mono');
  assert.equal(ctx.measureCount, measured + 1);
  measureWorldOverlayText(ctx, 'label-1099', '10px mono');
  assert.equal(ctx.measureCount, measured + 1);
  assert.equal(getWorldOverlayTextMeasureCacheSize(), 1024);
  clearWorldOverlayTextMeasureCache();
});

test('variant measurement and all six painters remain renderer-local', () => {
  const ctx = mockContext();
  const entry = {
    title: 'CAMERA 12',
    details: ['LIVE', '1.2 KM'],
    accent: '#6be8ff',
    image: { width: 192, height: 108 },
    thumbnailWidth: 96,
    thumbnailHeight: 54,
  };
  const variants = ['label', 'track', 'card', 'thumbnail', 'selected', 'tracked'];
  const painters = [paintLabel, paintTrack, paintCard, paintThumbnail, paintSelected, paintTracked];
  for (let i = 0; i < variants.length; i++) {
    const variantEntry = { ...entry, variant: variants[i], selected: variants[i] === 'selected' };
    const layout = measureOverlayEntry(ctx, variantEntry, {});
    variantEntry._overlayLayout = layout;
    const placement = placementVariants({
      anchorX: 100,
      anchorY: 100,
      width: layout.w,
      height: layout.h,
      viewportWidth: 400,
      viewportHeight: 300,
    })[0];
    assert.equal(painters[i](ctx, variantEntry, placement, 0.5), placement.rect);
  }
  assert.ok(ctx.calls.some(([name]) => name === 'drawImage'));
  assert.ok(ctx.calls.filter(([name]) => name === 'fillText').length >= variants.length);
  const trackLayout = measureOverlayEntry(ctx, { ...entry, variant: 'track' }, {});
  assert.ok(trackLayout.w >= 'CAMERA 12 · LIVE'.length * 6);
});

test('thumbnail painter preserves the shipped CCTV 104x77 geometry and drawing coordinates', () => {
  const ctx = mockContext();
  const frameSlot = createFrameSlot();
  frameSlot.frame = { width: 192, height: 108 };
  frameSlot.stamp = 123;
  const entry = createCctvThumbnailOverlayEntry({
    id: 'cam-a',
    position: { x: 1, y: 2, z: 3 },
    title: 'Main & Fifth Avenue',
    frameSlot,
  });
  entry._overlayLayout = measureOverlayEntry(ctx, entry, {});
  assert.deepEqual(
    { w: entry._overlayLayout.w, h: entry._overlayLayout.h },
    { w: 104, h: 77 },
  );
  const placement = placementVariants({
    anchorX: 200,
    anchorY: 200,
    width: 104,
    height: 77,
    viewportWidth: 500,
    viewportHeight: 400,
    gap: entry.gapPx,
    leaderOffset: entry.leaderOffsetPx,
    verticalOnly: true,
  })[0];
  assert.deepEqual(placement.rect, { x: 148, y: 101, w: 104, h: 77 });
  paintThumbnail(ctx, entry, placement, 0.75);
  assert.deepEqual(
    ctx.calls.find(([name]) => name === 'strokeStyle'),
    ['strokeStyle', 'rgba(107, 232, 255, 0.6)'],
    'CCTV leader uses the source cyan token rather than the generic leader fallback',
  );
  assert.deepEqual(ctx.calls.find(([name]) => name === 'moveTo'), ['moveTo', 200, 184]);
  assert.deepEqual(
    ctx.calls.find(([name]) => name === 'drawImage'),
    ['drawImage', frameSlot.frame, 152, 105, 96, 54],
  );
  assert.deepEqual(
    ctx.calls.find(([name]) => name === 'fillText'),
    ['fillText', 'MAIN & FIFTH AV', 152, 169],
  );
});

test('tracked painter preserves centered multi-line readout metrics', () => {
  const ctx = mockContext();
  const entry = {
    variant: 'tracked',
    title: 'UAL123',
    details: ['FL350 · 451 kts', 'SFO → JFK'],
    accent: '#39d0ff',
  };
  entry._overlayLayout = measureOverlayEntry(ctx, entry, {});
  assert.equal(entry._overlayLayout.padX, 13);
  assert.equal(entry._overlayLayout.padY, 9);
  assert.equal(entry._overlayLayout.lineH, 17);
  const placement = placementVariants({
    anchorX: 200,
    anchorY: 180,
    width: entry._overlayLayout.w,
    height: entry._overlayLayout.h,
    viewportWidth: 600,
    viewportHeight: 400,
    verticalOnly: true,
  })[0];
  paintTracked(ctx, entry, placement, 0.8);
  assert.deepEqual(
    ctx.calls.filter(([name]) => name === 'fillText').map(([, text]) => text),
    ['UAL123', 'FL350 · 451 kts', 'SFO → JFK'],
  );
});

test('shared tactical painter preserves FIRMS card metrics and top-rule treatment', () => {
  const ctx = mockContext();
  const entry = {
    variant: 'selected',
    selected: true,
    cardStyle: 'tactical',
    title: 'FIRE · 1520 MW',
    details: ['high conf · 2h ago', '61.9°N 122.9°W'],
    accent: '224, 82, 82',
  };
  entry._overlayLayout = measureOverlayEntry(ctx, entry, {});
  assert.deepEqual(
    {
      padX: entry._overlayLayout.padX,
      padY: entry._overlayLayout.padY,
      titleH: entry._overlayLayout.titleH,
      lineH: entry._overlayLayout.lineH,
    },
    { padX: 12, padY: 8, titleH: 14, lineH: 15 },
  );
  const placement = placementVariants({
    anchorX: 200,
    anchorY: 160,
    width: entry._overlayLayout.w,
    height: entry._overlayLayout.h,
    viewportWidth: 500,
    viewportHeight: 300,
    gap: 20,
    leaderOffset: 14,
    verticalOnly: true,
  })[0];
  assert.equal(paintTacticalCard(ctx, entry, placement, 0.5), placement.rect);
  assert.deepEqual(ctx.calls.find(([name]) => name === 'moveTo'), ['moveTo', 200, 146]);
  assert.equal(ctx.calls.filter(([name]) => name === 'stroke').length, 2, 'leader + selected border');
  assert.equal(ctx.calls.filter(([name]) => name === 'fillText').length, 3);
  assert.equal(ctx.calls.at(-1)[0], 'restore');
});

test('track display text is cached across measure and paint and invalidates on content change', () => {
  const ctx = mockContext();
  const entry = { variant: 'track', title: 'UAL123', details: ['450 KT'] };
  const originalFilter = Array.prototype.filter;
  let filterCalls = 0;
  Array.prototype.filter = function countTrackDisplayFilters(...args) {
    filterCalls++;
    return originalFilter.apply(this, args);
  };
  try {
    entry._overlayLayout = measureOverlayEntry(ctx, entry, {});
    const placement = placementVariants({
      anchorX: 100,
      anchorY: 100,
      width: entry._overlayLayout.w,
      height: entry._overlayLayout.h,
      viewportWidth: 400,
      viewportHeight: 300,
    })[0];
    paintTrack(ctx, entry, placement);
    measureOverlayEntry(ctx, entry, entry._overlayLayout);
    paintTrack(ctx, entry, placement);
    entry.title = 'UAL124';
    entry.details[0] = '451 KT';
    measureOverlayEntry(ctx, entry, entry._overlayLayout);
    paintTrack(ctx, entry, placement);
  } finally {
    Array.prototype.filter = originalFilter;
  }
  assert.equal(filterCalls, 0);
  assert.equal(entry._overlayTrackDisplayText, 'UAL124 · 451 KT');
  assert.deepEqual(
    ctx.calls.filter(([name]) => name === 'fillText').map(([, text]) => text),
    ['UAL123 · 450 KT', 'UAL123 · 450 KT', 'UAL124 · 451 KT'],
  );
});

/** Records the globalAlpha in force at each paint op, which the shared mock does not. */
function alphaProbe() {
  const ctx = mockContext();
  const alphas = { fill: [], text: [], stroke: [] };
  const inner = { fill: ctx.fill, fillText: ctx.fillText, stroke: ctx.stroke };
  ctx.fill = function fill(...args) { alphas.fill.push(this.globalAlpha); return inner.fill.apply(this, args); };
  ctx.fillText = function fillText(...args) { alphas.text.push(this.globalAlpha); return inner.fillText.apply(this, args); };
  ctx.stroke = function stroke(...args) { alphas.stroke.push(this.globalAlpha); return inner.stroke.apply(this, args); };
  return { ctx, alphas };
}

const CALLOUT_FIXTURE = Object.freeze({
  x: 20, y: 30, w: 80, h: 18,
  primaryX: 27, microX: 70, baseline: 42,
  leadFromX: 60, leadFromY: 60, leadToX: 60, leadToY: 48,
  plate: 'rgba(2, 18, 26, 0.52)',
  accent: '#22e0ff',
  label: 'rgba(200, 250, 255, 0.97)',
  primary: 'JA23NF',
  micro: 'FL017',
  font: '10px JetBrains Mono, monospace',
  microFont: '9px JetBrains Mono, monospace',
});

test('a sky-backed callout feathers its PLATE and nothing else', () => {
  // The owner's call: against the horizon the plate reads as a dark box on an
  // empty sky and the pre-plate bare text was better. Feathering must land on
  // the backing only — the callsign, the tier bar and the leader are the
  // callout's identity and keep the composed fades.
  const ground = alphaProbe();
  paintDetectionCallout(ground.ctx, { ...CALLOUT_FIXTURE, plateScale: 1 }, 0.8);
  const sky = alphaProbe();
  paintDetectionCallout(sky.ctx, { ...CALLOUT_FIXTURE, plateScale: SKY_PLATE_SCALE }, 0.8);

  // The plate is the FIRST fill; the tier accent bar is the second.
  assert.ok(Math.abs(ground.alphas.fill[0] - 0.8) < 1e-12, 'ground keeps the full plate');
  assert.ok(
    Math.abs(sky.alphas.fill[0] - 0.8 * SKY_PLATE_SCALE) < 1e-12,
    'sky scales the plate by the token, not by some other number',
  );
  assert.deepEqual(
    sky.alphas.fill.slice(1), ground.alphas.fill.slice(1),
    'the accent bar must not inherit the plate feather',
  );
  assert.deepEqual(sky.alphas.text, ground.alphas.text, 'text opacity is untouched');
  assert.deepEqual(sky.alphas.stroke, ground.alphas.stroke, 'the leader is untouched');
  // Same fill token in both: the theme's plate hue is scaled, never swapped.
  assert.equal(
    sky.ctx.calls.find(([name]) => name === 'fillStyle')?.[1],
    ground.ctx.calls.find(([name]) => name === 'fillStyle')?.[1],
  );
});

test('a callout with no backdrop information paints at full plate', () => {
  // Every caller before the backdrop pass omitted plateScale. Defaulting to a
  // feather would silently strip plates off the tilted-down case the plate was
  // introduced for, so the default must be the full plate.
  const { ctx, alphas } = alphaProbe();
  paintDetectionCallout(ctx, CALLOUT_FIXTURE, 0.5);
  assert.ok(Math.abs(alphas.fill[0] - 0.5) < 1e-12);
});

test('the sky plate scale is a whisper, not a second plate', () => {
  // The point of the feather is to land back near the bare-text look the owner
  // preferred against sky. A scale that drifts up toward 1 quietly restores the
  // boxes; a negative or >1 scale is nonsense.
  assert.ok(SKY_PLATE_SCALE > 0 && SKY_PLATE_SCALE <= 0.35);
  // Against the lightest shipped plate this must resolve to near-invisible.
  const lightest = Math.min(
    ...Object.values(DETECTION_THEME_MAP).map((theme) => alphaOf(theme.calloutPlate)),
  );
  assert.ok(lightest * SKY_PLATE_SCALE < 0.12, 'the feathered plate must read as bare text');
});
