import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

// TeleGeography submarine-cable data is bundled for an out-of-the-box
// experience. IMPORTANT: it is CC BY-NC-SA 3.0 (NonCommercial + ShareAlike),
// NOT covered by this project's MIT license — see DATA_SOURCES.md. Commercial
// users must remove this dataset or obtain a license from TeleGeography.
const cableUrl = new URL(
  './local_data/telegeography_submarine_cables/cable-geo.json',
  import.meta.url,
).href;
const landingPointUrl = new URL(
  './local_data/telegeography_submarine_cables/landing-point-geo.json',
  import.meta.url,
).href;

const BASE_CABLE_COLOR = '#39d5ff';
const BASE_LANDING_COLOR = '#8fffd2';
const STEM_TARGET_PX = 66;
const CABLE_REFERENCE_LABEL_MAX_DISTANCE_M = 9000000;
/** Bounded nearest-visible cohort the layer offers the shared host. */
export const CABLE_REFERENCE_LABEL_WINNER_CAP = 160;
/** Shared world-overlay source id (matches the layer id). */
export const CABLE_OVERLAY_SOURCE_ID = 'telegeography-submarine-cables';
/** Shared ambient-label paint budget, matching the infrastructure sources. */
export const CABLE_OVERLAY_COLLISION_CAPACITY = 96;
/** Ignore sub-metre camera-derived stem-tip noise at camera settle. */
export const CABLE_STEM_TIP_EPSILON_M = 0.5;
const CABLE_STEM_TIP_EPSILON_SQ = CABLE_STEM_TIP_EPSILON_M ** 2;
/**
 * Motion-fallback probe window. Cameras that never emit `moveEnd` (tracked
 * entities, orbits) would otherwise starve the dirty-only sweep forever, so
 * the gate samples camera motion at most this often while frames render.
 */
export const CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS = 2000;
/**
 * Camera displacement that counts as meaningful motion for that probe. Stem
 * tip height is ~8.5% of camera distance at the shipped 66 px target, so
 * 250 m of camera travel moves a tip ~21 m; below that the frozen sweep is
 * visually indistinguishable and `moveEnd` settles it exactly.
 */
export const CABLE_SWEEP_MOTION_EPSILON_M = 250;
/**
 * Phase-5 depth decision, REVISED 2026-08-18: Option 2. Cable reference text
 * now renders in the shared world-overlay host (horizon-cull + keyhole fade,
 * no per-label tile depth test), superseding the 2026-08-02 Option-1 native
 * `LabelGraphics` exception. The native path evaluated 2 `CallbackProperty`
 * channels per reference entity per frame (5,258 across the 2,629-reference
 * dataset) and re-batched a 160-label `LabelCollection` on every sweep — the
 * layer alone cost ~9.5 ms/frame during camera motion. The depth cue this
 * trades away (photoreal tiles occluding label TEXT at low, city-level
 * cameras) matches the sibling dams/datacenters sources, which shipped
 * host-composited under the same rule; the anchor points/stems remain
 * Cesium-native and depth-tested.
 */
export const CABLE_LABEL_DEPTH_DECISION = Object.freeze({
  option: 2,
  decidedAt: '2026-08-18',
  supersedes: '2026-08-02',
  depthTested: false,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  clearSource: clearOverlaySource,
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
});

export default createTeleGeographySubmarineCableLayer();

/**
 * Select the nearest visible cable references without exceeding the bounded
 * cohort cap the shared host is offered.
 * @param {object[]} records Records annotated with `visible` and `distanceM`.
 * @param {number} [limit]
 * @returns {object[]}
 */
export function selectCableReferenceLabelWinners(
  records,
  limit = CABLE_REFERENCE_LABEL_WINNER_CAP,
) {
  const cap = Math.max(0, Math.min(
    CABLE_REFERENCE_LABEL_WINNER_CAP,
    Math.floor(Number(limit) || 0),
  ));
  if (!Array.isArray(records) || cap === 0) return [];
  return records
    .filter((record) => record?.visible === true
      && record.label
      && Number.isFinite(record.distanceM)
      && record.distanceM <= CABLE_REFERENCE_LABEL_MAX_DISTANCE_M)
    .sort((a, b) => a.distanceM - b.distanceM
      || String(a.entity?.id || '').localeCompare(String(b.entity?.id || '')))
    .slice(0, cap);
}

/**
 * Distance-derived arbiter priority. Quantized to 50 km buckets so a slowly
 * moving camera does not reshuffle equal-rank labels on every sweep; nearer
 * references still win collisions, matching the shipped nearest-first feel.
 * @param {number} distanceM
 * @returns {number}
 */
export function cableReferencePriority(distanceM) {
  const distance = Number.isFinite(distanceM) ? Math.max(0, distanceM) : CABLE_REFERENCE_LABEL_MAX_DISTANCE_M;
  return 1000 - Math.round(distance / 50000);
}

/**
 * Build one shared-host ambient label for a cable or landing-point reference.
 * The entry stays attached to the record's mutable stem-tip Cartesian and is
 * created once per record; only `priority` is refreshed per sweep.
 * `interactive: false` follows the infrastructure precedent — the depth-tested
 * native point/stem/line remains the click surface, and a non-interactive
 * label keeps the host's per-frame accessibility/hit sync allocation-free.
 * @param {object} record Reference record ({ id, kind, label, tip }).
 * @returns {object}
 */
export function createCableOverlayEntry(record) {
  const kind = record?.kind === 'landing-point' ? 'landing-point' : 'cable';
  return {
    id: String(record?.id || ''),
    position: record?.tip,
    variant: 'label',
    title: String(record?.label || ''),
    accent: kind === 'cable' ? BASE_CABLE_COLOR : BASE_LANDING_COLOR,
    priority: cableReferencePriority(record?.distanceM),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    minDistance: 0,
    maxDistance: CABLE_REFERENCE_LABEL_MAX_DISTANCE_M,
    distanceFadeStartRatio: 0.7,
    // Former native scaleByDistance curve, unchanged: 1.0× at 250 km → 0.62×
    // at 9,000 km.
    distanceScale: {
      near: 250000,
      nearValue: 1,
      far: 9000000,
      farValue: 0.62,
    },
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Bind the cable layer's host visibility and entry lifecycle to the shared
 * world overlay (same contract as the infrastructure publisher). The layer
 * supports re-init after destroy (legacy contract), so its teardown path is
 * hide() — clear the published source and go invisible while staying
 * reusable. There is deliberately no permanent-destroy method: a hidden
 * publisher already drops late publishes until the next show().
 * @param {object} [options]
 * @param {string} [options.sourceId]
 * @param {object} [options.host] Test seam for the three host lifecycle calls.
 * @returns {{show:function():void,publish:function(object[]):void,hide:function():void}}
 */
export function createCableOverlayPublisher({
  sourceId = CABLE_OVERLAY_SOURCE_ID,
  host = DEFAULT_OVERLAY_HOST,
} = {}) {
  let visible = false;
  let published = false;
  const sourceOptions = {
    cohortLimit: CABLE_REFERENCE_LABEL_WINNER_CAP,
    collisionCapacity: CABLE_OVERLAY_COLLISION_CAPACITY,
    moving: false,
  };

  return {
    show() {
      if (visible) return;
      visible = true;
      host.setVisible(sourceId, true);
    },
    publish(entries) {
      if (!visible) return;
      host.setEntries(sourceId, entries, sourceOptions);
      published = entries.length > 0;
    },
    hide() {
      if (published) host.clearSource(sourceId);
      if (visible) host.setVisible(sourceId, false);
      visible = false;
      published = false;
    },
  };
}

/**
 * `MAP_STACKS` ids that render imagery on the SHOWN Cesium globe (the ion
 * Bing stacks + OSM). Deliberately an explicit allowlist, not "anything that
 * is not photoreal": an id this module has never heard of is UNKNOWN, and
 * unknown must reach the documented BOTH fallback rather than being asserted
 * onto the terrain surface. A stack added to `MAP_STACKS` without being added
 * here therefore degrades to the safe pre-optimization behavior (visible on
 * every surface) instead of vanishing — and the per-stack unit test walks the
 * real `MAP_STACKS` so the omission is caught loudly.
 */
const CABLE_GLOBE_STACK_IDS = Object.freeze(
  new Set(['bing-aerial', 'bing-labels', 'osm']),
);

/**
 * Ground-line classification for one map stack. The photoreal stack renders
 * Google 3D tiles with the Cesium globe HIDDEN, so cable ground lines only
 * need the 3D-tile classification pass there; every other known stack (the
 * bing stacks and osm) renders imagery on the shown globe, so only the
 * terrain pass applies.
 * Classifying against just the active surface halves the batched
 * GroundPolylinePrimitive's emitted command sets. BOTH is the safe fallback
 * for an unknown stack — it renders on every surface, exactly the shipped
 * pre-optimization behavior.
 * @param {string|null|undefined} activeId MapStackController stack id.
 * @returns {Cesium.ClassificationType}
 */
export function cableClassificationTypeForStack(activeId) {
  if (activeId === 'photoreal') return Cesium.ClassificationType.CESIUM_3D_TILE;
  if (CABLE_GLOBE_STACK_IDS.has(activeId)) return Cesium.ClassificationType.TERRAIN;
  return Cesium.ClassificationType.BOTH;
}

/**
 * Derive the active surface from live scene state. The boot-time
 * `setStack(..., { silent: true })` fires no 'gev:map-stack-changed' event,
 * so the initial classification reads the scene the way the height-datum
 * listeners do: the photoreal regime is exactly "globe hidden".
 * @param {Cesium.Scene|null|undefined} scene
 * @returns {Cesium.ClassificationType}
 */
export function cableClassificationTypeForScene(scene) {
  if (!scene?.globe) return Cesium.ClassificationType.BOTH;
  return scene.globe.show === false
    ? Cesium.ClassificationType.CESIUM_3D_TILE
    : Cesium.ClassificationType.TERRAIN;
}

/** EntityCluster's private marker collections and their required types. */
const MARKER_COLLECTION_EXPECTATIONS = Object.freeze([
  Object.freeze({ key: '_billboardCollection', type: Cesium.BillboardCollection }),
  Object.freeze({ key: '_pointCollection', type: Cesium.PointPrimitiveCollection }),
]);

/**
 * Validate one data source's marker collections WITHOUT mutating anything.
 * Splitting validation from mutation is what makes the fallback honest: a
 * shape failure on the SECOND collection (or the second data source) must
 * not leave the first one already forced to TRANSLUCENT.
 * @param {Cesium.DataSource|null|undefined} dataSource
 * @returns {{ready:object[],pending:number,invariantFailed:boolean}}
 */
function probeTranslucentMarkerBlend(dataSource) {
  const cluster = dataSource?.clustering;
  if (!cluster) return { ready: [], pending: 0, invariantFailed: true };
  const ready = [];
  let pending = 0;
  let invariantFailed = false;
  for (const { key, type } of MARKER_COLLECTION_EXPECTATIONS) {
    if (!(key in cluster)) {
      invariantFailed = true;
      continue;
    }
    const collection = cluster[key];
    if (collection === undefined || collection === null) {
      pending++;
      continue;
    }
    if (!(collection instanceof type) || !('blendOption' in collection)) {
      invariantFailed = true;
      continue;
    }
    ready.push(collection);
  }
  // Any failure discards every collected target: nothing is mutated at all.
  if (invariantFailed) return { ready: [], pending: 0, invariantFailed: true };
  return { ready, pending, invariantFailed: false };
}

/**
 * Commit a clean probe. Only ever called once every probe in the batch has
 * passed, so this cannot land a partial application.
 * @param {{ready:object[],pending:number}} probe
 * @returns {{applied:number,pending:number,invariantFailed:boolean}}
 */
function commitTranslucentMarkerBlend(probe) {
  for (const collection of probe.ready) {
    if (collection.blendOption !== Cesium.BlendOption.TRANSLUCENT) {
      collection.blendOption = Cesium.BlendOption.TRANSLUCENT;
    }
  }
  return { applied: probe.ready.length, pending: probe.pending, invariantFailed: false };
}

/**
 * Force one translucent draw pass for a data source's marker collections.
 * The default `OPAQUE_AND_TRANSLUCENT` blend emits two draw commands per
 * collection, and every cable marker is translucent (alpha < 1), so the
 * opaque pass is pure overhead across 1,917 landing billboards + 2,629
 * reference points. Cesium has no public accessor for the entity-backed
 * collections, so this reaches through EntityCluster's private fields under
 * a SHAPE INVARIANT the caller must honor loudly: the constructor
 * pre-assigns `_billboardCollection`/`_pointCollection` (= undefined until a
 * visualizer lazily creates them), so a missing PROPERTY means Cesium's
 * shape changed — report `invariantFailed` and never touch anything —
 * while a present-but-undefined value only means "not created yet"
 * (`pending`). Wrong instance types also fail the invariant. The cables
 * sources never enable clustering, so created collections persist.
 * VALIDATE-ALL-THEN-MUTATE-ALL: every field/type check runs before the first
 * assignment, so a failure anywhere leaves BOTH collections on Cesium's
 * default blend — the fallback this helper promises.
 * @param {Cesium.DataSource|null|undefined} dataSource
 * @returns {{applied:number,pending:number,invariantFailed:boolean}}
 */
export function applyTranslucentMarkerBlend(dataSource) {
  const probe = probeTranslucentMarkerBlend(dataSource);
  if (probe.invariantFailed) return { applied: 0, pending: 0, invariantFailed: true };
  return commitTranslucentMarkerBlend(probe);
}

/**
 * Monotonic clock for the sweep gate's motion probe. A hoisted declaration:
 * the module's `export default createTeleGeographySubmarineCableLayer()`
 * runs before this point in source order.
 * @returns {number}
 */
function defaultSweepClock() {
  return (typeof performance === 'object' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

/**
 * Dirty gate for the reference sweep. TWO dirty conditions, no timer:
 *
 * 1. EVENT (primary): the sweep runs on the first frame after a camera
 *    `moveEnd`, layer enable, or load completion. The former 500 ms timer
 *    path re-sized stems while frames were flowing, and every re-size
 *    rebuilt the 2,629-instance batched translucent stem primitive
 *    (measured: 12 rebuilds in 6 s with the replacement primitive unready
 *    for 46/360 frames — the felt hitch). Stem lengths are therefore
 *    deliberately stale mid-drag/mid-flight and settle on release;
 *    reference visibility and label winners go stale the same way, and the
 *    shared host keeps reprojecting the published positions per frame.
 * 2. MOTION FALLBACK: `moveEnd` covers drags, one-shot `setView`, and voice
 *    `flyTo`, but a TRACKED-entity follow camera or an orbit never emits it,
 *    so condition 1 alone starves those sessions forever (frozen horizon
 *    visibility, frozen stems, stale label winners for as long as tracking
 *    lasts). While frames render, the gate therefore samples the camera at
 *    most once per `CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS` and re-arms itself
 *    only when the camera has actually travelled past
 *    `CABLE_SWEEP_MOTION_EPSILON_M` since the last sweep.
 *
 * A PARKED camera still costs exactly zero sweeps: the probe compares against
 * the last swept position (never the previous frame), so neither a frozen
 * camera nor sub-epsilon numeric jitter ever accumulates into a sweep, and
 * the per-frame cost of the fallback is one clock read plus one subtraction.
 * Position is the only motion channel because it is the only camera input the
 * sweep consumes — the horizon occluder, the reference distances, the stem
 * sizing, and the winner ranks all derive from `positionWC` alone, so a
 * heading-only rotation cannot change a single sweep output and deliberately
 * does not spend one.
 * @param {object} [options]
 * @param {function():number} [options.now] Monotonic clock (test seam).
 * @param {number} [options.probeIntervalMs]
 * @param {number} [options.motionEpsilonM]
 */
export function createCableReferenceSweepGate({
  now = defaultSweepClock,
  probeIntervalMs = CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS,
  motionEpsilonM = CABLE_SWEEP_MOTION_EPSILON_M,
} = {}) {
  const motionEpsilonSq = motionEpsilonM ** 2;
  // Preallocated: the probe clones into it, so a moving camera allocates
  // nothing per frame.
  const lastSweptPosition = new Cesium.Cartesian3();
  let hasSweptPosition = false;
  let dirty = true;
  let lastProbeAt = -Infinity;

  /** Arm the next probe window and adopt the camera position being swept. */
  function accept(camera, time) {
    lastProbeAt = time;
    const position = camera?.positionWC;
    hasSweptPosition = Boolean(position);
    if (position) Cesium.Cartesian3.clone(position, lastSweptPosition);
    return true;
  }

  return {
    markDirty() { dirty = true; },
    /**
     * @param {Cesium.Camera} [camera] Live camera; omit to disable the motion
     *   fallback entirely (pure dirty-only gate).
     * @returns {boolean}
     */
    shouldRun(camera) {
      if (dirty) {
        dirty = false;
        return accept(camera, now());
      }
      if (!camera) return false;
      // Cheapest possible per-frame path: a clock read and a subtraction. The
      // camera getter is only touched once the probe window has actually
      // opened, and the window re-arms whether or not the probe sweeps.
      const time = now();
      if (time - lastProbeAt < probeIntervalMs) return false;
      lastProbeAt = time;
      const position = camera.positionWC;
      if (!position) return false;
      if (hasSweptPosition
        && Cesium.Cartesian3.distanceSquared(position, lastSweptPosition) <= motionEpsilonSq) {
        return false;
      }
      return accept(camera, time);
    },
    reset() {
      dirty = true;
      lastProbeAt = -Infinity;
      hasSweptPosition = false;
    },
  };
}

/**
 * Recompute one staticized stem on the sweep cadence. Replaces the former
 * per-frame `CallbackProperty` pair: constant properties are redefined only
 * when the camera-scaled tip moved beyond the settle epsilon, and the two
 * preallocated position buffers alternate so each real change raises exactly
 * one geometry notification (the localGeojson double-buffer pattern).
 * @param {object} record Reference record with entity/base/tip/nextTip/buffers.
 * @param {Cesium.Cartesian3} cameraPositionWC
 * @param {number} canvasHeight CSS-pixel canvas height.
 * @param {number} fov Camera frustum field of view (radians).
 * @returns {boolean} True when the stem geometry was redefined.
 */
export function updateCableReferenceStem(record, cameraPositionWC, canvasHeight, fov) {
  const distance = Cesium.Cartesian3.distance(cameraPositionWC, record.base);
  const effectiveDistance = Math.max(distance, 5000);
  const height = canvasHeight || 1080;
  const fieldOfView = fov || (Math.PI / 3);
  const metersPerPixelFactor = 2 * Math.tan(fieldOfView / 2) / height;
  const tipHeight = Math.max(
    700,
    Math.min(85000, effectiveDistance * metersPerPixelFactor * STEM_TARGET_PX),
  );
  Cesium.Cartesian3.fromDegrees(
    record.reference.lon,
    record.reference.lat,
    tipHeight,
    Cesium.Ellipsoid.WGS84,
    record.nextTip,
  );
  if (Cesium.Cartesian3.distanceSquared(record.tip, record.nextTip) <= CABLE_STEM_TIP_EPSILON_SQ) {
    return false;
  }
  Cesium.Cartesian3.clone(record.nextTip, record.tip);
  record.stemPositionBufferIndex = 1 - record.stemPositionBufferIndex;
  const stemPositions = record.stemPositionBuffers[record.stemPositionBufferIndex];
  stemPositions[0] = record.base;
  stemPositions[1] = record.tip;
  record.entity.position.setValue(record.tip);
  record.entity.polyline.positions.setValue(stemPositions);
  return true;
}

export function createTeleGeographySubmarineCableLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  screenSpaceEventHandlerFactory = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
  mapStackEventTarget = typeof window !== 'undefined' ? window : null,
  // Test seam: the sweep gate's motion-fallback clock. Tests freeze it so the
  // fallback window is driven explicitly instead of by wall-clock timing.
  sweepClock = defaultSweepClock,
} = {}) {
  let _viewer = null;
  let _enabled = false;
  let _loading = false;
  let _loaded = false;
  let _count = 0;
  let _error = null;
  let _lastUpdate = null;
  let _loadingLabel = '';
  let _abort = null;
  /** Monotonic load-ownership token; every load() start claims a new one. */
  let _loadGeneration = 0;
  let _cableDataSource = null;
  let _landingDataSource = null;
  let _referenceDataSource = null;
  let _referenceRecords = [];
  let _surfaceRecords = [];
  let _clickHandler = null;
  let _preRenderRemover = null;
  let _moveEndRemover = null;
  let _mapStackListener = null;
  /** Active ground-line classification; refined from live scene state at init. */
  let _classificationType = Cesium.ClassificationType.BOTH;
  /** True once both marker collections blend translucent (or the shape probe failed). */
  let _markerBlendDone = false;
  let _markerBlendInvariantWarned = false;
  let _pickByEntity = new WeakMap();
  let _referenceLabelCount = 0;
  const _referenceSweepGate = createCableReferenceSweepGate({ now: sweepClock });
  const _overlayPublisher = createCableOverlayPublisher({ host: overlayHost });
  /** Reused winner→entry scratch so a 2 Hz sweep allocates no arrays. */
  const _publishScratch = [];
  /**
   * Last published cohort signature (ids + quantized priorities). A parked
   * camera reproduces the same winners every sweep; skipping the identical
   * republish keeps the host from requesting a render per publish, so the
   * layer stays render-governor idle exactly like its native predecessor.
   * Tip positions need no republish either: the host reprojects the same
   * mutable Cartesians on every painted frame.
   */
  const _lastPublishedIds = [];
  const _lastPublishedPriorities = [];
  let _lastPublishedCount = -1;

  function resetPublishSignature() {
    _lastPublishedIds.length = 0;
    _lastPublishedPriorities.length = 0;
    _lastPublishedCount = -1;
  }

  const cableColor = Cesium.Color.fromCssColorString(BASE_CABLE_COLOR);
  const cableOutline = Cesium.Color.BLACK.withAlpha(0.45);
  const landingColor = Cesium.Color.fromCssColorString(BASE_LANDING_COLOR);

  async function load(viewer) {
    if (_loading || _loaded) return;

    _loading = true;
    _error = null;
    _loadingLabel = 'loading...';
    // Ownership token (the militaryAwareness activationId pattern): a
    // disable/abort followed by a fresh enable starts a NEWER load while this
    // one is still settling. The stale load must bail after every await and
    // must never touch shared lifecycle state or the viewer it no longer
    // owns — clearing `_loading`/`_abort` for the successor is how duplicate
    // or post-destroy data sources got added.
    const generation = ++_loadGeneration;
    const abort = new AbortController();
    _abort = abort;
    const owns = () => generation === _loadGeneration && !abort.signal.aborted;

    try {
      const [cableJson, landingJson] = await Promise.all([
        fetchJson(cableUrl, abort.signal),
        fetchJson(landingPointUrl, abort.signal),
      ]);
      if (!owns()) return;

      const cableFeatures = normalizeFeatures(cableJson, 'cable');
      const landingFeatures = normalizeFeatures(landingJson, 'landing');

      const cableDataSource = await Cesium.GeoJsonDataSource.load(
        { type: 'FeatureCollection', features: cableFeatures },
        {
          clampToGround: true,
          stroke: cableColor.withAlpha(0.95),
          fill: cableColor.withAlpha(0.18),
          strokeWidth: 2,
          markerColor: cableColor,
          markerSize: 6,
        }
      );
      if (!owns()) return;
      const landingDataSource = await Cesium.GeoJsonDataSource.load(
        { type: 'FeatureCollection', features: landingFeatures },
        {
          clampToGround: true,
          stroke: landingColor.withAlpha(0.9),
          fill: landingColor.withAlpha(0.35),
          strokeWidth: 2,
          markerColor: landingColor,
          markerSize: 6,
        }
      );
      if (!owns()) return;

      cableDataSource.name = 'TeleGeography Submarine Cables';
      landingDataSource.name = 'TeleGeography Landing Points';
      const referenceDataSource = new Cesium.CustomDataSource('TeleGeography Cable References');
      const addedSources = [cableDataSource, landingDataSource, referenceDataSource];

      // dataSources.add() is itself an await point: Cesium mutates the
      // collection on a DEFERRED tick, so a disable/destroy racing this
      // window finds nothing to remove and the adds still materialize
      // afterwards. Await every add to settlement (allSettled so a partial
      // failure cannot leave an unawaited add materializing later), then
      // re-check ownership. Pinned teardown mechanism: disable/destroy never
      // wait for in-flight adds — the stale generation's own post-await
      // check here guarantees cleanup by removing exactly the sources THIS
      // generation added.
      const addResults = await Promise.allSettled([
        viewer.dataSources.add(cableDataSource),
        viewer.dataSources.add(landingDataSource),
        viewer.dataSources.add(referenceDataSource),
      ]);
      const rejectedAdd = addResults.find((result) => result.status === 'rejected');
      if (!owns() || rejectedAdd) {
        // Compensate: every add has settled by now, so removal is effective
        // (a remove inside the deferred window would have been a no-op).
        // Remove EVERY generation-local source regardless of settle status:
        // Cesium's add() pushes into the collection BEFORE raising
        // dataSourceAdded, so a REJECTED add may still have landed its
        // mutation. remove() of a never-added source is a harmless no-op.
        for (const source of addedSources) {
          try { viewer.dataSources.remove(source, true); } catch { /* collection gone */ }
        }
        if (owns() && rejectedAdd) throw rejectedAdd.reason;
        return;
      }

      // Await-free commit: the viewer accepted all three sources and this
      // load still owns the lifecycle.
      _cableDataSource = cableDataSource;
      _landingDataSource = landingDataSource;
      _referenceDataSource = referenceDataSource;

      const cableEntities = _cableDataSource.entities.values;
      const landingEntities = _landingDataSource.entities.values;
      _pickByEntity = new WeakMap();
      _referenceRecords = [];
      _surfaceRecords = [];

      cableEntities.forEach((entity, index) => {
        const feature = cableFeatures[index];
        const reference = featureReference(feature);
        if (!reference) return;

        styleCableEntity(entity, feature);
        registerPickEntity(entity, {
          kind: 'cable',
          reference,
          label: featureLabel(feature),
        });
        _surfaceRecords.push({
          entity,
          base: Cesium.Cartesian3.fromDegrees(reference.lon, reference.lat, 0),
        });
        addReferenceStem({
          reference,
          label: featureLabel(feature),
          kind: 'cable',
          color: cableColor,
          feature,
        });
      });

      landingEntities.forEach((entity, index) => {
        const feature = landingFeatures[index];
        const reference = featureReference(feature);
        if (!reference) return;

        styleLandingEntity(entity, feature);
        registerPickEntity(entity, {
          kind: 'landing-point',
          reference,
          label: featureLabel(feature),
        });
        _surfaceRecords.push({
          entity,
          base: Cesium.Cartesian3.fromDegrees(reference.lon, reference.lat, 0),
        });
        addReferenceStem({
          reference,
          label: featureLabel(feature),
          kind: 'landing-point',
          color: landingColor,
          feature,
        });
      });

      _count = cableFeatures.length + landingFeatures.length;
      _loaded = true;
      _lastUpdate = Date.now();
      _loadingLabel = '';
      updateVisibility();
      _referenceSweepGate.markDirty();
      viewer.scene.requestRender?.();
    } catch (error) {
      // A stale or aborted load reports nothing: its failure belongs to a
      // lifecycle the user already left.
      if (owns() && error?.name !== 'AbortError') {
        _error = error?.message || 'TeleGeography load failed';
        console.warn('[Data:telegeography-submarine-cables]', _error, error);
      }
    } finally {
      // Only the OWNING load may clear the shared lifecycle. A stale load
      // clearing `_loading`/`_abort` would hand a later enable/update a
      // duplicate load while the real one is still in flight.
      if (generation === _loadGeneration) {
        _loading = false;
        if (_abort === abort) _abort = null;
      }
    }
  }

  function updateVisibility() {
    if (_cableDataSource) _cableDataSource.show = _enabled;
    if (_landingDataSource) _landingDataSource.show = _enabled;
    if (_referenceDataSource) _referenceDataSource.show = _enabled;
  }

  function registerPickEntity(entity, info) {
    entity.__gevTeleGeography = info;
    _pickByEntity.set(entity, info);
  }

  function styleCableEntity(entity, feature) {
    if (!entity?.polyline) return;
    const color = feature?.properties?.color
      ? Cesium.Color.fromCssColorString(String(feature.properties.color))
      : cableColor;
    entity.polyline.material = color.withAlpha(0.92);
    entity.polyline.width = 2.5;
    entity.polyline.clampToGround = true;
    entity.polyline.classificationType = _classificationType;
    entity.show = true;
  }

  /**
   * Apply the single translucent blend pass to the landing-billboard and
   * reference-point collections. Landing entities carry only billboards and
   * reference entities only points, so completion is one applied collection
   * per source; a failed shape probe disables the optimization permanently
   * for this session and says so loudly in dev builds.
   * Both sources are probed BEFORE either is committed, so the helper's
   * "defaults untouched on shape drift" fallback holds across the pair too —
   * a reference-source failure can never leave the landing source already
   * forced to TRANSLUCENT.
   */
  function applyMarkerBlendOnce() {
    const landing = probeTranslucentMarkerBlend(_landingDataSource);
    const reference = probeTranslucentMarkerBlend(_referenceDataSource);
    if (landing.invariantFailed || reference.invariantFailed) {
      _markerBlendDone = true;
      if (!_markerBlendInvariantWarned && import.meta.env?.DEV === true) {
        _markerBlendInvariantWarned = true;
        console.error(
          '[Data:telegeography-submarine-cables] EntityCluster marker-collection '
          + 'shape changed — single-pass translucent blend skipped; markers fall '
          + 'back to Cesium\'s default two-pass blend.',
        );
      }
      return;
    }
    const landingBlend = commitTranslucentMarkerBlend(landing);
    const referenceBlend = commitTranslucentMarkerBlend(reference);
    if (landingBlend.applied > 0 && referenceBlend.applied > 0) _markerBlendDone = true;
  }

  /**
   * Re-classify every cable ground line for the active surface. One batched
   * ground-primitive rebuild per stack switch — never per frame.
   * @param {Cesium.ClassificationType} next
   */
  function applyCableClassification(next) {
    if (next === undefined || next === _classificationType) return;
    _classificationType = next;
    if (!_cableDataSource) return;
    const entities = _cableDataSource.entities.values;
    for (let i = 0; i < entities.length; i++) {
      const polyline = entities[i].polyline;
      if (polyline) polyline.classificationType = next;
    }
    _viewer?.scene?.requestRender?.();
  }

  function styleLandingEntity(entity, feature) {
    if (!entity?.point) return;
    entity.point.color = landingColor.withAlpha(0.92);
    entity.point.pixelSize = feature?.properties?.is_tbd ? 6 : 7;
    entity.point.outlineColor = cableOutline;
    entity.point.outlineWidth = 1;
    entity.point.disableDepthTestDistance = 0;
    entity.show = true;
  }

  function addReferenceStem({ reference, label, kind, color, feature }) {
    if (!_referenceDataSource || !reference) return;

    const base = Cesium.Cartesian3.fromDegrees(reference.lon, reference.lat, 0);
    const tip = Cesium.Cartesian3.fromDegrees(reference.lon, reference.lat, 2500);
    const info = {
      kind,
      reference,
      label,
      featureId: feature?.id || feature?.properties?.id || null,
    };
    const pointColor = color.withAlpha(kind === 'cable' ? 0.84 : 0.94);
    const stemColor = color.withAlpha(kind === 'cable' ? 0.58 : 0.68);
    // Constant properties on the sweep cadence, never per-frame callbacks:
    // the sweep redefines them through the alternating buffers below.
    const stemPositionBuffers = [[base, tip], [base, tip]];

    const entity = _referenceDataSource.entities.add({
      id: `${kind}-reference-${_referenceRecords.length}-${info.featureId || 'feature'}`,
      position: tip,
      polyline: {
        positions: stemPositionBuffers[0],
        width: kind === 'cable' ? 2 : 2.4,
        material: new Cesium.ColorMaterialProperty(stemColor),
      },
      point: {
        pixelSize: kind === 'cable' ? 7 : 8,
        color: pointColor,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.65),
        outlineWidth: 1,
        disableDepthTestDistance: 0,
      },
    });

    entity.__gevTeleGeography = info;
    _pickByEntity.set(entity, info);
    const record = {
      id: entity.id,
      entity,
      base,
      tip,
      nextTip: Cesium.Cartesian3.clone(tip),
      stemPositionBuffers,
      stemPositionBufferIndex: 0,
      reference,
      kind,
      label: clampLabel(label),
      visible: false,
      distanceM: Infinity,
      entry: null,
    };
    record.entry = createCableOverlayEntry(record);
    _referenceRecords.push(record);
  }

  function updateReferenceVisibility() {
    if (!_enabled || !_viewer?.camera) return;
    const cameraPos = _viewer.camera.positionWC;
    if (!cameraPos) return;

    const canvasHeight = _viewer.scene?.canvas?.clientHeight || 1080;
    const fov = _viewer.camera.frustum?.fov || (Math.PI / 3);
    const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, cameraPos);
    for (const record of _referenceRecords) {
      const visible = occluder.isPointVisible(record.base);
      record.visible = visible;
      record.distanceM = Cesium.Cartesian3.distance(cameraPos, record.base);
      if (record.entity.show !== visible) {
        record.entity.show = visible;
      }
      // Hidden stems keep their last geometry; this same sweep refreshes them
      // in the pass where they turn visible again.
      if (visible) updateCableReferenceStem(record, cameraPos, canvasHeight, fov);
    }
    for (const record of _surfaceRecords) {
      const visible = occluder.isPointVisible(record.base);
      if (record.entity.show !== visible) {
        record.entity.show = visible;
      }
    }
    const winners = selectCableReferenceLabelWinners(_referenceRecords);
    let changed = winners.length !== _lastPublishedCount;
    for (let i = 0; i < winners.length; i++) {
      const record = winners[i];
      const priority = cableReferencePriority(record.distanceM);
      record.entry.priority = priority;
      _publishScratch[i] = record.entry;
      if (!changed
        && (_lastPublishedIds[i] !== record.entry.id
          || _lastPublishedPriorities[i] !== priority)) {
        changed = true;
      }
    }
    _publishScratch.length = winners.length;
    _referenceLabelCount = winners.length;
    // The marker collections are created lazily by the visualizers, so the
    // single-pass blend is applied on the sweep cadence until both landed.
    if (!_markerBlendDone) applyMarkerBlendOnce();
    if (!changed) return;
    _overlayPublisher.publish(_publishScratch);
    _lastPublishedCount = winners.length;
    for (let i = 0; i < winners.length; i++) {
      _lastPublishedIds[i] = _publishScratch[i].id;
      _lastPublishedPriorities[i] = _publishScratch[i].priority;
    }
    _lastPublishedIds.length = winners.length;
    _lastPublishedPriorities.length = winners.length;
  }

  function beginInteraction(viewer) {
    if (_clickHandler) return;
    _clickHandler = screenSpaceEventHandlerFactory(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!_enabled) return;
      const picked = viewer.scene.pick(click.position);
      const record = resolvePickRecord(picked);
      if (!record?.reference) return;
      flyToReference(viewer, record.reference);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function resolvePickRecord(picked) {
    if (!picked) return null;
    const primitive = picked.primitive;
    if (primitive) {
      const primitiveInfo = _pickByEntity.get(primitive);
      if (primitiveInfo) return primitiveInfo;
      if (primitive.__gevTeleGeography) return primitive.__gevTeleGeography;
      if (primitive.id && typeof primitive.id === 'object' && primitive.id.reference) {
        return primitive.id;
      }
    }

    const entity = picked.id;
    if (entity) {
      const entityInfo = _pickByEntity.get(entity);
      if (entityInfo) return entityInfo;
      if (entity.__gevTeleGeography) return entity.__gevTeleGeography;
      if (entity.id && typeof entity.id === 'object' && entity.id.reference) {
        return entity.id;
      }
    }

    return null;
  }

  function flyToReference(viewer, reference) {
    if (!viewer || !reference) return;
    const destination = Cesium.Cartesian3.fromDegrees(reference.lon, reference.lat, 6500);
    viewer.camera.cancelFlight();
    viewer.camera.flyTo({
      destination,
      orientation: {
        heading: viewer.camera.heading || 0,
        pitch: Cesium.Math.toRadians(-52),
        roll: 0,
      },
      duration: 1.35,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }

  function featureReference(feature) {
    const geometry = feature?.geometry;
    if (!geometry) return null;

    const props = feature?.properties || {};
    const propertyCoords = coordsFromProperty(props.coordinates);
    if (propertyCoords) {
      return {
        lon: propertyCoords[0],
        lat: propertyCoords[1],
      };
    }

    if (geometry.type === 'Point') {
      const coords = coordsFromPoint(geometry.coordinates);
      if (!coords) return null;
      return { lon: coords[0], lat: coords[1] };
    }

    const coords = [];
    collectLonLat(geometry.coordinates, coords);
    if (!coords.length) return null;

    let lonSum = 0;
    let latSum = 0;
    for (const [lon, lat] of coords) {
      lonSum += lon;
      latSum += lat;
    }
    return {
      lon: lonSum / coords.length,
      lat: latSum / coords.length,
    };
  }

  function coordsFromProperty(value) {
    if (!Array.isArray(value) || value.length < 2) return null;
    const lon = Number(value[0]);
    const lat = Number(value[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return [lon, lat];
  }

  function coordsFromPoint(value) {
    if (!Array.isArray(value) || value.length < 2) return null;
    const lon = Number(value[0]);
    const lat = Number(value[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return [lon, lat];
  }

  function collectLonLat(value, out) {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      const lon = Number(value[0]);
      const lat = Number(value[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        out.push([lon, lat]);
      }
      return;
    }
    for (const child of value) collectLonLat(child, out);
  }

  function featureLabel(feature) {
    const props = feature?.properties || {};
    return String(props.name || props.id || feature?.id || '').trim();
  }

  function normalizeFeatures(json, kind) {
    const features = Array.isArray(json?.features) ? json.features : [];
    return features.map((feature, index) => {
      const id = feature?.properties?.id || feature?.id || `${kind}-${index}`;
      return {
        ...feature,
        id: String(id),
      };
    });
  }

  async function fetchJson(url, signal) {
    const response = await fetch(url, { signal, cache: 'force-cache' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.json();
  }

  return {
    id: 'telegeography-submarine-cables',
    name: 'Submarine Cables',
    icon: '≋',
    source: 'TeleGeography',
    updateInterval: 0,
    statsRefreshInterval: 500,

    init(viewer) {
      _viewer = viewer;
      _classificationType = cableClassificationTypeForScene(viewer?.scene);
      if (!_mapStackListener && mapStackEventTarget?.addEventListener) {
        _mapStackListener = (event) => {
          applyCableClassification(event?.detail?.activeId
            ? cableClassificationTypeForStack(event.detail.activeId)
            : cableClassificationTypeForScene(_viewer?.scene));
        };
        mapStackEventTarget.addEventListener('gev:map-stack-changed', _mapStackListener);
      }
      beginInteraction(viewer);
      if (!_preRenderRemover) {
        _preRenderRemover = viewer.scene.preRender.addEventListener(() => {
          // The camera is handed to the gate so tracked/orbit cameras — which
          // never emit moveEnd — reach the motion fallback. No render is
          // requested for a fallback sweep: it only fires while the camera is
          // already moving, so frames are flowing by construction.
          if (!_enabled || !_loaded
            || !_referenceSweepGate.shouldRun(viewer.camera)) return;
          updateReferenceVisibility();
        });
      }
      if (!_moveEndRemover) {
        _moveEndRemover = viewer.camera.moveEnd.addEventListener(() => {
          if (!_enabled) return;
          _referenceSweepGate.markDirty();
          viewer.scene.requestRender?.();
        });
      }
    },

    enable(viewer) {
      _enabled = true;
      updateVisibility();
      _overlayPublisher.show();
      // A hide() cleared the host source, so an identical cohort must still
      // republish on the next sweep.
      resetPublishSignature();
      _referenceSweepGate.markDirty();
      // The gate is dirty-only; ask for the frame its sweep needs in case the
      // camera is parked and nothing else is rendering.
      (viewer || _viewer)?.scene?.requestRender?.();
      void load(viewer || _viewer);
    },

    disable() {
      _enabled = false;
      updateVisibility();
      _overlayPublisher.hide();
      resetPublishSignature();
      if (_loading && _abort) {
        _abort.abort();
        _loading = false;
        _loadingLabel = '';
      }
    },

    update(viewer) {
      return load(viewer || _viewer);
    },

    destroy(viewer) {
      if (_abort) _abort.abort();
      if (_cableDataSource && viewer) viewer.dataSources.remove(_cableDataSource, true);
      if (_landingDataSource && viewer) viewer.dataSources.remove(_landingDataSource, true);
      if (_referenceDataSource && viewer) viewer.dataSources.remove(_referenceDataSource, true);
      // hide() clears every published host entry and goes invisible while
      // keeping the publisher reusable — the legacy layer supported re-init
      // after destroy, and hidden publishers already drop late publishes.
      // Pinned by the direct-destroy host test: removing this line leaves a
      // visible overlay source with orphan labels.
      _overlayPublisher.hide();
      if (_clickHandler) {
        _clickHandler.destroy();
        _clickHandler = null;
      }
      if (_preRenderRemover) {
        _preRenderRemover();
        _preRenderRemover = null;
      }
      if (_moveEndRemover) {
        _moveEndRemover();
        _moveEndRemover = null;
      }
      if (_mapStackListener && mapStackEventTarget?.removeEventListener) {
        mapStackEventTarget.removeEventListener('gev:map-stack-changed', _mapStackListener);
        _mapStackListener = null;
      }
      _viewer = null;
      _enabled = false;
      _loading = false;
      _loaded = false;
      _count = 0;
      _error = null;
      _lastUpdate = null;
      _loadingLabel = '';
      _cableDataSource = null;
      _landingDataSource = null;
      _referenceDataSource = null;
      _referenceRecords = [];
      _surfaceRecords = [];
      _pickByEntity = new WeakMap();
      _referenceLabelCount = 0;
      _publishScratch.length = 0;
      _markerBlendDone = false;
      _markerBlendInvariantWarned = false;
      resetPublishSignature();
      _referenceSweepGate.reset();
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        loading: _loading,
        loadingLabel: _loadingLabel,
        error: _error,
        referenceLabelCount: _referenceLabelCount,
      };
    },
  };
}

function clampLabel(value, maxLength = 34) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 3))}...`;
}
