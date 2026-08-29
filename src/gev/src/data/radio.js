/**
 * Internet-radio station directory and direct-playback layer.
 *
 * Radio Browser supplies public-domain directory metadata through the local
 * `/api/gev/radio/*` broker. Audio always travels directly from the broadcaster
 * to one active HTMLAudioElement after an explicit user action; GEV does not
 * proxy, cache, record, or redistribute streams.
 *
 * @module radio
 */
import * as Cesium from 'cesium';
import { cachedGroundFloor, warmGroundFloor } from './groundFloor.js';
import { normalizeRadioCountryInput } from './radioCountry.js';
import { normalizeRadioFilter } from './layerState.js';
import { horizonOccluder } from './iconOrientation.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from './pickRegistry.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  earthDiscScreenRadius,
  getKeyholeGeometry,
  GLOBE_ENTER_CLEARANCE_PX,
  isFullGlobeInsideKeyhole,
  projectEarthDiscToViewport,
} from '../celestialRing.js';
import { governorRequestRender } from '../renderGovernor.js';

const RADIO_PREFIX = 'radio:';
const DIRECTORY_ENDPOINT = '/api/gev/radio/stations';
const HORIZON_TICK_MS = 250;
const HORIZON_CAMERA_MOVE_EPSILON_M = 1;
const MARKER_LIFT_M = 2.5;
const SELECTED_LIFT_M = 5;
const RADIO_PICK_TOLERANCE_PX = 8;
const RADIO_TUNER_DIRECTORY_LIMIT = 750;
const RADIO_TUNER_STATION_LIMIT = RADIO_TUNER_DIRECTORY_LIMIT;
const RADIO_TUNER_STATIC_MAX_GAIN = 0.018;
const RADIO_VOICE_PLAYBACK_TIMEOUT_MS = 12_000;
const RADIO_DIRECTORY_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const RADIO_DIRECTORY_FUTURE_SKEW_MS = 5 * 60 * 1000;
const RADIO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RADIO_OVERLAY_SOURCE_ID = 'radio';
export const RADIO_OVERLAY_COHORT_LIMIT = 64;
export const RADIO_SINGLETON_GLOBAL_LIMIT = 16;
export const RADIO_SINGLETON_MID_LIMIT = 32;
export const RADIO_SINGLETON_NEAR_LIMIT = 48;
export const RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M = 50_000_000;
export const RADIO_GLOBE_RECENTER_MAX_HEIGHT_M = 13_000_000;
export const RADIO_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: RADIO_OVERLAY_COHORT_LIMIT,
  collisionCapacity: 96,
  moving: false,
});
const RADIO_PICK_OFFSETS = Object.freeze([
  [0, -RADIO_PICK_TOLERANCE_PX],
  [RADIO_PICK_TOLERANCE_PX, 0],
  [0, RADIO_PICK_TOLERANCE_PX],
  [-RADIO_PICK_TOLERANCE_PX, 0],
  [6, -6],
  [6, 6],
  [-6, 6],
  [-6, -6],
]);
const _radioEarthScreenCenter = new Cesium.Cartesian2();
const _radioEarthToCenter = new Cesium.Cartesian3();
export const DEFAULT_RADIO_FILTER = 'all';
export const GLOBAL_RADIO_ALTITUDE_M = 2_000_000;

const MUSIC_GENRES = Object.freeze([
  ['alternative', 'Alternative'],
  ['ambient', 'Ambient'],
  ['blues', 'Blues'],
  ['classical', 'Classical'],
  ['country', 'Country'],
  ['dance', 'Dance'],
  ['electronic', 'Electronic'],
  ['folk', 'Folk'],
  ['funk', 'Funk'],
  ['hip hop', 'Hip-Hop'],
  ['house', 'House'],
  ['indie', 'Indie'],
  ['jazz', 'Jazz'],
  ['latin', 'Latin'],
  ['metal', 'Metal'],
  ['oldies', 'Oldies'],
  ['pop', 'Pop'],
  ['punk', 'Punk'],
  ['r&b', 'R&B'],
  ['reggae', 'Reggae'],
  ['rock', 'Rock'],
  ['soul', 'Soul'],
  ['techno', 'Techno'],
  ['trance', 'Trance'],
  ['world', 'World'],
]);

const CATEGORY_MATCHERS = Object.freeze({
  news: ['news', 'current affairs', 'journalism'],
  talk: ['talk', 'spoken word', 'interview', 'podcast'],
  weather: ['weather', 'emergency', 'noaa'],
  'public-safety': ['public safety', 'scanner', 'police', 'fire', 'ems', 'dispatch', 'emergency'],
  'aviation-marine': ['aviation', 'air traffic', 'atc', 'airport', 'marine', 'maritime', 'coast guard'],
  'traffic-transit': ['traffic', 'transit', 'transport', 'rail', 'metro'],
});

const RADIO_CATEGORY_COLORS = Object.freeze({
  all: '#b9fbff',
  news: '#44adff',
  talk: '#f2b84b',
  weather: '#ff5c78',
  'public-safety': '#ff8b4a',
  'aviation-marine': '#a87cff',
  'traffic-transit': '#ffd166',
  music: '#54d17a',
  other: '#9aa7b3',
});

const RADIO_CLUSTER_LABELS = Object.freeze({
  news: 'NEWS',
  talk: 'TALK',
  weather: 'WEATHER',
  'public-safety': 'SAFETY',
  'aviation-marine': 'AIR / SEA',
  'traffic-transit': 'TRANSIT',
  music: 'MUSIC',
  other: 'OTHER',
});

const RADIO_MARKER_CATEGORY_ORDER = Object.freeze([
  'news',
  'public-safety',
  'weather',
  'aviation-marine',
  'traffic-transit',
  'talk',
  'music',
]);
const DEFAULT_RADIO_VOLUME = 0.8;
const EMPTY_ACCEPTED_CATALOG_SNAPSHOT = Object.freeze({
  instance: null,
  generation: null,
  updatedAt: null,
  stations: Object.freeze([]),
  stationIds: Object.freeze([]),
});

let _viewer = null;
let _dataSource = null;
let _enabled = false;
let _managerLifecyclePresentation = null;
let _loading = false;
let _stale = false;
let _degraded = false;
let _error = null;
let _updatedAt = null;
let _acceptedCatalogSnapshot = EMPTY_ACCEPTED_CATALOG_SNAPSHOT;
let _stations = [];
let _stationById = new Map();
let _categories = [];
let _renderById = new Map();
let _filter = DEFAULT_RADIO_FILTER;
let _selectedId = null;
let _selectedEntity = null;
let _selectionGeneration = 0;
let _selectionTimer = null;
let _radioCameraNavigationGeneration = 0;
let _radioCameraFlightSequence = 0;
let _activeRadioCameraFlight = null;
let _audio = null;
let _audioStationId = null;
let _audioState = 'stopped';
let _audioError = null;
let _userVolume = DEFAULT_RADIO_VOLUME;
let _tuningActive = false;
let _tuningStatic = false;
let _tuningAwaitingStationId = null;
let _tuningPreviewId = null;
let _tuningStartStationId = null;
let _tuningResolutionSnapshot = EMPTY_ACCEPTED_CATALOG_SNAPSHOT;
let _tuningStationById = new Map();
let _tuningUnavailableStationId = null;
let _cancelledTuningPresentationStation = null;
let _tuningCameraNavigation = null;
let _tuningNoiseContext = null;
let _tuningNoiseSource = null;
let _tuningNoiseFilter = null;
let _tuningNoiseGain = null;
let _voiceDucked = false;
let _voiceRestoring = false;
let _voiceRestoreTimer = null;
let _volumeFadeFrame = null;
let _volumeTransitionGeneration = 0;
let _playGeneration = 0;
let _playAttemptSequence = 0;
let _activePlaybackAttempt = null;
let _playFallbackId = null;
let _playFallbackFocus = null;
let _playFallbackOrigin = 'programmatic';
let _playFallbackAttemptId = null;
let _clickHandler = null;
let _horizonTimer = null;
let _lastHorizonCameraPosition = null;
let _horizonScanCount = 0;
let _abortController = null;
let _requestGeneration = 0;
let _sessionGeneration = 0;
let _removeClusterListener = null;
let _overlayPublishTimer = null;
let _clusterOverlayIdentitySequence = 0;
let _clusterOverlayIdentities = [];
let _overlayDiagnostics = {
  entryCount: 0,
  selectedCount: 0,
  singletonTexts: [],
  singletonIds: [],
  clusterTexts: [],
  clusterIds: [],
  clusterMemberships: [],
};
const _listeners = new Set();
const _playbackControlListeners = new Set();
const VOICE_RESTORE_DELAY_MS = 650;
const VOICE_RESTORE_DURATION_MS = 1800;

function isNonGlobalRadioIpv4(hostname) {
  const pieces = hostname.split('.');
  if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece))) return false;
  const values = pieces.map(Number);
  if (values.some((value) => value > 255)) return true;
  const [a, b, c] = values;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function isSafeRadioHttpsUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || !hostname) return false;
    return !(
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || isNonGlobalRadioIpv4(hostname)
      || hostname.includes(':')
    );
  } catch {
    return false;
  }
}

function isValidRadioDirectoryStation(station) {
  const cleanText = (value, maxLength, { allowEmpty = true } = {}) => (
    typeof value === 'string'
    && value.length <= maxLength
    && (allowEmpty || value.trim().length > 0)
    && !/[\u0000-\u001f\u007f]/.test(value)
    && value === value.trim()
    && !/\s{2,}/.test(value)
  );
  const textArray = (value, limit, itemMaxLength) => (
    Array.isArray(value)
    && value.length <= limit
    && value.every((item) => cleanText(item, itemMaxLength, { allowEmpty: false }))
  );
  return Boolean(
    station
    && RADIO_UUID_RE.test(station.id)
    && cleanText(station.name, 140, { allowEmpty: false })
    && Number.isFinite(station.lat) && station.lat >= -90 && station.lat <= 90
    && Number.isFinite(station.lon) && station.lon >= -180 && station.lon <= 180
    && isSafeRadioHttpsUrl(station.streamUrl)
    && (station.homepage === null || isSafeRadioHttpsUrl(station.homepage))
    && textArray(station.tags, 24, 80)
    && textArray(station.languages, 8, 40)
    && cleanText(station.state, 80)
    && cleanText(station.country, 80)
    && cleanText(station.countryCode, 2)
    && (station.countryCode === '' || normalizeRadioCountryInput(station.countryCode).valid)
    && station.metadataTrust === 'untrusted-community'
    && cleanText(station.codec, 16, { allowEmpty: false })
    && /^(?:MP3|AAC(?:\+|-LC|-HE)?|HE-AAC)$/i.test(station.codec)
    && (station.bitrate === null
      || (Number.isInteger(station.bitrate) && station.bitrate >= 8 && station.bitrate <= 1024))
  );
}

function freezeRadioStation(station) {
  return Object.freeze({
    id: station.id,
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    streamUrl: station.streamUrl,
    homepage: station.homepage,
    tags: Object.freeze([...station.tags]),
    languages: Object.freeze([...station.languages]),
    state: station.state,
    country: station.country,
    countryCode: station.countryCode,
    metadataTrust: station.metadataTrust,
    codec: station.codec,
    bitrate: station.bitrate,
  });
}

function createAcceptedCatalogSnapshot(instance, generation, updatedAt, stations) {
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  if (typeof instance !== 'string' || !instance) return null;
  const frozenStations = Object.freeze(stations.map(freezeRadioStation));
  return Object.freeze({
    instance,
    generation,
    updatedAt,
    stations: frozenStations,
    stationIds: Object.freeze(frozenStations.map((station) => station.id)),
  });
}

const RADIO_GLOBE_LABEL_MAX_CHARS = 30;
const RADIO_LABEL_SEGMENTER = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

function compactRadioLabelText(value, maxChars) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const graphemes = RADIO_LABEL_SEGMENTER
    ? [...RADIO_LABEL_SEGMENTER.segment(text)].map((segment) => segment.segment)
    : Array.from(text);
  if (graphemes.length <= maxChars) return text;
  return `${graphemes.slice(0, Math.max(1, maxChars - 1)).join('').trimEnd()}…`;
}

function cleanRadioLabelName(value) {
  return String(value || '')
    .replace(/^[\s|:·\-–—]+|[\s|:·\-–—]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+\([^()]{1,40}\)$/, '')
    .replace(/\s+FM$/i, '')
    .trim();
}

/** Return compact frequency-first text for a Radio globe label. */
export function radioGlobeLabel(station) {
  const fullName = String(station?.name || '').replace(/\s+/g, ' ').trim();
  if (!fullName) return '';

  let frequency = null;
  let labelName = '';
  const explicitMatches = [...fullName.matchAll(/(\d{2,3}(?:\.\d{1,2})?)\s*FM\b/gi)];
  const explicit = explicitMatches.find((match) => {
    const value = Number(match[1]);
    return value >= 64 && value <= 108;
  });
  if (explicit) {
    frequency = explicit[1];
    const before = cleanRadioLabelName(fullName.slice(0, explicit.index));
    const after = cleanRadioLabelName(fullName.slice(explicit.index + explicit[0].length));
    labelName = before || after;
  } else {
    // Infer only a leading decimal in the conventional FM band. Integers such
    // as "80's" or "100 GREATEST" and domains such as "1.fm" stay names.
    const leading = fullName.match(/^(\d{2,3}\.\d{1,2})(?:\s+|\s*[-–—]\s*)(.+)$/);
    const value = Number(leading?.[1]);
    if (leading && value >= 87.5 && value <= 108) {
      frequency = leading[1];
      labelName = cleanRadioLabelName(leading[2].split(/\s+[-–—]\s+/)[0]);
    }
  }

  if (!frequency) return compactRadioLabelText(fullName, RADIO_GLOBE_LABEL_MAX_CHARS);
  const prefix = `${frequency} FM`;
  if (!labelName) return prefix;
  const nameBudget = RADIO_GLOBE_LABEL_MAX_CHARS - prefix.length - 3;
  return `${prefix} — ${compactRadioLabelText(labelName, nameBudget)}`;
}

/** Build the protected selected-station text published through WorldOverlay. */
export function createRadioSelectedOverlayEntry(station, position) {
  if (!station?.id || !station?.name || !position) return null;
  return {
    id: `selected:${station.id}`,
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-label',
    priority: Number.MAX_SAFE_INTEGER,
    title: radioGlobeLabel(station),
    accent: radioCategoryColor(radioStationCategoryId(station)),
    interactive: false,
    anchorRadiusPx: 20,
    minAnchorGapPx: 8,
    verticalOnly: true,
    placement: 'above',
    gapPx: 8,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    maxDistance: RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
  };
}

/** Build one bounded ambient cluster badge for the shared overlay host. */
export function createRadioClusterOverlayEntry({ id, position, text, accent, stationCount }) {
  if (!id || !position || !text) return null;
  return {
    id: `cluster:${id}`,
    position,
    variant: 'label',
    paintLane: 'ambient-label',
    collisionGroup: 'ambient-label',
    priority: Math.max(1, Number(stationCount) || 1),
    title: text,
    accent: accent || RADIO_CATEGORY_COLORS.other,
    interactive: false,
    anchorRadiusPx: Math.min(13, 6 + Math.log2(Math.max(1, Number(stationCount) || 1)) * 0.8),
    minAnchorGapPx: 4,
    verticalOnly: true,
    placement: 'above',
    gapPx: 6,
    // Cluster membership/counts update continuously while the camera moves.
    // Paint them as hard-opacity incumbents so a replacement count never
    // cross-fades with its predecessor or dims merely for leaving the keyhole.
    // Collision, viewport rejection, and horizon culling remain host-owned.
    stateless: true,
    edgeFade: 'none',
    horizonCull: true,
    terrainOcclusion: false,
    // The camera can sit above 24,000 km in the supported full-globe view, and
    // horizon clusters are farther from it than the camera's surface altitude.
    maxDistance: RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
    distanceScale: {
      near: 100_000,
      nearValue: 1.08,
      far: RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
      farValue: 0.92,
    },
  };
}

/** Build one ambient station label while Cesium retains its point and picking. */
export function createRadioSingletonOverlayEntry({ station, position, priority = 1 }) {
  if (!station?.id || !station?.name || !position) return null;
  return {
    id: `station:${station.id}`,
    position,
    variant: 'label',
    paintLane: 'ambient-label',
    collisionGroup: 'ambient-label',
    priority: Math.max(1, Number(priority) || 1),
    title: radioGlobeLabel(station),
    accent: radioCategoryColor(radioStationCategoryId(station)),
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 4,
    verticalOnly: true,
    placement: 'above',
    gapPx: 5,
    // Camera/filter changes replace this bounded cohort. Prevent the prior
    // cohort from fading over the current visible points.
    stateless: true,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    maxDistance: RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
    distanceScale: {
      near: 100_000,
      nearValue: 1,
      far: RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
      farValue: 0.86,
    },
  };
}

/** Return the bounded singleton-label allowance for the current camera scale. */
export function radioSingletonLabelLimit(cameraHeightM) {
  const height = Math.max(0, Number(cameraHeightM) || 0);
  if (height >= GLOBAL_RADIO_ALTITUDE_M) return RADIO_SINGLETON_GLOBAL_LIMIT;
  if (height >= 250_000) return RADIO_SINGLETON_MID_LIMIT;
  return RADIO_SINGLETON_NEAR_LIMIT;
}

/** Rank visible singleton stations by camera distance and stable station id. */
export function selectRadioSingletonCandidates(candidates, limit = RADIO_SINGLETON_NEAR_LIMIT) {
  const distance = (candidate) => {
    const value = Number(candidate?.distanceM);
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };
  return [...(candidates || [])]
    .sort((a, b) => (
      distance(a) - distance(b)
      || String(a?.station?.id || a?.id || '').localeCompare(String(b?.station?.id || b?.id || ''))
    ))
    .slice(0, Math.max(0, Math.floor(Number(limit) || 0)));
}

/** Rank and cap ambient Radio clusters before shared-host entry allocation. */
export function selectRadioClusterCandidates(candidates, limit = RADIO_OVERLAY_COHORT_LIMIT) {
  return [...(candidates || [])]
    .sort((a, b) => (
      (Number(b?.stationCount) || 0) - (Number(a?.stationCount) || 0)
      || String(a?.id || '').localeCompare(String(b?.id || ''))
    ))
    .slice(0, Math.max(0, Math.floor(Number(limit) || 0)));
}

/**
 * Preserve one-to-one overlay identity for overlapping clusters.
 * Cesium clustering is screen-space, so a small camera move may alter exact
 * membership even when the same geographic cluster remains visible. Every
 * positive overlap participates in greatest-contributor discovery, while
 * inheritance remains mutual-best: a current cluster accepts only one of its
 * greatest contributors and a prior identity transfers only to one of its
 * strongest split children.
 */
export function reconcileRadioClusterCandidates(candidates, previous = [], createId = null) {
  const current = (Array.isArray(candidates) ? candidates : []).map((candidate, index) => {
    const stationIds = [...new Set((candidate?.stationIds || []).map((id) => String(id)))].sort();
    const membershipId = String(candidate?.id || `membership:${stationIds.join('|')}`);
    return {
      ...candidate,
      _reconcileIndex: index,
      _reconcileMembershipId: membershipId,
      _reconcileCanonicalKey: `${membershipId}\u0000${stationIds.join('\u0000')}`,
      stationIds,
    };
  });
  const priorMembershipsByIdentity = new Map();
  for (const candidate of Array.isArray(previous) ? previous : []) {
    const identityId = String(candidate?.identityId || candidate?.id || '');
    if (!identityId) continue;
    if (!priorMembershipsByIdentity.has(identityId)) {
      priorMembershipsByIdentity.set(identityId, new Set());
    }
    const membership = priorMembershipsByIdentity.get(identityId);
    for (const stationId of candidate?.stationIds || []) membership.add(String(stationId));
  }
  const prior = [...priorMembershipsByIdentity]
    .map(([identityId, stationIds]) => ({
      identityId,
      stationIds: [...stationIds].sort(),
    }))
    .filter((candidate) => candidate.stationIds.length)
    .sort((a, b) => a.identityId.localeCompare(b.identityId));
  const priorByStation = new Map();
  for (let priorIndex = 0; priorIndex < prior.length; priorIndex += 1) {
    for (const stationId of prior[priorIndex].stationIds) {
      if (!priorByStation.has(stationId)) priorByStation.set(stationId, []);
      priorByStation.get(stationId).push(priorIndex);
    }
  }

  const edges = [];
  const greatestOverlapByCurrent = new Map();
  const greatestOverlapByPrior = new Map();
  for (let currentIndex = 0; currentIndex < current.length; currentIndex += 1) {
    const overlapByPrior = new Map();
    for (const stationId of current[currentIndex].stationIds) {
      for (const priorIndex of priorByStation.get(stationId) || []) {
        overlapByPrior.set(priorIndex, (overlapByPrior.get(priorIndex) || 0) + 1);
      }
    }
    for (const [priorIndex, overlap] of overlapByPrior) {
      const union = current[currentIndex].stationIds.length + prior[priorIndex].stationIds.length - overlap;
      const smaller = Math.min(current[currentIndex].stationIds.length, prior[priorIndex].stationIds.length);
      const score = smaller > 0 ? overlap / smaller : 0;
      const similarity = union > 0 ? overlap / union : 0;
      edges.push({ currentIndex, priorIndex, overlap, score, similarity });
      greatestOverlapByCurrent.set(
        currentIndex,
        Math.max(greatestOverlapByCurrent.get(currentIndex) || 0, overlap),
      );
      greatestOverlapByPrior.set(
        priorIndex,
        Math.max(greatestOverlapByPrior.get(priorIndex) || 0, overlap),
      );
    }
  }
  const eligibleEdges = edges.filter((edge) => (
    edge.overlap === greatestOverlapByCurrent.get(edge.currentIndex)
    && edge.overlap === greatestOverlapByPrior.get(edge.priorIndex)
  ));
  eligibleEdges.sort((a, b) => (
    // Identity follows the contributor representing the largest share of the
    // new cluster. Overlap-coefficient-first incorrectly lets a fully retained
    // two-station minority beat a larger partial contributor during a merge.
    b.overlap - a.overlap
    || b.score - a.score
    || b.similarity - a.similarity
    || current[a.currentIndex]._reconcileCanonicalKey
      .localeCompare(current[b.currentIndex]._reconcileCanonicalKey)
    || prior[a.priorIndex].identityId.localeCompare(prior[b.priorIndex].identityId)
  ));

  const inheritedByCurrent = new Map();
  const usedPriorIdentities = new Set();
  for (const edge of eligibleEdges) {
    const identityId = prior[edge.priorIndex].identityId;
    if (inheritedByCurrent.has(edge.currentIndex) || usedPriorIdentities.has(identityId)) continue;
    inheritedByCurrent.set(edge.currentIndex, prior[edge.priorIndex].identityId);
    usedPriorIdentities.add(identityId);
  }

  const generatedByCurrent = new Map();
  if (typeof createId === 'function') {
    const freshIndices = current
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ index }) => !inheritedByCurrent.has(index))
      .sort((a, b) => (
        a.candidate._reconcileCanonicalKey.localeCompare(b.candidate._reconcileCanonicalKey)
      ));
    for (const { candidate, index } of freshIndices) {
      generatedByCurrent.set(index, String(createId(candidate, index) || ''));
    }
  }

  return current.map((candidate, index) => {
    const membershipId = candidate._reconcileMembershipId;
    const inherited = inheritedByCurrent.get(index);
    const generated = generatedByCurrent.get(index) || '';
    const identityId = inherited || generated || membershipId;
    const {
      _reconcileIndex,
      _reconcileMembershipId,
      _reconcileCanonicalKey,
      ...rest
    } = candidate;
    return { ...rest, membershipId, identityId, id: identityId };
  });
}

function resetRadioClusterOverlayIdentities() {
  _clusterOverlayIdentities = [];
}

function emptyRadioOverlayDiagnostics() {
  return {
    entryCount: 0,
    selectedCount: 0,
    singletonTexts: [],
    singletonIds: [],
    clusterTexts: [],
    clusterIds: [],
    clusterMemberships: [],
  };
}

function clampRadioVolume(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

/** Return whether camera translation materially changes horizon visibility. */
export function radioCameraPositionChanged(previous, current, epsilonM = HORIZON_CAMERA_MOVE_EPSILON_M) {
  if (!previous || !current) return true;
  const dx = Number(current.x) - Number(previous.x);
  const dy = Number(current.y) - Number(previous.y);
  const dz = Number(current.z) - Number(previous.z);
  if (![dx, dy, dz].every(Number.isFinite)) return true;
  const threshold = Math.max(0, Number(epsilonM) || 0);
  return dx * dx + dy * dy + dz * dz > threshold * threshold;
}

function cancelRadioVolumeTransition() {
  _volumeTransitionGeneration += 1;
  if (_voiceRestoreTimer) clearTimeout(_voiceRestoreTimer);
  _voiceRestoreTimer = null;
  if (_volumeFadeFrame) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(_volumeFadeFrame);
    else clearTimeout(_volumeFadeFrame);
  }
  _volumeFadeFrame = null;
}

function scheduleVolumeFrame(callback) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(() => callback(Date.now()), 16);
}

function volumeClock() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Normalize one directory tag to a stable, lower-case display token. */
export function normalizeRadioTag(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function stationTags(station) {
  if (Array.isArray(station?.tags)) return station.tags.map(normalizeRadioTag).filter(Boolean);
  return String(station?.tags ?? '')
    .split(',')
    .map(normalizeRadioTag)
    .filter(Boolean);
}

function hasTag(station, needles) {
  const tags = stationTags(station);
  return needles.some((needle) => tags.some((tag) => tag === needle || tag.includes(needle)));
}

function detectedGenres(station) {
  return MUSIC_GENRES.filter(([genre]) => hasTag(station, [genre])).map(([genre]) => genre);
}

/** Return whether a station belongs in a station-tag category. */
export function stationMatchesRadioCategory(station, categoryId) {
  if (categoryId === 'all') return true;
  if (categoryId.startsWith('genre:')) {
    return detectedGenres(station).includes(categoryId.slice('genre:'.length));
  }
  if (categoryId === 'music') {
    return detectedGenres(station).length > 0
      || hasTag(station, ['music', 'hits', 'songs']);
  }
  if (categoryId === 'other') {
    return !Object.entries(CATEGORY_MATCHERS).some(([id]) => stationMatchesRadioCategory(station, id))
      && !stationMatchesRadioCategory(station, 'music');
  }
  return hasTag(station, CATEGORY_MATCHERS[categoryId] || []);
}

/** Return the shared CSS color for a canonical or detected-genre category. */
export function radioCategoryColor(categoryId = 'other') {
  const normalized = String(categoryId || 'other');
  const canonical = normalized.startsWith('genre:') ? 'music' : normalized;
  return RADIO_CATEGORY_COLORS[canonical] || RADIO_CATEGORY_COLORS.other;
}

/** Format the concise count/category badge shown above a Radio cluster. */
export function radioClusterBadgeText(categoryId = 'other', count = 0) {
  const normalized = String(categoryId || 'other');
  const canonical = normalized.startsWith('genre:') ? 'music' : normalized;
  const label = RADIO_CLUSTER_LABELS[canonical] || RADIO_CLUSTER_LABELS.other;
  const stationCount = Math.max(0, Math.floor(Number(count) || 0));
  return `${stationCount} ${label}`;
}

/** Choose the category advertised by a cluster in the active station-tag view. */
export function radioClusterCategoryId(stations, activeFilter = 'all') {
  const filter = String(activeFilter || 'all');
  if (filter !== 'all') {
    if (filter.startsWith('genre:') || RADIO_MARKER_CATEGORY_ORDER.includes(filter) || filter === 'other') {
      return filter;
    }
    return 'other';
  }
  const categoryCounts = new Map();
  for (const station of Array.isArray(stations) ? stations : []) {
    const categoryId = radioStationCategoryId(station);
    categoryCounts.set(categoryId, (categoryCounts.get(categoryId) || 0) + 1);
  }
  let clusterCategory = 'other';
  let clusterCategoryCount = 0;
  for (const categoryId of RADIO_MARKER_CATEGORY_ORDER) {
    const count = categoryCounts.get(categoryId) || 0;
    if (count > clusterCategoryCount) {
      clusterCategory = categoryId;
      clusterCategoryCount = count;
    }
  }
  if ((categoryCounts.get('other') || 0) > clusterCategoryCount) return 'other';
  return clusterCategory;
}

/** Build the code-native four-corner bracket used by the selected station. */
export function radioSelectionBracketSvg(color = RADIO_CATEGORY_COLORS.other) {
  const stroke = /^#[0-9a-f]{6}$/i.test(String(color)) ? String(color) : RADIO_CATEGORY_COLORS.other;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><path d="M2 13V2H13 M27 2H38V13 M38 27V38H27 M13 38H2V27" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="square"/></svg>`;
}

/** Choose one stable display category for a station that may match several filters. */
export function radioStationCategoryId(station) {
  return RADIO_MARKER_CATEGORY_ORDER.find((categoryId) => (
    stationMatchesRadioCategory(station, categoryId)
  )) || 'other';
}

/** Build canonical and detected-genre categories from station-level tags. */
export function buildRadioCategories(stations) {
  const rows = Array.isArray(stations) ? stations : [];
  const categories = [
    { id: 'all', label: 'All' },
    { id: 'news', label: 'News' },
    { id: 'talk', label: 'Talk' },
    { id: 'weather', label: 'Weather / Emergency' },
    { id: 'public-safety', label: 'Public Safety' },
    { id: 'aviation-marine', label: 'Aviation / Marine' },
    { id: 'traffic-transit', label: 'Traffic / Transit' },
    { id: 'music', label: 'Music' },
  ];

  for (const [genre, label] of MUSIC_GENRES) {
    const id = `genre:${genre}`;
    if (rows.some((station) => stationMatchesRadioCategory(station, id))) {
      categories.push({ id, label });
    }
  }
  categories.push({ id: 'other', label: 'Other' });
  return categories.map((category) => ({
    ...category,
    color: radioCategoryColor(category.id),
    count: rows.filter((station) => stationMatchesRadioCategory(station, category.id)).length,
  }));
}

/** Filter stations without changing the active stream or selection. */
export function filterRadioStations(stations, categoryId = 'all') {
  return (Array.isArray(stations) ? stations : [])
    .filter((station) => stationMatchesRadioCategory(station, categoryId));
}

/** Return whether Radio Browser metadata identifies a station as English-language. */
export function isEnglishRadioStation(station) {
  const languages = Array.isArray(station?.languages) ? station.languages : [];
  return languages.some((language) => {
    const normalized = normalizeRadioTag(language);
    return normalized === 'en' || normalized === 'eng' || normalized.startsWith('english');
  });
}

function radioAngularDistance(station, anchor) {
  const lat1 = Cesium.Math.toRadians(Number(anchor?.lat));
  const lon1 = Cesium.Math.toRadians(Number(anchor?.lon));
  const lat2 = Cesium.Math.toRadians(Number(station?.lat));
  const lon2 = Cesium.Math.toRadians(Number(station?.lon));
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
  const deltaLat = lat2 - lat1;
  const deltaLon = lon2 - lon1;
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(Math.max(0, haversine))));
}

/** Rank a copied station list by viewport distance, with an optional English-first tier. */
export function rankRadioStationsForViewport(stations, anchor, { preferEnglish = false } = {}) {
  return (Array.isArray(stations) ? stations : [])
    .map((station, index) => ({
      station,
      index,
      distance: radioAngularDistance(station, anchor),
      languageTier: preferEnglish && !isEnglishRadioStation(station) ? 1 : 0,
    }))
    .sort((a, b) => a.languageTier - b.languageTier || a.distance - b.distance || a.index - b.index)
    .map(({ station }) => station);
}

/** Rank stations for an explicit voice/player request without moving the camera. */
export function rankRadioStationsForRequest(stations, {
  categoryId = 'all',
  anchor = null,
  country = '',
  stationQuery = '',
} = {}) {
  const countryFilter = normalizeRadioCountryInput(country);
  if (!countryFilter.valid) return [];
  const query = normalizeRadioTag(stationQuery);
  let matches = filterRadioStations(stations, categoryId);
  if (countryFilter.code || countryFilter.name) {
    matches = matches.filter((station) => {
      const stationCode = String(station?.countryCode || '').trim().toUpperCase();
      const stationCountry = normalizeRadioCountryInput(station?.country);
      return (countryFilter.code && stationCode === countryFilter.code)
        || (countryFilter.code && stationCountry.valid && stationCountry.code === countryFilter.code);
    });
  }
  if (query) {
    matches = matches.filter((station) => [
      station?.id,
      station?.name,
      station?.state,
      station?.country,
      station?.countryCode,
      ...(Array.isArray(station?.tags) ? station.tags : []),
    ].some((value) => normalizeRadioTag(value).includes(query)));
  }
  return anchor
    ? rankRadioStationsForViewport(matches, anchor)
    : matches.slice();
}

/** Classify a globe-scale Radio view without flapping on Cesium height round-off. */
export function radioViewIsGlobal(altitudeM) {
  return Number.isFinite(altitudeM) && Math.round(altitudeM) >= GLOBAL_RADIO_ALTITUDE_M;
}

/** Pure stale-response guard shared by the async directory update path. */
export function radioRequestIsCurrent(
  generation,
  currentGeneration,
  enabled,
  sessionGeneration = null,
  currentSessionGeneration = sessionGeneration,
) {
  return generation === currentGeneration
    && Boolean(enabled)
    && sessionGeneration === currentSessionGeneration;
}

/** Resolve a station id from ordinary, selected, or Cesium cluster pick shapes. */
export function radioStationIdFromPick(picked) {
  const pending = [picked?.id, picked?.primitive?.id];
  const seen = new Set();
  while (pending.length) {
    const value = pending.shift();
    if (typeof value === 'string' || typeof value === 'number') {
      const id = String(value);
      if (id.startsWith(`${RADIO_PREFIX}selected:`)) return id.slice(`${RADIO_PREFIX}selected:`.length);
      if (id.startsWith(RADIO_PREFIX)) return id.slice(RADIO_PREFIX.length);
      continue;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) pending.push(...value);
    else {
      pending.push(value.id);
      if (value.primitive) pending.push(value.primitive.id);
    }
  }
  return null;
}

/** Map an integer tuner slot directly to one available directory station. */
export function radioTunerSlot(value, stationCount) {
  const count = Math.max(0, Math.floor(Number(stationCount) || 0));
  if (!count) return { slot: 0, max: 0, locked: false, stationIndex: -1, leftIndex: -1, rightIndex: -1 };
  const max = Math.max(0, count - 1);
  const slot = Math.min(max, Math.max(0, Math.round(Number(value) || 0)));
  return {
    slot,
    max,
    locked: true,
    stationIndex: slot,
    leftIndex: slot,
    rightIndex: slot,
  };
}

/** Snap a tuner release to the nearest available directory station. */
export function radioTunerCommitSlot(value, stationCount) {
  return radioTunerSlot(value, stationCount);
}

/** Map one pointer coordinate to continuous absolute directory progress. */
export function radioTunerPointerPosition(clientX, left, width, stationCount, insetPx = 7) {
  const count = Math.max(0, Math.floor(Number(stationCount) || 0));
  if (!count) return { ratio: 0, coordinate: 0, stationIndex: -1 };
  if (count === 1) return { ratio: 0.5, coordinate: 0, stationIndex: 0 };
  const inset = Math.max(0, Number(insetPx) || 0);
  const usableWidth = Math.max(1, (Number(width) || 0) - inset * 2);
  const ratio = Math.min(1, Math.max(0, ((Number(clientX) || 0) - (Number(left) || 0) - inset) / usableWidth));
  const coordinate = ratio * (count - 1);
  return {
    ratio,
    coordinate,
    stationIndex: Math.min(count - 1, Math.max(0, Math.floor(coordinate + 0.5))),
  };
}

/** Build a bounded virtual tuner tape around one continuous directory coordinate. */
export function buildRadioTunerTicks(coordinate, stationCount, width, {
  insetPx = 7,
  minPitchPx = 14,
  speedFactor = 5,
  overscan = 2,
  labelStep = 6,
} = {}) {
  const count = Math.max(0, Math.floor(Number(stationCount) || 0));
  const dialWidth = Math.max(0, Number(width) || 0);
  const inset = Math.max(0, Number(insetPx) || 0);
  const usableWidth = Math.max(0, dialWidth - inset * 2);
  if (!count) return { ticks: [], needleX: inset, pitchPx: 0, ratio: 0 };
  const value = Math.min(count - 1, Math.max(0, Number(coordinate) || 0));
  if (count === 1) {
    return {
      ticks: [{ stationIndex: 0, channel: 1, xPx: inset + usableWidth / 2, current: true, label: '01' }],
      needleX: inset + usableWidth / 2,
      pitchPx: Math.max(1, Number(minPitchPx) || 14),
      ratio: 0.5,
    };
  }
  const directoryStep = usableWidth / (count - 1);
  const pitchPx = Math.max(
    Math.max(1, Number(minPitchPx) || 14),
    directoryStep * Math.max(1, Number(speedFactor) || 5),
  );
  const needleX = inset + directoryStep * value;
  const overscanPx = pitchPx * Math.max(0, Number(overscan) || 0);
  const first = Math.max(0, Math.ceil(value + (-overscanPx - needleX) / pitchPx));
  const last = Math.min(count - 1, Math.floor(value + (dialWidth + overscanPx - needleX) / pitchPx));
  const currentIndex = Math.min(count - 1, Math.max(0, Math.floor(value + 0.5)));
  const majorEvery = Math.max(1, Math.floor(Number(labelStep) || 6));
  const labelWidth = Math.max(2, String(count).length);
  const ticks = [];
  for (let stationIndex = first; stationIndex <= last; stationIndex += 1) {
    const channel = stationIndex + 1;
    const current = stationIndex === currentIndex;
    const labelled = current || stationIndex === 0 || stationIndex === count - 1 || channel % majorEvery === 0;
    ticks.push({
      stationIndex,
      channel,
      xPx: needleX + pitchPx * (stationIndex - value),
      current,
      label: labelled ? String(channel).padStart(labelWidth, '0') : '',
    });
  }
  return { ticks, needleX, pitchPx, ratio: value / (count - 1) };
}

/** Plan a station-centered camera move that preserves altitude and view angle. */
export function radioStationCameraPlan(station, cameraState = {}) {
  const targetLat = Number(station?.lat);
  const targetLon = Number(station?.lon);
  const height = Math.max(1, Number(cameraState.height) || 1);
  const heading = Number.isFinite(cameraState.heading) ? cameraState.heading : 0;
  const pitch = Number.isFinite(cameraState.pitch) ? cameraState.pitch : -Math.PI / 2;
  const roll = Number.isFinite(cameraState.roll) ? cameraState.roll : 0;
  if (!Number.isFinite(targetLat) || !Number.isFinite(targetLon)) return null;

  const downAngle = Math.min(Math.PI / 2, Math.max(0.08, Math.abs(Math.min(-0.001, pitch))));
  const groundOffsetM = downAngle > Math.PI / 2 - 1e-6
    ? 0
    : Math.min(2_000_000, height / Math.max(0.08, Math.tan(downAngle)));
  const angularDistance = groundOffsetM / 6_378_137;
  const targetLatRad = targetLat * Math.PI / 180;
  const cameraBearing = heading + Math.PI;
  const cameraLatRad = Math.asin(
    Math.sin(targetLatRad) * Math.cos(angularDistance)
      + Math.cos(targetLatRad) * Math.sin(angularDistance) * Math.cos(cameraBearing),
  );
  const cameraLonRad = targetLon * Math.PI / 180 + Math.atan2(
    Math.sin(cameraBearing) * Math.sin(angularDistance) * Math.cos(targetLatRad),
    Math.cos(angularDistance) - Math.sin(targetLatRad) * Math.sin(cameraLatRad),
  );
  const cameraLon = ((cameraLonRad * 180 / Math.PI + 540) % 360) - 180;
  return {
    lat: cameraLatRad * 180 / Math.PI,
    lon: cameraLon,
    height,
    heading,
    pitch,
    roll,
  };
}

/**
 * Decide whether Radio navigation should first restore a centered Earth view.
 * Fit-capable clipped discs and closer views whose optical center has reached
 * the Earth limb use the staged path; ordinary centered local views stay direct.
 */
export function radioGlobeNeedsRecentering(geometry) {
  if (!geometry || isFullGlobeInsideKeyhole(geometry, false)) return false;
  const centeredGeometry = {
    ...geometry,
    earthCenterX: geometry.keyholeCenterX,
    earthCenterY: geometry.keyholeCenterY,
  };
  if (isFullGlobeInsideKeyhole(centeredGeometry, false)) return true;
  const values = [
    geometry.earthCenterX,
    geometry.earthCenterY,
    geometry.earthRadius,
    geometry.keyholeCenterX,
    geometry.keyholeCenterY,
  ];
  if (!values.every(Number.isFinite) || geometry.earthRadius <= 0) return false;
  const centerOffset = Math.hypot(
    geometry.earthCenterX - geometry.keyholeCenterX,
    geometry.earthCenterY - geometry.keyholeCenterY,
  );
  return geometry.earthRadius - centerOffset < GLOBE_ENTER_CLEARANCE_PX;
}

/** Preserve closer zoom while capping an extreme full-globe recovery. */
export function radioGlobeRecenterHeight(currentHeight, fullGlobeCapable) {
  if (!Number.isFinite(currentHeight) || currentHeight < 0) return null;
  return fullGlobeCapable
    ? Math.min(currentHeight, RADIO_GLOBE_RECENTER_MAX_HEIGHT_M)
    : currentHeight;
}

/** Bound one already ordered filtered directory without injecting outside selections. */
export function buildRadioTunerBand(rankedStations, selected, limit = RADIO_TUNER_STATION_LIMIT) {
  const boundedLimit = Math.min(
    RADIO_TUNER_DIRECTORY_LIMIT,
    Math.max(1, Math.floor(Number(limit) || RADIO_TUNER_STATION_LIMIT)),
  );
  return (Array.isArray(rankedStations) ? rankedStations : []).slice(0, boundedLimit);
}

/** Decide whether tuner static should be audible for the current handoff state. */
export function radioTuningStaticShouldPlay({
  tuningActive = false,
  tuningStatic = false,
  awaitingStationId = null,
  voiceDucked = false,
} = {}) {
  return Boolean(tuningStatic && !voiceDucked && (tuningActive || awaitingStationId));
}

function markerPosition(station, liftM = MARKER_LIFT_M) {
  const floor = cachedGroundFloor(station.lat, station.lon);
  return Cesium.Cartesian3.fromDegrees(
    station.lon,
    station.lat,
    (Number.isFinite(floor) ? floor : 0) + liftM,
  );
}

function selectedStation() {
  return _selectedId ? _stationById.get(_selectedId) || null : null;
}

function selectedPresentationStation() {
  if (_tuningActive) return tuningResolutionStation(_tuningPreviewId);
  return _cancelledTuningPresentationStation || selectedStation();
}

function visibleStations() {
  return filterRadioStations(_stations, _filter);
}

function viewportRadioAnchor() {
  const camera = _viewer?.camera;
  const scene = _viewer?.scene;
  if (!camera) return null;
  const altitudeM = Number(camera.positionCartographic?.height);
  let cartographic = null;
  const canvas = scene?.canvas;
  if (canvas && typeof camera.pickEllipsoid === 'function') {
    const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const position = camera.pickEllipsoid(center, scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84);
    if (position) cartographic = Cesium.Cartographic.fromCartesian(position);
  }
  cartographic ||= camera.positionCartographic || null;
  if (!cartographic) return null;
  return {
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: Cesium.Math.toDegrees(cartographic.longitude),
    altitudeM,
    globalView: radioViewIsGlobal(altitudeM),
  };
}

function rankedVisibleStations() {
  const anchor = viewportRadioAnchor();
  return rankRadioStationsForViewport(visibleStations(), anchor, {
    preferEnglish: Boolean(anchor?.globalView),
  });
}

/** Return the deeply immutable healthy catalog generation shared with tuner consumers. */
export function getRadioAcceptedCatalogSnapshot() {
  return _acceptedCatalogSnapshot;
}

/** Compare every station field that determines tuner presentation and playback. */
export function radioStationResolutionMatches(frozenStation, currentStation) {
  if (!frozenStation || !currentStation) return false;
  for (const key of [
    'id', 'name', 'lat', 'lon', 'streamUrl', 'homepage', 'state', 'country',
    'countryCode', 'metadataTrust', 'codec', 'bitrate',
  ]) {
    if (frozenStation[key] !== currentStation[key]) return false;
  }
  return ['tags', 'languages'].every((key) => {
    const frozenValues = Array.isArray(frozenStation[key]) ? frozenStation[key] : [];
    const currentValues = Array.isArray(currentStation[key]) ? currentStation[key] : [];
    return frozenValues.length === currentValues.length
      && frozenValues.every((value, index) => value === currentValues[index]);
  });
}

function captureRadioTuningResolutionSnapshot() {
  return _acceptedCatalogSnapshot;
}

function tuningResolutionStation(id) {
  return id ? _tuningStationById.get(String(id)) || null : null;
}

/** Return an immutable snapshot consumed by the right-rail UI. */
export function getRadioUIState() {
  const visible = visibleStations();
  const selected = selectedStation();
  return Object.freeze({
    enabled: _enabled,
    loading: _loading,
    stale: _stale,
    degraded: _degraded,
    error: _error,
    updatedAt: _updatedAt,
    filter: _filter,
    categories: _categories,
    acceptedCatalogGeneration: _acceptedCatalogSnapshot.generation,
    presentationActive: radioPresentationAllowed(),
    stationCount: _stations.length,
    filteredCount: visible.length,
    selected,
    selectedIndex: selected ? visible.findIndex((station) => station.id === selected.id) : -1,
    audioState: _audioState,
    audioError: _audioError,
    playingStationId: _audioStationId,
    volume: _userVolume,
    effectiveVolume: _audio?.volume ?? (_voiceDucked ? 0 : _userVolume),
    voiceDucked: _voiceDucked,
    voiceRestoring: _voiceRestoring,
    tuningActive: _tuningActive,
    tuningStatic: _tuningStatic,
    tuningAwaitingStationId: _tuningAwaitingStationId,
    tuningPreviewStationId: _tuningPreviewId,
    tuningRestoredStationId: _cancelledTuningPresentationStation?.id || null,
    tuningCatalogGeneration: _tuningResolutionSnapshot.generation,
    tuningUnavailableStationId: _tuningUnavailableStationId,
  });
}

function emitState() {
  const snapshot = getRadioUIState();
  for (const listener of _listeners) {
    try {
      listener(snapshot);
    } catch {
      // A broken consumer must not break playback or rendering.
    }
  }
}

/** Subscribe to radio state; the current state is delivered immediately. */
export function subscribeToRadio(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  listener(getRadioUIState());
  return () => _listeners.delete(listener);
}

/** Subscribe to explicit playback controls so voice handoffs cannot undo them. */
export function subscribeToRadioPlaybackControls(listener) {
  if (typeof listener !== 'function') return () => {};
  _playbackControlListeners.add(listener);
  return () => _playbackControlListeners.delete(listener);
}

function emitPlaybackControl(action, origin, attemptId = _activePlaybackAttempt?.id || null) {
  const event = { action, origin, attemptId };
  for (const listener of _playbackControlListeners) {
    try {
      listener(event);
    } catch {
      // Playback controls must remain usable if an observer fails.
    }
  }
}

function audioEventBelongsToActiveAttempt(audio) {
  const attempt = _activePlaybackAttempt;
  return _audio === audio
    && Boolean(attempt)
    && attempt.generation === _playGeneration
    && attempt.stationId === _audioStationId;
}

function installAudio({ replace = false } = {}) {
  if (_audio && !replace) return;
  if (typeof Audio === 'undefined') return;
  const previousAudio = _audio;
  _audio = null;
  if (previousAudio) {
    try { previousAudio.pause(); } catch { /* already stopped */ }
    try { previousAudio.removeAttribute('src'); } catch { /* no source */ }
    try { previousAudio.load(); } catch { /* detached media */ }
  }
  const audio = new Audio();
  _audio = audio;
  audio.preload = 'none';
  audio.volume = _voiceDucked ? 0 : _userVolume;
  audio.addEventListener('playing', () => {
    if (_audio !== audio) return;
    if (!audioEventBelongsToActiveAttempt(audio)) return;
    if (!['loading', 'buffering', 'playing'].includes(_audioState)) return;
    _audioState = 'playing';
    _audioError = null;
    if (_tuningAwaitingStationId === _audioStationId) clearRadioTuningNoise({ emit: false });
    emitState();
  });
  audio.addEventListener('pause', () => {
    if (_audio !== audio) return;
    if (_audioState === 'stopped' || _audioState === 'loading') return;
    _audioState = 'paused';
    emitState();
  });
  audio.addEventListener('waiting', () => {
    if (_audio !== audio) return;
    if (!audioEventBelongsToActiveAttempt(audio)) return;
    if (!['loading', 'buffering', 'playing'].includes(_audioState)) return;
    _audioState = 'buffering';
    emitState();
  });
  audio.addEventListener('error', () => {
    if (_audio !== audio) return;
    if (!audioEventBelongsToActiveAttempt(audio)) return;
    if (!['loading', 'buffering', 'playing'].includes(_audioState)) return;
    const failedId = _audioStationId;
    const attempt = _activePlaybackAttempt;
    if (tryRadioFallback(failedId, attempt?.origin, attempt?.id)) return;
    _audioState = 'error';
    _audioError = 'Broadcaster stream is unavailable or blocked by the browser.';
    emitState();
  });
}

function stopTuningNoiseSource() {
  if (_tuningNoiseSource) {
    try { _tuningNoiseSource.stop(); } catch { /* already stopped */ }
    try { _tuningNoiseSource.disconnect(); } catch { /* already disconnected */ }
  }
  try { _tuningNoiseFilter?.disconnect(); } catch { /* already disconnected */ }
  try { _tuningNoiseGain?.disconnect(); } catch { /* already disconnected */ }
  _tuningNoiseSource = null;
  _tuningNoiseFilter = null;
  _tuningNoiseGain = null;
}

function syncTuningNoiseGain() {
  if (!_tuningNoiseContext || !_tuningNoiseGain) return;
  const audible = radioTuningStaticShouldPlay({
    tuningActive: _tuningActive,
    tuningStatic: _tuningStatic,
    awaitingStationId: _tuningAwaitingStationId,
    voiceDucked: _voiceDucked,
  });
  const target = audible
    ? Math.min(RADIO_TUNER_STATIC_MAX_GAIN, _userVolume * 0.03)
    : 0;
  const now = _tuningNoiseContext.currentTime;
  _tuningNoiseGain.gain.cancelScheduledValues(now);
  _tuningNoiseGain.gain.setValueAtTime(_tuningNoiseGain.gain.value, now);
  _tuningNoiseGain.gain.linearRampToValueAtTime(target, now + 0.025);
}

function installTuningNoise() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) return false;
  if (!_tuningNoiseContext) _tuningNoiseContext = new AudioContextClass();
  const resumed = _tuningNoiseContext.resume?.();
  if (resumed?.catch) void resumed.catch(() => {});
  if (_tuningNoiseSource) return true;

  const frameCount = Math.max(1, Math.floor(_tuningNoiseContext.sampleRate * 0.75));
  const buffer = _tuningNoiseContext.createBuffer(1, frameCount, _tuningNoiseContext.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < channel.length; index += 1) channel[index] = Math.random() * 2 - 1;

  _tuningNoiseSource = _tuningNoiseContext.createBufferSource();
  _tuningNoiseFilter = _tuningNoiseContext.createBiquadFilter();
  _tuningNoiseGain = _tuningNoiseContext.createGain();
  _tuningNoiseSource.buffer = buffer;
  _tuningNoiseSource.loop = true;
  _tuningNoiseFilter.type = 'bandpass';
  _tuningNoiseFilter.frequency.value = 1_650;
  _tuningNoiseFilter.Q.value = 0.55;
  _tuningNoiseGain.gain.value = 0;
  _tuningNoiseSource.connect(_tuningNoiseFilter);
  _tuningNoiseFilter.connect(_tuningNoiseGain);
  _tuningNoiseGain.connect(_tuningNoiseContext.destination);
  _tuningNoiseSource.start();
  return true;
}

/** Return the complete accepted filtered directory in stable catalog order. */
export function getRadioTunerStations(limit = RADIO_TUNER_STATION_LIMIT) {
  if (!radioPresentationAllowed() || !_acceptedCatalogSnapshot.stations.length) return [];
  return buildRadioTunerBand(visibleStations(), selectedStation(), limit);
}

/** Begin a direct-manipulation tuning gesture and pause the current stream. */
export function beginRadioTuning() {
  if (!radioPresentationAllowed() || !visibleStations().length) return false;
  const snapshot = captureRadioTuningResolutionSnapshot();
  if (!Number.isSafeInteger(snapshot.generation) || !snapshot.stations.length) return false;
  _tuningResolutionSnapshot = snapshot;
  _tuningStationById = new Map(
    _tuningResolutionSnapshot.stations.map((station) => [station.id, station]),
  );
  _tuningUnavailableStationId = null;
  _tuningActive = true;
  _tuningStatic = false;
  _tuningAwaitingStationId = null;
  _cancelledTuningPresentationStation = null;
  _tuningStartStationId = _selectedId;
  _tuningPreviewId = _selectedId;
  installTuningNoise();
  pauseRadioPlayback({ origin: 'user' });
  syncTuningNoiseGain();
  emitState();
  return true;
}

/** Toggle low-volume synthesized static for tuner preview and stream handoff. */
export function setRadioTuningStatic(active) {
  if (!radioPresentationAllowed() || !_tuningActive) return false;
  const next = Boolean(active);
  if (next === _tuningStatic) return true;
  _tuningStatic = next;
  syncTuningNoiseGain();
  emitState();
  return true;
}

function radioCameraState(camera = _viewer?.camera) {
  if (!camera) return null;
  return {
    height: camera.positionCartographic?.height,
    heading: camera.heading,
    pitch: camera.pitch,
    roll: camera.roll,
  };
}

/** Radio may move the globe only while no tracked entity owns the follow camera. */
export function radioCameraNavigationAllowed(viewer = _viewer) {
  return Boolean(viewer?.camera) && !viewer.trackedEntity;
}

function radioGlobeRecenterPlan(viewer = _viewer) {
  const camera = viewer?.camera;
  const canvas = viewer?.scene?.canvas;
  const width = canvas?.clientWidth || canvas?.width;
  const height = canvas?.clientHeight || canvas?.height;
  const cartographic = camera?.positionCartographic;
  if (!camera || !cartographic || !(width > 0) || !(height > 0)) return null;
  const geometry = projectEarthDiscToViewport(
    viewer,
    width,
    height,
    _radioEarthScreenCenter,
    _radioEarthToCenter,
  );
  let fullGlobeCapable = false;
  if (geometry) {
    if (!radioGlobeNeedsRecentering(geometry)) return null;
    fullGlobeCapable = isFullGlobeInsideKeyhole({
      ...geometry,
      earthCenterX: geometry.keyholeCenterX,
      earthCenterY: geometry.keyholeCenterY,
    }, false);
  } else {
    const earthRadius = earthDiscScreenRadius(
      Cesium.Cartesian3.magnitude(camera.positionWC),
      height,
      camera.frustum?.fovy,
    );
    const facingEarthCenter = Cesium.Cartesian3.dot(
      camera.directionWC,
      _radioEarthToCenter,
    ) > 0;
    if (!earthRadius || facingEarthCenter) return null;
    const keyhole = getKeyholeGeometry(width, height);
    fullGlobeCapable = earthRadius + GLOBE_ENTER_CLEARANCE_PX <= keyhole.radius;
  }
  const recenterHeight = radioGlobeRecenterHeight(
    cartographic.height,
    fullGlobeCapable,
  );
  if (recenterHeight == null) return null;
  return {
    destination: Cesium.Cartesian3.fromRadians(
      cartographic.longitude,
      cartographic.latitude,
      recenterHeight,
    ),
    cameraState: {
      ...radioCameraState(camera),
      height: recenterHeight,
      heading: 0,
      pitch: -Cesium.Math.PI_OVER_TWO,
      roll: 0,
    },
  };
}

function radioCameraNavigationIsCurrent(navigation) {
  return Boolean(
    navigation
    && navigation.generation === _radioCameraNavigationGeneration
    && _enabled
    && radioCameraNavigationAllowed(_viewer)
  );
}

function cancelActiveRadioCameraFlight() {
  if (!_activeRadioCameraFlight || !radioCameraNavigationAllowed(_viewer)) return;
  _activeRadioCameraFlight = null;
  _viewer.camera.cancelFlight();
}

function invalidateRadioCameraNavigation() {
  _radioCameraNavigationGeneration += 1;
  cancelActiveRadioCameraFlight();
  _activeRadioCameraFlight = null;
}

function radioCameraNavigationOwnsSelection(navigation, station) {
  return Boolean(
    navigation
    && station
    && navigation.generation === _radioCameraNavigationGeneration
    && navigation.target?.id === station.id
  );
}

function startRadioCameraFlight(navigation, options, onComplete) {
  if (!radioCameraNavigationIsCurrent(navigation)) return false;
  const token = ++_radioCameraFlightSequence;
  _activeRadioCameraFlight = { generation: navigation.generation, token };
  const finish = (completed) => {
    if (_activeRadioCameraFlight?.token === token) _activeRadioCameraFlight = null;
    if (completed && radioCameraNavigationIsCurrent(navigation)) onComplete?.();
  };
  _viewer.camera.flyTo({
    ...options,
    complete: () => finish(true),
    cancel: () => finish(false),
  });
  return true;
}

function focusRadioNavigationTarget(navigation) {
  if (!radioCameraNavigationIsCurrent(navigation) || !navigation.target) return false;
  const plan = radioStationCameraPlan(navigation.target, navigation.cameraState);
  if (!plan) return false;
  navigation.phase = 'focusing';
  return startRadioCameraFlight(navigation, {
    destination: Cesium.Cartesian3.fromDegrees(plan.lon, plan.lat, plan.height),
    orientation: { heading: plan.heading, pitch: plan.pitch, roll: plan.roll },
    duration: navigation.duration,
  }, () => {
    navigation.phase = 'settled';
  });
}

function beginRadioCameraNavigation(cameraState = null) {
  const generation = ++_radioCameraNavigationGeneration;
  if (!radioCameraNavigationAllowed(_viewer) || !_enabled) return null;
  cancelActiveRadioCameraFlight();
  const recenterPlan = radioGlobeRecenterPlan(_viewer);
  return {
    generation,
    phase: 'idle',
    recentered: false,
    recenterPlan,
    cameraState: recenterPlan?.cameraState || cameraState || radioCameraState(),
    target: null,
    duration: 0.35,
  };
}

function rotateRadioStationIntoView(
  station,
  duration = 0.35,
  cameraState = null,
  navigation = null,
) {
  const activeNavigation = navigation || beginRadioCameraNavigation(cameraState);
  if (!station || !radioCameraNavigationIsCurrent(activeNavigation)) return false;
  activeNavigation.target = station;
  activeNavigation.duration = duration;
  if (activeNavigation.phase === 'recentering') return true;
  if (activeNavigation.phase === 'focusing') cancelActiveRadioCameraFlight();
  if (activeNavigation.recenterPlan && !activeNavigation.recentered) {
    activeNavigation.phase = 'recentering';
    const recenterDuration = Math.min(0.9, Math.max(0.65, duration));
    return startRadioCameraFlight(activeNavigation, {
      destination: activeNavigation.recenterPlan.destination,
      orientation: {
        heading: activeNavigation.cameraState.heading,
        pitch: activeNavigation.cameraState.pitch,
        roll: activeNavigation.cameraState.roll,
      },
      duration: recenterDuration,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    }, () => {
      activeNavigation.recentered = true;
      activeNavigation.phase = 'idle';
      focusRadioNavigationTarget(activeNavigation);
    });
  }
  return focusRadioNavigationTarget(activeNavigation);
}

/** Preview a tuner station bracket and camera orientation without starting audio. */
export function previewRadioTuningStation(id, { rotate = true } = {}) {
  if (!radioPresentationAllowed() || !_tuningActive) return false;
  const station = tuningResolutionStation(id);
  const nextId = station?.id || null;
  const changed = nextId !== _tuningPreviewId;
  _tuningPreviewId = nextId;
  _tuningStatic = !station;
  if (changed) {
    updateSelectionEntity();
    if (station && rotate) {
      const cameraState = radioCameraState();
      _tuningCameraNavigation = beginRadioCameraNavigation(cameraState);
      rotateRadioStationIntoView(station, 0.35, cameraState, _tuningCameraNavigation);
    }
    else if (rotate) {
      _tuningCameraNavigation = null;
      invalidateRadioCameraNavigation();
    }
  }
  syncTuningNoiseGain();
  emitState();
  return Boolean(station);
}

function clearRadioTuningNoise({ emit = true, restoredStation = null } = {}) {
  if (_tuningCameraNavigation) invalidateRadioCameraNavigation();
  _tuningActive = false;
  _tuningStatic = false;
  _tuningAwaitingStationId = null;
  _tuningPreviewId = null;
  _tuningStartStationId = null;
  _tuningResolutionSnapshot = EMPTY_ACCEPTED_CATALOG_SNAPSHOT;
  _tuningStationById = new Map();
  _tuningCameraNavigation = null;
  _cancelledTuningPresentationStation = restoredStation;
  updateSelectionEntity();
  syncTuningNoiseGain();
  stopTuningNoiseSource();
  const suspended = _tuningNoiseContext?.suspend?.();
  if (suspended?.catch) void suspended.catch(() => {});
  if (emit) emitState();
}

/** Finish a tuning gesture and release its synthesized noise source. */
export function endRadioTuning() {
  if (!_tuningActive && !_tuningStatic && !_tuningAwaitingStationId
      && !_tuningNoiseSource && !_cancelledTuningPresentationStation) return;
  clearRadioTuningNoise();
}

/** Cancel a tuning gesture and restore its frozen start marker for presentation only. */
export function cancelRadioTuning() {
  if (!_tuningActive) return false;
  const restoredStation = tuningResolutionStation(_tuningStartStationId);
  clearRadioTuningNoise({ restoredStation });
  return true;
}

/** Commit the exact frozen drag resolution or report that it is unavailable. */
export function commitRadioTuningStation(id, { origin = 'programmatic' } = {}) {
  const frozenStation = tuningResolutionStation(id);
  const currentStation = _stationById.get(String(id)) || null;
  const generation = _tuningResolutionSnapshot.generation;
  if (!radioPresentationAllowed() || !_tuningActive || !frozenStation) {
    endRadioTuning();
    return Object.freeze({ ok: false, reason: 'not-tuning', stationId: String(id || ''), generation });
  }
  if (!radioStationResolutionMatches(frozenStation, currentStation)) {
    const stationId = frozenStation.id;
    // A failed exact release owns the visible outcome. Do not let the previous
    // selection—or changed metadata under the same ID—reappear between the
    // frozen preview and the unavailable state.
    _selectedId = null;
    _selectionGeneration += 1;
    clearRadioTuningNoise({ emit: false });
    _tuningUnavailableStationId = stationId;
    emitState();
    return Object.freeze({ ok: false, reason: 'station-unavailable', stationId, generation });
  }
  _tuningActive = false;
  _tuningStatic = true;
  _tuningAwaitingStationId = frozenStation.id;
  _tuningPreviewId = null;
  _tuningStartStationId = null;
  _tuningUnavailableStationId = null;
  const cameraNavigation = _tuningCameraNavigation;
  _tuningCameraNavigation = null;
  _tuningResolutionSnapshot = EMPTY_ACCEPTED_CATALOG_SNAPSHOT;
  _tuningStationById = new Map();
  // An exact tuner release owns its frozen target. A fallback armed by an
  // earlier non-playing selection must never retarget this gesture if the
  // broadcaster fails after release.
  _playFallbackId = null;
  _playFallbackFocus = null;
  _playFallbackOrigin = 'programmatic';
  _playFallbackAttemptId = null;
  syncTuningNoiseGain();
  emitState();
  const selected = selectRadioStation(frozenStation.id, {
    autoplay: true,
    focus: false,
    origin,
    cameraNavigation,
  });
  return Object.freeze({
    ok: selected,
    reason: selected ? null : 'station-unavailable',
    stationId: frozenStation.id,
    generation,
  });
}

function tryRadioFallback(
  failedId,
  origin = _playFallbackOrigin || 'programmatic',
  attemptId = _playFallbackAttemptId,
) {
  const fallbackId = _playFallbackId;
  const fallbackStation = fallbackId ? _stationById.get(fallbackId) : null;
  const fallbackFocusPolicy = _playFallbackFocus;
  _playFallbackId = null;
  _playFallbackFocus = null;
  _playFallbackOrigin = 'programmatic';
  _playFallbackAttemptId = null;
  if (!fallbackStation || fallbackId === failedId || _selectedId !== failedId) {
    return false;
  }
  const fallbackFocusResult = typeof fallbackFocusPolicy === 'function'
    ? fallbackFocusPolicy(fallbackStation)
    : fallbackFocusPolicy;
  const fallbackCameraNavigation = fallbackFocusResult
    && typeof fallbackFocusResult === 'object'
    ? fallbackFocusResult
    : null;
  const fallbackFocus = fallbackCameraNavigation ? false : Boolean(fallbackFocusResult);
  selectRadioStation(fallbackId, {
    autoplay: true,
    focus: fallbackFocus,
    origin: origin || 'programmatic',
    attemptId,
    cameraNavigation: fallbackCameraNavigation,
  });
  return true;
}

function recordDirectoryClick(id) {
  fetch(`/api/gev/radio/click/${encodeURIComponent(id)}`, { method: 'POST' }).catch(() => {});
}

/** Play the selected broadcaster stream after an explicit user action. */
export async function playSelectedRadio({ origin = 'programmatic', attemptId = null } = {}) {
  const station = selectedStation();
  if (!radioPresentationAllowed() || !station?.streamUrl) return false;
  if (_tuningActive) endRadioTuning();
  // A media event carries no reliable attempt identity. Give every explicit
  // play/resume/replacement its own element so queued events from the retired
  // attempt remain bound to the discarded element and cannot mutate this one.
  installAudio({ replace: true });
  if (!_audio) return false;

  const generation = ++_playGeneration;
  const ownedAttemptId = attemptId || `radio-play-${++_playAttemptSequence}`;
  _activePlaybackAttempt = {
    id: ownedAttemptId,
    origin,
    stationId: station.id,
    streamUrl: station.streamUrl,
    generation,
  };
  if (_playFallbackId) {
    _playFallbackOrigin = origin;
    _playFallbackAttemptId = ownedAttemptId;
  }
  _audioError = null;
  _audioState = 'loading';
  if (_audioStationId !== station.id || _audio.src !== station.streamUrl) {
    _audio.pause();
    _audio.src = station.streamUrl;
    _audioStationId = station.id;
  }
  emitState();

  try {
    const playback = _audio.play();
    if (playback?.then) await playback;
    if (
      generation !== _playGeneration
      || _audioStationId !== station.id
      || _activePlaybackAttempt?.id !== ownedAttemptId
    ) return false;
    _audioState = 'playing';
    if (_tuningAwaitingStationId === station.id) clearRadioTuningNoise({ emit: false });
    _playFallbackId = null;
    _playFallbackFocus = null;
    _playFallbackOrigin = 'programmatic';
    _playFallbackAttemptId = null;
    recordDirectoryClick(station.id);
    emitState();
    if (origin === 'user') emitPlaybackControl('play', origin, ownedAttemptId);
    return true;
  } catch (error) {
    if (generation !== _playGeneration || _activePlaybackAttempt?.id !== ownedAttemptId) return false;
    if (tryRadioFallback(station.id, origin, ownedAttemptId)) return false;
    _audioState = 'error';
    _audioError = error?.name === 'NotAllowedError'
      ? 'Playback requires a direct click or tap.'
      : 'Broadcaster stream could not be started.';
    emitState();
    return false;
  }
}

/**
 * Wait for confirmed Radio playback while voice owns a hard mute.
 * A fallback station may replace the first stream during this wait, so the
 * state subscription—not the first play() promise—is authoritative.
 */
export function confirmRadioPlayback({
  startPlayback,
  subscribe,
  getState,
  timeoutMs = RADIO_VOICE_PLAYBACK_TIMEOUT_MS,
} = {}) {
  if (typeof startPlayback !== 'function' || typeof subscribe !== 'function' || typeof getState !== 'function') {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    let started = false;
    let unsubscribe = () => {};
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolve(Boolean(ok));
    };
    const inspect = (state) => {
      if (!started || !state) return;
      if (!state.voiceDucked && ['loading', 'buffering', 'playing'].includes(state.audioState)) {
        finish(false);
        return;
      }
      if (state.audioState === 'playing' && state.playingStationId && state.voiceDucked) {
        finish(true);
      } else if (state.audioState === 'error') {
        finish(false);
      }
    };
    unsubscribe = subscribe(inspect);
    started = true;
    timer = setTimeout(() => finish(false), Math.max(1, Number(timeoutMs) || RADIO_VOICE_PLAYBACK_TIMEOUT_MS));
    Promise.resolve()
      .then(startPlayback)
      .then((playStarted) => {
        const state = getState();
        inspect(state);
        if (!playStarted && !['loading', 'buffering', 'playing'].includes(state?.audioState)) finish(false);
      })
      .catch(() => finish(false));
  });
}

/** Start and verify a prepared station without ever making it audible under voice. */
export function playPreparedRadioForVoice(options = {}) {
  if (!_voiceDucked) return Promise.resolve(false);
  return confirmRadioPlayback({
    startPlayback: () => playSelectedRadio({ origin: 'voice', attemptId: options.attemptId }),
    subscribe: subscribeToRadio,
    getState: getRadioUIState,
    timeoutMs: options.timeoutMs,
  });
}

/** Stop the shared stream and release its network resource. */
export function stopRadioPlayback({ origin = 'programmatic', attemptId = null } = {}) {
  if (attemptId && _activePlaybackAttempt?.id !== attemptId) return false;
  const stoppedAttemptId = _activePlaybackAttempt?.id || null;
  endRadioTuning();
  _playGeneration += 1;
  _playFallbackId = null;
  _playFallbackFocus = null;
  _playFallbackOrigin = 'programmatic';
  _playFallbackAttemptId = null;
  _activePlaybackAttempt = null;
  if (_audio) {
    _audio.pause();
    _audio.removeAttribute('src');
    _audio.load();
  }
  _audioStationId = null;
  _audioState = 'stopped';
  _audioError = null;
  emitState();
  if (origin === 'user' || origin === 'voice') {
    emitPlaybackControl('stop', origin, stoppedAttemptId);
  }
  return true;
}

/** Pause or resume the selected stream. Resuming is still click initiated. */
export function toggleRadioPlayback({ origin = 'programmatic' } = {}) {
  if (['loading', 'playing', 'buffering'].includes(_audioState)) {
    return Promise.resolve(pauseRadioPlayback({ origin }));
  }
  if (!radioPresentationAllowed()) return Promise.resolve(false);
  if (!_selectedId) {
    const ranked = rankedVisibleStations();
    if (!ranked.length) return Promise.resolve(false);
    _playFallbackId = ranked[1]?.id || null;
    _playFallbackFocus = false;
    selectRadioStation(ranked[0].id, { autoplay: false, focus: false });
  }
  return playSelectedRadio({ origin });
}

/** Pause Radio without toggling a stopped or already-paused stream back on. */
export function pauseRadioPlayback({ origin = 'programmatic' } = {}) {
  if (!['loading', 'playing', 'buffering'].includes(_audioState)) return false;
  const pausedAttemptId = _activePlaybackAttempt?.id || null;
  if (_tuningAwaitingStationId && !_tuningActive) endRadioTuning();
  _playGeneration += 1;
  _playFallbackId = null;
  _playFallbackFocus = null;
  _playFallbackOrigin = 'programmatic';
  _playFallbackAttemptId = null;
  _activePlaybackAttempt = null;
  _audio?.pause();
  _audioState = 'paused';
  emitState();
  if (origin === 'user' || origin === 'voice') {
    emitPlaybackControl('pause', origin, pausedAttemptId);
  }
  return true;
}

/** Set shared audio volume, clamped to [0, 1]. */
export function setRadioVolume(value) {
  if (!radioPresentationAllowed()) return false;
  const volume = clampRadioVolume(value);
  _userVolume = volume;
  installAudio();
  if (!_voiceDucked) {
    cancelRadioVolumeTransition();
    _voiceRestoring = false;
    if (_audio) _audio.volume = volume;
  }
  syncTuningNoiseGain();
  emitState();
  return true;
}

/** Durable Radio preferences; this surface never creates or plays audio. */
export function setRadioParams(params = {}) {
  const nextFilter = Object.hasOwn(params, 'filter')
    ? normalizeRadioFilter(params.filter)
    : null;
  if (Object.hasOwn(params, 'filter') && !nextFilter) return false;
  const numericVolume = Object.hasOwn(params, 'volume') ? Number(params.volume) : null;
  if (Object.hasOwn(params, 'volume') && !Number.isFinite(numericVolume)) return false;
  const nextVolume = numericVolume === null ? null : clampRadioVolume(numericVolume);

  let changed = false;
  let filterChanged = false;
  let clearedCancelledPresentation = false;
  if (nextFilter !== null) {
    filterChanged = nextFilter !== _filter;
    if (filterChanged && (_tuningActive || _tuningAwaitingStationId)) endRadioTuning();
    clearedCancelledPresentation = Boolean(_cancelledTuningPresentationStation);
    _cancelledTuningPresentationStation = null;
    _filter = nextFilter;
    if (clearedCancelledPresentation) updateSelectionEntity();
    if (filterChanged) resetRadioClusterOverlayIdentities();
    changed ||= filterChanged || clearedCancelledPresentation;
  }
  if (nextVolume !== null && nextVolume !== _userVolume) {
    _userVolume = nextVolume;
    if (_audio && !_voiceDucked) {
      cancelRadioVolumeTransition();
      _voiceRestoring = false;
      _audio.volume = nextVolume;
    }
    syncTuningNoiseGain();
    changed = true;
  }
  if (changed && radioPresentationAllowed()) {
    updateRenderVisibility();
    if (filterChanged && _dataSource?.clustering?.enabled) {
      const clusterPoints = _dataSource.clustering.clusterPoints;
      _dataSource.clustering.clusterPoints = !clusterPoints;
      _dataSource.clustering.clusterPoints = clusterPoints;
      _viewer?.scene?.requestRender();
    }
    scheduleRadioOverlayPublish();
  }
  emitState();
  return true;
}

export function getRadioParams() {
  return { filter: _filter, volume: _userVolume };
}

/**
 * Mute Radio during a live voice turn, then gently restore the user-owned
 * volume after voice returns to standby. Repeated state sync is idempotent.
 */
export function setRadioVoiceDucking(ducked, {
  restoreDelayMs = VOICE_RESTORE_DELAY_MS,
  restoreDurationMs = VOICE_RESTORE_DURATION_MS,
} = {}) {
  const shouldDuck = Boolean(ducked);
  if (shouldDuck === _voiceDucked && (shouldDuck || _voiceRestoring)) return;
  if (!shouldDuck && !_voiceDucked && !_voiceRestoring
      && (!_audio || Math.abs(_audio.volume - _userVolume) < 0.001)) return;

  cancelRadioVolumeTransition();
  _voiceDucked = shouldDuck;
  _voiceRestoring = false;

  if (shouldDuck) {
    if (_audio) _audio.volume = 0;
    syncTuningNoiseGain();
    emitState();
    return;
  }
  if (!_audio) {
    syncTuningNoiseGain();
    _voiceRestoring = false;
    emitState();
    return;
  }

  const generation = _volumeTransitionGeneration;
  syncTuningNoiseGain();
  _voiceRestoring = true;
  emitState();
  const beginRestore = () => {
    _voiceRestoreTimer = null;
    if (generation !== _volumeTransitionGeneration || _voiceDucked || !_audio) return;
    const startedAt = volumeClock();
    const initialVolume = _audio.volume;
    const duration = Math.max(0, Number(restoreDurationMs) || 0);
    const step = (now) => {
      if (generation !== _volumeTransitionGeneration || _voiceDucked || !_audio) return;
      const progress = duration === 0 ? 1 : Math.min(1, Math.max(0, (now - startedAt) / duration));
      const eased = progress * progress * (3 - 2 * progress);
      _audio.volume = clampRadioVolume(initialVolume + (_userVolume - initialVolume) * eased);
      if (progress < 1) {
        _volumeFadeFrame = scheduleVolumeFrame(step);
        return;
      }
      _volumeFadeFrame = null;
      _voiceRestoring = false;
      emitState();
    };
    _volumeFadeFrame = scheduleVolumeFrame(step);
  };
  const delay = Math.max(0, Number(restoreDelayMs) || 0);
  if (delay > 0) _voiceRestoreTimer = setTimeout(beginRestore, delay);
  else beginRestore();
}

function updateSelectionEntity() {
  if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
  _selectedEntity = null;
  const station = selectedPresentationStation();
  if (!radioPresentationAllowed() || !_viewer || !station) {
    scheduleRadioOverlayPublish();
    return;
  }
  const selectionColor = radioCategoryColor(radioStationCategoryId(station));
  const bracketImage = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(radioSelectionBracketSvg(selectionColor))}`;

  _selectedEntity = _viewer.entities.add({
    id: `${RADIO_PREFIX}selected:${station.id}`,
    position: markerPosition(station, SELECTED_LIFT_M),
    point: {
      pixelSize: 14,
      color: Cesium.Color.fromCssColorString(selectionColor),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
        0,
        RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
      ),
    },
    billboard: {
      image: bracketImage,
      width: 40,
      height: 40,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
        0,
        RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
      ),
      scaleByDistance: new Cesium.NearFarScalar(100_000, 1, 12_000_000, 0.72),
    },
  });
  scheduleRadioOverlayPublish();
}

function clusterPointCollection() {
  return _dataSource?.clustering?._clusterPointCollection || null;
}

function publishRadioOverlayEntries() {
  _overlayPublishTimer = null;
  if (!radioPresentationAllowed()) {
    resetRadioClusterOverlayIdentities();
    _overlayDiagnostics = emptyRadioOverlayDiagnostics();
    clearOverlaySource(RADIO_OVERLAY_SOURCE_ID);
    setOverlaySourceVisible(RADIO_OVERLAY_SOURCE_ID, false);
    return;
  }

  const entries = [];
  const station = selectedPresentationStation();
  if (station) {
    const selectedEntry = createRadioSelectedOverlayEntry(
      station,
      markerPosition(station, SELECTED_LIFT_M),
    );
    if (selectedEntry) entries.push(selectedEntry);
  }

  const clusterCandidates = [];
  const clusteredStationIds = new Set();
  const points = clusterPointCollection();
  for (let index = 0; index < (points?.length || 0); index += 1) {
    const point = points.get(index);
    if (!point?.show || !point.position || !Array.isArray(point.id) || point.id.length < 3) continue;
    const stationIds = point.id
      .map((entity) => String(entity?.id || '').slice(RADIO_PREFIX.length))
      .filter((id) => {
        const station = _stationById.get(id);
        return station && stationMatchesRadioCategory(station, _filter);
      })
      .sort();
    if (stationIds.length < 3) continue;
    for (const stationId of stationIds) clusteredStationIds.add(stationId);
    const clusteredStations = stationIds.map((id) => _stationById.get(id));
    const category = radioClusterCategoryId(clusteredStations, _filter);
    clusterCandidates.push({
      id: `${stationIds[0]}:${stationIds.at(-1)}:${stationIds.length}`,
      stationIds,
      point,
      text: radioClusterBadgeText(category, stationIds.length),
      accent: radioCategoryColor(category),
      stationCount: stationIds.length,
    });
  }
  const selectedClusterCandidates = selectRadioClusterCandidates(clusterCandidates);
  _clusterOverlayIdentities = reconcileRadioClusterCandidates(
    selectedClusterCandidates,
    _clusterOverlayIdentities,
    () => `stable:${++_clusterOverlayIdentitySequence}`,
  );
  for (const candidate of _clusterOverlayIdentities) {
    const clusterEntry = createRadioClusterOverlayEntry({
      ...candidate,
      position: () => candidate.point.position,
    });
    if (clusterEntry) entries.push(clusterEntry);
  }

  const cameraPosition = _viewer?.camera?.positionWC;
  const singletonAllowance = Math.min(
    radioSingletonLabelLimit(_viewer?.camera?.positionCartographic?.height),
    Math.max(0, RADIO_OVERLAY_COHORT_LIMIT - selectedClusterCandidates.length),
  );
  const singletonCandidates = selectRadioSingletonCandidates(
    [..._renderById.values()]
      .filter((record) => (
        record.entity?.show
        && record.station?.id !== station?.id
        && !clusteredStationIds.has(record.station?.id)
      ))
      .map((record) => ({
        ...record,
        distanceM: cameraPosition
          ? Cesium.Cartesian3.distance(cameraPosition, record.position)
          : Number.POSITIVE_INFINITY,
      })),
    singletonAllowance,
  );
  for (let index = 0; index < singletonCandidates.length; index += 1) {
    const candidate = singletonCandidates[index];
    const singletonEntry = createRadioSingletonOverlayEntry({
      station: candidate.station,
      position: candidate.position,
      // Cluster priorities begin at three. Keep clusters authoritative while
      // retaining nearest-first singleton ordering inside the ambient lane.
      priority: 2 - (index / Math.max(1, singletonCandidates.length + 1)),
    });
    if (singletonEntry) entries.push(singletonEntry);
  }

  setOverlayEntries(RADIO_OVERLAY_SOURCE_ID, entries, RADIO_OVERLAY_SOURCE_OPTIONS);
  setOverlaySourceVisible(RADIO_OVERLAY_SOURCE_ID, true);
  _overlayDiagnostics = {
    entryCount: entries.length,
    selectedCount: entries.filter((entry) => entry.selected).length,
    singletonTexts: entries.filter((entry) => entry.id.startsWith('station:')).map((entry) => entry.title),
    singletonIds: entries.filter((entry) => entry.id.startsWith('station:')).map((entry) => entry.id),
    clusterTexts: entries.filter((entry) => entry.id.startsWith('cluster:')).map((entry) => entry.title),
    clusterIds: entries.filter((entry) => entry.id.startsWith('cluster:')).map((entry) => entry.id),
    clusterMemberships: _clusterOverlayIdentities.map((candidate) => ({
      membershipId: candidate.membershipId,
      entryId: `cluster:${candidate.id}`,
    })),
  };
}

function scheduleRadioOverlayPublish() {
  if (_overlayPublishTimer) clearTimeout(_overlayPublishTimer);
  const sessionGeneration = _sessionGeneration;
  _overlayPublishTimer = setTimeout(() => {
    if (sessionGeneration === _sessionGeneration) publishRadioOverlayEntries();
  }, 0);
}

function focusStation(station) {
  _radioCameraNavigationGeneration += 1;
  if (!station || !radioCameraNavigationAllowed(_viewer)) return false;
  cancelActiveRadioCameraFlight();
  _viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(station.lon, station.lat, 85_000),
    duration: 1.1,
  });
  return true;
}

/** Select a station. Playback occurs only when autoplay is explicitly true. */
export function selectRadioStation(id, {
  autoplay = false,
  focus = false,
  origin = 'programmatic',
  attemptId = null,
  cameraNavigation = null,
} = {}) {
  if (!radioPresentationAllowed()) return false;
  const station = _stationById.get(String(id));
  if (!station) return false;
  _tuningUnavailableStationId = null;
  if (!radioCameraNavigationOwnsSelection(cameraNavigation, station)) {
    invalidateRadioCameraNavigation();
  }
  if (_tuningActive || (_tuningAwaitingStationId && _tuningAwaitingStationId !== station.id)) endRadioTuning();
  _cancelledTuningPresentationStation = null;
  _selectedId = station.id;
  const generation = ++_selectionGeneration;
  const sessionGeneration = _sessionGeneration;
  updateSelectionEntity();
  warmGroundFloor([{ lat: station.lat, lon: station.lon }]);
  if (_selectionTimer) clearTimeout(_selectionTimer);
  _selectionTimer = setTimeout(() => {
    _selectionTimer = null;
    if (
      sessionGeneration === _sessionGeneration
      && generation === _selectionGeneration
      && _selectedId === station.id
    ) updateSelectionEntity();
  }, 1300);
  if (focus) focusStation(station);
  emitState();
  if (autoplay) void playSelectedRadio({ origin, attemptId });
  return true;
}

/** Select the previous or next station and optionally retain a UI-owned band order. */
export function cycleRadioStation(direction = 1, {
  rotate = false,
  stationIds = null,
  autoplay = true,
  origin = 'programmatic',
} = {}) {
  if (!radioPresentationAllowed()) return false;
  const ranked = Array.isArray(stationIds) && stationIds.length
    ? stationIds
      .slice(0, RADIO_TUNER_DIRECTORY_LIMIT)
      .map((id) => _stationById.get(String(id)))
      .filter((station) => station && stationMatchesRadioCategory(station, _filter))
    : rankedVisibleStations();
  if (!ranked.length) return false;
  const current = ranked.findIndex((station) => station.id === _selectedId);
  const nextIndex = current < 0
    ? 0
    : (current + (direction < 0 ? -1 : 1) + ranked.length) % ranked.length;
  _playFallbackId = ranked.length > 1 ? ranked[(nextIndex + 1) % ranked.length].id : null;
  const rotationCameraState = rotate ? radioCameraState() : null;
  const rotationNavigation = rotate ? beginRadioCameraNavigation(rotationCameraState) : null;
  _playFallbackFocus = rotate
    ? (fallbackStation) => {
      rotateRadioStationIntoView(fallbackStation, 0.65, rotationCameraState, rotationNavigation);
      return rotationNavigation;
    }
    : false;
  const station = ranked[nextIndex];
  if (rotate) rotateRadioStationIntoView(station, 0.65, rotationCameraState, rotationNavigation);
  return selectRadioStation(station.id, {
    autoplay,
    focus: false,
    origin,
    cameraNavigation: rotationNavigation,
  });
}

/** Select and optionally play the best station for a location/category request. */
export function selectRequestedRadioStation(criteria = {}, { autoplay = true, origin = 'programmatic' } = {}) {
  if (!radioPresentationAllowed()) return null;
  const requestedCategory = String(criteria.categoryId || 'all');
  const categoryId = _categories.some((category) => category.id === requestedCategory)
    ? requestedCategory
    : 'all';
  setRadioFilter(categoryId);
  const ranked = rankRadioStationsForRequest(_stations, {
    ...criteria,
    categoryId,
    anchor: criteria.anchor || viewportRadioAnchor(),
  });
  if (!ranked.length) return null;
  _playFallbackId = ranked[1]?.id || null;
  _playFallbackFocus = false;
  selectRadioStation(ranked[0].id, { autoplay, focus: false, origin });
  return ranked[0];
}

function updateRenderVisibility({ force = true } = {}) {
  if (!_viewer || !_dataSource) return;
  const cameraPosition = _viewer.camera?.positionWC;
  if (!force && !radioCameraPositionChanged(_lastHorizonCameraPosition, cameraPosition)) return;
  _lastHorizonCameraPosition = cameraPosition
    ? { x: cameraPosition.x, y: cameraPosition.y, z: cameraPosition.z }
    : null;
  _horizonScanCount += 1;
  const occluder = horizonOccluder(_viewer.camera);
  let visibilityChanged = false;
  for (const [id, record] of _renderById) {
    const matches = stationMatchesRadioCategory(record.station, _filter);
    const visible = matches && occluder.isPointVisible(record.position);
    if (record.entity.show !== visible) visibilityChanged = true;
    record.entity.show = visible;
  }
  if (_selectedEntity) {
    const position = _selectedEntity.position?.getValue?.(Cesium.JulianDate.now());
    const selectedVisible = !position || occluder.isPointVisible(position);
    if (_selectedEntity.show !== selectedVisible) visibilityChanged = true;
    _selectedEntity.show = selectedVisible;
  }
  scheduleRadioOverlayPublish();
  // The horizon timer can commit AFTER the camera settles and the governor
  // parks the scene — a changed show flag needs one frame. (perf wave 2 fix)
  if (visibilityChanged) governorRequestRender('radio-horizon');
}

/** Change marker/list category without interrupting an active station. */
export function setRadioFilter(categoryId) {
  if (!radioPresentationAllowed()) return false;
  const valid = _categories.some((category) => category.id === categoryId);
  const nextFilter = valid ? categoryId : 'all';
  const changed = nextFilter !== _filter;
  if (changed && (_tuningActive || _tuningAwaitingStationId)) endRadioTuning();
  const clearsCancelledPresentation = Boolean(_cancelledTuningPresentationStation);
  _cancelledTuningPresentationStation = null;
  _filter = nextFilter;
  if (clearsCancelledPresentation) updateSelectionEntity();
  if (changed) resetRadioClusterOverlayIdentities();
  updateRenderVisibility();
  if (changed && _dataSource?.clustering?.enabled) {
    // Entity visibility changes do not invalidate Cesium's existing cluster
    // primitives. Toggle a public clustering input twice to mark the current
    // cluster set dirty without changing its effective configuration.
    const clusterPoints = _dataSource.clustering.clusterPoints;
    _dataSource.clustering.clusterPoints = !clusterPoints;
    _dataSource.clustering.clusterPoints = clusterPoints;
    _viewer?.scene?.requestRender();
  }
  scheduleRadioOverlayPublish();
  emitState();
  return true;
}

/** Retain refresh identities only while every represented station still exists. */
export function retainRadioClusterIdentitiesForStations(previous, stations) {
  const stationIds = new Set((stations || []).map((station) => String(station?.id || '')).filter(Boolean));
  return (previous || []).filter((candidate) => (
    Array.isArray(candidate?.stationIds)
    && candidate.stationIds.length > 0
    && candidate.stationIds.every((stationId) => stationIds.has(String(stationId)))
  ));
}

function reconcileStations(stations) {
  if (!_tuningActive) _cancelledTuningPresentationStation = null;
  _clusterOverlayIdentities = retainRadioClusterIdentitiesForStations(
    _clusterOverlayIdentities,
    stations,
  );
  _stations = Object.freeze([...stations]);
  _stationById = new Map(stations.map((station) => [station.id, station]));
  _categories = Object.freeze(buildRadioCategories(stations).map((category) => Object.freeze(category)));
  if (_filter === DEFAULT_RADIO_FILTER && !filterRadioStations(stations, DEFAULT_RADIO_FILTER).length) {
    _filter = 'all';
  }
  if (_selectedId && !_stationById.has(_selectedId)) {
    if (_audioStationId === _selectedId) stopRadioPlayback();
    _selectedId = null;
  }

  if (_dataSource) _dataSource.entities.removeAll();
  _renderById.clear();
  for (const station of stations) {
    const position = markerPosition(station);
    const markerColor = radioCategoryColor(radioStationCategoryId(station));
    const entity = _dataSource.entities.add({
      id: `${RADIO_PREFIX}${station.id}`,
      position,
      point: {
        pixelSize: 13,
        color: Cesium.Color.fromCssColorString(markerColor).withAlpha(0.86),
        outlineColor: Cesium.Color.fromCssColorString('#071b25'),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(100_000, 1.15, 12_000_000, 1),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
        ),
      },
    });
    _renderById.set(station.id, { station, entity, position });
  }
  updateSelectionEntity();
  updateRenderVisibility();
}

function installClusterStyling() {
  if (!_dataSource || _removeClusterListener) return;
  const clustering = _dataSource.clustering;
  clustering.enabled = true;
  clustering.pixelRange = 42;
  clustering.minimumClusterSize = 3;
  clustering.clusterPoints = true;
  clustering.clusterLabels = false;
  clustering.clusterBillboards = false;
  _removeClusterListener = clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
    const clusteredStations = [];
    for (const entity of clusteredEntities) {
      const stationId = String(entity.id || '').slice(RADIO_PREFIX.length);
      const station = _renderById.get(stationId)?.station;
      if (station) clusteredStations.push(station);
    }
    const clusterCategory = radioClusterCategoryId(clusteredStations, _filter);
    const clusterColor = Cesium.Color.fromCssColorString(radioCategoryColor(clusterCategory));
    // Cesium assigns the entity-id array only to the generated cluster label.
    // Mirror it to the visible point so clicking either part of the callout
    // resolves the first station and remains a direct playback gesture.
    cluster.point.id = clusteredEntities;
    cluster.billboard.id = clusteredEntities;
    cluster.label.show = false;
    cluster.label.text = '';
    cluster.point.show = true;
    cluster.point.pixelSize = Math.min(26, 12 + Math.log2(clusteredEntities.length) * 1.6);
    cluster.point.color = clusterColor.withAlpha(0.9);
    cluster.point.outlineColor = Cesium.Color.BLACK;
    cluster.point.outlineWidth = 2;
    cluster.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    cluster.point.distanceDisplayCondition = new Cesium.DistanceDisplayCondition(
      0,
      RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
    );
    scheduleRadioOverlayPublish();
  });
}

function pickedRadioStationAt(position) {
  const scene = _viewer?.scene;
  if (!scene || !position) return null;

  const stationFromPick = (picked) => {
    const stationId = radioStationIdFromPick(picked);
    return stationId && _stationById.has(stationId) ? stationId : null;
  };
  const primaryPick = scene.pick(position);
  const primaryStationId = stationFromPick(primaryPick);
  if (primaryStationId) return primaryStationId;
  const primaryId = resolvePickId(primaryPick);
  if (primaryId && isOwnedByOtherLayer('radio', primaryId)) return null;

  if (typeof scene.drillPick === 'function') {
    const drilled = scene.drillPick(position, 16) || [];
    for (const picked of drilled) {
      const stationId = stationFromPick(picked);
      if (stationId) return stationId;
    }
  }

  for (const [offsetX, offsetY] of RADIO_PICK_OFFSETS) {
    const offsetPosition = new Cesium.Cartesian2(position.x + offsetX, position.y + offsetY);
    const picked = scene.pick(offsetPosition);
    const pickedId = resolvePickId(picked);
    if (pickedId && isOwnedByOtherLayer('radio', pickedId)) continue;
    const stationId = stationFromPick(picked);
    if (stationId) return stationId;
  }
  return null;
}

function radioPresentationAllowed() {
  if (!_managerLifecyclePresentation) return _enabled;
  return _enabled
    && _managerLifecyclePresentation.lifecycleState === 'enabled'
    && _managerLifecyclePresentation.enabled
    && !_managerLifecyclePresentation.uncertain;
}

function syncRadioLifecyclePresentation() {
  const visible = radioPresentationAllowed();
  if (_dataSource) _dataSource.show = visible;
  setOverlaySourceVisible(RADIO_OVERLAY_SOURCE_ID, visible);
  if (visible) {
    installInteraction();
    updateSelectionEntity();
    updateRenderVisibility();
    scheduleRadioOverlayPublish();
  } else {
    removeInteraction();
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
  }
}

function installInteraction() {
  if (!_viewer || _clickHandler) return;
  registerPickOwner('radio', (id) => id.startsWith(RADIO_PREFIX));
  _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    if (!radioPresentationAllowed()) return;
    const stationId = pickedRadioStationAt(click.position);
    if (!stationId) return;
    _playFallbackId = null;
    _playFallbackFocus = null;
    selectRadioStation(stationId, { autoplay: true, origin: 'user' });
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('gev:radio-selected', { detail: { stationId } }));
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  // Polling remains bounded during flights, but a stationary camera no longer
  // rewrites every station's visibility four times per second while voice and
  // audio processing share the main thread.
  _horizonTimer = setInterval(() => updateRenderVisibility({ force: false }), HORIZON_TICK_MS);
}

function removeInteraction() {
  unregisterPickOwner('radio');
  _clickHandler?.destroy();
  _clickHandler = null;
  if (_horizonTimer) clearInterval(_horizonTimer);
  _horizonTimer = null;
}

/** Radio layer lifecycle implementation. */
export const radioLayer = {
  id: 'radio',
  name: 'Radio',
  icon: '◉',
  source: 'Radio Browser',
  updateInterval: 45 * 60 * 1000,

  /** Initialize the Cesium data source and the single audio element. */
  init(viewer) {
    _sessionGeneration += 1;
    _viewer = viewer;
    resetRadioClusterOverlayIdentities();
    installAudio();
    if (!_dataSource) {
      _dataSource = new Cesium.CustomDataSource('Radio stations');
      viewer.dataSources.add(_dataSource);
      installClusterStyling();
    }
    _dataSource.show = false;
    clearOverlaySource(RADIO_OVERLAY_SOURCE_ID);
    setOverlaySourceVisible(RADIO_OVERLAY_SOURCE_ID, false);
  },

  /** Show stations. Enabling or preset restoration never starts audio. */
  enable() {
    _enabled = true;
    syncRadioLifecyclePresentation();
    emitState();
  },

  /** Apply the manager-owned lifecycle gate to visible and pickable Radio state. */
  setLifecyclePresentation({ lifecycleState = null, enabled = false, uncertain = false } = {}) {
    const settledState = enabled ? 'enabled' : 'disabled';
    const normalizedState = ['enabling', 'enabled', 'disabling', 'disabled'].includes(lifecycleState)
      ? lifecycleState
      : settledState;
    _managerLifecyclePresentation = {
      lifecycleState: normalizedState,
      enabled: Boolean(enabled),
      uncertain: Boolean(uncertain),
    };
    syncRadioLifecyclePresentation();
    emitState();
  },

  /** Hide the layer and stop playback without forgetting the selected station. */
  disable() {
    _sessionGeneration += 1;
    _enabled = false;
    invalidateRadioCameraNavigation();
    _requestGeneration += 1;
    _abortController?.abort();
    _abortController = null;
    _loading = false;
    _selectionGeneration += 1;
    if (_selectionTimer) clearTimeout(_selectionTimer);
    _selectionTimer = null;
    removeInteraction();
    endRadioTuning();
    _cancelledTuningPresentationStation = null;
    _tuningUnavailableStationId = null;
    stopRadioPlayback({ origin: 'layer-disable' });
    if (_dataSource) _dataSource.show = false;
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    if (_overlayPublishTimer) clearTimeout(_overlayPublishTimer);
    _overlayPublishTimer = null;
    resetRadioClusterOverlayIdentities();
    _overlayDiagnostics = emptyRadioOverlayDiagnostics();
    clearOverlaySource(RADIO_OVERLAY_SOURCE_ID);
    setOverlaySourceVisible(RADIO_OVERLAY_SOURCE_ID, false);
    emitState();
  },

  /** Refresh directory metadata through the hardened same-origin broker. */
  async update() {
    if (!_enabled) return;
    const generation = ++_requestGeneration;
    const sessionGeneration = _sessionGeneration;
    _abortController?.abort();
    _abortController = new AbortController();
    _loading = true;
    _error = null;
    emitState();
    try {
      const response = await fetch(DIRECTORY_ENDPOINT, { signal: _abortController.signal });
      if (!response.ok) throw new Error(`Radio directory returned ${response.status}`);
      const body = await response.json();
      if (!radioRequestIsCurrent(
        generation,
        _requestGeneration,
        _enabled,
        sessionGeneration,
        _sessionGeneration,
      )) return;
      if (!Array.isArray(body?.stations)) throw new Error('Radio directory response was malformed');
      const updatedAt = typeof body.updatedAt === 'string' && Number.isFinite(Date.parse(body.updatedAt))
        ? body.updatedAt
        : null;
      const updatedAtMs = updatedAt ? Date.parse(updatedAt) : NaN;
      if (
        !updatedAt
        || updatedAtMs < Date.now() - RADIO_DIRECTORY_STALE_MS
        || updatedAtMs > Date.now() + RADIO_DIRECTORY_FUTURE_SKEW_MS
        || typeof body.stale !== 'boolean'
        || typeof body.degraded !== 'boolean'
      ) throw new Error('Radio directory freshness metadata was malformed');
      const rows = body.stations;
      const acceptedRows = rows.filter(isValidRadioDirectoryStation);
      if (!acceptedRows.length) throw new Error('Radio directory returned no usable stations');
      if (acceptedRows.length !== rows.length) {
        throw new Error('Radio directory response contained malformed stations');
      }
      const acceptedGeneration = body.acceptedGeneration;
      if (
        acceptedGeneration !== null
        && (!Number.isSafeInteger(acceptedGeneration) || acceptedGeneration < 1)
      ) throw new Error('Radio directory generation metadata was malformed');
      if (!body.stale && !body.degraded && acceptedGeneration === null) {
        throw new Error('Radio directory omitted its accepted generation');
      }
      const catalogInstance = body.catalogInstance;
      if (!body.stale && !body.degraded && (typeof catalogInstance !== 'string' || !catalogInstance)) {
        throw new Error('Radio directory omitted its catalog instance');
      }
      const preservingWarmCatalog = _stations.length > 0 && (body.stale || body.degraded);
      // Generations are only comparable within one producer instance. A new
      // instance token (server restart, different proxy process) starts a fresh
      // sequence: never a repeat and never a regression.
      const sameCatalogInstance = _acceptedCatalogSnapshot?.instance === catalogInstance;
      const currentAcceptedGeneration = sameCatalogInstance
        ? _acceptedCatalogSnapshot?.generation
        : null;
      if (
        !body.stale
        && !body.degraded
        && Number.isSafeInteger(currentAcceptedGeneration)
        && acceptedGeneration < currentAcceptedGeneration
      ) throw new Error('Radio directory generation regressed');
      const repeatingAcceptedGeneration = (
        !body.stale
        && !body.degraded
        && Number.isSafeInteger(currentAcceptedGeneration)
        && acceptedGeneration === currentAcceptedGeneration
      );
      if (!preservingWarmCatalog) {
        const immutableRows = acceptedRows.map(freezeRadioStation);
        if (repeatingAcceptedGeneration) {
          _updatedAt = _acceptedCatalogSnapshot.updatedAt;
          if (!_tuningActive && _cancelledTuningPresentationStation) {
            _cancelledTuningPresentationStation = null;
            updateSelectionEntity();
          }
        } else if (!body.stale && !body.degraded) {
          const acceptedSnapshot = createAcceptedCatalogSnapshot(
            catalogInstance,
            acceptedGeneration,
            updatedAt,
            immutableRows,
          );
          if (!acceptedSnapshot) throw new Error('Radio directory generation metadata was malformed');
          _acceptedCatalogSnapshot = acceptedSnapshot;
          reconcileStations(acceptedSnapshot.stations);
        } else {
          reconcileStations(immutableRows);
        }
        if (!repeatingAcceptedGeneration) _updatedAt = updatedAt;
      }
      _degraded = body.degraded;
      _stale = body.stale;
      _error = preservingWarmCatalog
        ? 'Directory refresh degraded; showing the previous station catalog.'
        : (_degraded ? 'Radio directory coverage is degraded.' : null);
    } catch (error) {
      if (error?.name === 'AbortError' || !radioRequestIsCurrent(
        generation,
        _requestGeneration,
        _enabled,
        sessionGeneration,
        _sessionGeneration,
      )) return;
      _error = _stations.length
        ? 'Directory refresh failed; showing the previous station catalog.'
        : 'Radio directory is temporarily unavailable.';
      _stale = _stations.length > 0;
      _degraded = _stations.length > 0;
    } finally {
      if (generation === _requestGeneration && sessionGeneration === _sessionGeneration) {
        _loading = false;
        _abortController = null;
        emitState();
      }
    }
  },

  /** Release rendering, event, request, and playback resources. */
  destroy() {
    this.disable();
    cancelRadioVolumeTransition();
    _voiceDucked = false;
    _voiceRestoring = false;
    endRadioTuning();
    const closedTuningNoise = _tuningNoiseContext?.close?.();
    if (closedTuningNoise?.catch) void closedTuningNoise.catch(() => {});
    _tuningNoiseContext = null;
    if (_audio) _audio.volume = DEFAULT_RADIO_VOLUME;
    _audio = null;
    _userVolume = DEFAULT_RADIO_VOLUME;
    _removeClusterListener?.();
    _removeClusterListener = null;
    if (_dataSource && _viewer) _viewer.dataSources.remove(_dataSource, true);
    _dataSource = null;
    clearOverlaySource(RADIO_OVERLAY_SOURCE_ID);
    _stations = [];
    _acceptedCatalogSnapshot = EMPTY_ACCEPTED_CATALOG_SNAPSHOT;
    _stationById.clear();
    _categories = Object.freeze([]);
    _filter = DEFAULT_RADIO_FILTER;
    _renderById.clear();
    resetRadioClusterOverlayIdentities();
    _lastHorizonCameraPosition = null;
    _horizonScanCount = 0;
    _selectedId = null;
    _tuningPreviewId = null;
    _tuningStartStationId = null;
    _tuningResolutionSnapshot = EMPTY_ACCEPTED_CATALOG_SNAPSHOT;
    _tuningStationById = new Map();
    _tuningUnavailableStationId = null;
    _cancelledTuningPresentationStation = null;
    _loading = false;
    _stale = false;
    _degraded = false;
    _error = null;
    _updatedAt = null;
    _managerLifecyclePresentation = null;
    _viewer = null;
    emitState();
    _listeners.clear();
    _playbackControlListeners.clear();
  },

  /** Layer statistics for HUD/debug surfaces. */
  getStats() {
    return {
      count: _stations.length,
      filtered: visibleStations().length,
      selected: _selectedId,
      playing: _audioStationId,
      stale: _stale,
      degraded: _degraded,
      loading: _loading,
      error: _error,
      lastUpdate: _updatedAt ? Date.parse(_updatedAt) : null,
      horizonScans: _horizonScanCount,
      overlayEntries: _overlayDiagnostics.entryCount,
    };
  },

  subscribe: subscribeToRadio,
  subscribePlaybackControls: subscribeToRadioPlaybackControls,
  getAcceptedCatalogSnapshot: getRadioAcceptedCatalogSnapshot,
  getUIState: getRadioUIState,
  getParams: getRadioParams,
  setParams: setRadioParams,
  getOverlayDiagnostics: () => ({
    ..._overlayDiagnostics,
    singletonTexts: [..._overlayDiagnostics.singletonTexts],
    singletonIds: [..._overlayDiagnostics.singletonIds],
    clusterTexts: [..._overlayDiagnostics.clusterTexts],
    clusterIds: [..._overlayDiagnostics.clusterIds],
    clusterMemberships: _overlayDiagnostics.clusterMemberships.map((entry) => ({ ...entry })),
  }),
  getTunerStations: getRadioTunerStations,
  beginTuning: beginRadioTuning,
  setTuningStatic: setRadioTuningStatic,
  previewTuningStation: previewRadioTuningStation,
  commitTuningStation: commitRadioTuningStation,
  cancelTuning: cancelRadioTuning,
  endTuning: endRadioTuning,
  setFilter: setRadioFilter,
  selectStation: selectRadioStation,
  selectRequestedStation: selectRequestedRadioStation,
  cycleStation: cycleRadioStation,
  togglePlayback: toggleRadioPlayback,
  play: playSelectedRadio,
  playForVoice: playPreparedRadioForVoice,
  pause: pauseRadioPlayback,
  stopPlayback: stopRadioPlayback,
  setVolume: setRadioVolume,
  setVoiceDucked: setRadioVoiceDucking,
};

export default radioLayer;
