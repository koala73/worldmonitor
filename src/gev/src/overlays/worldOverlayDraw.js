/**
 * @module worldOverlayDraw
 * @description Pure geometry, measurement, and Canvas2D painters for the
 * shared world overlay. This module owns presentation only: no layer state,
 * fetching, Cesium scene queries, or source selection policy belongs here.
 */

import { WORLD_OVERLAY_STYLE } from './worldOverlayTokens.js';

// Two high-cardinality infrastructure sources share this cache; 1024 avoids
// repeated O(n) eviction scans while keeping host-lifetime retention bounded.
const TEXT_MEASURE_CACHE_LIMIT = 1024;
const _textMeasureCache = new Map();
let _textMeasureCacheSize = 0;
// Recency is a monotonic integer stamp rather than a doubly linked list: a
// cache hit happens twice per painted entry per frame, and re-linking four
// object pointers on every hit costs real write-barrier traffic. A Smi store
// costs nothing, and eviction (only above the cap) can afford a scan.
let _textMeasureClock = 0;
let _fontInvalidationInstalled = false;
let _fontInvalidationGeneration = 0;
let _observedFontSet = null;

function evictOldestTextMeasureEntry() {
  let oldestFont = null;
  let oldestText = null;
  let oldestUsedAt = Number.POSITIVE_INFINITY;
  _textMeasureCache.forEach((fontCache, font) => {
    fontCache.forEach((entry, text) => {
      if (entry.usedAt >= oldestUsedAt) return;
      oldestUsedAt = entry.usedAt;
      oldestFont = font;
      oldestText = text;
    });
  });
  if (oldestFont === null) return;
  const fontCache = _textMeasureCache.get(oldestFont);
  fontCache.delete(oldestText);
  if (fontCache.size === 0) _textMeasureCache.delete(oldestFont);
  _textMeasureCacheSize--;
}

/** Clear cached text widths after web-font availability changes. */
export function clearWorldOverlayTextMeasureCache() {
  _textMeasureCache.clear();
  _textMeasureCacheSize = 0;
  _textMeasureClock = 0;
}

/** Install the font-loading invalidation hooks once, when the API exists. */
export function installWorldOverlayFontInvalidation() {
  if (_fontInvalidationInstalled || typeof document === 'undefined' || !document.fonts) return;
  _fontInvalidationInstalled = true;
  _observedFontSet = document.fonts;
  const generation = ++_fontInvalidationGeneration;
  Promise.resolve(document.fonts.ready)
    .then(() => {
      if (generation === _fontInvalidationGeneration) clearWorldOverlayTextMeasureCache();
    })
    .catch(() => {});
  _observedFontSet.addEventListener?.('loadingdone', clearWorldOverlayTextMeasureCache);
}

/** Remove font hooks and cached measurements when the overlay host is destroyed. */
export function destroyWorldOverlayDraw() {
  _fontInvalidationGeneration++;
  _observedFontSet?.removeEventListener?.('loadingdone', clearWorldOverlayTextMeasureCache);
  _observedFontSet = null;
  _fontInvalidationInstalled = false;
  clearWorldOverlayTextMeasureCache();
}

/**
 * Measure text with a font-aware cache.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {string} font
 * @returns {number}
 */
export function measureWorldOverlayText(ctx, text, font) {
  if (!_fontInvalidationInstalled) installWorldOverlayFontInvalidation();
  const normalizedText = String(text ?? '');
  const normalizedFont = String(font || WORLD_OVERLAY_STYLE.fontLabel);
  let fontCache = _textMeasureCache.get(normalizedFont);
  const cached = fontCache?.get(normalizedText);
  if (cached) {
    cached.usedAt = ++_textMeasureClock;
    return cached.width;
  }
  ctx.font = normalizedFont;
  const width = Number(ctx.measureText(normalizedText)?.width) || 0;
  if (!fontCache) {
    fontCache = new Map();
    _textMeasureCache.set(normalizedFont, fontCache);
  }
  fontCache.set(normalizedText, { width, usedAt: ++_textMeasureClock });
  _textMeasureCacheSize++;
  if (_textMeasureCacheSize > TEXT_MEASURE_CACHE_LIMIT) evictOldestTextMeasureEntry();
  return width;
}

/** @returns {number} Current cache size, exposed for focused diagnostics/tests. */
export function getWorldOverlayTextMeasureCacheSize() {
  return _textMeasureCacheSize;
}

/**
 * Append a rounded rectangle to the current Canvas2D path.
 * @param {CanvasRenderingContext2D|Path2D} path
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} radius
 */
export function roundedRectPath(path, x, y, w, h, radius = WORLD_OVERLAY_STYLE.radius) {
  if (typeof path.roundRect === 'function') {
    path.roundRect(x, y, w, h, radius);
    return;
  }
  const r = Math.max(0, Math.min(Number(radius) || 0, w / 2, h / 2));
  path.moveTo(x + r, y);
  path.arcTo(x + w, y, x + w, y + h, r);
  path.arcTo(x + w, y + h, x, y + h, r);
  path.arcTo(x, y + h, x, y, r);
  path.arcTo(x, y, x + w, y, r);
  path.closePath();
}

/**
 * FIRMS-compatible distance fade: full through 70% of the far range, then a
 * linear ramp to zero. A finite minimum is a hard near-range policy boundary.
 * @param {number} distanceM
 * @param {object} [options]
 * @param {number} [options.minDistance]
 * @param {number} [options.maxDistance]
 * @param {number} [options.fadeStartRatio]
 * @returns {number}
 */
export function distanceFade(distanceM, {
  minDistance = 0,
  maxDistance = Number.POSITIVE_INFINITY,
  fadeStartRatio = 0.7,
} = {}) {
  if (!Number.isFinite(distanceM)) return 0;
  const min = Number.isFinite(minDistance) ? Math.max(0, minDistance) : 0;
  if (distanceM < min) return 0;
  if (!Number.isFinite(maxDistance)) return 1;
  const max = Math.max(min, maxDistance);
  if (distanceM >= max) return 0;
  const ratio = Math.max(0, Math.min(1, Number(fadeStartRatio) || 0));
  const fadeStart = min + (max - min) * ratio;
  if (distanceM <= fadeStart || fadeStart >= max) return 1;
  return 1 - (distanceM - fadeStart) / (max - fadeStart);
}

/**
 * Cesium NearFarScalar-compatible distance scale for a complete overlay card.
 * Values clamp outside the curve and interpolate linearly between its stops.
 * @param {number} distanceM
 * @param {object|null} [curve]
 * @param {number} [curve.near]
 * @param {number} [curve.nearValue]
 * @param {number} [curve.far]
 * @param {number} [curve.farValue]
 * @returns {number}
 */
export function distanceScale(distanceM, curve = null) {
  if (!curve || !Number.isFinite(distanceM)) return 1;
  const near = Math.max(0, Number(curve.near) || 0);
  const far = Math.max(near, Number(curve.far) || near);
  const nearValue = Math.max(0, Number(curve.nearValue) || 0);
  const farValue = Math.max(0, Number(curve.farValue) || 0);
  if (distanceM <= near || far === near) return nearValue;
  if (distanceM >= far) return farValue;
  const progress = (distanceM - near) / (far - near);
  return nearValue + (farValue - nearValue) * progress;
}

/**
 * Source-configurable camera-altitude scale for a complete overlay card.
 * The first leg may use smoothstep to preserve CCTV's shipped street-to-city
 * transition; the second leg is linear and clamps at the source's minimum.
 * @param {number} altitudeM
 * @param {object|null} [curve]
 * @returns {number}
 */
export function altitudeScale(altitudeM, curve = null) {
  if (!curve || !Number.isFinite(altitudeM)) return 1;
  const fullEnd = Number(curve.fullEnd);
  const midEnd = Number(curve.midEnd);
  const end = Number(curve.end);
  const midValue = Number(curve.midValue);
  const endValue = Number(curve.endValue);
  if (!Number.isFinite(fullEnd) || !Number.isFinite(midEnd) || !Number.isFinite(end)
    || !Number.isFinite(midValue) || !Number.isFinite(endValue)) return 1;
  if (altitudeM <= fullEnd) return 1;
  if (altitudeM <= midEnd) {
    const span = Math.max(1, midEnd - fullEnd);
    let progress = Math.max(0, Math.min(1, (altitudeM - fullEnd) / span));
    if (curve.smoothToMid === true) progress = progress * progress * (3 - 2 * progress);
    return 1 + (midValue - 1) * progress;
  }
  if (altitudeM >= end) return endValue;
  const progress = Math.max(0, Math.min(1, (altitudeM - midEnd) / Math.max(1, end - midEnd)));
  return midValue + (endValue - midValue) * progress;
}

/**
 * Linear camera-altitude fade. Sources opt in with finite fade boundaries.
 * @param {number} altitudeM
 * @param {object} [options]
 * @param {number} [options.minAltitude]
 * @param {number} [options.fadeStart]
 * @param {number} [options.fadeEnd]
 * @returns {number}
 */
export function altitudeFade(altitudeM, {
  minAltitude = Number.NEGATIVE_INFINITY,
  fadeStart = Number.POSITIVE_INFINITY,
  fadeEnd = Number.POSITIVE_INFINITY,
} = {}) {
  if (!Number.isFinite(altitudeM)) return 1;
  if (Number.isFinite(minAltitude) && altitudeM < minAltitude) return 0;
  if (!Number.isFinite(fadeEnd)) return 1;
  const end = fadeEnd;
  const start = Number.isFinite(fadeStart) ? Math.min(fadeStart, end) : end;
  if (altitudeM <= start) return 1;
  if (altitudeM >= end || start === end) return 0;
  return 1 - (altitudeM - start) / (end - start);
}

/** Multiply the five independent opacity channels in the binding order. */
export function combinedOverlayAlpha({
  sourceAlpha = 1,
  temporalFade = 1,
  distanceFade: distanceAlpha = 1,
  altitudeFade: altitudeAlpha = 1,
  keyholeEdgeFade = 1,
} = {}) {
  return clampUnit(sourceAlpha)
    * clampUnit(temporalFade)
    * clampUnit(distanceAlpha)
    * clampUnit(altitudeAlpha)
    * clampUnit(keyholeEdgeFade);
}

function clampUnit(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 1;
}

function trackDisplayText(entry) {
  const title = entry?.title || '';
  const detail = Array.isArray(entry?.details) ? entry.details[0] || '' : '';
  if (entry._overlayTrackDisplayTitle !== title || entry._overlayTrackDisplayDetail !== detail) {
    entry._overlayTrackDisplayTitle = title;
    entry._overlayTrackDisplayDetail = detail;
    entry._overlayTrackDisplayText = title && detail ? `${title} · ${detail}` : title || detail;
  }
  return entry._overlayTrackDisplayText || '';
}

/**
 * Measure the selected entry variant into a caller-owned layout object.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} entry
 * @param {object} [out]
 * @returns {{w:number,h:number,padX:number,padY:number,titleH:number,lineH:number,thumbW:number,thumbH:number}}
 */
export function measureOverlayEntry(ctx, entry, out = {}) {
  const variant = entry?.selected ? 'selected' : String(entry?.variant || 'label');
  const details = Array.isArray(entry?.details) ? entry.details : [];
  const selected = variant === 'selected';
  const tracked = variant === 'tracked';
  const tactical = entry?.cardStyle === 'tactical';
  const titleFont = tracked
    ? WORLD_OVERLAY_STYLE.fontTrackedTitle
    : selected ? WORLD_OVERLAY_STYLE.fontSelected : WORLD_OVERLAY_STYLE.fontTitle;
  let titleWidth = measureWorldOverlayText(ctx, entry?.title || '',
    variant === 'label' ? WORLD_OVERLAY_STYLE.fontLabel : titleFont);
  if (variant === 'track' && details[0]) {
    titleWidth = measureWorldOverlayText(
      ctx,
      trackDisplayText(entry),
      WORLD_OVERLAY_STYLE.fontTrack,
    );
  }
  let detailWidth = 0;
  for (let i = 0; i < details.length; i++) {
    detailWidth = Math.max(
      detailWidth,
      measureWorldOverlayText(
        ctx,
        details[i],
        tracked ? WORLD_OVERLAY_STYLE.fontTrackedDetail : WORLD_OVERLAY_STYLE.fontDetail,
      ),
    );
  }

  out.padX = tracked ? 13 : selected ? 12 : variant === 'label' || variant === 'track' ? 6 : 9;
  out.padY = tracked ? 9 : selected ? 8 : variant === 'label' || variant === 'track' ? 4 : 6;
  out.titleH = tactical
    ? (selected ? 14 : 12)
    : tracked ? 13 : selected ? 15 : variant === 'label' || variant === 'track' ? 11 : 13;
  out.lineH = tracked ? 17 : selected ? 15 : 13;
  out.thumbW = 0;
  out.thumbH = 0;

  if (variant === 'thumbnail') {
    out.padX = Math.max(0, Number(entry?.thumbnailPadX) || 0);
    out.padY = Math.max(0, Number(entry?.thumbnailPadTop) || 0);
    out.padBottom = Math.max(0, Number(entry?.thumbnailPadBottom) || 0);
    out.titleGap = Math.max(0, Number(entry?.thumbnailTitleGap) || 0);
    out.titleH = Math.max(0, Number(entry?.thumbnailTitleHeight) || out.titleH);
    out.thumbW = Math.max(1, Number(entry?.thumbnailWidth) || 96);
    out.thumbH = Math.max(1, Number(entry?.thumbnailHeight) || 54);
    out.w = out.thumbW + out.padX * 2;
    out.h = out.padY + out.thumbH + out.titleGap + out.titleH + out.padBottom;
  } else {
    out.w = Math.ceil(Math.max(titleWidth, detailWidth)) + out.padX * 2;
    out.h = out.padY * 2 + out.titleH + details.length * out.lineH;
  }
  out.w = Math.max(8, out.w);
  out.h = Math.max(8, out.h);
  return out;
}

function writePlacement(out, corner, x, y, w, h, anchorX, anchorY, signedLeaderOffset = 0) {
  const placement = out || {};
  placement.corner = corner;
  placement.rect ||= {};
  placement.rect.x = Math.round(x);
  placement.rect.y = Math.round(y);
  placement.rect.w = w;
  placement.rect.h = h;
  placement.centerX = placement.rect.x + w / 2;
  placement.centerY = placement.rect.y + h / 2;
  placement.anchorX = anchorX;
  placement.anchorY = anchorY;
  // This value is computed once per entry below and copied into every pooled
  // placement. Keeping the signed pixel offset a Smi avoids boxing a fresh
  // `anchor +/- offset` double on every placement write.
  placement.leaderOffset = signedLeaderOffset;
  if (corner === 'above' || corner === 'below') {
    placement.leadFromX = anchorX;
    placement.leadFromY = anchorY;
    // Strictly vertical, always — the shipped leader ran from the anchor's sx to
    // the card edge at the same sx with no clamp. Clamping the endpoint into the
    // card rect made the stub visibly diagonal whenever a viewport-edge clamp had
    // pushed the card sideways off its anchor, which reads as "the card isn't
    // attached to that camera".
    placement.leadToX = anchorX;
    placement.leadToY = corner === 'above' ? placement.rect.y + h : placement.rect.y;
  } else {
    placement.leadFromX = anchorX;
    placement.leadFromY = anchorY;
    placement.leadToX = corner === 'left' ? placement.rect.x + w : placement.rect.x;
    placement.leadToY = Math.max(placement.rect.y, Math.min(anchorY, placement.rect.y + h));
  }
  return placement;
}

const PLACEMENT_ORDERS = Object.freeze({
  above: Object.freeze(['above', 'below', 'right', 'left']),
  below: Object.freeze(['below', 'above', 'right', 'left']),
  right: Object.freeze(['right', 'above', 'below', 'left']),
  left: Object.freeze(['left', 'above', 'below', 'right']),
});

const VERTICAL_PLACEMENT_ORDERS = Object.freeze({
  above: Object.freeze(['above', 'below']),
  below: Object.freeze(['below', 'above']),
});

function clampPlacementCoordinate(value, size, viewportSize, margin = 4) {
  return Math.max(margin, Math.min(value, Math.max(margin, viewportSize - size - margin)));
}

/**
 * Build deterministic above/below/right/left placements, clamped to the live
 * viewport. The caller may reuse `out` and its placement objects every frame.
 * @param {object} input
 * @param {number} input.anchorX
 * @param {number} input.anchorY
 * @param {number} input.width
 * @param {number} input.height
 * @param {number} input.viewportWidth
 * @param {number} input.viewportHeight
 * @param {number} [input.gap]
 * @param {string} [input.preferred]
 * @param {number} [input.leaderOffset]
 * @param {boolean} [input.verticalOnly]
 * @param {number} [input.viewportMargin]
 * @param {Array<object>} [out]
 * @returns {Array<object>}
 */
export function placementVariants({
  anchorX,
  anchorY,
  width,
  height,
  viewportWidth,
  viewportHeight,
  gap = 12,
  preferred = 'auto',
  leaderOffset = 0,
  verticalOnly = false,
  viewportMargin = 4,
}, out = []) {
  const automatic = anchorY - gap - height >= 4 ? 'above' : 'below';
  const orders = verticalOnly ? VERTICAL_PLACEMENT_ORDERS : PLACEMENT_ORDERS;
  const order = orders[preferred] || orders[automatic];
  let positiveLeaderOffset = leaderOffset;
  let negativeLeaderOffset = leaderOffset;
  if (leaderOffset !== 0) {
    positiveLeaderOffset = Math.round(leaderOffset);
    negativeLeaderOffset = -positiveLeaderOffset;
  }
  for (let i = 0; i < order.length; i++) {
    const corner = order[i];
    let x = anchorX - width / 2;
    let y = anchorY - gap - height;
    if (corner === 'below') y = anchorY + gap;
    else if (corner === 'right') {
      x = anchorX + gap;
      y = anchorY - height / 2;
    } else if (corner === 'left') {
      x = anchorX - gap - width;
      y = anchorY - height / 2;
    }
    out[i] = writePlacement(
      out[i],
      corner,
      clampPlacementCoordinate(x, width, viewportWidth, viewportMargin),
      clampPlacementCoordinate(y, height, viewportHeight, viewportMargin),
      width,
      height,
      anchorX,
      anchorY,
      corner === 'above' || corner === 'left' ? negativeLeaderOffset : positiveLeaderOffset,
    );
  }
  out.length = order.length;
  return out;
}

function drawLeader(ctx, placement, accent) {
  ctx.strokeStyle = accent || WORLD_OVERLAY_STYLE.leader;
  // Leaders are screen-space strokes. Card content may be painted inside an
  // altitude/distance scale transform, so counter-scale the canvas width to
  // retain the shipped one-CSS-pixel leader at every card size.
  ctx.lineWidth = 1 / (placement.paintScale || 1);
  ctx.beginPath();
  if (placement.leaderOffset === 0) {
    ctx.moveTo(placement.leadFromX, placement.leadFromY);
  } else if (placement.corner === 'above' || placement.corner === 'below') {
    ctx.moveTo(placement.leadFromX, placement.leadFromY + placement.leaderOffset);
  } else {
    ctx.moveTo(placement.leadFromX + placement.leaderOffset, placement.leadFromY);
  }
  ctx.lineTo(placement.leadToX, placement.leadToY);
  ctx.stroke();
}

function drawCardChrome(ctx, entry, placement, selected = false) {
  const { x, y, w, h } = placement.rect;
  const accent = entry.accent || WORLD_OVERLAY_STYLE.accent;
  drawLeader(ctx, placement, accent);
  ctx.beginPath();
  roundedRectPath(ctx, x, y, w, h);
  ctx.fillStyle = selected ? WORLD_OVERLAY_STYLE.selectedBackground : WORLD_OVERLAY_STYLE.background;
  ctx.fill();
  ctx.strokeStyle = selected ? WORLD_OVERLAY_STYLE.selectedBorder : WORLD_OVERLAY_STYLE.border;
  ctx.lineWidth = selected ? 1.25 : 1;
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.fillRect(x, y + 3, selected ? 3 : 2, Math.max(1, h - 6));
}

function drawCardText(ctx, entry, placement, selected = false, topOffset = 0) {
  const details = Array.isArray(entry.details) ? entry.details : [];
  const x = placement.rect.x + (selected ? 12 : 9);
  let y = placement.rect.y + (selected ? 8 : 6) + topOffset;
  ctx.fillStyle = WORLD_OVERLAY_STYLE.title;
  ctx.font = selected ? WORLD_OVERLAY_STYLE.fontSelected : WORLD_OVERLAY_STYLE.fontTitle;
  ctx.textBaseline = 'top';
  ctx.fillText(String(entry.title || ''), x, y);
  y += selected ? 15 : 13;
  ctx.fillStyle = WORLD_OVERLAY_STYLE.detail;
  ctx.font = WORLD_OVERLAY_STYLE.fontDetail;
  for (let i = 0; i < details.length; i++) {
    ctx.fillText(String(details[i]), x, y);
    y += selected ? 15 : 13;
  }
}

function colorWithAlpha(color, alpha) {
  const text = String(color || WORLD_OVERLAY_STYLE.accent).trim();
  const triplet = text.match(/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/);
  if (triplet) return `rgba(${triplet[1]}, ${triplet[2]}, ${triplet[3]}, ${alpha})`;
  const hex = text.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
  }
  return text;
}

function tacticalAccentColors(entry) {
  const accent = entry.accent || WORLD_OVERLAY_STYLE.accent;
  let colors = entry._overlayTacticalAccentColors;
  if (!colors || colors.accent !== accent) {
    colors = {
      accent,
      leader: colorWithAlpha(accent, 0.65),
      border: colorWithAlpha(accent, 0.85),
      rule: colorWithAlpha(accent, 0.95),
    };
    entry._overlayTacticalAccentColors = colors;
  }
  return colors;
}

/** Paint the legacy FIRMS/vessel tactical card inside the shared host. */
export function paintTacticalCard(ctx, entry, placement, alpha = 1) {
  const selected = entry.selected || entry.variant === 'selected';
  const details = Array.isArray(entry.details) ? entry.details : [];
  const layout = entry._overlayLayout || {};
  const { x, y, w, h } = placement.rect;
  const accentColors = tacticalAccentColors(entry);
  ctx.save();
  ctx.globalAlpha = alpha;

  ctx.strokeStyle = accentColors.leader;
  ctx.lineWidth = 1 / (placement.paintScale || 1);
  ctx.beginPath();
  if (placement.leaderOffset === 0) {
    ctx.moveTo(placement.leadFromX, placement.leadFromY);
  } else if (placement.corner === 'above' || placement.corner === 'below') {
    ctx.moveTo(placement.leadFromX, placement.leadFromY + placement.leaderOffset);
  } else {
    ctx.moveTo(placement.leadFromX + placement.leaderOffset, placement.leadFromY);
  }
  ctx.lineTo(placement.leadToX, placement.leadToY);
  ctx.stroke();

  ctx.beginPath();
  roundedRectPath(ctx, x, y, w, h, 4);
  ctx.fillStyle = WORLD_OVERLAY_STYLE.background;
  ctx.fill();
  if (selected) {
    ctx.beginPath();
    roundedRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4);
    ctx.strokeStyle = accentColors.border;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.beginPath();
  roundedRectPath(ctx, x, y, w, 2, 1);
  ctx.fillStyle = accentColors.rule;
  ctx.fill();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = WORLD_OVERLAY_STYLE.title;
  ctx.font = selected ? WORLD_OVERLAY_STYLE.fontSelected : WORLD_OVERLAY_STYLE.fontTitle;
  const titleBaseline = y + layout.padY + layout.titleH - 2;
  ctx.fillText(String(entry.title || ''), x + layout.padX, titleBaseline);
  ctx.fillStyle = WORLD_OVERLAY_STYLE.detail;
  ctx.font = WORLD_OVERLAY_STYLE.fontDetail;
  for (let i = 0; i < details.length; i++) {
    ctx.fillText(String(details[i]), x + layout.padX, titleBaseline + (i + 1) * layout.lineH);
  }
  ctx.restore();
  return placement.rect;
}

/** Paint a compact ambient label. */
export function paintLabel(ctx, entry, placement, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  drawCardChrome(ctx, entry, placement, false);
  ctx.fillStyle = WORLD_OVERLAY_STYLE.title;
  ctx.font = WORLD_OVERLAY_STYLE.fontLabel;
  ctx.textBaseline = 'top';
  ctx.fillText(String(entry.title || ''), placement.rect.x + 6, placement.rect.y + 4);
  ctx.restore();
  return placement.rect;
}

/** Paint a compact track label with optional inline detail. */
export function paintTrack(ctx, entry, placement, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  drawCardChrome(ctx, entry, placement, false);
  ctx.fillStyle = WORLD_OVERLAY_STYLE.title;
  ctx.font = WORLD_OVERLAY_STYLE.fontTrack;
  ctx.textBaseline = 'top';
  ctx.fillText(
    trackDisplayText(entry),
    placement.rect.x + 6,
    placement.rect.y + 4,
  );
  ctx.restore();
  return placement.rect;
}

/** Paint a standard detail card. */
export function paintCard(ctx, entry, placement, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  drawCardChrome(ctx, entry, placement, false);
  drawCardText(ctx, entry, placement, false);
  ctx.restore();
  return placement.rect;
}

/** Paint a thumbnail card. The image slot remains source-owned. */
export function paintThumbnail(ctx, entry, placement, alpha = 1) {
  const layout = entry._overlayLayout || {};
  const { x, y, w, h } = placement.rect;
  const padX = Number.isFinite(layout.padX) ? layout.padX : 4;
  const padY = Number.isFinite(layout.padY) ? layout.padY : 4;
  const thumbW = layout.thumbW || Number(entry.thumbnailWidth) || 96;
  const thumbH = layout.thumbH || Number(entry.thumbnailHeight) || 54;
  const titleH = Number.isFinite(layout.titleH) ? layout.titleH : 13;
  const image = entry.image?.frame ?? entry.image;
  ctx.save();
  ctx.globalAlpha = alpha;

  drawLeader(ctx, placement, entry.thumbnailLeaderColor || WORLD_OVERLAY_STYLE.leader);
  ctx.beginPath();
  roundedRectPath(ctx, x, y, w, h, Number(entry.thumbnailRadius) || 4);
  ctx.fillStyle = entry.thumbnailBackground || WORLD_OVERLAY_STYLE.background;
  ctx.fill();

  const imageX = x + padX;
  const imageY = y + padY;
  if (image && typeof ctx.drawImage === 'function') {
    try {
      ctx.drawImage(image, imageX, imageY, thumbW, thumbH);
    } catch {
      // A source may replace/close a live image slot between frames. Chrome
      // and text remain valid; the next source update supplies the next frame.
    }
  }

  const ruleHeight = Math.max(0, Number(entry.thumbnailRuleHeight) || 0);
  if (ruleHeight > 0) {
    ctx.beginPath();
    roundedRectPath(ctx, x, y, w, ruleHeight, Math.min(1, ruleHeight));
    ctx.fillStyle = entry.thumbnailRuleColor || entry.accent || WORLD_OVERLAY_STYLE.accent;
    ctx.fill();
  }

  const titleChars = Math.max(0, Math.floor(Number(entry.thumbnailTitleChars) || 0));
  const title = entry._overlayThumbnailTitle
    || String(entry.title || '').toUpperCase();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = entry.thumbnailTitleColor || WORLD_OVERLAY_STYLE.title;
  ctx.font = entry.thumbnailTitleFont || WORLD_OVERLAY_STYLE.fontTitle;
  ctx.fillText(
    titleChars > 0 ? title.slice(0, titleChars) : title,
    imageX,
    imageY + thumbH + titleH - 3,
  );
  ctx.restore();
  return placement.rect;
}

/** Paint the protected selected-card treatment. */
export function paintSelected(ctx, entry, placement, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  drawCardChrome(ctx, entry, placement, true);
  drawCardText(ctx, entry, placement, true);
  ctx.restore();
  return placement.rect;
}

/** Paint the centered protected tracked-target readout treatment. */
export function paintTracked(ctx, entry, placement, alpha = 1) {
  const details = Array.isArray(entry.details) ? entry.details : [];
  const layout = entry._overlayLayout || {};
  const { x, y, w, h } = placement.rect;
  const accent = entry.accent || WORLD_OVERLAY_STYLE.accent;
  ctx.save();
  ctx.globalAlpha = alpha;
  drawLeader(ctx, placement, accent);
  ctx.beginPath();
  roundedRectPath(ctx, x, y, w, h, 5);
  ctx.fillStyle = WORLD_OVERLAY_STYLE.background;
  ctx.fill();
  ctx.beginPath();
  roundedRectPath(ctx, x, y, w, 2, 1);
  ctx.fillStyle = accent;
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const centerX = x + w / 2;
  const titleBaseline = y + layout.padY + layout.titleH - 2;
  ctx.fillStyle = WORLD_OVERLAY_STYLE.title;
  ctx.font = WORLD_OVERLAY_STYLE.fontTrackedTitle;
  ctx.fillText(String(entry.title || ''), centerX, titleBaseline);
  ctx.fillStyle = WORLD_OVERLAY_STYLE.detail;
  ctx.font = WORLD_OVERLAY_STYLE.fontTrackedDetail;
  for (let i = 0; i < details.length; i++) {
    ctx.fillText(String(details[i]), centerX, titleBaseline + (i + 1) * layout.lineH);
  }
  ctx.restore();
  return placement.rect;
}

/**
 * Paint one ambient detection callout: backing plate, tier accent bar, leader
 * stub, bright primary text and a dimmer micro-field.
 *
 * This is the LEGIBILITY-CRITICAL painter. It runs on the shared normal-blend
 * canvas rather than the screen-blended sensor surface, because `screen` can
 * only lighten: a dark plate composited with `screen` over sunlit imagery
 * resolves to the imagery itself (measured: rgba(2,18,26,0.66) over rgb(230)
 * yields rgb(230,231,232)), which is why ambient callsigns used to dissolve
 * into bright ground while the tracked card — always painted on this same
 * normal-blend canvas — stayed readable in every style.
 *
 * Allocation-free by contract: no Path2D, array, or string is constructed here.
 * It is called once per visible callout per frame.
 *
 * @param {CanvasRenderingContext2D} ctx Shared normal-blend canvas context.
 * @param {object} callout Placement + text, supplied by the detection lane.
 * @param {number} callout.x Plate left edge, CSS px.
 * @param {number} callout.y Plate top edge, CSS px.
 * @param {number} callout.w Plate width, CSS px.
 * @param {number} callout.h Plate height, CSS px.
 * @param {number} callout.primaryX Baseline-relative x of the primary text.
 * @param {number} callout.microX Baseline-relative x of the micro text.
 * @param {number} callout.baseline Text baseline, CSS px.
 * @param {number} callout.leadFromX Leader start x.
 * @param {number} callout.leadFromY Leader start y.
 * @param {number} callout.leadToX Leader end x.
 * @param {number} callout.leadToY Leader end y.
 * @param {string} callout.plate Backing plate fill.
 * @param {number} [callout.plateScale=1] Backdrop feather: 1 over ground, down
 *   to `SKY_PLATE_SCALE` against sky. Multiplies the PLATE only — the accent
 *   bar, leader and text keep the composed fades, so a feathered callout loses
 *   its box without losing its identity.
 * @param {string} callout.accent Tier colour for the accent bar and leader.
 * @param {string} callout.label Primary text fill.
 * @param {string} callout.primary Primary text.
 * @param {string} callout.micro Micro-field text ('' when absent).
 * @param {string} callout.font Primary font.
 * @param {string} callout.microFont Micro-field font.
 * @param {number} alpha Composed opacity; already folded through every fade.
 */
export function paintDetectionCallout(ctx, callout, alpha = 1) {
  // Scaling globalAlpha rather than rewriting the fill string keeps every
  // theme's own plate hue and weight, and keeps this painter allocation-free.
  ctx.globalAlpha = alpha * (callout.plateScale ?? 1);
  ctx.beginPath();
  roundedRectPath(ctx, callout.x, callout.y, callout.w, callout.h, 3);
  ctx.fillStyle = callout.plate;
  ctx.fill();

  ctx.globalAlpha = alpha;
  ctx.beginPath();
  roundedRectPath(ctx, callout.x, callout.y + 2, 2, callout.h - 4, 1);
  ctx.fillStyle = callout.accent;
  ctx.fill();

  ctx.globalAlpha = alpha * 0.6;
  ctx.strokeStyle = callout.accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(callout.leadFromX, callout.leadFromY);
  ctx.lineTo(callout.leadToX, callout.leadToY);
  ctx.stroke();

  ctx.globalAlpha = alpha;
  ctx.fillStyle = callout.label;
  ctx.font = callout.font;
  if (callout.primary) ctx.fillText(callout.primary, callout.primaryX, callout.baseline);
  if (callout.micro) {
    ctx.globalAlpha = alpha * 0.8;
    ctx.font = callout.microFont;
    ctx.fillText(callout.micro, callout.microX, callout.baseline);
  }
}

/** Dispatch a normalized entry to its pure variant painter. */
export function paintOverlayEntry(ctx, entry, placement, alpha = 1) {
  if (entry.cardStyle === 'tactical') return paintTacticalCard(ctx, entry, placement, alpha);
  if (entry.variant === 'tracked') return paintTracked(ctx, entry, placement, alpha);
  if (entry.selected || entry.variant === 'selected') return paintSelected(ctx, entry, placement, alpha);
  if (entry.variant === 'thumbnail') return paintThumbnail(ctx, entry, placement, alpha);
  if (entry.variant === 'card') return paintCard(ctx, entry, placement, alpha);
  if (entry.variant === 'track') return paintTrack(ctx, entry, placement, alpha);
  return paintLabel(ctx, entry, placement, alpha);
}
