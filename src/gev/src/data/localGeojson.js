import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  selectEntityContext,
} from './contextStore.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

const DEFAULT_LABEL_MAX = 900;
const DEFAULT_LABEL_GRID_PX = 132;
const VISIBILITY_UPDATE_MS = 450;
// Each source keeps its own bounded cohort; the host sums their ambient-card
// paint budgets only up to its 192-card shared-lane ceiling.
export const LOCAL_OVERLAY_COHORT_LIMIT = 160;
const LOCAL_OVERLAY_COLLISION_CAPACITY = 96;
const LOCAL_OVERLAY_CELL_SURPLUS = 2;
const LOCAL_OVERLAY_MAX_DISTANCE_M = 14000000;
const LOCAL_OVERLAY_FADE_START_M = 250000;
const LOCAL_OVERLAY_FADE_START_RATIO = LOCAL_OVERLAY_FADE_START_M / LOCAL_OVERLAY_MAX_DISTANCE_M;
// Stems are anchored at ellipsoid height 0, but high-elevation features
// (e.g. dams in river canyons) sit hundreds of meters above the ellipsoid,
// burying the short close-in stem inside the photoreal mesh. Once the
// camera is near enough for tiles to be loaded, sample the real surface
// height once per feature and lift the stem onto it.
const GROUND_SAMPLE_MAX_DISTANCE_M = 75000;
const GROUND_SAMPLE_RETRY_MS = 2000;
const GROUND_SAMPLE_MAX_ABS_HEIGHT_M = 9000;
/**
 * Bounded give-up for the self-armed retry. Sampling can be SUPPORTED and still
 * never succeed (no sampleable surface under the feature), in which case each
 * requested frame would arm the next 2 s timer forever — an idle-governor leak
 * dressed up as a retry. After this many consecutive armed retries with no
 * record newly grounded, stop arming; camera motion (a frame we get for free)
 * still retries through the normal preRender walk and re-opens the budget.
 * 30 × 2 s ≈ 60 s, far longer than a tile stream-in.
 */
export const GROUND_SAMPLE_MAX_ARMED_RETRIES = 30;
/** Ignore sub-metre camera-derived stem-tip noise at camera settle. */
export const LOCAL_STEM_TIP_EPSILON_M = 0.5;
const LOCAL_STEM_TIP_EPSILON_SQ = LOCAL_STEM_TIP_EPSILON_M ** 2;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  clearSource: clearOverlaySource,
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
});

/**
 * Build the validated local-infrastructure card copy.
 * @param {object} properties Unwrapped GeoJSON feature properties.
 * @param {string} layerId Local layer id.
 * @returns {{title:string,details:string[]}}
 */
export function localInfrastructureOverlayCopy(properties, layerId) {
  const props = unwrapProperties(properties) || {};
  const tags = props.tags || {};
  const title = featureLabelFromProperties(props, layerId);
  const details = [];

  if (layerId === 'local-datacenters') {
    const operator = firstClean([
      tags.operator,
      props.operator,
      tags['operator:short'],
    ]);
    const capacity = firstClean([
      tags['capacity:it_load'],
      tags.it_load,
      tags.capacity,
      props.capacity,
    ]);
    const line = [operator, capacity]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .filter((value) => value.toLocaleLowerCase() !== title.toLocaleLowerCase())
      .join(' · ');
    if (line) details.push(clampCardLine(line));
  } else if (layerId === 'local-dams') {
    const river = firstClean([
      tags.associated_river,
      props.associated_river,
      tags.river,
      props.river,
      tags['river:name'],
    ]);
    if (river && river.toLocaleLowerCase() !== title.toLocaleLowerCase()) {
      details.push(clampCardLine(river));
    }
  }

  return { title, details };
}

/**
 * Produce one normalized-contract input owned by a local infrastructure layer.
 * The host revalidates the authoritative `source` value while normalizing it.
 * @param {object} options
 * @param {string} options.id Stable id within the source.
 * @param {string} options.layerId Local layer id.
 * @param {Cesium.Cartesian3} options.position Current stem-tip position.
 * @param {object} options.properties Unwrapped feature properties.
 * @param {number} options.priority Source-owned importance score.
 * @param {string} options.accent Source accent color.
 * @returns {object}
 */
export function createLocalInfrastructureOverlayEntry({
  id,
  layerId,
  position,
  properties,
  priority,
  accent,
}) {
  const copy = localInfrastructureOverlayCopy(properties, layerId);
  return {
    id: String(id),
    source: layerId,
    position,
    variant: 'card',
    title: copy.title,
    details: copy.details,
    accent,
    priority,
    collisionGroup: 'ambient-card',
    zIndex: 30,
    interactive: false,
    minDistance: 0,
    maxDistance: LOCAL_OVERLAY_MAX_DISTANCE_M,
    distanceFadeStartRatio: LOCAL_OVERLAY_FADE_START_RATIO,
    distanceScale: {
      near: 250000,
      nearValue: 1,
      far: 9000000,
      farValue: 0.62,
    },
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    placement: 'above',
  };
}

/**
 * Retain a bounded screen-grid surplus for the host's final rectangle arbiter.
 * Two deterministic contenders per legacy grid cell preserve the old density
 * while giving the shared solver an alternative when the first card collides.
 * @param {object[]} records Local stem/entry records.
 * @param {object} options
 * @param {number} options.maxEntries Legacy source cap.
 * @param {number} options.gridPx Legacy screen grid size.
 * @param {number} options.width Viewport width in CSS pixels.
 * @param {number} options.height Viewport height in CSS pixels.
 * @param {function(object):({x:number,y:number}|null)} options.project Projection callback.
 * @param {number} [options.cohortLimit=Infinity] Host-safe materialization cap.
 * @returns {object[]} Bounded overlay entries for shared-host arbitration.
 */
export function selectLocalInfrastructureOverlayCohort(records, {
  maxEntries,
  gridPx,
  width,
  height,
  project,
  cohortLimit = Number.POSITIVE_INFINITY,
}) {
  const sourceCap = Math.max(0, Math.floor(Number(maxEntries) || 0));
  const materializationCap = Number.isFinite(Number(cohortLimit))
    ? Math.max(0, Math.floor(Number(cohortLimit)))
    : Number.POSITIVE_INFINITY;
  const cap = Math.min(sourceCap, materializationCap);
  const cellSize = Math.max(1, Number(gridPx) || 1);
  if (!Array.isArray(records) || records.length === 0 || cap === 0 || typeof project !== 'function') {
    return [];
  }

  const cells = new Map();
  const padding = cellSize;
  for (const record of records) {
    const screen = project(record);
    if (!Number.isFinite(screen?.x) || !Number.isFinite(screen?.y)) continue;
    if (screen.x < -padding || screen.x > width + padding
      || screen.y < -padding || screen.y > height + padding) continue;
    const key = `${Math.floor(screen.x / cellSize)}:${Math.floor(screen.y / cellSize)}`;
    let contenders = cells.get(key);
    if (!contenders) {
      contenders = [];
      cells.set(key, contenders);
    }
    insertLocalCellContender(contenders, record);
  }

  const primary = [];
  const surplus = [];
  for (const contenders of cells.values()) {
    if (contenders[0]) primary.push(contenders[0]);
    if (contenders[1]) surplus.push(contenders[1]);
  }
  primary.sort(compareLocalOverlayRecords);
  surplus.sort(compareLocalOverlayRecords);
  if (primary.length >= cap) return primary.slice(0, cap).map((record) => record.entry);
  const candidates = primary.concat(surplus.slice(0, cap - primary.length));
  return candidates.map((record) => record.entry);
}

/**
 * Bind a local layer's visibility and entry lifecycle to the shared host.
 * @param {object} options
 * @param {string} options.sourceId Local layer id.
 * @param {object} [options.host] Test seam for the three host lifecycle calls.
 * @returns {{show:function():void,publish:function(object[]):void,hide:function():void,destroy:function():void}}
 */
export function createLocalInfrastructureOverlayPublisher({
  sourceId,
  host = DEFAULT_OVERLAY_HOST,
}) {
  let visible = false;
  let published = false;
  let destroyed = false;
  const sourceOptions = {
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    collisionCapacity: LOCAL_OVERLAY_COLLISION_CAPACITY,
    moving: false,
  };

  return {
    show() {
      if (destroyed || visible) return;
      visible = true;
      host.setVisible(sourceId, true);
    },
    publish(entries) {
      if (destroyed || !visible) return;
      host.setEntries(sourceId, entries, sourceOptions);
      published = entries.length > 0;
    },
    hide() {
      if (destroyed) return;
      if (published) host.clearSource(sourceId);
      if (visible) host.setVisible(sourceId, false);
      visible = false;
      published = false;
    },
    destroy() {
      if (destroyed) return;
      if (published) host.clearSource(sourceId);
      if (visible) host.setVisible(sourceId, false);
      visible = false;
      published = false;
      destroyed = true;
    },
  };
}

/**
 * Reduce a bundled-dataset load failure to one short, honest stats string.
 *
 * These layers ship their data with the build, so a failure means the asset
 * is missing (404 / bad path) or corrupt — never "the network is slow". Both
 * must reach the user's chip; the raw parser message is console-only because
 * a truncated JSON blob is not a status line.
 *
 * @param {Error|{name?:string, message?:string}|null|undefined} error - The thrown load failure.
 * @returns {string} Short reason for getStats().error.
 */
export function localDatasetError(error) {
  if (error?.name === 'SyntaxError') return 'dataset is malformed';
  const message = String(error?.message || '').trim();
  return message ? `dataset unavailable (${message})` : 'dataset unavailable';
}

/**
 * A minimal, rock-solid native implementation for loading local GeoJSON Data.
 * Draws 3D stems (polylines) attached to Point entities and ensures
 * standard scene.pick natively clicks them.
 */
export function createLocalGeoJsonLayer({
  id,
  url,
  name,
  color,
  icon = '📍',
  source = 'Local JSONL',
  labels = true,
  labelMax = DEFAULT_LABEL_MAX,
  labelGridPx = DEFAULT_LABEL_GRID_PX,
  overlayHost = DEFAULT_OVERLAY_HOST,
  screenSpaceEventHandlerFactory = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
  projectToWindow = (scene, position) => Cesium.SceneTransforms.worldToWindowCoordinates(scene, position),
}) {
  let _dataSource = null;
  let _enabled = false;
  let _clickHandler = null;
  let _count = 0;
  /** @type {number|null} Timestamp of the last successful dataset load. */
  let _lastUpdate = null;
  /** @type {string|null} Short reason the bundled dataset failed to load. */
  let _error = null;
  let _preRenderRemover = null;
  let _cameraMoveEndRemover = null;
  let _stemRecords = [];
  let _stemGeometryDirty = true;
  let _lastVisibilityUpdate = 0;
  let _destroyed = false;
  let _groundRetryTimer = null;
  /** Consecutive self-armed retries since the last grounding/camera motion. */
  let _groundRetryArms = 0;
  /** Last observed scene.sampleHeightSupported; null until the first walk. */
  let _lastGroundSampleCapability = null;

  /**
   * Coalesced one-shot: ask the governor for a frame once the retry window
   * has elapsed, so the preRender ground-sample retry actually runs while the
   * camera is parked. One timer for the whole layer (not per record) — the
   * retry pass walks every record anyway. (perf rebase 2026-08-17)
   *
   * Two gates keep this from becoming an idle leak (second review):
   *   - CAPABILITY: without `scene.sampleHeightSupported` the sample can never
   *     succeed, so a timer here would re-arm on every requested frame,
   *     forever. Records simply stay at ellipsoid height — exactly the
   *     pre-perf keyless behavior.
   *   - BUDGET: sampling can be supported and still keep failing (no sampleable
   *     surface yet/ever). Give up after GROUND_SAMPLE_MAX_ARMED_RETRIES
   *     consecutive arms; free camera-motion frames still retry.
   * @param {Cesium.Viewer} viewer
   * @returns {void}
   */
  function scheduleGroundRetryRender(viewer) {
    if (_groundRetryTimer || !_enabled) return;
    if (!viewer?.scene?.sampleHeightSupported) return;
    if (_groundRetryArms >= GROUND_SAMPLE_MAX_ARMED_RETRIES) return;
    _groundRetryArms += 1;
    _groundRetryTimer = setTimeout(() => {
      _groundRetryTimer = null;
      if (!_enabled || _destroyed) return;
      governorRequestRender(`local-ground-retry:${id}`);
    }, GROUND_SAMPLE_RETRY_MS);
  }

  function clearGroundRetryRender() {
    _groundRetryArms = 0;
    _lastGroundSampleCapability = null;
    if (!_groundRetryTimer) return;
    clearTimeout(_groundRetryTimer);
    _groundRetryTimer = null;
  }
  const _overlayPublisher = createLocalInfrastructureOverlayPublisher({
    sourceId: id,
    host: overlayHost,
  });

  const disableLayer = (viewer) => {
    _enabled = false;
    clearGroundRetryRender();
    if (_dataSource) _dataSource.show = false;
    _overlayPublisher.hide();
    clearSelectedEntityContextForLayer(id);
    if (viewer?.selectedEntity?.__localLayerId === id) {
      viewer.selectedEntity = undefined;
    }
    if (_preRenderRemover) {
      _preRenderRemover();
      _preRenderRemover = null;
    }
    if (_cameraMoveEndRemover) {
      _cameraMoveEndRemover();
      _cameraMoveEndRemover = null;
    }
  };

  return {
    id,
    name,
    icon,
    source,
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init: async (viewer) => {
      // DataLayerManager calls this once
    },
    
    update: async (viewer) => {
      // DataLayerManager calls this when enabled
    },
    
    /**
     * @returns {{count:number, lastUpdate:number|null, error:string|null}}
     *   A dead layer must be distinguishable from an empty one: a failed load
     *   surfaces `error` (manager chip → UNAVAILABLE) instead of reporting a
     *   silent zero count as nominal.
     */
    getStats: () => {
      return { count: _count, lastUpdate: _lastUpdate, error: _error };
    },

    enable: async (viewer) => {
      if (_destroyed) return;
      _enabled = true;
      _stemGeometryDirty = true;
      _lastVisibilityUpdate = Number.NEGATIVE_INFINITY;
      _groundRetryArms = 0; // fresh give-up budget per enable-cycle
      _lastGroundSampleCapability = null;
      _overlayPublisher.show();

      // 1. Initialize data source
      if (!_dataSource) {
        const baseColor = Cesium.Color.fromCssColorString(color);

        // Fetch and parse JSON Lines (.geojsonl) into a FeatureCollection.
        // The source is built into a local and committed to `_dataSource`
        // only once setup finishes: a half-built source published early would
        // make every later enable() skip this block, so the layer could never
        // clear its error or retry.
        _error = null;
        let loaded = null;
        // Whether the scene has actually accepted `loaded` — the two rollback
        // windows (before vs after the add settles) need different cleanup.
        let addedToScene = false;
        try {
          const response = await fetch(url);
          // A 404 returns an HTML body that would otherwise die in JSON.parse
          // one line later, reported as a parse error for a missing file.
          if (!response.ok) {
            throw new Error(`HTTP ${response.status ?? '?'}`);
          }
          const text = await response.text();
          const lines = text.split('\n').filter(l => l.trim().length > 0);
          
          const features = lines.map(line => JSON.parse(line));
          
          const geojson = {
            type: 'FeatureCollection',
            features
          };

          // Natively parse into entities and use it as our _dataSource
          loaded = await Cesium.GeoJsonDataSource.load(geojson, {
            clampToGround: true,
            stroke: baseColor,
            fill: baseColor.withAlpha(0.3),
            strokeWidth: 2,
            markerSize: 8,
            markerColor: baseColor,
          });

          loaded.name = name;
          loaded.show = false;
          // Cesium's DataSourceCollection.add() returns a promise and only
          // inserts on a later microtask. Without this await, a throw during
          // post-processing would roll back a source the scene had not
          // accepted yet — and Cesium would then insert the "removed" source
          // anyway, leaving an orphan the retry would double up on. Awaiting
          // also routes an add() rejection into the error path below instead
          // of leaving it uncaught with healthy-looking stats.
          await viewer.dataSources.add(loaded);
          addedToScene = true;

          // Convert parsed points into 3D stems or style polygons
          const entities = loaded.entities.values;
          _count = entities.length;
          _stemRecords = [];
          _stemGeometryDirty = true;
          
          for (let i = 0; i < entities.length; i++) {
            const feature = entities[i];
            feature.__localLayerId = id; // Tag it so our click handler knows it belongs to this layer
            
            let pos = feature.position?.getValue(Cesium.JulianDate.now());
            
            if (!pos) {
              // It's a polygon or line
              if (feature.polygon) {
                feature.polygon.outline = true;
                feature.polygon.outlineColor = baseColor;
                
                // Calculate center point for the stem
                const hierarchy = feature.polygon.hierarchy?.getValue(Cesium.JulianDate.now());
                if (hierarchy && hierarchy.positions && hierarchy.positions.length > 0) {
                  pos = Cesium.BoundingSphere.fromPoints(hierarchy.positions).center;
                }
              }
            }

            if (!pos) continue;

            const carto = Cesium.Cartographic.fromCartesian(pos);
            const groundHeight = 0; // Ellipsoid surface until a scene sample lands
            const tipHeight = 2000; // Initial Stem height

            const base = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, groundHeight);
            const tip = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, tipHeight);
            const properties = propertyObject(feature);
            const recordId = String(feature.id ?? i);

            // Store references for bounded stem scaling and native picking.
            feature.__localBaseCarto = carto;
            feature.__localBaseCartesian = base;
            registerEntityContext(feature, {
              id: `${id}:${recordId}`,
              layerId: id,
              layerName: name,
              source,
              dataSource: loaded,
              label: featureLabelFromProperties(properties, id),
              properties,
              latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(6)),
              longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(6)),
            });

            // Constant properties are refreshed on the existing 450 ms source
            // cadence. Cesium no longer evaluates 2-3 callbacks per entity on
            // every frame, while the point/stem pick surface stays native.
            feature.position = tip;
            const stemPositionBuffers = [[base, tip], [base, tip]];
            feature.polyline = new Cesium.PolylineGraphics({
              positions: stemPositionBuffers[0],
              width: 3.5,
              material: new Cesium.ColorMaterialProperty(baseColor),
            });
            feature.point = new Cesium.PointGraphics({
              pixelSize: 10,
              color: baseColor,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              // Never depth-cull the anchor against the photoreal mesh —
              // globe-horizon culling is handled by the pre-render occluder.
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            });

            const priority = labelPriorityFromProperties(properties, id);
            _stemRecords.push({
              id: recordId,
              entity: feature,
              carto,
              base,
              tip,
              nextTip: Cesium.Cartesian3.clone(tip),
              stemPositionBuffers,
              stemPositionBufferIndex: 0,
              groundHeight,
              groundSampled: false,
              lastGroundSampleMs: 0,
              priority,
              entry: labels ? createLocalInfrastructureOverlayEntry({
                id: recordId,
                layerId: id,
                position: tip,
                properties,
                priority,
                accent: color,
              }) : null,
            });
          }
          // Setup finished — publish it.
          _dataSource = loaded;
          _lastUpdate = Date.now();
        } catch (e) {
          // The dataset ships with the build, so this is a broken install,
          // not a blip — it has to reach the chip, not just the console.
          _error = localDatasetError(e);
          // Roll the partial build back so a later enable() retries from
          // scratch instead of inheriting a half-populated source. Only the
          // post-add window has something in the scene to remove: a failure
          // before (or inside) add() never reached the collection, and
          // removing then would race Cesium's pending insert.
          if (addedToScene) {
            try { viewer?.dataSources?.remove(loaded, true); } catch { /* already gone */ }
          }
          _count = 0;
          _stemRecords = [];
          console.error(`Failed to load ${id}:`, e);
        }

        // 2. Install native global click handler
        if (!_clickHandler) {
          _clickHandler = screenSpaceEventHandlerFactory(viewer.scene.canvas);
          _clickHandler.setInputAction((click) => {
            if (!_enabled) return;
            const picked = viewer.scene.pick(click.position);
            
            if (picked && picked.id && picked.id.__localLayerId === id) {
              const entity = picked.id;
              viewer.selectedEntity = entity;
              selectEntityContext(entity);
              
              // We zoom to the surface base of the stem or the center of the polygon
              let targetPos = null;
              
              if (entity.polyline) {
                // If it's a stem, fly to the base
                const positions = entity.polyline.positions.getValue(Cesium.JulianDate.now());
                if (positions && positions.length > 0) {
                  targetPos = positions[0];
                }
              } else if (entity.polygon && entity.polygon.hierarchy) {
                // If it's a polygon, just fly to its center
                const hierarchy = entity.polygon.hierarchy.getValue(Cesium.JulianDate.now());
                if (hierarchy && hierarchy.positions.length > 0) {
                  targetPos = Cesium.BoundingSphere.fromPoints(hierarchy.positions).center;
                }
              }
              
              if (targetPos) {
                const carto = Cesium.Cartographic.fromCartesian(targetPos);
                
                // Disable interactions so Cesium doesn't magically cancel the flight
                viewer.scene.screenSpaceCameraController.enableInputs = false;
                
                viewer.camera.flyTo({
                  destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 5000),
                  duration: 1.5,
                  complete: () => { viewer.scene.screenSpaceCameraController.enableInputs = true; },
                  cancel: () => { viewer.scene.screenSpaceCameraController.enableInputs = true; },
                });
              }
            }
          }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
        }
      }

      // 3. Add an incredibly fast pre-render occluder to hide points behind the globe
      if (_enabled && !_preRenderRemover) {
        _preRenderRemover = viewer.scene.preRender.addEventListener(() => {
          if (!_enabled || !_dataSource) return;
          const now = performance.now();
          if (now - _lastVisibilityUpdate < VISIBILITY_UPDATE_MS) return;
          _lastVisibilityUpdate = now;

          const cameraPos = viewer.camera.positionWC;
          if (!cameraPos) return;
          
          const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, cameraPos);
          const visibleOverlayRecords = [];
          const refreshStemGeometry = _stemGeometryDirty;
          
          // A scene that cannot sample heights can never ground a record, so it
          // must never arm a retry (the arm would re-arm on every requested
          // frame, forever) and must not spend ANY per-record work trying.
          // Read once per walk, not per record.
          const canSampleGround = viewer.scene.sampleHeightSupported === true;
          // Capability can arrive late (WebGL context restore, a tileset that
          // finally supports sampling). A parked camera has no moveEnd to
          // re-open a spent budget, so the false→true edge does it.
          if (canSampleGround && _lastGroundSampleCapability === false) _groundRetryArms = 0;
          _lastGroundSampleCapability = canSampleGround;
          let groundRetryPending = false;
          let groundSampleProgress = false;
          for (let i = 0; i < _stemRecords.length; i++) {
            const record = _stemRecords[i];
            const wasGroundSampled = record.groundSampled;
            if (refreshStemGeometry) {
              updateLocalStemGeometry(viewer, record, now);
            } else if (canSampleGround && !record.groundSampled
              && now - record.lastGroundSampleMs >= GROUND_SAMPLE_RETRY_MS) {
              // Capability first: without it the distance below is pure waste,
              // once per ungrounded record per walk, forever.
              const distance = Cesium.Cartesian3.distance(viewer.camera.positionWC, record.base);
              if (distance < GROUND_SAMPLE_MAX_DISTANCE_M
                && sampleLocalGroundHeight(viewer, record, now)) {
                updateLocalStemGeometry(viewer, record, now, distance);
              }
            }
            if (!wasGroundSampled && record.groundSampled) groundSampleProgress = true;
            // Still unsampled AND close enough for a retry to succeed: this
            // layer has no hold and no periodic update, so under the idle
            // governor the retry's preRender never arrives on a parked camera
            // and the stem stays at ellipsoid height (buried/floating) until
            // the user happens to move. Schedule the frame the retry needs.
            // Gated on a sampleable scene and in-range records only, so a far
            // camera (or a keyless scene) stays fully idle; the distance is
            // only computed for still-unsampled stems.
            if (canSampleGround && !record.groundSampled && !groundRetryPending
              && Cesium.Cartesian3.distance(viewer.camera.positionWC, record.base)
                < GROUND_SAMPLE_MAX_DISTANCE_M) {
              groundRetryPending = true;
            }
            const isVisible = occluder.isPointVisible(record.base);
            if (record.entity.show !== isVisible) record.entity.show = isVisible;
            if (isVisible && record.entry) visibleOverlayRecords.push(record);
          }
          _stemGeometryDirty = false;
          // Tiles ARE streaming in: real progress re-opens the give-up budget
          // so the records still waiting get their own bounded run of retries.
          if (groundSampleProgress) _groundRetryArms = 0;
          if (groundRetryPending) scheduleGroundRetryRender(viewer);

          const canvas = viewer.scene.canvas;
          const cohort = selectLocalInfrastructureOverlayCohort(visibleOverlayRecords, {
            maxEntries: labelMax,
            gridPx: labelGridPx,
            width: canvas.clientWidth || canvas.width || 0,
            height: canvas.clientHeight || canvas.height || 0,
            cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
            project: (record) => projectToWindow(viewer.scene, record.tip),
          });
          _overlayPublisher.publish(cohort);
        });
      }
      if (_enabled && !_cameraMoveEndRemover) {
        _cameraMoveEndRemover = viewer.camera.moveEnd.addEventListener(() => {
          if (!_enabled) return;
          _stemGeometryDirty = true;
          _lastVisibilityUpdate = Number.NEGATIVE_INFINITY;
          // Real camera motion is a fresh situation (new tiles, new distances)
          // and its frames are free, so it re-opens the retry budget that a
          // parked camera may have spent.
          _groundRetryArms = 0;
          viewer.scene.requestRender?.();
        });
      }

      // Honor a disable() that landed while we were awaiting the fetch/parse:
      // disable() runs before _dataSource exists, so its show=false is a no-op —
      // reading _enabled here (rather than forcing true) respects the toggle-off.
      if (_dataSource) _dataSource.show = _enabled;
      viewer.scene.requestRender?.();
    },

    disable: disableLayer,

    destroy: (viewer) => {
      if (_destroyed) return;
      _destroyed = true;
      // Defensively disable first so listeners and selection state are
      // torn down even if destroy is called while the layer is enabled.
      disableLayer(viewer);
      if (_clickHandler) {
        _clickHandler.destroy();
        _clickHandler = null;
      }
      if (_dataSource && viewer) {
        viewer.dataSources.remove(_dataSource, true);
      }
      _overlayPublisher.destroy();
      _dataSource = null;
      _stemRecords = [];
      _count = 0;
      _lastUpdate = null;
      _error = null;
    }
  };
}

function compareLocalOverlayRecords(a, b) {
  return b.priority - a.priority || String(a.id).localeCompare(String(b.id));
}

function insertLocalCellContender(contenders, record) {
  let index = 0;
  while (index < contenders.length && compareLocalOverlayRecords(contenders[index], record) <= 0) {
    index++;
  }
  contenders.splice(index, 0, record);
  if (contenders.length > LOCAL_OVERLAY_CELL_SURPLUS) contenders.length = LOCAL_OVERLAY_CELL_SURPLUS;
}

function sampleLocalGroundHeight(viewer, record, now) {
  if (record.groundSampled || !viewer.scene.sampleHeightSupported) return false;
  if (now - record.lastGroundSampleMs < GROUND_SAMPLE_RETRY_MS) return false;
  record.lastGroundSampleMs = now;
  let sampled;
  try {
    sampled = viewer.scene.sampleHeight(record.carto, [record.entity]);
  } catch {
    return false; // tiles not ready; retry on a later bounded update
  }
  if (!Number.isFinite(sampled) || Math.abs(sampled) > GROUND_SAMPLE_MAX_ABS_HEIGHT_M) return false;
  record.groundSampled = true;
  record.groundHeight = sampled;
  Cesium.Cartesian3.fromRadians(
    record.carto.longitude,
    record.carto.latitude,
    record.groundHeight,
    Cesium.Ellipsoid.WGS84,
    record.base,
  );
  record.entity.__localBaseCartesian = record.base;
  return true;
}

function updateLocalStemGeometry(viewer, record, now, knownDistance = null) {
  const distance = Number.isFinite(knownDistance)
    ? knownDistance
    : Cesium.Cartesian3.distance(viewer.camera.positionWC, record.base);
  if (distance < GROUND_SAMPLE_MAX_DISTANCE_M) sampleLocalGroundHeight(viewer, record, now);
  const effectiveDistance = Math.max(distance, 5000);
  const canvasHeight = viewer.scene.canvas.clientHeight || 1080;
  const fov = viewer.camera.frustum.fov || (Math.PI / 3);
  const targetPx = 65;
  const fovFactor = 2 * Math.tan(fov / 2) * (targetPx / canvasHeight);
  const tipHeight = record.groundHeight + effectiveDistance * fovFactor;
  Cesium.Cartesian3.fromRadians(
    record.carto.longitude,
    record.carto.latitude,
    tipHeight,
    Cesium.Ellipsoid.WGS84,
    record.nextTip,
  );
  if (Cesium.Cartesian3.distanceSquared(record.tip, record.nextTip) <= LOCAL_STEM_TIP_EPSILON_SQ) {
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

function featureLabelFromProperties(props, layerId) {
  const tags = props.tags || {};

  const candidates = [
    props.name,
    tags.name,
    tags['name:en'],
    tags.official_name,
    tags.operator,
    tags['operator:short'],
    props.operator,
    props.output ? `${layerTitle(layerId)} ${props.output}` : '',
    props.osm_id ? `${layerTitle(layerId)} ${props.osm_id}` : '',
  ];

  const text = candidates.map(cleanLabel).find(Boolean);
  return clampLabel(text || layerTitle(layerId));
}

function labelPriorityFromProperties(props, layerId) {
  const tags = props.tags || {};

  let score = 0;
  if (cleanLabel(props.name) || cleanLabel(tags.name)) score += 1000;
  if (cleanLabel(tags['name:en'])) score += 700;
  if (cleanLabel(tags.operator) || cleanLabel(props.operator)) score += 180;
  if (props.output || tags['plant:output:electricity']) score += 120;
  if (layerId === 'local-dams') score += 80;
  if (layerId === 'local-datacenters') score += 60;
  return score;
}

function propertyObject(entity) {
  const source = entity?.properties;
  const raw = typeof source?.getValue === 'function'
    ? source.getValue(Cesium.JulianDate.now())
    : source || {};
  return unwrapProperties(raw);
}

function unwrapProperties(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(unwrapProperties);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = entry && typeof entry.getValue === 'function'
      ? unwrapProperties(entry.getValue(Cesium.JulianDate.now()))
      : unwrapProperties(entry);
  }
  return out;
}

function cleanLabel(value) {
  const text = String(value || '').trim();
  if (!text || text === 'undefined' || text === 'null') return '';
  return text;
}

function firstClean(values) {
  return values.map(cleanLabel).find(Boolean) || '';
}

function clampLabel(value) {
  const text = cleanLabel(value);
  return text.length > 34 ? `${text.slice(0, 31)}...` : text;
}

function clampCardLine(value) {
  const text = cleanLabel(value);
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function layerTitle(layerId) {
  if (layerId === 'local-datacenters') return 'Datacenter';
  if (layerId === 'local-dams') return 'Dam';
  return 'Feature';
}
