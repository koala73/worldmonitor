import * as Cesium from 'cesium';
import {
  registerEntityContext,
  selectEntityContext,
  clearSelectedEntityContextForLayer,
} from './contextStore.js';
import { createTrail } from './trailRenderer.js';
import { screenProjectedRotation, cameraPoseSignature } from './iconOrientation.js';
import { formatKnots } from './detectionDraw.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  unregisterPickOwner,
  resolvePickId,
} from './pickRegistry.js';
import {
  applyVesselOverlayPolicy,
  accentForVesselType,
  VESSEL_CARD_FADE_DISTANCE_M,
  VESSEL_LABEL_GRID_PX,
  VESSEL_OVERLAY_SOURCE_ID,
  vesselTypeCss,
  vesselOverlayCohortLimit,
  normalizeVesselType,
} from './vesselLabels.js';
import {
  clearOverlaySource,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { ensureGeoidReady, geoidHeight } from './geoid.js';
import {
  registerSpriteCollection,
  restoreSpriteOrder,
  restoreSpriteOrderOnEnable,
} from './spriteOrder.js';
import {
  advanceSpriteFocus,
  focusNowMs,
  focusAlphaNeedsWrite,
  focusPassIsNeeded,
  forgetSpriteFocus,
  getFocusTarget,
} from './focusDeemphasis.js';
import { requestWorldFocus } from '../worldFocus.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';

const FOCUS_EVIDENCE_DEV = import.meta.env?.DEV === true;

/** Camera pose signature at the last vessel rotation pass. */
let _lastCamPoseSig = '';
const _scratchFocusScreen = new Cesium.Cartesian2();

const DEFAULT_API_URL = '/api/gev/ais-live';
const DEFAULT_RENDER_ROWS = 12000;
const DEFAULT_ACTIVE_LABELS = 900;
const REFRESH_MS = 60000;
/** Bounded wait for the first accepted vessel position in one enabled session. */
export const AIS_FIRST_CONNECT_GRACE_MS = 30000;
const AIS_FIRST_CONNECT_LABEL = 'awaiting first AIS position…';
const VISIBILITY_UPDATE_MS = 800;
/** Focus alpha alone samples faster inside the existing preRender pass. */
const FOCUS_UPDATE_MS = 80;
const LABEL_GRID_PX = VESSEL_LABEL_GRID_PX;
/**
 * Minimum screen-space separation between accepted vessel cards (matches the
 * FIRMS card declutter). The 118px grid alone under-spaces the wider canvas
 * cards; the greedy pass below enforces true card-scale spacing.
 */
const CARD_MIN_SEP_PX = 150;
/** Number of consecutive refreshes a selected-but-vanished vessel is retained. */
const SELECTED_PIN_REFRESHES = 3;
/** Trail hue for the selected vessel (PRD F4, pinned to the AIS teal-green family). */
const TRAIL_COLOR = '#39ffd5';
/** Slight lift (m) for trail vertices to avoid sea-surface z-fighting. */
const TRAIL_HEIGHT_M = 3;
/**
 * Lift (m) above the local sea surface (geoid) for vessel anchors — locked
 * height-datum principle #1: never below the visible surface, slightly above
 * is always fine (clears tide/mesh noise in the photoreal sea mesh).
 */
const VESSEL_LIFT_M = 3;
/** Combined cap on trail vertices (server backfill + live accumulation). */
const TRAIL_MAX_POINTS = 400;
/** Minimum movement (m) before a reconcile refresh appends a new trail point. */
const TRAIL_MIN_MOVE_M = 25;

const DEFAULT_VESSEL_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
  hitTest: hitTestWorldOverlay,
});
let _vesselOverlayHost = DEFAULT_VESSEL_OVERLAY_HOST;

const DEFAULT_AIS_RUNTIME = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
});
let _aisRuntime = DEFAULT_AIS_RUNTIME;
let _aisSessionSequence = 0;

/**
 * Human-readable reasons for a non-'open' AISStream feed status, keyed to the
 * server's `_aisStreamStatus` values (see vite.config.js). Surfaced verbatim in
 * the layer chip so a dead feed reads "feed down" instead of a healthy-looking
 * "just now · 0 vessels".
 */
const AIS_STATUS_REASON = {
  'missing-key': 'AISSTREAM_API_KEY not set',
  unsupported: 'live feed unsupported',
  connecting: 'connecting to feed…',
  closed: 'feed disconnected',
  error: 'feed down',
  idle: 'feed idle',
};

/**
 * Statuses in which fresh data is flowing. 'open' is the pre-watchdog spelling
 * and is still accepted so a cached bundle and a restarted server never
 * disagree about health.
 */
const AIS_HEALTHY_STATUSES = new Set(['live', 'open']);

/**
 * Server statuses meaning "the feed is not delivering right now". These are
 * surfaced even while cached vessels are still drawn: rows retained from
 * before the outage must never make a dead feed read as a healthy one.
 */
const AIS_DEGRADED_STATUSES = new Set(['stale', 'reconnecting', 'down', 'auth-failed']);

/**
 * Seconds until the server's next reconnect attempt, or 0 when none is
 * scheduled. Mirrors the flights layer's `retryInSec` chip affordance.
 * @returns {number}
 */
function aisRetryInSec() {
  // A rejected key is terminal until someone changes it; an hour-long
  // countdown would imply waiting is the fix.
  if (state.transportStatus === 'auth-failed') return 0;
  const at = Number(state.nextAttemptAt);
  if (!Number.isFinite(at) || at <= 0) return 0;
  return Math.max(0, Math.ceil((at - _aisRuntime.now()) / 1000));
}

/**
 * Chip text for a feed the server has reported as not delivering.
 * @param {string} status - 'stale' | 'reconnecting' | 'down'
 * @param {Object} payload - Parsed /api/ais-live JSON.
 * @returns {string}
 */
function describeDegradedAisFeed(status, payload) {
  if (status === 'auth-failed') {
    // Actionable, not a countdown: retrying cannot fix a rejected credential,
    // so the chip asks the operator to do the one thing that can.
    return 'API key rejected — check AISSTREAM_API_KEY';
  }
  if (status === 'stale') {
    const silentSec = Math.round(Number(payload?.silentForMs) / 1000);
    return Number.isFinite(silentSec) && silentSec > 0
      ? `feed silent ${silentSec}s — no AIS data`
      : 'feed silent — no AIS data';
  }
  const attempt = Number(payload?.reconnectAttempt);
  const suffix = Number.isFinite(attempt) && attempt >= 1 ? ` (attempt ${attempt})` : '';
  return status === 'down'
    ? `feed down — retrying slowly${suffix}`
    : `reconnecting to feed…${suffix}`;
}

/**
 * Derive a surfaced error string from an /api/ais-live payload, or null when the
 * feed has accepted product data. Socket transport, message receipt, and usable
 * vessel positions are separate health stages: an open socket with no message
 * or no accepted positions must not read as a fresh successful update.
 *
 * @param {Object|null|undefined} payload - Parsed /api/ais-live JSON.
 * @param {number} acceptedRowCount - Number of rows accepted by vessel normalization.
 * @returns {string|null} A short reason for the chip, or null if healthy.
 */
export function deriveAisFeedError(payload, acceptedRowCount) {
  const status = payload && typeof payload.status === 'string' ? payload.status : null;
  // A feed the server reports as not delivering outranks the row count: the
  // cached vessels on screen are exactly what makes an outage invisible.
  if (status && AIS_DEGRADED_STATUSES.has(status)) {
    return describeDegradedAisFeed(status, payload);
  }
  if (acceptedRowCount > 0) return null; // accepted rows may be stale while reconnecting, but remain usable
  if (AIS_HEALTHY_STATUSES.has(status)) {
    return payload?.lastMessageAt
      ? 'awaiting usable AIS positions…'
      : 'awaiting first AIS message…';
  }
  if (!status) return null;
  const detail = typeof payload.error === 'string' && payload.error.trim() ? payload.error.trim() : '';
  const reason = AIS_STATUS_REASON[status] || 'feed unavailable';
  return detail && !AIS_STATUS_REASON[status] ? `${reason} (${detail})` : reason;
}

/** True when a raw AIS row can enter the production vessel normalizer. */
function hasUsableVesselCoordinates(row) {
  return Number.isFinite(Number(row?.lat)) && Number.isFinite(Number(row?.lon));
}

/**
 * Classify one server snapshot before any destructive reconciliation.
 * @param {Object|null|undefined} payload - Parsed /api/ais-live payload.
 * @returns {{transportStatus: string|null, lastMessageAt: number|string|null,
 *   rawRows: Array<Object>, acceptedRows: Array<Object>, rawRowCount: number,
 *   acceptedRowCount: number, error: string|null}}
 */
export function classifyAisFeedSnapshot(payload) {
  const rawRows = Array.isArray(payload?.rows) ? payload.rows : [];
  const acceptedRows = rawRows.filter(hasUsableVesselCoordinates);
  const transportStatus = typeof payload?.status === 'string' ? payload.status : null;
  const lastMessageAt = payload?.lastMessageAt ?? null;
  const acceptedRowCount = acceptedRows.length;
  return {
    transportStatus,
    lastMessageAt,
    rawRows,
    acceptedRows,
    rawRowCount: rawRows.length,
    acceptedRowCount,
    error: deriveAisFeedError(payload, acceptedRowCount)
      || (acceptedRowCount === 0 ? 'awaiting usable AIS positions…' : null),
  };
}

/**
 * Map one internal vessel record to a plain JSON-safe analyst record
 * (analyst query engine seam). Pure — no Cesium types. Missing/unknown
 * fields are null, never NaN/undefined. navStatus is always null: the
 * /api/ais-live proxy does not surface AIS NavigationalStatus, so it
 * cannot be derived client-side.
 * @param {Object|null|undefined} record - `state.vesselMap`/`state.vesselRecords` entry.
 * @returns {{id: string|null, mmsi: string|null, name: string|null,
 *   lat: number|null, lon: number|null, speedKts: number|null,
 *   courseDeg: number|null, shipType: string|null, destination: string|null,
 *   navStatus: null}}
 */
export function mapAnalystRecord(record) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  const mmsi = text(record?.mmsi);
  const name = text(record?.name);
  return {
    id: name || mmsi,
    mmsi,
    name,
    lat: num(record?.lat),
    lon: num(record?.lon),
    speedKts: num(record?.speed),
    courseDeg: num(record?.course),
    shipType: text(record?.type),
    destination: text(record?.destination),
    navStatus: null,
  };
}

/**
 * True once the EGM96 geoid grid has loaded (fire-and-forget warm at
 * enable(), aircraft idiom — see militaryFlights.js). Gates all synchronous
 * geoidHeight() reads so a poll can never throw pre-load.
 * @type {boolean}
 */
let _geoidReady = false;

/**
 * Ellipsoidal render height (m) for a sea-surface object: the local geoid
 * undulation N plus a small lift. The sea surface ≈ the geoid, which sits
 * −106…+85 m off the WGS84 ellipsoid worldwide (Rotterdam ≈ +45 m — at
 * height 0 the tile sea mesh occludes every chevron; Houston ≈ −27 m).
 * Pure seam, exported for unit tests.
 * @param {number|null|undefined} geoidN - Undulation N (m), or null/undefined while the grid is cold.
 * @param {number} liftM - Lift above the sea surface (m).
 * @returns {number} Ellipsoidal height h = N + lift (N treated as 0 when absent).
 */
export function vesselDatumHeightM(geoidN, liftM) {
  return (Number.isFinite(geoidN) ? geoidN : 0) + liftM;
}

/**
 * Reduce one vessel-selection gesture to the layer-owned action it should
 * perform. The interaction handler reserves only vessel-record residuals and
 * trail picks as no-ops. The interaction wire also reserves sibling-owned
 * picks before this reducer so their camera action cannot mutate AIS state.
 *
 * @param {{selectedMmsi?: string|number|null, pickedMmsi?: string|number|null,
 *   gesture?: 'click'|'escape'}} input - Current selection plus owned pick.
 * @returns {{action: 'none'|'select'|'deselect'}}
 */
export function reduceVesselSelection(input = {}) {
  const selectedMmsi = normalizeSelectionMmsi(input.selectedMmsi);
  const pickedMmsi = normalizeSelectionMmsi(input.pickedMmsi);
  const gesture = input.gesture || 'click';

  if (gesture === 'escape') {
    return selectedMmsi
      ? { action: 'deselect' }
      : { action: 'none' };
  }
  if (gesture !== 'click') {
    return { action: 'none' };
  }
  if (pickedMmsi) {
    if (pickedMmsi === selectedMmsi) {
      return { action: 'none' };
    }
    return { action: 'select' };
  }
  return selectedMmsi
    ? { action: 'deselect' }
    : { action: 'none' };
}

function normalizeSelectionMmsi(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * Geoid undulation N at (lat, lon), or null until the grid has loaded.
 * @param {number} lat
 * @param {number} lon
 * @returns {number|null}
 */
function currentGeoidN(lat, lon) {
  return _geoidReady ? geoidHeight(lat, lon) : null;
}

/** @type {Map<string, string>} `${cssColor}:${variant}` -> chevron SVG data URL */
const shipIconCache = new Map();

const aisLiveVesselsLayer = {
  id: 'ais-live-vessels',
  name: 'Live AIS Vessels',
  icon: '◭',
  source: 'AISStream',
  updateInterval: REFRESH_MS,
  statsRefreshInterval: 1000,

  init(viewer) {
    state.viewer = viewer;
    ensureCollections(viewer);
    _vesselOverlayHost.setVisible(VESSEL_OVERLAY_SOURCE_ID, false);
    installInteraction(viewer);
    installRuntime(viewer);
    restoreSpriteOrder(viewer);
  },

  enable(viewer) {
    const wasEnabled = state.enabled;
    state.enabled = true;
    if (!wasEnabled) beginAisSession();
    holdContinuousRender('ais-vessels'); // per-frame animator (perf wave 2)
    const activeViewer = viewer || state.viewer;
    ensureCollections(activeViewer);
    installInteraction(activeViewer);
    setVisible(true);
    // Height-datum fix: warm the geoid grid once per layer-enable, never
    // blocking a poll. The first refresh may land pre-resolve (N = 0), and
    // the next is up to 60 s out — so re-floor in place on resolve. A load
    // failure leaves N = 0 forever, which is safe: sprites are depth-test-
    // free, so vessels stay visible either way.
    if (!_geoidReady) {
      ensureGeoidReady()
        .then(() => {
          _geoidReady = true;
          refloorVesselRecords();
        })
        .catch(() => { /* grid failed to load — anchors stay at ellipsoid 0 */ });
    }
    // Pick-ownership (H2): vessel picks carry the record OBJECT as their id;
    // the registry resolver reduces it to the record's mmsi (a string key).
    registerPickOwner('ais-live-vessels', (pickedId) => state.vesselMap.has(pickedId));
    restoreSpriteOrderOnEnable('ais', activeViewer);
    return loadLivePositions(activeViewer);
  },

  disable() {
    state.enabled = false;
    invalidateAisSession();
    releaseContinuousRender('ais-vessels');
    unregisterPickOwner('ais-live-vessels');
    setVisible(false);
    _vesselOverlayHost.clearSource(VESSEL_OVERLAY_SOURCE_ID);
    clearVesselInspection();
    destroySelectedVesselTrail();
    removeVesselInteraction();
    if (state.abort) {
      state.abort.abort();
      state.abort = null;
    }
    state.loading = false;
    state.loadingLabel = '';
  },

  update(viewer) {
    if (!state.enabled) return Promise.resolve();
    return loadLivePositions(viewer || state.viewer);
  },

  destroy(viewer) {
    invalidateAisSession();
    releaseContinuousRender('ais-vessels'); // direct-destroy path (perf wave 2 fix)
    if (state.abort) state.abort.abort();
    unregisterPickOwner('ais-live-vessels');
    clearVesselInspection();
    destroySelectedVesselTrail();
    if (state.billboardCollection && viewer) {
      viewer.scene.primitives.remove(state.billboardCollection);
    }
    _vesselOverlayHost.clearSource(VESSEL_OVERLAY_SOURCE_ID);
    _vesselOverlayHost.setVisible(VESSEL_OVERLAY_SOURCE_ID, false);
    removeVesselInteraction();
    if (state.preRenderRemover) {
      state.preRenderRemover();
    }
    resetState();
  },

  /**
   * Find a vessel by exact MMSI or case-insensitive name substring.
   * @param {string|number} query MMSI or partial vessel name.
   * @returns {{ mmsi: string, name: string, position: Cesium.Cartesian3, latitude: number, longitude: number, speedKt: number|null, course: number|null, type: string }|null}
   */
  findByQuery(query) {
    if (query === null || query === undefined) return null;
    const records = state.vesselRecords;
    if (!Array.isArray(records) || !records.length) return null;
    const q = String(query).trim();
    if (!q) return null;

    let record = null;
    if (/^\d+$/.test(q)) {
      record = state.vesselMap.get(q) || null;
    }
    if (!record) {
      const lower = q.toLowerCase();
      record = records.find((r) => String(r.name || '').toLowerCase().includes(lower)) || null;
    }
    if (!record) return null;

    const position = record.billboard?.position || record.position;
    if (!position) return null;
    return {
      mmsi: record.mmsi,
      name: record.name,
      position,
      latitude: record.lat,
      longitude: record.lon,
      speedKt: record.speed,
      course: record.course,
      type: record.type,
    };
  },

  /**
   * Get vessels within a range of a point, sorted nearest-first.
   * @param {Cesium.Cartesian3} centerCartesian Center of the search.
   * @param {number} rangeM Max distance in meters (non-finite = unbounded).
   * @param {number} [maxCount=25] Maximum entries to return.
   * @returns {Array<{ mmsi: string, name: string, position: Cesium.Cartesian3, distanceM: number }>}
   */
  getNearby(centerCartesian, rangeM, maxCount = 25) {
    const records = state.vesselRecords;
    if (!centerCartesian || !Array.isArray(records) || !records.length) return [];
    const range = Number.isFinite(rangeM) && rangeM > 0 ? rangeM : Infinity;
    const cap = Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 25;

    const entries = [];
    for (const record of records) {
      if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon)) continue;
      const position = record.billboard?.position || record.position;
      if (!position) continue;
      const distanceM = Cesium.Cartesian3.distance(centerCartesian, position);
      if (!Number.isFinite(distanceM) || distanceM > range) continue;
      entries.push({ mmsi: record.mmsi, name: record.name, position, distanceM });
    }
    entries.sort((a, b) => a.distanceM - b.distanceM);
    return entries.slice(0, cap);
  },

  /**
   * Get positions of all currently loaded vessels.
   * @param {number} [maxCount=800] Maximum entries to return.
   * @returns {Array<{ id: string, label: string, position: Cesium.Cartesian3, latitude: number, longitude: number }>}
   */
  /**
   * Whether this layer still carries a vessel, in O(1).
   *
   * Mirror of `flights.hasContact`: presence consumers must not infer absence
   * from the capped `getAllPositions` rows. `vesselMap` is MMSI-keyed.
   * A disabled layer keeps its records, so it must decline rather than answer
   * from data the user can no longer see.
   * @param {string} mmsi Vessel identifier.
   * @returns {boolean|null} Presence, or null when the layer is disabled or
   *   holds no data and therefore cannot answer.
   */
  hasContact(mmsi) {
    if (!state.enabled || !state.vesselMap || state.vesselMap.size === 0) return null;
    if (!mmsi) return false;
    return state.vesselMap.has(String(mmsi).trim());
  },

  getAllPositions(maxCount = 800) {
    const result = [];
    const records = state.vesselRecords;
    if (!Array.isArray(records)) return result;
    const cap = Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 800;

    for (const record of records) {
      if (result.length >= cap) break;
      const position = record.billboard?.position || record.position;
      if (!position) continue;
      result.push({
        id: record.mmsi,
        label: record.name || record.mmsi,
        position,
        latitude: record.lat,
        longitude: record.lon,
      });
    }
    return result;
  },

  /**
   * Snapshot the layer's in-memory vessel records as plain JSON-safe
   * objects for the analyst query engine. On-demand only (called at most
   * once per spoken query) — zero per-frame cost, no listeners, no caching.
   * Returns [] while the layer is disabled or empty.
   * @param {number} [maxCount=2000] - Maximum records to return (truncation).
   * @returns {Array<Object>} See mapAnalystRecord for the record shape.
   */
  getAnalystRecords(maxCount = 2000) {
    if (!state.enabled) return [];
    const records = state.vesselRecords;
    if (!Array.isArray(records) || !records.length) return [];
    const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
    const result = [];
    for (const record of records) {
      if (result.length >= limit) break;
      result.push(mapAnalystRecord(record));
    }
    return result;
  },

  /**
   * Select a vessel by MMSI via the same path as a map click
   * (highlight + HUD update).
   * @param {string|number} mmsi Vessel MMSI.
   * @returns {boolean} True if a matching vessel was selected.
   */
  selectById(mmsi) {
    if (mmsi === null || mmsi === undefined) return false;
    const target = String(mmsi).trim();
    if (!target) return false;
    const record = state.vesselMap.get(target);
    if (!record) return false;
    selectVessel(record);
    return true;
  },

  /**
   * Clear the current vessel selection and reset the HUD readout.
   * @returns {boolean} Always true.
   */
  clearSelection() {
    clearVesselInspection();
    return true;
  },

  /**
   * Get info about the currently selected vessel.
   * @returns {{ mmsi: string, name: string, latitude: number, longitude: number, speedKt: number|null, course: number|null, type: string }|null}
   */
  getSelectedInfo() {
    const record = state.selectedRecord;
    if (!record) return null;
    return {
      mmsi: record.mmsi,
      name: record.name,
      latitude: record.lat,
      longitude: record.lon,
      speedKt: record.speed,
      course: record.course,
      type: record.type,
    };
  },

  /**
   * Return a subset of vessels for the universal detection overlay.
   * Deterministic stride sampling distributes selections evenly across the
   * current record list while honoring the overlay's per-layer budget.
   * @param {Object} [options={}] - Options from the detection system.
   * @param {number} [options.maxCount] - Maximum objects to return (defaults to all).
   * @param {number} [options.seed] - Seed offset for stride sampling.
   * @returns {Array<{position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean}>}
   */
  getDetectableObjects(options = {}) {
    if (!state.enabled || !state.billboardCollection || !state.billboardCollection.show) return [];
    const records = state.vesselRecords;
    if (!Array.isArray(records) || !records.length) return [];

    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : records.length;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    // Deterministic stride: evenly space selections across the record list
    const stride = Math.max(1, Math.ceil(records.length / maxCount));
    const start = seed % stride;

    const selected = state.selectedRecord;
    const result = [];
    for (let idx = 0; idx < records.length; idx += 1) {
      if (((idx - start) % stride) !== 0) continue;
      const record = records[idx];
      if (record.billboard && !record.billboard.show) continue;
      const position = record.billboard?.position || record.position;
      if (!position) continue;
      result.push({
        position,
        sourceId: record.mmsi,
        id: record.name || record.mmsi || 'VESSEL',
        type: 'SEA',
        skipLabel: record === selected,
        klass: record.type ? String(record.type).toUpperCase().slice(0, 14) : undefined,
        metric: formatKnots(record.speed), // record.speed is knots
      });
      if (result.length >= maxCount) break;
    }
    return result;
  },

  ...(FOCUS_EVIDENCE_DEV ? {
    __focusEvidence: Object.freeze({
      setVessels: _setFocusEvidenceVessels,
      snapshot: _focusEvidenceVesselSnapshot,
    }),
  } : {}),

  getStats() {
    const waitingForFirstPosition = state.firstConnectPhase === 'loading';
    return {
      count: state.count,
      lastUpdate: state.lastUpdate,
      loading: state.loading || waitingForFirstPosition,
      loadingLabel: waitingForFirstPosition
        ? AIS_FIRST_CONNECT_LABEL
        : state.loadingLabel,
      error: state.error,
      stale: state.stale,
      status: state.firstConnectPhase === 'unavailable' ? 'unavailable' : undefined,
      transportStatus: state.transportStatus,
      lastMessageAt: state.lastMessageAt,
      rawRowCount: state.rawRowCount,
      acceptedRowCount: state.acceptedRowCount,
      // Same chip affordance the flights layer uses: when the server is
      // backing off, say how long until the next attempt instead of leaving
      // the user to guess whether anything is still happening.
      retryInSec: aisRetryInSec(),
    };
  },
};

const state = {
  viewer: null,
  enabled: false,
  loading: false,
  loaded: false,
  stale: false,
  error: null,
  loadingLabel: '',
  lastUpdate: null,
  count: 0,
  newestPositionAt: null,
  transportStatus: null,
  /** Server epoch-ms of the next reconnect attempt while the feed is degraded. */
  nextAttemptAt: null,
  lastMessageAt: null,
  rawRowCount: 0,
  acceptedRowCount: 0,
  /** Monotonic enable/reset owner for requests and first-connect timers. */
  sessionId: 0,
  /** @type {'idle'|'loading'|'ready'|'unavailable'} */
  firstConnectPhase: 'idle',
  firstConnectStartedAt: null,
  firstConnectDeadline: null,
  firstConnectTimer: null,
  abort: null,
  billboardCollection: null,
  /** @type {Array<Object>} Flat render list: keyed records + unkeyed records */
  vesselRecords: [],
  /** @type {Map<string, Object>} MMSI -> vessel record (identity across refreshes) */
  vesselMap: new Map(),
  /** @type {Array<Object>} Records with no MMSI — rebuilt fresh each refresh */
  unkeyedRecords: [],
  clickHandler: null,
  /** Exact EventTarget currently holding the Escape listener. */
  keyTarget: null,
  /** Exact callback registered on keyTarget. */
  keydownHandler: null,
  /** Cesium trackedEntityChanged listener disposer. */
  trackedEntityRemover: null,
  /** Test-only factory used to exercise enable-time interaction installation. */
  interactionHandlerFactory: null,
  /** Test-only key target paired with interactionHandlerFactory. */
  interactionKeyTarget: null,
  preRenderRemover: null,
  lastVisibilityUpdate: 0,
  lastFocusUpdate: 0,
  /** Sprites whose animated emphasis remains outside the 1.0 deadband. */
  activeFocusCount: 0,
  activeLabelCount: 0,
  selectedRecord: null,
  /** @type {{setPositions: Function, clear: Function, destroy: Function}|null} Selected-vessel fading trail */
  trail: null,
  /** @type {Cesium.Cartesian3[]} Chronological trail vertices (oldest first) */
  trailPositions: [],
  /** @type {string|null} MMSI that owns the active selected-vessel trail. */
  trailMmsi: null,
  /** @type {number} Monotonic token — invalidates in-flight backfill responses */
  trailBackfillToken: 0,
};

/** Replace live AIS rows through the production reconciliation path (DEV only). */
function _setFocusEvidenceVessels(rows = []) {
  if (!FOCUS_EVIDENCE_DEV || !state.viewer || !state.billboardCollection) {
    return { ok: false, count: 0 };
  }
  clearVesselInspection();
  reconcileVessels(state.viewer, Array.isArray(rows) ? rows : []);
  state.count = state.vesselRecords.length;
  state.loaded = true;
  state.error = null;
  state.stale = false;
  state.lastUpdate = Date.now();
  state.transportStatus = 'synthetic';
  state.lastMessageAt = null;
  state.rawRowCount = Array.isArray(rows) ? rows.length : 0;
  state.acceptedRowCount = state.count;
  return { ok: true, count: state.count };
}

/** JSON-safe vessel alpha/position snapshot for the evidence report. */
function _focusEvidenceVesselSnapshot() {
  if (!FOCUS_EVIDENCE_DEV || !state.viewer) return [];
  return state.vesselRecords.map((record) => {
    const bb = record.billboard;
    const screen = bb?.position
      ? Cesium.SceneTransforms.worldToWindowCoordinates(state.viewer.scene, bb.position)
      : null;
    return {
      id: record.mmsi,
      show: bb?.show === true,
      alpha: bb?.color?.alpha ?? null,
      x: screen?.x ?? null,
      y: screen?.y ?? null,
    };
  });
}

export default aisLiveVesselsLayer;

function clearFirstConnectTimer() {
  if (state.firstConnectTimer === null) return;
  _aisRuntime.clearTimeout(state.firstConnectTimer);
  state.firstConnectTimer = null;
}

function invalidateAisSession() {
  clearFirstConnectTimer();
  state.sessionId = ++_aisSessionSequence;
  state.firstConnectPhase = 'idle';
  state.firstConnectStartedAt = null;
  state.firstConnectDeadline = null;
}

function beginAisSession() {
  clearFirstConnectTimer();
  const sessionId = ++_aisSessionSequence;
  const startedAt = _aisRuntime.now();
  state.sessionId = sessionId;
  state.firstConnectPhase = 'loading';
  state.firstConnectStartedAt = startedAt;
  state.firstConnectDeadline = startedAt + AIS_FIRST_CONNECT_GRACE_MS;
  state.error = null;
  state.loadingLabel = AIS_FIRST_CONNECT_LABEL;
  scheduleFirstConnectExpiry(sessionId, AIS_FIRST_CONNECT_GRACE_MS);
}

function scheduleFirstConnectExpiry(sessionId, delayMs) {
  state.firstConnectTimer = _aisRuntime.setTimeout(() => {
    if (
      !state.enabled
      || state.sessionId !== sessionId
      || state.firstConnectPhase !== 'loading'
    ) return;
    const remainingMs = state.firstConnectDeadline - _aisRuntime.now();
    if (remainingMs > 0) {
      scheduleFirstConnectExpiry(sessionId, remainingMs);
      return;
    }
    state.firstConnectTimer = null;
    state.firstConnectPhase = 'unavailable';
    state.loadingLabel = '';
    state.error = state.lastMessageAt
      ? 'awaiting usable AIS positions…'
      : 'awaiting first AIS message…';
    state.stale = state.count > 0;
  }, delayMs);
}

function settleFirstConnectPhase(phase) {
  clearFirstConnectTimer();
  state.firstConnectPhase = phase;
  state.loadingLabel = '';
}

function isGraceEligibleTransport(status) {
  return AIS_HEALTHY_STATUSES.has(status) || status === 'connecting';
}

function isDefinitiveTransportFailure(status) {
  return Boolean(status) && !isGraceEligibleTransport(status);
}

function markAisUnavailable(reason) {
  settleFirstConnectPhase('unavailable');
  state.error = reason || 'AIS live load failed';
  state.stale = state.count > 0;
}

async function loadLivePositions(viewer) {
  if (!viewer || state.loading) return;
  state.loading = true;
  state.loadingLabel = state.loaded ? 'refreshing...' : 'loading...';
  const requestController = new AbortController();
  const requestSessionId = state.sessionId;
  state.abort = requestController;

  try {
    const url = liveApiUrl();
    // Combine the layer's teardown-abort with a hard timeout so a hung upstream
    // can't wedge the poll indefinitely (parity with the track fetch + flights).
    const signal = typeof AbortSignal.any === 'function'
      ? AbortSignal.any([requestController.signal, AbortSignal.timeout(10000)])
      : requestController.signal;
    const response = await fetch(url, {
      signal,
      cache: 'no-store',
    });
    if (!ownsAisRequest(requestController, requestSessionId)) return;
    if (!response.ok) {
      // The 503 key-absent / 502 stream-error bodies still carry {status,error}.
      // Prefer a clean surfaced reason over a cryptic "AIS live HTTP 503".
      let reason = `AIS live HTTP ${response.status}`;
      try {
        const errPayload = await response.json();
        if (!ownsAisRequest(requestController, requestSessionId)) return;
        reason = deriveAisFeedError(errPayload, 0)
          || (typeof errPayload?.error === 'string' && errPayload.error.trim()) || reason;
      } catch { /* non-JSON body — keep the HTTP status reason */ }
      throw new Error(reason);
    }

    const payload = await response.json();
    if (!ownsAisRequest(requestController, requestSessionId)) return;
    applyAisFeedSnapshot(viewer, payload);
  } catch (error) {
    if (ownsAisRequest(requestController, requestSessionId) && error?.name !== 'AbortError') {
      markAisUnavailable(error?.message || 'AIS live load failed');
      console.warn('[Data:ais-live-vessels]', state.error, error);
    }
  } finally {
    if (state.abort === requestController && state.sessionId === requestSessionId) {
      state.loading = false;
      state.loadingLabel = state.firstConnectPhase === 'loading'
        ? AIS_FIRST_CONNECT_LABEL
        : '';
      state.abort = null;
    }
  }
}

/** True while a request still owns this enabled layer lifecycle. */
function ownsAisRequest(controller, sessionId) {
  return state.enabled
    && state.sessionId === sessionId
    && state.abort === controller
    && !controller.signal.aborted;
}

/** Apply a classified snapshot while preserving warm state on zero accepted rows. */
function applyAisFeedSnapshot(viewer, payload) {
  const snapshot = classifyAisFeedSnapshot(payload);
  state.loaded = true;
  state.loadingLabel = '';
  state.transportStatus = snapshot.transportStatus;
  state.nextAttemptAt = Number(payload?.nextAttemptAt) || null;
  state.lastMessageAt = snapshot.lastMessageAt;
  state.rawRowCount = snapshot.rawRowCount;
  state.acceptedRowCount = snapshot.acceptedRowCount;

  if (snapshot.acceptedRowCount === 0) {
    state.count = state.vesselRecords.length;
    state.stale = state.count > 0 || Boolean(payload?.refreshing);
    if (isDefinitiveTransportFailure(snapshot.transportStatus)) {
      markAisUnavailable(snapshot.error);
      return { reconciled: false, ...snapshot };
    }
    if (
      state.firstConnectPhase === 'loading'
      && isGraceEligibleTransport(snapshot.transportStatus)
    ) {
      state.error = null;
      state.loadingLabel = AIS_FIRST_CONNECT_LABEL;
      return { reconciled: false, ...snapshot };
    }
    if (state.firstConnectPhase === 'loading') {
      markAisUnavailable(snapshot.error);
      return { reconciled: false, ...snapshot };
    }
    state.error = snapshot.error;
    return { reconciled: false, ...snapshot };
  }

  settleFirstConnectPhase('ready');
  reconcileVessels(viewer, snapshot.acceptedRows);
  state.count = state.vesselRecords.length;
  state.stale = Boolean(payload?.refreshing);
  state.newestPositionAt = payload?.newestPositionAt || null;
  // Not unconditionally null: a degraded feed keeps its reason even though the
  // cached vessels are still drawable, so the chip cannot go quiet on an
  // outage the user is still looking at.
  state.error = snapshot.error;
  state.lastUpdate = _aisRuntime.now();
  return { reconciled: true, ...snapshot };
}

function liveApiUrl() {
  const base = import.meta.env?.VITE_AIS_LIVE_API_URL || DEFAULT_API_URL;
  const url = new URL(base, window.location.origin);
  url.searchParams.set('maxRows', String(renderRowLimit()));
  return url.toString();
}

function renderRowLimit() {
  const configured = Number(import.meta.env?.VITE_AIS_LIVE_MAX_ROWS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(500, Math.min(50000, Math.round(configured)));
  }
  return DEFAULT_RENDER_ROWS;
}

function labelRowLimit() {
  const configured = Number(import.meta.env?.VITE_AIS_LIVE_LABEL_MAX_ROWS);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.max(0, Math.min(renderRowLimit(), Math.round(configured)));
  }
  return Math.min(DEFAULT_ACTIVE_LABELS, renderRowLimit());
}

function ensureCollections(viewer) {
  if (!viewer || state.billboardCollection) return;
  state.billboardCollection = new Cesium.BillboardCollection({
    blendOption: Cesium.BlendOption.TRANSLUCENT,
  });
  state.billboardCollection.show = state.enabled;
  viewer.scene.primitives.add(state.billboardCollection);
  registerSpriteCollection('ais', state.billboardCollection);
}

/**
 * Reconcile the incoming AIS rows against the MMSI-keyed record map.
 * Existing records are updated in place (position/heading/label) so identity
 * and selection survive refreshes; new vessels are added; vanished vessels are
 * removed — except the selected vessel, which is pinned for up to
 * SELECTED_PIN_REFRESHES consecutive misses with a stale HUD readout.
 * Rows without an MMSI are rendered unkeyed and rebuilt fresh each refresh.
 * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
 * @param {Array<Object>} rows - Raw AIS rows from the live API.
 */
function reconcileVessels(viewer, rows) {
  ensureCollections(viewer);

  // Unkeyed (no-MMSI) records cannot be diffed — drop and rebuild them.
  for (const record of state.unkeyedRecords) {
    removeRecordPrimitives(record);
  }
  state.unkeyedRecords = [];

  const occluder = makeOccluder();
  const seen = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const next = normalizeVessel(rows[index]);
    if (!next) continue;

    if (!next.mmsi) {
      addRecordPrimitives(next, occluder);
      state.unkeyedRecords.push(next);
      continue;
    }
    if (seen.has(next.mmsi)) continue; // defensive: dedupe payload rows
    seen.add(next.mmsi);

    const existing = state.vesselMap.get(next.mmsi);
    if (existing) {
      updateRecordInPlace(existing, next);
    } else {
      addRecordPrimitives(next, occluder);
      state.vesselMap.set(next.mmsi, next);
    }
  }

  // Remove vanished vessels, pinning the selected one for a few refreshes.
  for (const [mmsi, record] of state.vesselMap) {
    if (seen.has(mmsi)) continue;
    if (record === state.selectedRecord) {
      record.missedRefreshes = (record.missedRefreshes || 0) + 1;
      if (record.missedRefreshes <= SELECTED_PIN_REFRESHES) {
        updateSelectedVesselHud(record); // re-render with STALE marker
        continue;
      }
      // Aged out of the feed after exhausting its pin — not a deselect.
      clearVesselInspection({ evicted: true });
    }
    removeRecordPrimitives(record);
    state.vesselMap.delete(mmsi);
    // Defensive lifecycle closure: a trail may outlive selection state during
    // asynchronous handoff/refresh ordering, but never its owning record.
    if (state.trailMmsi === mmsi) clearSelectedVesselTrail();
  }

  state.vesselRecords = [...state.vesselMap.values(), ...state.unkeyedRecords];
  state.lastVisibilityUpdate = 0;
  updateVisibility(true);
}

/**
 * Create the billboard primitive for a freshly added vessel record. Map labels
 * are canvas cards (vesselLabels.js) rebuilt by the declutter pass — no
 * per-record label primitive exists anymore.
 * @param {Object} record - Normalized vessel record.
 * @param {Cesium.EllipsoidalOccluder|null} occluder - Horizon occluder for initial visibility.
 */
function addRecordPrimitives(record, occluder) {
  const visible = state.enabled && isVisible(record.surfacePosition, occluder);
  record.billboard = state.billboardCollection.add({
    position: record.position,
    show: visible,
    image: shipIcon(record, false),
    scale: shipScale(record),
    // Screen-projected rotation lands on the next visibility/rotation pass.
    rotation: 0,
    alignedAxis: Cesium.Cartesian3.ZERO,
    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
    verticalOrigin: Cesium.VerticalOrigin.CENTER,
    // Locked height-datum principle #2: contacts are ALWAYS visible —
    // depth-test-free sprites; the EllipsoidalOccluder handles the far side.
    // (The tile sea mesh ≠ the geoid exactly, so a depth-tested chevron at
    // the geoid still clips out behind local tide/mesh noise.)
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    id: record,
  });
}

/**
 * Update an existing record (and its primitives) from a freshly normalized row,
 * preserving object identity so selection and the click-pick id stay valid.
 * Billboard image is only reassigned when the resolved icon actually changes
 * (type recolor) to avoid thousands of redundant texture lookups per refresh.
 * @param {Object} record - Existing vessel record in state.vesselMap.
 * @param {Object} next - Freshly normalized record for the same MMSI.
 */
function updateRecordInPlace(record, next) {
  const selected = record === state.selectedRecord;
  const prevIcon = shipIcon(record, selected);

  record.lat = next.lat;
  record.lon = next.lon;
  record.name = next.name;
  record.imo = next.imo;
  record.type = next.type;
  record.destination = next.destination;
  record.speed = next.speed;
  record.course = next.course;
  record.heading = next.heading;
  record.lastPositionUtc = next.lastPositionUtc;
  record.lastPositionEpoch = next.lastPositionEpoch;
  record.position = next.position;
  record.surfacePosition = next.surfacePosition;
  record.normal = next.normal;
  record.missedRefreshes = 0;

  if (record.billboard) {
    record.billboard.position = record.position;
    // Rotation is owned by the projected-rotation pass (updateVisibility).
    record.billboard.scale = shipScale(record) * (selected ? 1.2 : 1);
    const nextIcon = shipIcon(record, selected);
    if (nextIcon !== prevIcon) {
      record.billboard.image = nextIcon;
    }
  }
  if (record.mmsi === state.trailMmsi) {
    appendSelectedVesselTrailFix(record);
  }
  if (selected) {
    updateSelectedVesselHud(record);
    registerSelectedContext(record);
  }
}

/**
 * Remove a record's billboard primitive from its collection.
 * @param {Object} record - Vessel record to tear down.
 */
function removeRecordPrimitives(record) {
  if (!record) return;
  if (record.billboard && state.billboardCollection) {
    forgetSpriteFocus(record.billboard);
    state.billboardCollection.remove(record.billboard);
  }
  record.billboard = null;
}

function normalizeVessel(row) {
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Vertical datum: anchor at the SEA SURFACE (geoid, h = N + lift), not the
  // ellipsoid — at height 0 everything that projects record.position (clicks,
  // detection brackets, cards, getNearby) points up to ~45 m under the water.
  const heightM = vesselDatumHeightM(currentGeoidN(lat, lon), VESSEL_LIFT_M);
  const position = Cesium.Cartesian3.fromDegrees(lon, lat, heightM);
  // Surface normal at this position — used as alignedAxis so billboard
  // rotation operates in the local tangent plane (true world heading)
  const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(position, new Cesium.Cartesian3());
  return {
    lat,
    lon,
    name: String(row.name || row.input_name || row.mmsi || row.input_identifier || 'VESSEL'),
    mmsi: String(row.mmsi || row.input_identifier || '').trim(),
    imo: String(row.imo || ''),
    type: String(row.type_specific || row.type || ''),
    destination: String(row.destination || ''),
    speed: finiteNumber(row.speed),
    course: finiteNumber(row.course),
    heading: finiteNumber(row.heading),
    lastPositionUtc: String(row.last_position_UTC || ''),
    lastPositionEpoch: finiteNumber(row.last_position_epoch),
    position,
    // Ellipsoid-surface point (height 0) — feeds ONLY the horizon occluder,
    // which tests against the WGS84 ellipsoid; keep it off the sea datum.
    surfacePosition: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    normal,
    missedRefreshes: 0,
    billboard: null,
  };
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shipScale(record) {
  const speed = Number(record.speed || 0);
  if (speed >= 18) return 0.78;
  if (speed >= 8) return 0.68;
  return 0.6;
}

/**
 * Best available real-world direction of travel for a vessel, degrees
 * clockwise from north (true heading preferred, course-over-ground fallback).
 * Screen rotation is computed from this by the shared projected-rotation
 * pass in updateVisibility — never directly from the compass value.
 * @param {Object} record - Vessel record.
 * @returns {number} Course in degrees (0 when unknown).
 */
function vesselCourseDeg(record) {
  const direction = record.heading ?? record.course;
  return Number.isFinite(direction) ? direction : 0;
}

/**
 * Build (and cache) a chevron/delta-wing SVG data URL tinted for the vessel.
 * The shape points north (up) so billboard rotation maps directly to heading.
 * One icon is generated per color+variant and reused across all billboards.
 * @param {Object} record - Vessel record (drives per-type tint).
 * @param {boolean} selected - True for the white/brighter selected variant.
 * @returns {string} SVG data URL.
 */
function shipIcon(record, selected) {
  const cssColor = selected ? '#ffffff' : vesselTypeCss(record.type);
  const key = `${cssColor}:${selected ? 'selected' : 'normal'}`;
  if (shipIconCache.has(key)) return shipIconCache.get(key);

  const stroke = selected ? 'rgba(6,26,32,0.95)' : 'rgba(4,18,24,0.9)';
  const strokeWidth = selected ? 1.1 : 0.7;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <g transform="translate(16,16)">
      <path d="M0,-14 L11,10 L4,7 L0,14 L-4,7 L-11,10 Z" fill="${cssColor}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>
    </g>
  </svg>`;
  const icon = 'data:image/svg+xml;base64,' + btoa(svg);
  shipIconCache.set(key, icon);
  return icon;
}

function installRuntime(viewer) {
  if (state.preRenderRemover || !viewer) return;
  state.preRenderRemover = viewer.scene.preRender.addEventListener(() => updateVisibility());
}

function updateVisibility(force = false) {
  if (!state.enabled) return;
  const now = focusNowMs(performance.now());
  const focusTarget = getFocusTarget();
  const regularPass = force || now - state.lastVisibilityUpdate >= VISIBILITY_UPDATE_MS;
  const focusPass = focusPassIsNeeded(focusTarget, state.activeFocusCount)
    && (force || now - state.lastFocusUpdate >= FOCUS_UPDATE_MS);
  if (!regularPass && !focusPass) return;
  if (regularPass) state.lastVisibilityUpdate = now;
  if (focusPass) state.lastFocusUpdate = now;
  if (!state.vesselRecords.length) {
    // No records — flush any lingering card entries (vanished-feed case).
    if (regularPass) updateClusteredLabels([]);
    if (focusPass) state.activeFocusCount = 0;
    return;
  }

  const scene = state.viewer?.scene;
  const camera = state.viewer?.camera;
  if (regularPass) {
    // Candidate construction stays on the original 800 ms selector cadence.
    // The 80 ms focus-only pass below never allocates label candidates.
    const poseSig = camera ? cameraPoseSignature(camera) : '';
    const doRotations = force || poseSig !== _lastCamPoseSig;
    if (doRotations) _lastCamPoseSig = poseSig;
    const occluder = makeOccluder();
    const labelCandidates = [];
    for (const record of state.vesselRecords) {
      const visible = isVisible(record.surfacePosition, occluder);
      if (record.billboard) {
        record.billboard.show = visible;
        if (visible && doRotations && scene) {
          const rot = screenProjectedRotation(
            scene, record.position, vesselCourseDeg(record), record.billboard.rotation
          );
          if (rot !== null && Math.abs(rot - record.billboard.rotation) > 0.002) {
            record.billboard.rotation = rot;
          }
        }
      }
      if (visible) labelCandidates.push(record);
    }
    updateClusteredLabels(labelCandidates);
  }
  if (focusPass && scene && camera) {
    const result = applyVesselFocusDeemphasis({
      records: state.vesselRecords,
      target: focusTarget,
      previousActiveCount: state.activeFocusCount,
      nowMs: now,
      screenPositionFor: (position) => (
        Cesium.SceneTransforms.worldToWindowCoordinates(scene, position, _scratchFocusScreen)
      ),
      cameraDistanceFor: (position) => Cesium.Cartesian3.distance(camera.positionWC, position),
    });
    state.activeFocusCount = result.activeCount;
  }
}

/**
 * Apply focus alpha to vessel sprites. Kept as a production wire seam so the
 * animation/deadband contract can be tested without constructing WebGL.
 * @param {object} input
 * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
 */
export function applyVesselFocusDeemphasis({
  records,
  target,
  previousActiveCount = 0,
  nowMs,
  screenPositionFor,
  cameraDistanceFor,
  params,
}) {
  if (!focusPassIsNeeded(target, previousActiveCount)) {
    return { writes: 0, transitioning: false, activeCount: 0, ran: false };
  }
  let writes = 0;
  let transitioning = false;
  let activeCount = 0;
  for (const record of records || []) {
    const bb = record?.billboard;
    const position = bb?.position || record?.position;
    if (!bb || !position) continue;
    const focus = advanceSpriteFocus(bb, {
      // Hidden/far-side sprites still finish any pending release so the active
      // count remains truthful and they cannot reappear with stale dim alpha.
      screenPosition: bb.show === false ? null : screenPositionFor(position),
      cameraDistance: cameraDistanceFor(position),
      nowMs,
      target,
      params,
      // Vessel artwork is 32 px before billboard scale. Including the
      // ambient chevron's own rendered extent prevents edge-overlap misses.
      spriteHalfWidthPx: (bb.width || 32) * (bb.scale || 1) * 0.5,
      spriteHalfHeightPx: (bb.height || 32) * (bb.scale || 1) * 0.5,
    });
    transitioning ||= focus.transitioning;
    if (focus.active) activeCount += 1;
    if (focusAlphaNeedsWrite(bb.color?.alpha, focus.factor, params)) {
      // Narrow always-visible amendment: the ship chevron remains present at
      // the non-zero floor while it competes with the tracked target. Preserve
      // the billboard's existing base RGB, matching the other layer patterns,
      // rather than repainting every chevron from a hard-coded WHITE base.
      const baseColor = bb.color || Cesium.Color.WHITE;
      bb.color = baseColor.withAlpha(focus.factor);
      writes += 1;
    }
  }
  return { writes, transitioning, activeCount, ran: true };
}

function makeOccluder() {
  const cameraPosition = state.viewer?.camera?.positionWC;
  if (!cameraPosition) return null;
  return new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, cameraPosition);
}

function isVisible(surfacePosition, occluder) {
  if (!surfacePosition || !occluder) return true;
  return occluder.isPointVisible(surfacePosition);
}

/**
 * Source selector for the shared world-overlay pipeline: the
 * grid declutter picks which vessels get cards — one winner per screen-space
 * grid cell, priority-ranked, capped — and publishes presentation entries to
 * the host, which owns projection, final placement, fade and paint. Runs on the
 * throttled visibility pass and forced refreshes, never per frame. The
 * selected vessel always gets its full-detail card, even when horizon-culled
 * from the ambient candidates; its protected entry bypasses ambient quotas.
 * @param {Array<Object>} records - Horizon-visible vessel records.
 */
function updateClusteredLabels(records) {
  const viewer = state.viewer;
  const scene = viewer?.scene;
  const selected = state.selectedRecord;
  const entries = selected ? [buildSelectedVesselCard(selected)] : [];
  const maxLabels = labelRowLimit();

  if (!scene || !records.length || maxLabels <= 0) {
    state.activeLabelCount = entries.length;
    publishVesselOverlayEntries(entries);
    return;
  }

  const cells = new Map();
  for (const record of records) {
    if (record === selected) continue;
    const screen = Cesium.SceneTransforms.worldToWindowCoordinates(scene, record.position);
    if (!screen) continue;
    const key = `${Math.floor(screen.x / LABEL_GRID_PX)}:${Math.floor(screen.y / LABEL_GRID_PX)}`;
    const candidate = { record, score: labelPriority(record, selected), x: screen.x, y: screen.y };
    const existing = cells.get(key);
    if (!existing || candidate.score > existing.score) {
      cells.set(key, candidate);
    }
  }

  // Greedy min-separation pass over the priority-ranked cell winners: the
  // selected card's anchor seeds the accepted set so ambient cards keep clear.
  const accepted = [];
  if (selected) {
    const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
      scene, selected.billboard?.position || selected.position
    );
    if (screen) accepted.push({ x: screen.x, y: screen.y });
  }
  const ranked = [...cells.values()].sort((a, b) => b.score - a.score);
  for (const candidate of ranked) {
    if (entries.length >= maxLabels) break;
    if (!cardScreenSeparated(accepted, candidate, CARD_MIN_SEP_PX)) continue;
    accepted.push({ x: candidate.x, y: candidate.y });
    entries.push(buildVesselCard(candidate.record));
  }
  state.activeLabelCount = entries.length;
  publishVesselOverlayEntries(entries);
}

/**
 * Publish a complete, bounded source snapshot to the shared host. The source
 * selector remains authoritative for the 118 px grid and 150 px separation;
 * the host then composes this demand with sibling ambient-card sources.
 * @param {Object[]} entries Formatted vessel card entries.
 */
function publishVesselOverlayEntries(entries) {
  const canvas = state.viewer?.scene?.canvas || state.viewer?.canvas;
  const width = Number(canvas?.clientWidth) || 0;
  const height = Number(canvas?.clientHeight) || 0;
  const ambientLimit = vesselOverlayCohortLimit(width, height, labelRowLimit());
  _vesselOverlayHost.setEntries(
    VESSEL_OVERLAY_SOURCE_ID,
    entries.map((entry) => {
      const card = applyVesselOverlayPolicy(entry, VESSEL_CARD_FADE_DISTANCE_M);
      if (!card.interactive) return card;
      const mmsi = String(card.id || '').startsWith('vessel:')
        ? card.id.slice('vessel:'.length)
        : '';
      return {
        ...card,
        accessibilityLabel: `Focus vessel ${card.title}, MMSI ${mmsi}`,
        activate: () => {
          const record = state.vesselMap.get(mmsi);
          if (!record) return false;
          selectAndFocusVessel(record);
          return true;
        },
      };
    }),
    {
      cohortLimit: Math.max(1, ambientLimit),
      collisionCapacity: ambientLimit,
      moving: false,
    },
  );
}

function labelPriority(record, selected) {
  if (record === selected) return 100000;
  let score = 0;
  if (hasUsefulName(record)) score += 1000;
  if (record.speed !== null) score += Math.min(400, Math.max(0, record.speed) * 20);
  if (record.heading !== null || record.course !== null) score += 80;
  if (record.type) score += 40;
  return score;
}

function hasUsefulName(record) {
  const text = String(record.name || '').trim();
  return Boolean(text && text !== 'VESSEL' && !/^MMSI\s*\d+$/i.test(text) && text !== record.mmsi);
}

function installInteraction(viewer) {
  if (state.clickHandler || !viewer) return;
  const handler = state.interactionHandlerFactory
    ? state.interactionHandlerFactory(viewer)
    : new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  bindVesselInteraction(viewer, handler, state.interactionKeyTarget || document);
}

function bindVesselInteraction(viewer, handler, keyTarget) {
  state.clickHandler = handler;
  handler.setInputAction((click) => {
    if (!state.enabled) return;
    const picked = viewer.scene.pick(click.position);
    const pickedId = resolvePickId(picked);
    let record = pickedId ? state.vesselMap.get(pickedId) : null;
    const rawId = picked?.id ?? picked?.primitive?.id;
    const ownRecordPick = rawId && typeof rawId === 'object' && Object.hasOwn(rawId, 'mmsi');

    // An own-layer record without a live map key is a strict no-op (FB-1
    // residual). Trails carry no layer identity and hug their contacts, so any
    // `gev-trail:*` pick is also a no-op. Every other non-vessel pick — sibling
    // unowned scene picks dismiss the current vessel inspection.
    if (ownRecordPick && (!pickedId || !record)) return;
    if (pickedId && !record && String(pickedId).startsWith('gev-trail:')) return;

    // A sibling layer already owns this click. Preserve the current vessel
    // selection and do not compete with its camera command.
    if (pickedId && isOwnedByOtherLayer('ais-live-vessels', pickedId)) return;

    // Cards are painted on a pointer-events:none canvas, so the scene pick is
    // usually terrain behind the card. Resolve against the host's current
    // actionable hit rectangles before treating the click as empty space.
    const cardHit = !record
      ? _vesselOverlayHost.hitTest?.(click.position?.x, click.position?.y, {
        sourceId: VESSEL_OVERLAY_SOURCE_ID,
      })
      : null;
    if (!record && cardHit) {
      const mmsi = String(cardHit.entryId || '').startsWith('vessel:')
        ? cardHit.entryId.slice('vessel:'.length)
        : null;
      record = mmsi ? state.vesselMap.get(mmsi) || null : null;
      // A stale card id is not empty terrain and must not clear a newer
      // selection. The next paint will evict its hit rectangle.
      if (!record) return;
    }

    if (record) {
      // A valid sprite or card click always transfers the camera exactly once,
      // including a second click on the already-selected vessel.
      selectAndFocusVessel(record);
    } else {
      const transition = reduceVesselSelection({
        selectedMmsi: state.selectedRecord?.mmsi,
        pickedMmsi: null,
        gesture: 'click',
      });
      if (transition.action === 'deselect') clearVesselInspection();
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  state.keyTarget = keyTarget;
  state.keydownHandler = onVesselKeyDown;
  keyTarget.addEventListener('keydown', state.keydownHandler);
  // Vessels never set viewer.trackedEntity, so any new tracked entity belongs
  // to another layer and takes interaction ownership of the scene.
  state.trackedEntityRemover = viewer.trackedEntityChanged.addEventListener(() => {
    if (viewer.trackedEntity && state.selectedRecord) clearVesselInspection();
  });
}

/** Select one live vessel and request one UI-owned camera transfer. */
function selectAndFocusVessel(record) {
  if (!record?.mmsi) return false;
  const transition = reduceVesselSelection({
    selectedMmsi: state.selectedRecord?.mmsi,
    pickedMmsi: record.mmsi,
    gesture: 'click',
  });
  if (transition.action === 'select') selectVessel(record);
  requestWorldFocus({
    kind: 'vessel',
    id: record.mmsi,
    label: record.name || record.mmsi,
    position: record.billboard?.position || record.position,
  });
  return true;
}

function removeVesselInteraction() {
  if (state.clickHandler) {
    state.clickHandler.destroy();
    state.clickHandler = null;
  }
  if (state.keyTarget && state.keydownHandler) {
    state.keyTarget.removeEventListener('keydown', state.keydownHandler);
  }
  state.keyTarget = null;
  state.keydownHandler = null;
  if (state.trackedEntityRemover) {
    state.trackedEntityRemover();
    state.trackedEntityRemover = null;
  }
}

function onVesselKeyDown(event) {
  if (!state.enabled || event.key !== 'Escape') return;
  const transition = reduceVesselSelection({
    selectedMmsi: state.selectedRecord?.mmsi,
    gesture: 'escape',
  });
  if (transition.action === 'deselect') {
    clearVesselInspection();
  }
}

function selectVessel(record) {
  if (!record?.mmsi) return;
  const reuseTrail = state.trailMmsi === record.mmsi;
  clearSelection({ preserveTrail: reuseTrail });
  state.selectedRecord = record;
  record.missedRefreshes = 0;
  if (record.billboard) {
    record.billboard.image = shipIcon(record, true);
    record.billboard.scale = shipScale(record) * 1.2;
  }
  // Rebuild the card set immediately so the full-detail card appears on the
  // click, not up to VISIBILITY_UPDATE_MS later.
  updateVisibility(true);
  updateSelectedVesselHud(record);
  if (registerSelectedContext(record)) {
    selectEntityContext(record);
  }
  // Track-history trail (PRD F3/F4): seed with the current position + async
  // backfill from the server-side per-MMSI ring buffer.
  if (reuseTrail) {
    appendSelectedVesselTrailFix(record);
  } else {
    startSelectedVesselTrail(record);
  }
}

/**
 * Build a slightly lifted trail vertex for a vessel record — raised
 * TRAIL_HEIGHT_M above the sea surface (geoid, same datum as the anchor)
 * to avoid z-fighting.
 * @param {Object} record - Vessel record with lat/lon.
 * @returns {Cesium.Cartesian3|null} Lifted position, or null without a fix.
 */
function vesselTrailPosition(record) {
  if (!Number.isFinite(record?.lat) || !Number.isFinite(record?.lon)) return null;
  const heightM = vesselDatumHeightM(currentGeoidN(record.lat, record.lon), TRAIL_HEIGHT_M);
  return Cesium.Cartesian3.fromDegrees(record.lon, record.lat, heightM);
}

/**
 * One-shot datum re-lift when the geoid grid warms mid-session: the first
 * refresh can land before ensureGeoidReady() resolves (anchors at N = 0) and
 * the next refresh is up to REFRESH_MS out — re-derive every record's
 * position in place so chevrons/labels snap to the sea surface as soon as N
 * is known. (A selected-vessel trail cannot exist that early — selection
 * needs a rendered pick — so trail vertices are not revisited.)
 */
function refloorVesselRecords() {
  if (!state.vesselRecords.length) return;
  for (const record of state.vesselRecords) {
    if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon)) continue;
    const heightM = vesselDatumHeightM(currentGeoidN(record.lat, record.lon), VESSEL_LIFT_M);
    record.position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat, heightM);
    if (record.billboard) record.billboard.position = record.position;
  }
}

/**
 * Start (or restart) the selected vessel's trail: seed with the current
 * position, render, then fire-and-forget the server ring-buffer backfill.
 * @param {Object} record - Freshly selected vessel record.
 */
function startSelectedVesselTrail(record) {
  state.trailBackfillToken += 1;
  state.trailMmsi = record.mmsi;
  state.trailPositions = [];
  const current = vesselTrailPosition(record);
  if (current) state.trailPositions.push(current);
  if (!state.trail && state.viewer) {
    state.trail = createTrail(state.viewer, { color: TRAIL_COLOR, width: 2.5 });
  }
  if (state.trail) state.trail.setPositions(state.trailPositions);
  backfillVesselTrail(record.mmsi, state.trailBackfillToken);
}

/**
 * Fire-and-forget backfill from the server-side per-MMSI ring buffer
 * (PRD F3 — "recent path" since server boot, not voyage history). Older
 * samples are spliced AHEAD of the live accumulation, capped at
 * TRAIL_MAX_POINTS (newest kept). Any failure (404/timeout/malformed)
 * silently keeps the live-only trail.
 * @param {string} mmsi - MMSI of the selected vessel.
 * @param {number} token - Backfill token captured at request time.
 * @returns {Promise<void>}
 */
async function backfillVesselTrail(mmsi, token) {
  let samples = null;
  try {
    const response = await fetch('/api/gev/ais-live/track?mmsi=' + encodeURIComponent(mmsi), {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return;
    const payload = await response.json();
    samples = Array.isArray(payload?.samples) ? payload.samples : null;
  } catch {
    return; // silent — keep the live-accumulated trail
  }
  if (!samples || token !== state.trailBackfillToken) return;
  if (state.trailMmsi !== mmsi) return;

  const older = [];
  for (const sample of samples) {
    const lat = Number(sample?.lat);
    const lon = Number(sample?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // Per-sample N (≤ TRAIL_MAX_POINTS lookups) — same sea-surface datum as
    // the live vertices so the spliced trail is height-continuous.
    const heightM = vesselDatumHeightM(currentGeoidN(lat, lon), TRAIL_HEIGHT_M);
    older.push(Cesium.Cartesian3.fromDegrees(lon, lat, heightM));
  }
  if (!older.length) return;

  state.trailPositions = older.concat(state.trailPositions);
  if (state.trailPositions.length > TRAIL_MAX_POINTS) {
    state.trailPositions = state.trailPositions.slice(state.trailPositions.length - TRAIL_MAX_POINTS);
  }
  if (state.trail) state.trail.setPositions(state.trailPositions);
}

/**
 * Append the selected vessel's refreshed position to its trail when it has
 * moved more than TRAIL_MIN_MOVE_M from the last trail vertex.
 * @param {Object} record - Selected vessel record after an in-place update.
 */
function appendSelectedVesselTrailFix(record) {
  if (!state.trail) return;
  const next = vesselTrailPosition(record);
  if (!next) return;
  const last = state.trailPositions[state.trailPositions.length - 1];
  if (last && Cesium.Cartesian3.distance(last, next) <= TRAIL_MIN_MOVE_M) return;
  state.trailPositions.push(next);
  if (state.trailPositions.length > TRAIL_MAX_POINTS) state.trailPositions.shift();
  state.trail.setPositions(state.trailPositions);
}

/**
 * Clear the rendered trail and accumulation; invalidate pending backfills.
 */
function clearSelectedVesselTrail() {
  state.trailBackfillToken += 1;
  state.trailMmsi = null;
  state.trailPositions = [];
  if (state.trail) state.trail.clear();
}

/**
 * Destroy the trail primitive entirely (layer disable/teardown).
 */
function destroySelectedVesselTrail() {
  clearSelectedVesselTrail();
  if (state.trail) {
    state.trail.destroy();
    state.trail = null;
  }
}

/**
 * Register (or refresh) the selected vessel in the shared context store so
 * the realtime/voice layer can describe what the user has selected.
 * @param {Object} record - Selected vessel record.
 * @returns {Object|null} The context record, or null if registration failed.
 */
function registerSelectedContext(record) {
  if (!record?.mmsi) return null;
  try {
    return registerEntityContext(record, {
      id: `ais-${record.mmsi}`,
      layerId: 'ais-live-vessels',
      layerName: 'Live AIS Vessels',
      source: 'AISStream',
      label: displayVesselName(record),
      latitude: record.lat,
      longitude: record.lon,
      properties: {
        mmsi: record.mmsi,
        type: record.type,
        speedKt: record.speed,
        course: record.course,
        destination: record.destination,
      },
    });
  } catch (error) {
    console.warn('[Data:ais-live-vessels] context register failed', error);
    return null;
  }
}

function clearSelection({ preserveTrail = false, evicted = false } = {}) {
  const record = state.selectedRecord;
  if (record?.billboard) {
    record.billboard.image = shipIcon(record, false);
    record.billboard.scale = shipScale(record);
  }
  state.selectedRecord = null;
  // Drop the full-detail card right away (no-op when the layer is disabled —
  // disable() clears the entry set itself).
  if (record && state.enabled) updateVisibility(true);
  if (!preserveTrail) clearSelectedVesselTrail();
  try {
    clearSelectedEntityContextForLayer('ais-live-vessels', { evicted });
  } catch (error) {
    console.warn('[Data:ais-live-vessels] context clear failed', error);
  }
}

/**
 * @param {object} [options] Clear origin.
 * @param {boolean} [options.evicted=false] The vessel aged out of the feed
 *   rather than being deselected.
 */
function clearVesselInspection({ evicted = false } = {}) {
  clearSelection({ evicted });
  resetSelectedVesselHud();
}

function updateSelectedVesselHud(record) {
  const el = document.getElementById('hud-ais-vessel');
  if (!el) return;

  // Pinned vessels missing from recent refreshes get a stale marker
  const stale = (record.missedRefreshes || 0) > 0;
  el.classList.add('active');
  el.textContent = [
    `AIS: ${trimHudValue(record.name, 32)}`,
    `${trimHudValue(record.type || 'VESSEL', 24)}  SPD: ${formatSpeed(record.speed)}  HDG: ${formatHeading(record.heading ?? record.course)}`,
    `MMSI: ${record.mmsi || '--'}  ${formatPositionTime(record)}${stale ? '  · STALE' : ''}`,
  ].join('\n');
}

function resetSelectedVesselHud() {
  const el = document.getElementById('hud-ais-vessel');
  if (!el) return;
  el.classList.remove('active');
  el.textContent = 'AIS: --';
}

function trimHudValue(value, maxLength) {
  const text = String(value || '--').trim() || '--';
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

/**
 * Card model for an ambient (decluttered-in) vessel — name title plus one
 * compact type/speed/heading detail line, anchored at the record's current
 * rendered position (height-datum caveat: no datum work here). Pure —
 * exported for unit tests.
 * @param {Object} record - Vessel record.
 * @returns {Object} vesselLabels entry.
 */
export function buildVesselCard(record) {
  const parts = [];
  const type = vesselTypeShort(record);
  if (type) parts.push(type);
  if (record.speed !== null && record.speed !== undefined) parts.push(formatSpeed(record.speed));
  const direction = record.heading ?? record.course;
  if (Number.isFinite(direction)) parts.push(`${Math.round(direction)}°`);
  return {
    id: vesselOverlayEntryId(record),
    actionable: Boolean(record?.mmsi),
    position: record.billboard?.position || record.position,
    gapPx: 10,
    accent: accentForVesselType(record.type),
    title: trimHudValue(displayVesselName(record), 26),
    details: parts.length ? [parts.join(' · ')] : [],
    selected: false,
    priority: labelPriority(record, null),
  };
}

/**
 * Card model for the click-selected vessel — the full-detail card, drawn last
 * (on top) and never distance-faded by the overlay. Pinned-but-vanished
 * vessels carry a STALE marker (mirrors the HUD readout). Pure — exported
 * for unit tests.
 * @param {Object} record - Selected vessel record.
 * @returns {Object} vesselLabels entry.
 */
export function buildSelectedVesselCard(record) {
  const direction = record.heading ?? record.course;
  const details = [[
    vesselTypeShort(record) || 'VESSEL',
    formatSpeed(record.speed),
    Number.isFinite(direction) ? `${Math.round(direction)}°` : '--°',
  ].join(' · ')];
  const destination = String(record.destination || '').trim();
  if (destination) details.push(`→ ${trimHudValue(destination, 24)}`);
  const stale = (record.missedRefreshes || 0) > 0;
  details.push(`MMSI ${record.mmsi || '--'} · ${formatPositionTime(record)}${stale ? ' · STALE' : ''}`);
  return {
    id: vesselOverlayEntryId(record),
    actionable: Boolean(record?.mmsi),
    position: record.billboard?.position || record.position,
    gapPx: 12,
    accent: accentForVesselType(record.type),
    title: trimHudValue(displayVesselName(record), 32),
    details,
    selected: true,
    priority: 100000,
  };
}

/** Stable overlay identity for MMSI-keyed and source-retained unkeyed rows. */
function vesselOverlayEntryId(record) {
  const mmsi = String(record?.mmsi || '').trim();
  if (mmsi) return `vessel:${mmsi}`;
  const name = String(record?.name || 'VESSEL').trim() || 'VESSEL';
  const lat = Number.isFinite(record?.lat) ? record.lat.toFixed(5) : 'x';
  const lon = Number.isFinite(record?.lon) ? record.lon.toFixed(5) : 'x';
  return `vessel:unkeyed:${name}:${lat}:${lon}`;
}

/** Uppercased, card-width-bounded AIS type (empty string when unknown). */
function vesselTypeShort(record) {
  return normalizeVesselType(record.type).toUpperCase().slice(0, 14);
}

/**
 * True when `screen` is at least `minSepPx` away from every accepted screen
 * position (greedy card-declutter accept test, mirroring the FIRMS pass).
 * Exported for unit tests.
 * @param {Array<{x: number, y: number}>} accepted - Accepted card positions.
 * @param {{x: number, y: number}} screen - Candidate window coordinates.
 * @param {number} minSepPx - Minimum separation in pixels.
 * @returns {boolean}
 */
export function cardScreenSeparated(accepted, screen, minSepPx) {
  const minSq = minSepPx * minSepPx;
  for (let i = 0; i < accepted.length; i += 1) {
    const dx = screen.x - accepted[i].x;
    const dy = screen.y - accepted[i].y;
    if (dx * dx + dy * dy < minSq) return false;
  }
  return true;
}

function displayVesselName(record) {
  const name = String(record.name || '').trim();
  if (name && name !== 'VESSEL' && name !== record.mmsi) return name;
  return record.mmsi ? `MMSI ${record.mmsi}` : 'VESSEL';
}

function formatSpeed(speed) {
  return speed === null ? '--KT' : `${speed.toFixed(1)}KT`;
}

function formatHeading(heading) {
  return Number.isFinite(heading) ? `${Math.round(heading)}DEG` : '--DEG';
}

function formatPositionTime(record) {
  if (!record.lastPositionUtc) return 'POS: LIVE';
  const date = new Date(record.lastPositionUtc);
  if (Number.isNaN(date.getTime())) return 'POS: LIVE';
  return `POS: ${date.toISOString().slice(11, 19)}Z`;
}

function setVisible(show) {
  if (state.billboardCollection) {
    state.billboardCollection.show = show;
  }
  _vesselOverlayHost.setVisible(VESSEL_OVERLAY_SOURCE_ID, show);
}

function resetState() {
  clearFirstConnectTimer();
  state.viewer = null;
  state.enabled = false;
  state.loading = false;
  state.loaded = false;
  state.stale = false;
  state.error = null;
  state.loadingLabel = '';
  state.lastUpdate = null;
  state.count = 0;
  state.newestPositionAt = null;
  state.transportStatus = null;
  state.nextAttemptAt = null;
  state.lastMessageAt = null;
  state.rawRowCount = 0;
  state.acceptedRowCount = 0;
  state.sessionId = ++_aisSessionSequence;
  state.firstConnectPhase = 'idle';
  state.firstConnectStartedAt = null;
  state.firstConnectDeadline = null;
  state.firstConnectTimer = null;
  state.abort = null;
  state.billboardCollection = null;
  state.vesselRecords = [];
  state.vesselMap = new Map();
  state.unkeyedRecords = [];
  state.clickHandler = null;
  state.keyTarget = null;
  state.keydownHandler = null;
  state.trackedEntityRemover = null;
  state.interactionHandlerFactory = null;
  state.interactionKeyTarget = null;
  state.preRenderRemover = null;
  state.lastVisibilityUpdate = 0;
  state.lastFocusUpdate = 0;
  state.activeFocusCount = 0;
  state.activeLabelCount = 0;
  state.selectedRecord = null;
  state.trail = null;
  state.trailPositions = [];
  state.trailMmsi = null;
  state.trailBackfillToken = 0;
}

/**
 * Bind the production interaction callbacks to mockable viewer/handler
 * surfaces. Test-only seam; behavior is shared with installInteraction().
 * @param {Object} viewer - Viewer-like object with scene.pick().
 * @param {Object} handler - Handler-like object with setInputAction().
 * @param {Object} keyTarget - EventTarget-like object with add/removeEventListener().
 * @returns {void}
 */
export function _bindVesselInteractionForTest(viewer, handler, keyTarget) {
  bindVesselInteraction(viewer, handler, keyTarget);
}

/**
 * Prime the minimum live state needed by interaction/lifecycle wire tests.
 * @param {Object} [options={}] - Test state values.
 * @returns {void}
 */
export function _setVesselStateForTest(options = {}) {
  resetState();
  const records = Array.isArray(options.records) ? options.records : [];
  state.viewer = options.viewer || null;
  state.enabled = options.enabled !== false;
  state.loaded = options.loaded === true;
  state.loading = options.loading === true;
  state.stale = options.stale === true;
  state.error = options.error || null;
  state.lastUpdate = options.lastUpdate ?? null;
  state.vesselRecords = records;
  state.count = records.length;
  state.vesselMap = new Map(
    records.filter((record) => record?.mmsi).map((record) => [record.mmsi, record])
  );
  state.selectedRecord = options.selectedRecord || null;
  state.billboardCollection = options.billboardCollection || { remove() {} };
  state.trail = options.trail || null;
  state.trailMmsi = options.trailMmsi || null;
  state.trailPositions = Array.isArray(options.trailPositions) ? [...options.trailPositions] : [];
  state.transportStatus = options.transportStatus || null;
  state.lastMessageAt = options.lastMessageAt ?? null;
  state.rawRowCount = Number.isFinite(options.rawRowCount) ? options.rawRowCount : 0;
  state.acceptedRowCount = Number.isFinite(options.acceptedRowCount) ? options.acceptedRowCount : records.length;
  state.firstConnectPhase = options.firstConnectPhase || 'idle';
  state.firstConnectStartedAt = options.firstConnectStartedAt ?? null;
  state.firstConnectDeadline = options.firstConnectDeadline ?? null;
  state.interactionHandlerFactory = options.interactionHandlerFactory || null;
  state.interactionKeyTarget = options.interactionKeyTarget || null;
}

/** Inject a host recorder for lifecycle/contract tests; null restores production. */
export function _setVesselOverlayHostForTest(host = null) {
  _vesselOverlayHost = host || DEFAULT_VESSEL_OVERLAY_HOST;
}

/** Exercise the production selector/publisher through a test-owned state. */
export function _updateVesselCardsForTest(records = []) {
  updateClusteredLabels(records);
}

/**
 * Reconcile AIS rows through the production lifecycle. Test-only seam.
 * @param {Object} viewer - Viewer-like object.
 * @param {Array<Object>} rows - Raw AIS rows.
 * @returns {void}
 */
export function _reconcileVesselsForTest(viewer, rows) {
  reconcileVessels(viewer, rows);
}

/** Apply one server snapshot through the production pre-reconcile health gate. */
export function _applyAisFeedSnapshotForTest(viewer, payload) {
  return applyAisFeedSnapshot(viewer, payload);
}

/** Exercise the request-owned live loader with a test-controlled fetch. */
export function _loadLivePositionsForTest(viewer) {
  return loadLivePositions(viewer);
}

/** Start the production first-connect grace state without installing UI. */
export function _beginAisSessionForTest() {
  beginAisSession();
}

/** Inject a deterministic clock/scheduler; null restores production runtime. */
export function _setAisRuntimeForTest(runtime = null) {
  clearFirstConnectTimer();
  _aisRuntime = runtime
    ? {
      now: runtime.now,
      setTimeout: runtime.setTimeout,
      clearTimeout: runtime.clearTimeout,
    }
    : DEFAULT_AIS_RUNTIME;
}

/** Read feed-health fields without exposing mutable production state. */
export function _getVesselFeedStateForTest() {
  const stats = aisLiveVesselsLayer.getStats();
  return {
    count: state.count,
    loaded: state.loaded,
    loading: stats.loading,
    loadingLabel: stats.loadingLabel,
    stale: state.stale,
    error: state.error,
    status: stats.status,
    lastUpdate: state.lastUpdate,
    transportStatus: state.transportStatus,
    lastMessageAt: state.lastMessageAt,
    rawRowCount: state.rawRowCount,
    acceptedRowCount: state.acceptedRowCount,
    selectedMmsi: state.selectedRecord?.mmsi || null,
    trailMmsi: state.trailMmsi,
    trailPositionCount: state.trailPositions.length,
    sessionId: state.sessionId,
    firstConnectPhase: state.firstConnectPhase,
    firstConnectStartedAt: state.firstConnectStartedAt,
    firstConnectDeadline: state.firstConnectDeadline,
  };
}

/**
 * Read lifecycle ownership state without exposing the mutable state object.
 * Test-only seam.
 * @returns {{trailMmsi: string|null, trailPositionCount: number, vesselCount: number}}
 */
export function _getVesselStateForTest() {
  return {
    trailMmsi: state.trailMmsi,
    trailPositionCount: state.trailPositions.length,
    vesselCount: state.vesselMap.size,
  };
}
