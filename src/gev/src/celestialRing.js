import * as Cesium from 'cesium';
import { governorRequestRender } from './renderGovernor.js';

/** Outer edge of the existing NVG/FLIR keyhole in normalized shader space. */
export const KEYHOLE_OUTER_RADIUS = 1.05;
/** Clearance required before entering the visible state. */
export const GLOBE_ENTER_CLEARANCE_PX = 24;
/** Clearance below which the overlay leaves the visible state. */
export const GLOBE_EXIT_CLEARANCE_PX = 12;
/** Minimum stable length of a celestial direction projected into the camera plane. */
export const CELESTIAL_PLANE_EPSILON = 0.045;
/** Responsive radial fade band used by every keyhole-aligned text overlay —
 * this is the Detection FADE (label/card fading), NOT the scope-mask feather
 * in scopeMask.js. 0.07 since the 2026-08-24 final value (was 0.16). */
export const KEYHOLE_LABEL_FEATHER_RATIO = 0.07;
export const KEYHOLE_LABEL_FEATHER_MAX_RATIO = 0.4;
/**
 * First-run OUTSIDE opacity for keyhole-aligned world overlays.
 *
 * 0.01 since 2026-08-24 (final value; 0.03 on 08-23, 0.05 before). Keep in lockstep with
 * `#detection-opacity-slider`'s markup value AND readout in index.html,
 * `_detectionOutsideOpacityPct` in sharelink.js,
 * `GLOBAL_POST_DEFAULTS.detectionOutsideOpacityPct` in ui.js, and
 * `AIRCRAFT_BRACKET_FLOOR_ANCHOR` in detectionPolicy.js — a fresh boot applies
 * no restore, so those literals ARE the first-run state. NOT the `ko` PARSE
 * fallback, which stays at 5 on purpose: a link predating that field was
 * authored when 5 was what its author saw. Pinned in reasonableDefaults.test.mjs.
 */
export const KEYHOLE_OUTSIDE_OPACITY_DEFAULT = 0.01;

const RING_INSET_PX = 11;
const MARKER_INSET_PX = 36;
const COLLIDING_MARKER_EXTRA_INSET_PX = 32;
const MARKER_COLLISION_ANGLE = Cesium.Math.toRadians(6);
const FULL_GLOBE_RADIUS_RATIO = 0.61;
const TAU = Math.PI * 2;
// This overlay is a secondary HUD treatment. Keep it smooth while reserving
// the majority of the frame budget for Cesium's terrain and 3D tiles.
export const CELESTIAL_MAX_FRAME_RATE = 30;
// There are two independently rotating effect canvases (sun and moon), so
// this is a per-layer budget; their combined allocation remains comparable to
// the former single 4 MP canvas.
export const CELESTIAL_MAX_BACKING_PIXELS = 2_000_000;
export const CELESTIAL_MAX_BACKING_DIMENSION = 1_600;
const CELESTIAL_MAX_DEVICE_PIXEL_RATIO = 1.25;

let keyholeFadeRatio = KEYHOLE_LABEL_FEATHER_RATIO;
let keyholeOutsideOpacity = KEYHOLE_OUTSIDE_OPACITY_DEFAULT;

/** Clamp a number to an inclusive range. */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Update the shared fade distance and outside-opacity floor. */
export function setKeyholeFadeTuning({ fadeRatio, outsideOpacity } = {}) {
  if (Number.isFinite(fadeRatio)) {
    keyholeFadeRatio = clamp(fadeRatio, 0, KEYHOLE_LABEL_FEATHER_MAX_RATIO);
  }
  if (Number.isFinite(outsideOpacity)) {
    keyholeOutsideOpacity = clamp(outsideOpacity, 0, 1);
  }
  return getKeyholeFadeTuning();
}

/** Read the current normalized keyhole fade settings. */
export function getKeyholeFadeTuning() {
  return { fadeRatio: keyholeFadeRatio, outsideOpacity: keyholeOutsideOpacity };
}

/** Return the single shared screen-space keyhole circle and label feather. */
export function getKeyholeGeometry(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) {
    return { centerX: 0, centerY: 0, radius: 0, featherPx: 0 };
  }
  const radius = h * 0.5 * KEYHOLE_OUTER_RADIUS;
  return {
    centerX: w * 0.5,
    centerY: h * 0.5,
    radius,
    featherPx: radius * keyholeFadeRatio,
  };
}

/**
 * Compute the radial opacity for a callout's visual center. Text remains fully
 * opaque inside the keyhole and fades linearly to the configured outside-opacity
 * floor through a band derived from the live keyhole radius.
 */
export function keyholeLabelAlpha(labelX, labelY, width, height) {
  return keyholeLabelAlphaFromGeometry(labelX, labelY, getKeyholeGeometry(width, height));
}

/** Compute keyhole opacity from geometry already cached by a hot render loop. */
export function keyholeLabelAlphaFromGeometry(labelX, labelY, geometry) {
  if (!geometry || !(geometry.radius > 0) || !Number.isFinite(labelX) || !Number.isFinite(labelY)) return 0;
  const feather = geometry.featherPx;
  const distance = Math.hypot(labelX - geometry.centerX, labelY - geometry.centerY);
  if (distance <= geometry.radius) return 1;
  if (!(feather > 0) || distance >= geometry.radius + feather) return keyholeOutsideOpacity;
  const progress = clamp((distance - geometry.radius) / feather, 0, 1);
  return 1 - (1 - keyholeOutsideOpacity) * progress;
}

/** Normalize an angle to [0, 2π). */
export function normalizeAngle(angle) {
  const wrapped = angle % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

/** Return the shortest unsigned distance between two circular angles. */
export function circularAngleDistance(a, b) {
  const delta = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(delta, TAU - delta);
}

/** The optical celestial treatment is intentionally limited to Normal view. */
export function isCelestialRingStyleSupported(styleName) {
  return styleName === 'normal';
}

/**
 * Resolve a screen-space direction angle. Canvas Y grows downward, so camera-up
 * is inverted. When the celestial vector points almost directly into/out of the
 * camera, retain the prior stable bearing and fade the marker.
 *
 * @param {number} rightComponent - Dot(direction, camera.rightWC).
 * @param {number} upComponent - Dot(direction, camera.upWC).
 * @param {number} lastAngle - Previous stable angle in radians.
 * @returns {{angle:number, opacity:number, stable:boolean}}
 */
export function celestialScreenAngle(rightComponent, upComponent, lastAngle = 0) {
  const planeLength = Math.hypot(rightComponent, upComponent);
  if (!Number.isFinite(planeLength) || planeLength < CELESTIAL_PLANE_EPSILON) {
    return {
      angle: normalizeAngle(Number.isFinite(lastAngle) ? lastAngle : 0),
      opacity: clamp(planeLength / CELESTIAL_PLANE_EPSILON, 0, 1),
      stable: false,
    };
  }
  return {
    angle: normalizeAngle(Math.atan2(-upComponent, rightComponent)),
    opacity: clamp((planeLength - CELESTIAL_PLANE_EPSILON) / 0.16, 0.28, 1),
    stable: true,
  };
}

/**
 * Test whether a projected Earth disc is completely inside the shared keyhole.
 * The different enter/exit clearances provide hysteresis while zooming.
 *
 * @param {object} geometry
 * @param {number} geometry.earthCenterX
 * @param {number} geometry.earthCenterY
 * @param {number} geometry.earthRadius
 * @param {number} geometry.keyholeCenterX
 * @param {number} geometry.keyholeCenterY
 * @param {number} geometry.keyholeRadius
 * @param {boolean} wasVisible
 * @returns {boolean}
 */
export function isFullGlobeInsideKeyhole(geometry, wasVisible = false) {
  const {
    earthCenterX,
    earthCenterY,
    earthRadius,
    keyholeCenterX,
    keyholeCenterY,
    keyholeRadius,
  } = geometry || {};
  const values = [earthCenterX, earthCenterY, earthRadius, keyholeCenterX, keyholeCenterY, keyholeRadius];
  if (!values.every(Number.isFinite) || earthRadius <= 0 || keyholeRadius <= 0) return false;
  const offset = Math.hypot(earthCenterX - keyholeCenterX, earthCenterY - keyholeCenterY);
  const clearance = keyholeRadius - (offset + earthRadius);
  return clearance >= (wasVisible ? GLOBE_EXIT_CLEARANCE_PX : GLOBE_ENTER_CLEARANCE_PX);
}

/** Return the Earth-disc radius in CSS pixels for a perspective camera. */
export function earthDiscScreenRadius(cameraDistance, viewportHeight, fovy) {
  const earthRadiusM = Cesium.Ellipsoid.WGS84.maximumRadius;
  if (
    !Number.isFinite(cameraDistance)
    || cameraDistance <= earthRadiusM
    || !(viewportHeight > 0)
    || !Number.isFinite(fovy)
    || fovy <= 0
    || fovy >= Math.PI
  ) return null;
  const angularRadius = Math.asin(clamp(earthRadiusM / cameraDistance, 0, 1));
  const radius = (viewportHeight * 0.5) * Math.tan(angularRadius) / Math.tan(fovy * 0.5);
  return Number.isFinite(radius) && radius > 0 ? radius : null;
}

/**
 * Project the visible Earth disc into viewport coordinates.
 * Shared by full-globe UI treatments that must agree on visual containment.
 *
 * @param {object} viewer - Cesium Viewer-like object.
 * @param {number} width - Viewport width in CSS pixels.
 * @param {number} height - Viewport height in CSS pixels.
 * @param {object} [scratchCenter] - Reusable Cesium Cartesian2 result.
 * @param {object} [scratchToCenter] - Reusable Cesium Cartesian3 result.
 * @returns {object|null}
 */
export function projectEarthDiscToViewport(
  viewer,
  width,
  height,
  scratchCenter = undefined,
  scratchToCenter = undefined,
) {
  const camera = viewer?.camera;
  const scene = viewer?.scene;
  if (!camera || !scene || !(width > 0) || !(height > 0)) return null;

  const distance = Cesium.Cartesian3.magnitude(camera.positionWC);
  if (!Number.isFinite(distance) || distance <= Cesium.Ellipsoid.WGS84.maximumRadius) return null;

  const toCenter = Cesium.Cartesian3.negate(
    camera.positionWC,
    scratchToCenter || new Cesium.Cartesian3(),
  );
  if (Cesium.Cartesian3.dot(camera.directionWC, toCenter) <= 0) return null;

  const center = Cesium.SceneTransforms.worldToWindowCoordinates(
    scene,
    Cesium.Cartesian3.ZERO,
    scratchCenter,
  );
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) return null;

  const earthRadius = earthDiscScreenRadius(distance, height, camera.frustum?.fovy);
  if (!earthRadius) return null;

  const keyhole = getKeyholeGeometry(width, height);
  return {
    earthCenterX: center.x,
    earthCenterY: center.y,
    earthRadius,
    keyholeCenterX: keyhole.centerX,
    keyholeCenterY: keyhole.centerY,
    keyholeRadius: keyhole.radius,
  };
}

/** Draw one tapered orbital arc around a celestial marker. */
function drawTaperedArc(ctx, cx, cy, radius, angle, rgb, strength) {
  const span = 0.82;
  const segments = 18;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.shadowColor = `rgba(${rgb}, ${0.5 * strength})`;
  ctx.shadowBlur = 9;
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const a0 = angle - span + span * 2 * t0;
    const a1 = angle - span + span * 2 * t1;
    const envelope = Math.sin(Math.PI * ((t0 + t1) * 0.5));
    ctx.strokeStyle = `rgba(${rgb}, ${strength * envelope * envelope})`;
    ctx.lineWidth = 0.7 + envelope * 1.25;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, a0, a1);
    ctx.stroke();
  }
  ctx.restore();
}

/** Draw the soft directional rays cast inward from the sun marker. */
function drawSunRays(ctx, cx, cy, radius, innerRadius, angle) {
  const sx = cx + Math.cos(angle) * radius;
  const sy = cy + Math.sin(angle) * radius;
  ctx.save();
  // The reference keeps the globe untouched: all illumination lives in the
  // annulus between the Earth limb and the outer optics ring.
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 3, 0, TAU);
  ctx.arc(cx, cy, innerRadius, 0, TAU, true);
  ctx.clip('evenodd');
  ctx.globalCompositeOperation = 'screen';
  const glow = ctx.createRadialGradient(sx, sy, 4, sx, sy, radius * 0.94);
  glow.addColorStop(0, 'rgba(255, 222, 126, 0.17)');
  glow.addColorStop(0.22, 'rgba(255, 229, 157, 0.085)');
  glow.addColorStop(0.58, 'rgba(255, 235, 188, 0.027)');
  glow.addColorStop(1, 'rgba(255, 242, 214, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - radius - 4, cy - radius - 4, (radius + 4) * 2, (radius + 4) * 2);

  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(255, 232, 171, 0.11)';
  ctx.shadowBlur = 18;
  const annulusWidth = Math.max(1, radius - innerRadius);
  for (let i = -2; i <= 2; i++) {
    const spread = i * 0.043;
    const rayAngle = angle + Math.PI + spread;
    const rayLength = annulusWidth * (0.7 + (2 - Math.abs(i)) * 0.07);
    const ex = sx + Math.cos(rayAngle) * rayLength;
    const ey = sy + Math.sin(rayAngle) * rayLength;
    const lineGradient = ctx.createLinearGradient(sx, sy, ex, ey);
    lineGradient.addColorStop(0, `rgba(255, 230, 166, ${0.075 - Math.abs(i) * 0.011})`);
    lineGradient.addColorStop(1, 'rgba(255, 226, 156, 0)');
    ctx.strokeStyle = lineGradient;
    ctx.lineWidth = i === 0 ? 1.8 : 0.9;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
  ctx.restore();
}

/** Draw a restrained cool haze around the moon sector. */
function drawMoonHaze(ctx, cx, cy, radius, angle) {
  const mx = cx + Math.cos(angle) * radius;
  const my = cy + Math.sin(angle) * radius;
  const haze = ctx.createRadialGradient(mx, my, 0, mx, my, radius * 0.22);
  haze.addColorStop(0, 'rgba(63, 214, 255, 0.16)');
  haze.addColorStop(0.42, 'rgba(63, 214, 255, 0.055)');
  haze.addColorStop(1, 'rgba(63, 214, 255, 0)');
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = haze;
  ctx.beginPath();
  ctx.arc(mx, my, radius * 0.22, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/**
 * Screen-space ring and celestial direction overlay for the full-globe view.
 */
export class CelestialRing {
  /**
   * @param {Cesium.Viewer} viewer
   * @param {{enabled?:boolean,onAutoDisable?:Function}} [options]
   */
  constructor(viewer, { enabled = true, onAutoDisable = null } = {}) {
    this.viewer = viewer;
    this.enabled = !!enabled;
    this.visible = false;
    this._onAutoDisable = typeof onAutoDisable === 'function' ? onAutoDisable : null;
    this._focusInProgress = false;
    this._ephemerisDirty = true;
    this._ephemerisUpdateCount = 0;
    this._sunAngle = 0;
    this._moonAngle = Math.PI;
    this._sunOpacity = 1;
    this._moonOpacity = 1;
    this._debug = null;
    this._nextDrawAt = 0;
    this._renderScale = 1;
    this._sunRenderKey = '';
    this._moonRenderKey = '';
    this._outlineRenderKey = '';

    this._sunInertial = new Cesium.Cartesian3();
    this._moonInertial = new Cesium.Cartesian3();
    this._sunFixed = new Cesium.Cartesian3();
    this._moonFixed = new Cesium.Cartesian3();
    this._toCenter = new Cesium.Cartesian3();
    this._screenCenter = new Cesium.Cartesian2();
    this._fixedMatrix = new Cesium.Matrix3();

    this._buildDOM();
    this._removePostRender = viewer.scene.postRender.addEventListener(() => this._draw());
    // Pre-existing staleness fix (perf wave 2 review): the ephemeris was
    // sampled once per visible-enable from the FROZEN app clock, so the
    // sun/moon markers aged with the app. Resample real wall time each
    // minute and request the one frame that repaints the ring.
    this._ephemerisTimer = setInterval(() => {
      if (!this.enabled) return;
      // Always mark dirty so a long-hidden interval can't serve stale
      // sun/moon vectors on return — but only request the repaint frame
      // while visible; the visibility-restore request (main.js) picks the
      // dirty flag up immediately. (review review finding)
      this._ephemerisDirty = true;
      if (typeof document !== 'undefined' && document.hidden) return;
      governorRequestRender('celestial-ephemeris');
    }, 60_000);
    this.setEnabled(this.enabled);
  }

  /** Construct cached effect layers and Material Symbols celestial markers. */
  _buildDOM() {
    this._root = document.createElement('div');
    this._root.id = 'celestial-ring-overlay';
    this._root.className = 'celestial-ring-overlay';
    this._root.setAttribute('aria-hidden', 'true');

    this._ringOutline = document.createElement('div');
    this._ringOutline.className = 'celestial-ring-outline';

    this._sunCanvas = document.createElement('canvas');
    this._sunCanvas.className = 'celestial-ring-canvas celestial-sun-canvas';
    this._sunCtx = this._sunCanvas.getContext('2d', { alpha: true, desynchronized: true });

    this._moonCanvas = document.createElement('canvas');
    this._moonCanvas.className = 'celestial-ring-canvas celestial-moon-canvas';
    this._moonCtx = this._moonCanvas.getContext('2d', { alpha: true, desynchronized: true });

    this._sunMarker = document.createElement('span');
    this._sunMarker.className = 'celestial-marker celestial-sun material-symbols-outlined';
    this._sunMarker.textContent = 'light_mode';

    this._moonMarker = document.createElement('span');
    this._moonMarker.className = 'celestial-marker celestial-moon material-symbols-outlined';
    this._moonMarker.textContent = 'dark_mode';

    this._root.append(
      this._ringOutline,
      this._sunCanvas,
      this._moonCanvas,
      this._sunMarker,
      this._moonMarker
    );
    this.viewer.container.appendChild(this._root);
  }

  /** Enable or disable the user preference for the effect. */
  setEnabled(enabled) {
    const wasEnabled = this.enabled;
    this.enabled = !!enabled;
    if (this.enabled && !wasEnabled) this._ephemerisDirty = true;
    // The ring paints its canvases from postRender, which only fires on
    // rendered frames — under the idle render governor an enable (or the
    // clearing disable) must request its frame or the ring never draws at
    // all. Camera motion covers every later repaint; the 60 s ephemeris
    // timer requests its own. (perf wave 2 fix — field test finding)
    if (this.enabled !== wasEnabled) governorRequestRender('celestial-ring');
    this._root.classList.toggle('disabled', !this.enabled);
    if (!this.enabled) {
      this.visible = false;
      this._root.classList.remove('visible');
      this._clear();
    }
  }

  /** Whether the current camera already frames the complete globe inside the keyhole. */
  isGlobeFullyVisible() {
    const canvas = this.viewer.scene.canvas;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    if (!(width > 0 && height > 0)) return false;
    const disc = this._projectedEarthDisc(width, height);
    return !!disc && isFullGlobeInsideKeyhole(disc, false);
  }

  /**
   * Fly outward to the full-globe composition used by the celestial ring while
   * preserving the hemisphere currently beneath the camera.
   * @param {{duration?:number}} [options]
   * @returns {boolean} Whether a valid camera flight was started.
   */
  focusFullGlobe({ duration = 2.4 } = {}) {
    const canvas = this.viewer.scene.canvas;
    const height = canvas.clientHeight || canvas.height;
    const cartographic = this.viewer.camera.positionCartographic;
    const fovy = this.viewer.camera.frustum?.fovy;
    if (!(height > 0) || !cartographic || !Number.isFinite(fovy) || fovy <= 0 || fovy >= Math.PI) {
      return false;
    }

    const earthRadius = Cesium.Ellipsoid.WGS84.maximumRadius;
    const keyholeRadius = getKeyholeGeometry(canvas.clientWidth || canvas.width, height).radius;
    const targetScreenRadius = keyholeRadius * FULL_GLOBE_RADIUS_RATIO;
    const angularRadius = Math.atan(
      (targetScreenRadius / (height * 0.5)) * Math.tan(fovy * 0.5)
    );
    const distance = earthRadius / Math.max(Math.sin(angularRadius), 1e-4);
    const altitude = Math.max(earthRadius * 1.55, distance - earthRadius);

    this._focusInProgress = true;
    const finishFocus = () => {
      this._focusInProgress = false;
      this.viewer.scene.requestRender?.();
    };
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(
        cartographic.longitude,
        cartographic.latitude,
        altitude
      ),
      orientation: {
        heading: this.viewer.camera.heading,
        pitch: -Cesium.Math.PI_OVER_TWO,
        roll: 0,
      },
      duration,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: finishFocus,
      cancel: () => {
        finishFocus();
        if (!this.isGlobeFullyVisible()) this._autoDisable();
      },
    });
    return true;
  }

  /** Clear the backing canvas. */
  _clear() {
    for (const [canvas, ctx] of [[this._sunCanvas, this._sunCtx], [this._moonCanvas, this._moonCtx]]) {
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    this._ringOutline?.style.setProperty('display', 'none');
    this._sunRenderKey = '';
    this._moonRenderKey = '';
    this._outlineRenderKey = '';
  }

  /** Resize the canvas backing store while drawing in CSS pixels. */
  _resize(width, height) {
    const nativeDpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelsScale = Math.sqrt(CELESTIAL_MAX_BACKING_PIXELS / (width * height));
    const dimensionScale = CELESTIAL_MAX_BACKING_DIMENSION / Math.max(width, height);
    const dpr = Math.min(nativeDpr, CELESTIAL_MAX_DEVICE_PIXEL_RATIO, pixelsScale, dimensionScale);
    const bw = Math.max(1, Math.round(width * dpr));
    const bh = Math.max(1, Math.round(height * dpr));
    for (const [canvas, ctx] of [[this._sunCanvas, this._sunCtx], [this._moonCanvas, this._moonCtx]]) {
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this._renderScale = dpr;
  }

  /**
   * Sample Earth-fixed directions once per enable. Camera movement only
   * re-projects these cached vectors; it never re-runs the planetary model.
   */
  _updateEphemeris(time) {
    if (!this._ephemerisDirty) return true;

    Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time, this._sunInertial);
    Cesium.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(time, this._moonInertial);
    const matrix = Cesium.Transforms.computeIcrfToFixedMatrix(time, this._fixedMatrix)
      || Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, this._fixedMatrix);
    if (!matrix) return false;

    Cesium.Matrix3.multiplyByVector(matrix, this._sunInertial, this._sunFixed);
    Cesium.Matrix3.multiplyByVector(matrix, this._moonInertial, this._moonFixed);
    Cesium.Cartesian3.normalize(this._sunFixed, this._sunFixed);
    Cesium.Cartesian3.normalize(this._moonFixed, this._moonFixed);
    this._ephemerisDirty = false;
    this._ephemerisUpdateCount += 1;
    return true;
  }

  /** Disable after the camera leaves the complete-globe composition. */
  _autoDisable() {
    if (!this.enabled) return;
    this.setEnabled(false);
    this._onAutoDisable?.();
  }

  /** Return the projected Earth disc used for the full-globe gate. */
  _projectedEarthDisc(width, height) {
    return projectEarthDiscToViewport(
      this.viewer,
      width,
      height,
      this._screenCenter,
      this._toCenter,
    );
  }

  /** Position one icon-library marker along the keyhole circumference. */
  _positionMarker(marker, cx, cy, radius, angle, opacity) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const margin = 14;
    const maxRadiusX = Math.abs(cos) > 1e-4 ? (cx - margin) / Math.abs(cos) : Number.POSITIVE_INFINITY;
    const maxRadiusY = Math.abs(sin) > 1e-4 ? (cy - margin) / Math.abs(sin) : Number.POSITIVE_INFINITY;
    const markerRadius = Math.min(radius, maxRadiusX, maxRadiusY);
    marker.style.left = `${cx + cos * markerRadius}px`;
    marker.style.top = `${cy + sin * markerRadius}px`;
    marker.style.opacity = String(opacity);
  }

  /** Update the cached effect geometry only when camera distance or viewport changes. */
  _renderEffectLayers(cx, cy, radius, rayInnerRadius) {
    const outlineKey = `${cx}:${cy}:${radius}`;
    if (outlineKey !== this._outlineRenderKey) {
      this._ringOutline.style.display = '';
      this._ringOutline.style.left = `${cx - radius}px`;
      this._ringOutline.style.top = `${cy - radius}px`;
      this._ringOutline.style.width = `${radius * 2}px`;
      this._ringOutline.style.height = `${radius * 2}px`;
      this._outlineRenderKey = outlineKey;
    }

    const sunKey = `${outlineKey}:${Math.round(rayInnerRadius)}`;
    if (sunKey !== this._sunRenderKey) {
      this._sunCtx.clearRect(0, 0, this._sunCanvas.width, this._sunCanvas.height);
      drawSunRays(this._sunCtx, cx, cy, radius, rayInnerRadius, 0);
      drawTaperedArc(this._sunCtx, cx, cy, radius, 0, '222, 190, 89', 0.56);
      this._sunRenderKey = sunKey;
    }

    if (outlineKey !== this._moonRenderKey) {
      this._moonCtx.clearRect(0, 0, this._moonCanvas.width, this._moonCanvas.height);
      drawMoonHaze(this._moonCtx, cx, cy, radius, 0);
      drawTaperedArc(this._moonCtx, cx, cy, radius, 0, '48, 201, 229', 0.42);
      this._moonRenderKey = outlineKey;
    }
  }

  /** Per-frame camera projection with GPU-composited cached effect layers. */
  _draw() {
    if (!this.enabled || !this._sunCtx || !this._moonCtx) return;
    const now = performance.now();
    if (now < this._nextDrawAt) return;
    this._nextDrawAt = now + 1000 / CELESTIAL_MAX_FRAME_RATE;
    const canvas = this.viewer.scene.canvas;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    if (!(width > 0 && height > 0)) return;
    this._resize(width, height);

    const disc = this._projectedEarthDisc(width, height);
    const wasVisible = this.visible;
    const nextVisible = disc ? isFullGlobeInsideKeyhole(disc, wasVisible) : false;
    this.visible = nextVisible;
    this._root.classList.toggle('visible', nextVisible);
    this._root.dataset.globeVisible = String(nextVisible);
    this._root.dataset.ephemerisUpdates = String(this._ephemerisUpdateCount);
    if (!nextVisible || !disc) {
      this._clear();
      this._debug = { enabled: true, visible: false, disc };
      if (!this._focusInProgress) this._autoDisable();
      return;
    }

    if (!wasVisible) this._ephemerisDirty = true;

    const time = Cesium.JulianDate.now();
    if (!this._updateEphemeris(time)) return;
    this._root.dataset.ephemerisUpdates = String(this._ephemerisUpdateCount);
    const camera = this.viewer.camera;
    const sunProjection = celestialScreenAngle(
      Cesium.Cartesian3.dot(this._sunFixed, camera.rightWC),
      Cesium.Cartesian3.dot(this._sunFixed, camera.upWC),
      this._sunAngle
    );
    const moonProjection = celestialScreenAngle(
      Cesium.Cartesian3.dot(this._moonFixed, camera.rightWC),
      Cesium.Cartesian3.dot(this._moonFixed, camera.upWC),
      this._moonAngle
    );
    if (sunProjection.stable) this._sunAngle = sunProjection.angle;
    if (moonProjection.stable) this._moonAngle = moonProjection.angle;
    this._sunOpacity = sunProjection.opacity;
    this._moonOpacity = moonProjection.opacity;

    const cx = width * 0.5;
    const cy = height * 0.5;
    const radius = disc.keyholeRadius - RING_INSET_PX;
    const rayInnerRadius = Math.min(radius - 12, disc.earthRadius + Math.max(38, radius * 0.065));
    this._renderEffectLayers(cx, cy, radius, rayInnerRadius);
    this._sunCanvas.style.transform = `rotate(${this._sunAngle}rad)`;
    this._sunCanvas.style.opacity = String(this._sunOpacity);
    this._moonCanvas.style.transform = `rotate(${this._moonAngle}rad)`;
    this._moonCanvas.style.opacity = String(this._moonOpacity);

    // Markers sit inside the illuminated band rather than straddling its outer
    // stroke. Near conjunction (such as a new moon), keep the true bearings but
    // move the moon into a second radial lane so both bodies remain legible.
    const markerRadius = radius - MARKER_INSET_PX;
    const markersCollide = circularAngleDistance(this._sunAngle, this._moonAngle)
      < MARKER_COLLISION_ANGLE;
    this._positionMarker(this._sunMarker, cx, cy, markerRadius, this._sunAngle, this._sunOpacity);
    this._positionMarker(
      this._moonMarker,
      cx,
      cy,
      markerRadius - (markersCollide ? COLLIDING_MARKER_EXTRA_INSET_PX : 0),
      this._moonAngle,
      this._moonOpacity
    );
    this._debug = {
      enabled: true,
      visible: true,
      sunAngle: this._sunAngle,
      moonAngle: this._moonAngle,
      sunOpacity: this._sunOpacity,
      moonOpacity: this._moonOpacity,
      markersCollide,
      ephemerisUpdates: this._ephemerisUpdateCount,
      renderScale: this._renderScale,
      disc: { ...disc },
    };
  }

  /** Read-only geometry snapshot for browser QA. */
  getDebugState() {
    return this._debug ? { ...this._debug, disc: this._debug.disc ? { ...this._debug.disc } : null } : null;
  }

  /** Detach the render hook and remove all overlay DOM. */
  destroy() {
    if (this._ephemerisTimer) {
      clearInterval(this._ephemerisTimer);
      this._ephemerisTimer = null;
    }
    if (this._removePostRender) this._removePostRender();
    this._removePostRender = null;
    this._root?.remove();
  }
}
