import * as Cesium from 'cesium';
import { deriveFetchCenter, clampBoundsAroundCenter } from './trafficBounds.js';
import { fetchFlowForBounds, getFlowSessionStats, resetFlowTileCache } from './flowTiles.js';
import { matchFlowToRoads } from './flowMatch.js';
import { flowBucket, flowSpeedScale, flowDensityMult } from './trafficFlowStyle.js';
import {
  trafficStyleProfile,
  presetDotRgba,
  presetSizeDelta,
  presetDotOutline,
  trafficBucketTier,
} from './trafficPresetStyle.js';
import { queuePlatoons, locateAlongRoad } from './trafficQueue.js';
import { registerDynamicCredit, TOMTOM_CREDIT } from './dataCredits.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';

/**
 * @file Street Traffic — animated dots along OSM road polylines, colored by
 * live TomTom congestion when a key is configured.
 *
 * Road geometry: OSM Overpass API (free, no auth). Fetches road polylines for
 * the camera viewport, spawns PointPrimitives that lerp along pre-computed
 * Cartesian3 waypoints. Camera-gated: only active below ~8 km altitude.
 *
 * Two modes (decided once per session via `/api/gev/tomtom/status`):
 *  - `sim` (keyless default): white dots at hardcoded per-road-class speeds —
 *    the original simulation, byte-identical behavior.
 *  - `live`: TomTom flow tiles (`flowTiles.js`) are matched onto the same
 *    Overpass roads (`flowMatch.js`); matched roads color/slow/densify their
 *    dots by real congestion (`trafficFlowStyle.js`), closed roads spawn no
 *    dots, and unmatched roads keep the simulated white.
 *
 * Architecture overview:
 *  - Camera-change listener triggers debounced road fetching per viewport tile.
 *  - Fetch bounds center on the camera's look-at point (`trafficBounds.js`, C4).
 *  - Roads are fetched in two passes: major-only (fast) then full graph (detailed).
 *  - Fetched tiles are cached by clamped bounding-box key to avoid re-fetching.
 *  - Dot budget allocation distributes a hard cap fairly across visible roads.
 *  - Each dot lerps along pre-computed Cartesian3 waypoints every preRender frame.
 *
 * @module data/traffic
 */

/** @const {string} Proxy endpoint for Overpass API queries */
const OVERPASS_URL = '/api/gev/overpass';
/** @const {number} Meters — hide all traffic dots above this camera altitude */
const ACTIVATION_ALTITUDE = 8000;
/** @const {number} Meters — above this altitude, only major roads are fetched */
const FAST_FETCH_ALTITUDE = 4500;
/** @const {number} Milliseconds — debounce delay before fetching after camera settles */
const FETCH_DEBOUNCE = 320;
/** @const {number} Meters — vertical offset to keep dots above clamped terrain surface */
const DOT_HEIGHT_OFFSET = 3.0;
/** @const {number} Fraction (0-1) — skip re-fetch when viewport overlap exceeds this */
const OVERLAP_THRESHOLD = 0.6;
/** @const {number} Hard cap on total rendered dot primitives for GPU/CPU performance */
const MAX_DOTS = 6000;
/** @const {number} Polylines longer than this are simplified by sub-sampling */
const MAX_WAYPOINTS_PER_ROAD = 80;
/** @const {number} Km — minimum viewport center shift before allowing refresh */
const MIN_CENTER_SHIFT_KM = 0.35;
/**
 * @const {number} Km — max great-circle distance the fetch center may sit from
 * the camera nadir. Traffic only activates below ACTIVATION_ALTITUDE (8 km),
 * so a look-at ground point farther than this is horizon-gazing and gets
 * pulled back toward nadir (C4 oblique-bounds fix).
 */
const MAX_LOOKAT_PULL_KM = 12;
/**
 * Development-only causal timing. Vite folds `import.meta.env.DEV` to false
 * in production, so the query-string read, nullable trace branches, and every
 * debug helper are removed from production builds. The remaining load-path
 * selectors point directly at the original functions: no marks, listeners,
 * observers, timers, counters, or per-road timing checks are installed.
 */
const TRAFFIC_TIMING_ENABLED = import.meta.env?.DEV
  && typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('trafficDebug') === '1';

/** @const {Object<string,number>} Speed in meters per second by highway tag (approximate real-world values) */
const SPEED_MPS = {
  motorway:     25,   // ~90 km/h
  trunk:        20,   // ~72 km/h
  primary:      14,   // ~50 km/h
  secondary:    11,   // ~40 km/h
  tertiary:     8,    // ~30 km/h
  residential:  5,    // ~18 km/h
  unclassified: 5,
};

/** @const {Object<string,number>} Density multiplier — higher values spawn more dots on important roads */
const DENSITY_MULT = {
  motorway: 3.0, trunk: 2.5, primary: 2.0, secondary: 1.5,
  tertiary: 1.0, residential: 0.5, unclassified: 0.4,
};

/** @const {Object<string,number>} Pixel size per road type (scaled up 25% for screen-recording visibility) */
const SIZE_BY_TYPE = {
  motorway: 6, trunk: 6, primary: 5, secondary: 5,
  tertiary: 4, residential: 4, unclassified: 4,
};

/**
 * Live-flow bucket colors (thresholds live in `trafficFlowStyle.js`):
 * green free flow / amber slow / red jam, all at 0.9 alpha.
 * Roads without flow data (`road.flow == null`) keep the sim's white.
 * @const {Object<string, Cesium.Color>}
 */
const FLOW_BUCKET_COLORS = {
  free: Cesium.Color.fromCssColorString('#2ecc71').withAlpha(0.9),
  slow: Cesium.Color.fromCssColorString('#f0b23e').withAlpha(0.9),
  jam: Cesium.Color.fromCssColorString('#e05252').withAlpha(0.9),
};

// ─── Jam-viz prototype (live mode only — see 2026-07-21 design doc) ────────
/** @const {number} Max congestion heat-line polylines per render (jam first). */
const HEAT_LINE_CAP = 400;
/** @const {number} Px — glowing jam corridor line width. */
const HEAT_LINE_JAM_WIDTH = 9;
/** @const {number} Px — flat slow corridor line width. */
const HEAT_LINE_SLOW_WIDTH = 4;
/** @const {number} Jam heat-line alpha midpoint (pulse oscillates around it). */
const HEAT_JAM_BASE_ALPHA = 0.55;
/** @const {number} Jam heat-line pulse amplitude (±, ~1.6 s period). */
const HEAT_JAM_PULSE_ALPHA = 0.2;
/** @const {Cesium.Color} Jam corridor color (bucket red, alpha pulsed live). */
const HEAT_JAM_COLOR = Cesium.Color.fromCssColorString('#e05252');
/** @const {Cesium.Color} Slow corridor color (bucket amber, faint + static). */
const HEAT_SLOW_COLOR = Cesium.Color.fromCssColorString('#f0b23e').withAlpha(0.2);
/**
 * @const {number} Meters — jam dots depth-test-punch through the 3D tiles out
 * to this camera distance so queues stay visible at city scale. The single
 * start-of-road terrain sample puts much of a road below the rendered mesh
 * at oblique city views (first A/B capture: 396 jam dots, zero visible), so
 * the shipped 2 km window hides exactly the congestion this prototype is
 * meant to surface. Live jam dots only; sim dots keep the shipped 2 km.
 */
const JAM_DOT_DEPTH_PUNCH = 15000;
/** @const {number} Far-distance scale floor for jam dots (shipped: 0.3). */
const JAM_DOT_FAR_SCALE = 0.55;
/** @const {number} Speed multiplier while a stop-and-go jam dot bursts forward. */
const CREEP_BURST = 2.2;
/** @const {number[]} Ms range a jam dot creeps forward before stopping. */
const CREEP_MOVE_MS = [1200, 3000];
/** @const {number[]} Ms range a jam dot sits stopped between creeps. */
const CREEP_STOP_MS = [1500, 5000];

// ─── Module State ──────────────────────────────────────────
/** @type {Cesium.Viewer|null} */
let _viewer = null;
/** @type {Cesium.PointPrimitiveCollection|null} */
let _pointCollection = null;
/** @type {Array<{point:Cesium.PointPrimitive, waypoints:Cesium.Cartesian3[], segmentDist:number[], numSegments:number, segIdx:number, t:number, mps:number, direction:number, stoppedUntil:number}>} Active animated dots */
let _dots = [];
/** @type {Array<{coords:number[][], type:string, waypoints:Cesium.Cartesian3[], segmentDist:number[]}>} Parsed roads with pre-computed Cartesian3 waypoints */
let _roads = [];
/** @type {boolean} Whether the layer is currently enabled */
let _enabled = false;
/** @type {Function|null} Disposer returned by preRender event subscription */
let _preRenderRemover = null;
/** @type {Function|null} Disposer returned by camera.changed event subscription */
let _cameraRemover = null;
/** @type {ReturnType<typeof setTimeout>|null} Debounce timer for camera-change fetch */
let _fetchTimeout = null;
/** @type {{south:number,west:number,north:number,east:number}|null} Last fetched clamped bounds */
let _lastBounds = null;
/** @type {boolean} True while an Overpass fetch is in flight */
let _fetching = false;
/** @type {number} Current count of rendered dots */
let _count = 0;
/** @type {number|null} Timestamp of last successful render */
let _lastUpdate = null;
/** @type {number} Monotonic generation counter — incremented on each load to discard stale responses */
let _loadGeneration = 0;
/** @type {AbortController|null} Controller for the in-flight fetch, so it can be cancelled */
let _activeFetchAbort = null;
/** @type {number} User-adjustable density multiplier (clamped 0.2–2.5) */
let _densityScale = 1.0;
/** @type {number} User-adjustable speed multiplier (clamped 0.3–3.0) */
let _speedScale = 1.0;
/** @type {{lat:number,lon:number}|null} Center of last-fetched viewport for shift gating */
let _lastViewCenter = null;
/** @type {number|null} camera.percentageChanged value before we overrode it, restored on disable */
let _prevPercentageChanged = null;
/** @type {boolean} Live TomTom flow mode — true iff /api/tomtom/status reports a key */
let _liveMode = false;
/**
 * Short user-facing reason live flow is currently unavailable, or null while
 * healthy. Only ever set in live mode: keyless simulation is a designed
 * fallback, not a fault, and must never read as an error.
 * @type {string|null}
 */
let _flowError = null;
/**
 * True when `/api/gev/tomtom/status` itself could not be reached, so the layer is
 * simulating because it could not ask — not because the server said "no key".
 * @type {boolean}
 */
let _flowStatusUnavailable = false;
/**
 * Flow requests this layer still owns. The 250 ms paint race lets a flow
 * fetch outlive the road load that started it (cached roads settle
 * instantly), so `_fetching` alone under-reports the work in flight: the
 * loading batch would close with LOAD COMPLETE and a failure landing after
 * it could never be announced. Counted, not boolean — recolor-after-timeout
 * means two loads can overlap.
 * @type {number}
 */
let _flowPending = 0;
/**
 * Rendered-dot counts per flow bucket (sim = white ambient, no flow data).
 * Reset with the dots in clearDots; drives the data-panel diagnostics and
 * the qa-traffic harness color assertions.
 * @type {{free:number, slow:number, jam:number, sim:number}}
 */
let _bucketCounts = { free: 0, slow: 0, jam: 0, sim: 0 };
/** @type {number} Roads in the current render skipped entirely as closed. */
let _closedRoads = 0;
/** @type {'sim'|'hide'} Live-mode treatment of roads without flow data. */
let _uncoveredMode = 'sim';
/**
 * Jam-viz prototype mode: 'density' = deep-jam density boost + platoon queues
 * + stop-and-go creep; 'heatline' = congestion corridor polylines; 'both';
 * 'none' = shipped main behavior. Live mode only — the keyless simulation
 * never has `road.flow`, so every jamViz path is unreachable there.
 * Default 'density' — A/B verdict 2026-07-23 (heatline stays available
 * via setParams).
 * @type {'none'|'density'|'heatline'|'both'}
 */
let _jamViz = 'density';
/**
 * Congestion heat-lines are GroundPolylinePrimitive batches draped onto the
 * rendered 3D tiles (ClassificationType.CESIUM_3D_TILE) — polylines at the
 * dots' single-sample heights depth-fail under the mesh across an oblique
 * city view (first A/B capture: 198 lines rendered, zero visible). One
 * primitive per bucket so the jam batch can pulse via a single shared
 * material uniform.
 * @type {Cesium.GroundPolylinePrimitive|null}
 */
let _heatJamPrim = null;
/** @type {Cesium.GroundPolylinePrimitive|null} Slow-bucket heat-line batch. */
let _heatSlowPrim = null;
/** @type {number} Heat-lines in the current render (stats). */
let _heatLineCount = 0;
/** @type {boolean|null} GroundPolylinePrimitive.isSupported, checked once. */
let _heatSupported = null;
/** @type {number} Altitude of the last render, for late-flow heat rebuilds. */
let _lastRenderAltitude = 0;
/**
 * Active post-FX style (StyleManager preset name), synced from
 * `document.documentElement.dataset.gevStyle` at init and the
 * `gev:style-change` window event thereafter. Drives the preset-aware dot
 * styling (`trafficPresetStyle.js`): NVG/FLIR/noir re-encode congestion in
 * luminance + size (their shaders discard hue), retro/CRT gets saturated
 * hues + a size boost to survive pixelation. 'normal' → shipped palette.
 * @type {string}
 */
let _stylePreset = 'normal';
/** @type {'on'|'off'} Kill switch for preset-aware dot styling (A/B). */
let _presetDots = 'on';
/** @type {boolean} gev:style-change listener bound (bind once per page). */
let _styleListenerBound = false;
/**
 * Effective per-bucket dot colors: preset override when one applies, else
 * the shipped FLOW_BUCKET_COLORS. Rebuilt on style/param change only —
 * spawn/recolor/restyle all read from here, no per-dot allocation.
 * @type {{free:Cesium.Color, slow:Cesium.Color, jam:Cesium.Color}}
 */
let _activeBucketColors = { ...FLOW_BUCKET_COLORS };
/**
 * @const {number} Minimum base pixel size for COLORED dots while a styled
 * preset is active — residential-road dots spawn at 4 px and vanish into
 * post-FX pixelation; presence is the dots' whole job there (follow-up round
 * 2). Sim dots and the normal profile keep SIZE_BY_TYPE untouched.
 */
const STYLED_MIN_BASE_PX = 5;

/** @returns {boolean} A non-normal preset profile is active and enabled. */
function presetProfileActive() {
  return _presetDots === 'on' && trafficStyleProfile(_stylePreset) !== 'normal';
}

/**
 * Pixel-size delta the active preset adds for a bucket (0 when the kill
 * switch is off or the profile is normal).
 * @param {'free'|'slow'|'jam'|null} bucket - Flow bucket.
 * @returns {number} Pixels to add on top of the shipped sizing.
 */
function activeSizeDelta(bucket) {
  return _presetDots === 'on' ? presetSizeDelta(_stylePreset, bucket) : 0;
}

/**
 * Base pixel size for a dot: shipped SIZE_BY_TYPE, floored at
 * STYLED_MIN_BASE_PX for colored dots while a styled preset is active.
 * @param {string} roadType - OSM highway class.
 * @param {'free'|'slow'|'jam'|null} bucket - Flow bucket (null = sim).
 * @returns {number} Base pixel size before jam/preset deltas.
 */
function baseDotSize(roadType, bucket) {
  const base = SIZE_BY_TYPE[roadType] || 4;
  return (bucket && presetProfileActive()) ? Math.max(base, STYLED_MIN_BASE_PX) : base;
}

/** Recompute `_activeBucketColors` from the active style + kill switch. */
function refreshBucketColors() {
  for (const bucket of ['free', 'slow', 'jam']) {
    const rgba = _presetDots === 'on' ? presetDotRgba(_stylePreset, bucket) : null;
    _activeBucketColors[bucket] = rgba
      ? new Cesium.Color(rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, rgba[3])
      : FLOW_BUCKET_COLORS[bucket];
  }
}

/**
 * Apply the active preset's dark-halo outline to a colored dot (or clear
 * it back to the shipped no-outline state). NVG's auto-gain saturates the
 * scene, so brightness alone cannot separate a dot from a bright road —
 * the dark ring restores local contrast through every luma-mapping shader.
 * @param {Cesium.PointPrimitive} point - The dot primitive.
 * @param {'free'|'slow'|'jam'|null} bucket - Flow bucket (null = sim).
 */
function applyOutline(point, bucket) {
  const spec = _presetDots === 'on' ? presetDotOutline(_stylePreset, bucket) : null;
  if (spec) {
    point.outlineColor = new Cesium.Color(
      spec.rgba[0] / 255, spec.rgba[1] / 255, spec.rgba[2] / 255, spec.rgba[3],
    );
    point.outlineWidth = spec.width;
  } else {
    point.outlineWidth = 0;
  }
}

/**
 * Re-apply dot styling in place after a style/param change: colored dots
 * get the (new) effective bucket color and size; sim (white) dots are
 * never touched. No refetch, no respawn — heat-lines rebuild for their
 * per-preset colors.
 */
function restyleDotsInPlace() {
  refreshBucketColors();
  if (!_dots.length && !_heatLineCount) return;
  for (const dot of _dots) {
    const bucket = dot.bucket;
    if (!bucket) continue; // sim/uncovered dots stay byte-identical
    dot.point.color = _activeBucketColors[bucket];
    dot.point.pixelSize = baseDotSize(dot.road?.type, bucket)
      + (bucket === 'jam' ? 1 : 0)
      + activeSizeDelta(bucket);
    applyOutline(dot.point, bucket);
  }
  rebuildHeatLines(visibleRoadsForAltitude(_roads, _lastRenderAltitude));
}

/**
 * Adopt a new active style preset (from the gev:style-change event or the
 * dataset read at init) and restyle live dots immediately.
 * @param {string|null|undefined} name - StyleManager preset name.
 */
function setStylePreset(name) {
  const next = (typeof name === 'string' && name) ? name : 'normal';
  if (next === _stylePreset) return;
  _stylePreset = next;
  restyleDotsInPlace();
}

/** @returns {boolean} Density/queue/creep prototype active. */
const jamDensityOn = () => _jamViz === 'density' || _jamViz === 'both';
/** @returns {boolean} Heat-line prototype active. */
const heatlineOn = () => _jamViz === 'heatline' || _jamViz === 'both';
/**
 * Dot fade-out distances, recomputed per render from the camera-to-area
 * distance. The original constants (8 km scale / 10 km translucency)
 * assumed a nadir view; at oblique pitch the loaded area legitimately sits
 * 7–12+ km from the CAMERA and every dot faded to invisible (field-test
 * round 1: "the screen itself was empty").
 */
let _fadeScaleFar = 8000;
let _fadeTransFar = 10000;
/** @type {Promise<void>|null} Session-cached status check (one fetch per session) */
let _flowStatusPromise = null;
/** @type {ReturnType<typeof setInterval>|null} Enable-time retry until the first load commits. */
let _enableKickTimer = null;
/** @type {number} 0–100 int — matched roads / roads with any flow candidates */
let _flowCoveragePct = 0;
/** @type {Function|null} Development-only camera moveEnd timing disposer. */
let _trafficTimingMoveEndRemover = null;
/** @type {Set<Function>|null} Development-only one-shot postRender disposers. */
let _trafficTimingPostRenderRemovers = null;
/** @type {{interactionId:number, timestamp:number}|null} Debug anchor for the pending load. */
let _trafficTimingCurrentAnchor = null;
/** @type {number} Development-only unique mark/trace sequence. */
let _trafficTimingSequence = 0;
/** @type {number} Development-only count of correlated trace objects created. */
let _trafficTimingTracesCreated = 0;
/** @type {number} Development-only count of loads dropped for missing/stale anchors. */
let _trafficTimingDroppedTraces = 0;

/**
 * Return development timing counters for the capture harness and inertness test.
 * This named export is unused by the application and removed from production.
 * @returns {{enabled:boolean, marksInstalled:number, traceObjectsCreated:number,
 *   uncorrelatedTracesDropped:number}}
 */
export function getTrafficTimingDiagnostics() {
  return {
    enabled: Boolean(TRAFFIC_TIMING_ENABLED),
    marksInstalled: _trafficTimingMoveEndRemover ? 1 : 0,
    traceObjectsCreated: _trafficTimingTracesCreated,
    uncorrelatedTracesDropped: _trafficTimingDroppedTraces,
  };
}

/**
 * Tile cache keyed by "s,w,n,e" string.
 * Each entry stores separately fetched major-only and full road sets
 * so the major pass can be served from cache while a full fetch continues.
 * @type {Map<string, {major: Array|null, full: Array|null}>}
 */
const _tileCache = new Map();
/** @const {number} Maximum tile cache entries before LRU eviction */
const TILE_CACHE_MAX_ENTRIES = 64;

/** Reusable scratch Cartesian3 to avoid per-frame allocation / GC pressure */
const _scratchLerp = new Cesium.Cartesian3();

// ─── Overpass API ──────────────────────────────────────────

/**
 * Build an Overpass QL query string to fetch road ways within a bounding box.
 *
 * The query uses a highway tag regex filter. When `majorOnly` is true, only
 * motorway/trunk/primary/secondary are included; otherwise all drivable road
 * classes are fetched. The `out geom qt;` suffix returns inline geometry
 * (lat/lon per node) sorted by quadtile for faster server response.
 *
 * @param {number} south - Southern latitude bound (degrees).
 * @param {number} west  - Western longitude bound (degrees).
 * @param {number} north - Northern latitude bound (degrees).
 * @param {number} east  - Eastern longitude bound (degrees).
 * @param {Object}  [opts]
 * @param {boolean} [opts.majorOnly=false] - Restrict to major highway classes only.
 * @param {number}  [opts.timeoutSec=25]   - Overpass server-side timeout.
 * @returns {string} Overpass QL query body.
 */
function buildOverpassQuery(south, west, north, east, { majorOnly = false, timeoutSec = 25 } = {}) {
  // Regex matches the OSM `highway` tag value against allowed road types
  const regex = majorOnly
    ? '^(motorway|trunk|primary|secondary)$'
    : '^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$';
  return `[out:json][timeout:${timeoutSec}];(way["highway"~"${regex}"](${south},${west},${north},${east}););out geom qt;`;
}

/**
 * Fetch road geometries from the Overpass API via the local proxy.
 *
 * Sends a POST with the query as form-encoded `data`. Supports
 * AbortController signals so in-flight requests can be cancelled
 * when the camera moves before the response arrives.
 *
 * @param {number} south - Southern latitude bound (degrees).
 * @param {number} west  - Western longitude bound (degrees).
 * @param {number} north - Northern latitude bound (degrees).
 * @param {number} east  - Eastern longitude bound (degrees).
 * @param {Object}  [opts]
 * @param {boolean} [opts.majorOnly=false]  - Restrict to major highway classes.
 * @param {number}  [opts.timeoutSec=25]    - Server-side Overpass timeout.
 * @param {AbortSignal} [opts.signal]       - Abort signal for cancellation.
 * @param {Object|null} [trace=null] - Development-only correlated load trace.
 * @returns {Promise<Object>} Parsed JSON response from Overpass.
 * @throws {Error} If the HTTP response status is not OK.
 */
async function fetchRoads(
  south,
  west,
  north,
  east,
  { majorOnly = false, timeoutSec = 25, signal } = {},
  trace = null,
) {
  const query = buildOverpassQuery(south, west, north, east, { majorOnly, timeoutSec });
  const state = TRAFFIC_TIMING_ENABLED && trace
    ? trafficTimingPass(trace, majorOnly ? 'major' : 'full', 'proxy')
    : null;
  if (state) trace.currentPass = state.pass;
  const fetchStart = state ? trafficTimingMark(state, 'fetch-start') : null;
  if (state) {
    trafficTimingMeasure(
      'last-camera-change-to-fetch-start', state, trace.cameraChangeMark, fetchStart,
    );
  }
  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
    signal,
  });

  if (!response.ok) {
    throw new Error(`Overpass API returned ${response.status}`);
  }

  if (!state) return response.json();

  if (state) {
    state.proxyCache = response.headers.get('x-overpass-cache');
    state.proxyUpstream = response.headers.get('x-overpass-upstream');
  }
  const responseStart = state ? trafficTimingMark(state, 'response-json-start', {
    responseStatus: response.status,
  }) : null;
  if (state) {
    trafficTimingMeasure('fetch-to-response', state, fetchStart, responseStart, {
      responseStatus: response.status,
    });
  }
  const data = await response.json();
  if (state) {
    const responseEnd = trafficTimingMark(state, 'response-json-end', {
      responseStatus: response.status,
    });
    trafficTimingMeasure('response-json', state, responseStart, responseEnd, {
      responseStatus: response.status,
    });
  }
  return data;
}

/**
 * Parse an Overpass `out geom;` JSON response into internal road objects.
 *
 * Each OSM `way` element carries an inline `geometry` array of `{lat, lon}`
 * objects, so no separate node look-up or osmtogeojson conversion is needed.
 *
 * Processing per way:
 *  1. Extract [lon, lat] coordinate pairs.
 *  2. Sub-sample long polylines to at most MAX_WAYPOINTS_PER_ROAD vertices.
 *  3. Sample terrain height once at the first vertex (avoids per-vertex cost).
 *  4. Convert to Cartesian3 waypoints and pre-compute inter-vertex distances.
 *
 * @param {Object} overpassData - Raw JSON response from the Overpass API.
 * @param {Array}  overpassData.elements - Array of OSM elements.
 * @returns {Array<{coords:number[][], type:string, waypoints:Cesium.Cartesian3[], segmentDist:number[]}>}
 *   Parsed road objects ready for dot spawning.
 */
function parseRoads(overpassData) {
  if (!overpassData || !overpassData.elements) return [];

  const roads = [];
  for (const el of overpassData.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;

    const rawCoords = el.geometry.map(g => [g.lon, g.lat]);

    // Sub-sample long polylines: keep every Nth vertex to stay within budget
    const simplifyStep = rawCoords.length > MAX_WAYPOINTS_PER_ROAD
      ? Math.ceil(rawCoords.length / MAX_WAYPOINTS_PER_ROAD)
      : 1;
    const coords = [];
    for (let i = 0; i < rawCoords.length; i += simplifyStep) {
      coords.push(rawCoords[i]);
    }

    // Ensure the original endpoint is always preserved
    const last = rawCoords[rawCoords.length - 1];
    const tail = coords[coords.length - 1];
    if (!tail || tail[0] !== last[0] || tail[1] !== last[1]) {
      coords.push(last);
    }

    if (coords.length < 2) continue;

    const type = el.tags?.highway || 'unclassified';
    // One-way capture (field-test round 1: "a car would never go in
    // reverse"): dots on one-way roads all travel the legal direction.
    // OSM: oneway=yes/1/true → digitization order; '-1' → reversed;
    // roundabouts are one-way by definition. 0 = two-way (alternate).
    const onewayTag = el.tags?.oneway;
    const oneway = (onewayTag === 'yes' || onewayTag === '1' || onewayTag === 'true' || el.tags?.junction === 'roundabout')
      ? 1
      : (onewayTag === '-1' ? -1 : 0);

    // Sample terrain height once at the road start to avoid per-vertex cost
    let baseHeight = 0;
    const firstCoord = coords[0];
    if (_viewer?.scene?.sampleHeightSupported && firstCoord) {
      const carto = Cesium.Cartographic.fromDegrees(firstCoord[0], firstCoord[1]);
      const sampled = _viewer.scene.sampleHeight(carto);
      if (Number.isFinite(sampled)) baseHeight = sampled;
    }

    // Pre-compute Cartesian3 waypoints (lon, lat, height) for fast lerp animation
    const waypoints = coords.map(([lng, lat]) => {
      const h = baseHeight + DOT_HEIGHT_OFFSET;
      return Cesium.Cartesian3.fromDegrees(lng, lat, h);
    });

    // Pre-compute segment distances in meters for speed-to-t conversion
    const segmentDist = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      segmentDist.push(Cesium.Cartesian3.distance(waypoints[i], waypoints[i + 1]));
    }

    roads.push({ coords, type, oneway, waypoints, segmentDist });
  }

  return roads;
}

// ─── Road Length Estimation ────────────────────────────────

/**
 * Estimate the total length of a road in meters from its degree-based coordinates.
 *
 * Uses Euclidean distance in degree-space then multiplies by the equatorial
 * approximation of 111 km per degree. Accurate enough for dot density spacing
 * but not for navigation.
 *
 * @param {number[][]} coords - Array of [lon, lat] pairs.
 * @returns {number} Approximate road length in meters.
 */
function estimateRoadLengthDeg(coords) {
  let len = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const dx = coords[i + 1][0] - coords[i][0];
    const dy = coords[i + 1][1] - coords[i][1];
    len += Math.sqrt(dx * dx + dy * dy);
  }
  // Rough conversion: 1 degree ~ 111,000 meters at equator
  return len * 111000;
}

// ─── Dot Spawning ──────────────────────────────────────────

/**
 * Compute the ideal number of dots for a single road at a given camera altitude.
 *
 * Spacing increases with altitude so fewer dots are rendered when zoomed out.
 * The result is further scaled by the road-type density multiplier and the
 * user-adjustable `_densityScale`.
 *
 * @param {{coords:number[][], type:string}} road - Parsed road object.
 * @param {number} altitude - Current camera altitude in meters.
 * @returns {number} Ideal dot count (minimum 1).
 */
function computeDotCount(road, altitude) {
  // Live flow: closed roads carry zero traffic; congestion packs more dots.
  // `road.flow` is only ever set in live mode, so the keyless path is
  // untouched (flow stays undefined → multiplier 1, identical output).
  const flow = _liveMode ? road.flow : null;
  if (flow?.closure) return 0;
  // Strict data-integrity view: uncovered roads spawn nothing when hidden.
  if (_liveMode && !flow && _uncoveredMode === 'hide') return 0;

  const lengthM = estimateRoadLengthDeg(road.coords);

  // Altitude-adaptive spacing: closer camera = denser dots
  let spacing;
  if (altitude < 1000)      spacing = 30;
  else if (altitude < 3000) spacing = 80;
  else if (altitude < 5000) spacing = 150;
  else                      spacing = 250;

  const mult = (DENSITY_MULT[road.type] || 1)
    * _densityScale
    * (flow ? flowDensityMult(flow.level, { jamBoost: jamDensityOn() }) : 1);
  return Math.max(1, Math.floor((lengthM / spacing) * mult));
}

/**
 * Distribute a fixed dot budget fairly across all visible roads.
 *
 * Algorithm:
 *  1. Compute ideal dot count per road via `computeDotCount`.
 *  2. Seed one dot to every road that wants at least one (fairness pass).
 *  3. Distribute remaining budget proportionally to each road's ideal count.
 *  4. Assign leftover dots (from floor rounding) to roads with the highest
 *     fractional residuals (largest-remainder method).
 *
 * This prevents high-density motorways from starving smaller residential roads
 * when the global MAX_DOTS cap is reached.
 *
 * @param {Array} roads    - Parsed road objects.
 * @param {number} altitude - Camera altitude in meters (affects spacing).
 * @param {number} dotCap   - Maximum total dots to allocate.
 * @returns {number[]} Per-road dot budgets, same length as `roads`.
 */
function allocateRoadDotBudgets(roads, altitude, dotCap) {
  const planned = roads.map((road) => computeDotCount(road, altitude));
  const budgets = new Array(roads.length).fill(0);
  let remaining = Math.max(0, dotCap);

  // Pass 1 — fairness seed: give one dot to every road (highest-demand first)
  const firstPassOrder = planned
    .map((count, index) => ({ count, index }))
    .sort((a, b) => b.count - a.count);

  for (const entry of firstPassOrder) {
    if (remaining <= 0) break;
    if (entry.count <= 0) continue;
    budgets[entry.index] = 1;
    remaining -= 1;
  }

  if (remaining <= 0) return budgets;

  // Pass 2 — proportional distribution of the remaining budget
  let totalRemainder = 0;
  for (let i = 0; i < planned.length; i++) {
    totalRemainder += Math.max(0, planned[i] - budgets[i]);
  }
  if (totalRemainder <= 0) return budgets;

  const residuals = [];
  let assigned = 0;
  for (let i = 0; i < planned.length; i++) {
    const cap = Math.max(0, planned[i] - budgets[i]);
    if (cap <= 0) continue;
    const ideal = (cap / totalRemainder) * remaining;
    const add = Math.min(cap, Math.floor(ideal));
    budgets[i] += add;
    assigned += add;
    residuals.push({ index: i, residual: ideal - add });
  }

  // Pass 3 — largest-remainder: hand out leftover dots from floor rounding
  let leftover = remaining - assigned;
  if (leftover > 0 && residuals.length > 0) {
    residuals.sort((a, b) => b.residual - a.residual);
    let cursor = 0;
    while (leftover > 0 && residuals.length > 0) {
      const idx = residuals[cursor % residuals.length].index;
      if (budgets[idx] < planned[idx]) {
        budgets[idx] += 1;
        leftover -= 1;
      }
      cursor += 1;
      // Safety valve: avoid infinite loop if all roads are already at their ideal
      if (cursor > residuals.length * 3 && leftover > 0) break;
    }
  }

  return budgets;
}

/**
 * Spawn animated dot primitives along a single road.
 *
 * Each dot is placed at a random position along the road, assigned a
 * randomized speed (base +/-30%), and given a direction (alternating
 * forward/backward to simulate two-way traffic).
 *
 * @param {{waypoints:Cesium.Cartesian3[], segmentDist:number[], type:string, coords:number[][]}} road
 *   Parsed road object with pre-computed waypoints.
 * @param {number} altitude      - Camera altitude (used if budgetCount is null).
 * @param {number|null} [budgetCount=null] - Pre-allocated dot count. Falls back
 *   to `computeDotCount` when null.
 */
function spawnDotsForRoad(road, altitude, budgetCount = null) {
  // Live flow styling (`road.flow` only exists in live mode; keyless path is
  // byte-identical): closures spawn nothing, congestion colors/slows dots.
  const flow = _liveMode ? road.flow : null;
  if (flow?.closure) return;
  if (_liveMode && !flow && _uncoveredMode === 'hide') return;

  const count = Number.isFinite(budgetCount)
    ? Math.max(0, Math.floor(budgetCount))
    : computeDotCount(road, altitude);
  const numSegments = road.waypoints.length - 1;
  if (numSegments < 1 || count <= 0) return;

  const baseMps = SPEED_MPS[road.type] || 5;
  const bucket = flow ? flowBucket(flow.level) : null;
  // Jam dots get +1px: a red queue should read as a queue at a glance.
  // Preset-aware styling adds its own size delta and floors the base (0 /
  // no floor under the normal profile) so NVG/FLIR/CRT dots stay PRESENT.
  const pixelSize = baseDotSize(road.type, bucket)
    + (bucket === 'jam' ? 1 : 0)
    + activeSizeDelta(bucket);
  const flowColor = bucket ? _activeBucketColors[bucket] : null;
  // Dark-halo outline under styled presets (null = shipped no-outline).
  const outlineSpec = (bucket && _presetDots === 'on') ? presetDotOutline(_stylePreset, bucket) : null;
  const outlineColor = outlineSpec
    ? new Cesium.Color(outlineSpec.rgba[0] / 255, outlineSpec.rgba[1] / 255, outlineSpec.rgba[2] / 255, outlineSpec.rgba[3])
    : null;
  const flowSpeed = flow ? flowSpeedScale(flow.level) : 1;
  const now = Date.now();

  // Jam-viz density prototype: jam-road dots spawn as bumper-to-bumper
  // platoons (one shared direction per queue) instead of uniform scatter.
  // Unreachable in sim mode — `bucket` requires flow.
  let placements = null;
  if (bucket === 'jam' && jamDensityOn()) {
    let totalLen = 0;
    for (const d of road.segmentDist) totalLen += d;
    const platoons = queuePlatoons(totalLen, count);
    if (platoons.length) {
      placements = [];
      for (let p = 0; p < platoons.length; p++) {
        const dir = road.oneway ? road.oneway : ((p % 2 === 0) ? 1 : -1);
        for (const s of platoons[p]) {
          const { segIdx, t } = locateAlongRoad(road.segmentDist, s);
          placements.push({ segIdx, t, direction: dir });
        }
      }
    }
  }

  for (let i = 0; i < count; i++) {
    if (_dots.length >= MAX_DOTS) return;

    // Random start position: pick a random segment and offset within it —
    // unless this is a queued jam dot with a platoon placement.
    const segIdx = placements ? placements[i].segIdx : Math.floor(Math.random() * numSegments);
    const t = placements ? placements[i].t : Math.random();

    // Speed noise: base speed +/-30% for organic variation. baseMps (noise
    // included, flow excluded) is kept on the dot so a late-arriving flow
    // match can rescale speed in place (recolorDotsInPlace).
    const noisedMps = baseMps * _speedScale * (0.7 + Math.random() * 0.6);
    const mps = noisedMps * flowSpeed;

    // One-way roads flow only their legal direction; two-way alternates
    // (per platoon in queue mode — a queue moves as one).
    const direction = placements
      ? placements[i].direction
      : (road.oneway ? road.oneway : ((i % 2 === 0) ? 1 : -1));

    // Compute initial Cartesian3 position via linear interpolation
    Cesium.Cartesian3.lerp(road.waypoints[segIdx], road.waypoints[segIdx + 1], t, _scratchLerp);

    // Jam-viz density prototype: jam dots stay visible at city scale — a
    // longer depth-test punch-through (single-sample road heights sit under
    // the mesh at oblique views) and a higher far-scale floor. Sim dots and
    // other buckets keep the shipped values.
    const jamProminent = bucket === 'jam' && jamDensityOn();
    const point = _pointCollection.add({
      position: Cesium.Cartesian3.clone(_scratchLerp),
      pixelSize,
      // No flow data → today's exact simulated white.
      color: flowColor || Cesium.Color.WHITE.withAlpha(0.85),
      scaleByDistance: new Cesium.NearFarScalar(100, 1.5, _fadeScaleFar, jamProminent ? JAM_DOT_FAR_SCALE : 0.3),
      translucencyByDistance: new Cesium.NearFarScalar(100, 1.0, _fadeTransFar, 0.0),
      // visible through tiles only when very close (jam: city-scale punch)
      disableDepthTestDistance: jamProminent ? JAM_DOT_DEPTH_PUNCH : 2000,
      // Preset dark halo (spread only when present — the keyless/normal
      // path passes the exact shipped option set).
      ...(outlineSpec ? { outlineColor, outlineWidth: outlineSpec.width } : {}),
    });
    _bucketCounts[bucket || 'sim'] += 1;

    _dots.push({
      point,
      road,
      bucket, // flow bucket at spawn (null = sim) — drives preset restyle/pulse
      waypoints: road.waypoints,
      segmentDist: road.segmentDist,
      numSegments,
      segIdx,
      t,
      mps,          // meters per second (flow-scaled)
      baseMps: noisedMps, // pre-flow speed, for in-place flow rescale
      direction,
      stoppedUntil: 0,
      // Stop-and-go creep state (jam-viz density prototype): jam dots
      // alternate move-bursts and stops. Null in sim mode and for non-jam.
      creep: (bucket === 'jam' && jamDensityOn())
        ? { moving: Math.random() < 0.4, until: now + Math.random() * 2000 }
        : null,
    });
  }
}

// ─── Animation ─────────────────────────────────────────────

/** @type {number} Timestamp of the last animation tick (ms) */
let _lastAnimTime = 0;
/** @type {number} Running frame counter (for diagnostics) */
let _animFrame = 0;

/**
 * Per-frame animation callback registered on `scene.preRender`.
 *
 * For every active dot:
 *  1. Skip if currently paused by a simulated stop-light.
 *  2. Convert speed (m/s) to a parametric t-delta relative to the current
 *     segment's Cartesian distance.
 *  3. Advance t in the dot's travel direction, handling segment boundary
 *     crossings and end-of-road reversals.
 *  4. Linearly interpolate between the two bounding waypoints and update the
 *     point primitive's position.
 *
 * Delta time is capped at 100 ms to prevent large jumps after background tabs.
 */
function animate() {
  const now = Date.now();
  // Delta time in seconds, capped to avoid jumps when returning from background tab
  const dt = _lastAnimTime ? Math.min((now - _lastAnimTime) / 1000, 0.1) : 0.016;
  _lastAnimTime = now;

  for (let i = 0; i < _dots.length; i++) {
    const dot = _dots[i];

    // Simulated stop-light pause — skip movement while timer is active
    if (now < dot.stoppedUntil) continue;

    // Stop-and-go creep (jam-viz density prototype, live jam dots only):
    // alternate short forward bursts with stops. The burst multiplier keeps
    // the long-run average near the honest TomTom crawl speed.
    let burst = 1;
    if (dot.creep) {
      if (now >= dot.creep.until) {
        dot.creep.moving = !dot.creep.moving;
        const [lo, hi] = dot.creep.moving ? CREEP_MOVE_MS : CREEP_STOP_MS;
        dot.creep.until = now + lo + Math.random() * (hi - lo);
      }
      if (!dot.creep.moving) continue;
      burst = CREEP_BURST;
    }

    // Convert m/s speed to parametric t-delta for the current segment length
    const segLen = dot.segmentDist[dot.segIdx] || 1;
    const tDelta = (dot.mps * burst * dt) / segLen;

    // Advance parametric position along the road in the current direction
    dot.t += tDelta * dot.direction;

    // Handle forward segment boundary crossing (t >= 1.0)
    if (dot.t >= 1.0) {
      dot.t -= 1.0;
      dot.segIdx++;
      if (dot.segIdx >= dot.numSegments) {
        // End of road: recycle to the road's entry with a small stagger —
        // cars don't reverse at the end of a street (field-test round 1).
        // Direction is preserved, so one-way flow stays legal.
        dot.segIdx = 0;
        dot.t = Math.random() * 0.3;
      }
      maybeStopLight(dot, now);
    } else if (dot.t <= 0.0) {
      // Handle backward segment boundary crossing (t <= 0.0)
      dot.t += 1.0;
      dot.segIdx--;
      if (dot.segIdx < 0) {
        // Start of road (traveling backward): recycle to the far end.
        dot.segIdx = dot.numSegments - 1;
        dot.t = 1.0 - Math.random() * 0.3;
      }
      maybeStopLight(dot, now);
    }

    // Lerp between pre-computed Cartesian3 waypoints (no trig needed).
    // Pass the scratch directly: PointPrimitive's position setter clones the
    // value into its own storage (and skips the VBO dirty flag when equal), so
    // the extra defensive clone here allocated 360–720k Cartesian3/s of pure
    // garbage across 6000 dots. (perf item 5)
    const a = dot.waypoints[dot.segIdx];
    const b = dot.waypoints[dot.segIdx + 1];
    Cesium.Cartesian3.lerp(a, b, dot.t, _scratchLerp);
    dot.point.position = _scratchLerp;
  }

  // Jam heat-lines throb (~1.6 s period) — one shared material uniform for
  // the whole jam batch, no geometry rebuild. Null outside live heatline mode.
  if (_heatJamPrim?.appearance) {
    _heatJamPrim.appearance.material.uniforms.color.alpha =
      HEAT_JAM_BASE_ALPHA + HEAT_JAM_PULSE_ALPHA * Math.sin(now / 260);
  }

  _animFrame++;
}

/**
 * Randomly pause a dot near road endpoints to simulate stop-light behaviour.
 *
 * Only triggers within the first 2 or last 2 segments of the road, and only
 * with a very low per-frame probability (0.8%) to keep traffic flowing.
 *
 * @param {Object} dot - The dot state object.
 * @param {number} now - Current timestamp in milliseconds.
 */
function maybeStopLight(dot, now) {
  const nearEnd = dot.segIdx <= 1 || dot.segIdx >= dot.numSegments - 2;
  if (nearEnd && Math.random() < 0.008) {
    // Pause for 2–6 seconds
    dot.stoppedUntil = now + 2000 + Math.random() * 4000;
  }
}

// ─── Camera Monitoring ─────────────────────────────────────

/**
 * Get the current camera altitude in meters above the ellipsoid.
 * @returns {number} Camera height in meters, or Infinity if unavailable.
 */
function getCameraAltitude() {
  const carto = _viewer.camera.positionCartographic;
  return carto ? carto.height : Infinity;
}

/**
 * Compute the current camera view rectangle in degrees.
 * @returns {{south:number, west:number, north:number, east:number}|null}
 *   Bounding box in degrees, or null if the rectangle cannot be computed.
 */
function getViewBounds() {
  const rect = _viewer.camera.computeViewRectangle();
  if (!rect) return null;
  return {
    south: Cesium.Math.toDegrees(rect.south),
    west: Cesium.Math.toDegrees(rect.west),
    north: Cesium.Math.toDegrees(rect.north),
    east: Cesium.Math.toDegrees(rect.east),
  };
}

/**
 * Derive the road-fetch center from the camera's look-at ground point.
 *
 * C4 fix: at oblique pitch `computeViewRectangle()` spans toward the horizon,
 * so its midpoint can sit tens of km from what the user is looking at. Instead
 * we pick the ellipsoid under the canvas center (`camera.pickEllipsoid` — this
 * works with the globe hidden under Google 3D tiles, where `scene.globe.pick`
 * is NOT reliable), fall back to the camera nadir on a sky/horizon look, and
 * pull horizon-gaze hits back to MAX_LOOKAT_PULL_KM from nadir.
 *
 * @returns {{lat:number, lon:number, source:string}|null} Fetch center in
 *   degrees, or null when the camera position is unavailable.
 */
function getFetchCenter() {
  const carto = _viewer.camera.positionCartographic;
  if (!carto) return null;
  const nadirLat = Cesium.Math.toDegrees(carto.latitude);
  const nadirLon = Cesium.Math.toDegrees(carto.longitude);

  let hitLat;
  let hitLon;
  const canvas = _viewer.scene.canvas;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  if (width > 0 && height > 0) {
    const hit = _viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(width / 2, height / 2),
      Cesium.Ellipsoid.WGS84
    );
    if (hit) {
      const hitCarto = Cesium.Cartographic.fromCartesian(hit);
      hitLat = Cesium.Math.toDegrees(hitCarto.latitude);
      hitLon = Cesium.Math.toDegrees(hitCarto.longitude);
    }
  }

  return deriveFetchCenter({
    nadirLat, nadirLon, hitLat, hitLon, maxPullKm: MAX_LOOKAT_PULL_KM,
  });
}

/**
 * Compute the geographic center of a bounding box.
 * @param {{south:number, west:number, north:number, east:number}} bounds
 * @returns {{lat:number, lon:number}} Center point in degrees.
 */
function getBoundsCenter(bounds) {
  return {
    lat: (bounds.south + bounds.north) / 2,
    lon: (bounds.west + bounds.east) / 2,
  };
}

/**
 * Approximate great-circle distance between two points in kilometres.
 *
 * Uses an equirectangular projection (cosine correction on longitude)
 * with the 111 km/degree approximation. Sufficient for the small
 * viewport-center shifts being compared.
 *
 * @param {{lat:number, lon:number}} a - First point.
 * @param {{lat:number, lon:number}} b - Second point.
 * @returns {number} Distance in kilometres.
 */
function distanceKm(a, b) {
  const dLat = (a.lat - b.lat) * 111;
  const avgLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLon = (a.lon - b.lon) * 111 * Math.cos(avgLat);
  return Math.sqrt((dLat * dLat) + (dLon * dLon));
}

/**
 * Check whether two bounding boxes overlap by at least a given fraction of
 * the first box's area. Used to decide if a camera move is large enough to
 * warrant a new road fetch.
 *
 * @param {{south:number, west:number, north:number, east:number}} a - Reference bounds.
 * @param {{south:number, west:number, north:number, east:number}} b - Bounds to compare.
 * @param {number} threshold - Minimum overlap fraction (0-1) relative to `a`.
 * @returns {boolean} True if overlap area / a area >= threshold.
 */
function boundsOverlap(a, b, threshold) {
  // Compute the intersection rectangle
  const overlapS = Math.max(a.south, b.south);
  const overlapN = Math.min(a.north, b.north);
  const overlapW = Math.max(a.west, b.west);
  const overlapE = Math.min(a.east, b.east);

  // No intersection if the rectangle is degenerate
  if (overlapN <= overlapS || overlapE <= overlapW) return false;

  const overlapArea = (overlapN - overlapS) * (overlapE - overlapW);
  const aArea = (a.north - a.south) * (a.east - a.west);

  return aArea > 0 && (overlapArea / aArea) >= threshold;
}

/**
 * Clamp a bounding box to a maximum span to avoid overloading the Overpass API.
 *
 * The box is centered on the input's midpoint with each axis capped at 0.05
 * degrees (~5.5 km at the equator). This keeps query area and response size
 * manageable while still covering the visible neighbourhood.
 *
 * NOTE (C4): the camera-driven path in `onCameraChanged` centers on the
 * derived look-at point via `clampBoundsAroundCenter` instead; this
 * midpoint-centered variant remains as the internal re-clamp guard in
 * `loadRoadsForBounds` (idempotent on already-clamped bounds).
 *
 * @param {{south:number, west:number, north:number, east:number}} bounds
 * @returns {{south:number, west:number, north:number, east:number}} Clamped bounds.
 */
function clampBounds(bounds) {
  return clampBoundsAroundCenter(bounds, getBoundsCenter(bounds));
}

/**
 * Camera-change handler — the main entry point for viewport-driven road loading.
 *
 * Gating logic:
 *  1. If the camera is above ACTIVATION_ALTITUDE, clear all dots and bail.
 *  2. Clamp the view bounds and compute the viewport center.
 *  3. Skip the fetch if the new viewport significantly overlaps the last-fetched
 *     bounds AND the center has shifted less than MIN_CENTER_SHIFT_KM. This
 *     prevents redundant fetches during small pans.
 *  4. Otherwise, debounce and schedule `loadRoadsForBounds`.
 */
function onCameraChanged() {
  if (!_enabled) return;

  const alt = getCameraAltitude();

  // Above activation altitude — remove all traffic and stop.
  // Also null the last-fetch gate: otherwise zooming back down to the SAME
  // viewport hits the overlap/center-shift skip in step 3 and the dots
  // (cleared here) never reload (H5). Clearing the gate forces a fresh fetch.
  if (alt > ACTIVATION_ALTITUDE) {
    clearDots();
    _lastBounds = null;
    _lastViewCenter = null;
    return;
  }

  const bounds = getViewBounds();
  if (!bounds) return;
  // C4 fix: center the fetch box on the camera's look-at ground point (with
  // nadir fallback + 12 km horizon-gaze pull-back), NOT the view rectangle's
  // midpoint — at oblique pitch that midpoint drifts toward the horizon.
  const fetchCenter = getFetchCenter();
  const clamped = fetchCenter
    ? clampBoundsAroundCenter(bounds, fetchCenter)
    : clampBounds(bounds);
  const center = getBoundsCenter(clamped);

  // Skip re-fetch when viewport overlap is high and center shift is negligible
  if (
    _lastBounds
    && _lastViewCenter
    && boundsOverlap(clamped, _lastBounds, OVERLAP_THRESHOLD)
    && distanceKm(center, _lastViewCenter) < MIN_CENTER_SHIFT_KM
  ) {
    return;
  }

  // Debounce: wait for camera to settle before triggering a fetch. In debug
  // captures the final changed event that arms this exact timeout is its
  // causal anchor; Cesium's later moveEnd notification is diagnostic only.
  const interactionAnchor = TRAFFIC_TIMING_ENABLED ? markTrafficTimingCameraChange() : null;
  clearTimeout(_fetchTimeout);
  _fetchTimeout = setTimeout(
    () => _loadRoadsForBounds(clamped, alt, interactionAnchor),
    FETCH_DEBOUNCE,
  );
}

/** Abort any in-flight Overpass fetch and clear the controller reference. */
function cancelActiveFetch() {
  if (_activeFetchAbort) {
    _activeFetchAbort.abort();
    _activeFetchAbort = null;
  }
}

// ─── Live Flow (TomTom) ────────────────────────────────────

/**
 * Map a failed flow fetch onto one short, honest user-facing reason.
 *
 * `fetchFlowForBounds` only rejects when EVERY covering tile failed, so a
 * non-null result here always means "there is no live flow to show right
 * now" — the dots fall back to simulated white. Mirrors the
 * `deriveAisFeedError` honesty helper.
 *
 * @param {Error|{name?:string, message?:string}|null|undefined} error - Rejection from the flow fetch.
 * @returns {string|null} Short reason, or null for an aborted (superseded) fetch.
 */
export function deriveTrafficFlowError(error) {
  if (!error || error.name === 'AbortError') return null;
  const message = String(error.message || error);
  const status = Number(message.match(/HTTP (\d{3})/)?.[1]);
  if (status === 503) return 'TomTom key unavailable';
  if (status === 429) return 'TomTom daily budget reached';
  if (status === 502 || status === 504) return 'TomTom upstream unreachable';
  if (Number.isFinite(status)) return `TomTom flow error (HTTP ${status})`;
  return 'TomTom flow unavailable';
}

/**
 * Derive the layer's honest feed presentation from its live-flow state.
 *
 * The three states a user can be in, and what each must read as:
 *  - keyless → `mode:'sim'` (the manager maps that to a FALLBACK chip) with a
 *    label that never claims live data;
 *  - live and healthy → LIVE with real coverage;
 *  - live but flow-down → an `error` string, so the chip degrades and says
 *    the colors on screen are simulated. Never a stale "LIVE · N% cov".
 *
 * @param {Object} [input]
 * @param {boolean} [input.liveMode] - `/api/gev/tomtom/status` reported a key.
 * @param {boolean} [input.fetching] - A viewport load is in flight.
 * @param {string|null} [input.flowError] - `deriveTrafficFlowError` result, if any.
 * @param {number} [input.coveragePct] - Matched-road coverage, 0–100.
 * @param {boolean} [input.statusUnavailable] - The status probe itself failed.
 * @returns {{mode:'live'|'sim', error:string|null, loadingLabel:string}}
 */
export function trafficFeedPresentation({
  liveMode = false,
  fetching = false,
  flowError = null,
  coveragePct = 0,
  statusUnavailable = false,
} = {}) {
  // `mode` is the CONFIGURED source (live key present vs keyless), not this
  // instant's health — health rides on `error`. The qa-traffic harness pins
  // that meaning.
  const mode = liveMode ? 'live' : 'sim';
  if (liveMode && flowError) {
    // One string for both fields. The manager's meta line renders `error` and
    // drops `loadingLabel` in its error branch, so the SIMULATED copy
    // has to BE the error text or the steady state reverts to a bare
    // "TomTom daily budget reached" that never says what is on screen.
    const degraded = `SIMULATED — ${flowError}`;
    return { mode, error: degraded, loadingLabel: degraded };
  }
  if (liveMode) {
    return {
      mode,
      error: null,
      loadingLabel: fetching
        ? 'syncing LIVE traffic flow'
        : `LIVE · TomTom flow · ${coveragePct}% cov`,
    };
  }
  // Keyless simulation — one terse line that names the mode and the remedy
  // (the copy shape). The chip's own progress text carries "working";
  // this line must never imply a live feed.
  return {
    mode,
    error: null,
    loadingLabel: statusUnavailable
      ? 'SIMULATED — traffic service unreachable'
      : 'SIMULATED — add TomTom key for live',
  };
}

/**
 * Check `/api/gev/tomtom/status` once per session and cache the result.
 * Live mode iff the server holds a TomTom key; the TomTom attribution credit
 * registers the first time live mode activates. Keyless or unreachable →
 * simulation mode, exactly today's behavior.
 *
 * @returns {Promise<void>} Resolves when `_liveMode` is settled.
 */
function ensureFlowStatus() {
  if (!_flowStatusPromise) {
    _flowStatusPromise = fetch('/api/gev/tomtom/status')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((status) => {
        _liveMode = Boolean(status?.hasKey);
        _flowStatusUnavailable = false;
        if (_liveMode) {
          console.log('[Data:Traffic] TomTom key present — live flow mode');
          registerDynamicCredit(_viewer, TOMTOM_CREDIT);
        }
      })
      .catch((e) => {
        // Simulating because we could not ask, which is NOT the same as
        // "server says no key" — getStats() distinguishes the two.
        _liveMode = false;
        _flowStatusUnavailable = true;
        console.warn('[Data:Traffic] TomTom status unreachable — simulated traffic:', e?.message || e);
      });
  }
  return _flowStatusPromise;
}

/**
 * Live mode only: fetch TomTom flow for the clamped bounds, match it onto the
 * parsed roads, and attach `road.flow` (`{level, closure}` or null).
 *
 * Reuses the load-generation guard: stale flow responses are discarded, and
 * the shared AbortController lets `cancelActiveFetch()` (next load / disable)
 * cancel an in-flight flow fetch. Any failure leaves roads unmatched — the
 * dots then render in today's simulated white, never a phantom color — and is
 * recorded in `_flowError` so `getStats()` degrades honestly instead of
 * reporting a stale "LIVE · N% cov" over simulated dots.
 *
 * @param {Array} roads - Parsed road objects (mutated: `road.flow`).
 * @param {{south:number,west:number,north:number,east:number}} clamped - Fetch bounds.
 * @param {number} generation - `_loadGeneration` at call time.
 * @returns {Promise<void>}
 */
async function applyFlowToRoads(roads, clamped, generation) {
  // Claim the work synchronously, before the first await, so `stats.loading`
  // covers this request from the same tick the caller started it — the
  // loading batch must not be able to close underneath an in-flight fetch.
  _flowPending += 1;
  try {
    if (!_flowStatusPromise) return; // status check not started — sim mode
    await _flowStatusPromise;
    if (!_liveMode || !_enabled) return;
    if (generation !== _loadGeneration) return;
    if (!Array.isArray(roads) || roads.length === 0) return;
    try {
      // Cached paths reach here without a live controller; the fetch paths
      // reuse theirs so one cancel covers both roads and flow.
      if (!_activeFetchAbort) _activeFetchAbort = new AbortController();
      const segments = await fetchFlowForBounds(clamped, { signal: _activeFetchAbort.signal });
      if (generation !== _loadGeneration) return;
      const { matches, matchedCount, candidateCount } = matchFlowToRoads(roads, segments);
      for (let i = 0; i < roads.length; i++) {
        roads[i].flow = matches[i];
      }
      _flowCoveragePct = candidateCount > 0
        ? Math.round((matchedCount / candidateCount) * 100)
        : 0;
      _flowError = null;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      // Same guard the success path gets: a superseded request rejecting late
      // (or after disable() cleared the state) must not restore a stale
      // outage over newer good data.
      if (generation !== _loadGeneration || !_enabled) return;
      // Every covering tile failed: there is no live flow on screen. Drop the
      // now-false coverage number and surface the reason through getStats().
      _flowError = deriveTrafficFlowError(e);
      _flowCoveragePct = 0;
      console.warn('[Data:Traffic] Flow fetch failed (sim colors remain):', e?.message || e);
    }
  } finally {
    _flowPending -= 1;
  }
}

/**
 * Milliseconds the first dot paint will wait for flow data. Cached flow
 * settles within this window (decode cache, 120 s TTL) and renders fully
 * colored; a cold tile fetch loses the race, dots paint immediately in
 * white, and recolorDotsInPlace applies the colors when flow arrives —
 * field-test round 1's "takes forever to load" was the sequential wait.
 */
const FLOW_RENDER_RACE_MS = 250;

/**
 * Race flow application against the paint deadline, render, and schedule an
 * in-place recolor if flow lost the race.
 * @param {Array} roads - Parsed road objects.
 * @param {{south:number,west:number,north:number,east:number}} clamped - Fetch bounds.
 * @param {number} generation - `_loadGeneration` at call time.
 * @param {number} altitude - Camera altitude in meters.
 * @param {string} label - Render log label.
 * @param {Object|null} [trace=null] - Development-only correlated load trace.
 * @returns {Promise<boolean>} True if this generation rendered.
 */
async function applyFlowThenRender(roads, clamped, generation, altitude, label, trace = null) {
  const state = TRAFFIC_TIMING_ENABLED && trace
    ? trafficTimingRenderState(trace, label)
    : null;
  const flowRaceStart = state ? trafficTimingMark(state, 'flow-render-race-start', {
    deadlineMs: FLOW_RENDER_RACE_MS,
  }) : null;
  const flowJob = applyFlowToRoads(roads, clamped, generation);
  const outcome = await Promise.race([
    flowJob.then(() => 'flow'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), FLOW_RENDER_RACE_MS)),
  ]);
  if (state) {
    const flowRaceEnd = trafficTimingMark(state, 'flow-render-race-end', {
      deadlineMs: FLOW_RENDER_RACE_MS,
      outcome,
    });
    trafficTimingMeasure('flow-render-race', state, flowRaceStart, flowRaceEnd, {
      deadlineMs: FLOW_RENDER_RACE_MS,
      outcome,
    });
  }
  if (generation !== _loadGeneration) return false;
  renderRoadsForAltitude(roads, altitude, label, trace);
  if (outcome === 'timeout') {
    flowJob.then(() => {
      if (generation !== _loadGeneration) return;
      recolorDotsInPlace(label);
    }).catch(() => { /* applyFlowToRoads settles its own failures */ });
  }
  return true;
}

/**
 * Apply late-arriving flow data to already-rendered dots without a respawn:
 * color, jam size, and speed update in place; closed roads' dots hide.
 * Density bunching intentionally waits for the next natural re-render —
 * color and speed are the live signal, dot count is a refinement.
 * @param {string} label - Render log label (for the console trace).
 */
function recolorDotsInPlace(label) {
  if (!_liveMode || !_dots.length) return;
  _bucketCounts = { free: 0, slow: 0, jam: 0, sim: 0 };
  let closedDots = 0;
  const now = Date.now();
  for (const dot of _dots) {
    const flow = dot.road ? dot.road.flow : null;
    if (flow?.closure) {
      dot.point.show = false;
      closedDots += 1;
      continue;
    }
    const bucket = flow ? flowBucket(flow.level) : null;
    dot.bucket = bucket;
    dot.point.color = bucket ? _activeBucketColors[bucket] : Cesium.Color.WHITE.withAlpha(0.85);
    if (bucket === 'jam') {
      dot.point.pixelSize = baseDotSize(dot.road?.type, bucket) + 1 + activeSizeDelta('jam');
    } else if (bucket && presetProfileActive()) {
      // Preset profiles size-floor every bucket; the shipped normal path
      // keeps its jam-only size touch (byte-identical behavior).
      dot.point.pixelSize = baseDotSize(dot.road?.type, bucket) + activeSizeDelta(bucket);
    }
    // Late flow can move a dot between buckets — keep the preset halo in
    // step (no-op writes under the normal profile, whose dots have none).
    if (presetProfileActive()) applyOutline(dot.point, bucket);
    dot.mps = dot.baseMps * (flow ? flowSpeedScale(flow.level) : 1);
    // Late flow tags/untags stop-and-go creep + city-scale prominence the
    // same way it rescales speed. Queue *positions* wait for the next
    // natural re-render, like density bunching.
    if (bucket === 'jam' && jamDensityOn()) {
      if (!dot.creep) dot.creep = { moving: Math.random() < 0.4, until: now + Math.random() * 2000 };
      dot.point.scaleByDistance = new Cesium.NearFarScalar(100, 1.5, _fadeScaleFar, JAM_DOT_FAR_SCALE);
      dot.point.disableDepthTestDistance = JAM_DOT_DEPTH_PUNCH;
    } else {
      dot.creep = null;
    }
    _bucketCounts[bucket || 'sim'] += 1;
  }
  _closedRoads = _roads.reduce((n, r) => n + (r.flow?.closure ? 1 : 0), 0);
  rebuildHeatLines(visibleRoadsForAltitude(_roads, _lastRenderAltitude));
  console.log(`[Data:Traffic] Flow recolor (${label}): ${_dots.length} dots, closedDots=${closedDots}`);
}

/**
 * At high altitude only major roads render — shared by the render pass and
 * the late-flow heat-line rebuild so lines never mark roads without dots.
 * @param {Array} roads    - Parsed road objects.
 * @param {number} altitude - Camera altitude in meters.
 * @returns {Array} The roads visible at this altitude.
 */
function visibleRoadsForAltitude(roads, altitude) {
  return altitude > 5000
    ? roads.filter(r => r.type === 'motorway' || r.type === 'trunk' || r.type === 'primary')
    : roads;
}

/** Remove both heat-line ground primitives from the scene. */
function removeHeatLines() {
  if (_heatJamPrim) {
    _viewer?.scene.groundPrimitives.remove(_heatJamPrim);
    _heatJamPrim = null;
  }
  if (_heatSlowPrim) {
    _viewer?.scene.groundPrimitives.remove(_heatSlowPrim);
    _heatSlowPrim = null;
  }
  _heatLineCount = 0;
}

/**
 * Rebuild the congestion heat-line underlay (jam-viz heatline prototype):
 * slow/jam roads drape a corridor line onto the rendered 3D tiles — glowing
 * pulsing red for jam, faint flat amber for slow — with the dots animating
 * on top. Two batched GroundPolylinePrimitives (one per bucket) so the jam
 * batch pulses through one shared material. Capped at HEAT_LINE_CAP (jam
 * first, longest first); overflow is logged. No-op in sim mode, when the
 * heatline mode is off, or without ground-primitive support.
 *
 * @param {Array} roads - Road objects visible in the current render.
 */
function rebuildHeatLines(roads) {
  removeHeatLines();
  if (!_viewer || !_liveMode || !heatlineOn()) return;
  if (_heatSupported === null) {
    _heatSupported = Cesium.GroundPolylinePrimitive.isSupported(_viewer.scene);
    if (!_heatSupported) console.warn('[Data:Traffic] GroundPolylinePrimitive unsupported — heat-lines disabled');
  }
  if (!_heatSupported) return;

  const candidates = [];
  for (const road of roads) {
    const flow = road.flow;
    if (!flow || flow.closure) continue;
    const bucket = flowBucket(flow.level);
    if (bucket === 'free') continue;
    let len = 0;
    for (const d of road.segmentDist) len += d;
    candidates.push({ road, bucket, len });
  }
  candidates.sort((a, b) => (a.bucket === b.bucket
    ? b.len - a.len
    : (a.bucket === 'jam' ? -1 : 1)));
  const kept = candidates.slice(0, HEAT_LINE_CAP);

  const instancesFor = (bucket, width) => kept
    .filter((c) => c.bucket === bucket)
    .map((c) => new Cesium.GeometryInstance({
      geometry: new Cesium.GroundPolylineGeometry({ positions: c.road.waypoints, width }),
    }));

  // Mono presets (NVG/FLIR/noir) discard hue — heat-lines re-encode in
  // luminance like the dots: jam = white glow, slow = faint gray.
  const monoHeat = _presetDots === 'on' && trafficStyleProfile(_stylePreset) === 'mono';
  const jamLineColor = monoHeat ? Cesium.Color.WHITE : HEAT_JAM_COLOR;
  const slowLineColor = monoHeat
    ? new Cesium.Color(0.7, 0.7, 0.7, HEAT_SLOW_COLOR.alpha)
    : HEAT_SLOW_COLOR;

  const jamInstances = instancesFor('jam', HEAT_LINE_JAM_WIDTH);
  if (jamInstances.length) {
    _heatJamPrim = _viewer.scene.groundPrimitives.add(new Cesium.GroundPolylinePrimitive({
      geometryInstances: jamInstances,
      classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
      appearance: new Cesium.PolylineMaterialAppearance({
        material: Cesium.Material.fromType('PolylineGlow', {
          color: jamLineColor.withAlpha(HEAT_JAM_BASE_ALPHA),
          glowPower: 0.25,
        }),
      }),
    }));
  }
  const slowInstances = instancesFor('slow', HEAT_LINE_SLOW_WIDTH);
  if (slowInstances.length) {
    _heatSlowPrim = _viewer.scene.groundPrimitives.add(new Cesium.GroundPolylinePrimitive({
      geometryInstances: slowInstances,
      classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
      appearance: new Cesium.PolylineMaterialAppearance({
        material: Cesium.Material.fromType('Color', { color: slowLineColor }),
      }),
    }));
  }

  _heatLineCount = kept.length;
  if (candidates.length > kept.length) {
    console.log(`[Data:Traffic] Heat-lines capped at ${HEAT_LINE_CAP} (${candidates.length} congested roads in view)`);
  }
}

/**
 * Clear existing dots and re-spawn them for the given road set and altitude.
 *
 * When zoomed out (>5 km), only major road types are rendered to reduce clutter.
 * Dot budgets are allocated fairly across visible roads via `allocateRoadDotBudgets`.
 *
 * @param {Array} roads    - Parsed road objects to render.
 * @param {number} altitude - Camera altitude in meters.
 * @param {string} label    - Logging label (e.g. "Cache full", "Loaded major").
 * @param {Object|null} [trace=null] - Development-only correlated load trace.
 */
function renderRoadsForAltitude(roads, altitude, label, trace = null) {
  const state = TRAFFIC_TIMING_ENABLED && trace
    ? trafficTimingRenderState(trace, label)
    : null;
  const renderId = state ? ++trace.renderSequence : null;
  clearDots();
  _roads = roads;
  _lastRenderAltitude = altitude;

  // At high altitude, drop minor roads to reduce visual noise
  const filteredRoads = visibleRoadsForAltitude(roads, altitude);

  // Closed roads spawn zero dots (computeDotCount/spawnDotsForRoad) — count
  // them here so the closure signal is visible in stats even at zero dots.
  _closedRoads = _liveMode
    ? filteredRoads.reduce((n, r) => n + (r.flow?.closure ? 1 : 0), 0)
    : 0;

  // Fade distances must track the camera-to-AREA distance, not assume a
  // nadir view: oblique pitches put the loaded roads many km away even at
  // low altitude. Probe three roads and stretch the curves accordingly.
  let areaDist = altitude;
  if (_viewer && filteredRoads.length) {
    const probes = [
      filteredRoads[0],
      filteredRoads[Math.floor(filteredRoads.length / 2)],
      filteredRoads[filteredRoads.length - 1],
    ];
    for (const probe of probes) {
      const wp = probe?.waypoints?.[0];
      if (wp) areaDist = Math.max(areaDist, Cesium.Cartesian3.distance(_viewer.camera.positionWC, wp));
    }
  }
  _fadeScaleFar = Math.max(8000, areaDist * 1.5);
  _fadeTransFar = Math.max(10000, areaDist * 1.8);

  const dotStart = state ? trafficTimingMark(state, 'dot-construction-start', {
    renderId,
    renderLabel: label,
    roadCount: roads.length,
    visibleRoadCount: filteredRoads.length,
  }) : null;
  const roadBudgets = allocateRoadDotBudgets(filteredRoads, altitude, MAX_DOTS);
  for (let i = 0; i < filteredRoads.length; i++) {
    const road = filteredRoads[i];
    const budget = roadBudgets[i] || 0;
    if (budget <= 0) continue;
    spawnDotsForRoad(road, altitude, budget);
    if (_dots.length >= MAX_DOTS) break;
  }

  const renderMetrics = state ? {
    renderId,
    renderLabel: label,
    roadCount: roads.length,
    visibleRoadCount: filteredRoads.length,
    dotCount: _dots.length,
  } : null;
  if (state) {
    const dotEnd = trafficTimingMark(state, 'dot-construction-end', renderMetrics);
    trafficTimingMeasure('dot-construction', state, dotStart, dotEnd, renderMetrics);
  }

  const heatStart = state ? trafficTimingMark(state, 'rebuild-heat-lines-start', renderMetrics) : null;
  rebuildHeatLines(filteredRoads);
  if (state) {
    const heatEnd = trafficTimingMark(state, 'rebuild-heat-lines-end', {
      ...renderMetrics,
      heatLineCount: _heatLineCount,
    });
    trafficTimingMeasure('rebuild-heat-lines', state, heatStart, heatEnd, {
      ...renderMetrics,
      heatLineCount: _heatLineCount,
    });
  }

  _count = _dots.length;
  _lastUpdate = Date.now();
  console.log(`[Data:Traffic] ${label}: ${_count} dots (roads=${roads.length}, alt=${Math.round(altitude)}m)`);
  if (state) {
    const renderEnd = trafficTimingMark(state, 'render-return', renderMetrics);
    scheduleTrafficTimingPostRender(state, renderEnd, renderId, renderMetrics);
  }
}

// ─── Development-only causal timing ───────────────────────

/**
 * Return (and optionally update) the current trace's state for a render pass.
 * This function is only reachable when `TRAFFIC_TIMING_ENABLED` is true.
 *
 * @param {Object|null} trace - Correlated load trace.
 * @param {'major'|'full'} pass - Road-fetch/render pass.
 * @param {string} [source] - Client cache or proxy/network source.
 * @returns {Object|null} Mutable pass timing state.
 */
function trafficTimingPass(trace, pass, source) {
  if (!trace) return null;
  let state = trace.passes.get(pass);
  if (!state) {
    state = {
      trace,
      pass,
      source: source || 'unknown',
      proxyCache: null,
      proxyUpstream: null,
    };
    trace.passes.set(pass, state);
  } else if (source) {
    state.source = source;
  }
  return state;
}

/** Build a structured-clone-safe detail object for User Timing entries. */
function trafficTimingDetail(state, segment, extra = {}) {
  return {
    trafficTiming: true,
    segment,
    traceId: state?.trace?.id ?? null,
    interactionId: state?.trace?.interactionId ?? null,
    cameraChangeTimestamp: state?.trace?.cameraChangeTimestamp ?? null,
    generation: state?.trace?.generation ?? null,
    cacheKey: state?.trace?.cacheKey ?? null,
    pass: state?.pass || 'load',
    source: state?.source || 'unknown',
    proxyCache: state?.proxyCache || null,
    proxyUpstream: state?.proxyUpstream || null,
    ...extra,
  };
}

/** Add a uniquely named User Timing mark and return its name. */
function trafficTimingMark(state, phase, extra = {}, startTime) {
  const traceId = state?.trace?.id ?? 'interaction';
  const pass = state?.pass || 'load';
  const name = `traffic:${traceId}:${pass}:${phase}:${++_trafficTimingSequence}`;
  const options = { detail: trafficTimingDetail(state, phase, extra) };
  if (Number.isFinite(startTime)) options.startTime = startTime;
  performance.mark(name, options);
  return name;
}

/** Emit a named User Timing measure between two marks. */
function trafficTimingMeasure(segment, state, start, end, extra = {}) {
  performance.measure(`traffic:${segment}:${state?.pass || 'load'}`, {
    start,
    end,
    detail: trafficTimingDetail(state, segment, extra),
  });
}

/** Emit an aggregate-duration measure without pretending its work was contiguous. */
function trafficTimingAggregate(segment, state, anchorTime, duration, extra = {}) {
  const start = trafficTimingMark(state, `${segment}-aggregate-start`, extra, anchorTime);
  const end = trafficTimingMark(state, `${segment}-aggregate-end`, extra, anchorTime + duration);
  trafficTimingMeasure(segment, state, start, end, { aggregate: true, ...extra });
}

/** Clear only this module's stale User Timing entries before a new debug run. */
function clearTrafficTimingEntries() {
  const markNames = new Set(
    performance.getEntriesByType('mark')
      .filter((entry) => entry.name.startsWith('traffic:'))
      .map((entry) => entry.name),
  );
  const measureNames = new Set(
    performance.getEntriesByType('measure')
      .filter((entry) => entry.name.startsWith('traffic:'))
      .map((entry) => entry.name),
  );
  for (const name of markNames) performance.clearMarks(name);
  for (const name of measureNames) performance.clearMeasures(name);
}

/** Return the stable User Timing mark name for a scheduling interaction. */
function trafficTimingCameraChangeMarkName(interactionId) {
  return `traffic:interaction:${interactionId}:last-camera-change`;
}

/** Mint and mark the exact camera-change interaction that armed a debounced load. */
function markTrafficTimingCameraChange() {
  const interactionId = ++_trafficTimingSequence;
  const timestamp = performance.now();
  const anchor = { interactionId, timestamp };
  _trafficTimingCurrentAnchor = anchor;
  performance.mark(trafficTimingCameraChangeMarkName(interactionId), {
    startTime: timestamp,
    detail: {
      trafficTiming: true,
      segment: 'last-camera-change',
      interactionId,
      timestamp,
    },
  });
  return anchor;
}

/**
 * Mark Cesium's diagnostic moveEnd notification. Cesium normally emits this
 * about 500 ms after stillness, so fetch has typically already started and
 * never waits for this boundary.
 */
function markTrafficTimingMoveEnd() {
  const diagnosticId = ++_trafficTimingSequence;
  const timestamp = performance.now();
  const name = `traffic:diagnostic:${diagnosticId}:camera-move-end`;
  performance.mark(name, {
    startTime: timestamp,
    detail: {
      trafficTiming: true,
      segment: 'camera-move-end',
      diagnosticOnly: true,
      cameraEventWaitTimeMs: 500,
      fetchWaitsForMoveEnd: false,
      timestamp,
    },
  });
}

/**
 * Instrumented twin of `parseRoads`. Operation ordering and road output match
 * the normal function; debug-only clocks accumulate synchronous height and
 * waypoint-materialization time independently.
 */
function parseRoadsTimed(overpassData, trace) {
  /* TRACE_ONLY_BEGIN */
  const _trafficTimingState = trafficTimingPass(trace, trace?.currentPass || 'full');
  const _trafficTimingParseStartTime = performance.now();
  const _trafficTimingParseStart = trafficTimingMark(
    _trafficTimingState, 'road-parse-start', {}, _trafficTimingParseStartTime
  );
  /* TRACE_ONLY_END */
  if (!overpassData || !overpassData.elements) {
    /* TRACE_ONLY_BEGIN */
    const _trafficTimingParseEnd = trafficTimingMark(
      _trafficTimingState, 'road-parse-end', { roadCount: 0 }
    );
    trafficTimingMeasure(
      'road-parse-total', _trafficTimingState,
      _trafficTimingParseStart, _trafficTimingParseEnd, { roadCount: 0 }
    );
    trafficTimingAggregate('sample-height-total', _trafficTimingState, _trafficTimingParseStartTime, 0, {
      sampleHeightCalls: 0,
      sampleHeightMeanMs: 0,
      distinctCells: 0,
      roadCount: 0,
    });
    trafficTimingAggregate(
      'waypoint-materialization', _trafficTimingState, _trafficTimingParseStartTime, 0,
      { roadCount: 0 }
    );
    /* TRACE_ONLY_END */
    return [];
  }

  const roads = [];
  /* TRACE_ONLY_BEGIN */
  const _trafficTimingSampledCells = new Set();
  let _trafficTimingSampleHeightCalls = 0;
  let _trafficTimingSampleHeightMs = 0;
  let _trafficTimingWaypointMaterializationMs = 0;
  /* TRACE_ONLY_END */
  for (const el of overpassData.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;

    const rawCoords = el.geometry.map(g => [g.lon, g.lat]);
    const simplifyStep = rawCoords.length > MAX_WAYPOINTS_PER_ROAD
      ? Math.ceil(rawCoords.length / MAX_WAYPOINTS_PER_ROAD)
      : 1;
    const coords = [];
    for (let i = 0; i < rawCoords.length; i += simplifyStep) {
      coords.push(rawCoords[i]);
    }

    const last = rawCoords[rawCoords.length - 1];
    const tail = coords[coords.length - 1];
    if (!tail || tail[0] !== last[0] || tail[1] !== last[1]) {
      coords.push(last);
    }
    if (coords.length < 2) continue;

    const type = el.tags?.highway || 'unclassified';
    const onewayTag = el.tags?.oneway;
    const oneway = (onewayTag === 'yes' || onewayTag === '1' || onewayTag === 'true' || el.tags?.junction === 'roundabout')
      ? 1
      : (onewayTag === '-1' ? -1 : 0);

    let baseHeight = 0;
    const firstCoord = coords[0];
    if (_viewer?.scene?.sampleHeightSupported && firstCoord) {
      /* TRACE_ONLY_BEGIN */
      _trafficTimingSampleHeightCalls += 1;
      _trafficTimingSampledCells.add(`${firstCoord[1].toFixed(3)},${firstCoord[0].toFixed(3)}`);
      /* TRACE_ONLY_END */
      const carto = Cesium.Cartographic.fromDegrees(firstCoord[0], firstCoord[1]);
      /* TRACE_ONLY_BEGIN */
      const _trafficTimingSampleStart = performance.now();
      /* TRACE_ONLY_END */
      const sampled = _viewer.scene.sampleHeight(carto);
      /* TRACE_ONLY_BEGIN */
      _trafficTimingSampleHeightMs += performance.now() - _trafficTimingSampleStart;
      /* TRACE_ONLY_END */
      if (Number.isFinite(sampled)) baseHeight = sampled;
    }

    /* TRACE_ONLY_BEGIN */
    const _trafficTimingMaterializeStart = performance.now();
    /* TRACE_ONLY_END */
    const waypoints = coords.map(([lng, lat]) => {
      const h = baseHeight + DOT_HEIGHT_OFFSET;
      return Cesium.Cartesian3.fromDegrees(lng, lat, h);
    });
    const segmentDist = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      segmentDist.push(Cesium.Cartesian3.distance(waypoints[i], waypoints[i + 1]));
    }
    /* TRACE_ONLY_BEGIN */
    _trafficTimingWaypointMaterializationMs += performance.now() - _trafficTimingMaterializeStart;
    /* TRACE_ONLY_END */

    roads.push({ coords, type, oneway, waypoints, segmentDist });
  }

  /* TRACE_ONLY_BEGIN */
  const _trafficTimingMetrics = {
    roadCount: roads.length,
    sampleHeightCalls: _trafficTimingSampleHeightCalls,
    sampleHeightMeanMs: _trafficTimingSampleHeightCalls
      ? _trafficTimingSampleHeightMs / _trafficTimingSampleHeightCalls
      : 0,
    distinctCells: _trafficTimingSampledCells.size,
  };
  trafficTimingAggregate(
    'sample-height-total', _trafficTimingState, _trafficTimingParseStartTime,
    _trafficTimingSampleHeightMs, _trafficTimingMetrics
  );
  trafficTimingAggregate(
    'waypoint-materialization', _trafficTimingState, _trafficTimingParseStartTime,
    _trafficTimingWaypointMaterializationMs, _trafficTimingMetrics
  );
  const _trafficTimingParseEnd = trafficTimingMark(
    _trafficTimingState, 'road-parse-end', _trafficTimingMetrics
  );
  trafficTimingMeasure(
    'road-parse-total', _trafficTimingState,
    _trafficTimingParseStart, _trafficTimingParseEnd, _trafficTimingMetrics
  );
  /* TRACE_ONLY_END */
  return roads;
}

/** Resolve a render label into its correlated pass and data source. */
function trafficTimingRenderState(trace, label) {
  const pass = label.toLowerCase().includes('major') ? 'major' : 'full';
  const source = label.startsWith('Cache') ? 'client-cache' : 'proxy';
  return trafficTimingPass(trace, pass, source);
}

/** Record the first Cesium postRender following a completed dot render. */
function scheduleTrafficTimingPostRender(state, renderEnd, renderId, renderMetrics) {
  if (!_viewer?.scene) return;
  let remove = null;
  remove = _viewer.scene.postRender.addEventListener(() => {
    remove?.();
    _trafficTimingPostRenderRemovers?.delete(remove);
    const visibleTime = performance.now();
    const postRender = trafficTimingMark(state, 'next-post-render', {
      renderId,
      ...renderMetrics,
    }, visibleTime);
    const firstVisible = trafficTimingMark(state, 'first-visible-pixel', {
      renderId,
      visibleBoundary: 'next-postRender',
      ...renderMetrics,
    }, visibleTime);
    trafficTimingMeasure('render-to-post-render', state, renderEnd, postRender, {
      renderId,
      visibleBoundary: 'next-postRender',
      ...renderMetrics,
    });
    trafficTimingMeasure(
      'last-camera-change-to-first-visible', state, state.trace.cameraChangeMark, firstVisible,
      { renderId, visibleBoundary: 'next-postRender', ...renderMetrics }
    );
  });
  _trafficTimingPostRenderRemovers?.add(remove);
}

/** Start a scheduling-correlated debug trace, or count and drop an unpaired load. */
async function loadRoadsForBoundsTimed(bounds, altitude, expectedAnchor) {
  const generation = _loadGeneration + 1;
  if (!expectedAnchor || expectedAnchor !== _trafficTimingCurrentAnchor) {
    _trafficTimingDroppedTraces += 1;
    await loadRoadsForBounds(bounds, altitude);
    return;
  }
  _trafficTimingCurrentAnchor = null;
  const clamped = clampBounds(bounds);
  const trace = {
    id: ++_trafficTimingSequence,
    interactionId: expectedAnchor.interactionId,
    cameraChangeTimestamp: expectedAnchor.timestamp,
    cameraChangeMark: trafficTimingCameraChangeMarkName(expectedAnchor.interactionId),
    generation,
    cacheKey: `${clamped.south.toFixed(4)},${clamped.west.toFixed(4)},${clamped.north.toFixed(4)},${clamped.east.toFixed(4)}`,
    currentPass: null,
    renderSequence: 0,
    passes: new Map(),
  };
  _trafficTimingTracesCreated += 1;
  await loadRoadsForBounds(bounds, altitude, trace);
}

// Disabled-path contract: these references resolve directly to the original
// functions. Instrumentation adds no load-path callbacks or per-item checks.
const _parseRoads = TRAFFIC_TIMING_ENABLED
  ? (data, trace) => (trace ? parseRoadsTimed(data, trace) : parseRoads(data))
  : parseRoads;
const _loadRoadsForBounds = TRAFFIC_TIMING_ENABLED
  ? loadRoadsForBoundsTimed
  : loadRoadsForBounds;

/**
 * Load road data for the given viewport bounds and render traffic dots.
 *
 * Implements a two-pass fetch strategy with tile caching:
 *
 *  1. Check the tile cache (keyed by clamped bounding-box coordinates).
 *     - If a full road set is cached, render immediately and return.
 *     - If only major roads are cached, render those first.
 *  2. Fetch major roads from Overpass (fast, small payload). Render.
 *  3. If altitude is low enough (< FAST_FETCH_ALTITUDE), fetch the full
 *     road graph (includes tertiary/residential). Render again to upgrade.
 *
 * Each fetch is guarded by a monotonic `_loadGeneration` counter so that
 * stale responses from superseded requests are silently discarded.
 *
 * @param {{south:number, west:number, north:number, east:number}} bounds
 *   Viewport bounds (will be clamped internally).
 * @param {number} altitude - Camera altitude in meters.
 * @param {Object|null} [trace=null] - Development-only correlated load trace.
 * @returns {Promise<void>}
 */
async function loadRoadsForBounds(bounds, altitude, trace = null) {
  // Increment generation to invalidate any in-flight responses from prior calls
  const generation = ++_loadGeneration;
  cancelActiveFetch();
  const clamped = clampBounds(bounds);

  // Cache key: fixed-precision bounding-box string for deterministic lookups
  const cacheKey = `${clamped.south.toFixed(4)},${clamped.west.toFixed(4)},${clamped.north.toFixed(4)},${clamped.east.toFixed(4)}`;

  // Live mode: warm the flow-tile cache CONCURRENTLY with the Overpass road
  // fetch — sequential fetches doubled first-paint latency (field-test
  // round 1). Failures are irrelevant; applyFlowToRoads settles the truth.
  ensureFlowStatus().then(() => {
    if (_liveMode && _enabled && generation === _loadGeneration) {
      fetchFlowForBounds(clamped, {}).catch(() => { /* warm-up only */ });
    }
  });

  _fetching = true;
  // Only COMMIT these on success. Committing up-front means a failed Overpass
  // fetch (rate-limited / feed down) still trips the overlap gate in
  // onCameraChanged, so a stationary user never retries (H3/H5). Stage the
  // prospective values and roll back if nothing rendered.
  const prevBounds = _lastBounds;
  const prevViewCenter = _lastViewCenter;
  _lastBounds = clamped;
  _lastViewCenter = getBoundsCenter(clamped);
  let renderedSomething = false;

  try {
    let cache = _tileCache.get(cacheKey);
    if (!cache) {
      // LRU eviction: drop the oldest entry when cache exceeds the cap
      if (_tileCache.size >= TILE_CACHE_MAX_ENTRIES) {
        const oldest = _tileCache.keys().next().value;
        _tileCache.delete(oldest);
      }
      cache = { major: null, full: null };
      _tileCache.set(cacheKey, cache);
    }

    // Fast path: full road set already cached — render and return.
    // Flow is (re)applied even on cache hits: roads cache for the session,
    // but congestion data has a 120s shelf life. The race renders within
    // FLOW_RENDER_RACE_MS either way; late flow recolors in place.
    if (cache.full) {
      renderedSomething = await applyFlowThenRender(
        cache.full, clamped, generation, altitude, 'Cache full', trace
      );
      return;
    }

    // Intermediate path: render cached major roads while fetching the rest
    if (cache.major) {
      if (!await applyFlowThenRender(
        cache.major, clamped, generation, altitude, 'Cache major', trace
      )) return;
      renderedSomething = true;
    } else {
      // Fetch major roads first (smaller payload, faster response)
      _activeFetchAbort = new AbortController();
      console.log(`[Data:Traffic] Fast fetch major roads [${cacheKey}]`);
      const majorData = await fetchRoads(
        clamped.south, clamped.west, clamped.north, clamped.east,
        { majorOnly: true, timeoutSec: 12, signal: _activeFetchAbort.signal },
        trace,
      );
      // Discard stale response if a newer load was triggered while waiting
      if (generation !== _loadGeneration) return;
      cache.major = _parseRoads(majorData, trace);
      if (!await applyFlowThenRender(
        cache.major, clamped, generation, altitude, 'Loaded major', trace
      )) return;
      renderedSomething = true;
    }

    // At higher altitude, major roads provide sufficient motion density
    if (altitude > FAST_FETCH_ALTITUDE) return;

    // Detailed pass: fetch the full road graph (tertiary, residential, etc.)
    _activeFetchAbort = new AbortController();
    console.log(`[Data:Traffic] Full fetch local roads [${cacheKey}]`);
    const fullData = await fetchRoads(
      clamped.south, clamped.west, clamped.north, clamped.east,
      { majorOnly: false, timeoutSec: 20, signal: _activeFetchAbort.signal },
      trace,
    );
    if (generation !== _loadGeneration) return;

    cache.full = _parseRoads(fullData, trace);
    if (!await applyFlowThenRender(
      cache.full, clamped, generation, altitude, 'Loaded full', trace
    )) return;
    renderedSomething = true;

  } catch (e) {
    if (e?.name === 'AbortError') return;
    console.warn('[Data:Traffic] Fetch error:', e);
  } finally {
    if (generation === _loadGeneration) {
      _fetching = false;
      // Roll back the bounds commit if this load rendered nothing (e.g. the
      // Overpass fetch failed). Leaving them committed would make the overlap
      // gate skip the retry while the user sits still. Guarded on generation so
      // a superseding load's commit is not clobbered.
      if (!renderedSomething) {
        _lastBounds = prevBounds;
        _lastViewCenter = prevViewCenter;
      }
    }
    _activeFetchAbort = null;
  }
}

// ─── Cleanup ───────────────────────────────────────────────

/** Remove all point primitives and reset dot/road arrays and counters. */
function clearDots() {
  if (_pointCollection) _pointCollection.removeAll();
  removeHeatLines();
  _dots = [];
  _roads = [];
  _count = 0;
  _bucketCounts = { free: 0, slow: 0, jam: 0, sim: 0 };
  _closedRoads = 0;
}

// ─── Data Layer Interface ──────────────────────────────────

/**
 * Traffic data layer — conforms to the God's Eye View data-layer interface.
 *
 * Lifecycle: init -> enable -> (animate loop + camera-driven loads) -> disable -> destroy.
 * The layer is self-updating: no external tick is needed (`updateInterval: 0`).
 *
 * @type {Object}
 */
const trafficLayer = {
  id: 'traffic',
  name: 'Street Traffic',
  icon: '🚗',
  source: 'OpenStreetMap',
  /** @type {number} Zero — layer is self-managed via camera listener + preRender */
  updateInterval: 0,

  /**
   * One-time initialisation. Creates the PointPrimitiveCollection and adds it
   * to the scene (hidden). The collection is never removed and re-added — only
   * toggled via `.show` to avoid destroy-on-remove errors.
   *
   * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
   */
  init(viewer) {
    _viewer = viewer;
    _pointCollection = new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    // Add permanently — toggle with .show to avoid destroy-on-remove errors
    viewer.scene.primitives.add(_pointCollection);
    _pointCollection.show = false;
    _dots = [];
    _roads = [];
    _count = 0;
    _lastUpdate = null;
    _lastBounds = null;
    _fetching = false;
    _loadGeneration = 0;
    _densityScale = 1.0;
    _speedScale = 1.0;
    _lastViewCenter = null;
    _flowCoveragePct = 0;
    _flowError = null;
    if (TRAFFIC_TIMING_ENABLED) {
      _trafficTimingCurrentAnchor = null;
      _trafficTimingSequence = 0;
      _trafficTimingTracesCreated = 0;
      _trafficTimingDroppedTraces = 0;
    }

    // Preset-aware dot styling: adopt the active post-FX style (persisted
    // style restore may run before layer registration, so read the dataset)
    // and follow StyleManager's gev:style-change event thereafter. Guarded
    // for non-browser contexts; bound once per page (init survives layer
    // destroy/re-register).
    if (typeof window !== 'undefined') {
      _stylePreset = document?.documentElement?.dataset?.gevStyle || 'normal';
      if (!_styleListenerBound) {
        window.addEventListener('gev:style-change', (e) => setStylePreset(e?.detail?.style));
        _styleListenerBound = true;
      }
    }
    refreshBucketColors();
    console.log('[Data:Traffic] Initialized');
  },

  /**
   * Enable the traffic layer. Shows the point collection, subscribes to the
   * preRender animation loop and camera-change events, and kicks off an
   * initial viewport check.
   *
   * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
   */
  enable(viewer) {
    _enabled = true;
    holdContinuousRender('traffic'); // per-frame animator (perf wave 2)
    _lastAnimTime = 0;
    _pointCollection.show = true;

    // One status check per session decides sim vs live-TomTom mode.
    ensureFlowStatus();

    _preRenderRemover = viewer.scene.preRender.addEventListener(animate);
    if (TRAFFIC_TIMING_ENABLED) {
      clearTrafficTimingEntries();
      _trafficTimingCurrentAnchor = null;
      _trafficTimingPostRenderRemovers = new Set();
      _trafficTimingMoveEndRemover = viewer.camera.moveEnd.addEventListener(markTrafficTimingMoveEnd);
    }

    // Subscribe to camera changes with a 5% movement threshold. Save the prior
    // value so disable() can restore it — percentageChanged is a shared global
    // on the camera and leaving it mutated affects every other camera.changed
    // listener in the app.
    viewer.camera.changed.addEventListener(onCameraChanged);
    _prevPercentageChanged = viewer.camera.percentageChanged;
    viewer.camera.percentageChanged = 0.05;

    // Kick off initial viewport check
    onCameraChanged();

    // Boot-order guard (field-test round 1: layer sat empty until the user
    // moved): when the persisted layer state re-enables traffic during the
    // intro flyTo, the initial check bails at high altitude — and a camera
    // that then parks never re-fires camera.changed. Retry cheaply until the
    // first load commits, then self-clear. Also acts as a safety kick if a
    // failed first fetch left the viewport unloaded while parked.
    clearInterval(_enableKickTimer);
    _enableKickTimer = setInterval(() => {
      if (!_enabled || _lastUpdate) {
        clearInterval(_enableKickTimer);
        _enableKickTimer = null;
        return;
      }
      if (!_fetching) onCameraChanged();
    }, 1500);
  },

  /**
   * Disable the traffic layer. Cancels pending fetches, clears all dots,
   * unsubscribes from events, and hides the point collection.
   *
   * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
   */
  disable(viewer) {
    _enabled = false;
    releaseContinuousRender('traffic');
    clearTimeout(_fetchTimeout);
    clearInterval(_enableKickTimer);
    _enableKickTimer = null;
    cancelActiveFetch();
    _loadGeneration++;
    clearDots();
    _lastViewCenter = null;
    // A stale outage from the last session would misreport a fresh enable —
    // the next load re-derives feed health from real evidence.
    _flowError = null;

    if (_preRenderRemover) {
      _preRenderRemover();
      _preRenderRemover = null;
    }
    if (TRAFFIC_TIMING_ENABLED) {
      _trafficTimingMoveEndRemover?.();
      _trafficTimingMoveEndRemover = null;
      for (const remove of _trafficTimingPostRenderRemovers || []) remove();
      _trafficTimingPostRenderRemovers = null;
      _trafficTimingCurrentAnchor = null;
    }

    viewer.camera.changed.removeEventListener(onCameraChanged);
    // Restore the camera's global percentageChanged so other layers/listeners
    // keep their expected sensitivity.
    if (_prevPercentageChanged != null) {
      viewer.camera.percentageChanged = _prevPercentageChanged;
      _prevPercentageChanged = null;
    }
    _pointCollection.show = false;
  },

  /**
   * No-op — traffic updates are entirely camera-driven, not timer-driven.
   * @returns {Promise<void>}
   */
  async update() {
    // No-op — updates are camera-driven
  },

  /**
   * Update user-adjustable parameters (density and speed scaling).
   *
   * @param {Object}  [params]
   * @param {number}  [params.densityScale] - Dot density multiplier (clamped 0.2–2.5).
   * @param {number}  [params.speedScale]   - Dot speed multiplier (clamped 0.3–3.0).
   */
  setParams(params = {}) {
    if (typeof params.densityScale === 'number') {
      _densityScale = Math.max(0.2, Math.min(2.5, params.densityScale));
    }
    if (typeof params.speedScale === 'number') {
      _speedScale = Math.max(0.3, Math.min(3.0, params.speedScale));
    }
    // Live-mode treatment of roads TomTom has no flow data for:
    // 'sim' (default) keeps them as today's white ambient dots — colored =
    // real data, white = simulation; 'hide' spawns nothing on them (strict
    // data-integrity view). Owner-explorable; re-render applies on the next
    // camera-driven load.
    if (params.uncoveredRoads === 'sim' || params.uncoveredRoads === 'hide') {
      _uncoveredMode = params.uncoveredRoads;
    }
    // Jam-viz prototype toggle (A/B): 'none' = shipped main behavior;
    // live mode only, applies on the next camera-driven load like the
    // uncoveredRoads param above.
    if (['none', 'density', 'heatline', 'both'].includes(params.jamViz)) {
      _jamViz = params.jamViz;
    }
    // Preset-aware dot styling kill switch (A/B): 'off' forces the
    // shipped palette under every post-FX preset. Applies immediately via
    // in-place restyle — no refetch — so A/B legs share identical dots.
    if (params.presetDots === 'on' || params.presetDots === 'off') {
      if (params.presetDots !== _presetDots) {
        _presetDots = params.presetDots;
        restyleDotsInPlace();
      }
    }
  },

  /**
   * Return the current user-adjustable parameters.
   * @returns {{densityScale:number, speedScale:number}}
   */
  getParams() {
    return {
      densityScale: _densityScale,
      speedScale: _speedScale,
      uncoveredRoads: _uncoveredMode,
      jamViz: _jamViz,
      presetDots: _presetDots,
    };
  },

  /**
   * Return a sub-sampled list of active dot positions for detection overlays
   * (e.g. CCTV bounding-box rendering).
   *
   * Uses a deterministic stride-based sampling so different seeds yield
   * non-overlapping subsets without sorting or shuffling.
   *
   * @param {Object}  [options]
   * @param {number}  [options.maxCount] - Maximum objects to return (defaults to all).
   * @param {number}  [options.seed]     - Integer seed to offset the sampling start.
   * @returns {Array<{position:Cesium.Cartesian3, id:string, type:string}>}
   */
  getDetectableObjects(options = {}) {
    if (!_enabled || _dots.length === 0) return [];
    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : _dots.length;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    // Stride-based sampling: step through dots evenly to get ~maxCount samples
    const stride = Math.max(1, Math.ceil(_dots.length / maxCount));
    const start = seed % stride;

    const result = [];
    for (let i = start; i < _dots.length; i += stride) {
      const pos = _dots[i].point.position;
      if (!pos) continue;
      const entry = {
        position: pos,
        id: `VEH-${String(i).padStart(4, '0')}`,
        type: 'VEH',
      };
      // Live mode: the detection bracket carries the congestion signal —
      // its canvas sits ABOVE the post-FX chain, so tier colors survive
      // every preset (follow-up round 2: "bounding boxes do the heavy
      // lifting"). Keyless mode sets no tier: contacts keep the stock
      // 'vehicle' bracket and the keyless experience stays untouched.
      if (_liveMode) {
        const tier = trafficBucketTier(_dots[i].bucket || 'sim');
        if (tier) entry.tier = tier;
      }
      result.push(entry);
      if (result.length >= maxCount) break;
    }
    return result;
  },

  /**
   * Permanently tear down the layer. Disables it, removes the point collection
   * from the scene, and clears the tile cache.
   *
   * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
   */
  destroy(viewer) {
    this.disable(viewer);
    if (_pointCollection) {
      viewer.scene.primitives.remove(_pointCollection);
      _pointCollection = null;
    }
    removeHeatLines();
    _tileCache.clear();
    resetFlowTileCache();
    _count = 0;
    _lastUpdate = null;
  },

  /**
   * Return current layer statistics for UI status chips.
   * `mode` is the CONFIGURED source — 'live' (a TomTom key is present) or
   * 'sim' (keyless simulation, which the manager renders as a FALLBACK chip);
   * `error` carries this instant's health, so a live-configured layer whose
   * flow feed went down reads DEGRADED with the reason instead of a stale
   * LIVE coverage number. `flowCoveragePct` is matched roads / roads with any
   * flow candidates (0–100 int); `tilesFetched` counts flow-tile requests
   * issued to the proxy this session (decode-cache hits excluded).
   * @returns {{count:number, lastUpdate:number|null, loading:boolean,
   *   mode:'live'|'sim', error:string|null, flowCoveragePct:number,
   *   tilesFetched:number}}
   */
  getStats() {
    // Outstanding flow work counts as loading: the paint race can leave a
    // TomTom request in flight after the roads have settled, and the shared
    // loading batch has to stay open long enough to announce its failure.
    const loading = _fetching || _flowPending > 0;
    const feed = trafficFeedPresentation({
      liveMode: _liveMode,
      fetching: loading,
      flowError: _flowError,
      coveragePct: _flowCoveragePct,
      statusUnavailable: _flowStatusUnavailable,
    });
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      loading,
      mode: feed.mode,
      error: feed.error,
      flowCoveragePct: _flowCoveragePct,
      tilesFetched: getFlowSessionStats().tilesFetched,
      ...(TRAFFIC_TIMING_ENABLED ? { trafficTiming: getTrafficTimingDiagnostics() } : {}),
      // Per-bucket rendered-dot counts (sim = white ambient). Drives the
      // qa-traffic color assertions and the sync-chip mode label below.
      flowBuckets: { ..._bucketCounts },
      closedRoads: _closedRoads,
      // Jam-viz prototype diagnostics (additive — harness contract untouched).
      heatLines: _heatLineCount,
      jamViz: _jamViz,
      // Preset-styling diagnostics (additive): active style + profile.
      stylePreset: _stylePreset,
      styleProfile: _presetDots === 'on' ? trafficStyleProfile(_stylePreset) : 'normal',
      // Sync-chip text: shown while busy, and flashed on its own for 1.5 s
      // after each completed load (ui.js _updateTrafficSyncChip semantics).
      // The settled flash carries NO progress number beside it — this label's
      // coverage figure is the chip's only percentage — so a label that ends
      // in one had better be the honest one. This is also where LIVE vs
      // SIMULATED mode is surfaced, and it must never imply a live feed the
      // layer does not have.
      loadingLabel: feed.loadingLabel,
    };
  },
};

export default trafficLayer;
