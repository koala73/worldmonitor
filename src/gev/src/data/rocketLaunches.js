import * as Cesium from 'cesium';
import {
  findSatelliteOrbitTrackInTle,
  getSatelliteOrbitTrack,
  orbitFrameModelMatrix,
} from './satellites.js';
import { getKeyholeGeometry } from '../celestialRing.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';

const WINDOW_DAYS = 30;
const API_URL = '/api/gev/launches';

export const ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID = 'rocket-missions';
export const ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID = 'rocket-mission-selected';
export const ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT = 48;
export const ROCKET_MISSION_AMBIENT_OVERLAY_COLLISION_CAPACITY = 24;
export const ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 12,
  collisionCapacity: 0,
  moving: true,
  solveIntervalMs: 0,
});

const ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
  collisionCapacity: ROCKET_MISSION_AMBIENT_OVERLAY_COLLISION_CAPACITY,
  moving: false,
});
const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

let _dataSource = null;
let _count = 0;
let _lastUpdate = null;
let _lastError = null;
let _orbitMatches = 0;
let _clickHandler = null;
let _moveHandler = null;
let _viewer = null;
let _declutterHandler = null;
let _dataManager = null;
let _retryTimer = null;
let _postTleRetryCount = 0;
let _updatePromise = null;
let _updatePromiseToken = 0;
let _updateDirty = false;
let _lifecycleToken = 0;
let _enabled = false;
let _selectedLaunchId = null;
let _explicitSelection = false;
let _launches = [];
let _missionPanel = null;
let _missionRoster = null;
let _missionRosterHoverTimer = null;
let _hoveredRosterLaunchId = null;
let _missionHoverReticleImage = null;
let _replayVehicleOverlay = null;
let _replayVehicleOverlayText = '';
const _animationStarts = new Map();
const _satelliteTelemetry = new Map();
let _lastPanelTelemetryMs = 0;
let _lastMissionRingRotationMs = 0;
let _activeTleText = null;
let _activeTlePromise = null;
let _activeTlePromiseToken = 0;
let _renderedTleText = null;
let _focusAfterActiveLookup = false;
let _satelliteStateBeforeMission = null;
let _satelliteActivationPromise = null;
let _replayCameraRemover = null;
let _replayCameraLaunchId = null;
let _replayCameraToken = 0;
let _replayPaused = false;
let _replayPausedAtMs = null;
let _replaySpeed = 1;
const _replayTracks = new Map();
const _missionOverlayRecords = new Map();
let _missionOverlayHost = DEFAULT_OVERLAY_HOST;
let _selectedMissionOverlayTimeText = null;
let _missionZoomAnchorRemover = null;
let _missionZoomAnchorId = null;
let _launchPadZonePrimitive = null;
let _launchPadZoneRemover = null;
let _launchPadZoneLaunchId = null;
const _missionOrbitPrimitives = new Map();

const REPLAY_ASCENT_FALLBACK_SEC = 12;
const REPLAY_ASCENT_MIN_SEC = 8;
const REPLAY_ASCENT_MAX_SEC = 36;
const REPLAY_ORBIT_DURATION_SEC = 28;
const REPLAY_COUNTDOWN_DURATION_SEC = 10;
const REPLAY_TILE_SETTLE_DELAY_SEC = 5;
const REPLAY_INITIAL_RANGE_M = 3500;
const REPLAY_LOCAL_MAX_RANGE_M = 900000;
const REPLAY_CONTEXT_MAX_RANGE_M = 2400000;
const REPLAY_CONTEXT_ALTITUDE_END_M = 420000;
const REPLAY_ORBIT_GLOBE_RANGE_M = 18000000;
const REPLAY_ORBIT_PULLBACK_FRACTION = 0.2;
const REPLAY_ASCENT_CAMERA_OFFSET_RAD = Cesium.Math.toRadians(30);
const REPLAY_ORBIT_CAMERA_OFFSET_RAD = Cesium.Math.toRadians(45);
const REPLAY_ORBIT_FRAME_CENTER_BLEND = 0.45;
const REPLAY_SPEED_MIN = 0.25;
const REPLAY_SPEED_MAX = 4;
const REPLAY_SPEED_STEP = 0.25;
const MAX_POST_TLE_RETRIES = 1;
const POST_TLE_RETRY_DELAY_MS = 1500;
const _declutterTime = new Cesium.JulianDate();
const _declutterOccluder = new Cesium.EllipsoidalOccluder(
  Cesium.Ellipsoid.WGS84,
  new Cesium.Cartesian3(),
);
const _missionRingDate = new Date(0);
const EARTH_ROTATION_RAD_PER_SEC = Cesium.Math.TWO_PI / 86164.0905;
const PROJECTED_ASCENT_ROTATION_SEC = 600;
const STAGE_REENTRY_ALTITUDE_M = 100000;
const MISSION_CLOSE_VIEW_RANGE_M = 180000;
const MISSION_GLOBE_VIEW_RANGE_M = 5000000;
const MISSION_FOCUS_RANGE_M = 12000;
const SATELLITE_STANDALONE_DEFAULTS = {
  catalog: 'core',
  showPoints: true,
  showOrbits: true,
};

/**
 * Derive the temporary Satellite display mode required by Space Missions.
 * @param {object|null} currentParams Complete pre-mission Satellite parameters.
 * @returns {object} Temporary mission-specific Satellite parameters.
 */
export function satelliteParamsForSpaceMissions(currentParams) {
  return {
    ...SATELLITE_STANDALONE_DEFAULTS,
    ...(currentParams || {}),
    catalog: 'dense',
    showPoints: false,
    showOrbits: false,
  };
}

/**
 * Resolve the complete Satellite parameter set restored after mission mode.
 * @param {object|null} snapshot Complete pre-mission Satellite parameters.
 * @returns {object} Standalone Satellite parameters.
 */
export function satelliteParamsAfterSpaceMissions(snapshot) {
  return {
    ...SATELLITE_STANDALONE_DEFAULTS,
    ...(snapshot || {}),
  };
}

/**
 * Failed launch records may retain a planned orbit in Launch Library, but
 * must not be represented as a live or estimated payload in orbit.
 * @param {string|null} status Normalized Launch Library status name.
 * @returns {boolean} Whether orbital visualization is allowed.
 */
export function launchStatusAllowsOrbit(status) {
  return !/\b(?:fail(?:ed|ure)?|partial failure)\b/i.test(String(status || ''));
}

/**
 * Describe only the mission paths that the selected record can actually show.
 * Launch Library may retain a target orbit after a failure, but that target is
 * not evidence of orbital insertion and cannot support a reconstructed replay.
 * @param {object|null} launch Normalized launch record.
 * @param {boolean} replayAvailable Whether a rendered ascent/orbit track exists.
 * @returns {{orbit: string|null, ascent: string, replayAvailable: boolean}}
 */
export function missionPathPresentation(launch, replayAvailable = false) {
  const orbitName = launch?.orbit?.name || (typeof launch?.orbit === 'string' ? launch.orbit : null);
  const orbitAllowed = launchStatusAllowsOrbit(launch?.status);
  const suppliedTrajectoryPoints = Array.isArray(launch?.trajectory)
    ? launch.trajectory.filter((point) => (
      Number.isFinite(Number(point?.latitude))
      && Number.isFinite(Number(point?.longitude))
    )).length
    : 0;
  return {
    orbit: orbitName ? `${orbitAllowed ? '' : 'PLANNED · '}${orbitName}` : null,
    ascent: suppliedTrajectoryPoints > 1
      ? 'SUPPLIED TRAJECTORY POINTS'
      : replayAvailable ? 'RECONSTRUCTED ESTIMATE' : 'UNAVAILABLE',
    replayAvailable: Boolean(replayAvailable),
  };
}

/**
 * Decide whether one bounded rebuild is needed after the active TLE lookup.
 * @param {object} input Retry state.
 * @param {boolean} input.enabled Whether Space Missions is active.
 * @param {number} input.retryCount Number of post-TLE retries already used.
 * @param {string|null} input.activeTleText Resolved active TLE catalog.
 * @param {string|null} input.renderedTleText TLE catalog used for the last build.
 * @returns {boolean} Whether to schedule a refresh.
 */
export function shouldRetryAfterActiveTle({
  enabled,
  retryCount,
  activeTleText,
  renderedTleText,
}) {
  return Boolean(
    enabled
    && activeTleText
    && activeTleText !== renderedTleText
    && retryCount < MAX_POST_TLE_RETRIES,
  );
}

/**
 * Release aircraft follow state through each owning flight layer before a
 * mission replay takes over the camera.
 * @param {object|null} dataManager DataLayerManager instance.
 * @returns {number} Number of owner APIs invoked.
 */
export function releaseAircraftTracking(dataManager) {
  let released = 0;
  for (const layerId of ['flights', 'military']) {
    const module = dataManager?.layers?.get(layerId)?.module;
    if (typeof module?.stopTracking !== 'function') continue;
    module.stopTracking();
    released++;
  }
  return released;
}
const MISSION_ORBIT_PATTERN_GROUPS = 4;
const MISSION_ORBIT_DASHES_PER_GROUP = 100;
export const LAUNCH_PAD_ZONE_RADIUS_M = 500;
const LAUNCH_PAD_ZONE_MAX_CAMERA_HEIGHT_M = 120000;
const LAUNCH_PAD_ZONE_MAX_CAMERA_DISTANCE_M = 180000;

const TRAJECTORY_STAGE_COLORS = [
  '#ff9f43', '#ff66c4', '#a78bfa', '#7bed9f', '#ffd166', '#60a5fa',
];

let _missionOrbitPatternRegistered = false;
const _pathDistanceCache = new WeakMap();

/**
 * Register the selected-orbit tactical material once. Each group begins with
 * one compact round dot followed by one hundred short dashes.
 */
function ensureMissionOrbitPatternRegistered() {
  if (_missionOrbitPatternRegistered) return;
  new Cesium.Material({
    fabric: {
      type: 'GevMissionOrbitTactical',
      uniforms: {
        color: Cesium.Color.CYAN,
        groupCount: MISSION_ORBIT_PATTERN_GROUPS,
        dashCount: MISSION_ORBIT_DASHES_PER_GROUP,
      },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material material = czm_getDefaultMaterial(materialInput);
          float groupPosition = fract(materialInput.st.s * groupCount);
          float markPosition = groupPosition * (dashCount + 1.0);
          float markIndex = floor(markPosition);
          float localPosition = fract(markPosition);
          float centerDistance = abs(localPosition - 0.5);
          float edge = max(fwidth(localPosition) * 1.35, 0.012);
          float dashAlong = 1.0 - smoothstep(0.27 - edge, 0.27 + edge, centerDistance);
          float dashAcross = 1.0 - smoothstep(0.12, 0.24, abs(materialInput.st.t - 0.5));
          float dash = dashAlong * dashAcross;
          float dotAlong = (localPosition - 0.5) / 0.32;
          float dotAcross = (materialInput.st.t - 0.5) / 0.5;
          float dot = 1.0 - smoothstep(0.78, 1.0, length(vec2(dotAlong, dotAcross)));
          float isDot = 1.0 - step(0.5, markIndex);
          float visible = mix(dash, dot, isDot);
          material.diffuse = color.rgb;
          material.emission = color.rgb * mix(0.07, 0.65, isDot);
          material.alpha = color.a * visible * mix(0.58, 1.0, isDot);
          return material;
        }`,
    },
  });
  _missionOrbitPatternRegistered = true;
}

function createMissionOrbitPatternMaterial(color) {
  ensureMissionOrbitPatternRegistered();
  return Cesium.Material.fromType('GevMissionOrbitTactical', {
    color,
    groupCount: MISSION_ORBIT_PATTERN_GROUPS,
    dashCount: MISSION_ORBIT_DASHES_PER_GROUP,
  });
}

function missionOrbitPrimitiveVisible(launchId) {
  return Boolean(
    _enabled
    && _dataSource?.show
    && (!_selectedLaunchId || _selectedLaunchId === launchId),
  );
}

function syncMissionOrbitPrimitiveVisibility() {
  for (const [launchId, path] of _missionOrbitPrimitives) {
    if (path.primitive) path.primitive.show = missionOrbitPrimitiveVisible(launchId);
  }
}

function removeMissionOrbitPrimitives() {
  for (const path of _missionOrbitPrimitives.values()) {
    if (path.primitive && _viewer?.scene?.primitives) {
      _viewer.scene.primitives.remove(path.primitive);
    }
  }
  _missionOrbitPrimitives.clear();
}

function updateMissionOrbitPrimitiveFrames(nowDate) {
  for (const [launchId, path] of _missionOrbitPrimitives) {
    if (!path.primitive || !missionOrbitPrimitiveVisible(launchId)) continue;
    orbitFrameModelMatrix(path.gmstAtBake, nowDate, path.primitive.modelMatrix);
    if (path.labelBakePosition && path.labelPosition) {
      Cesium.Matrix4.multiplyByPoint(
        path.primitive.modelMatrix,
        path.labelBakePosition,
        path.labelPosition,
      );
    }
  }
}

function addMissionOrbitPrimitive(launch, orbitPath, satelliteTrack) {
  if (!_viewer || !satelliteTrack || !Number.isFinite(satelliteTrack.gmstAtBake)) return false;
  const collection = new Cesium.PolylineCollection();
  collection.add({
    positions: orbitPath,
    width: 3,
    material: createMissionOrbitPatternMaterial(
      Cesium.Color.fromCssColorString('#22e6e6').withAlpha(0.95),
    ),
  });
  collection.show = missionOrbitPrimitiveVisible(launch.id);
  orbitFrameModelMatrix(satelliteTrack.gmstAtBake, new Date(), collection.modelMatrix);
  _viewer.scene.primitives.add(collection);
  _missionOrbitPrimitives.set(launch.id, {
    primitive: collection,
    gmstAtBake: satelliteTrack.gmstAtBake,
  });
  return true;
}

function MissionOrbitPatternMaterialProperty(color) {
  ensureMissionOrbitPatternRegistered();
  this._color = color;
  this._definitionChanged = new Cesium.Event();
}

Object.defineProperties(MissionOrbitPatternMaterialProperty.prototype, {
  isConstant: { get() { return true; } },
  definitionChanged: { get() { return this._definitionChanged; } },
});

MissionOrbitPatternMaterialProperty.prototype.getType = function getType() {
  return 'GevMissionOrbitTactical';
};

MissionOrbitPatternMaterialProperty.prototype.getValue = function getValue(time, result) {
  if (!Cesium.defined(result)) result = {};
  result.color = this._color;
  result.groupCount = MISSION_ORBIT_PATTERN_GROUPS;
  result.dashCount = MISSION_ORBIT_DASHES_PER_GROUP;
  return result;
};

MissionOrbitPatternMaterialProperty.prototype.equals = function equals(other) {
  return this === other;
};

/**
 * Decide whether the selected launch-pad zone belongs in the current view.
 * Both altitude and direct camera range are bounded so an oblique close-up can
 * show the effect without leaking it into regional or globe views.
 * @param {object} input Visibility inputs.
 * @param {boolean} input.layerActive Whether Space Missions is active.
 * @param {string|null} input.selectedLaunchId Selected mission identifier.
 * @param {string} input.launchId Candidate mission identifier.
 * @param {number} input.cameraHeightM Camera height above the ellipsoid.
 * @param {number} input.cameraDistanceM Direct camera range to the launch pad.
 * @returns {boolean}
 */
export function launchPadZoneVisible({
  layerActive,
  selectedLaunchId,
  launchId,
  cameraHeightM,
  cameraDistanceM,
}) {
  return Boolean(
    layerActive
    && selectedLaunchId
    && selectedLaunchId === launchId
    && Number.isFinite(cameraHeightM)
    && cameraHeightM <= LAUNCH_PAD_ZONE_MAX_CAMERA_HEIGHT_M
    && Number.isFinite(cameraDistanceM)
    && cameraDistanceM <= LAUNCH_PAD_ZONE_MAX_CAMERA_DISTANCE_M,
  );
}

/**
 * Resolve whether a surface mission anchor is safely on the camera-facing
 * side of Earth. The small positive limb margin prevents labels anchored just
 * beyond the horizon from leaking through the hidden Cesium globe.
 * @param {Cesium.Cartesian3} cameraPosition Camera world position.
 * @param {Cesium.Cartesian3} markerPosition Mission anchor world position.
 * @param {number} [limbMargin] Additional normalized horizon clearance.
 * @returns {boolean} Whether the marker belongs on the visible hemisphere.
 */
export function missionAnchorHorizonVisible(cameraPosition, markerPosition, limbMargin = 0.012) {
  if (!cameraPosition || !markerPosition) return false;
  const cameraMagnitude = Cesium.Cartesian3.magnitude(cameraPosition);
  if (!Number.isFinite(cameraMagnitude) || cameraMagnitude <= Cesium.Ellipsoid.WGS84.maximumRadius) {
    return false;
  }
  const cameraDirection = Cesium.Cartesian3.normalize(
    cameraPosition,
    new Cesium.Cartesian3(),
  );
  const markerDirection = Cesium.Cartesian3.normalize(
    markerPosition,
    new Cesium.Cartesian3(),
  );
  const limbThreshold = Cesium.Ellipsoid.WGS84.maximumRadius / cameraMagnitude;
  return Cesium.Cartesian3.dot(cameraDirection, markerDirection)
    > limbThreshold + limbMargin;
}

/**
 * Resolve launch-anchor visibility for overview and selected-mission views.
 * @param {Cesium.Cartesian3} cameraPosition Camera world position.
 * @param {Cesium.Cartesian3} markerPosition Mission anchor world position.
 * @param {string} markerId Mission represented by this anchor.
 * @param {string|null} selectedLaunchId Explicitly selected mission.
 * @returns {boolean} Whether the launch anchor should render.
 */
export function missionAnchorVisible(
  cameraPosition,
  markerPosition,
  markerId,
  selectedLaunchId = null,
) {
  if (selectedLaunchId && markerId !== selectedLaunchId) return false;
  return missionAnchorHorizonVisible(cameraPosition, markerPosition);
}

function focusFullGlobe(viewer, duration = 2.4) {
  const canvas = viewer?.scene?.canvas;
  const height = canvas?.clientHeight || canvas?.height;
  const width = canvas?.clientWidth || canvas?.width;
  const cartographic = viewer?.camera?.positionCartographic;
  const fovy = viewer?.camera?.frustum?.fovy;
  if (!(width > 0) || !(height > 0) || !cartographic || !Number.isFinite(fovy) || fovy <= 0 || fovy >= Math.PI) return;
  const earthRadius = Cesium.Ellipsoid.WGS84.maximumRadius;
  const keyholeRadius = getKeyholeGeometry(width, height).radius;
  const targetScreenRadius = keyholeRadius * 0.61;
  const angularRadius = Math.atan((targetScreenRadius / (height * 0.5)) * Math.tan(fovy * 0.5));
  const distance = earthRadius / Math.max(Math.sin(angularRadius), 1e-4);
  const altitude = Math.max(earthRadius * 1.55, distance - earthRadius);
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, altitude),
    orientation: { heading: viewer.camera.heading, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

function shortMissionLabel(name, maxLength = 24) {
  const text = String(name || 'Unnamed mission').replace(/\s+/g, ' ').trim().split(' | ')[0];
  const compact = text.split(' — ')[0].trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1).trimEnd()}…` : compact;
}

/**
 * Reduce generic launch-complex names to their identifying pad or area suffix.
 * @param {string|null} launchSite Launch Library pad name.
 * @returns {string|null} Compact launch-site identifier.
 */
export function compactLaunchSiteName(launchSite) {
  const text = String(launchSite || '').replace(/\s+/g, ' ').trim();
  if (!text || /^(unknown|unavailable|n\/a)$/i.test(text)) return null;
  const genericPrefix = /^(?:orbital\s+launch\s+pad|space\s+launch\s+complex|launch\s+(?:area|complex|pad|site))\s*[-·:]?\s*/i;
  const compact = text.replace(genericPrefix, '').trim();
  return compact || null;
}

/**
 * Build the source-owned launch-site marker presentation. Overview markers
 * compete in the bounded ambient-label domain; the selected mission moves to
 * the protected selected lane and gains the former launch-site detail line.
 * @param {object} launch Normalized Launch Library mission.
 * @param {Cesium.Cartesian3|function():Cesium.Cartesian3} position Existing display position.
 * @param {boolean} [selected=false] Whether the mission owns the selected view.
 * @returns {object}
 */
export function createRocketMissionMarkerOverlayEntry(launch, position, selected = false) {
  const mission = shortMissionLabel(launch?.name, 26).toUpperCase();
  const siteName = compactLaunchSiteName(launch?.launchSite);
  const launchTimeMs = Date.parse(launch?.launchTime);
  const details = selected
    ? [siteName
      ? `LAUNCH SITE · ${shortMissionLabel(siteName, 20).toUpperCase()}`
      : 'LAUNCH SITE']
    : [];
  return {
    id: `launch:${launch?.id}`,
    position,
    variant: 'label',
    title: mission,
    details,
    accent: '#22e6e6',
    priority: selected
      ? Number.MAX_SAFE_INTEGER
      : Number.isFinite(launchTimeMs) ? Math.floor(launchTimeMs / 1000) : 0,
    selected,
    protected: selected,
    paintLane: selected ? 'selected' : 'ambient-label',
    collisionGroup: 'ambient-label',
    interactive: false,
    distanceScale: {
      near: 1000,
      nearValue: 1.08,
      far: 20_000_000,
      farValue: 0.78,
    },
    gapPx: 12,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/**
 * Build one protected label belonging to the selected mission's trajectory,
 * live payload position, or orbit. Copy is already source-formatted by the
 * caller; newline semantics become explicit host detail rows.
 * @param {object} input
 * @param {string} input.id Stable mission-element identity.
 * @param {Cesium.Cartesian3|function():Cesium.Cartesian3} input.position Existing cached position.
 * @param {string} input.text Former native-label text, including newlines.
 * @param {string} input.accent Source-owned label color.
 * @param {number} [input.priority=0] Protected placement order.
 * @param {number} [input.gapPx=8] Anchor-to-label gap.
 * @returns {object}
 */
export function createRocketMissionElementOverlayEntry({
  id,
  position,
  text,
  accent,
  priority = 0,
  gapPx = 8,
}) {
  const [title, ...details] = String(text || '').split('\n');
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    details,
    accent,
    priority,
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-label',
    interactive: false,
    gapPx,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/** Keep the newest ambient mission markers with stable identity tie-breaking. */
export function selectRocketMissionMarkerOverlayCohort(
  entries,
  limit = ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(0, Math.min(
    ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
    Math.floor(Number(limit) || 0),
  ));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries.slice().sort((a, b) => (
    b.priority - a.priority || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}

function missionHoverReticleImage() {
  if (_missionHoverReticleImage) return _missionHoverReticleImage;
  const canvas = document.createElement('canvas');
  const size = 48;
  const inset = 6;
  const arm = 12;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  context.strokeStyle = '#22e6e6';
  context.lineWidth = 2;
  context.lineCap = 'square';
  context.shadowColor = 'rgba(34, 230, 230, .72)';
  context.shadowBlur = 5;
  context.beginPath();
  context.moveTo(inset, inset + arm);
  context.lineTo(inset, inset);
  context.lineTo(inset + arm, inset);
  context.moveTo(size - inset - arm, inset);
  context.lineTo(size - inset, inset);
  context.lineTo(size - inset, inset + arm);
  context.moveTo(inset, size - inset - arm);
  context.lineTo(inset, size - inset);
  context.lineTo(inset + arm, size - inset);
  context.moveTo(size - inset - arm, size - inset);
  context.lineTo(size - inset, size - inset);
  context.lineTo(size - inset, size - inset - arm);
  context.stroke();
  _missionHoverReticleImage = canvas;
  return canvas;
}

/**
 * Resolve the one permitted screen-space replay overlay state.
 * @param {object} input Overlay state.
 * @param {boolean} input.replayActive Whether replay owns the camera.
 * @param {boolean} input.ascending Whether the replay marker is on ascent.
 * @param {boolean} input.countdownActive Whether the T-minus hold is active.
 * @returns {'countdown'|'ascent'|'orbit'|null}
 */
export function replayOverlayMode({
  replayActive,
  ascending,
  countdownActive,
  preCountdownActive = false,
}) {
  if (!replayActive) return null;
  if (preCountdownActive) return null;
  if (countdownActive) return 'countdown';
  return ascending ? 'ascent' : 'orbit';
}

/**
 * Rotate an upright screen-space rocket so its nose follows a projected path.
 * @param {{x: number, y: number}} from Current screen point.
 * @param {{x: number, y: number}} to Forward screen point.
 * @returns {number} Clockwise CSS rotation in radians.
 */
export function replayVehicleScreenRotation(from, to) {
  const dx = Number(to?.x) - Number(from?.x);
  const dy = Number(to?.y) - Number(from?.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 0.01) return 0;
  return Math.atan2(dx, -dy);
}

/**
 * Reduce small screen-space reprojection jitter without allowing the marker
 * to lag behind a camera jump or a phase transition.
 * @param {{x:number,y:number}|null} previous Previous rendered position.
 * @param {{x:number,y:number}} next Current path projection.
 * @param {number} [alpha] Interpolation amount.
 * @param {number} [snapDistance] Maximum distance to smooth.
 * @returns {{x:number,y:number}}
 */
export function smoothReplayWindowPosition(
  previous,
  next,
  alpha = 0.55,
  snapDistance = 24,
) {
  if (!previous || !next) return next;
  const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
  if (!Number.isFinite(distance) || distance > snapDistance) return next;
  const amount = Cesium.Math.clamp(Number(alpha) || 0, 0, 1);
  return {
    x: Cesium.Math.lerp(previous.x, next.x, amount),
    y: Cesium.Math.lerp(previous.y, next.y, amount),
  };
}

function createReplayVehicleOverlay() {
  if (_replayVehicleOverlay || typeof document === 'undefined') return;
  const host = document.getElementById('cesiumContainer') || document.body;
  _replayVehicleOverlay = document.createElement('div');
  _replayVehicleOverlay.className = 'mission-replay-vehicle-overlay';
  _replayVehicleOverlay.hidden = true;
  _replayVehicleOverlay.setAttribute('aria-hidden', 'true');
  _replayVehicleOverlay.innerHTML = `
    <div class="mission-replay-flight-symbol">
      <svg class="mission-replay-rocket" viewBox="0 0 48 72" aria-hidden="true">
        <path class="mission-replay-rocket-body" d="M24 5C16 14 14 27 15 45L9 54L18 51L24 58L30 51L39 54L33 45C34 27 32 14 24 5Z"></path>
        <circle class="mission-replay-rocket-port" cx="24" cy="29" r="3.4"></circle>
      </svg>
      <svg class="mission-replay-thrust" viewBox="0 0 72 72" aria-hidden="true">
        <ellipse style="--thrust-index:0" cx="36" cy="7" rx="5" ry="1.8"></ellipse>
        <ellipse style="--thrust-index:1" cx="36" cy="15" rx="8" ry="2.4"></ellipse>
        <ellipse style="--thrust-index:2" cx="36" cy="24" rx="11" ry="3"></ellipse>
        <ellipse style="--thrust-index:3" cx="36" cy="35" rx="15" ry="3.8"></ellipse>
        <ellipse style="--thrust-index:4" cx="36" cy="48" rx="20" ry="4.7"></ellipse>
        <ellipse style="--thrust-index:5" cx="36" cy="63" rx="26" ry="5.8"></ellipse>
      </svg>
    </div>
    <div class="mission-replay-orbit-dot" aria-hidden="true"></div>
    <div class="mission-replay-overlay-callout">
      <strong data-replay-overlay-title></strong>
      <span data-replay-overlay-detail></span>
    </div>`;
  host.appendChild(_replayVehicleOverlay);
}

function hideReplayVehicleOverlay() {
  if (!_replayVehicleOverlay) return;
  _replayVehicleOverlay.hidden = true;
  _replayVehicleOverlay.classList.remove('is-thrusting', 'is-paused');
}

function destroyReplayVehicleOverlay() {
  _replayVehicleOverlay?.remove();
  _replayVehicleOverlay = null;
  _replayVehicleOverlayText = '';
}

/**
 * Score the amount of useful mission context available for roster triage.
 * @param {object} launch Normalized launch record.
 * @returns {number} Completeness score.
 */
export function missionDataCompleteness(launch = {}) {
  let score = 0;
  const present = (value) => value !== null && value !== undefined && value !== '';
  score += present(launch.provider) ? 1 : 0;
  score += present(launch.mission) ? 2 : 0;
  score += present(launch.missionName) ? 1 : 0;
  score += present(launch.orbit?.name || launch.orbit) ? 2 : 0;
  score += Array.isArray(launch.payloads) ? Math.min(launch.payloads.length, 5) * 2 : 0;
  score += Array.isArray(launch.recoveryStages) ? Math.min(launch.recoveryStages.length, 4) * 2 : 0;
  score += Array.isArray(launch.trajectory) ? Math.min(launch.trajectory.length, 12) : 0;
  score += Array.isArray(launch.timeline) ? Math.min(launch.timeline.length, 6) : 0;
  return score;
}

/**
 * Build a data-rich roster while preserving the source-array index
 * used by mission selection and Previous/Next navigation.
 * @param {Array<object>} launches Normalized launch records.
 * @returns {Array<{launch: object, index: number}>}
 */
export function missionRosterEntries(launches) {
  return (launches || [])
    .map((launch, index) => ({ launch, index }))
    .sort((a, b) => {
      const completeness = missionDataCompleteness(b.launch) - missionDataCompleteness(a.launch);
      if (completeness !== 0) return completeness;
      const aTime = Date.parse(a.launch?.launchTime);
      const bTime = Date.parse(b.launch?.launchTime);
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
      return b.index - a.index;
    });
}

/**
 * Preserve the user's globe scale for roster previews while avoiding an
 * accidental surface-level fly-to when the list is opened from a close view.
 * @param {number} cameraHeight Current camera height above the ellipsoid.
 * @returns {number} Preview range in metres.
 */
export function missionHoverPreviewRange(cameraHeight) {
  const height = Number(cameraHeight);
  return Math.max(
    MISSION_CLOSE_VIEW_RANGE_M,
    Number.isFinite(height) ? height : MISSION_GLOBE_VIEW_RANGE_M,
  );
}

/**
 * Format a mission epoch for compact on-globe replay labels.
 * @param {string|Date|null} launchTime ISO-8601 mission time or Date.
 * @returns {string} UTC timestamp or a clear unavailable state.
 */
export function formatMissionEventTime(launchTime) {
  const date = new Date(launchTime);
  if (!launchTime || !Number.isFinite(date.getTime())) return 'UNAVAILABLE';
  return `${date.toISOString().slice(0, 10)}\n${date.toISOString().slice(11, 19)} UTC`;
}

/**
 * Parse the ISO-8601 durations supplied by Launch Library timeline events.
 * @param {string|null} value ISO duration such as PT8M40S or -PT35M.
 * @returns {number|null} Signed duration in seconds.
 */
export function parseMissionDurationSeconds(value) {
  const match = String(value || '').trim().match(
    /^(-)?P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!match) return null;
  const seconds = (Number(match[2] || 0) * 86400)
    + (Number(match[3] || 0) * 3600)
    + (Number(match[4] || 0) * 60)
    + Number(match[5] || 0);
  return match[1] ? -seconds : seconds;
}

function orbitInsertionOffsetSeconds(launch) {
  const events = (launch.timeline || []).filter((event) => Number.isFinite(event.offsetSeconds) && event.offsetSeconds >= 0);
  if (!events.length) return null;
  const deployment = events.filter((event) => /deploy|payload separation|spacecraft separation|orbit insertion|injection/i.test(event.name));
  if (deployment.length) return Math.max(...deployment.map((event) => event.offsetSeconds));
  const engineCutoff = events.filter((event) => /seco|second engine cutoff/i.test(event.name));
  if (engineCutoff.length) return Math.max(...engineCutoff.map((event) => event.offsetSeconds));
  return Math.max(...events.map((event) => event.offsetSeconds));
}

function estimatedOrbitPeriodSeconds(orbitPath) {
  if (!orbitPath?.length) return 5400;
  const meanRadius = orbitPath.reduce((total, point) => total + Cesium.Cartesian3.magnitude(point), 0) / orbitPath.length;
  return 2 * Math.PI * Math.sqrt((meanRadius ** 3) / 3.986004418e14);
}

/**
 * Derive a compressed but mission-specific ascent replay duration.
 * Launch Library timelines are authoritative when they expose insertion,
 * SECO, or separation timing. Sparse records fall back to the reconstructed
 * path length and a conservative ascent velocity estimate.
 * @param {object} launch Normalized launch record.
 * @param {Cesium.Cartesian3[]} ascentPath Reconstructed or supplied ascent.
 * @returns {number} Replay duration in seconds.
 */
export function replayAscentDurationSeconds(launch, ascentPath = []) {
  const disclosedSeconds = orbitInsertionOffsetSeconds(launch);
  let realAscentSeconds = disclosedSeconds > 0 ? disclosedSeconds : null;
  if (!realAscentSeconds && ascentPath.length > 1) {
    const pathLength = ascentPath.slice(1).reduce(
      (total, point, index) => total + Cesium.Cartesian3.distance(ascentPath[index], point),
      0,
    );
    realAscentSeconds = Math.max(180, pathLength / 9000);
  }
  if (!realAscentSeconds) realAscentSeconds = REPLAY_ASCENT_FALLBACK_SEC * 50;
  return Cesium.Math.clamp(
    REPLAY_ASCENT_FALLBACK_SEC * (realAscentSeconds / 600),
    REPLAY_ASCENT_MIN_SEC,
    REPLAY_ASCENT_MAX_SEC,
  );
}

/**
 * Clamp and snap a replay speed multiplier to the supported slider range.
 * @param {number|string} value Requested playback multiplier.
 * @returns {number} Supported multiplier between 0.25x and 4x.
 */
export function normalizeReplaySpeed(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  const clamped = Cesium.Math.clamp(numeric, REPLAY_SPEED_MIN, REPLAY_SPEED_MAX);
  return Math.round(clamped / REPLAY_SPEED_STEP) * REPLAY_SPEED_STEP;
}

/**
 * Preserve replay elapsed time when resuming after a pause.
 * @param {number} startedAt Original replay start epoch in milliseconds.
 * @param {number} pausedAt Pause epoch in milliseconds.
 * @param {number} resumedAt Resume epoch in milliseconds.
 * @returns {number} Shifted start epoch.
 */
export function replayStartAfterPause(startedAt, pausedAt, resumedAt) {
  if (![startedAt, pausedAt, resumedAt].every(Number.isFinite)) return startedAt;
  return startedAt + Math.max(0, resumedAt - pausedAt);
}

export function replayState(
  launch,
  startedAt,
  ascentDurationSec,
  orbitDurationSec,
  orbitPeriodSec,
  speed = 1,
  nowMs = Date.now(),
  preCountdownDurationSec = 0,
  loop = true,
) {
  const animationDurationSec = ascentDurationSec + orbitDurationSec;
  const realSecondsSinceStart = (nowMs - startedAt) / 1000;
  const preCountdownDuration = Math.max(0, Number(preCountdownDurationSec) || 0);
  const preCountdownActive = preCountdownDuration > 0
    && realSecondsSinceStart < -preCountdownDuration;
  const countdownActive = realSecondsSinceStart < 0 && !preCountdownActive;
  const countdownSeconds = countdownActive ? Math.ceil(-realSecondsSinceStart) : 0;
  const elapsedSinceStart = Math.max(0, realSecondsSinceStart * normalizeReplaySpeed(speed));
  const elapsed = loop
    ? elapsedSinceStart % animationDurationSec
    : Math.min(elapsedSinceStart, Math.max(0, animationDurationSec - 1e-6));
  const insertionOffsetSec = orbitInsertionOffsetSeconds(launch);
  const ascending = elapsed < ascentDurationSec;
  const phaseProgress = ascending
    ? elapsed / ascentDurationSec
    : (elapsed - ascentDurationSec) / orbitDurationSec;
  const missionOffsetSec = insertionOffsetSec === null
    ? null
    : ascending
      ? phaseProgress * insertionOffsetSec
      : insertionOffsetSec + phaseProgress * orbitPeriodSec;
  const launchEpoch = Date.parse(launch.launchTime);
  const eventTime = Number.isFinite(launchEpoch) && missionOffsetSec !== null
    ? new Date(launchEpoch + missionOffsetSec * 1000)
    : null;
  return {
    ascending,
    phaseProgress,
    eventTime,
    elapsedSinceStart,
    countdownActive,
    preCountdownActive,
    countdownSeconds,
  };
}

export function approximateOrbitPath(launch) {
  if (!launch.orbit?.name || !Number.isFinite(launch.lat) || !Number.isFinite(launch.lon)) return null;
  const orbitName = launch.orbit.name.toLowerCase();
  const altitude = orbitName.includes('geostationary') || orbitName.includes('transfer') ? 35786000
    : orbitName.includes('medium') ? 20200000 : 550000;
  const radius = Cesium.Ellipsoid.WGS84.maximumRadius + altitude;
  const longitude = Cesium.Math.toRadians(launch.lon);
  const latitude = Cesium.Math.toRadians(launch.lat);
  const up = new Cesium.Cartesian3(
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
  );
  const east = new Cesium.Cartesian3(
    -Math.sin(longitude),
    Math.cos(longitude),
    0,
  );
  const north = new Cesium.Cartesian3(
    -Math.sin(latitude) * Math.cos(longitude),
    -Math.sin(latitude) * Math.sin(longitude),
    Math.cos(latitude),
  );
  const isPolar = orbitName.includes('polar') || orbitName.includes('sun');
  const isWesternNorthAmerica = launch.lat > 20 && launch.lat < 60
    && launch.lon > -140 && launch.lon < -105;
  const launchAzimuthDeg = isPolar
    ? (launch.lat >= 0 ? 180 : 0)
    : isWesternNorthAmerica ? 190 : 90;
  const launchAzimuth = Cesium.Math.toRadians(launchAzimuthDeg);
  const forward = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.add(
      Cesium.Cartesian3.multiplyByScalar(north, Math.cos(launchAzimuth), new Cesium.Cartesian3()),
      Cesium.Cartesian3.multiplyByScalar(east, Math.sin(launchAzimuth), new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  // A reconstructed orbit is an estimate, not a claim that the vehicle was
  // inserted directly above the pad. Offset the orbital plane downrange by a
  // small launch-to-insertion arc so a top-down view does not draw the entire
  // orbit on top of the launch site. The ascent still joins this ring at its
  // propagated insertion reference.
  const insertionArc = Cesium.Math.toRadians(isPolar ? 8 : 12);
  const orbitAnchor = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.add(
      Cesium.Cartesian3.multiplyByScalar(up, Math.cos(insertionArc), new Cesium.Cartesian3()),
      Cesium.Cartesian3.multiplyByScalar(forward, Math.sin(insertionArc), new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  const planeNormal = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(orbitAnchor, forward, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const crossTrack = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(planeNormal, orbitAnchor, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  return Array.from({ length: 97 }, (_, index) => {
    const angle = (index / 96) * Math.PI * 2;
    return new Cesium.Cartesian3(
      radius * (Math.cos(angle) * orbitAnchor.x + Math.sin(angle) * crossTrack.x),
      radius * (Math.cos(angle) * orbitAnchor.y + Math.sin(angle) * crossTrack.y),
      radius * (Math.cos(angle) * orbitAnchor.z + Math.sin(angle) * crossTrack.z),
    );
  });
}

function entityLaunchId(entity) {
  if (!entity?.id || typeof entity.id !== 'string') return null;
  const match = entity.id.match(/^rocket-[^:]+:([^:]+)/);
  return match?.[1] || null;
}

function clearMissionOverlaySources() {
  _selectedMissionOverlayTimeText = null;
  _missionOverlayHost.clearSource(ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID);
  _missionOverlayHost.setVisible(ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID, false);
  _missionOverlayHost.clearSource(ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID);
  _missionOverlayHost.setVisible(ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID, false);
}

function syncMissionOverlayEntries() {
  if (!_enabled || !_dataSource?.show) {
    clearMissionOverlaySources();
    return;
  }
  const selectedRecord = _selectedLaunchId
    ? _missionOverlayRecords.get(_selectedLaunchId)
    : null;
  if (selectedRecord) {
    _missionOverlayHost.clearSource(ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID);
    _missionOverlayHost.setVisible(ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID, false);
    const entries = selectedRecord.elementEntryFactories.map((createEntry) => createEntry());
    if (_replayCameraLaunchId !== selectedRecord.launch.id) {
      entries.unshift(createRocketMissionMarkerOverlayEntry(
        selectedRecord.launch,
        selectedRecord.anchorPosition,
        true,
      ));
    }
    _missionOverlayHost.setEntries(
      ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
      entries,
      ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
    _missionOverlayHost.setVisible(ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID, true);
    _selectedMissionOverlayTimeText = selectedRecord.liveEventTime
      ? formatMissionEventTime(selectedRecord.liveEventTime())
      : null;
    return;
  }

  _missionOverlayHost.clearSource(ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID);
  _missionOverlayHost.setVisible(ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID, false);
  _selectedMissionOverlayTimeText = null;
  const entries = selectRocketMissionMarkerOverlayCohort(
    Array.from(_missionOverlayRecords.values(), (record) => {
      const entry = createRocketMissionMarkerOverlayEntry(
        record.launch,
        record.anchorPosition,
      );
      if (record.launch.id === _hoveredRosterLaunchId) {
        entry.pinned = true;
        entry.priority = Number.MAX_SAFE_INTEGER - 1;
      }
      return entry;
    }),
  );
  _missionOverlayHost.setEntries(
    ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
    entries,
    ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_OPTIONS,
  );
  _missionOverlayHost.setVisible(ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID, true);
}

function refreshSelectedMissionOverlayText() {
  const selectedRecord = _selectedLaunchId
    ? _missionOverlayRecords.get(_selectedLaunchId)
    : null;
  if (!selectedRecord?.liveEventTime) return;
  const nextText = formatMissionEventTime(selectedRecord.liveEventTime());
  if (nextText !== _selectedMissionOverlayTimeText) syncMissionOverlayEntries();
}

function setSelectedMission(launchId, isolate = true) {
  if (launchId) clearMissionRosterHover();
  if (_replayCameraLaunchId && _replayCameraLaunchId !== launchId) stopMissionReplay();
  if (_missionZoomAnchorId && _missionZoomAnchorId !== launchId) stopMissionZoomAnchor();
  _selectedLaunchId = launchId;
  _explicitSelection = Boolean(launchId && isolate);
  if (launchId) _animationStarts.set(launchId, Date.now());
  if (!launchId && _viewer) {
    stopMissionZoomAnchor();
    _viewer.selectedEntity = undefined;
  }
  if (!_dataSource) return;
  for (const entity of _dataSource.entities.values) {
    const relatedId = entityLaunchId(entity);
    entity.show = launchId
      ? relatedId === launchId
      : entity.id.startsWith('rocket-launch:');
  }
  syncMissionOrbitPrimitiveVisibility();
  syncMissionOverlayEntries();
  renderMissionPanel();
}

function hideLaunchPadZone() {
  if (_launchPadZonePrimitive) _launchPadZonePrimitive.show = false;
}

function removeLaunchPadZonePrimitive() {
  if (_launchPadZonePrimitive && _viewer?.scene?.primitives) {
    _viewer.scene.primitives.remove(_launchPadZonePrimitive);
  }
  _launchPadZonePrimitive = null;
  _launchPadZoneLaunchId = null;
}

function createLaunchPadZonePrimitive(launch) {
  removeLaunchPadZonePrimitive();
  const material = new Cesium.Material({
    fabric: {
      type: 'GevLaunchPadZone',
      uniforms: {
        color: Cesium.Color.fromCssColorString('#22e6e6'),
        fillAlpha: 0.105,
        rimAlpha: 0.72,
      },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material material = czm_getDefaultMaterial(materialInput);
          vec2 centered = (materialInput.st - vec2(0.5)) * 2.0;
          float radius = length(centered);
          float inside = 1.0 - smoothstep(0.985, 1.0, radius);
          float rim = smoothstep(0.952, 0.985, radius) * inside;
          material.diffuse = color.rgb;
          material.emission = color.rgb * rim * 0.35;
          material.alpha = color.a * inside * mix(fillAlpha, rimAlpha, rim);
          return material;
        }`,
    },
  });
  const geometry = new Cesium.EllipseGeometry({
    center: Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat),
    semiMajorAxis: LAUNCH_PAD_ZONE_RADIUS_M,
    semiMinorAxis: LAUNCH_PAD_ZONE_RADIUS_M,
    granularity: Cesium.Math.toRadians(0.08),
    vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
  });
  _launchPadZonePrimitive = _viewer.scene.primitives.add(new Cesium.GroundPrimitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry,
      id: `rocket-pad-zone:${launch.id}`,
    }),
    appearance: new Cesium.MaterialAppearance({
      material,
      translucent: true,
      closed: false,
      faceForward: true,
      flat: true,
      // Keep the zone classified onto the photoreal surface, but bias only its
      // rasterized depth toward the camera. This avoids coplanar fragments
      // being intermittently buried by the launch-pad mesh at oblique angles
      // without adding a world-space height that would make the ring float.
      renderState: {
        depthTest: {
          enabled: true,
        },
        depthMask: false,
        polygonOffset: {
          enabled: true,
          factor: -1,
          units: -4,
        },
        blending: Cesium.BlendingState.ALPHA_BLEND,
      },
    }),
    classificationType: Cesium.ClassificationType.BOTH,
    asynchronous: true,
    show: true,
  }));
  _launchPadZoneLaunchId = launch.id;
}

function initLaunchPadZonePrimitive() {
  if (!_viewer || _launchPadZoneRemover) return;
  _launchPadZoneRemover = _viewer.scene.preRender.addEventListener(() => {
    if (!_enabled || !_dataSource?.show) {
      hideLaunchPadZone();
      return;
    }
    const nowMs = Date.now();
    if (nowMs - _lastMissionRingRotationMs >= 1000) {
      _missionRingDate.setTime(nowMs);
      updateMissionOrbitPrimitiveFrames(_missionRingDate);
      _lastMissionRingRotationMs = nowMs;
    }
    const launch = _launches.find((item) => item.id === _selectedLaunchId);
    const camera = _viewer?.camera;
    if (!launch || !camera) {
      hideLaunchPadZone();
      return;
    }
    const launchPosition = Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat);
    const visible = launchPadZoneVisible({
      layerActive: Boolean(_dataSource?.show),
      selectedLaunchId: _selectedLaunchId,
      launchId: launch.id,
      cameraHeightM: camera.positionCartographic?.height,
      cameraDistanceM: Cesium.Cartesian3.distance(camera.positionWC, launchPosition),
    });
    if (!visible) {
      hideLaunchPadZone();
      return;
    }
    if (_launchPadZoneLaunchId !== launch.id) createLaunchPadZonePrimitive(launch);
    _launchPadZonePrimitive.show = true;
  });
}

function destroyLaunchPadZonePrimitive() {
  if (_launchPadZoneRemover) _launchPadZoneRemover();
  _launchPadZoneRemover = null;
  removeLaunchPadZonePrimitive();
}

export function samplePath(path, progress, result) {
  if (!path?.length) return undefined;
  // Degenerate returns clone into `result` when provided — handing back a
  // path vertex would let an in-place caller mutate the path geometry.
  if (path.length === 1) return result ? Cesium.Cartesian3.clone(path[0], result) : path[0];
  let distances = _pathDistanceCache.get(path);
  if (!distances) {
    distances = new Float64Array(path.length);
    for (let index = 1; index < path.length; index++) {
      distances[index] = distances[index - 1]
        + Cesium.Cartesian3.distance(path[index - 1], path[index]);
    }
    _pathDistanceCache.set(path, distances);
  }
  const totalDistance = distances.at(-1);
  if (!(totalDistance > 0)) return result ? Cesium.Cartesian3.clone(path[0], result) : path[0];
  const targetDistance = Cesium.Math.clamp(progress, 0, 1) * totalDistance;
  let low = 1;
  let high = distances.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (distances[middle] < targetDistance) low = middle + 1;
    else high = middle;
  }
  const index = Math.max(0, low - 1);
  const segmentDistance = distances[index + 1] - distances[index];
  const segmentProgress = segmentDistance > 0
    ? (targetDistance - distances[index]) / segmentDistance
    : 0;
  return Cesium.Cartesian3.lerp(
    path[index],
    path[index + 1],
    segmentProgress,
    result || new Cesium.Cartesian3(),
  );
}

/**
 * Resolve a continuously advancing orbit fraction from a wall-clock epoch.
 * Fractional seconds prevent the selected satellite marker from jumping at
 * each second boundary and forcing a one-frame photoreal globe LOD pulse.
 * @param {number} nowMs Wall-clock epoch in milliseconds.
 * @param {number} periodSec Orbital period in seconds.
 * @returns {number} Normalized progress in the range [0, 1).
 */
export function orbitProgressAtTime(nowMs, periodSec) {
  const period = Math.max(1, Number(periodSec) || 1);
  return Cesium.Math.mod((Number(nowMs) || 0) / 1000, period) / period;
}

/**
 * Construct one continuous estimated climb from the pad to orbit insertion.
 * Horizontal movement begins much more slowly than altitude gain, preserving
 * the near-vertical launch appearance without a hard corner at 120 km.
 * @param {Cesium.Cartesian3} launchPosition Launch-pad position.
 * @param {Cesium.Cartesian3} insertionPosition Orbit insertion position.
 * @param {number} [samples] Number of curve intervals.
 * @returns {Cesium.Cartesian3[]}
 */
export function reconstructedAscentPath(launchPosition, insertionPosition, samples = 512) {
  const ellipsoid = Cesium.Ellipsoid.WGS84;
  const origin = ellipsoid.cartesianToCartographic(launchPosition);
  const insertion = ellipsoid.cartesianToCartographic(insertionPosition);
  if (!origin || !insertion) return [launchPosition, insertionPosition];
  const geodesic = new Cesium.EllipsoidGeodesic(
    new Cesium.Cartographic(origin.longitude, origin.latitude),
    new Cesium.Cartographic(insertion.longitude, insertion.latitude),
    ellipsoid,
  );
  return Array.from({ length: samples + 1 }, (_, index) => {
    const progress = index / samples;
    if (index === 0) return launchPosition;
    if (index === samples) return insertionPosition;
    const horizontalProgress = progress ** 4;
    const cartographic = geodesic.interpolateUsingFraction(
      horizontalProgress,
      new Cesium.Cartographic(),
    );
    // Approximate the inertial eastward lead accumulated during a ten-minute
    // ascent. The p³ envelope keeps liftoff nearly vertical, peaks during the
    // upper climb, and returns to the fixed insertion endpoint.
    const rotationalLead = EARTH_ROTATION_RAD_PER_SEC
      * PROJECTED_ASCENT_ROTATION_SEC
      * Math.sin(Math.PI * progress ** 3);
    cartographic.longitude = Cesium.Math.negativePiToPi(
      cartographic.longitude + rotationalLead,
    );
    cartographic.height = Cesium.Math.lerp(
      Math.max(0, origin.height),
      Math.max(0, insertion.height),
      Math.sin(progress * Cesium.Math.PI_OVER_TWO),
    );
    return ellipsoid.cartographicToCartesian(cartographic);
  });
}

function nearestOrbitIndex(orbitPath, referencePosition) {
  if (!orbitPath?.length || !referencePosition) return 0;
  const referenceDirection = Cesium.Cartesian3.normalize(referencePosition, new Cesium.Cartesian3());
  let bestIndex = 0;
  let bestDot = -Number.MAX_VALUE;
  orbitPath.forEach((candidate, index) => {
    const direction = Cesium.Cartesian3.normalize(candidate, new Cesium.Cartesian3());
    const dot = Cesium.Cartesian3.dot(referenceDirection, direction);
    if (dot > bestDot) {
      bestDot = dot;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function orbitPathFromInsertion(orbitPath, insertionIndex) {
  if (!orbitPath?.length) return [];
  const first = orbitPath[0];
  const last = orbitPath.at(-1);
  const isClosed = orbitPath.length > 2 && Cesium.Cartesian3.distance(first, last) < 1000;
  const core = isClosed ? orbitPath.slice(0, -1) : orbitPath.slice();
  if (!core.length) return orbitPath.slice();
  const index = Cesium.Math.mod(insertionIndex, core.length);
  const rotated = [...core.slice(index), ...core.slice(0, index)];
  rotated.push(rotated[0]);
  return rotated;
}

function surfaceSafeSegment(startPosition, endPosition) {
  const ellipsoid = Cesium.Ellipsoid.WGS84;
  const start = ellipsoid.cartesianToCartographic(startPosition);
  const end = ellipsoid.cartesianToCartographic(endPosition);
  if (!start || !end) return [startPosition, endPosition];
  const geodesic = new Cesium.EllipsoidGeodesic(
    new Cesium.Cartographic(start.longitude, start.latitude),
    new Cesium.Cartographic(end.longitude, end.latitude),
    ellipsoid,
  );
  // Replay advances in real time across this path. Keep the geometry
  // surface-safe, but give the animated marker and chase camera enough
  // samples that they do not visibly pause at long segment boundaries.
  const steps = Cesium.Math.clamp(Math.ceil(geodesic.surfaceDistance / 75000), 2, 256);
  const positions = [];
  for (let index = 0; index <= steps; index++) {
    const fraction = index / steps;
    const eased = fraction * fraction * (3 - 2 * fraction);
    const cartographic = geodesic.interpolateUsingFraction(fraction, new Cesium.Cartographic());
    cartographic.height = Cesium.Math.lerp(start.height, end.height, eased);
    positions.push(ellipsoid.cartographicToCartesian(cartographic));
  }
  positions[0] = startPosition;
  positions[positions.length - 1] = endPosition;
  return positions;
}

function surfaceSafePath(controlPositions) {
  if (!controlPositions?.length) return [];
  if (controlPositions.length === 1) return controlPositions.slice();
  const path = [];
  for (let index = 0; index < controlPositions.length - 1; index++) {
    const segment = surfaceSafeSegment(controlPositions[index], controlPositions[index + 1]);
    path.push(...(index === 0 ? segment : segment.slice(1)));
  }
  return path;
}

function blendAscentIntoOrbitTangent(ascentPath, orbitPath, insertionIndex) {
  if (!ascentPath?.length || ascentPath.length < 4 || !orbitPath?.length) return ascentPath;
  const ellipsoid = Cesium.Ellipsoid.WGS84;
  const transferEnd = orbitPath[insertionIndex];
  const nextOrbit = orbitPath[(insertionIndex + 1) % orbitPath.length];
  const orbitTangent = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(nextOrbit, transferEnd, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  if (Cesium.Cartesian3.equalsEpsilon(orbitTangent, Cesium.Cartesian3.ZERO, 1e-8)) return ascentPath;

  // Replace a substantial final section with one cubic Bézier transition.
  // Matching both endpoint tangents avoids the short corrective hook produced
  // by locally pulling only the last few ascent samples toward the orbit.
  const blendCount = Math.min(52, ascentPath.length - 2);
  const blendStart = ascentPath.length - 1 - blendCount;
  const start = ascentPath[blendStart];
  const previous = ascentPath[Math.max(0, blendStart - 1)];
  const altitudeEnvelope = ascentPath.slice(blendStart).map((position) => Math.max(
    0,
    ellipsoid.cartesianToCartographic(position)?.height || 0,
  ));
  const ascentTangent = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(start, previous, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const chordLength = Math.max(Cesium.Cartesian3.distance(start, transferEnd), 1000);
  const handleLength = chordLength * 0.28;
  const controlA = Cesium.Cartesian3.add(
    start,
    Cesium.Cartesian3.multiplyByScalar(ascentTangent, handleLength, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const controlB = Cesium.Cartesian3.add(
    transferEnd,
    Cesium.Cartesian3.multiplyByScalar(orbitTangent, -handleLength, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  for (let index = 0; index <= blendCount; index++) {
    const progress = index / blendCount;
    const inverse = 1 - progress;
    const point = new Cesium.Cartesian3();
    Cesium.Cartesian3.multiplyByScalar(start, inverse ** 3, point);
    Cesium.Cartesian3.add(
      point,
      Cesium.Cartesian3.multiplyByScalar(controlA, 3 * inverse ** 2 * progress, new Cesium.Cartesian3()),
      point,
    );
    Cesium.Cartesian3.add(
      point,
      Cesium.Cartesian3.multiplyByScalar(controlB, 3 * inverse * progress ** 2, new Cesium.Cartesian3()),
      point,
    );
    Cesium.Cartesian3.add(
      point,
      Cesium.Cartesian3.multiplyByScalar(transferEnd, progress ** 3, new Cesium.Cartesian3()),
      point,
    );
    // A Cartesian Bézier is a chord in world space and can pass through the
    // ellipsoid when its orbit-tangent handle is long. Preserve the original
    // climb's smooth altitude envelope while retaining the Bézier's horizontal
    // curvature and tangent-aligned insertion.
    const cartographic = ellipsoid.cartesianToCartographic(point);
    const minimumHeight = altitudeEnvelope[index] ?? 0;
    if (cartographic && cartographic.height < minimumHeight) {
      cartographic.height = minimumHeight;
      ascentPath[blendStart + index] = ellipsoid.cartographicToCartesian(cartographic);
    } else {
      ascentPath[blendStart + index] = point;
    }
  }
  ascentPath[ascentPath.length - 1] = transferEnd;
  return ascentPath;
}

/**
 * Build a globe-safe ascent ending at the nearest point on the selected orbit.
 * The returned orbit is rotated to begin at that same insertion point so the
 * animated marker cannot jump between ascent and orbital phases.
 * @param {Cesium.Cartesian3} launchPosition Launch-site position.
 * @param {Cesium.Cartesian3[]} trajectoryPositions Optional upstream stage fixes.
 * @param {Cesium.Cartesian3[]} orbitPath Selected satellite or estimated orbit.
 * @param {Cesium.Cartesian3|null} [insertionReference] Propagated or estimated insertion position.
 * @returns {{ascentPath: Cesium.Cartesian3[], animatedOrbitPath: Cesium.Cartesian3[], insertionIndex: number}}
 */
export function buildMissionPaths(
  launchPosition,
  trajectoryPositions,
  orbitPath,
  insertionReference = null,
) {
  const suppliedTrajectory = trajectoryPositions || [];
  const controls = [launchPosition, ...suppliedTrajectory];
  const insertionIndex = nearestOrbitIndex(
    orbitPath,
    insertionReference || controls.at(-1),
  );
  const transferEnd = orbitPath[insertionIndex];
  const ascentPath = suppliedTrajectory.length
    ? surfaceSafePath([...controls, transferEnd])
    : reconstructedAscentPath(launchPosition, transferEnd);
  blendAscentIntoOrbitTangent(ascentPath, orbitPath, insertionIndex);
  return {
    ascentPath,
    animatedOrbitPath: orbitPathFromInsertion(orbitPath, insertionIndex),
    insertionIndex,
  };
}

export function cameraHeadingForPath(path, progress, fallback = Math.PI) {
  if (!path?.length) return fallback;
  const current = samplePath(path, progress);
  const currentCartographic = Cesium.Ellipsoid.WGS84.cartesianToCartographic(current);
  if (!currentCartographic) return fallback;
  for (const step of [0.01, 0.025, 0.05, 0.1, 0.2]) {
    const next = samplePath(path, Math.min(1, progress + step));
    const nextCartographic = Cesium.Ellipsoid.WGS84.cartesianToCartographic(next);
    if (!nextCartographic) continue;
    const geodesic = new Cesium.EllipsoidGeodesic(currentCartographic, nextCartographic);
    if (geodesic.surfaceDistance > 10 && Number.isFinite(geodesic.startHeading)) {
      // HeadingPitchRange positions the camera opposite its heading vector.
      // Passing the forward path heading therefore keeps the camera behind
      // the vehicle, with the remaining ascent receding into the scene.
      return Cesium.Math.zeroToTwoPi(geodesic.startHeading);
    }
  }
  return fallback;
}

/**
 * Resolve the initial replay heading as a profile view of the path.
 * @param {Cesium.Cartesian3[]} path Replay path.
 * @returns {number} Heading perpendicular to the initial path direction.
 */
export function replayInitialCameraHeading(path) {
  return Cesium.Math.zeroToTwoPi(
    cameraHeadingForPath(path, 0, Math.PI) + Cesium.Math.PI_OVER_TWO,
  );
}

/**
 * Keep ascent framing behind and slightly to one side of the vehicle, then
 * widen that rear-quarter angle as the orbit becomes visible.
 * @param {number} pathHeading Forward path bearing in radians.
 * @param {number} orbitBlend Normalized orbit-camera transition.
 * @returns {number} Cesium HeadingPitchRange heading.
 */
export function replayChaseCameraHeading(pathHeading, orbitBlend = 0) {
  const blend = Cesium.Math.clamp(Number(orbitBlend) || 0, 0, 1);
  return Cesium.Math.zeroToTwoPi(
    pathHeading + Cesium.Math.lerp(
      REPLAY_ASCENT_CAMERA_OFFSET_RAD,
      REPLAY_ORBIT_CAMERA_OFFSET_RAD,
      blend,
    ),
  );
}

/**
 * Limit replay-camera yaw changes so a path heading wrap or insertion turn
 * cannot swing the chase view through the front of the vehicle.
 * @param {number} previous Previous Cesium heading in radians.
 * @param {number} desired Desired Cesium heading in radians.
 * @param {number} [maxStepRad] Maximum angular change for one rendered frame.
 * @returns {number}
 */
export function smoothReplayCameraHeading(
  previous,
  desired,
  maxStepRad = Cesium.Math.toRadians(2),
) {
  if (!Number.isFinite(previous)) return Cesium.Math.zeroToTwoPi(desired);
  if (!Number.isFinite(desired)) return Cesium.Math.zeroToTwoPi(previous);
  const delta = Cesium.Math.negativePiToPi(desired - previous);
  const step = Cesium.Math.clamp(delta, -Math.abs(maxStepRad), Math.abs(maxStepRad));
  return Cesium.Math.zeroToTwoPi(previous + step);
}

/**
 * Blend from a global nadir view into an oblique local 3D view as the user
 * approaches a selected launch site.
 * @param {number} rangeM Camera distance from the launch-site anchor.
 * @returns {number} Cesium camera pitch in radians.
 */
export function missionZoomPitch(rangeM) {
  const range = Math.max(0, Number(rangeM) || 0);
  const blend = Cesium.Math.clamp(
    (Math.log(Math.max(range, MISSION_CLOSE_VIEW_RANGE_M)) - Math.log(MISSION_CLOSE_VIEW_RANGE_M))
      / (Math.log(MISSION_GLOBE_VIEW_RANGE_M) - Math.log(MISSION_CLOSE_VIEW_RANGE_M)),
    0,
    1,
  );
  return Cesium.Math.lerp(Cesium.Math.toRadians(-42), -Cesium.Math.PI_OVER_TWO, blend);
}

/**
 * Resolve the replay camera offset for either close ascent tracking or the
 * orbital globe pullback.
 * @param {{ascending: boolean, phaseProgress: number}} state Replay phase.
 * @param {number} altitudeM Animated vehicle altitude above the ellipsoid.
 * @returns {{range: number, pitch: number}}
 */
export function replayCameraView(state, altitudeM) {
  const altitude = Math.max(0, Number(altitudeM) || 0);
  const localRange = Cesium.Math.clamp(
    REPLAY_INITIAL_RANGE_M + altitude * 0.7,
    REPLAY_INITIAL_RANGE_M,
    REPLAY_LOCAL_MAX_RANGE_M,
  );
  const rawContextBlend = Cesium.Math.clamp(
    (altitude - 20000)
      / (REPLAY_CONTEXT_ALTITUDE_END_M - 20000),
    0,
    1,
  );
  const contextBlend = rawContextBlend * rawContextBlend * (3 - 2 * rawContextBlend);
  const contextRange = Cesium.Math.clamp(
    180000 + altitude * 3.8,
    MISSION_CLOSE_VIEW_RANGE_M,
    REPLAY_CONTEXT_MAX_RANGE_M,
  );
  const ascentRange = Cesium.Math.lerp(localRange, contextRange, contextBlend);
  const ascentPitch = Cesium.Math.lerp(
    Cesium.Math.toRadians(-20),
    Cesium.Math.toRadians(-34),
    contextBlend,
  );
  if (state?.ascending) {
    return { range: ascentRange, pitch: ascentPitch };
  }
  const rawBlend = Cesium.Math.clamp(
    (Number(state?.phaseProgress) || 0) / REPLAY_ORBIT_PULLBACK_FRACTION,
    0,
    1,
  );
  const blend = rawBlend * rawBlend * (3 - 2 * rawBlend);
  return {
    range: Cesium.Math.lerp(ascentRange, REPLAY_ORBIT_GLOBE_RANGE_M, blend),
    // Keep an oblique tactical view of the complete orbit rather than ending
    // in a nadir view. This also prevents the camera from appearing to
    // return toward the launch site after insertion.
    pitch: Cesium.Math.lerp(ascentPitch, Cesium.Math.toRadians(-45), blend),
  };
}

/**
 * Move the orbit-follow target from the vehicle toward its sub-satellite
 * globe anchor, keeping Earth centered while the vehicle remains in frame.
 * @param {Cesium.Cartesian3} position Animated orbital position.
 * @param {number} orbitBlend Normalized orbit-camera transition.
 * @returns {Cesium.Cartesian3} Camera look-at target.
 */
export function replayOrbitGlobeAnchor(position, orbitBlend = 0) {
  if (!position) return position;
  const blend = Cesium.Math.clamp(Number(orbitBlend) || 0, 0, 1);
  if (blend <= 0) return Cesium.Cartesian3.clone(position);
  const cartographic = Cesium.Ellipsoid.WGS84.cartesianToCartographic(position);
  if (!cartographic) return Cesium.Cartesian3.clone(position);
  const altitude = Math.max(0, cartographic.height || 0);
  return Cesium.Cartesian3.fromRadians(
    cartographic.longitude,
    cartographic.latitude,
    Cesium.Math.lerp(altitude, altitude * 0.1, blend),
  );
}

/**
 * Keep the orbital camera's look-at frame biased toward the moving vehicle.
 * Blending completely to a whole-orbit bounding-sphere center can place the
 * target at (or numerically close to) Earth's center. That frame is singular
 * for a heading/pitch camera and lets compact-orbit vehicles leave the view as
 * the camera rotates. Retaining a radial vehicle bias keeps the local frame
 * stable while the wider camera range still contains Earth and the full orbit.
 * @param {Cesium.Cartesian3} vehicleAnchor Globe-side anchor below the vehicle.
 * @param {Cesium.Cartesian3|null} frameCenter Combined Earth/orbit frame center.
 * @param {number} orbitBlend Normalized orbit-camera transition.
 * @returns {Cesium.Cartesian3} Stable camera look-at target.
 */
export function replayOrbitCameraTarget(vehicleAnchor, frameCenter, orbitBlend = 0) {
  if (!vehicleAnchor) return vehicleAnchor;
  if (!frameCenter) return Cesium.Cartesian3.clone(vehicleAnchor);
  const blend = Cesium.Math.clamp(Number(orbitBlend) || 0, 0, 1)
    * REPLAY_ORBIT_FRAME_CENTER_BLEND;
  return Cesium.Cartesian3.lerp(
    vehicleAnchor,
    frameCenter,
    blend,
    new Cesium.Cartesian3(),
  );
}

/**
 * Build a stable orbit-relative camera pose. The camera remains on one side
 * of the orbital plane and uses the vehicle radial as its visual up axis.
 * Consequently the forward orbit tangent always projects toward screen-left
 * instead of changing direction when local compass headings wrap near a pole.
 * @param {Cesium.Cartesian3} position Current vehicle position.
 * @param {Cesium.Cartesian3} tangentPosition Nearby forward path position.
 * @param {Cesium.Cartesian3} target Camera look-at target.
 * @param {number} range Camera distance from the target.
 * @param {number} pitch Camera elevation below the local horizon.
 * @returns {{destination: Cesium.Cartesian3, direction: Cesium.Cartesian3, up: Cesium.Cartesian3}|null}
 */
export function replayOrbitCameraPose(
  position,
  tangentPosition,
  target,
  range,
  pitch,
) {
  if (!position || !tangentPosition || !target) return null;
  const radial = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.clone(position),
    new Cesium.Cartesian3(),
  );
  const tangent = Cesium.Cartesian3.subtract(
    tangentPosition,
    position,
    new Cesium.Cartesian3(),
  );
  if (Cesium.Cartesian3.magnitudeSquared(tangent) < 1) return null;
  Cesium.Cartesian3.normalize(tangent, tangent);
  const orbitNormal = Cesium.Cartesian3.cross(
    radial,
    tangent,
    new Cesium.Cartesian3(),
  );
  if (Cesium.Cartesian3.magnitudeSquared(orbitNormal) < 1e-12) return null;
  Cesium.Cartesian3.normalize(orbitNormal, orbitNormal);

  const distance = Math.max(1, Number(range) || 1);
  const elevation = Cesium.Math.clamp(
    Math.abs(Number(pitch) || 0),
    Cesium.Math.toRadians(5),
    Cesium.Math.toRadians(80),
  );
  const planeOffset = Cesium.Cartesian3.multiplyByScalar(
    orbitNormal,
    Math.cos(elevation) * distance,
    new Cesium.Cartesian3(),
  );
  const radialOffset = Cesium.Cartesian3.multiplyByScalar(
    radial,
    Math.sin(elevation) * distance,
    new Cesium.Cartesian3(),
  );
  const destination = Cesium.Cartesian3.add(
    target,
    planeOffset,
    new Cesium.Cartesian3(),
  );
  Cesium.Cartesian3.add(destination, radialOffset, destination);
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(target, destination, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const radialAlongView = Cesium.Cartesian3.multiplyByScalar(
    direction,
    Cesium.Cartesian3.dot(radial, direction),
    new Cesium.Cartesian3(),
  );
  const up = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(radial, radialAlongView, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  return { destination, direction, up };
}

/**
 * Build one conservative frame that contains both Earth and the complete
 * selected orbit. High-apogee missions cannot be composed from the vehicle's
 * instantaneous altitude alone because the opposite side of the orbit may
 * extend much farther from the globe.
 * @param {Cesium.Cartesian3[]} orbitPath Selected orbit samples.
 * @returns {Cesium.BoundingSphere} Combined Earth/orbit frame.
 */
export function replayOrbitFrameSphere(orbitPath = []) {
  const earth = new Cesium.BoundingSphere(
    Cesium.Cartesian3.ZERO,
    Cesium.Ellipsoid.WGS84.maximumRadius,
  );
  if (!Array.isArray(orbitPath) || orbitPath.length < 2) return earth;
  const orbit = Cesium.BoundingSphere.fromPoints(orbitPath);
  return Cesium.BoundingSphere.union(earth, orbit, new Cesium.BoundingSphere());
}

/**
 * Ensure high-altitude missions frame both the globe and selected vehicle.
 * @param {number} baseRange Range from the normal replay camera transition.
 * @param {number} altitudeM Vehicle altitude above the ellipsoid.
 * @param {number} orbitBlend Normalized orbit-camera transition.
 * @param {number} frameRadiusM Radius of the combined Earth/orbit frame.
 * @returns {number} Camera range in metres.
 */
export function replayOrbitGlobeRange(
  baseRange,
  altitudeM,
  orbitBlend = 0,
  frameRadiusM = 0,
) {
  const range = Math.max(0, Number(baseRange) || 0);
  const altitude = Math.max(0, Number(altitudeM) || 0);
  const frameRadius = Math.max(0, Number(frameRadiusM) || 0);
  const blend = Cesium.Math.clamp(Number(orbitBlend) || 0, 0, 1);
  const globeAndVehicleRange = Math.max(
    range,
    altitude + Cesium.Ellipsoid.WGS84.maximumRadius * 2.4,
    frameRadius * 3,
  );
  return Cesium.Math.lerp(range, globeAndVehicleRange, blend);
}

function stopMissionZoomAnchor() {
  if (_missionZoomAnchorRemover) _missionZoomAnchorRemover();
  _missionZoomAnchorRemover = null;
  _missionZoomAnchorId = null;
  if (_viewer?.camera && !_replayCameraLaunchId) {
    _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }
}

function startMissionZoomAnchor(launch, initialRange) {
  if (!_viewer || !launch || _replayCameraLaunchId) return;
  stopMissionZoomAnchor();
  const target = Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat);
  const range = Math.max(2000, Number(initialRange) || MISSION_GLOBE_VIEW_RANGE_M);
  _missionZoomAnchorId = launch.id;
  _viewer.camera.lookAt(
    target,
    new Cesium.HeadingPitchRange(0, missionZoomPitch(range), range),
  );
}

function syncReplayButton() {
  const button = _missionPanel?.querySelector('[data-mission-replay]');
  const transport = _missionPanel?.querySelector('[data-mission-replay-transport]');
  const speedControl = _missionPanel?.querySelector('.mission-replay-speed-control');
  if (!button) return;
  const active = Boolean(_replayCameraLaunchId && _replayCameraLaunchId === _selectedLaunchId);
  const replayAvailable = Boolean(_selectedLaunchId && _replayTracks.has(_selectedLaunchId));
  if (speedControl) speedControl.hidden = !replayAvailable;
  button.hidden = active || !replayAvailable;
  button.disabled = !replayAvailable;
  button.textContent = 'REPLAY ASCENT';
  button.classList.remove('active');
  button.setAttribute('aria-pressed', String(active));
  button.title = 'Replay the estimated ascent with a following camera';
  if (transport) {
    transport.hidden = !active;
    transport.classList.toggle('is-paused', active && _replayPaused);
    const toggleButton = transport.querySelector('[data-mission-replay-toggle]');
    if (toggleButton) {
      toggleButton.disabled = !active;
      toggleButton.textContent = _replayPaused ? '▶' : 'Ⅱ';
      toggleButton.setAttribute('aria-label', _replayPaused ? 'Resume replay' : 'Pause replay');
      toggleButton.title = _replayPaused ? 'Resume replay' : 'Pause replay';
    }
  }
}

function syncReplayCountdownButton(state) {
  const transport = _missionPanel?.querySelector('[data-mission-replay-transport]');
  if (!transport || !_replayCameraLaunchId) return;
  const phase = state.countdownActive
    ? `T minus ${state.countdownSeconds}`
    : state.preCountdownActive
      ? 'Preparing launch site'
    : state.elapsedSinceStart < 1
      ? 'Liftoff'
      : state.ascending ? 'Ascent replay' : 'Orbit replay';
  transport.setAttribute('aria-label', `${phase}${_replayPaused ? ', paused' : ''}`);
}

function syncReplaySpeedControl() {
  const input = _missionPanel?.querySelector('[data-mission-replay-speed]');
  const output = _missionPanel?.querySelector('[data-mission-replay-speed-output]');
  if (input) {
    input.value = String(_replaySpeed);
    const progress = ((_replaySpeed - REPLAY_SPEED_MIN) / (REPLAY_SPEED_MAX - REPLAY_SPEED_MIN)) * 100;
    input.style.setProperty('--replay-speed-progress', `${progress}%`);
  }
  if (output) output.textContent = `${_replaySpeed.toFixed(_replaySpeed % 1 ? 2 : 0)}×`;
}

function setReplaySpeed(value) {
  const nextSpeed = normalizeReplaySpeed(value);
  const previousSpeed = _replaySpeed;
  if (nextSpeed === previousSpeed) {
    syncReplaySpeedControl();
    return;
  }
  const now = _replayPaused && Number.isFinite(_replayPausedAtMs)
    ? _replayPausedAtMs
    : Date.now();
  for (const [launchId, startedAt] of _animationStarts) {
    if (!Number.isFinite(startedAt)) continue;
    const elapsedMissionMs = (now - startedAt) * previousSpeed;
    _animationStarts.set(launchId, now - elapsedMissionMs / nextSpeed);
  }
  _replaySpeed = nextSpeed;
  syncReplaySpeedControl();
}

function replayClockNow(launchId) {
  if (
    _replayPaused
    && _replayCameraLaunchId === launchId
    && Number.isFinite(_replayPausedAtMs)
  ) {
    return _replayPausedAtMs;
  }
  return Date.now();
}

function pauseMissionReplay() {
  if (!_replayCameraLaunchId || _replayPaused) return false;
  _replayPausedAtMs = Date.now();
  _replayPaused = true;
  syncReplayButton();
  return true;
}

function resumeMissionReplay() {
  if (!_replayCameraLaunchId || !_replayPaused || !Number.isFinite(_replayPausedAtMs)) {
    return false;
  }
  const resumedAt = Date.now();
  const startedAt = _animationStarts.get(_replayCameraLaunchId);
  if (Number.isFinite(startedAt)) {
    _animationStarts.set(
      _replayCameraLaunchId,
      replayStartAfterPause(startedAt, _replayPausedAtMs, resumedAt),
    );
  }
  _replayPaused = false;
  _replayPausedAtMs = null;
  syncReplayButton();
  return true;
}

function stopMissionReplay() {
  const stoppedLaunchId = _replayCameraLaunchId;
  _replayCameraToken++;
  if (_replayCameraRemover) _replayCameraRemover();
  _replayCameraRemover = null;
  _viewer?.camera?.cancelFlight();
  if (_viewer?.camera) _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  _replayCameraLaunchId = null;
  _replayPaused = false;
  _replayPausedAtMs = null;
  if (stoppedLaunchId) _animationStarts.set(stoppedLaunchId, Date.now());
  syncReplayButton();
  syncMissionOverlayEntries();
}

function startMissionReplay(launchId) {
  const launch = _launches.find((item) => item.id === launchId);
  const track = _replayTracks.get(launchId);
  if (!_viewer || !launch || !track) return false;
  if (_replayCameraLaunchId === launchId) {
    stopMissionReplay();
    return false;
  }

  stopMissionZoomAnchor();
  stopMissionReplay();
  _replayCameraLaunchId = launchId;
  _replayPaused = false;
  _replayPausedAtMs = null;
  const token = ++_replayCameraToken;
  const ascentDurationSec = track.ascentDurationSec;
  // Start broadside to the ascent/orbit direction so the launch profile is
  // visible. The chase heading then eases toward the path tangent after the
  // camera is established.
  const initialHeading = replayInitialCameraHeading(track.ascentPath);
  track.lastCameraHeading = initialHeading;
  syncReplayButton();
  syncMissionOverlayEntries();
  releaseAircraftTracking(_dataManager);
  _viewer.trackedEntity = undefined;
  _viewer.camera.cancelFlight();
  _animationStarts.set(
    launchId,
    Date.now() + (REPLAY_TILE_SETTLE_DELAY_SEC + REPLAY_COUNTDOWN_DURATION_SEC) * 1000,
  );
  let cameraReady = false;
  let lastCameraUpdateMs = null;

  // Move the chase camera before scene traversal. Mutating it in preRender
  // makes Cesium discover a new view after 3D-tile refinement, which can cause
  // a self-sustaining refinement loop and visible stutter during slow replay.
  _replayCameraRemover = _viewer.scene.preUpdate.addEventListener(() => {
    if (token !== _replayCameraToken || _replayCameraLaunchId !== launchId) return;
    const state = track.beginReplayFrame();
    syncReplayCountdownButton(state);
    if (!cameraReady) return;
    const path = state.ascending
      ? track.ascentPath
      : track.animatedOrbitPath;
    const position = samplePath(path, state.phaseProgress);
    if (!position) return;
    const pathHeading = cameraHeadingForPath(
      path,
      state.phaseProgress,
      track.lastCameraHeading,
    );
    const orbitBlend = !state.ascending
      ? Cesium.Math.clamp(
        (Number(state.phaseProgress) || 0) / REPLAY_ORBIT_PULLBACK_FRACTION,
        0,
        1,
      )
      : 0;
    const desiredHeading = replayChaseCameraHeading(pathHeading, orbitBlend);
    if (state.ascending) track.orbitCameraWorldFrame = false;
    const nowMs = performance.now();
    const frameDurationMs = Number.isFinite(lastCameraUpdateMs)
      ? Cesium.Math.clamp(nowMs - lastCameraUpdateMs, 4, 50)
      : 1000 / 60;
    lastCameraUpdateMs = nowMs;
    track.lastCameraHeading = smoothReplayCameraHeading(
      track.lastCameraHeading,
      desiredHeading,
      Cesium.Math.toRadians(2) * frameDurationMs / (1000 / 60),
    );
    const cartographic = Cesium.Ellipsoid.WGS84.cartesianToCartographic(position);
    const altitude = Math.max(0, cartographic?.height || 0);
    const cameraView = replayCameraView(state, altitude);
    const defaultOrbitTarget = !state.ascending
      ? replayOrbitGlobeAnchor(position, orbitBlend)
      : position;
    const cameraTarget = !state.ascending
      ? replayOrbitCameraTarget(
        defaultOrbitTarget,
        track.orbitFrameSphere?.center,
        orbitBlend,
      )
      : defaultOrbitTarget;
    const cameraRange = !state.ascending
      ? replayOrbitGlobeRange(
        cameraView.range,
        altitude,
        orbitBlend,
        track.orbitFrameSphere?.radius,
      )
      : cameraView.range;
    if (state.ascending) {
      _viewer.camera.lookAt(
        cameraTarget,
        new Cesium.HeadingPitchRange(
          track.lastCameraHeading,
          cameraView.pitch,
          cameraRange,
        ),
      );
    } else {
      const tangentStep = Math.max(0.002, 0.8 / Math.max(2, path.length - 1));
      const tangentProgress = Math.min(1, state.phaseProgress + tangentStep);
      const tangentPosition = samplePath(
        path,
        tangentProgress > state.phaseProgress
          ? tangentProgress
          : Math.max(0, state.phaseProgress - tangentStep),
      );
      const orbitPose = replayOrbitCameraPose(
        position,
        tangentPosition,
        cameraTarget,
        cameraRange,
        cameraView.pitch,
      );
      if (orbitPose) {
        if (!track.orbitCameraWorldFrame) {
          _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
          track.orbitCameraWorldFrame = true;
        }
        _viewer.camera.setView({
          destination: orbitPose.destination,
          orientation: {
            direction: orbitPose.direction,
            up: orbitPose.up,
          },
        });
      }
    }
    if (state.elapsedSinceStart >= ascentDurationSec
      + REPLAY_ORBIT_DURATION_SEC) {
      stopMissionReplay();
    }
  });

  _viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(track.ascentPath[0], 0),
    {
      offset: new Cesium.HeadingPitchRange(
        initialHeading,
        Cesium.Math.toRadians(-20),
        REPLAY_INITIAL_RANGE_M,
      ),
      duration: 1.4,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: () => {
        cameraReady = true;
      },
      cancel: () => {
        if (token === _replayCameraToken && _replayCameraLaunchId === launchId) stopMissionReplay();
      },
    },
  );
  return true;
}

function finiteCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePayloadFlights(launch) {
  const flights = launch.rocket?.payloads || launch.payloads || launch.mission?.payloads || [];
  if (!Array.isArray(flights)) return [];
  return flights.map((flight, index) => {
    const payload = flight.payload || flight;
    return {
      id: String(flight.id || payload.id || `payload-${index}`),
      name: payload.name || flight.name || 'Undisclosed payload',
      type: payload.type?.name || flight.type?.name || null,
      manufacturer: payload.manufacturer?.name || null,
      operator: payload.operator?.name || null,
      destination: flight.destination || payload.destination || null,
      amount: Number.isFinite(Number(flight.amount)) ? Number(flight.amount) : 1,
      massKg: Number.isFinite(Number(payload.mass)) ? Number(payload.mass) : null,
    };
  });
}

function normalizeLanding(stage, fallbackName, category, index) {
  const landing = stage?.landing;
  const location = landing?.landing_location || {};
  const launcher = stage?.launcher || stage?.spacecraft || {};
  const serial = launcher.serial_number || stage?.serial_number || null;
  const stageType = stage?.type?.name || stage?.type || category;
  const attempted = landing?.attempt === true;
  const success = landing?.success;
  const recoveryType = landing?.type?.name || null;
  const launcherStatus = launcher.status?.name || null;
  const status = success === true ? 'RECOVERED'
    : success === false ? 'LOST'
      : attempted ? 'RECOVERY ATTEMPT'
        : recoveryType ? recoveryType.toUpperCase()
          : launcherStatus ? launcherStatus.toUpperCase()
            : 'NO RECOVERY DATA';
  return {
    id: String(stage?.id || landing?.id || `${category}-${index}`),
    category,
    name: [stageType, serial].filter(Boolean).join(' · ') || fallbackName,
    serial,
    reused: stage?.reused === true,
    flightNumber: finiteCoordinate(stage?.launcher_flight_number),
    status,
    attempted,
    success: success === true ? true : success === false ? false : null,
    recoveryType,
    destination: location.name || landing?.destination || landing?.type?.name || null,
    description: landing?.description || null,
    downrangeKm: finiteCoordinate(landing?.downrange_distance),
    lat: finiteCoordinate(location.latitude ?? landing?.latitude),
    lon: finiteCoordinate(location.longitude ?? landing?.longitude),
  };
}

function normalizeRecoveryStages(launch, payloads) {
  const rocket = launch.rocket || {};
  const launcherStages = Array.isArray(rocket.launcher_stage) ? rocket.launcher_stage : [];
  const spacecraftStages = Array.isArray(rocket.spacecraft_stage) ? rocket.spacecraft_stage : [];
  const stages = [
    ...launcherStages.map((stage, index) => normalizeLanding(stage, `Launcher stage ${index + 1}`, 'LAUNCHER', index)),
    ...spacecraftStages.map((stage, index) => normalizeLanding(stage, `Spacecraft stage ${index + 1}`, 'SPACECRAFT', index)),
  ];
  const payloadFlights = rocket.payloads || launch.payloads || [];
  if (Array.isArray(payloadFlights)) {
    payloadFlights.forEach((flight, index) => {
      if (!flight?.landing) return;
      stages.push(normalizeLanding(
        { ...flight, type: payloads[index]?.type || 'Payload', serial_number: payloads[index]?.name },
        payloads[index]?.name || `Payload ${index + 1}`,
        'PAYLOAD',
        index,
      ));
    });
  }
  return stages;
}

function landingEndpoint(stage, launch, insertionPosition) {
  if (Number.isFinite(stage.lat) && Number.isFinite(stage.lon)) {
    return { lat: stage.lat, lon: stage.lon, accuracy: 'CONFIRMED' };
  }
  const recoveryIdentity = `${stage.recoveryType || ''} ${stage.destination || ''}`.toLowerCase();
  if (/return to launch site|rtls|launch site|landing zone/.test(recoveryIdentity)) {
    return { lat: launch.lat, lon: launch.lon, accuracy: 'PAD / RTLS' };
  }
  if (!(stage.downrangeKm > 0) || !insertionPosition) return null;
  const ellipsoid = Cesium.Ellipsoid.WGS84;
  const start = Cesium.Cartographic.fromDegrees(launch.lon, launch.lat);
  const insertion = ellipsoid.cartesianToCartographic(insertionPosition);
  if (!insertion) return null;
  const geodesic = new Cesium.EllipsoidGeodesic(start, insertion, ellipsoid);
  const bearing = geodesic.startHeading;
  const angularDistance = (stage.downrangeKm * 1000) / ellipsoid.maximumRadius;
  const lat1 = start.latitude;
  const lon1 = start.longitude;
  const lat = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance)
      + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lon = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat),
  );
  return {
    lat: Cesium.Math.toDegrees(lat),
    lon: Cesium.Math.toDegrees(Cesium.Math.negativePiToPi(lon)),
    accuracy: 'EST. DOWNRANGE',
  };
}

function stageReentryRecoveryPath(ascentPath, endpoint, stageIndex, stageCount) {
  if (!ascentPath?.length || !endpoint) return [];
  const progress = Cesium.Math.clamp(0.28 + (stageIndex / Math.max(stageCount, 1)) * 0.34, 0.28, 0.68);
  const separation = samplePath(ascentPath, progress);
  const destination = Cesium.Cartesian3.fromDegrees(endpoint.lon, endpoint.lat, 12);
  return surfaceSafeSegment(separation, destination);
}

function atmosphericReentryIndex(path) {
  if (!path?.length) return 0;
  const ellipsoid = Cesium.Ellipsoid.WGS84;
  for (let index = 1; index < path.length; index++) {
    const previousHeight = ellipsoid.cartesianToCartographic(path[index - 1])?.height;
    const height = ellipsoid.cartesianToCartographic(path[index])?.height;
    if (
      Number.isFinite(previousHeight)
      && Number.isFinite(height)
      && previousHeight > STAGE_REENTRY_ALTITUDE_M
      && height <= STAGE_REENTRY_ALTITUDE_M
    ) {
      return index;
    }
  }
  return Math.min(Math.max(Math.round(path.length * 0.55), 0), path.length - 1);
}

function missionTableRows(items, columns, emptyText) {
  if (!items.length) return `<tr><td colspan="${columns}" class="mission-table-empty">${emptyText}</td></tr>`;
  return items.map((item) => item).join('');
}

function setMissionPanelField(selector, value, title = '') {
  const output = _missionPanel?.querySelector(selector);
  if (!output) return;
  const row = output.closest('[data-mission-field]');
  const available = value !== null && value !== undefined && String(value).trim() !== '';
  if (row) row.hidden = !available;
  if (!available) {
    output.textContent = '';
    output.removeAttribute('title');
    return;
  }
  output.textContent = value;
  if (title) output.title = title;
  else output.removeAttribute('title');
}

function renderMissionPanel() {
  if (!_missionPanel) return;
  const launch = _launches.find((item) => item.id === _selectedLaunchId);
  const index = launch ? _launches.indexOf(launch) : -1;
  _missionPanel.hidden = !launch;
  if (!launch) return;
  _missionPanel.querySelector('[data-mission-title]').textContent = shortMissionLabel(launch.name, 32).toUpperCase();
  setMissionPanelField('[data-mission-provider]', launch.provider);
  setMissionPanelField('[data-mission-status]', launch.status);
  setMissionPanelField(
    '[data-mission-site]',
    launch.launchSite && launch.launchSite !== 'Unknown launch site' ? launch.launchSite : null,
  );
  setMissionPanelField('[data-mission-time]', launch.launchTime);
  const pathPresentation = missionPathPresentation(launch, _replayTracks.has(launch.id));
  setMissionPanelField('[data-mission-orbit]', pathPresentation.orbit);
  _missionPanel.querySelector('[data-mission-ascent-source]').textContent = pathPresentation.ascent;
  const payloadRows = launch.payloads.length
    ? launch.payloads.slice(0, 5).map((payload) => {
      const detail = [
        payload.manufacturer,
        payload.operator && payload.operator !== payload.manufacturer ? payload.operator : null,
        Number.isFinite(payload.massKg) ? `${payload.massKg.toLocaleString()} KG` : null,
      ].filter(Boolean).join(' · ');
      return `<tr><td>${escapeMissionText(payload.name)}${payload.amount > 1 ? ` ×${payload.amount}` : ''}${detail ? `<small>${escapeMissionText(detail)}</small>` : ''}</td><td>${escapeMissionText(payload.type || 'UNSPECIFIED')}</td><td>${escapeMissionText(payload.destination || launch.orbit?.name || 'UNAVAILABLE')}</td></tr>`;
    })
    : [];
  if (launch.payloads.length > 5) {
    payloadRows.push(`<tr><td colspan="3" class="mission-table-empty">+${launch.payloads.length - 5} additional payload records</td></tr>`);
  }
  _missionPanel.querySelector('[data-mission-payloads]').innerHTML = missionTableRows(
    payloadRows,
    3,
    'CLASSIFIED / MULTI-PAYLOAD',
  );
  const stageRows = launch.recoveryStages.map((stage) => {
    const endpoint = stage.endpoint;
    const destination = stage.destination || (endpoint?.accuracy === 'PAD / RTLS' ? launch.launchSite : 'UNAVAILABLE');
    const position = endpoint
      ? `${endpoint.lat.toFixed(2)}, ${endpoint.lon.toFixed(2)} · ${endpoint.accuracy}`
      : stage.downrangeKm > 0 ? `${stage.downrangeKm.toLocaleString()} KM DOWNRANGE` : 'POSITION UNAVAILABLE';
    const stageDetail = [
      Number.isFinite(stage.flightNumber) ? `FLIGHT ${stage.flightNumber}` : null,
      stage.reused ? 'REUSED' : null,
      stage.recoveryType,
    ].filter(Boolean).join(' · ');
    return `<tr><td>${escapeMissionText(stage.name)}${stageDetail ? `<small>${escapeMissionText(stageDetail)}</small>` : ''}</td><td>${escapeMissionText(stage.status)}</td><td>${escapeMissionText(destination)}<small>${escapeMissionText(position)}</small></td></tr>`;
  });
  _missionPanel.querySelector('[data-mission-stages]').innerHTML = missionTableRows(
    stageRows,
    3,
    'NO STAGE RE-ENTRY / RECOVERY DATA',
  );
  const stageSection = _missionPanel.querySelector('[data-mission-stages-section]');
  if (stageSection) stageSection.hidden = stageRows.length === 0;
  updateMissionTelemetry(true);
  _missionPanel.querySelector('[data-mission-index]').textContent = `${index + 1} / ${_launches.length}`;
  _missionPanel.querySelector('[data-mission-prev]').disabled = index <= 0;
  _missionPanel.querySelector('[data-mission-next]').disabled = index < 0 || index >= _launches.length - 1;
  syncReplayButton();
  const panelScroller = _missionPanel.closest('.global-context-panel-inner');
  if (panelScroller) panelScroller.scrollTop = 0;
}

function renderMissionRoster() {
  if (!_missionRoster) return;
  const list = _missionRoster.querySelector('[data-mission-roster-list]');
  const count = _missionRoster.querySelector('[data-mission-roster-count]');
  if (count) count.textContent = `${_launches.length} / 30D`;
  if (!list) return;
  const entries = missionRosterEntries(_launches);
  if (!entries.length) {
    list.innerHTML = '<div class="space-mission-roster-empty">NO MISSIONS AVAILABLE IN THE CURRENT 30-DAY WINDOW</div>';
    return;
  }
  list.innerHTML = entries.map(({ launch, index }) => {
    const color = missionMarkerColor(launch).toCssColorString();
    const date = launch.launchTime?.slice(0, 10) || 'DATE UNAVAILABLE';
    const provider = launch.provider || 'UNSPECIFIED OPERATOR';
    const label = shortMissionLabel(launch.name, 27).toUpperCase();
    return `<button type="button" class="space-mission-roster-item" data-mission-roster-index="${index}" aria-label="Select ${escapeMissionText(label)}"><span class="space-mission-roster-marker" style="--mission-roster-color:${color}" aria-hidden="true"></span><span class="space-mission-roster-copy"><strong>${escapeMissionText(label)}</strong><small>${escapeMissionText(provider)} · ${escapeMissionText(date)}</small></span><span class="space-mission-roster-chevron" aria-hidden="true">›</span></button>`;
  }).join('');
}

function escapeMissionText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function updateMissionTelemetry(force = false) {
  if (!_missionPanel || !_selectedLaunchId || !_dataSource) return;
  const now = performance.now();
  if (!force && now - _lastPanelTelemetryMs < 250) return;
  _lastPanelTelemetryMs = now;
  const satellite = _dataSource.entities.getById(`rocket-satellite:${_selectedLaunchId}`);
  const position = satellite?.position?.getValue(Cesium.JulianDate.now(_declutterTime));
  const altitudeM = position ? Cesium.Cartographic.fromCartesian(position)?.height : null;
  setMissionPanelField(
    '[data-mission-distance]',
    Number.isFinite(altitudeM)
      ? `${Math.max(0, altitudeM / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} KM`
      : null,
  );
  const speedMps = _satelliteTelemetry.get(_selectedLaunchId)?.speedMps;
  setMissionPanelField(
    '[data-mission-speed]',
    Number.isFinite(speedMps)
      ? `${(speedMps / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} KM/S`
      : null,
    Number.isFinite(speedMps)
      ? `${(speedMps * 3.6).toLocaleString(undefined, { maximumFractionDigits: 0 })} km/h`
      : '',
  );
}

function selectMissionAt(index) {
  const launch = _launches[index];
  if (!launch) return;
  setSelectedMission(launch.id, true);
  focusMission(launch);
}

function clearMissionRosterHover() {
  if (_missionRosterHoverTimer) clearTimeout(_missionRosterHoverTimer);
  _missionRosterHoverTimer = null;
  const changed = _hoveredRosterLaunchId !== null;
  _hoveredRosterLaunchId = null;
  if (changed) syncMissionOverlayEntries();
}

function previewMissionFromRoster(launch) {
  if (!_viewer || !launch || _selectedLaunchId) return;
  const range = missionHoverPreviewRange(_viewer.camera.positionCartographic?.height);
  const position = Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat);
  _viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(position, 0),
    {
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_TWO, range),
      duration: 0.8,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    },
  );
}

function scheduleMissionRosterPreview(index) {
  const launch = _launches[index];
  if (!launch || _selectedLaunchId) return;
  if (_missionRosterHoverTimer) clearTimeout(_missionRosterHoverTimer);
  _hoveredRosterLaunchId = launch.id;
  syncMissionOverlayEntries();
  _missionRosterHoverTimer = setTimeout(() => {
    _missionRosterHoverTimer = null;
    if (_hoveredRosterLaunchId === launch.id) previewMissionFromRoster(launch);
  }, 140);
}

function focusMission(launch) {
  if (!_viewer || !launch) return;
  stopMissionZoomAnchor();
  _viewer.selectedEntity = _dataSource.entities.getById(`rocket-launch:${launch.id}`);
  const orbitEntity = _dataSource.entities.getById(`rocket-orbit:${launch.id}`);
  const orbitPositions = orbitEntity?.polyline?.positions?.getValue(Cesium.JulianDate.now());
  const launchPosition = Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat);
  let range = 18000000;
  if (orbitPositions?.length > 1) {
    const canvas = _viewer.scene.canvas;
    const fovy = _viewer.camera.frustum?.fovy || Cesium.Math.toRadians(60);
    const aspect = Math.max(0.1, (canvas.clientWidth || canvas.width) / Math.max(1, canvas.clientHeight || canvas.height));
    const fovx = 2 * Math.atan(Math.tan(fovy * 0.5) * aspect);
    const paddedHalfAngle = Math.min(fovy, fovx) * 0.5 * 0.62;
    const orbitExtent = orbitPositions.reduce(
      (largest, point) => Math.max(largest, Cesium.Cartesian3.distance(launchPosition, point)),
      0,
    );
    range = Math.max(
      orbitExtent / Math.max(Math.sin(paddedHalfAngle), 0.1),
      18000000,
    );
  }
  const targetNormal = Cesium.Cartesian3.normalize(launchPosition, new Cesium.Cartesian3());
  const destination = Cesium.Cartesian3.add(
    launchPosition,
    Cesium.Cartesian3.multiplyByScalar(targetNormal, range, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const direction = Cesium.Cartesian3.negate(targetNormal, new Cesium.Cartesian3());
  let right = Cesium.Cartesian3.cross(direction, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3());
  if (Cesium.Cartesian3.magnitudeSquared(right) < 1e-8) {
    right = Cesium.Cartesian3.cross(direction, Cesium.Cartesian3.UNIT_Y, right);
  }
  Cesium.Cartesian3.normalize(right, right);
  const up = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  _viewer.camera.flyTo({
    destination,
    orientation: { direction, up },
    duration: 1.1,
    complete: () => {
      if (_selectedLaunchId === launch.id) startMissionZoomAnchor(launch, range);
    },
  });
}

function focusLaunchSite(launch) {
  if (!_viewer || !launch) return;
  stopMissionReplay();
  stopMissionZoomAnchor();
  const launchPosition = Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat);
  _viewer.selectedEntity = _dataSource.entities.getById(`rocket-launch:${launch.id}`);
  _viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(launchPosition, 0),
    {
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(-42),
        MISSION_FOCUS_RANGE_M,
      ),
      duration: 1.4,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: () => {
        if (_selectedLaunchId === launch.id) {
          startMissionZoomAnchor(launch, MISSION_FOCUS_RANGE_M);
        }
      },
    },
  );
}

function createMissionPanel() {
  if (_missionPanel || typeof document === 'undefined') return;
  const host = document.getElementById('space-mission-panel-host')
    || document.getElementById('right-context-rail');
  if (!host) return;
  _missionRoster = document.getElementById('space-mission-roster');
  if (_missionRoster) {
    _missionRoster.onclick = (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('[data-mission-roster-index]')
        : null;
      if (!button) return;
      selectMissionAt(Number(button.dataset.missionRosterIndex));
    };
    _missionRoster.onmouseover = (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('[data-mission-roster-index]')
        : null;
      if (!button || button.contains(event.relatedTarget)) return;
      scheduleMissionRosterPreview(Number(button.dataset.missionRosterIndex));
    };
    _missionRoster.onfocusin = (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('[data-mission-roster-index]')
        : null;
      if (button) scheduleMissionRosterPreview(Number(button.dataset.missionRosterIndex));
    };
    _missionRoster.onmouseleave = clearMissionRosterHover;
    _missionRoster.onfocusout = (event) => {
      if (!_missionRoster.contains(event.relatedTarget)) clearMissionRosterHover();
    };
  }
  _missionPanel = document.createElement('aside');
  _missionPanel.id = 'space-mission-panel';
  _missionPanel.className = 'context-space-mission-detail';
  _missionPanel.setAttribute('aria-label', 'Selected Space Mission');
  _missionPanel.innerHTML = `<div class="space-mission-view-header"><span>SELECTED SPACE MISSION</span><button type="button" data-mission-close title="Show all missions" aria-label="Deselect mission">×</button></div><div class="space-mission-detail"><strong data-mission-title>MISSION</strong><span data-mission-field data-mission-provider></span><span data-mission-field>STATUS · <b data-mission-status></b></span><span data-mission-field>LAUNCH SITE · <b data-mission-site></b></span><span data-mission-field>LAUNCH TIME · <b data-mission-time></b></span><span data-mission-field>ORBIT · <b data-mission-orbit></b></span><span>ASCENT PATH · <b data-mission-ascent-source></b></span><span data-mission-field>CURRENT DISTANCE FROM EARTH · <b data-mission-distance></b></span><span data-mission-field>SATELLITE SPEED · <b data-mission-speed></b></span></div><section class="mission-data-section"><h4>PAYLOAD</h4><div class="mission-table-scroll"><table class="mission-data-table"><thead><tr><th>NAME</th><th>TYPE</th><th>DESTINATION</th></tr></thead><tbody data-mission-payloads></tbody></table></div></section><section class="mission-data-section" data-mission-stages-section><h4>STAGE / RE-ENTRY / RECOVERY</h4><div class="mission-table-scroll"><table class="mission-data-table"><thead><tr><th>STAGE</th><th>STATUS</th><th>FINAL POSITION</th></tr></thead><tbody data-mission-stages></tbody></table></div></section><div class="mission-replay-speed-control"><div class="mission-replay-speed-header"><label for="space-mission-replay-speed">REPLAY SPEED</label><output class="gev-slider-value" for="space-mission-replay-speed" data-mission-replay-speed-output>1×</output></div><input id="space-mission-replay-speed" class="gev-quantitative-slider" type="range" min="0.25" max="4" step="0.25" value="1" data-mission-replay-speed aria-label="Replay speed multiplier"><div class="mission-replay-speed-scale" aria-hidden="true"><span>0.25×</span><span>1×</span><span>4×</span></div></div><div class="mission-action-row"><button type="button" class="mission-focus-button" data-mission-focus>FOCUS</button><button type="button" class="mission-replay-button" data-mission-replay aria-pressed="false">REPLAY ASCENT</button></div><div class="space-mission-nav"><button type="button" class="mission-nav-button" data-mission-prev title="Previous mission"><span aria-hidden="true">‹</span> PREV</button><span class="mission-nav-index" data-mission-index>—</span><button type="button" class="mission-nav-button" data-mission-next title="Next mission">NEXT <span aria-hidden="true">›</span></button></div><button type="button" class="panel-layer-toggle" data-mission-show-all>SHOW ALL / DESELECT</button>`;
  _missionPanel.querySelector('.mission-action-row').insertAdjacentHTML(
    'beforeend',
    `<div class="mission-replay-transport" data-mission-replay-transport hidden>
      <button type="button" data-mission-replay-toggle title="Pause replay" aria-label="Pause replay">Ⅱ</button>
      <button type="button" class="cancel" data-mission-replay-cancel title="Cancel replay" aria-label="Cancel replay"><span aria-hidden="true">×</span></button>
    </div>`,
  );
  host.appendChild(_missionPanel);
  _missionPanel.querySelector('[data-mission-prev]').addEventListener('click', () => selectMissionAt(_launches.findIndex((item) => item.id === _selectedLaunchId) - 1));
  _missionPanel.querySelector('[data-mission-next]').addEventListener('click', () => selectMissionAt(_launches.findIndex((item) => item.id === _selectedLaunchId) + 1));
  _missionPanel.querySelector('[data-mission-close]').addEventListener('click', () => setSelectedMission(null));
  _missionPanel.querySelector('[data-mission-show-all]').addEventListener('click', () => setSelectedMission(null));
  _missionPanel.querySelector('[data-mission-focus]').addEventListener('click', () => {
    const launch = _launches.find((item) => item.id === _selectedLaunchId);
    if (launch) focusLaunchSite(launch);
  });
  _missionPanel.querySelector('[data-mission-replay]').addEventListener('click', () => {
    if (_selectedLaunchId) startMissionReplay(_selectedLaunchId);
  });
  _missionPanel.querySelector('[data-mission-replay-toggle]').addEventListener('click', () => {
    if (_replayPaused) resumeMissionReplay();
    else pauseMissionReplay();
  });
  _missionPanel.querySelector('[data-mission-replay-cancel]').addEventListener('click', stopMissionReplay);
  _missionPanel.querySelector('[data-mission-replay-speed]').addEventListener('input', (event) => {
    setReplaySpeed(event.currentTarget.value);
  });
  syncReplaySpeedControl();
}

function updateReplayVehicleOverlay(occluder) {
  if (!_viewer || !_replayVehicleOverlay || !_selectedLaunchId) {
    hideReplayVehicleOverlay();
    return null;
  }
  const launch = _launches.find((item) => item.id === _selectedLaunchId);
  const track = _replayTracks.get(_selectedLaunchId);
  if (!launch || !track) {
    hideReplayVehicleOverlay();
    return null;
  }
  const replayActive = _replayCameraLaunchId === launch.id;
  const state = track.getReplayState();
  const mode = replayOverlayMode({
    replayActive,
    ascending: state.ascending,
    countdownActive: state.countdownActive,
    preCountdownActive: state.preCountdownActive,
  });
  if (!mode) {
    track.lastOverlayWindowPosition = null;
    track.lastOverlayMode = null;
    hideReplayVehicleOverlay();
    return null;
  }
  const path = state.ascending
    ? track.ascentPath
    : track.animatedOrbitPath;
  // Do not call scene.sampleHeight() from this post-render path. A selected
  // mission can remain visible from globe range, and a periodic remote height
  // probe forces Google Photorealistic 3D Tiles to reconsider its refinement
  // set even though the camera is stationary. That presented as a one-second
  // shrink/expand pulse across the globe. Replay follows its already-built,
  // surface-safe Cartesian path and therefore needs no runtime pad sampling.
  const position = samplePath(path, state.phaseProgress);
  if (!position || !occluder.isPointVisible(position)) {
    hideReplayVehicleOverlay();
    return null;
  }
  const windowPosition = Cesium.SceneTransforms.worldToWindowCoordinates(
    _viewer.scene,
    position,
  );
  if (!windowPosition) {
    hideReplayVehicleOverlay();
    return null;
  }
  const canvas = _viewer.scene.canvas;
  if (
    windowPosition.x < -80
    || windowPosition.y < -100
    || windowPosition.x > canvas.clientWidth + 80
    || windowPosition.y > canvas.clientHeight + 100
  ) {
    hideReplayVehicleOverlay();
    return null;
  }
  // The replay camera already targets this same frame-cached world position.
  // Applying a second temporal filter here made the DOM vehicle trail the
  // camera until the snap threshold was crossed, producing a repeating
  // forward/back jump. Keep smoothing only for the non-tracked close-up pad
  // marker, where the user can move the camera independently.
  const renderedWindowPosition = !replayActive && track.lastOverlayMode === mode
    ? smoothReplayWindowPosition(track.lastOverlayWindowPosition, windowPosition)
    : windowPosition;
  track.lastOverlayWindowPosition = renderedWindowPosition;
  track.lastOverlayMode = mode;
  _replayVehicleOverlay.hidden = false;
  _replayVehicleOverlay.dataset.mode = mode;
  _replayVehicleOverlay.classList.toggle(
    'is-thrusting',
    replayActive && state.ascending && !state.countdownActive,
  );
  _replayVehicleOverlay.classList.toggle('is-paused', replayActive && _replayPaused);
  _replayVehicleOverlay.style.transform = `translate3d(${renderedWindowPosition.x}px, ${renderedWindowPosition.y}px, 0) translate(-50%, -50%)`;
  let vehicleRotation = 0;
  if (replayActive && !state.countdownActive) {
    const tangentStep = Math.max(0.002, 0.8 / Math.max(2, path.length - 1));
    const forwardProgress = Math.min(1, state.phaseProgress + tangentStep);
    const backwardProgress = Math.max(0, state.phaseProgress - tangentStep);
    const useForward = forwardProgress > state.phaseProgress;
    const tangentPosition = samplePath(
      path,
      useForward ? forwardProgress : backwardProgress,
    );
    const tangentWindowPosition = tangentPosition
      ? Cesium.SceneTransforms.worldToWindowCoordinates(_viewer.scene, tangentPosition)
      : null;
    if (tangentWindowPosition) {
      const screenDelta = Math.hypot(
        tangentWindowPosition.x - windowPosition.x,
        tangentWindowPosition.y - windowPosition.y,
      );
      // When the path points almost directly into/out of the camera, its
      // screen projection has no trustworthy direction. Keep the last valid
      // path-facing pose instead of snapping the rocket to a camera-facing
      // upright orientation.
      if (screenDelta >= 2) {
        vehicleRotation = useForward
          ? replayVehicleScreenRotation(windowPosition, tangentWindowPosition)
          : replayVehicleScreenRotation(tangentWindowPosition, windowPosition);
        track.lastVehicleRotation = vehicleRotation;
      } else if (Number.isFinite(track.lastVehicleRotation)) {
        vehicleRotation = track.lastVehicleRotation;
      }
    }
  }
  _replayVehicleOverlay.style.setProperty(
    '--mission-replay-rotation',
    `${Cesium.Math.toDegrees(vehicleRotation)}deg`,
  );

  const mission = shortMissionLabel(launch.name, 22).toUpperCase();
  const siteName = compactLaunchSiteName(launch.launchSite);
  const siteCallout = siteName
    ? `LAUNCH SITE · ${shortMissionLabel(siteName, 20).toUpperCase()}`
    : 'LAUNCH SITE';
  let title = mission;
  let detail = siteCallout;
  if (mode === 'countdown') {
    title = `T−${String(state.countdownSeconds).padStart(2, '0')} · ${mission}`;
    detail = `LAUNCH STANDBY\n${siteCallout}`;
  } else if (mode === 'ascent') {
    title = state.elapsedSinceStart < 1
      ? `LIFTOFF · ${mission}`
      : `${launch.trajectory.length > 1 ? 'ASCENT REPLAY' : 'ASCENT ESTIMATE'} · ${mission}`;
    detail = formatMissionEventTime(state.eventTime);
  } else if (mode === 'recovery') {
    title = `STAGE RE-ENTRY / RECOVERY · ${mission}`;
    detail = formatMissionEventTime(state.eventTime);
  } else if (mode === 'orbit') {
    title = `ORBIT REPLAY · ${mission}`;
    detail = formatMissionEventTime(state.eventTime);
  }
  if (_replayPaused) title = `PAUSED · ${title}`;
  const nextText = `${title}\n${detail}`;
  if (nextText !== _replayVehicleOverlayText) {
    _replayVehicleOverlayText = nextText;
    _replayVehicleOverlay.querySelector('[data-replay-overlay-title]').textContent = title;
    _replayVehicleOverlay.querySelector('[data-replay-overlay-detail]').textContent = detail;
  }
  return mode;
}

function setGraphicVisibility(graphic, visible, time) {
  if (!graphic) return;
  const next = Boolean(visible);
  const current = graphic.show?.getValue?.(time);
  if (current !== next) graphic.show = next;
}

function updateMissionFrame() {
  if (!_enabled || !_viewer || !_dataSource?.show) {
    hideReplayVehicleOverlay();
    return;
  }
  updateMissionTelemetry();
  const time = Cesium.JulianDate.now(_declutterTime);
  _declutterOccluder.cameraPosition = _viewer.scene.camera.positionWC;
  updateReplayVehicleOverlay(_declutterOccluder);
  refreshSelectedMissionOverlayText();
  for (const entity of _dataSource.entities.values) {
    if (!entity.show) continue;
    if (!entity.position) continue;
    const id = entityLaunchId(entity);
    if (!id) continue;
    const position = entity.position.getValue(time);
    let horizonVisible = Boolean(position && _declutterOccluder.isPointVisible(position));
    const launchAnchor = entity.id.startsWith('rocket-launch:');
    if (launchAnchor) {
      horizonVisible = missionAnchorVisible(
        _viewer.scene.camera.positionWC,
        position,
        id,
        _selectedLaunchId,
      );
      // Keep entity.show reserved for mission-selection isolation. Horizon
      // state is applied to the individual graphics below so a rear-side
      // anchor remains eligible for reevaluation as the camera moves.
    }
    if (entity.point) {
      setGraphicVisibility(entity.point, horizonVisible, time);
    }
    if (launchAnchor && entity.billboard) {
      setGraphicVisibility(
        entity.billboard,
        horizonVisible && id === _hoveredRosterLaunchId,
        time,
      );
    }
  }
}

/**
 * Select a stable marker color from the mission operator and payload name.
 * Labels stay cyan so the layer remains visually coherent.
 * @param {object} launch Normalized launch record.
 * @returns {Cesium.Color}
 */
export function missionMarkerColor(launch) {
  const identity = `${launch.provider || ''} ${launch.name || ''} ${launch.missionName || ''}`.toLowerCase();
  if (/nasa|national aeronautics/.test(identity)) return Cesium.Color.fromCssColorString('#ff9f43');
  if (/starlink|spacex|space exploration/.test(identity)) return Cesium.Color.fromCssColorString('#4cc9f0');
  if (/rocket lab/.test(identity)) return Cesium.Color.fromCssColorString('#7bed9f');
  if (/isro|indian space/.test(identity)) return Cesium.Color.fromCssColorString('#ff66c4');
  if (/cnsa|china national|long march/.test(identity)) return Cesium.Color.fromCssColorString('#ffd166');
  if (/blue origin/.test(identity)) return Cesium.Color.fromCssColorString('#a78bfa');
  if (/ula|united launch alliance/.test(identity)) return Cesium.Color.fromCssColorString('#f97316');
  if (/arianespace|esa|european space/.test(identity)) return Cesium.Color.fromCssColorString('#60a5fa');
  if (launch.provider) return Cesium.Color.fromCssColorString('#c084fc');
  return Cesium.Color.fromCssColorString('#22e6e6');
}

/**
 * Normalize a Launch Library 2 response into records suitable for the layer.
 * Trajectory points are retained only when the upstream explicitly supplies
 * them; orbital tracks must not be reconstructed from launch metadata.
 * @param {object} payload Launch Library 2-compatible response.
 * @param {Date} [now] Reference time used for the rolling window.
 * @returns {Array<object>}
 */
export function normalizeRocketLaunches(payload, now = new Date()) {
  const launches = Array.isArray(payload) ? payload : payload?.results;
  if (!Array.isArray(launches)) return [];
  const cutoff = now.getTime() - WINDOW_DAYS * 86400000;
  return launches.map((launch) => {
    const launchTime = launch.net || launch.window_start || launch.pad?.location?.name;
    const date = Date.parse(launchTime);
    const pad = launch.pad || {};
    const location = pad.location || {};
    const coordinates = location.coordinates || '';
    const [coordinateLon, coordinateLat] = String(coordinates).split(',').map(Number);
    const lat = Number.isFinite(Number(pad.latitude)) ? Number(pad.latitude) : coordinateLat;
    const lon = Number.isFinite(Number(pad.longitude)) ? Number(pad.longitude) : coordinateLon;
    const payloads = normalizePayloadFlights(launch);
    return {
      id: String(launch.id || launch.slug || launch.name || `launch-${date}`),
      name: launch.name || 'Unnamed launch',
      status: launch.status?.name || 'Unknown',
      launchTime: Number.isFinite(date) ? new Date(date).toISOString() : null,
      launchSite: pad.name || location.name || 'Unknown launch site',
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      provider: launch.launch_service_provider?.name || null,
      mission: launch.mission?.description || null,
      missionName: launch.mission?.name || null,
      satelliteQuery: launch.mission?.name || launch.name || null,
      payloads,
      recoveryStages: normalizeRecoveryStages(launch, payloads),
      trajectory: Array.isArray(launch.trajectory) ? launch.trajectory : [],
      timeline: Array.isArray(launch.timeline)
        ? launch.timeline.map((event) => ({
          name: event.type?.abbrev || event.type?.name || event.name || 'Mission event',
          relativeTime: event.relative_time || event.relativeTime || null,
          offsetSeconds: parseMissionDurationSeconds(event.relative_time || event.relativeTime),
        }))
        : [],
      orbit: launch.mission?.orbit || launch.orbit || null,
      source: 'Launch Library 2',
      inWindow: Number.isFinite(date) && date >= cutoff && date <= now.getTime(),
    };
  }).filter((launch) => launch.inWindow && launch.lat !== null && launch.lon !== null);
}

function addLaunchEntity(launch, activeTleText = _activeTleText) {
  const position = Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat);
  const overlayRecord = {
    launch,
    anchorPosition: position,
    elementEntryFactories: [],
    liveEventTime: null,
  };
  _missionOverlayRecords.set(launch.id, overlayRecord);
  const orbitAllowed = launchStatusAllowsOrbit(launch.status);
  const coreTrack = orbitAllowed && launch.satelliteQuery
    ? getSatelliteOrbitTrack(launch.satelliteQuery, { launchTime: launch.launchTime })
    : null;
  const satelliteTrack = coreTrack || (orbitAllowed && activeTleText && launch.satelliteQuery
    ? findSatelliteOrbitTrackInTle(
      activeTleText,
      launch.satelliteQuery,
      { launchTime: launch.launchTime },
    )
    : null);
  const orbitPath = !orbitAllowed
    ? null
    : satelliteTrack?.orbitPath?.length > 1
      ? satelliteTrack.orbitPath
      : approximateOrbitPath(launch);
  launch.recoveryStages.forEach((stage) => {
    stage.endpoint = landingEndpoint(stage, launch, orbitPath?.[0] || null);
  });
  if (satelliteTrack) _orbitMatches++;
  const entity = _dataSource.entities.add({
    id: `rocket-launch:${launch.id}`,
    position,
    point: {
      pixelSize: 5,
      color: missionMarkerColor(launch),
      outlineColor: missionMarkerColor(launch),
      outlineWidth: 0,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    billboard: {
      image: missionHoverReticleImage(),
      width: 24,
      height: 24,
      show: false,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    properties: {
      launchId: launch.id,
      launchName: launch.name,
      launchTime: launch.launchTime,
      launchSite: launch.launchSite,
      provider: launch.provider,
      mission: launch.mission,
      status: launch.status,
      source: launch.source,
      orbit: JSON.stringify(launch.orbit || {}),
      satelliteName: satelliteTrack?.name || '',
      noradId: satelliteTrack?.noradId || '',
    },
  });
  const points = launch.trajectory
    .filter((point) => Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude)))
    .map((point) => ({
      stage: String(point.stage || point.stage_name || point.phase || point.stageName || 'trajectory'),
      position: Cesium.Cartesian3.fromDegrees(Number(point.longitude), Number(point.latitude), Number(point.altitude || 0)),
    }));
  if (points.length > 1) {
    const segments = [];
    points.forEach((point) => {
      const previous = segments.at(-1);
      if (!previous || previous.stage !== point.stage) segments.push({ stage: point.stage, positions: [] });
      segments.at(-1).positions.push(point.position);
    });
    segments.forEach((segment, index) => {
      if (segment.positions.length < 2) return;
      _dataSource.entities.add({
        id: `rocket-trajectory:${launch.id}:${index}`,
        polyline: {
          positions: surfaceSafePath(segment.positions),
          width: 2,
          material: Cesium.Color.fromCssColorString(TRAJECTORY_STAGE_COLORS[index % TRAJECTORY_STAGE_COLORS.length]).withAlpha(0.8),
          clampToGround: false,
          arcType: Cesium.ArcType.NONE,
        },
        properties: { launchId: launch.id, stage: segment.stage, source: launch.source },
      });
    });
  }
  if (orbitPath?.length > 1) {
    const orbitCurrent = satelliteTrack?.current || { longitude: launch.lon, latitude: launch.lat, altitude: 0 };
    const orbitPeriodSec = satelliteTrack?.periodSec || estimatedOrbitPeriodSeconds(orbitPath);
    const launchEpochMs = Date.parse(launch.launchTime);
    const disclosedInsertionOffsetSec = orbitInsertionOffsetSeconds(launch);
    const insertionDurationSec = Number.isFinite(disclosedInsertionOffsetSec)
      ? Math.max(0, disclosedInsertionOffsetSec)
      : 600;
    const insertionEpochMs = Number.isFinite(launchEpochMs)
      ? launchEpochMs + insertionDurationSec * 1000
      : Number.NaN;
    let insertionReference = points.at(-1)?.position || null;
    if (!insertionReference && satelliteTrack?.positionAt && Number.isFinite(insertionEpochMs)) {
      const propagatedInsertion = satelliteTrack.positionAt(new Date(insertionEpochMs));
      if (propagatedInsertion) {
        insertionReference = Cesium.Cartesian3.fromDegrees(
          propagatedInsertion.longitude,
          propagatedInsertion.latitude,
          propagatedInsertion.altitude,
        );
      }
    }
    if (!insertionReference && !satelliteTrack) {
      // A projected orbit has no authoritative historical phase. Start its
      // plane over the launch site, advance only by the estimated powered
      // ascent duration, and join the forward orbit tangent. Using the UTC
      // epoch as phase sent some ascents toward the far side of Earth and
      // forced a visible 180-degree corrective hook before insertion.
      const insertionProgress = Cesium.Math.clamp(
        insertionDurationSec / orbitPeriodSec,
        1 / 96,
        0.16,
      );
      insertionReference = samplePath(orbitPath, insertionProgress);
    }
    const { ascentPath, animatedOrbitPath } = buildMissionPaths(
      position,
      points.map((point) => point.position),
      orbitPath,
      insertionReference,
    );
    const ascentDurationSec = replayAscentDurationSeconds(launch, ascentPath);
    // Cesium can evaluate CallbackProperty values multiple times while it
    // traverses one frame. Camera tracking and the HTML replay overlay must
    // use the exact same replay epoch as those callbacks; sampling Date.now()
    // independently made the vehicle advance relative to the camera and then
    // snap back on the next frame.
    let replayStateForFrame = null;
    const sampleReplayState = () => replayState(
      launch,
      _animationStarts.get(launch.id) || Date.now(),
      ascentDurationSec,
      REPLAY_ORBIT_DURATION_SEC,
      orbitPeriodSec,
      _replaySpeed,
      replayClockNow(launch.id),
      REPLAY_TILE_SETTLE_DELAY_SEC,
      _replayCameraLaunchId !== launch.id,
    );
    // preUpdate runs before Cesium evaluates entity CallbackProperties. Seed
    // one state there and retain it through postRender so every consumer in
    // that traversal sees the same timestamp. scene.frameState.frameNumber is
    // advanced between some of those phases, so it is not a reliable cache key.
    const beginReplayFrame = () => {
      replayStateForFrame = sampleReplayState();
      return replayStateForFrame;
    };
    const getReplayState = () => {
      if (!replayStateForFrame) {
        replayStateForFrame = sampleReplayState();
      }
      return replayStateForFrame;
    };
    launch.recoveryStages.forEach((stage, stageIndex) => {
      stage.endpoint = landingEndpoint(stage, launch, ascentPath.at(-1));
      const path = stageReentryRecoveryPath(ascentPath, stage.endpoint, stageIndex, launch.recoveryStages.length);
      if (path.length < 2) return;
      const reentryIndex = atmosphericReentryIndex(path);
      const reentryPath = path.slice(reentryIndex);
      const color = Cesium.Color.fromCssColorString(
        TRAJECTORY_STAGE_COLORS[(stageIndex + 1) % TRAJECTORY_STAGE_COLORS.length],
      );
      _dataSource.entities.add({
        id: `rocket-reentry-recovery:${launch.id}:${stageIndex}`,
        polyline: {
          positions: path,
          width: 2,
          material: new Cesium.PolylineDashMaterialProperty({
            color: color.withAlpha(0.82),
            dashLength: 12,
            dashPattern: 0xAAAA,
          }),
          arcType: Cesium.ArcType.NONE,
        },
        properties: {
          launchId: launch.id,
          stageId: stage.id,
          phase: 'STAGE_REENTRY_RECOVERY',
          accuracy: stage.endpoint.accuracy,
          source: launch.source,
        },
      });
      if (reentryPath.length > 1) {
        _dataSource.entities.add({
          id: `rocket-reentry:${launch.id}:${stageIndex}`,
          polyline: {
            positions: reentryPath,
            width: 2.5,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString('#ffd166').withAlpha(0.9),
              dashLength: 8,
              dashPattern: 0xF0F0,
            }),
            arcType: Cesium.ArcType.NONE,
          },
          properties: {
            launchId: launch.id,
            stageId: stage.id,
            phase: 'ATMOSPHERIC_REENTRY',
            altitudeM: STAGE_REENTRY_ALTITUDE_M,
            source: 'Estimated 100 km atmospheric interface',
          },
        });
        const reentryPosition = path[reentryIndex];
        overlayRecord.elementEntryFactories.push(() => (
          createRocketMissionElementOverlayEntry({
            id: `reentry:${launch.id}:${stageIndex}`,
            position: reentryPosition,
            text: 'STAGE RE-ENTRY',
            accent: '#ffd166',
            priority: 700_000 - stageIndex,
            gapPx: 8,
          })
        ));
      }
      _dataSource.entities.add({
        id: `rocket-recovery-end:${launch.id}:${stageIndex}`,
        position: path.at(-1),
        point: {
          pixelSize: 4,
          color,
          outlineWidth: 0,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: {
          launchId: launch.id,
          stageId: stage.id,
          phase: 'RECOVERY_ENDPOINT',
          source: launch.source,
        },
      });
    });
    _replayTracks.set(launch.id, {
      ascentPath,
      animatedOrbitPath,
      orbitFrameSphere: replayOrbitFrameSphere(animatedOrbitPath),
      ascentDurationSec,
      beginReplayFrame,
      getReplayState,
      lastCameraHeading: Math.PI,
      orbitCameraWorldFrame: false,
      lastVehicleRotation: 0,
      lastOverlayWindowPosition: null,
      lastOverlayMode: null,
    });
    let livePosition = Cesium.Cartesian3.fromDegrees(
      orbitCurrent.longitude,
      orbitCurrent.latitude,
      orbitCurrent.altitude,
    );
    const liveTime = new Date();
    const liveTelemetry = { speedMps: null };
    _satelliteTelemetry.set(launch.id, liveTelemetry);
    let liveFrameNumber = -1;
    const fallbackPeriodSec = estimatedOrbitPeriodSeconds(orbitPath);
    const updateLiveState = () => {
      const frameNumber = _viewer?.scene?.frameState?.frameNumber ?? -1;
      if (frameNumber !== -1 && frameNumber === liveFrameNumber) return;
      liveFrameNumber = frameNumber;
      const nowMs = Date.now();
      liveTime.setTime(nowMs);
      if (satelliteTrack) {
        const propagated = satelliteTrack.positionAt?.(liveTime) || satelliteTrack.current;
        if (propagated) {
          Cesium.Cartesian3.fromDegrees(
            propagated.longitude,
            propagated.latitude,
            propagated.altitude,
            undefined,
            livePosition,
          );
          liveTelemetry.speedMps = Number.isFinite(propagated.speedMps)
            ? propagated.speedMps
            : null;
        }
      } else {
        // In-place write keeps one Cartesian3 for the mission's lifetime —
        // the estimated branch previously reallocated per propagation.
        livePosition = samplePath(
          orbitPath,
          orbitProgressAtTime(nowMs, fallbackPeriodSec),
          livePosition,
        ) || livePosition;
      }
    };
    _dataSource.entities.add({
      id: `rocket-satellite:${launch.id}`,
      position: new Cesium.CallbackProperty(() => {
        updateLiveState();
        return livePosition;
      }, false),
      point: {
        pixelSize: 6,
        color: Cesium.Color.fromCssColorString(satelliteTrack ? '#7bed9f' : '#ffd166'),
        outlineWidth: 0,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: {
        launchId: launch.id,
        noradId: satelliteTrack?.noradId || '',
        phase: satelliteTrack ? 'CURRENT_SATELLITE_POSITION' : 'ESTIMATED_ORBIT_POSITION',
        source: satelliteTrack ? 'Satellites layer' : 'Approximate mission orbit',
      },
    });
    overlayRecord.liveEventTime = () => liveTime;
    overlayRecord.elementEntryFactories.push(() => {
      const name = satelliteTrack
        ? shortMissionLabel(satelliteTrack.name, 22).toUpperCase()
        : 'EST. ORBIT POSITION';
      return createRocketMissionElementOverlayEntry({
        id: `payload-position:${launch.id}`,
        position: () => livePosition,
        text: `${name}\n${formatMissionEventTime(liveTime)}`,
        accent: satelliteTrack ? '#7bed9f' : '#ffd166',
        priority: 900_000,
        gapPx: 12,
      });
    });
    // Live satellite rings use a primitive collection so the core Satellite
    // GMST transform can rotate their baked ECEF geometry without rebuilding
    // it. Estimated launch-site-relative rings remain ordinary entities.
    const primitiveOrbitAdded = addMissionOrbitPrimitive(launch, orbitPath, satelliteTrack);
    if (!primitiveOrbitAdded) {
      _dataSource.entities.add({
        id: `rocket-orbit:${launch.id}`,
        polyline: {
          positions: orbitPath,
          // The 3 px canvas gives the periodic dot room to read as round; the
          // shader masks the ten intervening dashes down to a thin center stroke.
          width: 3,
          material: new MissionOrbitPatternMaterialProperty(
            Cesium.Color.fromCssColorString('#c084fc').withAlpha(0.95),
          ),
          arcType: Cesium.ArcType.NONE,
        },
        properties: {
          launchId: launch.id,
          satelliteName: '',
          noradId: '',
          source: 'Approximate mission orbit',
        },
      });
    }
    const orbitLabelBakePosition = ascentPath.at(-1);
    let orbitLabelPosition = orbitLabelBakePosition;
    const primitivePath = _missionOrbitPrimitives.get(launch.id);
    if (primitivePath) {
      primitivePath.labelBakePosition = orbitLabelBakePosition;
      primitivePath.labelPosition = Cesium.Matrix4.multiplyByPoint(
        primitivePath.primitive.modelMatrix,
        orbitLabelBakePosition,
        new Cesium.Cartesian3(),
      );
      orbitLabelPosition = () => primitivePath.labelPosition;
    }
    overlayRecord.elementEntryFactories.push(() => (
      createRocketMissionElementOverlayEntry({
        id: `orbit:${launch.id}`,
        position: orbitLabelPosition,
        text: satelliteTrack ? 'ORBIT' : 'PROJECTED ORBIT',
        accent: satelliteTrack ? '#22e6e6' : '#c084fc',
        priority: 800_000,
        gapPx: 8,
      })
    ));
    const replayPosition = new Cesium.CallbackProperty(() => {
      const state = getReplayState();
      return state.ascending
        ? samplePath(ascentPath, state.phaseProgress)
        : samplePath(animatedOrbitPath, state.phaseProgress);
    }, false);
    _dataSource.entities.add({
      id: `rocket-vehicle:${launch.id}`,
      position: replayPosition,
      properties: { launchId: launch.id, noradId: satelliteTrack?.noradId || '', phase: 'ASCENT_THEN_ORBIT', source: satelliteTrack ? 'Satellite trajectory animation' : 'Approximate trajectory animation' },
    });
    _dataSource.entities.add({
      id: `rocket-transfer:${launch.id}`,
      polyline: {
        positions: ascentPath,
        width: 1.5,
        // The animated vehicle uses Cartesian interpolation between these
        // exact samples. Prevent Cesium from replacing each segment with a
        // geodesic arc, which would visually separate the dot from the line.
        arcType: Cesium.ArcType.NONE,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#7bed9f').withAlpha(0.8),
          dashLength: 24,
          dashPattern: 0xF0F0,
        }),
      },
      properties: {
        launchId: launch.id,
        phase: 'APPROXIMATE_TRANSFER',
        source: satelliteTrack
          ? 'Launch site to propagated insertion'
          : 'Launch site to forward projected insertion',
      },
    });
  }
}

function clearPostTleRetry() {
  if (_retryTimer) clearTimeout(_retryTimer);
  _retryTimer = null;
}

function schedulePostTleRetry(token) {
  if (_retryTimer || token !== _lifecycleToken || !shouldRetryAfterActiveTle({
    enabled: _enabled,
    retryCount: _postTleRetryCount,
    activeTleText: _activeTleText,
    renderedTleText: _renderedTleText,
  })) return;
  _postTleRetryCount++;
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    if (_enabled && token === _lifecycleToken) requestMissionUpdate();
  }, POST_TLE_RETRY_DELAY_MS);
}

function ensureActiveTleLookup(token) {
  if (_activeTleText) return Promise.resolve(_activeTleText);
  if (_activeTlePromise && _activeTlePromiseToken === token) return _activeTlePromise;
  const request = fetch('/api/gev/celestrak/active')
    .then((activeResponse) => {
      if (!activeResponse.ok) throw new Error(`HTTP ${activeResponse.status}`);
      return activeResponse.text();
    })
    .then((text) => {
      if (!_enabled || token !== _lifecycleToken) return null;
      _activeTleText = text;
      _focusAfterActiveLookup = Boolean(_selectedLaunchId);
      schedulePostTleRetry(token);
      return text;
    })
    .catch((error) => {
      if (_enabled && token === _lifecycleToken) {
        console.warn('[Data:RocketLaunches] Active satellite lookup unavailable:', error.message);
      }
      return null;
    })
    .finally(() => {
      if (_activeTlePromise === request) {
        _activeTlePromise = null;
        _activeTlePromiseToken = 0;
      }
    });
  _activeTlePromise = request;
  _activeTlePromiseToken = token;
  return request;
}

async function captureSatelliteDependency() {
  if (!_dataManager || _satelliteStateBeforeMission) return;
  _satelliteStateBeforeMission = {
    // Effective visibility: a user enable still mid-activation is intent ON —
    // capturing settled false would restore the user's enable away on exit.
    enabled: _dataManager.isEffectivelyEnabled?.('satellites')
      ?? _dataManager.isEnabled('satellites'),
    params: satelliteParamsAfterSpaceMissions(
      _dataManager.getLayerParams('satellites'),
    ),
  };
  _dataManager.setLayerParams(
    'satellites',
    satelliteParamsForSpaceMissions(_satelliteStateBeforeMission.params),
  );
  const token = _lifecycleToken;
  const activation = Promise.resolve(_dataManager.setEnabled('satellites', true));
  _satelliteActivationPromise = activation;
  try {
    const activated = await activation;
    // Space Missions without its satellite dependency is a broken replay
    // surface; fail the mission enable so the manager's fail-closed path and
    // the Context rollback see an honest failure instead of a silent success.
    if (
      token === _lifecycleToken
      && _enabled
      && (activated === false || !_dataManager.isEnabled('satellites'))
    ) {
      throw new Error('Space Missions requires the satellites layer, which failed to start');
    }
  } finally {
    if (token === _lifecycleToken && _satelliteActivationPromise === activation) {
      _satelliteActivationPromise = null;
    }
  }
}

async function restoreSatelliteDependency() {
  const snapshot = _satelliteStateBeforeMission;
  if (!snapshot || !_dataManager) return;
  _satelliteStateBeforeMission = null;
  _satelliteActivationPromise = null;
  _dataManager.setLayerParams(
    'satellites',
    satelliteParamsAfterSpaceMissions(snapshot.params),
  );
  const restored = await _dataManager.setEnabled('satellites', snapshot.enabled);
  if (
    restored === false
    || _dataManager.isEnabled('satellites') !== snapshot.enabled
  ) {
    throw new Error('Space Missions could not restore the satellites layer');
  }
}

async function performMissionUpdate(token) {
  try {
    ensureActiveTleLookup(token);
    const response = await fetch(API_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const launches = normalizeRocketLaunches(await response.json());
    if (!_enabled || token !== _lifecycleToken || !_dataSource) return;
    const activeTleText = _activeTleText;
    if (_replayCameraLaunchId) stopMissionReplay();
    _launches = launches;
    removeMissionOrbitPrimitives();
    _dataSource.entities.removeAll();
    _missionOverlayRecords.clear();
    _satelliteTelemetry.clear();
    _replayTracks.clear();
    _orbitMatches = 0;
    launches.forEach((launch) => addLaunchEntity(launch, activeTleText));
    _renderedTleText = activeTleText;
    if (_renderedTleText === _activeTleText) clearPostTleRetry();
    _count = launches.length;
    renderMissionRoster();
    if (!_selectedLaunchId || !launches.some((launch) => launch.id === _selectedLaunchId)) {
      setSelectedMission(null, false);
    } else {
      setSelectedMission(_selectedLaunchId, true);
      if (_focusAfterActiveLookup) {
        focusMission(launches.find((launch) => launch.id === _selectedLaunchId));
      }
    }
    _focusAfterActiveLookup = false;
    renderMissionPanel();
    _lastUpdate = Date.now();
    _lastError = null;
  } catch (error) {
    if (_enabled && token === _lifecycleToken) {
      _lastError = error.message;
      console.warn('[Data:RocketLaunches] Fetch error:', error);
    }
  }
}

function requestMissionUpdate() {
  if (!_enabled) return Promise.resolve();
  const token = _lifecycleToken;
  _updateDirty = true;
  if (_updatePromise && _updatePromiseToken === token) return _updatePromise;
  let request;
  request = (async () => {
    while (_enabled && token === _lifecycleToken && _updateDirty) {
      _updateDirty = false;
      await performMissionUpdate(token);
    }
  })().finally(() => {
    if (_updatePromise === request) {
      _updatePromise = null;
      _updatePromiseToken = 0;
    }
  });
  _updatePromise = request;
  _updatePromiseToken = token;
  return request;
}

const rocketLaunchesLayer = {
  id: 'rocket-launches',
  name: 'Space Missions (30d)',
  icon: '🚀',
  source: 'Launch Library 2',
  updateInterval: 300000,

  init(viewer) {
    _viewer = viewer;
    _enabled = false;
    createMissionPanel();
    createReplayVehicleOverlay();
    _dataSource = new Cesium.CustomDataSource('rocket-launches');
    _dataSource.show = false;
    viewer.dataSources.add(_dataSource);
    _count = 0;
    _lastUpdate = null;
    _lastError = null;
    _orbitMatches = 0;
    clearMissionOverlaySources();
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((movement) => {
      if (!_enabled || !_dataSource?.show) return;
      const entity = viewer.scene.drillPick(movement.position, 12)
        .map((picked) => picked?.id)
        .find((candidate) => entityLaunchId(candidate));
      const launchId = entityLaunchId(entity);
      if (!launchId) return;
      setSelectedMission(launchId);
      focusMission(_launches.find((launch) => launch.id === launchId));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    _moveHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _moveHandler.setInputAction((movement) => {
      if (!_enabled || !_dataSource?.show) return;
      const missionEntity = viewer.scene.drillPick(movement.endPosition, 12)
        .map((picked) => picked?.id)
        .find((candidate) => entityLaunchId(candidate));
      viewer.scene.canvas.style.cursor = missionEntity ? 'pointer' : '';
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    // Apply horizon visibility before Cesium traverses and picks the scene.
    // A postRender write is one frame late and can remain visibly stale when
    // request-on-demand rendering stops after a globe camera move.
    _declutterHandler = viewer.scene.preRender.addEventListener(updateMissionFrame);
    initLaunchPadZonePrimitive();
  },

  async enable() {
    _enabled = true;
    holdContinuousRender('rocket-launches'); // per-frame animator (perf wave 2)
    _lifecycleToken++;
    _postTleRetryCount = 0;
    try {
      await this._enableBody();
    } catch (error) {
      // Enable is a transaction: a failed dependency must not leave mission
      // UI/datasource visible or the satellite snapshot retained (a retained
      // snapshot makes the next enable skip dependency capture entirely).
      try {
        await this.disable();
      } catch (cleanupError) {
        console.warn('[Missions] enable rollback failed:', cleanupError);
      }
      throw error;
    }
  },
  async _enableBody() {
    _updateDirty = false;
    if (_dataSource) _dataSource.show = true;
    syncMissionOrbitPrimitiveVisibility();
    focusFullGlobe(_viewer);
    document.getElementById('cockpit-context')?.setAttribute('hidden', '');
    if (_selectedLaunchId) setSelectedMission(_selectedLaunchId, _explicitSelection);
    else setSelectedMission(null, false);
    await captureSatelliteDependency();
  },
  async disable() {
    _enabled = false;
    releaseContinuousRender('rocket-launches');
    _lifecycleToken++;
    _updateDirty = false;
    clearPostTleRetry();
    clearMissionRosterHover();
    stopMissionReplay();
    stopMissionZoomAnchor();
    if (_dataSource) _dataSource.show = false;
    syncMissionOrbitPrimitiveVisibility();
    if (_viewer?.scene?.canvas) _viewer.scene.canvas.style.cursor = '';
    hideLaunchPadZone();
    hideReplayVehicleOverlay();
    _selectedLaunchId = null;
    clearMissionOverlaySources();
    await restoreSatelliteDependency();
    renderMissionPanel();
  },

  update() {
    return requestMissionUpdate();
  },

  /** Release only Space Mission camera ownership, preserving layer and selection state. */
  releaseCameraOwnership() {
    clearMissionRosterHover();
    stopMissionReplay();
    stopMissionZoomAnchor();
  },

  async destroy(viewer) {
    releaseContinuousRender('rocket-launches'); // direct-destroy path (perf wave 2 fix)
    _enabled = false;
    _lifecycleToken++;
    _updateDirty = false;
    await restoreSatelliteDependency();
    clearMissionRosterHover();
    stopMissionReplay();
    stopMissionZoomAnchor();
    clearPostTleRetry();
    if (_clickHandler) _clickHandler.destroy();
    _clickHandler = null;
    if (_moveHandler) _moveHandler.destroy();
    _moveHandler = null;
    if (_declutterHandler) _declutterHandler();
    _declutterHandler = null;
    destroyLaunchPadZonePrimitive();
    removeMissionOrbitPrimitives();
    clearMissionOverlaySources();
    destroyReplayVehicleOverlay();
    _launches = [];
    _missionOverlayRecords.clear();
    _animationStarts.clear();
    _satelliteTelemetry.clear();
    _replayTracks.clear();
    _missionPanel?.remove();
    _missionPanel = null;
    if (_missionRoster) {
      _missionRoster.onclick = null;
      _missionRoster.onmouseover = null;
      _missionRoster.onfocusin = null;
      _missionRoster.onmouseleave = null;
      _missionRoster.onfocusout = null;
    }
    _missionRoster = null;
    _viewer = null;
    if (_dataSource) viewer.dataSources.remove(_dataSource, true);
    _dataSource = null;
    _count = 0;
    _orbitMatches = 0;
    _lastUpdate = null;
    _activeTleText = null;
    _activeTlePromise = null;
    _activeTlePromiseToken = 0;
    _renderedTleText = null;
    _postTleRetryCount = 0;
    _satelliteStateBeforeMission = null;
    _satelliteActivationPromise = null;
    _dataManager = null;
  },

  getStats() { return { count: _count, orbitMatches: _orbitMatches, lastUpdate: _lastUpdate, error: _lastError }; },
  attachDataManager(dataManager) { _dataManager = dataManager; },
};

/** Test seam for real layer lifecycle coverage with a recording host. */
export function _setRocketMissionOverlayHostForTest(host = null) {
  _missionOverlayHost = host ? { ...DEFAULT_OVERLAY_HOST, ...host } : DEFAULT_OVERLAY_HOST;
}

/** Test seam that exercises the real selection/deselection path. */
export function _setSelectedRocketMissionForTest(launchId = null) {
  setSelectedMission(launchId, Boolean(launchId));
}

export default rocketLaunchesLayer;
