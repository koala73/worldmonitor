import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  registerSpriteCollection,
  restoreSpriteOrder,
  restoreSpriteOrderOnEnable,
} from './spriteOrder.js';
import {
  clearSelectedEntityContextForLayer,
  getContextStore,
  registerEntityContext,
  selectEntityContext,
} from './contextStore.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from './pickRegistry.js';
import { adaptFirmsRecords } from './firmsAdapt.js';
import { fireAnchorHeight, warmFireAnchorFloors } from './fireAnchors.js';
import { horizonOccluder } from './iconOrientation.js';
import {
  accentForSeverity,
  fireDetectionKey,
  FIRMS_AMBIENT_COHORT_LIMIT,
  FIRMS_OVERLAY_SOURCE_ID,
  satelliteShortName,
} from './firmsLabels.js';
import {
  clearOverlaySource,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { requestWorldFocus } from '../worldFocus.js';

/** Same-origin live-fires proxy (vite.config.js firmsProxy — key stays server-side). */
const FIRMS_API_URL = '/api/gev/firms';
/** Client poll interval; the proxy's 30 min TTL is what guards upstream quota. */
const REFRESH_INTERVAL_MS = 600_000;

/**
 * LOD bands keyed by camera height. `cells` bands render aggregated
 * ground-clamped heat rectangles; `detections` bands (< ~750km plus the
 * local band) render individual fire detections as glow-sprite billboards.
 * Labels in every band go through the shared screen-space greedy declutter
 * (hard cap MAX_AMBIENT_LABELS) — there are no per-band label knobs.
 */
const LOD_LEVELS = [
  { id: 'global', minHeight: 9000000, mode: 'cells', gridDegrees: 2.0, maxCells: 1800, labelDistance: 12000000 },
  { id: 'regional', minHeight: 3000000, mode: 'cells', gridDegrees: 1.0, maxCells: 3600, labelDistance: 8500000 },
  { id: 'local', minHeight: 750000, mode: 'detections', maxDetections: 2500, labelDistance: 4500000 },
  { id: 'close', minHeight: 0, mode: 'detections', maxDetections: 3000, labelDistance: 1800000 },
];
const LOD_CHECK_MS = 650;
/** +/-10% hysteresis on LOD band edges so slow zooms don't thrash rebuilds. */
const LOD_HYSTERESIS = 0.1;
/** Padding fraction applied to the camera view rectangle before clipping. */
const VIEW_PADDING = 0.3;
/** Number of top-FRP detections registered in the shared context store. */
const CONTEXT_TOP_N = 50;
/** Hard cap on ambient (non-selected) labels, regardless of zoom/density. */
const MAX_AMBIENT_LABELS = FIRMS_AMBIENT_COHORT_LIMIT;
/** Min screen-space separation between accepted labels, in CSS pixels. */
const LABEL_MIN_SEP_PX = 150;
/** Candidates projecting outside the canvas by more than this are skipped. */
const LABEL_VIEW_MARGIN_PX = 16;
/**
 * Anchors below this height get a separate LIFTED point for occlusion tests
 * (never for rendering). Mirrors the flights layer's `cullPosition` idiom
 * (`renderAltitudeM < 10` → test at 12 m): `fireAnchorHeight` is ground floor
 * + lift, and in negative-geoid coastal regions that lands a few tens of
 * metres BELOW the WGS84 ellipsoid — EllipsoidalOccluder then judges such a
 * point "beyond the horizon" while its true-surface neighbours stay visible,
 * so near-limb fires would blink out for a datum reason.
 */
const CULL_LIFT_THRESHOLD_M = 10;
/** Height of the lifted occlusion-test point (flights uses the same 12 m). */
const CULL_LIFT_M = 12;

/** Color stops shared by cell heat fills and detection glow sprites. */
const DETECTION_COLOR_STOPS = [
  { name: 'red', color: Cesium.Color.RED },
  { name: 'orange', color: Cesium.Color.ORANGE },
  { name: 'yellow', color: Cesium.Color.YELLOW },
];

/** Pre-baked radial-glow sprites keyed by `<colorStop>:<sizeBucket>`. */
const glowSpriteCache = new Map();

const scratchViewRect = new Cesium.Rectangle();
const scratchCenterA = new Cesium.Cartographic();
const scratchCenterB = new Cesium.Cartographic();
const scratchWindowCoord = new Cesium.Cartesian2();

/**
 * Map one internal fire record (firmsAdapt.js shape) to a plain JSON-safe
 * analyst record (analyst query engine seam). Pure — no Cesium types.
 * Missing/unknown fields are null, never NaN/undefined. The id reuses the
 * layer's FIRE-##### pick-id convention (index keys pick ids and
 * context-store ids, so the two stay consistent).
 * @param {Object|null|undefined} fire - Internal fire record.
 * @returns {{id: string, lat: number|null, lon: number|null, frp: number|null,
 *   confidence: number|null, satellite: string|null, acqTime: number|null}}
 */
export function mapAnalystRecord(fire) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  return {
    id: `FIRE-${String(fire?.index ?? 0).padStart(5, '0')}`,
    lat: num(fire?.lat),
    lon: num(fire?.lon),
    frp: num(fire?.frp),
    confidence: num(fire?.confidence), // normalized 0..1 (firmsAdapt.normalizeConfidence)
    satellite: text(fire?.satellite) || text(fire?.sensor),
    acqTime: Number.isFinite(fire?.acqMs) && fire.acqMs > 0 ? fire.acqMs : null, // epoch ms; 0 = unparseable → null
  };
}

export function createFirmsHeatmapLayer({
  id,
  name,
  icon = '▲',
  source = 'NASA FIRMS',
  overlayHost = {
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
    clearSource: clearOverlaySource,
    hitTest: hitTestWorldOverlay,
  },
  screenSpaceEventHandlerFactory = (viewer) => (
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
  ),
}) {
  let _viewer = null;
  let _dataSource = null;
  let _billboards = null;
  let _enabled = false;
  let _destroyed = false;
  let _loading = false;
  /** True when the proxy answered 503 {error:'no_key'} — FIRMS_MAP_KEY unset. */
  let _keyRequired = false;
  /** True when the proxy served a cached payload past TTL (upstream failing). */
  let _stale = false;
  /** Surfaced error string when the live fetch failed outright. */
  let _error = null;
  let _fires = [];
  let _firesByFrp = [];
  let _count = 0;
  let _cellCount = 0;
  let _lastUpdate = null;
  let _currentLodId = null;
  let _currentLodIndex = -1;
  let _lastViewRect = null;
  let _preRenderRemover = null;
  let _moveEndSettleRemover = null;
  let _lastLodCheck = 0;
  let _contextIds = new Set();
  let _clickHandler = null;
  let _moveEndRemover = null;
  let _selectedFire = null;
  /** Priority-ordered label candidates from the last rebuild (detections or cells). */
  let _labelCandidates = [];
  let _labelLodDistance = 0;
  /** pick id string -> fire record, for the currently rendered sprites. */
  const _pickIndexById = new Map();
  /** Actionable card id -> current detection record painted for that id. */
  const _fireByCardId = new Map();
  /**
   * Occlusion-test anchors index-aligned with the billboard collection (the
   * collection is cleared and refilled in one ordered pass per rebuild, and
   * nothing else adds to it). Lifted where the render anchor sits at/below
   * the ellipsoid — see {@link fireCullPosition}.
   * @type {Array<Cesium.Cartesian3>}
   */
  const _cullPositions = [];
  /**
   * gridDegrees -> heat-sorted full cell list. The full-grid aggregation is
   * viewport-independent but walks every detection (~200k live), so it is
   * computed once per grid size per data refresh; renders only clip + cap
   * (field-test round 1: intermediate-zoom chug during LOD rebuilds).
   * @type {Map<number, Array<Object>>}
   */
  const _cellCacheByGrid = new Map();
  /** Camera idle snapshot so the throttled LOD check is ~free when parked. */
  let _camSnapValid = false;
  const _camPos = new Cesium.Cartesian3();
  const _camDir = new Cesium.Cartesian3();

  return {
    id,
    name,
    icon,
    source,
    // Live layer: the manager calls update() every 10 minutes while enabled,
    // which refetches through the /api/firms proxy (the proxy's 30 min TTL —
    // not this interval — is what protects the upstream FIRMS quota).
    updateInterval: REFRESH_INTERVAL_MS,

    init(viewer) {
      if (_destroyed) return;
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(id);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    async enable(viewer) {
      if (_destroyed) return;
      _enabled = true;
      _viewer = viewer;
      if (!_dataSource) this.init(viewer);
      if (_dataSource) _dataSource.show = true;
      if (_billboards) {
        // The camera can have moved anywhere while the layer was off: moveEnd
        // was not being listened to, and the preRender watcher is inert while
        // disabled AND while the (untimed) refetch below is in flight. So the
        // retained per-sprite show flags describe the OLD viewpoint. Re-cull
        // BEFORE the collection becomes visible — otherwise re-enabling at a
        // new location flashes far-side fires through the planet (and keeps
        // near-side ones hidden) until the fetch resolves.
        refreshHorizonCulling();
        _billboards.show = true;
      }
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, true);
      installLodWatcher();
      installMoveEndWatcher();
      installClickHandler();
      registerPickOwner(id, (pickedId) => _pickIndexById.has(pickedId));
      if (!_fires.length && !_loading) await loadHeatmap();
      restoreSpriteOrderOnEnable('firms', viewer);
    },

    disable() {
      _enabled = false;
      clearFireSelection();
      if (_dataSource) _dataSource.show = false;
      if (_billboards) _billboards.show = false;
      overlayHost.clearSource(FIRMS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, false);
      clearSelectedEntityContextForLayer(id);
      removeClickHandler();
      removeMoveEndWatcher();
      unregisterPickOwner(id);
      removeLodWatcher();
    },

    async update() {
      if (_destroyed || !_enabled || _loading) return;
      // Scheduled 10-minute poll (and the manager's immediate first update):
      // refetch live fires through the proxy and re-render. Viewport-driven
      // re-renders between polls are handled by the LOD watcher.
      await loadHeatmap();
    },

    destroy(viewer) {
      if (_destroyed) return;
      _destroyed = true;
      _enabled = false;
      removeLodWatcher();
      removeMoveEndWatcher();
      removeClickHandler();
      unregisterPickOwner(id);
      if (_dataSource && viewer) {
        viewer.dataSources.remove(_dataSource, true);
      }
      _dataSource = null;
      removeDetectionCollections(viewer);
      clearContextRegistrations();
      clearSelectedEntityContextForLayer(id);
      _fires = [];
      _firesByFrp = [];
      _cellCacheByGrid.clear();
      _count = 0;
      _cellCount = 0;
      _lastUpdate = null;
      _keyRequired = false;
      _stale = false;
      _error = null;
      _currentLodId = null;
      overlayHost.clearSource(FIRMS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, false);
      _currentLodIndex = -1;
      _lastViewRect = null;
      _selectedFire = null;
      _labelCandidates = [];
      _labelLodDistance = 0;
      _pickIndexById.clear();
      _fireByCardId.clear();
      _cullPositions.length = 0;
      _camSnapValid = false;
    },

    /**
     * Layer stats for the data panel. Degraded feed states surface through
     * `error` (established qa-failstate pattern: a dead feed must never look
     * like a healthy empty layer) with a matching human `loadingLabel`:
     * 'LIVE · updated Xm ago' fresh, 'STALE · cached Xh' when the proxy
     * served past-TTL cache, 'KEY REQUIRED' keyless.
     */
    getStats() {
      const now = Date.now();
      const staleText = _lastUpdate ? `STALE · cached ${formatAge(now - _lastUpdate) || '<1h'}` : 'STALE';
      let loadingLabel = '';
      if (_loading) {
        loadingLabel = _fires.length ? 'refreshing...' : 'loading...';
      } else if (_keyRequired) {
        loadingLabel = 'KEY REQUIRED';
      } else if (_stale) {
        loadingLabel = staleText;
      } else if (_error) {
        loadingLabel = _error;
      } else if (_lastUpdate) {
        loadingLabel = `LIVE · updated ${formatAgoMinutes(now - _lastUpdate)}`;
      }
      return {
        count: _count,
        cells: _cellCount,
        lastUpdate: _lastUpdate,
        loading: _loading,
        stale: _stale,
        keyRequired: _keyRequired,
        error: _keyRequired ? 'KEY REQUIRED' : (_stale ? staleText : _error),
        loadingLabel,
      };
    },

    /**
     * Strongest currently-loaded detection (by FRP) for voice targeting
     * ("take me to the biggest fire").
     * @returns {{latitude: number, longitude: number, frp: number, label: string}|null}
     */
    getStrongestFire() {
      const strongest = _firesByFrp.length ? _firesByFrp[0] : null;
      if (!strongest) return null;
      return {
        latitude: strongest.lat,
        longitude: strongest.lon,
        frp: strongest.frp,
        label: `Fire · FRP ${formatFrp(strongest.frp)} MW`,
      };
    },

    /**
     * Detection-overlay seam, shaped like the other layers' detectable
     * objects (traffic/flights). NOT yet registered in initDetection's layer
     * list — wiring fires through the detection/label-arbiter pipeline is a
     * deliberate post-PR#1 task; when that happens the arbiter replaces this
     * layer's greedy declutter as the SELECTOR and the shared overlay remains
     * the renderer. Walks the FRP-sorted index so the strongest fires come first.
     * @param {{maxCount?: number}} [options]
     * @returns {Array<{position: Cesium.Cartesian3, id: string, type: string}>}
     */
    getDetectableObjects(options = {}) {
      if (!_enabled || !_firesByFrp.length) return [];
      const maxCount = Number.isFinite(options.maxCount)
        ? Math.max(1, Math.floor(options.maxCount))
        : 250;
      const result = [];
      for (const fire of _firesByFrp) {
        result.push({
          position: firePosition(fire),
          id: `FIRE-${String(fire.index).padStart(5, '0')}`,
          type: 'FIRE',
        });
        if (result.length >= maxCount) break;
      }
      return result;
    },

    /**
     * Snapshot the layer's in-memory fire records as plain JSON-safe
     * objects for the analyst query engine. Walks the FRP-sorted index so
     * truncation keeps the STRONGEST fires (200k+ detections can be live —
     * the cap is load-bearing, not cosmetic). On-demand only (called at
     * most once per spoken query) — zero per-frame cost, no listeners, no
     * caching. Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_firesByFrp.length) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
      const result = [];
      for (const fire of _firesByFrp) {
        result.push(mapAnalystRecord(fire));
        if (result.length >= limit) break;
      }
      return result;
    },

    /** Test seam that binds the production click path and indexes. */
    _bindInteractionForTest(viewer, fires = []) {
      _viewer = viewer;
      _enabled = true;
      _fires = fires;
      _firesByFrp = [...fires];
      _pickIndexById.clear();
      _labelLodDistance = 1e7;
      _labelCandidates = fires.map((fire) => {
        _pickIndexById.set(`firms-${fire.index}`, fire);
        return { fire, position: firePosition(fire) };
      });
      rebuildAmbientLabels();
      installClickHandler();
      return _clickHandler;
    },
  };

  /**
   * Fetch live fires from the /api/firms proxy and swap them in. Handles the
   * three degraded states distinctly: keyless (503 {error:'no_key'} → KEY
   * REQUIRED, no retry storm — the 10 min poll re-checks cheaply without
   * touching upstream), stale (proxy served past-TTL cache → surfaced via
   * getStats), and outright failure (existing fires are KEPT — old data
   * beats a wiped map). A click-selected fire survives the swap when the
   * same detection (lat/lon/acqMs) is still present.
   */
  async function loadHeatmap() {
    if (!_dataSource) return;
    _loading = true;

    try {
      const response = await fetch(FIRMS_API_URL, { cache: 'no-store' });
      if (!response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch { /* non-JSON error body — fall through to the generic error */ }
        if (response.status === 503 && payload?.error === 'no_key') {
          _keyRequired = true;
          _error = null;
          _stale = false;
          return;
        }
        throw new Error(`FIRMS HTTP ${response.status}`);
      }

      const payload = await response.json();
      _keyRequired = false;
      _error = null;
      _stale = Boolean(payload?.stale);
      const previousSelection = _selectedFire;
      _selectedFire = null;
      _fires = adaptFirmsRecords(payload?.fires);
      _cellCacheByGrid.clear(); // aggregation is per-dataset — new fires, new cells
      _firesByFrp = [..._fires].sort((a, b) => b.frp - a.frp);
      _count = _fires.length;
      // Data age, not response age: a stale proxy payload truthfully reads old.
      _lastUpdate = Number.isFinite(payload?.fetchedAt) ? payload.fetchedAt : Date.now();
      // Settle the previous selection BEFORE the LOD rebuild. renderCurrentLod
      // runs refreshContextRegistrations(), which deletes every context record
      // not in the new top-N — including the one the store still points at.
      // Clearing after that deletion fails the ownership guard inside
      // clearSelectedEntityContextForLayer and emits nothing at all, so an
      // eviction-aware readout never hears that its subject is gone.
      const reselected = findMatchingFire(previousSelection);
      if (!reselected && previousSelection) {
        // The selected detection is not in the new payload: it left the feed
        // rather than being deselected. Eviction-aware readouts hold their
        // last-known values for this instead of tearing down.
        clearSelectedEntityContextForLayer(id, { evicted: true });
      }
      renderCurrentLod(true);
      if (reselected) selectFire(reselected);
    } catch (error) {
      console.warn(`[Data:${id}] FIRMS live load failed:`, error);
      _error = 'live feed unavailable';
    } finally {
      _loading = false;
    }
  }

  /**
   * Find the record in the freshly-loaded set matching a previous selection.
   * Identity is the detection itself (lat/lon/acquisition time) — indices
   * are regenerated every fetch, so object/index identity cannot be used.
   * @param {?Object} previous - Previously selected fire record.
   * @returns {?Object} Matching new record.
   */
  function findMatchingFire(previous) {
    if (!previous) return null;
    const key = fireDetectionKey(previous);
    return _fires.find((fire) => fireDetectionKey(fire) === key) || null;
  }

  /**
   * Rebuild the render for the current LOD band and viewport. Skips work
   * when neither the (hysteresis-damped) LOD band nor the padded view
   * rectangle changed meaningfully.
   * @param {boolean} force - Rebuild even if LOD/view appear unchanged.
   * @returns {boolean} True when a rebuild actually ran. Callers use this to
   *   avoid a second horizon walk in the same tick: a rebuild already culls
   *   its freshly-added sprites, an early-out does not.
   */
  function renderCurrentLod(force = false) {
    if (!_dataSource || !_fires.length || !_viewer) return false;
    const lodIndex = selectLodIndex(cameraHeight());
    const lod = LOD_LEVELS[lodIndex];
    const viewRect = computeViewRect();
    if (!force && lodIndex === _currentLodIndex && !viewChangedEnough(viewRect)) return false;
    _currentLodIndex = lodIndex;
    _currentLodId = lod.id;
    _lastViewRect = viewRect ? Cesium.Rectangle.clone(viewRect) : null;
    const bounds = viewRect ? paddedDegreeBounds(viewRect) : null;

    if (lod.mode === 'detections') {
      renderDetections(lod, bounds);
    } else {
      renderCells(aggregateFires(lod, bounds), lod, bounds);
    }
    return true;
  }

  /**
   * Bin all detections into grid cells, then viewport-clip BEFORE the
   * top-N cap so fires in view never lose their slot to higher-scoring
   * cells on other continents. `bounds === null` (sky/horizon or
   * near-global view) falls back to the global top-N behavior.
   * @param {Object} lod - Active LOD descriptor.
   * @param {?Object} bounds - Padded view bounds in degrees, or null.
   * @returns {Array<Object>} Cells sorted by heat score, capped.
   */
  function aggregateFires(lod, bounds) {
    const gridDegrees = lod.gridDegrees;

    let sorted = _cellCacheByGrid.get(gridDegrees);
    if (!sorted) {
      const cells = new Map();
      for (const fire of _fires) {
        const latCell = Math.floor(fire.lat / gridDegrees) * gridDegrees;
        const lonCell = Math.floor(fire.lon / gridDegrees) * gridDegrees;
        const key = `${latCell.toFixed(3)}:${lonCell.toFixed(3)}`;
        // confidence is normalized 0..1 — weight ×4 preserves the old 0..100×0.04 scale.
        const intensity = Math.max(1, fire.frp * 0.18 + fire.confidence * 4 + fire.brightness * 0.01);
        const existing = cells.get(key) || {
          latCell,
          lonCell,
          count: 0,
          intensity: 0,
          maxFrp: 0,
          night: 0,
          newestAcqMs: 0,
        };
        existing.count += 1;
        existing.intensity += intensity;
        existing.maxFrp = Math.max(existing.maxFrp, fire.frp);
        existing.newestAcqMs = Math.max(existing.newestAcqMs, fire.acqMs);
        if (fire.night) existing.night += 1;
        cells.set(key, existing);
      }
      // Heat-sorted once; per-render clipping below preserves the order.
      sorted = [...cells.values()].sort((a, b) => heatScore(b) - heatScore(a));
      _cellCacheByGrid.set(gridDegrees, sorted);
    }

    if (!bounds) return sorted.slice(0, lod.maxCells);
    const clipped = [];
    for (const cell of sorted) {
      if (!cellIntersectsBounds(cell, gridDegrees, bounds)) continue;
      clipped.push(cell);
      if (clipped.length >= lod.maxCells) break;
    }
    return clipped;
  }

  /**
   * Render aggregated heat cells (global/regional bands) as ground-clamped
   * rectangles. Cell labels do NOT live on the entities anymore — they go
   * through the same unclamped, screen-space-decluttered label pipeline as
   * detections (see {@link rebuildAmbientLabels}).
   * @param {Array<Object>} cells - Aggregated cells, heat-sorted descending.
   * @param {Object} lod - Active LOD descriptor.
   * @param {?Object} bounds - Padded view bounds in degrees, or null.
   */
  function renderCells(cells, lod, bounds) {
    ensureDetectionCollections();
    _dataSource.entities.removeAll();
    if (_billboards) _billboards.removeAll();
    _pickIndexById.clear();
    _cullPositions.length = 0;
    _cellCount = cells.length;
    const maxScore = Math.max(1, ...cells.map(heatScore));

    _labelCandidates = [];
    _labelLodDistance = lod.labelDistance;

    for (const cell of cells) {
      const score = heatScore(cell);
      const normalized = Math.min(1, Math.sqrt(score / maxScore));
      const alpha = 0.16 + normalized * 0.5;
      const color = heatColor(normalized, alpha);
      const centerLon = cell.lonCell + lod.gridDegrees / 2;
      const centerLat = cell.latCell + lod.gridDegrees / 2;
      const position = Cesium.Cartesian3.fromDegrees(centerLon, centerLat, 0);

      _dataSource.entities.add({
        rectangle: {
          coordinates: Cesium.Rectangle.fromDegrees(
            cell.lonCell,
            cell.latCell,
            cell.lonCell + lod.gridDegrees,
            cell.latCell + lod.gridDegrees
          ),
          material: new Cesium.ColorMaterialProperty(color),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        position,
        properties: {
          count: cell.count,
          intensity: score,
          maxFrp: cell.maxFrp,
          night: cell.night,
        },
      });

      // Cells arrive heat-sorted, so candidate order doubles as label priority.
      // Accent is resolved here because `normalized` only exists in this walk.
      _labelCandidates.push({
        position,
        cullPosition: cellCullPosition(centerLon, centerLat),
        fire: null,
        cell,
        accent: cellAccent(normalized),
      });
    }

    rebuildAmbientLabels();
    refreshContextRegistrations(topFiresWithinBounds(bounds));
  }

  /**
   * Render individual detections (local/close bands) as pre-baked
   * radial-glow sprite billboards sized by FRP, capped per viewport by
   * highest FRP, depth test disabled. The 3D Tiles mesh is never sampled
   * per point; instead, the CLOSE band (where terrain parallax is actually
   * visible) batch-warms the shared cached DEM floor for its rendered
   * subset and re-renders once floors land, so anchors sit on the terrain
   * (firePosition). The local band keeps cold anchors at height 0 — at
   * ≥750 km camera height the divergence is invisible and warming a
   * continent-wide viewport would waste the DEM proxy.
   * Labels are not built here; candidates feed {@link rebuildAmbientLabels}.
   * @param {Object} lod - Active LOD descriptor.
   * @param {?Object} bounds - Padded view bounds in degrees, or null.
   */
  function renderDetections(lod, bounds) {
    ensureDetectionCollections();
    _dataSource.entities.removeAll();
    if (!_billboards) return;
    _billboards.removeAll();
    _pickIndexById.clear();
    _cullPositions.length = 0;

    let candidates;
    if (bounds) {
      // Walk the pre-sorted FRP index and early-exit at the cap — the old
      // collect-then-sort touched and sorted every in-view detection per
      // rebuild (tens of thousands mid-zoom; field-test round 1 chug).
      candidates = [];
      for (const fire of _firesByFrp) {
        if (!boundsContainPoint(bounds, fire.lat, fire.lon)) continue;
        candidates.push(fire);
        if (candidates.length >= lod.maxDetections) break;
      }
    } else {
      // Sky/horizon view: fall back to the globally strongest detections.
      candidates = _firesByFrp.slice(0, lod.maxDetections);
    }

    _cellCount = candidates.length;
    _labelCandidates = [];
    _labelLodDistance = lod.labelDistance;

    for (const fire of candidates) {
      const coreSize = frpPixelSize(fire.frp);
      const position = firePosition(fire);
      const cullPosition = fireCullPosition(fire);
      const pickId = `firms-${fire.index}`;
      _pickIndexById.set(pickId, fire);
      _cullPositions.push(cullPosition);
      _billboards.add({
        id: pickId,
        position,
        image: glowSprite(detectionColorStop(fire), sizeBucket(coreSize)),
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      // FRP-sorted walk: candidate order doubles as label priority.
      _labelCandidates.push({ position, cullPosition, fire, cell: null });
    }

    // Freshly-added sprites default to show=true; cull the far side now so a
    // rebuild never flashes through-the-planet detections while the camera
    // sits still (the moveEnd/preRender hooks only fire on camera motion).
    refreshHorizonCulling();
    rebuildAmbientLabels();
    refreshContextRegistrations(candidates.slice(0, CONTEXT_TOP_N));

    if (lod.id === 'close') {
      // Batched (chunked ≤200, sequential, session-cached) DEM warm for the
      // rendered subset; fires are static so each coarse cell resolves once
      // ever. Re-render ONLY when a floor actually landed — a failed resolve
      // reports false, so this chain terminates instead of looping against a
      // down proxy (the next camera-driven rebuild retries).
      warmFireAnchorFloors(candidates).then((warmed) => {
        if (!warmed || !_enabled || !_viewer) return;
        const currentLod = LOD_LEVELS[_currentLodIndex];
        if (!currentLod || currentLod.mode !== 'detections') return;
        renderCurrentLod(true);
      });
    }
  }

  /**
   * Rebuild the card entries for the shared world-overlay host: the
   * selected-fire detail card (if any) plus at most MAX_AMBIENT_LABELS
   * ambient cards picked by a greedy screen-space declutter — walk the
   * priority-ranked candidates, project each with
   * SceneTransforms.worldToWindowCoordinates, and accept only candidates
   * ≥ LABEL_MIN_SEP_PX from every already-accepted card. Candidates whose
   * projection fails are dropped silently. SELECTION runs here, on LOD/
   * viewport rebuilds and camera moveEnd — never per frame; RENDERING is
   * the host, which re-projects the accepted entries every frame so
   * cards track the camera smoothly.
   */
  function rebuildAmbientLabels() {
    if (!_viewer) return;
    const scene = _viewer.scene;
    const now = Date.now();
    const entries = [];
    /** @type {Array<{x: number, y: number}>} Screen positions of accepted labels. */
    const accepted = [];
    // worldToWindowCoordinates happily projects points on the FAR side of the
    // planet, so without this the ≤18 ambient slots get spent on fires the
    // overlay host will then horizon-cull at paint time (`horizonCull: true`
    // in applyFirmsOverlayPolicy) — near-side fires silently lose their cards.
    // Shared with the sprite pass (fireHorizonOccluder) so cards and sprites
    // never disagree about which hemisphere a detection is on.
    const occluder = fireHorizonOccluder();
    const beyondHorizon = (position) => (
      occluder ? occluder.isPointVisible(position) !== true : false
    );
    _fireByCardId.clear();

    if (_selectedFire) {
      const selectedCard = buildSelectedFireCard(_selectedFire, now);
      _fireByCardId.set(selectedCard.id, _selectedFire);
      entries.push(selectedCard);
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        firePosition(_selectedFire),
        scratchWindowCoord
      );
      // Seed the accepted list so ambient cards keep clear of the detail card.
      // A selected fire behind the limb is not painted, so it must not reserve
      // screen space either.
      if (screen && !beyondHorizon(fireCullPosition(_selectedFire))) {
        accepted.push({ x: screen.x, y: screen.y });
      }
    }

    const width = scene.canvas.clientWidth;
    const height = scene.canvas.clientHeight;
    let ambientCount = 0;

    for (const candidate of _labelCandidates) {
      if (ambientCount >= MAX_AMBIENT_LABELS) break;
      if (candidate.fire && candidate.fire === _selectedFire) continue;
      // Spend the bounded cohort only on the visible hemisphere. At global
      // LOD, far-side cells can still project on-canvas; accepting those first
      // starves front-side cards before the host applies its authoritative cull.
      if (beyondHorizon(candidate.cullPosition || candidate.position)) continue;
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        candidate.position,
        scratchWindowCoord
      );
      if (!screen) continue; // projection failed (e.g. behind camera) — drop silently
      if (screen.x < -LABEL_VIEW_MARGIN_PX || screen.x > width + LABEL_VIEW_MARGIN_PX
        || screen.y < -LABEL_VIEW_MARGIN_PX || screen.y > height + LABEL_VIEW_MARGIN_PX) continue;
      if (!screenSeparated(accepted, screen)) continue;
      accepted.push({ x: screen.x, y: screen.y });
      ambientCount += 1;
      const card = candidate.fire
        ? buildFireCard(candidate, now)
        : buildCellCard(candidate, now);
      if (candidate.fire) _fireByCardId.set(card.id, candidate.fire);
      entries.push(card);
    }

    overlayHost.setEntries(
      FIRMS_OVERLAY_SOURCE_ID,
      entries.map((entry) => {
        const card = applyFirmsOverlayPolicy(entry, _labelLodDistance);
        if (!card.interactive) return card;
        return {
          ...card,
          accessibilityLabel: `Focus fire detection ${card.title}, ${card.details.join(', ')}`,
          activate: () => {
            const fire = _fireByCardId.get(card.id);
            if (!fire) return false;
            selectAndFocusFire(fire);
            return true;
          },
        };
      }),
      {
        cohortLimit: FIRMS_AMBIENT_COHORT_LIMIT,
        collisionCapacity: FIRMS_AMBIENT_COHORT_LIMIT,
        moving: false,
      },
    );
  }

  /**
   * Install the LEFT_CLICK handler for fire selection (enable-time only,
   * mirroring the flight layers). Clicking a fire sprite selects it and
   * surfaces it in the shared context store; clicking empty space clears
   * the selection. Picks owned by sibling layers are left alone.
   */
  function installClickHandler() {
    if (_clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      const picked = _viewer.scene.pick(click.position);
      const fire = pickedFire(picked);
      if (fire) {
        selectAndFocusFire(fire);
        return;
      }
      // A pick that belongs to a sibling layer (e.g. an aircraft) is not
      // "empty space" — leave the selection alone and let that layer handle it.
      if (picked) {
        const pickedId = resolvePickId(picked);
        if (pickedId && isOwnedByOtherLayer(id, pickedId)) return;
      }
      const cardHit = overlayHost.hitTest?.(click.position?.x, click.position?.y, {
        sourceId: FIRMS_OVERLAY_SOURCE_ID,
      });
      if (cardHit) {
        const carded = _fireByCardId.get(cardHit.entryId);
        if (carded) selectAndFocusFire(carded);
        return;
      }
      clearFireSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  /** Select one stable detection and request one UI-owned camera transfer. */
  function selectAndFocusFire(fire) {
    selectFire(fire);
    requestWorldFocus({
      kind: 'fire',
      id: fireDetectionKey(fire),
      label: 'FIRE',
      position: firePosition(fire),
    });
  }

  /**
   * Resolve a scene pick to one of this layer's fire records, or null.
   * BillboardCollection picks surface our id either on picked.primitive.id
   * or directly on picked.id depending on the CesiumJS pick path.
   * @param {*} picked - Result of scene.pick().
   * @returns {?Object} Fire record.
   */
  function pickedFire(picked) {
    if (!picked) return null;
    const primitiveId = picked.primitive?.id;
    if (typeof primitiveId === 'string' && _pickIndexById.has(primitiveId)) {
      return _pickIndexById.get(primitiveId);
    }
    if (typeof picked.id === 'string' && _pickIndexById.has(picked.id)) {
      return _pickIndexById.get(picked.id);
    }
    return null;
  }

  /**
   * Select a fire: show its detail label and mark it selected in the shared
   * context store so voice "what's selected" resolves to it.
   * @param {Object} fire - Detection record.
   */
  function selectFire(fire) {
    _selectedFire = fire;
    try {
      registerFireContext(fire);
      _contextIds.add(fireDetectionKey(fire));
      selectEntityContext(fire.contextEntity);
    } catch {
      // context store unavailable — the selection label still works
    }
    rebuildAmbientLabels();
  }

  function clearFireSelection() {
    if (!_selectedFire) return;
    _selectedFire = null;
    clearSelectedEntityContextForLayer(id);
    rebuildAmbientLabels();
  }

  /**
   * Ambient labels are placed via screen-space projection, so they need a
   * re-declutter after the camera settles — on moveEnd, never per frame.
   */
  function installMoveEndWatcher() {
    if (_moveEndRemover || !_viewer) return;
    _moveEndRemover = _viewer.camera.moveEnd.addEventListener(() => {
      if (!_enabled) return;
      // Settled-camera exactness for the horizon pass (the throttled preRender
      // watcher can last have run up to LOD_CHECK_MS before the camera
      // stopped). Runs ahead of the `_loading` gate on purpose: the sprites on
      // screen during a refresh are the ones that need culling.
      refreshHorizonCulling();
      if (_loading) return;
      rebuildAmbientLabels();
    });
  }

  function removeMoveEndWatcher() {
    if (_moveEndRemover) {
      _moveEndRemover();
      _moveEndRemover = null;
    }
  }

  /**
   * Register the top detections of the current render set in the shared
   * context store (voice "what's burning here") and drop stale entries
   * from the previous rebuild.
   * @param {Array<Object>} fires - FRP-ranked detections to register.
   */
  function refreshContextRegistrations(fires) {
    let store = null;
    try {
      store = getContextStore();
    } catch {
      return;
    }

    const nextIds = new Set();
    for (const fire of fires) {
      nextIds.add(registerFireContext(fire));
    }
    // The click-selected fire must stay queryable ("what's selected") even
    // when it falls outside the top-N context slice.
    if (_selectedFire) {
      nextIds.add(registerFireContext(_selectedFire));
    }

    for (const staleId of _contextIds) {
      if (!nextIds.has(staleId)) store.entities.delete(staleId);
    }
    _contextIds = nextIds;
  }

  /**
   * Register one fire in the shared context store (idempotent) and return
   * its record id.
   * @param {Object} fire - Detection record.
   * @returns {string} Context record id.
   */
  function registerFireContext(fire) {
    const recordId = fireDetectionKey(fire);
    if (!fire.contextEntity) {
      fire.contextEntity = {
        show: true,
      };
    }
    // Refreshed every registration: the anchor re-grounds onto the DEM when
    // its floor cell warms, and voice targeting must project the same point
    // the sprite renders at.
    fire.contextEntity.__localBaseCartesian = firePosition(fire);
    registerEntityContext(fire.contextEntity, {
      id: recordId,
      layerId: id,
      layerName: name,
      source: 'NASA FIRMS',
      dataSource: _dataSource,
      label: `Fire · FRP ${formatFrp(fire.frp)} MW`,
      latitude: fire.lat,
      longitude: fire.lon,
      properties: {
        frp: fire.frp,
        confidence: confidenceBucket(fire.confidence),
        age: fire.acqMs > 0 ? formatAge(Date.now() - fire.acqMs) : 'unknown',
        sensor: fire.sensor || 'unknown',
      },
    });
    return recordId;
  }

  function clearContextRegistrations() {
    if (!_contextIds.size) return;
    try {
      const store = getContextStore();
      for (const recordId of _contextIds) store.entities.delete(recordId);
    } catch {
      // store unavailable — nothing to clean
    }
    _contextIds = new Set();
  }

  /**
   * Top-FRP detections within the given bounds (or globally when bounds is
   * null). Walks the pre-sorted FRP index so it stays a single cheap pass.
   * @param {?Object} bounds - Padded view bounds in degrees, or null.
   * @param {number} limit - Max detections returned.
   * @returns {Array<Object>}
   */
  function topFiresWithinBounds(bounds, limit = CONTEXT_TOP_N) {
    if (!bounds) return _firesByFrp.slice(0, limit);
    const top = [];
    for (const fire of _firesByFrp) {
      if (!boundsContainPoint(bounds, fire.lat, fire.lon)) continue;
      top.push(fire);
      if (top.length >= limit) break;
    }
    return top;
  }

  function ensureDetectionCollections() {
    if (!_viewer || _billboards) return;
    _billboards = new Cesium.BillboardCollection({
      scene: _viewer.scene,
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    _billboards.show = _enabled;
    _viewer.scene.primitives.add(_billboards);
    registerSpriteCollection('firms', _billboards);
    restoreSpriteOrder(_viewer);
    overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, _enabled);
  }

  function removeDetectionCollections(viewer) {
    const scene = viewer?.scene || _viewer?.scene;
    if (scene && !scene.isDestroyed?.()) {
      try {
        if (_billboards) scene.primitives.remove(_billboards);
      } catch { /* already torn down */ }
    }
    _billboards = null;
    overlayHost.clearSource(FIRMS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, false);
  }

  /**
   * Shared horizon occluder positioned at the current camera, or null when
   * there is no usable camera yet (init order / headless stubs).
   * `viewer.camera` and `viewer.scene.camera` are the SAME object in Cesium;
   * both are probed so a partial stub (either shape) still gets a real
   * occluder rather than silently degrading to "nothing is ever occluded".
   * @returns {?Cesium.EllipsoidalOccluder}
   */
  function fireHorizonOccluder() {
    const camera = _viewer?.camera?.positionWC ? _viewer.camera : _viewer?.scene?.camera;
    if (!camera?.positionWC) return null;
    return horizonOccluder(camera);
  }

  /**
   * Hide detection sprites that sit beyond the ellipsoid horizon (see
   * {@link applyHorizonCull}). Runs on the cadences that already exist in this
   * layer — the throttled LOD preRender watcher (camera-moved only), camera
   * moveEnd, and each detection rebuild — never as a new per-frame pass.
   * No-ops in the `cells` bands, where the collection is empty.
   */
  function refreshHorizonCulling() {
    if (!_billboards || !_billboards.length) return;
    applyHorizonCull(_billboards, fireHorizonOccluder(), _cullPositions);
  }

  function cameraHeight() {
    return _viewer?.camera?.positionCartographic?.height ?? Number.POSITIVE_INFINITY;
  }

  /** Raw LOD index for a camera height (0 = global ... 3 = close). */
  function rawLodIndex(height) {
    const index = LOD_LEVELS.findIndex((level) => height >= level.minHeight);
    return index === -1 ? LOD_LEVELS.length - 1 : index;
  }

  /**
   * LOD selection with ±10% hysteresis around band floors: a band switch
   * only happens once the camera clears the boundary by the margin, so a
   * slow zoom oscillating on an edge cannot trigger a rebuild every check.
   * @param {number} height - Camera height in meters.
   * @returns {number} LOD index to render.
   */
  function selectLodIndex(height) {
    const raw = rawLodIndex(height);
    if (_currentLodIndex < 0 || raw === _currentLodIndex) return raw;
    let index = _currentLodIndex;
    // Zooming out: enter a coarser band only after clearing its floor by +10%.
    while (index > raw && height >= LOD_LEVELS[index - 1].minHeight * (1 + LOD_HYSTERESIS)) index -= 1;
    // Zooming in: leave the current band only after dropping 10% below its floor.
    while (index < raw && height <= LOD_LEVELS[index].minHeight * (1 - LOD_HYSTERESIS)) index += 1;
    return index;
  }

  /** Current camera view rectangle, or null when looking at sky/horizon. */
  function computeViewRect() {
    try {
      const rect = _viewer?.camera?.computeViewRectangle(
        _viewer?.scene?.globe?.ellipsoid,
        scratchViewRect
      );
      return rect || null;
    } catch {
      return null;
    }
  }

  /**
   * True when the camera view rectangle drifted far enough from the last
   * rendered one that the padding is at risk of being consumed (pan) or
   * the footprint changed notably (zoom within a band).
   * @param {?Cesium.Rectangle} viewRect - Current view rectangle.
   * @returns {boolean}
   */
  function viewChangedEnough(viewRect) {
    if (!viewRect) return false; // sky/horizon — keep the current render
    if (!_lastViewRect) return true; // previous render was global fallback
    const lastWidth = Cesium.Rectangle.computeWidth(_lastViewRect);
    const lastHeight = Cesium.Rectangle.computeHeight(_lastViewRect);
    const width = Cesium.Rectangle.computeWidth(viewRect);
    const height = Cesium.Rectangle.computeHeight(viewRect);
    if (width > lastWidth * 1.3 || width < lastWidth * 0.75) return true;
    if (height > lastHeight * 1.3 || height < lastHeight * 0.75) return true;
    const lastCenter = Cesium.Rectangle.center(_lastViewRect, scratchCenterA);
    const center = Cesium.Rectangle.center(viewRect, scratchCenterB);
    const latShift = Math.abs(center.latitude - lastCenter.latitude);
    let lonShift = Math.abs(center.longitude - lastCenter.longitude);
    if (lonShift > Math.PI) lonShift = Cesium.Math.TWO_PI - lonShift;
    return latShift > lastHeight * VIEW_PADDING * 0.6 || lonShift > lastWidth * VIEW_PADDING * 0.6;
  }

  function installLodWatcher() {
    if (_preRenderRemover || !_viewer) return;
    // The LOD sweep is throttle-gated inside preRender. When the camera
    // settles just inside the throttle window, the final rebuild would wait
    // for a frame that idle mode never produces — schedule one. (perf wave 2)
    if (!_moveEndSettleRemover) {
      _moveEndSettleRemover = _viewer.camera.moveEnd.addEventListener(() => {
        if (!_enabled) return;
        setTimeout(() => governorRequestRender('firms-lod-settle'), LOD_CHECK_MS + 40);
      });
    }
    _preRenderRemover = _viewer.scene.preRender.addEventListener(() => {
      // NOTE: `_loading`/empty-data are deliberately NOT part of this guard.
      // A refresh has no timeout, and sprites from the previous payload stay
      // on screen throughout it — so the horizon pass below must keep running
      // while a fetch is in flight. Only the rebuild is gated on fresh data.
      if (!_enabled) return;
      const now = performance.now();
      if (now - _lastLodCheck < LOD_CHECK_MS) return;
      _lastLodCheck = now;
      // Idle camera: two scratch compares and out — no view-rect math, no
      // aggregation, no allocation while the user is parked.
      const camera = _viewer.camera;
      if (_camSnapValid
        && Cesium.Cartesian3.equalsEpsilon(camera.positionWC, _camPos, 0, 0.5)
        && Cesium.Cartesian3.equalsEpsilon(camera.directionWC, _camDir, 0, 1e-7)) {
        return;
      }
      Cesium.Cartesian3.clone(camera.positionWC, _camPos);
      Cesium.Cartesian3.clone(camera.directionWC, _camDir);
      _camSnapValid = true;
      // The camera moved, so the horizon moved. A rebuild culls its own fresh
      // sprites (renderDetections); an early-out — same LOD band and view
      // rect, or a refresh in flight — does not, so cull here instead.
      // Exactly ONE occlusion walk per tick either way, bounded by the
      // idle-gate + LOD_CHECK_MS throttle above: a parked camera costs
      // nothing, a moving one pays one ≤maxDetections show-flip walk at
      // ~1.5 Hz.
      const rebuilt = (_fires.length && !_loading) ? renderCurrentLod(false) : false;
      if (!rebuilt) refreshHorizonCulling();
    });
  }

  function removeLodWatcher() {
    if (_preRenderRemover) {
      _preRenderRemover();
      _preRenderRemover = null;
    }
    if (_moveEndSettleRemover) {
      _moveEndSettleRemover();
      _moveEndSettleRemover = null;
    }
  }
}

/**
 * Expand a view rectangle by VIEW_PADDING per side and convert to degree
 * bounds with an explicit anti-meridian wrap flag. Returns null for
 * near-global views where clipping would be pointless.
 * @param {Cesium.Rectangle} rect - Camera view rectangle (radians).
 * @returns {?{west: number, south: number, east: number, north: number, wraps: boolean}}
 */
function paddedDegreeBounds(rect) {
  const width = Cesium.Rectangle.computeWidth(rect);
  const height = Cesium.Rectangle.computeHeight(rect);
  if (width >= Math.PI * 1.85) return null;
  const padLon = width * VIEW_PADDING;
  const padLat = height * VIEW_PADDING;
  const south = Math.max(-Cesium.Math.PI_OVER_TWO, rect.south - padLat);
  const north = Math.min(Cesium.Math.PI_OVER_TWO, rect.north + padLat);
  let west = rect.west - padLon;
  let east = rect.east + padLon;
  let wraps;
  if (width + padLon * 2 >= Cesium.Math.TWO_PI) {
    west = -Math.PI;
    east = Math.PI;
    wraps = false;
  } else {
    west = Cesium.Math.negativePiToPi(west);
    east = Cesium.Math.negativePiToPi(east);
    wraps = west > east;
  }
  return {
    west: Cesium.Math.toDegrees(west),
    south: Cesium.Math.toDegrees(south),
    east: Cesium.Math.toDegrees(east),
    north: Cesium.Math.toDegrees(north),
    wraps,
  };
}

/** Point-in-bounds test in degrees, anti-meridian aware. */
function boundsContainPoint(bounds, lat, lon) {
  if (lat < bounds.south || lat > bounds.north) return false;
  if (bounds.wraps) return lon >= bounds.west || lon <= bounds.east;
  return lon >= bounds.west && lon <= bounds.east;
}

/** Cell-rectangle/bounds intersection test in degrees, anti-meridian aware. */
function cellIntersectsBounds(cell, gridDegrees, bounds) {
  if (cell.latCell + gridDegrees < bounds.south || cell.latCell > bounds.north) return false;
  const west = cell.lonCell;
  const east = cell.lonCell + gridDegrees;
  if (bounds.wraps) return east >= bounds.west || west <= bounds.east;
  return east >= bounds.west && west <= bounds.east;
}

function heatScore(cell) {
  return cell.intensity + cell.count * 0.8 + cell.night * 0.6 + cell.maxFrp * 0.12;
}

function heatColor(value, alpha) {
  if (value > 0.72) return Cesium.Color.RED.withAlpha(alpha);
  if (value > 0.42) return Cesium.Color.ORANGE.withAlpha(alpha);
  return Cesium.Color.YELLOW.withAlpha(alpha);
}

/**
 * Pick a sprite color stop from FRP + confidence, reusing the same
 * yellow → orange → red thresholds as the aggregated heat cells.
 * @param {Object} fire - Detection record.
 * @returns {{name: string, color: Cesium.Color}}
 */
function detectionColorStop(fire) {
  const heat = Math.min(1, Math.sqrt(Math.max(0, fire.frp) / 150) * 0.85 + fire.confidence * 0.15);
  if (heat > 0.72) return DETECTION_COLOR_STOPS[0];
  if (heat > 0.42) return DETECTION_COLOR_STOPS[1];
  return DETECTION_COLOR_STOPS[2];
}

/** FRP → core marker pixel size, clamped to 8..28px. */
function frpPixelSize(frp) {
  return Math.max(8, Math.min(28, Math.round(8 + Math.sqrt(Math.max(0, frp)) * 2)));
}

/** Quantize a core size to a 2px bucket so the sprite cache stays tiny. */
function sizeBucket(coreSize) {
  return Math.max(8, Math.min(28, Math.round(coreSize / 2) * 2));
}

/**
 * Build (and cache) a radial-glow sprite: hot near-white center fading
 * through the stop color to a transparent edge. The glow lives in the
 * sprite itself because global bloom defaults OFF.
 * @param {{name: string, color: Cesium.Color}} stop - Color stop.
 * @param {number} corePx - Bucketed core size in pixels.
 * @returns {string} PNG data URL.
 */
function glowSprite(stop, corePx) {
  const key = `${stop.name}:${corePx}`;
  const cached = glowSpriteCache.get(key);
  if (cached) return cached;

  const dimension = corePx * 2;
  const canvas = document.createElement('canvas');
  canvas.width = dimension;
  canvas.height = dimension;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const radius = dimension / 2;
  const rgb = [
    Math.round(stop.color.red * 255),
    Math.round(stop.color.green * 255),
    Math.round(stop.color.blue * 255),
  ].join(',');
  const gradient = context.createRadialGradient(radius, radius, 0, radius, radius, radius);
  gradient.addColorStop(0, 'rgba(255,255,235,0.95)');
  gradient.addColorStop(0.25, `rgba(${rgb},0.9)`);
  gradient.addColorStop(0.55, `rgba(${rgb},0.35)`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, dimension, dimension);

  const dataUrl = canvas.toDataURL('image/png');
  glowSpriteCache.set(key, dataUrl);
  return dataUrl;
}

/**
 * Lazily-cached Cartesian3 anchor at the shared ground floor (DEM/mesh cell
 * + lift) when the floor is warm, else ellipsoid height 0 (owner field
 * finding 2026-07-21: height-0 anchors read as buried under high terrain at
 * close/oblique zoom). Warm-cache read only — floors are warmed in batch by
 * renderDetections for the close band; everything else (cell-band context
 * registrations, detectable objects) just rides whatever is already warm.
 * Fires are static and floor cells latch, so each detection re-allocates at
 * most once per floor state (cold 0 → warm DEM). Rendering stays depth-test
 * free either way (contacts are ALWAYS visible — never below the surface,
 * slightly above is fine).
 * @param {Object} fire - Detection record.
 * @returns {Cesium.Cartesian3}
 */
function firePosition(fire) {
  const height = fireAnchorHeight(fire.lat, fire.lon);
  if (!fire.position || fire.positionHeight !== height) {
    fire.position = Cesium.Cartesian3.fromDegrees(fire.lon, fire.lat, height);
    fire.positionHeight = height;
  }
  return fire.position;
}

/**
 * Occlusion-test anchor for one detection. Returns the render position
 * outright for anchors comfortably above the ellipsoid (the common case) and
 * a lazily-cached lifted point otherwise — see CULL_LIFT_THRESHOLD_M. This
 * NEVER feeds rendering: the datum-correct anchor from {@link firePosition}
 * is what the sprite and the card are drawn at.
 * @param {Object} fire - Detection record.
 * @returns {Cesium.Cartesian3}
 */
export function fireCullPosition(fire) {
  const position = firePosition(fire);
  if (fire.positionHeight >= CULL_LIFT_THRESHOLD_M) return position;
  if (!fire.cullPosition) {
    fire.cullPosition = Cesium.Cartesian3.fromDegrees(fire.lon, fire.lat, CULL_LIFT_M);
  }
  return fire.cullPosition;
}

/**
 * Occlusion-test anchor for an aggregated heat cell. Cell centers are built at
 * height 0 (exactly on the ellipsoid), which the occluder treats as a limb
 * boundary case, so they get the same lift as sub-ellipsoid fire anchors.
 * @param {number} lon - Cell center longitude in degrees.
 * @param {number} lat - Cell center latitude in degrees.
 * @returns {Cesium.Cartesian3}
 */
function cellCullPosition(lon, lat) {
  return Cesium.Cartesian3.fromDegrees(lon, lat, CULL_LIFT_M);
}

/**
 * Horizon-cull a billboard collection against an ellipsoid occluder.
 *
 * The Cesium globe is hidden in this app (Google 3D Tiles render the planet),
 * so nothing writes far-side depth — and these sprites are additionally
 * always-on-top (`disableDepthTestDistance: INFINITY`, so a detection is never
 * swallowed by terrain it sits on). Without an explicit occluder pass, fires on
 * the opposite side of the Earth shine through the planet at tilted mid-altitude
 * views. Same pattern as the flights/CCTV layers' `EllipsoidalOccluder` passes.
 *
 * Pure and allocation-free: reads `billboard.position`, writes `billboard.show`
 * only when it actually flips (assigning `show` dirties the collection's vertex
 * buffer). Accepts any `{length, get(i)}` shape so it is unit-testable without
 * a WebGL scene.
 *
 * @param {?{length: number, get: function(number): (Object|undefined)}} billboards
 *   Billboard collection (or collection-shaped stub).
 * @param {?{isPointVisible: function(Object): boolean}} occluder Horizon occluder.
 * @param {?Array<Cesium.Cartesian3>} [cullPositions=null] Index-aligned lifted
 *   occlusion-test anchors (see {@link fireCullPosition}); falls back to the
 *   billboard's own render position wherever an entry is absent.
 * @returns {number} Count of billboards left visible (0 when nothing to test).
 */
export function applyHorizonCull(billboards, occluder, cullPositions = null) {
  if (!billboards || typeof billboards.get !== 'function') return 0;
  if (typeof occluder?.isPointVisible !== 'function') return 0;
  const total = Number(billboards.length) || 0;
  let visibleCount = 0;
  for (let i = 0; i < total; i += 1) {
    const billboard = billboards.get(i);
    if (!billboard) continue;
    const point = (cullPositions && cullPositions[i]) || billboard.position;
    const visible = occluder.isPointVisible(point) === true;
    if (billboard.show !== visible) billboard.show = visible;
    if (visible) visibleCount += 1;
  }
  return visibleCount;
}

/**
 * True when `screen` is at least LABEL_MIN_SEP_PX away from every accepted
 * screen position (greedy declutter accept test).
 * @param {Array<{x: number, y: number}>} accepted - Accepted label positions.
 * @param {Cesium.Cartesian2} screen - Candidate window coordinates.
 * @returns {boolean}
 */
function screenSeparated(accepted, screen) {
  const minSq = LABEL_MIN_SEP_PX * LABEL_MIN_SEP_PX;
  for (let i = 0; i < accepted.length; i += 1) {
    const dx = screen.x - accepted[i].x;
    const dy = screen.y - accepted[i].y;
    if (dx * dx + dy * dy < minSq) return false;
  }
  return true;
}

/**
 * Card model for a click-selected fire — the full-detail card, drawn last
 * (on top) and never distance-faded by the overlay.
 * Exported for unit tests.
 * @param {Object} fire - Detection record.
 * @param {number} nowMs - Current epoch milliseconds.
 * @returns {Object} firmsLabels entry.
 */
export function buildSelectedFireCard(fire, nowMs) {
  const meta = [`${confidenceBucket(fire.confidence)} conf`];
  if (fire.acqMs > 0) {
    const age = formatAge(nowMs - fire.acqMs);
    if (age) meta.push(`${age} ago`);
  }
  const sat = satelliteShortName(fire.satellite);
  meta.push(sat ? `${fire.sensor || 'VIIRS'} ${sat}` : (fire.sensor || 'sensor n/a'));
  return {
    id: `selected-fire:${fireDetectionKey(fire)}`,
    actionable: true,
    position: firePosition(fire),
    // Host-side horizon test uses this instead of the render anchor.
    cullPosition: fireCullPosition(fire),
    gapPx: frpPixelSize(fire.frp),
    accent: accentForSeverity(detectionColorStop(fire).name),
    title: `FIRE · ${formatFrp(fire.frp)} MW`,
    details: [
      meta.join(' · '),
      formatLatLon(fire.lat, fire.lon) + (fire.night ? ' · NIGHT' : ''),
    ],
    selected: true,
    priority: Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Card model for an ambient fire detection, e.g. title "▲ 47 MW", detail
 * "high · 14h · N20". Ages are computed against each detection's acquisition
 * time — with the live feed everything reads under 24 h (and a stale cache
 * reads truthfully old). Exported for unit tests.
 * @param {{fire: Object, position: Cesium.Cartesian3}} candidate - Label candidate.
 * @param {number} nowMs - Current epoch milliseconds.
 * @returns {Object} firmsLabels entry.
 */
export function buildFireCard(candidate, nowMs) {
  const fire = candidate.fire;
  const meta = [confidenceBucket(fire.confidence)];
  if (fire.acqMs > 0) {
    const age = formatAge(nowMs - fire.acqMs);
    if (age) meta.push(age);
  }
  const sat = satelliteShortName(fire.satellite) || fire.sensor;
  if (sat) meta.push(sat);
  return {
    id: `fire:${fireDetectionKey(fire)}`,
    actionable: true,
    position: candidate.position,
    cullPosition: candidate.cullPosition || candidate.position,
    gapPx: frpPixelSize(fire.frp),
    accent: accentForSeverity(detectionColorStop(fire).name),
    title: `▲ ${formatFrp(fire.frp)} MW`,
    details: [meta.join(' · ')],
    selected: false,
    priority: Number(fire.frp) || 0,
  };
}

/**
 * Card model for an aggregated heat cell, e.g. title "14 FIRES", detail
 * "max 210 MW · new 3h". Accent comes from the candidate (heat-normalized
 * score is only known at renderCells time). Exported for unit tests.
 * @param {{cell: Object, position: Cesium.Cartesian3, accent: string}} candidate
 * @param {number} nowMs - Current epoch milliseconds.
 * @returns {Object} firmsLabels entry.
 */
export function buildCellCard(candidate, nowMs) {
  const cell = candidate.cell;
  const noun = cell.count === 1 ? 'FIRE' : 'FIRES';
  const parts = [`max ${formatFrp(cell.maxFrp)} MW`];
  if (cell.newestAcqMs > 0) {
    const age = formatAge(nowMs - cell.newestAcqMs);
    if (age) parts.push(`new ${age}`);
  }
  return {
    id: `cell:${cell.latCell ?? 'x'}:${cell.lonCell ?? 'x'}`,
    position: candidate.position,
    cullPosition: candidate.cullPosition || candidate.position,
    gapPx: 10,
    accent: candidate.accent || accentForSeverity('yellow'),
    title: `${cell.count} ${noun}`,
    details: [parts.join(' · ')],
    selected: false,
    priority: Number(cell.maxFrp) || 0,
  };
}

/**
 * Add the host-owned layout/fade/collision fields to a source-formatted FIRMS
 * card. Selected fires share the collision domain so their protected rect
 * excludes ambient cards, but bypass both the 18-card cohort and distance fade.
 * @param {Object} card Source-formatted card.
 * @param {number} fadeDistance Current LOD fade distance in metres.
 * @returns {Object}
 */
export function applyFirmsOverlayPolicy(card, fadeDistance) {
  const selected = card?.selected === true;
  const rawGap = Number(card?.gapPx) || 10;
  const gapPx = Math.max(12, rawGap + 8);
  return {
    ...card,
    variant: selected ? 'selected' : 'card',
    protected: selected,
    collisionGroup: 'ambient-card',
    cardStyle: 'tactical',
    gapPx,
    leaderOffsetPx: Math.max(2, gapPx - 6),
    verticalOnly: true,
    viewportMargin: 4,
    maxDistance: selected ? Number.POSITIVE_INFINITY : fadeDistance,
    distanceFadeStartRatio: 0.7,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    // Aggregate cells omit actionable because they do not identify one fire.
    interactive: card?.actionable === true,
  };
}

/**
 * Heat-normalized cell score → severity accent, mirroring heatColor's
 * red/orange/yellow thresholds.
 * @param {number} normalized - 0..1 normalized heat score.
 * @returns {string} "r, g, b" accent string.
 */
function cellAccent(normalized) {
  if (normalized > 0.72) return accentForSeverity('red');
  if (normalized > 0.42) return accentForSeverity('orange');
  return accentForSeverity('yellow');
}

/** Coordinate line like "30.512°N 75.831°E". */
function formatLatLon(lat, lon) {
  const latPart = `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}`;
  const lonPart = `${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${latPart} ${lonPart}`;
}

function formatFrp(frp) {
  return frp >= 10 ? frp.toFixed(0) : frp.toFixed(1);
}

/** Millisecond delta → "<1h" / "Xh" / "Xd", or '' for invalid input. */
function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return '';
  const hours = deltaMs / 3600000;
  if (hours < 1) return '<1h';
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Millisecond delta → "<1m ago" / "Xm ago" / "Xh ago" (fresh-feed readout). */
function formatAgoMinutes(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return 'just now';
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return '<1m ago';
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** Normalized 0..1 confidence → low/nominal/high display bucket. */
function confidenceBucket(confidence) {
  if (confidence >= 0.75) return 'high';
  if (confidence >= 0.45) return 'nominal';
  return 'low';
}
