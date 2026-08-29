import * as Cesium from 'cesium';
import {
  getKeyholeFadeTuning,
  getKeyholeGeometry,
  keyholeLabelAlphaFromGeometry,
} from '../celestialRing.js';
import { BoundedCohort, stableIdentityHash } from '../data/detectionCohort.js';
import { LabelArbiter, LABEL_ARBITER_TIMING } from '../data/labelArbiter.js';
import {
  altitudeFade,
  destroyWorldOverlayDraw,
  distanceFade,
  distanceScale,
  measureOverlayEntry,
  paintOverlayEntry,
  placementVariants,
} from './worldOverlayDraw.js';
import { WORLD_OVERLAY_STYLE } from './worldOverlayTokens.js';

/**
 * @module worldOverlay
 * @description Shared screen-space renderer/scheduler for world-anchored
 * labels and cards. Sources own data, business rules, and bounded candidate
 * generation; this host owns projection, final placement, paint, and hits.
 */

const ROOT_ID = 'world-overlay-root';
const CANVAS_ID = 'world-overlay-canvas';
const DETECTION_SURFACE_ID = 'world-overlay-detection-surface';
const ACCESSIBILITY_ROOT_ID = 'world-overlay-actions';
const ACCESSIBILITY_LIST_ID = 'world-overlay-action-list';
const ACCESSIBILITY_STATUS_ID = 'world-overlay-status';
const PAINT_TARGET_SHARED = 'shared';
const PAINT_TARGET_DETECTION = 'detection';
const OCCLUDER_PADDING_PX = 6;
const OCCLUDER_REFRESH_MS = 100;
const DEFAULT_COHORT_LIMIT = 256;
const MAX_SOURCE_COHORT_LIMIT = 900;
const DEFAULT_COLLISION_CAPACITY = 96;
// Phase 4 adds CCTV's shipped 40-card ambient tier to Phase 3's two 96-card
// infrastructure budgets, FIRMS' 18, and the vessel selector's configured
// 900-row absolute ceiling. Runtime vessel demand is the much smaller 118px
// viewport grid (112 at 1600x900, 170 at full HD). This aggregate
// work-conserving ceiling preserves every source's shipped cap; pinned and
// active/protected entries bypass it.
export const AMBIENT_CARD_COLLISION_CAPACITY = 1150;
const DEFAULT_MOVING_SOLVE_MS = 125;
const VALID_VARIANTS = new Set(['label', 'track', 'card', 'thumbnail', 'selected', 'tracked']);

/** Stable logical bottom-to-top paint order across the host-owned surfaces. */
export const WORLD_OVERLAY_PAINT_LANES = Object.freeze([
  'detection',
  'ambient-label',
  'ambient-track',
  'ambient-card',
  'thumbnail',
  'selected',
  'tracked',
]);

const PAINT_LANE_INDEX = new Map(WORLD_OVERLAY_PAINT_LANES.map((lane, index) => [lane, index]));

/**
 * Unified UI exclusion inventory. Selectors may match multiple elements; the
 * service caches their rectangles and observes layout/visibility changes.
 *
 * These rectangles are a PLACEMENT policy, never a paint mask. Every element
 * listed here composites ABOVE the overlay host — map chrome sits at z90–z1000
 * and the cockpit HUD at z145, against this host's z5/z6 — so the browser
 * already keeps overlay pixels off it and no canvas needs clipping. What the
 * inventory buys is readability: a card placed under solid chrome is simply
 * lost, so the solver PREFERS placements clear of it. When nothing is clear the
 * entry still renders and the chrome covers it, exactly as it did before the
 * host existed.
 *
 * The list therefore holds only chrome dense enough to swallow a card. The
 * cockpit's thin translucent line art — rims, arcs, rails, tapes, toplines,
 * readouts — is deliberately ABSENT under the AR-HUD ruling:
 * world-space overlay content renders beneath the cockpit's screen-space HUD,
 * which paints over it by z-order. Those elements are also enormous (the
 * altitude rim is keyhole-tall, the topline viewport-wide), and excluding them
 * suppressed essentially the entire cockpit view. Only the two solid,
 * backdrop-filled cockpit windows survive as exclusions.
 */
export const WORLD_OVERLAY_OCCLUDER_SELECTORS = Object.freeze([
  '#title-bar',
  '#style-indicator',
  '#top-center-actions',
  '#traffic-sync-chip',
  '#cctv-sync-chip',
  '#left-panel-stack',
  '#right-context-rail',
  '#pp-toggles',
  '#command-dock',
  '#gev-voice-control',
  '#cesium-credits',
  '.hud-top-left',
  '.hud-top-right',
  '.hud-bottom-left',
  '.hud-bottom-right',
  '.hud-top-bar',
  '.hud-bottom-bar',
  '#space-mission-panel',
  '#space-mission-panel-host',
  '#military-awareness-panel',
  // Cockpit: solid backdrop-filled windows only (both bounded to
  // `min(340px, 28vw)` wide and `min(42vh, 410px)` tall, both `hidden` until
  // toggled). Every other cockpit selector was removed — see the block comment.
  '#cockpit-context',
  '#cockpit-signal-stream',
]);

/** @typedef {{x:number,y:number,w:number,h:number}} OverlayRect */
/**
 * @typedef {object} WorldOverlayEntry
 * @property {string} id Stable identity within the source.
 * @property {string} source Owning source id.
 * @property {Cesium.Cartesian3|function():Cesium.Cartesian3} position
 * @property {'label'|'track'|'card'|'thumbnail'|'selected'|'tracked'} variant
 * @property {string} [accessibilityLabel] Accessible name for an actionable card.
 * @property {function():*} [activate] Keyboard/assistive activation callback.
 */
/**
 * @typedef {object} WorldOverlaySourceOptions
 * @property {boolean} [visible=true]
 * @property {boolean} [hideInCockpit=false]
 * @property {number} [alpha=1]
 * @property {number} [cohortLimit=256] Ambient surplus retained per domain.
 * @property {number} [collisionCapacity=96] Shared domain paint budget.
 * @property {boolean} [moving=false] Enables bounded interval re-solves.
 * @property {number} [solveIntervalMs=125]
 */

/** @type {Cesium.Viewer|null} */
let _viewer = null;
/** @type {HTMLElement|null} */
let _root = null;
/** @type {HTMLCanvasElement|null} */
let _canvas = null;
/** @type {CanvasRenderingContext2D|null} */
let _ctx = null;
/** @type {HTMLElement|null} Focusable mirror of painted actionable cards. */
let _accessibilityRoot = null;
/** @type {HTMLElement|null} */
let _accessibilityList = null;
/** @type {HTMLElement|null} */
let _accessibilityStatus = null;
let _accessibilitySignature = '';
const _accessibleActivatorByKey = new Map();
/** @type {HTMLCanvasElement|null} Host-owned detection blend-isolation surface. */
let _detectionSurface = null;
/** @type {CanvasRenderingContext2D|null} */
let _detectionCtx = null;
/** @type {Function|null} */
let _removePostRender = null;
/** @type {Function|null} */
let _removeMoveEnd = null;
let _resizeObserver = null;
let _mutationObserver = null;
let _observedOccluderElements = new WeakSet();
let _occluderRefreshTimer = null;
let _cockpitModeHandler = null;
let _windowResizeHandler = null;
let _cockpitActive = false;
/**
 * Set by `destroyWorldOverlay` when it actually tore a host down, and cleared
 * by `initWorldOverlay`. A torn-down host must not be resurrected by a late
 * source callback, so every mutating export short-circuits while this is true.
 * Destroying before the first init leaves it false, so pre-init buffering
 * keeps working.
 */
let _destroyed = false;
let _resizeDirty = true;
let _occludersDirty = true;
let _solveDirty = true;
let _canvasNeedsClear = true;
let _detectionSurfaceNeedsClear = true;
let _occludersUpdatedAt = Number.NEGATIVE_INFINITY;
let _canvasWidth = 0;
let _canvasHeight = 0;
let _canvasDpr = 1;
/**
 * Monotonic per-frame identity. Pooled candidate/rectangle records carry the
 * stamp of the frame that last published them, which replaces the per-frame
 * `Map.clear()` + refill cycle that reallocated a hash table every frame.
 */
let _frameStamp = 0;

/** @type {Map<string, object>} */
const _sources = new Map();
/** @type {Array<object>} Append-only iteration order for `_sources`. */
const _sourceList = [];
/** @type {Map<string, object>} Source-owned painters hosted in fixed lanes. */
const _customPaintLanes = new Map();
/** @type {Array<object>} Stable registration order for custom painters. */
const _customPaintLaneList = [];
/** @type {Map<string, object>} */
const _domains = new Map();
/** @type {Array<object>} Append-only iteration order for `_domains`. */
const _domainList = [];
/** @type {Map<string, object>} */
const _records = new Map();
const _scratchViewProjection = new Cesium.Matrix4();
const _viewProjectionScalars = {};
const _viewport = { width: 0, height: 0 };
let _occluder = null;
let _occluderCameraX = Number.NaN;
let _occluderCameraY = Number.NaN;
let _occluderCameraZ = Number.NaN;
/** Cached keyhole geometry, versioned by both its box and shared tuning. */
let _keyhole = null;
let _keyholeWidth = -1;
let _keyholeHeight = -1;
let _keyholeFadeRatio = Number.NaN;
let _keyholeOutsideOpacity = Number.NaN;
let _layoutRevision = 0;

const _uiOcclusionRects = [];
const _uiOcclusionRectPool = [];
/** Shared, allocation-free frame contract passed to custom paint lanes. */
const _customPaintFrame = {
  canvas: null,
  surface: null,
  ctx: null,
  width: 0,
  height: 0,
  dpr: 1,
  timestamp: 0,
  viewProjectionMatrix: _scratchViewProjection,
  viewProjection: _viewProjectionScalars,
  cameraPosition: null,
  occluder: null,
  keyhole: null,
  uiRects: _uiOcclusionRects,
  uiRectCount: 0,
  layoutRevision: 0,
};
const _paintQueue = [];
const _paintItemPool = [];
const _paintRectPool = [];
const _paintRectByKey = new Map();
const _hitRects = [];
const _paintedBySource = Object.create(null);
const _paintedSourceKeys = [];
// Live lengths of the pooled frame buffers. Pool arrays are never truncated
// per frame, so their backing stores survive instead of being re-grown.
let _paintCount = 0;
let _paintRectCount = 0;
let _hitRectCount = 0;

const _diagnostics = {
  sourceCount: 0,
  entryCount: 0,
  candidateCount: 0,
  projectedCount: 0,
  selectedCount: 0,
  fadingCount: 0,
  paintedCount: 0,
  hitRectCount: 0,
  projectionMs: 0,
  solveMs: 0,
  paintMs: 0,
  solveRevision: 0,
  paintItemPoolSize: 0,
  paintRectPoolSize: 0,
  candidateIndexSize: 0,
  entriesBySource: {},
  paintedBySource: _paintedBySource,
};

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function clamp01(value, fallback = 1) {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : fallback;
}

function assertSourceId(sourceId) {
  if (typeof sourceId !== 'string' || !sourceId.trim()) {
    throw new TypeError('WorldOverlay sourceId must be a non-empty string');
  }
  return sourceId.trim();
}

function entryKey(sourceId, entryId) {
  return `${sourceId}\u0000${entryId}`;
}

function compareStableKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareProtectedEntries(a, b) {
  return b.priority - a.priority || compareStableKeys(a._overlayKey, b._overlayKey);
}

function compareProtectedCandidates(a, b) {
  return b.priority - a.priority || compareStableKeys(a.key, b.key);
}

function comparePaintItems(a, b) {
  return a.lane - b.lane || a.zIndex - b.zIndex || compareStableKeys(a.key, b.key);
}

/**
 * Stable in-place insertion sort over the live prefix of a pooled array.
 * `Array#sort` allocates a work buffer per call; the frame path only ever
 * orders a short, nearly sorted prefix.
 */
function sortPooledRange(items, count, compare) {
  for (let i = 1; i < count; i++) {
    const item = items[i];
    let j = i - 1;
    while (j >= 0 && compare(items[j], item) > 0) {
      items[j + 1] = items[j];
      j--;
    }
    items[j + 1] = item;
  }
}

/** Map#forEach callback that zeroes a demand tally without clearing the map. */
function zeroDemandEntry(value, key, map) {
  map.set(key, 0);
}

/**
 * Amortized prune for a keyed index that is rebuilt every frame but only
 * grows when a source publishes new identities. Clearing unconditionally
 * reallocates the backing hash table per domain per frame, so the index is
 * dropped only once it dwarfs the live cohort — the same policy the arbiter
 * applies to its per-solve key stamps.
 * @param {Map<string, object>} index
 * @param {number} liveCount
 */
function pruneKeyedIndex(index, liveCount) {
  if (index.size > liveCount * 4 + 64) index.clear();
}

function defaultCollisionGroup(variant) {
  if (variant === 'label') return 'ambient-label';
  if (variant === 'track' || variant === 'tracked') return 'ambient-track';
  return 'ambient-card';
}

/** Resolve an entry to one of the seven binding paint lanes. */
export function paintLaneForOverlayEntry(entry = {}) {
  if (PAINT_LANE_INDEX.has(entry.paintLane)) return PAINT_LANE_INDEX.get(entry.paintLane);
  if (entry.tracked || entry.variant === 'tracked') return PAINT_LANE_INDEX.get('tracked');
  if (entry.selected || entry.variant === 'selected') return PAINT_LANE_INDEX.get('selected');
  if (entry.variant === 'thumbnail') return PAINT_LANE_INDEX.get('thumbnail');
  if (entry.variant === 'card') return PAINT_LANE_INDEX.get('ambient-card');
  if (entry.variant === 'track') return PAINT_LANE_INDEX.get('ambient-track');
  return PAINT_LANE_INDEX.get('ambient-label');
}

/**
 * Validate and copy a source entry into the shared presentation contract.
 * Source-specific objects remain opaque in `metadata`; they are never read by
 * the renderer.
 * @param {string} sourceId
 * @param {object} entry
 * @returns {WorldOverlayEntry}
 */
/**
 * Snapshot an entry's optional occlusion-test anchor into a host-owned
 * Cartesian3, mirroring the flights layer's `info.cullPosition || bb.position`
 * idiom: a source whose render anchor can land at or below the ellipsoid
 * (ground floor + lift in a negative-geoid region) supplies a LIFTED point
 * here so the horizon test judges the real surface instead of false-hiding it
 * near the limb. The render position stays datum-correct and untouched.
 *
 * Resolved exactly ONCE per setEntries and never re-read on the paint path:
 * - the property is read a single time, so an accessor-backed field is
 *   invoked once rather than once per validated component;
 * - a throwing accessor is contained here — it degrades that one entry to
 *   "no cull anchor" instead of aborting normalization for the whole source;
 * - the components are copied into a fresh Cartesian3, so a caller mutating
 *   or recycling its own vector after publishing cannot feed NaN (or a moved
 *   point) to the per-frame occluder.
 *
 * @param {object} entry - Raw source entry.
 * @returns {?Cesium.Cartesian3} Host-owned lifted anchor, or null.
 */
function snapshotCullPosition(entry) {
  let candidate;
  try {
    candidate = entry.cullPosition;
  } catch {
    return null; // a hostile/throwing accessor must not break the source
  }
  if (!candidate || typeof candidate !== 'object') return null;
  const { x, y, z } = candidate;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return new Cesium.Cartesian3(x, y, z);
}

export function normalizeOverlayEntry(sourceId, entry) {
  const source = assertSourceId(sourceId);
  if (!entry || typeof entry !== 'object') throw new TypeError('WorldOverlay entry must be an object');
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id) throw new TypeError('WorldOverlay entry.id must be a non-empty string');
  const validPosition = typeof entry.position === 'function'
    || (entry.position && Number.isFinite(entry.position.x)
      && Number.isFinite(entry.position.y) && Number.isFinite(entry.position.z));
  if (!validPosition) {
    throw new TypeError(`WorldOverlay entry ${source}:${id} requires a Cartesian position or getter`);
  }
  const variant = String(entry.variant || 'label');
  if (!VALID_VARIANTS.has(variant)) {
    throw new TypeError(`Unsupported WorldOverlay variant: ${variant}`);
  }
  const normalized = {
    id,
    source,
    position: entry.position,
    cullPosition: snapshotCullPosition(entry),
    variant,
    title: String(entry.title ?? ''),
    details: Array.isArray(entry.details) ? entry.details.map((line) => String(line)) : [],
    accent: entry.accent || WORLD_OVERLAY_STYLE.accent,
    paintLane: entry.paintLane,
    priority: Number.isFinite(Number(entry.priority)) ? Number(entry.priority) : 0,
    selected: entry.selected === true,
    pinned: entry.pinned === true,
    protected: entry.protected === true,
    tracked: entry.tracked === true || variant === 'tracked',
    active: entry.active === true,
    collisionGroup: String(entry.collisionGroup || defaultCollisionGroup(variant)),
    // Explicit field pick rather than `{ ...entry, variant }`: the lane
    // resolver reads only these four, and a full spread re-invokes every
    // accessor the source put on its entry (a throwing one would abort
    // normalization for the whole batch).
    zIndex: Number.isFinite(Number(entry.zIndex))
      ? Number(entry.zIndex)
      : paintLaneForOverlayEntry({
        paintLane: entry.paintLane,
        tracked: entry.tracked,
        selected: entry.selected,
        variant,
      }) * 10,
    interactive: entry.interactive === true,
    accessibilityLabel: String(entry.accessibilityLabel || '').trim(),
    activate: typeof entry.activate === 'function' ? entry.activate : null,
    minDistance: Number.isFinite(Number(entry.minDistance)) ? Math.max(0, Number(entry.minDistance)) : 0,
    maxDistance: Number.isFinite(Number(entry.maxDistance)) ? Math.max(0, Number(entry.maxDistance)) : Number.POSITIVE_INFINITY,
    distanceFadeStartRatio: Number.isFinite(Number(entry.distanceFadeStartRatio))
      ? Math.max(0, Math.min(1, Number(entry.distanceFadeStartRatio)))
      : 0.7,
    distanceScale: normalizeDistanceScale(entry.distanceScale),
    altitudeScale: normalizeAltitudeScale(entry.altitudeScale),
    minAltitude: Number.isFinite(Number(entry.minAltitude)) ? Number(entry.minAltitude) : Number.NEGATIVE_INFINITY,
    altitudeFadeStart: Number.isFinite(Number(entry.altitudeFadeStart))
      ? Number(entry.altitudeFadeStart)
      : Number.POSITIVE_INFINITY,
    altitudeFadeEnd: Number.isFinite(Number(entry.altitudeFadeEnd))
      ? Number(entry.altitudeFadeEnd)
      : Number.POSITIVE_INFINITY,
    edgeFade: entry.edgeFade === false || entry.edgeFade === 'none' ? 'none' : 'keyhole',
    horizonCull: entry.horizonCull !== false,
    terrainOcclusion: entry.terrainOcclusion === true,
    sourceAlpha: clamp01(entry.sourceAlpha ?? entry.alpha, 1),
    temporalAlpha: clamp01(entry.temporalAlpha, 1),
    gapPx: Number.isFinite(Number(entry.gapPx)) ? Math.max(0, Number(entry.gapPx)) : 12,
    leaderOffsetPx: Number.isFinite(Number(entry.leaderOffsetPx))
      ? Math.max(0, Number(entry.leaderOffsetPx))
      : 0,
    anchorRadiusPx: Number.isFinite(Number(entry.anchorRadiusPx))
      ? Math.max(0, Number(entry.anchorRadiusPx))
      : 0,
    anchorRadiusScale: normalizeDistanceScale(entry.anchorRadiusScale),
    minAnchorGapPx: Number.isFinite(Number(entry.minAnchorGapPx))
      ? Math.max(0, Number(entry.minAnchorGapPx))
      : 0,
    anchorGapPaddingPx: Number.isFinite(Number(entry.anchorGapPaddingPx))
      ? Math.max(0, Number(entry.anchorGapPaddingPx))
      : 0,
    verticalOnly: entry.verticalOnly === true,
    // Opt out of the arbiter's statefulness (min-lifetime pinning, re-entry
    // cooldown, enter/exit fades, sticky corner). Sources whose shipped
    // behaviour was a stateless per-frame rebuild set this to keep that feel.
    stateless: entry.stateless === true,
    // Opt-in ANCHOR separation, in CSS px at scale 1, scaled by paintScale at
    // projection. Rectangle overlap alone lets cards stack far denser than a
    // shipped anchor-separation pass did, because the leader gap does not shrink
    // with the card. 0 disables.
    minAnchorSeparationPx: Number.isFinite(Number(entry.minAnchorSeparationPx))
      ? Math.max(0, Number(entry.minAnchorSeparationPx))
      : 0,
    viewportMargin: Number.isFinite(Number(entry.viewportMargin))
      ? Math.max(0, Number(entry.viewportMargin))
      : 4,
    viewportPadding: Number.isFinite(Number(entry.viewportPadding))
      ? Math.max(0, Number(entry.viewportPadding))
      : 64,
    requireImage: entry.requireImage === true,
    safeTopRatio: Number.isFinite(Number(entry.safeTopRatio))
      ? Math.max(0, Number(entry.safeTopRatio))
      : 0,
    safeTopMaxPx: Number.isFinite(Number(entry.safeTopMaxPx))
      ? Math.max(0, Number(entry.safeTopMaxPx))
      : Number.POSITIVE_INFINITY,
    pinnedBypassesSafeTop: entry.pinnedBypassesSafeTop === true,
    placement: String(entry.placement || 'auto'),
    cardStyle: entry.cardStyle,
    image: entry.image ?? null,
    metadata: entry.metadata ?? null,
    thumbnailWidth: entry.thumbnailWidth,
    thumbnailHeight: entry.thumbnailHeight,
    thumbnailPadX: entry.thumbnailPadX,
    thumbnailPadTop: entry.thumbnailPadTop,
    thumbnailPadBottom: entry.thumbnailPadBottom,
    thumbnailTitleGap: entry.thumbnailTitleGap,
    thumbnailTitleHeight: entry.thumbnailTitleHeight,
    thumbnailTitleChars: entry.thumbnailTitleChars,
    thumbnailBackground: entry.thumbnailBackground,
    thumbnailTitleColor: entry.thumbnailTitleColor,
    thumbnailTitleFont: entry.thumbnailTitleFont,
    thumbnailLeaderColor: entry.thumbnailLeaderColor,
    thumbnailRuleColor: entry.thumbnailRuleColor,
    thumbnailRuleHeight: entry.thumbnailRuleHeight,
    thumbnailRadius: entry.thumbnailRadius,
    _overlayTacticalAccentColors: null,
    _overlayTrackDisplayTitle: null,
    _overlayTrackDisplayDetail: null,
    _overlayTrackDisplayText: '',
    _overlayThumbnailTitle: variant === 'thumbnail'
      ? String(entry.title ?? '').toUpperCase().slice(
        0,
        Math.max(0, Math.floor(Number(entry.thumbnailTitleChars) || 0)) || undefined,
      )
      : '',
  };
  normalized._overlayKey = entryKey(source, id);
  normalized._cohortPriority = normalized.priority;
  normalized._cohortBand = 0;
  normalized._cohortHash = stableIdentityHash(source, id);
  normalized._cohortSourceId = id;
  normalized._overlayImageSlot = normalized.requireImage && normalized.image
    && Object.prototype.hasOwnProperty.call(normalized.image, 'frame')
    ? normalized.image
    : null;
  normalized._overlayLayout = {};
  return normalized;
}

function normalizeDistanceScale(curve) {
  if (!curve || typeof curve !== 'object') return null;
  const values = [curve.near, curve.nearValue, curve.far, curve.farValue].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const near = Math.max(0, values[0]);
  const nearValue = Math.max(0, values[1]);
  const far = Math.max(near, values[2]);
  const farValue = Math.max(0, values[3]);
  return { near, nearValue, far, farValue };
}

function normalizeAltitudeScale(curve) {
  if (!curve || typeof curve !== 'object') return null;
  const values = [curve.fullEnd, curve.midEnd, curve.end, curve.midValue, curve.endValue].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const fullEnd = Math.max(0, values[0]);
  const midEnd = Math.max(fullEnd, values[1]);
  const end = Math.max(midEnd, values[2]);
  return {
    fullEnd,
    midEnd,
    end,
    midValue: Math.max(0, values[3]),
    endValue: Math.max(0, values[4]),
    smoothToMid: curve.smoothToMid === true,
  };
}

function normalizeSourceOptions(options = {}, previous = {}) {
  const requestedCapacity = Number(options.collisionCapacity ?? previous.collisionCapacity);
  return {
    visible: options.visible !== undefined ? options.visible !== false : previous.visible !== false,
    hideInCockpit: options.hideInCockpit !== undefined
      ? options.hideInCockpit === true
      : previous.hideInCockpit === true,
    alpha: clamp01(options.alpha, previous.alpha ?? 1),
    cohortLimit: Math.max(1, Math.min(
      MAX_SOURCE_COHORT_LIMIT,
      Math.floor(Number(options.cohortLimit ?? previous.cohortLimit) || DEFAULT_COHORT_LIMIT),
    )),
    collisionCapacity: Number.isFinite(requestedCapacity)
      ? Math.max(0, Math.floor(requestedCapacity))
      : DEFAULT_COLLISION_CAPACITY,
    moving: options.moving !== undefined ? options.moving === true : previous.moving === true,
    solveIntervalMs: Math.max(0, Number(
      options.solveIntervalMs ?? previous.solveIntervalMs ?? DEFAULT_MOVING_SOLVE_MS,
    ) || 0),
  };
}

function isProtected(entry) {
  return entry.selected || entry.pinned || entry.protected || entry.tracked
    || paintLaneForOverlayEntry(entry) >= PAINT_LANE_INDEX.get('selected');
}

/**
 * Bound one source/domain's ambient surplus without evicting protected items.
 * `LabelArbiter` performs the later cross-source, screen-space selection.
 * @param {Array<WorldOverlayEntry>} entries
 * @param {number} limit
 * @param {Set<string>} [incumbentKeys]
 * @returns {Array<WorldOverlayEntry>}
 */
export function selectBoundedOverlayCohort(entries, limit = DEFAULT_COHORT_LIMIT, incumbentKeys = new Set()) {
  const cap = Math.max(1, Math.min(MAX_SOURCE_COHORT_LIMIT, Math.floor(Number(limit) || DEFAULT_COHORT_LIMIT)));
  const protectedEntries = [];
  const bounded = new BoundedCohort(cap, MAX_SOURCE_COHORT_LIMIT);
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    if (isProtected(entry)) {
      protectedEntries.push(entry);
      continue;
    }
    bounded.consider(entry, incumbentKeys.has(entry._overlayKey) || incumbentKeys.has(entry.id));
  }
  protectedEntries.sort(compareProtectedEntries);
  return protectedEntries.concat(bounded.values(cap));
}

function sourceActive(source) {
  return source.options.visible && !(_cockpitActive && source.options.hideInCockpit);
}

function getOrCreateDomain(domainId) {
  let domain = _domains.get(domainId);
  if (!domain) {
    domain = {
      id: domainId,
      arbiter: new LabelArbiter(),
      candidates: [],
      candidateCount: 0,
      candidateMap: new Map(),
      protectedCandidates: [],
      protectedCount: 0,
      protectedRects: [],
      protectedRectCount: 0,
      // Pooled accepted-anchor ring for opt-in anchor separation. Parallel
      // arrays instead of objects so the pass allocates nothing per frame.
      sepX: [],
      sepY: [],
      sepR: [],
      sepSource: [],
      sepCount: 0,
      renderEntries: [],
      demandBySource: new Map(),
      capacity: DEFAULT_COLLISION_CAPACITY,
      lastSolveAt: Number.NEGATIVE_INFINITY,
      moving: false,
      solveIntervalMs: DEFAULT_MOVING_SOLVE_MS,
    };
    _domains.set(domainId, domain);
    _domainList.push(domain);
  }
  return domain;
}

function rebuildSourceCohorts(source) {
  const groups = new Map();
  source.demandByDomain.clear();
  for (const entry of source.entries.values()) {
    if (!groups.has(entry.collisionGroup)) groups.set(entry.collisionGroup, []);
    groups.get(entry.collisionGroup).push(entry);
    if (!isProtected(entry)) {
      source.demandByDomain.set(
        entry.collisionGroup,
        (source.demandByDomain.get(entry.collisionGroup) || 0) + 1,
      );
    }
  }
  let index = 0;
  for (const [domainId, entries] of groups) {
    const incumbentKeys = getOrCreateDomain(domainId).arbiter.selectedKeys;
    source.cohortDomainIds[index] = domainId;
    source.cohortLists[index] = selectBoundedOverlayCohort(
      entries,
      source.options.cohortLimit,
      incumbentKeys,
    );
    index++;
  }
  source.cohortCount = index;
  source.cohortDomainIds.length = index;
  source.cohortLists.length = index;
}

function getOrCreateSource(sourceId, options = {}) {
  const id = assertSourceId(sourceId);
  let source = _sources.get(id);
  if (!source) {
    source = {
      id,
      entries: new Map(),
      cohortDomainIds: [],
      cohortLists: [],
      cohortCount: 0,
      demandByDomain: new Map(),
      options: normalizeSourceOptions(options),
    };
    _sources.set(id, source);
    _sourceList.push(source);
  } else if (options && Object.keys(options).length > 0) {
    source.options = normalizeSourceOptions(options, source.options);
  }
  return source;
}

function invalidateHost({ solve = true, layout = false } = {}) {
  if (solve) _solveDirty = true;
  if (layout) _occludersDirty = true;
  _canvasNeedsClear = true;
  _paintRectCount = 0;
  _hitRectCount = 0;
  _paintRectByKey.clear();
  _viewer?.scene?.requestRender?.();
}

function inertPaintLaneHandle() {
  return { surface: null, setActive() {}, requestPaint() {}, unregister() {} };
}

/**
 * Register a source-owned painter behind one deterministic host lane. The
 * callback receives the host's already-sized/clipped Canvas2D target plus the
 * frame's shared matrix, keyhole, occluder, and UI rectangles. It must not
 * clear or resize the target. The detection target is a host-owned sibling
 * surface used only to preserve element-level scene blending.
 * @param {string} laneId One of `WORLD_OVERLAY_PAINT_LANES`.
 * @param {function(object):void} painter Source-owned paint callback.
 * @param {{id?:string,active?:boolean,target?:'shared'|'detection',shouldPaint?:function(object):boolean}} [options]
 * @returns {{surface:HTMLCanvasElement|null,setActive:function(boolean):void,requestPaint:function():void,unregister:function():void}}
 */
export function registerWorldOverlayPaintLane(laneId, painter, options = {}) {
  if (_destroyed) return inertPaintLaneHandle();
  if (!PAINT_LANE_INDEX.has(laneId)) {
    throw new TypeError(`Unsupported WorldOverlay paint lane: ${laneId}`);
  }
  if (typeof painter !== 'function') {
    throw new TypeError('WorldOverlay custom paint lane requires a painter callback');
  }
  const id = assertSourceId(options.id || laneId);
  const previous = _customPaintLanes.get(id);
  if (previous) {
    const index = _customPaintLaneList.indexOf(previous);
    if (index >= 0) _customPaintLaneList.splice(index, 1);
  }
  const record = {
    id,
    lane: PAINT_LANE_INDEX.get(laneId),
    painter,
    active: options.active === true,
    target: options.target === PAINT_TARGET_DETECTION
      ? PAINT_TARGET_DETECTION
      : PAINT_TARGET_SHARED,
    shouldPaint: typeof options.shouldPaint === 'function' ? options.shouldPaint : null,
  };
  _customPaintLanes.set(id, record);
  _customPaintLaneList.push(record);
  invalidateHost({ solve: false });

  const unregister = () => {
    if (_customPaintLanes.get(id) !== record) return;
    _customPaintLanes.delete(id);
    const index = _customPaintLaneList.indexOf(record);
    if (index >= 0) _customPaintLaneList.splice(index, 1);
    record.active = false;
    invalidateHost({ solve: false });
  };
  return {
    get surface() {
      return record.target === PAINT_TARGET_DETECTION ? _detectionSurface : _canvas;
    },
    setActive(active) {
      if (_destroyed || _customPaintLanes.get(id) !== record) return;
      const next = active === true;
      if (record.active === next) return;
      record.active = next;
      invalidateHost({ solve: false });
    },
    requestPaint() {
      if (_destroyed || _customPaintLanes.get(id) !== record) return;
      invalidateHost({ solve: false });
    },
    unregister,
  };
}

/**
 * Replace all entries owned by a source atomically.
 * @param {string} sourceId
 * @param {object[]} entries
 * @param {WorldOverlaySourceOptions} [options]
 */
export function setOverlayEntries(sourceId, entries, options = {}) {
  if (_destroyed) return;
  if (!Array.isArray(entries)) throw new TypeError('WorldOverlay entries must be an array');
  const source = getOrCreateSource(sourceId, options);
  const normalized = entries.map((entry) => normalizeOverlayEntry(source.id, entry));
  const next = new Map();
  for (const entry of normalized) next.set(entry.id, entry);
  for (const entry of source.entries.values()) {
    if (!next.has(entry.id)) _records.delete(entry._overlayKey);
  }
  source.entries = next;
  rebuildSourceCohorts(source);
  updateEntryDiagnostics();
  invalidateHost();
}

/**
 * Insert or replace one entry without rebuilding another source.
 * @param {string} sourceId
 * @param {object} entry
 */
export function upsertOverlayEntry(sourceId, entry) {
  if (_destroyed) return;
  const source = getOrCreateSource(sourceId);
  const normalized = normalizeOverlayEntry(source.id, entry);
  source.entries.set(normalized.id, normalized);
  rebuildSourceCohorts(source);
  updateEntryDiagnostics();
  invalidateHost();
}

/**
 * Remove one entry by stable identity.
 * @param {string} sourceId
 * @param {string} entryId
 * @returns {boolean}
 */
export function removeOverlayEntry(sourceId, entryId) {
  if (_destroyed) return false;
  const source = _sources.get(assertSourceId(sourceId));
  if (!source) return false;
  const id = String(entryId);
  const removed = source.entries.delete(id);
  if (!removed) return false;
  _records.delete(entryKey(source.id, id));
  rebuildSourceCohorts(source);
  updateEntryDiagnostics();
  invalidateHost();
  return true;
}

/**
 * Remove all entries while retaining the source's registration/options.
 * @param {string} sourceId
 * @returns {boolean}
 */
export function clearOverlaySource(sourceId) {
  if (_destroyed) return false;
  const source = _sources.get(assertSourceId(sourceId));
  if (!source) return false;
  for (const entry of source.entries.values()) _records.delete(entry._overlayKey);
  source.entries.clear();
  source.cohortDomainIds.length = 0;
  source.cohortLists.length = 0;
  source.cohortCount = 0;
  source.demandByDomain.clear();
  updateEntryDiagnostics();
  invalidateHost();
  return true;
}

/**
 * Enable/disable one registered source.
 * @param {string} sourceId
 * @param {boolean} visible
 */
export function setOverlaySourceVisible(sourceId, visible) {
  if (_destroyed) return;
  const source = getOrCreateSource(sourceId);
  const next = visible !== false;
  if (source.options.visible === next) return;
  source.options.visible = next;
  invalidateHost();
}

function updateEntryDiagnostics() {
  const entriesBySource = {};
  let entryCount = 0;
  for (const [sourceId, source] of _sources) {
    entriesBySource[sourceId] = source.entries.size;
    entryCount += source.entries.size;
  }
  _diagnostics.sourceCount = _sources.size;
  _diagnostics.entryCount = entryCount;
  _diagnostics.entriesBySource = entriesBySource;
}

/**
 * Return the most recently published painted box (valid until next frame).
 * @param {string} sourceId
 * @param {string} entryId
 * @returns {(OverlayRect & {sourceId:string,entryId:string})|null}
 */
export function getOverlayPaintRect(sourceId, entryId) {
  if (_destroyed) return null;
  const key = entryKey(String(sourceId), String(entryId));
  const rect = _paintRectByKey.get(key);
  // Pooled rectangles outlive their key, so identity and the publishing frame
  // are both re-checked instead of clearing the index every frame.
  return rect && rect.key === key && rect.stamp === _frameStamp ? rect : null;
}

/**
 * Resolve the topmost interactive world-overlay entry at CSS-pixel coords.
 * @param {number} x
 * @param {number} y
 * @param {{sourceId?:string,collisionGroup?:string,filter?:Function}} [options]
 * @returns {{sourceId:string,entryId:string,entry:WorldOverlayEntry,rect:OverlayRect}|null}
 */
export function hitTestWorldOverlay(x, y, options = {}) {
  if (_destroyed || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (let i = _hitRectCount - 1; i >= 0; i--) {
    const hit = _hitRects[i];
    if (options.sourceId && hit.sourceId !== options.sourceId) continue;
    if (options.collisionGroup && hit.entry.collisionGroup !== options.collisionGroup) continue;
    if (typeof options.filter === 'function' && !options.filter(hit.entry)) continue;
    if (x < hit.x || x > hit.x + hit.w || y < hit.y || y > hit.y + hit.h) continue;
    return { sourceId: hit.sourceId, entryId: hit.entryId, entry: hit.entry, rect: hit };
  }
  return null;
}

/** @returns {object} Copy of the stable diagnostic facade shape. */
export function getWorldOverlayDiagnostics() {
  const paintedBySource = {};
  for (let i = 0; i < _paintedSourceKeys.length; i++) {
    const sourceId = _paintedSourceKeys[i];
    const count = _paintedBySource[sourceId];
    if (count > 0) paintedBySource[sourceId] = count;
  }
  return {
    ..._diagnostics,
    entriesBySource: { ..._diagnostics.entriesBySource },
    paintedBySource,
  };
}

/**
 * True when a candidate survives the explicit horizon/viewport policies.
 * The horizon test prefers `entry.cullPosition` when the source supplied one
 * (see normalizeOverlayEntry) so a sub-ellipsoid render anchor is not
 * false-hidden near the limb; everything else still uses the render position.
 */
export function isOverlayPointVisible(entry, position, screen, viewport, occluder) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
    return false;
  }
  if (entry?.horizonCull !== false && occluder?.isPointVisible
    && !occluder.isPointVisible(entry?.cullPosition || position)) {
    return false;
  }
  const x = screen?.x;
  const y = screen?.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const padding = Math.max(0, Number(entry?.viewportPadding) || 0);
  return x >= -padding && x <= viewport.width + padding
    && y >= -padding && y <= viewport.height + padding;
}

/**
 * Return true when a rectangle intersects any cached UI exclusion box.
 * `count` lets pooled buffers expose a live prefix without truncating.
 */
export function overlayRectIntersectsAny(rect, exclusions, count = exclusions.length) {
  for (let i = 0; i < count; i++) {
    const other = exclusions[i];
    if (rect.x < other.x + other.w && rect.x + rect.w > other.x
      && rect.y < other.y + other.h && rect.y + rect.h > other.y) return true;
  }
  return false;
}

/**
 * Like `overlayRectIntersectsAny`, but only against exclusions that composite
 * BELOW the host — the ones a placement may never overlap at any cost.
 */
export function overlayRectIntersectsAnyHard(rect, exclusions, count = exclusions.length) {
  for (let i = 0; i < count; i++) {
    const other = exclusions[i];
    if (!other.hard) continue;
    if (rect.x < other.x + other.w && rect.x + rect.w > other.x
      && rect.y < other.y + other.h && rect.y + rect.h > other.y) return true;
  }
  return false;
}

function leastOverlappingPlacement(placements, exclusions, count) {
  let best = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (let i = 0; i < placements.length; i++) {
    const placement = placements[i];
    const rect = placement?.rect;
    if (!rect) continue;
    let overlapArea = 0;
    for (let j = 0; j < count; j++) {
      const other = exclusions[j];
      const overlapW = Math.min(rect.x + rect.w, other.x + other.w) - Math.max(rect.x, other.x);
      const overlapH = Math.min(rect.y + rect.h, other.y + other.h) - Math.max(rect.y, other.y);
      if (overlapW > 0 && overlapH > 0) overlapArea += overlapW * overlapH;
    }
    if (overlapArea < bestArea) {
      best = placement;
      bestArea = overlapArea;
    }
  }
  return best;
}

function ensureOverlayDom() {
  _root = document.getElementById(ROOT_ID);
  if (!_root) {
    _root = document.createElement('div');
    _root.id = ROOT_ID;
    _root.setAttribute('aria-hidden', 'true');
    const parent = _viewer.container?.parentElement || document.body;
    if (_viewer.container?.nextSibling) parent.insertBefore(_root, _viewer.container.nextSibling);
    else parent.appendChild(_root);
  }
  _canvas = _root.querySelector?.(`#${CANVAS_ID}`) || document.getElementById(CANVAS_ID);
  if (!_canvas) {
    _canvas = document.createElement('canvas');
    _canvas.id = CANVAS_ID;
    _root.appendChild(_canvas);
  }
  // The detection surface is parented to the Cesium container, NOT to
  // `#world-overlay-root`. Detection paints with `mix-blend-mode: screen`,
  // which only reaches the WebGL scene while no ancestor between the surface
  // and the Cesium canvas forms a stacking context (an isolated blending
  // group). `#cesiumContainer` is `position:absolute; z-index:auto` and does
  // not; `#world-overlay-root` is `z-index:6` and does — parenting here made
  // the browser silently discard the blend while the CSS string stayed
  // `'screen'`. Paint order is expressed purely by z-index: this surface is
  // z5, the shared card canvas inside the root is z6.
  const detectionParent = _viewer?.container || document.body;
  _detectionSurface = detectionParent.querySelector?.(`#${DETECTION_SURFACE_ID}`)
    || document.getElementById(DETECTION_SURFACE_ID);
  if (!_detectionSurface) {
    _detectionSurface = document.createElement('canvas');
    _detectionSurface.id = DETECTION_SURFACE_ID;
  }
  if (_detectionSurface.parentElement !== detectionParent) {
    detectionParent.appendChild(_detectionSurface);
  }
  _root.setAttribute('aria-hidden', 'true');
  _canvas.setAttribute('aria-hidden', 'true');
  _detectionSurface.setAttribute('aria-hidden', 'true');
  _accessibilityRoot = document.getElementById(ACCESSIBILITY_ROOT_ID);
  if (!_accessibilityRoot) {
    _accessibilityRoot = document.createElement('div');
    _accessibilityRoot.id = ACCESSIBILITY_ROOT_ID;
    _accessibilityRoot.className = 'world-overlay-accessibility';
    _accessibilityRoot.setAttribute('role', 'region');
    _accessibilityRoot.setAttribute('aria-label', 'Visible map targets');
    document.body.appendChild(_accessibilityRoot);
  }
  _accessibilityList = document.getElementById(ACCESSIBILITY_LIST_ID);
  if (!_accessibilityList) {
    _accessibilityList = document.createElement('div');
    _accessibilityList.id = ACCESSIBILITY_LIST_ID;
    _accessibilityRoot.appendChild(_accessibilityList);
  }
  _accessibilityStatus = document.getElementById(ACCESSIBILITY_STATUS_ID);
  if (!_accessibilityStatus) {
    _accessibilityStatus = document.createElement('div');
    _accessibilityStatus.id = ACCESSIBILITY_STATUS_ID;
    _accessibilityStatus.setAttribute('role', 'status');
    _accessibilityStatus.setAttribute('aria-live', 'polite');
    _accessibilityStatus.setAttribute('aria-atomic', 'true');
    _accessibilityRoot.appendChild(_accessibilityStatus);
  }
  _ctx = _canvas.getContext('2d', { alpha: true, desynchronized: true });
  _detectionCtx = _detectionSurface.getContext('2d', { alpha: true, desynchronized: true });
}

function sizeCanvasSurface(canvas, ctx, width, height, dpr) {
  if (!canvas) return false;
  const backingWidth = Math.round(width * dpr);
  const backingHeight = Math.round(height * dpr);
  const changed = canvas.width !== backingWidth || canvas.height !== backingHeight;
  if (changed) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx?.setTransform?.(dpr, 0, 0, dpr, 0, 0);
  return changed;
}

/**
 * Size the backing store to the live CSS box and DPR. A dormant host never
 * calls this, so a zero-source overlay keeps a 0x0 canvas instead of a
 * full-viewport buffer; `drawWorldOverlay` sizes lazily on the first frame
 * that actually has paint work.
 */
function ensureCanvasSize() {
  if (!_canvas || !_viewer?.canvas) return false;
  const width = Math.max(0, Math.round(Number(_viewer.canvas.clientWidth) || 0));
  const height = Math.max(0, Math.round(Number(_viewer.canvas.clientHeight) || 0));
  const dpr = Math.max(1, Number(globalThis.window?.devicePixelRatio) || 1);
  const changed = _canvas.width !== Math.round(width * dpr)
    || _canvas.height !== Math.round(height * dpr)
    || _detectionSurface?.width !== Math.round(width * dpr)
    || _detectionSurface?.height !== Math.round(height * dpr)
    || _canvasWidth !== width || _canvasHeight !== height || _canvasDpr !== dpr;
  _resizeDirty = false;
  if (!changed) return false;
  sizeCanvasSurface(_detectionSurface, _detectionCtx, width, height, dpr);
  sizeCanvasSurface(_canvas, _ctx, width, height, dpr);
  _canvasWidth = width;
  _canvasHeight = height;
  _viewport.width = width;
  _viewport.height = height;
  _canvasDpr = dpr;
  _occludersDirty = true;
  _solveDirty = true;
  _canvasNeedsClear = true;
  // Resizing a canvas clears its backing store by definition.
  _detectionSurfaceNeedsClear = false;
  _layoutRevision++;
  return true;
}

/**
 * Only chrome the user can actually see may exclude anything. A collapsed or
 * hidden panel must contribute nothing, including when the reason it is
 * invisible lives on an ANCESTOR — a child of a `display:none` container keeps
 * its own computed `display`, so the local style test alone cannot see it.
 * `checkVisibility` resolves the whole chain; the local test is the fallback.
 */
function elementIsVisible(element) {
  if (!element || element.hidden) return false;
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({
      contentVisibilityAuto: true,
      // The spec renamed these; pass both spellings so the check keeps its
      // opacity/visibility coverage on either engine vintage. Unknown keys are
      // ignored, and every option defaults to false, so a missing alias would
      // silently weaken the test rather than throw.
      opacityProperty: true,
      visibilityProperty: true,
      checkOpacity: true,
      checkVisibilityCSS: true,
    }) !== false;
  }
  const style = globalThis.window?.getComputedStyle?.(element);
  if (!style) return true;
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
}

/**
 * Highest z-index the host paints at: the card canvas sits in `#world-overlay-root`
 * (z6) and the detection surface at z5. Chrome ABOVE this composites over host
 * paint; chrome at or below it is painted OVER by the host.
 */
const HOST_TOP_Z_INDEX = 6;

/**
 * Effective stacking level of an element relative to the page root.
 *
 * Paint order against the host is decided by the OUTERMOST positioned ancestor
 * carrying a z-index — that is the stacking context which actually competes with
 * `#world-overlay-root` — so the walk keeps overwriting as it climbs and returns
 * the last one found. An element with no positioned z-indexed ancestor stacks at
 * the root's own level, which is below the host.
 */
function elementStackLevel(element) {
  let level = 0;
  let node = element;
  while (node && node !== document.body) {
    const style = globalThis.window?.getComputedStyle?.(node);
    if (style && style.position !== 'static' && style.zIndex !== 'auto') {
      const numeric = Number(style.zIndex);
      if (Number.isFinite(numeric)) level = numeric;
    }
    node = node.parentElement;
  }
  return level;
}

/**
 * Does this chrome composite ABOVE the host?
 *
 * This is the justification for treating exclusion as a soft preference: chrome
 * that paints over the host hides an unplaceable card harmlessly. Chrome that
 * paints UNDER the host does not — a card kept there renders ON TOP of it, which
 * violates the absolute rule that labels never cover the UI. `#intel-hud` is z2,
 * i.e. below both host surfaces, so its corners and bars need a HARD veto.
 */
function occluderStacksAboveHost(element) {
  return elementStackLevel(element) > HOST_TOP_Z_INDEX;
}

/** Append one inflated, canvas-relative exclusion rectangle from the pool. */
function pushUiOcclusionRect(rect, canvasRect, hard = false) {
  const index = _uiOcclusionRects.length;
  const out = _uiOcclusionRectPool[index] || (_uiOcclusionRectPool[index] = {});
  // `hard` rects veto a placement outright; soft rects are only preferred against.
  out.hard = hard;
  out.x = rect.left - canvasRect.left - OCCLUDER_PADDING_PX;
  out.y = rect.top - canvasRect.top - OCCLUDER_PADDING_PX;
  out.w = rect.width + OCCLUDER_PADDING_PX * 2;
  out.h = rect.height + OCCLUDER_PADDING_PX * 2;
  _uiOcclusionRects.push(out);
}

function refreshUiOccluders(timestamp, force = false) {
  if (!_canvas || !_occludersDirty) return false;
  const elapsed = timestamp - _occludersUpdatedAt;
  if (!force && elapsed < OCCLUDER_REFRESH_MS) {
    if (_occluderRefreshTimer == null && typeof setTimeout === 'function') {
      _occluderRefreshTimer = setTimeout(() => {
        _occluderRefreshTimer = null;
        _viewer?.scene?.requestRender?.();
      }, Math.max(0, OCCLUDER_REFRESH_MS - elapsed));
    }
    return false;
  }
  _occludersUpdatedAt = timestamp;
  _occludersDirty = false;
  _uiOcclusionRects.length = 0;
  const canvasRect = _canvas.getBoundingClientRect?.() || { left: 0, top: 0 };
  const seen = new Set();
  for (const selector of WORLD_OVERLAY_OCCLUDER_SELECTORS) {
    const matches = document.querySelectorAll?.(selector)
      || [document.querySelector?.(selector)].filter(Boolean);
    for (const element of matches) {
      if (seen.has(element) || !elementIsVisible(element)) continue;
      seen.add(element);
      if (_resizeObserver && !_observedOccluderElements.has(element)) {
        _resizeObserver.observe(element);
        _mutationObserver?.observe?.(element, OCCLUDER_ATTRIBUTE_OBSERVATION);
        _observedOccluderElements.add(element);
      }
      const rect = element.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      pushUiOcclusionRect(rect, canvasRect, !occluderStacksAboveHost(element));
    }
  }
  // Each element keeps its OWN rectangle. The inventory used to be reduced to
  // transitive bounding UNIONS of overlapping rects, which is only a
  // requirement for even-odd canvas holes (overlapping holes toggle pixels back
  // on) — and the host no longer punches holes in anything. As placement
  // geometry the unions were actively wrong: a chain of pairwise-overlapping
  // panels collapsed into one enormous rectangle that swept unrelated world
  // space, jumped in size whenever a panel expanded, and in cockpit coalesced
  // to 94-98 % of the viewport. Per-rect exclusions hug the real chrome.
  _solveDirty = true;
  _layoutRevision++;
  return true;
}

function markLayoutDirty() {
  _resizeDirty = true;
  _occludersDirty = true;
  if (!overlayHasPaintWork()) return;
  invalidateHost({ solve: true, layout: true });
}

function markOccludersDirty() {
  _occludersDirty = true;
  if (!overlayHasPaintWork()) return;
  invalidateHost({ solve: true });
}

/**
 * Occluder-element attribute observation is deliberately NOT `subtree`: the
 * inventory only reads each occluder's own border box and visibility, and a
 * descendant cannot change either without the element's ResizeObserver seeing
 * it. Subtree scope added nothing — but it delivered every ticking descendant
 * (the REC-dot blink, chip internals) as an invalidation, which held a parked
 * camera at ~12 requestRender/s for every live overlay source.
 */
const OCCLUDER_ATTRIBUTE_OBSERVATION = Object.freeze({
  attributes: true,
  attributeFilter: Object.freeze(['class', 'style', 'hidden']),
});

/**
 * True when a node either IS inventory chrome or CONTAINS some. Judged against
 * live nodes at record-delivery time, so "append, then set id" within one task
 * is still seen; removals judge the detached subtree, which selector APIs
 * still traverse.
 */
function nodeIsOrContainsOccluderChrome(node) {
  if (!node || typeof node.matches !== 'function') return false; // text/comment nodes
  for (const selector of WORLD_OVERLAY_OCCLUDER_SELECTORS) {
    if (node.matches(selector)) return true;
    if (typeof node.querySelector === 'function' && node.querySelector(selector)) return true;
  }
  return false;
}

function childListTouchesChrome(nodes) {
  if (!nodes) return false;
  for (let i = 0; i < nodes.length; i++) {
    if (nodeIsOrContainsOccluderChrome(nodes[i])) return true;
  }
  return false;
}

/**
 * Shared MutationObserver callback for both observation scopes. Body-level
 * childList records are DISCOVERY only — they matter solely when the churn
 * adds or removes inventory chrome, so a ticking clock's text swaps and other
 * non-chrome element churn are dropped here. Attribute records can only
 * originate from an occluder element itself (element-scoped observation), so
 * they always invalidate. A batch the runtime failed to deliver falls back to
 * the conservative pre-filter behavior.
 */
function handleChromeMutations(records) {
  if (!overlayHasPaintWork()) {
    // Dormant host: keep the pre-filter flag semantics without paying selector
    // checks — the first frame with real paint work force-refreshes anyway.
    _occludersDirty = true;
    return;
  }
  if (!records || typeof records.length !== 'number') {
    markOccludersDirty();
    return;
  }
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.type !== 'childList'
      || childListTouchesChrome(record.addedNodes)
      || childListTouchesChrome(record.removedNodes)) {
      markOccludersDirty();
      return;
    }
  }
}

function installUiOccluderObservers() {
  _windowResizeHandler = markLayoutDirty;
  globalThis.window?.addEventListener?.('resize', _windowResizeHandler);
  if (typeof MutationObserver === 'function' && document.body) {
    _mutationObserver = new MutationObserver(handleChromeMutations);
    // Body observation is childList discovery only, filtered in the callback;
    // attribute churn is observed per occluder element, without subtree.
    _mutationObserver.observe(document.body, { subtree: true, childList: true });
  }
  if (typeof ResizeObserver === 'function') {
    _resizeObserver = new ResizeObserver(markLayoutDirty);
    if (_root) {
      _resizeObserver.observe(_root);
      _observedOccluderElements.add(_root);
    }
    for (const selector of WORLD_OVERLAY_OCCLUDER_SELECTORS) {
      const matches = document.querySelectorAll?.(selector) || [];
      for (const element of matches) {
        if (_observedOccluderElements.has(element)) continue;
        _resizeObserver.observe(element);
        _mutationObserver?.observe?.(element, OCCLUDER_ATTRIBUTE_OBSERVATION);
        _observedOccluderElements.add(element);
      }
    }
  }
}

function clearCanvasSurface(canvas, ctx) {
  if (!ctx || !canvas || !(canvas.width > 0) || !(canvas.height > 0)) return;
  ctx.setTransform?.(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform?.(_canvasDpr, 0, 0, _canvasDpr, 0, 0);
}

/** Clear either or both host-owned surfaces through the single frame path. */
function clearCanvas(clearMain = true, clearDetection = true) {
  if (clearMain) {
    clearCanvasSurface(_canvas, _ctx);
    _canvasNeedsClear = false;
  }
  if (clearDetection) {
    clearCanvasSurface(_detectionSurface, _detectionCtx);
    _detectionSurfaceNeedsClear = false;
  }
}

function activeEntryCount() {
  let count = 0;
  for (let i = 0; i < _sourceList.length; i++) {
    const source = _sourceList[i];
    if (sourceActive(source)) count += source.entries.size;
  }
  return count;
}

function activeCustomPaintLaneCount(target = null) {
  let count = 0;
  for (let i = 0; i < _customPaintLaneList.length; i++) {
    const record = _customPaintLaneList[i];
    if (record.active && (target === null || record.target === target)) count++;
  }
  return count;
}

function activeFadeCount(timestamp) {
  let count = 0;
  for (let d = 0; d < _domainList.length; d++) {
    const arbiter = _domainList[d].arbiter;
    const stateCount = arbiter.activeStateCount();
    for (let i = 0; i < stateCount; i++) {
      const state = arbiter.activeStateAt(i);
      if (state.selected) {
        if (timestamp - state.enterStartedAt < LABEL_ARBITER_TIMING.fadeInMs) count++;
      } else if (timestamp - state.exitStartedAt < LABEL_ARBITER_TIMING.fadeOutMs) {
        count++;
      }
    }
  }
  return count;
}

function overlayHasPaintWork(timestamp = nowMs()) {
  if (activeCustomPaintLaneCount() > 0) return true;
  if (activeEntryCount() > 0) return true;
  if (!_solveDirty) return activeFadeCount(timestamp) > 0;
  for (let d = 0; d < _domainList.length; d++) {
    if (_domainList[d].arbiter.states.size > 0) return true;
  }
  return false;
}

function prepareProjectionMatrix() {
  const camera = _viewer.camera;
  const matrix = Cesium.Matrix4.multiply(
    camera.frustum.projectionMatrix,
    camera.viewMatrix,
    _scratchViewProjection,
  );
  _viewProjectionScalars.m0 = matrix[0];
  _viewProjectionScalars.m1 = matrix[1];
  _viewProjectionScalars.m3 = matrix[3];
  _viewProjectionScalars.m4 = matrix[4];
  _viewProjectionScalars.m5 = matrix[5];
  _viewProjectionScalars.m7 = matrix[7];
  _viewProjectionScalars.m8 = matrix[8];
  _viewProjectionScalars.m9 = matrix[9];
  _viewProjectionScalars.m11 = matrix[11];
  _viewProjectionScalars.m12 = matrix[12];
  _viewProjectionScalars.m13 = matrix[13];
  _viewProjectionScalars.m15 = matrix[15];
  return _viewProjectionScalars;
}

function prepareCustomPaintFrame(timestamp, keyhole) {
  const viewProjection = prepareProjectionMatrix();
  const camera = _viewer.camera.positionWC;
  if (camera.x !== _occluderCameraX || camera.y !== _occluderCameraY || camera.z !== _occluderCameraZ) {
    _occluder.cameraPosition = camera;
    _occluderCameraX = camera.x;
    _occluderCameraY = camera.y;
    _occluderCameraZ = camera.z;
  }
  _customPaintFrame.canvas = _canvas;
  _customPaintFrame.surface = _canvas;
  _customPaintFrame.ctx = _ctx;
  _customPaintFrame.width = _canvasWidth;
  _customPaintFrame.height = _canvasHeight;
  _customPaintFrame.dpr = _canvasDpr;
  _customPaintFrame.timestamp = timestamp;
  _customPaintFrame.cameraPosition = camera;
  _customPaintFrame.occluder = _occluder;
  _customPaintFrame.keyhole = keyhole;
  _customPaintFrame.uiRectCount = _uiOcclusionRects.length;
  _customPaintFrame.layoutRevision = _layoutRevision;
  return viewProjection;
}

function getProjectionRecord(entry) {
  let record = _records.get(entry._overlayKey);
  if (!record) {
    record = {
      key: entry._overlayKey,
      entry,
      position: new Cesium.Cartesian3(),
      screen: { x: 0, y: 0 },
      layout: entry._overlayLayout,
      placements: [],
      candidate: null,
      distanceAlpha: 1,
      paintScale: 1,
      altitudeAlpha: 1,
      sourceAlpha: 1,
      protectedPlacement: null,
      distanceOptions: {},
      altitudeOptions: {},
      placementInput: {},
      scaledPaintPlacement: { rect: {} },
    };
    record.candidate = {
      key: record.key,
      layerId: entry.source,
      sourceId: entry.id,
      priority: entry.priority,
      centerDistance: 0,
      keyholeAlpha: 1,
      placements: record.placements,
      screenX: 0,
      screenY: 0,
      frameStamp: 0,
      // Declared up front so the arbiter's per-solve scalar caches land in
      // stable double fields instead of transitioning the shape every frame.
      _anchorX: 0,
      _anchorY: 0,
      _record: record,
    };
    _records.set(record.key, record);
  }
  record.entry = entry;
  record.layout = entry._overlayLayout;
  record.candidate.layerId = entry.source;
  record.candidate.sourceId = entry.id;
  record.candidate.priority = entry.priority;
  record.candidate.stateless = entry.stateless;
  record.distanceOptions.minDistance = entry.minDistance;
  record.distanceOptions.maxDistance = entry.maxDistance;
  record.distanceOptions.fadeStartRatio = entry.distanceFadeStartRatio;
  record.altitudeOptions.minAltitude = entry.minAltitude;
  record.altitudeOptions.fadeStart = entry.altitudeFadeStart;
  record.altitudeOptions.fadeEnd = entry.altitudeFadeEnd;
  return record;
}

function resetFrameDomains() {
  for (let d = 0; d < _domainList.length; d++) {
    const domain = _domainList[d];
    // `candidateMap` keeps its table across frames; membership is expressed by
    // `candidate.frameStamp`, and demand tallies are zeroed rather than cleared
    // because `Map#clear` reallocates the backing hash table every call. Stale
    // keys still have to go somewhere, so the index is pruned here — before the
    // frame republishes it — against the previous frame's live cohort.
    pruneKeyedIndex(domain.candidateMap, domain.candidateCount);
    domain.candidateCount = 0;
    domain.protectedCount = 0;
    domain.protectedRectCount = 0;
    domain.sepCount = 0;
    domain.demandBySource.forEach(zeroDemandEntry);
    domain.capacity = 0;
    domain.moving = false;
    domain.solveIntervalMs = Number.POSITIVE_INFINITY;
  }
}

function snapshotAndProject(entry, source, viewProjection, keyhole) {
  const record = getProjectionRecord(entry);
  let position;
  try {
    position = typeof entry.position === 'function' ? entry.position() : entry.position;
  } catch {
    return null;
  }
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
    return null;
  }
  record.position.x = position.x;
  record.position.y = position.y;
  record.position.z = position.z;

  const { x: px, y: py, z: pz } = record.position;
  const clipW = viewProjection.m3 * px + viewProjection.m7 * py
    + viewProjection.m11 * pz + viewProjection.m15;
  if (!(clipW > 0)) return null;
  const invW = 1 / clipW;
  record.screen.x = ((viewProjection.m0 * px + viewProjection.m4 * py
    + viewProjection.m8 * pz + viewProjection.m12) * invW * 0.5 + 0.5) * _canvasWidth;
  record.screen.y = (0.5 - (viewProjection.m1 * px + viewProjection.m5 * py
    + viewProjection.m9 * pz + viewProjection.m13) * invW * 0.5) * _canvasHeight;
  if (entry.safeTopRatio > 0 && !(entry.pinned && entry.pinnedBypassesSafeTop)) {
    const safeTop = Math.min(entry.safeTopMaxPx, _canvasHeight * entry.safeTopRatio);
    if (record.screen.y < safeTop) return null;
  }
  if (!isOverlayPointVisible(
    entry,
    record.position,
    record.screen,
    _viewport,
    _occluder,
  )) return null;

  // Doubles crossing a non-inlined call boundary are boxed, so the two hot
  // scalar steps stay local: the range is computed inline, and the common
  // "no far limit" fade policy resolves without calling out at all. Both are
  // exact restatements of `Cartesian3.distance` / `distanceFade`.
  const cameraPosition = _viewer.camera.positionWC;
  const rangeX = cameraPosition.x - record.position.x;
  const rangeY = cameraPosition.y - record.position.y;
  const rangeZ = cameraPosition.z - record.position.z;
  const distance = Math.sqrt(rangeX * rangeX + rangeY * rangeY + rangeZ * rangeZ);
  record.distanceAlpha = entry.maxDistance === Number.POSITIVE_INFINITY
    ? (distance >= entry.minDistance ? 1 : 0)
    : distanceFade(distance, record.distanceOptions);
  const cameraAltitude = _viewer.camera.positionCartographic?.height;
  record.paintScale = entry.distanceScale ? distanceScale(distance, entry.distanceScale) : 1;
  // Keep the source-configurable piecewise curve local to the projection hot
  // path. Passing its five doubles through a non-inlined helper boxed them for
  // every thumbnail candidate and broke the shared 154 B/candidate gate.
  const altitudeCurve = entry.altitudeScale;
  if (altitudeCurve && Number.isFinite(cameraAltitude)) {
    let altitudeFactor = 1;
    if (cameraAltitude > altitudeCurve.fullEnd) {
      if (cameraAltitude <= altitudeCurve.midEnd) {
        const span = Math.max(1, altitudeCurve.midEnd - altitudeCurve.fullEnd);
        let progress = Math.max(0, Math.min(1, (cameraAltitude - altitudeCurve.fullEnd) / span));
        if (altitudeCurve.smoothToMid) progress = progress * progress * (3 - 2 * progress);
        altitudeFactor = 1 + (altitudeCurve.midValue - 1) * progress;
      } else if (cameraAltitude >= altitudeCurve.end) {
        altitudeFactor = altitudeCurve.endValue;
      } else {
        const progress = (cameraAltitude - altitudeCurve.midEnd)
          / Math.max(1, altitudeCurve.end - altitudeCurve.midEnd);
        altitudeFactor = altitudeCurve.midValue
          + (altitudeCurve.endValue - altitudeCurve.midValue) * progress;
      }
    }
    record.paintScale *= altitudeFactor;
  }
  record.altitudeAlpha = entry.altitudeFadeEnd === Number.POSITIVE_INFINITY
    ? (Number.isFinite(cameraAltitude) && cameraAltitude < entry.minAltitude ? 0 : 1)
    : altitudeFade(cameraAltitude, record.altitudeOptions);
  record.sourceAlpha = source.options.alpha * entry.sourceAlpha;
  if (record.distanceAlpha <= 0 || record.paintScale <= 0
    || record.altitudeAlpha <= 0 || record.sourceAlpha <= 0) return null;

  measureOverlayEntry(_ctx, entry, record.layout);
  record.placementInput.anchorX = record.screen.x;
  record.placementInput.anchorY = record.screen.y;
  record.placementInput.width = record.layout.w * record.paintScale;
  record.placementInput.height = record.layout.h * record.paintScale;
  record.placementInput.viewportWidth = _canvasWidth;
  record.placementInput.viewportHeight = _canvasHeight;
  if (entry.anchorRadiusPx > 0) {
    const anchorScale = entry.anchorRadiusScale
      ? distanceScale(distance, entry.anchorRadiusScale)
      : 1;
    const anchorRadius = entry.anchorRadiusPx * anchorScale;
    record.placementInput.gap = anchorRadius + Math.max(
      entry.minAnchorGapPx,
      anchorRadius + entry.anchorGapPaddingPx,
    );
    record.placementInput.leaderOffset = anchorRadius;
  } else {
    record.placementInput.gap = entry.gapPx;
    record.placementInput.leaderOffset = entry.leaderOffsetPx;
  }
  record.placementInput.preferred = entry.placement;
  record.placementInput.verticalOnly = entry.verticalOnly;
  record.placementInput.viewportMargin = entry.viewportMargin;
  placementVariants(record.placementInput, record.placements);
  // UI exclusion is a PREFERENCE for chrome that composites ABOVE the host, and
  // a HARD VETO for chrome that composites below it.
  //
  // The soft half exists because deleting an entry whose every variant collides
  // is what made cards hop between corners and then fade out near a panel, and
  // what left cockpit with nothing. Keeping the placement is safe only when the
  // chrome paints over the card anyway.
  //
  // That justification fails for chrome UNDER the host — `#intel-hud` is z2,
  // below both host surfaces — where a kept placement would render ON TOP of the
  // HUD text. Labels never cover the UI, so those rects keep the absolute veto.
  let softClear = 0;
  for (let i = 0; i < record.placements.length; i++) {
    const placement = record.placements[i];
    if (overlayRectIntersectsAny(placement.rect, _uiOcclusionRects)) continue;
    record.placements[softClear++] = placement;
  }
  if (softClear === 0) {
    // Nothing is clear of everything: fall back to placements that at least
    // clear the below-host chrome, and veto the entry if even that is impossible.
    let hardClear = 0;
    for (let i = 0; i < record.placements.length; i++) {
      const placement = record.placements[i];
      if (overlayRectIntersectsAnyHard(placement.rect, _uiOcclusionRects)) continue;
      record.placements[hardClear++] = placement;
    }
    record.placements.length = hardClear;
  } else {
    record.placements.length = softClear;
  }
  if (record.placements.length === 0) return null;
  let centerDistance = Number.POSITIVE_INFINITY;
  let closestCenterX = 0;
  let closestCenterY = 0;
  for (let i = 0; i < record.placements.length; i++) {
    const placement = record.placements[i];
    // `Math.hypot` is variadic and allocates per call; screen-space offsets
    // never approach the overflow range it exists to guard.
    const dx = placement.centerX - keyhole.centerX;
    const dy = placement.centerY - keyhole.centerY;
    const distanceFromCenter = Math.sqrt(dx * dx + dy * dy);
    if (distanceFromCenter < centerDistance) {
      centerDistance = distanceFromCenter;
      closestCenterX = placement.centerX;
      closestCenterY = placement.centerY;
    }
  }
  // Shared keyhole alpha is radial and monotonic, so the closest surviving
  // placement is exactly the maximum-alpha placement. Evaluate the shared
  // helper once, then evaluate the final chosen rectangle again at paint.
  record.candidate.keyholeAlpha = entry.edgeFade === 'keyhole'
    ? (centerDistance <= keyhole.radius
      ? 1
      : keyholeLabelAlphaFromGeometry(closestCenterX, closestCenterY, keyhole))
    : 1;
  record.candidate.centerDistance = centerDistance;
  // Anchor separation is authored in unscaled CSS px; the shipped pass scaled it
  // with the card, so a zoomed-out (smaller) card needs proportionally less room.
  record.candidate.minAnchorSeparationPx = entry.minAnchorSeparationPx > 0
    ? entry.minAnchorSeparationPx * record.paintScale
    : 0;
  record.candidate.screenX = record.screen.x;
  record.candidate.screenY = record.screen.y;
  return record;
}

/**
 * Project every active cohort into the pooled per-domain candidate buffers.
 * Nothing here allocates per painted entry in steady state: records, candidate
 * objects, placement objects, and the domain buffers are all reused, and live
 * membership is carried by `candidate.frameStamp` instead of a rebuilt map.
 */
function collectFrameCandidates(keyhole, viewProjection) {
  resetFrameDomains();
  let candidateCount = 0;
  let projectedCount = 0;
  for (let s = 0; s < _sourceList.length; s++) {
    const source = _sourceList[s];
    if (!sourceActive(source)) continue;
    for (let c = 0; c < source.cohortCount; c++) {
      const domainId = source.cohortDomainIds[c];
      const cohort = source.cohortLists[c];
      const domain = getOrCreateDomain(domainId);
      domain.capacity = domainId === 'ambient-card'
        ? Math.min(
          AMBIENT_CARD_COLLISION_CAPACITY,
          domain.capacity + source.options.collisionCapacity,
        )
        : Math.max(domain.capacity, source.options.collisionCapacity);
      domain.moving ||= source.options.moving;
      domain.solveIntervalMs = Math.min(domain.solveIntervalMs, source.options.solveIntervalMs);
      domain.demandBySource.set(source.id, source.demandByDomain.get(domainId) || 0);
      candidateCount += cohort.length;
      for (let i = 0; i < cohort.length; i++) {
        const entry = cohort[i];
        // Source-owned stable slots are dereferenced on every frame, before
        // the numeric projection path. Ambient CCTV has no pre-frame chrome;
        // the shipped pinned-card exception remains immediate feedback.
        if (entry.requireImage && !entry.pinned) {
          const imageSlot = entry._overlayImageSlot;
          if (imageSlot ? (!(imageSlot.stamp > 0) || !imageSlot.frame) : !entry.image) continue;
        }
        const record = snapshotAndProject(entry, source, viewProjection, keyhole);
        if (!record) continue;
        // Anchor separation runs HERE, not inside the arbiter. The shipped pass
        // filtered the candidate list and then drew it; rejecting inside the
        // arbiter's fill loop instead leaves the source's quota permanently
        // unfillable, so it rebuilds its spatial queue every solve and blows the
        // per-frame allocation budget. Filtering first keeps the quota honest.
        // Cohorts arrive in rank order (nearest/highest priority first), which is
        // the order the shipped greedy accept used.
        const separation = record.candidate.minAnchorSeparationPx;
        if (separation > 0 && !isProtected(record.entry)) {
          let clear = true;
          for (let k = 0; k < domain.sepCount; k++) {
            if (domain.sepSource[k] !== source.id) continue;
            const dx = record.candidate.screenX - domain.sepX[k];
            const dy = record.candidate.screenY - domain.sepY[k];
            const required = separation > domain.sepR[k] ? separation : domain.sepR[k];
            if (dx * dx + dy * dy < required * required) { clear = false; break; }
          }
          if (!clear) continue;
          const slot = domain.sepCount++;
          domain.sepX[slot] = record.candidate.screenX;
          domain.sepY[slot] = record.candidate.screenY;
          domain.sepR[slot] = separation;
          domain.sepSource[slot] = source.id;
        }
        projectedCount++;
        if (isProtected(record.entry)) {
          domain.protectedCandidates[domain.protectedCount++] = record.candidate;
        } else {
          record.candidate.frameStamp = _frameStamp;
          domain.candidates[domain.candidateCount++] = record.candidate;
          domain.candidateMap.set(record.key, record.candidate);
        }
      }
    }
  }

  for (let d = 0; d < _domainList.length; d++) {
    const domain = _domainList[d];
    sortPooledRange(domain.protectedCandidates, domain.protectedCount, compareProtectedCandidates);
    for (let p = 0; p < domain.protectedCount; p++) {
      const candidate = domain.protectedCandidates[p];
      let placement = null;
      for (let i = 0; i < candidate.placements.length; i++) {
        const candidatePlacement = candidate.placements[i];
        if (overlayRectIntersectsAny(
          candidatePlacement.rect,
          domain.protectedRects,
          domain.protectedRectCount,
        )) continue;
        placement = candidatePlacement;
        break;
      }
      placement ||= leastOverlappingPlacement(
        candidate.placements,
        domain.protectedRects,
        domain.protectedRectCount,
      );
      candidate._record.protectedPlacement = placement;
      if (placement) domain.protectedRects[domain.protectedRectCount++] = placement.rect;
    }
    for (let a = 0; a < domain.candidateCount; a++) {
      const candidate = domain.candidates[a];
      let count = 0;
      for (let i = 0; i < candidate.placements.length; i++) {
        const placement = candidate.placements[i];
        if (overlayRectIntersectsAny(
          placement.rect,
          domain.protectedRects,
          domain.protectedRectCount,
        )) continue;
        candidate.placements[count++] = placement;
      }
      candidate.placements.length = count;
      if (count === 0) candidate.frameStamp = 0;
    }
    let count = 0;
    for (let i = 0; i < domain.candidateCount; i++) {
      if (domain.candidates[i].frameStamp !== _frameStamp) continue;
      domain.candidates[count++] = domain.candidates[i];
    }
    domain.candidateCount = count;
    domain.candidates.length = count;
    domain.protectedCandidates.length = domain.protectedCount;
    domain.protectedRects.length = domain.protectedRectCount;
    if (!Number.isFinite(domain.solveIntervalMs)) domain.solveIntervalMs = DEFAULT_MOVING_SOLVE_MS;
  }
  let candidateIndexSize = 0;
  for (let d = 0; d < _domainList.length; d++) candidateIndexSize += _domainList[d].candidateMap.size;
  _diagnostics.candidateIndexSize = candidateIndexSize;
  _diagnostics.candidateCount = candidateCount;
  _diagnostics.projectedCount = projectedCount;
}

function addPaintItem(record, placement, temporalAlpha, selected) {
  if (!record || !placement) return;
  const item = _paintItemPool[_paintCount] || (_paintItemPool[_paintCount] = {});
  item.record = record;
  item.placement = placement;
  item.temporalAlpha = temporalAlpha;
  item.selected = selected;
  item.lane = paintLaneForOverlayEntry(record.entry);
  item.zIndex = record.entry.zIndex;
  item.key = record.key;
  _paintQueue[_paintCount++] = item;
}

function sourceCanPaint(sourceId) {
  const source = _sources.get(sourceId);
  return !!source && sourceActive(source);
}

function solveDomains(timestamp) {
  _paintCount = 0;
  let solveMs = 0;
  let selectedCount = 0;
  let fadingCount = 0;
  let solveRevision = 0;
  for (let d = 0; d < _domainList.length; d++) {
    const domain = _domainList[d];
    const movingSolveDue = domain.moving
      && timestamp - domain.lastSolveAt >= domain.solveIntervalMs;
    if (_solveDirty || movingSolveDue) {
      const started = nowMs();
      domain.arbiter.solve(domain.candidates, {
        capacity: Math.min(domain.capacity, domain.candidates.length),
        demandByLayer: domain.demandBySource,
        now: timestamp,
        // The host publishes its own pooled counters below, so duplicating a
        // per-layer diagnostic object in the arbiter adds no observable data.
        collectDiagnostics: false,
      });
      solveMs += nowMs() - started;
      domain.lastSolveAt = timestamp;
    }
    for (let p = 0; p < domain.protectedCount; p++) {
      const record = domain.protectedCandidates[p]._record;
      addPaintItem(record, record.protectedPlacement, record.entry.temporalAlpha, true);
      selectedCount++;
    }
    const rendered = domain.arbiter.renderEntries(
      domain.candidateMap,
      timestamp,
      domain.renderEntries,
    );
    for (let r = 0; r < rendered.length; r++) {
      const renderedEntry = rendered[r];
      const candidate = renderedEntry.candidate;
      const record = candidate?._record;
      if (!record || !sourceCanPaint(record.entry.source)) continue;
      if (renderedEntry.selected && candidate.frameStamp !== _frameStamp) continue;
      // No second UI veto here. The placement already went through the
      // exclusion preference at projection; re-testing it meant that a panel
      // expanding over a settled card evicted the card outright — it popped
      // out and then had to fade back in — instead of simply sliding beneath
      // the chrome that composites above this host anyway.
      addPaintItem(
        record,
        renderedEntry.placement,
        renderedEntry.temporalAlpha * record.entry.temporalAlpha,
        renderedEntry.selected,
      );
      if (renderedEntry.selected) selectedCount++;
      else fadingCount++;
    }
    solveRevision += domain.arbiter.solveRevision;
  }
  _paintQueue.length = _paintCount;
  _solveDirty = false;
  _diagnostics.solveMs = solveMs;
  _diagnostics.selectedCount = selectedCount;
  _diagnostics.fadingCount = fadingCount;
  _diagnostics.solveRevision = solveRevision;
}

function publishPaintRect(item) {
  const { record, placement } = item;
  const rect = _paintRectPool[_paintRectCount] || (_paintRectPool[_paintRectCount] = {});
  _paintRectCount++;
  rect.x = placement.rect.x;
  rect.y = placement.rect.y;
  rect.w = placement.rect.w;
  rect.h = placement.rect.h;
  rect.sourceId = record.entry.source;
  rect.entryId = record.entry.id;
  rect.entry = record.entry;
  rect.key = record.key;
  rect.stamp = _frameStamp;
  _paintRectByKey.set(record.key, rect);
  if (record.entry.interactive) _hitRects[_hitRectCount++] = rect;
}

/** Keep a stable, bounded accessible mirror of currently painted actions. */
function syncAccessibleActions() {
  if (!_accessibilityList) return;
  _accessibleActivatorByKey.clear();
  const items = [];
  for (let i = _hitRectCount - 1; i >= 0; i--) {
    const rect = _hitRects[i];
    const entry = rect.entry;
    if (!entry?.accessibilityLabel || typeof entry.activate !== 'function') continue;
    if (_accessibleActivatorByKey.has(rect.key)) continue;
    _accessibleActivatorByKey.set(rect.key, entry.activate);
    items.push({
      key: rect.key,
      label: entry.accessibilityLabel,
      selected: entry.selected === true,
    });
  }
  const signature = items
    .map((item) => `${item.key}\u0000${item.label}\u0000${item.selected ? '1' : '0'}`)
    .join('\u0001');
  if (signature === _accessibilitySignature) return;
  _accessibilitySignature = signature;
  if (typeof _accessibilityList.replaceChildren === 'function') {
    _accessibilityList.replaceChildren();
  } else {
    while (_accessibilityList.firstChild) _accessibilityList.removeChild(_accessibilityList.firstChild);
  }
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.setAttribute('aria-label', item.label);
    button.setAttribute('aria-pressed', String(item.selected));
    button.dataset.overlayActionKey = item.key;
    button.addEventListener?.('click', () => {
      const activate = _accessibleActivatorByKey.get(item.key);
      if (!activate) return;
      const accepted = activate();
      if (accepted !== false && _accessibilityStatus) {
        _accessibilityStatus.textContent = `Focusing ${item.label}`;
      }
    });
    _accessibilityList.appendChild(button);
  }
}

let _detectionSurfacePrepared = false;

function paintCustomLane(lane) {
  for (let i = 0; i < _customPaintLaneList.length; i++) {
    const record = _customPaintLaneList[i];
    if (!record.active || record.lane !== lane) continue;
    const detectionTarget = record.target === PAINT_TARGET_DETECTION;
    const surface = detectionTarget ? _detectionSurface : _canvas;
    const ctx = detectionTarget ? _detectionCtx : _ctx;
    if (!surface || !ctx) continue;
    _customPaintFrame.surface = surface;
    _customPaintFrame.ctx = ctx;
    if (record.shouldPaint && record.shouldPaint(_customPaintFrame) === false) continue;
    if (detectionTarget && !_detectionSurfacePrepared) {
      clearCanvas(false, true);
      _detectionSurfacePrepared = true;
    }
    ctx.save();
    try {
      // No UI clip. Detection paints edge to edge exactly as it shipped: it
      // consumes `frame.uiRects` itself to keep its CALLOUT CARDS off solid
      // chrome, while brackets, labels, the focus ring, the banner and the
      // scanline wash cover the whole field. Clipping this surface punched
      // hard-edged rectangular voids through the detection field, and in
      // cockpit — where the exclusions coalesced to nearly the full viewport —
      // blanked Panoptic entirely while it was still solving and painting.
      record.painter(_customPaintFrame);
      if (detectionTarget) _detectionSurfaceNeedsClear = true;
    } finally {
      ctx.restore();
    }
  }
}

function paintEntryItem(item, keyhole) {
  const { record, placement } = item;
  const entry = record.entry;
  let keyholeAlpha = 1;
  if (entry.edgeFade === 'keyhole') {
    const keyholeX = placement.centerX - keyhole.centerX;
    const keyholeY = placement.centerY - keyhole.centerY;
    keyholeAlpha = keyholeX * keyholeX + keyholeY * keyholeY <= keyhole.radius * keyhole.radius
      ? 1
      : keyholeLabelAlphaFromGeometry(placement.centerX, placement.centerY, keyhole);
  }
  // All five channels are normalized at their source. Keep the multiply on
  // the hot paint path so its intermediate doubles remain unboxed; the pure
  // `combinedOverlayAlpha` export still specifies/tests the same binding.
  const finalAlpha = record.sourceAlpha * item.temporalAlpha
    * record.distanceAlpha * record.altitudeAlpha * keyholeAlpha;
  if (finalAlpha <= 0.001) return;
  if (record.paintScale === 1) {
    paintOverlayEntry(_ctx, entry, placement, finalAlpha);
  } else {
    const scaled = localizeScaledPlacement(
      placement,
      record.paintScale,
      record.scaledPaintPlacement,
    );
    _ctx.save();
    _ctx.translate(placement.rect.x, placement.rect.y);
    _ctx.scale(record.paintScale, record.paintScale);
    paintOverlayEntry(_ctx, entry, scaled, finalAlpha);
    _ctx.restore();
  }
  publishPaintRect(item);
  if (_paintedBySource[entry.source] === undefined) {
    _paintedBySource[entry.source] = 0;
    _paintedSourceKeys.push(entry.source);
  }
  _paintedBySource[entry.source]++;
}

function paintFrame(keyhole) {
  const started = nowMs();
  clearCanvas(true, false);
  _detectionSurfacePrepared = false;
  if (activeCustomPaintLaneCount(PAINT_TARGET_DETECTION) === 0
    && _detectionSurfaceNeedsClear) clearCanvas(false, true);
  _paintRectCount = 0;
  _hitRectCount = 0;
  sortPooledRange(_paintQueue, _paintCount, comparePaintItems);
  // The shared canvas is not clipped either. Cards already avoid solid chrome
  // by placement, and every occluder composites above this host in the DOM, so
  // the clip could only ever carve voids out of legitimate world content.
  _ctx.save();
  let itemIndex = 0;
  for (let lane = 0; lane < WORLD_OVERLAY_PAINT_LANES.length; lane++) {
    // Source-owned painters run first inside their lane. Detection therefore
    // retains its former z5 position below every ordinary host entry at z6.
    paintCustomLane(lane);
    while (itemIndex < _paintCount && _paintQueue[itemIndex].lane === lane) {
      paintEntryItem(_paintQueue[itemIndex], keyhole);
      itemIndex++;
    }
  }
  _ctx.restore();
  _diagnostics.paintedCount = _paintRectCount;
  _diagnostics.hitRectCount = _hitRectCount;
  _diagnostics.paintItemPoolSize = _paintItemPool.length;
  _diagnostics.paintRectPoolSize = _paintRectPool.length;
  _diagnostics.paintMs = nowMs() - started;
  syncAccessibleActions();
  _canvasNeedsClear = _paintRectCount > 0
    || activeCustomPaintLaneCount(PAINT_TARGET_SHARED) > 0;
}

function localizeScaledPlacement(placement, scale, out) {
  const x = placement.rect.x;
  const y = placement.rect.y;
  out.corner = placement.corner;
  out.rect.x = 0;
  out.rect.y = 0;
  out.rect.w = placement.rect.w / scale;
  out.rect.h = placement.rect.h / scale;
  out.centerX = (placement.centerX - x) / scale;
  out.centerY = (placement.centerY - y) / scale;
  out.anchorX = (placement.anchorX - x) / scale;
  out.anchorY = (placement.anchorY - y) / scale;
  out.leadFromX = (placement.leadFromX - x) / scale;
  out.leadFromY = (placement.leadFromY - y) / scale;
  out.paintScale = scale;
  out.leaderOffset = placement.leaderOffset;
  if (out.leaderOffset !== 0) out.leaderOffset /= scale;
  out.leadToX = (placement.leadToX - x) / scale;
  out.leadToY = (placement.leadToY - y) / scale;
  return out;
}

function resetFrameDiagnostics() {
  _diagnostics.candidateCount = 0;
  _diagnostics.projectedCount = 0;
  _diagnostics.selectedCount = 0;
  _diagnostics.fadingCount = 0;
  _diagnostics.paintedCount = 0;
  _diagnostics.hitRectCount = 0;
  _diagnostics.projectionMs = 0;
  _diagnostics.solveMs = 0;
  _diagnostics.paintMs = 0;
  for (let i = 0; i < _paintedSourceKeys.length; i++) {
    _paintedBySource[_paintedSourceKeys[i]] = 0;
  }
}

function drawWorldOverlay() {
  if (_destroyed || !_viewer || !_canvas || !_ctx) return;
  const timestamp = nowMs();
  if (!overlayHasPaintWork(timestamp)) {
    resetFrameDiagnostics();
    _solveDirty = false;
    if (_canvasNeedsClear || _detectionSurfaceNeedsClear) clearCanvas();
    if (_accessibilitySignature) {
      _hitRectCount = 0;
      syncAccessibleActions();
    }
    return;
  }
  if (_resizeDirty) ensureCanvasSize();
  if (_canvasWidth <= 0 || _canvasHeight <= 0) return;
  _frameStamp++;
  refreshUiOccluders(timestamp, _occludersUpdatedAt === Number.NEGATIVE_INFINITY);
  resetFrameDiagnostics();
  const projectionStarted = nowMs();
  const fadeTuning = getKeyholeFadeTuning();
  if (!_keyhole || _keyholeWidth !== _canvasWidth || _keyholeHeight !== _canvasHeight
    || _keyholeFadeRatio !== fadeTuning.fadeRatio
    || _keyholeOutsideOpacity !== fadeTuning.outsideOpacity) {
    _keyhole = getKeyholeGeometry(_canvasWidth, _canvasHeight);
    _keyholeWidth = _canvasWidth;
    _keyholeHeight = _canvasHeight;
    _keyholeFadeRatio = fadeTuning.fadeRatio;
    _keyholeOutsideOpacity = fadeTuning.outsideOpacity;
  }
  const keyhole = _keyhole;
  const viewProjection = prepareCustomPaintFrame(timestamp, keyhole);
  collectFrameCandidates(keyhole, viewProjection);
  _diagnostics.projectionMs = nowMs() - projectionStarted;
  solveDomains(timestamp);
  paintFrame(keyhole);
  const fadesRemaining = activeFadeCount(timestamp);
  if (fadesRemaining > 0) _viewer.scene.requestRender?.();
}

function createDevFacade() {
  if (typeof window === 'undefined' || import.meta.env?.DEV !== true) return;
  window.__gevWorldOverlay = { getDiagnostics: getWorldOverlayDiagnostics };
}

/**
 * Initialize the singleton host. Repeated calls for the same viewer are no-op.
 * @param {Cesium.Viewer} viewer
 */
export function initWorldOverlay(viewer) {
  if (!viewer?.scene?.postRender?.addEventListener) {
    throw new TypeError('initWorldOverlay requires a Cesium viewer with scene.postRender');
  }
  if (_viewer === viewer && _canvas && _removePostRender) return;
  if (_viewer) destroyWorldOverlay();
  _destroyed = false;
  _viewer = viewer;
  ensureOverlayDom();
  _occluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    viewer.camera?.positionWC || new Cesium.Cartesian3(),
  );
  _cockpitActive = !!document.body?.classList?.contains('cockpit-mode');
  _cockpitModeHandler = (event) => {
    _cockpitActive = event?.detail?.active === true;
    invalidateHost();
  };
  window.addEventListener('gev:cockpit-mode-changed', _cockpitModeHandler);
  _removePostRender = viewer.scene.postRender.addEventListener(drawWorldOverlay);
  if (viewer.camera?.moveEnd?.addEventListener) {
    _removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => invalidateHost());
  }
  installUiOccluderObservers();
  // The backing store and the occluder inventory are both deferred to the
  // first frame with real paint work: a dormant host must not hold a
  // full-viewport canvas (~19 MB at DPR 2) or scan the UI for exclusions.
  _resizeDirty = true;
  _occludersDirty = true;
  _solveDirty = true;
  _canvasNeedsClear = true;
  _detectionSurfaceNeedsClear = true;
  updateEntryDiagnostics();
  createDevFacade();
}

/** Remove all listeners, observers, entries, diagnostics, and overlay DOM. */
export function destroyWorldOverlay() {
  // Tearing down a host that was never initialized must not arm the
  // post-destroy guard: sources are allowed to publish before the first
  // `initWorldOverlay`, and that buffering has to survive a stray destroy.
  const hadHost = _viewer !== null;
  _removePostRender?.();
  _removePostRender = null;
  _removeMoveEnd?.();
  _removeMoveEnd = null;
  if (_cockpitModeHandler && typeof window !== 'undefined') {
    window.removeEventListener('gev:cockpit-mode-changed', _cockpitModeHandler);
  }
  _cockpitModeHandler = null;
  if (_windowResizeHandler && typeof window !== 'undefined') {
    window.removeEventListener('resize', _windowResizeHandler);
  }
  _windowResizeHandler = null;
  _resizeObserver?.disconnect?.();
  _resizeObserver = null;
  _observedOccluderElements = new WeakSet();
  _mutationObserver?.disconnect?.();
  _mutationObserver = null;
  destroyWorldOverlayDraw();
  if (_occluderRefreshTimer != null) clearTimeout(_occluderRefreshTimer);
  _occluderRefreshTimer = null;
  _root?.remove?.();
  _accessibilityRoot?.remove?.();
  // The detection surface is not a child of `_root` (it lives in the Cesium
  // container so its `screen` blend reaches the scene), so it has to be torn
  // down explicitly rather than by the root's removal.
  _detectionSurface?.remove?.();
  if (typeof window !== 'undefined' && window.__gevWorldOverlay?.getDiagnostics === getWorldOverlayDiagnostics) {
    delete window.__gevWorldOverlay;
  }
  _sources.clear();
  _sourceList.length = 0;
  for (let i = 0; i < _customPaintLaneList.length; i++) {
    _customPaintLaneList[i].active = false;
    _customPaintLaneList[i].painter = null;
    _customPaintLaneList[i].shouldPaint = null;
  }
  _customPaintLanes.clear();
  _customPaintLaneList.length = 0;
  _domains.clear();
  _domainList.length = 0;
  _records.clear();
  for (let i = 0; i < _paintItemPool.length; i++) {
    const item = _paintItemPool[i];
    item.record = null;
    item.placement = null;
  }
  for (let i = 0; i < _paintRectPool.length; i++) {
    _paintRectPool[i].entry = null;
  }
  _paintQueue.length = 0;
  _paintItemPool.length = 0;
  _paintRectPool.length = 0;
  _hitRects.length = 0;
  _accessibleActivatorByKey.clear();
  _accessibilitySignature = '';
  _paintRectByKey.clear();
  _paintCount = 0;
  _paintRectCount = 0;
  _hitRectCount = 0;
  _uiOcclusionRects.length = 0;
  _uiOcclusionRectPool.length = 0;
  _destroyed = hadHost || _destroyed;
  _viewer = null;
  _root = null;
  _canvas = null;
  _ctx = null;
  _accessibilityRoot = null;
  _accessibilityList = null;
  _accessibilityStatus = null;
  _detectionSurface = null;
  _detectionCtx = null;
  _occluder = null;
  _occluderCameraX = Number.NaN;
  _occluderCameraY = Number.NaN;
  _occluderCameraZ = Number.NaN;
  _keyhole = null;
  _keyholeWidth = -1;
  _keyholeHeight = -1;
  _keyholeFadeRatio = Number.NaN;
  _keyholeOutsideOpacity = Number.NaN;
  _cockpitActive = false;
  _resizeDirty = true;
  _occludersDirty = true;
  _solveDirty = true;
  _canvasNeedsClear = true;
  _detectionSurfaceNeedsClear = true;
  _detectionSurfacePrepared = false;
  _occludersUpdatedAt = Number.NEGATIVE_INFINITY;
  _canvasWidth = 0;
  _canvasHeight = 0;
  _viewport.width = 0;
  _viewport.height = 0;
  _canvasDpr = 1;
  _layoutRevision = 0;
  _customPaintFrame.canvas = null;
  _customPaintFrame.surface = null;
  _customPaintFrame.ctx = null;
  _customPaintFrame.width = 0;
  _customPaintFrame.height = 0;
  _customPaintFrame.dpr = 1;
  _customPaintFrame.timestamp = 0;
  _customPaintFrame.cameraPosition = null;
  _customPaintFrame.occluder = null;
  _customPaintFrame.keyhole = null;
  _customPaintFrame.uiRectCount = 0;
  _customPaintFrame.layoutRevision = 0;
  for (let i = 0; i < _paintedSourceKeys.length; i++) {
    delete _paintedBySource[_paintedSourceKeys[i]];
  }
  _paintedSourceKeys.length = 0;
  Object.assign(_diagnostics, {
    sourceCount: 0,
    entryCount: 0,
    candidateCount: 0,
    projectedCount: 0,
    selectedCount: 0,
    fadingCount: 0,
    paintedCount: 0,
    hitRectCount: 0,
    projectionMs: 0,
    solveMs: 0,
    paintMs: 0,
    solveRevision: 0,
    paintItemPoolSize: 0,
    paintRectPoolSize: 0,
    candidateIndexSize: 0,
    entriesBySource: {},
    paintedBySource: _paintedBySource,
  });
}
