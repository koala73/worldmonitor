/**
 * @module detectionDraw
 * @description Pure, renderer-agnostic helpers for the detection overlay.
 *
 * Deliberately free of Cesium and DOM dependencies so the label composition,
 * metric formatting, glyph-width estimation, fade ramp, and corner-bracket
 * geometry can be unit-tested in isolation — and reused verbatim by a future
 * GPU/MSDF renderer. The Canvas2D overlay (detection.js) imports these and
 * supplies the actual drawing surface.
 */

/** @constant {number} Max characters shown for a label's primary (id) line. */
const MAX_PRIMARY = 18;
/** @constant {number} Max characters shown for a label's secondary (class · metric) line. */
const MAX_SECONDARY = 26;
/** @constant {number} Metres-to-feet conversion factor. */
const M_TO_FT = 3.28084;

/**
 * Formats an altitude in metres as an aviation flight level (hundreds of feet),
 * zero-padded to three digits. Returns '' for missing/zero/negative altitude so
 * the label gracefully degrades to id-only.
 * @param {number} altitudeMeters - Altitude above sea level in metres.
 * @returns {string} e.g. 'FL340', or '' when not applicable.
 */
export function formatFlightLevel(altitudeMeters) {
  if (!Number.isFinite(altitudeMeters) || altitudeMeters <= 0) return '';
  const fl = Math.round((altitudeMeters * M_TO_FT) / 100);
  return 'FL' + String(fl).padStart(3, '0');
}

/**
 * Formats a speed in knots as a short rounded label. Returns '' for
 * non-positive or non-finite speeds (declutters moored/unknown vessels).
 * @param {number} knots - Speed over ground in knots.
 * @returns {string} e.g. '14 kn', or '' when not applicable.
 */
export function formatKnots(knots) {
  if (!Number.isFinite(knots) || knots <= 0) return '';
  return Math.round(knots) + ' kn';
}

/**
 * Estimates the pixel width of a monospace string without touching the canvas.
 * For a fixed-advance font, width is exactly length × advance — this avoids a
 * per-label measureText() call (the old per-frame hot-path stall).
 * @param {string} text - The string to measure.
 * @param {number} charWidth - Per-glyph advance width in pixels.
 * @returns {number} Estimated width in pixels (0 for empty/null).
 */
export function monoTextWidth(text, charWidth) {
  if (!text) return 0;
  return text.length * charWidth;
}

/**
 * Composes a detection label into a two-tier structure: a bright primary line
 * (the id/callsign) and a dimmer secondary line ("class · metric"). Missing
 * class/metric collapse the secondary to '' so the label degrades to id-only.
 * @param {{id?: string, klass?: string, metric?: string}} obj - Label source fields.
 * @returns {{primary: string, secondary: string}} Truncated label lines.
 */
export function composeLabel(obj) {
  const src = obj || {};
  const primary = String(src.id || '').slice(0, MAX_PRIMARY);
  const parts = [src.klass, src.metric]
    .map((s) => (s == null ? '' : String(s).trim()))
    .filter((s) => s.length > 0);
  const secondary = parts.join(' · ').slice(0, MAX_SECONDARY);
  return { primary, secondary };
}

/**
 * Computes a 0→1 fade-in alpha for a subtle "acquire" animation, ramping over
 * fadeMs from the first-seen timestamp. Defaults to fully visible (1) when the
 * timestamp is unknown or the fade window is non-positive.
 * @param {number} firstSeenMs - Timestamp the target first appeared.
 * @param {number} nowMs - Current timestamp.
 * @param {number} fadeMs - Fade-in duration in milliseconds.
 * @returns {number} Alpha in [0, 1].
 */
export function acquireAlpha(firstSeenMs, nowMs, fadeMs) {
  if (!Number.isFinite(firstSeenMs) || !(fadeMs > 0)) return 1;
  const elapsed = nowMs - firstSeenMs;
  if (elapsed <= 0) return 0;
  if (elapsed >= fadeMs) return 1;
  return elapsed / fadeMs;
}

/**
 * Appends one bracket-style bounding box (four L-shaped corner segments only)
 * to a path-like sink exposing moveTo(x, y) / lineTo(x, y). Designed so many
 * boxes accumulate into a single Path2D for one batched stroke() — replacing
 * the old per-box beginPath/stroke. Geometry matches the prior reticle exactly.
 * @param {{moveTo: Function, lineTo: Function}} sink - Path2D or compatible recorder.
 * @param {number} sx - Screen X centre of the box.
 * @param {number} sy - Screen Y centre of the box.
 * @param {number} halfW - Half-width of the box.
 * @param {number} halfH - Half-height of the box.
 */
export function appendCornerBracket(sink, sx, sy, halfW, halfH) {
  const x0 = sx - halfW;
  const y0 = sy - halfH;
  const x1 = sx + halfW;
  const y1 = sy + halfH;
  const seg = Math.max(4, Math.floor(Math.min(halfW, halfH) * 0.55));

  // top-left
  sink.moveTo(x0, y0 + seg);
  sink.lineTo(x0, y0);
  sink.lineTo(x0 + seg, y0);
  // top-right
  sink.moveTo(x1 - seg, y0);
  sink.lineTo(x1, y0);
  sink.lineTo(x1, y0 + seg);
  // bottom-right
  sink.moveTo(x1, y1 - seg);
  sink.lineTo(x1, y1);
  sink.lineTo(x1 - seg, y1);
  // bottom-left
  sink.moveTo(x0 + seg, y1);
  sink.lineTo(x0, y1);
  sink.lineTo(x0, y1 - seg);
}

/**
 * Resolves a detectable object's threat tier — the key into a theme's color
 * ramp (civil/military/sea/space/vehicle). A layer-supplied `tier` wins;
 * otherwise it derives from the coarse `type`. Drives per-tier box/card color.
 * @param {{type?: string, tier?: string}} obj - Detectable object.
 * @returns {string} Tier key.
 */
export function resolveTier(obj) {
  if (obj && obj.tier) return obj.tier;
  const t = obj && obj.type;
  if (t === 'SEA') return 'sea';
  if (t === 'SAT') return 'space';
  if (t === 'VEH') return 'vehicle';
  return 'civil';
}

/**
 * Computes the geometry of a two-tier label "card": overall width/height plus
 * the text baselines, sized so the second line and its descenders always fit
 * (the clipping bug in the throwaway spike). Pure layout — the renderer draws
 * the rounded rect, accent bar, and text from these numbers.
 * @param {string} primary - Bright first line (id/callsign).
 * @param {string} secondary - Dim second line (class · metric); '' collapses to one line.
 * @param {number} charWidth - Monospace glyph advance, px.
 * @returns {{w: number, h: number, idBase: number, subBase: number, textX: number, hasSec: boolean}}
 */
export function measureLabelCard(primary, secondary, charWidth) {
  const padX = 6;
  const padY = 4;
  const lineH = 11;
  const ASC = 8; // cap height above the first baseline
  const DESC = 3; // descender depth below the last baseline
  const accentW = 3; // left accent bar width
  const accentGap = 4; // gap between accent bar and text (doubles as left pad)
  const hasSec = !!(secondary && secondary.length);
  const wId = monoTextWidth(primary, charWidth);
  const wSub = hasSec ? monoTextWidth(secondary, charWidth) : 0;
  const textW = Math.max(wId, wSub);
  const w = Math.ceil(accentW + accentGap + textW + padX);
  const idBase = padY + ASC;
  const subBase = hasSec ? idBase + lineH : 0;
  const lastBase = hasSec ? subBase : idBase;
  const h = lastBase + DESC + padY;
  const textX = accentW + accentGap;
  return { w, h, idBase, subBase, textX, hasSec };
}

/**
 * Computes the geometry of a SINGLE-LINE track label: callsign (bright) followed
 * on the same baseline by a dim altitude/metric micro-field. This is the
 * persistent label — type is carried by the platform icon, not text — replacing
 * the two-line card for the ambient majority of tracks.
 * @param {string} primary - Callsign / id (bright).
 * @param {string} micro - Short metric, e.g. flight level digits or '14kn' ('' = none).
 * @param {number} charWidth - Monospace glyph advance for the primary text, px.
 * @returns {{w: number, h: number, baseline: number, primaryX: number, microX: number, hasMicro: boolean}}
 */
export function measureTrackLabel(primary, micro, charWidth) {
  const padX = 6;
  const padY = 4;
  const ASC = 8;
  const DESC = 3;
  const tickW = 3; // affiliation/tier tick at the left
  const tickGap = 4;
  const microGap = 6; // space between callsign and the micro-field
  const MICRO_SCALE = 0.9; // micro renders slightly smaller than the callsign
  const hasMicro = !!(micro && micro.length);
  const wPrimary = monoTextWidth(primary, charWidth);
  const wMicro = hasMicro ? monoTextWidth(micro, charWidth * MICRO_SCALE) : 0;
  const textW = wPrimary + (hasMicro ? microGap + wMicro : 0);
  const w = Math.ceil(tickW + tickGap + textW + padX);
  const baseline = padY + ASC;
  const h = baseline + DESC + padY;
  const primaryX = tickW + tickGap;
  const microX = primaryX + wPrimary + microGap;
  return { w, h, baseline, primaryX, microX, hasMicro };
}

/**
 * Returns whether a screen-space card intersects any reserved UI rectangle.
 * Touching edges are allowed; positive padding expands the exclusion gap.
 * @param {{x:number,y:number,w:number,h:number}} rect - Candidate card rectangle.
 * @param {Array<{x:number,y:number,w:number,h:number}>} obstacles - HUD rectangles.
 * @param {number} [padding=0] - Additional separation in CSS pixels.
 * @returns {boolean} True when the card would be covered by a HUD rectangle.
 */
export function rectIntersectsAny(rect, obstacles, padding = 0) {
  if (!rect || !Array.isArray(obstacles)) return false;
  return obstacles.some((obstacle) => obstacle
    && rect.x < obstacle.x + obstacle.w + padding
    && rect.x + rect.w + padding > obstacle.x
    && rect.y < obstacle.y + obstacle.h + padding
    && rect.y + rect.h + padding > obstacle.y);
}

/**
 * Linear near/far interpolation matching Cesium's NearFarScalar — maps a camera
 * distance to a scale, clamped to the near value when closer than `near` and the
 * far value when beyond `far`. Lets the detection reticle track a billboard's
 * on-screen size (which uses the same scaleByDistance curve).
 * @param {number} distance - Camera-to-object distance, metres.
 * @param {number} near - Near distance, metres.
 * @param {number} nearValue - Scale at/under the near distance.
 * @param {number} far - Far distance, metres.
 * @param {number} farValue - Scale at/over the far distance.
 * @returns {number} Interpolated scale.
 */
export function nearFarScale(distance, near, nearValue, far, farValue) {
  if (!(far > near)) return nearValue;
  if (distance <= near) return nearValue;
  if (distance >= far) return farValue;
  const t = (distance - near) / (far - near);
  return nearValue + t * (farValue - nearValue);
}
