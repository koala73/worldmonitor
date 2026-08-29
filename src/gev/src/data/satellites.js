import * as Cesium from 'cesium';
import { twoline2satrec, propagate, gstime, eciToGeodetic, degreesLong, degreesLat } from 'satellite.js';
import { registerPickOwner, unregisterPickOwner, isOwnedByOtherLayer, resolvePickId } from './pickRegistry.js';
import { findNextIssPass } from './issPass.js';
import {
  advanceSpriteFocus,
  clearFocusTarget,
  focusAlphaNeedsWrite,
  focusNowMs,
  focusPassIsNeeded,
  getFocusTarget,
  nearFarScalarValueAtDistance,
  publishFocusTargetFromCachedPosition,
} from './focusDeemphasis.js';
import { refreshTrackedReadout } from './trackedReadout.js';
import {
  satelliteClassColor,
  satelliteClassLabel,
  satelliteClassLegend,
  tallySatelliteClasses,
} from './satelliteClass.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  clearTrackedSubjectContext,
  getContextStore,
  refreshTrackedSubjectContext,
  selectTrackedSubjectContext,
} from './contextStore.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { isExplicitLayerStateOrigin } from './layerState.js';

/**
 * Satellite Orbits — Real-time positions via CelesTrak TLE + SGP4 propagation.
 *
 * Loads six CelesTrak groups (~840 sats): stations, visual, GPS, GLONASS,
 * Galileo, and the geosynchronous belt. Optional dense mode (setParams
 * catalog:'dense') adds the Starlink shell as points-only extras.
 * Renders positions via PointPrimitiveCollection, orbital paths as polylines.
 * Click any satellite to track it with camera follow + orbital path.
 *
 * ISS gets special treatment: larger point, persistent host label, path shown by default.
 */

const ISS_NORAD = 25544;
export const ISS_OVERLAY_SOURCE_ID = 'satellites-iss';
export const ISS_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: true,
  solveIntervalMs: 125,
});
const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});
let _overlayHost = DEFAULT_OVERLAY_HOST;
const ORBIT_PATH_STEPS = 180;  // points per orbital path
const POSITION_UPDATE_MS = 1000; // re-propagate every 1s (SGP4 is smooth at this rate)
const RING_ROTATION_MS = 1000;   // re-align baked orbit rings to current GMST every 1s

/**
 * CelesTrak groups loaded as the core catalog, in dedupe-priority order:
 * a satellite that appears in multiple groups keeps the FIRST (most specific)
 * tag. `path` is the upstream GROUP name forwarded by the /api/celestrak
 * proxy; `tag` is the internal group key used for POINT_STYLES lookup.
 * Note: CelesTrak's GLONASS group is named 'glo-ops' (not
 * 'glonass-operational' — that name 404s upstream).
 */
const CATALOG_GROUPS = [
  { tag: 'stations', path: 'stations' },
  { tag: 'visual', path: 'visual' },
  { tag: 'gps-ops', path: 'gps-ops' },
  { tag: 'glonass', path: 'glo-ops' },
  { tag: 'galileo', path: 'galileo' },
  { tag: 'geo', path: 'geo' },
];

// Dense-catalog mode (setParams({ catalog: 'dense' })): Starlink shell as
// points-only extras — no labels, no detection-overlay participation, and a
// relaxed propagation budget (round-robin, ~1/5 of core cadence per sat).
const DENSE_GROUP_PATH = 'starlink';
const DENSE_REFRESH_FRAMES = 300;  // full dense pass spread over ~300 frames (~5s @ 60fps)
const DENSE_CREATE_CHUNK = 1500;   // satrec builds per macro-task while loading

/**
 * Tracked-entity camera offset, east-north-up meters (Entity.viewFrom).
 * Magnitude ≈ 726 km — the user-validated "slightly zoomed out" framing for
 * LEO: far enough that per-frame satellite motion doesn't stutter the camera
 * or smear the label, with +Z biasing the view down onto the satellite.
 * High orbits (MEO nav / GEO belt) scale this up so the ring stays in frame.
 */
const TRACK_VIEW_FROM_LEO = new Cesium.Cartesian3(-450000, -450000, 350000);
const HIGH_ORBIT_ALTITUDE_M = 2000000;
const TRACK_VIEW_FROM_HIGH_SCALE = 4; // ≈ 2900 km back for MEO/GEO

/**
 * Shared per-group point styling — single source of truth used by BOTH the
 * creation site (update) and tracking restore (_clearTracking) so deselecting
 * a satellite never loses the original palette (WS-D3).
 *
 * Colors come from `satelliteClass.js` so the dot, the class label on the
 * card, and the legend swatch on the layer row can never disagree. Only
 * pixelSize/outline live here — those encode per-group prominence, not class.
 * Converted once at module load; per-point color is a plain primitive
 * attribute, so classification costs nothing per frame.
 */
const POINT_OUTLINE = Cesium.Color.WHITE.withAlpha(0.3);
const _classColor = (group) => Cesium.Color.fromCssColorString(satelliteClassColor(group));

const POINT_STYLES = {
  // The ISS keeps its own long-standing red hero styling rather than the
  // STATION class color: it is the object most users open this layer for, it
  // carries a permanent name label, and its size/outline already set it apart.
  // Its card still reads "STATION · ISS", so the class stays legible.
  iss: {
    pixelSize: 12,
    color: Cesium.Color.fromCssColorString('#ff4444'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 2,
  },
  stations: {
    pixelSize: 8,
    color: _classColor('stations'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  visual: {
    pixelSize: 6,
    color: _classColor('visual'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  // Nav constellations (GPS / GLONASS / Galileo) resolve to one shared NAV
  // color; 6px so the MEO shells read as clearly as the old visual group did.
  'gps-ops': {
    pixelSize: 6,
    color: _classColor('gps-ops'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  glonass: {
    pixelSize: 6,
    color: _classColor('glonass'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  galileo: {
    pixelSize: 6,
    color: _classColor('galileo'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  geo: {
    pixelSize: 5,
    color: _classColor('geo'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  // Dense-mode extras (Starlink): dim, small, points-only.
  dense: {
    pixelSize: 3,
    color: _classColor('dense').withAlpha(0.9),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
};

/**
 * Resolve the canonical point style for a satellite.
 * @param {number} noradId NORAD catalog number.
 * @param {string|undefined} group Catalog group tag (see CATALOG_GROUPS / 'dense').
 * @returns {{ pixelSize: number, color: Cesium.Color, outlineColor: Cesium.Color, outlineWidth: number }}
 */
function _pointStyleFor(noradId, group) {
  if (noradId === ISS_NORAD) return POINT_STYLES.iss;
  return POINT_STYLES[group] || POINT_STYLES.visual;
}

// Satellite catalog: { noradId → { name, satrec, group } }
let _catalog = new Map();
let _pointCollection = null;
let _points = new Map();          // noradId → point primitive
/** Stable lightweight records reused by the detection overlay between updates. */
let _detectionObjects = new Map();
// noradId → { primitive, gmstAtBake }
// primitive is a one-instance Cesium.Primitive holding the ring baked in ECEF
// at gmstAtBake; the preRender tick re-aligns it to current GMST by updating
// its modelMatrix (rigid Z-rotation — no geometry rebuild, WS-D1).
let _orbitPaths = new Map();
let _count = 0;
let _lastUpdate = null;
/** @type {string|null} Surfaced feed error (e.g. CelesTrak outage) for the layer chip. */
let _lastError = null;
const _activeUpdateControllers = new Set();
let _denseLoadController = null;

function _abortActiveUpdates() {
  for (const controller of _activeUpdateControllers) controller.abort();
  _activeUpdateControllers.clear();
  _denseLoadController?.abort();
  _denseLoadController = null;
}
let _viewer = null;
let _preRenderListener = null;
let _lastPropagation = 0;
let _lastRingRotation = 0;
let _lastFocusUpdate = 0;
/** Points whose animated emphasis remains outside the 1.0 deadband. */
let _activeFocusCount = 0;
const _scratchFocusScreen = new Cesium.Cartesian2();
let _enabled = false;

// Click-to-track state
let _trackedNorad = null;
let _pendingTrackingRestore = null;
let _trackingIntentGeneration = 0;
let _trackingRefreshEpoch = 0;
let _lastTrackingRefreshOutcome = {
  epoch: 0,
  status: 'unavailable',
  failedGroups: [],
};
let _trackedEntity = null;
let _clickHandler = null;
/** @type {Cesium.Event.RemoveCallback|null} trackedEntityChanged listener disposer (cross-layer untrack) */
let _trackedEntityChangedRemove = null;

// Runtime params (DataLayerManager.setLayerParams path)
let _params = { catalog: 'core', showPoints: true, showOrbits: true }; // 'core' | 'dense'
let _denseIds = [];      // norad ids of dense extras, round-robin order
let _denseCursor = 0;    // next dense id to re-propagate
let _denseLoadToken = 0; // invalidates in-flight dense loads on mode flip/reload
let _denseLoadPromise = null;

/**
 * Dense-load lifecycle: 'idle' → 'loading' → 'ready' | 'failed'.
 * The catalog param flips synchronously but the Starlink shell arrives over
 * seconds and can fail outright (CelesTrak 502s this feed regularly), so the
 * row chip reports THIS, not the param. An active chip must mean dense points
 * are actually on screen.
 */
let _denseStatus = 'idle';
/** @type {string|null} Why the last dense load failed, for the chip tooltip. */
let _denseError = null;
/** Bumped on every bulk catalog mutation; keys the row-legend tally cache. */
let _catalogRevision = 0;
let _classTallyCache = { revision: -1, counts: null };
/** @type {(() => void)|null} Manager callback: "this layer's row controls changed". */
let _rowControlsListener = null;

/** Tell the manager to re-render this layer's row (chip state / legend counts). */
function _notifyRowControls() {
  try {
    _rowControlsListener?.();
  } catch (error) {
    console.warn('[Data:Satellites] row-controls listener failed:', error);
  }
}

/**
 * Per-class tally for the row legend, cached against the catalog revision.
 * Without the cache this scans ~10.7k entries in dense mode on every panel
 * refresh, and any layer polling on the 1s stats timer refreshes the panel.
 * @returns {Record<string, number>} Class key → count.
 */
function _classTally() {
  if (_classTallyCache.counts && _classTallyCache.revision === _catalogRevision) {
    return _classTallyCache.counts;
  }
  const entries = [];
  // Pass the ISS flag, not just the group: during a stations-feed outage the
  // ISS is ingested as `visual`, and the legend must file it exactly where its
  // card does (STATION) rather than letting STATION vanish from the legend.
  for (const [noradId, sat] of _catalog) {
    entries.push({ group: sat.group, isIss: noradId === ISS_NORAD });
  }
  const counts = tallySatelliteClasses(entries);
  _classTallyCache = { revision: _catalogRevision, counts };
  return counts;
}

/**
 * Satellite preferences may be restored while the layer is disabled (for
 * example, when Space Missions releases its dependency). Preferences must not
 * revive render primitives until the layer is explicitly enabled again.
 * @param {boolean} layerEnabled Whether the Satellite layer is enabled.
 * @param {boolean} requestedVisible Whether the current presentation requests visibility.
 * @returns {boolean} Whether a primitive should be visible now.
 */
export function satelliteVisualsVisible(layerEnabled, requestedVisible) {
  return Boolean(layerEnabled) && Boolean(requestedVisible);
}

/**
 * Decide whether a valid catalog request represents a real mode transition.
 * Reapplying an already-active mode must not restart the dense TLE load.
 * @param {'core'|'dense'} currentCatalog Current catalog mode.
 * @param {string|undefined} requestedCatalog Requested catalog mode.
 * @returns {boolean} Whether the catalog mode should change.
 */
export function satelliteCatalogModeChanged(currentCatalog, requestedCatalog) {
  return (requestedCatalog === 'core' || requestedCatalog === 'dense')
    && requestedCatalog !== currentCatalog;
}

/** Build the persistent ISS ambient label from the cached point position. */
export function createIssOverlayEntry(position) {
  return {
    id: String(ISS_NORAD),
    position,
    variant: 'label',
    title: 'ISS',
    accent: '#ff4444',
    priority: 1000,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    distanceScale: {
      near: 1_000_000,
      nearValue: 1,
      far: 30_000_000,
      farValue: 0.4,
    },
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/** Cached ISS point only; never performs a fresh SGP4 propagation. */
function _issDisplayCached() {
  return _points.get(ISS_NORAD)?.position || null;
}

/**
 * Physically DOCKED vehicles are separate real tracks sharing one position: the
 * station and everything berthed to it sit within metres of each other. Their
 * ambient labels therefore stack underneath the tracked card, which is what the
 * owner saw. This radius is deliberately tight — it must catch a docked stack
 * and nothing else, so an unrelated satellite in a similar orbit is never
 * suppressed. Formation-flying pairs are km apart; a docked stack is ~100 m.
 */
const DOCKED_COMPANION_RADIUS_M = 2000;
/** The scan is O(points); the tracked label is rebuilt every frame, so throttle. */
const DOCKED_SCAN_INTERVAL_MS = 1000;
/** @type {Set<number>} NORAD ids co-located with the tracked satellite. */
let _dockedCompanions = new Set();
let _lastDockedScanMs = Number.NEGATIVE_INFINITY;

/**
 * Rebuild the docked-companion set for the tracked satellite.
 * @returns {boolean} true when membership changed (callers resync presentation).
 */
function _refreshDockedCompanions(nowMs) {
  const trackedPosition = _trackedNorad === null ? null : _trackedDisplayCached();
  if (!trackedPosition) {
    if (_dockedCompanions.size === 0) return false;
    _dockedCompanions = new Set();
    return true;
  }
  if (nowMs - _lastDockedScanMs < DOCKED_SCAN_INTERVAL_MS) return false;
  _lastDockedScanMs = nowMs;
  const radiusSq = DOCKED_COMPANION_RADIUS_M * DOCKED_COMPANION_RADIUS_M;
  let changed = false;
  let found = 0;
  const next = new Set();
  for (const [noradId, point] of _points) {
    if (noradId === _trackedNorad || !point?.position) continue;
    const dx = point.position.x - trackedPosition.x;
    const dy = point.position.y - trackedPosition.y;
    const dz = point.position.z - trackedPosition.z;
    if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
    next.add(noradId);
    found++;
    if (!_dockedCompanions.has(noradId)) changed = true;
  }
  if (found !== _dockedCompanions.size) changed = true;
  if (changed) _dockedCompanions = next;
  return changed;
}

/** Names of the docked companions, stable-sorted so the card text never churns. */
function _dockedCompanionNames() {
  const names = [];
  for (const noradId of _dockedCompanions) {
    names.push(_catalog.get(noradId)?.name?.trim() || `SAT-${noradId}`);
  }
  return names.sort();
}

/** Keep persistent ISS text mutually exclusive with the tracked host card. */
function _syncIssOverlay() {
  // Hidden when ISS is the tracked subject, and equally when ISS is DOCKED to
  // whatever is tracked: its ambient label would otherwise sit underneath the
  // tracked card at the same position.
  const visible = _enabled && _params.showOrbits && _trackedNorad !== ISS_NORAD
    && !_dockedCompanions.has(ISS_NORAD)
    && _catalog.has(ISS_NORAD) && _issDisplayCached();
  if (!visible) {
    _overlayHost.clearSource(ISS_OVERLAY_SOURCE_ID);
    _overlayHost.setVisible(ISS_OVERLAY_SOURCE_ID, false);
    return;
  }
  _overlayHost.setEntries(
    ISS_OVERLAY_SOURCE_ID,
    [createIssOverlayEntry(_issDisplayCached)],
    ISS_OVERLAY_SOURCE_OPTIONS,
  );
  _overlayHost.setVisible(ISS_OVERLAY_SOURCE_ID, true);
}

// Per-frame cache for the tracked satellite (WS-D2): dot, host readout, camera, and
// getTrackedInfo all read one SGP4 sample per rendered frame, keyed on
// scene.frameState.frameNumber, so they never diverge in epoch.
let _trackedFrameNumber = -1;
let _trackedFrameGeo = null; // { longitude, latitude, altitude } or null
const _trackedFrameCartesian = new Cesium.Cartesian3();
/** Optional deterministic clock used only by the production-frame test seam. */
let _trackedFrameNowForTest = null;

// Scratch variables
const _scratchCartesian = new Cesium.Cartesian3();
const _scratchRingRotation = new Cesium.Matrix3();

/**
 * Build the rigid ECEF transform that keeps an orbit path baked at one GMST
 * aligned with live SGP4 positions propagated at another epoch.
 * @param {number} gmstAtBake GMST used when the path positions were baked.
 * @param {Date} nowDate Epoch whose rotating-Earth frame should be displayed.
 * @param {Cesium.Matrix4} [result] Optional matrix to update in place.
 * @returns {Cesium.Matrix4} Z-rotation from bake-time ECEF to current ECEF.
 */
export function orbitFrameModelMatrix(
  gmstAtBake,
  nowDate,
  result = new Cesium.Matrix4(),
) {
  const deltaGmst = gstime(nowDate) - gmstAtBake;
  const rotation = Cesium.Matrix3.fromRotationZ(-deltaGmst, _scratchRingRotation);
  return Cesium.Matrix4.fromRotationTranslation(
    rotation,
    Cesium.Cartesian3.ZERO,
    result,
  );
}

/**
 * Parse TLE text into array of { name, line1, line2 } objects.
 */
function parseTLE(text) {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const result = [];
  for (let i = 0; i < lines.length - 2; i += 3) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (line1.startsWith('1 ') && line2.startsWith('2 ')) {
      result.push({ name, line1, line2 });
    }
  }
  return result;
}

/**
 * Propagate satellite position at a given JS Date.
 * Returns geodetic position plus inertial speed from the same SGP4 propagation
 * epoch, or null on error.
 */
function propagatePosition(satrec, date) {
  try {
    const posVel = propagate(satrec, date);
    if (!posVel.position || typeof posVel.position === 'boolean') return null;

    const gmst = gstime(date);
    const geo = eciToGeodetic(posVel.position, gmst);
    const velocity = posVel.velocity && typeof posVel.velocity !== 'boolean'
      ? posVel.velocity
      : null;
    const speedMps = velocity
      ? Math.hypot(velocity.x, velocity.y, velocity.z) * 1000
      : null;

    return {
      longitude: degreesLong(geo.longitude),
      latitude: degreesLat(geo.latitude),
      altitude: geo.height * 1000, // km → meters
      speedMps: Number.isFinite(speedMps) ? speedMps : null,
    };
  } catch {
    return null;
  }
}

function orbitalPeriodSeconds(satrec) {
  const meanMotion = satrec.no * (1440 / (2 * Math.PI));
  return 86400 / Math.max(meanMotion, 0.1);
}

/**
 * Compute full orbital path as array of Cartesian3 positions.
 * Steps around one full orbit based on the satellite's mean motion.
 */
function computeOrbitPath(satrec, referenceDate) {
  const periodSec = orbitalPeriodSeconds(satrec);
  const stepSec = periodSec / ORBIT_PATH_STEPS;

  const positions = [];
  const baseTime = referenceDate.getTime();
  // Fix GMST to reference time so the orbital ring closes.
  // Without this, Earth rotation during the orbit period (~24° for LEO)
  // shifts the end point west of the start, leaving a visible gap.
  const fixedGmst = gstime(referenceDate);

  for (let i = 0; i <= ORBIT_PATH_STEPS; i++) {
    const t = new Date(baseTime + i * stepSec * 1000);
    try {
      const posVel = propagate(satrec, t);
      if (!posVel.position || typeof posVel.position === 'boolean') continue;
      const geo = eciToGeodetic(posVel.position, fixedGmst);
      positions.push(Cesium.Cartesian3.fromDegrees(
        degreesLong(geo.longitude),
        degreesLat(geo.latitude),
        geo.height * 1000
      ));
    } catch { continue; }
  }

  return positions;
}

/**
 * Show orbital path for a satellite.
 *
 * RING FLICKER FIX: this is a one-instance Cesium.Primitive built
 * synchronously ONCE (asynchronous: false), then re-aligned to current GMST
 * each tick via its modelMatrix. The previous Entity-polyline approach
 * rebuilt geometry ASYNCHRONOUSLY on every positions assignment, which made
 * both the selected ring and the ISS ring blink once per second while the
 * rebuild was in flight. A rigid Z-rotation needs no rebuild at all.
 *
 * Why not a CallbackProperty entity (dynamic mode)? Verified in Cesium
 * 1.138 source: the dynamic polyline updater renders through a shared
 * PolylineCollection and applies only the fill material —
 * `depthFailMaterial` is silently dropped, losing the dimmed behind-Earth
 * segment. The Primitive keeps it via depthFailAppearance + the per-instance
 * depthFailColor attribute (same mechanism the entity STATIC batch uses):
 * bright where above the horizon, dimmed where behind the globe.
 */
function _showOrbitPath(noradId, color) {
  if (_orbitPaths.has(noradId)) return; // already showing

  const sat = _catalog.get(noradId);
  if (!sat || !_viewer) return;

  const bakeDate = new Date();
  const basePositions = computeOrbitPath(sat.satrec, bakeDate);
  if (basePositions.length < 2) return;

  const pathColor = color || Cesium.Color.CYAN;

  const primitive = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.PolylineGeometry({
        positions: basePositions,
        width: noradId === ISS_NORAD ? 2.5 : 2.0,
        vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(pathColor.withAlpha(0.6)),
        depthFailColor: Cesium.ColorGeometryInstanceAttribute.fromColor(pathColor.withAlpha(0.35)),
      },
    }),
    appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
    depthFailAppearance: new Cesium.PolylineColorAppearance({ translucent: true }),
    asynchronous: false, // build this frame — no async-rebuild blink window
    allowPicking: false, // ring clicks fall through to satellites/deselect
  });
  _viewer.scene.primitives.add(primitive);

  _orbitPaths.set(noradId, {
    primitive,
    // Same Date object as computeOrbitPath's internal fixedGmst → identical
    // GMST value (gstime is pure), so delta starts at exactly 0 and the
    // initial identity modelMatrix is correct until the first ring tick.
    gmstAtBake: gstime(bakeDate),
  });
}

/**
 * Rotate every baked orbit ring from its bake-time ECEF snapshot to current
 * GMST (WS-D1). The baked ring is an inertial-frame snapshot frozen at
 * gmstAtBake; the live dot lives in true rotating-frame ECEF, so without this
 * the dot slides west off the ring at Earth-rotation rate (~0.25°/min).
 *
 * Sign derivation: a point fixed in inertial space keeps its right ascension
 * α, so its ECEF longitude λ = α − gmst DECREASES by ΔGMST as time advances
 * (it drifts WEST). Cesium.Matrix3.fromRotationZ(θ) rotates +X toward +Y,
 * i.e. INCREASES longitude by θ — so we rotate the baked points by −ΔGMST.
 * Mental check: ISS baked over Austin at t0; 10 min later Austin has rotated
 * east under the (inertial) ring, so the ring must sit further WEST in ECEF.
 *
 * Wraparound: gstime returns radians in [0, 2π), so the raw difference can be
 * off from the continuous ΔGMST — but only by exact multiples of 2π, which a
 * rotation cannot distinguish. Tiny negative deltas right after bake are
 * likewise harmless. No unwrapping needed.
 *
 * No SGP4 here — the rotation is applied as the ring primitive's modelMatrix
 * (exact compensation; WGS84 is rotationally symmetric about Z, so rotating
 * the baked curve rigidly equals rebaking from rotated points). modelMatrix
 * updates are synchronous uniforms — no geometry rebuild, no flicker. Post-
 * creation modelMatrix changes are supported for one-instance primitives in
 * 3D mode, which these rings are. In-place mutation is safe: Primitive.update
 * diffs modelMatrix against an internal clone.
 * @param {Date} nowDate Epoch used for current GMST.
 */
function _updateOrbitPathRotations(nowDate) {
  if (_orbitPaths.size === 0) return;

  for (const path of _orbitPaths.values()) {
    if (!path.primitive) continue;
    orbitFrameModelMatrix(path.gmstAtBake, nowDate, path.primitive.modelMatrix);
  }
}

/**
 * Remove orbital path for a satellite.
 */
function _hideOrbitPath(noradId) {
  const path = _orbitPaths.get(noradId);
  if (path) {
    if (_viewer) _viewer.scene.primitives.remove(path.primitive); // remove() destroys
    _orbitPaths.delete(noradId);
  }
}

function _normalizeTrackedNorad(candidate) {
  const numeric = Number(candidate);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.trunc(numeric);
  return rounded > 0 ? rounded : null;
}

function _emitAwarenessEvent(type, detail) {
  if (typeof window === 'undefined' || !window.dispatchEvent || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function _applyPendingTrackingRestore() {
  const pending = _pendingTrackingRestore;
  if (!pending || pending.generation !== _trackingIntentGeneration || !_enabled) return false;
  if (!_viewer || !_catalog.has(pending.id) || !_points.has(pending.id)) return false;
  _pendingTrackingRestore = null;
  _trackSatellite(pending.id, { origin: pending.origin });
  return _trackedNorad === pending.id;
}

function _cancelPendingTrackingRestore() {
  _trackingIntentGeneration += 1;
  _pendingTrackingRestore = null;
}

/**
 * Stop tracking the currently followed satellite.
 * @param {boolean} [skipViewerUntrack=false] - When ANOTHER layer just grabbed
 *   the follow-camera (viewer.trackedEntityChanged), tear down our own state
 *   but do NOT clear viewer.trackedEntity — the new owner controls it now,
 *   and clearing it would yank the camera off their target (mirror of flights).
 */
function _clearTracking(skipViewerUntrack = false, { origin = 'programmatic' } = {}) {
  // Untracking dissolves the cluster: every companion returns to its own
  // ambient label on the next collection.
  _dockedCompanions = new Set();
  _lastDockedScanMs = Number.NEGATIVE_INFINITY;
  if (!_trackedNorad) {
    clearFocusTarget('satellites');
    _syncIssOverlay();
    return;
  }
  const clearedNorad = _trackedNorad;
  clearFocusTarget('satellites', _trackedNorad);

  const lastPos = _points.get(_trackedNorad);

  // Re-show the primitive (hidden while the tracked entity rendered the dot)
  // and restore the original group palette from the shared style table (WS-D3)
  if (lastPos) {
    const style = _pointStyleFor(_trackedNorad, _catalog.get(_trackedNorad)?.group);
    lastPos.show = true;
    lastPos.pixelSize = style.pixelSize;
    lastPos.color = style.color;
    lastPos.outlineColor = style.outlineColor;
    lastPos.outlineWidth = style.outlineWidth;
    lastPos.disableDepthTestDistance = 0;
  }

  // Invalidate the per-frame tracked-position cache (WS-D2)
  _trackedFrameNumber = -1;
  _trackedFrameGeo = null;

  // Remove tracked entity and orbit path (unless ISS — keep its path)
  if (_trackedNorad !== ISS_NORAD) {
    _hideOrbitPath(_trackedNorad);
  }
  if (_viewer && !skipViewerUntrack) _viewer.trackedEntity = undefined;
  if (_trackedEntity) {
    _viewer.entities.remove(_trackedEntity);
    _trackedEntity = null;
  }
  _trackedNorad = null;
  _syncIssOverlay();
  clearTrackedSubjectContext('satellites');
  _contextRefreshedAtMs = 0;
  _emitAwarenessEvent('gev:awareness-subject-cleared', {
    layerId: 'satellites', id: clearedNorad, origin,
  });
}

/**
 * Get the tracked satellite's geodetic position, propagated at most once per
 * rendered frame (WS-D2). All tracked-satellite consumers (entity position
 * callback → camera, host model, point primitive, getTrackedInfo) share this
 * single `new Date()` epoch per frame, so they can never diverge by the old
 * 200ms throttle. The matching ECEF position is left in
 * `_trackedFrameCartesian`. SGP4 for one satellite per frame is cheap.
 * @returns {{ longitude: number, latitude: number, altitude: number }|null}
 */
function _getTrackedFramePosition() {
  if (_trackedNorad === null) return null;
  const sat = _catalog.get(_trackedNorad);
  if (!sat) return null;

  const frameNumber = _viewer?.scene?.frameState?.frameNumber ?? -1;
  if (frameNumber === -1 || frameNumber !== _trackedFrameNumber || _trackedFrameGeo === null) {
    const pos = propagatePosition(
      sat.satrec,
      _trackedFrameNowForTest ? new Date(_trackedFrameNowForTest()) : new Date(),
    );
    if (!pos) return _trackedFrameGeo; // propagation hiccup — keep last good sample
    _trackedFrameGeo = pos;
    Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, pos.altitude, undefined, _trackedFrameCartesian);
    _trackedFrameNumber = frameNumber;
    // Throttled inside; membership changes are rare, so resync the ISS ambient
    // gate only when the cluster actually changed.
    const clusterChanged = _refreshDockedCompanions(
      _trackedFrameNowForTest ? _trackedFrameNowForTest() : Date.now(),
    );
    _updateTrackedSatelliteLabelModel();
    // The card and the context slot describe the same satellite — keep them
    // together so voice never narrates a fix the card has already replaced.
    _refreshTrackedSubjectContext();
    if (clusterChanged) _syncIssOverlay();
    const name = sat.name?.trim() || `SAT-${_trackedNorad}`;
    const altitudeText = `${Math.round(pos.altitude / 1000)} km · NORAD ${_trackedNorad}`;
    const labelWidthPx = Math.max(name.length, altitudeText.length) * 7.8 + 20;
    const labelHeightPx = 2 * 13 + 12;
    const trackedPointDiameterPx = 14 + 4; // point plus its 2 px outline on both sides
    // Exact SGP4 frame cache only: dot, host readout, camera, and focus rectangle all
    // share one epoch, avoiding a second propagation phase and its old jitter.
    publishFocusTargetFromCachedPosition({
      ownerLayer: 'satellites',
      id: _trackedNorad,
      scene: _viewer?.scene,
      camera: _viewer?.camera,
      displayPosition: _trackedFrameCartesian,
      widthPx: Math.max(trackedPointDiameterPx, Math.min(260, labelWidthPx)),
      // Union of the 14 px point and the two-line label shifted 18 px upward.
      heightPx: trackedPointDiameterPx + 18 + labelHeightPx,
    });
  }
  return _trackedFrameGeo;
}

/** Cached ECEF display point only; never propagates a fresh SGP4 sample. */
function _trackedDisplayCached() {
  return _trackedFrameGeo ? _trackedFrameCartesian : null;
}

/** Update the explicit model only when the rounded altitude line changes. */
/** Epoch of the last shared-context refresh for the tracked satellite. */
let _contextRefreshedAtMs = 0;
/**
 * Shared-context refresh interval. The tracked satellite is re-propagated
 * every rendered frame; the voice context only needs to be current to about
 * the propagation cadence, so this refreshes on the same 1 s beat instead of
 * allocating a record 60 times a second.
 */
const CONTEXT_REFRESH_INTERVAL_MS = 1000;

/**
 * Describe the tracked satellite for the shared context slot the voice tools
 * read. Values come from the live per-frame propagation, not a selection-time
 * snapshot, so a long follow never narrates a position the satellite has left.
 * @param {number} noradId Catalog identity.
 * @param {{latitude: number, longitude: number, altitude: number}|null} [position]
 *   Explicit position; defaults to the current per-frame propagation.
 * @returns {object|null} Context metadata, or null when the satellite is gone.
 */
function _contextSubjectMetadata(noradId, position = null) {
  const sat = _catalog.get(noradId);
  if (!sat) return null;
  const pos = position || _getTrackedFramePosition();
  if (!pos) return null;
  const name = sat.name?.trim() || `SAT-${noradId}`;
  const altitudeKm = Number.isFinite(pos.altitude) ? Math.round(pos.altitude / 1000) : null;
  return {
    id: String(noradId),
    layerId: 'satellites',
    layerName: 'Satellites',
    source: 'CelesTrak',
    label: name,
    latitude: pos.latitude,
    longitude: pos.longitude,
    // Flat text only: the voice payload compacts properties through a string
    // cleaner that drops nested objects.
    properties: {
      name,
      operator: '',
      noradId: String(noradId),
      class: satelliteClassLabel(sat.group, { isIss: noradId === ISS_NORAD }),
      altitude: altitudeKm === null ? '' : `${altitudeKm.toLocaleString('en-US')} km`,
    },
  };
}

/**
 * Reconcile the published subject with a freshly rebuilt catalog.
 *
 * A rebuild (dense↔core toggle, TLE refresh) clears and repopulates the
 * catalog, so the tracked satellite's entry is a NEW object with a new satrec.
 * A surviving subject is simply re-resolved against it. A subject that is GONE
 * must release the slot: the per-frame refresh cannot do this itself, because
 * `_getTrackedFramePosition` returns early once the satellite has no catalog
 * entry — so without this the record would linger and voice would narrate a
 * satellite the catalog no longer carries, frozen at its last position.
 *
 * Releasing is gated on PROOF. The subject is preserved unless it is absent
 * from a catalog that is both complete (`accepted`, no failed CelesTrak group)
 * and applicable (dense settled, when dense is the requested catalog). A
 * partial refresh, a failed dense load, or an empty catalog is unproven
 * absence, and unproven absence is not absence — the same honesty rule the
 * tracking-restore path already applies.
 * @returns {Promise<void>} Resolves once the applicable catalog has settled.
 */
async function _reconcileTrackedSubjectContext() {
  const subjectAtStart = _trackedNorad;
  if (subjectAtStart === null) return;
  // Dense extras land AFTER the core rebuild resolves. Deciding before they
  // settle called a dense subject missing and deleted its record; the record
  // then stayed gone, because a refresh can update an existing record but
  // cannot recreate one.
  const denseSettlement = _params.catalog === 'dense' ? _denseLoadPromise : null;
  if (denseSettlement) {
    try {
      await denseSettlement;
    } catch {
      // A failed dense load proves nothing about the subject; fall through and
      // let the outcome check below preserve it.
    }
  }
  // The operator may have moved on while we waited.
  if (_trackedNorad !== subjectAtStart) return;

  const metadata = _contextSubjectMetadata(subjectAtStart);
  if (metadata) {
    const store = getContextStore();
    const key = String(subjectAtStart);
    if (store.entities.has(key)) {
      refreshTrackedSubjectContext(metadata);
    } else if (!store.selectedEntityId) {
      // The record was dropped while the subject was briefly unresolvable.
      // Restore it — but only into an EMPTY slot: a satellite reappearing must
      // never yank the subject away from something the operator selected since.
      selectTrackedSubjectContext(metadata);
    }
    _contextRefreshedAtMs = Date.now();
    return;
  }

  // Absence only counts when EVERY catalog that could carry the subject
  // actually loaded. Unproven absence is not absence — the same honesty rule
  // the tracking-restore path applies.
  //
  // Deliberately NOT scoped to the group the subject was last seen in:
  // CelesTrak reclassifies satellites between groups, so a subject missing
  // from its old group may simply have moved to one that failed this refresh.
  // Believing the old group alone would drop it. Any failed or empty group is
  // therefore a reason to wait — and `accepted` already means every group
  // returned entries.
  if (_catalog.size === 0) return;
  if (_lastTrackingRefreshOutcome?.status !== 'accepted') return;
  // Dense is a potential carrier too whenever it was REQUESTED — and the
  // request is read from `denseSettlement`, captured before the await, not
  // from `_params.catalog` now. A failed dense load reverts the mode to 'core'
  // as part of settling (an ACTIVE chip over an empty sky would be a lie), so
  // by the time we get here the intent that made dense a carrier has been
  // erased. Re-reading it would skip this guard on exactly the runs that need
  // it and delete a subject the dense catalog might have carried.
  if (denseSettlement && _denseStatus !== 'ready') return;
  clearTrackedSubjectContext('satellites');
  _contextRefreshedAtMs = 0;
}

/**
 * Keep the shared context slot current with the tracked satellite, on the
 * propagation beat rather than the frame clock.
 * @returns {void}
 */
function _refreshTrackedSubjectContext() {
  if (_trackedNorad === null) return;
  const now = Date.now();
  if (now - _contextRefreshedAtMs < CONTEXT_REFRESH_INTERVAL_MS) return;
  _contextRefreshedAtMs = now;
  refreshTrackedSubjectContext(_contextSubjectMetadata(_trackedNorad));
}

function _updateTrackedSatelliteLabelModel(fallbackAltitudeM = null) {
  if (!_trackedEntity || _trackedNorad === null) return;
  const sat = _catalog.get(_trackedNorad);
  const title = sat?.name?.trim() || `SAT-${_trackedNorad}`;
  const altitudeM = _trackedFrameGeo?.altitude ?? fallbackAltitudeM;
  const detail = `${Number.isFinite(altitudeM) ? Math.round(altitudeM / 1000) : '?'} km · NORAD ${_trackedNorad}`;
  // Class leads the detail block: it is what tells the operator WHAT they are
  // looking at, and it stays readable under the IR styles that flatten the
  // dot colors to a single channel (the card is painted above post-FX).
  const details = [satelliteClassLabel(sat?.group, { isIss: _trackedNorad === ISS_NORAD }), detail];
  // Docked companions are consolidated onto the tracked card as SECONDARY info
  // instead of competing with it as separate ambient labels. Identities are
  // preserved: the catalog is untouched and every companion returns to its own
  // label the moment the cluster is no longer tracked.
  const companions = _dockedCompanionNames();
  if (companions.length > 0) {
    const extra = companions.length - 1;
    details.push(`DOCKED · ${companions[0]}${extra > 0 ? ` · +${extra}` : ''}`);
  }
  const current = _trackedEntity.gevLabelModel;
  // Compare the WHOLE detail array: comparing only `details[0]` swallowed any
  // change confined to the companions line, so the card would never republish.
  const unchanged = current?.title === title
    && current?.details?.length === details.length
    && details.every((line, index) => current.details[index] === line);
  if (unchanged) return;
  _trackedEntity.gevLabelModel = { title, details, accent: '#ffd84d' };
  refreshTrackedReadout(_trackedEntity);
}

function _trackSatellite(noradId, { origin = 'programmatic' } = {}) {
  _clearTracking(false, { origin });

  const point = _points.get(noradId);
  const sat = _catalog.get(noradId);
  if (!point || !sat) return;

  _trackedNorad = noradId;
  _trackedFrameNumber = -1;
  _trackedFrameGeo = null;
  _syncIssOverlay();

  // Hide the primitive — the tracked ENTITY renders the dot below. The
  // entity must own a point graphic so the Viewer's tracking camera can
  // resolve a bounding sphere and engage viewFrom (a label-only entity
  // left the camera stranded; this mirrors the proven flights pattern).
  point.show = false;

  // Show orbital path
  _showOrbitPath(noradId, Cesium.Color.YELLOW);

  // Tracked entity position propagates per evaluation through the per-frame
  // cache (WS-D2) — dot, host readout, and camera share one SGP4 epoch per frame.
  // Falls back to the point primitive's 1s-throttled position if SGP4 fails.
  const positionProperty = new Cesium.CallbackProperty(() => {
    const pos = _getTrackedFramePosition();
    return pos ? _trackedFrameCartesian : point.position;
  }, false);

  const name = sat.name.trim();

  // Comfortable tracking landing: ~726 km back for LEO (user-validated
  // "slightly zoomed out" framing — no stutter, label reads cleanly), scaled
  // up for MEO/GEO so the camera doesn't land on top of a high-orbit dot.
  const initialPos = propagatePosition(sat.satrec, new Date());
  const viewScale = initialPos && initialPos.altitude > HIGH_ORBIT_ALTITUDE_M
    ? TRACK_VIEW_FROM_HIGH_SCALE
    : 1;
  const viewFrom = Cesium.Cartesian3.multiplyByScalar(
    TRACK_VIEW_FROM_LEO, viewScale, new Cesium.Cartesian3()
  );

  _trackedEntity = _viewer.entities.add({
    position: positionProperty,
    viewFrom,
    point: {
      pixelSize: 14,
      color: Cesium.Color.YELLOW,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
  _trackedEntity.gevSelectionOrigin = origin;
  _trackedEntity.gevTrackedId = `satellites:${noradId}`;
  _trackedEntity.gevDisplayPosition = _trackedDisplayCached;
  _updateTrackedSatelliteLabelModel(initialPos?.altitude ?? null);

  _emitAwarenessEvent('gev:awareness-subject-selected', {
    layerId: 'satellites',
    id: noradId,
    label: name,
    position: Cesium.Cartesian3.clone(point.position),
    origin,
  });
  selectTrackedSubjectContext(_contextSubjectMetadata(noradId, initialPos));
  _contextRefreshedAtMs = Date.now();

  _viewer.trackedEntity = _trackedEntity;
  console.log(`[Data:Satellites] Tracking ${name} (NORAD ${noradId})`);
}

/**
 * Propagate all CORE satellite positions and update point primitives.
 * (~840 sats ≈ 1.6 ms/pass — fine at the 1s/200ms cadence.) Dense extras are
 * excluded: they refresh on the round-robin budget in _propagateDenseChunk.
 */
function _propagateAll() {
  const now = new Date();
  let updated = 0;

  for (const [noradId, sat] of _catalog) {
    if (sat.group === 'dense') continue;
    const pos = propagatePosition(sat.satrec, now);
    if (!pos) continue;

    const cartesian = Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, pos.altitude);
    const point = _points.get(noradId);
    if (point) {
      point.position = cartesian;
      updated++;
    }
  }

  return updated;
}

/**
 * Re-propagate a small per-frame slice of the dense extras (round-robin).
 * Budget: the full dense set completes one pass every ~DENSE_REFRESH_FRAMES
 * frames (~5s at 60fps ≈ 1/5 of the core cadence), so per-frame cost stays
 * ~35 propagations (~0.1 ms) even with 10K+ Starlink sats — spreading the
 * work per frame avoids the once-per-second spike a tick-sized chunk
 * (~2K props ≈ 4ms) would cause.
 */
function _propagateDenseChunk() {
  if (_denseIds.length === 0) return;
  const perFrame = Math.max(1, Math.ceil(_denseIds.length / DENSE_REFRESH_FRAMES));
  const now = new Date();
  for (let i = 0; i < perFrame; i++) {
    if (_denseCursor >= _denseIds.length) _denseCursor = 0;
    const noradId = _denseIds[_denseCursor++];
    if (noradId === _trackedNorad) continue; // per-frame tracked path owns it
    const sat = _catalog.get(noradId);
    const point = _points.get(noradId);
    if (!sat || !point) continue;
    const pos = propagatePosition(sat.satrec, now);
    if (pos) {
      point.position = Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, pos.altitude);
    }
  }
}

/**
 * Load the dense catalog extras (Starlink) as points-only satellites.
 * Chunked so ~10K twoline2satrec builds + initial propagations never block a
 * frame; a token guards against mode flips / catalog rebuilds mid-load.
 */
async function _loadDenseCatalog({ signal = null } = {}) {
  if (!_viewer || !_pointCollection) return { status: 'source-unavailable', reason: 'layer-unavailable' };
  _denseLoadController?.abort();
  const resourceController = new AbortController();
  _denseLoadController = resourceController;
  const loadSignal = signal
    ? AbortSignal.any([signal, resourceController.signal])
    : resourceController.signal;
  const token = ++_denseLoadToken;
  _denseStatus = 'loading';
  _denseError = null;
  _notifyRowControls();
  try {
    loadSignal.throwIfAborted();
    const res = await fetch(`/api/gev/celestrak/${DENSE_GROUP_PATH}`, { signal: loadSignal });
    if (!res.ok) {
      console.warn(`[Data:Satellites] Dense group '${DENSE_GROUP_PATH}' fetch failed (${res.status})`);
      _denseLoadFailed(token, `feed unavailable (${res.status})`);
      return { status: 'source-unavailable', reason: `feed unavailable (${res.status})` };
    }
    const text = await res.text();
    loadSignal.throwIfAborted();
    if (token !== _denseLoadToken || _params.catalog !== 'dense') {
      return { status: 'superseded', reason: 'dense-load-superseded' };
    }

    const entries = parseTLE(text);
    const style = POINT_STYLES.dense;
    const now = new Date();
    let added = 0;

    for (let start = 0; start < entries.length; start += DENSE_CREATE_CHUNK) {
      loadSignal.throwIfAborted();
      if (token !== _denseLoadToken || _params.catalog !== 'dense' || !_pointCollection) {
        return { status: 'superseded', reason: 'dense-load-superseded' };
      }
      const end = Math.min(start + DENSE_CREATE_CHUNK, entries.length);
      for (let i = start; i < end; i++) {
        const entry = entries[i];
        const satrec = twoline2satrec(entry.line1, entry.line2);
        if (!satrec || satrec.error !== 0) continue;
        const noradId = Number(satrec.satnum);
        if (_catalog.has(noradId)) continue; // core catalog keeps priority
        const pos = propagatePosition(satrec, now);
        if (!pos) continue;

        _catalog.set(noradId, { name: entry.name, satrec, group: 'dense' });
        const point = _pointCollection.add({
          position: Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, pos.altitude),
          pixelSize: style.pixelSize,
          color: style.color,
          outlineColor: style.outlineColor,
          outlineWidth: style.outlineWidth,
          scaleByDistance: new Cesium.NearFarScalar(1e6, 1.5, 2e7, 0.6),
          id: noradId,
        });
        _points.set(noradId, point);
        _denseIds.push(noradId);
        added++;
      }
      // Yield to the event loop between chunks.
      await new Promise(resolve => setTimeout(resolve, 0));
      loadSignal.throwIfAborted();
    }

    // A 200 that yields nothing usable is still a failed load — an empty body,
    // an HTML error page the proxy passed through, or a feed of TLEs the core
    // catalog already owns. Treating it as success is the same lie as treating
    // a 502 as success, just through a different door.
    if (added === 0) {
      console.warn(`[Data:Satellites] Dense group '${DENSE_GROUP_PATH}' returned no usable satellites`);
      _denseLoadFailed(token, 'feed returned no satellites');
      return { status: 'source-unavailable', reason: 'feed returned no satellites' };
    }

    _count = _points.size;
    _catalogRevision++;
    _denseStatus = 'ready';
    console.log(`[Data:Satellites] Dense catalog: +${added} ${DENSE_GROUP_PATH} (points only)`);
    // The panel would otherwise keep the pre-load count and legend until the
    // next natural refresh — up to the 5-minute catalog interval.
    _notifyRowControls();
    _applyPendingTrackingRestore();
    return { status: 'ready', added };
  } catch (e) {
    if (loadSignal.aborted || e?.name === 'AbortError') {
      return { status: 'cancelled', reason: String(loadSignal.reason || 'aborted') };
    }
    console.warn('[Data:Satellites] Dense catalog load failed:', e);
    _denseLoadFailed(token, 'feed unreachable');
    return { status: 'source-unavailable', reason: 'feed unreachable' };
  } finally {
    if (_denseLoadController === resourceController) _denseLoadController = null;
  }
}

/**
 * Settle a failed dense load: drop any partial chunk, return the layer to the
 * core catalog, and leave the reason on the chip. Reverting the param is the
 * point — a chip that reads ACTIVE over an empty sky is a lie.
 * @param {number} token The load token that failed.
 * @param {string} reason Short operator-facing cause.
 */
function _denseLoadFailed(token, reason) {
  // A newer load (or a mode flip) already owns the state — say nothing.
  if (token !== _denseLoadToken) return;
  _params.catalog = 'core';
  _removeDenseCatalog();
  _denseStatus = 'failed';
  _denseError = reason;
  _notifyRowControls();
}

/** Remove all dense extras (catalog entries, points, tracking if needed). */
function _removeDenseCatalog() {
  _denseLoadController?.abort();
  _denseLoadController = null;
  _denseLoadToken++; // cancel any in-flight dense load
  if (_trackedNorad !== null && _catalog.get(_trackedNorad)?.group === 'dense') {
    _clearTracking();
  }
  for (const noradId of _denseIds) {
    const point = _points.get(noradId);
    if (point && _pointCollection) _pointCollection.remove(point);
    _points.delete(noradId);
    _catalog.delete(noradId);
  }
  _denseIds = [];
  _denseCursor = 0;
  _count = _points.size;
  _catalogRevision++;
}

/**
 * Shared scene.preRender tick (single definition for init + enable):
 * - core fleet propagation at 200ms-tracked / 1s-idle cadence,
 * - dense extras on a per-frame round-robin budget,
 * - tracked satellite's point primitive per frame (WS-D2),
 * - orbit ring GMST re-alignment every ~1s (WS-D1).
 */
function _preRenderTick() {
  if (!_enabled) return;
  const now = focusNowMs(Date.now());

  const interval = _trackedNorad ? 200 : POSITION_UPDATE_MS;
  // Space Missions keeps this layer enabled for TLE lookup while deliberately
  // hiding its standalone fleet. Do not rebuild hidden point buffers on the
  // one-second propagation cadence: that GPU upload presented as a periodic
  // whole-globe pulse even though the camera remained stationary.
  if (_params.showPoints && now - _lastPropagation >= interval) {
    _propagateAll();
    _lastPropagation = now;
  }

  if (_params.showPoints) _propagateDenseChunk();

  // Keep the tracked dot on the per-frame epoch shared with label + camera —
  // runs after _propagateAll so the per-frame sample wins over the 200ms one.
  if (_trackedNorad !== null) {
    const pos = _getTrackedFramePosition();
    const point = _points.get(_trackedNorad);
    if (pos && point) {
      point.position = _trackedFrameCartesian; // primitive setter clones
    }
  }

  _updatePointFocus(now);

  // Hidden standalone orbit primitives do not need GMST matrix writes while
  // Space Missions draws the selected mission orbit itself.
  if (_params.showOrbits && now - _lastRingRotation >= RING_ROTATION_MS) {
    _updateOrbitPathRotations(new Date(now));
    _lastRingRotation = now;
  }
}

/**
 * Seed a single tracked satellite so tests can invoke the exact production
 * pre-render callback without constructing a WebGL viewer.
 * @param {object} state
 * @param {number} state.noradId
 * @param {string} state.name
 * @param {object} state.satrec
 * @param {object} state.entity
 * @param {object} state.point
 * @param {object} state.viewer
 * @param {() => (number|Date)} state.now
 */
export function _setTrackedSatelliteRefreshStateForTest({
  noradId,
  name,
  satrec,
  entity,
  point,
  viewer,
  now,
  // Extra catalog/point rows so a test can exercise a docked cluster (and a
  // control satellite that must NOT be treated as part of it).
  neighbours = [],
}) {
  _viewer = viewer;
  _catalog = new Map([[noradId, { name, satrec, group: 'stations' }]]);
  _points = new Map([[noradId, point]]);
  for (const neighbour of neighbours) {
    _catalog.set(neighbour.noradId, {
      name: neighbour.name,
      satrec: neighbour.satrec || satrec,
      group: neighbour.group || 'stations',
    });
    _points.set(neighbour.noradId, neighbour.point);
  }
  _dockedCompanions = new Set();
  _lastDockedScanMs = Number.NEGATIVE_INFINITY;
  _trackedNorad = noradId;
  _trackedEntity = entity;
  _trackedFrameNumber = -1;
  _trackedFrameGeo = null;
  _trackedFrameNowForTest = now;
  _params = { catalog: 'core', showPoints: false, showOrbits: false };
  _enabled = true;
}

/** Seed catalog authority and optional dense settlement for share-Follow tests. */
export function _setSatelliteTrackingRefreshOutcomeForTest({
  status = 'accepted',
  failedGroups = [],
  catalog = 'core',
  densePromise = null,
} = {}) {
  const epoch = ++_trackingRefreshEpoch;
  _lastTrackingRefreshOutcome = { epoch, status, failedGroups: [...failedGroups] };
  _params.catalog = catalog;
  _denseLoadPromise = densePromise || Promise.resolve({ status: 'not-requested' });
}

/** The tracked satellite's current ECEF sample — the value the docked-cluster
 *  scan measures against. Exposed so a test can place neighbours around it. */
export function _trackedFrameCartesianForTest() {
  return _trackedFrameCartesian;
}

/** Invoke the same callback registered on `scene.preRender` in production. */
export function _runSatellitePreRenderForTest() {
  _preRenderTick();
}

/**
 * Seed the minimum render state a dense-catalog load needs, so a test can
 * exercise the real async load/settle/fail path (and the row-control states it
 * drives) without constructing a WebGL viewer.
 * @param {{ catalog?: 'core'|'dense', showPoints?: boolean }} [options]
 */
export function _setDenseCatalogStateForTest({ catalog = 'core', showPoints = true } = {}) {
  _viewer = { scene: { primitives: { add: (p) => p, remove() {} } } };
  // Neutralize the shared world-overlay host: these tests exercise catalog and
  // row-control logic, not the ISS callout.
  _overlayHost = { setEntries() {}, setVisible() {}, clearSource() {} };
  _pointCollection = {
    show: true,
    add: (opts) => ({ ...opts }),
    remove() {},
    removeAll() {},
  };
  _catalog = new Map();
  _points = new Map();
  _detectionObjects = new Map();
  _orbitPaths = new Map();
  _denseIds = [];
  _denseCursor = 0;
  _denseLoadToken++;
  _denseStatus = 'idle';
  _denseError = null;
  _catalogRevision++;
  _trackedNorad = null;
  _cancelPendingTrackingRestore();
  _params = { catalog, showPoints, showOrbits: false };
  _enabled = true;
}

/** Tear the dense seam back down so ordering cannot leak into other tests. */
export function _clearDenseCatalogStateForTest() {
  _rowControlsListener = null;
  _overlayHost = DEFAULT_OVERLAY_HOST;
  _orbitPaths = new Map();
  _viewer = null;
  _pointCollection = null;
  _catalog = new Map();
  _points = new Map();
  _denseIds = [];
  _denseLoadToken++;
  _denseStatus = 'idle';
  _denseError = null;
  _params = { catalog: 'core', showPoints: true, showOrbits: true };
  _cancelPendingTrackingRestore();
  _enabled = false;
}

/** Catalog group tag recorded for a satellite, for ingestion-path assertions. */
export function _catalogGroupForTest(noradId) {
  return _catalog.get(Number(noradId))?.group;
}

/** Seed ISS/tracking state while retaining the production track and host paths. */
export function _setSatelliteLabelLifecycleStateForTest({
  viewer,
  satrec,
  point,
  overlayHost,
  preservePending = false,
}) {
  _viewer = viewer;
  _catalog = new Map([[ISS_NORAD, { name: 'ISS (ZARYA)', satrec, group: 'stations' }]]);
  _points = new Map([[ISS_NORAD, point]]);
  _orbitPaths = new Map([[
    ISS_NORAD,
    { primitive: { show: true, modelMatrix: new Cesium.Matrix4() }, gmstAtBake: 0 },
  ]]);
  _trackedNorad = null;
  _trackedEntity = null;
  if (!preservePending) _cancelPendingTrackingRestore();
  _trackedFrameNumber = -1;
  _trackedFrameGeo = null;
  _enabled = true;
  _params = { catalog: 'core', showPoints: true, showOrbits: true };
  _overlayHost = overlayHost || DEFAULT_OVERLAY_HOST;
  _syncIssOverlay();
}

/** Exercise production ISS tracking from the cached catalog and point. */
export function _trackIssForTest() {
  _trackSatellite(ISS_NORAD);
  return _trackedEntity;
}

/** Return the deferred restore target held by the production tracker. */
export function _pendingSatelliteTrackingRestoreForTest() {
  return _pendingTrackingRestore?.id ?? null;
}

/** Exercise the production deferred-restore retry after a simulated catalog refresh. */
export function _applyPendingSatelliteTrackingRestoreForTest() {
  return _applyPendingTrackingRestore();
}

/** Remove a cached catalog row so tests can model a target arriving later. */
export function _removeSatelliteTrackingCandidateForTest(noradId) {
  const id = Number(noradId);
  _catalog.delete(id);
  _points.delete(id);
}

/** Exercise production untrack and restore the default host seam. */
export function _clearSatelliteLabelLifecycleForTest() {
  _clearTracking();
  _enabled = false;
  _overlayHost.clearSource(ISS_OVERLAY_SOURCE_ID);
  _overlayHost.setVisible(ISS_OVERLAY_SOURCE_ID, false);
  _overlayHost = DEFAULT_OVERLAY_HOST;
}

/** Focus alpha for satellite points, inside the existing shared preRender tick. */
function _updatePointFocus(nowMs) {
  const target = getFocusTarget();
  if (!_params.showPoints || !focusPassIsNeeded(target, _activeFocusCount)) return;
  if (nowMs - _lastFocusUpdate < 80) return;
  _lastFocusUpdate = nowMs;
  const scene = _viewer.scene;
  const camera = _viewer.camera;
  const result = applySatellitePointFocusDeemphasis({
    points: _points,
    trackedId: _trackedNorad,
    target,
    previousActiveCount: _activeFocusCount,
    nowMs,
    screenPositionFor: (position) => (
      Cesium.SceneTransforms.worldToWindowCoordinates(scene, position, _scratchFocusScreen)
    ),
    cameraDistanceFor: (position) => Cesium.Cartesian3.distance(camera.positionWC, position),
    baseColorFor: (noradId) => _pointStyleFor(noradId, _catalog.get(noradId)?.group).color,
  });
  _activeFocusCount = result.activeCount;
}

/**
 * Apply the gated satellite-point focus pass through the production color path.
 * @param {object} input
 * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
 */
export function applySatellitePointFocusDeemphasis({
  points,
  trackedId,
  target,
  previousActiveCount = 0,
  nowMs,
  screenPositionFor,
  cameraDistanceFor,
  baseColorFor,
  params,
}) {
  if (!focusPassIsNeeded(target, previousActiveCount)) {
    return { writes: 0, transitioning: false, activeCount: 0, ran: false };
  }
  let writes = 0;
  let transitioning = false;
  let activeCount = 0;
  for (const [noradId, point] of points || []) {
    if (noradId === trackedId || !point?.position) continue;
    const cameraDistance = cameraDistanceFor(point.position);
    const distanceScale = nearFarScalarValueAtDistance(point.scaleByDistance, cameraDistance);
    const halfExtentPx = (point.pixelSize || 5) * distanceScale * 0.5;
    const focus = advanceSpriteFocus(point, {
      // Hidden points still release toward identity, preventing stale dim
      // alpha if a catalog/presentation toggle later makes them visible.
      screenPosition: point.show === false ? null : screenPositionFor(point.position),
      cameraDistance,
      nowMs,
      target,
      params,
      spriteHalfWidthPx: halfExtentPx,
      spriteHalfHeightPx: halfExtentPx,
    });
    transitioning ||= focus.transitioning;
    if (focus.active) activeCount += 1;
    const base = baseColorFor(noradId);
    const alpha = base.alpha * focus.factor;
    if (focusAlphaNeedsWrite(point.color?.alpha, alpha, params)) {
      // Point stays continuously present at the non-zero emphasis floor; its
      // own alpha yields around the tracked target, independent of draw order.
      point.color = base.withAlpha(alpha);
      writes += 1;
    }
  }
  return { writes, transitioning, activeCount, ran: true };
}


const satellitesLayer = {
  id: 'satellites',
  name: 'Satellites',
  icon: '🛰️',
  source: 'CelesTrak',
  updateInterval: 0, // We use preRender for real-time updates, not interval polling
  refreshInterval: 5 * 60 * 1000, // Catalog data refresh; propagation remains preRender-owned.

  async init(viewer) {
    _abortActiveUpdates();
    clearFocusTarget('satellites');
    _viewer = viewer;
    _catalog = new Map();
    _points = new Map();
    _detectionObjects = new Map();
    _orbitPaths = new Map();
    _count = 0;
    _lastUpdate = null;
    _trackedNorad = null;
    _cancelPendingTrackingRestore();
    _trackedEntity = null;
    _trackedFrameNumber = -1;
    _trackedFrameGeo = null;
    _trackedFrameNowForTest = null;
    _lastFocusUpdate = 0;
    _activeFocusCount = 0;
    _enabled = false;
    _overlayHost.clearSource(ISS_OVERLAY_SOURCE_ID);
    _overlayHost.setVisible(ISS_OVERLAY_SOURCE_ID, false);
    // Dense extras rebuild via update() when _params.catalog === 'dense'
    // (the catalog-mode preference itself is sticky across init/destroy).
    _denseIds = [];
    _denseCursor = 0;
    _denseLoadPromise = null;
    _denseLoadToken++;
    _denseStatus = 'idle';
    _denseError = null;
    _catalogRevision++;

    // Point primitives for satellite dots
    _pointCollection = new Cesium.PointPrimitiveCollection();
    viewer.scene.primitives.add(_pointCollection);

    _installClickHandler(viewer);

    // Pre-render listener for real-time position updates
    // (fleet propagation + tracked per-frame dot + orbit ring GMST rotation)
    _preRenderListener = viewer.scene.preRender.addEventListener(_preRenderTick);

    console.log('[Data:Satellites] Initialized');
  },

  enable(viewer) {
    _enabled = true;
    holdContinuousRender('satellites'); // per-frame animator (perf wave 2)
    if (_pointCollection) _pointCollection.show = satelliteVisualsVisible(_enabled, _params.showPoints);
    // Orbit ring primitives + persistent ISS host label — show them
    for (const path of _orbitPaths.values()) path.primitive.show = satelliteVisualsVisible(_enabled, _params.showOrbits);
    _syncIssOverlay();
    // Re-attach input handlers and preRender propagation
    _installClickHandler(viewer);
    // Pick-ownership (H2): satellite dot ids are numeric NORAD catalog numbers;
    // the registry hands predicates String()-coerced ids, so match via Number().
    registerPickOwner('satellites', (pickedId) => {
      const norad = Number(pickedId);
      return Number.isFinite(norad) && _points.has(norad);
    });
    if (!_preRenderListener && viewer) {
      _preRenderListener = viewer.scene.preRender.addEventListener(_preRenderTick);
    }
    _applyPendingTrackingRestore();
  },

  disable(viewer) {
    _abortActiveUpdates();
    _cancelPendingTrackingRestore();
    _enabled = false;
    releaseContinuousRender('satellites');
    if (_pointCollection) _pointCollection.show = false;
    for (const path of _orbitPaths.values()) path.primitive.show = false;
    _clearTracking();
    _syncIssOverlay();
    // Remove click handler + keydown listener + preRender propagation while disabled
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    if (_trackedEntityChangedRemove) {
      _trackedEntityChangedRemove();
      _trackedEntityChangedRemove = null;
    }
    document.removeEventListener('keydown', _onKeyDown);
    unregisterPickOwner('satellites');
    if (_preRenderListener) {
      _preRenderListener();
      _preRenderListener = null;
    }
  },

  async update(viewer, { signal = null } = {}) {
    const trackingRefreshEpoch = ++_trackingRefreshEpoch;
    _lastTrackingRefreshOutcome = {
      epoch: trackingRefreshEpoch,
      status: 'source-unavailable',
      failedGroups: [],
    };
    const resourceController = new AbortController();
    _activeUpdateControllers.add(resourceController);
    const updateSignal = signal
      ? AbortSignal.any([signal, resourceController.signal])
      : resourceController.signal;
    try {
      updateSignal.throwIfAborted();
      // Load all core groups in parallel; a failed/empty group degrades
      // gracefully (parseTLE of an upstream error body yields []).
      const results = await Promise.all(CATALOG_GROUPS.map(async (groupDef) => {
        try {
          const res = await fetch(`/api/gev/celestrak/${groupDef.path}`, { signal: updateSignal });
          if (!res.ok) return { ...groupDef, entries: [], ok: false };
          const entries = parseTLE(await res.text());
          updateSignal.throwIfAborted();
          return { ...groupDef, entries, ok: entries.length > 0 };
        } catch (error) {
          if (updateSignal.aborted || error?.name === 'AbortError') throw error;
          return { ...groupDef, entries: [], ok: false };
        }
      }));
      updateSignal.throwIfAborted();

      const failed = results.filter(r => !r.ok).map(r => r.path);
      if (failed.length > 0) {
        console.warn(`[Data:Satellites] Groups failed or empty: ${failed.join(', ')}`);
      }
      console.log(`[Data:Satellites] Loaded ${results.map(r => `${r.tag}:${r.entries.length}`).join(' ')}`);

      // CelesTrak outage guard (H3): if EVERY group failed, bail BEFORE clearing.
      // Wiping the collection + catalog here would blank all 838 satellites while
      // the chip still read "just now". Keep the existing (stale) catalog on
      // screen and surface the outage instead — do NOT stamp _lastUpdate.
      if (results.every(r => !r.ok)) {
        _lastError = 'CelesTrak unreachable';
        console.warn('[Data:Satellites] All CelesTrak groups failed — keeping existing catalog, surfacing outage');
        // Re-apply dense mode is skipped (no fresh core catalog); tracking untouched.
        return;
      }

      // At least one group loaded — proceed with a fresh rebuild, but keep the
      // partial outage visible at the layer control instead of presenting the
      // reduced catalog as a fully healthy refresh.
      _lastError = failed.length
        ? `${failed.length} CelesTrak group${failed.length === 1 ? '' : 's'} unavailable`
        : null;

      // Clear existing
      _pointCollection.removeAll();
      _points.clear();
      for (const path of _orbitPaths.values()) viewer.scene.primitives.remove(path.primitive);
      _orbitPaths.clear();
      _catalog.clear();
      // The detection overlay caches one record per satellite and stamps its
      // id/class at creation only. A rebuild can re-tag a satellite (a failed
      // group shifts which one wins dedupe), so the cache must go with the
      // catalog or those labels stay stale for the life of the session.
      _detectionObjects.clear();
      _denseIds = [];
      _denseCursor = 0;
      _denseLoadController?.abort();
      _denseLoadController = null;
      _denseLoadToken++; // cancel any in-flight dense load against the old catalog
      _syncIssOverlay();

      const now = new Date();

      // Process all TLE entries in CATALOG_GROUPS order
      const allEntries = [];
      for (const r of results) {
        for (const e of r.entries) allEntries.push({ ...e, group: r.tag });
      }

      // Deduplicate by NORAD ID — first (most specific) group tag wins
      const seen = new Set();

      for (const entry of allEntries) {
        const satrec = twoline2satrec(entry.line1, entry.line2);
        if (!satrec || satrec.error !== 0) continue;

        const noradId = Number(satrec.satnum);
        if (seen.has(noradId)) continue;
        seen.add(noradId);

        // Store in catalog
        _catalog.set(noradId, {
          name: entry.name,
          satrec,
          group: entry.group,
        });

        // Propagate initial position
        const pos = propagatePosition(satrec, now);
        if (!pos) continue;

        const cartesian = Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, pos.altitude);

        // Add point primitive (styling from the shared table, WS-D3)
        const style = _pointStyleFor(noradId, entry.group);
        const point = _pointCollection.add({
          position: cartesian,
          pixelSize: style.pixelSize,
          color: style.color,
          outlineColor: style.outlineColor,
          outlineWidth: style.outlineWidth,
          scaleByDistance: new Cesium.NearFarScalar(1e6, 1.5, 2e7, 0.6),
          id: noradId,
        });

        _points.set(noradId, point);
      }

      // Show ISS orbital path by default
      if (_catalog.has(ISS_NORAD)) {
        _showOrbitPath(ISS_NORAD, POINT_STYLES.iss.color);
        const issPath = _orbitPaths.get(ISS_NORAD);
        if (issPath) issPath.primitive.show = _params.showOrbits;

        _syncIssOverlay();
      }

      _count = _points.size;
      _catalogRevision++;
      _lastUpdate = Date.now();
      _lastPropagation = Date.now();
      _lastTrackingRefreshOutcome = {
        epoch: trackingRefreshEpoch,
        status: failed.length ? 'partial' : 'accepted',
        failedGroups: [...failed],
      };
      console.log(`[Data:Satellites] ${_count} satellites active, ISS path shown`);

      // Re-apply dense mode after a full catalog rebuild (fire-and-forget —
      // _loadDenseCatalog handles its own errors and token invalidation).
      _denseLoadPromise = _params.catalog === 'dense'
        ? _loadDenseCatalog({ signal: updateSignal })
        : Promise.resolve({ status: 'not-requested' });
      // The catalog the published voice subject was resolved against is gone.
      // Re-resolve it, or release the slot if the subject provably did not
      // survive. Deliberately not awaited: it waits on dense settlement, and
      // the rebuild must not block on that.
      void _reconcileTrackedSubjectContext();
      _applyPendingTrackingRestore();

    } catch (e) {
      if (updateSignal.aborted || e?.name === 'AbortError') {
        throw new DOMException('Satellite update aborted', 'AbortError');
      }
      console.warn('[Data:Satellites] Fetch error:', e);
    } finally {
      _activeUpdateControllers.delete(resourceController);
    }
  },

  destroy(viewer) {
    _abortActiveUpdates();
    releaseContinuousRender('satellites'); // direct-destroy path (perf wave 2 fix)
    _enabled = false;
    _clearTracking();
    _cancelPendingTrackingRestore();
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    if (_trackedEntityChangedRemove) {
      _trackedEntityChangedRemove();
      _trackedEntityChangedRemove = null;
    }
    document.removeEventListener('keydown', _onKeyDown);
    unregisterPickOwner('satellites');
    if (_preRenderListener) {
      _preRenderListener();
      _preRenderListener = null;
    }
    _overlayHost.clearSource(ISS_OVERLAY_SOURCE_ID);
    _overlayHost.setVisible(ISS_OVERLAY_SOURCE_ID, false);
    if (_pointCollection) {
      viewer.scene.primitives.remove(_pointCollection);
      _pointCollection = null;
    }
    // Orbit ring primitives are removed (and destroyed) here
    for (const path of _orbitPaths.values()) {
      viewer.scene.primitives.remove(path.primitive);
    }
    _points.clear();
    _detectionObjects.clear();
    _orbitPaths.clear();
    _catalog.clear();
    _denseIds = [];
    _denseCursor = 0;
    _denseLoadToken++;
    _denseStatus = 'idle';
    _denseError = null;
    _catalogRevision++;
    _rowControlsListener = null;
    _count = 0;
    _lastUpdate = null;
    _lastError = null;
    _lastFocusUpdate = 0;
    _activeFocusCount = 0;
    _trackingRefreshEpoch += 1;
    _lastTrackingRefreshOutcome = {
      epoch: _trackingRefreshEpoch,
      status: 'destroyed',
      failedGroups: [],
    };
    _viewer = null;
  },

  getDetectableObjects(options = {}) {
    if (!_pointCollection || !_pointCollection.show) return [];
    // Dense extras are points-only: excluded from the detection overlay.
    const eligibleCount = Math.max(1, _points.size - _denseIds.length);
    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : eligibleCount;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    const stride = Math.max(1, Math.ceil(eligibleCount / maxCount));
    const start = seed % stride;

    const result = [];
    let idx = 0;
    for (const [noradId, point] of _points) {
      if (_denseIds.length > 0 && _catalog.get(noradId)?.group === 'dense') continue;
      const shouldTake = ((idx - start) % stride) === 0;
      idx++;
      if (!shouldTake) continue;
      if (!point.position) continue;
      const isTracked = noradId === _trackedNorad;
      // A docked companion sits at the tracked subject's own position, so its
      // mark and label would stack underneath the tracked card. It is listed on
      // that card instead. Only members of the tracked cluster are affected —
      // unrelated nearby satellites are never suppressed.
      if (!isTracked && _dockedCompanions.has(noradId)) continue;
      const cat = _catalog.get(noradId);
      let object = _detectionObjects.get(noradId);
      if (!object) {
        object = {
          sourceId: noradId,
          id: cat?.name || `SAT-${noradId}`,
          type: 'SAT',
          // Human class ("NAV · GPS"), not the raw CelesTrak tag ("GPS-OPS").
          // The detection canvas composites ABOVE the post-FX chain, so this
          // is how class survives NVG/FLIR once the dot colors are collapsed.
          klass: satelliteClassLabel(cat?.group, { isIss: noradId === ISS_NORAD }),
        };
        _detectionObjects.set(noradId, object);
      }
      object.position = point.position;
      object.skipLabel = isTracked;
      result.push(object);
      if (result.length >= maxCount) break;
    }
    return result;
  },

  /**
   * Find a satellite by exact NORAD id (numeric string) or case-insensitive
   * name substring. Position is freshly propagated via SGP4.
   * @param {string|number} query NORAD id or partial name.
   * @returns {{ noradId: number, name: string, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number }|null}
   */
  findByQuery(query) {
    if (query === null || query === undefined || !_catalog || _catalog.size === 0) return null;
    const q = String(query).trim();
    if (!q) return null;

    let noradId = null;
    if (/^\d+$/.test(q) && _catalog.has(Number(q))) {
      noradId = Number(q);
    } else {
      const lower = q.toLowerCase();
      for (const [id, sat] of _catalog) {
        if (sat.name.toLowerCase().includes(lower)) {
          noradId = id;
          break;
        }
      }
    }
    if (noradId === null) return null;

    const sat = _catalog.get(noradId);
    const pos = propagatePosition(sat.satrec, new Date());
    if (!pos) return null;

    return {
      noradId,
      name: sat.name.trim(),
      position: Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, pos.altitude),
      latitude: pos.latitude,
      longitude: pos.longitude,
      altitudeM: pos.altitude,
    };
  },

  /**
   * Get positions of currently rendered satellites from per-point state
   * (no SGP4 re-propagation).
   * @param {number} [maxCount=300] Maximum entries to return.
   * @returns {Array<{ id: number, label: string, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number }>}
   */
  getAllPositions(maxCount = 300) {
    const result = [];
    if (!_points || _points.size === 0) return result;
    const cap = Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 300;

    for (const [noradId, point] of _points) {
      if (result.length >= cap) break;
      if (!point.position) continue;
      // Dense extras are points-only — keep voice/framing lists to the core catalog.
      if (_denseIds.length > 0 && _catalog.get(noradId)?.group === 'dense') continue;
      const carto = Cesium.Cartographic.fromCartesian(point.position);
      if (!carto) continue;
      const sat = _catalog.get(noradId);
      result.push({
        id: noradId,
        label: sat ? sat.name.trim() : String(noradId),
        position: point.position,
        latitude: Cesium.Math.toDegrees(carto.latitude),
        longitude: Cesium.Math.toDegrees(carto.longitude),
        altitudeM: carto.height,
      });
    }
    return result;
  },

  /**
   * Track a satellite by NORAD id (camera follow + orbit path + highlight),
   * same path as clicking its point.
   * @param {string|number} noradId NORAD catalog number.
   * @returns {boolean} True if tracking started.
   */
  trackById(noradId, { origin = 'programmatic' } = {}) {
    const id = Number(noradId);
    if (!Number.isFinite(id) || !_viewer || !_catalog.has(id) || !_points.has(id)) return false;
    _cancelPendingTrackingRestore();
    _trackSatellite(id, { origin });
    return _trackedNorad === id;
  },

  /**
   * Resolve a shared Follow target only after the applicable CelesTrak
   * catalog has settled. A partial catalog can prove presence, never absence.
   */
  async resolveTrackingRestoreTarget(noradId, {
    signal = null,
    origin = 'share-restore',
  } = {}) {
    if (signal?.aborted) return { status: 'cancelled', reason: String(signal.reason || 'aborted') };
    const id = _normalizeTrackedNorad(noradId);
    if (id === null) return { status: 'missing', reason: 'invalid-target' };
    const outcome = _lastTrackingRefreshOutcome;
    const found = () => _catalog.has(id) && _points.has(id);
    const follow = () => {
      if (signal?.aborted) return { status: 'cancelled', reason: String(signal.reason || 'aborted') };
      return this.trackById(id, { origin })
        ? { status: 'found', refreshEpoch: outcome.epoch }
        : { status: 'source-unavailable', reason: 'target-not-renderable', refreshEpoch: outcome.epoch };
    };

    if (found()) return follow();
    if (outcome.status !== 'accepted' && outcome.status !== 'partial') {
      return {
        status: 'source-unavailable',
        reason: 'CelesTrak catalog unavailable',
        refreshEpoch: outcome.epoch,
      };
    }

    if (_params.catalog === 'dense') {
      const dense = await (_denseLoadPromise || Promise.resolve({ status: 'source-unavailable' }));
      if (signal?.aborted) return { status: 'cancelled', reason: String(signal.reason || 'aborted') };
      if (_lastTrackingRefreshOutcome.epoch !== outcome.epoch) {
        return { status: 'superseded', reason: 'newer-catalog-refresh' };
      }
      if (found()) return follow();
      if (dense?.status !== 'ready') {
        return {
          status: 'source-unavailable',
          reason: dense?.reason || 'dense catalog unavailable',
          refreshEpoch: outcome.epoch,
        };
      }
    }

    if (outcome.status === 'partial') {
      return {
        status: 'source-unavailable',
        reason: 'partial CelesTrak catalog cannot prove absence',
        refreshEpoch: outcome.epoch,
        failedGroups: [...outcome.failedGroups],
      };
    }
    return {
      status: 'missing',
      reason: 'target-absent-from-catalog',
      refreshEpoch: outcome.epoch,
    };
  },

  /**
   * Stop tracking the currently tracked satellite (no-op if none).
   * @returns {boolean} Always true.
   */
  stopTracking({ origin = 'programmatic' } = {}) {
    _cancelPendingTrackingRestore();
    _clearTracking(false, { origin });
    return true;
  },

  cancelPendingTrackingRestore() {
    _cancelPendingTrackingRestore();
  },

  /**
   * Get info about the currently tracked satellite.
   * @returns {{ noradId: number, name: string, latitude: number, longitude: number, altitudeM: number }|null}
   */
  getTrackedInfo() {
    if (_trackedNorad === null || !_catalog.has(_trackedNorad)) return null;
    const sat = _catalog.get(_trackedNorad);
    // Per-frame cache (WS-D2) — same epoch as the dot/label/camera this frame.
    const pos = _getTrackedFramePosition();
    if (!pos) return null;
    return {
      noradId: _trackedNorad,
      name: sat.name.trim(),
      latitude: pos.latitude,
      longitude: pos.longitude,
      altitudeM: pos.altitude,
    };
  },

  /**
   * Runtime params (DataLayerManager.setLayerParams path).
   * catalog: 'core' (default, ~840 sats) | 'dense' (adds the Starlink shell
   * as points-only extras on a relaxed propagation budget).
   * @param {{ catalog?: 'core'|'dense', showPoints?: boolean, showOrbits?: boolean, selectedSatTrackingId?: number|null }} [params]
   */
  setParams(params = {}, { origin = 'programmatic' } = {}) {
    if (isExplicitLayerStateOrigin(origin)
        && !Object.hasOwn(params, 'selectedSatTrackingId')) {
      _cancelPendingTrackingRestore();
    }
    const catalog = params.catalog;
    if (catalog !== undefined && catalog !== 'core' && catalog !== 'dense') return false;
    const catalogChanged = satelliteCatalogModeChanged(_params.catalog, catalog);
    if (catalogChanged) {
      _params.catalog = catalog;
    }
    if (params.showPoints !== undefined) {
      _params.showPoints = params.showPoints !== false;
      if (_pointCollection) _pointCollection.show = satelliteVisualsVisible(_enabled, _params.showPoints);
    }
    if (params.showOrbits !== undefined) {
      _params.showOrbits = params.showOrbits !== false;
      for (const path of _orbitPaths.values()) path.primitive.show = satelliteVisualsVisible(_enabled, _params.showOrbits);
      _syncIssOverlay();
    }
    if (catalogChanged && catalog === 'dense') {
      _denseLoadPromise = _loadDenseCatalog();
    } else if (catalog === 'core') {
      if (catalogChanged) _removeDenseCatalog();
      // Any explicit request for core clears the error, even when the mode did
      // NOT change: a failed dense load already reverted the param to core, so
      // a Space Missions restore of an already-core snapshot would otherwise
      // leave the user staring at a DENSE ✕ they never caused.
      _denseStatus = 'idle';
      _denseError = null;
    }
    if (catalogChanged) console.log(`[Data:Satellites] Catalog mode: ${catalog}`);
    if (Object.hasOwn(params, 'selectedSatTrackingId')) {
      const requested = _normalizeTrackedNorad(params.selectedSatTrackingId);
      if (requested === _trackedNorad) {
        _pendingTrackingRestore = null;
      } else if (requested === null) {
        _cancelPendingTrackingRestore();
        if (_trackedNorad !== null) _clearTracking(false, { origin });
      } else {
        const generation = ++_trackingIntentGeneration;
        _pendingTrackingRestore = { id: requested, generation, origin };
        if (_trackedNorad !== null) _clearTracking(false, { origin });
        _applyPendingTrackingRestore();
      }
    }
    return true;
  },

  /** @returns {{ catalog: string }} Current runtime params. */
  getParams() {
    return {
      catalog: _params.catalog,
      showPoints: _params.showPoints,
      showOrbits: _params.showOrbits,
      selectedSatTrackingId: _trackedNorad,
    };
  },

  /**
   * Layer-row sub-controls (DataLayerManager row-controls contract): the DENSE
   * catalog chip plus a class legend so the point colors are learnable without
   * a new panel.
   *
   * The chip is stateless — it declares the params to apply and the manager
   * owns the write, so the Space Missions snapshot/restore path (which drives
   * the same `catalog` param) stays the single source of truth and the chip
   * always renders whatever the layer actually has.
   *
   * The chip reports the dense LOAD state, not the catalog param: the param
   * flips synchronously while the Starlink shell takes seconds to arrive and
   * frequently 502s, so ACTIVE means "dense points are on screen" and nothing
   * less. The legend tally is cached against the catalog revision.
   * @returns {{ chips: Array<object>, legend: Array<object> }} Row controls.
   */
  getRowControls() {
    // A dependency owner (Space Missions) borrows this layer for TLE lookup
    // with showPoints:false. Nothing is rendered, so a legend would describe an
    // empty sky and a chip write would be silently reverted by that owner's
    // restore. Surrender the row rather than lie about it.
    if (!_params.showPoints) return { chips: [], legend: [] };

    const loading = _denseStatus === 'loading';
    const failed = _denseStatus === 'failed';
    const active = _params.catalog === 'dense' && _denseStatus === 'ready';
    let title = 'Add the full Starlink broadband shell (thousands of extra points)';
    if (loading) title = 'Loading the Starlink shell…';
    else if (failed) title = `Starlink ${_denseError || 'load failed'} — click to retry`;
    else if (active) title = 'Showing the full Starlink shell — click for the core catalog only';
    return {
      chips: [{
        id: 'catalog',
        label: loading ? 'DENSE ···' : (failed ? 'DENSE ✕' : 'DENSE'),
        active,
        busy: loading,
        disabled: loading,
        state: loading ? 'loading' : (failed ? 'error' : (active ? 'active' : 'idle')),
        title,
        params: { catalog: active ? 'core' : 'dense' },
      }],
      legend: satelliteClassLegend(_classTally()),
    };
  },

  /**
   * Install the manager's "row controls changed" callback. The dense load is
   * asynchronous, so completion and failure have to push a re-render — nothing
   * else would repaint this row before the 5-minute catalog refresh.
   * @param {(() => void)|null} listener Callback, or null to detach.
   */
  setRowControlsListener(listener) {
    _rowControlsListener = typeof listener === 'function' ? listener : null;
  },

  getStats() {
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      stale: false,
      status: _lastError === 'CelesTrak unreachable'
        ? 'unavailable'
        : (_lastError ? 'degraded' : 'nominal'),
      error: _lastError,
    };
  },
};

function _onKeyDown(e) {
  if (_enabled && e.key === 'Escape' && _trackedNorad) {
    _cancelPendingTrackingRestore();
    _clearTracking(false, { origin: 'user' });
  }
}

function _installClickHandler(viewer) {
  if (_clickHandler) return; // already installed

  // Cross-layer untrack (H2, mirror of flights): if ANOTHER layer (flights,
  // military, …) grabs the follow-camera, drop our tracking so the orbit ring /
  // tracked entity don't orphan — without touching viewer.trackedEntity (the
  // new owner controls it). Guarded so our OWN switch (viewer.trackedEntity
  // briefly undefined mid-_trackSatellite) doesn't self-clear.
  if (!_trackedEntityChangedRemove) {
    _trackedEntityChangedRemove = viewer.trackedEntityChanged.addEventListener(() => {
      if (!_enabled) return;
      if (_trackedNorad && _viewer && _viewer.trackedEntity && _viewer.trackedEntity !== _trackedEntity) {
        _clearTracking(true, {
          origin: _viewer.trackedEntity?.gevSelectionOrigin || 'programmatic',
        });
      }
    });
  }

  _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    if (!_enabled) return;
    const picked = viewer.scene.pick(click.position);

    if (picked) {
      // Clicking tracked entity itself — ignore
      if (picked.id === _trackedEntity) return;

      // Check if it's a satellite point (id is NORAD catalog number)
      const prim = picked.primitive;
      if (prim && prim.id != null) {
        const noradId = Number(prim.id);
        if (!isNaN(noradId) && _catalog.has(noradId)) {
          _cancelPendingTrackingRestore();
          _trackSatellite(noradId, { origin: 'user' });
          return;
        }
      }
    }

    // A pick that belongs to a sibling layer (plane, vessel, station, CCTV
    // camera…) is not "empty space" — leave OUR tracking (and crucially
    // viewer.trackedEntity, which that sibling may have JUST set) alone (H2).
    if (picked) {
      const pickedId = resolvePickId(picked);
      if (pickedId && isOwnedByOtherLayer('satellites', pickedId)) return;
    }

    // Clicked empty space — deselect
    if (_trackedNorad) {
      _cancelPendingTrackingRestore();
      _clearTracking(false, { origin: 'user' });
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  document.addEventListener('keydown', _onKeyDown);
}

/**
 * Next ISS pass for an observer. Requires the catalog to have loaded (the
 * satellites layer enabled at least once this session).
 * @returns {{status:'no-tle'}|{status:'none'}|{status:'ok', pass:{riseMs:number,setMs:number,maxElevDeg:number,maxElevMs:number,riseAzDeg:number}}}
 */
export function getNextIssPass({ latDeg, lonDeg, minElevDeg = 10 }) {
  const sat = _catalog.get(ISS_NORAD);
  if (!sat || !sat.satrec) return { status: 'no-tle' };
  const pass = findNextIssPass({
    satrec: sat.satrec, latDeg, lonDeg, fromMs: Date.now(), minElevDeg,
  });
  return pass ? { status: 'ok', pass } : { status: 'none' };
}

/**
 * Score a mission-to-catalog name match. Compact identifier containment handles
 * names such as "Sirius SXM-11" → "SXM-11", while weak generic matches such as
 * "Starlink Group 17-40" → an arbitrary "STARLINK-1008" remain below the
 * acceptance threshold.
 * @param {string} query Mission or payload name.
 * @param {string} catalogName Satellite catalog name.
 * @returns {number} Match score; 0 means no useful relationship.
 */
export function scoreSatelliteNameMatch(query, catalogName) {
  const q = String(query || '').trim().toLowerCase();
  const name = String(catalogName || '').trim().toLowerCase();
  if (!q || !name) return 0;
  const qCompact = q.replace(/[^a-z0-9]/g, '');
  const nameCompact = name.replace(/[^a-z0-9]/g, '');
  if (qCompact === nameCompact) return 1000;
  let score = 0;
  if (
    Math.min(qCompact.length, nameCompact.length) >= 5
    && (qCompact.includes(nameCompact) || nameCompact.includes(qCompact))
  ) {
    score += 200 + Math.min(qCompact.length, nameCompact.length);
  }
  const ignored = new Set(['group', 'block', 'mission', 'launch', 'falcon', 'rocket']);
  const tokens = q.split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !ignored.has(token));
  score += tokens.reduce((total, token) => total + (name.includes(token) ? token.length : 0), 0);
  return score;
}

function internationalDesignatorYear(satrec) {
  const match = String(satrec?.intldesg || '').match(/^(\d{2})/);
  if (!match) return null;
  const shortYear = Number(match[1]);
  return shortYear >= 57 ? 1900 + shortYear : 2000 + shortYear;
}

let _lookupTleText = null;
let _lookupTleEntries = [];

function lookupTleEntries(tleText) {
  if (tleText !== _lookupTleText) {
    _lookupTleText = tleText;
    _lookupTleEntries = parseTLE(tleText);
  }
  return _lookupTleEntries;
}

function tleLineLaunchYear(line1) {
  const shortYear = Number(String(line1 || '').slice(9, 11));
  if (!Number.isFinite(shortYear)) return null;
  return shortYear >= 57 ? 1900 + shortYear : 2000 + shortYear;
}

function orbitTrackFromRecord(name, satrec) {
  const referenceDate = new Date();
  const current = propagatePosition(satrec, referenceDate);
  if (!current) return null;
  return {
    noradId: Number(satrec.satnum),
    name: String(name || '').trim(),
    current,
    periodSec: orbitalPeriodSeconds(satrec),
    orbitPath: computeOrbitPath(satrec, referenceDate),
    gmstAtBake: gstime(referenceDate),
    positionAt: (date) => propagatePosition(satrec, date),
  };
}

/**
 * Find and propagate a mission payload directly from a TLE catalog.
 * This supports newly launched payloads that are present in CelesTrak's active
 * feed but have not yet moved into a narrower operational group.
 * @param {string} tleText Three-line-element catalog text.
 * @param {string} query Mission or payload name.
 * @param {{launchTime?: string|null}} [options] Optional launch epoch for namesake rejection.
 * @returns {{noradId:number,name:string,current:object,periodSec:number,orbitPath:Cesium.Cartesian3[],positionAt:function(Date):object|null}|null}
 */
export function findSatelliteOrbitTrackInTle(tleText, query, options = {}) {
  const launchYear = Number.isFinite(Date.parse(options.launchTime))
    ? new Date(options.launchTime).getUTCFullYear()
    : null;
  let bestEntry = null;
  let bestScore = 0;
  const catalogText = String(tleText || '');
  for (const entry of lookupTleEntries(catalogText)) {
    const designatorYear = tleLineLaunchYear(entry.line1);
    if (launchYear !== null && designatorYear !== null && designatorYear !== launchYear) continue;
    const score = scoreSatelliteNameMatch(query, entry.name);
    if (score > bestScore) {
      bestEntry = entry;
      bestScore = score;
    }
  }
  if (!bestEntry || bestScore < 12) return null;
  const satrec = twoline2satrec(bestEntry.line1, bestEntry.line2);
  if (!satrec || satrec.error !== 0) return null;
  return orbitTrackFromRecord(bestEntry.name, satrec);
}

/**
 * Return the current propagated position and one-orbit path for a catalog satellite.
 * @param {string|number} query NORAD id or mission/payload name.
 * @param {{launchTime?: string|null}} [options] Optional launch epoch used to reject namesakes from another launch year.
 * @returns {{noradId:number,name:string,current:object,periodSec:number,orbitPath:Cesium.Cartesian3[],positionAt:function(Date):object|null}|null}
 */
export function getSatelliteOrbitTrack(query, options = {}) {
  if (query === null || query === undefined || !_catalog?.size) return null;
  const q = String(query).trim().toLowerCase();
  let noradId = /^\d+$/.test(q) ? Number(q) : null;
  if (noradId === null || !_catalog.has(noradId)) {
    noradId = null;
    const launchYear = Number.isFinite(Date.parse(options.launchTime))
      ? new Date(options.launchTime).getUTCFullYear()
      : null;
    let bestScore = 0;
    for (const [id, sat] of _catalog) {
      const designatorYear = internationalDesignatorYear(sat.satrec);
      if (launchYear !== null && designatorYear !== null && designatorYear !== launchYear) continue;
      const score = scoreSatelliteNameMatch(q, sat.name);
      if (score > bestScore) { bestScore = score; noradId = id; }
    }
    if (bestScore < 12) noradId = null;
  }
  if (noradId === null) return null;
  const sat = _catalog.get(noradId);
  return orbitTrackFromRecord(sat.name, sat.satrec);
}

export default satellitesLayer;
