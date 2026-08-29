/**
 * @module cctv
 *
 * CCTV camera data layer for God's Eye View.
 *
 * Architecture:
 * - Camera catalog: built from seed definitions (CAMERA_SEEDS) merged with live
 *   sources fetched from the backend (/api/cctv/sources). Each camera record
 *   holds a base pose, a calibration offset, computed intrinsics/extrinsics,
 *   and an anchor position on the globe.
 *
 * - Coverage geometry (v2): a true pitched frustum pyramid per camera — 4
 *   corner rays from the mount to the far-plane corners plus the closed
 *   far-plane rectangle (5 polylines), rendered as Cesium entities with
 *   neighbor-limited visibility. All geometry is pure pose math
 *   (computeFrustumGeometry) — zero steady-state scene queries.
 *
 * - Monitor plane (v2): the live frame renders on a plane entity capping the
 *   far end of the frustum ("monitor at the end of the cone"), oriented
 *   perpendicular to the view axis (static — never billboarded). Video feeds
 *   bind the HTMLVideoElement directly (Cesium updates video textures
 *   per-frame); image feeds alternate two offscreen canvases so the texture
 *   re-uploads on every repaint tick (<=1Hz). One live plane at a time. On
 *   activation a single scene.pickFromRay obstruction probe (§9.1 — the ONLY
 *   raycast in the subsystem) clamps the plane's range short of the first
 *   tile hit so the end cap never clips into buildings.
 *
 * - Ambient card tier (2026-07-29 design): the LOD-selected nearby static
 *   cameras (cctvLod.js — zoom-scaled 16/24/32 budget, eviction grace)
 *   additionally get a screen-space thumbnail card (cctvCards.js) showing
 *   their latest paced static frame. Reselection is camera.moveEnd-driven
 *   (never per frame); frame fetches go through a global 1-per-second gate;
 *   camera icons stay visible at every zoom (cards annotate, never replace).
 *   The active camera keeps the monitor plane and is excluded from the card
 *   ring by default. An opt-in presentation option can also publish its
 *   protected thumbnail without changing the ambient quota.
 *
 * - Health sync: periodic fetch of /api/cctv/health to update per-camera
 *   source status shown in the UI.
 *
 * - Auto-hop: timed camera cycling with view-context awareness (snaps to
 *   nearest camera when the viewer pans to a new region).
 *
 * All mutable state is module-scoped. The exported `cctvLayer` object
 * implements the standard layer interface (init/enable/disable/update/destroy)
 * plus CCTV-specific methods (selectCamera, cycleCamera, focusNearest, etc.).
 */
import * as Cesium from 'cesium';
import { registerSpriteCollection, restoreSpriteOrder } from './spriteOrder.js';
import {
  CCTV_ACTIVATION_RESULT,
  activateCctvCameraFromWorldClick,
} from '../cctvFocusRequest.js';
import { bindTrackingClickGesture, isTrackingClickGesture } from './trackingClickGesture.js';
import {
  clearOverlaySource,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { CITY_POIS } from '../locations.js';
import {
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from './pickRegistry.js';
import { resolveEllipsoidalGround } from './terrainHeights.js';
import { cachedGroundFloor, resolveGroundFloorCells, warmGroundFloor } from './groundFloor.js';
import { sampleMeshFloorCells } from './meshFloorSampler.js';
import { horizonOccluder } from './iconOrientation.js';
import { cameraHue, viewshedColors, createFrustumVolumePrimitive } from './cctvViewshed.js';
import { createCalibrationGizmo, GIZMO_ID_PREFIX } from './cctvGizmo.js';
import {
  CCTV_AMBIENT_CARD_MAX,
  applyEvictionGrace,
  selectCctvLod,
  staticFrameRefreshMs,
} from './cctvLod.js';
import {
  CCTV_CARD_FETCH_BURST_LIMIT,
  CCTV_CARD_FETCH_BURST_SPACING_MS,
  CCTV_FRAME_CANVAS_W,
  CCTV_FRAME_CANVAS_H,
  applyFrameResult,
  cardFetchPolicy,
  createCctvThumbnailOverlayEntry,
  createFrameSlot,
  declutterCctvCards,
  CCTV_OVERLAY_SOURCE_ID,
  planFrameCachePrune,
  frameFetchDue,
} from './cctvCards.js';
import {
  advanceSpriteFocus,
  focusAlphaNeedsWrite,
  focusNowMs,
  focusPassIsNeeded,
  getFocusTarget,
  onFocusTargetAppear,
} from './focusDeemphasis.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------
const FRAME_ENDPOINT = '/api/gev/cctv/frame';
const SOURCE_ENDPOINT = '/api/gev/cctv/sources';
const HEALTH_ENDPOINT = '/api/gev/cctv/health';
const MEDIA_ENDPOINT = '/api/gev/cctv/media';

// ---------------------------------------------------------------------------
// Timing and geometry constants
// ---------------------------------------------------------------------------
const DEFAULT_UPDATE_INTERVAL_MS = 10000;
const MIN_AUTO_HOP_SEC = 8;
const MAX_AUTO_HOP_SEC = 90;
const HEALTH_SYNC_INTERVAL_MS = 7000;
const ACTIVE_FRAME_REFRESH_MS = 10000;
const IDLE_FRAME_REFRESH_MS = 60000;
const PROJECTION_ACTIVE_REFRESH_MS = 10000;
const PROJECTION_IDLE_REFRESH_MS = 60000;
const PROJECTION_CANVAS_WIDTH = 1920;
const PROJECTION_CANVAS_HEIGHT = 1080;
// Downsample grid for the unchanged-frame signature (drawProjectionFrame).
// 64x36 keeps the 16:9 aspect and reads ~9 KB per check versus the 8.3 MB a
// full-resolution compare would touch.
const FRAME_SIGNATURE_W = 64;
const FRAME_SIGNATURE_H = 36;
const COVERAGE_NEIGHBOR_LIMIT = 14;
const COVERAGE_NEIGHBOR_RADIUS_KM = 1.8;
// Staggered geometry/frame loading: ground-sampled coverage geometry is
// refined in small batches (active camera first, then nearest-to-viewer) so
// enabling the layer never raycasts every camera in a single frame.
const GEO_LOAD_BATCH_SIZE = 4;
const GEO_LOAD_BATCH_DELAY_MS = 120;
const GEO_TRACKING_BATCH_SIZE = 2;
const GEO_TRACKING_BATCH_DELAY_MS = 250;
const GEO_PROGRESS_NOTIFY_INTERVAL_MS = 300;
const GEO_PROGRESS_NOTIFY_BATCH_LIMIT = 10;
// Throttle for placeholder repaints — the projection RAF loop must not
// re-fill a 1080p canvas on every frame while a feed image is still loading.
const PLACEHOLDER_REPAINT_MS = 750;
// v1 key is retired dead data (product rule #3, §9.3 — WIPE CLEAN, no
// legacy import): kept here only as a documented constant so nothing ever
// re-reads it by accident. Exported for the unit suite's "v1 is ignored"
// assertion; there is NO read path for this key anywhere in the module.
export const CCTV_CALIBRATION_STORAGE_KEY_V1 = 'godsEyeView.cctv.calibration.v1';
/** v2 store key. Entries: { values: <7-field calibration offsets>, source: 'manual', savedAt: <epoch ms> }. */
export const CCTV_CALIBRATION_STORAGE_KEY_V2 = 'godsEyeView.cctv.calibration.v2';
// H5: throttle for double-buffered canvas texture swaps (<=1Hz; each swap is a
// full 1080p texture re-upload because Cesium re-uploads only on a NEW image
// object reference).
const PROJECTION_TEXTURE_SWAP_MS = 1000;
const PROJECTION_VERT_ASPECT = PROJECTION_CANVAS_WIDTH / PROJECTION_CANVAS_HEIGHT;
// V2 frustum geometry (design §2a/§6): the far-cap center + corners never sink
// below groundAlt + this clearance, so a fabricated pitch (-24°) cannot bury
// the monitor plane in the 3D tiles. Exported for the unit suite.
export const FRUSTUM_GROUND_CLEARANCE_M = 2;
/** Public result codes for explicit CCTV camera flights. */
export const CCTV_FOCUS_RESULT = Object.freeze({
  FOCUSED: 'focused',
  NO_ACTIVE_CAMERA: 'no-active-camera',
  TRACKING_HOLDS_VIEW: 'tracking-holds-view',
  COCKPIT_ACTIVE: 'cockpit-active',
});
// §9.1 activation obstruction probe: clamp the plane's effective range to just
// short of the first pickFromRay hit along the frustum axis, with a floor so a
// point-blank obstruction never collapses the frustum to zero. The floor is
// the old H6 monitor's 8-15 m distance band: small enough that a pitched-down
// camera whose axis meets the street ~25 m out still clamps SHORT of the hit
// (a larger floor would push the plane back through the obstruction).
const PROBE_CLEARANCE_M = 4;
const PROBE_MIN_RANGE_M = 12;
// Bounded wait for the enable-time ground-prior batch: warm proxy disk cache
// resolves in milliseconds; a cold/slow upstream must never hang layer init,
// so past this budget init proceeds on catalog fallbacks and the batch applies
// post-hoc (applyLateGroundPriors) when it lands.
const GROUND_PRIOR_INIT_WAIT_MS = 8000;
/** Default calibration offsets — all zeroed, range scale 1x. */
const DEFAULT_CAMERA_CALIBRATION = Object.freeze({
  offsetNorthM: 0,
  offsetEastM: 0,
  headingDeg: 0,
  pitchDeg: 0,
  fovDeg: 0,
  rangeScale: 1,
  heightM: 0,
});

/**
 * Returns whether a calibration patch moves the camera's ground anchor.
 * Rotational, optical, range, and manual-height edits preserve the existing
 * ground reference; only north/east translation needs a new floor.
 * @param {Object|null|undefined} patch
 * @returns {boolean}
 */
export function calibrationPatchMovesAnchor(patch) {
  if (!patch || typeof patch !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(patch, 'offsetNorthM') ||
    Object.prototype.hasOwnProperty.call(patch, 'offsetEastM');
}

/** Base64-encoded SVG camera icon for billboard rendering. */
const CAMERA_ICON = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    <defs>
      <linearGradient id="lens" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#c9f6ff"/>
        <stop offset="45%" stop-color="#6fd9ff"/>
        <stop offset="100%" stop-color="#1a5f78"/>
      </linearGradient>
    </defs>
    <g transform="translate(4 6)">
      <rect x="0" y="8" width="20" height="9" rx="2.5" fill="#0e1720" stroke="#75e7ff" stroke-width="1.2"/>
      <rect x="17" y="10" width="10" height="5" rx="1.5" fill="#132433" stroke="#75e7ff" stroke-width="1"/>
      <circle cx="24" cy="12.5" r="3.1" fill="url(#lens)" stroke="#dbfbff" stroke-width="0.8"/>
      <rect x="6.4" y="17" width="4.2" height="8.5" rx="1.2" fill="#10212d" stroke="#75e7ff" stroke-width="1"/>
      <rect x="4.2" y="24" width="8.6" height="2.5" rx="1.1" fill="#0b151d" stroke="#4ecde7" stroke-width="0.8"/>
    </g>
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
})();

/**
 * Seed camera definitions used when no live sources are available.
 * Each seed references a city from CITY_POIS and a POI index within that city,
 * plus offsets to place the camera near the POI.
 */
const CAMERA_SEEDS = [
  { id: 'nyc-midtown-w', cityId: 'nyc', poiIndex: 1, label: 'Midtown West @ 34th', offsetNorthM: 120, offsetEastM: -70, headingDeg: 206, fovDeg: 74, rangeM: 880, elevationM: 26 },
  { id: 'nyc-wtc-n', cityId: 'nyc', poiIndex: 2, label: 'WTC North Plaza', offsetNorthM: 95, offsetEastM: 34, headingDeg: 164, fovDeg: 68, rangeM: 760, elevationM: 32 },
  { id: 'nyc-times-square-ne', cityId: 'nyc', poiIndex: 1, label: 'Times Sq Northeast', offsetNorthM: 230, offsetEastM: 120, headingDeg: 218, fovDeg: 66, rangeM: 640, elevationM: 24 },

  { id: 'sf-market-5th', cityId: 'sf', poiIndex: 2, label: 'Market & 5th', offsetNorthM: -160, offsetEastM: 80, headingDeg: 320, fovDeg: 70, rangeM: 780, elevationM: 20 },
  { id: 'sf-financial-district', cityId: 'sf', poiIndex: 1, label: 'SF Financial Core', offsetNorthM: 110, offsetEastM: 52, headingDeg: 205, fovDeg: 72, rangeM: 760, elevationM: 24 },

  { id: 'tokyo-shibuya-scramble', cityId: 'tokyo', poiIndex: 4, label: 'Shibuya Crossing', offsetNorthM: 180, offsetEastM: 46, headingDeg: 18, fovDeg: 82, rangeM: 640, elevationM: 30 },
  { id: 'tokyo-ginza-core', cityId: 'tokyo', poiIndex: 0, label: 'Ginza Core', offsetNorthM: -180, offsetEastM: 150, headingDeg: 245, fovDeg: 70, rangeM: 690, elevationM: 28 },
  { id: 'tokyo-asakusa-n', cityId: 'tokyo', poiIndex: 3, label: 'Asakusa North Gate', offsetNorthM: 110, offsetEastM: -65, headingDeg: 192, fovDeg: 68, rangeM: 620, elevationM: 24 },

  { id: 'london-city-a1', cityId: 'london', poiIndex: 4, label: 'City Cluster A1', offsetNorthM: 80, offsetEastM: 65, headingDeg: 220, fovDeg: 71, rangeM: 720, elevationM: 27 },
  { id: 'london-soho-core', cityId: 'london', poiIndex: 2, label: 'Soho Core', offsetNorthM: 210, offsetEastM: 120, headingDeg: 206, fovDeg: 70, rangeM: 700, elevationM: 22 },

  { id: 'paris-rivoli', cityId: 'paris', poiIndex: 4, label: 'Rue de Rivoli', offsetNorthM: 55, offsetEastM: 85, headingDeg: 248, fovDeg: 66, rangeM: 640, elevationM: 22 },
  { id: 'paris-champs-n', cityId: 'paris', poiIndex: 1, label: 'Champs-Élysées North', offsetNorthM: 130, offsetEastM: -38, headingDeg: 175, fovDeg: 68, rangeM: 700, elevationM: 26 },

  { id: 'dc-mall-center', cityId: 'dc', poiIndex: 1, label: 'National Mall Center', offsetNorthM: 120, offsetEastM: 20, headingDeg: 258, fovDeg: 78, rangeM: 940, elevationM: 24 },
  { id: 'dc-pentagon-s', cityId: 'dc', poiIndex: 3, label: 'Pentagon South', offsetNorthM: -100, offsetEastM: 92, headingDeg: 14, fovDeg: 66, rangeM: 620, elevationM: 21 },

  { id: 'dubai-difc-loop', cityId: 'dubai', poiIndex: 4, label: 'DIFC Loop', offsetNorthM: 92, offsetEastM: -45, headingDeg: 196, fovDeg: 70, rangeM: 720, elevationM: 26 },
  { id: 'dubai-downtown-east', cityId: 'dubai', poiIndex: 0, label: 'Downtown East', offsetNorthM: -130, offsetEastM: 190, headingDeg: 322, fovDeg: 72, rangeM: 760, elevationM: 28 },

  { id: 'austin-congress-s', cityId: 'austin', poiIndex: 0, label: 'Congress Southbound', offsetNorthM: -165, offsetEastM: 40, headingDeg: 12, fovDeg: 74, rangeM: 760, elevationM: 24 },
  { id: 'austin-downtown-west', cityId: 'austin', poiIndex: 1, label: 'Downtown West', offsetNorthM: -120, offsetEastM: -160, headingDeg: 120, fovDeg: 69, rangeM: 700, elevationM: 20 },
];

// ---------------------------------------------------------------------------
// Visual style constants
// ---------------------------------------------------------------------------
const IDLE_CAMERA_COLOR = Cesium.Color.fromCssColorString('#6be8ff').withAlpha(0.88);
const ACTIVE_CAMERA_COLOR = Cesium.Color.fromCssColorString('#ffd97a').withAlpha(0.95);
const IDLE_COVERAGE_COLOR = Cesium.Color.fromCssColorString('#2fe0ff').withAlpha(0.24);
const IDLE_COVERAGE_CENTER_MUTED = Cesium.Color.fromCssColorString('#2fe0ff').withAlpha(0.2);
const IDLE_COVERAGE_EDGE_MUTED = Cesium.Color.fromCssColorString('#2fe0ff').withAlpha(0.18);
const ACTIVE_COVERAGE_EDGE = Cesium.Color.fromCssColorString('#8dff87').withAlpha(0.58);
const ACTIVE_COVERAGE_CENTER = Cesium.Color.fromCssColorString('#d7ff8d').withAlpha(0.82);
// H6: dimmer depth-fail materials let the active frustum wireframe read
// through buildings while in monitor fallback mode.
const ACTIVE_COVERAGE_EDGE_DEPTHFAIL = Cesium.Color.fromCssColorString('#8dff87').withAlpha(0.18);
const ACTIVE_COVERAGE_CENTER_DEPTHFAIL = Cesium.Color.fromCssColorString('#d7ff8d').withAlpha(0.26);
const PLANE_OUTLINE_COLOR = Cesium.Color.fromCssColorString('#6be8ff').withAlpha(0.55);

// ---------------------------------------------------------------------------
// Module-scoped mutable state
// ---------------------------------------------------------------------------
let _viewer = null;
let _billboards = null;
let _records = [];
let _recordById = new Map();
let _coverageEntities = [];
let _projectionEntities = [];
let _enabled = false;
let _activeCameraId = null;
let _coverageMode = 'on'; // 'off' | 'on' (wireframes) | 'viewshed' (color-coded volumes)
let _showProjection = true;
let _autoHop = false;
// An explicit empty-space deselect keeps AUTO HOP configured but prevents its
// timer from silently choosing a replacement. A later explicit activation or
// AUTO HOP toggle-on releases the hold.
let _autoHopSuspended = false;
let _autoHopSec = 18;
let _lastHopAt = 0;
let _lastViewContext = '';
let _clickHandler = null;
let _count = 0;
let _lastUpdate = null;
let _lastHealthSyncAt = 0;
let _lastError = null;
let _healthById = new Map();
let _calibrationById = new Map();
let _listeners = new Set();
let _projectionRaf = 0;
let _removeFocusAppearListener = null;
let _lastFocusStyleAt = 0;
/** Icons whose animated emphasis remains outside the 1.0 deadband. */
let _activeFocusStyleCount = 0;
const _scratchFocusScreen = new Cesium.Cartesian2();
// Staggered geometry-load queue state (see startGeometryLoadQueue).
let _geoQueue = [];
let _geoQueueTimer = 0;
let _geoLoading = false;
let _geoLoadTotal = 0;
let _geoLoadDone = 0;
let _geoProgressNotifier = null;
// One-shot completion latch for shared floor resolution: the enable-time queue
// can drain while DEM cells or 3D tiles are still loading. The first update()
// tick that sees projectionTilesReady() re-enqueues unresolved records ONCE;
// shared mesh cells remain one-shot and idle ticks stay sample-free. Reset by
// startGeometryLoadQueue so each enable-time drain gets its own completion pass.
let _tilesReadyReenqueued = false;
// Calibration ADJUST mode (viewshed/gizmo design §3c): while true, the active
// camera renders the direct-manipulation gizmo. Reset on layer disable.
let _calibrationMode = false;
let _gizmo = null;
let _lastTransientNotifyAt = 0;
// Cached handle on the active Google Photorealistic 3D Tileset, discovered
// lazily from scene.primitives. Shared mesh-floor sampling is gated on its
// tilesLoaded flag so a coarse-LOD miss is never baked in. Cleared when the
// tileset is destroyed / the layer tears down.
let _activeTileset = null;
// Task 5: last surface regime the record geometry was recomputed for. The
// map-stack change listener compares the CURRENT regime (derived live from
// scene.globe.show) against this so bing→osm switches (same 'terrain-globe'
// regime) don't trigger a pointless full-catalog rewrite.
let _lastAppliedRegime = null;
// Task 5: window listener handle for the 'gev:map-stack-changed' CustomEvent
// main.js dispatches from MapStackController's onChange (removed in destroy).
let _mapStackListener = null;
// Field-test fix (2026-07-06): camera.moveEnd handle for the horizon-culling
// pass (removed in destroy). Event-driven only — never a per-frame loop, so
// the zero-steady-state-work invariant holds.
let _horizonCullListener = null;
// Ambient card tier state (2026-07-29 design). The card set is rebuilt only
// on moveEnd/enable/activation (refreshAmbientCards); frame slots are STABLE
// objects shared with the overlay host so landed frames appear without an
// entry rebuild.
let _cardIds = new Set();
/** @type {Map<string,{misses:number,since:number}>} */
let _cardGraceState = new Map();
/** @type {Map<string,{frame:*, stamp:number, failCount:number, lastAttemptAt:number}>} */
let _cardFrameSlots = new Map();
let _cardFetchTimer = 0;
/** In-flight card-frame fetch count (burst allows up to 4, steady is 1). */
let _cardFetchInFlightCount = 0;
/** @type {Set<HTMLImageElement>} in-flight fetches, detached on teardown. */
const _cardFetchImages = new Set();
/** @type {Set<string>} camera ids with an in-flight fetch (no double-fetch). */
const _cardFetchPendingIds = new Set();
let _cardFetchCount = 0;
let _cardLastFetchAt = 0;
let _cardMinFetchSpacingMs = null;
/** Pacer mode telemetry: 'burst' during cold fill, 'steady' after. */
let _cardFetchMode = 'steady';
/**
 * Card budget while the staggered geometry drain is running — the raised
 * 20/28/40 tiers resume when loading completes (see refreshAmbientCards).
 */
const CCTV_AMBIENT_CARD_DRAIN_CAP = 16;
// Global static-frame pacing (field finding 3): the pacer ticks at the burst
// spacing (250 ms) but cardFetchPolicy gates launches — cold fill (selected
// cards still missing their FIRST frame) allows up to 4 in-flight fetches at
// 250 ms spacing; steady state keeps the salvaged Part C gate of at most one
// request per second with an in-flight fetch blocking the tick, so slow
// responses only lower the rate.
const CARD_FETCH_TICK_MS = CCTV_CARD_FETCH_BURST_SPACING_MS;
// In-view margin so cards whose anchors sit just beyond an edge don't churn
// while the operator makes minor camera adjustments (Part C recordIsInView).
const CARD_VIEW_MARGIN = 0.06;
/** Card leader gap: clears the 24px icon (12px half + breathing room). */
const CARD_GAP_PX = 16;
const CCTV_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: CCTV_AMBIENT_CARD_MAX,
  collisionCapacity: CCTV_AMBIENT_CARD_MAX,
  moving: true,
  solveIntervalMs: 125,
});
export const CCTV_PROJECTION_OVERLAY_SOURCE_ID = 'cctv-projection';
export const CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});
const DEFAULT_CCTV_OVERLAY_HOST = Object.freeze({
  clearSource: clearOverlaySource,
  hitTest: hitTestWorldOverlay,
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
});
let _cctvOverlayHost = DEFAULT_CCTV_OVERLAY_HOST;
let _projectionOverlayOwnerId = null;
/**
 * Product presentation option. Shipped behavior keeps the active camera's
 * thumbnail absent because its monitor plane is the active representation.
 */
let _activeCameraCardEnabled = false;
// Hover-summoned card (follow-up round 2, item B): pointing at a cardless camera
// icon shows its card immediately as a PINNED entry (budget-exempt, top
// draw-pass declutter priority).
/** Min spacing between hover scene.pick calls (event-driven, user gesture). */
const HOVER_PICK_THROTTLE_MS = 120;
/** How long the hover card lingers after the pointer leaves the icon. */
const HOVER_RELEASE_MS = 1_000;
/** Camera id currently holding the hover-summoned pinned card (or null). */
let _hoverCardId = null;
let _hoverReleaseTimer = 0;
let _hoverLastPickAt = 0;

/** Test seam: republishes host entries through the real push path, so tests
 * can observe the pristine module default without touching the setter. */
export function _pushAmbientCardEntriesForTest() {
  pushAmbientCardEntries();
}

/** Test seam for exercising real layer lifecycle paths without a DOM host. */
export function _setCctvOverlayHostForTest(host = null) {
  _cctvOverlayHost = host ? { ...DEFAULT_CCTV_OVERLAY_HOST, ...host } : DEFAULT_CCTV_OVERLAY_HOST;
  _projectionOverlayOwnerId = null;
}

/**
 * Build the protected label associated with one active monitor plane.
 * @param {{cameraId: string, name: string, position: Cesium.Cartesian3|Function}} input
 * @returns {Object} Shared-host presentation entry.
 */
export function createCctvProjectionOverlayEntry({ cameraId, name, position }) {
  return {
    id: String(cameraId),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER - 1,
    title: String(name || cameraId || 'CAMERA'),
    details: [],
    accent: '#6be8ff',
    interactive: false,
    gapPx: 6,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/**
 * Configures optional CCTV card presentation without changing card density.
 * The active-camera thumbnail defaults OFF, preserving the shipped behavior
 * where the monitor plane is the camera's sole active representation.
 *
 * @param {Object} [options]
 * @param {boolean} [options.activeCameraCardEnabled=false]
 * @returns {{activeCameraCardEnabled:boolean}}
 */
export function setCctvCardPresentationOptions({ activeCameraCardEnabled = false } = {}) {
  _activeCameraCardEnabled = activeCameraCardEnabled === true;
  if (_enabled) pushAmbientCardEntries();
  _viewer?.scene?.requestRender?.();
  return { activeCameraCardEnabled: _activeCameraCardEnabled };
}
// True between camera.moveStart and moveEnd — hover picking pauses while the
// camera is in motion (picks during a flight would fight the reselection).
let _cameraMoving = false;
let _moveStartListener = null;

/**
 * Converts degrees to radians.
 * @param {number} deg
 * @returns {number}
 */
function toRad(deg) {
  return Cesium.Math.toRadians(deg);
}

/**
 * Normalizes a heading angle to the [0, 360) range.
 * @param {number} deg
 * @returns {number}
 */
function normalizeHeading(deg) {
  let v = deg % 360;
  if (v < 0) v += 360;
  return v;
}

/**
 * Clamps a value to [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Normalizes an angle to the (-180, 180] range.
 * @param {number} deg
 * @returns {number}
 */
function normalizeSignedAngle(deg) {
  let value = deg % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  return value;
}

/**
 * Returns the absolute angular difference between two headings in degrees.
 * @param {number} aDeg
 * @param {number} bDeg
 * @returns {number} Value in [0, 180].
 */
function angularDeltaAbs(aDeg, bDeg) {
  return Math.abs(normalizeSignedAngle(aDeg - bDeg));
}

/**
 * Task 5 (height-datum fix): maps the scene's `globe.show` flag to the surface
 * regime key the per-camera ground cache is keyed by (spec §2 "cache by
 * surface regime", collapsed to two keys — ion World Terrain and Re:Earth
 * globe terrain get the same handling):
 *
 *  - `google-3d`     — photoreal stack: globe hidden, the visible Google 3D
 *                      tileset IS the surface → one-shot scene sampling refines.
 *  - `terrain-globe` — any globe stack: the Re:Earth point-height prior IS the
 *                      resolution (zero scene queries).
 *
 * Only an explicit `false` (the photoreal stack hides the globe) selects
 * `google-3d`; undefined/null (no viewer / torn down) must fall to the regime
 * that never touches the scene. Pure — exported for the unit suite.
 * @param {boolean|undefined|null} globeShow - `viewer.scene.globe.show`.
 * @returns {'google-3d'|'terrain-globe'}
 */
export function surfaceRegimeKey(globeShow) {
  return globeShow === false ? 'google-3d' : 'terrain-globe';
}

/**
 * Normalizes a raw feed-type string to a canonical type (image, mjpeg, mp4, hls, webm).
 * @param {string|*} value - Raw feed type from source config.
 * @returns {string} Canonical feed type.
 */
function normalizeFeedType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'image';
  if (raw === 'mjpg') return 'mjpeg';
  if (raw === 'jpeg') return 'image';
  if (raw === 'jpg') return 'image';
  if (raw === 'video') return 'mp4';
  if (raw === 'stream') return 'hls';
  if (raw === 'png') return 'image';
  if (raw === 'gif') return 'image';
  return raw;
}

/**
 * Returns true if the feed type requires a <video> element rather than an <img>.
 * @param {string} feedType
 * @returns {boolean}
 */
function isVideoFeedType(feedType) {
  return feedType === 'mp4' || feedType === 'hls' || feedType === 'webm';
}

/**
 * Coerces a value to a finite number or returns the fallback.
 * @param {*} value
 * @param {number} [fallback=NaN]
 * @returns {number}
 */
function safeNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Derives a deterministic heading from a camera ID string via a simple hash.
 * Produces one of 16 evenly-spaced headings (0, 22.5, 45, ..., 337.5).
 * @param {string} id
 * @returns {number} Heading in degrees [0, 360).
 */
function headingFromId(id) {
  const text = String(id || '');
  let acc = 0;
  for (let i = 0; i < text.length; i++) {
    acc = (acc * 33 + text.charCodeAt(i)) >>> 0;
  }
  return normalizeHeading((acc % 16) * 22.5);
}

/**
 * Rounds a value to the nearest multiple of `step`.
 * @param {number} value
 * @param {number} [step=0.1]
 * @returns {number}
 */
function quantize(value, step = 0.1) {
  return Math.round(value / step) * step;
}

/**
 * Sanitizes and clamps a calibration object to valid ranges.
 * Missing or non-finite fields fall back to defaults.
 * @param {Object} [value={}] - Raw calibration values.
 * @returns {{ offsetNorthM: number, offsetEastM: number, headingDeg: number, pitchDeg: number, fovDeg: number, rangeScale: number, heightM: number }}
 */
function normalizeCalibration(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    offsetNorthM: quantize(clamp(safeNumber(raw.offsetNorthM, 0), -900, 900), 0.1),
    offsetEastM: quantize(clamp(safeNumber(raw.offsetEastM, 0), -900, 900), 0.1),
    headingDeg: quantize(clamp(safeNumber(raw.headingDeg, 0), -180, 180), 0.1),
    pitchDeg: quantize(clamp(safeNumber(raw.pitchDeg, 0), -45, 45), 0.1),
    fovDeg: quantize(clamp(safeNumber(raw.fovDeg, 0), -50, 50), 0.1),
    rangeScale: quantize(clamp(safeNumber(raw.rangeScale, 1), 0.35, 3.0), 0.01),
    heightM: quantize(clamp(safeNumber(raw.heightM, 0), -120, 240), 0.1),
  };
}

/**
 * Returns true if the given calibration is effectively the default (all offsets near zero).
 * @param {Object} calibration
 * @returns {boolean}
 */
function isDefaultCalibration(calibration) {
  const probe = normalizeCalibration(calibration);
  return Object.keys(DEFAULT_CAMERA_CALIBRATION).every((key) => Math.abs(probe[key] - DEFAULT_CAMERA_CALIBRATION[key]) < 0.0001);
}

/**
 * Normalizes a coverage-mode request (viewshed design §3b). Accepts the three
 * mode strings plus booleans for `setParams({showCoverage})` back-compat
 * (true → 'on', false → 'off'); anything else keeps the current mode.
 * @param {*} value - Requested mode ('off'|'on'|'viewshed') or boolean.
 * @param {'off'|'on'|'viewshed'} current - Mode to keep when the request is invalid.
 * @returns {'off'|'on'|'viewshed'}
 */
export function normalizeCoverageMode(value, current) {
  if (value === true) return 'on';
  if (value === false) return 'off';
  if (value === 'off' || value === 'on' || value === 'viewshed') return value;
  return current;
}

/**
 * Converts north/east metre offsets to lat/lon degree deltas at a given latitude.
 * Uses the equirectangular approximation (111320 m/deg).
 * @param {number} latDeg - Reference latitude (degrees).
 * @param {number} northMeters - Offset northward (metres).
 * @param {number} eastMeters - Offset eastward (metres).
 * @returns {{ latOffset: number, lonOffset: number }} Degree deltas.
 */
function offsetDegrees(latDeg, northMeters, eastMeters) {
  const latOffset = northMeters / 111320;
  const lonDivisor = Math.max(0.15, Math.cos(toRad(latDeg)));
  const lonOffset = eastMeters / (111320 * lonDivisor);
  return { latOffset, lonOffset };
}

/**
 * Returns `window.localStorage` when it is safely accessible, else null.
 * Split out so store IO can be exercised under plain node:test with an
 * injected storage-like object (getItem/setItem/removeItem) instead.
 * @returns {Storage|null}
 */
function safeWindowLocalStorage() {
  if (typeof window === 'undefined') return null;
  try {
    // NB: the window.localStorage property ACCESS itself throws SecurityError
    // under "block all cookies", so it has to live inside the try (M11).
    return window.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * Loads all persisted per-camera calibration overrides from the v2 store.
 *
 * v2 entries carry provenance: `{ values: <7-field offsets>, source: 'manual',
 * savedAt: <epoch ms> }`. The v1 key (`CCTV_CALIBRATION_STORAGE_KEY_V1`) is
 * NEVER read here — product rule #3 (§9.3): wipe clean, no legacy import.
 *
 * @param {{getItem:function}|null} [storage] - Injectable storage (defaults
 *   to `window.localStorage`); lets the unit suite test this pure of a DOM.
 * @returns {Map<string, {values:Object, source:string, savedAt:number}>}
 */
export function readCalibrationStoreV2(storage = safeWindowLocalStorage()) {
  const map = new Map();
  if (!storage) return map;
  try {
    const raw = storage.getItem(CCTV_CALIBRATION_STORAGE_KEY_V2);
    if (!raw) return map;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return map;
    for (const [cameraId, entry] of Object.entries(parsed)) {
      if (!cameraId || !entry || typeof entry !== 'object') continue;
      if (!entry.values || typeof entry.values !== 'object') continue;
      // 'manual' is the only provenance v2 knows (§9.3 killed 'legacy'); a
      // malformed/foreign source string still normalizes to 'manual' rather
      // than surfacing an unrecognized value into the badge logic.
      map.set(cameraId, {
        values: normalizeCalibration(entry.values),
        source: 'manual',
        savedAt: safeNumber(entry.savedAt, 0),
      });
    }
    return map;
  } catch {
    return map;
  }
}

/**
 * Persists a calibration map to the v2 store.
 * @param {Map<string, {values:Object, source:string, savedAt:number}>} map
 * @param {{setItem:function}|null} [storage] - Injectable storage (defaults
 *   to `window.localStorage`).
 */
export function writeCalibrationStoreV2(map, storage = safeWindowLocalStorage()) {
  if (!storage) return;
  try {
    const payload = {};
    for (const [cameraId, entry] of map.entries()) {
      payload[cameraId] = {
        values: normalizeCalibration(entry.values),
        source: 'manual',
        savedAt: safeNumber(entry.savedAt, Date.now()),
      };
    }
    storage.setItem(CCTV_CALIBRATION_STORAGE_KEY_V2, JSON.stringify(payload));
  } catch {
    // storage unavailable
  }
}

/**
 * Loads the v2 calibration store. `_calibrationById` holds these entries
 * directly (`{values, source:'manual', savedAt}`) — never bare offset values
 * — so it round-trips straight back through `writeCalibrationStoreV2`.
 * @returns {Map<string, {values:Object, source:string, savedAt:number}>}
 */
function loadCalibrationStore() {
  return readCalibrationStoreV2();
}

/** Persists the in-memory calibration entries (values + provenance) to the v2 store. */
function saveCalibrationStore() {
  writeCalibrationStoreV2(_calibrationById);
}

/**
 * Derives the panel CAL badge state for a camera (design §3b, as amended by
 * the LOCKED §9.2 — panel-only, no in-world tint).
 *
 * Three states:
 *  - 'calibrated' — a human explicitly saved a v2 calibration (`source:'manual'`).
 *  - 'curated'    — no manual save, but the catalog entry was hand-authored
 *                   (`poseSource:'curated'`, file/env sources only).
 *  - 'raw-prior'  — everything else (all Austin Open Data today).
 *
 * Pure — no scoring math, no raycasts. `confidenceFromScore` and score-based
 * quality seeding are retired; this replaces them.
 * @param {{calSource?: string|null, poseSource?: string|null}} camera
 * @returns {'calibrated'|'curated'|'raw-prior'}
 */
export function deriveCalBadge(camera) {
  if (camera?.calSource === 'manual') return 'calibrated';
  if (camera?.poseSource === 'curated') return 'curated';
  return 'raw-prior';
}

/**
 * Initializes or recomputes a camera's derived pose fields from its base pose
 * and calibration offsets. Also sets intrinsics, extrinsics, and anchor.
 *
 * On first call for a camera, captures the raw values as `basePose`.
 * Subsequent calls re-derive lat/lon/heading/pitch/fov/range by applying
 * calibration deltas to the frozen base pose.
 *
 * Note: the old score-based quality system (`confidenceFromScore`, seeded
 * `camera.quality.score`) is retired — panel trust signal is now the 3-state
 * CAL badge (`deriveCalBadge`, driven by `calSource`/`poseSource`), not a
 * fabricated confidence score.
 *
 * @param {Object} camera - Mutable camera record.
 */
function ensureCameraPose(camera) {
  if (!camera) return;
  if (!camera.basePose) {
    camera.basePose = {
      lat: safeNumber(camera.lat, 0),
      lon: safeNumber(camera.lon, 0),
      headingDeg: normalizeHeading(safeNumber(camera.headingDeg, 0)),
      pitchDeg: clamp(safeNumber(camera.pitchDeg, -17), -70, 10),
      fovDeg: clamp(safeNumber(camera.fovDeg, 74), 20, 130),
      rangeM: clamp(safeNumber(camera.rangeM, 700), 120, 5000),
      mountHeightM: clamp(safeNumber(camera.mountHeightM, 24), 2, 240),
    };
  }

  const nextCalibration = normalizeCalibration(camera.calibration || DEFAULT_CAMERA_CALIBRATION);
  camera.calibration = nextCalibration;

  const base = camera.basePose;
  const offsets = offsetDegrees(base.lat, nextCalibration.offsetNorthM, nextCalibration.offsetEastM);
  camera.lat = base.lat + offsets.latOffset;
  camera.lon = base.lon + offsets.lonOffset;
  camera.headingDeg = normalizeHeading(base.headingDeg + nextCalibration.headingDeg);
  camera.pitchDeg = clamp(base.pitchDeg + nextCalibration.pitchDeg, -70, 10);
  camera.fovDeg = clamp(base.fovDeg + nextCalibration.fovDeg, 20, 130);
  camera.rangeM = clamp(base.rangeM * nextCalibration.rangeScale, 120, 5000);
  camera.mountHeightM = clamp(base.mountHeightM + nextCalibration.heightM, 2, 240);

  camera.intrinsics = {
    fovDeg: camera.fovDeg,
    principalPoint: [0.5, 0.5],
  };
  camera.extrinsics = {
    headingDeg: camera.headingDeg,
    pitchDeg: camera.pitchDeg,
    rollDeg: 0,
    heightM: camera.mountHeightM,
  };
  camera.anchor = {
    lat: camera.lat,
    lon: camera.lon,
    elevM: safeNumber(camera.groundElevationM, 0),
    targetLatLon: camera.anchor?.targetLatLon || null,
  };
}

/**
 * Projects a point along a bearing from a given lat/lon by a distance.
 * Uses the spherical-earth direct geodesic formula (R = 6371 km).
 * @param {number} latDeg - Origin latitude (degrees).
 * @param {number} lonDeg - Origin longitude (degrees).
 * @param {number} bearingDeg - Azimuth from north (degrees).
 * @param {number} distanceM - Distance in metres.
 * @returns {{ lat: number, lon: number }} Destination in degrees.
 */
function projectPoint(latDeg, lonDeg, bearingDeg, distanceM) {
  const angular = distanceM / 6371000;
  const bearing = toRad(bearingDeg);
  const lat1 = toRad(latDeg);
  const lon1 = toRad(lonDeg);

  const sinLat2 = Math.sin(lat1) * Math.cos(angular)
    + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing);
  const lat2 = Math.asin(sinLat2);

  const y = Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1);
  const x = Math.cos(angular) - Math.sin(lat1) * sinLat2;
  const lon2 = lon1 + Math.atan2(y, x);

  return {
    lat: Cesium.Math.toDegrees(lat2),
    lon: Cesium.Math.toDegrees(lon2),
  };
}

/**
 * V2 core geometry (design §2a): computes the pitched frustum pyramid — mount
 * point, far-cap (monitor plane) center, and the 4 far-plane corners — purely
 * from the calibrated pose + a caller-supplied ground altitude. ZERO scene
 * queries: ground sampling happens in the caller (one-shot snap), and the
 * obstruction probe passes its clamp in as `rangeOverrideM`.
 *
 * Math (spherical small-angle offsets; sub-centimetre at ≤2.2 km ranges):
 *   mountAlt  = groundAltM + mountHeightM
 *   capCenter = projectPoint(heading, R·cos(pitch)) @ alt mountAlt + R·sin(pitch)
 *   halfW     = R·tan(hFov/2)
 *   vFov      = 2·atan(tan(hFov/2) / (16/9))   → halfH = R·tan(vFov/2)
 *   upOffset  = cos(pitch)·halfH vertical + (−sin(pitch))·halfH along heading
 *   corners   = (capCenter ∓ halfW toward heading∓90°) ± upOffset
 * The cap CENTER altitude clamps to ≥ groundAltM + 2 m (§6 risk: fabricated
 * pitch must never bury the plane's anchor); corners derive rigidly from the
 * clamped center so the wireframe rays always terminate on the plane's
 * corners — the bottom pair may dip below ground (tiles occlude it).
 *
 * @param {Object} camera - Pose: lat, lon, headingDeg, pitchDeg, fovDeg,
 *   rangeM, mountHeightM.
 * @param {number} groundAltM - Ground altitude at the mount (metres).
 * @param {number|null} [rangeOverrideM=null] - Obstruction-probe clamp: caps the
 *   effective range (never lengthens it).
 * @returns {{ rangeM: number, vFovDeg: number, halfW: number, halfH: number,
 *   mount: {lat:number,lon:number,alt:number},
 *   capCenter: {lat:number,lon:number,alt:number},
 *   corners: { tl: Object, tr: Object, br: Object, bl: Object },
 *   topCenter: {lat:number,lon:number,alt:number}, groundAltM: number }}
 */
export function computeFrustumGeometry(camera, groundAltM, rangeOverrideM = null) {
  const ground = safeNumber(groundAltM, 0);
  const poseRange = Math.max(1, safeNumber(camera.rangeM, 700));
  const override = safeNumber(rangeOverrideM, NaN);
  const R = Number.isFinite(override) && override > 0 ? Math.min(poseRange, override) : poseRange;
  const pitch = toRad(clamp(safeNumber(camera.pitchDeg, -17), -89, 89));
  const hFov = toRad(clamp(safeNumber(camera.fovDeg, 74), 8, 160));
  const heading = safeNumber(camera.headingDeg, 0);
  const mountAlt = ground + safeNumber(camera.mountHeightM, 24);

  const horiz = R * Math.cos(pitch);
  const vert = R * Math.sin(pitch);
  const capLL = projectPoint(camera.lat, camera.lon, heading, horiz);
  const capAlt = mountAlt + vert;

  const halfW = R * Math.tan(hFov / 2);
  const vFovRad = 2 * Math.atan(Math.tan(hFov / 2) / PROJECTION_VERT_ASPECT);
  const halfH = R * Math.tan(vFovRad / 2);

  // In-plane "up" of the pitched cap, decomposed into a vertical part and a
  // horizontal part along the heading (pitch < 0 tilts the cap's top forward).
  const upVert = Math.cos(pitch) * halfH;
  const upHoriz = -Math.sin(pitch) * halfH;

  const capL = projectPoint(capLL.lat, capLL.lon, heading - 90, halfW);
  const capR = projectPoint(capLL.lat, capLL.lon, heading + 90, halfW);
  // Ground clamp (§6 risk): lift the CAP CENTER once so a fabricated pitch
  // never buries the plane's anchor — then derive the corners RIGIDLY from the
  // lifted center. Clamping each corner independently flattened the wireframe
  // into a ground-hugging fan while the rigid plane kept its height (owner
  // field test 2026-07-04): the corner rays must always terminate exactly on
  // the monitor plane's corners. The bottom pair may dip below ground; the 3D
  // tiles occlude that portion, exactly as they do for the plane itself.
  const minAlt = ground + FRUSTUM_GROUND_CLEARANCE_M;
  const capAltClamped = Math.max(minAlt, capAlt);
  const corner = (base, sign) => {
    const ll = projectPoint(base.lat, base.lon, heading, sign * upHoriz);
    return { lat: ll.lat, lon: ll.lon, alt: capAltClamped + sign * upVert };
  };

  const topCenter = corner(capLL, 1);
  return {
    rangeM: R,
    vFovDeg: Cesium.Math.toDegrees(vFovRad),
    halfW,
    halfH,
    mount: { lat: camera.lat, lon: camera.lon, alt: mountAlt },
    capCenter: { lat: capLL.lat, lon: capLL.lon, alt: capAltClamped },
    corners: {
      tl: corner(capL, 1),
      tr: corner(capR, 1),
      br: corner(capR, -1),
      bl: corner(capL, -1),
    },
    topCenter,
    groundAltM: ground,
  };
}

/**
 * Resolves the obstruction probe's effective-range clamp just short of a hit,
 * with the field-derived 12 m floor used by the original H6 monitor.
 * @param {number} rangeM Nominal camera range.
 * @param {number} hitDistanceM Distance to the first obstruction.
 * @returns {number|null} Clamp range, or null when the hit does not shorten it.
 */
export function activationProbeClampRange(rangeM, hitDistanceM) {
  const nominalRange = Number(rangeM);
  const hitDistance = Number(hitDistanceM);
  if (!Number.isFinite(nominalRange) || nominalRange <= 0) return null;
  if (!Number.isFinite(hitDistance) || hitDistance <= 0 || hitDistance >= nominalRange) return null;
  return Math.max(PROBE_MIN_RANGE_M, hitDistance - PROBE_CLEARANCE_M);
}

/**
 * Computes the great-circle distance between two points using the haversine formula.
 * @param {number} lat1 - Latitude of point 1 (degrees).
 * @param {number} lon1 - Longitude of point 1 (degrees).
 * @param {number} lat2 - Latitude of point 2 (degrees).
 * @param {number} lon2 - Longitude of point 2 (degrees).
 * @returns {number} Distance in kilometres.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Computes the area of a circular sector (camera FOV wedge).
 * @param {number} rangeM - Radius in metres.
 * @param {number} fovDeg - Field of view in degrees.
 * @returns {number} Area in km^2.
 */
function sectorAreaKm2(rangeM, fovDeg) {
  const theta = toRad(clamp(fovDeg, 12, 170));
  const areaM2 = 0.5 * rangeM * rangeM * theta;
  return areaM2 / 1_000_000;
}

/**
 * Returns a coarse grid key describing the viewer's current position and zoom
 * level. Used to detect meaningful view changes for auto-hop camera switching.
 * @returns {string} Grid key in the form "zoomBucket:latGrid:lonGrid".
 */
function currentViewContext() {
  const carto = _viewer?.camera?.positionCartographic;
  if (!carto) return 'none';
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const alt = carto.height || 0;
  const zoomBucket = alt < 1500 ? 'street'
    : alt < 12000 ? 'city'
      : alt < 75000 ? 'regional'
        : 'global';
  const grid = zoomBucket === 'street' ? 0.045
    : zoomBucket === 'city' ? 0.24
      : zoomBucket === 'regional' ? 1.0
        : 4.5;
  return `${zoomBucket}:${Math.floor(lat / grid)}:${Math.floor(lon / grid)}`;
}

/**
 * Builds the initial camera catalog from CAMERA_SEEDS definitions.
 * Each seed is resolved against its city's POI coordinates, offset, and
 * passed through ensureCameraPose to populate derived fields.
 * @returns {Object[]} Array of fully-initialized camera objects.
 */
function seedCatalog() {
  const catalog = [];
  for (const seed of CAMERA_SEEDS) {
    const city = CITY_POIS[seed.cityId];
    const poi = city?.pois?.[seed.poiIndex];
    if (!city || !poi) continue;
    const { latOffset, lonOffset } = offsetDegrees(
      poi.lat,
      seed.offsetNorthM || 0,
      seed.offsetEastM || 0
    );
    const camera = {
      id: seed.id,
      name: seed.label,
      cityId: seed.cityId,
      city: city.name,
      provider: 'OSM Camera Grid',
      sourceKind: 'seed',
      feedType: 'image',
      feedConfigured: false,
      headingConfidence: 'medium',
      lat: poi.lat + latOffset,
      lon: poi.lon + lonOffset,
      headingDeg: normalizeHeading(seed.headingDeg ?? poi.heading ?? 0),
      fovDeg: clamp(seed.fovDeg ?? 70, 20, 120),
      rangeM: clamp(seed.rangeM ?? 700, 260, 1800),
      mountHeightM: clamp(seed.elevationM ?? 22, 8, 80),
      groundElevationM: Number(city.groundElevation) || 0,
      absoluteHeightM: (Number(city.groundElevation) || 0) + clamp(seed.elevationM ?? 22, 8, 80),
      pitchDeg: clamp(seed.pitchDeg ?? -17, -40, -4),
    };
    ensureCameraPose(camera);
    catalog.push(camera);
  }
  return catalog;
}

/**
 * Looks up a city ID from CITY_POIS by exact or partial name match.
 * @param {string} cityName
 * @returns {string|null} Matching city ID or null.
 */
function cityIdByName(cityName) {
  const probe = String(cityName || '').trim().toLowerCase();
  if (!probe) return null;
  for (const [cityId, city] of Object.entries(CITY_POIS)) {
    if (city.name.toLowerCase() === probe) return cityId;
  }
  for (const [cityId, city] of Object.entries(CITY_POIS)) {
    if (city.name.toLowerCase().includes(probe) || probe.includes(city.name.toLowerCase())) return cityId;
  }
  return null;
}

/**
 * Fetches configured camera sources from the backend.
 * @returns {Promise<Object[]>} Array of raw source objects, or empty on failure.
 */
async function loadCameraSources() {
  try {
    const resp = await fetch(SOURCE_ENDPOINT, { cache: 'no-store' });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!Array.isArray(data?.sources)) return [];
    return data.sources;
  } catch {
    return [];
  }
}

/**
 * Merges raw backend sources with seed data to produce the final camera catalog.
 * Seeds provide fallback values for heading, FOV, range, etc. when not specified
 * by the source. Each camera is passed through ensureCameraPose.
 * @param {Object[]} rawSources - Raw source objects from the backend.
 * @returns {Object[]} Array of fully-initialized camera objects.
 */
function buildCatalogFromSources(rawSources) {
  const sources = Array.isArray(rawSources) ? rawSources : [];
  if (!sources.length) return [];

  const seeded = seedCatalog();
  const seedById = new Map(seeded.map((camera) => [camera.id, camera]));

  const catalog = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const id = String(source.id || '').trim();
    if (!id) continue;
    const seed = seedById.get(id);
    const cityId = String(source.cityId || '').trim() || cityIdByName(source.city) || seed?.cityId || '';
    const city = cityId && CITY_POIS[cityId] ? CITY_POIS[cityId] : null;

    const lat = safeNumber(source.lat, seed?.lat ?? NaN);
    const lon = safeNumber(source.lon, seed?.lon ?? NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const sourceHeading = safeNumber(source.headingDeg, NaN);
    const headingDeg = normalizeHeading(
      Number.isFinite(sourceHeading)
        ? sourceHeading
        : (seed?.headingDeg ?? headingFromId(id))
    );
    const fovDeg = clamp(safeNumber(source.fovDeg, seed?.fovDeg ?? 74), 20, 125);
    const rangeM = clamp(safeNumber(source.rangeM, seed?.rangeM ?? 700), 220, 2200);
    const mountHeightM = clamp(safeNumber(source.mountHeightM, seed?.mountHeightM ?? 24), 6, 120);
    const pitchDeg = clamp(safeNumber(source.pitchDeg, seed?.pitchDeg ?? -17), -55, -2);
    const groundElevationM = safeNumber(source.groundElevationM, city?.groundElevation ?? seed?.groundElevationM ?? 0);
    const feedType = normalizeFeedType(source.feedType || source.type || 'image');
    const headingConfidence = String(source.headingConfidence || (seed ? 'high' : 'low')).toLowerCase();
    // CAL badge input (design §3b passthrough): hand-authored file/env source
    // entries may carry poseSource:'curated'. Austin Open Data rows never set
    // this — they stay RAW PRIOR until a human manually calibrates them.
    const poseSource = source.poseSource === 'curated' ? 'curated' : (seed?.poseSource || null);

    const camera = {
      id,
      name: String(source.name || seed?.name || id),
      cityId,
      city: String(source.city || city?.name || seed?.city || 'Global'),
      provider: String(source.provider || seed?.provider || 'Configured CCTV Source'),
      sourceKind: String(source.sourceKind || source.kind || (source.url ? 'configured' : 'seed')).toLowerCase(),
      feedType,
      feedConfigured: typeof source.url === 'string' && !!source.url.trim(),
      lat,
      lon,
      headingDeg,
      headingConfidence,
      fovDeg,
      rangeM,
      mountHeightM,
      groundElevationM,
      absoluteHeightM: groundElevationM + mountHeightM,
      pitchDeg,
      license: String(source.license || source.licenseNote || ''),
      poseSource,
    };
    ensureCameraPose(camera);
    catalog.push(camera);
  }

  return catalog;
}

/**
 * Reports whether the active Google Photorealistic 3D Tileset (if any) has
 * finished loading the tiles in view. Shared mesh-floor sampling is gated on
 * this so a one-shot cell never bakes in a miss from still-streaming tiles.
 * Discovers + caches the tileset lazily from scene
 * primitives (the CCTV module holds only a `_viewer` reference). When no
 * tileset is present (OSM fallback) this returns true so ground sampling is
 * not permanently blocked.
 *
 * Task 5 (spec correction, spec §2): a HIDDEN tileset (`show === false`,
 * i.e. a globe stack is active) must NOT report ready — Cesium 1.138's
 * the shared sampler can only inspect *visible* 3D tilesets, so a sample taken
 * against the hidden Google tileset would silently miss.
 *
 * @returns {boolean} True when tiles are loaded AND visible (or no tileset
 *   exists to wait on).
 */
function projectionTilesReady() {
  if (!_activeTileset || _activeTileset.isDestroyed?.()) {
    _activeTileset = null;
    const primitives = _viewer?.scene?.primitives;
    if (primitives && typeof primitives.get === 'function') {
      for (let i = 0; i < primitives.length; i++) {
        const p = primitives.get(i);
        if (p instanceof Cesium.Cesium3DTileset && !p.isDestroyed?.()) {
          _activeTileset = p;
          break;
        }
      }
    }
  }
  if (!_activeTileset) return true;
  if (_activeTileset.show === false) return false;
  return _activeTileset.tilesLoaded === true;
}

/**
 * Converts a computeFrustumGeometry result into the Cartesian3 positions the
 * entities consume. Fresh objects per call (geometry updates are rare —
 * slider/save/activation — and entities must never share scratch objects).
 * @param {Object} geometry - Result of computeFrustumGeometry.
 * @returns {{ mount: Cesium.Cartesian3, capCenter: Cesium.Cartesian3,
 *   tl: Cesium.Cartesian3, tr: Cesium.Cartesian3, br: Cesium.Cartesian3,
 *   bl: Cesium.Cartesian3, label: Cesium.Cartesian3 }}
 */
function frustumCartesians(geometry) {
  const at = (p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt);
  return {
    mount: at(geometry.mount),
    capCenter: at(geometry.capCenter),
    tl: at(geometry.corners.tl),
    tr: at(geometry.corners.tr),
    br: at(geometry.corners.br),
    bl: at(geometry.corners.bl),
    label: Cesium.Cartesian3.fromDegrees(
      geometry.topCenter.lon,
      geometry.topCenter.lat,
      geometry.topCenter.alt + 1.2
    ),
  };
}

/**
 * Unit ECEF direction of the frustum view axis (heading/pitch) at a position.
 * Used by the plane orientation and the activation obstruction probe — both
 * need the UNCLAMPED axis, so it comes from the pose, not from clamped points.
 * @param {Object} camera - Camera pose (headingDeg, pitchDeg).
 * @param {Cesium.Cartesian3} atPos - ECEF position defining the local ENU frame.
 * @returns {{ dir: Cesium.Cartesian3, up: Cesium.Cartesian3 }} View axis + the
 *   frame's in-plane "up" (both unit, mutually perpendicular).
 */
function frustumFrameEcef(camera, atPos) {
  const h = toRad(camera.headingDeg);
  const p = toRad(camera.pitchDeg);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(atPos);
  const rot = Cesium.Matrix4.getMatrix3(enu, new Cesium.Matrix3());
  // ENU components: view axis + the perpendicular "up" of the pitched cap.
  const dirEnu = new Cesium.Cartesian3(
    Math.sin(h) * Math.cos(p),
    Math.cos(h) * Math.cos(p),
    Math.sin(p)
  );
  const upEnu = new Cesium.Cartesian3(
    -Math.sin(p) * Math.sin(h),
    -Math.sin(p) * Math.cos(h),
    Math.cos(p)
  );
  return {
    dir: Cesium.Matrix3.multiplyByVector(rot, dirEnu, new Cesium.Cartesian3()),
    up: Cesium.Matrix3.multiplyByVector(rot, upEnu, new Cesium.Cartesian3()),
  };
}

/**
 * Orientation quaternion for the monitor plane entity: local +Z is the plane
 * normal, pointing BACK along the view axis toward the mount so the textured
 * front face reads correctly from the natural viewpoint (focusCamera flies the
 * viewer to look along the camera heading). Local +X = viewer-right, +Y =
 * frame-up, so the 16:9 texture maps upright and unmirrored. Static geometry —
 * computed only on slider/save/activation, never per frame (§2b).
 * @param {Object} camera - Camera pose.
 * @param {Cesium.Cartesian3} capCenterPos - Plane center in ECEF.
 * @returns {Cesium.Quaternion}
 */
function planeOrientationFor(camera, capCenterPos) {
  const frame = frustumFrameEcef(camera, capCenterPos);
  const right = Cesium.Cartesian3.cross(frame.dir, frame.up, new Cesium.Cartesian3());
  const normal = Cesium.Cartesian3.negate(frame.dir, new Cesium.Cartesian3());
  const m = new Cesium.Matrix3(
    right.x, frame.up.x, normal.x,
    right.y, frame.up.y, normal.y,
    right.z, frame.up.z, normal.z
  );
  return Cesium.Quaternion.fromRotationMatrix(m);
}

/**
 * Task 5: the surface regime the scene is CURRENTLY rendering, derived live
 * from `globe.show` (mapStackController's `_activatePhotoreal` /
 * `_activateGlobeStack` flip exactly this flag). Reading scene state directly
 * — rather than caching the map-stack id — means the regime is correct even
 * for stack changes this module never got an event for.
 * @returns {'google-3d'|'terrain-globe'}
 */
function currentSurfaceRegime() {
  return surfaceRegimeKey(_viewer?.scene?.globe?.show);
}

/**
 * Task 5: the record's ellipsoidal ground PRIOR (Re:Earth point-height batch,
 * `record.groundPrior.ellipsoid`), falling back to the catalog's fabricated
 * orthometric `groundElevationM` only when the prior batch hasn't landed yet.
 * This is the value that replaces every previous
 * `Number(camera.groundElevationM) || 0` ground fallback — it alone lifts
 * London's cameras from the fabricated 15 m to ~52.7 m ellipsoidal in every
 * regime, on first paint.
 * @param {Object} record - Camera record.
 * @returns {number} Ellipsoidal ground altitude in metres.
 */
function groundPriorAltFor(record) {
  const prior = record?.groundPrior?.ellipsoid;
  return Number.isFinite(prior) ? prior : (Number(record?.camera?.groundElevationM) || 0);
}

/**
 * Task 5: whether the record's one-shot ground resolution has completed for
 * the given regime (per-regime latch — replaces the old boolean
 * `groundResolved`).
 * @param {Object} record - Camera record.
 * @param {string} [regime] - Defaults to the current surface regime.
 * @returns {boolean}
 */
function isGroundResolved(record, regime = currentSurfaceRegime()) {
  return record?.groundResolved?.[regime] === true;
}

/**
 * Ground altitude used for pure geometry recomputes: the given regime's
 * cached resolution (`record.groundSamples[regime]` — a shared mesh/DEM floor
 * in google-3d, the DEM/prior in terrain-globe) when it exists, else the prior
 * itself. Never queries the scene.
 * @param {Object} record - Camera record.
 * @param {string} [regime] - Defaults to the current surface regime.
 * @returns {number} Ground altitude in metres.
 */
function groundAltFor(record, regime = currentSurfaceRegime()) {
  const cached = record?.groundSamples?.[regime];
  return Number.isFinite(cached) ? cached : groundPriorAltFor(record);
}

/**
 * FNV-1a over the RGB channels of a downsampled frame. Pure (takes the raw
 * pixel buffer, no DOM) so it is unit-testable.
 *
 * Alpha is skipped deliberately — CCTV stills are opaque, so hashing it would
 * cost a third more work to mix in a constant.
 *
 * @param {Uint8ClampedArray|number[]} data - RGBA pixels, 4 bytes per pixel.
 * @returns {number|null} Unsigned 32-bit signature, or null for empty input.
 */
export function frameSignatureFromPixels(data) {
  if (!data || typeof data.length !== 'number' || data.length < 4) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i += 4) {
    hash = Math.imul(hash ^ data[i], 0x01000193);
    hash = Math.imul(hash ^ data[i + 1], 0x01000193);
    hash = Math.imul(hash ^ data[i + 2], 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Signature of the runtime's freshly decoded frame, via a reused 64x36
 * scratch canvas.
 *
 * @param {Object} runtime - Projection runtime holding the decoded `.image`.
 * @returns {number|null} Signature, or null when it cannot be computed (the
 *   caller then treats the frame as changed — the pre-2026-07-30 behavior).
 */
function projectionFrameSignature(runtime) {
  const image = runtime?.image;
  if (!image) return null;
  if (!runtime.signatureCtx) {
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_SIGNATURE_W;
    canvas.height = FRAME_SIGNATURE_H;
    runtime.signatureCanvas = canvas;
    runtime.signatureCtx = canvas.getContext('2d', { willReadFrequently: true });
  }
  const ctx = runtime.signatureCtx;
  if (!ctx) return null;
  try {
    ctx.clearRect(0, 0, FRAME_SIGNATURE_W, FRAME_SIGNATURE_H);
    ctx.drawImage(image, 0, 0, FRAME_SIGNATURE_W, FRAME_SIGNATURE_H);
    return frameSignatureFromPixels(
      ctx.getImageData(0, 0, FRAME_SIGNATURE_W, FRAME_SIGNATURE_H).data
    );
  } catch {
    // Tainted canvas (a cross-origin source served without CORS) or a decode
    // race. Returning null means "assume changed", so behavior degrades to
    // the unconditional redraw this optimization replaced.
    return null;
  }
}

/**
 * Blits the latest projection canvas into the next of two alternating
 * offscreen buffer canvases and returns it (H5).
 *
 * Two buffers are required because Cesium's Material image path re-uploads a
 * canvas texture only when the uniform receives a NEW object reference —
 * redrawing the same canvas in place is invisible to the GPU. Alternating
 * references forces a texture recreate, which at <=1Hz and 1080p is cheap.
 *
 * @param {Object} runtime - Projection runtime with `.canvas`.
 * @returns {HTMLCanvasElement|null} The freshly painted buffer, or null.
 */
function paintNextProjectionBuffer(runtime) {
  if (!runtime?.canvas) return null;
  if (!runtime.buffers) {
    runtime.buffers = [0, 1].map(() => {
      const buffer = document.createElement('canvas');
      buffer.width = PROJECTION_CANVAS_WIDTH;
      buffer.height = PROJECTION_CANVAS_HEIGHT;
      return buffer;
    });
    runtime.bufferIndex = 0;
  }
  runtime.bufferIndex = (runtime.bufferIndex + 1) % 2;
  const buffer = runtime.buffers[runtime.bufferIndex];
  const ctx = buffer.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, buffer.width, buffer.height);
  ctx.drawImage(runtime.canvas, 0, 0);
  return buffer;
}

/**
 * Pushes fresh pixels into the monitor plane material. Called every
 * projection tick.
 *
 * Video feeds are skipped entirely — their HTMLVideoElement uniform is
 * updated per-frame by Cesium natively (H5). Image/webcam-frame feeds swap
 * the double-buffer canvas reference, throttled to PROJECTION_TEXTURE_SWAP_MS.
 *
 * @param {Object} record - Camera record with an initialized projection runtime.
 */
function refreshProjectionTextures(record) {
  const runtime = record?.projection;
  if (!runtime || runtime.mode === 'video') return;
  const now = Date.now();
  if (now - safeNumber(runtime.lastTextureSwapAt, 0) < PROJECTION_TEXTURE_SWAP_MS) return;

  const planeShowing = !!(runtime.planeEntity?.show && runtime.planeMaterial);
  if (!planeShowing) return;

  // Only swap when the canvas content actually changed since the last swap.
  // Frames land every ~10 s but this runs at 1 Hz — swapping an UNCHANGED
  // canvas re-uploads the texture for nothing, and each material image
  // reassignment is a flash opportunity on the live plane (field test
  // 2026-07-04: intermittent white flashes on the monitor plane).
  if (runtime.canvasStamp === runtime.lastSwappedCanvasStamp) return;

  const buffer = paintNextProjectionBuffer(runtime);
  if (!buffer) return;
  runtime.lastTextureSwapAt = now;
  runtime.lastSwappedCanvasStamp = runtime.canvasStamp;
  runtime.planeMaterial.image = buffer;
}

/**
 * Builds the URL for fetching a camera frame image from the backend.
 * Includes a tick parameter to control cache invalidation cadence.
 * @param {Object} camera - Camera object.
 * @param {number} [refreshMs=ACTIVE_FRAME_REFRESH_MS] - Refresh interval used for tick bucketing.
 * @returns {string} Frame URL.
 */
function frameUrlFor(camera, refreshMs = ACTIVE_FRAME_REFRESH_MS) {
  const cadenceMs = Math.max(1000, safeNumber(refreshMs, ACTIVE_FRAME_REFRESH_MS));
  const tick = Math.floor(Date.now() / cadenceMs);
  const params = new URLSearchParams({
    label: camera.name,
    city: camera.city,
    lat: camera.lat.toFixed(6),
    lon: camera.lon.toFixed(6),
    heading: String(Math.round(camera.headingDeg)),
    fov: String(Math.round(camera.fovDeg)),
    pitch: String(Math.round(camera.pitchDeg || -10)),
    ts: String(tick),
  });
  return `${FRAME_ENDPOINT}/${encodeURIComponent(camera.id)}?${params.toString()}`;
}

/**
 * Builds the URL for fetching a camera's video/media stream.
 * @param {Object} camera - Camera object.
 * @returns {string} Media URL.
 */
function mediaUrlFor(camera) {
  return `${MEDIA_ENDPOINT}/${encodeURIComponent(camera.id)}?ts=${Math.floor(Date.now() / 15000)}`;
}

/**
 * Paints a placeholder frame onto the projection canvas when no live feed
 * image or video is available. Shows camera name, city, and status text
 * over a dark gradient with tactical border lines.
 * @param {CanvasRenderingContext2D} ctx - 2D context for the projection canvas.
 * @param {Object} camera - Camera object for label info.
 * @param {Object|null} [health=null] - Health state for status message.
 */
function paintProjectionPlaceholder(ctx, camera, health = null) {
  if (!ctx) return;
  const w = PROJECTION_CANVAS_WIDTH;
  const h = PROJECTION_CANVAS_HEIGHT;
  ctx.clearRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#05111a');
  g.addColorStop(1, '#01070c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const label = String(camera?.name || 'CCTV');
  const city = String(camera?.city || 'GLOBAL');
  const status = String(health?.message || health?.status || camera?.feedType || 'NO FEED').toUpperCase();

  ctx.strokeStyle = 'rgba(0, 220, 255, 0.24)';
  ctx.lineWidth = 2;
  ctx.strokeRect(18, 18, w - 36, h - 36);
  ctx.strokeRect(36, 36, w - 72, h - 72);

  ctx.fillStyle = 'rgba(170, 242, 255, 0.95)';
  ctx.font = '600 32px "JetBrains Mono", monospace';
  ctx.fillText(label.slice(0, 42), 46, 74);
  ctx.fillStyle = 'rgba(127, 216, 231, 0.8)';
  ctx.font = '500 24px "JetBrains Mono", monospace';
  ctx.fillText(city.toUpperCase(), 46, 112);
  ctx.font = '500 21px "JetBrains Mono", monospace';
  ctx.fillText(status.slice(0, 58), 46, h - 42);
}

/**
 * Re-derives the monitor plane entity's placement (position, orientation,
 * dimensions) + label from the record's current frustum geometry, so the plane
 * always caps the wireframe exactly (corner rays terminate on its corners).
 * No-op when the record has no plane runtime (idle neighbors have no plane).
 * @param {Object} record - Camera record.
 */
function updatePlanePlacement(record) {
  const runtime = record?.projection;
  if (!runtime?.planeEntity) return;
  const geometry = record.frustumGeometry
    || computeFrustumGeometry(record.camera, groundAltFor(record), record.probeClampRangeM);
  const positions = record.frustumPositions || frustumCartesians(geometry);
  runtime.planeEntity.position = positions.capCenter;
  runtime.planeEntity.orientation = planeOrientationFor(record.camera, positions.capCenter);
  if (runtime.planeEntity.plane) {
    runtime.planeEntity.plane.dimensions = new Cesium.Cartesian2(
      geometry.halfW * 2,
      geometry.halfH * 2
    );
  }
  if (runtime.labelPosition) {
    Cesium.Cartesian3.clone(positions.label, runtime.labelPosition);
  }
}

/**
 * Clear the active monitor-plane label source and ownership marker.
 */
function clearProjectionOverlay() {
  _cctvOverlayHost.clearSource(CCTV_PROJECTION_OVERLAY_SOURCE_ID);
  _cctvOverlayHost.setVisible(CCTV_PROJECTION_OVERLAY_SOURCE_ID, false);
  _projectionOverlayOwnerId = null;
}

/**
 * Shows/hides the monitor plane and its associated shared-host label.
 * @param {Object} runtime - Projection runtime.
 * @param {boolean} visible
 */
function setPlaneVisible(runtime, visible) {
  if (!runtime) return;
  if (runtime.planeEntity) runtime.planeEntity.show = !!visible;
  if (visible && runtime.overlayEntry && runtime.cameraId) {
    if (_projectionOverlayOwnerId !== runtime.cameraId) {
      _cctvOverlayHost.setEntries(
        CCTV_PROJECTION_OVERLAY_SOURCE_ID,
        [runtime.overlayEntry],
        CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
      );
      _cctvOverlayHost.setVisible(CCTV_PROJECTION_OVERLAY_SOURCE_ID, true);
      _projectionOverlayOwnerId = runtime.cameraId;
    }
  } else if (_projectionOverlayOwnerId === runtime.cameraId) {
    clearProjectionOverlay();
  }
}

/** Create the native monitor plane plus its cached host-label presentation. */
function createProjectionPlane(record, runtime, geometry, positions) {
  runtime.labelPosition ||= new Cesium.Cartesian3();
  Cesium.Cartesian3.clone(positions.label, runtime.labelPosition);
  runtime.cameraId = String(record.camera.id);
  runtime.overlayEntry = createCctvProjectionOverlayEntry({
    cameraId: runtime.cameraId,
    name: record.camera.name,
    position: () => runtime.labelPosition,
  });
  runtime.planeEntity = _viewer.entities.add({
    id: `cctv-${record.camera.id}-plane`,
    properties: { cctvCameraId: record.camera.id },
    show: false,
    position: positions.capCenter,
    orientation: planeOrientationFor(record.camera, positions.capCenter),
    plane: {
      plane: new Cesium.Plane(Cesium.Cartesian3.UNIT_Z, 0.0),
      dimensions: new Cesium.Cartesian2(geometry.halfW * 2, geometry.halfH * 2),
      material: runtime.planeMaterial,
      outline: true,
      outlineColor: PLANE_OUTLINE_COLOR,
    },
  });
  return runtime.planeEntity;
}

/**
 * Create the production monitor-plane/host-label pair without media setup.
 * @param {Object} viewer Cesium viewer seam.
 * @param {Object} record CCTV runtime record.
 * @returns {Object} Projection runtime.
 */
export function _createCctvProjectionPlaneForTest(viewer, record) {
  _viewer = viewer;
  const geometry = record.frustumGeometry
    || computeFrustumGeometry(record.camera, groundAltFor(record), record.probeClampRangeM);
  const positions = record.frustumPositions || frustumCartesians(geometry);
  record.frustumGeometry = geometry;
  record.frustumPositions = positions;
  const runtime = {
    cameraId: String(record.camera.id),
    planeEntity: null,
    labelPosition: new Cesium.Cartesian3(),
    overlayEntry: null,
    planeMaterial: new Cesium.ColorMaterialProperty(Cesium.Color.WHITE),
  };
  createProjectionPlane(record, runtime, geometry, positions);
  record.projection = runtime;
  return runtime;
}

/**
 * Exercise the production geometry-to-plane-and-label cache update.
 * @param {Object} record CCTV runtime record.
 */
export function _updateCctvProjectionPlaneForTest(record) {
  updatePlanePlacement(record);
}

/**
 * Creates the projection runtime for a camera record: an offscreen canvas,
 * the monitor plane plus associated host label, and either an
 * <img> or <video> element depending on the feed type.
 *
 * The plane is the only projection representation (v2): the frustum's far cap,
 * perpendicular to the view axis (§2b — never billboarded; a wall primitive
 * can't pitch, the plane can). It is textured with the live frame: video
 * element direct, canvas double-buffer otherwise.
 *
 * @param {Object} record - Camera record.
 * @returns {Object|null} Projection runtime, or null if no viewer.
 */
function createProjectionRuntime(record) {
  if (!_viewer) return null;
  const canvas = document.createElement('canvas');
  canvas.width = PROJECTION_CANVAS_WIDTH;
  canvas.height = PROJECTION_CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d', { alpha: true });

  const feedType = normalizeFeedType(record.camera.feedType);
  const mode = isVideoFeedType(feedType) ? 'video' : 'image';
  const runtime = {
    mode,
    canvas,
    ctx,
    image: null,
    video: null,
    planeEntity: null,
    cameraId: String(record.camera.id),
    labelPosition: new Cesium.Cartesian3(),
    overlayEntry: null,
    planeMaterial: null,
    buffers: null,
    bufferIndex: 0,
    lastTextureSwapAt: 0,
    lastImageRefreshAt: 0,
    imageReady: false,
    imageLoading: false,
    imageStamp: 0,
    drawnImageStamp: -1,
    // Signature of the pixels currently ON the canvas, plus the reused 64x36
    // scratch used to compute it. null = "nothing known", which always redraws.
    lastFrameSignature: null,
    signatureCanvas: null,
    signatureCtx: null,
    lastPlaceholderPaintAt: 0,
    // canvasStamp increments on every canvas write (frame blit / placeholder
    // paint); lastSwappedCanvasStamp trails it so refreshProjectionTextures
    // only re-uploads the plane texture when there is genuinely new content.
    canvasStamp: 1,
    lastSwappedCanvasStamp: 0,
  };

  paintProjectionPlaceholder(ctx, record.camera);

  if (mode === 'video') {
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.src = mediaUrlFor(record.camera);
    video.addEventListener('canplay', () => {
      video.play().catch(() => {});
    });
    runtime.video = video;
  } else {
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      runtime.imageLoading = false;
      runtime.imageReady = true;
      runtime.imageStamp = Date.now();
    };
    img.onerror = () => {
      runtime.imageLoading = false;
      runtime.imageReady = false;
    };
    runtime.image = img;
  }

  // Monitor plane = the frustum's far cap: video feeds bind the video element
  // directly (Cesium updates video-backed entity materials per frame); image
  // feeds start on the placeholder canvas and switch to double-buffer swaps
  // at <=1Hz.
  const geometry = record.frustumGeometry
    || computeFrustumGeometry(record.camera, groundAltFor(record), record.probeClampRangeM);
  const positions = record.frustumPositions || frustumCartesians(geometry);
  runtime.planeMaterial = new Cesium.ImageMaterialProperty({
    image: (mode === 'video' && runtime.video) ? runtime.video : canvas,
    transparent: true,
    color: Cesium.Color.WHITE.withAlpha(0.95),
  });
  createProjectionPlane(record, runtime, geometry, positions);

  return runtime;
}

/**
 * Lazily initializes the projection runtime for a record if it doesn't exist yet.
 * @param {Object} record - Camera record.
 * @returns {Object|null} The record's projection runtime.
 */
function ensureProjectionRuntime(record) {
  if (!record) return null;
  if (record.projection) return record.projection;
  const runtime = createProjectionRuntime(record);
  record.projection = runtime;
  if (runtime) {
    _projectionEntities.push(runtime);
  }
  return runtime;
}

/**
 * Tears down a projection runtime: stops video playback, removes the monitor
 * plane, and clears its host label if it owns the active source.
 * @param {Object} runtime - Projection runtime to destroy.
 */
function destroyProjectionRuntime(runtime) {
  if (!runtime) return;
  if (runtime.video) {
    runtime.video.pause();
    runtime.video.removeAttribute('src');
    runtime.video.load();
  }
  if (runtime.planeEntity && _viewer) {
    _viewer.entities.remove(runtime.planeEntity);
    runtime.planeEntity = null;
  }
  if (_projectionOverlayOwnerId === runtime.cameraId) clearProjectionOverlay();
  runtime.overlayEntry = null;
  runtime.labelPosition = null;
  runtime.planeMaterial = null;
}

/**
 * Triggers a new frame fetch for an image-mode projection if the refresh
 * interval has elapsed. Active cameras refresh more frequently than idle ones.
 * @param {Object} record - Camera record.
 * @param {boolean} [force=false] - Bypass the interval check.
 */
function refreshProjectionImage(record, force = false) {
  const runtime = record?.projection;
  if (!runtime || runtime.mode !== 'image' || !runtime.image) return;
  // Hidden-state gate (perf wave 2): no new frame fetch/decode for a canvas
  // nobody can see. The refresh interval re-fills naturally on return.
  if (typeof document !== 'undefined' && document.hidden && !force) return;
  // Do not replace an in-flight URL on the 10-second refresh boundary. Slow
  // providers otherwise leave cancelled server requests behind and the plane
  // can remain permanently pending. The proxy bounds each attempt; load/error
  // clears this latch so the next normal tick can refresh.
  if (runtime.imageLoading) return;
  const now = Date.now();
  const refreshMs = record.camera.id === _activeCameraId
    ? PROJECTION_ACTIVE_REFRESH_MS
    : PROJECTION_IDLE_REFRESH_MS;
  if (!force && now - runtime.lastImageRefreshAt < refreshMs) return;
  runtime.lastImageRefreshAt = now;

  const frameUrl = frameUrlFor(record.camera, refreshMs);
  const sep = frameUrl.includes('?') ? '&' : '?';
  runtime.imageLoading = true;
  runtime.imageReady = false;
  runtime.image.src = `${frameUrl}${sep}projTs=${Math.floor(now / refreshMs)}`;
}

/**
 * Repaints the projection placeholder at most once per PLACEHOLDER_REPAINT_MS.
 * The projection loop runs at RAF cadence — unthrottled, a pending feed would
 * re-fill the 1080p canvas (gradient + text) on every single frame.
 * @param {Object} record - Camera record.
 * @param {Object} runtime - Projection runtime.
 * @param {Object|null} health - Health state for status text.
 */
function paintPlaceholderThrottled(record, runtime, health) {
  const now = Date.now();
  if (now - safeNumber(runtime.lastPlaceholderPaintAt, 0) < PLACEHOLDER_REPAINT_MS) return;
  runtime.lastPlaceholderPaintAt = now;
  runtime.drawnImageStamp = -1;
  // The placeholder overwrites the canvas, so the last real frame is no longer
  // on it. Drop the signature or an identical frame returning after an outage
  // would be skipped as "unchanged" and leave the placeholder on the plane.
  runtime.lastFrameSignature = null;
  runtime.canvasStamp = (runtime.canvasStamp || 0) + 1;
  paintProjectionPlaceholder(runtime.ctx, record.camera, health);
}

/**
 * Draws the current frame (video or image) onto the projection canvas.
 * Falls back to the placeholder if the media source is not yet ready.
 * Image feeds only repaint when a NEW image finished loading (stamp check):
 * re-blitting an unchanged 1080p image every RAF tick is pure waste since
 * texture uploads are already throttled to 1Hz buffer swaps.
 * @param {Object} record - Camera record with an initialized projection runtime.
 */
function drawProjectionFrame(record) {
  const runtime = record?.projection;
  if (!runtime || !runtime.ctx) return;

  const health = _healthById.get(record.camera.id) || null;

  if (runtime.mode === 'video' && runtime.video) {
    const video = runtime.video;
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      runtime.ctx.clearRect(0, 0, PROJECTION_CANVAS_WIDTH, PROJECTION_CANVAS_HEIGHT);
      runtime.ctx.drawImage(video, 0, 0, PROJECTION_CANVAS_WIDTH, PROJECTION_CANVAS_HEIGHT);
      runtime.canvasStamp = (runtime.canvasStamp || 0) + 1;
      return;
    }
    paintPlaceholderThrottled(record, runtime, health);
    return;
  }

  refreshProjectionImage(record);
  if (runtime.image && runtime.imageReady) {
    if (runtime.drawnImageStamp !== runtime.imageStamp) {
      // The frame URL carries a 10s cache-buster tick, so a fresh Image
      // DECODES every PROJECTION_ACTIVE_REFRESH_MS whether or not the provider
      // actually published a new picture — measured 2026-07-30: a London
      // camera republished once in 5 minutes, an Austin one not at all.
      // Redrawing regardless bumped canvasStamp, which forced a buffer swap
      // and a fresh 1920x1080 texture upload; the plane renders its white
      // base color (planeMaterial color = WHITE, alpha .95) for the frame or
      // two Cesium needs to rebind, which IS the periodic white flash from the
      // field tests (2026-07-04 and 2026-07-30).
      const signature = projectionFrameSignature(runtime);
      runtime.drawnImageStamp = runtime.imageStamp;
      if (signature !== null && signature === runtime.lastFrameSignature) {
        // Identical pixels — leave the canvas, and therefore the bound
        // texture, completely alone. No canvasStamp bump, no swap, no flash.
        return;
      }
      runtime.lastFrameSignature = signature;
      runtime.ctx.clearRect(0, 0, PROJECTION_CANVAS_WIDTH, PROJECTION_CANVAS_HEIGHT);
      runtime.ctx.drawImage(runtime.image, 0, 0, PROJECTION_CANVAS_WIDTH, PROJECTION_CANVAS_HEIGHT);
      runtime.canvasStamp = (runtime.canvasStamp || 0) + 1;
      runtime.lastPlaceholderPaintAt = 0;
    }
    return;
  }
  // A refresh is in flight (imageReady=false): keep the last good frame on
  // the canvas instead of flashing the placeholder. Placeholder only paints
  // when nothing has ever been drawn for this camera.
  if (runtime.drawnImageStamp === -1) {
    paintPlaceholderThrottled(record, runtime, health);
  }
}

/**
 * Starts the requestAnimationFrame loop that drives projection canvas updates
 * (frame draw + texture swap) for the active camera.
 */
/**
 * The projection rAF has real work only while a camera is actively projected
 * or a focus fade is in flight — otherwise it burned a wakeup + style poll
 * every rendered frame for the whole enabled lifetime of the layer. The tick
 * self-stops when idle; every state edge that creates work re-arms it
 * (enable, setActiveCamera, showProjection, focus-target appearance).
 * (perf wave 1)
 * @returns {boolean} Whether the loop currently has work.
 */
function projectionLoopIsNeeded() {
  if (!_enabled || !_viewer) return false;
  if (_showProjection && getActiveRecord()) return true;
  return focusPassIsNeeded(getFocusTarget(), _activeFocusStyleCount);
}

function startProjectionLoop() {
  if (_projectionRaf) return;
  if (!projectionLoopIsNeeded()) return;
  // The armed projection loop uploads video textures / runs focus fades per
  // frame — the scene must render continuously while it runs. Released when
  // the tick self-stops. (perf wave 2)
  holdContinuousRender('cctv-projection');

  const tick = () => {
    if (!_viewer || !projectionLoopIsNeeded()) {
      _projectionRaf = 0;
      releaseContinuousRender('cctv-projection');
      return;
    }

    refreshCctvFocusStyles(performance.now());

    const active = getActiveRecord();
    if (_enabled && _showProjection && active) {
      ensureProjectionRuntime(active);
      if (active.projection?.video) {
        active.projection.video.play().catch(() => {});
      }
      if (active.projection) {
        drawProjectionFrame(active);
        refreshProjectionTextures(active);
      }
    }

    _projectionRaf = requestAnimationFrame(tick);
  };

  _projectionRaf = requestAnimationFrame(tick);
}

/**
 * Focus modulation rides the layer's existing animation loop; no additional
 * scene listener is installed. Only camera-icon alpha changes here — coverage
 * geometry and monitor-plane styling retain their established cadence.
 */
function refreshCctvFocusStyles(nowMs) {
  nowMs = focusNowMs(nowMs);
  const target = getFocusTarget();
  if (!_enabled || !_viewer || !focusPassIsNeeded(target, _activeFocusStyleCount)) return;
  if (nowMs - _lastFocusStyleAt < 80) return;
  _lastFocusStyleAt = nowMs;
  const scene = _viewer.scene;
  const camera = _viewer.camera;
  const result = applyCctvFocusDeemphasis({
    records: _records,
    target,
    previousActiveCount: _activeFocusStyleCount,
    nowMs,
    screenPositionFor: (position) => (
      Cesium.SceneTransforms.worldToWindowCoordinates(scene, position, _scratchFocusScreen)
    ),
    cameraDistanceFor: (position) => Cesium.Cartesian3.distance(camera.positionWC, position),
    baseColorFor: (record) => (
      record.camera.id === _activeCameraId ? ACTIVE_CAMERA_COLOR : IDLE_CAMERA_COLOR
    ),
  });
  _activeFocusStyleCount = result.activeCount;
}

/**
 * Apply the gated CCTV focus pass through the production color path.
 * @param {object} input
 * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
 */
export function applyCctvFocusDeemphasis({
  records,
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
  for (const record of records || []) {
    const bb = record.billboard;
    if (!bb) continue;
    const position = bb.position;
    // CCTV never publishes a tracked focus target, so every icon is ambient.
    const focus = advanceSpriteFocus(bb, {
      // Keep hidden icons in the state/release pass so the active count cannot
      // drop while a stale dim alpha remains waiting to reappear.
      screenPosition: bb.show === false || !position ? null : screenPositionFor(position),
      cameraDistance: position ? cameraDistanceFor(position) : Number.NaN,
      nowMs,
      target,
      params,
      spriteHalfWidthPx: (bb.width || 24) * (bb.scale || 1) * 0.5,
      spriteHalfHeightPx: (bb.height || 24) * (bb.scale || 1) * 0.5,
    });
    transitioning ||= focus.transitioning;
    if (focus.active) activeCount += 1;
    const base = baseColorFor(record);
    const alpha = base.alpha * focus.factor;
    if (focusAlphaNeedsWrite(bb.color?.alpha, alpha, params)) {
      // Order-independent narrow amendment to always-visible icons: CCTV
      // contacts retain a non-zero floor while yielding near the tracked target.
      bb.color = base.withAlpha(alpha);
      writes += 1;
    }
  }
  return { writes, transitioning, activeCount, ran: true };
}

/** Cancels the projection animation loop. */
function stopProjectionLoop() {
  if (_projectionRaf) {
    cancelAnimationFrame(_projectionRaf);
    _projectionRaf = 0;
  }
  releaseContinuousRender('cctv-projection');
}

/**
 * Recomputes the pure frustum geometry from the camera pose + the given ground
 * altitude and writes it into the scene: billboard position, the 5 wireframe
 * polylines (4 corner rays + closed far-plane rectangle), and the monitor
 * plane placement. This is the ONLY place v2 geometry is written — called on
 * slider input / save / activation / the one-shot ground snap, never per frame.
 * @param {Object} record - Camera record.
 * @param {number} groundAltM - Ground altitude at the mount (metres).
 */
function applyFrustumGeometry(record, groundAltM) {
  const geometry = computeFrustumGeometry(record.camera, groundAltM, record.probeClampRangeM);
  const positions = frustumCartesians(geometry);
  record.frustumGeometry = geometry;
  record.frustumPositions = positions;
  record.position = positions.mount;
  record.camera.absoluteHeightM = geometry.mount.alt;
  if (record.billboard) {
    record.billboard.position = positions.mount;
  }
  if (record.coverageEntities?.length >= 5) {
    record.coverageEntities[0].polyline.positions = [positions.mount, positions.tl];
    record.coverageEntities[1].polyline.positions = [positions.mount, positions.tr];
    record.coverageEntities[2].polyline.positions = [positions.mount, positions.br];
    record.coverageEntities[3].polyline.positions = [positions.mount, positions.bl];
    record.coverageEntities[4].polyline.positions = [
      positions.tl, positions.tr, positions.br, positions.bl, positions.tl,
    ];
  }
  // A live viewshed volume tracks its wireframe: rebuild from the SAME fresh
  // positions (weld invariant). Only records currently showing a volume pay
  // this (6 triangles, synchronous — trivial even during slider/gizmo drags).
  // Tint derives from the live active id, not the cached viewshedActiveTint —
  // during an activation switch this runs BEFORE refreshCoverageStyles, and
  // the cache is stale for exactly that window.
  if (record.viewshedPrimitive) {
    rebuildViewshedVolume(record, record.camera.id === _activeCameraId);
  }
  updatePlanePlacement(record);
  // Gizmo handles track the pose they manipulate: refresh when the ACTIVE
  // camera's geometry rewrites (incl. during its own drag).
  if (_gizmo?.isEnabled() && record.camera.id === _activeCameraId) {
    _gizmo.refresh();
  }
}

/**
 * Refreshes a record's frustum geometry with a regime-aware, ONE-SHOT ground
 * resolution (Task 5, spec §2). Per regime:
 *
 *  - `terrain-globe` (any globe stack): `cachedGroundFloor` returns its DEM
 *    floor because mesh floors are regime-disabled. The exact Re:Earth prior
 *    remains the immediate fallback while that coarse cell warms.
 *  - `google-3d` (photoreal): the shared mesh-floor sampler may refine the
 *    DEM cell once, subject to its existing tiles-ready, distance,
 *    camera-height, and acceptance gates. Geometry reads only
 *    `cachedGroundFloor`, never a CCTV-owned point sample.
 *
 * v2 samples ONLY the mount — the far cap hangs in the air off mountAlt. No
 * timer, no deadband: this function is called only from the staggered
 * geometry queue (the enable-time drain + update()'s one-shot tiles-ready
 * completion re-enqueue), from explicit pose-edit call sites, and from the
 * map-stack regime-change handler.
 * @param {Object} record - Camera record.
 * @param {Object} [options={}]
 * @param {boolean} [options.sampleGround=true] - When false, skip shared
 *   mesh-floor refinement and use the cached/prior ground instead.
 */
function updateRecordGeometry(record, options = {}) {
  const sampleGround = options.sampleGround !== false;
  const regime = currentSurfaceRegime();
  const point = { lat: record.camera.lat, lon: record.camera.lon };
  warmGroundFloor([point]);

  if (regime === 'terrain-globe') {
    const cachedFloor = cachedGroundFloor(point.lat, point.lon);
    const ground = Number.isFinite(cachedFloor) ? cachedFloor : groundPriorAltFor(record);
    record.groundSamples['terrain-globe'] = ground;
    record.groundResolved['terrain-globe'] = true;
    applyFrustumGeometry(record, ground);
    return;
  }

  // Photoreal regime. Sampling is delegated to the shared coarse-cell
  // sampler. It remains event-driven, one-shot per cell, and keeps its
  // existing acceptance window; CCTV adds no rooftop rejection policy.
  if (sampleGround && projectionTilesReady()) {
    record.groundMeshSampleRequestCount = (record.groundMeshSampleRequestCount || 0) + 1;
    const viewerCarto = _viewer?.camera?.positionCartographic;
    const excludeObjects = [...(record.coverageEntities || [])];
    if (record.billboard) excludeObjects.push(record.billboard);
    if (record.projection?.planeEntity) excludeObjects.push(record.projection.planeEntity);
    sampleMeshFloorCells(_viewer?.scene, [point], {
      excludeObjects: excludeObjects.filter(Boolean),
      viewerLat: viewerCarto ? Cesium.Math.toDegrees(viewerCarto.latitude) : undefined,
      viewerLon: viewerCarto ? Cesium.Math.toDegrees(viewerCarto.longitude) : undefined,
    });
  }

  const cachedFloor = cachedGroundFloor(point.lat, point.lon);
  const ground = Number.isFinite(cachedFloor)
    ? cachedFloor
    : groundAltFor(record, 'google-3d');
  applyFrustumGeometry(record, ground);

  record.groundResolved['google-3d'] = Number.isFinite(cachedFloor);
  if (Number.isFinite(cachedFloor)) {
    record.groundSamples['google-3d'] = ground;
  }
}

/**
 * Re-arms a record for a fresh one-shot ground resolution after a GENUINE
 * pose change (an explicit user select/move or manual calibration edit).
 * Clears the CURRENT regime's resolved latch so the next real pass in
 * updateRecordGeometry always applies, then the record re-freezes. Never
 * called on a timer.
 *
 * The cached `groundSamples` entries are deliberately KEPT (only the latch is
 * cleared). They are the record's "has ever resolved" memory: the B9c
 * fallback guard in updateRecordGeometry reads the google-3d entry so a
 * rearmed camera whose tiles are mid-stream (e.g. select → flyTo →
 * tilesLoaded false) is not yanked back to prior/catalog heights before its
 * fresh shared floor lands. In the terrain-globe regime the re-arm is
 * effectively free: the next pass re-latches from the DEM/prior with zero
 * scene queries.
 * @param {Object} record - Camera record.
 */
function rearmGroundResolution(record) {
  if (!record) return;
  record.groundResolved[currentSurfaceRegime()] = false;
}

/**
 * Resolves a user-moved ground anchor exactly once at commit. The synchronous
 * pass uses a warm shared floor immediately, or preserves the pre-drag floor
 * while the new cell is cold. A revision and coordinate check prevent an
 * older asynchronous release from rewriting a newer edit.
 * @param {Object} record - Camera record whose lat/lon just committed.
 */
function resolveCommittedGroundAnchor(record) {
  if (!record?.camera) return;
  record.calibrationGroundResolveCount = (record.calibrationGroundResolveCount || 0) + 1;
  const revision = (record.calibrationGroundRevision || 0) + 1;
  record.calibrationGroundRevision = revision;
  const point = { lat: record.camera.lat, lon: record.camera.lon };

  rearmGroundResolution(record);
  updateRecordGeometry(record);
  if (isGroundResolved(record)) return;

  resolveGroundFloorCells([point]).then(() => {
    if (_recordById.get(record.camera.id) !== record) return;
    if (record.calibrationGroundRevision !== revision) return;
    if (record.camera.lat !== point.lat || record.camera.lon !== point.lon) return;
    rearmGroundResolution(record);
    updateRecordGeometry(record);
    refreshCoverageStyles();
    notifyListeners();
  });
}

/**
 * Task 5: batches every catalog camera's coords through the Re:Earth
 * ellipsoidal ground resolver (`/api/gev/terrain/heights` proxy — network-cached,
 * chunked, geoid fallback; NOT a scene query). The catalog's orthometric
 * `groundElevationM` rides along as `sourceOrthometricM` so the geoid
 * fallback chain is meaningful where the catalog value is real (Caltrans).
 * Never rejects — a total failure resolves null and geometry stays on
 * catalog fallbacks (no worse than pre-Task-5).
 * @param {Object[]} catalog - Camera objects (post-ensureCameraPose).
 * @returns {Promise<Array<{ellipsoid:number, source:string}>|null>}
 */
async function resolveGroundPriors(catalog) {
  try {
    const coords = catalog.map((camera) => {
      const ortho = Number(camera.groundElevationM);
      return {
        lat: camera.lat,
        lon: camera.lon,
        ...(Number.isFinite(ortho) ? { sourceOrthometricM: ortho } : {}),
      };
    });
    return await resolveEllipsoidalGround(coords);
  } catch (error) {
    console.warn('[Data:CCTV] ground-prior batch failed (keeping catalog fallbacks):', error?.message || error);
    return null;
  }
}

/**
 * Task 5: applies a LATE-arriving ground-prior batch (init's bounded race
 * lost — cold proxy cache / slow upstream). Pure recomputes only, no scene
 * queries:
 *  - terrain-globe regime: the prior IS the resolution → re-run the
 *    resolution (updateRecordGeometry latches it) for every record.
 *  - google-3d regime: records still awaiting a shared floor move from the
 *    catalog fallback onto the exact prior; records already holding a shared
 *    mesh/DEM floor keep it untouched.
 * Guarded per record against a torn-down/re-inited layer (records are only
 * touched while they are still the live catalog entries).
 * @param {Object[]} records - The record array captured at init time.
 * @param {Array<{ellipsoid:number, source:string}>} priors - Aligned by index.
 */
function applyLateGroundPriors(records, priors) {
  if (!Array.isArray(records) || !Array.isArray(priors)) return;
  let applied = 0;
  for (let i = 0; i < records.length && i < priors.length; i++) {
    const record = records[i];
    const prior = priors[i];
    if (!record || !prior || !Number.isFinite(prior.ellipsoid)) continue;
    // Stale-record guard: init() may have re-run (destroy/init cycle) while
    // the batch was in flight — only touch records still live in the map.
    if (_recordById.get(record.camera.id) !== record) continue;
    record.groundPrior = prior;
    // Keep the cheap pre-enable altitude consistent for records whose
    // geometry hasn't been applied yet (applyFrustumGeometry overwrites it).
    if (!record.frustumPositions) {
      record.camera.absoluteHeightM = prior.ellipsoid + record.camera.mountHeightM;
    }
    const regime = currentSurfaceRegime();
    if (regime === 'terrain-globe') {
      // Prior IS the resolution — re-latch onto the fresh value.
      updateRecordGeometry(record, { sampleGround: false });
      applied += 1;
    } else if (!Number.isFinite(record.groundSamples['google-3d'])) {
      // Still awaiting the shared floor: snap interim geometry onto the exact
      // prior (pure recompute; the shared cell may refine later).
      applyFrustumGeometry(record, prior.ellipsoid);
      applied += 1;
    }
  }
  if (applied) notifyListeners();
}

/**
 * Task 5: surface-regime change handler ('gev:map-stack-changed'
 * CustomEvent, dispatched by main.js from MapStackController.onChange). The
 * surface HEIGHT at a camera differs between regimes (a photogrammetric
 * deck/building-top in google-3d vs bare Re:Earth DEM on globe stacks), so
 * on a REGIME change (photoreal ↔ globe; bing→osm stays 'terrain-globe' and
 * no-ops):
 *  1. every record's geometry recomputes IMMEDIATELY from the new regime's
 *     resolution — cached sample if that regime has one, else the Re:Earth
 *     prior (never blank, zero scene queries);
 *  2. entering google-3d re-arms the one-shot tiles-ready completion latch so
 *     update()'s existing event-driven machinery refines records that never
 *     took their sample, through the same staggered queue.
 * Event-driven only — never called on a timer.
 */
function handleMapStackChanged() {
  if (!_viewer || !_records.length) return;
  const regime = currentSurfaceRegime();
  if (regime === _lastAppliedRegime) return;
  _lastAppliedRegime = regime;

  for (const record of _records) {
    if (regime === 'terrain-globe') {
      // Prior IS the resolution — latch it (zero scene queries).
      record.groundSamples['terrain-globe'] = groundPriorAltFor(record);
      record.groundResolved['terrain-globe'] = true;
    }
    const ground = groundAltFor(record, regime);
    // Skip the entity rewrite when the applied ground already matches (e.g.
    // entering google-3d before any sample: prior → prior is a no-op).
    if (record.frustumGeometry && Math.abs(record.frustumGeometry.groundAltM - ground) < 0.001) {
      continue;
    }
    applyFrustumGeometry(record, ground);
  }

  if (regime === 'google-3d') {
    // Fresh google-3d session: let update()'s ONE-SHOT completion pass
    // re-enqueue records without an accepted sample once the (re-shown)
    // tileset reports tilesLoaded. Records already sampled in a previous
    // google-3d session keep their cached resolution — 0 new samples, well
    // under the ≤1-per-(camera, session) ceiling.
    _tilesReadyReenqueued = false;
  }
  notifyListeners();
}

/**
 * Stops the staggered geometry-load queue and optionally clears progress
 * counters (kept when pausing mid-flight is not needed — we always clear).
 * @param {boolean} [clearProgress=true]
 */
function stopGeometryLoadQueue(clearProgress = true) {
  if (_geoQueueTimer) {
    clearTimeout(_geoQueueTimer);
    _geoQueueTimer = 0;
  }
  _geoQueue = [];
  _geoProgressNotifier = null;
  if (clearProgress) {
    _geoLoading = false;
    _geoLoadTotal = 0;
    _geoLoadDone = 0;
  }
}

/**
 * Creates the notification coalescer used by a staggered geometry drain.
 * Progress emits after roughly 300 ms or ten batches, whichever comes first;
 * finish always emits once even when the last progress tick just fired.
 *
 * @param {Function} notify Notification callback.
 * @param {Object} [options={}] Testable timing options.
 * @param {() => number} [options.now] Monotonic clock returning milliseconds.
 * @param {number} [options.intervalMs] Maximum progress-notification cadence.
 * @param {number} [options.batchLimit] Maximum batches between progress ticks.
 * @returns {{ progress: () => boolean, finish: () => void }} Drain notifier.
 */
export function createGeometryProgressNotifier(notify, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const intervalMs = Number.isFinite(options.intervalMs)
    ? Math.max(0, options.intervalMs)
    : GEO_PROGRESS_NOTIFY_INTERVAL_MS;
  const batchLimit = Number.isFinite(options.batchLimit)
    ? Math.max(1, Math.floor(options.batchLimit))
    : GEO_PROGRESS_NOTIFY_BATCH_LIMIT;
  let lastNotifyAt = now();
  let batchesSinceNotify = 0;

  return {
    progress() {
      batchesSinceNotify += 1;
      const current = now();
      if (current - lastNotifyAt < intervalMs && batchesSinceNotify < batchLimit) {
        return false;
      }
      batchesSinceNotify = 0;
      lastNotifyAt = current;
      notify?.();
      return true;
    },
    finish() {
      batchesSinceNotify = 0;
      lastNotifyAt = now();
      notify?.();
    },
  };
}

/**
 * Processes one geometry-queue batch and routes progress/completion through
 * the callbacks shared by production and the unit drain harness.
 *
 * @param {Object} options Batch inputs.
 * @param {Object[]} options.queue Mutable record queue.
 * @param {number} options.batchSize Maximum records to visit.
 * @param {(record: Object) => void} options.visit Per-record geometry work.
 * @param {() => void} options.progress Coalesced progress publication.
 * @param {() => void} options.complete Unconditional completion publication.
 * @returns {boolean} True when more records remain.
 */
export function processCctvGeometryQueueBatch({
  queue,
  batchSize,
  visit,
  progress,
  complete,
}) {
  const safeQueue = Array.isArray(queue) ? queue : [];
  const take = Number.isFinite(batchSize) ? Math.max(1, Math.floor(batchSize)) : 1;
  const batch = safeQueue.splice(0, take);
  for (const record of batch) visit?.(record);
  if (safeQueue.length) {
    progress?.();
    return true;
  }
  complete?.();
  return false;
}

/**
 * Selects per-batch geometry-drain pacing from current camera ownership.
 * Called for every batch so releasing tracking immediately restores normal
 * throughput without restarting the queue.
 *
 * @param {Object} [ownership={}] Current camera-ownership state.
 * @param {*} [ownership.trackedEntity] Cesium tracked entity, if any.
 * @param {boolean} [ownership.cockpitActive] Whether cockpit owns the camera.
 * @returns {{ batchSize: number, delayMs: number }} Drain pacing.
 */
export function cctvGeometryDrainPacing({ trackedEntity = null, cockpitActive = false } = {}) {
  if (trackedEntity || cockpitActive) {
    return { batchSize: GEO_TRACKING_BATCH_SIZE, delayMs: GEO_TRACKING_BATCH_DELAY_MS };
  }
  return { batchSize: GEO_LOAD_BATCH_SIZE, delayMs: GEO_LOAD_BATCH_DELAY_MS };
}

/**
 * Processes one tracking-aware geometry-drain batch. Ownership is read inside
 * every call so a mid-drain tracking/cockpit transition changes the very next
 * batch's size and delay.
 *
 * @param {Object} options Batch inputs.
 * @param {Object[]} options.queue Mutable record queue.
 * @param {() => Object} [options.readOwnership] Current camera ownership.
 * @param {(record: Object) => void} options.visit Per-record geometry work.
 * @param {() => void} options.progress Coalesced progress publication.
 * @param {() => void} options.complete Unconditional completion publication.
 * @returns {{ hasMore: boolean, batchSize: number, delayMs: number }} Batch result and pacing.
 */
export function processCctvGeometryDrainBatch({
  queue,
  readOwnership,
  visit,
  progress,
  complete,
}) {
  const pacing = cctvGeometryDrainPacing(readOwnership?.() || {});
  const hasMore = processCctvGeometryQueueBatch({
    queue,
    batchSize: pacing.batchSize,
    visit,
    progress,
    complete,
  });
  return { hasMore, ...pacing };
}

/**
 * Moves the current active record to the front of a live drain queue.
 * @param {Object[]} queue Mutable geometry queue.
 * @param {Object|null} activeRecord Current active CCTV record.
 * @returns {boolean} Whether the queue order changed.
 */
export function prioritizeActiveCctvGeometryRecord(queue, activeRecord) {
  if (!Array.isArray(queue) || !activeRecord) return false;
  const index = queue.indexOf(activeRecord);
  if (index <= 0) return false;
  queue.splice(index, 1);
  queue.unshift(activeRecord);
  return true;
}

/**
 * Processes one batch (GEO_LOAD_BATCH_SIZE records) of the geometry queue:
 * full ground-sampled coverage geometry per record, then yields back to the
 * event loop before the next batch so tile rendering never stalls. When the
 * initial-load pass completes it clears the loading flag and refreshes styles.
 */
export function processGeometryBatch() {
  _geoQueueTimer = 0;
  if (!_viewer) {
    stopGeometryLoadQueue();
    return;
  }
  // Active-camera-first is re-established every batch because the operator
  // can select a new camera while a long catalog drain is in flight.
  prioritizeActiveCctvGeometryRecord(_geoQueue, getActiveRecord());
  const batchResult = processCctvGeometryDrainBatch({
    queue: _geoQueue,
    readOwnership: () => ({
      trackedEntity: _viewer.trackedEntity,
      cockpitActive: typeof document !== 'undefined'
        && document.body?.classList.contains('cockpit-mode'),
    }),
    visit: (record) => {
      try {
        updateRecordGeometry(record);
      } catch (err) {
        console.warn('[Data:CCTV] geometry refresh error:', err?.message || err);
      }
      if (_geoLoading && _geoLoadDone < _geoLoadTotal) {
        _geoLoadDone += 1;
      }
    },
    progress: () => _geoProgressNotifier?.progress(),
    complete: () => {
      const wasInitialLoad = _geoLoading;
      _geoLoading = false;
      if (wasInitialLoad) {
        _geoLoadDone = _geoLoadTotal;
        if (_enabled) {
          refreshCoverageStyles();
          // Geometry refinement may have replaced record.position objects — the
          // one-shot drain completion re-anchors the card entries (event-driven,
          // not a per-frame or timer pass).
          refreshAmbientCards();
        }
      }
      // Completion is never coalesced: subscribers must observe the final
      // loading state even if the last progress tick just happened.
      _geoProgressNotifier?.finish();
      _geoProgressNotifier = null;
    },
  });
  if (batchResult.hasMore) {
    _geoQueueTimer = setTimeout(processGeometryBatch, batchResult.delayMs);
    return;
  }
}

/**
 * Appends records to the geometry queue (no progress tracking) and starts
 * the batch timer if idle. Used by update()'s ONE-SHOT tiles-ready completion
 * pass (records left `!groundResolved` by an enable-time drain that ran while
 * tiles were still streaming) so it shares the same stagger machinery as the
 * initial load. Fires at most once per enable — never on a recurring timer.
 * @param {Object[]} records - Camera records needing geometry refresh.
 */
function enqueueGeometryRefresh(records) {
  for (const record of records) {
    if (!_geoQueue.includes(record)) {
      _geoQueue.push(record);
    }
  }
  if (!_geoQueueTimer && _geoQueue.length) {
    _geoProgressNotifier = createGeometryProgressNotifier(notifyListeners);
    _geoQueueTimer = setTimeout(processGeometryBatch, 0);
  }
}

/**
 * Starts the initial staggered load: orders all records active-camera-first,
 * then by distance from the current viewer position (nearest first, so
 * cameras likely in view refine before off-screen ones), and exposes
 * loaded/total progress through uiState()/getStats() while running.
 */
function startGeometryLoadQueue() {
  stopGeometryLoadQueue();
  // Fresh drain → fresh one-shot completion pass: re-arm the tiles-ready
  // latch so update() can complete any records this drain leaves unresolved.
  _tilesReadyReenqueued = false;
  if (!_records.length) return;
  const active = getActiveRecord();
  const carto = _viewer?.camera?.positionCartographic;
  const refLat = carto ? Cesium.Math.toDegrees(carto.latitude) : (active?.camera.lat ?? 0);
  const refLon = carto ? Cesium.Math.toDegrees(carto.longitude) : (active?.camera.lon ?? 0);
  const pending = _records
    .filter((record) => record !== active)
    .map((record) => ({
      record,
      distKm: haversineKm(refLat, refLon, record.camera.lat, record.camera.lon),
    }))
    .sort((a, b) => a.distKm - b.distKm)
    .map((entry) => entry.record);
  _geoQueue = active ? [active, ...pending] : pending;
  _geoLoadTotal = _geoQueue.length;
  _geoLoadDone = 0;
  _geoLoading = true;
  _geoProgressNotifier = createGeometryProgressNotifier(notifyListeners);
  _geoQueueTimer = setTimeout(processGeometryBatch, 0);
}

/**
 * Returns the camera record for the currently active camera. A stale ID falls
 * back to the first record, but an intentional null remains an honest
 * deselected state.
 * @returns {Object|null} Active camera record, or null when none is active.
 */
function getActiveRecord() {
  if (!_activeCameraId) return null;
  if (_recordById.has(_activeCameraId)) {
    return _recordById.get(_activeCameraId);
  }
  // Sync _activeCameraId when falling back to first record to prevent ID mismatch
  const fallback = _records[0] || null;
  if (fallback && fallback.camera?.id) {
    _activeCameraId = fallback.camera.id;
  }
  return fallback;
}

/**
 * Pauses video playback on all non-active camera projections and resumes
 * the active one (if projection is enabled).
 * @param {string|null} activeId - ID of the currently active camera.
 */
function pauseInactiveProjectionFeeds(activeId) {
  for (const record of _records) {
    if (!record.projection?.video) continue;
    if (record.camera.id === activeId && _enabled && _showProjection) {
      record.projection.video.play().catch(() => {});
    } else {
      record.projection.video.pause();
    }
  }
}

/**
 * Determines which camera coverage overlays should be visible based on
 * proximity to the active camera. Limits visibility to
 * COVERAGE_NEIGHBOR_LIMIT cameras within COVERAGE_NEIGHBOR_RADIUS_KM.
 * @param {Object|null} activeRecord - The active camera record.
 * @returns {Set<string>} Set of visible camera IDs.
 */
function buildCoverageVisibleSet(activeRecord) {
  if (!_records.length) return new Set();
  // Coverage emphasis is relative to a selected camera. Without one, do not
  // invent an arbitrary catalog-order cohort.
  if (!activeRecord) return new Set();

  const ranked = _records.map((record) => {
    if (record === activeRecord) {
      return { record, distKm: -1 };
    }
    return {
      record,
      distKm: haversineKm(
        activeRecord.camera.lat,
        activeRecord.camera.lon,
        record.camera.lat,
        record.camera.lon
      ),
    };
  });

  ranked.sort((a, b) => a.distKm - b.distKm);

  const primary = ranked.filter((entry) => entry.distKm <= COVERAGE_NEIGHBOR_RADIUS_KM || entry.distKm === -1);
  const fallback = ranked;
  const chosen = (primary.length >= COVERAGE_NEIGHBOR_LIMIT ? primary : fallback)
    .slice(0, COVERAGE_NEIGHBOR_LIMIT)
    .map((entry) => entry.record.camera.id);
  return new Set(chosen);
}

/**
 * Removes (and destroys) a record's viewshed volume primitive, if any.
 * @param {Object} record - Camera record.
 */
function destroyViewshedVolume(record) {
  if (!record) return;
  if (record.viewshedPrimitive && _viewer) {
    _viewer.scene.primitives.remove(record.viewshedPrimitive);
  }
  record.viewshedPrimitive = null;
}

/**
 * (Re)builds a record's translucent viewshed volume from its CURRENT
 * frustumPositions — the same 5 Cartesians the wireframe draws, so the volume
 * is welded to the cone by construction. Called only where the wireframe
 * already rewrites (style refresh on mode/visible-set/active changes,
 * applyFrustumGeometry on pose edits) — no new update cadence, zero scene
 * queries (viewshed design §3b).
 * @param {Object} record - Camera record.
 * @param {boolean} isActive - Active camera gets the brighter fill.
 */
function rebuildViewshedVolume(record, isActive) {
  destroyViewshedVolume(record);
  if (!_viewer || !record?.frustumPositions || !record.viewshedColors) return;
  const color = isActive ? record.viewshedColors.fillActive : record.viewshedColors.fill;
  const primitive = createFrustumVolumePrimitive(record.frustumPositions, color);
  // QA tag: the harness counts viewshed volumes by this marker.
  primitive._gevViewshed = record.camera.id;
  record.viewshedPrimitive = _viewer.scene.primitives.add(primitive);
  record.viewshedActiveTint = !!isActive;
}

/**
 * Updates visual styles (colors, widths, visibility) for all camera billboards,
 * coverage polylines, viewshed volumes, and projection entities based on which
 * camera is active, whether the layer is enabled, and the current
 * coverage-mode/projection toggle states.
 */
/**
 * Field-test fix (2026-07-06): horizon-culls camera billboards, mirroring the
 * flights layer's EllipsoidalOccluder pass. With the Cesium globe hidden
 * (Google-3D regime) nothing writes far-side depth, and the billboards are now
 * always-on-top (`disableDepthTestDistance: INFINITY` — the far-zoom submerge
 * fix), so without this pass London's cluster would shine through the planet
 * from a US viewpoint. Pure math over ≤ catalog-size points; runs on
 * camera.moveEnd + init only (event-driven — no steady-state work).
 */
function refreshHorizonCulling() {
  if (!_viewer || _viewer.isDestroyed() || !_records.length) return;
  const occluder = horizonOccluder(_viewer.camera);
  for (const record of _records) {
    const bb = record.billboard;
    if (!bb) continue;
    const visible = occluder.isPointVisible(bb.position);
    if (bb.show !== visible) bb.show = visible;
  }
}

// ---------------------------------------------------------------------------
// Ambient card tier (2026-07-29 design — spec:
// docs/CURRENT-STATE.md)
// ---------------------------------------------------------------------------

/** Returns (creating on demand) the stable frame slot for a camera id. */
function ensureCardFrameSlot(cameraId) {
  let slot = _cardFrameSlots.get(cameraId);
  if (!slot) {
    slot = createFrameSlot();
    _cardFrameSlots.set(cameraId, slot);
  }
  return slot;
}

/**
 * Rebuilds the ambient card selection: horizon + in-view projection of the
 * catalog (pure math — no scene queries), the zoom-budgeted nearest-first
 * LOD pick, greedy screen-space declutter, and the eviction-grace pass that
 * keeps budget-edge cards alive across small camera moves (zero-flicker).
 * Runs on camera.moveEnd, enable, activation change, and the one-shot
 * geometry-drain completion — NEVER per frame. The active camera is excluded
 * from the ambient selection/quota. By default its monitor plane is the sole
 * active representation; the optional protected-card path is applied only by
 * `pushAmbientCardEntries`. Camera icons are never touched here (cards
 * annotate markers, they don't replace them).
 */
function refreshAmbientCards() {
  if (!_enabled || !_viewer || _viewer.isDestroyed() || !_records.length) {
    _cctvOverlayHost.setEntries(CCTV_OVERLAY_SOURCE_ID, [], CCTV_OVERLAY_SOURCE_OPTIONS);
    return;
  }
  const scene = _viewer.scene;
  const carto = _viewer.camera.positionCartographic;
  const viewerLat = carto ? Cesium.Math.toDegrees(carto.latitude) : 0;
  const viewerLon = carto ? Cesium.Math.toDegrees(carto.longitude) : 0;
  // The active camera is excluded from ambient selection ALWAYS (not just
  // after its async activation settles). It is published separately in the
  // protected lane below, and grace never applies to it.
  const activeId = _activeCameraId;
  const occluder = horizonOccluder(_viewer.camera);
  const width = scene.canvas.clientWidth || scene.canvas.width || 0;
  const height = scene.canvas.clientHeight || scene.canvas.height || 0;
  const marginX = width * CARD_VIEW_MARGIN;
  const marginY = height * CARD_VIEW_MARGIN;

  const candidates = [];
  const screenById = new Map();
  for (const record of _records) {
    const id = record.camera.id;
    if (id === activeId || !record.position) continue;
    let inView = false;
    let sx = NaN;
    let sy = NaN;
    if (occluder.isPointVisible(record.position)) {
      const screen = scene.cartesianToCanvasCoordinates(record.position);
      if (screen && Number.isFinite(screen.x) && Number.isFinite(screen.y)
        && screen.x >= -marginX && screen.x <= width + marginX
        && screen.y >= -marginY && screen.y <= height + marginY) {
        inView = true;
        sx = screen.x;
        sy = screen.y;
        screenById.set(id, { sx, sy });
      }
    }
    candidates.push({
      id,
      distanceKm: haversineKm(viewerLat, viewerLon, record.camera.lat, record.camera.lon),
      inView,
      isVideo: isVideoFeedType(normalizeFeedType(record.camera.feedType)),
      sx,
      sy,
    });
  }

  // Field finding 4: current card holders rank with the 20% incumbency
  // distance discount, so a small camera move never batch-swaps the ring.
  // Item C: passing the viewport dims + per-candidate screen anchors routes
  // the budget fill through the screen-distribution grid, so periphery
  // cells hold cards instead of everything clustering at screen center.
  const { cardIds, budgets } = selectCctvLod(candidates, {
    cameraHeightM: carto?.height,
    incumbentIds: _cardIds,
    viewW: width,
    viewH: height,
  });
  // Like the cold-fill burst, card density yields to the staggered geometry
  // drain: painting the raised 20/28/40 budget per frame starves the
  // frame-paced mesh-floor queue on weak GPUs (qa-cctv-v2 N=800 drain-budget
  // regression). During the initial load the budget holds at the low tier;
  // full density arrives the moment the drain completes (which triggers its
  // own refreshAmbientCards pass).
  const cardLimit = _geoLoading
    ? Math.min(budgets.cardLimit, CCTV_AMBIENT_CARD_DRAIN_CAP)
    : budgets.cardLimit;
  const decluttered = declutterCctvCards(
    cardIds
      .filter((id) => screenById.has(id))
      .slice(0, cardLimit)
      .map((id, index) => ({
        id,
        ...screenById.get(id),
        // Priority carrier, not kilometers: declutter sorts ascending on
        // this field, and the selection's order (distribution + incumbency)
        // must survive — a periphery cell-winner must not be re-outranked
        // by central proximity when two anchors contest the min separation.
        distanceKm: index,
      })),
    { limit: cardLimit }
  );
  // Field finding 2: grace must never apply to the active camera — drop any
  // lingering grace entry and keep it out of the retained-card baseline.
  if (activeId) {
    _cardIds.delete(activeId);
    _cardGraceState.delete(activeId);
  }
  const retention = applyEvictionGrace({
    selectedIds: decluttered,
    builtIds: [..._cardIds],
    graceState: _cardGraceState,
    nowMs: Date.now(),
    cardLimit: budgets.cardLimit,
  });
  _cardIds = new Set(retention.keepIds);
  _cardGraceState = retention.graceState;

  // Bounded thumbnail LRU: live cards (grace included) never lose their
  // persisted frame — that persistence IS the no-flicker guarantee. The
  // hover card's slot is protected too while the gesture lasts.
  const keepFrames = new Set(_cardIds);
  if (_hoverCardId) keepFrames.add(_hoverCardId);
  if (_activeCameraCardEnabled && _activeCameraId) keepFrames.add(_activeCameraId);
  const drops = planFrameCachePrune(
    [..._cardFrameSlots].map(([id, slot]) => ({ id, stamp: slot.stamp })),
    keepFrames
  );
  for (const id of drops) _cardFrameSlots.delete(id);

  pushAmbientCardEntries();
}

/**
 * Builds and publishes the card entry list from the current kept set and the
 * hover-summoned pin. The hover entry is budget-exempt and high-priority. The
 * active camera is absent by default; `activeCameraCardEnabled` retains the
 * migrated protected-publication path as an explicit product option. If the
 * LOD selection adopts the hovered camera it remains a normal budgeted entry
 * that keeps the pin while the gesture lasts.
 */
function pushAmbientCardEntries() {
  const entries = [];
  let rank = 0;
  const push = (id, { pinned = false, active = false } = {}) => {
    const record = _recordById.get(id);
    if (!record?.position) return;
    entries.push(createCctvThumbnailOverlayEntry({
      id,
      position: record.position,
      gapPx: CARD_GAP_PX,
      title: record.camera.name,
      frameSlot: ensureCardFrameSlot(id),
      rank: rank++,
      pinned,
      active,
    }));
  };
  for (const id of _cardIds) push(id, { pinned: id === _hoverCardId });
  if (_hoverCardId && !_cardIds.has(_hoverCardId) && _hoverCardId !== _activeCameraId) {
    push(_hoverCardId, { pinned: true });
  }
  if (_activeCameraCardEnabled && _activeCameraId) {
    push(_activeCameraId, { active: true });
  }
  _cctvOverlayHost.setEntries(
    CCTV_OVERLAY_SOURCE_ID,
    entries,
    CCTV_OVERLAY_SOURCE_OPTIONS,
  );
}

/**
 * Throttled MOUSE_MOVE hover pass (follow-up round 2, item B): pointing at a
 * camera icon that has no card summons its card immediately. This is
 * EVENT-DRIVEN picking on a user gesture, not steady-state work — the
 * ≥120 ms throttle caps it at ~8 scene.pick calls/s while the pointer is
 * actually moving (a still pointer costs nothing), so it can never approach
 * per-frame cost. Skipped while the camera is in motion, while ADJUST mode
 * owns the pointer (gizmo drags), and while the layer is disabled.
 * @param {Cesium.Cartesian2} position - Pointer position (CSS px).
 */
function handleHoverMove(position) {
  if (!_enabled || _cameraMoving || _calibrationMode || !position) return;
  if (!_viewer || _viewer.isDestroyed()) return;
  const now = Date.now();
  if (now - _hoverLastPickAt < HOVER_PICK_THROTTLE_MS) return;
  _hoverLastPickAt = now;
  let picked = null;
  try {
    picked = _viewer.scene.pick(position);
  } catch {
    picked = null;
  }
  const cameraId = extractPickedCameraId(picked);
  if (cameraId && cameraId === _hoverCardId) {
    // Still on the hovered camera — keep the card alive.
    cancelHoverRelease();
    return;
  }
  const record = cameraId ? _recordById.get(cameraId) : null;
  // Hovering the active camera or a camera that already has a card is a
  // no-op; video feeds stay icon-only until activated (ambient tier is
  // stills-only — same rule as the LOD selection).
  const eligible = !!record
    && cameraId !== _activeCameraId
    && !_cardIds.has(cameraId)
    && !isVideoFeedType(normalizeFeedType(record.camera.feedType));
  if (eligible) {
    cancelHoverRelease();
    _hoverCardId = cameraId;
    // Immediacy: the pinned entry publishes now — chrome may paint before
    // the first frame arrives (documented exception in cctvCards.js).
    pushAmbientCardEntries();
    hoverFetchCardFrame(record);
  } else if (_hoverCardId) {
    // Pointer left the hovered icon: linger ~1 s, then release.
    scheduleHoverRelease();
  }
}

/** Cancels a pending hover-card release. */
function cancelHoverRelease() {
  if (_hoverReleaseTimer) {
    clearTimeout(_hoverReleaseTimer);
    _hoverReleaseTimer = 0;
  }
}

/**
 * Schedules the hover card's release ~1 s after unhover. On release the pin
 * drops; the card stays only if the LOD selection has adopted the camera
 * (it is then a normal budgeted entry in `_cardIds`).
 */
function scheduleHoverRelease() {
  if (_hoverReleaseTimer) return;
  _hoverReleaseTimer = setTimeout(() => {
    _hoverReleaseTimer = 0;
    _hoverCardId = null;
    pushAmbientCardEntries();
  }, HOVER_RELEASE_MS);
}

/** Clears the hover-card state (teardown / activation of the hovered camera). */
function clearHoverCard() {
  cancelHoverRelease();
  _hoverCardId = null;
  _hoverLastPickAt = 0;
}

/**
 * Fast-tracked frame fetch for the hover-summoned card: launches
 * immediately, bypassing the pacer's launch-spacing gate (a single
 * user-gesture fetch is fine even during the geometry drain), but still
 * respecting the per-camera failure backoff / freshness check
 * (frameFetchDue), the no-double-fetch pending set, and the burst in-flight
 * cap of 4.
 * @param {Object} record - The hovered camera's record.
 */
function hoverFetchCardFrame(record) {
  const cameraId = record.camera.id;
  if (_cardFetchPendingIds.has(cameraId)) return;
  if (_cardFetchInFlightCount >= CCTV_CARD_FETCH_BURST_LIMIT) return;
  const slot = ensureCardFrameSlot(cameraId);
  const refreshMs = staticFrameRefreshMs(record.camera);
  if (!frameFetchDue(slot, refreshMs, Date.now())) return;
  fetchCardFrame(record, slot, refreshMs, { userGesture: true });
}

/**
 * Card-frame pacer tick (field finding 3): launches AT MOST one fetch per
 * tick, with cardFetchPolicy deciding whether a launch is allowed. Cold fill
 * — any selected card still missing its FIRST frame — bursts up to 4
 * in-flight fetches at 250 ms spacing so arriving in a new area populates
 * in a few seconds instead of 16-32 s; once every selected card has a first
 * frame the layer drops back to the salvaged steady-state gate (single
 * flight, one request per second). Priority: frameless cards first in ring
 * order (nearest-first — they're what makes a card appear at all), then the
 * stalest refresh-overdue card by its source cadence (staticFrameRefreshMs).
 * Failures back off per camera (frameFetchDue) instead of hammering a dead
 * source, so a dead upstream never eats the burst slots.
 */
function cardFrameTick() {
  if (!_enabled || (!_cardIds.size && !(_activeCameraCardEnabled && _activeCameraId))) return;
  const now = Date.now();
  let frameless = null;
  let stalest = null;
  let coldFill = false;
  const consider = (id) => {
    const record = _recordById.get(id);
    if (!record) return;
    const slot = ensureCardFrameSlot(id);
    if (_cardFetchPendingIds.has(id)) {
      // An in-flight first-frame fetch keeps cold-fill mode active without
      // being re-launchable.
      if (!(slot.stamp > 0)) coldFill = true;
      return;
    }
    const refreshMs = staticFrameRefreshMs(record.camera);
    if (!frameFetchDue(slot, refreshMs, now)) return;
    if (!(slot.stamp > 0)) {
      coldFill = true;
      if (!frameless) frameless = { record, slot, refreshMs };
      return;
    }
    if (!stalest || slot.stamp < stalest.slot.stamp) {
      stalest = { record, slot, refreshMs };
    }
  };
  // The optional protected active card stays outside the 40-card ambient
  // quota and uses the same source-owned pacing/retry/cache lifecycle.
  if (_activeCameraCardEnabled && _activeCameraId) consider(_activeCameraId);
  for (const id of _cardIds) consider(id);
  const policy = cardFetchPolicy({
    // The cold-fill burst yields to the staggered geometry drain: 4 concurrent
    // image fetch+decodes mid-drain starve the mesh-floor queue on weak GPUs
    // (qa-cctv-v2 drain-budget regression). Steady 1/s trickle still runs;
    // the burst fires the moment the drain completes.
    coldFill: coldFill && !_geoLoading,
    inFlight: _cardFetchInFlightCount,
    sinceLastLaunchMs: _cardLastFetchAt > 0 ? now - _cardLastFetchAt : Infinity,
  });
  _cardFetchMode = policy.mode;
  if (!policy.launch) return;
  const pick = frameless || stalest;
  if (pick) fetchCardFrame(pick.record, pick.slot, pick.refreshMs);
}

/**
 * Fetches one paced static frame and settles it into the stable slot via the
 * pure persistence rule (applyFrameResult): success replaces the thumbnail,
 * failure leaves the drawn frame untouched. The frame is downscaled once
 * into a 2x-thumb offscreen canvas; the renderer reads the slot live.
 * @param {Object} record - Camera record.
 * @param {Object} slot - The camera's stable frame slot.
 * @param {number} refreshMs - Source cadence (also keys the frame-URL tick).
 * @param {Object} [options]
 * @param {boolean} [options.userGesture] - Hover fast-track (item B): the
 *   launch bypasses the pacer gate, so its spacing sample would pollute the
 *   pacing telemetry — skip the min-spacing sample only. The launch still
 *   stamps `_cardLastFetchAt`, so the pacer waits a full interval after it.
 */
function fetchCardFrame(record, slot, refreshMs, { userGesture = false } = {}) {
  if (typeof document !== 'undefined' && document.hidden && !userGesture) return;
  const now = Date.now();
  const cameraId = record.camera.id;
  _cardFetchInFlightCount += 1;
  _cardFetchPendingIds.add(cameraId);
  if (_cardLastFetchAt > 0 && !userGesture) {
    const spacing = now - _cardLastFetchAt;
    // NOTE: cold-fill bursts legitimately push this to ~250 ms — read it
    // together with the ambientCards.fetchMode telemetry.
    _cardMinFetchSpacingMs = _cardMinFetchSpacingMs == null
      ? spacing
      : Math.min(_cardMinFetchSpacingMs, spacing);
  }
  _cardLastFetchAt = now;
  _cardFetchCount += 1;

  const image = new Image();
  _cardFetchImages.add(image);
  const settle = (ok) => {
    image.onload = null;
    image.onerror = null;
    if (_cardFetchImages.delete(image)) {
      _cardFetchInFlightCount = Math.max(0, _cardFetchInFlightCount - 1);
      _cardFetchPendingIds.delete(cameraId);
    }
    let frame = null;
    if (ok) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = CCTV_FRAME_CANVAS_W;
        canvas.height = CCTV_FRAME_CANVAS_H;
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        frame = canvas;
      } catch {
        frame = null;
      }
    }
    Object.assign(slot, applyFrameResult(slot, { ok: !!frame, frame }, Date.now()));
    _viewer?.scene?.requestRender?.();
  };
  image.onload = () => settle(true);
  image.onerror = () => settle(false);
  image.src = frameUrlFor(record.camera, refreshMs);
}

/** Starts the card-frame pacer (idempotent; policy-gated per tick). */
function startCardFrameLoop() {
  if (_cardFetchTimer) return;
  _cardFetchTimer = setInterval(cardFrameTick, CARD_FETCH_TICK_MS);
}

/**
 * Hidden-state gate (perf wave 2): detach in-flight card frame decodes when
 * the document hides — a hidden canvas has no reader, and image decode is
 * the expensive half. New fetches are gated at fetchCardFrame; the steady
 * pacer refills naturally on return. Installed once at module scope.
 */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    for (const image of _cardFetchImages) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute('src');
    }
    _cardFetchImages.clear();
    _cardFetchPendingIds.clear();
    _cardFetchInFlightCount = 0;
  });
}

/** Stops the pacer and detaches all in-flight fetch handlers. */
function stopCardFrameLoop() {
  if (_cardFetchTimer) {
    clearInterval(_cardFetchTimer);
    _cardFetchTimer = 0;
  }
  for (const image of _cardFetchImages) {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
  }
  _cardFetchImages.clear();
  _cardFetchPendingIds.clear();
  _cardFetchInFlightCount = 0;
  _cardFetchMode = 'steady';
}

/**
 * Complete ambient-tier teardown (layer disable/destroy): pacer + in-flight
 * handlers, shared-host source entries, card set, grace state, thumbnail
 * cache, and fetch telemetry. Nothing leaks across a toggle.
 */
function teardownAmbientCards() {
  stopCardFrameLoop();
  _cctvOverlayHost.clearSource(CCTV_OVERLAY_SOURCE_ID);
  _cctvOverlayHost.setVisible(CCTV_OVERLAY_SOURCE_ID, false);
  clearHoverCard();
  _cameraMoving = false;
  _cardIds = new Set();
  _cardGraceState = new Map();
  _cardFrameSlots = new Map();
  _cardFetchCount = 0;
  _cardLastFetchAt = 0;
  _cardMinFetchSpacingMs = null;
}

/**
 * Hides every per-record CCTV visual without recomputing coverage membership or
 * styles. Disabling makes every visibility branch false, so a direct sweep is
 * sufficient; live viewshed primitives still require explicit destruction.
 *
 * @param {Object[]} records CCTV runtime records.
 * @param {(record: Object) => void} destroyVolume Viewshed teardown callback.
 * @param {string|null} [activeCameraId=null] Active camera whose activation probe must be re-armed.
 */
export function hideCctvRecordVisuals(records, destroyVolume, activeCameraId = null) {
  for (const record of Array.isArray(records) ? records : []) {
    if (record) {
      record.probeClampRangeM = null;
      if (record.camera?.id === activeCameraId) record.activationDone = false;
    }
    for (const entity of record?.coverageEntities || []) entity.show = false;
    if (record?.viewshedPrimitive) destroyVolume?.(record);
    if (record?.projection?.planeEntity) record.projection.planeEntity.show = false;
  }
}

function hideCctvVisuals() {
  hideCctvRecordVisuals(_records, destroyViewshedVolume, _activeCameraId);
  clearProjectionOverlay();
  if (_billboards) _billboards.show = false;
  pauseInactiveProjectionFeeds(null);
}

/** Applies coverage visibility/style state and lazily builds eligible sets. */
export function refreshCoverageStyles() {
  const activeRecord = getActiveRecord();
  ensureActiveCoverageEntities(activeRecord);
  const activeId = activeRecord?.camera.id || null;
  const coverageVisible = buildCoverageVisibleSet(activeRecord);
  const coverageOn = _coverageMode !== 'off';
  const viewshedOn = _coverageMode === 'viewshed';
  if (coverageOn) {
    ensureVisibleCoverageEntities(_records, coverageVisible);
  }
  for (const record of _records) {
    const isActive = record.camera.id === activeId;
    if (record.billboard) {
      record.billboard.color = isActive ? ACTIVE_CAMERA_COLOR : IDLE_CAMERA_COLOR;
      record.billboard.scale = isActive ? 1.25 : 1.0;
      // disableDepthTestDistance stays POSITIVE_INFINITY for every billboard
      // (set at creation) — see the field-test far-zoom submerge fix there.
    }

    if (_enabled && _showProjection && isActive) {
      ensureProjectionRuntime(record);
    }
    // One live plane in the world at a time (§2c): only the active camera's
    // far cap carries the monitor plane; idle neighbors get the faint
    // wireframe only.
    const planeShowing = !!(_enabled && _showProjection && isActive);

    const inVisibleSet = coverageVisible.has(record.camera.id);
    for (const entity of record.coverageEntities || []) {
      // The frustum wireframe is part of the projection representation —
      // force it on for the active camera and let it read through geometry
      // via depthFailMaterial (polylines have no disableDepthTestDistance).
      entity.show = !!(_enabled && ((coverageOn && inVisibleSet) || planeShowing));
      if (!entity.polyline) continue;
      // Viewshed mode swaps the cyan/green scheme for the camera's own hue so
      // adjacent cones read as distinct coverage claims (design §3b); the
      // active camera keeps its width/alpha emphasis in both schemes.
      const hue = viewshedOn ? record.viewshedColors : null;
      if (entity._coverageRole === 'cap') {
        entity.polyline.material = hue
          ? (isActive ? hue.lineActive : hue.line)
          : (isActive ? ACTIVE_COVERAGE_CENTER : IDLE_COVERAGE_CENTER_MUTED);
        entity.polyline.width = isActive ? 2.2 : 1.0;
        entity.polyline.depthFailMaterial = planeShowing
          ? (hue ? hue.line.withAlpha(0.26) : ACTIVE_COVERAGE_CENTER_DEPTHFAIL)
          : undefined;
      } else {
        entity.polyline.material = hue
          ? (isActive ? hue.lineActive : hue.line.withAlpha(0.6))
          : (isActive ? ACTIVE_COVERAGE_EDGE : IDLE_COVERAGE_EDGE_MUTED);
        entity.polyline.width = isActive ? 1.8 : 0.9;
        entity.polyline.depthFailMaterial = planeShowing
          ? (hue ? hue.line.withAlpha(0.18) : ACTIVE_COVERAGE_EDGE_DEPTHFAIL)
          : undefined;
      }
    }

    // Viewshed volume lifecycle: exists iff enabled + viewshed mode + in the
    // visible set. Rebuild on active-tint flips (rare); otherwise leave the
    // primitive alone so idle refreshes never churn geometry.
    const wantVolume = !!(_enabled && viewshedOn && inVisibleSet && record.frustumPositions);
    if (wantVolume) {
      if (!record.viewshedPrimitive || record.viewshedActiveTint !== isActive) {
        rebuildViewshedVolume(record, isActive);
      }
    } else if (record.viewshedPrimitive) {
      destroyViewshedVolume(record);
    }

    if (record.projection) {
      setPlaneVisible(record.projection, planeShowing);
    }
  }

  if (_billboards) _billboards.show = !!_enabled;
  pauseInactiveProjectionFeeds(activeId);
}

/**
 * Finds the camera closest to the Cesium viewer's current position.
 * @returns {string|null} Camera ID of the nearest camera, or null.
 */
function nearestCameraIdToViewer() {
  const carto = _viewer?.camera?.positionCartographic;
  if (!carto || !_records.length) return null;
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);

  let best = null;
  for (const record of _records) {
    const distKm = haversineKm(lat, lon, record.camera.lat, record.camera.lon);
    if (!best || distKm < best.distKm) {
      best = { id: record.camera.id, distKm };
    }
  }
  return best?.id || null;
}

/**
 * Counts how many other cameras have overlapping coverage with the target.
 * Overlap is approximated by comparing inter-camera distance against the
 * combined range of both cameras (scaled by 0.92).
 * @param {Object} targetRecord - Camera record to check.
 * @returns {number} Number of overlapping neighbors.
 */
function coverageNeighborCount(targetRecord) {
  if (!targetRecord) return 0;
  let count = 0;
  for (const record of _records) {
    if (record === targetRecord) continue;
    const dKm = haversineKm(
      targetRecord.camera.lat,
      targetRecord.camera.lon,
      record.camera.lat,
      record.camera.lon
    );
    const overlapKm = (targetRecord.camera.rangeM + record.camera.rangeM) / 1000 * 0.92;
    if (dKm <= overlapKm) count++;
  }
  return count;
}

/**
 * Builds a single-line summary string for the active camera, including city,
 * heading, FOV, coverage area, overlap count, projection mode, alignment
 * confidence, source type, and view context.
 * @returns {string} Summary text separated by mid-dots.
 */
function buildSummaryText() {
  const active = getActiveRecord();
  if (!active) {
    return _records.length
      ? `${_records.length} CAMERAS STANDING BY · NO CAMERA SELECTED · CLICK A CAMERA TO ACTIVATE`
      : 'No cameras available in catalog.';
  }

  const area = sectorAreaKm2(active.camera.rangeM, active.camera.fovDeg);
  const overlapCount = coverageNeighborCount(active);
  const viewKey = currentViewContext();
  const viewBand = viewKey.split(':')[0] || 'global';
  const health = _healthById.get(active.camera.id) || null;
  const calBadge = deriveCalBadge(active.camera);

  return [
    `${active.camera.city.toUpperCase()} CCTV`,
    `${active.camera.name.toUpperCase()}`,
    `HDG ${Math.round(active.camera.headingDeg)}°`,
    `FOV ${Math.round(active.camera.fovDeg)}°`,
    `COVERAGE ${area.toFixed(2)}km²`,
    overlapCount > 0 ? `OVERLAP ${overlapCount} cams` : 'ISOLATED VIEW',
    `PROJ ${_showProjection ? 'MONITOR' : 'OFF'}`,
    _coverageMode === 'viewshed' ? 'VIEWSHED' : null,
    `CAL ${calBadge.replace('-', ' ').toUpperCase()}`,
    health?.sourceKind ? `SRC ${String(health.sourceKind).toUpperCase()}` : `SRC ${String(active.camera.feedType || 'image').toUpperCase()}`,
    `${viewBand.toUpperCase()} CONTEXT`,
  ].filter(Boolean).join(' · ');
}

/**
 * Builds a public-facing camera state object for UI consumption.
 * Includes all pose, calibration, CAL badge, projection, and feed metadata.
 * @param {Object} record - Camera record.
 * @param {string|null} [activeId=null] - Active camera ID for the `active` flag.
 * @returns {Object} Public camera state.
 */
function getPublicCameraState(record, activeId = null) {
  const resolvedActiveId = activeId || getActiveRecord()?.camera.id || null;
  const camera = record.camera;
  const health = _healthById.get(camera.id) || null;
  const isActive = camera.id === resolvedActiveId;
  const refreshMs = isActive ? ACTIVE_FRAME_REFRESH_MS : IDLE_FRAME_REFRESH_MS;
  return {
    id: camera.id,
    name: camera.name,
    city: camera.city,
    provider: camera.provider,
    lat: camera.lat,
    lon: camera.lon,
    headingDeg: camera.headingDeg,
    pitchDeg: camera.pitchDeg,
    fovDeg: camera.fovDeg,
    rangeM: camera.rangeM,
    elevationM: camera.absoluteHeightM,
    mountHeightM: camera.mountHeightM,
    active: isActive,
    feedType: camera.feedType,
    sourceKind: health?.sourceKind || camera.sourceKind || (camera.feedConfigured ? 'configured' : 'seed'),
    sourceStatus: health?.status || 'unknown',
    sourceMessage: health?.message || '',
    sourceLabel: health?.label || camera.provider || '',
    calibration: { ...normalizeCalibration(camera.calibration) },
    // Save-gated persistence (design §3e): true while the live pose carries
    // edits that have not been SAVEd (or RESET). Drives the CAL · EDITED chip.
    calDirty: !!record.calDirty,
    // Deterministic QA seam: counts commit-grade anchor resolutions (E/N drag
    // release, numeric E/N edit, or reset), never transient gizmo moves.
    groundResolveCount: record.calibrationGroundResolveCount || 0,
    // Per-record QA seam for proving transient gizmo moves never enter the
    // shared mesh-floor sampler while unrelated catalog cells finish.
    groundMeshSampleRequestCount: record.groundMeshSampleRequestCount || 0,
    // Datum QA seam: expose the immutable Re:Earth ellipsoidal prior
    // separately from the currently applied frustum ground. Google-3D may
    // legitimately refine the latter to the rendered mesh, so callers must
    // not infer the prior by subtracting mount height from live geometry.
    groundPriorM: Number.isFinite(record.groundPrior?.ellipsoid)
      ? record.groundPrior.ellipsoid
      : null,
    intrinsics: camera.intrinsics ? { ...camera.intrinsics } : null,
    extrinsics: camera.extrinsics ? { ...camera.extrinsics } : null,
    anchor: camera.anchor ? { ...camera.anchor } : null,
    // Panel-only trust signal (design §3b, amended by LOCKED §9.2/§9.3): no
    // in-world rendering reads this, no score-based quality math backs it.
    calBadge: deriveCalBadge(camera),
    poseSource: camera.poseSource || null,
    basePose: camera.basePose ? { ...camera.basePose } : null,
    frameUrl: frameUrlFor(camera, refreshMs),
    mediaUrl: mediaUrlFor(camera),
  };
}

/**
 * Assembles the full UI state payload containing layer toggles, camera list,
 * active camera details, summary text, and error state.
 * @returns {Object} Complete UI state for subscribers.
 */
function uiState() {
  const active = getActiveRecord();
  const activeId = active?.camera.id || null;
  const payload = {
    enabled: _enabled,
    // Compat boolean + the full tri-state (viewshed design §3b).
    showCoverage: _coverageMode !== 'off',
    coverageMode: _coverageMode,
    showProjection: _showProjection,
    calibrationMode: _calibrationMode,
    autoHop: _autoHop,
    autoHopSuspended: _autoHopSuspended,
    autoHopSec: _autoHopSec,
    count: _count,
    lastUpdate: _lastUpdate,
    error: _lastError,
    loading: {
      active: _geoLoading,
      loaded: Math.min(_geoLoadDone, _geoLoadTotal),
      total: _geoLoadTotal,
    },
    // Ambient card tier telemetry (QA harnesses assert the fetch pacing —
    // minFrameFetchSpacingMs reads together with fetchMode: cold-fill bursts
    // legitimately reach ~250 ms, steady state stays >=1000 ms).
    ambientCards: {
      count: _cardIds.size,
      limit: CCTV_AMBIENT_CARD_MAX,
      frameFetches: _cardFetchCount,
      minFrameFetchSpacingMs: _cardMinFetchSpacingMs,
      fetchMode: _cardFetchMode,
      fetchesInFlight: _cardFetchInFlightCount,
      // Item B QA seam: the hover-summoned pinned card, if any.
      hoverId: _hoverCardId,
    },
    activeCameraId: activeId,
    activeCamera: active ? getPublicCameraState(active, activeId) : null,
    cameras: _records.map((record) => getPublicCameraState(record, activeId)),
    summary: buildSummaryText(),
  };
  return payload;
}

/** Dispatches the current UI state to all registered subscriber callbacks. */
function notifyListeners() {
  const payload = uiState();
  for (const callback of _listeners) {
    try {
      callback(payload);
    } catch (error) {
      console.warn('[Data:CCTV] listener error:', error);
    }
  }
}

/**
 * Throttled notifyListeners for transient (mid-drag) calibration patches —
 * the panel re-render is DOM-heavy, so live gizmo drags publish state at
 * ≤10 Hz while the in-world geometry still tracks every processed move.
 */
function notifyListenersThrottled() {
  const now = Date.now();
  if (now - _lastTransientNotifyAt < 100) return;
  _lastTransientNotifyAt = now;
  notifyListeners();
}

/**
 * Applies a calibration patch to a record's IN-MEMORY pose (save-gated
 * persistence, design §3e: no localStorage write here — only the explicit
 * `calibration.save` action persists).
 *
 * Transient grade (gizmo mid-drag): recompute pose + frustum geometry only
 * (the cheap v2 path) with throttled notify — no ground re-arm, no frame
 * re-fetch, no store touch.
 * Commit grade (drag end, numeric entry, voice): only an E/N anchor move
 * resolves a new shared floor; all other edits keep the frozen reference.
 *
 * @param {Object} record - Camera record.
 * @param {Object} patch - Partial 7-field calibration (absolute offset values).
 * @param {{transient?: boolean}} [options]
 * @returns {boolean} True when the patch applied.
 */
function applyCalibrationPatch(record, patch, options = {}) {
  if (!record || !patch || typeof patch !== 'object') return false;
  record.camera.calibration = normalizeCalibration({
    ...record.camera.calibration,
    ...patch,
  });
  ensureCameraPose(record.camera);
  // §9.1: touching range takes manual control — clear the activation clamp.
  if ('rangeScale' in patch) {
    record.probeClampRangeM = null;
  }
  const anchorMoved = calibrationPatchMovesAnchor(patch);
  if (options.transient === true && anchorMoved) {
    record.calibrationAnchorDirty = true;
  }
  record.calDirty = true;
  if (options.transient === true) {
    applyFrustumGeometry(record, groundAltFor(record));
    notifyListenersThrottled();
    return true;
  }
  if (anchorMoved) {
    resolveCommittedGroundAnchor(record);
  } else {
    applyFrustumGeometry(record, groundAltFor(record));
  }
  refreshProjectionImage(record, true);
  return true;
}

/**
 * Lazily creates the calibration gizmo controller. The gizmo sees the layer
 * only through these callbacks: it attaches to the active record while the
 * layer is enabled AND ADJUST mode is on, funnels drags through
 * applyCalibrationPatch (transient), and runs the commit tail on release.
 */
function ensureGizmo() {
  if (_gizmo || !_viewer) return;
  // Both patch callbacks receive the gizmo's PINNED drag record — never
  // re-resolve the active camera here: a mid-drag voice select or auto-hop
  // would route the captured offsets onto a camera with a different basePose.
  const liveRecord = (record) => (
    record && _recordById.get(record.camera?.id) === record ? record : null
  );
  _gizmo = createCalibrationGizmo({
    viewer: _viewer,
    getActiveRecord: () => (_enabled && _calibrationMode ? getActiveRecord() : null),
    applyPatch: (patch, draggedRecord) => {
      const record = _enabled && _calibrationMode ? liveRecord(draggedRecord) : null;
      if (record) applyCalibrationPatch(record, patch, { transient: true });
    },
    endPatch: (draggedRecord) => {
      const record = liveRecord(draggedRecord);
      if (!record) return;
      if (record.calibrationAnchorDirty) {
        record.calibrationAnchorDirty = false;
        resolveCommittedGroundAnchor(record);
      } else {
        applyFrustumGeometry(record, groundAltFor(record));
      }
      refreshProjectionImage(record, true);
      refreshCoverageStyles();
      notifyListeners();
    },
  });
}

/**
 * §9.1 activation obstruction probe (LOCKED product rule): on camera
 * ACTIVATION only, fire ONE scene.pickFromRay along the frustum axis
 * (mount → cap-center direction). If it hits the tiles closer than the pose
 * range, clamp the plane's effective range just short of the first hit so the
 * "big and dramatic" true end cap never clips into downtown buildings.
 *
 * This is the ONLY raycast in the whole CCTV subsystem — once per activation,
 * never per-frame (the zero-raycast invariant applies to steady state). The
 * per-camera range slider overrides the clamp: a user-set rangeScale skips the
 * probe entirely. Probe failure/miss keeps the unclamped range.
 * @param {Object} record - Camera record being activated.
 */
function runActivationObstructionProbe(record) {
  record.probeClampRangeM = null;
  const scene = _viewer?.scene;
  if (!scene || typeof scene.pickFromRay !== 'function') return;
  const camera = record.camera;
  const rangeScale = normalizeCalibration(camera.calibration).rangeScale;
  if (Math.abs(rangeScale - 1) > 0.0001) return; // slider overrides the clamp
  try {
    const mountAlt = groundAltFor(record) + camera.mountHeightM;
    const mountPos = Cesium.Cartesian3.fromDegrees(camera.lon, camera.lat, mountAlt);
    const { dir } = frustumFrameEcef(camera, mountPos);
    // Exclude everything the layer itself draws so the probe can only hit the
    // world (3D tiles), not our own billboards/polylines/planes.
    const exclude = [_billboards, ..._coverageEntities];
    for (const runtime of _projectionEntities) {
      if (runtime?.planeEntity) exclude.push(runtime.planeEntity);
    }
    const hit = scene.pickFromRay(new Cesium.Ray(mountPos, dir), exclude);
    if (!hit?.position) return;
    const dist = Cesium.Cartesian3.distance(mountPos, hit.position);
    record.probeClampRangeM = activationProbeClampRange(camera.rangeM, dist);
  } catch {
    // probe failure → keep the unclamped range
  }
}

/**
 * Clears a deactivated camera's temporary obstruction clamp and rewrites its
 * geometry through the normal single-range path.
 * @param {Object|null} record Camera runtime record being deactivated.
 * @param {(record: Object) => void} rewriteGeometry Nominal geometry rewrite.
 * @returns {boolean} Whether a clamp was cleared.
 */
export function clearProbeClampOnDeactivation(record, rewriteGeometry) {
  if (!record || !Number.isFinite(record.probeClampRangeM)) return false;
  record.probeClampRangeM = null;
  rewriteGeometry?.(record);
  return true;
}

/**
 * Reports whether selecting a record must run the full activation path.
 * Disable re-arms the still-active record so its obstruction probe runs again
 * on its next real activation after the temporary clamp is cleared.
 * @param {string} cameraId Requested camera ID.
 * @param {string|null} activeCameraId Current active camera ID.
 * @param {Object|null} record Requested camera runtime record.
 * @returns {boolean} Whether activation work must run.
 */
export function cctvRecordNeedsActivation(cameraId, activeCameraId, record) {
  return cameraId !== activeCameraId || record?.activationDone !== true;
}

/**
 * Bind CCTV activation to clean taps while preserving the layer's hover-move
 * callback on the shared Cesium handler. Drag-like and long-press gestures do
 * not reach camera activation or focus dispatch.
 * @param {Cesium.ScreenSpaceEventHandler|Object} handler - Input handler.
 * @param {(click: Object) => void} onClick - Accepted CCTV click callback.
 * @param {Object} [options] - Gesture test seams and optional onMouseMove hook.
 * @returns {void}
 */
export function bindCctvWorldClickGesture(handler, onClick, options = {}) {
  bindTrackingClickGesture(handler, (click, gesture) => {
    if (!isTrackingClickGesture(gesture)) return;
    onClick(click);
  }, options);
}

/**
 * Sets the active camera by ID, initializes its projection runtime, refreshes
 * its frame, and updates styles.
 * @param {string} cameraId - ID of the camera to activate.
 * @returns {'activated'|'unchanged'|'not-found'} Discriminated activation result.
 */
export function setActiveCamera(cameraId) {
  if (!cameraId || !_recordById.has(cameraId)) return CCTV_ACTIVATION_RESULT.NOT_FOUND;
  const record = _recordById.get(cameraId);
  const previousActiveRecord = getActiveRecord();
  // Re-selecting the already-active camera is a no-op: re-running the
  // activation path re-probes and rewrites the plane entity's geometry, and
  // that async primitive rebuild visibly flashes the monitor plane (owner
  // field test 2026-07-04 — every click ON the plane picks its own camera).
  // `activationDone` distinguishes a real activation from the enable()-time
  // default `_activeCameraId` assignment, which never ran this path.
  if (!cctvRecordNeedsActivation(cameraId, _activeCameraId, record)) {
    return CCTV_ACTIVATION_RESULT.UNCHANGED;
  }
  _activeCameraId = cameraId;
  _autoHopSuspended = false;
  // A real activation creates projection work — wake the self-stopping loop.
  startProjectionLoop();
  if (previousActiveRecord && previousActiveRecord !== record) {
    clearProbeClampOnDeactivation(previousActiveRecord, (previous) => {
      applyFrustumGeometry(previous, groundAltFor(previous));
    });
  }
  // The clicked camera leaves the ambient quota immediately (never graced).
  // Shipped behavior publishes no card for it because the monitor plane is
  // now the active representation; the opt-in protected-card path republishes
  // it synchronously through refreshAmbientCards() below.
  _cardIds.delete(cameraId);
  _cardGraceState.delete(cameraId);
  // Activating the hovered camera consumes the transient pin; the active
  // monitor plane replaces it from this moment.
  if (_hoverCardId === cameraId) clearHoverCard();
  // If the record's geometry refinement is still queued, jump it to the front
  // so the newly active camera resolves before idle neighbors.
  const queueIdx = _geoQueue.indexOf(record);
  if (queueIdx > 0) {
    _geoQueue.splice(queueIdx, 1);
    _geoQueue.unshift(record);
  }
  // §9.1: one obstruction probe per activation, BEFORE the geometry pass so
  // the range clamp lands in the same rewrite. A FIRST-EVER activation (no
  // real ground sample yet) probes from the catalog-prior altitude — if that
  // prior is off, the clamp is measured from a shifted origin, but a
  // re-activation after the one-shot snap lands re-probes from real ground,
  // so it self-corrects.
  runActivationObstructionProbe(record);
  // Coverage is activation-lazy even while the mode is OFF: the active
  // camera's projection representation must be ready without materializing
  // any idle neighbor. The following geometry rewrite welds these entities to
  // the current sampled positions.
  ensureActiveCoverageEntities(record);
  ensureProjectionRuntime(record);
  refreshProjectionImage(record, true);
  // FIX B9b: an explicit user (re)select re-arms one real ground sample for the
  // newly-active camera, then freezes. Idle neighbors keep their resolved state.
  // FIX B9c: if tiles are ready this real pass applies + re-resolves
  // immediately; if tiles are still streaming, updateRecordGeometry's fallback
  // guard recomputes purely from the cached real ground (the pose + the probe
  // clamp above still land — no scene queries) and the record stays unresolved
  // until update()'s one-shot tiles-ready completion pass re-grounds it.
  rearmGroundResolution(record);
  updateRecordGeometry(record);
  record.activationDone = true;
  refreshCoverageStyles();
  // The newly active camera leaves the ambient ring (its monitor plane takes
  // over); the freed slot re-fills on this same pass.
  refreshAmbientCards();
  // ADJUST mode follows the active camera.
  _gizmo?.refresh();
  notifyListeners();
  return CCTV_ACTIVATION_RESULT.ACTIVATED;
}

/**
 * Clears the active CCTV camera in place without moving the viewer or
 * disabling the layer. The normal selection-refresh path releases the active
 * projection, emphasis, and probe state while ambient cards remain available.
 * @returns {boolean} True when a camera was deactivated.
 */
export function deactivateActiveCamera() {
  const record = _activeCameraId ? _recordById.get(_activeCameraId) : null;
  if (!record) return false;
  _activeCameraId = null;
  _autoHopSuspended = true;
  record.activationDone = false;
  clearProbeClampOnDeactivation(record, (previous) => {
    applyFrustumGeometry(previous, groundAltFor(previous));
  });
  refreshCoverageStyles();
  refreshAmbientCards();
  _gizmo?.refresh();
  notifyListeners();
  return true;
}

/**
 * True only for a clean click that is empty from CCTV's perspective: an
 * active camera exists, ADJUST does not own the pointer, and the scene pick
 * carries no canonical object ID. Any identified scene object is non-empty,
 * including selectable siblings that do not participate in the pick registry.
 * @param {Object|null} picked - `scene.pick()` result.
 * @param {Object} [context]
 * @param {string|null} [context.activeCameraId]
 * @param {boolean} [context.calibrationMode]
 * @returns {boolean}
 */
export function cctvEmptyClickDeselects(picked, {
  activeCameraId = null,
  calibrationMode = false,
} = {}) {
  if (!activeCameraId || calibrationMode) return false;
  return resolvePickId(picked) === null;
}

/**
 * Creates the five Cesium polyline entities that visualize a camera's pitched
 * frustum: 4 corner rays (mount → far-plane corner) + the closed far-plane
 * rectangle. Entity ids stay in the `cctv-<id>-<role>` scheme (pick-owner
 * regex depends on it): roles ray-tl / ray-tr / ray-br / ray-bl / cap.
 * @param {Object} record - Camera record.
 * @returns {Cesium.Entity[]} Array of five coverage entities.
 */
function buildCoverageEntities(record) {
  const { camera } = record;
  // Prefer the record's already-refined geometry. Lazy creation commonly
  // happens after the staggered ground pass; recomputing from the catalog
  // prior here would regress the camera to its pre-sampled datum.
  let geometry = record.frustumGeometry;
  let positions = record.frustumPositions;
  if (!geometry || !positions) {
    geometry = computeFrustumGeometry(
      camera,
      groundPriorAltFor(record),
      record.probeClampRangeM
    );
    positions = frustumCartesians(geometry);
    record.frustumGeometry = geometry;
    record.frustumPositions = positions;
    record.position = positions.mount;
  }

  const addPolyline = (role, linePositions) => _viewer.entities.add({
    id: `cctv-${camera.id}-${role}`,
    properties: { cctvCameraId: camera.id },
    polyline: {
      positions: linePositions,
      width: 1.2,
      material: IDLE_COVERAGE_COLOR,
    },
  });

  const entities = [
    addPolyline('ray-tl', [positions.mount, positions.tl]),
    addPolyline('ray-tr', [positions.mount, positions.tr]),
    addPolyline('ray-br', [positions.mount, positions.br]),
    addPolyline('ray-bl', [positions.mount, positions.bl]),
    addPolyline('cap', [positions.tl, positions.tr, positions.br, positions.bl, positions.tl]),
  ];

  entities[0]._coverageRole = 'edge';
  entities[1]._coverageRole = 'edge';
  entities[2]._coverageRole = 'edge';
  entities[3]._coverageRole = 'edge';
  entities[4]._coverageRole = 'cap';
  return entities;
}

/**
 * Materializes coverage entities for eligible records exactly once.
 * The helper is dependency-injected so unit tests can prove the enable policy
 * without constructing Cesium entities.
 *
 * @param {Object[]} records CCTV runtime records.
 * @param {(record: Object) => boolean} [isEligible] Eligibility predicate.
 * @param {(record: Object) => Object[]} buildEntities Coverage builder.
 * @returns {Object[]} Newly created entities across all eligible records.
 */
export function materializeCctvCoverageEntities(
  records,
  isEligible = () => true,
  buildEntities,
) {
  const created = [];
  if (typeof buildEntities !== 'function') return created;
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.coverageEntities?.length || !isEligible(record)) continue;
    const entities = buildEntities(record);
    record.coverageEntities = Array.isArray(entities) ? entities.filter(Boolean) : [];
    created.push(...record.coverageEntities);
  }
  return created;
}

/** Materializes one active camera's coverage set. */
export function materializeCctvActiveCoverageEntities(record, buildEntities) {
  return materializeCctvCoverageEntities([record], () => true, buildEntities);
}

/** Materializes only records in the current coverage-visible ID set. */
export function materializeCctvVisibleCoverageEntities(records, visibleIds, buildEntities) {
  const eligibleIds = visibleIds instanceof Set ? visibleIds : new Set(visibleIds || []);
  return materializeCctvCoverageEntities(
    records,
    (record) => eligibleIds.has(record.camera?.id),
    buildEntities,
  );
}

/** Registers newly built coverage entities with the layer-global collection. */
function registerCoverageEntities(created) {
  _coverageEntities.push(...created);
  return created;
}

function ensureActiveCoverageEntities(record) {
  return registerCoverageEntities(
    materializeCctvActiveCoverageEntities(record, buildCoverageEntities),
  );
}

function ensureVisibleCoverageEntities(records, visibleIds) {
  return registerCoverageEntities(
    materializeCctvVisibleCoverageEntities(records, visibleIds, buildCoverageEntities),
  );
}

/**
 * Extracts a camera ID from a Cesium pick result by checking billboard IDs,
 * primitive IDs, and entity cctvCameraId properties.
 * @param {Object|null} picked - Result from scene.pick().
 * @returns {string|null} Camera ID, or null if the pick is not a CCTV entity.
 */
function extractPickedCameraId(picked) {
  if (!picked) return null;

  const entity = picked.id?.properties ? picked.id : picked.primitive?.id?.properties ? picked.primitive.id : null;
  const maybeProp = entity?.properties?.cctvCameraId;
  if (maybeProp) {
    const value = typeof maybeProp.getValue === 'function'
      ? maybeProp.getValue(Cesium.JulianDate.now())
      : maybeProp;
    const record = typeof value === 'string' ? _recordById.get(value) : null;
    const ownsCoverageEntity = Boolean(record?.coverageEntities?.includes(entity));
    const ownsProjectionEntity = record?.projection?.planeEntity === entity
      || _projectionEntities.some((runtime) => (
        runtime?.cameraId === value && runtime.planeEntity === entity
      ));
    if (record && (ownsCoverageEntity || ownsProjectionEntity)) return value;
  }

  // Camera billboard IDs are intentionally the upstream camera ID, so a
  // sibling may legitimately use the same string. A bare ID match is not
  // ownership proof: require this layer's billboard collection or the exact
  // billboard stored on the record.
  const directId = typeof picked.id === 'string'
    ? picked.id
    : typeof picked.primitive?.id === 'string' ? picked.primitive.id : null;
  const record = directId === null ? null : _recordById.get(directId);
  if (!record) return null;
  return picked.primitive === _billboards || picked.primitive === record.billboard
    ? directId
    : null;
}

/** Test-only seam for the CCTV ownership proof used by the world-click route. */
export function _extractPickedCameraIdForTest(picked) {
  return extractPickedCameraId(picked);
}

/**
 * Removes all coverage entities and projection runtimes from the scene.
 */
function destroyCoverageEntities() {
  if (!_viewer) return;
  for (const entity of _coverageEntities) {
    _viewer.entities.remove(entity);
  }
  _coverageEntities = [];

  for (const record of _records) {
    destroyViewshedVolume(record);
  }

  for (const runtime of _projectionEntities) {
    destroyProjectionRuntime(runtime);
  }
  _projectionEntities = [];
}

/** Resets all module-scoped runtime state to initial values. */
function clearRuntimeState() {
  stopGeometryLoadQueue();
  // Idempotent — also covers a re-init without a prior destroy().
  teardownAmbientCards();
  clearProjectionOverlay();
  _records = [];
  _recordById = new Map();
  _healthById = new Map();
  _count = 0;
  _lastUpdate = null;
  _lastHealthSyncAt = 0;
  _lastError = null;
  _lastFocusStyleAt = 0;
  _activeFocusStyleCount = 0;
  // FIX ①/③: the discovered tileset handle is scene-scoped — drop it so a fresh
  // init re-discovers against the current scene primitives.
  _activeTileset = null;
  // Task 5: the applied-regime tracker is record-set-scoped — a fresh init
  // recomputes it against the then-current scene.
  _lastAppliedRegime = null;
}

/**
 * Primes the minimum module state needed to exercise the production coverage
 * refresh path in unit tests.
 * @param {Object} [options={}] Test state values.
 * @param {Object|null} [options.viewer] Viewer-like entity owner.
 * @param {Object[]} [options.records] Seeded CCTV records.
 * @param {string|null} [options.activeCameraId] Active record id.
 * @param {boolean} [options.enabled=true] Layer enabled state.
 * @param {'off'|'on'|'viewshed'} [options.coverageMode='on'] Coverage mode.
 * @param {boolean} [options.showProjection=false] Projection visibility.
 * @returns {void}
 */
export function _setCctvCoverageStateForTest({
  viewer = null,
  records = [],
  activeCameraId = null,
  enabled = true,
  coverageMode = 'on',
  showProjection = false,
} = {}) {
  _viewer = viewer;
  _records = Array.isArray(records) ? records : [];
  _recordById = new Map(
    _records
      .filter((record) => record?.camera?.id)
      .map((record) => [record.camera.id, record]),
  );
  _coverageEntities = [];
  _projectionEntities = [];
  _billboards = null;
  _activeCameraId = activeCameraId;
  _autoHopSuspended = false;
  _enabled = !!enabled;
  _coverageMode = normalizeCoverageMode(coverageMode, 'on');
  _showProjection = !!showProjection;
}

/**
 * Flies the Cesium viewer camera to frame the specified CCTV camera,
 * looking along its heading from above.
 * @param {Cesium.Viewer|null} viewer Cesium viewer that owns the camera.
 * @param {Object|null} record CCTV camera runtime record.
 * @param {number} [duration=2.2] - Flight duration in seconds.
 * @returns {'focused'|'no-active-camera'|'tracking-holds-view'|'cockpit-active'} Focus result.
 */
export function focusCctvRecord(viewer, record, duration = 2.2) {
  if (!viewer || !record) return CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
  if (typeof document !== 'undefined'
    && document.body?.classList.contains('cockpit-mode')) {
    console.debug('[Data:CCTV] focus ignored while cockpit owns the camera');
    return CCTV_FOCUS_RESULT.COCKPIT_ACTIVE;
  }
  if (viewer.trackedEntity) {
    console.debug('[Data:CCTV] focus ignored while a tracked entity owns the camera');
    return CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW;
  }
  const { camera } = record;
  const range = Math.max(280, camera.rangeM * 1.18);
  viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(record.position, Math.max(40, camera.rangeM * 0.36)),
    {
      offset: new Cesium.HeadingPitchRange(
        toRad(camera.headingDeg),
        toRad(-22),
        range
      ),
      duration: Math.max(0.2, duration || 0),
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    }
  );
  return CCTV_FOCUS_RESULT.FOCUSED;
}

function focusCamera(cameraId, duration = 2.2) {
  return focusCctvRecord(_viewer, _recordById.get(cameraId), duration);
}

/**
 * Advances to the next camera if auto-hop is enabled and the hop interval
 * has elapsed. If the viewer has panned to a new region since the last hop,
 * snaps to the nearest camera instead of cycling sequentially.
 * @param {number} nowMs - Current timestamp in milliseconds.
 */
export function maybeAutoHop(nowMs) {
  if (!_autoHop || _autoHopSuspended || !_enabled || _records.length < 2) return;
  if (nowMs - _lastHopAt < _autoHopSec * 1000) return;

  const viewKey = currentViewContext();
  const viewChanged = viewKey !== _lastViewContext;
  _lastViewContext = viewKey;

  if (viewChanged) {
    const nearest = nearestCameraIdToViewer();
    if (nearest && nearest !== _activeCameraId) {
      // Use setActiveCamera so the full activation path runs (obstruction
      // probe, projection runtime, geometry rewrite) — previously bypassed
      // with a bare assignment
      setActiveCamera(nearest);
      _lastHopAt = nowMs;
      return;
    }
  }

  const nextIdx = cctvCycleIndex(
    _records.findIndex((record) => record.camera.id === _activeCameraId),
    1,
    _records.length,
  );
  setActiveCamera(_records[nextIdx].camera.id);
  _lastHopAt = nowMs;
}

/**
 * Resolves a catalog cycle target, including the explicit no-selection state.
 * NEXT from null selects the first record; PREV selects the last.
 * @param {number} currentIdx
 * @param {number} step
 * @param {number} count
 * @returns {number}
 */
export function cctvCycleIndex(currentIdx, step, count) {
  const total = Number.isFinite(count) ? Math.floor(count) : 0;
  if (total <= 0) return -1;
  const delta = Number.isFinite(step) ? Math.trunc(step) : 1;
  if (!Number.isFinite(currentIdx) || currentIdx < 0) {
    return delta < 0 ? total - 1 : 0;
  }
  return (((Math.floor(currentIdx) + delta) % total) + total) % total;
}

/**
 * Fetches per-camera health status from the backend and updates _healthById.
 * Rate-limited to HEALTH_SYNC_INTERVAL_MS unless forced.
 * @param {boolean} [force=false] - Bypass the interval check.
 */
async function syncHealthState(force = false) {
  const now = Date.now();
  if (!force && now - _lastHealthSyncAt < HEALTH_SYNC_INTERVAL_MS) return;
  _lastHealthSyncAt = now;

  try {
    const resp = await fetch(HEALTH_ENDPOINT, { cache: 'no-store' });
    if (!resp.ok) return;
    const data = await resp.json();
    const rows = Array.isArray(data?.cameras) ? data.cameras : [];
    const next = new Map();
    for (const row of rows) {
      const id = String(row?.id || '').trim();
      if (!id) continue;
      next.set(id, {
        status: String(row.status || '').toLowerCase() || 'unknown',
        sourceKind: String(row.sourceKind || row.feedType || '').toLowerCase(),
        label: String(row.label || row.provider || ''),
        message: String(row.message || ''),
        updatedAt: safeNumber(row.updatedAt, now),
      });
    }
    _healthById = next;
  } catch {
    // keep previous health map
  }
}

// ---------------------------------------------------------------------------
// Exported layer object — standard layer interface + CCTV-specific methods
// ---------------------------------------------------------------------------

/**
 * CCTV data layer implementing the standard layer interface.
 * Manages camera catalog, coverage visualization, the far-cap projection
 * plane, health sync, calibration, and auto-hop.
 */
const cctvLayer = {
  id: 'cctv',
  name: 'CCTV',
  icon: '📹',
  source: 'CCTV + Street View fallback',
  updateInterval: DEFAULT_UPDATE_INTERVAL_MS,

  /**
   * Initializes the CCTV layer: loads camera sources, builds the catalog,
   * restores calibration from localStorage, creates billboards, sets up click
   * handling, and performs initial health sync. Coverage entities stay lazy.
   * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
   */
  async init(viewer) {
    _viewer = viewer;
    clearRuntimeState();
    _enabled = false;
    _activeCameraId = null;
    _autoHopSuspended = false;
    _lastHopAt = 0;
    _lastViewContext = '';
    _calibrationById = loadCalibrationStore();

    _billboards = new Cesium.BillboardCollection();
    _viewer.scene.primitives.add(_billboards);
    registerSpriteCollection('cctv', _billboards);

    const sources = await loadCameraSources();
    const catalogFromSources = buildCatalogFromSources(sources);
    const catalog = catalogFromSources.length ? catalogFromSources : seedCatalog();

    // Viewshed color identity (design §3a): golden-angle hue over the
    // id-SORTED catalog index — deterministic across sessions for a stable
    // catalog, maximally separated for neighboring cameras.
    const hueIndexById = new Map(
      catalog.map((camera) => camera.id).sort().map((id, index) => [id, index])
    );

    for (const camera of catalog) {
      const savedEntry = _calibrationById.get(camera.id);
      if (savedEntry) {
        camera.calibration = normalizeCalibration(savedEntry.values);
        camera.calSource = savedEntry.source;
      }
      ensureCameraPose(camera);
    }

    // Task 5 (height-datum fix): batch ALL camera coords through the Re:Earth
    // ellipsoidal ground-prior resolver (network-cached — NOT a scene query;
    // the catalog's orthometric groundElevationM feeds the geoid fallback
    // chain). Bounded wait: a warm proxy cache resolves in milliseconds, so
    // records are normally built WITH their prior (correct first paint in
    // every regime); a cold/slow upstream loses the race and the batch
    // applies post-hoc via applyLateGroundPriors instead of hanging init.
    const priorsPromise = resolveGroundPriors(catalog);
    const priors = await Promise.race([
      priorsPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), GROUND_PRIOR_INIT_WAIT_MS)),
    ]);

    for (let i = 0; i < catalog.length; i++) {
      const camera = catalog[i];
      // Ellipsoidal ground prior (or null while the batch is still in
      // flight). Geometry falls back to the catalog value only until the
      // batch lands.
      const groundPrior = priors?.[i] || null;
      // Cheap first-pass altitude from the ellipsoidal prior (catalog value
      // only as the pre-prior fallback) — the staggered geometry queue
      // refines with sampled tile heights after enable so the init path
      // never raycasts the scene once per camera.
      const priorGround = Number.isFinite(groundPrior?.ellipsoid)
        ? groundPrior.ellipsoid
        : (Number(camera.groundElevationM) || 0);
      camera.absoluteHeightM = priorGround + camera.mountHeightM;
      const position = Cesium.Cartesian3.fromDegrees(camera.lon, camera.lat, camera.absoluteHeightM);
      const billboard = _billboards.add({
        id: camera.id,
        image: CAMERA_ICON,
        position,
        color: IDLE_CAMERA_COLOR,
        width: 24,
        height: 24,
        // Field-test fix (2026-07-06): always-on-top. The old finite value
        // (1800 m) re-engaged the depth test at far zoom, where the COARSE
        // far-LOD Google-3D mesh sits above the true ground and swallowed
        // ground-anchored icons ("submerged" pills over SF). Far-side-of-globe
        // icons are handled by refreshHorizonCulling() (the flights-layer
        // EllipsoidalOccluder pattern), not by the depth test.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(350, 1.25, 4_000_000, 0.42),
      });

      const record = {
        camera,
        position,
        billboard,
        coverageEntities: [],
        projection: null,
        // Task 5 (height-datum fix): regime-aware ground resolution state.
        //   groundPrior     — { ellipsoid, source } from the Re:Earth batch
        //     (null until a late batch lands). The prior applies in EVERY
        //     regime and is the terrain-globe resolution outright.
        //   groundResolved  — PER-REGIME one-shot latch (regime key →
        //     boolean): true once this record's resolution completed for that
        //     regime; such records are excluded from the completion pass so
        //     their geometry freezes. Re-armed only on a genuine pose change,
        //     explicit user select/move, or a surface-regime change — never
        //     on the 10s timer.
        //   groundSamples   — PER-REGIME resolved ground (regime key →
        //     metres): the accepted one-shot scene sample in google-3d, the
        //     mirrored prior in terrain-globe. Kept across re-arms as the
        //     "has ever resolved" memory for the B9c mid-stream guard.
        //   frustumPositions — cached Cartesians for pure recomputes (so
        //     plane placement never re-derives geometry it already has).
        groundPrior,
        groundResolved: {},
        groundSamples: {},
        frustumGeometry: null,
        frustumPositions: null,
        // §9.1 activation obstruction probe result: effective-range clamp so
        // the far-cap plane never clips into the tiles. Null = unclamped.
        // Reset + re-probed on every activation; cleared when the user takes
        // the range slider (slider overrides the clamp).
        probeClampRangeM: null,
        // Viewshed (design §3a/§3b): per-camera color identity + the volume
        // primitive handle (exists only in viewshed mode for the visible set).
        viewshedColors: viewshedColors(cameraHue(hueIndexById.get(camera.id) ?? 0)),
        viewshedPrimitive: null,
        viewshedActiveTint: false,
      };
      _records.push(record);
      _recordById.set(camera.id, record);
    }

    _count = _records.length;
    if (_records.length > 0) {
      // Projection runtime + first frame fetch are deferred to enable() so
      // initializing the catalog stays render-cheap.
      _activeCameraId = _records[0].camera.id;
    }

    // Task 5: if the prior batch lost init's bounded race, apply it post-hoc
    // when it lands (pure recomputes — applyLateGroundPriors guards against
    // a torn-down/re-inited catalog).
    if (!priors) {
      const initRecords = _records.slice();
      priorsPromise.then((late) => {
        if (late) applyLateGroundPriors(initRecords, late);
      }).catch(() => {});
    }

    // Task 5: track the surface regime the initial geometry was computed for
    // and listen for map-stack changes (main.js re-dispatches
    // MapStackController.onChange as this CustomEvent). The handler compares
    // regimes itself, so 'switching'/'error' emissions and same-regime stack
    // swaps (bing→osm) no-op.
    _lastAppliedRegime = currentSurfaceRegime();
    if (!_mapStackListener && typeof window !== 'undefined') {
      _mapStackListener = () => handleMapStackChanged();
      window.addEventListener('gev:map-stack-changed', _mapStackListener);
    }

    // Field-test fix (2026-07-06): horizon-cull on camera settle (pairs with
    // the billboards' always-on-top depth setting) + one initial pass so the
    // first paint is already culled.
    if (!_horizonCullListener) {
      // Ambient cards piggyback the same settle event: moveEnd-driven
      // reselection only, never per frame (refreshAmbientCards no-ops while
      // the layer is disabled).
      _horizonCullListener = () => {
        _cameraMoving = false;
        refreshHorizonCulling();
        refreshAmbientCards();
      };
      _viewer.camera.moveEnd.addEventListener(_horizonCullListener);
    }
    if (!_moveStartListener) {
      // Item B: hover picking pauses while the camera is in motion.
      _moveStartListener = () => {
        _cameraMoving = true;
      };
      _viewer.camera.moveStart.addEventListener(_moveStartListener);
    }
    refreshHorizonCulling();

    _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
    bindCctvWorldClickGesture(_clickHandler, (click) => {
      if (!_enabled) return;
      const picked = _viewer.scene.pick(click.position);
      const cameraId = extractPickedCameraId(picked);
      if (cameraId) {
        activateCctvCameraFromWorldClick(cameraId, setActiveCamera);
        return;
      }
      // Any identified scene object owns this click even if its layer does not
      // register a shared pick predicate. This keeps selectable siblings ahead
      // of an overlapping CCTV card while ID-less globe/terrain/tile surfaces
      // remain eligible for true empty-space deselection.
      const pickedId = resolvePickId(picked);
      if (pickedId !== null) return;
      // Item A (follow-up round 2): the scene pick found no camera — try the
      // painted ambient cards. The cards canvas is pointer-events:none (this
      // handler owns the events), so a click landing on a card's rect selects
      // its camera exactly like a click on the icon. Cesium click positions
      // and the recorded rects are both CSS px — direct comparison.
      const cardId = _cctvOverlayHost.hitTest(
        click.position.x,
        click.position.y,
        { sourceId: CCTV_OVERLAY_SOURCE_ID },
      )?.entryId;
      if (cardId && _recordById.has(cardId)) {
        activateCctvCameraFromWorldClick(cardId, setActiveCamera);
        return;
      }
      if (cctvEmptyClickDeselects(picked, {
        activeCameraId: _activeCameraId,
        calibrationMode: _calibrationMode,
      })) {
        deactivateActiveCamera();
      }
    }, {
      // Item B: hover summons a card on a cardless camera icon. The gesture
      // classifier owns MOUSE_MOVE too, so chain hover work through its seam
      // instead of replacing the travel accumulator's handler.
      onMouseMove: (movement) => handleHoverMove(movement?.endPosition),
    });

    await syncHealthState(true);
    refreshCoverageStyles();
    notifyListeners();
    restoreSpriteOrder(_viewer);
    console.log('[Data:CCTV] Initialized with', _count, 'cameras');
  },

  /**
   * Enables the layer: shows entities, starts the projection loop, and kicks
   * the staggered geometry-load queue. Heavy work (per-camera ground
   * sampling) is deferred/batched so the frame budget never collapses at
   * enable time.
   */
  enable() {
    _enabled = true;
    _lastUpdate = Date.now();
    // Pick-ownership (H2): camera billboards use the camera id directly;
    // coverage polyline entities use `cctv-<cameraId>-<role>` entity ids.
    registerPickOwner('cctv', (pickedId) => {
      if (_recordById.has(pickedId)) return true;
      if (typeof pickedId === 'string' && pickedId.startsWith(GIZMO_ID_PREFIX)) return true;
      const coverage = /^cctv-(.+)-(?:ray-tl|ray-tr|ray-br|ray-bl|cap|plane|plane-label)$/.exec(pickedId);
      return Boolean(coverage && _recordById.has(coverage[1]));
    });
    if (!_activeCameraId && _records.length) {
      _activeCameraId = _records[0].camera.id;
      _autoHopSuspended = false;
    }
    const activeRecord = getActiveRecord();
    if (activeRecord) {
      ensureProjectionRuntime(activeRecord);
      refreshProjectionImage(activeRecord, true);
    }
    startGeometryLoadQueue();
    refreshCoverageStyles();
    startProjectionLoop();
    // The projection loop self-stops when idle; a focus target appearing
    // (user starts tracking a contact) is the one edge it can't see while
    // stopped, so re-arm on it. Removed on disable.
    _removeFocusAppearListener?.();
    _removeFocusAppearListener = onFocusTargetAppear(() => startProjectionLoop());
    // Ambient card tier: shared host source + policy-gated frame pacer + the
    // initial selection pass (moveEnd drives every later reselection).
    _cctvOverlayHost.setVisible(CCTV_OVERLAY_SOURCE_ID, true);
    startCardFrameLoop();
    refreshAmbientCards();
    notifyListeners();
    restoreSpriteOrder(_viewer);
  },

  /** Disables the layer: hides entities, stops the projection loop and load queue. */
  disable() {
    _enabled = false;
    unregisterPickOwner('cctv');
    // ADJUST mode does not survive a layer toggle — predictable re-entry.
    _calibrationMode = false;
    releaseContinuousRender('cctv-adjust');
    _gizmo?.setEnabled(false);
    _removeFocusAppearListener?.();
    _removeFocusAppearListener = null;
    stopProjectionLoop();
    stopGeometryLoadQueue();
    // Ambient cards tear down COMPLETELY on disable (product design point 6):
    // source entries, pacer timer, in-flight handlers, and caches.
    teardownAmbientCards();
    hideCctvVisuals();
    notifyListeners();
  },

  /**
   * Periodic update tick: syncs health state and runs auto-hop logic. Ground
   * geometry is NOT resampled here — v2 grounds each camera once via the
   * staggered load queue (see startGeometryLoadQueue/updateRecordGeometry)
   * and never resamples on a timer. The ONE exception is a one-shot
   * completion pass: the enable-time drain can run while 3D tiles are still
   * streaming (each such pass keeps the fabricated catalog height and leaves
   * the record `!groundResolved`), so the FIRST tick that sees
   * projectionTilesReady() re-enqueues those records once — each then takes
   * its single real sample and freezes (design §4). Guarded by a boolean
   * latch (`_tilesReadyReenqueued`), NOT a timer loop: after it fires, no
   * tick ever samples anything again.
   */
  async update() {
    if (!_enabled) return;
    const now = Date.now();
    _lastUpdate = now;
    if (!_tilesReadyReenqueued && projectionTilesReady()) {
      _tilesReadyReenqueued = true;
      // Per-regime resolution (Task 5): only records unresolved for the
      // CURRENT surface regime need the completion pass. On globe stacks
      // projectionTilesReady() is false while a (hidden) Google tileset
      // exists, so this latch effectively fires for the google-3d regime —
      // terrain-globe records resolve from the prior in their drain pass.
      const unresolved = _records.filter((record) => !isGroundResolved(record));
      if (unresolved.length) enqueueGeometryRefresh(unresolved);
    }
    await syncHealthState();
    maybeAutoHop(now);
    notifyListeners();
  },

  /**
   * Tears down the layer: destroys click handler, projection loop, coverage
   * entities, billboards, and clears all runtime state and subscribers.
   * @param {Cesium.Viewer} [viewer] - Viewer instance (falls back to stored ref).
   */
  destroy(viewer) {
    unregisterPickOwner('cctv');
    if (_mapStackListener && typeof window !== 'undefined') {
      window.removeEventListener('gev:map-stack-changed', _mapStackListener);
      _mapStackListener = null;
    }
    const teardownViewer = viewer || _viewer;
    if (_horizonCullListener && teardownViewer?.camera?.moveEnd) {
      teardownViewer.camera.moveEnd.removeEventListener(_horizonCullListener);
      _horizonCullListener = null;
    }
    if (_moveStartListener && teardownViewer?.camera?.moveStart) {
      teardownViewer.camera.moveStart.removeEventListener(_moveStartListener);
      _moveStartListener = null;
    }
    if (_gizmo) {
      _gizmo.destroy();
      _gizmo = null;
    }
    _calibrationMode = false;
    releaseContinuousRender('cctv-adjust');
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    if (teardownViewer?.scene?.screenSpaceCameraController) {
      teardownViewer.scene.screenSpaceCameraController.enableInputs = true;
    }
    stopProjectionLoop();
    stopGeometryLoadQueue();
    teardownAmbientCards();
    destroyCoverageEntities();
    if (_billboards && teardownViewer) {
      teardownViewer.scene.primitives.remove(_billboards);
      _billboards = null;
    }
    clearRuntimeState();
    _viewer = null;
    _enabled = false;
    _activeCameraId = null;
    _autoHopSuspended = false;
    // Clear existing subscribers rather than replacing the Set —
    // replacing would silently orphan any unsubscribe() closures
    _listeners.clear();
  },

  /**
   * Applies runtime parameter changes: coverage/projection toggles, auto-hop
   * settings, camera selection, and calibration patches/resets.
   * @param {Object} [params={}] - Parameter object.
   * @param {boolean} [params.showCoverage] - Back-compat coverage toggle (true→'on', false→'off').
   * @param {'off'|'on'|'viewshed'} [params.coverageMode] - Full coverage-mode API.
   * @param {boolean} [params.showProjection] - Toggle projection overlay visibility.
   * @param {boolean} [params.autoHop] - Enable/disable auto-hop.
   * @param {number} [params.autoHopSec] - Auto-hop interval in seconds.
   * @param {string} [params.selectedCameraId] - Camera ID to activate.
   * @param {Object} [params.calibration] - Calibration config: `patch` edits
   *   the live pose (save-gated — no persistence), `save` persists the current
   *   calibration as manual, `reset` restores the base prior.
   * @param {boolean} [params.calibrationMode] - Toggle the ADJUST gizmo.
   * @param {boolean} [params.focusSelected] - Fly to the active camera.
   * @param {number} [params.focusDurationSec] - Fly-to duration.
   */
  setParams(params = {}) {
    if (typeof params.showCoverage === 'boolean') {
      _coverageMode = normalizeCoverageMode(params.showCoverage, _coverageMode);
    }
    if (typeof params.coverageMode === 'string') {
      _coverageMode = normalizeCoverageMode(params.coverageMode, _coverageMode);
    }
    if (typeof params.showProjection === 'boolean') {
      _showProjection = params.showProjection;
      if (_showProjection) {
        const active = getActiveRecord();
        if (active) ensureProjectionRuntime(active);
        startProjectionLoop();
      }
    }
    if (typeof params.autoHop === 'boolean') {
      _autoHop = params.autoHop;
      if (params.autoHop) _autoHopSuspended = false;
    }
    if (typeof params.autoHopSec === 'number' && Number.isFinite(params.autoHopSec)) {
      _autoHopSec = clamp(Math.round(params.autoHopSec), MIN_AUTO_HOP_SEC, MAX_AUTO_HOP_SEC);
    }
    if (typeof params.selectedCameraId === 'string' && _recordById.has(params.selectedCameraId)) {
      setActiveCamera(params.selectedCameraId);
    }
    if (params.calibration && typeof params.calibration === 'object') {
      const calibrationCfg = params.calibration;
      const targetCameraId = typeof calibrationCfg.cameraId === 'string' && calibrationCfg.cameraId
        ? calibrationCfg.cameraId
        : _activeCameraId;
      const targetRecord = targetCameraId ? _recordById.get(targetCameraId) : null;
      if (targetRecord) {
        if (calibrationCfg.reset) {
          // RESET: back to the base prior, delete the persisted entry, clear
          // the dirty flag (semantics unchanged from v2).
          targetRecord.camera.calibration = normalizeCalibration(DEFAULT_CAMERA_CALIBRATION);
          targetRecord.camera.calSource = null;
          targetRecord.calDirty = false;
          ensureCameraPose(targetRecord.camera);
          _calibrationById.delete(targetCameraId);
          saveCalibrationStore();
          // Reset returns to the base lat/lon, so resolve that anchor once.
          resolveCommittedGroundAnchor(targetRecord);
          refreshProjectionImage(targetRecord, true);
        }
        if (calibrationCfg.patch && typeof calibrationCfg.patch === 'object') {
          // Save-gated persistence (design §3e): a patch edits the LIVE pose
          // only. The store — and the CALIBRATED badge's `calSource` — move
          // exclusively on the explicit `save` action below. (§9.1 range-slider
          // clamp override + B9b re-ground live inside applyCalibrationPatch.)
          applyCalibrationPatch(targetRecord, calibrationCfg.patch);
        }
        if (calibrationCfg.save) {
          // SAVE CAL: persist the current in-memory calibration with manual
          // provenance. Saving an all-default calibration clears the entry
          // (a no-op calibration is not a calibration).
          if (isDefaultCalibration(targetRecord.camera.calibration)) {
            targetRecord.camera.calSource = null;
            _calibrationById.delete(targetCameraId);
          } else {
            targetRecord.camera.calSource = 'manual';
            _calibrationById.set(targetCameraId, {
              values: { ...targetRecord.camera.calibration },
              source: 'manual',
              savedAt: Date.now(),
            });
          }
          targetRecord.calDirty = false;
          saveCalibrationStore();
        }
      }
    }
    if (typeof params.calibrationMode === 'boolean') {
      _calibrationMode = params.calibrationMode;
      if (_calibrationMode) {
        ensureGizmo();
        _gizmo?.setEnabled(true);
        // ADJUST mode: gizmo drags mutate entity geometry from pointer events,
        // which don't trigger renders in requestRenderMode. (perf wave 2)
        holdContinuousRender('cctv-adjust');
      } else {
        releaseContinuousRender('cctv-adjust');
        _gizmo?.setEnabled(false);
      }
    }
    if (params.focusSelected && _activeCameraId) {
      focusCamera(_activeCameraId, Number(params.focusDurationSec) || 1.8);
    }
    refreshCoverageStyles();
    notifyListeners();
  },

  /**
   * Returns the current runtime parameters including toggle states,
   * active camera, and calibration values.
   * @returns {Object}
   */
  getParams() {
    const active = getActiveRecord();
    return {
      showCoverage: _coverageMode !== 'off',
      coverageMode: _coverageMode,
      showProjection: _showProjection,
      calibrationMode: _calibrationMode,
      autoHop: _autoHop,
      autoHopSec: _autoHopSec,
      selectedCameraId: active?.camera.id || null,
      calibration: active?.camera ? {
        cameraId: active.camera.id,
        values: { ...normalizeCalibration(active.camera.calibration) },
      } : null,
    };
  },

  /**
   * Returns a sampled list of camera positions for the detection overlay system.
   * @param {Object} [options={}]
   * @param {number} [options.maxCount] - Maximum number of objects to return.
   * @param {number} [options.seed] - Offset seed for deterministic stride sampling.
   * @returns {{ position: Cesium.Cartesian3, id: string, type: string }[]}
   */
  getDetectableObjects(options = {}) {
    if (!_enabled || _records.length === 0) return [];
    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : _records.length;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    const stride = Math.max(1, Math.ceil(_records.length / maxCount));
    const start = seed % stride;

    const objects = [];
    for (let i = start; i < _records.length; i += stride) {
      const camera = _records[i].camera;
      objects.push({
        position: _records[i].position,
        sourceId: camera.id,
        id: `CAM-${camera.id}`,
        type: 'CAM',
      });
      if (objects.length >= maxCount) break;
    }
    return objects;
  },

  /**
   * Returns basic layer statistics, including initial-load progress while
   * the staggered geometry queue is draining.
   * @returns {{ count: number, lastUpdate: number|null, error: string|null, loading: boolean, loadingLoaded: number, loadingTotal: number }}
   */
  getStats() {
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      error: _lastError,
      loading: _geoLoading,
      loadingLoaded: Math.min(_geoLoadDone, _geoLoadTotal),
      loadingTotal: _geoLoadTotal,
    };
  },

  /**
   * Registers a callback that receives the full UI state on every change.
   * The callback is invoked immediately with the current state.
   * @param {Function} callback - Listener function receiving the UI state object.
   * @returns {Function} Unsubscribe function.
   */
  subscribe(callback) {
    if (typeof callback !== 'function') return () => {};
    _listeners.add(callback);
    callback(uiState());
    return () => {
      _listeners.delete(callback);
    };
  },

  /**
   * Returns the current UI state snapshot without subscribing.
   * @returns {Object}
   */
  getUIState() {
    return uiState();
  },

  /**
   * Opts the active camera into or out of protected thumbnail publication.
   * The default is false: the monitor plane remains the sole active-camera
   * representation while ambient and hover-pinned cards continue unchanged.
   * @param {Object} [options]
   * @param {boolean} [options.activeCameraCardEnabled=false]
   * @returns {{activeCameraCardEnabled:boolean}}
   */
  setCardPresentationOptions(options = {}) {
    return setCctvCardPresentationOptions(options);
  },

  /**
   * Selects a camera by ID and optionally flies to it.
   * @param {string} cameraId - Camera ID to select.
   * @param {Object} [options={}]
   * @param {boolean} [options.focus] - If true, fly the viewer to the camera.
   * @param {number} [options.durationSec] - Fly-to duration in seconds.
   * @returns {boolean} True if the camera was found and selected.
   */
  selectCamera(cameraId, options = {}) {
    const result = setActiveCamera(cameraId);
    if (result === CCTV_ACTIVATION_RESULT.NOT_FOUND) return false;
    if (options.focus) {
      focusCamera(cameraId, options.durationSec || 1.8);
    }
    return true;
  },

  /**
   * Flies the viewer to a specific camera.
   * @param {string} cameraId - Camera ID to focus on.
   * @param {number} [durationSec=2.2] - Flight duration in seconds.
   * @returns {'focused'|'no-active-camera'|'tracking-holds-view'|'cockpit-active'} Focus result.
   */
  focusCamera(cameraId, durationSec = 2.2) {
    return focusCamera(cameraId, durationSec);
  },

  /**
   * Cycles the active camera forward or backward by `step` positions in the catalog.
   * @param {number} [step=1] - Number of positions to advance (negative to go back).
   * @param {Object} [options={}]
   * @param {boolean} [options.focus] - If true, fly to the new camera.
   * @param {number} [options.durationSec] - Fly-to duration in seconds.
   * @returns {string|null} The newly active camera ID, or null if catalog is empty.
   */
  cycleCamera(step = 1, options = {}) {
    if (!_records.length) return null;
    const current = getActiveRecord();
    const nextIdx = cctvCycleIndex(
      _records.findIndex((record) => record === current),
      step,
      _records.length,
    );
    const nextId = _records[nextIdx].camera.id;
    setActiveCamera(nextId);
    if (options.focus) {
      focusCamera(nextId, options.durationSec || 1.8);
    }
    return nextId;
  },

  /**
   * Selects and flies to the camera nearest the current viewer position.
   * @param {Object} [options={}]
   * @param {boolean} [options.focus=true] Whether to fly after selection.
   * @param {number} [options.durationSec] - Fly-to duration in seconds.
   * @returns {string|null} The nearest camera ID, or null if none found.
   */
  focusNearest(options = {}) {
    const nearest = nearestCameraIdToViewer();
    if (!nearest) return null;
    setActiveCamera(nearest);
    if (options.focus !== false) {
      focusCamera(nearest, options.durationSec || 1.8);
    }
    return nearest;
  },
};

export default cctvLayer;
