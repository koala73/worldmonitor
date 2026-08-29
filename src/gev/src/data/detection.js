import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  DETECTION_ENABLE_FADE_MS,
  countAnimatingRenderEntries,
  detectionNeedsFollowUpFrame,
  detectionPaintSkipDecision,
  scanlineOffsetPx,
} from './detectionRenderDemand.js';
import {
  acquireAlpha,
  appendCornerBracket,
  resolveTier,
  measureTrackLabel,
  nearFarScale,
  rectIntersectsAny,
} from './detectionDraw.js';
import {
  getKeyholeFadeTuning,
  keyholeLabelAlphaFromGeometry,
} from '../celestialRing.js';
import { registerWorldOverlayPaintLane } from '../overlays/worldOverlay.js';
import {
  DETECTION_STYLE,
  DETECTION_THEME_MAP,
  SKY_PLATE_SCALE,
} from '../overlays/worldOverlayTokens.js';
import { skyBackdropFactor } from './iconOrientation.js';
import { paintDetectionCallout } from '../overlays/worldOverlayDraw.js';
import { allocateLayerQuotas, LabelArbiter } from './labelArbiter.js';
import {
  BoundedCohort,
  cohortCapForQuota,
  stableIdentityHash,
} from './detectionCohort.js';
import {
  ALLOCATION_ELASTIC,
  canonicalizeDensity,
  defaultDensityForProfile,
  detectionBracketAlpha,
  detectionHorizontalSector,
  labelBudgetFor,
  normalizeAllocationStrategy,
  normalizeProfile,
  profileForDensity,
  viewScaleForAltitude,
} from './detectionPolicy.js';
import { detectionBracketOpacity } from './detectionPresentation.js';

/**
 * @module detection
 * @description Universal Detection Overlay — renders styled screen-space bounding boxes
 * over tracked objects (vehicles, flights, satellites) through the shared world-overlay
 * host. Supports five-stop density-derived profiles:
 *
 *   - OFF      — overlay disabled, canvas hidden
 *   - SPARSE   — stable minimum label cohort at 0/25
 *   - BALANCED — stable mixed-layer label cohort at 50
 *   - DENSE    — broad stable mixed-layer label cohort at 75/100
 *
 * Theming is driven by THEME_MAP presets (retro, surveillance, thermal, default).
 * Density tuning and suspension allow external callers (scene transitions, UI)
 * to throttle or pause rendering without tearing down the overlay.
 */

/** @constant {number} MODE_OFF - Detection disabled */
const MODE_OFF = 0;
/** @constant {number} MODE_SPARSE - Curated sparse sampling mode */
const MODE_SPARSE = 1;
/** @constant {number} MODE_BALANCED - Balanced mixed-layer mode */
const MODE_BALANCED = 2;
/** @constant {number} MODE_DENSE - Broad dense mode (legacy Panoptic) */
const MODE_DENSE = 3;
/** @constant {string[]} MODE_LABELS - Human-readable labels indexed by mode value */
const MODE_LABELS = ['OFF', 'SPARSE', 'BALANCED', 'DENSE'];

/** @constant {Object<string,string>} LEGACY_MODE_ALIAS - Maps deprecated mode names to current labels */
const LEGACY_MODE_ALIAS = {
  SURVEY: 'SPARSE',
  GOD: 'DENSE',
  PANOPTIC: 'DENSE',
  NORMAL: 'BALANCED',
  ON: 'DENSE',
};

/**
 * @constant {Object<string, {line: string, label: string, labelBg: string, glow: string, blend: string, filter: string, scanline: number}>}
 * THEME_MAP - Visual theme presets controlling box stroke color, label styling,
 * glow intensity, CSS blend mode, filter chain, and scanline overlay opacity.
 */
const THEME_MAP = DETECTION_THEME_MAP;

/** @constant {number} SPARSE_ZONE_FRACTION - Fraction of viewport half-extent used as sparse focus ring radius */
const SPARSE_ZONE_FRACTION = 0.5;
/** Solve cadence for membership/collision; accepted identities still reproject every frame. */
const LABEL_SOLVE_INTERVAL_MS = 125;
/** Alpha bands retain bracket batching while approximating a continuous radial fade. */
const BRACKET_ALPHA_STEPS = 4;
/** Stable per-layer candidate safety cap; independent of density and camera bearing. */
const LAYER_CANDIDATE_CAP = 2600;
const LAYER_WEIGHTS = Object.freeze({
  military: 1.4,
  traffic: 1.15,
  cctv: 1.1,
  flights: 1,
  satellites: 1,
  bikeshare: 0.9,
  'ais-live-vessels': 1,
});

/** @constant {string} FONT - Monospace font used for callsign/overlay text. */
const FONT = DETECTION_STYLE.font;
/** @constant {string} MICRO_FONT - Slightly smaller font for the dim altitude micro-field. */
const MICRO_FONT = DETECTION_STYLE.microFont;
/** Billboard scale-by-distance curve (mirrors the flight billboards' NearFarScalar) — grows the AIR reticle with the plane as you zoom in. */
const BILL_NEAR = 1000;
const BILL_NEAR_SCALE = 3.0;
const BILL_FAR = 8000000;
const BILL_FAR_SCALE = 0.5;
/**
 * Query-string gate for the detection mode banner, mirroring `trafficDebug` in
 * `traffic.js` — the app's existing convention for a developer-only affordance.
 *
 * The banner ("DENSE VIS:15 SRC:1036 DENS:100% ELASTIC 0.4ms") is engine
 * telemetry, but it painted for every user: CRT/NVG/FLIR auto-enable detection,
 * so an orange debug readout was the first thing a visitor saw, colliding with
 * the cockpit callsign block. It is kept — the same numbers also ship
 * programmatically via `getDetectionDiagnostics()` — but now defaults OFF and
 * paints only under `?detectDebug=1`.
 *
 * Deliberately NOT also gated on `import.meta.env.DEV`, unlike `trafficDebug`:
 * that gate exists there so Vite can strip per-road timing instrumentation from
 * production builds. This banner installs no machinery, and being able to read
 * detection telemetry against a production build is the point of keeping it.
 *
 * @param {string} search A `location.search` string.
 * @returns {boolean}
 */
export function detectionDebugRequested(search) {
  try {
    return new URLSearchParams(String(search ?? '')).get('detectDebug') === '1';
  } catch {
    return false;
  }
}

/** Resolved once per `initDetection` — never re-read per frame. */
let _debugBanner = false;

/** @constant {number} FADE_MS - Duration of the subtle fade-in when detection (re)activates.
 *  Shared with the render-demand policy, which owes the scene a frame for exactly
 *  as long as this window is open (`detectionRenderDemand.js`). */
const FADE_MS = DETECTION_ENABLE_FADE_MS;
/** @constant {number} GLOW_PX - Soft glow radius, applied once via a CSS drop-shadow (not per-primitive). */
const GLOW_PX = DETECTION_STYLE.glowPx;

/**
 * The clock the render-demand model runs on: monotonic, and the SAME source the
 * world-overlay host samples once per frame into `frame.timestamp`.
 *
 * Detection used to mix this with `Date.now()`, which meant the paint and the
 * "do I need another frame" question could land on different milliseconds inside
 * a single frame and disagree about whether an animation had finished. Every
 * timestamp that feeds a fade — this module's and the label arbiter's — now
 * comes from here or from `frame.timestamp`, which is the same clock.
 * @returns {number}
 */
function _nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * Count rendered entries that are in their fade-out tail.
 * @param {Array<{selected?: boolean}>} renderEntries - Arbiter render rows.
 * @returns {number} Number of rendered rows no longer selected.
 */
export function countFadingRenderEntries(renderEntries) {
  let count = 0;
  for (let i = 0; i < renderEntries.length; i++) {
    if (!renderEntries[i].selected) count++;
  }
  return count;
}
// ---------------------------------------------------------------------------
// Module-level state — singleton lifecycle tied to the Cesium viewer
// ---------------------------------------------------------------------------

/** @type {Cesium.Viewer|null} */
let _viewer = null;
/** @type {number} Current mode index into MODE_LABELS */
let _mode = MODE_OFF;
/** @type {HTMLCanvasElement|null} Shared host canvas used for QA diagnostics. */
let _hostCanvas = null;
/** @type {HTMLCanvasElement|null} Host-owned scene-blend isolation surface. */
let _hostSurface = null;
/** @type {CanvasRenderingContext2D|null} Current host-owned paint target. */
let _ctx = null;
/** @type {Array} Registered data layers that may expose detectable objects */
let _layers = [];
/** @type {number} Monotonic frame counter for frame-skip gating and scanline animation */
let _frameCount = 0;
/** @type {number} Wall-clock ms spent in the last _drawOverlay call (used for adaptive throttling) */
let _lastRenderMs = 0;
let _lastPaintMs = 0;
let _lastSolveMs = 0;
let _throttleSkipCount = 0;
/** @type {Function|null} External callback invoked when the detection mode changes */
let _onModeChange = null;
/** @type {{surface:HTMLCanvasElement|null,setActive:Function,requestPaint:Function,unregister:Function}|null} */
let _hostLane = null;
/**
 * Second host lane for the SAME logical z-slot, targeting the shared
 * normal-blend canvas. Callouts live here so their dark backing plate can
 * actually darken bright ground; brackets, scanlines, the focus ring and the
 * debug banner stay on `_hostLane`'s screen-blended sensor surface, where
 * additive blending is the whole point. See `paintDetectionCallout`.
 * @type {{surface:HTMLCanvasElement|null,setActive:Function,requestPaint:Function,unregister:Function}|null}
 */
let _calloutLane = null;
/**
 * Callouts solved by the sensor lane this frame, replayed by the callout lane.
 * The array and its rows are POOLED — `_calloutCount` is the live length — so a
 * dense field costs no per-frame allocation. Retaining the previous frame's
 * rows is deliberate: `_shouldPaintDetectionLane` can skip the sensor lane
 * under load while the host clears the shared canvas every frame, so replaying
 * the last solve is what keeps plates from strobing against persistent
 * brackets.
 * @type {Array<Object>}
 */
const _calloutPool = [];
let _calloutCount = 0;
/** Cached per-theme plate fills, resolved on style change (never per label). */
let _platePaint = DETECTION_THEME_MAP._default.calloutPlate;
let _platePaintSpace = DETECTION_THEME_MAP._default.calloutPlateSpace;
/** @type {Object} Active theme palette from THEME_MAP */
let _theme = THEME_MAP._default;
/** @type {string} Name of the active theme */
let _themeName = 'normal';
/** @type {number} Canonical density stop (0, 25, 50, 75, or 100). */
let _densityPct = 50;
/** @type {'ELASTIC'|'WEIGHTED'} Active layer-capacity splitter. */
let _allocationStrategy = ALLOCATION_ELASTIC;
/** @type {number} Last enabled profile, restored by the Off/On toggle. */
let _lastNonOffMode = MODE_BALANCED;
/** @type {LabelArbiter} Shared stable callout selector. */
const _labelArbiter = new LabelArbiter();
let _lastLabelSolveAt = 0;
let _labelSolveDirty = true;
let _lastDiagnostics = null;
let _lastSolveSnapshot = {
  demandByLayer: {},
  cohortByLayer: {},
  cohortCount: 0,
};
let _hostLayoutRevision = -1;
/** @type {boolean} Whether overlay rendering is temporarily suspended */
let _suspended = false;
/** @type {string} Human-readable reason the overlay is suspended */
let _suspendReason = '';
/** @type {number} Timestamp (ms) detection last activated — drives the fade-in ramp. */
let _enableTime = 0;
/** @type {number} Cached monospace glyph advance width (px); measured once on first draw. */
let _charWidth = 0;
/** @type {boolean} Whether Cockpit view currently owns the viewport. */
let _cockpitActive = false;
/** @type {((event: CustomEvent) => void)|null} */
let _cockpitModeListener = null;

/**
 * Initializes detection inside the shared world-overlay host and stores
 * references to data layers. The host owns the canvas and render listener.
 * @param {Cesium.Viewer} viewer - The active Cesium viewer instance.
 * @param {Array} layers - Data layer modules that may implement getDetectableObjects().
 * @param {Function} onModeChange - Callback invoked with the new mode label string on mode changes.
 */
export function initDetection(viewer, layers, onModeChange) {
  if (_cockpitModeListener && typeof window !== 'undefined') {
    window.removeEventListener('gev:cockpit-mode-changed', _cockpitModeListener);
  }
  _hostLane?.unregister?.();
  _calloutLane?.unregister?.();
  _viewer = viewer;
  _layers = layers;
  _onModeChange = onModeChange;
  _debugBanner = detectionDebugRequested(
    typeof window !== 'undefined' ? window.location?.search : '',
  );
  _hostLayoutRevision = -1;
  _calloutCount = 0;
  _hostLane = registerWorldOverlayPaintLane('detection', _paintDetectionLane, {
    id: 'detection',
    active: _mode !== MODE_OFF && !_suspended,
    target: 'detection',
    shouldPaint: _shouldPaintDetectionLane,
  });
  // Registered AFTER the sensor lane so it replays the callouts that lane just
  // solved. Both sit in the 'detection' lane — the host's bottom slot — so
  // callouts still paint under every ordinary overlay card and under the
  // tracked readout, exactly where they sat before.
  _calloutLane = registerWorldOverlayPaintLane('detection', _paintCalloutLane, {
    id: 'detection-callouts',
    active: _mode !== MODE_OFF && !_suspended,
    target: 'shared',
  });
  _hostSurface = _hostLane.surface;
  _cockpitModeListener = (event) => {
    _cockpitActive = event?.detail?.active === true;
    _hostLane?.requestPaint();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('gev:cockpit-mode-changed', _cockpitModeListener);
  }

  setDetectionStyle('normal');
  _syncSurfaceVisibility();
  console.log('[Detection] Initialized');
}

/** Release the host lane and all retained detection runtime state. */
export function destroyDetection() {
  if (_cockpitModeListener && typeof window !== 'undefined') {
    window.removeEventListener('gev:cockpit-mode-changed', _cockpitModeListener);
  }
  _cockpitModeListener = null;
  _cockpitActive = false;
  _debugBanner = false;
  if (_hostSurface) _hostSurface.style.display = 'none';
  _hostLane?.unregister?.();
  _hostLane = null;
  _calloutLane?.unregister?.();
  _calloutLane = null;
  _calloutCount = 0;
  _viewer = null;
  _layers = [];
  _onModeChange = null;
  _hostCanvas = null;
  _hostSurface = null;
  _ctx = null;
  _mode = MODE_OFF;
  _suspended = false;
  _suspendReason = '';
  _labelArbiter.clear();
  _lastLabelSolveAt = 0;
  _labelSolveDirty = true;
  _lastDiagnostics = null;
  _lastSolveSnapshot = { demandByLayer: {}, cohortByLayer: {}, cohortCount: 0 };
  _hostLayoutRevision = -1;
  _charWidth = 0;
  _frameCount = 0;
  _lastRenderMs = 0;
  _lastPaintMs = 0;
  _lastSolveMs = 0;
  _throttleSkipCount = 0;
}

/**
 * Clamps a numeric value between min and max (inclusive).
 * @param {number} value - The value to clamp.
 * @param {number} min - Lower bound.
 * @param {number} max - Upper bound.
 * @returns {number} The clamped value.
 */
function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function _modeForDensity(densityPct = _densityPct) {
  return MODE_LABELS.indexOf(profileForDensity(densityPct));
}

/** Toggles detection Off/restore without cycling an independent mode. */
export function cycleMode() {
  if (_mode === MODE_OFF) {
    _mode = _lastNonOffMode || _modeForDensity();
  } else {
    _lastNonOffMode = _mode;
    _mode = MODE_OFF;
  }
  _applyModeState();
}

/**
 * Sets the detection mode by label string. Accepts current names and legacy aliases.
 * @param {string} modeLabel - Mode name (e.g. 'SPARSE', 'PANOPTIC', 'OFF', or legacy 'SURVEY'/'GOD').
 */
export function setMode(modeLabel) {
  if (!modeLabel) return;
  const target = _normalizeModeLabel(modeLabel);
  if (!target) return;
  if (target === 'OFF') {
    if (_mode !== MODE_OFF) _lastNonOffMode = _mode;
    _mode = MODE_OFF;
  } else {
    const requestedDensity = defaultDensityForProfile(target);
    if (profileForDensity(_densityPct) !== target) _densityPct = requestedDensity;
    _mode = _modeForDensity();
    _lastNonOffMode = _mode;
  }
  _labelSolveDirty = true;
  _applyModeState();
}

/**
 * Returns the current detection mode as a human-readable label.
 * @returns {string} One of 'OFF', 'SPARSE', 'BALANCED', or 'DENSE'.
 */
export function getMode() {
  return MODE_LABELS[_mode];
}

/**
 * Temporarily suspends the detection lane (e.g. during scene transitions).
 * @param {string} [reason='transition'] - Human-readable suspension reason shown in the mode banner.
 */
export function suspendDetection(reason = 'transition') {
  _suspended = true;
  _suspendReason = String(reason || 'transition');
  _syncSurfaceVisibility();
  _setLanesActive(false);
}

/** Resumes detection-lane rendering after a suspension. */
export function resumeDetection() {
  _suspended = false;
  _suspendReason = '';
  _syncSurfaceVisibility();
  _setLanesActive(_mode !== MODE_OFF);
}

/**
 * Detection owns two host lanes that must arm and disarm together: the
 * screen-blended sensor surface and the shared normal-blend callout lane.
 * Letting them diverge would leave callouts painted over a dead sensor field
 * (or brackets with no callsigns).
 * @param {boolean} active
 */
function _setLanesActive(active) {
  const next = active === true;
  _hostLane?.setActive(next);
  _calloutLane?.setActive(next);
  if (!next) _calloutCount = 0;
}

/**
 * Checks whether overlay rendering is currently suspended.
 * @returns {boolean} True if suspended.
 */
export function isDetectionSuspended() {
  return _suspended;
}

/**
 * Adjusts runtime tuning parameters for the detection overlay.
 * @param {Object} [options={}] - Tuning options.
 * @param {number} [options.densityPct] - Density percentage canonicalized to 0/25/50/75/100.
 * @param {'ELASTIC'|'WEIGHTED'} [options.allocationStrategy] - Layer-capacity split policy.
 */
export function setDetectionTuning(options = {}) {
  let modeChanged = false;
  if (typeof options.densityPct === 'number' && Number.isFinite(options.densityPct)) {
    const nextDensity = canonicalizeDensity(options.densityPct);
    if (nextDensity !== _densityPct) {
      _densityPct = nextDensity;
      if (_mode !== MODE_OFF) {
        _mode = _modeForDensity();
        _lastNonOffMode = _mode;
        modeChanged = true;
      } else {
        _lastNonOffMode = _modeForDensity();
      }
      _labelSolveDirty = true;
    }
  }
  if (options.allocationStrategy != null) {
    const nextStrategy = normalizeAllocationStrategy(options.allocationStrategy, _allocationStrategy);
    if (nextStrategy !== _allocationStrategy) {
      _allocationStrategy = nextStrategy;
      _labelSolveDirty = true;
    }
  }
  if (modeChanged && _onModeChange) _onModeChange(MODE_LABELS[_mode]);
  _hostLane?.requestPaint();
}

/**
 * Returns the current runtime tuning state.
 * @returns {{densityPct: number, allocationStrategy: 'ELASTIC'|'WEIGHTED'}} Current tuning.
 */
export function getDetectionTuning() {
  return { densityPct: _densityPct, allocationStrategy: _allocationStrategy };
}

/**
 * Tell detection that the set of detectable objects may have changed.
 *
 * Detection PULLS its candidates (`getDetectableObjects()`) on each paint, so a
 * layer that swaps its contents does not announce itself — and the label solve
 * behind those candidates runs on a private 125 ms throttle. Between the two, a
 * layer tick that requested exactly ONE frame in idle mode could be consumed by
 * a paint that declined to re-solve, leaving the departed contact labelled and
 * the arriving one unlabelled with nothing left to ask for another frame.
 *
 * Marking the solve dirty makes that single requested frame do the work it was
 * requested for. It is called from discrete layer events only — a poll tick or a
 * visibility change, seconds apart — never per frame, so it cannot reintroduce a
 * hot loop. It deliberately does NOT request a render itself: the caller already
 * does that, and detection asking again would double the request.
 *
 * @param {string} [reason] - Diagnostic label for the caller's benefit.
 * @returns {void}
 */
export function markDetectionSourcesChanged(reason = 'sources-changed') {
  if (_mode === MODE_OFF) return;
  _labelSolveDirty = true;
  if (_lastDiagnostics) _lastDiagnostics.lastSourceChangeReason = reason;
}

/** Read-only diagnostics for unit/browser QA. */
export function getDetectionDiagnostics() {
  return _lastDiagnostics ? JSON.parse(JSON.stringify(_lastDiagnostics)) : null;
}

function _publishDiagnostics() {
  if (!_hostCanvas?.dataset || !_lastDiagnostics) return;
  const dataset = _hostCanvas.dataset;
  dataset.profile = _lastDiagnostics.profile || 'OFF';
  dataset.densityPct = String(_lastDiagnostics.densityPct ?? _densityPct);
  dataset.allocationStrategy = _lastDiagnostics.allocationStrategy || _allocationStrategy;
  dataset.solveRevision = String(_lastDiagnostics.solveRevision ?? 0);
  dataset.collectiveLabelBudget = String(_lastDiagnostics.collectiveLabelBudget ?? 0);
  dataset.labelsByLayer = JSON.stringify(_lastDiagnostics.labelsByLayer || {});
  dataset.entitlementByLayer = JSON.stringify(_lastDiagnostics.entitlementByLayer || {});
  dataset.labeledKeys = JSON.stringify(_lastDiagnostics.labeledKeys || []);
  dataset.labelAlphaByKey = JSON.stringify(_lastDiagnostics.labelAlphaByKey || {});
  dataset.bracketOpacityCounts = JSON.stringify(_lastDiagnostics.bracketOpacityCounts || {});
  dataset.keyholeRadius = String(_lastDiagnostics.keyholeRadius ?? 0);
  dataset.keyholeFeatherPx = String(_lastDiagnostics.keyholeFeatherPx ?? 0);
  dataset.demandByLayer = JSON.stringify(_lastDiagnostics.demandByLayer || {});
  dataset.cohortByLayer = JSON.stringify(_lastDiagnostics.cohortByLayer || {});
  dataset.placementBuildCount = String(_lastDiagnostics.placementBuildCount ?? 0);
  dataset.observationCount = String(_lastDiagnostics.observationCount ?? 0);
  dataset.selectedCount = String(_lastDiagnostics.selectedCount ?? 0);
  dataset.fadingCount = String(_lastDiagnostics.fadingCount ?? 0);
  dataset.paintMs = String(_lastDiagnostics.paintMs ?? 0);
  dataset.solveMs = String(_lastDiagnostics.solveMs ?? 0);
  dataset.frameTotalMs = String(_lastDiagnostics.frameTotalMs ?? 0);
  dataset.throttleSkipCount = String(_lastDiagnostics.throttleSkipCount ?? 0);
}

/**
 * Switches the visual theme for detection's host paint lane.
 * @param {string} styleName - Theme key from THEME_MAP (e.g. 'retro', 'surveillance', 'thermal').
 *   Falls back to '_default' for unrecognized names.
 */
export function setDetectionStyle(styleName) {
  _themeName = styleName || 'normal';
  _theme = THEME_MAP[_themeName] || THEME_MAP._default;
  // Resolve the plate fills once per style change. The callout painter reads
  // these strings directly, so the hot path never builds a colour.
  _platePaint = _theme.calloutPlate || THEME_MAP._default.calloutPlate;
  _platePaintSpace = _theme.calloutPlateSpace || _platePaint;
  _applySurfaceTheme();
  // Host invalidation is frame-global, so one request repaints both lanes.
  _hostLane?.requestPaint();
}

function _applySurfaceTheme() {
  if (!_hostSurface) return;
  _hostSurface.style.mixBlendMode = _theme.blend;
  // This exact CSS chain is one compositor pass over the finished layer.
  _hostSurface.style.filter = `${_theme.filter} drop-shadow(0 0 ${GLOW_PX}px ${_theme.glow})`;
}

function _syncSurfaceVisibility() {
  // Detection does NOT hold continuous render. It repaints on CHANGE — every
  // mode/suspend/tuning transition routes through this chokepoint or through
  // `_hostLane.requestPaint()`, both of which ask the governor for a frame — and
  // owes itself follow-up frames only while a bounded animation is in flight
  // (see `detectionRenderDemand.js` for why a hold was wrong here, and why
  // removing it is safe).
  governorRequestRender('detection-visibility');
  if (!_hostSurface) return;
  _hostSurface.style.display = _mode === MODE_OFF ? 'none' : 'block';
  _hostSurface.style.opacity = _suspended ? '0' : '1';
}

/**
 * Returns the active theme's key colors so other overlays (e.g. the tracked-target
 * readout) can match the current visual mode (cyan/green/amber/white-hot).
 * @returns {{label: string, line: string, dim: string, glow: string, labelBg: string}}
 */
export function getDetectionTheme() {
  return {
    label: _theme.label,
    line: _theme.line,
    dim: _theme.dim || _theme.label,
    glow: _theme.glow,
    labelBg: _theme.labelBg,
  };
}

/**
 * Normalizes a mode label string, resolving legacy aliases to current names.
 * @param {string} label - Raw mode label (case-insensitive).
 * @returns {string|null} Canonical mode label or null if unrecognized.
 */
function _normalizeModeLabel(label) {
  const upper = String(label).toUpperCase();
  if (LEGACY_MODE_ALIAS[upper]) return LEGACY_MODE_ALIAS[upper];
  if (MODE_LABELS.includes(upper)) return upper;
  return null;
}

/**
 * Applies the current mode to the registered host lane.
 */
function _applyModeState() {
  const label = MODE_LABELS[_mode];
  if (_mode === MODE_OFF) {
    _syncSurfaceVisibility();
    _setLanesActive(false);
    _labelArbiter.clear();
    _lastLabelSolveAt = 0;
    _labelSolveDirty = true;
    _lastSolveSnapshot = { demandByLayer: {}, cohortByLayer: {}, cohortCount: 0 };
  } else {
    _enableTime = _nowMs(); // restart the subtle fade-in on (re)activation
    _syncSurfaceVisibility();
    _setLanesActive(!_suspended);
    _labelSolveDirty = true;
  }

  if (_onModeChange) _onModeChange(label);
  console.log(`[Detection] Mode: ${label}`);
}

/**
 * Host gate for the shipped pathological-load relief valve. Returning false
 * preserves the dedicated surface's previous pixels while every shared lane
 * continues through the same host frame.
 */
function _shouldPaintDetectionLane(frame) {
  if (_mode === MODE_OFF || _suspended) return false;
  const layoutChanged = frame.layoutRevision !== _hostLayoutRevision;
  _frameCount++;
  // The skip and the follow-up request come from ONE decision, so the valve
  // cannot drop a frame without handing its request forward — see
  // `detectionPaintSkipDecision`. (Skipping is a deferral, never a cancellation:
  // without a render hold, the frame this declines may be the only one anybody
  // asked for.)
  const decision = detectionPaintSkipDecision({
    layoutChanged,
    lastPaintMs: _lastPaintMs,
    frameCount: _frameCount,
  });
  if (decision.skip) {
    _throttleSkipCount++;
    if (_lastDiagnostics) _lastDiagnostics.throttleSkipCount = _throttleSkipCount;
    if (decision.requestFollowUp) governorRequestRender('detection-paint-skipped');
    return false;
  }
  return true;
}

/** Paint detection into the host-owned blend-isolation target. */
function _paintDetectionLane(frame) {
  if (_mode === MODE_OFF || _suspended) return;
  _ctx = frame.ctx;
  _hostCanvas = frame.canvas;
  if (_hostSurface !== frame.surface) {
    _hostSurface = frame.surface;
    _applySurfaceTheme();
    _syncSurfaceVisibility();
  }
  if (frame.layoutRevision !== _hostLayoutRevision) {
    _hostLayoutRevision = frame.layoutRevision;
    _labelSolveDirty = true;
  }
  const start = performance.now();
  const result = _drawOverlay(frame)
    || { didSolve: false, solveMs: 0, fadingCount: 0, animatingCount: 0, solvePending: false };
  _lastRenderMs = performance.now() - start;
  _lastSolveMs = result.solveMs || 0;
  _lastPaintMs = Math.max(0, _lastRenderMs - _lastSolveMs);
  if (_lastDiagnostics) {
    _lastDiagnostics.frameTotalMs = _lastRenderMs;
    _lastDiagnostics.paintMs = _lastPaintMs;
    _lastDiagnostics.solveMs = _lastSolveMs;
    _lastDiagnostics.throttleSkipCount = _throttleSkipCount;
  }
  if (result.didSolve) _publishDiagnostics();
  // Detection holds nothing, so a time-based animation has to ask for its own
  // next frame. This chain is self-terminating BY CONSTRUCTION — every animation
  // it covers ends (the enable fade closes, labels finish fading out) — which is
  // exactly what makes it safe where the old blanket hold was not. On a parked
  // scene with nothing animating it asks for nothing, and the governor stays
  // idle. See `detectionRenderDemand.js`.
  if (detectionNeedsFollowUpFrame({
    active: _mode !== MODE_OFF && !_suspended,
    // The frame's OWN timestamp, not a fresh sample — re-reading the clock here
    // is what dropped the terminal frame of a fade (paint at 219 ms, policy at
    // 220 ms, and the settled alpha never painted).
    nowMs: Number.isFinite(frame.timestamp) ? frame.timestamp : _nowMs(),
    enabledAtMs: _enableTime,
    fadeMs: FADE_MS,
    animatingLabelCount: result.animatingCount || 0,
    solvePending: result.solvePending === true,
  })) {
    governorRequestRender('detection-animation');
  }
}

/**
 * Queries all registered layers for detectable objects. Candidate collection is
 * deliberately independent of density and camera bearing; the central arbiter
 * is the only owner of callout selection.
 * @returns {Array<Object>} Aggregated detectable objects across all layers.
 *   Each object is annotated with a `_layerId` property.
 */
function _collectDetectableObjects() {
  const label = MODE_LABELS[_mode];
  const objects = [];

  for (let i = 0; i < _layers.length; i++) {
    const layer = _layers[i];
    if (typeof layer.getDetectableObjects !== 'function') continue;
    try {
      const maxCount = ['flights', 'military'].includes(layer.id)
        ? Number.POSITIVE_INFINITY
        : LAYER_CANDIDATE_CAP;
      const items = layer.getDetectableObjects({
        mode: label,
        maxCount,
        seed: 0,
      });
      if (items && items.length > 0) {
        for (const item of items) {
          item._layerId = layer.id;
          objects.push(item);
        }
      }
    } catch {
      // layer skipped — may not have data or threw an error
    }
  }

  return objects;
}

/**
 * Draws a CRT-style scanline overlay across the entire canvas.
 *
 * The scroll offset comes from the CLOCK, not from `_frameCount`. Those look
 * identical while the scene is rendering — `SCANLINE_STEP_MS` is one 60 fps
 * frame — but they differ in what they DEMAND. A frame counter only advances if
 * something keeps rendering, so tying decorative texture to it meant detection
 * had to hold the scene in continuous mode forever to keep its own shimmer
 * alive. Off the clock, the pattern scrolls whenever the scene is rendering for
 * any real reason and simply rests on a parked view. The lines are always
 * painted; only the shimmer pauses.
 *
 * Opacity is controlled by the theme's scanline property.
 * @param {number} width - Canvas width in pixels.
 * @param {number} height - Canvas height in pixels.
 * @param {number} nowMs - Wall-clock time of this frame.
 */
function _drawScanlines(width, height, nowMs) {
  if (!_theme.scanline || !_ctx) return;
  _ctx.save();
  _ctx.globalAlpha = _theme.scanline;
  _ctx.fillStyle = _theme.labelBg;
  for (let y = scanlineOffsetPx(nowMs); y < height; y += 4) {
    _ctx.fillRect(0, y, width, 1);
  }
  _ctx.restore();
}

// Corner-bracket geometry (appendCornerBracket) and label composition
// (composeLabel) now live in detectionDraw.js. _drawOverlay batches brackets by
// tier color + radial-opacity band and draws labels as one background fill plus
// two text passes, avoiding per-object strokes while preserving keyhole fading.

/**
 * Draws the top-left status banner showing the current mode, visible/source counts,
 * density tuning value, frame render time, and suspension state.
 *
 * Developer telemetry: paints only under `?detectDebug=1` (see
 * `detectionDebugRequested`). The same numbers are always available through
 * `getDetectionDiagnostics()`.
 * @param {number} visibleCount - Number of objects that passed all visibility checks this frame.
 * @param {number} sampledCount - Total number of objects collected from layers before filtering.
 */
function _drawModeBanner(visibleCount, sampledCount) {
  if (!_debugBanner) return;
  const mode = MODE_LABELS[_mode];
  const paused = _suspended ? `  PAUSED:${_suspendReason || 'transition'}` : '';
  const allocation = _allocationStrategy === ALLOCATION_ELASTIC ? 'ELASTIC' : 'WEIGHTED';
  const text = `${mode}  VIS:${visibleCount}  SRC:${sampledCount}  DENS:${_densityPct}%  ${allocation}  ${_lastRenderMs.toFixed(1)}ms${paused}`;
  _ctx.fillStyle = _theme.labelBg;
  _ctx.fillRect(12, 12, Math.max(180, _ctx.measureText(text).width + 12), 16);
  _ctx.fillStyle = _theme.label;
  _ctx.fillText(text, 18, 23);
}

/**
 * Draws a faint circular focus ring in the center of the viewport in sparse mode.
 * Objects outside this ring are culled during sparse selection.
 * @param {number} width - Canvas width in pixels.
 * @param {number} height - Canvas height in pixels.
 */
function _drawSparseFocusRing(width, height) {
  if (_mode !== MODE_SPARSE) return;
  const cx = width * 0.5;
  const cy = height * 0.5;
  const r = Math.min(width, height) * SPARSE_ZONE_FRACTION;
  _ctx.save();
  _ctx.strokeStyle = _theme.glow;
  _ctx.globalAlpha = 0.35;
  _ctx.lineWidth = 1;
  _ctx.beginPath();
  _ctx.arc(cx, cy, r, 0, Math.PI * 2);
  _ctx.stroke();
  _ctx.restore();
}

function _detectionKey(layerId, sourceId) {
  return `${layerId || 'unknown'}:${String(sourceId)}`;
}

function _semanticPriority(obj) {
  if (obj.skipLabel) return 1000;
  if (obj.tier === 'military') return 120;
  if (obj.type === 'CAM') return 50;
  if (obj.type === 'VEH') return 35;
  if (obj.type === 'AIR') return 30;
  if (obj.type === 'SAT') return 25;
  if (obj.type === 'SEA') return 25;
  return 10;
}

function _buildLabelPlacements(
  sx,
  sy,
  halfW,
  halfH,
  card,
  width,
  height,
  keyhole,
  occlusionRects = [],
) {
  const gapX = 8;
  const gapY = 12;
  const margin = 4;
  const raw = [
    {
      corner: 'NE',
      cardX: sx + halfW + gapX,
      cardY: sy - halfH - gapY - card.h,
      leadFromX: sx + halfW,
      leadFromY: sy - halfH,
      leadToSide: 'SW',
    },
    {
      corner: 'NW',
      cardX: sx - halfW - gapX - card.w,
      cardY: sy - halfH - gapY - card.h,
      leadFromX: sx - halfW,
      leadFromY: sy - halfH,
      leadToSide: 'SE',
    },
    {
      corner: 'SE',
      cardX: sx + halfW + gapX,
      cardY: sy + halfH + gapY,
      leadFromX: sx + halfW,
      leadFromY: sy + halfH,
      leadToSide: 'NW',
    },
    {
      corner: 'SW',
      cardX: sx - halfW - gapX - card.w,
      cardY: sy + halfH + gapY,
      leadFromX: sx - halfW,
      leadFromY: sy + halfH,
      leadToSide: 'NE',
    },
  ];

  const placements = [];
  for (const placement of raw) {
    const { cardX, cardY } = placement;
    if (cardX < margin || cardY < margin || cardX + card.w > width - margin || cardY + card.h > height - margin) {
      continue;
    }
    const cardRect = { x: cardX, y: cardY, w: card.w, h: card.h };
    if (rectIntersectsAny(cardRect, occlusionRects)) continue;
    const leadToX = placement.leadToSide.endsWith('E') ? cardX + card.w : cardX;
    const leadToY = placement.leadToSide.startsWith('S') ? cardY + card.h : cardY;
    const centerX = cardX + card.w * 0.5;
    const centerY = cardY + card.h * 0.5;
    const radialAlpha = keyholeLabelAlphaFromGeometry(centerX, centerY, keyhole);
    if (radialAlpha <= 0) continue;
    placements.push({
      ...placement,
      leadToX,
      leadToY,
      centerX,
      centerY,
      keyholeAlpha: radialAlpha,
      rect: cardRect,
      primaryX: cardX + card.primaryX,
      microX: cardX + card.microX,
      baseline: cardY + card.baseline,
    });
  }
  return placements;
}

/**
 * Record one solved callout into the pooled replay buffer consumed by
 * `_paintCalloutLane`. Nothing is painted here: the sensor lane owns the
 * screen-blended surface, and a dark plate cannot darken through `screen`.
 *
 * Row objects are created once and then only mutated, so a dense field costs
 * no allocation after the first frames that reach a given population.
 * @param {Object} entry Arbiter render row.
 * @param {number} acquireFade Detection's activation fade.
 * @param {Object} keyhole Frame keyhole geometry.
 */
function _stashCallout(entry, acquireFade, keyhole) {
  const { candidate, placement, temporalAlpha } = entry;
  const radialAlpha = keyholeLabelAlphaFromGeometry(placement.centerX, placement.centerY, keyhole);
  const alpha = acquireFade * temporalAlpha * radialAlpha;
  if (alpha <= 0.001) return;

  let row = _calloutPool[_calloutCount];
  if (!row) {
    row = {
      x: 0, y: 0, w: 0, h: 0,
      primaryX: 0, microX: 0, baseline: 0,
      leadFromX: 0, leadFromY: 0, leadToX: 0, leadToY: 0,
      plate: '', plateScale: 1, accent: '', label: '', primary: '', micro: '',
      font: FONT, microFont: MICRO_FONT, alpha: 1,
    };
    _calloutPool[_calloutCount] = row;
  }
  row.x = placement.cardX;
  row.y = placement.cardY;
  row.w = placement.rect.w;
  row.h = placement.rect.h;
  row.primaryX = placement.primaryX;
  row.microX = placement.microX;
  row.baseline = placement.baseline;
  row.leadFromX = placement.leadFromX;
  row.leadFromY = placement.leadFromY;
  row.leadToX = placement.leadToX;
  row.leadToY = placement.leadToY;
  // Satellites sit over the high-albedo lit Earth disc far more often than
  // aircraft do, so the space tier carries the heavier plate.
  row.plate = candidate.type === 'SAT' ? _platePaintSpace : _platePaint;
  // Solved once per candidate, replayed on every frame between solves.
  row.plateScale = candidate.plateScale ?? 1;
  row.accent = candidate.color;
  row.label = _theme.label;
  row.primary = candidate.primary;
  row.micro = candidate.hasMicro ? candidate.micro : '';
  row.font = FONT;
  row.microFont = MICRO_FONT;
  row.alpha = alpha;
  _calloutCount++;
}

/**
 * Replay this frame's callouts onto the shared normal-blend canvas.
 *
 * Runs as its own host lane so the plate composites normally instead of
 * through the sensor surface's `screen` blend. Registered in the same
 * 'detection' lane slot, so callouts keep their shipped z-position beneath
 * every ordinary overlay card and the tracked readout.
 * @param {Object} frame Host paint frame.
 */
function _paintCalloutLane(frame) {
  if (_mode === MODE_OFF || _suspended || _calloutCount === 0) return;
  const ctx = frame.ctx;
  if (!ctx) return;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (let i = 0; i < _calloutCount; i++) {
    const row = _calloutPool[i];
    paintDetectionCallout(ctx, row, row.alpha);
  }
  ctx.globalAlpha = 1;
}

/**
 * Scale a callout's plate for what sits behind it. Ground keeps the full
 * per-theme plate; sky feathers down to `SKY_PLATE_SCALE` of it, because the
 * plate's whole job — holding small mono text off busy sunlit imagery — does
 * not exist against an empty horizon. See `SKY_PLATE_SCALE` for the taste call.
 * @param {number} skyFactor 0 (ground behind) … 1 (sky behind).
 * @returns {number} Multiplier applied to the plate fill only.
 */
function _plateScaleForBackdrop(skyFactor) {
  return 1 + (SKY_PLATE_SCALE - 1) * skyFactor;
}

/** Materialize one bounded rich-callout candidate for the existing arbiter. */
function _materializeCandidate(obj, width, height, keyhole, occlusionRects, cameraPosition) {
  const primary = obj._candidatePrimary;
  const micro = obj._candidateMicro;
  const card = measureTrackLabel(primary, micro, _charWidth);
  const placements = _buildLabelPlacements(
    obj._candidateScreenX,
    obj._candidateScreenY,
    obj._candidateHalfW,
    obj._candidateHalfH,
    card,
    width,
    height,
    keyhole,
    occlusionRects,
  );
  if (placements.length === 0) return null;
  let centerDistance = Number.POSITIVE_INFINITY;
  let keyholeAlpha = 0;
  for (const placement of placements) {
    centerDistance = Math.min(
      centerDistance,
      Math.hypot(placement.centerX - keyhole.centerX, placement.centerY - keyhole.centerY),
    );
    keyholeAlpha = Math.max(keyholeAlpha, placement.keyholeAlpha);
  }
  const layerId = obj._layerId || 'unknown';
  const sourceId = obj._cohortSourceId;
  return {
    key: _detectionKey(layerId, sourceId),
    layerId,
    sourceId,
    type: obj.type || 'UNK',
    priority: obj._cohortPriority,
    screenX: obj._candidateScreenX,
    screenY: obj._candidateScreenY,
    centerDistance,
    keyholeAlpha,
    placements,
    color: obj._candidateColor,
    // Costed here rather than in the object sweep: the sweep walks every
    // observation in view, while this runs only for callouts that actually
    // placed — a budgeted handful per frame.
    plateScale: _plateScaleForBackdrop(skyBackdropFactor(cameraPosition, obj.position)),
    primary,
    micro,
    hasMicro: card.hasMicro,
  };
}

/**
 * Paint detection against the shared host frame. Brackets remain broad and
 * per-frame; rich placements rebuild only for selected/fading identities and
 * for a bounded cohort on solve ticks.
 */
function _drawOverlay(frame) {
  const { width, height } = frame;
  if (!_ctx || width <= 0 || height <= 0) {
    return { didSolve: false, solveMs: 0, fadingCount: 0, animatingCount: 0, solvePending: false };
  }

  // ONE timestamp per frame, monotonic, shared with the demand policy below and
  // with every arbiter call in this function — so the frame that paints an
  // animation's final state is the same frame that ends its demand.
  const now = Number.isFinite(frame.timestamp) ? frame.timestamp : _nowMs();
  const bracketPresentationOpacity = detectionBracketOpacity(_cockpitActive);
  const shouldSolve = _labelSolveDirty || now - _lastLabelSolveAt >= LABEL_SOLVE_INTERVAL_MS;
  const calloutOcclusionRects = frame.uiRects;
  const selectedIdentities = shouldSolve
    ? _labelArbiter.liveIdentities({ includeFading: false, now })
    : null;
  const renderIdentities = _labelArbiter.liveIdentities({ includeFading: true, now });
  const objects = _collectDetectableObjects();
  const sampledCount = objects.length;
  if (objects.length === 0) {
    // No detectable objects (e.g. DETECT on with no data layers enabled). Still
    // paint so the overlay reads "armed, nothing in view" instead of a dead blank
    // canvas (H3 silent-failure theme). The scanlines and focus ring carry that
    // signal for everyone; the mode banner adds counts only under ?detectDebug=1.
    // The frame is already cleared above.
    //
    // Drop the replay buffer with it. Every other exit from this function
    // rebuilds the buffer, but this one returns early — and because the
    // callout lane repaints the last solve on frames the sensor lane skips,
    // leaving rows here would strand the final callsigns on screen after the
    // last data layer is switched off.
    _calloutCount = 0;
    _ctx.font = FONT;
    _drawScanlines(width, height, now);
    _drawSparseFocusRing(width, height);
    _drawModeBanner(0, 0);
    _lastDiagnostics = {
      profile: MODE_LABELS[_mode],
      densityPct: _densityPct,
      allocationStrategy: _allocationStrategy,
      viewScale: viewScaleForAltitude(_viewer?.camera?.positionCartographic?.height),
      candidateCount: 0,
      observationCount: 0,
      visibleCount: 0,
      bracketPresentationOpacity,
      labelBudget: 0,
      labelsByLayer: {},
      labeledKeys: [],
      solveRevision: _labelArbiter.solveRevision,
      demandByLayer: {},
      cohortByLayer: {},
      cohortCount: 0,
      placementBuildCount: 0,
      selectedCount: 0,
      fadingCount: 0,
      didSolve: false,
    };
    // With nothing detectable there is nothing to place, so the solve is
    // VACUOUSLY complete — settle it here rather than carrying the dirty flag
    // out of a branch that can never clear it.
    //
    // This is the one exit that skips the solve block entirely, so leaving the
    // flag set reports "a solve is still owed" on every future frame. Paired
    // with the follow-up request that owed solves now earn, that is a permanent
    // frame chain on the emptiest possible scene — precisely the hot loop this
    // whole mechanism exists to remove.
    _lastLabelSolveAt = now;
    _labelSolveDirty = false;
    return { didSolve: false, solveMs: 0, fadingCount: 0, animatingCount: 0, solvePending: false };
  }

  // Horizon culling, keyhole geometry, and camera transforms are shared with
  // every host lane. Detection retains the manual scalar projection below.
  const occluder = frame.occluder;
  const camPos = frame.cameraPosition;
  const keyhole = frame.keyhole;
  // Read the OUTSIDE setting ONCE per paint, from the same module state the
  // host's own keyhole alpha comes from, so a bracket and its callout can never
  // disagree about the operator's setting within a frame.
  const keyholeOutsideOpacity = getKeyholeFadeTuning().outsideOpacity;
  const viewProjection = frame.viewProjectionMatrix;
  const vp0 = viewProjection[0];
  const vp1 = viewProjection[1];
  const vp3 = viewProjection[3];
  const vp4 = viewProjection[4];
  const vp5 = viewProjection[5];
  const vp7 = viewProjection[7];
  const vp8 = viewProjection[8];
  const vp9 = viewProjection[9];
  const vp11 = viewProjection[11];
  const vp12 = viewProjection[12];
  const vp13 = viewProjection[13];
  const vp15 = viewProjection[15];

  // Brackets stay broad inside the keyhole, fade outside it, and batch by tier
  // color plus a 32-step alpha band. Text candidates are projected once and
  // handed to the shared stable arbiter.
  _ctx.font = FONT;
  if (!_charWidth) _charWidth = _ctx.measureText('0000000000').width / 10 || 6;
  const tiers = _theme.tiers || null;
  const colorFor = (key) => (tiers && tiers[key]) || _theme.line;
  const bracketPaths = new Map();
  const pathFor = (map, color, alpha) => {
    const band = Math.max(1, Math.min(BRACKET_ALPHA_STEPS, Math.ceil(alpha * BRACKET_ALPHA_STEPS)));
    let bands = map.get(color);
    if (!bands) {
      bands = new Array(BRACKET_ALPHA_STEPS + 1);
      map.set(color, bands);
    }
    let entry = bands[band];
    if (!entry) {
      entry = { color, alpha: band / BRACKET_ALPHA_STEPS, path: new Path2D() };
      bands[band] = entry;
    }
    return entry.path;
  };

  let visibleCount = 0;
  const bracketOpacityCounts = { full: 0, partial: 0, hidden: 0 };
  const aircraftBracketSectors = { left: 0, front: 0, right: 0 };
  let protectedVisibleCount = 0;
  const candidateMap = new Map();
  const cohortBuilders = shouldSolve ? new Map() : null;
  const demandByLayer = shouldSolve ? new Map() : null;
  let placementBuildCount = 0;
  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    if (!obj.position) continue;
    // Skip objects occluded by the ellipsoid (behind the horizon)
    if (!occluder.isPointVisible(obj.position)) continue;

    // This product renders in Cesium's 3D scene mode. Multiplying by the
    // once-per-frame view-projection matrix is equivalent to the general
    // SceneTransforms helper here, without repeating its mode/viewport setup
    // for every observation.
    const px = obj.position.x;
    const py = obj.position.y;
    const pz = obj.position.z;
    const clipW = vp3 * px + vp7 * py + vp11 * pz + vp15;
    if (clipW <= 0) continue;
    const invW = 1 / clipW;
    const sx = ((vp0 * px + vp4 * py + vp8 * pz + vp12) * invW * 0.5 + 0.5) * width;
    const sy = (0.5 - (vp1 * px + vp5 * py + vp9 * pz + vp13) * invW * 0.5) * height;

    // Tracked objects (skipLabel) get larger boxes. AIR reticles scale with the
    // plane's on-screen size (same scaleByDistance curve as the billboards) so
    // they don't look tiny at altitude; other types keep fixed sizes.
    const isTracked = obj.skipLabel;
    let halfW;
    let halfH;
    if (obj.type === 'AIR') {
      const bscale = nearFarScale(
        Cesium.Cartesian3.distance(camPos, obj.position),
        BILL_NEAR, BILL_NEAR_SCALE, BILL_FAR, BILL_FAR_SCALE,
      );
      halfW = _clamp((isTracked ? 14 : 9) * bscale, 7, 48);
      halfH = _clamp((isTracked ? 11 : 7) * bscale, 5, 38);
    } else {
      halfW = _mode === MODE_DENSE ? (isTracked ? 28 : 11) : 16;
      halfH = _mode === MODE_DENSE ? (isTracked ? 22 : 7) : 10;
    }
    // Viewport bounds check with padding
    if (sx < -halfW || sx > width + halfW || sy < -halfH || sy > height + halfH) continue;

    // Tier color drives the bracket, accent bar, and leader line for this object.
    // The bracket follows the same linear radial keyhole fade as its callout.
    const color = colorFor(resolveTier(obj));
    const keyholeAlpha = keyholeLabelAlphaFromGeometry(sx, sy, keyhole);
    const bracketAlpha = detectionBracketAlpha(obj.type, keyholeAlpha, keyholeOutsideOpacity);
    if (bracketAlpha > 0) {
      appendCornerBracket(pathFor(bracketPaths, color, bracketAlpha), sx, sy, halfW, halfH);
      visibleCount++;
      if (obj.type === 'AIR') aircraftBracketSectors[detectionHorizontalSector(sx, width)]++;
      if (bracketAlpha >= 1) bracketOpacityCounts.full++;
      else bracketOpacityCounts.partial++;
    } else {
      bracketOpacityCounts.hidden++;
    }

    if (obj.skipLabel) {
      if (bracketAlpha > 0) protectedVisibleCount++;
      continue;
    }

    const primary = String(obj.id || '');
    const micro = String(obj.metric || '');
    if (!primary && !micro) continue;
    const layerId = obj._layerId || 'unknown';
    const sourceId = obj.sourceId ?? obj.id ?? i;
    const liveForRender = renderIdentities.get(layerId)?.has(sourceId) || false;
    if (!shouldSolve && !liveForRender) continue;

    obj._cohortSourceId = sourceId;
    obj._cohortPriority = _semanticPriority(obj);
    obj._cohortBand = bracketAlpha >= 0.999 ? 8 : Math.floor(bracketAlpha * 8);
    obj._cohortHash = stableIdentityHash(layerId, sourceId);
    obj._candidateScreenX = sx;
    obj._candidateScreenY = sy;
    obj._candidateHalfW = halfW;
    obj._candidateHalfH = halfH;
    obj._candidateColor = color;
    obj._candidatePrimary = primary;
    obj._candidateMicro = micro;

    if (shouldSolve && keyholeAlpha > 0) {
      demandByLayer.set(layerId, (demandByLayer.get(layerId) || 0) + 1);
      if (!cohortBuilders.has(layerId)) cohortBuilders.set(layerId, new BoundedCohort(256));
      const incumbent = selectedIdentities?.get(layerId)?.has(sourceId) || false;
      cohortBuilders.get(layerId).consider(obj, incumbent);
    }

    if (liveForRender) {
      placementBuildCount++;
      const candidate = _materializeCandidate(
        obj,
        width,
        height,
        keyhole,
        calloutOcclusionRects,
        camPos,
      );
      if (candidate && !candidateMap.has(candidate.key)) candidateMap.set(candidate.key, candidate);
    }
  }

  const altitude = _viewer?.camera?.positionCartographic?.height ?? 1e9;
  const collectiveBudget = labelBudgetFor(altitude, _densityPct);
  const ambientBudget = Math.max(0, collectiveBudget - Math.min(collectiveBudget, protectedVisibleCount));
  let didSolve = false;
  let solveMs = 0;
  if (shouldSolve) {
    const quotas = allocateLayerQuotas(
      demandByLayer,
      ambientBudget,
      _allocationStrategy,
      LAYER_WEIGHTS,
    );
    const solveCandidates = [];
    const cohortByLayer = {};
    for (const [layerId, builder] of cohortBuilders) {
      const cohort = builder.values(cohortCapForQuota(quotas.get(layerId) || 0));
      for (const obj of cohort) {
        const key = _detectionKey(layerId, obj._cohortSourceId);
        let candidate = candidateMap.get(key);
        if (!candidate) {
          placementBuildCount++;
          candidate = _materializeCandidate(
            obj,
            width,
            height,
            keyhole,
            calloutOcclusionRects,
            camPos,
          );
          if (candidate) candidateMap.set(candidate.key, candidate);
        }
        if (candidate) solveCandidates.push(candidate);
      }
      cohortByLayer[layerId] = solveCandidates.filter((candidate) => candidate.layerId === layerId).length;
    }
    const solveStarted = performance.now();
    _labelArbiter.solve(solveCandidates, {
      capacity: ambientBudget,
      strategy: _allocationStrategy,
      layerWeights: LAYER_WEIGHTS,
      demandByLayer,
      now,
      // A dirty solve means the capacity/profile/policy changed, not that stable
      // identities became invalid. The arbiter itself disables preservation when
      // the active layer set changes; otherwise keep incumbents so increasing a
      // density stop adds labels instead of replacing the visible cohort.
      preserveIncumbents: true,
    });
    solveMs = performance.now() - solveStarted;
    _lastLabelSolveAt = now;
    _labelSolveDirty = false;
    _lastSolveSnapshot = {
      demandByLayer: Object.fromEntries(demandByLayer),
      cohortByLayer,
      cohortCount: solveCandidates.length,
    };
    didSolve = true;
  }

  const fade = acquireAlpha(_enableTime, now, FADE_MS);
  const bracketWidth = _mode === MODE_DENSE ? 1 : 1.25;

  // Brackets — batched by tier color and linear radial-opacity band.
  _ctx.lineWidth = bracketWidth;
  for (const bands of bracketPaths.values()) {
    for (const entry of bands) {
      if (!entry) continue;
      _ctx.globalAlpha = fade * entry.alpha * bracketPresentationOpacity;
      _ctx.strokeStyle = entry.color;
      _ctx.stroke(entry.path);
    }
  }

  const renderEntries = _labelArbiter.renderEntries(candidateMap, now);
  const fadingCount = countFadingRenderEntries(renderEntries);
  // Demand counts fades in BOTH directions; `fadingCount` above stays the
  // fade-OUT tail because that is what the published diagnostics have always
  // meant. A fade-IN that nothing asks a frame for is a label that never
  // becomes visible on a parked scene.
  const animatingCount = countAnimatingRenderEntries(renderEntries);
  _calloutCount = 0;
  for (const entry of renderEntries) _stashCallout(entry, fade, keyhole);
  _ctx.font = FONT;
  _ctx.globalAlpha = 1;

  if (didSolve || !_lastDiagnostics) {
    const arbiterDiagnostics = _labelArbiter.diagnostics() || {};
    const selectedCount = _labelArbiter.selectedKeys.size;
    _lastDiagnostics = {
      profile: MODE_LABELS[_mode],
      densityPct: _densityPct,
      allocationStrategy: _allocationStrategy,
      viewScale: viewScaleForAltitude(altitude),
      candidateCount: _lastSolveSnapshot.cohortCount,
      observationCount: sampledCount,
      candidatesByLayer: _lastSolveSnapshot.cohortByLayer,
      demandByLayer: _lastSolveSnapshot.demandByLayer,
      cohortByLayer: _lastSolveSnapshot.cohortByLayer,
      cohortCount: _lastSolveSnapshot.cohortCount,
      placementBuildCount,
      selectedCount,
      fadingCount,
      didSolve,
      visibleCount,
      bracketOpacityCounts,
      aircraftBracketSectors,
      bracketPresentationOpacity,
      protectedVisibleCount,
      collectiveLabelBudget: collectiveBudget,
      ambientLabelBudget: ambientBudget,
      labelsByLayer: arbiterDiagnostics.labelsByLayer || {},
      entitlementByLayer: arbiterDiagnostics.quotas || {},
      labeledKeys: Array.from(_labelArbiter.selectedKeys),
      labelAlphaByKey: Object.fromEntries(renderEntries.map((entry) => [
        entry.candidate.key,
        entry.temporalAlpha * keyholeLabelAlphaFromGeometry(
          entry.placement.centerX,
          entry.placement.centerY,
          keyhole,
        ),
      ])),
      solveRevision: _labelArbiter.solveRevision,
      keyholeRadius: keyhole.radius,
      keyholeFeatherPx: keyhole.featherPx,
      calloutOcclusionCount: calloutOcclusionRects.length,
    };
  } else {
    const selectedCount = _labelArbiter.selectedKeys.size;
    _lastDiagnostics.placementBuildCount = placementBuildCount;
    _lastDiagnostics.observationCount = sampledCount;
    _lastDiagnostics.selectedCount = selectedCount;
    _lastDiagnostics.fadingCount = fadingCount;
    _lastDiagnostics.didSolve = false;
    _lastDiagnostics.visibleCount = visibleCount;
    _lastDiagnostics.bracketOpacityCounts = bracketOpacityCounts;
    _lastDiagnostics.aircraftBracketSectors = aircraftBracketSectors;
    _lastDiagnostics.bracketPresentationOpacity = bracketPresentationOpacity;
    _lastDiagnostics.protectedVisibleCount = protectedVisibleCount;
  }

  _drawScanlines(width, height, now);
  _drawSparseFocusRing(width, height);
  _drawModeBanner(visibleCount, sampledCount);
  // `_labelSolveDirty` surviving a paint means the solve was owed and did not
  // run — the frame that carried the request cannot be the last one.
  return { didSolve, solveMs, fadingCount, animatingCount, solvePending: _labelSolveDirty };
}
