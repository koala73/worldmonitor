import * as Cesium from 'cesium';
import flightsLayer from './flights.js';
import militaryFlightsLayer from './militaryFlights.js';
import aisLiveVesselsLayer from './aisLiveVessels.js';
import militaryInstallationsLayer from './militaryInstallations.js';
import {
  AWARENESS_MAX_FLIGHT_SEARCH_RADIUS_M,
  AWARENESS_RADIUS_M,
  AWARENESS_RELATIONSHIP,
  findByDoublingRadius,
  formatAwarenessDistance,
  formatAwarenessLabel,
  getAwarenessNavigationTargets,
  summarizeAwarenessCohort,
} from './militaryAwarenessEngine.js';
import { announceNavigationAuthority } from '../navigationPolicy.js';
import { celestialScreenAngle, getKeyholeGeometry } from '../celestialRing.js';
import { bearingBetweenCoordinates } from '../cockpitMath.js';
import { cameraPoseSignature } from './iconOrientation.js';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

const AIRCRAFT_DEPENDENCIES = ['flights', 'military'];
const DEFERRED_DEPENDENCIES = ['ais-live-vessels', 'military-installations'];
const DEPENDENCIES = [...AIRCRAFT_DEPENDENCIES, ...DEFERRED_DEPENDENCIES];
const AWARENESS_REFRESH_MS = 750;
/** @constant {number} Refresh cadence while the camera pose is CHANGING.
 *  Field test 2026-08-18: the Contacts direction arrows and card readouts
 *  "feel sluggish when you look around" — at the parked 750 ms cadence the
 *  arrows lag the view by up to three quarters of a second. */
const AWARENESS_MOTION_REFRESH_MS = 175;
/** @constant {number} How long the pose signature must stay UNCHANGED before
 *  the view counts as parked again. The signature is quantized, so a slow drag
 *  crosses a bin only every few frames; without this hysteresis every crossing
 *  read as a motion-end and refreshed at nearly display rate. */
const AWARENESS_MOTION_SETTLE_MS = 250;
const AWARENESS_REEVALUATE_DISTANCE_M = 250;
const AWARENESS_PAGE_ROTATE_MS = 10000;
const AWARENESS_PAGE_SIZE = 3;
const AWARENESS_MAX_EXAMPLES = 10;
// Navigation walks the whole 250 km cohort, not the ten rows the panel shows,
// so these caps sit far above any realistic in-range population rather than at
// the display limit. They are still FINITE: an unbounded materialization would
// let a pathological feed sort an eleven-thousand-contact array on every
// refresh. Truthfulness does not depend on them — `summarizeAwarenessCohort`
// derives `count` from the full in-range set before any slice.
export const AWARENESS_QUERY_LIMIT = 20000;
const AWARENESS_MAX_NAVIGATION_EXAMPLES = 10000;
const CONTEXT_RIM_HEIGHT_M = 2500;
const VESSEL_FOCUS_RADIUS_M = 3000;
const DIRECTION_SCRATCH = Array.from({ length: 3 }, () => new Cesium.Cartesian3());
const SUBJECT_CARTOGRAPHIC_SCRATCH = new Cesium.Cartographic();
const TARGET_CARTOGRAPHIC_SCRATCH = Array.from({ length: 3 }, () => new Cesium.Cartographic());
const SOURCE_LABEL = {
  flights: 'OpenSky',
  military: 'adsb.lol',
  'ais-live-vessels': 'AISStream',
  'military-installations': 'OpenStreetMap',
};

/**
 * Whether focusing a Context target may take ownership of the camera.
 * Cockpit owns the camera at 20 Hz, so non-aircraft targets remain selectable
 * there but must not start a competing flyTo animation.
 *
 * @param {string} layerId Context target layer id.
 * @param {HTMLElement|null} [body=document.body] Document body to inspect.
 * @returns {boolean} Whether the target may start a camera flight.
 */
export function contextTargetFlyToAllowed(layerId, body = globalThis.document?.body) {
  const nonAircraft = layerId === 'ais-live-vessels' || layerId === 'military-installations';
  return !nonAircraft || !body?.classList?.contains('cockpit-mode');
}

/**
 * Decide whether a source-scoped context clear belongs to the current subject.
 * @param {{layerId?: string}|null} subject Current awareness subject.
 * @param {{layerId?: string}|null} cleared Cleared source detail.
 * @returns {boolean} Whether the current subject should be cleared.
 */
export function awarenessClearMatchesSubject(subject, cleared) {
  return Boolean(subject?.layerId && cleared?.layerId === subject.layerId);
}

/**
 * Refresh cadence for the Contacts direction arrows and card readouts.
 *
 * A MOVING camera earns the snappy cadence; a parked one keeps the cheap 750 ms
 * one. This is safe for requestRenderMode because the cadence is applied inside
 * `scene.preRender`: a faster interval can only ever consume frames the camera
 * movement is ALREADY forcing. A parked scene renders no frames at all, so no
 * extra refresh happens and no timer is introduced — the render governor and
 * the idle-leak fix both depend on parked staying quiet.
 * @param {boolean} cameraMoving Whether the camera pose changed since the last frame.
 * @returns {number} Minimum ms between refreshes.
 */
export function awarenessRefreshIntervalMs(cameraMoving) {
  return cameraMoving ? AWARENESS_MOTION_REFRESH_MS : AWARENESS_REFRESH_MS;
}

/**
 * Decide, for one rendered frame, whether the view counts as MOVING and whether
 * the Contacts readout may refresh.
 *
 * Motion is HYSTERETIC. The pose signature is quantized (~10 m / ~0.06°), so a
 * slow drag crosses a bin only every few frames: treating a single unchanged
 * frame as "parked" made every crossing look like a motion-end and refreshed at
 * nearly display rate. Motion therefore ends only after the pose has been
 * unchanged for AWARENESS_MOTION_SETTLE_MS, and the motion cadence is a HARD
 * floor in every state — no bin-crossing pattern, and no motion-end settle, can
 * refresh faster than AWARENESS_MOTION_REFRESH_MS.
 *
 * @param {object} input
 * @param {number} input.nowMs This frame's clock.
 * @param {number} input.lastRefreshMs When the readout last refreshed.
 * @param {number} input.lastPoseChangeMs When the camera pose last changed bins.
 * @param {boolean} input.wasMoving Whether the previous frame counted as moving.
 * @returns {{moving: boolean, refresh: boolean}}
 */
export function awarenessRefreshDecision({ nowMs, lastRefreshMs, lastPoseChangeMs, wasMoving }) {
  const moving = nowMs - lastPoseChangeMs < AWARENESS_MOTION_SETTLE_MS;
  // The single frame where hysteresis expires: settle the readout at rest
  // instead of leaving it up to a parked interval stale.
  const settling = Boolean(wasMoving) && !moving;
  const sinceRefresh = nowMs - lastRefreshMs;
  const refresh = sinceRefresh >= awarenessRefreshIntervalMs(true)
    && (moving || settling || sinceRefresh >= awarenessRefreshIntervalMs(false));
  return { moving, refresh };
}

/**
 * Decide whether a source-scoped clear was an eviction rather than a deselect.
 *
 * Both arrive on the same events: the owning layer calls the same teardown for
 * "the user clicked away" and "this contact aged out of the feed". Only the
 * origin separates them, and it matters — a deliberate clear takes the Contact
 * panel down, while an eviction must keep it up in its CONTACT LOST state, or
 * the panel disappears out from under its own PREVIOUS/NEXT controls.
 * @param {{reason?: string}|null} cleared Cleared source detail.
 * @returns {boolean} Whether the subject left the feed on its own.
 */
export function awarenessClearIsEviction(cleared) {
  return cleared?.reason === 'evicted';
}

/**
 * Decide whether proximity cohorts need an expensive rescan.
 * @param {object} input Refresh evidence.
 * @param {boolean} input.force Explicit invalidation.
 * @param {boolean} input.hasResults Whether a prior evaluation exists.
 * @param {number} input.movementM Subject displacement since evaluation.
 * @param {boolean} input.sourceRevisionChanged Whether any source state changed.
 * @returns {boolean} Whether cohorts should be evaluated again.
 */
export function awarenessRefreshRequired({ force, hasResults, movementM, sourceRevisionChanged }) {
  return Boolean(
    force
    || !hasResults
    || sourceRevisionChanged
    || !Number.isFinite(movementM)
    || movementM >= AWARENESS_REEVALUATE_DISTANCE_M,
  );
}

/**
 * Whether a refresh tick could confirm the subject in its source collection.
 * UNCHECKED means the tick did not look — it must never change the verdict.
 */
const SUBJECT_PRESENCE = Object.freeze({
  LIVE: 'live',
  MISSING: 'missing',
  UNCHECKED: 'unchecked',
});

const state = {
  viewer: null,
  dataManager: null,
  enabled: false,
  // Set once a refresh observes the subject gone from a still-reporting source.
  // The Contact readout turns this into its CONTACT LOST hold state.
  subjectMissing: false,
  // The dedicated Context chooser exposes a passive shell. Operational source
  // layers activate only after Contacts is explicitly selected.
  passive: true,
  ownedDependencies: new Set(),
  subject: null,
  results: null,
  visual: null,
  panel: null,
  panelOwned: false,
  subjectListener: null,
  contextListener: null,
  clearListener: null,
  subjectClearListener: null,
  runtimeListenersAttached: false,
  preRenderRemover: null,
  panelClickListener: null,
  directionRoot: null,
  compassRing: null,
  compassLabels: [],
  compassHeading: null,
  directionMarkers: [],
  navigationHistory: [],
  navigationVisited: new Set(),
  navigationIndex: -1,
  suppressedHistoryKey: null,
  pendingSelectionKey: null,
  lastSubjectRefreshMs: 0,
  /** Camera-pose signature observed on the previous rendered frame. */
  lastCameraPoseSig: '',
  /** When the pose signature last changed bins (hysteresis anchor). */
  lastCameraPoseChangeMs: 0,
  /** Whether the view currently counts as moving (hysteretic, not per-frame). */
  cameraMoving: false,
  lastEvaluatedPosition: null,
  sourceRevision: '',
  panelMarkup: '',
  directionFrame: null,
  lastDirectionUpdateMs: 0,
  activationId: 0,
  autoFocusAttempted: false,
  autoFocusRetryPending: false,
  pageTimer: null,
  cohortPages: new Map(),
};

function ensurePanel() {
  if (state.panel) return state.panel;
  const existing = document.getElementById('military-awareness-panel');
  const panel = existing || document.createElement('aside');
  state.panelOwned = !existing;
  if (!existing) {
    panel.id = 'military-awareness-panel';
  }
  state.panelClickListener = (event) => {
    const action = event.target.closest('button[data-awareness-action]');
    if (action) {
      event.preventDefault();
      if (action.dataset.awarenessAction === 'previous') navigateHistory(-1, { origin: 'user' });
      if (action.dataset.awarenessAction === 'next') navigateHistory(1, { origin: 'user' });
      if (action.dataset.awarenessAction === 'focus') focusCurrentSubject({ origin: 'user' });
      return;
    }
    const target = event.target.closest('button[data-awareness-layer][data-awareness-id]');
    if (!target) return;
    event.preventDefault();
    requestFocus(target.dataset.awarenessLayer, target.dataset.awarenessId, false, { origin: 'user' });
  };
  panel.addEventListener('click', state.panelClickListener);
  if (!existing) document.body.appendChild(panel);
  state.panel = panel;
  return panel;
}

function hidePanel() {
  if (state.panel) {
    const markup = `<div class="military-awareness-standby">
      <strong>${state.enabled ? 'CONTEXT READY' : 'GLOBAL CONTEXT OFF'}</strong>
      <span>${state.enabled ? 'SELECT A FLIGHT, VESSEL, OR MAPPED INSTALLATION' : 'ENABLE TO LOAD OBSERVED / MAPPED PROXIMITY'}</span>
    </div>`;
    state.panel.hidden = false;
    if (state.panelMarkup !== markup) {
      state.panel.innerHTML = markup;
      state.panelMarkup = markup;
    }
  }
  if (state.directionRoot) state.directionRoot.hidden = true;
}

function sourceState(layerId) {
  const lifecycle = state.dataManager?.getLayerLifecycleState?.(layerId) || null;
  const enabled = lifecycle?.enabled === true || state.dataManager?.isEnabled(layerId) === true;
  const enabling = lifecycle?.lifecycleState === 'enabling';
  const moduleStats = state.dataManager?.layers?.get(layerId)?.module?.getStats?.() || {};
  const stats = enabling
    ? { ...moduleStats, loading: true, status: 'loading' }
    : moduleStats;
  // A deferred source that has started but not settled is not evidence of an
  // empty cohort. Keep it explicitly unavailable so the panel cannot flash a
  // false all-clear, even if a lifecycle adapter briefly reports the requested
  // visibility intent as enabled.
  //
  // `enabling` and the never-answered predicate cover two DIFFERENT windows, and
  // both are needed because these dependencies do not settle the same way.
  //
  //   - military-installations is covered by `enabling` alone. Its enable() is
  //     SYNCHRONOUS and the manager awaits update(), which owns the first
  //     Overpass fetch, so the lifecycle stays `enabling` for that whole window
  //     however long the fetch takes. Confirmed live: a held 17 s first fetch
  //     read `enabling` across 34 samples with the panel non-numeric throughout,
  //     and a failing one settled to `enabled` with status 'unavailable'. Its
  //     getStats() has no `loading` status to offer in any case —
  //     setInstallationStatus is only ever called with
  //     zoom-in/ready/stale/empty/unavailable.
  //   - ais-live-vessels is what the predicate below is FOR. Its enable() and
  //     update() both resolve as soon as the first /api/ais-live poll answers,
  //     so the lifecycle settles to `enabled` — but until the server-side socket
  //     delivers a position, firstConnectPhase is 'loading' and getStats()
  //     reports loading: true, lastUpdate: null, count 0, and an UNDEFINED
  //     status. That zero is an absence of evidence, not evidence of absence,
  //     and neither the lifecycle nor the status list can tell.
  //
  // Deliberately `loading === true` and not truthiness: layers that never report
  // a busy flag (flights, military) must keep answering for themselves, and a
  // source that HAS answered once (lastUpdate set) keeps its last real count
  // through every later poll rather than blanking to `?` on each refresh.
  const neverAnswered = stats.loading === true && !stats.lastUpdate;
  const unavailable = enabling
    || !enabled
    || neverAnswered
    || ['unavailable', 'zoom-in'].includes(stats.status)
    || Boolean(stats.error && stats.count === 0);
  return { available: !unavailable, stale: Boolean(stats.stale), stats };
}

function collectSourceStates() {
  return Object.fromEntries(DEPENDENCIES.map((layerId) => [layerId, sourceState(layerId)]));
}

function sourceRevision(sourceStates) {
  return DEPENDENCIES.map((layerId) => {
    const source = sourceStates[layerId];
    const stats = source?.stats || {};
    return [
      layerId,
      source?.available,
      source?.stale,
      stats.lastUpdate || null,
      stats.count ?? null,
      stats.status || null,
      stats.error || null,
    ];
  }).map((parts) => parts.join(':')).join('|');
}

function isSame(subject, item, prefix, key) {
  return subject?.layerId === prefix && String(subject.id) === String(item?.[key]);
}

/**
 * Summarize viewport-backed installations without implying radius-complete coverage.
 * @param {Array<object>} items Loaded installation matches.
 * @param {object} source Current source availability and staleness.
 * @returns {object} Awareness summary with viewport-honest reasoning.
 */
export function summarizeInstallationViewport(items, source) {
  const summary = summarizeAwarenessCohortForNavigation(items, source);
  if (summary.count === null) return summary;
  return {
    ...summary,
    reason: summary.count
      ? 'mapped matches from the loaded viewport'
      : 'viewport feed is not a complete 250 km survey',
  };
}

function summarizeAwarenessCohortForNavigation(items, source, {
  displayLimit = AWARENESS_MAX_EXAMPLES,
  navigationLimit = AWARENESS_MAX_NAVIGATION_EXAMPLES,
} = {}) {
  const summary = summarizeAwarenessCohort(items, { ...source, limit: navigationLimit });
  if (summary.count === null) return summary;
  return {
    ...summary,
    nearest: summary.nearest.slice(0, displayLimit),
    navigationNearest: summary.nearest,
  };
}

/**
 * The per-layer counts the Contacts panel is showing, as one flat block.
 *
 * Three honest numbers were reaching the operator at once: this cohort count
 * (the panel), `analyst_query`'s count of CURRENTLY-LOADED records, and the
 * layer-wide loaded total in the coverage note. After the camera dives to a
 * tracked contact the flights layer reloads by viewport, so the loaded set can
 * hold a fraction of the cohort — 8 against the panel's 42 in the field. The
 * numbers are all correct and the disagreement still reads as chaos.
 *
 * Derived from the same snapshot the panel renders (`cohort.summary.count` via
 * `buildAwarenessContextSnapshot`), so the two cannot drift apart. A cohort
 * whose feed cannot answer reports 'unknown' rather than a misleading zero.
 * @param {object|null} snapshot `getContextSnapshot()` result.
 * @returns {{centeredOn: string|null, radiusKm: number|null, aircraft: number|string,
 *   flights: number|string, military: number|string, vessels: number|string}|null}
 *   Panel-equivalent counts.
 */
export function contactsWindowFromSnapshot(snapshot) {
  if (!snapshot?.subject) return null;
  const countFor = (cohortId) => {
    const cohort = Array.isArray(snapshot.cohorts)
      ? snapshot.cohorts.find((item) => item?.id === cohortId)
      : null;
    return Number.isFinite(cohort?.count) ? cohort.count : 'unknown';
  };
  const flights = countFor('flights');
  const military = countFor('military');
  return {
    centeredOn: snapshot.subject.label || snapshot.subject.id || null,
    radiusKm: Number.isFinite(snapshot.radiusM)
      ? Math.round(snapshot.radiusM / 1000)
      : null,
    aircraft: Number.isFinite(flights) && Number.isFinite(military)
      ? flights + military
      : 'unknown',
    flights,
    military,
    vessels: countFor('ais-live-vessels'),
  };
}

/** Build the read-only Awareness snapshot shared with compact HUD consumers. */
export function buildAwarenessContextSnapshot(results, navigation = {}, { subjectPresent = true } = {}) {
  if (!results) return null;
  return {
    subject: { ...results.subject },
    // Whether the subject is still reported by its source. The cockpit Contact
    // readout holds its last-known values behind a CONTACT LOST cue when this
    // is false, rather than presenting frozen geometry as a live reading.
    subjectPresent: subjectPresent !== false,
    evaluatedAt: results.evaluatedAt,
    radiusM: results.radiusM,
    cohorts: results.cohorts.map((cohort) => ({
      id: cohort.id,
      label: cohort.label,
      source: cohort.source,
      coverage: cohort.coverage || null,
      relationship: cohort.summary.relationship,
      count: cohort.summary.count,
      reason: cohort.summary.reason,
      nearest: cohort.summary.nearest.slice(),
    })),
    navigation: { ...navigation },
  };
}

/**
 * THE aircraft-proximity engine. One computation, two consumers: the Contacts
 * panel window and the voice analyst's entity-centred "how many nearby".
 *
 * They used to be separate. The panel read live billboard positions through
 * `getNearby` with a 20 000 cap; the analyst re-derived its own answer from
 * last-fix coordinates over a 2 000-record slice. Same question, same centre,
 * two numbers — and in the live trial the spoken answer (15) and the panel
 * (111) disagreed badly enough that the model narrated the difference away.
 * Routing both through here makes them the same number BY CONSTRUCTION, so
 * they cannot drift again.
 *
 * The subject is excluded from its own window, which is why the panel reads
 * "contacts around X" rather than "including X".
 * @param {Cesium.Cartesian3} position Window centre.
 * @param {object} [options]
 * @param {number} [options.radiusM=AWARENESS_RADIUS_M] Window radius.
 * @param {object|null} [options.subject=null] Contact at the centre, excluded.
 * @returns {{flights: Array, military: Array, aircraft: number}|null} Cohorts
 *   plus the combined aircraft count, or null without a position.
 */
export function collectAircraftProximityWindow(position, {
  radiusM = AWARENESS_RADIUS_M,
  subject = null,
} = {}) {
  if (!position) return null;
  const flights = flightsLayer
    .getNearby(position, radiusM, AWARENESS_QUERY_LIMIT, { includeHidden: true })
    .filter((item) => !subject || !isSame(subject, item, 'flights', 'icao24'));
  const military = militaryFlightsLayer
    .getNearby(position, radiusM, AWARENESS_QUERY_LIMIT, { includeHidden: true })
    .filter((item) => !subject || !isSame(subject, item, 'military', 'icao24'));
  return { flights, military, aircraft: flights.length + military.length };
}

function evaluateSubject(subject, sourceStates = collectSourceStates()) {
  const position = subject?.position;
  if (!position) return null;
  const flightsState = sourceStates.flights;
  const militaryState = sourceStates.military;
  const vesselsState = sourceStates['ais-live-vessels'];
  const installationsState = sourceStates['military-installations'];
  // Same engine the voice analyst calls — see collectAircraftProximityWindow.
  const { flights, military } = collectAircraftProximityWindow(position, { subject });
  const vessels = aisLiveVesselsLayer.getNearby(position, AWARENESS_RADIUS_M, AWARENESS_QUERY_LIMIT)
    .filter((item) => !isSame(subject, item, 'ais-live-vessels', 'mmsi'));
  const installations = militaryInstallationsLayer.getNearby(position, AWARENESS_RADIUS_M, AWARENESS_QUERY_LIMIT)
    .filter((item) => !isSame(subject, item, 'military-installations', 'id'));
  return {
    subject,
    evaluatedAt: Date.now(),
    radiusM: AWARENESS_RADIUS_M,
    cohorts: [
      { id: 'flights', label: 'Flights', source: flightsState.stats.source || SOURCE_LABEL.flights, summary: summarizeAwarenessCohortForNavigation(flights, flightsState) },
      { id: 'military', label: 'Military flights', source: militaryState.stats.source || SOURCE_LABEL.military, summary: summarizeAwarenessCohortForNavigation(military, militaryState) },
      { id: 'ais-live-vessels', label: 'AIS vessels', source: vesselsState.stats.source || SOURCE_LABEL['ais-live-vessels'], summary: summarizeAwarenessCohortForNavigation(vessels, vesselsState) },
      {
        id: 'military-installations',
        label: 'Mapped installations',
        source: installationsState.stats.source || SOURCE_LABEL['military-installations'],
        coverage: 'CURRENT VIEWPORT ONLY',
        summary: summarizeInstallationViewport(installations, installationsState),
      },
    ],
  };
}

function rowHtml(cohort) {
  const summary = cohort.summary;
  const count = summary.count === null ? '?' : String(summary.count);
  const page = state.cohortPages.get(cohort.id) || 0;
  const nearest = summary.nearest.slice(page, page + AWARENESS_PAGE_SIZE).map((item) => {
    const label = formatAwarenessLabel(item);
    const targetId = item.icao24 || item.mmsi || item.id;
    if (!targetId) {
      return `<li><span class="military-awareness-target unavailable" aria-label="Unavailable">${escapeHtml(label)} <span>${formatAwarenessDistance(item.distanceM)}</span></span></li>`;
    }
    const accessibleLabel = label === '—' ? 'Unavailable' : label;
    return `<li><button type="button" class="military-awareness-target" data-awareness-layer="${escapeHtml(cohort.id)}" data-awareness-id="${escapeHtml(targetId)}" aria-label="Focus ${escapeHtml(accessibleLabel)}">${escapeHtml(label)} <span>${formatAwarenessDistance(item.distanceM)}</span></button></li>`;
  }).join('');
  const pageCount = Math.max(1, Math.ceil(summary.nearest.length / AWARENESS_PAGE_SIZE));
  const pageLabel = pageCount > 1 ? ` · ${Math.floor(page / AWARENESS_PAGE_SIZE) + 1}/${pageCount}` : '';
  const coverage = cohort.coverage ? ` · ${escapeHtml(cohort.coverage)}` : '';
  return `<section class="military-awareness-row ${summary.relationship.toLowerCase()}">
    <div><strong>${escapeHtml(cohort.label)}</strong><b aria-live="polite">${count}${pageLabel}</b></div>
    <small>${escapeHtml(cohort.source)}${coverage} · ${escapeHtml(summary.reason)}</small>
    ${nearest ? `<ul>${nearest}</ul>` : ''}
  </section>`;
}

/** Focus a nearby example through the source layer that owns its selection. */
function focusNearbyTarget(layerId, id, { origin = 'programmatic' } = {}) {
  if (!layerId || !id) return false;
  if (layerId === 'flights') {
    return flightsLayer.refocusTrackedById?.(id, { origin }) || flightsLayer.trackById(id, { origin });
  }
  if (layerId === 'military') {
    return militaryFlightsLayer.refocusTrackedById?.(id, { origin }) || militaryFlightsLayer.trackById(id, { origin });
  }
  if (layerId === 'military-installations') {
    if (!contextTargetFlyToAllowed(layerId)) return selectKnownContextTarget(layerId, id);
    // focusById flies the camera; it never assigns a tracked entity, so the
    // stamp has to be announced here.
    announceNavigationAuthority('context-installation-focus');
    return militaryInstallationsLayer.focusById(id);
  }
  if (layerId !== 'ais-live-vessels' || !aisLiveVesselsLayer.selectById(id)) return false;

  const vessel = aisLiveVesselsLayer.getAllPositions(12000).find((item) => String(item.id) === String(id));
  if (!contextTargetFlyToAllowed(layerId) || !vessel?.position || !state.viewer) return true;
  announceNavigationAuthority('context-vessel-focus');
  state.viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(vessel.position, VESSEL_FOCUS_RADIUS_M),
    { duration: 1.4 },
  );
  return true;
}

function subjectKey(subject) {
  return subject ? `${subject.layerId}:${subject.id}` : '';
}

function normalizeContextId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedSubjectKey(subject) {
  if (!subject) return '';
  return `${normalizeContextId(subject.layerId)}:${normalizeContextId(subject.id)}`;
}

function resetNavigationVisitedCycle() {
  state.navigationVisited.clear();
  const currentKey = subjectKey(state.subject);
  if (currentKey) state.navigationVisited.add(currentKey);
}

/** @returns {{historyKeys: string[], navigationVisitedKeys: string[], historyLength: number, navigationIndex: number, suppressedHistoryKey: string|null, pendingSelectionKey: string|null}} */
export function _getAwarenessNavigationStateForTest() {
  return {
    historyKeys: state.navigationHistory.map(subjectKey),
    navigationVisitedKeys: [...state.navigationVisited],
    historyLength: state.navigationHistory.length,
    navigationIndex: state.navigationIndex,
    suppressedHistoryKey: state.suppressedHistoryKey,
    pendingSelectionKey: state.pendingSelectionKey,
  };
}

function selectKnownContextTarget(layerId, id) {
  const key = `${layerId}:${id}`;
  const known = [
    state.subject,
    ...state.navigationHistory,
    ...(state.results?.cohorts || []).flatMap((cohort) => (
      cohort.id === layerId ? (cohort.summary.navigationNearest || cohort.summary.nearest || []) : []
    )),
  ].find((item) => item && `${item.layerId || layerId}:${item.id || item.mmsi}` === key);
  if (!known?.position) return false;
  if (contextTargetFlyToAllowed(layerId)) releaseAircraftTracking();
  selectSubject({
    ...known,
    layerId,
    id: String(known.id || known.mmsi),
    label: known.label || known.name || known.callsign || String(id),
    position: Cesium.Cartesian3.clone(known.position),
  });
  return true;
}

function requestFocus(layerId, id, preserveHistory = false, { origin = 'programmatic' } = {}) {
  const key = `${layerId}:${id}`;
  state.pendingSelectionKey = key;
  if (preserveHistory) state.suppressedHistoryKey = key;
  const focused = focusNearbyTarget(layerId, id, { origin });
  state.pendingSelectionKey = null;
  state.suppressedHistoryKey = null;
  return focused;
}

function focusSubject(subject, preserveHistory = false, options = {}) {
  if (!subject) return false;
  return requestFocus(subject.layerId, subject.id, preserveHistory, options);
}

function focusCurrentSubject(options = {}) {
  return focusSubject(state.subject, true, options);
}

function isFlightLayer(layerId) {
  return layerId === 'flights' || layerId === 'military';
}

function normalizeAircraftClass(value) {
  return String(value || '').trim().toLowerCase();
}

function aircraftClassMatchesFilter(item, aircraftClass) {
  const requested = normalizeAircraftClass(aircraftClass);
  if (!requested) return true;
  const candidates = [
    item?.aircraftClass,
    item?.klass,
    item?.type,
    item?.typeCode,
    item?.typeName,
  ]
    .map((value) => normalizeAircraftClass(value))
    .filter(Boolean);
  if (!candidates.length) return false;
  return candidates.some((candidate) => candidate === requested || candidate.includes(requested));
}

function selectNavigationTargets(sourceCohorts, subject, visitedKeys, {
  targetLayer = null,
  aircraftClass = null,
  aircraftOnly = false,
} = {}) {
  let targets = getAwarenessNavigationTargets(sourceCohorts, subject, visitedKeys);
  if (aircraftOnly) {
    targets = targets.filter((target) => isFlightLayer(target.layerId));
  }
  if (targetLayer) {
    targets = targets.filter((target) => target.layerId === targetLayer);
  }
  if (aircraftClass) {
    targets = targets.filter((target) => aircraftClassMatchesFilter(target.item, aircraftClass));
  }
  return targets;
}

/**
 * Resolve the source-owned aircraft that currently owns Cesium tracking.
 * Both flight layers may briefly retain local state during a cross-layer
 * handoff, so the viewer's normalized tracked identity is the tie-breaker.
 * @returns {{layerId: string, id: string, label: string, position: Cesium.Cartesian3}|null}
 *   Detached awareness subject, or null when no flight owns the follow camera.
 */
function currentTrackedFlightSubject() {
  const trackedKey = normalizeContextId(state.viewer?.trackedEntity?.gevTrackedId);
  if (!trackedKey) return null;
  const subjects = [
    flightsLayer.getTrackedSubject?.(),
    militaryFlightsLayer.getTrackedSubject?.(),
  ];
  return subjects.find((subject) => normalizedSubjectKey(subject) === trackedKey) || null;
}

function alternativeFlightAvailable({
  targetLayer = null,
  aircraftClass = null,
} = {}) {
  if (!isFlightLayer(state.subject?.layerId) || !state.subject?.position) return false;
  if (targetLayer && !isFlightLayer(targetLayer)) return false;

  const flights = targetLayer === 'military'
    ? []
    : flightsLayer.getNearby(
      state.subject.position,
      AWARENESS_MAX_FLIGHT_SEARCH_RADIUS_M,
      2,
      { includeHidden: true },
    ).filter((item) => aircraftClassMatchesFilter(item, aircraftClass));

  const military = targetLayer === 'flights'
    ? []
    : militaryFlightsLayer.getNearby(
      state.subject.position,
      AWARENESS_MAX_FLIGHT_SEARCH_RADIUS_M,
      2,
      { includeHidden: true },
    ).filter((item) => aircraftClassMatchesFilter(item, aircraftClass));

  return [
    ['flights', flights],
    ['military', military],
  ].some(([layerId, items]) => items.some((item) => (
    `${layerId}:${item.icao24 || item.id}` !== subjectKey(state.subject)
  )));
}

function closestFlightWithinRadius(radiusM, visitedKeys, excludeVisited, {
  targetLayer = null,
  aircraftClass = null,
} = {}) {
  if (!state.subject?.position) return null;
  const visited = new Set(visitedKeys);
  if (targetLayer && !isFlightLayer(targetLayer)) return null;
  const candidates = [
    ...(targetLayer === 'military' ? [] : flightsLayer.getNearby(
      state.subject.position,
      radiusM,
      25000,
      { includeHidden: true },
    )
      .filter((item) => aircraftClassMatchesFilter(item, aircraftClass))
      .map((item) => ({ layerId: 'flights', id: String(item.icao24), item }))),
    ...(targetLayer === 'flights' ? [] : militaryFlightsLayer.getNearby(
      state.subject.position,
      radiusM,
      5000,
      { includeHidden: true },
    )
      .filter((item) => aircraftClassMatchesFilter(item, aircraftClass))
      .map((item) => ({ layerId: 'military', id: String(item.icao24), item }))),
  ].filter((target) => {
    const key = `${target.layerId}:${target.id}`;
    if (key === subjectKey(state.subject)) return false;
    return !excludeVisited || !visited.has(key);
  });
  candidates.sort((a, b) => (
    (a.item.distanceM ?? a.item.distance ?? Infinity)
    - (b.item.distanceM ?? b.item.distance ?? Infinity)
  ));
  return candidates[0] || null;
}

function findExpandedFlightTarget(options = {}) {
  if (!isFlightLayer(state.subject?.layerId)) return null;
  let visitedKeys = [...state.navigationVisited];
  const search = () => findByDoublingRadius(
    (radiusM) => closestFlightWithinRadius(radiusM, visitedKeys, true, options),
    {
      initialRadiusM: AWARENESS_RADIUS_M,
      maxRadiusM: AWARENESS_MAX_FLIGHT_SEARCH_RADIUS_M,
    },
  );
  const target = search();
  if (target) return target;
  resetNavigationVisitedCycle();
  visitedKeys = [...state.navigationVisited];
  return search();
}

function subjectCohortFeedUnknown() {
  const cohort = state.results?.cohorts?.find((item) => item.id === state.subject?.layerId);
  return cohort?.summary?.relationship === AWARENESS_RELATIONSHIP.UNKNOWN
    && cohort.summary.count === null;
}

/**
 * Resolves NEXT availability from the same three branches used by navigation.
 * Forward history remains usable while a feed is unavailable; discovering a
 * new nearby or expanded target requires a known subject cohort.
 * @param {Object} availability Navigation branch availability.
 * @returns {boolean} Whether NEXT has a path that can run.
 */
export function canNavigateAwarenessNext({
  hasForwardHistory = false,
  hasExpandedFlightTarget = false,
  hasNearbyTarget = false,
  subjectCohortUnknown = false,
} = {}) {
  return Boolean(
    hasForwardHistory
    || (!subjectCohortUnknown && (hasExpandedFlightTarget || hasNearbyTarget))
  );
}

function canNavigateNext({
  targetLayer = null,
  aircraftClass = null,
} = {}) {
  return canNavigateAwarenessNext({
    hasForwardHistory: findCompatibleHistoryIndex(
      state.navigationHistory,
      state.navigationIndex,
      1,
      { targetLayer, aircraftClass, resolveItem: historySubjectItem },
    ) !== -1,
    hasNearbyTarget: selectNavigationTargets(
      state.results?.cohorts,
      state.subject,
      [...state.navigationVisited],
      { targetLayer, aircraftClass },
    ).length > 0,
    hasExpandedFlightTarget: alternativeFlightAvailable({
      targetLayer,
      aircraftClass,
    }),
    subjectCohortUnknown: subjectCohortFeedUnknown(),
  });
}

/**
 * Walk navigation history for the next entry that can still be focused.
 *
 * A history entry only holds a SNAPSHOT of a contact; the live contact behind
 * it can be evicted from its layer at any time (the cull that drives
 * CONTACT LOST). Focusing an evicted entry fails, so stepping over it is the
 * only way PREVIOUS/NEXT survives a lost subject — stopping at the first dead
 * entry strands the operator there for the rest of the session, because the
 * index never advances past it.
 *
 * `state.navigationIndex` moves only on a successful focus: a caller that
 * falls through to the live cohort must still splice forward history from the
 * position the operator actually occupies.
 * @param {number} direction Walk direction (negative = previous).
 * @param {{targetLayer: string|null, aircraftClass: string|null}} filters Navigation filters.
 * @returns {boolean} Whether a history entry was focused.
 */
function focusCompatibleHistory(direction, {
  targetLayer,
  aircraftClass,
  aircraftOnly,
  origin = 'programmatic',
}) {
  let cursor = state.navigationIndex;
  for (;;) {
    const historyIndex = findCompatibleHistoryIndex(
      state.navigationHistory,
      cursor,
      direction,
      { targetLayer, aircraftClass, aircraftOnly, resolveItem: historySubjectItem },
    );
    if (historyIndex === -1) return false;
    if (focusSubject(state.navigationHistory[historyIndex], true, { origin })) {
      state.navigationIndex = historyIndex;
      return true;
    }
    // Contact evicted since it entered history — step over it. The scan is
    // strictly monotonic, so this terminates at the end of history.
    cursor = historyIndex;
  }
}

function navigateHistory(direction, {
  targetLayer = null,
  aircraftClass = null,
  aircraftOnly = false,
  origin = 'programmatic',
} = {}) {
  if (focusCompatibleHistory(direction, {
    targetLayer, aircraftClass, aircraftOnly, origin,
  })) return true;

  if (direction < 0) return false;

  let targets = selectNavigationTargets(
    state.results?.cohorts,
    state.subject,
    [...state.navigationVisited],
    { targetLayer, aircraftClass, aircraftOnly },
  );
  const targetHistoryFullyVisited = targets.length > 0 && targets.every((target) => target.visited);
  const subjectCohortUnknown = subjectCohortFeedUnknown();
  if (targetHistoryFullyVisited && isFlightLayer(state.subject?.layerId) && !subjectCohortUnknown) {
    const expanded = findExpandedFlightTarget({ targetLayer, aircraftClass });
    if (expanded) {
      return requestFocus(expanded.candidate.layerId, expanded.candidate.id, false, { origin });
    }
  }
  if (targetHistoryFullyVisited) {
    resetNavigationVisitedCycle();
    targets = selectNavigationTargets(
      state.results?.cohorts,
      state.subject,
      [...state.navigationVisited],
      { targetLayer, aircraftClass, aircraftOnly },
    );
  }
  const hasNearbyFlight = targets.some((target) => isFlightLayer(target.layerId));
  if (isFlightLayer(state.subject?.layerId) && !hasNearbyFlight && !subjectCohortUnknown) {
    const expanded = findExpandedFlightTarget({ targetLayer, aircraftClass });
    if (expanded) {
      return requestFocus(expanded.candidate.layerId, expanded.candidate.id, false, { origin });
    }
  }
  if (subjectCohortFeedUnknown()) return false;
  const candidate = targets[0];
  if (!candidate) return false;
  return requestFocus(candidate.layerId, candidate.id, false, { origin });
}

function historySubjectItem(subject) {
  if (!subject) return null;
  const cohort = state.results?.cohorts?.find((item) => item.id === subject.layerId);
  const items = cohort?.summary?.navigationNearest || cohort?.summary?.nearest || [];
  return items.find((item) => String(item?.icao24 || item?.mmsi || item?.id) === String(subject.id))
    || subject;
}

/** Retain filter metadata when a production subject enters navigation history. */
export function historySubjectSnapshot(subject, sourceItem = null) {
  const aircraftClass = sourceItem?.aircraftClass
    || sourceItem?.klass
    || sourceItem?.type
    || subject?.aircraftClass
    || null;
  return aircraftClass ? { ...subject, aircraftClass } : { ...subject };
}

function historySourceItem(subject) {
  if (!isFlightLayer(subject?.layerId) || !subject?.position) return null;
  // The current sweep already holds this contact's record. Reusing it keeps
  // selection O(1) against the cohort instead of paying a fresh full-layer
  // proximity scan per selection — the burst cost when NEXT walks a cohort.
  const cohort = state.results?.cohorts?.find((item) => item.id === subject.layerId);
  const items = cohort?.summary?.navigationNearest || cohort?.summary?.nearest || [];
  const fromSweep = items.find(
    (item) => String(item?.icao24 || item?.id) === String(subject.id),
  );
  if (fromSweep) return fromSweep;
  const layer = subject.layerId === 'military' ? militaryFlightsLayer : flightsLayer;
  return layer.getNearby(subject.position, 1000, 25, { includeHidden: true })
    .find((item) => String(item?.icao24 || item?.id) === String(subject.id)) || null;
}

/** Find the next history entry compatible with requested navigation filters. */
export function findCompatibleHistoryIndex(history, startIndex, direction, {
  targetLayer = null,
  aircraftClass = null,
  aircraftOnly = false,
  resolveItem = (subject) => subject,
} = {}) {
  const step = direction < 0 ? -1 : 1;
  for (let index = startIndex + step; index >= 0 && index < history.length; index += step) {
    const subject = history[index];
    if (aircraftOnly && !isFlightLayer(subject?.layerId)) continue;
    if (targetLayer && subject?.layerId !== targetLayer) continue;
    if (aircraftClass && !aircraftClassMatchesFilter(resolveItem(subject), aircraftClass)) continue;
    return index;
  }
  return -1;
}

function navigationControlsHtml() {
  const canPrevious = state.navigationIndex > 0;
  return `<div class="military-awareness-controls" role="group" aria-label="Global Context navigation">
    <button type="button" data-awareness-action="previous" title="Previous — prior visited contact in the 250 km window"${canPrevious ? '' : ' disabled'}>PREVIOUS</button>
    <button type="button" data-awareness-action="focus">FOCUS</button>
    <button type="button" data-awareness-action="next" title="Next — nearest unvisited contact in the 250 km window"${canNavigateNext() ? '' : ' disabled'}>NEXT</button>
  </div>`;
}

function navigationState() {
  return {
    canPrevious: state.navigationIndex > 0,
    canFocus: Boolean(state.subject),
    canNext: canNavigateNext(),
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function renderResults() {
  if (!state.enabled || !state.results) return hidePanel();
  const panel = ensurePanel();
  const { subject, cohorts } = state.results;
  const markup = `<div class="military-awareness-subject">${escapeHtml(subject.label)} · ${formatAwarenessDistance(AWARENESS_RADIUS_M)} FLIGHT / VESSEL WINDOW</div>
    ${navigationControlsHtml()}
    ${cohorts.map(rowHtml).join('')}
    <p class="military-awareness-note">Open-source mapped/observed context. Missing broadcasts, unloaded map areas, or unmapped sites are not evidence of absence.</p>`;
  panel.hidden = false;
  if (state.panelMarkup !== markup) {
    panel.innerHTML = markup;
    state.panelMarkup = markup;
  }
}

function rotateAwarenessPages() {
  if (!state.enabled || !state.results) return;
  let changed = false;
  for (const cohort of state.results.cohorts) {
    const pageCount = Math.max(1, Math.ceil(cohort.summary.nearest.length / AWARENESS_PAGE_SIZE));
    if (pageCount <= 1) continue;
    const current = state.cohortPages.get(cohort.id) || 0;
    state.cohortPages.set(cohort.id, ((Math.floor(current / AWARENESS_PAGE_SIZE) + 1) % pageCount) * AWARENESS_PAGE_SIZE);
    changed = true;
  }
  if (changed) { renderResults(); scheduleDirectionOverlayUpdate(true); }
}

function startAwarenessPageRotation() {
  if (!state.pageTimer) state.pageTimer = window.setInterval(rotateAwarenessPages, AWARENESS_PAGE_ROTATE_MS);
}

function stopAwarenessPageRotation() {
  if (state.pageTimer) window.clearInterval(state.pageTimer);
  state.pageTimer = null;
}

function ensureDirectionOverlay() {
  if (state.directionRoot || !state.viewer) return state.directionRoot;
  const root = document.createElement('div');
  root.id = 'military-awareness-direction-overlay';
  root.hidden = true;
  root.setAttribute('aria-hidden', 'true');

  const compass = document.createElement('div');
  compass.className = 'military-awareness-compass-ring';
  const cardinals = [
    ['N', 0], ['E', 90], ['S', 180], ['W', 270],
  ];
  state.compassLabels = cardinals.map(([label, bearing]) => {
    const element = document.createElement('span');
    element.className = `military-awareness-compass-label cardinal-${label.toLowerCase()}`;
    element.textContent = label;
    element.dataset.bearing = String(bearing);
    root.appendChild(element);
    return element;
  });
  const heading = document.createElement('span');
  heading.className = 'military-awareness-compass-heading';
  root.append(compass, heading);

  state.directionMarkers = Array.from({ length: 3 }, () => {
    const marker = document.createElement('div');
    marker.className = 'military-awareness-direction-marker';
    const arrow = document.createElement('span');
    arrow.className = 'military-awareness-direction-arrow';
    arrow.textContent = '➜';
    const label = document.createElement('span');
    label.className = 'military-awareness-direction-label';
    marker.append(arrow, label);
    marker._arrow = arrow;
    marker._label = label;
    marker._lastAngle = 0;
    root.appendChild(marker);
    return marker;
  });

  state.compassRing = compass;
  state.compassHeading = heading;
  state.viewer.container.appendChild(root);
  state.directionRoot = root;
  return root;
}

function scheduleDirectionOverlayUpdate(force = false) {
  if (state.directionFrame !== null || !state.enabled) return;
  const now = Date.now();
  if (!force && now - state.lastDirectionUpdateMs < awarenessRefreshIntervalMs(state.cameraMoving)) return;
  state.directionFrame = window.requestAnimationFrame(() => {
    state.directionFrame = null;
    state.lastDirectionUpdateMs = Date.now();
    updateDirectionOverlay();
  });
}

function cancelDirectionOverlayUpdate() {
  if (state.directionFrame !== null) window.cancelAnimationFrame(state.directionFrame);
  state.directionFrame = null;
  state.lastDirectionUpdateMs = 0;
}

function updateDirectionOverlay() {
  const root = ensureDirectionOverlay();
  if (!root || !state.enabled || !state.subject?.position || !state.results) {
    if (root) root.hidden = true;
    return;
  }

  const canvas = state.viewer.scene.canvas;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const geometry = getKeyholeGeometry(width, height);
  if (!(geometry.radius > 0)) {
    root.hidden = true;
    return;
  }

  root.hidden = false;
  // Keep the compass comfortably inside the shader keyhole so its cardinals
  // remain visible around the subject instead of hiding under edge panels.
  const compassRadius = Math.max(120, Math.min(geometry.radius - 48, geometry.radius * 0.66));
  state.compassRing.style.left = `${geometry.centerX - compassRadius}px`;
  state.compassRing.style.top = `${geometry.centerY - compassRadius}px`;
  state.compassRing.style.width = `${compassRadius * 2}px`;
  state.compassRing.style.height = `${compassRadius * 2}px`;

  const cameraHeading = state.viewer.camera.heading || 0;
  const headingDeg = (Math.round(Cesium.Math.toDegrees(cameraHeading)) + 360) % 360;
  state.compassRing.style.setProperty('--compass-rotation', `${-headingDeg}deg`);
  state.compassHeading.textContent = `HDG ${String(headingDeg).padStart(3, '0')}°`;
  state.compassHeading.style.left = `${geometry.centerX}px`;
  state.compassHeading.style.top = `${geometry.centerY - compassRadius + 39}px`;
  for (const label of state.compassLabels) {
    const bearing = Cesium.Math.toRadians(Number(label.dataset.bearing));
    const angle = bearing - cameraHeading - Cesium.Math.PI_OVER_TWO;
    const labelRadius = compassRadius - 17;
    label.style.left = `${geometry.centerX + Math.cos(angle) * labelRadius}px`;
    label.style.top = `${geometry.centerY + Math.sin(angle) * labelRadius}px`;
  }

  const directionalCohort = state.results.cohorts.find((cohort) => cohort.id === state.subject.layerId)
    || state.results.cohorts.find((cohort) => cohort.id === 'military');
  const page = state.cohortPages.get(directionalCohort?.id) || 0;
  const military = directionalCohort?.summary.nearest.slice(page, page + AWARENESS_PAGE_SIZE) || [];
  for (let index = 0; index < state.directionMarkers.length; index++) {
    const marker = state.directionMarkers[index];
    const item = military[index];
    if (!item?.position) {
      marker.hidden = true;
      continue;
    }
    const direction = Cesium.Cartesian3.subtract(item.position, state.subject.position, DIRECTION_SCRATCH[index]);
    if (Cesium.Cartesian3.magnitudeSquared(direction) < 1) {
      marker.hidden = true;
      continue;
    }
    Cesium.Cartesian3.normalize(direction, direction);
    const projection = celestialScreenAngle(
      Cesium.Cartesian3.dot(direction, state.viewer.camera.rightWC),
      Cesium.Cartesian3.dot(direction, state.viewer.camera.upWC),
      marker._lastAngle,
    );
    if (projection.stable) marker._lastAngle = projection.angle;
    // Every detected contact shares the compass rim. Keeping the bearing
    // markers on one radius makes them read as compass contacts rather than
    // unconstrained labels floating over the map.
    const markerRadius = compassRadius;
    marker.style.left = `${geometry.centerX + Math.cos(projection.angle) * markerRadius}px`;
    marker.style.top = `${geometry.centerY + Math.sin(projection.angle) * markerRadius}px`;
    marker.style.opacity = String(projection.opacity);
    marker._arrow.style.transform = `translate(-50%, -50%) rotate(${projection.angle}rad)`;
    marker._label.style.transform = `translate(-50%, -50%) translate(${-Math.cos(projection.angle) * 56}px, ${-Math.sin(projection.angle) * 56}px)`;
    const label = formatAwarenessLabel(item);
    const subjectCartographic = Cesium.Cartographic.fromCartesian(state.subject.position, undefined, SUBJECT_CARTOGRAPHIC_SCRATCH);
    const targetCartographic = Cesium.Cartographic.fromCartesian(item.position, undefined, TARGET_CARTOGRAPHIC_SCRATCH[index]);
    const bearing = subjectCartographic && targetCartographic
      ? bearingBetweenCoordinates(
        Cesium.Math.toDegrees(subjectCartographic.latitude),
        Cesium.Math.toDegrees(subjectCartographic.longitude),
        Cesium.Math.toDegrees(targetCartographic.latitude),
        Cesium.Math.toDegrees(targetCartographic.longitude),
      )
      : null;
    const bearingText = Number.isFinite(bearing) ? `BRG ${String(Math.round(bearing)).padStart(3, '0')}°` : 'BRG —';
    const courseText = Number.isFinite(item.track) ? ` · CRS ${String(Math.round(item.track)).padStart(3, '0')}°` : '';
    marker._label.textContent = `${label} · ${formatAwarenessDistance(item.distanceM)}\n${bearingText}${courseText}`;
    marker.hidden = false;
  }
}

function clearVisual() {
  if (state.visual?.entities && state.viewer) {
    for (const entity of state.visual.entities) state.viewer.entities.remove(entity);
    // Idle mode renders only on request; a removed ring must not linger.
    governorRequestRender('awareness-visual');
  }
  state.visual = null;
}

function renderVisual(subject) {
  if (!state.viewer || !subject?.position) return;
  const cartographic = Cesium.Cartographic.fromCartesian(subject.position);
  if (!cartographic) return;
  const groundCenter = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 0);
  const key = `${subject.layerId}:${subject.id}`;
  if (state.visual?.key === key) {
    // Large ellipse geometry is more reliable as a ConstantPositionProperty.
    // Move it only after a meaningful displacement so live tracking does not
    // churn ten large geometries for sub-pixel motion every 750 ms.
    if (Cesium.Cartesian3.distance(state.visual.center, groundCenter) >= 250) {
      for (const entity of state.visual.entities) entity.position.setValue(groundCenter);
      Cesium.Cartesian3.clone(groundCenter, state.visual.center);
      // Content actually changed — buy exactly one frame instead of holding.
      governorRequestRender('awareness-visual');
    }
    return;
  }
  clearVisual();

  const entities = [];

  entities.push(state.viewer.entities.add({
    position: groundCenter,
    ellipse: {
      semiMajorAxis: AWARENESS_RADIUS_M,
      semiMinorAxis: AWARENESS_RADIUS_M,
      fill: false,
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString('#62b5ff').withAlpha(0.72),
      height: CONTEXT_RIM_HEIGHT_M,
    },
  }));

  state.visual = { key, entities, center: Cesium.Cartesian3.clone(groundCenter) };
  governorRequestRender('awareness-visual');
}

function selectSubject(subject) {
  if (!state.enabled || !subject?.position) return;
  startAwarenessPageRotation();
  const key = subjectKey(subject);
  state.navigationVisited.add(key);
  const suppressHistory = state.suppressedHistoryKey === key;
  state.pendingSelectionKey = null;
  state.suppressedHistoryKey = null;
  if (!suppressHistory) {
    const current = state.navigationHistory[state.navigationIndex];
    if (subjectKey(current) !== key) {
      state.navigationHistory.splice(state.navigationIndex + 1);
      state.navigationHistory.push({
        ...historySubjectSnapshot(subject, historySourceItem(subject)),
        position: Cesium.Cartesian3.clone(subject.position),
      });
      state.navigationIndex = state.navigationHistory.length - 1;
    }
  }
  state.subject = subject;
  // A newly chosen contact starts present; the next refresh re-decides.
  state.subjectMissing = false;
  refreshSelectedSubject(true);
}

/**
 * Resolve the currently displayed position for a selected live subject. Flight
 * tracking owns the motion callback, so awareness consumes its cached display
 * position instead of creating a second tracker or extrapolation path.
 * @param {{layerId: string, id: string, position: Cesium.Cartesian3}} subject Current subject.
 * @param {object} [options] Position materialization controls.
 * @param {boolean} [options.allowCollectionMaterialization=true] Whether a layer-wide fallback may run.
 * @returns {Cesium.Cartesian3|null} A cloned live position when one is available.
 */
function resolveSubjectPosition(subject, { allowCollectionMaterialization = true } = {}) {
  if (!subject?.position) return null;
  if (subject.layerId === 'flights' || subject.layerId === 'military') {
    const trackedPosition = state.viewer?.trackedEntity?.gevDisplayPosition?.();
    if (trackedPosition) {
      return {
        position: Cesium.Cartesian3.clone(trackedPosition),
        // Only the follow camera's own contact proves presence this way; a
        // different tracked entity says nothing about this subject.
        presence: String(state.viewer?.trackedEntity?.gevTrackedId || '') === subjectKey(subject)
          ? SUBJECT_PRESENCE.LIVE
          : SUBJECT_PRESENCE.UNCHECKED,
      };
    }
    // Cockpit already materializes its tracked position on a fixed 20 Hz loop.
    // If that frame-owned cache is temporarily unavailable, keep the last
    // awareness position instead of allocating/scanning up to 1,000 contacts.
    if (!allowCollectionMaterialization) {
      return { position: Cesium.Cartesian3.clone(subject.position), presence: SUBJECT_PRESENCE.UNCHECKED };
    }
    const layer = subject.layerId === 'flights' ? flightsLayer : militaryFlightsLayer;
    return collectionSubjectPosition(subject, layer.getAllPositions(1000), layer);
  }
  if (subject.layerId === 'ais-live-vessels') {
    if (!allowCollectionMaterialization) {
      return { position: Cesium.Cartesian3.clone(subject.position), presence: SUBJECT_PRESENCE.UNCHECKED };
    }
    return collectionSubjectPosition(
      subject,
      aisLiveVesselsLayer.getAllPositions(12000),
      aisLiveVesselsLayer,
    );
  }
  // Mapped installations come from static geometry, not a live feed: there is
  // nothing to be culled from.
  return { position: Cesium.Cartesian3.clone(subject.position), presence: SUBJECT_PRESENCE.LIVE };
}

/**
 * Locate a subject inside its layer's live collection, keeping the last known
 * position when it is gone.
 *
 * Presence comes from the layer's O(1) `hasContact`, never from the rows:
 * `getAllPositions` stops at its cap and the flights layer routinely carries
 * ~11k contacts against a 1,000-row cap, so "not in the rows" is not "gone".
 * The rows are only consulted for a fresher position — a contact past the cap
 * keeps its last known position while still reading as present.
 * @param {{id: string, position: Cesium.Cartesian3}} subject Current subject.
 * @param {Array<{id: string, position: Cesium.Cartesian3}>} rows Live collection rows.
 * @param {{hasContact?: function}} layer The owning source layer.
 * @returns {{position: Cesium.Cartesian3, presence: string}} Position plus presence verdict.
 */
function collectionSubjectPosition(subject, rows, layer) {
  const collection = Array.isArray(rows) ? rows : [];
  const current = collection.find((item) => String(item.id) === String(subject.id));
  // null/undefined means the layer cannot answer (disabled or not yet loaded).
  const known = layer?.hasContact?.(subject.id);
  const presence = known === true
    ? SUBJECT_PRESENCE.LIVE
    : (known === false ? SUBJECT_PRESENCE.MISSING : SUBJECT_PRESENCE.UNCHECKED);
  return {
    position: current?.position
      ? Cesium.Cartesian3.clone(current.position)
      : Cesium.Cartesian3.clone(subject.position),
    presence,
  };
}

/**
 * Re-resolve a live subject's DISPLAY label from the layer that owns it.
 *
 * The subject snapshot is captured once at selection time, but a contact's
 * label INPUTS can arrive later: adsbdb enrichment supplies a registration
 * seconds after a callsign-less aircraft is selected, so every other surface
 * swapped `ae1fa4` → `N123AB` while the cached Context subject kept the hex.
 * The owning layer's tracked-subject accessor already applies the layer's
 * label convention (callsign → registration → icao24), so ask it rather than
 * re-deriving the chain here.
 *
 * Identity (`subject.id`) is NEVER re-derived — only the rendered string.
 * @param {{layerId: string, id: string, label: string}} subject Current subject.
 * @returns {string} The current label, or the cached one when the owning layer
 *   has no tracked subject (e.g. a cross-layer handoff is in flight).
 */
function resolveSubjectLabel(subject) {
  if (!isFlightLayer(subject?.layerId)) return subject?.label;
  const layer = subject.layerId === 'flights' ? flightsLayer : militaryFlightsLayer;
  const tracked = layer.getTrackedSubject?.();
  if (tracked?.label && String(tracked.id) === String(subject.id)) return tracked.label;
  return subject.label;
}

/** Refresh proximity counts/distances against the subject's current live position. */
function refreshSelectedSubject(force = false) {
  if (!state.enabled || !state.subject) return;
  const sources = collectSourceStates();
  const nextSourceRevision = sourceRevision(sources);
  const sourceRevisionChanged = nextSourceRevision !== state.sourceRevision;
  const resolved = resolveSubjectPosition(state.subject, {
    allowCollectionMaterialization: !document.body?.classList?.contains('cockpit-mode') || sourceRevisionChanged,
  });
  if (!resolved) return;
  const { position, presence } = resolved;
  // UNCHECKED leaves the verdict alone: this tick simply did not look.
  if (presence === SUBJECT_PRESENCE.LIVE) state.subjectMissing = false;
  else if (presence === SUBJECT_PRESENCE.MISSING) state.subjectMissing = true;
  const nextLabel = resolveSubjectLabel(state.subject);
  const labelChanged = nextLabel !== state.subject.label;
  state.subject = { ...state.subject, position, label: nextLabel };
  const movementM = state.lastEvaluatedPosition
    ? Cesium.Cartesian3.distance(state.lastEvaluatedPosition, position)
    : Infinity;
  if (!awarenessRefreshRequired({
    force,
    hasResults: Boolean(state.results),
    movementM,
    sourceRevisionChanged,
  })) {
    state.results.subject = state.subject;
    renderVisual(state.subject);
    // The panel markup embeds `subject.label`, so a label that changed while
    // the contact was stationary (async enrichment answering after selection)
    // is render-worthy ON ITS OWN. Without this the standalone Context panel
    // kept the ICAO hex until unrelated movement, a source-revision bump, or
    // page rotation happened to repaint it. Gated on an ACTUAL change so the
    // common no-op refresh (every 750 ms) still costs no repaint.
    if (labelChanged) renderResults();
    scheduleDirectionOverlayUpdate(force);
    return;
  }
  state.results = evaluateSubject(state.subject, sources);
  state.sourceRevision = nextSourceRevision;
  state.lastEvaluatedPosition = Cesium.Cartesian3.clone(position, state.lastEvaluatedPosition);
  for (const cohort of state.results.cohorts) {
    const maxPage = Math.max(0, Math.floor(Math.max(0, cohort.summary.nearest.length - 1) / AWARENESS_PAGE_SIZE) * AWARENESS_PAGE_SIZE);
    state.cohortPages.set(cohort.id, Math.min(state.cohortPages.get(cohort.id) || 0, maxPage));
  }
  renderVisual(state.subject);
  renderResults();
  scheduleDirectionOverlayUpdate(force);
}

function subjectFromContext(record) {
  if (!record || !['ais-live-vessels', 'military-installations'].includes(record.layerId)) return null;
  const latitude = Number(record.latitude);
  const longitude = Number(record.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    layerId: record.layerId,
    id: record.properties?.mmsi || record.id,
    label: record.label || record.id,
    position: Cesium.Cartesian3.fromDegrees(longitude, latitude, 0),
  };
}

/**
 * Record that the current subject left its feed on its own.
 *
 * The subject, its cohort results and its navigation history all survive: the
 * Contact panel keeps rendering them behind a CONTACT LOST cue, and PREVIOUS /
 * NEXT stay operable so the operator can step off. Nulling the subject here
 * instead would take the panel — and those controls — off screen.
 */
function markSubjectEvicted() {
  if (!state.subject) return;
  state.subjectMissing = true;
}

function clearAwarenessSubject() {
  state.autoFocusRetryPending = false;
  state.subject = null;
  state.subjectMissing = false;
  state.results = null;
  state.navigationHistory = [];
  state.navigationVisited.clear();
  state.navigationIndex = -1;
  state.suppressedHistoryKey = null;
  state.pendingSelectionKey = null;
  state.lastEvaluatedPosition = null;
  state.sourceRevision = '';
  state.cohortPages.clear();
  stopAwarenessPageRotation();
  clearVisual();
  hidePanel();
}

/**
 * Quantized camera-pose signature, or '' when the camera cannot report a full
 * pose yet. An unknown pose reads as PARKED, so a camera that is still coming
 * up can never be mistaken for continuous movement.
 * @param {Cesium.Camera|null|undefined} camera
 * @returns {string}
 */
function cameraMotionSignature(camera) {
  if (!camera?.positionWC || !Number.isFinite(camera.heading)) return '';
  return cameraPoseSignature(camera);
}

/**
 * Whether an evaluation actually has a contact to point an arrow at.
 *
 * A cohort reports `count: null` when its feed is unavailable or stale, and `0`
 * when the feed is healthy but empty. Only a positive count puts a marker on
 * the compass rim, so anything else means there is nothing to animate.
 * @param {?{cohorts?: Array<{summary?: {count: ?number}}>}} results
 * @returns {boolean}
 */
export function awarenessResultsAreLive(results) {
  const cohorts = Array.isArray(results?.cohorts) ? results.cohorts : [];
  return cohorts.some((cohort) => Number(cohort?.summary?.count) > 0);
}

/**
 * Whether Contacts genuinely has per-frame work right now.
 *
 * The direction arrows are screen-projected against the camera basis, so they
 * must be redrawn every frame while the view MOVES. Parked, or with no live
 * cohort to point at — nothing selected, every feed empty, every feed failed —
 * there is nothing to animate and Contacts must not be the reason the whole
 * scene keeps repainting.
 * @param {object} [snapshot] Explicit state, for tests.
 * @returns {boolean}
 */
export function awarenessNeedsContinuousRender({
  cameraMoving = state.cameraMoving,
  hasSubject = Boolean(state.subject),
  hasLiveResults = awarenessResultsAreLive(state.results),
} = {}) {
  return Boolean(cameraMoving && hasSubject && hasLiveResults);
}

/**
 * Take or drop the continuous-render hold to match the current need. Idempotent
 * (the governor is identity-keyed), and self-healing: the release decision is
 * made on a frame the hold itself guaranteed, so a hold can never strand the
 * scene in continuous mode.
 * @returns {void}
 */
function syncAwarenessRenderHold() {
  if (state.enabled && awarenessNeedsContinuousRender()) holdContinuousRender('military-awareness');
  else releaseContinuousRender('military-awareness');
}

function attachRuntimeListeners() {
  if (state.runtimeListenersAttached || !state.viewer) return;
  window.addEventListener('gev:awareness-subject-selected', state.subjectListener);
  window.addEventListener('gev:entity-selected', state.contextListener);
  window.addEventListener('gev:entity-selection-cleared', state.clearListener);
  window.addEventListener('gev:awareness-subject-cleared', state.subjectClearListener);
  state.preRenderRemover = state.viewer.scene.preRender.addEventListener(() => {
    if (!state.enabled) return;
    const now = Date.now();
    // "Did the camera move" uses the SAME quantized pose signature the fleet
    // rotation pass gates on (iconOrientation.cameraPoseSignature) rather than
    // camera.changed, whose granularity is globally degraded by other layers
    // mutating camera.percentageChanged.
    const poseSig = cameraMotionSignature(state.viewer.camera);
    if (poseSig !== state.lastCameraPoseSig) {
      state.lastCameraPoseSig = poseSig;
      state.lastCameraPoseChangeMs = now;
    }
    const decision = awarenessRefreshDecision({
      nowMs: now,
      lastRefreshMs: state.lastSubjectRefreshMs,
      lastPoseChangeMs: state.lastCameraPoseChangeMs,
      wasMoving: state.cameraMoving,
    });
    state.cameraMoving = decision.moving;
    syncAwarenessRenderHold();
    if (!decision.refresh) return;
    state.lastSubjectRefreshMs = now;
    if (state.subject && ['flights', 'military', 'ais-live-vessels'].includes(state.subject.layerId)) {
      refreshSelectedSubject();
    } else if (!state.passive && state.autoFocusRetryPending) {
      state.autoFocusRetryPending = false;
      focusAttentionTarget();
    } else {
      scheduleDirectionOverlayUpdate();
    }
  });
  state.runtimeListenersAttached = true;
}

function detachRuntimeListeners() {
  if (state.runtimeListenersAttached) {
    window.removeEventListener('gev:awareness-subject-selected', state.subjectListener);
    window.removeEventListener('gev:entity-selected', state.contextListener);
    window.removeEventListener('gev:entity-selection-cleared', state.clearListener);
    window.removeEventListener('gev:awareness-subject-cleared', state.subjectClearListener);
  }
  state.preRenderRemover?.();
  state.preRenderRemover = null;
  state.lastCameraPoseSig = '';
  state.lastCameraPoseChangeMs = 0;
  state.cameraMoving = false;
  // No frames will arrive to run the per-frame release once the listener is
  // gone, so drop the hold here.
  releaseContinuousRender('military-awareness');
  cancelDirectionOverlayUpdate();
  state.runtimeListenersAttached = false;
}

/**
 * Release any aircraft-owned follow camera before a non-aircraft context
 * selection takes ownership. Both layers are safe no-ops when idle and release
 * Cesium tracking in place, so the subsequent vessel/site framing starts from
 * the current view without the previous aircraft continuing to drag it.
 */
function releaseAircraftTracking() {
  flightsLayer.stopTracking?.();
  militaryFlightsLayer.stopTracking?.();
}

function refreshAfterDeferredDependency(activationId) {
  if (!state.enabled || state.passive || activationId !== state.activationId) return;
  if (state.subject) {
    refreshSelectedSubject(true);
    return;
  }
  if (state.autoFocusRetryPending) {
    state.autoFocusRetryPending = !focusAttentionTarget();
  }
}

async function enableDependencies(activationId = state.activationId) {
  const aircraftPending = [];
  for (const layerId of DEPENDENCIES) {
    if (!state.enabled) return;
    if (!state.dataManager) continue;
    const alreadyEnabled = state.dataManager.isEffectivelyEnabled?.(layerId)
      ?? state.dataManager.isEnabled(layerId);
    if (alreadyEnabled) continue;
    state.ownedDependencies.add(layerId);
    // Each layer serializes its own lifecycle internally. Start them together
    // so a slow or unavailable live feed cannot prevent the remaining context
    // sources from turning on.
    let pending;
    try {
      // Register the ON intent synchronously. If Contacts is turned OFF in the
      // same turn, DataLayerManager then sees OFF as the newest intent and a
      // stale deferred ON cannot resurrect a released dependency.
      pending = Promise.resolve(state.dataManager.setEnabled(layerId, true));
    } catch (error) {
      pending = Promise.reject(error);
    }
    if (AIRCRAFT_DEPENDENCIES.includes(layerId)) {
      aircraftPending.push(pending);
    } else {
      // Vessels and mapped installations enrich an already usable aircraft
      // context. Their settlement must never hold the Contacts transaction or
      // Cockpit gate open, and the activation token prevents a late result
      // from repainting or refocusing a newer/closed session.
      pending.then(
        () => refreshAfterDeferredDependency(activationId),
        () => refreshAfterDeferredDependency(activationId),
      );
    }
  }
  await Promise.allSettled(aircraftPending);
}

function releaseOwnedDependencies(releaseActivationId) {
  const owned = [...state.ownedDependencies];
  state.ownedDependencies.clear();
  if (!state.dataManager || !owned.length) return Promise.resolve();
  return Promise.allSettled(owned.map((layerId) => state.dataManager.setEnabled(layerId, false)))
    .then(() => {
      if (state.enabled && state.activationId !== releaseActivationId) {
        return enableDependencies(state.activationId);
      }
      return null;
    });
}

function activateOperationalContext() {
  const activationId = ++state.activationId;
  state.autoFocusRetryPending = false;
  const initialTrackedSubject = currentTrackedFlightSubject();
  if (initialTrackedSubject) selectSubject(initialTrackedSubject);
  return enableDependencies(activationId).then(() => {
    if (!state.enabled || state.passive || activationId !== state.activationId) return;
    const trackedSubject = currentTrackedFlightSubject();
    if (trackedSubject) {
      selectSubject(trackedSubject);
      return;
    }
    if (state.subject) {
      selectSubject(state.subject);
      return;
    }
    if (state.autoFocusAttempted) return;
    state.autoFocusRetryPending = !focusAttentionTarget();
  }).catch((error) => console.warn('[Global Context] dependency enable failed', error));
}

/**
 * Pick the observed candidate closest to the current view. This is intentionally
 * a navigation preference, not a risk, capability, or affiliation calculation.
 * @param {Array<{position: Cesium.Cartesian3}>} candidates Observed candidates.
 * @returns {Object|null} The best currently observable candidate.
 */
function closestToCurrentView(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const cameraPosition = state.viewer?.camera?.positionWC;
  if (!cameraPosition) return candidates.find((candidate) => candidate?.position) || null;

  let closest = null;
  let closestDistance = Infinity;
  for (const candidate of candidates) {
    if (!candidate?.position) continue;
    const distance = Cesium.Cartesian3.distance(cameraPosition, candidate.position);
    if (Number.isFinite(distance) && distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return closest;
}

/**
 * Focus a single observed, context-priority target after activation. Civilian
 * and military aircraft compete in one nearest-to-view pool; military is
 * concatenated first so exact distance ties resolve to military under the
 * strict comparison. An AIS vessel is only a fallback and is never inferred
 * to be military. There is deliberately no distance cap.
 * @returns {boolean} Whether a target was selected and framed.
 */
function focusAttentionTarget() {
  if (!state.enabled || state.subject || !state.viewer || state.autoFocusAttempted) return false;

  const nearestFlight = closestToCurrentView([
    ...militaryFlightsLayer.getAllPositions(800)
      .map((item) => ({ ...item, layerId: 'military' })),
    ...flightsLayer.getAllPositions(1000)
      .map((item) => ({ ...item, layerId: 'flights' })),
  ]);
  if (nearestFlight) {
    const layer = nearestFlight.layerId === 'military' ? militaryFlightsLayer : flightsLayer;
    if (layer.trackById(nearestFlight.id, { origin: 'programmatic' })) {
      state.autoFocusAttempted = true;
      return true;
    }
  }

  const vessel = closestToCurrentView(aisLiveVesselsLayer.getAllPositions(12000));
  if (!vessel || !aisLiveVesselsLayer.selectById(vessel.id)) return false;

  state.autoFocusAttempted = true;
  if (!contextTargetFlyToAllowed('ais-live-vessels')) return true;

  announceNavigationAuthority('context-vessel-autofocus', {
    cancelPendingSelection: false,
  });
  state.viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(vessel.position, VESSEL_FOCUS_RADIUS_M),
    { duration: 1.6 },
  );
  return true;
}

const militaryAwarenessLayer = {
  id: 'military-awareness',
  name: 'Global Context',
  icon: '◎',
  source: 'Open-source proximity context',
  // Context is entered from its dedicated right rail, not as a raw layer.
  showInTogglePanel: false,
  updateInterval: 0,
  statsRefreshInterval: 1000,
  attachDataManager(dataManager) { state.dataManager = dataManager; },
  setParams(params = {}) {
    if (typeof params.passive !== 'boolean') return;
    const wasPassive = state.passive;
    state.passive = params.passive;
    if (state.enabled && wasPassive && !state.passive) activateOperationalContext();
  },
  /** @returns {{ passive: boolean }} Current runtime parameters. */
  getParams() {
    return { passive: state.passive };
  },
  init(viewer) {
    detachRuntimeListeners();
    state.viewer = viewer;
    state.subjectListener = (event) => {
      if (!state.enabled) return;
      selectSubject(event.detail);
    };
    state.contextListener = (event) => {
      if (!state.enabled) return;
      const subject = subjectFromContext(event.detail);
      if (!subject) return;
      if (contextTargetFlyToAllowed(subject.layerId)) releaseAircraftTracking();
      selectSubject(subject);
    };
    state.clearListener = (event) => {
      if (!state.enabled || state.pendingSelectionKey) return;
      if (!awarenessClearMatchesSubject(state.subject, event.detail)) return;
      // An eviction keeps the subject so the readout can hold last-known
      // values; only a deliberate clear tears the selection down.
      if (awarenessClearIsEviction(event.detail)) {
        markSubjectEvicted();
        return;
      }
      clearAwarenessSubject();
    };
    state.subjectClearListener = (event) => {
      if (!state.enabled) return;
      const cleared = event.detail;
      if (state.pendingSelectionKey) return;
      if (
        awarenessClearMatchesSubject(state.subject, cleared)
        && String(state.subject?.id) === String(cleared?.id)
      ) {
        if (awarenessClearIsEviction(cleared)) {
          // Deliberately does NOT set autoFocusAttempted: the subject survives,
          // so the entry fallback has nothing to replace and the settlement
          // guard below stays scoped to real deselects.
          markSubjectEvicted();
          return;
        }
        // A deliberate clear during dependency settlement must win over the
        // entry fallback; otherwise Contacts can silently select a replacement.
        state.autoFocusAttempted = true;
        clearAwarenessSubject();
      }
    };
  },
  enable() {
    state.enabled = true;
    // NO unconditional continuous-render hold here. Contacts animates per frame
    // only while the VIEW is moving (the direction arrows are screen-projected);
    // parked, it is a throttled readout with nothing to animate. The hold is
    // taken and released per frame by syncAwarenessRenderHold().
    attachRuntimeListeners();
    startAwarenessPageRotation();
    state.autoFocusAttempted = false;
    state.autoFocusRetryPending = false;
    ensurePanel();
    hidePanel();
    if (!state.passive) return activateOperationalContext();
    return true;
  },
  disable() {
    state.enabled = false;
    releaseContinuousRender('military-awareness');
    detachRuntimeListeners();
    stopAwarenessPageRotation();
    state.cohortPages.clear();
    const releaseActivationId = ++state.activationId;
    state.autoFocusAttempted = false;
    state.autoFocusRetryPending = false;
    state.subject = null;
    state.results = null;
    state.lastSubjectRefreshMs = 0;
    state.lastEvaluatedPosition = null;
    state.sourceRevision = '';
    state.navigationHistory = [];
    state.navigationVisited.clear();
    state.navigationIndex = -1;
    state.suppressedHistoryKey = null;
    state.pendingSelectionKey = null;
    clearVisual();
    hidePanel();
    // The manager must not publish this coordinator as settled OFF while its
    // owned dependency releases are still issuing newer absolute intents.
    // Context mode handoffs restore the pre-entry snapshot only after this
    // promise resolves, preventing those releases from superseding restore.
    state.passive = true;
    return releaseOwnedDependencies(releaseActivationId);
  },
  update() {
    refreshSelectedSubject();
    return Promise.resolve();
  },
  destroy() {
    this.disable();
    detachRuntimeListeners();
    state.panel?.removeEventListener('click', state.panelClickListener);
    state.panelClickListener = null;
    if (state.panelOwned) state.panel?.remove();
    else if (state.panel) state.panel.replaceChildren();
    state.panel = null;
    state.panelOwned = false;
    state.directionRoot?.remove();
    state.directionRoot = null;
    state.compassRing = null;
    state.compassLabels = [];
    state.compassHeading = null;
    state.directionMarkers = [];
    state.panelMarkup = '';
    state.subjectListener = null;
    state.contextListener = null;
    state.clearListener = null;
    state.subjectClearListener = null;
    state.viewer = null;
    state.dataManager = null;
  },
  getStats() {
    return { count: state.results ? 1 : 0, lastUpdate: state.results?.evaluatedAt || null, stale: false, error: null, status: state.enabled ? 'ready' : 'idle' };
  },
  /** Return the latest read-only context result for compact HUD consumers. */
  getContextSnapshot() {
    if (!state.enabled || !state.subject) return null;
    if (!state.results) {
      return buildAwarenessContextSnapshot({
        subject: { ...state.subject },
        evaluatedAt: null,
        radiusM: AWARENESS_RADIUS_M,
        cohorts: [],
      }, navigationState(), {
        subjectPresent: !state.subjectMissing,
      });
    }
    return buildAwarenessContextSnapshot(state.results, navigationState(), {
      subjectPresent: !state.subjectMissing,
    });
  },
  /**
   * Release Contact-owned camera tracking without discarding the selected
   * subject. Reset-to-globe uses this route so the normal Context FOCUS action
   * can explicitly return to the same contact, while delayed activation work
   * cannot silently reclaim the camera after the reset.
   * @returns {boolean} Whether a Contact subject remains selected.
   */
  releaseCameraOwnership({ preserveVesselSelection = false, origin = 'programmatic' } = {}) {
    ++state.activationId;
    state.autoFocusAttempted = true;
    state.autoFocusRetryPending = false;

    const preservedSelectionKey = subjectKey(state.subject) || 'camera-release';
    state.pendingSelectionKey = preservedSelectionKey;
    try {
      flightsLayer.stopTracking?.({ origin });
      militaryFlightsLayer.stopTracking?.({ origin });
      if (!preserveVesselSelection) aisLiveVesselsLayer.clearSelection?.();
    } finally {
      if (state.pendingSelectionKey === preservedSelectionKey) {
        state.pendingSelectionKey = null;
      }
    }
    return Boolean(state.subject);
  },
  navigatePrevious(options = {}) { return navigateHistory(-1, options); },
  focusCurrent(options = {}) { return focusCurrentSubject(options); },
  navigateNext(options = {}) { return navigateHistory(1, options); },
  /** Select a context target through its owning layer's established tracker. */
  focusTarget(layerId, id, options = {}) { return requestFocus(layerId, id, false, options); },
};

export default militaryAwarenessLayer;
