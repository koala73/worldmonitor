/**
 * @module flights
 * @description Real-time flight tracking layer powered by the OpenSky Network API
 * (authenticated via Vite dev-server proxy at /api/opensky).
 *
 * Rendering strategy: all aircraft are drawn as billboards in a single
 * BillboardCollection for GPU-efficient batching (handles 5000+ aircraft).
 * Each billboard's alignedAxis is set to the WGS84 ellipsoid surface normal
 * so that the rotation value (derived from true_track heading) operates in
 * the local tangent plane (0 deg = north, 90 deg = east).
 *
 * Click-to-track: clicking a billboard creates a tracked Entity whose
 * position is driven by a dead-reckoning CallbackProperty.  Between API
 * refreshes (every ~10-30 s) the aircraft advances smoothly using ENU frame
 * math.  When a new API fix arrives, a 1-second lerp blends the current
 * dead-reckoned position into the corrected fix to avoid visual snapping.
 *
 * Press Escape or click empty space to deselect a tracked flight — the camera
 * is released IN PLACE (no flyTo), so the user keeps the context they were
 * looking at (product rule 2026-07-02).
 */
import * as Cesium from 'cesium';
import { aircraftIncludedInNearby } from './aircraftNearbyPolicy.js';
import { registerPickOwner, unregisterPickOwner, isOwnedByOtherLayer, resolvePickId } from './pickRegistry.js';
import {
  registerSpriteCollection,
  restoreSpriteOrder,
  restoreSpriteOrderOnEnable,
} from './spriteOrder.js';
import {
  bindTrackingClickGesture,
  isTrackingClickGesture,
  isTrackingSelectionGesture,
} from './trackingClickGesture.js';
import { createTrail } from './trailRenderer.js';
import { isExplicitLayerStateOrigin } from './layerState.js';
import {
  screenProjectedRotation,
  stabilizeScreenRotation,
  horizonOccluder,
  cameraPoseSignature,
} from './iconOrientation.js';
import { stickyText, stickyNumber } from './aircraftMeta.js';
import { classifyAircraft, CLASS_SCALE_2D, CLASS_SCALE_3D, CLASS_MODEL_URL, CLASS_MODEL_REAL } from './aircraftClass.js';
import { modelAnchorWorld, modelVisualAnchor, trailAnchorForModel, trailHeadStart, visualCenterForModel } from './modelVisualAnchor.js';
import { aircraftIcon, TRACKED_ICON_PX } from './aircraftIcons.js';
import {
  isTr3b, tr3bAircraftClass, tr3bConvertedIds, tr3bIconKind, tr3bTypeLabel,
} from './tr3bRegistry.js';
import { cockpitContactDotImage } from './cockpitContactDot.js';
import { nextCockpitNearContacts } from './cockpitAirLod.js';
import {
  applyTrackedCameraFrame,
  trackedModelScaleForPixelCap,
} from './trackedCamera.js';
import {
  courseBetweenCartesians, limitCourseStep, turnRateFromFixHistory, arcOffsetEnu,
  lerpAngleDeg, speedRamp, courseSlewCapDps, displayedKinematics, staleCoastLimitSeconds,
  liftRepeatedGroundFix, synthesizeForwardKinematicsFix, corridorPathLatLon,
  COURSE_HOLD_SPEED_MPS,
} from './motionModel.js';
import { routePlausible } from './routePlausible.js';
import { isMilitaryIcao, isMilitaryLayerActive, refreshMilitaryRegistryIfStale, onMilitaryLayerActiveChange } from './militaryRegistry.js';
import { formatFlightLevel } from './detectionDraw.js';
import { createGroundSnap } from './groundSnap.js';
import { trackedModelZoomActive } from './trackedModelRegime.js';
import { geoidSurfaceLastResortM, pickRenderAltitudeM } from './renderAltitude.js';
import { allocateCorridorCells, cachedGroundFloor, cachedMeshFloor, coarseFloorCoord, corridorFloorCells, displayFloorHeightM, floorAltitudeM, neighborFloorM, stickyFloorCell, warmGroundFloor, resolveGroundFloorCellsBounded, GROUND_FLOOR_LIFT_M } from './groundFloor.js';
import { sampleMeshFloorCells } from './meshFloorSampler.js';
import { ensureGeoidReady, geoidHeight } from './geoid.js';
import {
  advanceFocusEvidenceNowMs,
  advanceProjectedSpriteFocus,
  clearFocusTarget,
  focusNowMs,
  getFocusDeemphasisParams,
  getFocusTarget,
  nearFarScalarValueAtDistance,
  publishFocusTargetFromCachedPosition,
  setFocusEvidenceNowMs,
  setFocusDeemphasisParams,
} from './focusDeemphasis.js';
import {
  applyAircraftBillboardTreatment,
  applyAircraftModelTreatment,
  getAircraftRecessionParams,
  setAircraftRecessionParams,
} from './aircraftRecession.js';
import { refreshTrackedReadout, trackedLabelModelFromText } from './trackedReadout.js';
import {
  clearTrackedSubjectContext,
  refreshTrackedSubjectContext,
  selectTrackedSubjectContext,
} from './contextStore.js';
import { CONTACT_MATCH_TIER, contactMatchWins, rankContactMatch } from './contactMatch.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';

const FOCUS_EVIDENCE_DEV = import.meta.env?.DEV === true;

/** Amber tint for known-military aircraft rendered by this layer (matches the military layer's icon color). */
const MIL_TINT = Cesium.Color.fromCssColorString('#FFB800');

// --- Ground traffic (product change 2026-07-03: "absolutely we should see planes
// taxiing and landing") -----------------------------------------------------------
// Present-but-grounded planes are RENDERED instead of being skipped: same class
// silhouette + rotation pipeline, clickable/trackable/detectable, sticky metadata
// updating normally. Landing/takeoff is a TRANSITION — the on_ground flip restyles
// the existing billboard in place, never a removal. Ground planes draw no trails
// and are excluded from the ambient enrichment sweep (click-to-enrich still
// works). In 3D mode they take model slots like airborne planes (product rule
// 2026-07-03 — no air/ground distinction), placed by the one-shot ground snap
// (see _modelDisplayPosition).
//
// TINT: full-strength, same pipeline as airborne (white / amber-military /
// cyan-tracked). Day 1 shipped a slate-gray 50%-alpha "muted" ground tint; the
// owner killed it the same day ("just leave them as white, dude … in NYC I can
// barely see them, extremely grayed out"). "On the ground" reads from the ×0.8
// scale + missing trail; "feed-dropped, coasting" stays the 45%-alpha stale
// fade — a full-alpha ground icon can never be confused with it.
/** Ground billboards render slightly smaller so airport clutter stays visually minor. */
const GROUND_SCALE = 0.8;

/** Fleet (untracked) billboard tint: amber for known-military, white otherwise.
 *  Ground traffic gets NO special tint (validated behavior 2026-07-03 field test). */
function _fleetBillboardColor(icao24) {
  return isMilitaryIcao(icao24) ? MIL_TINT : Cesium.Color.WHITE;
}

/** Fleet billboard scale: per-class scale, ×GROUND_SCALE while grounded. */
function _fleetBillboardScale(icao24, klass) {
  return (CLASS_SCALE_2D[klass] || 1) * (_flightData.get(icao24)?.onGround ? GROUND_SCALE : 1);
}

/** Depth-test policy for aircraft billboards. Round 5 (product invariant
 *  2026-07-06: "I just want the planes and their lines to ALWAYS be
 *  visible... evenly applied"): EVERY contact renders depth-test-free at
 *  every distance — grounded, low, and airborne alike. The photoreal mesh
 *  writes depth and residual baro/floor error will always leave some sprite
 *  geometry at or below it; a uniform rule beats the grounded-only /
 *  low-AGL-only conditions that kept leaving classes of contacts buried
 *  (2026-07-03 Van Nuys grounded case; 2026-07-06 Austin QNH-below-field
 *  case). Far-side planes are still removed by the fleet tick's horizon
 *  occluder, which never depended on depth. Kept as a function so the
 *  callers' restyle sites stay diff-stable. */
function _groundDepthDistance() {
  return Number.POSITIVE_INFINITY;
}

// --- 3D model rendering (B3) ---------------------------------------------------------
// When enabled, aircraft render as 3D glTF models once the camera is below MODEL_ALT_CEIL_M
// (zoomed in); higher up they stay flat billboards. Eligibility is FRUSTUM-based (on-screen), and
// the slots go to either the nearest planes ('proximity') or every in-view plane ('all'), each
// backed by a hard cap so a draw-call explosion can't tank the frame (no instancing yet).
const PLANE_MODEL_URL = '/models/airplane.glb';
const MODEL_ALT_CEIL_M = 800000; // m: below this camera altitude, draw 3D models (raised so it's easy to trigger)
const MODEL_MIN_PX = 24;        // floor so distant models stay visible WITHOUT ballooning into a giant
                                // min-pixel blob (was 54 — far planes at the All radius became white
                                // star-bursts); ~matches the 2D icon size so the model↔billboard read is consistent
const TRACKED_MODEL_MIN_PX = 40; // keep the glTF silhouette comparable to the selected 2D glyph at handoff
export const TRACKED_MODEL_MAX_PX = 200; // selected close-range tracked-target feel
const MODEL_NATIVE_RADIUS_M = 34.41;
const MODEL_SCALE = 1;          // airplane.glb is transform-applied and baked to real-world meters
// Per-mode caps. Each model is its own draw call (no instancing yet), so these bound the frame cost.
const MODEL_MAX = 150;          // 'proximity' cap (the planes immediately around you)
const MODEL_MAX_ALL = 350;      // 'all' cap (everything out to ~the horizon)
// Per-mode ADD / KEEP radii. The two modes differ by RADIUS, not just cap — otherwise they look
// IDENTICAL whenever fewer than a cap's worth of planes are in range (field bug: Proximity and All
// rendered the same). 'proximity' = a tight ring; 'all' = roughly to the horizon (state-scale). Each
// band has hysteresis (KEEP > ADD) so a plane doesn't release+reload its model when it straddles the
// add edge (the zoom/pan flicker). Beyond ADD a model would force-clamp to minimumPixelSize into a
// giant floating blob (the old 422 km airport-cluster bug), so far planes stay 2D dots; the cap +
// on-screen priority then spend the model slots on planes you can actually see.
const MODEL_PROX_ADD_M  = 150000;  // proximity: model NEW planes within 150 km
const MODEL_PROX_KEEP_M = 185000;  // proximity: KEEP modeled planes out to 185 km

const COCKPIT_MODEL_MAX = 60;         // max concurrent GLBs in cockpit (never raises the map cap)
const MODEL_ALL_ADD_M   = 400000;  // all: model NEW planes within 400 km (~to the horizon)
const MODEL_ALL_KEEP_M  = 450000;  // all: KEEP modeled planes out to 450 km
const MODEL_HEADING_OFFSET_DEG = 180; // airplane.glb nose is opposite Cesium heading-0
// Owner launch-polish direction: models should read as clean light silhouettes,
// with only a weak diffuse contribution from the existing approved textures.
const MODEL_COLOR_BLEND_AMOUNT = 0.94;
// Grounded-model belly offset: airplane.glb's centred origin sits 6.719 m ABOVE its
// lowest vertex (glTF Y-up scene AABB with node transforms applied — same reader as
// modelScale.test.mjs, measured after its 24× transform bake). × class multiplier ≈ 5.0–9.7 m
// of lift, so a ground-snapped model rests its lowest geometry (gear/belly) ON the sampled
// tile skin instead of sinking to the fuselage-centerline origin. Locked against the GLB
// by modelScale.test.mjs.
const MODEL_BELLY_OFFSET_NATIVE = 6.719;
/** Per-class model spec. Hangar-fleet classes (CLASS_MODEL_REAL) ship GLBs
 *  vertex-baked to real-world METERS in the airplane.glb axis convention, so
 *  they render at scale 1 with their own measured belly lift and bounding
 *  radius. Every other class keeps the shared-airplane.glb formula
 *  (MODEL_SCALE × CLASS_SCALE_3D). nativeRadiusM is PER SCALE UNIT — pixel-cap
 *  math multiplies it by `scale`, so world radius = nativeRadiusM × scale in
 *  both branches. The code-side MIX tint dominates every existing asset so
 *  class silhouettes stay light without modifying third-party GLBs/textures. */
/*  Specs are static per class, and the detection weld now asks for one per
 *  MODELED contact per frame (up to the fleet cap) on top of the 12 Hz fleet
 *  pass — so this is memoized, as militaryFlights.js already does. */
const _specCache = new Map();
function _modelSpec(klass) {
  const cached = _specCache.get(klass);
  if (cached) return cached;
  const real = CLASS_MODEL_REAL[klass];
  let spec;
  if (real) {
    spec = {
      url: real.url,
      scale: 1,
      nativeRadiusM: real.radiusM,
      bellyM: real.bellyM,
      blendAmount: MODEL_COLOR_BLEND_AMOUNT,
      visualCenterNative: visualCenterForModel(real.url),
      trailAnchorNative: trailAnchorForModel(real.url),
    };
  } else {
    const scale = MODEL_SCALE * (CLASS_SCALE_3D[klass] || 1);
    const url = CLASS_MODEL_URL[klass] || PLANE_MODEL_URL;
    spec = {
      url,
      scale,
      nativeRadiusM: MODEL_NATIVE_RADIUS_M,
      bellyM: MODEL_BELLY_OFFSET_NATIVE * scale,
      blendAmount: MODEL_COLOR_BLEND_AMOUNT,
      visualCenterNative: visualCenterForModel(url),
      trailAnchorNative: trailAnchorForModel(url),
    };
  }
  _specCache.set(klass, spec);
  return spec;
}
/** One-shot cached tile-skin heights for MODELED grounded planes (see groundSnap.js). */
const _groundSnap = createGroundSnap();
const _scratchGroundCarto = new Cesium.Cartographic();
const _scratchGroundPos = new Cesium.Cartesian3();
/** @type {Cesium.PrimitiveCollection|null} */
let _modelCollection = null;
/** @type {Map<string, Cesium.Model>} icao24 → model */
const _models = new Map();
/** @type {Set<string>} icao24 currently loading (async) */
const _modelPending = new Set();
/** @type {Map<string, number>} icao24 → load generation; bumped on release to invalidate
 *  an in-flight load (so a track/untrack/remove during fromGltfAsync can't add a stale model). */
const _modelGen = new Map();
/** Lifecycle epoch; bumped on destroy so an in-flight load from a PREVIOUS init can't settle
 *  against a new lifecycle's globals (which destroy cleared). Captured by _ensureModel. */
let _modelEpoch = 0;
/** DEFAULT-ON in PROXIMITY (product invariant 2026-08-22). A fresh boot never runs
 *  layer-state restoration, so this initializer — not the codec — is what the app
 *  actually starts with; it must stay in lockstep with the `models3d` default in
 *  `layerState.js` and `this._models3dEnabled` in ui.js, or the DISPLAY rail would
 *  light a button the layer has not armed. */
let _models3dEnabled = true;
let _models3dMode = 'proximity'; // 'proximity' = nearest MODEL_MAX in view; 'all' = every in-view plane (≤ MODEL_MAX_ALL)
let _lastModelCapWarnMs = 0; // throttle the "more planes in view than the cap" console notice
// The tracked entity's billboard goes transparent (rather than hidden) once the model takes
// over, so it keeps supplying a bounding sphere for follow-camera framing. We only drop its
// alpha after the GLB is preloaded so the model is ready to render the instant the billboard
// fades — no gap, no double-image. Preloaded once at init; the instance is retained (not
// destroyed) purely to keep Cesium's glTF cache warm for fast tracked-model instantiation.
let _planeModelLoaded = false;
/** @type {Cesium.Model|null} retained preload that keeps the glTF cache warm */
let _preloadModel = null;
const CYAN_TRANSPARENT = Cesium.Color.CYAN.withAlpha(0);
const _scratchModelHpr = new Cesium.HeadingPitchRoll(0, 0, 0);
const _scratchModelMtx = new Cesium.Matrix4();
const _scratchModelBS = new Cesium.BoundingSphere(new Cesium.Cartesian3(), 1.0); // frustum-visibility test
/** Last limb taper per billboard, retained across class/ground/cockpit repaints. */
const _billboardLimbScale = new WeakMap();

/** @constant {string} API_URL - Vite proxy endpoint for OpenSky /states/all */
const API_URL = '/api/gev/opensky';
const SOURCE_STALE_MS = 120_000;
/** @constant {number} BACKOFF_INTERVAL - Cooldown (ms) after 429 / auth errors */
const BACKOFF_INTERVAL = 45000; // 45s on rate limit
/** @constant {number} ERROR_BACKOFF_INTERVAL - Cooldown (ms) after transient errors */
const ERROR_BACKOFF_INTERVAL = 20000; // transient error retry
/** @constant {number} POSITION_HISTORY_LIMIT - Max position samples kept per aircraft for dead reckoning */
const POSITION_HISTORY_LIMIT = 5; // keep last N positions per aircraft

// ---------------------------------------------------------------------------
// Module-level state: billboard collection and per-aircraft lookup maps
// ---------------------------------------------------------------------------

/** @type {Cesium.BillboardCollection|null} */
let _billboardCollection = null;
/** @type {Map<string, Cesium.Billboard>} icao24 -> billboard primitive */
let _billboards = new Map();
/** Stable lightweight records reused by the detection overlay between polls. */
let _detectionObjects = new Map();
/** @type {Map<string, {callsign:string, altitude:number, velocity:number, true_track:number}>} */
let _flightData = new Map();
/** DEV-only explicit-position contacts used by qa-focus-evidence.mjs. */
const _focusEvidenceIds = new Set();
/** @type {Map<string, Array<{time:Cesium.JulianDate, position:Cesium.Cartesian3}>>} */
let _positionHistory = new Map();
/** @type {boolean} True once ensureGeoidReady() has resolved (awaited once at enable()) */
let _geoidReady = false;
/** @type {Map<string, number>} icao24 -> geoid undulation N (m), cached (negligible drift per-aircraft). */
const _geoidNCache = new Map();
/** @type {number} Current number of visible aircraft */
let _count = 0;
/** @type {number|null} Epoch ms of last successful API update */
let _lastUpdate = null;
/** @type {boolean} True while in a backoff/cooldown window */
let _backoff = false;
/** @type {number} Epoch ms — earliest time the next fetch is allowed */
let _retryAt = 0;
/** @type {string|null} Human-readable error string shown in stats chip */
let _lastError = null;
const _activeUpdateControllers = new Set();

function _abortActiveUpdates() {
  for (const controller of _activeUpdateControllers) controller.abort();
  _activeUpdateControllers.clear();
}
/** @type {number|null} HTTP status of the most recent API response */
let _lastStatus = null;
/** @type {string} Source used by the latest successful snapshot. */
let _lastSource = 'OpenSky Network';
/** @type {string} Completeness boundary for the latest successful snapshot. */
let _lastCoverage = 'worldwide upstream snapshot';

function _flightApiUrl(viewer) {
  const cartographic = viewer?.camera?.positionCartographic;
  if (!cartographic) return API_URL;
  const latitude = Cesium.Math.toDegrees(cartographic.latitude);
  const longitude = Cesium.Math.toDegrees(cartographic.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return API_URL;
  const params = new URLSearchParams({
    lat: latitude.toFixed(4),
    lon: longitude.toFixed(4),
  });
  return `${API_URL}?${params}`;
}

// ---------------------------------------------------------------------------
// Click-to-track state
// ---------------------------------------------------------------------------

/** @type {string|null} ICAO24 of the currently tracked aircraft */
let _trackedIcao = null;
let _pendingTrackingRestore = null;
let _trackingIntentGeneration = 0;
let _trackingRefreshEpoch = 0;
let _lastTrackingRefreshOutcome = {
  epoch: 0,
  status: 'unavailable',
  ids: new Set(),
  source: 'OpenSky Network',
  coverage: null,
};
/** @type {Cesium.Entity|null} Entity used for camera tracking */
let _trackedEntity = null;
/** Disposes the single active tracked-camera framing owner. */
let _trackedCameraFrameStop = null;
/** @type {Cesium.Model|null} Standalone 3D model for the tracked aircraft. Deliberately NOT a
 *  graphic on _trackedEntity: viewer.trackedEntity derives the follow-camera from the entity's
 *  bounding sphere, and a model graphic reports PENDING until its glTF loads — which stalls (or, on
 *  3D-toggle, freezes) the centering. A pure-billboard entity always supplies a ready sphere; the
 *  model rides in _modelCollection and is driven per-frame, fully decoupled from the camera. */
let _trackedModel = null;
/** Bumped on untrack/teardown so an in-flight tracked-model load resolves into a no-op. */
let _trackedModelGen = 0;
let _trackedModelLoading = false;
/** @type {Cesium.ScreenSpaceEventHandler|null} Click handler on the scene canvas */
let _clickHandler = null;
/** @type {Cesium.Viewer|null} Cached viewer reference */
let _viewer = null;
/** Cockpit presentation switches ambient AIR contacts between near aircraft and far dots. */
let _cockpitContactMode = false;
/** AIR contacts inside the selected Display range; independent from model admission/load/cap. */
let _cockpitNearContacts = new Set();
/** Normalized ICAO24 of the active Cockpit subject, omitted from detection candidates. */
let _cockpitSubjectId = null;
/** @type {((event: CustomEvent) => void)|null} */
let _cockpitModeListener = null;

function _emitAwarenessEvent(type, detail) {
  if (typeof window === 'undefined' || !window.dispatchEvent || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function _publishTrackedSelection(icao24, origin = 'programmatic') {
  const bb = _billboards.get(icao24);
  const info = _flightData.get(icao24);
  if (!bb?.position || !info) return false;
  if (_trackedEntity) _trackedEntity.gevSelectionOrigin = origin;
  _emitAwarenessEvent('gev:awareness-subject-selected', {
    layerId: 'flights',
    id: icao24,
    // Canonical display chain (callsign → registration → hex). Publishing a
    // bare `callsign || icao24` here resurrected the pre-enrichment behavior:
    // a callsign-less contact reached Context as its raw hex even once adsbdb
    // had supplied a registration. Identity below stays `icao24`.
    label: _contactLabel(icao24, info),
    position: Cesium.Cartesian3.clone(bb.position),
    origin,
  });
  selectTrackedSubjectContext(_contextSubjectMetadata(icao24));
  return true;
}

/**
 * Describe the selected contact for the shared context slot the voice tools
 * and Cockpit read. Values are the LIVE descriptor, not a selection-time
 * snapshot, so a long follow never narrates a position the plane has left.
 * @param {string} icao24 Contact identity.
 * @returns {object|null} Context metadata, or null when the contact is gone.
 */
function _contextSubjectMetadata(icao24) {
  const described = _describeFlight(icao24);
  if (!described) return null;
  const altFt = Math.round((described.altitudeM || 0) * 3.28084);
  const route = described.route && _routeIsPlausible(icao24, described.route)
    ? `${described.route.origin.code} → ${described.route.destination.code}`
    : null;
  return {
    id: icao24,
    layerId: 'flights',
    layerName: 'Live Flights',
    source: 'OpenSky Network',
    label: _contactLabel(icao24, _flightData.get(icao24)),
    latitude: described.latitude,
    longitude: described.longitude,
    // Flat text only: the voice payload compacts properties through a
    // string cleaner that drops nested objects.
    properties: {
      name: _contactLabel(icao24, _flightData.get(icao24)),
      operator: described.airline || '',
      callsign: described.callsign || '',
      registration: described.registration || '',
      type: described.typeName || described.typeCode || '',
      altitude: described.onGround ? 'on ground' : `${altFt.toLocaleString('en-US')} ft`,
      speed: Number.isFinite(described.velocityMps)
        ? `${Math.round(described.velocityMps * 1.944)} kt`
        : '',
      heading: Number.isFinite(described.track) ? `${Math.round(described.track)}°` : '',
      route: route || '',
      icao24,
      // Honesty cue: the contact is coasting on dead reckoning, so the
      // narrated position/velocity are last-known rather than live.
      status: described.stale ? 'stale (missed polls)' : 'live',
    },
  };
}

function _isExplicitTrackingOrigin(origin) {
  return origin === 'user' || origin === 'voice' || origin === 'tool';
}

const COCKPIT_CONTACT_SIZE_PX = 6;
const COCKPIT_CIVILIAN_COLOR = Cesium.Color.fromCssColorString('#DCEEFF');
const TRACKED_BILLBOARD_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(
  1000, 3.0, 8000000, 0.5,
);

function _normalBillboardScaleByDistance() {
  // Preserve the established close-range 3× scale. Any smaller user-visible
  // default belongs in a separate evidence-backed proposal.
  return new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5);
}

function _cockpitBillboardScaleByDistance() {
  return new Cesium.NearFarScalar(1000, 1.15, 8000000, 0.65);
}

/** Sprite kind for one contact's billboard. Identity for every aircraft except
 *  the ones the operator converted into a TR-3B (Easter egg), which draw the
 *  black-triangle glyph — its thermal-reactive variant while an IR style owns
 *  the scene. Routing EVERY `aircraftIcon()` call through this is what makes a
 *  conversion survive the poll reconciler and the two-tier raster swap. */
const _iconKind = (icao24, klass) => tr3bIconKind(icao24, klass, { hot: _irBoost });

/** Apply the current normal/cockpit visual contract to one owned fleet billboard. */
function _applyFleetBillboardPresentation(icao24, bb) {
  if (!bb) return;
  const limbScale = _billboardLimbScale.get(bb) ?? 1;
  const isCockpitContact = _cockpitContactMode && icao24 !== _trackedIcao;
  const isCockpitNear = isCockpitContact && _cockpitNearContacts.has(icao24);
  if (isCockpitContact && !isCockpitNear) {
    const freshnessAlpha = bb.color?.alpha ?? 1;
    bb.image = cockpitContactDotImage();
    bb.width = COCKPIT_CONTACT_SIZE_PX;
    bb.height = COCKPIT_CONTACT_SIZE_PX;
    bb.scale = limbScale;
    bb.scaleByDistance = _cockpitBillboardScaleByDistance();
    bb.color = (isMilitaryIcao(icao24) ? MIL_TINT : COCKPIT_CIVILIAN_COLOR).withAlpha(freshnessAlpha);
    bb.rotation = 0;
    return;
  }

  const meta = _flightData.get(icao24);
  bb.image = aircraftIcon(_iconKind(icao24, meta?.klass), bb._gevIconLarge ? TRACKED_ICON_PX : undefined);
  bb.width = icao24 === _trackedIcao ? 24 : 20;
  bb.height = icao24 === _trackedIcao ? 24 : 20;
  bb.scale = _fleetBillboardScale(icao24, meta?.klass) * limbScale;
  bb.scaleByDistance = _normalBillboardScaleByDistance();
  bb.color = _fleetBillboardColor(icao24).withAlpha(bb.color?.alpha ?? 1);
}

/**
 * Refresh the Cockpit AIR near/far band without consulting model state.
 * Near contacts keep their 2D aircraft silhouette when 3D is off, loading, or
 * capped; only a ready admitted model may take that silhouette over later.
 */
function _refreshCockpitNearContacts() {
  if (!_cockpitContactMode || !_viewer?.camera?.positionWC) {
    if (_cockpitNearContacts.size) _cockpitNearContacts = new Set();
    return;
  }
  const previous = _cockpitNearContacts;
  const distancesSquared = [];
  for (const [icao24, bb] of _billboards) {
    if (icao24 === _trackedIcao || !bb?.position) continue;
    distancesSquared.push([
      icao24,
      Cesium.Cartesian3.distanceSquared(_viewer.camera.positionWC, bb.position),
    ]);
  }
  const next = nextCockpitNearContacts(
    previous,
    distancesSquared,
    _modelAddDistM(),
    _modelKeepDistM(),
  );
  _cockpitNearContacts = next;
  let presentationChanged = false;
  for (const [icao24, bb] of _billboards) {
    if (previous.has(icao24) === next.has(icao24)) continue;
    _applyFleetBillboardPresentation(icao24, bb);
    presentationChanged = true;
  }
  if (presentationChanged) _lastCamPoseSig = '';
}

/** Switch all current and future ambient contacts between silhouettes and cockpit pips. */
function _setCockpitContactMode(active) {
  const next = active === true;
  if (_cockpitContactMode === next) return;
  _cockpitContactMode = next;
  if (next) _refreshCockpitNearContacts();
  else _cockpitNearContacts = new Set();
  // The collection stays visible in cockpit. Near AIR contacts retain their
  // aircraft silhouette until a ready model takes over; far contacts are pips.
  // Never destroy on entry: tearing down hundreds of live glTF instances
  // synchronously blocked Chrome's renderer into Page Unresponsive.
  if (_modelCollection) _modelCollection.show = true;
  _trail?.setVisible(!next);
  if (_trailHeadEntity) _trailHeadEntity.show = !next;
  for (const [icao24, bb] of _billboards) _applyFleetBillboardPresentation(icao24, bb);
  _lastCamPoseSig = '';
  _lastFleetTickMs = 0;
}

function _applyCockpitState(detail = {}) {
  const active = detail?.active === true;
  _cockpitSubjectId = active
    ? String(detail?.subjectId || '').trim().toLowerCase() || null
    : null;
  _setCockpitContactMode(active);
}

// ---------------------------------------------------------------------------
// Track-history trail state (PRD WS-F F1/F4): a fading polyline behind the
// tracked aircraft. The accumulation array is intentionally SEPARATE from
// _positionHistory (capped at POSITION_HISTORY_LIMIT=5 for dead reckoning)
// so the visible trail can grow to TRAIL_MAX_POINTS fixes.
// ---------------------------------------------------------------------------

/** @constant {string} Civilian trail hue (PRD F4, pinned). */
const TRAIL_COLOR = '#00d4ff';
/** @constant {number} Combined cap on trail vertices (backfill + live accumulation). */
const TRAIL_MAX_POINTS = 400;
/** @type {{setPositions: Function, clear: Function, destroy: Function}|null} Shared fading-trail renderer */
let _trail = null;
/** @type {Cesium.Entity|null} Cheap 2-point head segment bridging the last fix to the LIVE
 *  dead-reckoned icon, updated per frame via a CallbackProperty — so the trail head stays
 *  glued to the 12 Hz icon without rebuilding the 400-point trail primitive every frame. */
let _trailHeadEntity = null;
/** @type {number} Uniquifier for head-segment entity ids (Cesium requires unique ids). */
let _trailHeadSeq = 0;
/** @type {Cesium.Cartesian3[]} Chronological tracked-aircraft fixes (oldest first) */
let _trailPositions = [];
/** @type {number} Monotonic token — invalidates in-flight backfill responses */
let _trailBackfillToken = 0;

// ---------------------------------------------------------------------------
// Render-behind smoothing (PRD WS-C C2 — approved product decision):
// the fleet renders at now - RENDER_DELAY_SEC so positions interpolate
// BETWEEN two known fixes instead of extrapolating ahead and snapping back
// when the next poll lands. All consumers (labels, HUD, detection,
// frame_overhead) share this delayed clock; removing the delay reintroduces
// the back/forward oscillation and is a regression.
// ---------------------------------------------------------------------------

/** @constant {number} Display latency in seconds (= one poll interval). */
const RENDER_DELAY_SEC = 30;
/** @constant {number} Polls an aircraft may miss before removal (transient OpenSky dropouts). */
const MISSING_POLL_LIMIT = 3;
// --- Landed-plane fast cull (field report 2026-07-02: "phantom" planes
// lingered ~2 min at airports after touchdown). OpenSky's on_ground flag LAGS
// the actual landing, so a landed plane's last airborne-classified fixes show
// it low + slow on the runway; when such a plane then drops out of the poll,
// it has landed (the feed reclassified it to ground traffic we filter out),
// not hit a transient gap — evict after ONE missed poll instead of the full
// grace. Thresholds: below ~150 m baro (MSL, so this only fires near
// sea-level-ish fields — deliberately conservative; a high-elevation airport
// ghost just falls back to the normal grace) AND below ~45 kts ground speed
// (≈23 m/s — rollout/taxi; nothing in normal FLIGHT is this slow, so cruise
// planes always keep the full grace that absorbs real feed gaps).
/** @constant {number} Max baro altitude (m, MSL) for the landed fast cull. */
const LANDED_ALT_MAX_M = 150;
/** @constant {number} Max ground speed (m/s) for the landed fast cull (~45 kts). */
const LANDED_SPEED_MAX_MPS = 23;
/** @constant {number} Missed-poll allowance for likely-landed planes (1 = removed on the first missed poll). */
const LANDED_MISSING_POLL_LIMIT = 1;
// Field-test rounds 1+3 (2026-07-06): below-ground floor clamp scope. Only
// contacts rendering below the alt ceiling are ever clamped/warmed (terrain
// tops out well under it outside the extreme Himalaya; cruise traffic can't
// be below ground and costs zero lookups). The radius bounds the FLEET clamp
// to viewer-visible traffic — clamping thousands of global contacts would
// need unbounded terrain resolution (the tracked contact clamps regardless).
/** @constant {number} Max render altitude (m, ellipsoidal) eligible for the ground-floor clamp. */
const GROUND_FLOOR_WARM_MAX_ALT_M = 4500;
/** @constant {number} Max viewer distance (km) for the fleet ground-floor clamp. */
const GROUND_FLOOR_CLAMP_RADIUS_KM = 150;
/** @type {Map<string, number>} icao24 -> consecutive missed polls */
let _missingPolls = new Map();

/**
 * Cheap equirectangular distance (km) — plenty accurate for the ~150 km
 * ground-floor clamp gate; runs once per contact per poll, so no trig-heavy
 * haversine needed.
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number} Approximate great-circle distance in km.
 */
function _approxDistanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111.32;
  const dLon = (lon2 - lon1) * 111.32 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * True when the aircraft's latest metadata reads "on or about the runway"
 * (low + slow) — see the landed fast-cull rationale above. Both gates must
 * hold, so a plane missing either datum keeps the normal grace.
 * @param {string} icao24 - ICAO 24-bit transponder address.
 * @returns {boolean}
 */
function _likelyLanded(icao24) {
  const info = _flightData.get(icao24);
  if (!info) return false;
  // Round 7: the fast cull only applies to contacts that were AIRBORNE
  // this session — its original target, the post-LANDING ghost. OpenSky's
  // ground coverage flaps constantly, so fast-culling every grounded contact
  // put parked planes in an evict/re-enter churn: each re-entry was a
  // brand-new contact with cold floor state (geoid-height first poll), so
  // the apron looked half-empty AND perpetually sunken. First-seen-grounded
  // contacts now ride the normal MISSING_POLL_LIMIT grace and keep their
  // identity (and warmed floors) across feed flaps.
  if (info.wasAirborne !== true) return false;
  // Was airborne, then grounded, then VANISHED from the poll — landed ghost.
  if (info.onGround) return true;
  return Number.isFinite(info.altitude) && info.altitude < LANDED_ALT_MAX_M
    && Number.isFinite(info.velocity) && info.velocity < LANDED_SPEED_MAX_MPS;
}

// ---------------------------------------------------------------------------
// Icon orientation (2026-06-10 playtest fix): rotation is computed by
// projecting each aircraft's course vector into WINDOW coordinates
// (iconOrientation.js) with alignedAxis always ZERO — exact at every camera
// pitch/heading, including tracked-entity orbit mode. Rotation passes run on
// the fleet tick only when the camera pose changed (or 1s drift catch-up).
// The same tick horizon-culls billboards: with the Cesium globe hidden there
// is no far-side depth, so planes otherwise show through the planet.
// ---------------------------------------------------------------------------

/** @constant {number} Fleet dead-reckoning tick interval (ms) — ~12Hz, not per-frame. */
const FLEET_DR_INTERVAL_MS = 80;
/** @constant {number} Max ms between rotation passes while the camera is idle. */
const ROTATION_REFRESH_MS = 1000;
/** @type {number} Epoch ms of the last fleet dead-reckoning pass */
let _lastFleetTickMs = 0;
/** @type {string} Camera pose signature at the last rotation pass */
let _lastCamPoseSig = '';
/** @type {number} Epoch ms of the last full rotation pass */
let _lastRotPassMs = 0;
/** @type {number} Last computed rotation for the tracked entity (radians) */
let _lastTrackedRotation = 0;
/** @type {Cesium.Event.RemoveCallback|null} preRender listener disposer */
let _preRenderRemove = null;
let _trackedModelPreUpdateRemove = null;
/** @type {Cesium.Event.RemoveCallback|null} camera.moveEnd listener disposer (arrival rotation pass) */
let _moveEndRemove = null;
/** @type {Cesium.Event.RemoveCallback|null} trackedEntityChanged listener disposer (cross-layer untrack) */
let _trackedEntityChangedRemove = null;
/** @type {(() => void)|null} militaryRegistry active-transition unsubscribe (M2 handoff sweep) */
let _milActiveChangeUnsub = null;

// ---------------------------------------------------------------------------
// Scratch (reusable) variables — avoid per-frame heap allocation
// ---------------------------------------------------------------------------

const _scratchOffset = new Cesium.Cartesian3();
const _scratchCarto = new Cesium.Cartographic();
const _scratchEnu = new Cesium.Matrix4();
const _scratchArc = { east: 0, north: 0, endCourseDeg: 0 };
const _scratchRenderTime = new Cesium.JulianDate();
const _scratchFleetPos = new Cesium.Cartesian3();
const _scratchDrRaw = new Cesium.Cartesian3();
const _scratchWarmupTime = new Cesium.JulianDate();
const _trackedPosHolder = new Cesium.Cartesian3();

// ---------------------------------------------------------------------------
// Per-frame cache for the tracked entity's dead-reckoned position.
// The position, alignedAxis, and rotation CallbackProperties all fire each
// render frame; caching avoids running _deadReckon three times.
// ---------------------------------------------------------------------------

/** @type {Cesium.Cartesian3|null} */
let _cachedDRPosition = null;
/** @type {number} Frame number for which _cachedDRPosition is valid */
let _cachedDRFrame = -1;

/** Course (deg) of the position `_deadReckon` most recently returned — set on
 *  every branch of `_deadReckon`, read IMMEDIATELY by the caller (same
 *  synchronous flow; module-scratch idiom, like the Cartesian scratches). */
let _drCourseDeg = null;
/** Sibling scratches of _drCourseDeg: the displayed ground speed of the motion
 *  `_deadReckon` just returned, and whether that motion is too slow for ANY
 *  course source to be trusted (hover/GPS drift — consumers HOLD their
 *  previous display course instead of chasing noise). */
let _drSpeedMps = null;
let _drCourseHold = false;
/** Sibling scratch: whether the position `_deadReckon` just returned came from
 *  EXTRAPOLATION (coasting past the newest fix, or the pre-history warm-up)
 *  rather than interpolation between two known fixes. The display-floor
 *  corridor needs it — an interpolating contact is walking TOWARD its newest
 *  fix, a coasting one is walking AWAY from it along its course, and warming
 *  the wrong end leaves a coaster permanently ahead of its floor data. */
let _drExtrapolating = false;
/** Frame-cached course for the tracked aircraft (sibling of _cachedDRPosition). */
let _cachedDRCourse = null;
/** Frame-cached siblings of _cachedDRCourse (same discipline). */
let _cachedDRSpeedMps = null;
let _cachedDRHold = false;
/** Wall-clock of the tracked course limiter's last advance (dt source only —
 *  the course VALUE lives in the shared per-icao _displayCourse map below). */
let _trackedCourseMs = 0;
/** Per-aircraft smoothed display course — the SINGLE source of truth for the
 *  nose direction an aircraft displays. The fleet pass reads/writes it at
 *  tick cadence for untracked planes; _trackedDisplayCourse reads/writes the
 *  SAME entry per frame for the tracked plane (the fleet pass skips the
 *  tracked icao, so exactly one writer owns an entry at a time). Sharing the
 *  entry — including its slew state — is what makes the tracked↔fleet
 *  handoff seamless (2026-07-03 field fix: separate states froze the fleet
 *  entry while tracked, so clicking / un-clicking a 65 kt helicopter FLIPPED
 *  its nose — "looks like it's going in reverse"). */
const _displayCourse = new Map();
/** Max course slew (deg/s) — well above real turns (≤4°/s), hides fix-boundary
 *  steps. Scaled down toward COURSE_MIN_DPS at low speed (courseSlewCapDps). */
const COURSE_MAX_DPS = 60;
/** Never spend a long render stall's full elapsed time in one visible course step. */
const COURSE_SLEW_DT_MAX_SEC = 0.25;

// ---------------------------------------------------------------------------
// adsbdb enrichment (best-effort, fail-silent). Bounded fan-out: max 4
// concurrent requests, dispatches dripped ≥ENRICH_DISPATCH_GAP_MS apart
// (≤5/s — adsbdb is a free community API; the dev-server proxy additionally
// caches per-key on disk forever, negative results included, so repeat
// sessions never re-hit adsbdb). Each key is requested at most once per
// session. Priority jobs (tracked plane, model-eligible planes) jump the
// queue; the ambient fleet sweep (below) fills the back at poll cadence.
// ---------------------------------------------------------------------------
const ENRICH_MAX_INFLIGHT = 4;
/** Min ms between request dispatches — the drip that bounds the fan-out to ≤5/s. */
const ENRICH_DISPATCH_GAP_MS = 200;
let _enrichActive = 0;
let _enrichLastDispatchMs = 0;
/** @type {ReturnType<typeof setTimeout>|null} pending drip wake-up */
let _enrichDripTimer = null;
const _enrichQueue = [];
const _enrichSeen = new Set();

function _enqueueEnrich(key, url, onData, priority = false) {
  if (_enrichSeen.has(key)) return;
  _enrichSeen.add(key);
  const job = { url, onData };
  // Priority (tracked / model-eligible) goes to the FRONT so a deep ambient
  // backlog can never delay the plane the user just clicked or zoomed into.
  if (priority) _enrichQueue.unshift(job); else _enrichQueue.push(job);
  _drainEnrich();
}

function _drainEnrich() {
  while (_enrichActive < ENRICH_MAX_INFLIGHT && _enrichQueue.length) {
    // Drip: at most one dispatch per ENRICH_DISPATCH_GAP_MS. When the gap
    // hasn't elapsed yet, park a single wake-up timer and stop — completions
    // and enqueues in the meantime re-enter here harmlessly.
    const wait = ENRICH_DISPATCH_GAP_MS - (Date.now() - _enrichLastDispatchMs);
    if (wait > 0) {
      if (!_enrichDripTimer) {
        _enrichDripTimer = setTimeout(() => { _enrichDripTimer = null; _drainEnrich(); }, wait);
      }
      return;
    }
    _enrichLastDispatchMs = Date.now();
    const job = _enrichQueue.shift();
    _enrichActive += 1;
    fetch(job.url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data && data.found) job.onData(data); })
      .catch(() => { /* enrichment never surfaces errors */ })
      .finally(() => { _enrichActive -= 1; _drainEnrich(); });
  }
}

function _requestTypeEnrichment(icao24, priority = false) {
  if (!/^[0-9a-f]{6}$/i.test(icao24)) return;
  _enqueueEnrich(`t:${icao24}`, `/api/gev/adsbdb/type/${icao24.toLowerCase()}`, (data) => {
    const meta = _flightData.get(icao24);
    if (!meta) return; // evicted while the lookup was in flight
    meta.typeCode = data.typeCode || meta.typeCode;
    meta.typeName = data.typeName || meta.typeName;
    meta.registration = data.registration || meta.registration;
    if (meta.typeCode) {
      const klass = classifyAircraft({ typeCode: meta.typeCode, category: meta.category });
      if (klass !== meta.klass) {
        meta.klass = klass;
        const bb = _billboards.get(icao24);
        if (bb) _applyFleetBillboardPresentation(icao24, bb);
        // Hangar fleet: the class's GLB/scale may have changed — resync the
        // live model, any in-flight load, and the tracked standalone model.
        _syncModelToClass(icao24);
      }
    }
    if (icao24 === _trackedIcao && _trackedEntity) _updateTrackedLabelModel(icao24);
  }, priority);
}

function _requestRouteEnrichment(icao24) {
  const cs = String(_flightData.get(icao24)?.callsign || '').trim().toUpperCase();
  if (!/^[A-Z]{3}\d/.test(cs)) return; // airline-style callsigns only (LLL + digit); GA tails won't resolve
  _enqueueEnrich(`r:${cs}`, `/api/gev/adsbdb/route/${encodeURIComponent(cs)}`, (data) => {
    const meta = _flightData.get(icao24);
    if (!meta) return;
    meta.airline = data.airline || meta.airline;
    if (data.origin && data.destination) meta.route = { origin: data.origin, destination: data.destination };
    if (icao24 === _trackedIcao && _trackedEntity) _updateTrackedLabelModel(icao24);
  }, true); // route lookups only fire for the TRACKED plane — front of the queue
}

// ---------------------------------------------------------------------------
// Ambient fleet type enrichment (2026-07-02 field data: OpenSky's live
// category field is 0/"no info" for ~94% of planes, so ambient classification
// defaulted nearly the whole fleet to the airliner silhouette). Each poll,
// ON-SCREEN planes — same horizon-occluder + frustum tests the fleet tick's
// model-eligibility pass uses; no new per-plane raycast — that haven't been
// requested this session are enqueued NEAREST-TO-CAMERA FIRST, bounded by:
//   - the shared queue's 4-concurrent / 200 ms-drip dispatch (above),
//   - ≤ ENRICH_AMBIENT_PER_SWEEP new enqueues per poll (= one poll interval
//     of drip, so the backlog can't outgrow a poll and re-sorts fresh), and
//   - a ROLLING token-bucket budget (below) bounding the sustained ambient
//     request rate (repeat sessions resolve instantly from the proxy's
//     permanent disk cache).
// Fail-silent by contract: the sweep never throws into the poll loop, never
// blocks rendering, and never touches tracking state. When a type answer
// lands, _requestTypeEnrichment's callback swaps the billboard glyph + scale
// in place (bb.scale composes multiplicatively with scaleByDistance).
// ---------------------------------------------------------------------------
// Rolling ambient budget (2026-07-03 field fix). The old ONE-SHOT session cap
// (300, refilled only in init) burned out in the first two polls of a busy
// region and never recovered — an hours-long session showed airliner
// monoculture in every NEW region until planes were clicked (the tracked path
// is uncapped). Token bucket instead: starts full at the ceiling, refills
// ENRICH_AMBIENT_REFILL_TOKENS every ENRICH_AMBIENT_REFILL_WINDOW_MS, clamped
// at the ceiling (no banking beyond one bucket). Numbers: 150 / 5 min sustains
// 0.5 req/s worst case — an order of magnitude under the 5/s drip that (with
// the 4-concurrent limit + the proxy's permanent disk cache) is the REAL
// politeness bound on adsbdb; the 300 ceiling preserves the old first-look
// burst so a fresh region still classifies quickly.
/** Bucket ceiling: max ambient tokens held at once (= the initial burst). */
const ENRICH_AMBIENT_BUDGET_CEIL = 300;
/** Tokens added back per refill window. */
const ENRICH_AMBIENT_REFILL_TOKENS = 150;
/** Refill window length (ms). */
const ENRICH_AMBIENT_REFILL_WINDOW_MS = 5 * 60 * 1000;
/** Max new ambient enqueues per poll sweep (≈ rate × poll interval). */
const ENRICH_AMBIENT_PER_SWEEP = 150;
let _enrichAmbientBudget = ENRICH_AMBIENT_BUDGET_CEIL;
/** Epoch ms the bucket last accounted a refill window from (0 = unset). */
let _enrichAmbientRefillAnchorMs = 0;

/** QA seam: headless harnesses (scripts/qa-enrich-ambient.mjs) shrink the
 *  bucket knobs via window.__GEV_ENRICH_AMBIENT_QA = {ceil, refillTokens,
 *  windowMs} — they cannot wait out a real 5-minute window. Read lazily each
 *  refill so a pre-boot override (or a mid-run windowMs swap) applies.
 *  Production never sets this; the constants above are the defaults. */
function _ambientBudgetKnobs() {
  const o = (typeof window !== 'undefined' && window.__GEV_ENRICH_AMBIENT_QA) || null;
  return {
    ceil: Number.isFinite(o?.ceil) && o.ceil > 0 ? o.ceil : ENRICH_AMBIENT_BUDGET_CEIL,
    refillTokens: Number.isFinite(o?.refillTokens) && o.refillTokens > 0 ? o.refillTokens : ENRICH_AMBIENT_REFILL_TOKENS,
    windowMs: Number.isFinite(o?.windowMs) && o.windowMs > 0 ? o.windowMs : ENRICH_AMBIENT_REFILL_WINDOW_MS,
  };
}

/** Advance the token bucket: add refillTokens per FULLY elapsed window since
 *  the anchor, clamp at the ceiling, and move the anchor forward by the whole
 *  windows consumed (while the bucket sits full this still advances, so idle
 *  time never banks more than one bucket's worth of burst). */
function _refillAmbientBudget(nowMs) {
  const { ceil, refillTokens, windowMs } = _ambientBudgetKnobs();
  if (!_enrichAmbientRefillAnchorMs) { _enrichAmbientRefillAnchorMs = nowMs; return; }
  const windows = Math.floor((nowMs - _enrichAmbientRefillAnchorMs) / windowMs);
  if (windows <= 0) return;
  _enrichAmbientBudget = Math.min(ceil, _enrichAmbientBudget + windows * refillTokens);
  _enrichAmbientRefillAnchorMs += windows * windowMs;
}

function _sweepAmbientEnrichment() {
  _refillAmbientBudget(Date.now());
  if (_enrichAmbientBudget <= 0 || !_viewer || !_billboardCollection || !_billboardCollection.show) return;
  try {
    const camera = _viewer.camera;
    const camPos = camera.positionWC;
    const occluder = horizonOccluder(camera);
    const cull = camera.frustum.computeCullingVolume(camPos, camera.directionWC, camera.upWC);
    const cand = [];
    for (const [icao24, bb] of _billboards) {
      if (_enrichSeen.has(`t:${icao24}`)) continue; // answered / queued / negative this session
      if (!/^[0-9a-f]{6}$/i.test(icao24)) continue; // adsbdb keys are 6-char hex only
      if (_flightData.get(icao24)?.onGround) continue; // ground traffic never spends ambient budget (click-to-enrich still works)
      if (!bb.position || !occluder.isPointVisible(bb.position)) continue; // beyond the limb
      Cesium.Cartesian3.clone(bb.position, _scratchModelBS.center);
      if (cull.computeVisibility(_scratchModelBS) === Cesium.Intersect.OUTSIDE) continue; // off-screen
      cand.push([icao24, Cesium.Cartesian3.distanceSquared(camPos, bb.position)]);
    }
    cand.sort((a, b) => a[1] - b[1]); // nearest first — what the user is looking at resolves first
    const n = Math.min(cand.length, ENRICH_AMBIENT_PER_SWEEP, _enrichAmbientBudget);
    for (let i = 0; i < n; i++) {
      _enrichAmbientBudget -= 1;
      _requestTypeEnrichment(cand[i][0]); // non-priority: fills the back of the queue
    }
  } catch { /* ambient enrichment is best-effort — never disturb the poll loop */ }
}

// Round 5: the old `_warmGroundedAircraftSurfaceCache` (global exact-5-decimal
// warm for every grounded contact on Earth) is GONE. Parked-aircraft GPS
// jitter minted fresh keys every poll → thousands of upstream points per
// minute → Re:Earth proxy failures → geoid-fallback POISON cached at
// sea-level heights → sunken sprites/trails and rejected mesh samples. The
// coarse ~111 m floor cells (viewer-proximate, collected in the poll loop)
// are the only DEM warm the layer needs.

/**
 * Round 6: lifts STALE grounded contacts onto floors that warmed after
 * their last feed fix. A parked plane whose transponder went quiet keeps
 * coasting on its final meta — if that fix predated the floor warm, it sat
 * frozen underground forever. Runs once per poll over the (bounded) flight
 * map; touches only grounded, feed-absent, demonstrably-below-floor
 * contacts, and patches the stored fix + billboard in place (zero-velocity
 * DR renders the patched fix verbatim).
 * @param {Set<string>} currentIcaos - Contacts present in THIS poll (already
 *   floored by the live path — skipped here).
 */
function _refloorStaleGroundedContacts(currentIcaos) {
  for (const [icao24, info] of _flightData) {
    if (!info?.onGround || currentIcaos.has(icao24)) continue;
    if (!Number.isFinite(info.rawLat) || !Number.isFinite(info.rawLon)) continue;
    const floor = cachedGroundFloor(info.rawLat, info.rawLon);
    if (!Number.isFinite(floor)) continue;
    const lifted = floor + GROUND_FLOOR_LIFT_M;
    if (Number.isFinite(info.renderAltitudeM) && info.renderAltitudeM >= floor - 1) continue;
    info.renderAltitudeM = lifted;
    info.cullPosition = null; // above the ellipsoid now (or floors say otherwise next poll)
    const position = Cesium.Cartesian3.fromDegrees(info.rawLon, info.rawLat, lifted);
    const history = _positionHistory.get(icao24);
    const newest = history?.[history.length - 1];
    if (newest) newest.position = Cesium.Cartesian3.clone(position, newest.position);
    const bb = _billboards.get(icao24);
    if (bb) bb.position = position;
  }
}

// ---------------------------------------------------------------------------
// Tracked-display reconciliation. _deadReckon gives the RAW position from real
// fixes; at the warm-up→interpolation handoff (and on feed glitches / backfill
// splices) that raw value can step discontinuously. We absorb a step into a
// correction offset that decays to zero over DR_CORRECTION_MS, so the tracked
// icon, camera, and trail head never visibly jump — with ZERO steady-state lag
// (the correction stays ~0 whenever motion is already continuous).
// ---------------------------------------------------------------------------

const DR_CORRECTION_MS = 900;
const _drCorrection = new Cesium.Cartesian3(0, 0, 0);
let _drCorrectionStartMs = 0;
const _drPrevRaw = new Cesium.Cartesian3();
const _drPrevDisplay = new Cesium.Cartesian3();
let _drPrevMs = 0;
let _drReconcileValid = false;
/** @type {string|null} icao the reconciliation state currently belongs to */
let _drReconcileIcao = null;

/**
 * Normalize a value to a trimmed lowercase string.
 * @param {*} value - Any value (typically a header string or null).
 * @returns {string} Lowercase trimmed string, or '' if falsy.
 */
function _toLowerText(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Normalize a value to a trimmed string. A whitespace-only field ("   ") is
 * truthy, so every label chain must trim FIRST and then fall through.
 * @param {*} value - Any value (typically a metadata string or null).
 * @returns {string} Trimmed string, or '' if falsy.
 */
function _toCleanText(value) {
  return String(value || '').trim();
}

/**
 * The layer's ONE label convention: spoken callsign → tail registration → raw
 * ICAO hex. Mirrors militaryFlights.js so the same aircraft reads identically
 * in both layers.
 *
 * Registration is aircraft IDENTITY, not route, so unlike the origin/destination
 * line it is NOT plausibility-gated — an adsbdb tail number describes the
 * airframe itself and cannot go stale the way a leg can.
 *
 * This is a DISPLAY string only. Identity everywhere in this layer is `icao24`
 * (the `_billboards`/`_flightData` key, the `sourceId` detection declutter hashes,
 * the `id` that trackById/Context cohorts resolve) — never the label.
 * @param {string} icao24 - ICAO 24-bit transponder address (the identity key).
 * @param {Object|null|undefined} info - `_flightData` record for this aircraft.
 * @returns {string} Display label; never empty.
 */
function _contactLabel(icao24, info) {
  return _toCleanText(info?.callsign) || _toCleanText(info?.registration) || icao24;
}

/**
 * Map OpenSky proxy response headers into a human-readable auth error string.
 * The Vite proxy forwards `x-opensky-auth-mode-used` and `x-opensky-auth-reason`
 * headers so the client can display a meaningful diagnostic.
 * @param {object} params
 * @param {string} params.detail  - Error body text from the proxy, if any.
 * @param {string} params.authMode - Normalized auth mode header value.
 * @param {string} params.authReason - Normalized auth reason header value.
 * @returns {string} Concise error description for UI display.
 */
function _deriveOpenSkyAuthError({ detail, authMode, authReason }) {
  const reason = _toLowerText(authReason);
  const mode = _toLowerText(authMode);

  if (reason === 'oauth_invalid_or_missing') {
    return 'OpenSky OAuth client missing/invalid';
  }
  if (reason === 'oauth_invalid_credentials') {
    return 'OpenSky OAuth rejected credentials';
  }
  if (reason === 'basic_invalid_credentials') {
    return 'OpenSky username/password rejected';
  }
  if (reason === 'missing_basic_creds' || reason === 'missing_oauth_and_basic_creds') {
    return 'OpenSky auth missing';
  }
  if (reason === 'auth_required') {
    return 'OpenSky auth required';
  }
  if (reason.startsWith('oauth_') || reason.startsWith('basic_')) {
    return 'OpenSky auth invalid';
  }
  if (reason === 'forced_anonymous' || mode === 'anon') {
    return 'OpenSky auth required';
  }
  if (detail) return detail;
  return 'OpenSky auth failed';
}

/**
 * Dead-reckon an aircraft's current position using ENU (East-North-Up) frame math.
 *
 * Projects forward from the last known API fix using the aircraft's ground
 * velocity and true_track heading.  The ENU transform avoids repeated lat/lon
 * trig, keeping the per-frame cost low.
 *
 * If this aircraft is the tracked target and a lerp is in progress (new API
 * fix just arrived), the function first blends from the old dead-reckoned
 * position toward the corrected fix before projecting forward.
 *
 * @param {string} icao24 - ICAO 24-bit transponder address of the aircraft.
 * @returns {Cesium.Cartesian3|null} Estimated ECEF position, or null if no history exists.
 */
function _deadReckon(icao24, result) {
  const info = _flightData.get(icao24);
  if (FOCUS_EVIDENCE_DEV && _focusEvidenceIds.has(icao24)) {
    const position = _billboards.get(icao24)?.position;
    _drCourseDeg = info?.true_track || 0;
    _drSpeedMps = info?.velocity || 0;
    _drCourseHold = _drSpeedMps < COURSE_HOLD_SPEED_MPS;
    _drExtrapolating = false;
    return position ? Cesium.Cartesian3.clone(position, result || new Cesium.Cartesian3()) : null;
  }
  const history = _positionHistory.get(icao24);
  if (!history || history.length === 0) {
    _drCourseDeg = null; _drSpeedMps = null; _drCourseHold = false; _drExtrapolating = false;
    return null;
  }

  const out = result || new Cesium.Cartesian3();
  // Render one poll interval behind real time so we interpolate between
  // two KNOWN fixes whenever possible (see RENDER_DELAY_SEC rationale).
  const renderTime = Cesium.JulianDate.addSeconds(
    Cesium.JulianDate.now(), -RENDER_DELAY_SEC, _scratchRenderTime
  );

  // Bracketing pair: interpolate — no extrapolation error, no snap-back.
  for (let i = history.length - 1; i >= 1; i--) {
    const a = history[i - 1];
    const b = history[i];
    if (
      Cesium.JulianDate.lessThanOrEquals(a.time, renderTime) &&
      Cesium.JulianDate.lessThanOrEquals(renderTime, b.time)
    ) {
      const span = Cesium.JulianDate.secondsDifference(b.time, a.time);
      const t = span > 0
        ? Cesium.JulianDate.secondsDifference(renderTime, a.time) / span
        : 1.0;
      // Course of the DISPLAYED motion. The chord is only trustworthy when the
      // segment covers real ground (at hover its direction is GPS jitter; on a
      // slow tight turn it STEPS the whole per-segment turn at each boundary),
      // so it is blended against the reported per-fix track by displayed
      // ground speed — and the track is TIME-INTERPOLATED between the fixes so
      // a slow turner's nose advances continuously through the segment instead
      // of snapping once per poll. Helicopters always use the reported track
      // (rotorcraft chords are noise-dominated at their typical speeds).
      const chordLenM = Cesium.Cartesian3.distance(a.position, b.position);
      const segSpeed = span > 0 ? chordLenM / span : ((info && info.velocity) || 0);
      const fallbackTrack = (info && info.true_track) || 0;
      const trackFrom = Number.isFinite(a.track) ? a.track : fallbackTrack;
      const trackTo = Number.isFinite(b.track) ? b.track : trackFrom;
      const trackCourse = lerpAngleDeg(trackFrom, trackTo, t);
      const w = (info && info.klass === 'helicopter') ? 0 : speedRamp(segSpeed);
      const chordCourse = w > 0 ? courseBetweenCartesians(a.position, b.position) : null;
      _drCourseDeg = chordCourse != null ? lerpAngleDeg(trackCourse, chordCourse, w) : trackCourse;
      _drSpeedMps = segSpeed;
      _drCourseHold = segSpeed < COURSE_HOLD_SPEED_MPS;
      _drExtrapolating = false;
      return Cesium.Cartesian3.lerp(a.position, b.position, t, out);
    }
  }

  const newest = history[history.length - 1];
  const elapsedSec = Cesium.JulianDate.secondsDifference(renderTime, newest.time);
  if (elapsedSec <= 0) {
    // Warm-up: renderTime predates ALL history (freshly seen / just-started-tracking
    // aircraft, before RENDER_DELAY_SEC of history has accumulated, so no bracketing
    // pair exists yet). Render at the DELAYED renderTime — preserving the 30s-behind
    // invariant — by extrapolating the OLDEST fix BACKWARD to renderTime. As history
    // fills, renderTime advances toward the first fix and the icon glides FORWARD into
    // the bracketing interpolation above with NO freeze and NO backward snap. (Holding
    // the oldest fix froze the icon; extrapolating the NEWEST fix to wall-clock now made
    // the icon jump back ~one poll interval the instant interpolation took over.)
    const oldest = history[0];
    const lookbackSec = Cesium.JulianDate.secondsDifference(oldest.time, renderTime); // ≥ 0
    return _extrapolateFix(oldest, info, -Math.min(lookbackSec, 60), out, (info && info.turnRateDps) || 0);
  }

  // Newest POSITION is older than renderTime. OpenSky can still be receiving
  // fresh contact/kinematic messages for that aircraft; freezing at a hard
  // 60 s-after-position boundary produced the visible stop → catch-up → stop
  // cadence. Coast through the latest real contact plus a bounded grace
  // window, with an absolute cap so a stale cached feed cannot drift forever.
  const coastLimitSec = staleCoastLimitSeconds({
    // `epochMs` is captured once when the poll is normalized. Avoid allocating
    // a Date per aircraft on every 12 Hz fleet tick.
    fixEpochMs: Number.isFinite(newest.epochMs)
      ? newest.epochMs
      : Cesium.JulianDate.toDate(newest.time).getTime(),
    lastContactEpochMs: info?.lastContactEpochMs,
    // Permit one minute of contact grace but cap any cached-feed drift at
    // five minutes. Source backoff is exposed separately as a STALE cue.
    minimumSec: 60,
    maximumSec: 300,
  });
  return _extrapolateFix(
    newest,
    info,
    Math.min(elapsedSec, coastLimitSec),
    out,
    (info && info.turnRateDps) || 0,
  );
}

/**
 * Dead-reckon a fix along its own velocity/track by `dt` seconds, integrating a
 * constant-rate-turn arc when `turnRateDps` is significant (straight line
 * otherwise). Positive `dt` projects FORWARD (after the fix); negative `dt`
 * projects BACKWARD (before the fix) — used for warm-up, estimating where the
 * aircraft was before its first observed fix. ENU frame: east = +X, north = +Y,
 * up = +Z; heading 0 deg = north, 90 deg = east. Sets `_drCourseDeg` to the
 * arc's instantaneous end course on every path.
 * Arc math adapted from skylight (https://github.com/cpaczek/skylight, MIT).
 */
function _extrapolateFix(fix, info, dt, out, turnRateDps = 0) {
  const speed = Number.isFinite(fix.velocity) ? fix.velocity : ((info && info.velocity) || 0);
  const heading = Number.isFinite(fix.track) ? fix.track : ((info && info.true_track) || 0);
  _drSpeedMps = speed;
  _drCourseHold = speed < COURSE_HOLD_SPEED_MPS;
  _drExtrapolating = true;
  if (speed === 0 || dt === 0) {
    _drCourseDeg = heading;
    return Cesium.Cartesian3.clone(fix.position, out);
  }
  // Constant-rate-turn arc (straight line when turnRateDps ≈ 0) — a plane in a
  // standard-rate turn is ~90° of arc wrong per 30 s if extrapolated straight.
  arcOffsetEnu(speed, heading, turnRateDps, dt, _scratchArc);
  _drCourseDeg = _scratchArc.endCourseDeg;
  Cesium.Cartesian3.fromElements(_scratchArc.east, _scratchArc.north, 0, _scratchOffset);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(fix.position, Cesium.Ellipsoid.WGS84, _scratchEnu);
  return Cesium.Matrix4.multiplyByPoint(enu, _scratchOffset, out);
}

/**
 * True while the tracked aircraft's delayed display time (now − RENDER_DELAY_SEC)
 * predates its oldest real fix — i.e. _deadReckon is extrapolating backward, with no
 * real history yet sitting BEHIND the displayed icon. The trail must draw nothing in
 * this window (every accumulated point is ahead of the icon).
 * @returns {boolean}
 */
function _isTrackWarmingUp() {
  if (!_trackedIcao) return false;
  const history = _positionHistory.get(_trackedIcao);
  if (!history || history.length === 0) return true;
  const renderTime = Cesium.JulianDate.addSeconds(
    Cesium.JulianDate.now(), -RENDER_DELAY_SEC, _scratchWarmupTime
  );
  return Cesium.JulianDate.lessThan(renderTime, history[0].time);
}

/** Resolve the selected aircraft's actual rendered square extent this frame. */
function _trackedFocusSizePx(icao24, position) {
  const camera = _viewer?.camera;
  const scene = _viewer?.scene;
  if (!camera?.positionWC || !position || !scene) return 28;
  const rangeM = Cesium.Cartesian3.distance(camera.positionWC, position);
  if (_modelOwnsVisual(icao24)) {
    const spec = _modelSpec(_flightData.get(icao24)?.klass);
    const scale = trackedModelScaleForPixelCap({
      baseScale: spec.scale,
      nativeRadiusM: spec.nativeRadiusM,
      rangeM,
      viewportHeightPx: scene.canvas.clientHeight,
      fovyRad: camera.frustum.fovy,
      maximumPixelSize: TRACKED_MODEL_MAX_PX,
    });
    const focalLengthPx = scene.canvas.clientHeight / (2 * Math.tan(camera.frustum.fovy / 2));
    const projectedDiameterPx = (2 * spec.nativeRadiusM * scale * focalLengthPx) / rangeM;
    return Math.max(TRACKED_MODEL_MIN_PX, Math.min(TRACKED_MODEL_MAX_PX, projectedDiameterPx));
  }

  const billboard = _trackedEntity?.billboard;
  const time = _viewer.clock.currentTime;
  const width = billboard?.width?.getValue(time) ?? 28;
  const height = billboard?.height?.getValue(time) ?? 28;
  const scale = billboard?.scale?.getValue(time)
    ?? (CLASS_SCALE_2D[_flightData.get(icao24)?.klass] || 1);
  const scaleByDistance = billboard?.scaleByDistance?.getValue(time)
    ?? TRACKED_BILLBOARD_SCALE_BY_DISTANCE;
  const distanceScale = nearFarScalarValueAtDistance(scaleByDistance, rangeM);
  return Math.max(width, height) * scale * distanceScale;
}

/**
 * Per-frame-cached, discontinuity-smoothed tracked DISPLAY position. Cached by Cesium
 * frame number so the position / rotation / trail-head callbacks share ONE computation
 * (and one reconciliation-state update) per frame. Returns a stable module holder, or
 * null when the aircraft has no fix.
 * @param {string} icao24
 * @returns {Cesium.Cartesian3|null}
 */
function _trackedDisplayPosition(icao24) {
  const frame = _viewer?.scene?.frameState?.frameNumber ?? -1;
  if (frame === _cachedDRFrame && icao24 === _drReconcileIcao) return _cachedDRPosition;

  // Does the reconciliation state belong to THIS aircraft? (Capture before overwriting
  // _drReconcileIcao, so a track switch doesn't inherit the old plane's _drPrevRaw.)
  const sameTrack = _drReconcileValid && _drReconcileIcao === icao24;
  const raw = _deadReckon(icao24, _scratchDrRaw);
  _cachedDRCourse = _drCourseDeg;
  _cachedDRSpeedMps = _drSpeedMps;
  _cachedDRHold = _drCourseHold;
  _cachedDRFrame = frame;
  _drReconcileIcao = icao24;
  if (!raw) {
    _cachedDRPosition = null;
    _drReconcileValid = false;
    clearFocusTarget('flights', icao24);
    return null;
  }

  const nowMs = Date.now();
  const info = _flightData.get(icao24);
  if (sameTrack) {
    const dtSec = Math.max(0.001, (nowMs - _drPrevMs) / 1000);
    const speed = (info && info.velocity) || 0;
    // Plausible single-frame motion (m): real velocity × frame Δt, ×4 slack + 25 m base.
    const plausible = speed * dtSec * 4 + 25;
    if (Cesium.Cartesian3.distance(raw, _drPrevRaw) > plausible) {
      // Discontinuity — re-anchor so the DISPLAYED position stays continuous, then decay.
      Cesium.Cartesian3.subtract(_drPrevDisplay, raw, _drCorrection);
      _drCorrectionStartMs = nowMs;
    }
  } else {
    Cesium.Cartesian3.fromElements(0, 0, 0, _drCorrection);
    _drCorrectionStartMs = nowMs - DR_CORRECTION_MS; // fully decayed
  }

  const elapsed = nowMs - _drCorrectionStartMs;
  const factor = elapsed >= DR_CORRECTION_MS ? 0 : 1 - elapsed / DR_CORRECTION_MS;
  let display = Cesium.Cartesian3.multiplyByScalar(_drCorrection, factor, _trackedPosHolder);
  Cesium.Cartesian3.add(raw, display, display);
  // Same display floor the fleet pass applies — otherwise selecting a correctly
  // floored grounded billboard swapped it for an unfloored tracked entity and
  // dropped the cyan target back under the mesh. Applied HERE, at the single
  // point every VISUAL consumer's per-frame position is computed, so the
  // readout anchor, detection bracket, trail head and follow-camera all read
  // the one floored value (the anti-jitter contract forbids recomputing per
  // consumer). NOT the single point for DATA: `_describeFlight` deliberately
  // reports sensor truth — see the note there. Skipped while a tracked 3D model
  // owns the visual: it rides groundSnap's one-shot sample and moving its input
  // would force a re-sample (T7).
  display = _floorGroundedDisplayPosition(icao24, info, display, _modelOwnsVisual(icao24), nowMs);

  Cesium.Cartesian3.clone(raw, _drPrevRaw);
  Cesium.Cartesian3.clone(display, _drPrevDisplay);
  _drPrevMs = nowMs;
  _drReconcileValid = true;
  _cachedDRPosition = display;
  const focusSizePx = _trackedFocusSizePx(icao24, _cachedDRPosition);
  // Publish only the exact per-frame display cache the tracked entity/camera
  // consumes. Re-running DR from a later frame phase recreates the historical
  // target-vs-camera jitter bug.
  publishFocusTargetFromCachedPosition({
    ownerLayer: 'flights',
    id: icao24,
    scene: _viewer?.scene,
    camera: _viewer?.camera,
    displayPosition: _cachedDRPosition,
    widthPx: focusSizePx,
    heightPx: focusSizePx,
  });
  return display;
}

/** The tracked plane's current display position WITHOUT recomputing — the exact value the
 *  follow-camera already settled on this frame (in the Viewer _onTick). getDetectableObjects + the
 *  readout run in postRender at a LATER frameNumber, so calling _trackedDisplayPosition there would
 *  re-run the dead-reckon on a fresh sample and double-advance the reconciliation → the label jitters
 *  against the now-stable plane (the model's jitter fix, resurfacing in the labels). Returns null when
 *  there's no valid fix for the tracked aircraft, so callers fall back to the billboard position. */
function _trackedDisplayCached() {
  return (_drReconcileValid && _drReconcileIcao === _trackedIcao) ? _cachedDRPosition : null;
}

/** @type {Cesium.Cartesian3} Scratch for the tracked model's rendered translation. */
const _trackedVisualPos = new Cesium.Cartesian3();
const _trackedTrailPos = new Cesium.Cartesian3();
/** Scratch for the tracked model's world-space origin (the envelope centre). */
const _scratchTrailClip = new Cesium.Cartesian3();
/** Scratch for the shortened trail-head start. Owned by the head-segment
 *  callback alone, so nothing else can overwrite it mid-frame. */
const _scratchTrailHead = new Cesium.Cartesian3();

/**
 * The position the tracked aircraft is VISUALLY at this frame — the translation its
 * 3D model is actually rendering with when the model owns the visual, otherwise the
 * cached dead-reckoned position the billboard uses.
 *
 * This exists because a grounded plane's model rides a one-shot ground snap while its
 * billboard deliberately stays at the reported (buried) altitude — a ~100 m vertical
 * split at an inland airport. Anything anchored to the display position while the model
 * is what you can see drifts below the aircraft and only converges as the coarse floor
 * cell warms ("the buoy"), sometimes never.
 *
 * It reads `modelMatrix`, which `_updateTrackedModel` already wrote this frame — no
 * sampling, no `_modelDisplayPosition` call from postRender, and no new dead reckoning,
 * so the follow-camera anti-jitter contract on `gevDisplayPosition` is untouched.
 */
function _trackedVisualCached() {
  if (_trackedIcao && _modelOwnsVisual(_trackedIcao)) {
    const spec = _modelSpec(_flightData.get(_trackedIcao)?.klass);
    return modelVisualAnchor(
      _trackedModel.modelMatrix,
      spec.visualCenterNative,
      Number.isFinite(_trackedModel.computedScale) ? _trackedModel.computedScale : spec.scale,
      _trackedVisualPos,
    );
  }
  return _trackedDisplayCached();
}

/** Trail endpoint for the rendered tracked owner. Brackets/readouts stay on
 * the visual centre; only the trail moves to the model's lower-centre hardpoint. */
/** The tracked model's rendered bounding radius (m), or 0 when no model of this
 *  contact is drawing. Carries Cesium's effective `computedScale`, which may be
 *  above `scale` to satisfy minimumPixelSize — the trail head has to be judged
 *  against the size the operator SEES, not the nominal one. */
/** World-space origin of the tracked model, or null when no model of this
 *  contact is drawing. This is the centre the rendered bounding sphere is
 *  measured from, so the trail clip and the envelope agree on one frame. */
function _trackedModelCenterWorld() {
  if (!_trackedIcao || !_trackedModel || !_modelOwnsVisual(_trackedIcao)) return null;
  return Cesium.Matrix4.getTranslation(_trackedModel.modelMatrix, _scratchTrailClip);
}

function _trackedModelEnvelopeM() {
  if (!_trackedIcao || !_trackedModel || !_modelOwnsVisual(_trackedIcao)) return 0;
  const spec = _modelSpec(_flightData.get(_trackedIcao)?.klass);
  const scale = Number.isFinite(_trackedModel.computedScale)
    ? _trackedModel.computedScale
    : spec.scale;
  return spec.nativeRadiusM * scale;
}

function _trackedTrailCached() {
  if (_trackedIcao && _modelOwnsVisual(_trackedIcao)) {
    const spec = _modelSpec(_flightData.get(_trackedIcao)?.klass);
    // Through the model's OWN render chain (modelVisualAnchor's hand-rolled
    // half-correction put this offset on the lateral axis — see
    // modelAnchorWorld).
    return modelAnchorWorld(_trackedModel, spec.trailAnchorNative, _trackedTrailPos);
  }
  return _trackedDisplayCached();
}

/** Smoothed world course for the tracked aircraft this frame. Reads the
 *  frame-cached course (set by _trackedDisplayPosition — the follow-camera's
 *  own computation), NEVER re-runs _deadReckon. Safe to call more than once
 *  per frame: the second call sees dt≈0 and the limiter is a no-op.
 *
 *  The smoothed value lives in the SHARED per-icao _displayCourse entry (see
 *  its declaration): on click the limiter continues from whatever nose the
 *  fleet pass was displaying, and on untrack the fleet pass continues from
 *  whatever nose this path last wrote — the tracked and fleet consumers of
 *  the same aircraft can never disagree across the handoff. */
function _trackedDisplayCourse() {
  const info = _flightData.get(_trackedIcao);
  const fallback = (info && info.true_track) || 0;
  const cacheValid = _drReconcileValid && _drReconcileIcao === _trackedIcao && _cachedDRCourse != null;
  const raw = cacheValid ? _cachedDRCourse : fallback;
  const nowMs = Date.now();
  const dt = _trackedCourseMs
    ? Math.min(COURSE_SLEW_DT_MAX_SEC, (nowMs - _trackedCourseMs) / 1000)
    : 0;
  _trackedCourseMs = nowMs;
  const prev = _displayCourse.get(_trackedIcao);
  // Hover hold: at near-zero displayed speed both the chord and the reported
  // track are noise — keep the last stable nose direction instead of chasing.
  if (cacheValid && _cachedDRHold && prev != null) return prev;
  const cap = courseSlewCapDps(cacheValid ? _cachedDRSpeedMps : ((info && info.velocity) ?? NaN), COURSE_MAX_DPS);
  const course = limitCourseStep(prev, raw, cap, dt);
  _displayCourse.set(_trackedIcao, course);
  return course;
}

/** Reset reconciliation + per-frame cache when tracking stops or switches
 *  target. Deliberately does NOT touch _displayCourse: the smoothed course
 *  entry belongs to the AIRCRAFT (not to the tracked session) and must
 *  survive the handoff back to the fleet pass. */
function _resetTrackedDisplay() {
  _drReconcileValid = false;
  _drReconcileIcao = null;
  _cachedDRFrame = -1;
  _cachedDRPosition = null;
  _cachedDRCourse = null;
  _cachedDRSpeedMps = null;
  _cachedDRHold = false;
  _trackedCourseMs = 0;
}

/**
 * Per-preRender fleet pass at ~12Hz: dead-reckons every untracked billboard,
 * horizon-culls billboards beyond the limb (no far-side depth with the globe
 * hidden), and refreshes screen-projected icon rotations whenever the camera
 * pose changed (plus a 1s drift catch-up while idle). Driven by
 * scene.preRender — NOT camera.changed, whose granularity is globally
 * degraded by other layers mutating camera.percentageChanged.
 * @returns {void}
 */

/** Model tint, mirroring the billboard color rules. */
function _modelColor(icao24) {
  if (icao24 === _trackedIcao) return Cesium.Color.CYAN;
  return isMilitaryIcao(icao24) ? MIL_TINT : Cesium.Color.WHITE;
}

/** The FLEET's 3D-model regime: models3d enabled AND the camera zoomed in past the altitude
 *  ceiling. Since 2026-08-22 the toggle DEFAULTS ON in `proximity`, which is itself the
 *  budget: models only appear below MODEL_ALT_CEIL_M and only for the nearest MODEL_MAX in
 *  view. The toggle still OWNS the fleet — an operator who wants every in-view plane arms
 *  `all`, and one who wants none turns 3D off — this predicate is unchanged. The TRACKED
 *  contact does not route through here: it is one model, it is what the camera is aimed at,
 *  and it takes its own default-on, hysteretic zoom regime
 *  (`_trackedModelRegimeActive`). */
function _modelRegimeActive() {
  if (!_models3dEnabled) return false;
  const h = _viewer?.camera?.positionCartographic?.height ?? Infinity;
  return h < MODEL_ALT_CEIL_M;
}

/** Hysteresis latch for the tracked contact's zoom regime, plus the selection it
 *  belongs to. Scoped per selection so a NEW target re-evaluates against the ENTER
 *  ceiling instead of inheriting the previous target's looser EXIT band. */
let _trackedZoomLatched = false;
let _trackedZoomLatchIcao = null;

/** Bounded on-demand loading for the tracked model. The tracked regime is
 *  DEFAULT-ON and its driver runs every `scene.preUpdate`, so a missing or
 *  corrupt GLB — or a dead network — would otherwise spin load→reject at frame
 *  rate for as long as the contact stays selected. Failures are counted PER
 *  SELECTION: a short backoff absorbs a transient blip, then the layer stops
 *  asking until the operator selects something else. The billboard is the
 *  visual throughout (the handoff only fades it once a model actually renders),
 *  so a latched failure degrades to exactly the pre-3D presentation. */
const TRACKED_MODEL_MAX_LOAD_FAILS = 3;
const TRACKED_MODEL_RETRY_BACKOFF_MS = 1500;
let _trackedModelFailIcao = null;
let _trackedModelFailCount = 0;
let _trackedModelRetryAtMs = 0;

/** Clear every per-SELECTION tracked-model latch: the zoom hysteresis band and
 *  the load-failure bound. Called from each path that changes which contact is
 *  selected — deselect, re-track, cross-layer handoff, init, destroy.
 *
 *  This must live in the production lifecycle, not only in the predicate's
 *  icao-change guard: a deselect followed by a same-turn re-track of the SAME
 *  icao (Contacts re-entry, a cross-layer round trip back to the original
 *  layer) never makes `_trackedIcao` *observably* change, so the guard never
 *  fires. Without the reset, a contact dropped inside the hysteresis band comes
 *  back as a MODEL above the ENTER ceiling, and a contact whose GLB had already
 *  failed out would never get its retries back. */
function _resetTrackedSelectionState() {
  _trackedZoomLatched = false;
  _trackedZoomLatchIcao = null;
  _trackedModelFailIcao = null;
  _trackedModelFailCount = 0;
  _trackedModelRetryAtMs = 0;
}

/** Whether the driver may start another tracked-model load this frame. */
function _trackedModelLoadAllowed(nowMs = Date.now()) {
  if (_trackedModelFailIcao !== _trackedIcao) return true; // untried selection
  if (_trackedModelFailCount >= TRACKED_MODEL_MAX_LOAD_FAILS) return false;
  return nowMs >= _trackedModelRetryAtMs;
}

/** Record a rejected tracked-model load and arm the backoff / give-up latch. */
function _noteTrackedModelLoadFailure(url, err) {
  if (_trackedModelFailIcao !== _trackedIcao) {
    _trackedModelFailIcao = _trackedIcao;
    _trackedModelFailCount = 0;
  }
  _trackedModelFailCount += 1;
  _trackedModelRetryAtMs = Date.now() + TRACKED_MODEL_RETRY_BACKOFF_MS;
  if (_trackedModelFailCount >= TRACKED_MODEL_MAX_LOAD_FAILS) {
    console.warn(
      `[Data:Flights] tracked 3D model gave up after ${_trackedModelFailCount} failed loads of ${url} — `
      + 'this contact stays 2D until another is selected',
      err,
    );
  }
}

/**
 * The TRACKED aircraft's own model regime — DEFAULT-ON, camera-distance driven
 * (product invariant 2026-08-19). Unlike the fleet, this does NOT consult the
 * DISPLAY-rail `models3d` toggle: the selected contact is a single model, it is
 * what the camera is pointed at, and zooming in on a target should resolve it
 * into an aircraft without the operator arming anything. The toggle keeps
 * owning the FLEET (`_modelRegimeActive`), which is the draw-call budget.
 *
 * Thresholds + hysteresis live in trackedModelRegime.js: enter at
 * TRACKED_MODEL_ENTER_ALT_M (150_000 m — the playtested swap distance,
 * deliberately NEARER than the fleet's 800 km ceiling this used to inherit),
 * hand back only above TRACKED_MODEL_EXIT_ALT_M, so orbiting AT the boundary
 * cannot flap billboard↔model. See that module's header for why the tracked
 * contact now goes 3D closer in than the fleet does.
 *
 * In cockpit you are sitting 7 m behind and 2.6 m above your own aircraft's
 * origin, so its ~26 m airframe would fill the visor. First-person means your
 * own airframe is not drawn.
 */
function _trackedModelRegimeActive() {
  if (_trackedZoomLatchIcao !== _trackedIcao) {
    _trackedZoomLatchIcao = _trackedIcao;
    _trackedZoomLatched = false;
  }
  // A converted TR-3B has no 3D asset — suppressing the regime keeps its
  // tracked billboard fully opaque (the colour callback reads this too), so
  // the triangle stays the visual all the way in.
  if (!_trackedIcao || _cockpitContactMode || isTr3b(_trackedIcao)) {
    _trackedZoomLatched = false;
    return false;
  }
  _trackedZoomLatched = trackedModelZoomActive(
    _viewer?.camera?.positionCartographic?.height,
    _trackedZoomLatched,
  );
  return _trackedZoomLatched;
}

/** Seed the tracked billboard's 2D orientation before a 3D→2D handoff. */
function _syncTracked2dRotation() {
  if (!_trackedIcao || !_viewer) return;
  const pos = _trackedDisplayCached() || _billboards.get(_trackedIcao)?.position;
  if (!pos) return;
  const projected = screenProjectedRotation(
    _viewer.scene,
    pos,
    _trackedDisplayCourse(),
    _lastTrackedRotation,
  );
  const rotation = stabilizeScreenRotation(_lastTrackedRotation, projected, 0);
  if (rotation !== null) _lastTrackedRotation = rotation;
}

/** Active model cap — the eligibility pre-pass AND _ensureModel's admission checks must use the
 *  SAME value, else 'all' (MODEL_MAX_ALL) would mark planes eligible that _ensureModel then refuses
 *  at the lower MODEL_MAX, silently degrading 'all' to 'proximity'. */
function _modelCap() {
  const mapCap = _models3dMode === 'all' ? MODEL_MAX_ALL : MODEL_MAX;
  // `Math.min` on purpose: cockpit may only ever LOWER the GLB budget. Cockpit is
  // already the heaviest mode (20 Hz camera setView ahead of scene update, photoreal
  // retraversal, the cloud pass) and every model is its own draw call.
  return _cockpitContactMode ? Math.min(COCKPIT_MODEL_MAX, mapCap) : mapCap;
}

/** Active ADD radius (m) — new planes inside this range get a model. Mode-aware: 'all' reaches far. */
function _modelAddDistM() {
  return _models3dMode === 'all' ? MODEL_ALL_ADD_M : MODEL_PROX_ADD_M;
}
/** Active KEEP radius (m) — a modeled plane keeps its model out to here (hysteresis vs ADD). */
function _modelKeepDistM() {
  return _models3dMode === 'all' ? MODEL_ALL_KEEP_M : MODEL_PROX_KEEP_M;
}

/** World model matrix from a position + course heading (pitch/roll 0; ENU frame). Writes into
 *  `result` and returns it — pass each model's OWN `.modelMatrix` so models never share one
 *  mutable matrix object. `Model.modelMatrix` is a plain field (not a cloning setter); Cesium
 *  clones it per frame in updateModelMatrix(). Sharing a single scratch made every model render at
 *  the LAST-written transform — all stacked on one plane — and, once the tracked model wrote the
 *  scratch every frame, the stack point oscillated frame-to-frame: the "flickering like mad" bug. */
function _modelMatrix(pos, headingDeg, result = _scratchModelMtx) {
  _scratchModelHpr.heading = Cesium.Math.toRadians((headingDeg || 0) + MODEL_HEADING_OFFSET_DEG);
  _scratchModelHpr.pitch = 0;
  _scratchModelHpr.roll = 0;
  return Cesium.Transforms.headingPitchRollToFixedFrame(
    pos, _scratchModelHpr, Cesium.Ellipsoid.WGS84, undefined, result,
  );
}

/** Everything scene.sampleHeight must NOT hit when snapping a grounded model: the
 *  vertical pick ray at a plane's own lat/lon otherwise lands on its (or a parked
 *  neighbor's) billboard/model instead of the tile skin. Cesium's ray-pick exclusion
 *  matches picked-object IDs, and every billboard AND model in this layer carries its
 *  icao as `id`, so the icao strings cover both; the tracked entity is excluded as the
 *  object itself. Built lazily — only when a sample actually fires (one-shot). */
function _groundSampleExclusions() {
  const out = [..._billboards.keys()];
  if (_trackedEntity) out.push(_trackedEntity);
  return out;
}

/** Position a 3D MODEL renders at. Airborne planes use their dead-reckoned position
 *  verbatim. GROUNDED planes' meta altitude is last-known baro or 0 m — nowhere near
 *  the photoreal tile skin in ellipsoid heights (buried ~100+ m at inland airports,
 *  hovering ~30 m at sea-level ones), and unlike the ground billboards a depth-tested
 *  model can't hide behind disableDepthTestDistance. So a modeled grounded plane rides
 *  a ONE-SHOT cached scene.sampleHeight of the skin at its lat/lon (groundSnap.js,
 *  CCTV-B9b discipline: never per-frame; taxiing >50 m retires the cached value to a
 *  bounded last-known and resamples), plus
 *  the belly offset so it sits on its gear rather than sinking to the model-origin
 *  fuselage centerline. Until the FIRST sample lands (tiles streaming / sample miss)
 *  there is no safe depth-tested placement at all: this returns null, the caller
 *  keeps the 2D billboard visible and the model hidden, and it retries later. Once
 *  a contact has resolved once, a later outage holds that measurement inside
 *  groundSnap's drift bound instead — a taxiing aircraft does not pop back to 2D
 *  because a resample is mid-backoff. */
function _modelDisplayPosition(icao24, pos, result) {
  const meta = _flightData.get(icao24);
  if (!meta || !meta.onGround) return pos;
  const h = _groundSnap.heightFor(_viewer, icao24, pos, _groundSampleExclusions);
  if (h == null) return null;
  const carto = Cesium.Cartographic.fromCartesian(pos, Cesium.Ellipsoid.WGS84, _scratchGroundCarto);
  carto.height = h + _modelSpec(meta.klass).bellyM;
  return Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height, Cesium.Ellipsoid.WGS84, result);
}

/** Atomically hand one fleet contact from its billboard to a safely placed,
 * ready 3D model. Missing/loading models and unresolved terrain always leave
 * the billboard owning the visual, so no render frame can hide both.
 * `beforeShow` runs only on the committing path — the per-tick model treatment
 * belongs to a model that is about to draw, not to one still waiting. */
function _driveFleetModelHandoff(icao24, model, bb, pos, course, beforeShow) {
  if (!model) {
    bb.show = true;
    return false;
  }
  const displayPos = _modelDisplayPosition(icao24, pos, _scratchGroundPos);
  if (!displayPos) {
    model.show = false; // no ground evidence → nothing safe to place a depth-tested model at
    bb.show = true;
    return false;
  }
  // The matrix is written BEFORE the readiness test on purpose: a model can flip
  // `ready` during scene update after this tick, and a first rendered frame on a
  // stale load-start matrix is the one-frame jump this ordering prevents.
  _modelMatrix(displayPos, course, model.modelMatrix);
  if (!model.ready) {
    model.show = false; // not loaded yet → keep the 2D icon, no half-model flash
    bb.show = true;
    return false;
  }
  beforeShow?.();
  if (!model.show) model.show = true;
  if (bb.show) bb.show = false; // hand off ONLY once the model renders
  return true;
}

/**
 * Whether a 3D model — not the billboard — is what the user actually SEES for
 * this contact, and therefore whether the display floor should stand aside.
 *
 * Model EXISTENCE is not ownership. A fleet model that is still loading, or has
 * no resolved ground to stand on, stays hidden while `bb.show` stays true (the
 * gap-proof handoff: "hand off ONLY once the model renders"), and a tracked model
 * is retained but hidden whenever the model regime is off — 3D disabled, camera
 * zoomed past the ceiling, or cockpit mode. Gating on `has()`/existence therefore
 * suppressed the clamp in exactly the states where the BILLBOARD is the visual,
 * putting the burial straight back.
 *
 * Cesium's own default `show === true` is the reason admission clears it
 * explicitly: a fleet model registered in `_models` the instant its glTF resolves
 * would otherwise claim ownership — at the identity matrix — for the frames
 * between admission and the next fleet tick, while the BILLBOARD was still the
 * visual. Ownership means actually rendering, and every site that sets `show`
 * true does so only after committing a matrix.
 *
 * The two halves:
 *  - Fleet: the rendering test alone. Safe for the ground snap either way,
 *    because a fleet model is positioned from the RAW dead-reckon, not from
 *    the billboard.
 *  - Tracked: the rendering test AND `_trackedModelRegimeActive()`. The tracked
 *    model is fed from `_trackedDisplayPosition`, so once it is live the clamp
 *    must stand aside: two different chains would otherwise be deciding one
 *    contact's ground, and the billboard's is the one the operator is not
 *    looking at (T7). The regime check is what makes a regime
 *    flip take effect on the same frame rather than waiting for
 *    `_updateTrackedModel` to clear `show`; the rendering test is what keeps a
 *    null or still-loading tracked model from claiming a visual it is not
 *    drawing yet.
 * @param {string} icao24
 * @returns {boolean}
 */
function _modelOwnsVisual(icao24) {
  if (icao24 === _trackedIcao) {
    return _trackedModelRegimeActive() && _modelIsRendering(_trackedModel);
  }
  return _modelIsRendering(_models.get(icao24));
}

/** A model is the visual only once it actually draws — loaded AND shown.
 *
 * `show` is sufficient evidence of a safe placement because only ONE site ever
 * sets it true for a fleet model (`_driveFleetModelHandoff`, after the matrix is
 * committed) and one for the tracked model (`_updateTrackedModel`, likewise);
 * everything else — admission, an unresolved ground, a not-yet-ready glTF, the
 * limb cull, a regime exit — only ever clears it. */
function _modelIsRendering(model) {
  return !!model && model.ready === true && model.show === true;
}

/** @type {Cesium.Cartographic} Scratch for the grounded display-floor read. */
const _scratchDisplayCarto = new Cesium.Cartographic();
/** @type {Map<string, {cell: {lat: number, lon: number}, effectiveM: number|null,
 *  in: Cesium.Cartesian3, out: Cesium.Cartesian3|null, heldM: number|null,
 *  heldCell: {lat: number, lon: number}|null,
 *  heldTier: 'own'|'neighbor'|null, heldActive: boolean, seeded: boolean,
 *  probeMs: number|null, retiredMs: number|null,
 *  easedM: number|null, easeMs: number|null}>} Per-grounded-contact
 *  display-floor state: the cell it is currently reading (boundary hysteresis),
 *  the last input position and the effective floor that produced the cached
 *  output (rebuild skip), the last floor that actually RESOLVED for it plus the
 *  tier it came from (the hold, below), whether that floor is a REHYDRATED SEED
 *  rather than something measured while the contact stood here (`seeded` — it
 *  ranks below live evidence), and the value the downward ease is currently
 *  displaying while it approaches a lower floor.
 *  Dropped with the contact, and whenever it stops being a grounded billboard. */
const _displayFloorState = new Map();
/** @constant {number} Cap on NEW cells the display corridors may add to one
 *  poll's warm/sample batch — a view full of ground traffic must not balloon
 *  it. Cells the poll already collected are free (deduped before budgeting). */
const DISPLAY_CORRIDOR_CELL_BUDGET = 64;
/** @constant {number} Cells any single contact may claim in the first pass, so
 *  one long corridor cannot spend the whole budget while other contacts get
 *  nothing. Leftovers are handed out in a second pass. */
const DISPLAY_CORRIDOR_FAIR_SHARE = 4;
/** @constant {number} How far ahead a COASTING contact's corridor reaches:
 *  two poll intervals, so the ground it covers before the next batch lands is
 *  already warm. */
const DISPLAY_CORRIDOR_LOOKAHEAD_SEC = RENDER_DELAY_SEC * 2;
/** @type {number} Poll counter handed to the corridor allocator: it rotates
 *  runs of EQUALLY needy contacts so a tie larger than the budget cycles across
 *  polls instead of the same prefix winning forever. */
let _corridorEpoch = 0;
/** @constant {number} Corridors are only collected this close to the viewer:
 *  the mesh sampler ignores anything past 15 km, and a far contact's exact
 *  datum is subpixel. */
const DISPLAY_CORRIDOR_RADIUS_KM = 25;

/** @constant {number} How far a contact may travel from the cell that supplied
 *  its held floor before that floor stops describing the ground under it.
 *
 *  Sized to the same worst-case ground segment `CORRIDOR_MAX_CELLS` is sized
 *  for — a 27 m/s rollout covers ~810 m in one poll interval — with headroom
 *  for a couple of polls of coasting. That is ~9 cells: aprons, taxiways and
 *  runways really are flat at that scale. An early draft used 5 km, which is
 *  ~45 cells and can leave the airfield entirely — the KAUS note in this file
 *  records a 21 m spread across the field alone — so the bound is the distance
 *  the contact can actually have travelled since the measurement rather than a
 *  comfortable-looking number. */
const HELD_FLOOR_MAX_DRIFT_KM = 1;
/** @constant {number} Minimum gap between adjacent-cell probes for one contact
 *  whose held floor is missing or came from a borrowed tier. A contact standing
 *  on its own resolved floor never probes at all.
 *
 *  This per-contact throttle is the ONLY rationing on the probe path, and that
 *  is deliberate. A probe is eight synchronous `Map` reads against the shared
 *  floor cache — no fetch, no `sampleHeight`, nothing async — so it cannot
 *  queue work anywhere; every DEM request is driven by `warmGroundFloor` from
 *  the poll loop, already bounded by DISPLAY_CORRIDOR_CELL_BUDGET and the
 *  resolver's single-flight chain. Measured worst case (`scripts/qa-floorhold-
 *  probe-cost.mjs`): 200 synchronized all-cold contacts probing on the SAME
 *  tick cost 2.1 ms, 2.6% of one 80 ms fleet tick, and 2.1 ms per second of
 *  wall clock sustained under this throttle. An earlier draft added a global
 *  per-tick budget with a fairness queue on top of that; it protected ~2 ms and
 *  cost two starvation defects, so it was deleted. Nothing can starve here
 *  because there is no shared resource to be starved of. */
const NEIGHBOR_FLOOR_PROBE_MS = 500;
/** @constant {number} Time constant of the downward floor ease. A floor that
 *  drops UNDER a contact standing on a borrowed one is approached
 *  exponentially: each tick closes `1 - e^(-dt/TAU)` of the remaining gap, so
 *  at the 80 ms fleet cadence a tick moves ~20% of what is left and the value
 *  is within a few centimetres inside ~1.6 s. FLOOR_EASE_MAX_STEP caps that
 *  fraction so a delayed tick cannot close more.
 *
 *  Exponential rather than a fixed-duration interpolation because the target
 *  MOVES: a second, lower neighbour can warm mid-ease. A from/duration ease
 *  re-evaluated against a new target jumps by the eased fraction of the change
 *  (measured: a 100 m single-tick drop late in an ease). Approaching from the
 *  CURRENTLY DISPLAYED value has no such seam — retargeting is just a different
 *  destination for the same continuous follow, and the per-tick bound holds
 *  however often the target moves.
 *
 *  Rises are never eased: up is the safe direction, and easing up would park
 *  the contact under the mesh for the duration — the exact failure this whole
 *  path exists to prevent.
 *
 *  Reachability note (2026-08-21, after neighborFloorM moved to a low lean):
 *  the ordinary arrival flows no longer produce a downward move at all — a
 *  borrowed floor is now the apron rather than a roof, so the contact rises
 *  once and stays (`scripts/qa-floorhold-staircase.mjs`: one step, zero float,
 *  in every scenario that settles). This machinery still guards the re-latch
 *  paths — a lower neighbour warming later, or an own-cell resolve below a
 *  hold — which the pins exercise directly. Whether those paths are worth the
 *  code is a follow-up judgement, deliberately not made in this change. */
const FLOOR_EASE_TAU_MS = 360;
/** @constant {number} Hard ceiling on the fraction of the remaining gap ONE
 *  tick may close, whatever its dt. The exponential alone is timing-dependent:
 *  it closes 19.9% at the 80 ms fleet cadence but 28.4% at 120 ms and 75% after
 *  a 500 ms stall (a hidden tab, a long frame, a GC pause), which would turn a
 *  delayed tick back into the snap this approach exists to prevent. Clamping
 *  the fraction rather than dt keeps the never-snap property a property of the
 *  code instead of a property of the schedule; a stalled tick simply resumes
 *  the approach at full rate rather than jumping most of the way. */
const FLOOR_EASE_MAX_STEP = 0.22;
/** @constant {number} Distance from the target at which the ease finishes
 *  exactly, so a parked contact stops rebuilding its position. Two orders of
 *  magnitude under GROUND_FLOOR_LIFT_M — invisible. */
const FLOOR_EASE_EPSILON_M = 0.02;
/**
 * The floor to stand a grounded contact on while its own cell is unresolved.
 *
 * Product invariant (2026-08-21, after a Re:Earth outage buried a parked contact
 * at a Texas field): "hold the last known altitude until a fresh one comes in.
 * Never render otherwise." Two tiers, strongest first:
 *  own — a floor this contact's OWN cell resolved to while it stood there.
 *        Nothing weaker can improve on it, and its cell warming again is picked
 *        up by the live read, not here. Valid only within
 *        HELD_FLOOR_MAX_DRIFT_KM of where it was measured.
 *  neighbor — the LOWEST of at least two resolved ADJACENT cells (~111 m away,
 *        the same apron). Two at least, because one reading cannot be checked
 *        against anything, and the LOWEST because a high reading beside a cold
 *        cell is as likely to be a terminal roof as ground — see neighborFloorM.
 *
 * BOTH are validated measurements out of the shared floor cache. A third tier
 * that read the rendered mesh directly, where no DEM existed to check it, was
 * built and then REMOVED: run against a real GPU with the proxy down it
 * recorded a coarse-LOD 20.6 m for ground that is really ~122 m (see the note
 * in meshFloorSampler.js). Nothing in this chain is a guess.
 *
 * A neighbour hold keeps re-probing at the throttle so it can UPGRADE: a parked
 * contact that first answered from one neighbour would otherwise keep it after
 * a better one warmed. A held value is never dropped for nothing — a failed
 * probe leaves the previous answer standing — and a re-probe that lands LOWER
 * eases rather than steps (see the ease note in the clamp below).
 *
 * A REHYDRATED SEED is the one exception to the tier order. A floor parked by
 * `_retireDisplayFloorState` and picked back up on a later re-ground was
 * measured while the contact stood somewhere it no longer necessarily is: it is
 * a memory, not a reading, and it outranks nothing. So `seeded` demotes an
 * `own` floor below the neighbour tier — when two fresh adjacent cells can
 * answer, they answer, and the seed is discarded. It serves only while nothing
 * fresh contradicts it, which is exactly the flap case it exists for (a rotation
 * outruns its own cells, so nothing nearby is warm either). Without this a
 * contact that re-grounded 0.5 km away kept a 200 m floor while its new
 * neighbourhood read 100 m and 105 m, and rendered 100 m in the air.
 *
 * @param {object} state - The contact's `_displayFloorState` entry (mutated).
 * @param {{lat: number, lon: number}} cell - Cell the display is reading now.
 * @param {number} nowMs - Tick clock.
 * @returns {number|null} Floor to use, or null when nothing anywhere can answer.
 */
function _heldDisplayFloorM(state, cell, nowMs) {
  if (state.heldTier && !(Number.isFinite(state.heldM) && state.heldCell
    && _approxDistanceKm(cell.lat, cell.lon, state.heldCell.lat, state.heldCell.lon)
      <= HELD_FLOOR_MAX_DRIFT_KM)) {
    // Out of range: the held value is no longer a measurement of anywhere this
    // contact has been. Drop it rather than stretch it.
    _dropHeldFloor(state);
  }
  if (state.heldTier === 'own' && !state.seeded) return state.heldM;
  if (state.probeMs != null && nowMs - state.probeMs < NEIGHBOR_FLOOR_PROBE_MS) return state.heldM;
  state.probeMs = nowMs;
  const near = neighborFloorM(cell);
  if (near != null) return _adoptHeldFloorM(state, near, cell, 'neighbor');
  return state.heldM;
}

/** Records a held floor and the tier it came from; returns it. Every caller
 *  passes a floor measured for the cell the contact is reading NOW, so an
 *  adoption always clears the seed flag: live evidence has arrived. */
function _adoptHeldFloorM(state, floorM, cell, tier) {
  state.heldM = floorM;
  state.heldCell = cell;
  state.heldTier = tier;
  state.seeded = false;
  return floorM;
}

/** Forgets the held floor and everything that describes where it came from,
 *  leaving the rest of the contact's display state alone. */
function _dropHeldFloor(state) {
  state.heldM = null;
  state.heldCell = null;
  state.heldTier = null;
  state.seeded = false;
}

/** @constant {number} How long a retired hold stays usable as a rehydration
 *  seed — three poll intervals.
 *
 *  Deleting the state outright was the first cut, and a field observation found
 *  what that costs: VIR138M at JFK, 45 kt down the runway, "clearly on good
 *  ground, then suddenly popped below the ground, then popped back up".
 *  OpenSky's `on_ground` flag is not clean through a rotation — it flaps — and
 *  the fix's own height source switches at the same moment, from the resolved
 *  surface to baro + geoid N, which at a sea-level field IS the geoid and sits
 *  below the runway. A single airborne poll therefore wiped the only thing that
 *  was hiding that: the contact came back grounded with no prior, outrunning
 *  its own floor cells at 23 m/s, and rendered at the geoid until something
 *  ahead of it warmed (`scripts/qa-floorhold-staircase.mjs` §F1: 12 of 22
 *  grounded ticks below the runway, and not recovering).
 *
 *  So a retired hold is PARKED, not destroyed, and a contact that re-grounds
 *  soon after picks it back up. What makes that safe is the bound already in
 *  `_heldDisplayFloorM`: a seed only answers within HELD_FLOOR_MAX_DRIFT_KM of
 *  where it was measured AND only while no fresh neighbour contradicts it, so a
 *  genuine departure-and-landing-elsewhere still starts clean — the grace window
 *  is belt to those braces, retiring the seed outright once a contact has been
 *  airborne long enough to have gone anywhere. */
const FLOOR_SEED_GRACE_MS = 90_000;

/** Whether a parked seed has been away longer than the grace window.
 *
 *  ONE judgement, asked from BOTH sides of the park, because neither side sees
 *  the whole story on its own. While the contact keeps reporting, the retire
 *  path asks it and drops the entry. But a contact can be parked and then make
 *  no calls at all — off the poll for a long-haul cruise, out of the corridor
 *  radius, tab hidden — and then re-ground; nothing ran in between, so an
 *  expiry checked only on the retire path never fires and an arbitrarily old
 *  measurement walks back in (measured: parked 198 s, still reused). The
 *  rehydration side therefore asks the same question against the wall clock
 *  before it clears `retiredMs`.
 *  @param {object} state @param {number} nowMs - Tick clock. */
function _seedExpired(state, nowMs) {
  return state.retiredMs != null && nowMs - state.retiredMs > FLOOR_SEED_GRACE_MS;
}

/** Retires a contact's display-floor state. Called the moment it stops being a
 *  grounded billboard — airborne, model-owned, or gone.
 *
 *  The floor itself is kept as a rehydration seed for FLOOR_SEED_GRACE_MS (see
 *  above) and MARKED as one; everything that describes the contact's CURRENT
 *  rendering is cleared, so a re-ground recomputes from scratch and cannot be
 *  mistaken for a hold release. Nothing visual is touched, so the T7
 *  model-ownership gate is unaffected.
 *  @param {string} icao24 @param {number} nowMs - Tick clock. */
function _retireDisplayFloorState(icao24, nowMs) {
  const state = _displayFloorState.get(icao24);
  if (!state) return;
  if (state.retiredMs == null) {
    state.retiredMs = nowMs;
    state.seeded = true;        // what it answers with next is a memory, not a reading
    state.heldActive = false;   // a later landing is an arrival, not a release
    state.easedM = null;
    state.easeMs = null;
    state.probeMs = null;       // re-ground may probe immediately
    state.out = null;
    state.effectiveM = null;
    Cesium.Cartesian3.clone(Cesium.Cartesian3.ZERO, state.in); // invalidate the memo
  } else if (_seedExpired(state, nowMs)) {
    _displayFloorState.delete(icao24); // airborne long enough to be anywhere
  }
}

/**
 * Floors a GROUNDED contact's DISPLAYED position onto the local ground.
 *
 * `renderAltitudeM` is chosen once per poll from the floor of the FIX's coarse
 * cell. The position that renders is the dead-reckoned one, which drifts away
 * from that fix for the whole segment — and for up to 300 s / several hundred
 * metres while a ground contact coasts through its stale-feed grace. Across a
 * graded apron (KAUS spans ~119–140 m ellipsoidal) that drift buries the
 * sprite under the mesh it is now over; `scripts/qa-floor-verify.mjs` measured
 * −15.5 m. A second, smaller share comes from the fix-time floor itself: a
 * taxiing contact whose current cell is still cold falls back to the PREVIOUS
 * fix's cell (see the grounded `surfaceM` chain) and nothing revisits that
 * height once the cell warms — the stale re-floor sweep deliberately skips
 * contacts present in the poll. Both are cured by reading the floor at the
 * coordinate actually being displayed.
 *
 * Discipline:
 *  - READ-ONLY against the shared floor cache. No latch, no heal, no sampling.
 *    Keeping cold cells rare is `_collectDisplayCorridorCells`'s job, not this
 *    one's. A cold cell used to mean NO clamp at all, which was only safe while
 *    the un-clamped height was a real reading — and for a grounded contact with
 *    no altitude data it is not: the poll path's last resort is the geoid, tens
 *    of metres under the mesh at an inland field. When the cell cannot answer,
 *    `_heldDisplayFloorM` holds the last floor that DID (owner, 2026-08-21).
 *    Still never an invented surface: every tier is a measurement, and when
 *    none exists the position passes through as before.
 *  - Grounded contacts only. Airborne heights are the fix-time clamp's job.
 *  - NEVER when a 3D model owns the visual (T7): the model rides groundSnap's
 *    one-shot tileset sample and the billboard hides behind it, so clamping the
 *    hidden billboard would put a SECOND ground chain on one contact — and the
 *    one the operator is not looking at. (The original rationale was narrower:
 *    lifting the datum dragged groundSnap's input past its 50 m
 *    move-invalidation and forced a re-sample every frame. groundSnap now
 *    measures that distance on the ellipsoid, so a purely vertical change costs
 *    nothing; the gate stays for the reason above.) Same gate the military
 *    layer's grounded billboard lift uses.
 *
 * @param {string} icao24 - Contact key (owns one `_displayFloorState` entry).
 * @param {object|null|undefined} info - `_flightData` record for this contact.
 * @param {Cesium.Cartesian3|null} pos - Dead-reckoned display position.
 * @param {boolean} modelOwnsVisual - Whether a 3D model is drawing this contact.
 * @param {number} [nowMs] - Tick clock, passed by both callers so the release
 *   ease advances on the same clock the rest of the tick uses.
 * @returns {Cesium.Cartesian3|null} `pos` itself when nothing moves (the common
 *   case — no allocation, no rebuild), otherwise the lifted position.
 */
function _floorGroundedDisplayPosition(icao24, info, pos, modelOwnsVisual, nowMs = Date.now()) {
  if (!pos || !info?.onGround || modelOwnsVisual) {
    _retireDisplayFloorState(icao24, nowMs);
    return pos;
  }
  const state = _displayFloorState.get(icao24);
  const carto = Cesium.Cartographic.fromCartesian(pos, Cesium.Ellipsoid.WGS84, _scratchDisplayCarto);
  // Boundary hysteresis: a position jittering across a cell edge would flip
  // floors at fleet-tick rate (see stickyFloorCell).
  const cell = stickyFloorCell(
    Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude), state?.cell,
  );
  const floor = cachedGroundFloor(cell.lat, cell.lon);
  const next = state || {
    cell, in: new Cesium.Cartesian3(), out: null, effectiveM: null,
    heldM: null, heldCell: null, heldTier: null, heldActive: false, seeded: false,
    probeMs: null, easedM: null, easeMs: null, retiredMs: null,
  };
  // Back on the ground. Judge the seed's AGE here, before `retiredMs` is
  // cleared: a contact that made no calls while it was away never reached the
  // retire path's own expiry branch, so this is the only place that can tell an
  // hour-old measurement from a three-poll-old one.
  if (_seedExpired(next, nowMs)) _dropHeldFloor(next);
  // The seed (if any survived) is live again, and the drift bound plus the
  // neighbour tier in the hold chain decide whether it still describes ground
  // this contact is on.
  next.retiredMs = null;
  // The floor to clamp against: this cell when it has one, otherwise the last
  // one that resolved for this contact (never the geoid the poll path fell to).
  // Snapshot what the contact was standing on BEFORE the chain overwrites it —
  // the ease decision below needs the previous value, and `_heldDisplayFloorM`
  // adopts into the same fields.
  const wasHeld = next.heldActive;
  const stoodOnM = next.heldM;
  let effective = floor;
  if (Number.isFinite(effective)) {
    _adoptHeldFloorM(next, effective, cell, 'own');
    next.heldActive = false;
  } else {
    effective = _heldDisplayFloorM(next, cell, nowMs);
    next.heldActive = Number.isFinite(effective);
  }
  // The floor moved DOWN under a contact that was standing on a BORROWED one.
  // Dropping it by that difference in a single tick is the snap product behavior requires
  // not to have, so approach it instead. Two ways in, and both need it:
  //  - the real floor arrives below the hold (releasing the hold);
  //  - a re-probe finds a LOWER neighbour than the one being held, which the
  //    12 m spread bound can make a large step on a mesa edge (200 m held, a
  //    120 m neighbour warms, the bounded answer is 132 m) — and can happen
  //    AGAIN while the first approach is still running.
  // Scoped to a borrowed floor on purpose: an ordinary cell-to-cell change
  // between two resolved floors is the existing path and keeps its timing.
  if (next.easedM == null && wasHeld && Number.isFinite(stoodOnM)
    && Number.isFinite(effective) && effective < stoodOnM) {
    next.easedM = stoodOnM; // start from where the contact is actually drawn
    next.easeMs = nowMs;
  }
  if (next.easedM != null) {
    if (!Number.isFinite(effective) || effective >= next.easedM) {
      // Nothing to approach, or the floor rose: take it whole and stop.
      next.easedM = null;
      next.easeMs = null;
    } else {
      // Exponential approach from the DISPLAYED value. The target may have
      // moved since last tick; that changes only where this is heading, never
      // where it is, so there is no seam to jump across.
      const dtMs = Math.max(0, nowMs - next.easeMs);
      next.easeMs = nowMs;
      const closed = Math.min(FLOOR_EASE_MAX_STEP, 1 - Math.exp(-dtMs / FLOOR_EASE_TAU_MS));
      let value = next.easedM + (effective - next.easedM) * closed;
      if (Math.abs(value - effective) <= FLOOR_EASE_EPSILON_M) {
        value = effective; // arrive exactly, so a parked contact stops rebuilding
        next.easedM = null;
        next.easeMs = null;
      } else {
        next.easedM = value;
      }
      effective = value;
    }
  }
  // Same input position AND the same EFFECTIVE floor ⇒ the same answer as last
  // tick, so skip the rebuild. A clamped stationary contact (parked, coasting
  // on a zero-velocity fix) hits this every tick; without it the identical
  // Cartesian was rebuilt at ~12 Hz forever. The test is deliberately on the
  // OUTPUT of the hold chain, not on its inputs: keying it to the raw cell
  // floor let a parked contact whose cell never warmed return a memoized
  // unresolved answer forever, so an adjacent-cell floor warming later was
  // never adopted. One owned entry per grounded
  // contact — O(grounded), dropped on eviction, on destroy, and the moment the
  // contact stops being a grounded billboard.
  if (state && state.effectiveM === effective && Cesium.Cartesian3.equals(pos, state.in)) {
    return state.out || pos;
  }
  const lifted = displayFloorHeightM(carto.height, effective);
  next.cell = cell;
  next.effectiveM = effective;
  Cesium.Cartesian3.clone(pos, next.in);
  if (lifted == null) {
    next.out = null;
  } else {
    // The cache OWNS its output: returning a shared scratch would let the next
    // contact in the fleet loop overwrite a position already handed out.
    next.out = Cesium.Cartesian3.fromRadians(
      carto.longitude, carto.latitude, lifted, Cesium.Ellipsoid.WGS84,
      next.out || new Cesium.Cartesian3(),
    );
  }
  if (!state) _displayFloorState.set(icao24, next);
  return next.out || pos;
}

/** @type {Cesium.Cartographic} Scratch for the corridor's display-end read. */
const _scratchCorridorCarto = new Cesium.Cartographic();
/** @type {Cesium.Cartesian3} Scratch for the corridor's dead-reckon probe. */
const _scratchCorridorPos = new Cesium.Cartesian3();

/**
 * Adds the cells each grounded contact's DISPLAY is about to render over to
 * this poll's floor warm/sample batch.
 *
 * The poll loop otherwise collects FIX cells only, so the clamp above has data
 * exactly where the contact ISN'T. A contact taxiing at 10 m/s crosses a
 * ~111 m cell every ~11 s while the batch runs once per 30 s poll, so it stays
 * permanently ahead of its own floor data (the "taxiing cache" failure mode, at
 * cell granularity) and the clamp silently passes.
 *
 * The corridor therefore follows the direction the display is actually MOVING,
 * which is not always toward the fix:
 *  - INTERPOLATING between two fixes — the display is walking to the newest
 *    fix, so that fix is the endpoint (exact, no projection error).
 *  - EXTRAPOLATING — coasting past the newest fix on a stale feed, or the
 *    pre-history warm-up — the display travels along its course AWAY from that
 *    fix. Aiming at the fix here warms the BACKTRAIL while the contact stays
 *    one sampling cycle ahead and buried, so the endpoint is the position its
 *    own kinematics put it at two poll intervals from now.
 *
 * Runs EVERY poll, warm cells included, for the same reason the fix cells do:
 * `warmGroundFloor` skips cells that already have a real DEM, but the mesh
 * sampler needs to see a cell again AFTER its DEM prior lands, since a sample
 * without that prior is rejected. Offering a cell once would leave it DEM-only
 * for the session — at fields where the photogrammetric mesh sits well above
 * bare earth that is still metres of burial.
 *
 * Budgeting is need-ranked and dedupe-first: cells this poll already collected
 * cost NOTHING (a parked contact's corridor is its own fix cell, so it never
 * competes), candidates are ordered by how many of their cells are actually
 * cold, and each takes at most DISPLAY_CORRIDOR_FAIR_SHARE before anyone takes
 * seconds. Insertion-order spending starved the contacts that needed it most.
 *
 * Purely additive to the existing batch: same fire-and-forget DEM resolve, same
 * one-shot DEM-validated mesh sampler. No latch, no heal.
 *
 * @param {Array<{lat: number, lon: number}>} out - This poll's warm points.
 * @param {number|null} viewerLat @param {number|null} viewerLon - Viewer subpoint.
 */
function _collectDisplayCorridorCells(out, viewerLat, viewerLon) {
  if (viewerLat == null || viewerLon == null) return;
  // Cells the poll already collected (grounded + low-airborne fix cells).
  const seen = new Set();
  for (const p of out) {
    const c = coarseFloorCoord(p.lat, p.lon);
    seen.add(`${c.lat},${c.lon}`);
  }

  const candidates = [];
  for (const [icao24, info] of _flightData) {
    if (!info?.onGround) continue;
    // T7: a contact whose 3D model is the visual never reads a display floor.
    if (_modelOwnsVisual(icao24)) continue;
    if (!Number.isFinite(info.rawLat) || !Number.isFinite(info.rawLon)) continue;
    if (_approxDistanceKm(viewerLat, viewerLon, info.rawLat, info.rawLon) > DISPLAY_CORRIDOR_RADIUS_KM) continue;
    const dr = _deadReckon(icao24, _scratchCorridorPos);
    if (!dr) continue;
    // Read the sibling scratches IMMEDIATELY, before any other _deadReckon call.
    const extrapolating = _drExtrapolating;
    const speedMps = Number.isFinite(_drSpeedMps) ? _drSpeedMps : (info.velocity || 0);
    const courseDeg = _drCourseDeg != null ? _drCourseDeg : (info.true_track || 0);
    const c = Cesium.Cartographic.fromCartesian(dr, Cesium.Ellipsoid.WGS84, _scratchCorridorCarto);
    const lat = Cesium.Math.toDegrees(c.latitude);
    const lon = Cesium.Math.toDegrees(c.longitude);
    const cells = corridorFloorCells(corridorPathLatLon({
      extrapolating,
      displayLat: lat,
      displayLon: lon,
      courseDeg,
      speedMps,
      // Same turn the dead-reckon integrates — a sustained-turn taxi leaves a
      // straight tangent within a few hundred metres.
      turnRateDps: info.turnRateDps || 0,
      fixLat: info.rawLat,
      fixLon: info.rawLon,
      lookaheadSec: DISPLAY_CORRIDOR_LOOKAHEAD_SEC,
    }));
    let cold = 0;
    for (const cell of cells) {
      if (cachedGroundFloor(cell.lat, cell.lon) == null) cold += 1;
    }
    candidates.push({ cells, cold, speedMps });
  }
  _corridorEpoch += 1;
  for (const cell of allocateCorridorCells(
    candidates, seen, DISPLAY_CORRIDOR_CELL_BUDGET, DISPLAY_CORRIDOR_FAIR_SHARE, _corridorEpoch,
  )) {
    out.push(cell);
  }
}

/** Test seam for the display-floor clamp (unit-tested against real Cesium math
 *  with seeded mesh cells — the drift mechanism is otherwise only reachable
 *  through a live poll + render loop). */
export function _floorGroundedDisplayPositionForTest(
  info, pos, modelOwnsVisual, icao24 = '__test__', nowMs = Date.now(),
) {
  return _floorGroundedDisplayPosition(icao24, info, pos, modelOwnsVisual, nowMs);
}

/** Test hook: drops the per-contact display-floor state (hysteresis + rebuild
 *  cache) so each case starts clean. There is no cross-contact state to reset —
 *  the clamp is per-contact all the way down. */
export function _clearDisplayFloorStateForTest() {
  _displayFloorState.clear();
}

/** Test hook: drops cached model ground snaps so a browser-harness scenario
 *  cannot inherit another scenario's per-contact measurement. */
export function _clearGroundSnapStateForTest() {
  _groundSnap.clear();
}

/** Spec identity for a LOADED model: URL and scale together (same-URL classes
 *  differ by scale — airliner vs quadjet both ship airplane.glb). */
const _specKeyFor = (klass) => {
  const spec = _modelSpec(klass);
  return `${spec.url}@${spec.scale}`;
};
/** Class-change model sync (enrichment AND poll-path klass updates): when the
 *  aircraft's live model or in-flight load no longer matches its class's spec,
 *  drop it so the eligibility pass reloads the right asset at the right scale.
 *  Gap-proof: the fleet billboard is re-shown BEFORE the release so the
 *  contact never goes invisible for the tick gap; _releaseModel's generation
 *  bump also invalidates any pending load. The tracked standalone model gets
 *  the same rule (its billboard entity is always the fallback visual). */
function _syncModelToClass(icao24) {
  const key = _specKeyFor(_flightData.get(icao24)?.klass);
  const current = _models.get(icao24);
  if ((current && current._gevSpecKey !== key) || (!current && _modelPending.has(icao24))) {
    const bb = _billboards.get(icao24);
    if (bb && icao24 !== _trackedIcao) bb.show = true;
    _releaseModel(icao24);
  }
  if (icao24 === _trackedIcao && _trackedModel && _trackedModel._gevSpecKey !== key) {
    _releaseTrackedModel();
  }
}

/** IR hot-target mode (field test 2026-08-16): the NVG/FLIR post-styles
 *  map LUMINANCE, so mid-gray textured models read cold and vanish into
 *  terrain. While a boost style is active every model renders flat white
 *  (hottest); per-spec color/tint restores on style exit. Driven by ui.js
 *  setStyle via the `irBoost` layer param. */
let _irBoost = false;
/** Boosted models render UNLIT (owner cockpit-FLIR field rounds, 2026-08-16):
 *  the white tint alone is applied to the MATERIAL, so Cesium still
 *  sun-shades it — near-horizon viewing shows a plane's SIDE, ~90° to a high
 *  sun, so it rendered near-BLACK in FLIR/NVG while sun-lit neighbors glowed.
 *  LightingModel.UNLIT emits the flat white directly, orientation be damned.
 *  CRITICAL (field-verified via scene.pick): assigning customShader to an
 *  already-READY model is a silent no-op — the property sets but the shader
 *  program never rebuilds. The boost therefore flips by RELEASE-AND-RELOAD
 *  (see setParams), so every boosted model gets the shader AT CREATION.
 *  One shared shader instance — stateless, safe across models. */
const _IR_UNLIT_SHADER = new Cesium.CustomShader({ lightingModel: Cesium.LightingModel.UNLIT });
/** Flip the whole 3D fleet's boost state by dropping models so the eligibility
 *  pass reloads them with creation-time boost options (both directions — a
 *  boosted model must not stay flat white back in Normal). Destroying 350
 *  GPU-backed models synchronously inside the style handler stalls the render
 *  thread (review P1; same failure the cockpit path documents), so the release
 *  is BATCHED through the fleet tick: each tick drops a bounded slice, showing
 *  each plane's billboard first (gap-proof per plane, no double-image window).
 *  Models are tagged with the boost state they loaded under, so queue entries
 *  whose model already matches the current state (rapid style cycling, or a
 *  reload that already happened) are skipped. In-flight loads are invalidated
 *  immediately (cheap gen bumps); the tracked model is a single primitive and
 *  reloads synchronously. */
const IR_RELOAD_BATCH = 40;
let _irReloadQueue = null;
function _reloadModelsForIrBoost() {
  _irReloadQueue = [..._models.keys()];
  for (const icao of _modelPending) {
    if (!_models.has(icao)) _modelGen.set(icao, (_modelGen.get(icao) || 0) + 1);
  }
  _releaseTrackedModel();
}
function _drainIrReloadQueue() {
  if (!_irReloadQueue) return;
  const batch = _irReloadQueue.splice(0, IR_RELOAD_BATCH);
  for (const icao of batch) {
    const model = _models.get(icao);
    if (!model || model._gevIrBoost === _irBoost) continue; // already right state
    const bb = _billboards.get(icao);
    if (bb && icao !== _trackedIcao) bb.show = true;
    _releaseModel(icao);
  }
  if (_irReloadQueue.length === 0) _irReloadQueue = null;
}

/** Lazily create the glTF model for an aircraft (fire-and-forget; billboard shows until ready). */
async function _ensureModel(icao24) {
  // Never model the TRACKED aircraft — it owns a separate entity billboard, and the fleet
  // tick skips it, so a model here would be orphaned + double-rendered.
  if (icao24 === _trackedIcao) return;
  _requestTypeEnrichment(icao24, true); // model-eligible: about to render in 3D — jump the ambient backlog
  if (_models.has(icao24) || _modelPending.has(icao24)) return;
  // Count PENDING loads in the cap so a zoomed-in tick can't fire 100s of concurrent loads
  // (the cap is rechecked post-await too, before the add). Mode-aware so 'all' can reach MAX_ALL.
  if ((_models.size + _modelPending.size) >= _modelCap()) return;
  const epoch = _modelEpoch;             // lifecycle token: if destroy() bumps it, this load is dead
  const gen = _modelGen.get(icao24) || 0; // capture; if it changes during the load, we're stale
  _modelPending.add(icao24);
  let model = null;
  // Spec identity captured at load START — if enrichment reclassifies the
  // aircraft mid-load, the post-await admission below rejects the stale asset.
  // Boost state likewise: the creation options bake it in, so a mid-load
  // toggle must reject too (the reload queue only covers ADMITTED models).
  const specKey = _specKeyFor(_flightData.get(icao24)?.klass);
  const loadIrBoost = _irBoost;
  try {
    const spec = _modelSpec(_flightData.get(icao24)?.klass);
    model = await Cesium.Model.fromGltfAsync({
      url: spec.url,
      asynchronous: false,
      minimumPixelSize: MODEL_MIN_PX,
      scale: spec.scale,
      color: _irBoost ? Cesium.Color.WHITE : _modelColor(icao24),
      colorBlendMode: Cesium.ColorBlendMode.MIX,
      // Launch presentation keeps the code-side tint dominant for every approved
      // model; IR boost removes the remaining diffuse hint with flat UNLIT white.
      colorBlendAmount: _irBoost ? 1.0 : spec.blendAmount,
      customShader: _irBoost ? _IR_UNLIT_SHADER : undefined,
      id: icao24, // so scene.pick returns the icao for click-to-track
    });
  } catch {
    // asset/decode fail — stay billboard. Only touch this lifecycle's state if still current
    // (a destroy/re-init may have swapped the globals while this load was in flight).
    if (epoch === _modelEpoch) { _modelPending.delete(icao24); _cleanupModelGen(icao24); }
    return;
  }
  // A load from a PREVIOUS lifecycle (destroy→init happened mid-load) must NOT mutate the new
  // epoch's _modelPending/_modelGen or add to the new collection — just drop its model.
  if (epoch !== _modelEpoch) { try { model.destroy(); } catch { /* gone */ } return; }
  _modelPending.delete(icao24);
  // Post-await admission: reject (and DESTROY the loaded model) if anything changed during the
  // load — a release bumped the generation (track/untrack/remove), the layer toggled off / was
  // torn down, the aircraft is gone or now tracked, a model already exists, or the cap filled.
  // Recheck the shared Display 3D toggle and altitude ceiling after the async
  // load. Cockpit uses the same OFF / Proximity / All contract as map Display.
  const stale = (_modelGen.get(icao24) || 0) !== gen
    || !_modelRegimeActive() || !_modelCollection || _modelCollection.isDestroyed()
    || !_flightData.has(icao24) || icao24 === _trackedIcao
    || _models.has(icao24) || _models.size >= _modelCap()
    // Class reclassified mid-load → this GLB/scale is for the OLD class.
    || _specKeyFor(_flightData.get(icao24)?.klass) !== specKey
    // IR boost flipped mid-load → this model baked the wrong shader/tint.
    || _irBoost !== loadIrBoost;
  if (stale) {
    try { model.destroy(); } catch { /* already gone */ }
    _cleanupModelGen(icao24); // bound the map
    return;
  }
  // Keep the pick identity explicit on the resolved primitive. This also
  // protects injected/custom loaders that do not copy the creation option.
  model.id = icao24;
  model._gevSpecKey = specKey; // class-change sync compares against this
  model._gevIrBoost = loadIrBoost; // boost-flip reload queue compares against this
  // Admitted, not yet the visual. Cesium's default is show=true, which would let
  // an unplaced primitive claim ownership from the billboard for the frames
  // between admission and the next fleet tick (and draw at the identity matrix,
  // i.e. the Earth's centre). The handoff turns it on once it has a matrix.
  model.show = false;
  _modelCollection.add(model);
  _models.set(icao24, model);
  _planeModelLoaded = true; // GLB is cached now — the tracked entity's model can fade in its billboard
}

/** Remove the 3D model for ONE aircraft (removal / military-suppression / track handoff).
 *  Bumps the load generation so any in-flight load for this icao is rejected on completion. */
function _releaseModel(icao24) {
  const m = _models.get(icao24);
  const pending = _modelPending.has(icao24);
  // Only bump the generation when there's something to invalidate (an in-flight load or a
  // live model) — so removing never-modeled aircraft doesn't grow _modelGen.
  if (m || pending) {
    _modelGen.set(icao24, (_modelGen.get(icao24) || 0) + 1);
  }
  if (m) {
    if (_modelCollection && !_modelCollection.isDestroyed()) { try { _modelCollection.remove(m); } catch { /* gone */ } }
    _models.delete(icao24);
  }
  // Do NOT clear _modelPending here — the in-flight load's OWN post-await removes it. Keeping
  // it (a) prevents a duplicate load from starting and (b) keeps the bumped gen entry alive so
  // the resolving load's gen-check still rejects it.
  _cleanupModelGen(icao24);
}

/** Drop an icao's generation entry once nothing references it (no live model, no in-flight
 *  load) — keeps _modelGen bounded. Shared by _releaseModel + both _ensureModel exit paths. */
function _cleanupModelGen(icao24) {
  if (!_modelPending.has(icao24) && !_models.has(icao24)) _modelGen.delete(icao24);
}

/** Remove all live models (toggle-off / zoom-out); billboards take back over next tick. */
function _releaseModels() {
  _irReloadQueue = null; // a full release supersedes any pending boost-flip drain
  // Invalidate in-flight loads so a completion after this bulk release can't add a model.
  for (const icao of _modelPending) _modelGen.set(icao, (_modelGen.get(icao) || 0) + 1);
  if (_modelCollection && !_modelCollection.isDestroyed()) {
    for (const m of _models.values()) { try { _modelCollection.remove(m); } catch { /* gone */ } }
  }
  _models.clear();
}

/** Destroy the standalone tracked-aircraft model and invalidate any in-flight load. */
function _releaseTrackedModel() {
  _trackedModelGen++;
  _trackedModelLoading = false;
  if (_trackedModel) {
    if (_modelCollection && !_modelCollection.isDestroyed()) { try { _modelCollection.remove(_trackedModel); } catch { /* gone */ } }
    _trackedModel = null;
  }
}

/** Per-frame driver for the standalone tracked model. Runs every preUpdate (not the 80 ms fleet
 *  cadence) so the centered plane moves smoothly. The tracked entity stays a pure billboard, so the
 *  follow-camera's bounding sphere is ALWAYS ready — toggling 3D, or tracking while already zoomed
 *  in, can never stall or freeze the centering (the old model-graphic-on-entity failure mode). */
function _updateTrackedModel() {
  const active = _trackedIcao && _trackedModelRegimeActive()
    && _modelCollection && !_modelCollection.isDestroyed();
  if (!active) { if (_trackedModel) _trackedModel.show = false; return; }
  // Ask the frame-cached source directly. If the entity callback already ran,
  // this is a no-op; if model loading completed between phases, it establishes
  // this frame's single sample before the model renders. Camera, detection, and
  // readout consumers then reuse that exact cached position.
  const pos = _trackedDisplayPosition(_trackedIcao) || _billboards.get(_trackedIcao)?.position;
  if (!pos) { if (_trackedModel) _trackedModel.show = false; return; }
  if (!_trackedModel && !_trackedModelLoading && _trackedModelLoadAllowed()) {
    _trackedModelLoading = true;
    const gen = _trackedModelGen;
    const trackedSpec = _modelSpec(_flightData.get(_trackedIcao)?.klass);
    const trackedKey = _specKeyFor(_flightData.get(_trackedIcao)?.klass);
    const trackedIrBoost = _irBoost;
    Cesium.Model.fromGltfAsync({
      url: trackedSpec.url,
      asynchronous: false,
      minimumPixelSize: TRACKED_MODEL_MIN_PX,
      scale: trackedSpec.scale,
      color: _irBoost ? Cesium.Color.WHITE : Cesium.Color.CYAN,
      colorBlendMode: Cesium.ColorBlendMode.MIX,
      // The tracked aircraft uses the same dominant light tint as the fleet;
      // IR boost removes the remaining diffuse hint with flat UNLIT white.
      colorBlendAmount: _irBoost ? 1.0 : trackedSpec.blendAmount,
      customShader: _irBoost ? _IR_UNLIT_SHADER : undefined,
      // Pick id (H1): without it, clicking the very plane being tracked read as
      // EMPTY SPACE (scene.pick → primitive with no id) → an unintended
      // deselect. With the icao, the click handler recognizes it as ours.
      id: _trackedIcao,
    }).then((m) => {
      // Untracked / re-tracked / torn down during the load → drop it.
      if (gen !== _trackedModelGen || !_modelCollection || _modelCollection.isDestroyed()) { try { m.destroy(); } catch { /* gone */ } return; }
      // Class reclassified OR boost flipped mid-load (no release ran —
      // _trackedModel was still null): drop the stale asset; driver reloads.
      if (_specKeyFor(_flightData.get(_trackedIcao)?.klass) !== trackedKey || _irBoost !== trackedIrBoost) {
        try { m.destroy(); } catch { /* gone */ }
        _trackedModelLoading = false;
        return;
      }
      // Assign after resolution as well as in the creation options so the
      // standalone primitive always exposes the tracked aircraft pick id.
      m.id = _trackedIcao;
      m._gevSpecKey = trackedKey; // class-change sync compares against this
      m.show = false; // admitted, not yet the visual — the driver shows it once placed
      // Seed the world transform before the primitive enters the scene. A model
      // can become ready+shown between render phases; leaving Cesium's identity
      // default here produces a one-frame jump to the Earth's center.
      const currentPos = _trackedDisplayCached()
        || _billboards.get(_trackedIcao)?.position;
      if (currentPos) {
        const displayPos = _modelDisplayPosition(_trackedIcao, currentPos, _scratchGroundPos);
        if (displayPos) _modelMatrix(displayPos, _trackedDisplayCourse(), m.modelMatrix);
      }
      _trackedModel = m;
      _trackedModelLoading = false;
      // A good load retires this selection's failure budget — a contact that
      // recovers after a transient blip is not one attempt from giving up.
      _trackedModelFailIcao = null;
      _trackedModelFailCount = 0;
      _trackedModelRetryAtMs = 0;
      _modelCollection.add(m);
      _planeModelLoaded = true; // GLB cached — the tracked billboard can fade out once the model is up
    }).catch((err) => {
      if (gen !== _trackedModelGen) return; // superseded load — not this selection's failure
      _trackedModelLoading = false;
      _noteTrackedModelLoadFailure(trackedSpec.url, err);
    });
    return; // billboard carries the visual until the model is ready
  }
  if (_trackedModel) {
    // Keep the transform current while GPU resources are still loading. Cesium
    // can flip ready during scene update after this callback; waiting for ready
    // here would let that first rendered frame use a stale load-start matrix.
    const displayPos = _modelDisplayPosition(_trackedIcao, pos, _scratchGroundPos);
    if (!displayPos) {
      _trackedModel.show = false; // no ground evidence → the billboard carries it
      return;
    }
    _modelMatrix(displayPos, _trackedDisplayCourse(), _trackedModel.modelMatrix);
    if (!_trackedModel.ready) return;
    const spec = _modelSpec(_flightData.get(_trackedIcao)?.klass);
    _trackedModel.scale = trackedModelScaleForPixelCap({
      baseScale: spec.scale,
      nativeRadiusM: spec.nativeRadiusM,
      rangeM: Cesium.Cartesian3.distance(_viewer.camera.positionWC, displayPos),
      viewportHeightPx: _viewer.scene.canvas.clientHeight,
      fovyRad: _viewer.camera.frustum.fovy,
      maximumPixelSize: TRACKED_MODEL_MAX_PX,
    });
    _trackedModel.show = true;
  }
}

function _fleetTick() {
  if (!_viewer || !_billboardCollection || !_billboardCollection.show) return;
  const scene = _viewer.scene;
  const camera = _viewer.camera;
  const nowMs = focusNowMs(Date.now());

  // (The tracked trail head is now the per-frame _trailHeadEntity segment — no 1 Hz
  // primitive rebuild needed here anymore.)

  if ((nowMs - _lastFleetTickMs) < FLEET_DR_INTERVAL_MS) return;
  const tickDtSec = _lastFleetTickMs
    ? Math.min(COURSE_SLEW_DT_MAX_SEC, (nowMs - _lastFleetTickMs) / 1000)
    : 0.08;
  _lastFleetTickMs = nowMs;

  _drainIrReloadQueue(); // bounded per-tick slice of any pending boost-flip reload
  if (_cockpitContactMode) _refreshCockpitNearContacts();
  const poseSig = cameraPoseSignature(camera);
  // Only the nearby Cockpit silhouettes need projected course; far dots are
  // rotation-free. The per-contact gate below keeps the pip path cheap.
  const doRotations = (poseSig !== _lastCamPoseSig || (nowMs - _lastRotPassMs) >= ROTATION_REFRESH_MS);
  if (doRotations) {
    _lastCamPoseSig = poseSig;
    _lastRotPassMs = nowMs;
  }

  const occluder = horizonOccluder(camera);
  const focusTarget = getFocusTarget();

  // 3D model regime: only when enabled AND the camera is zoomed in past the altitude ceiling.
  // Drop all models the moment we leave it (toggled off / zoomed out) so billboards resume.
  const useModels = _modelRegimeActive();
  // Drop live models AND invalidate in-flight loads on leaving the regime (else a load that
  // resolves after zoom-out could briefly add a model outside the 3D-model regime).
  if (!useModels && (_models.size || _modelPending.size)) _releaseModels();

  // 3D-model eligibility: by DISTANCE (the mode's add/keep band), with ON-SCREEN PRIORITY under the
  // cap. FOUR passes, visible-first, so the slots are spent on what you can see: (1) KEEP on-screen
  // already-modeled (hysteresis for visible planes); (2) ADD on-screen new inside the add radius,
  // nearest first; (3) KEEP off-screen already-modeled; (4) ADD off-screen new with leftover slots
  // (so a plane just off the cone still models — the "planes right next to me aren't 3D" complaint).
  // Crucially KEEP is SPLIT by frustum: an off-screen retained model (pass 3) can never starve an
  // on-screen plane that wants one (passes 1–2) — a single KEEP-everything pass could fill the cap
  // with off-screen retained models. Pure-distance let off-screen planes eat the cap; pure-frustum
  // filtering dropped near off-screen planes entirely. This does both right.
  let modelEligible = null;
  if (useModels) {
    const cap = _modelCap();
    const camPos = camera.positionWC;
    const addM = _modelAddDistM();
    const addDistSq = addM * addM;
    const keepM = _modelKeepDistM();
    const keepDistSq = keepM * keepM;
    const cull = camera.frustum.computeCullingVolume(camPos, camera.directionWC, camera.upWC);
    // Candidates = planes within the KEEP radius, nearest first, each tagged with on-screen-ness.
    const cand = [];
    for (const [icao, bb] of _billboards) {
      if (icao === _trackedIcao) continue;
      // A converted TR-3B renders as a billboard and can never take a model, so
      // it must not occupy a CAP SLOT either — excluded here at selection time,
      // not just at the handoff below, or accumulated conversions would starve
      // ordinary contacts of 3D models. (The handoff guard stays as defence.)
      if (isTr3b(icao)) continue;
      // Ground planes compete for model slots like everyone else (product rule
      // 2026-07-03: "3D mode is respected regardless of whether a plane is on the
      // ground or in the air — no distinction"). The cap + nearest-first ordering
      // below already bound airport clusters; grounded placement is handled by the
      // one-shot ground snap in _modelDisplayPosition.
      const d2 = Cesium.Cartesian3.distanceSquared(camPos, bb.position);
      if (d2 > keepDistSq) continue; // beyond the keep radius → never eligible
      Cesium.Cartesian3.clone(bb.position, _scratchModelBS.center);
      cand.push([icao, d2, cull.computeVisibility(_scratchModelBS) !== Cesium.Intersect.OUTSIDE]);
    }
    cand.sort((a, b) => a[1] - b[1]); // nearest first
    if (cand.length > cap && (nowMs - _lastModelCapWarnMs) > 5000) {
      console.warn(`[Data:Flights] ${cand.length} planes in 3D range; capped at ${cap} (${_models3dMode}). On-screen planes are prioritized.`);
      _lastModelCapWarnMs = nowMs;
    }
    modelEligible = new Set();
    // 1. KEEP on-screen already-modeled (visible retained — no flicker for what you can see).
    for (const [icao, , inF] of cand) { if (modelEligible.size >= cap) break; if (inF && _models.has(icao)) modelEligible.add(icao); }
    // 2. ADD on-screen NEW inside the add radius, nearest first (visible additions win the cap).
    for (const [icao, d2, inF] of cand) { if (modelEligible.size >= cap) break; if (inF && d2 <= addDistSq && !modelEligible.has(icao)) modelEligible.add(icao); }
    // 3. KEEP off-screen already-modeled (hysteresis, but LOWER priority than anything visible — so a
    //    retained off-screen model can never starve an on-screen plane that wants one; dropping it is
    //    invisible and it re-adds the moment it's back in view).
    for (const [icao, , inF] of cand) { if (modelEligible.size >= cap) break; if (!inF && _models.has(icao)) modelEligible.add(icao); }
    // 4. ADD off-screen NEW inside the add radius with any leftover slots.
    for (const [icao, d2, inF] of cand) { if (modelEligible.size >= cap) break; if (!inF && d2 <= addDistSq && !modelEligible.has(icao)) modelEligible.add(icao); }
    const toRelease = [];
    for (const icao of _models.keys()) {
      if (icao !== _trackedIcao && !modelEligible.has(icao)) toRelease.push(icao);
    }
    for (const icao of toRelease) _releaseModel(icao);
  }

  for (const [icao24, bb] of _billboards) {
    if (icao24 === _trackedIcao) continue; // tracked entity owns its own motion

    const info = _flightData.get(icao24);

    const dr = _deadReckon(icao24, _scratchFleetPos);
    // The dead-reckoned point drifts away from the fix whose cell supplied the
    // height, so a grounded contact's sprite ends up under the mesh it taxied
    // (or coasted) over. Re-floor at the DISPLAYED coordinate — read-only, and
    // never while a 3D model owns the visual (T7).
    const display = _floorGroundedDisplayPosition(icao24, info, dr, _modelOwnsVisual(icao24), nowMs);
    // Gate the write — assigning Billboard.position dirties the whole
    // collection's vertex buffer, so skip sub-meter moves.
    if (display && Cesium.Cartesian3.distanceSquared(display, bb.position) > 1.0) {
      bb.position = display;
    }

    // Round 6: occlusion-test a LIFTED point for contacts rendering below
    // (or within a wingspan of) the ellipsoid — EllipsoidalOccluder judges a
    // sub-ellipsoid point near the limb "beyond the horizon" and the fleet
    // pass would hide a plane that is really just low over high-N terrain
    // waiting for its floor to warm (ATL grounded contacts at geoid −31 m).
    const beyondHorizon = !occluder.isPointVisible(info?.cullPosition || bb.position);
    // A billboard flipping INTO view (horizon reveal while the camera idles)
    // gets its rotation refreshed THIS tick even without a pose change —
    // otherwise it reappears wearing its stale (often creation-north) nose for
    // up to ROTATION_REFRESH_MS. (Model-handed-off planes also read show=false
    // here; harmless — the model branch below `continue`s past the rotation.)
    const revealed = !beyondHorizon && !bb.show;
    if (bb.show === beyondHorizon) bb.show = !beyondHorizon;
    if (beyondHorizon) {
      // Also hide any 3D model — otherwise a model that crossed the limb would keep
      // rendering through the hidden globe at its last matrix.
      const m = _models.get(icao24);
      if (m && m.show) m.show = false;
      continue;
    }

    // One order-independent write site composes freshness × focus × limb haze
    // for alpha, and base class/ground scale × limb taper for scale. Cesium's
    // locked NearFarScalar remains a separate multiplicative stage. This
    // narrowly amends always-visible rendering without count culling or zero
    // alpha; nearer focus behavior remains tunable rather than universal.
    const cameraDistanceM = Cesium.Cartesian3.distance(camera.positionWC, bb.position);
    const distanceScale = nearFarScalarValueAtDistance(bb.scaleByDistance, cameraDistanceM);
    const focus = advanceProjectedSpriteFocus(
      bb,
      bb.position,
      scene,
      camera,
      nowMs,
      focusTarget,
      undefined,
      (bb.width || 20) * (bb.scale || 1) * distanceScale * 0.5,
      (bb.height || 20) * (bb.scale || 1) * distanceScale * 0.5,
    );
    const isCockpitNear = _cockpitContactMode && _cockpitNearContacts.has(icao24);
    const baseColor = _cockpitContactMode && !isCockpitNear
      ? (isMilitaryIcao(icao24) ? MIL_TINT : COCKPIT_CIVILIAN_COLOR)
      : _fleetBillboardColor(icao24);
    const treatment = applyAircraftBillboardTreatment({
      billboard: bb,
      baseScale: _cockpitContactMode && !isCockpitNear ? 1 : _fleetBillboardScale(icao24, info?.klass),
      baseAlpha: _missingPolls.get(icao24) ? 0.45 : 1,
      baseColor,
      focusFactor: focus.factor,
      cameraDistanceM,
      cameraHeightM: camera.positionCartographic?.height,
    });
    _billboardLimbScale.set(bb, treatment.factors.scale);
    // Two-tier glyph raster (field test 2026-08-16): the billboard atlas
    // has no mipmaps, so no single texture stays crisp across the ~25–150
    // device-px range scaleByDistance produces. Swap between the 64 px fleet
    // raster and the 192 px close raster on the billboard's ACTUAL on-screen
    // size — post-treatment bb.scale, so focus/limb recession counts — with
    // hysteresis so zoom oscillation never thrashes the atlas.
    if (!_cockpitContactMode || isCockpitNear) {
      const glyphDevPx = (bb.width || 20) * (bb.scale || 1)
        * distanceScale * (globalThis.devicePixelRatio || 1);
      const wantLarge = bb._gevIconLarge ? glyphDevPx > 56 : glyphDevPx > 76;
      if (wantLarge !== !!bb._gevIconLarge) {
        bb._gevIconLarge = wantLarge;
        bb.image = aircraftIcon(_iconKind(icao24, info?.klass), wantLarge ? TRACKED_ICON_PX : undefined);
      }
    }

    // Smoothed display course: the path direction _deadReckon just reported
    // for THIS aircraft (nothing else calls _deadReckon in between), rate-
    // limited so segment-boundary course steps glide instead of snapping.
    // The slew cap eases toward COURSE_MIN_DPS at low speed, and a hovering
    // aircraft (hold flag) keeps its previous nose direction outright.
    const rawCourse = _drCourseDeg != null ? _drCourseDeg : ((info && info.true_track) || 0);
    const prevCourse = _displayCourse.get(icao24);
    const course = (_drCourseHold && prevCourse != null)
      ? prevCourse
      : limitCourseStep(
        prevCourse, rawCourse,
        courseSlewCapDps(_drSpeedMps != null ? _drSpeedMps : ((info && info.velocity) ?? NaN), COURSE_MAX_DPS),
        tickDtSec,
      );
    _displayCourse.set(icao24, course);

    // 3D model takes over from the billboard for in-view planes (modelEligible). GAP-PROOF: the
    // billboard stays shown until the model is actually READY to render, so a plane is never both
    // iconless AND modelless (the "planes vanish when 3D turns on" bug). Position the model every
    // tick regardless so it's framed the instant it becomes ready.
    // Converted TR-3Bs stay 2D on purpose: the Easter egg IS the triangle, and
    // there is no GLB for it, so the model handoff is suppressed rather than
    // fed a stand-in mesh. The billboard keeps rendering (and keeps satisfying
    // the getNearby/getDetectableObjects `bb.show` visibility guards), so a
    // converted contact still works in Contacts and Cockpit.
    if (useModels && dr && modelEligible.has(icao24) && !isTr3b(icao24)) {
      _ensureModel(icao24);
      const model = _models.get(icao24);
      const ownsVisual = _driveFleetModelHandoff(
        icao24,
        model,
        bb,
        dr,
        course,
        () => {
          applyAircraftModelTreatment({
            model,
            // IR boost must survive the per-tick treatment write — otherwise
            // any alpha change would repaint the ordinary tint over the hot
            // white. Boosted models also skip the recession fade: hot targets
            // stay full-strength at any range (billboards keep their normal
            // fade — full-opacity glyph walls read as overwhelming).
            baseColor: _irBoost ? Cesium.Color.WHITE : _modelColor(icao24),
            alpha: _irBoost ? 1 : treatment.alpha,
          });
        },
      );
      if (ownsVisual) continue; // skip billboard rotation
    }

    if ((!_cockpitContactMode || isCockpitNear) && (doRotations || revealed)) {
      const rot = screenProjectedRotation(scene, bb.position, course, bb.rotation);
      if (rot !== null && Math.abs(rot - bb.rotation) > 0.002) {
        bb.rotation = rot;
      }
    }
  }
}

/**
 * Build a public descriptor for one aircraft using its best current position
 * (dead-reckoned when history exists, billboard position otherwise).
 * @param {string} icao24 - ICAO 24-bit transponder address.
 * @returns {{icao24: string, callsign: string|null, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number, velocityMps: number|null, track: number|null}|null}
 *   Descriptor with a cloned position, or null if the aircraft is unknown.
 */
function _describeFlight(icao24) {
  // DATA, NOT PIXELS — deliberately UNFLOORED (2026-08-19). The display floor
  // lifts grounded contacts onto the visible mesh so the sprite you see is not
  // buried; that is a rendering correction, not a measurement. This descriptor
  // feeds query/analyst/subject APIs — `findByQuery` (voice track-by-name),
  // `getTrackedInfo` (cockpit + readout altitude), `getTrackedSubject`
  // (proximity counts and distances) — where the honest answer is what the
  // aircraft REPORTED, not where its icon was nudged to avoid clipping tiles.
  // `altitudeM` is therefore the barometric/aviation value and `renderAltitudeM`
  // the fix-time datum, neither of them the floored display height. No
  // user-visible surface renders `position` as the plane's on-screen location —
  // every visual consumer reads the floored per-frame cache instead (see
  // `_trackedDisplayPosition`). If that ever changes, floor this path too.
  const info = _flightData.get(icao24);
  const bb = _billboards.get(icao24);
  const basePos = _deadReckon(icao24) || (bb ? bb.position : null);
  if (!basePos) return null;
  const displayed = displayedKinematics({
    derivedSpeedMps: _drSpeedMps,
    derivedTrackDeg: _drCourseDeg,
    reportedSpeedMps: info?.velocity,
    reportedTrackDeg: info?.true_track,
  });
  const carto = Cesium.Cartographic.fromCartesian(basePos, Cesium.Ellipsoid.WGS84, _scratchCarto);
  if (!carto) return null;
  return {
    icao24,
    callsign: String(info?.callsign || '').trim() || null,
    position: Cesium.Cartesian3.clone(basePos),
    latitude: Cesium.Math.toDegrees(carto.latitude),
    longitude: Cesium.Math.toDegrees(carto.longitude),
    // The cockpit instrument reports aviation altitude, not the Cesium
    // ellipsoid height of the camera/ground-clamped render position. The
    // latter can be slightly negative over terrain near the surface.
    altitudeM: Number.isFinite(info?.altitude) ? info.altitude : carto.height,
    renderAltitudeM: Number.isFinite(info?.renderAltitudeM) ? info.renderAltitudeM : carto.height,
    onGround: info?.onGround === true,
    velocityMps: displayed.speedMps,
    track: displayed.trackDeg,
    stale: Boolean(_missingPolls.get(icao24) || _backoff),
    airline: info?.airline ?? null,
    // CLASS label follows the TR-3B conversion so every downstream card
    // (cockpit, Contacts, analyst) agrees with the triangle on screen.
    typeName: tr3bTypeLabel(icao24, info?.typeName ?? null),
    typeCode: tr3bTypeLabel(icao24, info?.typeCode ?? null),
    // IDENTITY, deliberately NOT converted: registration is the airframe's tail
    // number and feeds `_contactLabel`'s callsign → registration → hex chain, so
    // a converted contact keeps the label convention every other contact uses.
    // Trimmed like `callsign` above so every consumer (cockpit readout, voice
    // narration, getTrackedSubject) can use it as a label link without
    // re-guarding a whitespace-only enrichment value.
    registration: _toCleanText(info?.registration) || null,
    origin: info?.route && _routeIsPlausible(icao24, info.route) ? info.route.origin.code : null,
    destination: info?.route && _routeIsPlausible(icao24, info.route) ? info.route.destination.code : null,
    route: info?.route && _routeIsPlausible(icao24, info.route) ? {
      origin: { ...info.route.origin },
      destination: { ...info.route.destination },
    } : null,
  };
}

/**
 * Append one fix to the tracked aircraft's trail accumulation and refresh
 * the rendered trail. Caller passes an owned (cloned) Cartesian3.
 * @param {Cesium.Cartesian3} position - New fix position, appended at the head.
 */
function _appendTrailFix(position) {
  _trailPositions.push(position);
  if (_trailPositions.length > TRAIL_MAX_POINTS) _trailPositions.shift();
  _refreshTrailDisplay();
}

/**
 * Renders the trail with its head clamped to the render-behind display
 * position. Raw newest fixes run up to RENDER_DELAY_SEC ahead of the
 * displayed aircraft (PRD C2 delayed clock) — drawing them verbatim makes
 * the trail extend in FRONT of the icon. The head is refreshed ~1Hz from
 * the fleet tick so it stays glued to the moving aircraft.
 */
function _refreshTrailDisplay() {
  // The trail BODY is the accumulated fixes EXCLUDING the newest raw one — that newest
  // fix is at ~now, ~one poll interval AHEAD of the delayed icon (rendered at
  // now − RENDER_DELAY_SEC), so drawing it would push the trail in front of the plane.
  // The cheap per-frame _trailHeadEntity segment bridges the last body point to the
  // delayed dead-reckoned head, so the body primitive only rebuilds on a real fix
  // (poll cadence), never at motion cadence.
  if (!_trail) return;
  _trail.setPositions(_trailPositions.length > 1 ? _trailPositions.slice(0, -1) : _trailPositions);
}

/**
 * Start the trail for a newly tracked aircraft: seed it with the short
 * dead-reckoning history (chronological), render immediately, then
 * fire-and-forget an OpenSky track backfill.
 * @param {string} icao24 - ICAO 24-bit transponder address being tracked.
 */
function _startTrail(icao24) {
  _trailBackfillToken += 1;
  _trailPositions = [];
  const history = _positionHistory.get(icao24) || [];
  // Seed only fixes at/behind the DELAYED display time (now − RENDER_DELAY_SEC). The
  // newest ~RENDER_DELAY_SEC of fixes are AHEAD of the displayed icon; including them
  // would draw the trail in front of the plane. They join the trail via _appendTrailFix
  // as they age past the delay.
  const seedRenderTime = Cesium.JulianDate.addSeconds(
    Cesium.JulianDate.now(), -RENDER_DELAY_SEC, _scratchWarmupTime
  );
  for (const fix of history) {
    if (Cesium.JulianDate.lessThanOrEquals(fix.time, seedRenderTime)) {
      _trailPositions.push(Cesium.Cartesian3.clone(fix.position));
    }
  }
  if (!_trail && _viewer) {
    _trail = createTrail(_viewer, { color: TRAIL_COLOR, width: 2.5 });
  }
  _trail?.setVisible(!_cockpitContactMode);
  // Live head segment: last fix → current dead-reckoned icon, updated every frame via
  // a CallbackProperty (Cesium updates entity-polyline positions cheaply, unlike the
  // trail primitive which fully rebuilds on setPositions). Keeps the head glued to the
  // 12 Hz icon instead of lagging ~1 s behind it.
  if (!_trailHeadEntity && _viewer) {
    _trailHeadEntity = _viewer.entities.add({
      // 'gev-trail' namespace (round 6): claimed by trailRenderer's pick
      // owner so a click on the head segment never reads as empty space.
      id: `gev-trail:fl-head-${++_trailHeadSeq}`,
      show: !_cockpitContactMode,
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          // Need ≥2 accumulated points: the body draws all-but-newest, so the head must
          // start at the last DISPLAYED body point (index n−2). With a single fix that
          // point would be the sole raw fix — which is ~now, AHEAD of the delayed icon —
          // so the segment would draw IN FRONT of the plane. Likewise during warm-up the
          // icon predates all real history, so there is no valid body point behind it.
          if (!_trackedIcao || _trailPositions.length < 2 || _isTrackWarmingUp()) return [];
          const head = _trackedTrailCached() || _trackedDisplayPosition(_trackedIcao);
          if (!head) return [];
          // body[n−2] (last displayed body point) → delayed head: runs FORWARD, never a
          // backward/reversing segment.
          const start = _trailPositions[_trailPositions.length - 2];
          // On a contact that has not moved this segment runs from inside the
          // model out to its own anchor — a line through the fuselage. The END
          // never gives, so a moving trail still terminates on the tail; the
          // START is what slides, from nothing on a parked contact out to the
          // whole segment once it has cleared its own envelope.
          // See trailHeadStart. Read `head` in place and clone only on the draw
          // path — a suppressed parked contact runs this every frame.
          const from = trailHeadStart(
            start, head, _trackedModelCenterWorld(), _trackedModelEnvelopeM(), _scratchTrailHead,
          );
          if (!from) return [];
          return [from, Cesium.Cartesian3.clone(head)];
        }, false),
        width: 2.5,
        material: Cesium.Color.fromCssColorString(TRAIL_COLOR).withAlpha(0.9),
        // Round 4: the head must never vanish into the mesh either (dimmed
        // when occluded so depth still reads).
        depthFailMaterial: Cesium.Color.fromCssColorString(TRAIL_COLOR).withAlpha(0.45),
        arcType: Cesium.ArcType.GEODESIC, // round 8: consistent with the trail body (no chords)
      },
    });
  }
  _refreshTrailDisplay();

  const oldestFixEpochSec = history.length
    ? Cesium.JulianDate.toDate(history[0].time).getTime() / 1000
    : Infinity;
  _backfillTrail(icao24, _trailBackfillToken, oldestFixEpochSec);
}

/**
 * Fire-and-forget OpenSky /tracks backfill (PRD F1). On success, splices
 * waypoints strictly older than the oldest seeded fix AHEAD of the locally
 * accumulated fine segment, capped at TRAIL_MAX_POINTS (newest kept). Any
 * failure (404/429/timeout/malformed) silently keeps the local-only trail.
 * @param {string} icao24 - ICAO 24-bit transponder address being tracked.
 * @param {number} token - Backfill token captured at request time.
 * @param {number} oldestFixEpochSec - Epoch seconds of the oldest seeded fix.
 * @returns {Promise<void>}
 */
async function _backfillTrail(icao24, token, oldestFixEpochSec) {
  let path = null;
  try {
    const response = await fetch('/api/gev/opensky-track?icao24=' + encodeURIComponent(icao24), {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return;
    const data = await response.json();
    path = Array.isArray(data?.path) ? data.path : null;
  } catch {
    return; // silent fallback to the accumulated trail
  }
  if (!path || token !== _trailBackfillToken || icao24 !== _trackedIcao) return;

  // OpenSky track waypoints: [time, latitude, longitude, baro_altitude, true_track, on_ground]
  // Height-datum fix (Task 6): /tracks only ever reports barometric/MSL altitude
  // (no per-waypoint geo_altitude in this endpoint), so waypoint render height is
  // the documented visual FALLBACK baroM + geoidHeight(waypointLat, waypointLon)
  // — geometrically approximate, not exact, same honesty caveat as the live
  // baro-fallback branch of pickRenderAltitudeM.
  await ensureGeoidReady();
  const parsed = [];
  for (const waypoint of path) {
    if (!Array.isArray(waypoint)) continue;
    const [time, lat, lon, baroAlt] = waypoint;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!Number.isFinite(time) || time >= oldestFixEpochSec) continue;
    parsed.push({ lat, lon, baroAlt });
  }
  if (!parsed.length) return;

  // Field-test fix (WAKE01 trail-underground, 2026-07-06 — mirror of
  // militaryFlights.js): resolve the coarse ellipsoidal ground along the track
  // and floor every waypoint at it so low baro segments never dive below the
  // mesh; a no-baro waypoint (predominantly taxi/ground segments in /tracks)
  // sits ON the surface when the floor is known.
  // Round-2 fix: the
  // resolve is BOUNDED (≤1.2 s), not a blocking await — a cold Re:Earth
  // lookup across a long path could stall the paint for seconds-to-timeout.
  // Paint with whatever cells are warm; the resolve keeps filling the cache
  // in the background for the next paint/select.
  await resolveGroundFloorCellsBounded(parsed);
  // Re-check the backfill token after the await (same guard as post-fetch):
  // tracking may have moved on while the terrain race was in flight.
  if (token !== _trailBackfillToken || icao24 !== _trackedIcao) return;

  const older = [];
  let lastAltM = null; // carry-forward for no-baro points whose cell isn't warm yet
  for (const { lat, lon, baroAlt } of parsed) {
    const baroM = Number.isFinite(baroAlt) ? baroAlt + geoidHeight(lat, lon) : null;
    let altM = floorAltitudeM(baroM, cachedGroundFloor(lat, lon));
    // No baro + unresolved floor: hold the previous waypoint's altitude
    // (continuity — never a dive/spike to a made-up height). Leading points
    // with nothing to carry keep the old 10 km airborne default.
    if (altM == null) altM = lastAltM != null ? lastAltM : 10000;
    lastAltM = altM;
    older.push(Cesium.Cartesian3.fromDegrees(lon, lat, altM));
  }

  _trailPositions = older.concat(_trailPositions);
  if (_trailPositions.length > TRAIL_MAX_POINTS) {
    _trailPositions = _trailPositions.slice(_trailPositions.length - TRAIL_MAX_POINTS);
  }
  _refreshTrailDisplay();
}

/**
 * Clear the rendered trail and accumulation; invalidate pending backfills.
 */
function _clearTrail() {
  _trailBackfillToken += 1;
  _trailPositions = [];
  if (_trail) _trail.clear();
  if (_trailHeadEntity && _viewer && !_viewer.isDestroyed()) {
    try { _viewer.entities.remove(_trailHeadEntity); } catch { /* already gone */ }
  }
  _trailHeadEntity = null;
}

/**
 * Destroy the trail primitive entirely (layer disable/teardown).
 */
function _destroyTrail() {
  _clearTrail();
  if (_trail) {
    _trail.destroy();
    _trail = null;
  }
}

/**
 * Stop tracking the currently followed aircraft.
 *
 * Restores the hidden billboard, removes the tracked Entity, resets lerp
 * state, and RELEASES the camera IN PLACE — no flyTo. Deselect used to fly
 * an ~80 km pulled-back overview; the owner field-ruled that wrong
 * (2026-07-02: "it randomly zooms way up and loses my context"). The camera
 * now simply stays at its current position/orientation, immediately free to
 * orbit/zoom. Applies to every deselect path: click-empty-space, Escape,
 * aged-out plane, layer disable, and voice stopTracking.
 *
 * @param {boolean} [skipViewerUntrack=false] - ANOTHER layer just grabbed the
 *   follow-camera: tear down our own state but leave viewer.trackedEntity
 *   alone (the new owner controls it).
 * @param {object} [options] - Clear origin.
 * @param {boolean} [options.evicted=false] - The contact aged out of the feed
 *   rather than being deselected. Consumers that keep a readout on screen
 *   (the Cockpit Contact panel) hold last-known values for an eviction and
 *   only tear down on a deliberate clear.
 */
function _clearTracking(skipViewerUntrack = false, {
  evicted = false,
  origin = 'programmatic',
} = {}) {
  _trackedCameraFrameStop?.();
  _trackedCameraFrameStop = null;
  if (!_trackedIcao) {
    clearFocusTarget('flights');
    return;
  }
  const clearedIcao = _trackedIcao;
  clearFocusTarget('flights', clearedIcao);

  // Restore the original billboard appearance. The rotation is re-seeded from
  // the tracked entity's last rendered rotation and a rotation pass is forced
  // (_lastCamPoseSig below): the fleet billboard otherwise reappears with the
  // STALE screen rotation it had when tracking began — up to a full
  // ROTATION_REFRESH_MS of a wrong (possibly reversed) nose on release.
  if (_billboards.has(_trackedIcao)) {
    const bb = _billboards.get(_trackedIcao);
    bb.show = true;
    bb.width = 20;
    bb.height = 20;
    // Ground/military-aware restore (a plane untracked while taxiing must come
    // back muted-gray at ground scale, not white at full scale).
    bb.color = _fleetBillboardColor(_trackedIcao);
    bb.scale = _fleetBillboardScale(_trackedIcao, _flightData.get(_trackedIcao)?.klass);
    bb.rotation = _lastTrackedRotation;
  }
  _lastCamPoseSig = ''; // force a fleet rotation pass on the next tick

  // Stop tracking and remove the entity. skipViewerUntrack: when ANOTHER layer just grabbed the
  // follow-camera, we tear down our own state but must NOT clear viewer.trackedEntity (the new owner
  // controls it now — clearing it would yank the camera off their plane). Releasing trackedEntity
  // does NOT move the camera: Cesium resets the lookAt transform in place, so the view stays where
  // the follow left it and the user can immediately orbit/zoom.
  if (_viewer && !skipViewerUntrack) {
    _viewer.trackedEntity = undefined;
  }
  if (_trackedEntity) {
    _viewer.entities.remove(_trackedEntity);
    _trackedEntity = null;
  }
  _releaseTrackedModel();
  _resetTrackedSelectionState(); // the zoom band + load-failure budget belong to the selection we just dropped
  _trackedIcao = null;
  _applyFleetBillboardPresentation(clearedIcao, _billboards.get(clearedIcao));
  clearTrackedSubjectContext('flights');
  _emitAwarenessEvent('gev:awareness-subject-cleared', {
    layerId: 'flights',
    id: clearedIcao,
    origin,
    reason: evicted ? 'evicted' : 'deliberate',
  });
  // Invalidate the per-frame DR cache + reconciliation state so a same-frame re-track
  // cannot read the previous aircraft's cached/smoothed position.
  _resetTrackedDisplay();
  _clearTrail();
}

function _normalizeTrackedIcao(candidate) {
  const normalized = String(candidate ?? '').trim().toLowerCase();
  return normalized || null;
}

function _isUsableOpenSkyState(state) {
  if (!Array.isArray(state) || typeof state[0] !== 'string' || !_normalizeTrackedIcao(state[0])) {
    return false;
  }
  return Number.isFinite(state[5]) && Number.isFinite(state[6]);
}

/**
 * Whether the Military layer suppresses this civil duplicate right now.
 *
 * The dedicated Military layer owns icon/track/click for known-military
 * contacts, so the OpenSky duplicate is dropped while that layer is on. Two
 * contacts are exempt, both for the same reason — this layer still owns them:
 *
 *   - the CURRENTLY tracked one, which hands off on untrack; and
 *   - a target this layer is holding on its deferred-restore latch.
 *
 * The second exemption is what makes a shared/local Follow of a mil-registry
 * hex restorable at all. The accepted-snapshot id set is built BEFORE this
 * suppression runs, so without it the target is provably present in a healthy
 * feed yet has no billboard, `trackById` fails, and the restore reports
 * "feed unavailable" about a feed that was perfectly fine.
 *
 * @param {string} icao24 - Normalized ICAO 24-bit address.
 * @returns {boolean} True when the civil duplicate must be dropped.
 */
function _militaryLayerSuppresses(icao24) {
  if (!isMilitaryLayerActive()) return false;
  if (icao24 === _trackedIcao) return false;
  if (icao24 === _pendingTrackingRestore?.id) return false;
  return true;
}

function _applyPendingTrackingRestore() {
  const pending = _pendingTrackingRestore;
  if (!pending || pending.generation !== _trackingIntentGeneration) return false;
  if (!_billboardCollection?.show || !_billboards.has(pending.id)) return false;
  _pendingTrackingRestore = null;
  _trackFlight(pending.id, { origin: pending.origin });
  return true;
}

function _cancelPendingTrackingRestore() {
  _trackingIntentGeneration += 1;
  _pendingTrackingRestore = null;
}

/** Multi-line tracked presentation text: "CS · FL · kts" + "Airline · Type" +
 *  "ORIG → DEST". The route line is gated by
 *  routePlausible so a wrong-leg adsbdb route is hidden, not displayed.
 *  While the plane is in its missed-poll grace (coasting on dead reckoning
 *  with sticky metadata), the first line carries a "· STALE" cue — the fleet's
 *  45%-alpha billboard fade doesn't apply to the tracked plane (its entity
 *  owns the visual), so without this the readout would present last-known
 *  velocity/altitude as live. */
function _trackedLabelText(icao24) {
  const info = _flightData.get(icao24);
  if (!info) return icao24;
  // A whitespace-only callsign ("   ") is truthy, so `(info.callsign || icao24)`
  // kept it, then .trim() emptied it → the callsign slot dropped out of the
  // readout. `_contactLabel` trims FIRST, then falls through registration to
  // the ICAO hex, so a callsign-less enriched contact heads its readout with
  // the tail number rather than raw hex.
  const cs = _contactLabel(icao24, info);
  const altFt = Math.round((info.altitude || 0) * 3.28084);
  const fl = altFt >= 18000 ? `FL${Math.round(altFt / 100)}` : `${altFt} ft`;
  const spd = info.velocity ? `${Math.round(info.velocity * 1.944)} kts` : '';
  const stale = (_missingPolls.get(icao24) || _backoff) ? 'STALE' : '';
  const lines = [[cs, fl, spd, stale].filter(Boolean).join(' · ')];
  // Converted contacts report their class as TR-3B and nothing else — the
  // operator/type identity is exactly what the Easter egg is replacing.
  const ident = isTr3b(icao24)
    ? tr3bTypeLabel(icao24)
    : [info.airline, info.typeName || info.typeCode].filter(Boolean).join(' · ');
  if (ident) lines.push(ident);
  if (info.route && _routeIsPlausible(icao24, info.route)) {
    lines.push(`${info.route.origin.code} → ${info.route.destination.code}`);
  }
  return lines.join('\n');
}

/** Write the explicit tracked presentation model and refresh its host entry. */
function _updateTrackedLabelModel(icao24) {
  if (!_trackedEntity || icao24 !== _trackedIcao) return;
  _trackedEntity.gevLabelModel = trackedLabelModelFromText(
    _trackedLabelText(icao24),
    '#39d0ff',
  );
  refreshTrackedReadout(_trackedEntity);
  // The readout and the context slot describe the same contact — refresh them
  // together so voice never narrates a fix the card has already replaced.
  refreshTrackedSubjectContext(_contextSubjectMetadata(icao24));
}

/** Re-image the tracked entity's billboard from the current class/conversion. */
function _syncTrackedBillboardImage() {
  if (!_trackedIcao || !_trackedEntity?.billboard) return;
  _trackedEntity.billboard.image = aircraftIcon(
    _iconKind(_trackedIcao, _flightData.get(_trackedIcao)?.klass),
    TRACKED_ICON_PX,
  );
}

/**
 * Re-render one contact after its TR-3B conversion (or the active IR style)
 * changed. Converting drops any 3D model so the triangle owns the visual; the
 * billboard image, tracked entity, and tracked card are all re-derived here.
 * @param {string} icao24 - ICAO 24-bit address.
 * @returns {boolean} True when the layer owns this contact.
 */
function _refreshTr3bContact(icao24) {
  const id = String(icao24 || '').trim().toLowerCase();
  if (!id) return false;
  if (isTr3b(id)) {
    // Drop the 3D handoff for this contact — the fleet tick now skips it, so
    // an already-loaded model would otherwise linger with the billboard hidden.
    if (_models.has(id) || _modelPending.has(id)) _releaseModel(id);
    const bb = _billboards.get(id);
    if (bb && id !== _trackedIcao) bb.show = true; // horizon cull re-asserts next tick
    if (id === _trackedIcao) {
      _releaseTrackedModel();
      _syncTracked2dRotation();
    }
  }
  const bb = _billboards.get(id);
  if (bb) _applyFleetBillboardPresentation(id, bb);
  if (id === _trackedIcao) {
    _syncTrackedBillboardImage();
    _updateTrackedLabelModel(id);
  }
  _viewer?.scene?.requestRender?.();
  return _billboards.has(id) || id === _trackedIcao;
}

/** Re-image every converted contact this layer owns (IR style flip). */
function _refreshTr3bForStyle() {
  for (const id of tr3bConvertedIds()) {
    if (_billboards.has(id) || id === _trackedIcao) _refreshTr3bContact(id);
  }
}

/**
 * Seed only the mutable state needed to exercise tracked-card refreshes through
 * the production poll reconciler. Tests still call `flightsLayer.update()`;
 * this seam avoids constructing the browser-only Cesium layer lifecycle.
 * @param {object} state
 * @param {string} state.icao24
 * @param {object} state.entity
 * @param {object} state.meta
 * @param {object} state.billboard
 * @param {object} state.billboardCollection
 * @param {object} state.viewer
 * @param {Array<Object>} [state.history=[]]
 * @param {boolean} [state.tracked=true]
 * @param {Iterable<[string, object]>} [state.models=[]] - Fleet 3D models keyed
 *   by icao24, for the billboard-hidden/model-shown handoff state.
 */
export function _setTrackedFlightRefreshStateForTest({
  icao24,
  entity,
  meta,
  billboard,
  billboardCollection,
  viewer,
  history = [],
  tracked = true,
  models = [],
  modelCollection = null,
}) {
  _viewer = viewer;
  _modelCollection = modelCollection;
  _billboardCollection = billboardCollection;
  _billboards = new Map([[icao24, billboard]]);
  _models.clear();
  for (const [key, model] of models) _models.set(key, model);
  _detectionObjects = new Map();
  _flightData = new Map([[icao24, meta]]);
  _positionHistory = new Map([[icao24, history]]);
  _missingPolls = new Map();
  _displayCourse.clear();
  _geoidNCache.clear();
  _trackedIcao = tracked ? icao24 : null;
  _trackedEntity = tracked ? entity : null;
  _trackedModel = null;
  _cancelPendingTrackingRestore();
  _trackedModelLoading = false;
  // NOTE: deliberately does NOT reset the per-selection latches. They are
  // production state owned by the tracking lifecycle (_resetTrackedSelectionState),
  // and clearing them here would mask exactly the deselect→re-track hole this
  // seam is used to test.
  _backoff = false;
  _retryAt = 0;
}

/** Seed the authoritative snapshot outcome used by share-Follow tests. */
export function _setFlightTrackingRefreshOutcomeForTest({
  status = 'accepted',
  ids = [],
  source = 'OpenSky Network',
  coverage = 'test',
} = {}) {
  const epoch = ++_trackingRefreshEpoch;
  _lastTrackingRefreshOutcome = {
    epoch,
    status,
    ids: new Set(ids.map((id) => String(id).trim().toLowerCase())),
    source,
    coverage,
  };
}

/** Add a cached contact so tests can model a target arriving on a later feed. */
export function _addFlightTrackingCandidateForTest({ icao24, meta, billboard, history = [] }) {
  _billboards.set(icao24, billboard);
  _flightData.set(icao24, meta);
  _positionHistory.set(icao24, history);
}

/** Expose the military-suppression decision for the civil duplicate. */
export function _militaryLayerSuppressesForTest(icao24) {
  return _militaryLayerSuppresses(icao24);
}

/** Arm the deferred restore latch directly, without a full setParams turn. */
export function _armFlightTrackingRestoreForTest(id, origin = 'share-restore') {
  _pendingTrackingRestore = id === null
    ? null
    : { id, generation: _trackingIntentGeneration, origin };
}

/** Return the deferred restore target held by the production tracker. */
export function _pendingFlightTrackingRestoreForTest() {
  return _pendingTrackingRestore?.id ?? null;
}

/** Exercise the production deferred-restore retry after a simulated feed refresh. */
export function _applyPendingFlightTrackingRestoreForTest() {
  return _applyPendingTrackingRestore();
}

/** Set the exact Cockpit subject through the production state transition for focused tests. */
export function _setCockpitDetectionSubjectForTest(active, subjectId = null) {
  _applyCockpitState({ active, subjectId });
}

/** Evaluate the TRACKED contact's zoom regime through the production predicate.
 *  The decision is latch-bearing (default-on, hysteretic, cockpit/TR-3B-suppressed)
 *  and otherwise only observable through a live scene, so tests drive it here. */
export function _trackedModelRegimeActiveForTest() {
  return _trackedModelRegimeActive();
}

/** Run one frame of the production tracked-model driver (normally a
 *  `scene.preUpdate` listener) so tests can pin its bounded load retries. */
export function _updateTrackedModelForTest() {
  return _updateTrackedModel();
}

/** Evaluate the production tracked-billboard handoff colour for focused tests. */
export function _trackedBillboardColorForTest() {
  return _modelOwnsVisual(_trackedIcao) ? CYAN_TRANSPARENT : Cesium.Color.CYAN;
}

/** Drive the exact fleet billboard-to-model handoff used by `_fleetTick`. */
export function _driveFleetModelHandoffForTest({ icao24, position, course = 0 }) {
  return _driveFleetModelHandoff(
    icao24,
    _models.get(icao24),
    _billboards.get(icao24),
    position,
    course,
  );
}

/** Exercise the exact asynchronous fleet loader and return its admitted model. */
export async function _ensureFleetModelForTest(icao24) {
  await _ensureModel(icao24);
  return _models.get(icao24) || null;
}

/** Plausibility check anchored to the plane's billboard position (coarse is
 *  fine here — this gates a LABEL, and it must not touch the tracked frame
 *  cache). Missing data → true (never hide what we can't judge). */
function _routeIsPlausible(icao24, route) {
  const info = _flightData.get(icao24);
  const bb = _billboards.get(icao24);
  if (!info || !bb || !bb.position) return true;
  const carto = Cesium.Cartographic.fromCartesian(bb.position, Cesium.Ellipsoid.WGS84, _scratchCarto);
  if (!carto) return true;
  return routePlausible({
    latDeg: Cesium.Math.toDegrees(carto.latitude),
    lonDeg: Cesium.Math.toDegrees(carto.longitude),
    altitudeM: info.altitude ?? null,
    verticalRateMps: info.verticalRate ?? null,
    origin: route.origin,
    destination: route.destination,
  });
}

/**
 * Begin tracking a specific aircraft by ICAO24 address.
 *
 * Clears any existing tracked flight, hides its billboard, and creates a
 * new Entity with:
 *  - A CallbackProperty position driven by dead-reckoning (_deadReckon).
 *  - A CallbackProperty alignedAxis set to the surface normal at the
 *    dead-reckoned position (keeps the icon tangent to the earth).
 *  - A CallbackProperty rotation from the aircraft's true_track heading.
 *  - An explicit host presentation model with callsign, flight level, speed,
 *    identity, and plausible route text.
 *
 * The viewer's trackedEntity is set to this entity so the camera follows it.
 *
 * @param {string} icao24 - ICAO 24-bit transponder address to track.
 */
function _trackFlight(icao24, { origin = 'programmatic' } = {}) {
  _clearTracking(false, { origin }); // switching planes — the new follow-camera takes over

  const bb = _billboards.get(icao24);
  const info = _flightData.get(icao24);
  if (!bb || !info) return;

  _trackedIcao = icao24;
  _resetTrackedSelectionState(); // fresh selection: enter at the ENTER ceiling, full load-retry budget
  _cachedDRFrame = -1;
  _lastTrackedRotation = bb.rotation || 0;
  // Drop any fleet 3D model for this aircraft — the tracked entity now owns its visual (its
  // own billboard + model graphic), and the fleet tick skips the tracked icao, so a leftover
  // fleet model would be orphaned + double-rendered.
  _releaseModel(icao24);

  // Hide the billboard — the tracked entity replaces it visually
  bb.show = false;

  // Helper: smoothed, per-frame-cached tracked position (see _trackedDisplayPosition —
  // one computation shared by the position/alignedAxis/rotation/trail-head callbacks,
  // with discontinuity reconciliation). Falls back to the last billboard position when
  // the aircraft has no fix.
  const getTrackedPosition = () => _trackedDisplayPosition(icao24) || bb.position;

  // Dead-reckoning position property — smooth continuous motion between API updates.
  const positionProperty = new Cesium.CallbackProperty(() => {
    return getTrackedPosition();
  }, false);

  // Create tracked entity: a 2D billboard when zoomed out, a 3D model when zoomed in past the
  // TRACKED altitude ceiling. That handoff is DEFAULT behaviour — it does NOT wait on the
  // DISPLAY-rail 3D toggle, which arms the FLEET. The plane the user zooms into always
  // resolves into an aircraft.
  //
  // The billboard stays SHOWN at all times and is hidden by going TRANSPARENT (alpha 0), not by
  // show=false. This is deliberate: viewer.trackedEntity derives the follow-camera framing from
  // the entity's bounding sphere, and a 3D model graphic reports a PENDING sphere until its glTF
  // finishes loading. If we hid the billboard outright, tracking a plane while already zoomed in
  // would stall the centering until the model loaded. A shown-but-transparent billboard always
  // supplies a ready sphere, so framing is instant; we only drop its alpha once the model GLB is
  // preloaded (_planeModelLoaded), so there's neither a billboard+model double-image nor a gap.
  // The tracked entity is a PURE BILLBOARD — no label or model graphic. The 3D model for the
  // tracked plane is a standalone primitive driven by _updateTrackedModel(); keeping it off the
  // entity is what makes the follow-camera's bounding sphere always ready (see _trackedModel).
  // Keep Cesium's generated entity ID: re-init without destroy can temporarily
  // overlap collections, and an explicit ICAO ID would throw on that duplicate.
  _trackedEntity = _viewer.entities.add({
    position: positionProperty,
    // Force Cesium's built-in EntityView and our close-range camera guard to
    // use the same local frame. AUTO can select a velocity frame while the
    // model matrix uses aircraft orientation; alternating between those
    // frames makes the target oscillate forward/back on screen.
    trackingReferenceFrame: Cesium.TrackingReferenceFrame.ENU,
    billboard: {
      image: aircraftIcon(_iconKind(_trackedIcao, _flightData.get(_trackedIcao)?.klass), TRACKED_ICON_PX),
      width: 28,
      height: 28,
      scale: CLASS_SCALE_2D[_flightData.get(_trackedIcao)?.klass] || 1,
      // Solid cyan when the billboard is the visual (zoomed out, 3D off, or model still loading);
      // transparent once the STANDALONE tracked model is actually up (ready + shown).
      color: new Cesium.CallbackProperty(() => (
        _modelOwnsVisual(_trackedIcao) ? CYAN_TRANSPARENT : Cesium.Color.CYAN
      ), false),
      sizeInMeters: false,
      scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5),
      alignedAxis: Cesium.Cartesian3.ZERO,
      // The tracked target must never vanish into tile geometry — tracking a
      // taxiing plane at street level would otherwise bury the cyan icon inside
      // the runway skin exactly like the fleet ground icons (_groundDepthDistance);
      // its shared-host tracked card is top-composited separately.
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      // Screen-projected rotation, evaluated per frame: exact in tracked-orbit
      // mode where camera.heading lives in the entity's reference frame.
      rotation: new Cesium.CallbackProperty(() => {
        const tracked = _flightData.get(_trackedIcao);
        const pos = getTrackedPosition();
        if (!tracked || !pos || !_viewer) return _lastTrackedRotation;
        const projected = screenProjectedRotation(
          _viewer.scene,
          pos,
          _trackedDisplayCourse(),
          _lastTrackedRotation,
        );
        const rot = stabilizeScreenRotation(_lastTrackedRotation, projected);
        if (rot !== null) _lastTrackedRotation = rot;
        return _lastTrackedRotation;
      }, false),
    },
  });
  _trackedEntity.gevSelectionOrigin = origin;
  _trackedEntity.gevTrackedId = `flights:${icao24}`;
  _trackedEntity.gevLabelModel = trackedLabelModelFromText(_trackedLabelText(icao24), '#39d0ff');

  // A billboard has a ~zero bounding sphere, so Cesium's default follow distance is
  // far too tight (the user had to scroll out to read the plane). Give the entity a
  // calibrated viewFrom — behind + above, distance scaled to altitude — for a readable
  // initial frame with surrounding context. (ENU: east=+X, north=+Y, up=+Z.)
  const followRange = Math.min(Math.max((info.altitude || 1500) * 1.1 + 2500, 3000), 30000);
  _trackedEntity.viewFrom = new Cesium.Cartesian3(0, -followRange * 0.8, followRange * 0.55);

  // Cancel any in-progress camera flight first — otherwise Cesium won't apply the
  // tracked entity's viewFrom on the first frame, so voice-initiated tracking (which
  // often fires mid-fly_to_location) would follow the plane WITHOUT centering/framing it
  // the way a click (idle camera) does.
  // Expose the camera's already-settled position to cross-module HUD consumers (the tracked-target
  // readout) so they draw at the SAME spot the camera framed, without recomputing the dead-reckon in
  // postRender (which would jitter the label against the now-stable plane).
  _trackedEntity.gevDisplayPosition = _trackedDisplayCached;
  // Separate accessor on purpose: `gevDisplayPosition` carries the follow-camera
  // anti-jitter contract and must keep returning the cached DR position. Presentation
  // that should weld to the AIRCRAFT YOU SEE reads `gevVisualPosition` instead.
  _trackedEntity.gevVisualPosition = _trackedVisualCached;
  refreshTrackedReadout(_trackedEntity);
  _viewer.camera.cancelFlight();
  // Camera follows the tracked entity
  _viewer.trackedEntity = _trackedEntity;
  _trackedCameraFrameStop = applyTrackedCameraFrame(
    _viewer,
    _trackedEntity,
    _trackedEntity.viewFrom,
  ) || null;

  // Track-history trail (PRD F1): seed from local history + async backfill.
  // Ground traffic draws NO trail (a taxi path is noise, not a track) — if the
  // plane takes off while tracked, the on_ground→false transition in update()
  // starts one.
  _requestTypeEnrichment(icao24, true); // tracked plane — front of the enrichment queue
  _requestRouteEnrichment(icao24);
  // Round 2 (owner): grounded contacts get trails too — a landed-but-taxiing
  // aircraft's history is retrievable on select. Grounded flights positions
  // are already surface-clamped (the surfaceM chain), so seeds/appends drape.
  _startTrail(icao24);

  _publishTrackedSelection(icao24, origin);

  console.log(`[Data:Flights] Tracking ${_contactLabel(icao24, info)} (${icao24})`);
}

/**
 * Immediate military-suppression handoff sweep (pre-ship audit M2).
 *
 * The poll-time suppression branch in update() only reconciles every 30 s, so
 * toggling the Military layer showed duplicate icons (military ON: both layers
 * render the same aircraft ~3-4 km apart) or holes (military OFF: suppressed
 * aircraft absent) for up to a full poll. Fired synchronously by the registry
 * on the active-state TRANSITION:
 *
 *  - activated  → suppress known-military billboards NOW (mirror of the
 *    poll-time branch, tracked aircraft excluded — it hands off on untrack);
 *  - deactivated → the suppressed aircraft's state was deleted, so bring the
 *    next OpenSky poll forward instead of waiting out the interval (update()
 *    itself still honors _retryAt backoff).
 *
 * @param {boolean} active - New military-layer active state.
 * @returns {void}
 */
function _onMilitaryActiveChange(active) {
  if (!_viewer || !_billboardCollection) return;
  if (active) {
    for (const [icao24, bb] of _billboards) {
      if (!isMilitaryIcao(icao24) || icao24 === _trackedIcao) continue;
      _billboardCollection.remove(bb);
      _billboards.delete(icao24);
      _releaseModel(icao24); // military-suppression: drop any 3D model too
      _flightData.delete(icao24);
      _positionHistory.delete(icao24);
      _displayCourse.delete(icao24);
      _groundSnap.forget(icao24);
      _missingPolls.delete(icao24);
    }
    _count = _billboards.size;
  } else if (_billboardCollection.show) {
    // Fire-and-forget refresh; only while the layer is actually enabled.
    void flightsLayer.update(_viewer);
  }
}

/**
 * Map one aircraft's internal poll record to a plain JSON-safe analyst
 * record (analyst query engine seam). Pure — no Cesium types, no fetches;
 * enrichment fields read the CACHED adsbdb values only. Missing/unknown
 * fields are null, never NaN/undefined. The route-plausibility verdict is
 * computed by the CALLER (it needs the billboard position) and passed in,
 * so an implausible cached route is never surfaced as fact.
 * @param {string} icao24 - ICAO 24-bit transponder address.
 * @param {Object|null|undefined} info - `_flightData` record for this aircraft.
 * @param {{military?: boolean, routeOk?: boolean}} [flags] - Shared-registry
 *   military flag + route-plausibility verdict.
 * @returns {{id: string, icao24: string, callsign: string|null, lat: number|null,
 *   lon: number|null, altitudeM: number|null, speedMps: number|null,
 *   heading: number|null, verticalRateMps: number|null, onGround: boolean,
 *   military: boolean, aircraftClass: string|null, originCountry: string|null,
 *   operator: string|null, routeOrigin: string|null, routeDestination: string|null}}
 */
export function mapAnalystRecord(icao24, info, { military = false, routeOk = false } = {}) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  const callsign = text(info?.callsign);
  return {
    // Display identity for the narration layer. `id` is NOT a queryable field
    // (see ANALYST_LAYERS) and follow-ups carry whole records, so this is a
    // label, not a key — the engine keys on `icao24` below.
    id: callsign || text(info?.registration) || icao24,
    icao24,
    callsign,
    lat: num(info?.rawLat),
    lon: num(info?.rawLon),
    altitudeM: num(info?.altitude), // barometric/MSL — the aviation field, not the render height
    speedMps: num(info?.velocity),
    heading: num(info?.true_track),
    verticalRateMps: num(info?.verticalRate),
    onGround: info?.onGround === true,
    military,
    // A converted contact reports the class it RENDERS as, so an analyst
    // filter/superlative agrees with the triangle on screen.
    aircraftClass: tr3bAircraftClass(icao24, text(info?.klass)),
    originCountry: text(info?.originCountry),
    operator: text(info?.airline),
    routeOrigin: routeOk ? text(info?.route?.origin?.code) : null,
    routeDestination: routeOk ? text(info?.route?.destination?.code) : null,
  };
}

/** Resolve a JSON-safe evidence position into ECEF. DEV-only caller. */
function _focusEvidencePosition(record) {
  const cartesian = record?.cartesian;
  if (Array.isArray(cartesian) && cartesian.length >= 3
    && cartesian.slice(0, 3).every(Number.isFinite)) {
    return Cesium.Cartesian3.fromElements(cartesian[0], cartesian[1], cartesian[2]);
  }
  if (!Number.isFinite(record?.longitude) || !Number.isFinite(record?.latitude)) return null;
  return Cesium.Cartesian3.fromDegrees(
    record.longitude,
    record.latitude,
    Number.isFinite(record.altitudeM) ? record.altitudeM : 3_000,
  );
}

/** Replace the real fleet with deterministic explicit-position contacts. */
function _setFocusEvidenceAircraft(records = []) {
  if (!FOCUS_EVIDENCE_DEV || !_billboardCollection || !_viewer) return { ok: false, count: 0 };
  if (_trackedIcao) _clearTracking();
  _releaseModels();
  for (const bb of _billboards.values()) _billboardCollection.remove(bb);
  _billboards.clear();
  _flightData.clear();
  _positionHistory.clear();
  _displayCourse.clear();
  _missingPolls.clear();
  _focusEvidenceIds.clear();

  for (const record of Array.isArray(records) ? records : []) {
    const id = String(record?.id || '').trim().toLowerCase();
    const position = _focusEvidencePosition(record);
    if (!id || !position) continue;
    const klass = record.klass || 'airliner';
    const altitudeM = Number.isFinite(record.altitudeM)
      ? record.altitudeM
      : (Cesium.Cartographic.fromCartesian(position)?.height || 3_000);
    const meta = {
      callsign: String(record.callsign || id).toUpperCase(),
      altitude: altitudeM,
      renderAltitudeM: altitudeM,
      velocity: Number.isFinite(record.velocityMps) ? record.velocityMps : 0,
      true_track: Number.isFinite(record.trackDeg) ? record.trackDeg : 90,
      klass,
      onGround: false,
      wasAirborne: true,
      turnRateDps: 0,
      lastContactEpochMs: Date.now(),
      rawLat: record.latitude ?? null,
      rawLon: record.longitude ?? null,
      cullPosition: null,
    };
    _flightData.set(id, meta);
    _focusEvidenceIds.add(id);
    const bb = _billboardCollection.add({
      position,
      image: aircraftIcon(_iconKind(id, klass)),
      width: 20,
      height: 20,
      scale: _fleetBillboardScale(id, klass),
      rotation: 0,
      alignedAxis: Cesium.Cartesian3.ZERO,
      color: _fleetBillboardColor(id),
      sizeInMeters: false,
      scaleByDistance: _normalBillboardScaleByDistance(),
      disableDepthTestDistance: _groundDepthDistance(),
      id,
      show: true,
    });
    _billboards.set(id, bb);
  }
  _count = _billboards.size;
  _lastFleetTickMs = 0;
  _viewer.scene.requestRender?.();
  return { ok: true, count: _count };
}

/** Update explicit evidence positions without rebuilding billboards. */
function _moveFocusEvidenceAircraft(records = []) {
  if (!FOCUS_EVIDENCE_DEV) return { ok: false, moved: 0 };
  let moved = 0;
  for (const record of Array.isArray(records) ? records : []) {
    const id = String(record?.id || '').trim().toLowerCase();
    if (!_focusEvidenceIds.has(id)) continue;
    const position = _focusEvidencePosition(record);
    const bb = _billboards.get(id);
    if (!position || !bb) continue;
    bb.position = position;
    const meta = _flightData.get(id);
    if (meta) {
      if (Number.isFinite(record.trackDeg)) meta.true_track = record.trackDeg;
      if (Number.isFinite(record.velocityMps)) meta.velocity = record.velocityMps;
    }
    moved += 1;
  }
  _lastFleetTickMs = 0;
  _viewer?.scene?.requestRender?.();
  return { ok: true, moved };
}

/** JSON-safe visual snapshot for the evidence report. */
function _focusEvidenceSnapshot() {
  if (!FOCUS_EVIDENCE_DEV || !_viewer) return [];
  return [..._focusEvidenceIds].map((id) => {
    const bb = _billboards.get(id);
    const screen = bb?.position
      ? Cesium.SceneTransforms.worldToWindowCoordinates(_viewer.scene, bb.position)
      : null;
    return {
      id,
      show: bb?.show === true,
      scale: bb?.scale ?? null,
      alpha: bb?.color?.alpha ?? null,
      x: screen?.x ?? null,
      y: screen?.y ?? null,
      cameraDistanceM: bb?.position
        ? Cesium.Cartesian3.distance(_viewer.camera.positionWC, bb.position)
        : null,
    };
  });
}

/**
 * Flights data-layer descriptor.
 * Conforms to the layer manager interface: init / enable / disable / update / destroy / getStats.
 * @type {object}
 */
const flightsLayer = {
  id: 'flights',
  name: 'Live Flights',
  icon: '✈️',
  source: 'OpenSky Network',
  // Browser-harness seam: isolates synthetic display-floor scenarios without
  // changing any production lifecycle or cache policy.
  _clearDisplayFloorStateForTest,
  _clearGroundSnapStateForTest,
  /** @type {number} Polling interval (ms) between update() calls */
  updateInterval: 30000,

  /**
   * Initialize the flights layer.
   * Creates the BillboardCollection, resets all state, and installs the
   * click-to-track handler on the scene canvas.
   * @param {Cesium.Viewer} viewer - The CesiumJS viewer instance.
   */
  init(viewer) {
    clearFocusTarget('flights');
    _focusEvidenceIds.clear();
    _viewer = viewer;
    _billboardCollection = new Cesium.BillboardCollection();
    viewer.scene.primitives.add(_billboardCollection);
    registerSpriteCollection('flights', _billboardCollection);
    _modelCollection = new Cesium.PrimitiveCollection();
    viewer.scene.primitives.add(_modelCollection);
    // Warm the glTF cache so the tracked plane's model instantiates instantly when first needed
    // (keeps the retained instance referenced; never rendered). Captured against this epoch so a
    // destroy/re-init mid-load doesn't flip the flag for a torn-down lifecycle.
    if (!_preloadModel) {
      const epoch = _modelEpoch;
      Cesium.Model.fromGltfAsync({ url: PLANE_MODEL_URL, asynchronous: false })
        .then((m) => {
          if (epoch === _modelEpoch) { _preloadModel = m; _planeModelLoaded = true; }
          else { try { m.destroy(); } catch { /* gone */ } }
        })
        .catch(() => { /* tracked plane just stays a billboard a beat longer */ });
    }
    _billboards = new Map();
    _detectionObjects = new Map();
    _flightData = new Map();
    _positionHistory = new Map();
    _displayCourse.clear();
    _groundSnap.clear();
    _count = 0;
    _lastUpdate = null;
    _backoff = false;
    _retryAt = 0;
    _lastError = null;
    _lastStatus = null;
    _lastSource = 'OpenSky Network';
    _lastCoverage = 'worldwide upstream snapshot';
    _trackedIcao = null;
    _resetTrackedSelectionState();
    _trackedEntity = null;
    _cockpitSubjectId = null;
    _cockpitContactMode = document.body.classList.contains('cockpit-mode');
    _cockpitNearContacts = new Set();
    if (!_cockpitModeListener) {
      _cockpitModeListener = (event) => _applyCockpitState(event?.detail);
      window.addEventListener('gev:cockpit-mode-changed', _cockpitModeListener);
    }
    // Fresh session — full bucket, anchor re-seeded on the first sweep.
    _enrichAmbientBudget = _ambientBudgetKnobs().ceil;
    _enrichAmbientRefillAnchorMs = 0;

    _installClickHandler(viewer);

    // React to Military-layer toggles IMMEDIATELY (suppress/restore sweep)
    // instead of waiting out the 30 s poll (M2).
    if (!_milActiveChangeUnsub) {
      _milActiveChangeUnsub = onMilitaryLayerActiveChange(_onMilitaryActiveChange);
    }

    restoreSpriteOrder(viewer);

    console.log('[Data:Flights] Initialized with billboard icons');
  },

  /**
   * Show the billboard collection and re-install the click handler.
   * @param {Cesium.Viewer} viewer
   */
  enable(viewer) {
    if (_billboardCollection) _billboardCollection.show = true;
    holdContinuousRender('flights'); // per-frame animator (perf wave 2)
    if (_modelCollection) _modelCollection.show = true;
    _setCockpitContactMode(document.body.classList.contains('cockpit-mode'));
    // Height-datum fix: warm the geoid grid once per layer-enable. The poll loop
    // only reads geoidHeight() synchronously after this resolves (guarded by
    // _geoidReady) — never awaited per-aircraft, never blocking a poll tick.
    if (!_geoidReady) {
      ensureGeoidReady()
        .then(() => { _geoidReady = true; })
        .catch(() => { /* geoid grid failed to load — baro path stays un-geoid-corrected until retried */ });
    }
    _installClickHandler(viewer);
    registerPickOwner('flights', (pickedId) => _billboards.has(pickedId));
    // Force a fresh rotation pass on the first tick after re-enable
    _lastCamPoseSig = '';
    if (!_preRenderRemove && viewer?.scene) {
      _preRenderRemove = viewer.scene.preRender.addEventListener(_fleetTick);
    }
    if (!_trackedModelPreUpdateRemove && viewer?.scene) {
      _trackedModelPreUpdateRemove = viewer.scene.preUpdate.addEventListener(_updateTrackedModel);
    }
    if (!_moveEndRemove && viewer?.camera) {
      // Arrival polish (field test 2026-07-03: "planes look weird when you first
      // come to them"): when a camera move SETTLES (voice fly-to, fast pan
      // release), force a full rotation pass on the very next frame. The
      // pose-signature gate alone can eat the settle — the final easing frames
      // of a flight land inside one quantization bucket (10 m / 0.06°), leaving
      // every icon wearing its last mid-flight rotation for up to
      // ROTATION_REFRESH_MS. Zeroing the tick throttle too means the pass runs
      // on the next preRender, not up to FLEET_DR_INTERVAL_MS later. Cost: one
      // extra rotation pass per completed camera gesture — nothing per-frame.
      _moveEndRemove = viewer.camera.moveEnd.addEventListener(() => {
        _lastCamPoseSig = '';
        _lastFleetTickMs = 0;
      });
    }
    restoreSpriteOrderOnEnable('flights', viewer);
  },

  /**
   * Hide all flight billboards and tear down click/keyboard handlers.
   * Also clears any active flight tracking so the camera is released.
   * @param {Cesium.Viewer} viewer
   */
  disable(viewer) {
    _abortActiveUpdates();
    _cancelPendingTrackingRestore();
    if (_billboardCollection) _billboardCollection.show = false;
    releaseContinuousRender('flights');
    _releaseModels();
    if (_modelCollection) _modelCollection.show = false;
    _clearTracking();
    _destroyTrail();
    // Remove click handler + keydown listener while disabled to avoid
    // intercepting input when the layer is off
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    if (_trackedEntityChangedRemove) {
      _trackedEntityChangedRemove();
      _trackedEntityChangedRemove = null;
    }
    document.removeEventListener('keydown', _onKeyDown);
    unregisterPickOwner('flights');
    if (_preRenderRemove) {
      _preRenderRemove();
      _preRenderRemove = null;
    }
    if (_trackedModelPreUpdateRemove) {
      _trackedModelPreUpdateRemove();
      _trackedModelPreUpdateRemove = null;
    }
    if (_moveEndRemove) {
      _moveEndRemove();
      _moveEndRemove = null;
    }
  },

  /**
   * Fetch the latest aircraft state vectors from the OpenSky proxy and
   * reconcile them with the billboard collection.
   *
   * Handles HTTP 429 (rate-limit), 401/403 (auth), and transient errors
   * with exponential-ish backoff.  On success, adds, updates, or removes
   * billboards and position history, triggers lerp blending for the
   * tracked aircraft, and updates its label text.
   *
   * @param {Cesium.Viewer} viewer
   * @returns {Promise<void>}
   */
  async update(viewer, { signal = null } = {}) {
    const nowMs = Date.now();
    const trackingRefreshEpoch = ++_trackingRefreshEpoch;
    _lastTrackingRefreshOutcome = {
      epoch: trackingRefreshEpoch,
      status: 'source-unavailable',
      ids: new Set(),
      source: _lastSource,
      coverage: _lastCoverage,
    };
    if (_retryAt && nowMs < _retryAt) {
      _backoff = true;
      return;
    }

    const resourceController = new AbortController();
    _activeUpdateControllers.add(resourceController);
    const updateSignal = signal
      ? AbortSignal.any([signal, resourceController.signal])
      : resourceController.signal;
    try {
      updateSignal.throwIfAborted();
      const response = await fetch(_flightApiUrl(viewer || _viewer), { signal: updateSignal });
      _lastStatus = response.status;
      const responseSource = response.headers.get('x-flight-source');
      const responseCoverage = response.headers.get('x-flight-coverage');
      const authMode = _toLowerText(
        response.headers.get('x-opensky-auth-mode-used') || response.headers.get('x-opensky-auth')
      );
      const authReason = _toLowerText(response.headers.get('x-opensky-auth-reason'));

      if (response.status === 429) {
        console.warn('[Data:Flights] Rate limited, backing off to 30s');
        _backoff = true;
        _retryAt = nowMs + BACKOFF_INTERVAL;
        _lastError = authMode && authMode !== 'anon'
          ? 'OpenSky rate limited'
          : 'OpenSky rate limited (anonymous)';
        return;
      }

      if (response.status === 401 || response.status === 403) {
        console.warn(`[Data:Flights] OpenSky unavailable (${response.status}), backing off`);
        _backoff = true;
        _retryAt = nowMs + BACKOFF_INTERVAL;
        let detail = '';
        try {
          const body = await response.json();
          updateSignal.throwIfAborted();
          detail = typeof body?.error === 'string' ? body.error.trim() : '';
        } catch {
          detail = '';
        }
        _lastError = _deriveOpenSkyAuthError({
          detail,
          authMode,
          authReason,
        });
        return;
      }

      if (!response.ok) {
        console.warn(`[Data:Flights] API returned ${response.status}`);
        _backoff = true;
        _retryAt = nowMs + ERROR_BACKOFF_INTERVAL;
        let detail = '';
        try {
          const body = await response.json();
          updateSignal.throwIfAborted();
          detail = typeof body?.error === 'string' ? body.error.trim() : '';
        } catch {
          detail = '';
        }
        _lastError = detail || `OpenSky HTTP ${response.status}`;
        return;
      }

      const data = await response.json();
      updateSignal.throwIfAborted();
      if (!data || !Array.isArray(data.states)) {
        _backoff = true;
        _retryAt = nowMs + ERROR_BACKOFF_INTERVAL;
        _lastError = 'Malformed OpenSky response';
        return;
      }

      const usableStates = data.states.filter(_isUsableOpenSkyState);
      if (data.states.length > 0 && usableStates.length === 0) {
        _backoff = true;
        _retryAt = nowMs + ERROR_BACKOFF_INTERVAL;
        _lastError = 'Malformed OpenSky aircraft rows';
        return;
      }

      const sourceEpochMs = Number.isFinite(Number(data.time)) && Number(data.time) > 0
        ? Number(data.time) * 1000
        : null;
      const sourceAgeMs = sourceEpochMs == null ? 0 : Math.max(0, Date.now() - sourceEpochMs);
      const sourceStale = sourceAgeMs > SOURCE_STALE_MS;
      _backoff = sourceStale;
      _retryAt = 0;
      _lastError = sourceStale
        ? `Source snapshot ${Math.max(2, Math.round(sourceAgeMs / 60_000))} min old`
        : null;
      _lastSource = responseSource || 'OpenSky Network';
      _lastCoverage = responseCoverage || 'worldwide upstream snapshot';
      const currentIcaos = new Set();
      const acceptedSnapshotIcaos = new Set();
      const now = Cesium.JulianDate.now();
      // Field-test round 3 (2026-07-06, Austin fleet-underground): viewer
      // subpoint + collected floor cells for the viewer-proximate low-contact
      // clamp below — one carto read per poll, one batch warm after the loop.
      const viewerCarto = (viewer || _viewer)?.camera?.positionCartographic || null;
      const viewerLatDeg = viewerCarto ? Cesium.Math.toDegrees(viewerCarto.latitude) : null;
      const viewerLonDeg = viewerCarto ? Cesium.Math.toDegrees(viewerCarto.longitude) : null;
      const floorWarmPoints = [];

      // Destructure OpenSky state vector array (indices per API spec):
      // [0] icao24, [1] callsign, [2] origin_country, [3] time_position,
      // [4] last_contact, [5] longitude, [6] latitude, [7] baro_altitude,
      // [8] on_ground, [9] velocity, [10] true_track, [11] vertical_rate,
      // [12] sensors, [13] geo_altitude (WGS84 ellipsoidal — the CORRECT
      // globe-render height when present; height-datum fix Task 6).
      // Keep military classification fresh while the military layer is off
      refreshMilitaryRegistryIfStale();

      for (const state of usableStates) {
        const [rawIcao24, callsign, origin_country, time_position, last_contact, lon, lat, baro_alt, on_ground, velocity, true_track, , , geo_alt] = state;
        const icao24 = _normalizeTrackedIcao(rawIcao24);
        const category = Number.isFinite(state[17]) ? state[17] : null; // extended=1 emitter category
        const vertical_rate = Number.isFinite(state[11]) ? state[11] : null; // m/s, + = climbing
        acceptedSnapshotIcaos.add(icao24);
        const onGround = on_ground === true;

        // Known-military aircraft: the dedicated military layer wins
        // (icon + track + click) while it is enabled — suppress the
        // OpenSky duplicate entirely (except a currently tracked one,
        // which hands off on untrack).
        const isMil = isMilitaryIcao(icao24);
        if (isMil && _militaryLayerSuppresses(icao24)) {
          const dupe = _billboards.get(icao24);
          if (dupe) {
            _billboardCollection.remove(dupe);
            _billboards.delete(icao24);
            _releaseModel(icao24); // military-suppression: drop any 3D model too
            _flightData.delete(icao24);
            _positionHistory.delete(icao24);
            _displayCourse.delete(icao24);
            _groundSnap.forget(icao24);
            _missingPolls.delete(icao24);
            _geoidNCache.delete(icao24);
          }
          continue;
        }

        currentIcaos.add(icao24);
        _missingPolls.delete(icao24);
        // Sticky merge: OpenSky intermittently drops callsign/velocity/track for
        // aircraft it still positions — hold last-known-good instead of
        // regressing to the ICAO hex / a 0° (north) heading. Bounded by the
        // MISSING_POLL_LIMIT eviction below, which deletes the whole entry.
        const prevMeta = _flightData.get(icao24);
        // Grounded planes with no baro reading sit at 0 m, not the 10 km
        // airborne default (a parked plane must never float).
        // NOTE (height-datum fix): `alt` stays the AVIATION field — the sticky
        // barometric/MSL altitude read by labels (FL/altitude readout),
        // route-plausibility, and follow-camera range heuristics. It is
        // NEVER overwritten or renamed. Where the aircraft actually RENDERS
        // on the ellipsoidal globe is a SEPARATE value (renderAltitudeM,
        // below) — geo_altitude when OpenSky reports it (already WGS84
        // ellipsoidal), else baro+geoid as a visual fallback, else ground
        // surface when parked. `Cartesian3.fromDegrees` gets renderAltitudeM,
        // never `alt` directly.
        const alt = stickyNumber(baro_alt, prevMeta?.altitude, onGround ? 0 : 10000);

        // geoid undulation N: cached per-aircraft (negligible drift — see
        // task brief) once the geoid grid has loaded; unavailable pre-load
        // just means the baro fallback branch below adds N=0 for a beat.
        let geoidN = _geoidNCache.get(icao24);
        if (geoidN === undefined && _geoidReady) {
          geoidN = geoidHeight(lat, lon);
          _geoidNCache.set(icao24, geoidN);
        }

        // on_ground surface prior: ONLY synchronous warm-cache reads here —
        // never a per-aircraft network fetch inside the poll loop (see the
        // batch resolve call below, which fills this cache for NEXT poll). A
        // Round 5 SIMPLIFICATION (product invariant: one floor, evenly applied):
        // the grounded surface is the round-4 choke point and nothing else —
        // rendered-mesh cell first, real (never fallback-poisoned) DEM cell
        // second. The old exact-5-decimal warm chain is GONE: it minted a new
        // key per parked-jitter poll for every grounded contact ON EARTH,
        // hammering Re:Earth into the very failures that poisoned the cache.
        let surfaceM = null;
        if (onGround) {
          surfaceM = cachedGroundFloor(lat, lon); // mesh ?? real DEM (coarse cell)
          // Taxiing crosses into a fresh cold cell every poll — always one
          // step ahead of the warm batch — so fall back to LAST poll's cell
          // (warmed by last poll's batch; aprons are flat across adjacent
          // 111 m cells). Round-5 verify caught taxiing contacts stuck at
          // the geoid without this (round 2's lesson, at cell granularity).
          if (surfaceM == null && Number.isFinite(prevMeta?.rawLat) && Number.isFinite(prevMeta?.rawLon)) {
            surfaceM = cachedGroundFloor(prevMeta.rawLat, prevMeta.rawLon);
          }
          // Grounded contacts near the viewer feed the floor warm/sampler
          // (the only ones whose exact height is visible; far contacts are
          // subpixel and always-on-top anyway).
          if (viewerLatDeg != null &&
              _approxDistanceKm(viewerLatDeg, viewerLonDeg, lat, lon) <= GROUND_FLOOR_CLAMP_RADIUS_KM) {
            floorWarmPoints.push({ lat, lon });
          }
          // Last synchronous resort for a BRAND-NEW grounded contact with NO
          // altitude data at all (nothing warm yet, not even the coarse
          // cell): the geoid surface. At the sea-level airports where most
          // grounded traffic sits, geoidN IS the local ellipsoidal ground to
          // within metres — instantly right — and at elevated fields it is
          // far less wrong than the raw 0 m ellipsoid default for the one
          // poll until the coarse cell warms. STRICTLY gated on "no geo, no
          // baro": a reported baro already reflects the field elevation, and
          // pickRenderAltitudeM's surfaceM branch would let this crude guess
          // outrank it (caught by the ground-3d track regression).
          //
          // 2026-08-21: the rule moved to geoidSurfaceLastResortM, which adds
          // one more gate — a contact that already HAS a render height keeps
          // it. Leaving surfaceM null routes it through the sentinel path
          // below, which holds that height.
          if (surfaceM == null) {
            surfaceM = geoidSurfaceLastResortM({
              geoAltM: geo_alt,
              baroAltM: baro_alt,
              priorRenderM: prevMeta?.renderAltitudeM,
              geoidN,
            });
          }
        }

        const geoAltitudeM = Number.isFinite(geo_alt) ? geo_alt : null;
        const pickedAltM = pickRenderAltitudeM({
          geoAltM: geoAltitudeM,
          baroAltM: Number.isFinite(baro_alt) ? baro_alt : null,
          onGround,
          surfaceM,
          geoidN,
        });
        // pickRenderAltitudeM returns the sentinel `null` only when NEITHER
        // geo_altitude nor baro_altitude was reported THIS poll. Two fallbacks,
        // in priority order:
        //   (1) hold the previous geoid-corrected render height if we have one —
        //       a one-poll baro dropout must NOT snap the plane down by the geoid
        //       undulation N (~46 m in London) and back up next poll. `alt` stays
        //       sticky for labels, so holding the last render height keeps the two
        //       layers consistent through the gap.
        //   (2) otherwise the SAME default policy `alt` already uses, so the two
        //       never disagree on the genuine "no data yet" case (a never-reported
        //       aircraft has no prior render height, so it lands here unchanged).
        let renderAltitudeM;
        if (pickedAltM != null) {
          renderAltitudeM = pickedAltM;
        } else if (Number.isFinite(prevMeta?.renderAltitudeM)) {
          renderAltitudeM = prevMeta.renderAltitudeM;
        } else {
          renderAltitudeM = alt;
        }
        // Field-test fix (WAKE01/RS46 class, 2026-07-06; widened round 3):
        // floor a low airborne contact's render height at the local coarse
        // ground so it can never dive below the mesh. Round 3 (Austin
        // fleet-underground): baro can read BELOW an elevated field — SWA696
        // showed 450 ft at Austin's 542 ft field elevation — and rollout/taxi
        // traffic that OpenSky hasn't flagged on_ground yet renders from that
        // baro, so the whole fleet sat buried at AUS in 2D. Clamping every
        // global contact would need unbounded terrain resolution; instead the
        // clamp covers the TRACKED contact (always) plus every low contact
        // within GROUND_FLOOR_CLAMP_RADIUS_KM of the viewer — the only ones
        // whose burial is visible. Cells warm in one batch after the loop.
        // Airborne only (grounded planes keep the surface-cache path above).
        if (!onGround && renderAltitudeM < GROUND_FLOOR_WARM_MAX_ALT_M &&
            (icao24 === _trackedIcao ||
              (viewerLatDeg != null &&
                _approxDistanceKm(viewerLatDeg, viewerLonDeg, lat, lon) <= GROUND_FLOOR_CLAMP_RADIUS_KM))) {
          renderAltitudeM = floorAltitudeM(renderAltitudeM, cachedGroundFloor(lat, lon));
          floorWarmPoints.push({ lat, lon });
        }

        const position = Cesium.Cartesian3.fromDegrees(lon, lat, renderAltitudeM);
        // Landing/takeoff transition: the on_ground flip restyles IN PLACE.
        const groundFlipped = !!prevMeta && (prevMeta.onGround === true) !== onGround;
        // Either flip direction retires the model's ground snap: a departing plane
        // flies free of it, a landing plane earns a fresh sample where it rolls out.
        if (groundFlipped) _groundSnap.forget(icao24);

        // Store flight metadata for click-to-track labels
        const cat = stickyNumber(category, prevMeta?.category, null);
        const meta = {
          callsign: stickyText(callsign, prevMeta?.callsign),
          altitude: alt,
          // geoAltitudeM/renderAltitudeM are ADDITIVE fields alongside the
          // untouched aviation `altitude` — never rename/replace it (labels,
          // FL readout, route-plausibility, and follow-camera range math all
          // still read `altitude`/baro).
          geoAltitudeM,
          renderAltitudeM,
          onGround,
          // Round 7: sticky airborne history — the landed fast-cull only
          // applies to contacts that actually flew this session.
          wasAirborne: prevMeta?.wasAirborne === true || !onGround,
          // Round 6: lifted occlusion-test point for contacts rendering
          // at/below the ellipsoid (fleet pass reads it — see the occluder
          // note there). Null for the overwhelmingly common airborne case.
          cullPosition: renderAltitudeM < 10 ? Cesium.Cartesian3.fromDegrees(lon, lat, 12) : null,
          velocity: stickyNumber(velocity, prevMeta?.velocity, 0),
          true_track: stickyNumber(true_track, prevMeta?.true_track, 0),
          category: cat,
          // An adsbdb-enriched type code outranks the coarse OpenSky category.
          klass: classifyAircraft({ typeCode: prevMeta?.typeCode ?? null, category: cat }),
          turnRateDps: prevMeta?.turnRateDps || 0,
          verticalRate: stickyNumber(vertical_rate, prevMeta?.verticalRate, null),
          // Analyst seam: OpenSky origin_country (state[2]) — additive, sticky
          // like callsign so a transient blank row doesn't blank the field.
          originCountry: stickyText(origin_country, prevMeta?.originCountry) || null,
          // OpenSky distinguishes the last position epoch from the last
          // transponder message. The fleet coast horizon uses this actual
          // contact time so a temporarily old position does not hard-freeze
          // while fresh velocity/track messages are still arriving.
          lastContactEpochMs: stickyNumber(
            Number.isFinite(last_contact) ? last_contact * 1000 : null,
            prevMeta?.lastContactEpochMs,
            null,
          ),
          // adsbdb enrichment — written by the enrichment callbacks, carried across polls:
          typeCode: prevMeta?.typeCode ?? null,
          typeName: prevMeta?.typeName ?? null,
          registration: prevMeta?.registration ?? null,
          airline: prevMeta?.airline ?? null,
          route: prevMeta?.route ?? null,
          // The RAW poll fix lat/lon (this tick's OpenSky state-vector
          // coords, pre-dead-reckon) — kept distinct from the continuously
          // dead-reckoned billboard position for any consumer that needs the
          // actual reported fix.
          rawLat: lat,
          rawLon: lon,
        };
        _flightData.set(icao24, meta);

        const isTracked = icao24 === _trackedIcao;

        // Append to position history stamped with the FEED's fix epoch
        // (time_position), not client receipt time — OpenSky positions arrive
        // 5-15s stale and receipt-time stamping is what caused the
        // back/forward oscillation. Only append when the fix actually
        // advances, so stale repeats don't create zero-dt segments.
        const fixEpochMs = Number.isFinite(time_position) && time_position > 0
          ? time_position * 1000
          : Date.now();
        const fixTime = Cesium.JulianDate.fromDate(new Date(fixEpochMs));
        if (!_positionHistory.has(icao24)) {
          _positionHistory.set(icao24, []);
        }
        const history = _positionHistory.get(icao24);
        const newest = history[history.length - 1];
        if (!newest || Cesium.JulianDate.greaterThan(fixTime, newest.time)) {
          // Per-fix kinematics: the fix's own velocity/track ride along so the
          // extrapolation paths use the values that BELONG to the fix they
          // extend, not whatever the latest poll reported.
          history.push({
            time: fixTime,
            epochMs: fixEpochMs,
            position: position.clone(),
            velocity: meta.velocity,
            track: meta.true_track,
          });
          if (history.length > POSITION_HISTORY_LIMIT) {
            history.shift();
          }
          // Turn rate from the fix-track history — computed once per new fix
          // (≤5 samples), consumed by the extrapolation paths at tick rate.
          meta.turnRateDps = turnRateFromFixHistory(history);
          // Trail accumulation is separate from the 5-fix DR history (PRD F1)
          // so the visible trail keeps growing while tracked. Ground traffic
          // appends nothing — a touchdown freezes the existing trail.
          // Round 2 (owner): ground traffic appends too — taxi history stays
          // live after touchdown (grounded flights positions are already
          // surface-clamped via the surfaceM chain, so the ground leg drapes).
          if (isTracked) _appendTrailFix(position.clone());
        } else {
          const modelOwnsGroundVisual = _modelOwnsVisual(icao24);
          if (!modelOwnsGroundVisual) {
            liftRepeatedGroundFix(newest, position, meta.onGround);
          }
          // Apply fresh kinematics only from a forward synthetic fix. Mutating
          // the historical fix reprojects the entire stale interval and snaps
          // the rendered aircraft when course or speed changes late.
          const kinematicsChanged = newest.velocity !== meta.velocity
            || newest.track !== meta.true_track;
          if (kinematicsChanged) {
            const synthetic = synthesizeForwardKinematicsFix(newest, {
              epochMs: Date.now(),
              velocity: meta.velocity,
              track: meta.true_track,
              turnRateDps: meta.turnRateDps,
            });
            if (synthetic) {
              history.push(synthetic);
              if (history.length > POSITION_HISTORY_LIMIT) history.shift();
              meta.turnRateDps = turnRateFromFixHistory(history);
              if (isTracked) _appendTrailFix(synthetic.position.clone());
            }
          }
        }

        if (_billboards.has(icao24)) {
          const bb = _billboards.get(icao24);
          // Reclassify if the category resolved/changed (first extended poll);
          // a ground flip (landing/takeoff) re-scales the SAME billboard in
          // place — the transition is a restyle, never a removal.
          // Round 5: depth policy is uniform (always depth-test-free, see
          // _groundDepthDistance) — nothing to flip on landing/takeoff.
          // Position AND rotation are owned by the fleet pass (_fleetTick);
          // course changes land on the next rotation pass (forced below).
          if (!isTracked) {
            // Refresh affiliation hue without clobbering the tick-owned
            // freshness × focus × horizon alpha composition.
            bb.color = _fleetBillboardColor(icao24).withAlpha(bb.color?.alpha ?? 1);
          }
          if (prevMeta?.klass !== meta.klass || groundFlipped || _cockpitContactMode) {
            _applyFleetBillboardPresentation(icao24, bb);
          }
          // Poll-path class change (category updates): same model resync rule
          // as the enrichment path — the class's GLB/scale may have changed.
          if (prevMeta?.klass !== meta.klass) _syncModelToClass(icao24);
        } else {
          const bb = _billboardCollection.add({
            position,
            image: aircraftIcon(_iconKind(icao24, meta.klass)),
            width: isTracked ? 24 : 20,
            height: isTracked ? 24 : 20,
            scale: _fleetBillboardScale(icao24, meta.klass),
            // Screen-projected rotation lands on the next fleet tick.
            rotation: 0,
            alignedAxis: Cesium.Cartesian3.ZERO,
            color: isTracked ? Cesium.Color.CYAN : _fleetBillboardColor(icao24),
            sizeInMeters: false,
            scaleByDistance: _normalBillboardScaleByDistance(),
            // Grounded/near-surface planes sit at/below the photoreal tile
            // surface — render them depth-test-free so they never vanish up
            // close (_groundDepthDistance).
            disableDepthTestDistance: _groundDepthDistance(),
            id: icao24,
            show: !isTracked, // hidden if currently tracked (entity replaces it)
          });
          _billboards.set(icao24, bb);
          _applyFleetBillboardPresentation(icao24, bb);
        }

        // Takeoff while TRACKED: ground traffic drew no trail, so start one
        // from the fresh airborne history (touchdown needs no action — the
        // append gate above simply freezes the existing trail).
        if (isTracked && groundFlipped && !meta.onGround) _startTrail(icao24);

        // If this is the tracked aircraft, update label text
        // (position updates automatically via dead-reckoning CallbackProperty)
        if (isTracked && _trackedEntity) {
          _updateTrackedLabelModel(icao24);
        }
      }

      // Remove aircraft only after MISSING_POLL_LIMIT consecutive absences.
      // OpenSky routinely drops aircraft for a single poll; immediate removal
      // made planes blink and yanked the camera off actively tracked flights.
      // EXCEPTION: likely-landed planes (last fix low + slow) get only
      // LANDED_MISSING_POLL_LIMIT — their disappearance means "landed", not a
      // feed gap, and the full grace left phantom planes parked at airports.
      for (const [icao24, bb] of _billboards) {
        if (currentIcaos.has(icao24)) continue;
        const misses = (_missingPolls.get(icao24) || 0) + 1;
        const limit = _likelyLanded(icao24) ? LANDED_MISSING_POLL_LIMIT : MISSING_POLL_LIMIT;
        if (misses < limit) {
          _missingPolls.set(icao24, misses);
          if (icao24 === _trackedIcao && _trackedEntity) {
            // Honest readout: the tracked plane has no faded billboard (its
            // entity owns the visual), so refresh the label — with icao24 now
            // in _missingPolls, _trackedLabelText appends the STALE cue so
            // last-known velocity/altitude aren't presented as live.
            _updateTrackedLabelModel(icao24);
          }
          continue;
        }
        _missingPolls.delete(icao24);

        // If the tracked flight is truly gone, clear tracking BEFORE deleting
        // its state (M3 ordering, keep it): teardown reads the maps this loop
        // is about to delete (billboard restore, DR cache reset), and we must
        // never leave the camera mid-follow with stale tracking state. The
        // camera is then RELEASED IN PLACE — it stays where the follow left
        // it, fully free (product rule 2026-07-02: no overview flyTo).
        if (icao24 === _trackedIcao) {
          _clearTracking(false, { evicted: true });
        }

        _billboardCollection.remove(bb);
        _billboards.delete(icao24);
        _releaseModel(icao24); // aged-out aircraft: drop its 3D model (no orphan / cap leak)
        _flightData.delete(icao24);
        _positionHistory.delete(icao24);
        _displayCourse.delete(icao24);
        _groundSnap.forget(icao24);
        _geoidNCache.delete(icao24);
        _displayFloorState.delete(icao24);
      }

      // Fresh courses arrived — force a rotation pass on the next fleet tick
      _lastCamPoseSig = '';

      // Ambient type enrichment: give ON-SCREEN planes real types (bounded
      // sweep — see _sweepAmbientEnrichment; internally fail-silent).
      _sweepAmbientEnrichment();

      // 2026-08-19: the loop above only ever collects FIX cells, but a grounded
      // contact renders across every cell its dead-reckoned position drifts
      // through. Add those too, so the display clamp has data where the contact
      // actually is instead of silently passing.
      _collectDisplayCorridorCells(floorWarmPoints, viewerLatDeg, viewerLonDeg);

      // Field-test round 3: one batch warm of the viewer-proximate low-contact
      // floor cells collected in the loop (fire-and-forget, single-flight;
      // read synchronously by NEXT poll's clamp — the military-layer pattern).
      warmGroundFloor(floorWarmPoints);
      // Round 4: sample the RENDERED mesh for those same cells (one-shot per
      // cell, budget-capped, viewer-proximate, google-3d regime only). Own
      // billboards/models are excluded so a vertical probe can't land on an
      // aircraft instead of the pavement.
      sampleMeshFloorCells(_viewer?.scene, floorWarmPoints, {
        excludeObjects: [..._billboards.values(), ..._models.values(), _trackedModel].filter(Boolean),
        viewerLat: viewerLatDeg,
        viewerLon: viewerLonDeg,
      });

      // Round 5: the grounded exact-key warm that used to live here is gone —
      // see the note where _warmGroundedAircraftSurfaceCache was removed. The
      // viewer-proximate coarse warm + mesh sampler above cover everything
      // whose height is actually visible.
      // Round 6: re-floor STALE grounded contacts. A parked plane whose
      // transponder went quiet stops receiving poll updates, so a floor that
      // warms AFTER its last fix never applied — it sat frozen at the geoid
      // (ATL verify: FFT4347 at −30.7 m, 305 m under the apron, forever).
      // Grounded contacts are static, so lifting the stored fix + billboard
      // in place is safe (the DR extrapolates a zero-velocity fix).
      _refloorStaleGroundedContacts(currentIcaos);

      _count = _billboards.size;
      // Freshness belongs to the source snapshot, not the moment this browser
      // received a cached 200 response.
      _lastUpdate = sourceEpochMs ?? Date.now();
      _lastTrackingRefreshOutcome = {
        epoch: trackingRefreshEpoch,
        status: 'accepted',
        ids: acceptedSnapshotIcaos,
        source: _lastSource,
        coverage: _lastCoverage,
      };
      console.log(`[Data:Flights] Updated: ${_count} aircraft`);
      _applyPendingTrackingRestore();

    } catch (e) {
      if (updateSignal.aborted || e?.name === 'AbortError') {
        throw new DOMException('Flights update aborted', 'AbortError');
      }
      console.warn('[Data:Flights] Fetch error:', e);
      _backoff = true;
      _retryAt = Date.now() + ERROR_BACKOFF_INTERVAL;
      _lastError = 'OpenSky network error';
    } finally {
      _activeUpdateControllers.delete(resourceController);
    }
  },

  /**
   * Fully tear down the flights layer — remove primitives, handlers,
   * tracked entities, and clear all internal state maps.
   * @param {Cesium.Viewer} viewer
   */
  destroy(viewer) {
    _abortActiveUpdates();
    releaseContinuousRender('flights'); // direct-destroy path (perf wave 2 fix)
    _clearTracking();
    _destroyTrail();
    _cancelPendingTrackingRestore();
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    if (_trackedEntityChangedRemove) {
      _trackedEntityChangedRemove();
      _trackedEntityChangedRemove = null;
    }
    if (_milActiveChangeUnsub) {
      _milActiveChangeUnsub();
      _milActiveChangeUnsub = null;
    }
    document.removeEventListener('keydown', _onKeyDown);
    if (_cockpitModeListener) {
      window.removeEventListener('gev:cockpit-mode-changed', _cockpitModeListener);
      _cockpitModeListener = null;
    }
    unregisterPickOwner('flights');
    if (_preRenderRemove) {
      _preRenderRemove();
      _preRenderRemove = null;
    }
    if (_trackedModelPreUpdateRemove) {
      _trackedModelPreUpdateRemove();
      _trackedModelPreUpdateRemove = null;
    }
    if (_moveEndRemove) {
      _moveEndRemove();
      _moveEndRemove = null;
    }
    _releaseModels();
    if (_billboardCollection) {
      viewer.scene.primitives.remove(_billboardCollection);
      _billboardCollection = null;
    }
    if (_modelCollection) {
      viewer.scene.primitives.remove(_modelCollection); // removing destroys it + its models
      _modelCollection = null;
    }
    _modelEpoch += 1; // invalidate any in-flight load from this lifecycle (settles post-destroy)
    _modelPending.clear();
    _modelGen.clear();
    if (_preloadModel) { try { _preloadModel.destroy(); } catch { /* gone */ } _preloadModel = null; }
    _planeModelLoaded = false;
    _billboards.clear();
    _detectionObjects.clear();
    _flightData.clear();
    _positionHistory.clear();
    _displayCourse.clear();
    _groundSnap.clear();
    _displayFloorState.clear();
    _enrichQueue.length = 0;
    _enrichSeen.clear();
    if (_enrichDripTimer) { clearTimeout(_enrichDripTimer); _enrichDripTimer = null; }
    _missingPolls.clear();
    _focusEvidenceIds.clear();
    _count = 0;
    _lastUpdate = null;
    _cockpitContactMode = false;
    _cockpitNearContacts = new Set();
    _cockpitSubjectId = null;
    _trackingRefreshEpoch += 1;
    _lastTrackingRefreshOutcome = {
      epoch: _trackingRefreshEpoch,
      status: 'destroyed',
      ids: new Set(),
      source: _lastSource,
      coverage: _lastCoverage,
    };
    _resetTrackedSelectionState(); // next lifecycle re-evaluates against the ENTER ceiling
    _viewer = null;
  },

  /**
   * Live layer params.
   * `models3d` toggles 3D glTF model rendering for the FLEET (altitude-gated): when on,
   * surrounding aircraft become 3D models once the camera is zoomed in past MODEL_ALT_CEIL_M.
   * The TRACKED contact is NOT gated by this — it takes its 3D model by camera distance
   * regardless (see `_trackedModelRegimeActive` / trackedModelRegime.js).
   * `models3dMode` is 'proximity' (nearest MODEL_MAX in view) or 'all' (every in-view plane).
   * @param {{models3d?: boolean, models3dMode?: 'proximity'|'all', selectedFlightsTrackingId?: string|null}} params
   */
  setParams(params = {}, { origin = 'programmatic' } = {}) {
    if (isExplicitLayerStateOrigin(origin)
        && !Object.hasOwn(params, 'selectedFlightsTrackingId')) {
      _cancelPendingTrackingRestore();
    }
    if (typeof params.models3d === 'boolean' && params.models3d !== _models3dEnabled) {
      _models3dEnabled = params.models3d;
      if (!_models3dEnabled) {
        _releaseModels();
        _syncTracked2dRotation();
        // Restore fleet billboards (the horizon-cull pass re-asserts next tick), but NEVER the
        // tracked plane's own fleet billboard — its tracked entity is the visual, so re-showing it
        // here would double-image the tracked plane when 3D is turned off mid-track.
        if (_billboardCollection) for (const [icao, bb] of _billboards) { if (icao !== _trackedIcao) bb.show = true; }
      }
    }
    if ((params.models3dMode === 'proximity' || params.models3dMode === 'all') && params.models3dMode !== _models3dMode) {
      // The next fleet tick re-derives the eligible set under the new cap and releases the overflow.
      _models3dMode = params.models3dMode;
      if (_cockpitContactMode) {
        _refreshCockpitNearContacts();
        _lastFleetTickMs = 0;
      }
    }
    if (typeof params.irBoost === 'boolean' && params.irBoost !== _irBoost) {
      _irBoost = params.irBoost;
      _reloadModelsForIrBoost();
      // Sprites don't reload with the models — swap the TR-3B glyph between its
      // cold and thermal-reactive variants directly. Bounded by the operator's
      // own conversions, so this never touches the ordinary fleet.
      _refreshTr3bForStyle();
    }
    if (Object.hasOwn(params, 'selectedFlightsTrackingId')) {
      const requested = _normalizeTrackedIcao(params.selectedFlightsTrackingId);
      if (requested === _trackedIcao) {
        _pendingTrackingRestore = null;
      } else if (requested === null) {
        _cancelPendingTrackingRestore();
        if (_trackedIcao) _clearTracking(false, { origin });
      } else {
        const generation = ++_trackingIntentGeneration;
        _pendingTrackingRestore = { id: requested, generation, origin };
        if (_trackedIcao) _clearTracking(false, { origin });
        _applyPendingTrackingRestore();
      }
    }
    return true;
  },
  getParams() {
    return {
      models3d: _models3dEnabled,
      models3dMode: _models3dMode,
      irBoost: _irBoost,
      selectedFlightsTrackingId: _trackedIcao,
    };
  },

  /**
   * Re-render a contact whose TR-3B conversion just flipped (Easter egg).
   * Callers own the registry write; this only re-derives what renders.
   * @param {string} icao24 - ICAO 24-bit address.
   * @returns {boolean} True when this layer owns the contact.
   */
  refreshTr3b(icao24) { return _refreshTr3bContact(icao24); },

  /**
   * Return a subsample of currently visible aircraft for detection overlay
   * rendering (e.g. bounding boxes drawn on-screen by the CCTV detection layer).
   *
   * Uses a deterministic stride + seed to select a spatially distributed
   * subset without sorting or shuffling.
   *
   * @param {object}  [options]
   * @param {number}  [options.maxCount] - Maximum number of objects to return.
   * @param {number}  [options.seed]     - Deterministic offset into the stride pattern.
   * @returns {Array<{position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean}>}
   */
  getDetectableObjects(options = {}) {
    if (!_billboardCollection || !_billboardCollection.show) return [];
    // Compute a stride that evenly samples the billboard map.
    // seed shifts the starting offset so successive calls can sample
    // different aircraft without shuffling the underlying Map order.
    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : _billboards.size;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    const stride = Math.max(1, Math.ceil(_billboards.size / maxCount));
    const start = seed % stride;

    const result = [];
    let idx = 0;
    for (const [icao24, bb] of _billboards) {
      const shouldTake = ((idx - start) % stride) === 0;
      idx++;
      if (!shouldTake) continue;
      if (_cockpitContactMode && icao24.toLowerCase() === _cockpitSubjectId) continue;
      const isTracked = icao24 === _trackedIcao;
      // Keep planes rendered as a 3D model (billboard hidden) so the detection box
      // doesn't vanish on the 2D→3D handoff; bb.position stays current while hidden.
      const model = _models.get(icao24);
      const modelOwnsVisual = _modelOwnsVisual(icao24);
      if (!isTracked && !bb.show && !modelOwnsVisual) continue;
      const info = _flightData.get(icao24);
      let object = _detectionObjects.get(icao24);
      if (!object) {
        object = { sourceId: icao24, type: 'AIR', _weldPos: new Cesium.Cartesian3() };
        _detectionObjects.set(icao24, object);
      }
      // WELD: anchor to whatever actually owns the visual. A model-owned contact is
      // read straight off the translation the fleet tick already wrote into its
      // modelMatrix, so bracket and label sit on the aircraft you can see instead of
      // on the buried billboard position, which for a grounded plane is ~100 m below
      // and rises only as the coarse ground-floor cell warms. Zero extra sampling and
      // no `_modelDisplayPosition` call from postRender. Sprite-owned contacts keep
      // `bb.position` — sprite and bracket are co-located there, so association holds.
      const spec = modelOwnsVisual ? _modelSpec(info?.klass) : null;
      const pos = isTracked
        ? (_trackedVisualCached() || bb.position)
        : (modelOwnsVisual
          ? modelVisualAnchor(
            model.modelMatrix,
            spec.visualCenterNative,
            Number.isFinite(model.computedScale) ? model.computedScale : spec.scale,
            object._weldPos || (object._weldPos = new Cesium.Cartesian3()),
          )
          : bb.position);
      if (!pos) continue;
      object.position = pos;
      object.skipLabel = isTracked;
      // Card text only — declutter/cohort identity is `object.sourceId` (icao24).
      const id = _contactLabel(icao24, info);
      if (object.id !== id) object.id = id;
      const altitude = info?.altitude;
      if (object._altitude !== altitude) {
        object._altitude = altitude;
        object.metric = formatFlightLevel(altitude); // altitude is metres
      }
      result.push(object);
      if (result.length >= maxCount) break;
    }
    if (_detectionObjects.size > _billboards.size + 512) {
      for (const icao24 of _detectionObjects.keys()) {
        if (!_billboards.has(icao24)) _detectionObjects.delete(icao24);
      }
    }
    return result;
  },

  /**
   * Find a single aircraft by free-text query.
   * Match priority: exact icao24 hex, exact callsign, callsign prefix,
   * then callsign substring (all case-insensitive, trimmed).
   * @param {string} query - ICAO24 hex or full/partial callsign.
   * @returns {{icao24: string, callsign: string|null, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number, velocityMps: number|null, track: number|null}|null}
   *   Best match with a cloned, dead-reckoned position, or null if none.
   */
  findByQuery(query) {
    if (!_flightData || _flightData.size === 0) return null;
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;

    // Registration is searched alongside callsign because it is what the
    // operator SEES: a callsign-less contact reads as its tail number on the
    // card, in the analyst's answer, and in the Contacts list. Matching only
    // callsigns meant "follow 6606" — and the analyst → track_entity handoff
    // the tool instructions prescribe — answered "nothing matched" for the
    // very identity the app had just shown. Ranking is shared with the
    // military layer (contactMatch.js) so the two cannot disagree, and it is
    // strictly tiered so a registration can never out-rank a real callsign on
    // feed order alone.
    let best = null;
    for (const [icao24, info] of _flightData) {
      const candidate = {
        tier: rankContactMatch({
          query: q,
          hex: icao24,
          callsign: info?.callsign,
          registration: info?.registration,
        }),
        id: icao24,
      };
      if (!contactMatchWins(candidate, best)) continue;
      best = candidate;
      if (candidate.tier === CONTACT_MATCH_TIER.HEX_EXACT) break;
    }
    return best ? _describeFlight(best.id) : null;
  },

  /**
   * Find aircraft near a given ECEF position, sorted ascending by distance.
   * Return shape mirrors militaryFlightsLayer.getNearby (id/icao24/position/distance).
   * @param {Cesium.Cartesian3} center - Reference position in ECEF coordinates.
   * @param {number} range - Maximum distance in meters (Infinity if not finite).
   * @param {number} [maxCount=50] - Maximum number of results to return.
   * @param {object} [options] Query membership options.
   * @param {boolean} [options.includeHidden=false] Include loaded horizon-hidden aircraft.
   * @returns {Array<{id: string, icao24: string, callsign: string|null, position: Cesium.Cartesian3, distance: number, aircraftClass: string|null, altitudeM: number|null, velocityMps: number|null, track: number|null}>}
   */
  getNearby(center, range, maxCount = 50, { includeHidden = false } = {}) {
    if (!center || !_billboardCollection || !_billboardCollection.show) return [];

    const limit = Number.isFinite(maxCount)
      ? Math.max(1, Math.floor(maxCount))
      : 50;
    const maxRange = Number.isFinite(range) && range > 0 ? range : Number.POSITIVE_INFINITY;

    const now = Cesium.JulianDate.now();
    const nearby = [];

    for (const [icao24, bb] of _billboards) {
      const isTracked = icao24 === _trackedIcao;
      // Keep planes rendered as a 3D model (billboard hidden) so proximity counts
      // don't drop to zero on the 2D→3D handoff; bb.position stays current while hidden.
      if (!aircraftIncludedInNearby({
        isTracked,
        billboardShown: bb.show,
        modelRendering: _modelOwnsVisual(icao24),
        includeHidden,
      })) continue;

      const trackedPos = isTracked ? _trackedDisplayCached() : null; // cached, no recompute (anti-jitter)
      const pos = trackedPos || bb.position;
      if (!pos) continue;

      const distance = Cesium.Cartesian3.distance(center, pos);
      if (distance > maxRange) continue;

      const info = _flightData.get(icao24);
      const callsign = info?.callsign?.trim() || null;
      nearby.push({
        // Label. Callers that need identity read `icao24` (Context cohorts do).
        id: _contactLabel(icao24, info),
        icao24,
        callsign,
        position: pos,
        distance,
        // Filter surface: the cockpit next/previous path matches on THIS field
        // (militaryAwareness.aircraftClassMatchesFilter), so a converted contact
        // has to report the class it renders as or a `tr3b` filter skips it.
        aircraftClass: tr3bAircraftClass(icao24, String(info?.klass || '').trim().toLowerCase() || null),
        altitudeM: info?.altitude ?? null,
        velocityMps: info?.velocity ?? null,
        track: info?.true_track ?? null,
      });
    }

    nearby.sort((a, b) => a.distance - b.distance);
    return nearby.slice(0, limit);
  },

  /**
   * Return id/label/position for up to maxCount currently rendered aircraft.
   * Cheap snapshot for voice-tool framing — billboard positions only, no
   * dead reckoning and no cloning.
   * @param {number} [maxCount=500] - Maximum number of entries to return.
   * @returns {Array<{id: string, label: string, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number}>}
   */
  /**
   * Whether this layer still carries a contact, in O(1).
   *
   * Presence consumers must not infer absence from `getAllPositions`: it stops
   * at its cap, and this layer routinely carries ~11k contacts against a
   * 1,000-row cap, so "not in the returned rows" is not "gone". Id matching
   * mirrors trackById: exact key first, then lowercase.
   * A disabled layer keeps its records but hides the collection, so it must
   * decline rather than answer from data the user can no longer see —
   * otherwise a preserved subject reads as fresh off stale hidden state.
   * @param {string} icao24 Contact identifier.
   * @returns {boolean|null} Presence, or null when the layer is disabled or
   *   holds no data and therefore cannot answer.
   */
  hasContact(icao24) {
    if (!_billboardCollection || !_billboardCollection.show || _billboards.size === 0) return null;
    if (!icao24) return false;
    const id = String(icao24).trim();
    return _billboards.has(id) || _billboards.has(id.toLowerCase());
  },

  getAllPositions(maxCount = 500) {
    if (!_billboardCollection || _billboards.size === 0) return [];
    const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 500;

    const result = [];
    for (const [icao24, bb] of _billboards) {
      const pos = bb.position;
      if (!pos) continue;
      const carto = Cesium.Cartographic.fromCartesian(pos, Cesium.Ellipsoid.WGS84, _scratchCarto);
      if (!carto) continue;
      const info = _flightData.get(icao24);
      result.push({
        id: icao24, // identity (trackById resolves this)
        label: _contactLabel(icao24, info),
        position: pos,
        latitude: Cesium.Math.toDegrees(carto.latitude),
        longitude: Cesium.Math.toDegrees(carto.longitude),
        altitudeM: carto.height,
        airline: info?.airline ?? null,
        typeName: info?.typeName ?? null,
        typeCode: info?.typeCode ?? null,
        registration: info?.registration ?? null,
        origin: info?.route && _routeIsPlausible(icao24, info.route) ? info.route.origin.code : null,
        destination: info?.route && _routeIsPlausible(icao24, info.route) ? info.route.destination.code : null,
      });
      if (result.length >= limit) break;
    }
    return result;
  },

  /**
   * Snapshot the layer's in-memory records as plain JSON-safe objects for
   * the analyst query engine. On-demand only (called at most once per
   * spoken query) — zero per-frame cost, no listeners, no caching, no
   * enrichment fetches (cached adsbdb values only). Returns [] while the
   * layer is disabled or empty.
   * @param {number} [maxCount=2000] - Maximum records to return (truncation).
   * @returns {Array<Object>} See mapAnalystRecord for the record shape.
   */
  getAnalystRecords(maxCount = 2000) {
    if (!_billboardCollection || !_billboardCollection.show || _flightData.size === 0) return [];
    const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
    const result = [];
    for (const [icao24, info] of _flightData) {
      const routeOk = !!info?.route && _routeIsPlausible(icao24, info.route);
      result.push(mapAnalystRecord(icao24, info, { military: isMilitaryIcao(icao24), routeOk }));
      if (result.length >= limit) break;
    }
    return result;
  },

  /**
   * Start camera-tracking an aircraft by ICAO24 address.
   * @param {string} icao24 - ICAO 24-bit transponder address.
   * @returns {boolean} True if the aircraft exists and tracking started.
   */
  trackById(icao24, { origin = 'programmatic' } = {}) {
    if (!icao24) return false;
    let id = String(icao24).trim();
    if (!_billboards.has(id)) id = id.toLowerCase();
    if (!_billboards.has(id)) return false;
    if (_isExplicitTrackingOrigin(origin)) _cancelPendingTrackingRestore();
    if (_trackedIcao === id) return _publishTrackedSelection(id, origin);
    _trackFlight(id, { origin });
    return true;
  },

  /** Resolve a shared Follow target only against the latest accepted refresh. */
  async resolveTrackingRestoreTarget(icao24, { signal = null, origin = 'share-restore' } = {}) {
    if (signal?.aborted) return { status: 'cancelled', reason: String(signal.reason || 'aborted') };
    const id = _normalizeTrackedIcao(icao24);
    if (!id) return { status: 'missing', reason: 'invalid-target' };
    const outcome = _lastTrackingRefreshOutcome;
    if (outcome.status !== 'accepted') {
      return {
        status: 'source-unavailable',
        reason: 'OpenSky snapshot unavailable',
        refreshEpoch: outcome.epoch,
        source: outcome.source,
        coverage: outcome.coverage,
      };
    }
    if (!outcome.ids.has(id)) {
      return {
        status: 'missing',
        reason: 'target-absent-from-snapshot',
        refreshEpoch: outcome.epoch,
        source: outcome.source,
        coverage: outcome.coverage,
      };
    }
    if (signal?.aborted) return { status: 'cancelled', reason: String(signal.reason || 'aborted') };
    const followed = this.trackById(id, { origin });
    return followed
      ? {
          status: 'found',
          refreshEpoch: outcome.epoch,
          source: outcome.source,
          coverage: outcome.coverage,
        }
      : { status: 'source-unavailable', reason: 'target-not-renderable', refreshEpoch: outcome.epoch };
  },

  /** Reapply the canonical follow frame without recreating the selected flight. */
  refocusTrackedById(icao24, { origin = 'programmatic' } = {}) {
    if (!icao24 || _cockpitContactMode || !_viewer || !_trackedEntity) return false;
    let id = String(icao24).trim();
    if (!_billboards.has(id)) id = id.toLowerCase();
    if (
      id !== _trackedIcao
      || !_viewer.entities?.contains?.(_trackedEntity)
      || _viewer.trackedEntity !== _trackedEntity
    ) return false;
    _trackedCameraFrameStop?.();
    _viewer.camera.cancelFlight();
    _viewer.trackedEntity = _trackedEntity;
    _trackedCameraFrameStop = applyTrackedCameraFrame(
      _viewer,
      _trackedEntity,
      _trackedEntity.viewFrom,
    ) || null;
    _publishTrackedSelection(id, origin);
    return true;
  },

  /**
   * Stop tracking the currently followed aircraft (no-op if none).
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
   * Describe the currently tracked aircraft at its dead-reckoned position.
   * @returns {{icao24: string, callsign: string|null, latitude: number, longitude: number, altitudeM: number, velocityMps: number|null, track: number|null}|null}
   *   Tracked aircraft info, or null when nothing is tracked.
   */
  getTrackedInfo() {
    if (!_trackedIcao) return null;
    const described = _describeFlight(_trackedIcao);
    if (!described) return null;
    const { position, ...rest } = described;
    return rest;
  },

  /**
   * Return the current aircraft as a Context subject without changing
   * tracking or camera ownership.
   * @returns {{layerId: string, id: string, label: string, position: Cesium.Cartesian3}|null}
   *   Detached subject descriptor, or null when no aircraft is tracked.
   */
  getTrackedSubject() {
    if (!_trackedIcao) return null;
    const described = _describeFlight(_trackedIcao);
    if (!described?.position) return null;
    return {
      layerId: 'flights',
      id: described.icao24,
      // Same label chain as getNearby/getDetectableObjects: a callsign-less
      // contact reads as its registration, never as the raw ICAO hex.
      label: described.callsign
        || _toCleanText(described.registration)
        || described.icao24,
      position: Cesium.Cartesian3.clone(described.position),
    };
  },

  ...(FOCUS_EVIDENCE_DEV ? {
    __focusEvidence: Object.freeze({
      setAircraft: _setFocusEvidenceAircraft,
      moveAircraft: _moveFocusEvidenceAircraft,
      snapshot: _focusEvidenceSnapshot,
      setTuning({ focus = {}, horizon = {} } = {}) {
        return {
          focus: setFocusDeemphasisParams(focus),
          horizon: setAircraftRecessionParams(horizon),
        };
      },
      getTuning() {
        return {
          focus: { ...getFocusDeemphasisParams() },
          horizon: { ...getAircraftRecessionParams() },
        };
      },
      takeFrameClock(startMs = 1_000_000_000) {
        if (!_viewer || !Number.isFinite(startMs)) return { ok: false, nowMs: null };
        _viewer.useDefaultRenderLoop = false;
        setFocusEvidenceNowMs(startMs);
        _lastFleetTickMs = startMs - FLEET_DR_INTERVAL_MS;
        // Cross a browser task boundary, then close Cesium's pending-loop
        // latch. Any already-queued callback still observes the false gate,
        // while manual evidence renders can begin without waiting on VSYNC.
        return new Promise((resolve) => setTimeout(() => {
          if (_viewer?._cesiumWidget) _viewer._cesiumWidget._renderLoopRunning = false;
          resolve({ ok: true, nowMs: startMs });
        }, 0));
      },
      advanceFrameClock(deltaMs = FLEET_DR_INTERVAL_MS) {
        return advanceFocusEvidenceNowMs(deltaMs);
      },
      releaseFrameClock() {
        setFocusEvidenceNowMs(null);
        if (_viewer) _viewer.useDefaultRenderLoop = true;
      },
    }),
  } : {}),

  /**
   * Return layer health/status for the HUD stats chip.
   * @returns {{count: number, lastUpdate: number|null, stale: boolean, error: string|null, status: number|null, retryInSec: number}}
   */
  getStats() {
    const retryInSec = _retryAt ? Math.max(0, Math.ceil((_retryAt - Date.now()) / 1000)) : 0;
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      stale: _backoff,
      error: _lastError,
      status: _lastStatus,
      retryInSec,
      source: _lastSource,
      coverage: _lastCoverage,
    };
  },
};

/**
 * Global keydown handler — Escape deselects the tracked flight.
 * @param {KeyboardEvent} e
 */
function _onKeyDown(e) {
  if (e.key === 'Escape' && _trackedIcao) {
    _cancelPendingTrackingRestore();
    _clearTracking(false, { origin: 'user' });
  }
}

/**
 * Install a LEFT_CLICK handler on the scene canvas for flight selection.
 *
 * Picking logic checks both `picked.primitive` and `picked.id` because
 * different CesiumJS versions surface BillboardCollection hits differently.
 * Also registers a global keydown listener for the Escape key.
 *
 * Idempotent — returns immediately if a handler is already installed.
 *
 * @param {Cesium.Viewer} viewer
 */
function _installClickHandler(viewer) {
  if (_clickHandler) return; // already installed

  // Cross-layer untrack: if ANOTHER layer (military, vessels, …) grabs the follow-camera, drop our
  // tracking so its model/entity/update-loop don't orphan — without touching viewer.trackedEntity
  // (the new owner controls it). Guarded so the intermediate untrack→retrack of OUR OWN switch
  // (viewer.trackedEntity briefly undefined) doesn't self-clear.
  if (!_trackedEntityChangedRemove) {
    _trackedEntityChangedRemove = viewer.trackedEntityChanged.addEventListener(() => {
      if (_trackedIcao && _viewer && _viewer.trackedEntity && _viewer.trackedEntity !== _trackedEntity) {
        _clearTracking(true, {
          origin: _viewer.trackedEntity?.gevSelectionOrigin || 'programmatic',
        });
      }
    });
  }

  _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  bindTrackingClickGesture(_clickHandler, (click, gesture) => {
    // Camera drags never select or deselect, even if they finish over a plane.
    // Duration alone is allowed through so a stationary long press can still
    // select/switch contacts; the destructive empty-space branch below applies
    // the full travel + duration click classifier.
    if (!isTrackingSelectionGesture(gesture)) return;
    // Cockpit mode owns the camera and keeps the current aircraft as its
    // first-person reference. A globe click must not fall through to the
    // normal empty-space deselection path; cockpit has explicit exit controls.
    if (document.body.classList.contains('cockpit-mode')) return;
    const picked = viewer.scene.pick(click.position);

    if (picked) {
      // Clicking the tracked entity itself — ignore (don't deselect)
      if (picked.id === _trackedEntity) return;

      // Clicking the plane we're ALREADY tracking (its standalone 3D model or
      // any pick carrying its icao) — same no-op as the 2D tracked-entity click
      // above. H1: the model used to have no pick id, so this fell through to
      // "empty space" and deselected the very plane being tracked.
      if (_trackedIcao) {
        const rawPick = typeof picked.id === 'string' ? picked.id : picked.primitive?.id;
        if (picked.primitive === _trackedModel || rawPick === _trackedIcao) return;
      }

      // For BillboardCollection picks, the billboard may be at picked.primitive or picked.id
      const billboard = picked.primitive;
      if (billboard && billboard.id && _billboards.has(billboard.id)) {
        _cancelPendingTrackingRestore();
        _trackFlight(billboard.id, { origin: 'user' });
        return;
      }
      // Some CesiumJS versions surface the id as a string on picked.id instead
      if (picked.id && typeof picked.id === 'string' && _billboards.has(picked.id)) {
        _cancelPendingTrackingRestore();
        _trackFlight(picked.id, { origin: 'user' });
        return;
      }
    }

    // A pick that belongs to a sibling layer (military aircraft, satellite,
    // vessel, station, CCTV camera…) is not "empty space" — leave tracking
    // alone and let that layer handle it. resolvePickId String()-coerces the
    // heterogeneous pick ids (numeric NORAD ids, AIS record objects) so the
    // registry predicates can recognize them (H2).
    if (picked) {
      const pickedId = resolvePickId(picked);
      if (pickedId && isOwnedByOtherLayer('flights', pickedId)) return;
    }

    // Clicked empty space — deselect only for a clean, short click. A slow
    // stationary press may select above, but cannot release existing tracking.
    if (!isTrackingClickGesture(gesture)) return;
    if (_trackedIcao) {
      _cancelPendingTrackingRestore();
      _clearTracking(false, { origin: 'user' });
    }
  });

  document.addEventListener('keydown', _onKeyDown);
}

export default flightsLayer;
