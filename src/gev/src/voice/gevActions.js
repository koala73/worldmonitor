import * as Cesium from 'cesium';
import { CITY_POIS, findPoiByName, flyToGlobeView, flyToLandmark, flyToPOI, flyToPresetLocation, GLOBE_VIEW, searchAndFlyTo } from '../locations.js';
import {
  getContextStore,
  getSelectedEntityContext,
  isContextRecordActive,
} from '../data/contextStore.js';
import { getNextIssPass } from '../data/satellites.js';
import { CCTV_FOCUS_RESULT } from '../data/cctv.js';
import { contextModeWord } from '../contextModePolicy.js';
import { createAnalystEngine } from '../data/analystEngine.js';
import { layerFeedState } from '../data/manager.js';
import militaryAwarenessLayer, {
  collectAircraftProximityWindow,
  contactsWindowFromSnapshot,
} from '../data/militaryAwareness.js';
import { initCameraVerbs, moveCamera, flyRoute, interruptCameraMotion, adjustOrbitRange } from '../cameraVerbs.js';
import { cachedGroundFloor, warmGroundFloor } from '../data/groundFloor.js';
import { isPickedWorldPosition } from '../data/scenePick.js';
import { resolveRegionRingForQuery } from '../annotations/annotationResolver.js';
import { normalizeRadioCountryInput } from '../data/radioCountry.js';
import { TR3B_CLASS } from '../data/tr3bRegistry.js';

const ALLOWED_STYLES = new Set(['normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow']);
const PANEL_ALIASES = new Map([
  ['data', 'data-panel'],
  ['data layers', 'data-panel'],
  ['layers', 'data-panel'],
  ['layer menu', 'data-panel'],
  ['data layer menu', 'data-panel'],
  ['locations', 'location-bar'],
  ['location', 'location-bar'],
  ['styles', 'control-panel'],
  ['filters', 'control-panel'],
  ['visual styles', 'control-panel'],
  ['cctv', 'cctv-panel'],
  ['cameras', 'cctv-panel'],
  ['radio', 'radio-panel'],
  ['internet radio', 'radio-panel'],
  ['radio stations', 'radio-panel'],
  ['context', 'global-context-panel'],
  ['context panel', 'global-context-panel'],
  ['global context', 'global-context-panel'],
  ['right context', 'global-context-panel'],
  ['context right panel', 'global-context-panel'],
  ['scenes', 'scene-panel'],
  ['scene', 'scene-panel'],
  ['post processing', 'pp-toggles'],
  ['hud controls', 'pp-toggles'],
  ['map stack', 'control-panel'],
  ['stack', 'control-panel'],
  ['basemap', 'control-panel'],
  ['map sources', 'control-panel'],
  ['sources', 'control-panel'],
]);

const PANEL_IDS = new Set(['data-panel', 'location-bar', 'control-panel', 'cctv-panel', 'radio-panel', 'global-context-panel', 'scene-panel', 'pp-toggles']);
const CONTEXT_MODE_ALIASES = new Map([
  ['off', 'off'],
  ['none', 'off'],
  ['clear', 'off'],
  ['contacts', 'flights'],
  ['contact', 'flights'],
  ['flights', 'flights'],
  ['space missions', 'space-missions'],
  ['space-mission', 'space-missions'],
  ['space mission', 'space-missions'],
  ['space-missions', 'space-missions'],
  ['missions', 'space-missions'],
]);
/**
 * Every model-readable field that carries a context-mode id, and what an
 * absent value means for each.
 *
 * `mode` always names a mode, so nothing is 'off'. `entering` and `priorMode`
 * are absent when there is no such mode at all — calling those 'off' would
 * assert a state that does not exist.
 */
const CONTEXT_MODE_RESULT_FIELDS = Object.freeze([
  { field: 'mode', emptyAs: 'off' },
  { field: 'entering', emptyAs: null },
  { field: 'priorMode', emptyAs: null },
]);

/** Nested results that are themselves context-mode payloads the model reads. */
const NESTED_CONTEXT_RESULT_FIELDS = Object.freeze(['context', 'contextRollback']);

/**
 * Report a context-mode payload in the tools' own vocabulary.
 *
 * `set_context_mode` accepts 'contacts' while the mode's internal id is
 * 'flights'. Reporting the internal id back made the model read
 * `mode:'flights'` as "Contacts is off" and refuse to answer from the Contacts
 * window counts sitting in the very same payload (field session
 * 2026-08-21). Secondary fields and nested transition/rollback results are
 * translated too — one leaked internal id is enough to recreate the confusion,
 * and a rollback result is exactly what the model reads when something went
 * wrong. Each internal id is kept alongside as `<field>Internal` for anything
 * reasoning about layers.
 * @param {object|null|undefined} state Any payload carrying context-mode fields.
 * @returns {object|null|undefined} The same payload, modes translated.
 */
function withContextModeVocabulary(state) {
  if (!state || typeof state !== 'object') return state;
  let out = state;
  const mutable = () => {
    if (out === state) out = { ...state };
    return out;
  };
  for (const { field, emptyAs } of CONTEXT_MODE_RESULT_FIELDS) {
    if (!(field in state)) continue;
    const internal = state[field] ?? null;
    const target = mutable();
    target[field] = contextModeWord(internal, { emptyAs });
    target[`${field}Internal`] = internal;
  }
  for (const field of NESTED_CONTEXT_RESULT_FIELDS) {
    const nested = state[field];
    if (!nested || typeof nested !== 'object') continue;
    const translated = withContextModeVocabulary(nested);
    if (translated !== nested) mutable()[field] = translated;
  }
  return out;
}

const COCKPIT_ACTION_ALIASES = new Map([
  ['next', 'next'],
  ['previous', 'previous'],
  ['prev', 'previous'],
  ['enter', 'enter'],
  ['exit', 'exit'],
  ['status', 'status'],
  ['state', 'status'],
  ['next military', 'next'],
  ['next military aircraft', 'next'],
  ['next helicopter', 'next'],
  ['next closest', 'next'],
  ['next closest helicopter', 'next'],
  ['next closest military', 'next'],
  ['go to next', 'next'],
]);
const COCKPIT_TARGET_LAYERS = new Set(['flights', 'military', 'ais-live-vessels', 'military-installations']);

const LAYER_ALIASES = new Map([
  ['flights', 'flights'],
  ['planes', 'flights'],
  ['aircraft', 'flights'],
  ['military', 'military'],
  ['military flights', 'military'],
  ['earthquakes', 'earthquakes'],
  ['quakes', 'earthquakes'],
  ['satellites', 'satellites'],
  ['space mission', 'rocket-launches'],
  ['space missions', 'rocket-launches'],
  ['missions', 'rocket-launches'],
  ['traffic', 'traffic'],
  ['street traffic', 'traffic'],
  ['cctv', 'cctv'],
  ['cameras', 'cctv'],
  ['radio', 'radio'],
  ['internet radio', 'radio'],
  ['radio stations', 'radio'],
  ['bikeshare', 'bikeshare'],
  ['bikes', 'bikeshare'],
  ['ais', 'ais-live-vessels'],
  ['ships', 'ais-live-vessels'],
  ['vessels', 'ais-live-vessels'],
  ['live vessels', 'ais-live-vessels'],
  ['datacenters', 'local-datacenters'],
  ['data centers', 'local-datacenters'],
  ['data centres', 'local-datacenters'],
  ['dams', 'local-dams'],
  ['submarine cables', 'telegeography-submarine-cables'],
  ['cables', 'telegeography-submarine-cables'],
  ['telegeography', 'telegeography-submarine-cables'],
  ['firms', 'local-firms'],
  ['fires', 'local-firms'],
  ['active fires', 'local-firms'],
]);

const CITY_ALIASES = new Map([
  ['new york', 'nyc'],
  ['new york city', 'nyc'],
  ['san francisco', 'sf'],
  ['washington', 'dc'],
  ['washington dc', 'dc'],
  ['washington d.c.', 'dc'],
]);

// Basemap stack vocabulary. Switching requires an explicit stack name
// ("Bing aerial", "road map", "OSM", "Google 3D") — any "satellite(s)"
// phrasing ALWAYS means the satellites DATA LAYER, never a basemap; the
// session instructions carry the decision table.
//
// Road phrasings resolve to OSM, the one shipped road basemap. Every alias
// must name a live `MAP_STACKS` id: an alias for a retired stack would resolve
// cleanly and then fail at the controller with "Unknown map stack", which reads
// to the operator as a broken command rather than a retired source.
const STACK_ALIASES = new Map([
  ['photoreal', 'photoreal'],
  ['google 3d', 'photoreal'],
  ['google', 'photoreal'],
  ['3d', 'photoreal'],
  ['photorealistic', 'photoreal'],
  ['bing-aerial', 'bing-aerial'],
  ['bing aerial', 'bing-aerial'],
  ['bing-labels', 'bing-labels'],
  ['bing labels', 'bing-labels'],
  ['labels', 'bing-labels'],
  ['aerial with labels', 'bing-labels'],
  ['osm', 'osm'],
  ['openstreetmap', 'osm'],
  ['open street map', 'osm'],
  ['road', 'osm'],
  ['roads', 'osm'],
  ['road map', 'osm'],
]);

/** Search order for track_entity across entity layer families. */
const TRACKABLE_FAMILIES = [
  { layerId: 'flights', kind: 'aircraft' },
  { layerId: 'military', kind: 'aircraft' },
  { layerId: 'ais-live-vessels', kind: 'vessel' },
  { layerId: 'satellites', kind: 'satellite' },
];

const FRAME_TARGETS = new Map([
  ['flights', 'flights'],
  ['planes', 'flights'],
  ['aircraft', 'flights'],
  ['military', 'military'],
  ['military flights', 'military'],
  ['satellites', 'satellites'],
  ['vessels', 'ais-live-vessels'],
  ['ships', 'ais-live-vessels'],
]);

const reverseGeocodeCache = new Map();
const reverseGeocodeInFlight = new Map();
const nearbyPlacesCache = new Map();
const nearbyPlacesInFlight = new Map();
const VISIBLE_ENTITY_SHORTLIST = 64;
const BASEMAP_CONTEXT_WAIT_MS = 1500;
const viewTargetCache = new WeakMap();

/**
 * Read one layer's authoritative visibility and lifecycle presentation state.
 * Falls back to stable enabled/disabled state for lightweight adapters that do
 * not expose the manager lifecycle API.
 * @param {object|null} dataManager Layer manager or lightweight adapter.
 * @param {string} layerId Registered layer identifier.
 * @param {object} [options] Fallback options.
 * @param {boolean} [options.fallbackEnabled=false] Observed state when no manager read is available.
 * @returns {{enabled:boolean,lifecycleState:string,lifecycleUncertain:boolean}} Lifecycle summary.
 */
export function readLayerLifecycleSummary(dataManager, layerId, { fallbackEnabled = false } = {}) {
  let lifecycle = null;
  try {
    lifecycle = dataManager?.getLayerLifecycleState?.(layerId) || null;
  } catch {
    lifecycle = null;
  }
  if (lifecycle) {
    const enabled = Boolean(lifecycle.enabled);
    return {
      enabled,
      lifecycleState: lifecycle.lifecycleState || (enabled ? 'enabled' : 'disabled'),
      lifecycleUncertain: Boolean(lifecycle.uncertain ?? lifecycle.lifecycleUncertain),
    };
  }

  let enabled = Boolean(fallbackEnabled);
  try {
    const managerEnabled = dataManager?.isEnabled?.(layerId);
    if (typeof managerEnabled === 'boolean') enabled = managerEnabled;
  } catch {
    // Retain the caller's observed fallback when the lightweight adapter fails.
  }
  return {
    enabled,
    lifecycleState: enabled ? 'enabled' : 'disabled',
    lifecycleUncertain: false,
  };
}

export function createGevActionRunner({ viewer, styleManager, dataManager, sceneDirector = null, annotations = null }) {
  installViewTargetPrewarm(viewer);
  initCameraVerbs(viewer, getViewTargetCartesian);
  return async function runGevAction(name, rawArgs = {}, runOptions = {}) {
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    const current = () => !runOptions.signal?.aborted
      && (typeof runOptions.isCurrent !== 'function' || runOptions.isCurrent());

    // Navigation tools interrupt any continuous camera motion (spec §1.1) —
    // checked FIRST because each handler returns.
    if (name === 'zoom_to_globe') {
      interruptCameraMotion(`nav:${name}`);
    }
    // Explicit navigation while TRACKING supersedes the follow camera —
    // otherwise the tracker drags the view back and "I flew there but can't
    // do anything" (field finding). track_entity manages its own handoff.
    if (name === 'zoom_to_globe' && viewer.trackedEntity) {
      stopAllTracking(viewer, dataManager);
    }

    // Zoom during an active orbit adjusts the orbit RADIUS (spiral in/out) —
    // a straight camera move would be snapped back by the per-frame lookAt.
    if (name === 'adjust_camera_zoom') {
      const zoomOut = String(args.direction || '').toLowerCase() === 'out';
      const amt = String(args.amount || 'medium').toLowerCase();
      const factor = { little: 1.25, medium: 1.6, lot: 2.4 }[amt] || 1.6;
      if (adjustOrbitRange(zoomOut ? factor : 1 / factor)) {
        return { ok: true, action: 'adjust_camera_zoom', direction: zoomOut ? 'out' : 'in', amount: amt, orbitRadiusAdjusted: true };
      }
    }

    if (name === 'set_layer_visibility') {
      const layerId = normalizeLayerId(args.layerId);
      if (!layerId) {
        throw new Error(`Unknown data layer: ${args.layerId || 'missing'}`);
      }
      if (!dataManager.layers.has(layerId)) {
        if (layerId === 'radio') {
          return {
            ok: false,
            action: 'set_layer_visibility',
            layerId,
            error: 'Radio layer unavailable',
            ...readLayerLifecycleSummary(dataManager, layerId),
          };
        }
        throw new Error(`Unknown data layer: ${args.layerId || 'missing'}`);
      }
      const enabled = Boolean(args.enabled);
      const changeOptions = { origin: 'voice' };
      if (runOptions.signal) changeOptions.signal = runOptions.signal;
      let changed = false;
      let changeError = null;
      let intentOutcome = null;
      try {
        if (typeof dataManager._setEnabledWithIntent === 'function') {
          const intent = dataManager._setEnabledWithIntent(layerId, enabled, changeOptions);
          changed = await intent.promise;
          if (Number.isInteger(intent.intentEpoch)) {
            intentOutcome = await dataManager._waitForVisibilityIntent?.(layerId, intent.intentEpoch);
          }
        } else {
          changed = await dataManager.setEnabled(layerId, enabled, changeOptions);
        }
        if (layerId === 'rocket-launches' || layerId === 'satellites') {
          await styleManager?._waitForContextLayerSettlement?.();
        }
      } catch (error) {
        changeError = error;
      }
      const lifecycleSummary = readLayerLifecycleSummary(dataManager, layerId);
      if (intentOutcome?.succeeded === false && intentOutcome.cancellationReason) {
        return {
          ok: false,
          action: 'set_layer_visibility',
          layerId,
          cancelled: true,
          phase: intentOutcome.phase,
          cancellationReason: intentOutcome.cancellationReason,
          successorIntentEpoch: intentOutcome.successorIntentEpoch,
          successorEnabled: intentOutcome.successorEnabled,
          successorOrigin: intentOutcome.successorOrigin,
          ...lifecycleSummary,
        };
      }
      const intentCommitted = intentOutcome?.succeeded === true;
      const current = !runOptions.signal?.aborted
        && (typeof runOptions.isCurrent !== 'function' || runOptions.isCurrent());
      if (!current && !intentCommitted) {
        return {
          ok: false,
          action: 'set_layer_visibility',
          layerId,
          cancelled: true,
          error: 'Layer request was superseded by a newer voice turn',
          ...lifecycleSummary,
        };
      }
      const settledEnabled = lifecycleSummary.enabled;
      const lifecycleSettled = lifecycleSummary.lifecycleState === (enabled ? 'enabled' : 'disabled')
        && !lifecycleSummary.lifecycleUncertain;
      if (changeError) {
        return {
          ok: false,
          action: 'set_layer_visibility',
          layerId,
          error: changeError?.message || `Could not ${enabled ? 'enable' : 'disable'} the requested layer`,
          ...lifecycleSummary,
        };
      }
      if (changed === false || settledEnabled !== enabled || !lifecycleSettled) {
        return {
          ok: false,
          action: 'set_layer_visibility',
          layerId,
          error: `Could not ${enabled ? 'enable' : 'disable'} the requested layer`,
          ...lifecycleSummary,
        };
      }
      if (enabled) _layerEnabledAt.set(layerId, Date.now());
      const layer = dataManager.getAll().find((item) => item.id === layerId);
      return {
        ok: true,
        action: 'set_layer_visibility',
        layerId,
        label: layer?.name || layerId,
        ...lifecycleSummary,
      };
    }

    if (name === 'select_nearest_aircraft') {
      const layerId = normalizeLayerId(args.layerId || 'flights');
      if (!['flights', 'military'].includes(layerId)) {
        return {
          ok: false,
          action: 'select_nearest_aircraft',
          error: 'Nearest-aircraft selection supports Flights or Military Flights only',
        };
      }
      const hasLocationId = Boolean(String(args.locationId || '').trim());
      const hasLocationQuery = Boolean(String(args.locationQuery || '').trim());
      const hasCoordinates = args.latitude != null
        && args.longitude != null
        && Number.isFinite(Number(args.latitude))
        && Number.isFinite(Number(args.longitude));
      if (!hasLocationId && !hasLocationQuery && !hasCoordinates) {
        return {
          ok: false,
          action: 'select_nearest_aircraft',
          stage: 'location',
          error: 'Nearest-aircraft selection needs a preset, place name, or latitude and longitude',
        };
      }
      const locationArgs = {
        waitForArrival: true,
        ...(args.locationId ? { locationId: args.locationId } : {}),
        ...(args.locationQuery ? { query: args.locationQuery } : {}),
        ...(hasCoordinates ? {
          latitude: Number(args.latitude),
          longitude: Number(args.longitude),
        } : {}),
      };
      const layer = await runGevAction('set_layer_visibility', {
        layerId,
        enabled: true,
      }, runOptions);
      if (layer?.ok !== true || !current()) {
        return {
          ok: false,
          action: 'select_nearest_aircraft',
          stage: 'layer',
          cancelled: !current() || Boolean(layer?.cancelled),
          error: layer?.error || `${layerId} could not be enabled`,
          layer,
        };
      }

      const location = await runGevAction('fly_to_location', locationArgs, runOptions);
      if (location?.ok !== true || !current()) {
        return {
          ok: false,
          action: 'select_nearest_aircraft',
          stage: 'location',
          cancelled: !current() || Boolean(location?.cancelled),
          error: location?.error || `Could not arrive at ${location?.label || args.locationQuery || args.locationId || 'the requested place'}`,
          location,
          layer,
        };
      }

      const layerModule = dataManager.layers.get(layerId)?.module || null;
      let refreshed = false;
      try {
        if (typeof dataManager.refreshLayer === 'function') {
          refreshed = await dataManager.refreshLayer(layerId, { signal: runOptions.signal });
        } else if (typeof layerModule?.update === 'function') {
          refreshed = (await layerModule.update(viewer, { signal: runOptions.signal })) !== false;
        }
      } catch {
        refreshed = false;
      }
      if (!refreshed || !current()) {
        return {
          ok: false,
          action: 'select_nearest_aircraft',
          stage: 'refresh',
          cancelled: !current(),
          error: !current()
            ? 'Nearest-aircraft refresh was cancelled'
            : `${layer.label || layerId} is enabled, but its destination refresh did not complete`,
          location,
          layer,
        };
      }
      const stats = layerModule?.getStats?.() || {};
      const source = String(stats.source || layerModule?.source || '').trim() || null;
      const feed = {
        state: layerFeedState({ ...stats, source }),
        source,
        count: Number.isFinite(Number(stats.count)) ? Number(stats.count) : null,
      };

      const nearest = await createAnalystEngine(analystProviders(viewer, dataManager, {
        recordLimitByLayer: { [layerId]: Number.MAX_SAFE_INTEGER },
      })).query({
        layers: [layerId],
        scope: { kind: 'view' },
        filters: [{ field: 'onGround', op: 'eq', value: false }],
        sortBy: 'distance',
        sortDir: 'asc',
        limit: 1,
      });
      const aircraft = nearest?.items?.[0] || null;
      if (!aircraft || !current()) {
        return {
          ok: false,
          action: 'select_nearest_aircraft',
          stage: 'nearest',
          cancelled: !current(),
          error: !current()
            ? 'Nearest-aircraft selection was cancelled'
            : (feed.state === 'unavailable'
              ? `${layer.label || layerId} is enabled, but ${feed.source || 'its aircraft feed'} is unavailable`
              : `${layer.label || layerId} is enabled${feed.state === 'fallback' ? ` on the ${feed.source || 'fallback'} feed` : ''}, but no airborne aircraft is loaded in the ${location.label || 'destination'} view yet`),
          location,
          layer,
          feed,
          count: nearest?.count || 0,
        };
      }

      const stableAircraftId = aircraft.icao24 || aircraft.id;
      const selection = await trackEntity(viewer, dataManager, styleManager, {
        query: stableAircraftId,
        layerId,
      });
      if (selection?.ok !== true) {
        return {
          ok: false,
          action: 'select_nearest_aircraft',
          stage: 'selection',
          error: selection?.error || 'The nearest airborne aircraft could not be selected',
          location,
          layer,
          feed,
          selection,
        };
      }
      return {
        ok: true,
        action: 'select_nearest_aircraft',
        location: location.label,
        layerId,
        label: selection.label,
        feed,
        aircraft: {
          id: stableAircraftId,
          callsign: aircraft.callsign || null,
          altitudeM: aircraft.altitudeM ?? null,
          distanceKm: aircraft.distanceKm ?? null,
          onGround: false,
        },
      };
    }

    if (name === 'set_visual_style') {
      const style = normalizeStyle(args.style);
      if (!style) throw new Error(`Unknown visual style: ${args.style || 'missing'}`);
      styleManager.setStyle(style);
      return { ok: true, action: 'set_visual_style', style };
    }

    if (name === 'set_panel_open') {
      const panelId = normalizePanelId(args.panelId || args.panel);
      if (!panelId) throw new Error(`Unknown panel: ${args.panelId || args.panel || 'missing'}`);
      const open = args.open !== false;
      setPanelOpen(styleManager, panelId, open);
      return { ok: true, action: 'set_panel_open', panelId, open };
    }

    if (name === 'set_context_mode') {
      if (!styleManager?.setContextMode) {
        return { ok: false, action: 'set_context_mode', error: 'Context mode control unavailable' };
      }
      const mode = normalizeContextMode(args.mode || args.contextMode);
      if (mode === null && args.mode != null && String(args.mode || '').trim() !== 'off') {
        return {
          ok: false,
          action: 'set_context_mode',
          error: `Unknown context mode: ${args.mode || 'missing'}`,
        };
      }
      const cancellationState = () => withContextModeVocabulary(
        typeof styleManager.getContextModeState === 'function'
          ? styleManager.getContextModeState()
          : {},
      );
      if (!current()) {
        return {
          ok: false,
          action: 'set_context_mode',
          cancelled: true,
          error: 'Context request was cancelled before it could run',
          ...cancellationState(),
        };
      }
      if (mode && mode !== 'off') {
        setPanelOpen(styleManager, 'global-context-panel', true);
      }
      const result = await styleManager.setContextMode(mode === 'off' ? null : mode, {
        signal: runOptions.signal,
        isCurrent: runOptions.isCurrent,
      });
      if (!current() && result?.ok !== true) {
        return {
          ...withContextModeVocabulary(result),
          ok: false,
          action: 'set_context_mode',
          cancelled: true,
          error: result?.error || 'Context request was cancelled before it completed',
          ...cancellationState(),
        };
      }
      const contactsWindow = ['contacts', 'flights'].includes(mode)
        ? activeContactsWindow()
        : null;
      return {
        ...withContextModeVocabulary(result),
        ...(contactsWindow ? { contactsWindow } : {}),
      };
    }

    if (name === 'control_cockpit') {
      if (!styleManager?.controlCockpit) {
        return { ok: false, action: 'control_cockpit', error: 'Cockpit control unavailable' };
      }
      const rawAction = args.action || args.command;
      const action = normalizeCockpitAction(rawAction);
      const notificationToken = args.notificationToken || null;
      if (!action) {
        return {
          ok: false,
          action: 'control_cockpit',
          error: `Unknown cockpit action: ${args.action || args.command || 'missing'}`,
        };
      }
      const inferred = normalizeCockpitNavigationHints(rawAction);
      const targetLayer = normalizeCockpitTargetLayer(
        args.targetLayer || inferred.targetLayer || args.layer || args.layerId,
      );
      const aircraftClass = normalizeAircraftClassFilter(args.aircraftClass || inferred.aircraftClass || args.type || args.filterType);
      let contextChangedForEntry = false;
      let priorContextMode = null;
      let rollbackTarget = null;
      if (action === 'enter' && typeof styleManager.setContextMode === 'function') {
        if (!current()) {
          return {
            ok: false,
            action: 'control_cockpit',
            cancelled: true,
            error: 'Cockpit entry was cancelled before it could run',
            state: styleManager.getCockpitState?.() || null,
          };
        }
        rollbackTarget = styleManager.getAircraftTrackingTarget?.() || null;
        const contextState = typeof styleManager.getContextModeState === 'function'
          ? styleManager.getContextModeState()
          : {};
        priorContextMode = contextState?.mode || null;
        const contactsReady = contextState?.mode === 'flights'
          && contextState?.active !== false
          && contextState?.changing !== true;
        if (!contactsReady) {
          const contextResult = await styleManager.setContextMode('flights', {
            signal: runOptions.signal,
            isCurrent: runOptions.isCurrent,
            // Cockpit entry establishes Contacts as its own precondition. That
            // is internal choreography, not an operator Context request, so it
            // must stay inert: claiming here would cancel a pending shared
            // style/detection restore the operator never overrode.
            claimVisualAuthority: false,
          });
          contextChangedForEntry = contextResult?.ok === true;
          if (contextResult?.ok !== true || !current()) {
            const contextRollback = contextChangedForEntry
              ? await styleManager.setContextMode(priorContextMode, {
                claimVisualAuthority: false,
              })
              : null;
            return {
              ok: false,
              action: 'control_cockpit',
              cancelled: !current() || Boolean(contextResult?.cancelled),
              error: contextResult?.error || 'Contacts context could not be established for Cockpit entry',
              context: contextResult ? withContextModeVocabulary(contextResult) : null,
              contextRollback: withContextModeVocabulary(contextRollback),
              state: styleManager.getCockpitState?.() || null,
            };
          }
        }
      }
      // Contacts activation can adopt a newer explicit aircraft selection.
      // Sample only after that transaction settles so an older voice snapshot
      // cannot overwrite the operator's newer choice.
      const selectedTarget = action === 'enter'
        ? selectedCockpitTarget(dataManager)
        : null;
      let cockpitResult;
      try {
        cockpitResult = await styleManager.controlCockpit(action, {
          notificationToken,
          targetLayer,
          aircraftClass,
          selectedTarget,
          rollbackTarget,
        });
      } catch (error) {
        cockpitResult = {
          ok: false,
          action: 'control_cockpit',
          error: error instanceof Error ? error.message : String(error),
          state: styleManager.getCockpitState?.() || null,
        };
      }
      if (action === 'enter' && cockpitResult?.ok !== true && contextChangedForEntry) {
        const contextRollback = await styleManager.setContextMode(priorContextMode, {
          // Undoing this action's own precondition — still choreography.
          claimVisualAuthority: false,
          ...(current() ? {
            signal: runOptions.signal,
            isCurrent: runOptions.isCurrent,
          } : {}),
        });
        return { ...cockpitResult, contextRollback: withContextModeVocabulary(contextRollback) };
      }
      return cockpitResult;
    }

    if (name === 'show_data_layers_menu') {
      const layerId = normalizeLayerId(args.layerId || args.layer);
      setPanelOpen(styleManager, 'data-panel', true);
      const focusedLayer = layerId && dataManager.layers.has(layerId)
        ? focusDataLayerRow(layerId)
        : null;
      return {
        ok: true,
        action: 'show_data_layers_menu',
        panelId: 'data-panel',
        focusedLayer,
        layers: dataManager.getAll()
          .filter((layer) => layer.showInTogglePanel !== false)
          .map((layer) => ({
          id: layer.id,
          name: layer.name,
          enabled: layer.enabled,
          count: layer.stats?.count || 0,
          })),
      };
    }

    if (name === 'fly_to_location') {
      return flyToRequestedLocation(viewer, args, {
        runImmediate: typeof styleManager?.runImmediateLocationNavigation === 'function'
          ? (navigate) => styleManager.runImmediateLocationNavigation(navigate)
          : null,
        beginDeferred: typeof styleManager?.beginDeferredLocationNavigation === 'function'
          ? () => styleManager.beginDeferredLocationNavigation()
          : null,
        reassertDeferred: typeof styleManager?.reassertDeferredLocationNavigation === 'function'
          ? (generation) => styleManager.reassertDeferredLocationNavigation(generation)
          : null,
        onStart: () => {
          if (typeof styleManager?.beginLocationNavigation === 'function') {
            styleManager.beginLocationNavigation();
            return;
          }
          interruptCameraMotion('nav:fly_to_location');
          if (viewer.trackedEntity) stopAllTracking(viewer, dataManager);
        },
      });
    }

    if (name === 'adjust_camera_zoom') {
      return adjustCameraZoom(viewer, args);
    }

    if (name === 'zoom_to_globe') {
      if (typeof styleManager?.resetToGlobeView === 'function') {
        return styleManager.resetToGlobeView();
      }
      const result = flyToGlobeView(viewer);
      return {
        ok: true,
        action: 'zoom_to_globe',
        heightKm: Math.round(GLOBE_VIEW.heightM / 1000),
        centeredOn: {
          latitude: Number(result.latitude.toFixed(2)),
          longitude: Number(result.longitude.toFixed(2)),
        },
      };
    }

    if (name === 'next_iss_pass') {
      return nextIssPass(viewer, args);
    }

    if (name === 'analyst_query') {
      return runAnalystQuery(viewer, dataManager, args);
    }

    if (name === 'move_camera') {
      return moveCamera(args, (navigate, releaseOptions) => runManagedVoiceNavigation(
        styleManager, 'camera', 'move_camera', navigate, releaseOptions,
      ));
    }

    if (name === 'fly_route') {
      return flyRoute(
        annotations?.list?.() || [],
        args,
        (lat, lon) => cachedGroundFloor(lat, lon),
        (navigate) => runManagedVoiceNavigation(styleManager, 'route', 'fly_route', navigate),
        (cells) => warmGroundFloor(cells),
      );
    }

    if (name === 'get_entity_context') {
      return getEntityContext(viewer, dataManager, styleManager, args);
    }

    if (name === 'get_current_view_state') {
      return getCurrentViewState(viewer, styleManager, dataManager, sceneDirector);
    }

    if (name === 'set_hud') {
      const out = { ok: true, action: 'set_hud' };
      if (args.layout != null) {
        const result = styleManager.setHudLayout(args.layout);
        if (!result.ok) return { ...result, action: 'set_hud' };
        Object.assign(out, result);
      }
      if (args.visible != null) {
        const result = styleManager.setHudVisible(args.visible);
        if (!result.ok) return { ...result, action: 'set_hud' };
        Object.assign(out, result);
      }
      return { ...out, hud: styleManager.getControlState().hud };
    }

    if (name === 'set_detection') {
      const result = styleManager.setDetection({
        enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
        mode: typeof args.mode === 'string' ? args.mode : undefined,
        densityPct: Number.isFinite(Number(args.densityPct)) ? Number(args.densityPct) : undefined,
        allocationStrategy: typeof args.allocationStrategy === 'string' ? args.allocationStrategy : undefined,
      });
      return { action: 'set_detection', ...result };
    }

    if (name === 'set_map_stack') {
      const stackId = normalizeStackId(args.stack);
      if (!stackId) throw new Error(`Unknown map stack: ${args.stack || 'missing'}`);
      const result = await styleManager.setMapStack(stackId);
      return { action: 'set_map_stack', requested: stackId, ...result };
    }

    if (name === 'set_post_processing') {
      const out = { ok: true, action: 'set_post_processing' };
      if (args.bloom && typeof args.bloom === 'object') {
        Object.assign(out, styleManager.setBloom({
          enabled: typeof args.bloom.enabled === 'boolean' ? args.bloom.enabled : undefined,
          intensityPct: Number.isFinite(Number(args.bloom.intensityPct)) ? Number(args.bloom.intensityPct) : undefined,
        }));
      }
      if (args.sharpen && typeof args.sharpen === 'object') {
        Object.assign(out, styleManager.setSharpen({
          enabled: typeof args.sharpen.enabled === 'boolean' ? args.sharpen.enabled : undefined,
          intensityPct: Number.isFinite(Number(args.sharpen.intensityPct)) ? Number(args.sharpen.intensityPct) : undefined,
        }));
      }
      return out;
    }

    if (name === 'control_scene') {
      return controlScene(sceneDirector, args);
    }

    if (name === 'control_cctv') {
      return controlCctv(dataManager, args, styleManager);
    }

    if (name === 'control_radio') {
      return controlRadio(viewer, dataManager, args, runOptions);
    }

    if (name === 'track_entity') {
      return trackEntity(viewer, dataManager, styleManager, args);
    }

    if (name === 'stop_tracking') {
      return stopAllTracking(viewer, dataManager);
    }

    if (name === 'frame_overhead') {
      return frameOverhead(viewer, dataManager, styleManager, args);
    }

    if (name === 'annotate_map') {
      return annotateMap(annotations, args);
    }

    if (name === 'clear_annotations') {
      return clearAnnotations(annotations);
    }

    throw new Error(`Unknown GEV tool: ${name}`);
  };
}

function selectedCockpitTarget(dataManager) {
  const selected = getSelectedEntityContext({ dataManager });
  if (!selected || !['flights', 'military'].includes(selected.layerId)) return null;
  const module = dataManager?.layers?.get(selected.layerId)?.module;
  if (!module?.trackById || typeof module.trackById !== 'function') return null;
  const id = String(selected.id || '').trim();
  return id ? { layerId: selected.layerId, id } : null;
}

// Abuse guards: a single tool call may not request more than this many marks,
// each route no more waypoints than this, and free-text fields are clamped so a
// runaway model call can't drive unbounded geocode/Overpass/OSRM/DOM work. These
// mirror the tool-schema caps (defense-in-depth: a direct or schema-ignoring call
// is still bounded here).
const MAX_ANNOTATIONS_PER_CALL = 24;
const MAX_ROUTE_POINTS = 12;
const MAX_TARGET_LEN = 200;
const MAX_LABEL_LEN = 120;

function clampStr(value, max) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Bound the free-text + array sizes inside one annotation spec before it reaches the engine. */
function sanitizeAnnotationSpec(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  const out = { ...spec };
  if (typeof out.target === 'string') out.target = clampStr(out.target, MAX_TARGET_LEN);
  if (typeof out.toTarget === 'string') out.toTarget = clampStr(out.toTarget, MAX_TARGET_LEN);
  if (typeof out.label === 'string') out.label = clampStr(out.label, MAX_LABEL_LEN);
  if (Array.isArray(out.points)) {
    out.points = out.points.slice(0, MAX_ROUTE_POINTS).map((p) => (
      p && typeof p === 'object' && typeof p.target === 'string'
        ? { ...p, target: clampStr(p.target, MAX_TARGET_LEN) }
        : p
    ));
  }
  return out;
}

/**
 * Draw "whiteboard" annotations on the 3D world to point out what the agent is
 * talking about. Place names are resolved to real-world coordinates (and OSM
 * footprints) by the annotation engine, so the agent never has to guess pixels.
 */
async function annotateMap(annotations, args = {}) {
  if (!annotations || typeof annotations.annotate !== 'function') {
    return { ok: false, action: 'annotate_map', error: 'Annotation engine unavailable' };
  }
  const raw = Array.isArray(args.annotations) ? args.annotations : [];
  if (!raw.length) {
    return { ok: false, action: 'annotate_map', error: 'No annotations supplied' };
  }
  if (raw.length > MAX_ANNOTATIONS_PER_CALL) {
    return {
      ok: false,
      action: 'annotate_map',
      error: `Too many annotations in one call (${raw.length}); max ${MAX_ANNOTATIONS_PER_CALL}. Mark fewer places, or split across calls.`,
    };
  }
  const requests = raw.map(sanitizeAnnotationSpec);
  const result = await annotations.annotate(requests, {
    // C1 invariant enforced in CODE (not just the prompt): the VOICE path NEVER clears as
    // a side effect of drawing — annotations accumulate/persist, and only an explicit
    // clear_annotations tool call wipes the board. (clearPrevious is intentionally ignored
    // here and removed from the annotate_map schema; the console/demo API still has it.)
    clearPrevious: false,
    persist: args.persist !== false,
    flyTo: Boolean(args.flyTo),
  });
  // Honesty: surface partial failure explicitly so the agent can tell the user
  // which place(s) it couldn't mark instead of implying everything appeared.
  const drewSome = result.drawn > 0;
  const someFailed = result.failed > 0;
  const failedLabels = [];
  for (const r of (result.results || [])) {
    if (r.ok) continue;
    // Route failures carry the specific missing waypoint name(s) in failedTargets;
    // everything else names its own label/target.
    if (Array.isArray(r.failedTargets) && r.failedTargets.length) failedLabels.push(...r.failedTargets);
    else failedLabels.push(r.target || r.label || 'an unnamed place'); // target (the place) before caption
  }
  return {
    ok: drewSome,
    action: 'annotate_map',
    drawn: result.drawn,
    failed: result.failed,
    partial: drewSome && someFailed,
    failedLabels: someFailed ? failedLabels : undefined,
    // A drawn route whose street routing was unavailable is a straight direct line,
    // not a real walking/driving route — flag it so the voice layer stays honest.
    routeFallback: (result.results || []).some((r) => r.ok && r.fallback),
    capped: Boolean(result.capped),
    // Progressive outlines: anchors are placed and returned immediately; footprints for
    // these items are still being traced and will appear on their own (or the mark
    // honestly stays a point). NOT a failure — the voice layer must not report it as one.
    outlinePending: (result.results || []).some((r) => r.ok && r.outlinePending) || undefined,
    items: result.results,
    // Keep `error` populated whenever ANYTHING failed (partial or total) so the
    // result never reads as a clean success — but keep it STATIC (no raw place text);
    // the actual names live only in the structured failedLabels DATA field, so the
    // model-facing prose can't carry injected instructions from a place name.
    error: someFailed ? 'Could not place one or more annotations' : null,
  };
}

function clearAnnotations(annotations) {
  if (!annotations || typeof annotations.clear !== 'function') {
    return { ok: false, action: 'clear_annotations', error: 'Annotation engine unavailable' };
  }
  annotations.clear();
  return { ok: true, action: 'clear_annotations' };
}

function normalizeStackId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  return STACK_ALIASES.get(raw) || null;
}

/**
 * Voice scene playback control. Playback is fire-and-forget: startScene
 * sequences shots for minutes and must not block the realtime tool loop.
 */
function controlScene(sceneDirector, args = {}) {
  if (!sceneDirector) {
    return { ok: false, action: 'control_scene', error: 'Scene director unavailable' };
  }
  const sceneAction = String(args.action || '').toLowerCase();

  if (sceneAction === 'list') {
    return { ok: true, action: 'control_scene', scenes: sceneDirector.listScenes(), ...sceneDirector.getPlaybackStatus() };
  }
  if (sceneAction === 'status') {
    return { ok: true, action: 'control_scene', ...sceneDirector.getPlaybackStatus() };
  }
  if (sceneAction === 'stop') {
    sceneDirector.stopScene('Stopped by voice');
    return { ok: true, action: 'control_scene', running: false };
  }
  if (sceneAction === 'next') {
    sceneDirector.runNextScene();
    return { ok: true, action: 'control_scene', advanced: true };
  }
  if (sceneAction === 'play') {
    if (sceneDirector.running) {
      return { ok: false, action: 'control_scene', error: 'A scene is already running — stop it first' };
    }
    const scene = args.sceneId
      ? sceneDirector.findSceneByQuery(args.sceneId)
      : (sceneDirector.listScenes()[0] || null);
    if (!scene) {
      return { ok: false, action: 'control_scene', error: `No scene matched "${args.sceneId || ''}"`, scenes: sceneDirector.listScenes() };
    }
    void sceneDirector.startScene(scene.id, { single: true });
    return { ok: true, action: 'control_scene', playing: scene.title, shots: scene.shots };
  }
  throw new Error(`Unknown scene action: ${args.action || 'missing'}`);
}

/** Voice CCTV control over the cctv layer module's public surface. */
export async function controlCctv(dataManager, args = {}, styleManager = null) {
  const action = String(args.action || '').toLowerCase();
  const cctv = dataManager.layers.get('cctv')?.module;
  if (!cctv) {
    return { ok: false, action: 'control_cctv', error: 'CCTV layer unavailable' };
  }

  if (action === 'enable' || action === 'disable') {
    await dataManager.setEnabled('cctv', action === 'enable', { origin: 'voice' });
    return { ok: true, action: 'control_cctv', enabled: dataManager.isEnabled('cctv') };
  }
  if (!dataManager.isEnabled('cctv')) {
    return { ok: false, action: 'control_cctv', error: 'CCTV layer is off — enable it first' };
  }

  const summarize = () => {
    const ui = cctv.getUIState?.() || {};
    return {
      activeCameraId: ui.activeCameraId || null,
      activeCamera: ui.activeCamera?.name || ui.activeCamera?.id || null,
      cameraCount: Array.isArray(ui.cameras) ? ui.cameras.length : (ui.count || 0),
      showCoverage: !!ui.showCoverage,
      coverageMode: ui.coverageMode || (ui.showCoverage ? 'on' : 'off'),
      showProjection: !!ui.showProjection,
      calibrationMode: !!ui.calibrationMode,
      autoHop: !!ui.autoHop,
    };
  };

  if (action === 'select') {
    const query = String(args.cameraQuery || '').trim().toLowerCase();
    if (!query) throw new Error('control_cctv select needs cameraQuery');
    const cams = cctv.getUIState?.()?.cameras || [];
    const match = cams.find((cam) => String(cam.id || '').toLowerCase() === query)
      || cams.find((cam) => String(cam.name || '').toLowerCase() === query)
      || cams.find((cam) => String(cam.name || '').toLowerCase().includes(query));
    if (!match) {
      return { ok: false, action: 'control_cctv', error: `No camera matched "${args.cameraQuery}"`, ...summarize() };
    }
    styleManager?.supersedeDeferredNavigation?.();
    const selected = cctv.selectCamera(match.id);
    const focusResult = selected
      ? cctv.focusCamera(match.id, 1.8)
      : CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    return {
      action: 'control_cctv',
      selected: match.name || match.id,
      ...summarize(),
      ...cctvVoiceFocusOutcome(focusResult, { cameraSelected: !!selected }),
    };
  }
  if (action === 'next' || action === 'prev') {
    styleManager?.supersedeDeferredNavigation?.();
    const nextId = cctv.cycleCamera(action === 'next' ? 1 : -1);
    const focusResult = nextId
      ? cctv.focusCamera(nextId, 1.8)
      : CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    return {
      action: 'control_cctv',
      ...summarize(),
      ...cctvVoiceFocusOutcome(focusResult, { cameraSelected: !!nextId }),
    };
  }
  if (action === 'nearest') {
    styleManager?.supersedeDeferredNavigation?.();
    const nearestId = cctv.focusNearest({ focus: false });
    const focusResult = nearestId
      ? cctv.focusCamera(nearestId, 1.8)
      : CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    return {
      action: 'control_cctv',
      ...summarize(),
      ...cctvVoiceFocusOutcome(focusResult, { cameraSelected: !!nearestId }),
    };
  }
  if (action === 'focus') {
    const activeId = cctv.getUIState?.()?.activeCameraId;
    if (activeId) styleManager?.supersedeDeferredNavigation?.();
    const focusResult = activeId
      ? cctv.focusCamera(activeId)
      : CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    return { action: 'control_cctv', ...summarize(), ...cctvVoiceFocusOutcome(focusResult) };
  }
  if (action === 'viewshed') {
    // Color-coded coverage volumes; enabled:false drops back to plain
    // coverage wireframes (not off — "hide coverage" is the coverage action).
    const next = (typeof args.enabled === 'boolean' && !args.enabled) ? 'on' : 'viewshed';
    dataManager.setLayerParams('cctv', { coverageMode: next }, { origin: 'voice' });
    return { ok: true, action: 'control_cctv', ...summarize() };
  }
  if (action === 'adjust') {
    const current = summarize();
    const next = typeof args.enabled === 'boolean' ? args.enabled : !current.calibrationMode;
    dataManager.setLayerParams('cctv', { calibrationMode: next }, { origin: 'voice' });
    return { ok: true, action: 'control_cctv', ...summarize() };
  }
  if (action === 'coverage') {
    const current = summarize();
    const next = typeof args.enabled === 'boolean' ? args.enabled : !current.showCoverage;
    dataManager.setLayerParams('cctv', { coverageMode: next ? 'on' : 'off' }, { origin: 'voice' });
    return { ok: true, action: 'control_cctv', ...summarize() };
  }
  if (action === 'projection' || action === 'autohop') {
    const key = action === 'projection' ? 'showProjection' : 'autoHop';
    const current = summarize();
    const next = typeof args.enabled === 'boolean' ? args.enabled : !current[key];
    dataManager.setLayerParams('cctv', { [key]: next }, { origin: 'voice' });
    return { ok: true, action: 'control_cctv', ...summarize() };
  }
  throw new Error(`Unknown CCTV action: ${args.action || 'missing'}`);
}

const RADIO_COUNTRY_CENTERS = new Map([
  ['us', { lat: 39.8, lon: -98.6, country: 'US', label: 'United States' }],
  ['usa', { lat: 39.8, lon: -98.6, country: 'US', label: 'United States' }],
  ['united states', { lat: 39.8, lon: -98.6, country: 'US', label: 'United States' }],
  ['united states of america', { lat: 39.8, lon: -98.6, country: 'US', label: 'United States' }],
]);

/** Resolve curated cities and common country requests without moving the camera. */
export function knownRadioLocation(query, locationId = '') {
  const requestedId = normalizeLocationId(locationId) || normalizeLocationId(query);
  const city = requestedId ? CITY_POIS[requestedId] : null;
  if (city) {
    const bounds = city.viewBounds;
    return {
      lat: bounds ? (bounds.southwest.lat + bounds.northeast.lat) / 2 : city.pois[0]?.lat,
      lon: bounds ? (bounds.southwest.lng + bounds.northeast.lng) / 2 : city.pois[0]?.lon,
      label: city.name,
      country: '',
    };
  }
  return RADIO_COUNTRY_CENTERS.get(String(query || '').trim().toLowerCase()) || null;
}

function radioCoordinatePair(args = {}) {
  const latitudeProvided = Object.hasOwn(args, 'latitude');
  const longitudeProvided = Object.hasOwn(args, 'longitude');
  const provided = latitudeProvided || longitudeProvided;
  const latitude = args.latitude;
  const longitude = args.longitude;
  const valid = latitudeProvided
    && longitudeProvided
    && typeof latitude === 'number'
    && typeof longitude === 'number'
    && Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
  return { provided, valid, latitude, longitude };
}

function radioActionIsCurrent(options = {}) {
  return !options.signal?.aborted
    && (typeof options.isCurrent !== 'function' || options.isCurrent());
}

function radioAbortError() {
  const error = new Error('Radio request was superseded by a newer voice turn');
  error.name = 'AbortError';
  return error;
}

async function resolveRadioLocation(args = {}, coordinates = radioCoordinatePair(args), options = {}) {
  if (!radioActionIsCurrent(options)) throw radioAbortError();
  if (coordinates.valid) {
    const { latitude, longitude } = coordinates;
    return { lat: latitude, lon: longitude, label: `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`, country: '' };
  }
  const query = String(args.locationQuery || '').trim();
  const known = knownRadioLocation(query, args.locationId);
  if (known) return known;
  if (!query) return null;
  const apiKey = window.__GOOGLE_MAPS_API_KEY__ || import.meta.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('No Google Maps API key available for Radio location search');
  const controller = new AbortController();
  const cancelFromTurn = () => controller.abort();
  if (options.signal?.aborted) throw radioAbortError();
  options.signal?.addEventListener('abort', cancelFromTurn, { once: true });
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}`;
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json();
    if (!radioActionIsCurrent(options)) throw radioAbortError();
    const result = body.status === 'OK' ? body.results?.[0] : null;
    if (!result?.geometry?.location) return null;
    return {
      lat: result.geometry.location.lat,
      lon: result.geometry.location.lng,
      label: result.formatted_address || query,
      country: '',
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancelFromTurn);
  }
}

/** Voice Radio controls over the Radio layer's public player surface. */
export async function controlRadio(viewer, dataManager, args = {}, options = {}) {
  const requestedAction = String(args.action || '').trim().toLowerCase();
  const coordinates = radioCoordinatePair(args);
  const hasSelectionCriteria = Boolean(
    args.category
    || args.locationId
    || args.locationQuery
    || coordinates.provided
    || args.country
    || args.stationQuery,
  );
  // Realtime models can reasonably interpret "play news near Austin" as Play
  // plus qualifiers. Play cannot honor those qualifiers, so normalize that
  // equivalent tool shape to Select instead of silently choosing the current
  // viewport's nearest station.
  const action = requestedAction === 'play' && hasSelectionCriteria
    ? 'select'
    : requestedAction;

  const readRadioLifecycle = () => readLayerLifecycleSummary(dataManager, 'radio');

  const radio = dataManager.layers.get('radio')?.module;
  if (!radio) {
    return {
      ok: false,
      action: 'control_radio',
      error: 'Radio layer unavailable',
      ...readRadioLifecycle(),
    };
  }
  const normalizedCountry = normalizeRadioCountryInput(args.country);
  let lastIntentOutcome = null;
  let lastIntentError = null;

  const intentSummary = () => (lastIntentOutcome ? {
    phase: lastIntentOutcome.phase,
    cancellationReason: lastIntentOutcome.cancellationReason || null,
    successorIntentEpoch: lastIntentOutcome.successorIntentEpoch ?? null,
    successorEnabled: lastIntentOutcome.successorEnabled ?? null,
    successorOrigin: lastIntentOutcome.successorOrigin ?? null,
  } : {});

  const cancelled = (summarize) => ({
    ok: false,
    action: 'control_radio',
    cancelled: true,
    error: 'Radio request was superseded by a newer voice turn',
    ...intentSummary(),
    ...summarize(),
  });

  const radioLifecycleIsSettled = (shouldEnable) => {
    const lifecycle = readRadioLifecycle();
    return lifecycle.enabled === shouldEnable
      && lifecycle.lifecycleState === (shouldEnable ? 'enabled' : 'disabled')
      && !lifecycle.lifecycleUncertain;
  };

  const setRadioEnabled = async (shouldEnable) => {
    lastIntentOutcome = null;
    lastIntentError = null;
    if (!radioActionIsCurrent(options)) return false;
    const enableOptions = { origin: 'voice' };
    // Both lifecycle directions can await module work. Let the manager own
    // the complete transaction so barge-in cancels it before a settled
    // visibility event can record explicit Context intent.
    if (options.signal) enableOptions.signal = options.signal;
    let result = false;
    try {
      if (typeof dataManager._setEnabledWithIntent === 'function') {
        const intent = dataManager._setEnabledWithIntent('radio', shouldEnable, enableOptions);
        result = await intent.promise;
        if (Number.isInteger(intent.intentEpoch)) {
          lastIntentOutcome = await dataManager._waitForVisibilityIntent?.('radio', intent.intentEpoch);
        }
      } else {
        result = await dataManager.setEnabled('radio', shouldEnable, enableOptions);
      }
    } catch (error) {
      lastIntentError = error;
      return false;
    }
    if (lastIntentOutcome?.succeeded === false) return false;
    if (!radioActionIsCurrent(options) && lastIntentOutcome?.succeeded !== true) return false;
    return result !== false && radioLifecycleIsSettled(shouldEnable);
  };

  const lifecycleFailure = (message, summarize) => ({
    ok: false,
    action: 'control_radio',
    cancelled: Boolean(lastIntentOutcome?.cancellationReason),
    error: lastIntentError?.message || message,
    ...intentSummary(),
    ...summarize(),
  });

  const authorizeRadioPlayerMutation = async ({ enableIfOff = false } = {}) => {
    const lifecycle = readRadioLifecycle();
    if (radioLifecycleIsSettled(true)) return true;
    if (
      !enableIfOff
      && !lifecycle.enabled
      && lifecycle.lifecycleState === 'disabled'
      && !lifecycle.lifecycleUncertain
    ) return false;
    const reconciled = await setRadioEnabled(true);
    return reconciled && radioLifecycleIsSettled(true);
  };

  const summarize = () => {
    const state = radio.getUIState?.() || {};
    return {
      radioAction: action,
      ...readRadioLifecycle(),
      stationId: state.selected?.id || null,
      category: state.filter || 'all',
      audioState: state.audioState || 'stopped',
      volumePct: Math.round((state.volume ?? 0.8) * 100),
      mutedForVoice: Boolean(state.voiceDucked),
    };
  };

  if (!normalizedCountry.valid) {
    return {
      ok: false,
      action: 'control_radio',
      error: 'Radio country must be a recognized code or country name (80 characters maximum)',
      ...summarize(),
    };
  }

  if (coordinates.provided && !coordinates.valid) {
    return {
      ok: false,
      action: 'control_radio',
      error: 'Radio coordinates require a complete numeric latitude/longitude pair in range',
      ...summarize(),
    };
  }

  if (!radioActionIsCurrent(options)) return cancelled(summarize);

  if (action === 'enable' || action === 'disable') {
    const shouldEnable = action === 'enable';
    const changed = await setRadioEnabled(shouldEnable);
    if (!radioActionIsCurrent(options) && lastIntentOutcome?.succeeded !== true) return cancelled(summarize);
    if (!changed) {
      return lifecycleFailure(
        `Radio could not be ${shouldEnable ? 'enabled' : 'disabled'}`,
        summarize,
      );
    }
    return { ok: true, action: 'control_radio', ...summarize() };
  }
  if (action === 'status') return { ok: true, action: 'control_radio', ...summarize() };
  if (action === 'volume') {
    const volumePct = Number(args.volumePct);
    if (!Number.isFinite(volumePct) || volumePct < 0 || volumePct > 100) {
      return { ok: false, action: 'control_radio', error: 'Radio volume must be from 0 to 100', ...summarize() };
    }
    const authorized = await authorizeRadioPlayerMutation();
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    if (!authorized) {
      return lifecycleFailure('Radio must be fully enabled before changing volume', summarize);
    }
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    const volumeApplied = typeof dataManager.setLayerParams === 'function'
      ? dataManager.setLayerParams('radio', { volume: volumePct / 100 }, { origin: 'voice' })
      : radio.setVolume(volumePct / 100);
    if (volumeApplied === false) {
      return {
        ok: false,
        action: 'control_radio',
        error: 'Radio must be fully enabled before changing volume',
        ...summarize(),
      };
    }
    return { ok: true, action: 'control_radio', ...summarize() };
  }
  if (action === 'stop') {
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    let stopped = false;
    try {
      stopped = await radio.stopPlayback({ origin: 'voice' });
    } catch (error) {
      return {
        ok: false,
        action: 'control_radio',
        error: error?.message || 'Radio could not be stopped',
        ...summarize(),
      };
    }
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    if (stopped === false) {
      return {
        ok: false,
        action: 'control_radio',
        error: 'Radio could not be stopped',
        ...summarize(),
      };
    }
    return { ok: true, action: 'control_radio', ...summarize() };
  }
  if (action === 'pause') {
    // Pause is a playback-only control. In particular, a Pause sibling must
    // never resurrect a layer that an explicit Disable just turned off. Keep
    // its established cancellation authority while an enable is in flight:
    // the controller commits a successful Pause by aborting that older work.
    const lifecycle = readRadioLifecycle();
    if (!lifecycle.enabled && lifecycle.lifecycleState !== 'enabling') {
      return { ok: true, action: 'control_radio', changed: false, ...summarize() };
    }
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    const paused = radio.pause?.({ origin: 'voice' }) || false;
    if (!paused) {
      return {
        ok: false,
        action: 'control_radio',
        error: 'Radio could not be paused',
        ...summarize(),
      };
    }
    return { ok: true, action: 'control_radio', changed: true, ...summarize() };
  }
  let resolvedLocation = null;
  if (action === 'select') {
    try {
      // Resolve asynchronous user input before enabling Radio. That keeps an
      // interrupted lookup from mutating layer or station state after barge-in.
      resolvedLocation = await resolveRadioLocation(args, coordinates, options);
    } catch (error) {
      if (error?.name === 'AbortError' || !radioActionIsCurrent(options)) return cancelled(summarize);
      throw error;
    }
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    if ((args.locationQuery || args.locationId) && !resolvedLocation) {
      return { ok: false, action: 'control_radio', error: `Could not resolve Radio location "${args.locationQuery || args.locationId}"`, ...summarize() };
    }
  }
  const authorized = await authorizeRadioPlayerMutation({ enableIfOff: true });
  if (!radioActionIsCurrent(options)) return cancelled(summarize);
  if (!authorized) {
    return lifecycleFailure('Radio could not be enabled', summarize);
  }
  const state = radio.getUIState?.() || {};
  if (!radioActionIsCurrent(options)) return cancelled(summarize);
  if (!state.stationCount) {
    return { ok: false, action: 'control_radio', error: state.error || 'No healthy Radio stations are available', ...summarize() };
  }
  if (action === 'play' || action === 'resume') {
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    const prepared = state.selected
      ? true
      : radio.cycleStation?.(1, { focus: false, autoplay: false });
    return {
      ok: Boolean(prepared),
      action: 'control_radio',
      radioPlaybackRequested: Boolean(prepared),
      ...summarize(),
    };
  }
  if (action === 'next' || action === 'previous') {
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    if (args.category) {
      if (typeof dataManager.setLayerParams === 'function') {
        dataManager.setLayerParams('radio', { filter: String(args.category) }, { origin: 'voice' });
      } else {
        radio.setFilter(String(args.category));
      }
    }
    const selected = radio.cycleStation?.(action === 'next' ? 1 : -1, {
      focus: false,
      autoplay: false,
    });
    return {
      ok: Boolean(selected),
      action: 'control_radio',
      radioPlaybackRequested: Boolean(selected),
      ...summarize(),
    };
  }
  if (action === 'select') {
    const location = resolvedLocation;
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    const station = radio.selectRequestedStation?.({
      categoryId: String(args.category || 'all'),
      anchor: location ? { lat: location.lat, lon: location.lon } : null,
      country: normalizedCountry.empty
        ? String(location?.country || '')
        : normalizedCountry.code,
      stationQuery: String(args.stationQuery || ''),
    }, { autoplay: false });
    if (!station) {
      return { ok: false, action: 'control_radio', error: 'No Radio station matched that location and category', ...summarize() };
    }
    return {
      ok: true,
      action: 'control_radio',
      radioPlaybackRequested: true,
      requestedLocation: location?.label || null,
      ...summarize(),
    };
  }
  throw new Error(`Unknown Radio action: ${args.action || 'missing'}`);
}

/**
 * Maps a CCTV focus code to an honest voice-tool result.
 * @param {string|boolean} focusResult CCTV focus result code.
 * @param {Object} [options]
 * @param {boolean} [options.cameraSelected=false] Whether this action first selected a camera.
 * @returns {{ok: boolean, error: string|null}} Voice-facing result fields.
 */
export function cctvVoiceFocusOutcome(focusResult, { cameraSelected = false } = {}) {
  if (focusResult === CCTV_FOCUS_RESULT.FOCUSED || focusResult === true) {
    return { ok: true, error: null };
  }
  if (focusResult === CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW) {
    return {
      ok: false,
      error: cameraSelected
        ? 'Camera selected; tracking holds the view — say untrack to fly'
        : 'Camera active; tracking holds the view — say untrack first',
    };
  }
  if (focusResult === CCTV_FOCUS_RESULT.COCKPIT_ACTIVE) {
    return {
      ok: false,
      error: cameraSelected
        ? 'Camera selected; in cockpit — exit cockpit to fly to it'
        : 'In cockpit — exit cockpit to fly to a camera',
    };
  }
  return { ok: false, error: 'No active camera to focus' };
}

/**
 * Spoken name for a tracked entity descriptor.
 *
 * Aircraft follow the flight layers' label convention — callsign →
 * registration → icao24 — so the narrated name matches the readout and the
 * detection card instead of speaking a raw hex at a contact the UI is calling
 * `N123AB`. Vessels and satellites carry no `registration`, so that link
 * simply falls through to their own name/mmsi/noradId links.
 * @param {object} found - Layer descriptor from `findByQuery`.
 * @param {string} query - The spoken query, used as the last resort.
 * @returns {string} A non-empty display name.
 */
export function formatTrackedEntityLabel(found, query = '') {
  const text = (v) => String(v ?? '').trim();
  return text(found?.callsign)
    || text(found?.registration)
    || text(found?.name)
    || text(found?.icao24)
    || text(found?.mmsi)
    || text(found?.noradId)
    || String(query);
}

/** Finds and tracks/selects an entity by spoken query across layer families. */
async function trackEntity(viewer, dataManager, styleManager, args = {}) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('track_entity needs a query');

  // Fire queries route to the FIRMS layer's strongest detection
  if (/\bfires?\b/i.test(query)) {
    if (!dataManager.isEnabled('local-firms')) {
      return { ok: false, action: 'track_entity', query, error: 'The FIRMS fires layer is not enabled' };
    }
    const firms = dataManager.layers.get('local-firms')?.module;
    const strongest = firms?.getStrongestFire?.();
    if (!strongest) {
      return { ok: false, action: 'track_entity', query, error: 'No fire detections loaded yet' };
    }
    if (!Number.isFinite(strongest.latitude) || !Number.isFinite(strongest.longitude)) {
      return { ok: false, action: 'track_entity', query, error: 'The strongest fire has no usable position' };
    }
    return runManagedVoiceNavigation(styleManager, 'fire', 'track_entity', () => {
      flyToLandmark(viewer, strongest.latitude, strongest.longitude, {
        range: 14000, pitch: -50, heading: 0, buildingHeight: 0, duration: 2.2,
      });
      return {
        ok: true, action: 'track_entity', kind: 'fire', layerId: 'local-firms',
        label: strongest.label || 'Strongest fire',
        latitude: strongest.latitude, longitude: strongest.longitude,
        frp: strongest.frp ?? null,
      };
    });
  }

  const requested = args.layerId ? normalizeLayerId(args.layerId) : null;
  const families = TRACKABLE_FAMILIES.filter((family) => !requested || family.layerId === requested);
  const skippedDisabled = [];

  for (const family of families) {
    if (!dataManager.isEnabled(family.layerId)) {
      skippedDisabled.push(family.layerId);
      continue;
    }
    const module = dataManager.layers.get(family.layerId)?.module;
    if (!module || typeof module.findByQuery !== 'function') continue;
    const found = module.findByQuery(query);
    if (!found) continue;

    if (family.kind === 'vessel'
      && (!Number.isFinite(found.latitude) || !Number.isFinite(found.longitude))) {
      return {
        ok: false, action: 'track_entity', layerId: family.layerId, kind: family.kind,
        error: 'The matched vessel has no usable position',
      };
    }

    return runManagedVoiceNavigation(styleManager, family.kind, 'track_entity', () => {
      let trackedOk = false;
      if (family.kind === 'vessel') {
        trackedOk = !!module.selectById?.(found.mmsi);
        flyToLandmark(viewer, found.latitude, found.longitude, {
          range: 6000, pitch: -45, heading: 0, buildingHeight: 0, duration: 2.0,
        });
      } else if (family.kind === 'satellite') {
        trackedOk = !!module.trackById?.(found.noradId, { origin: 'voice' });
      } else {
        trackedOk = !!module.trackById?.(found.icao24, { origin: 'voice' });
      }

      return {
        ok: trackedOk,
        action: 'track_entity',
        layerId: family.layerId,
        kind: family.kind,
        // Aircraft follow the flight layers' label convention (callsign →
        // registration → icao24) so the spoken name matches what the UI shows;
        // `registration` is absent on vessels/satellites and simply falls
        // through to their own name/id links.
        label: formatTrackedEntityLabel(found, query),
        latitude: found.latitude ?? null,
        longitude: found.longitude ?? null,
        altitudeM: Number.isFinite(found.altitudeM) ? Math.round(found.altitudeM) : null,
        error: trackedOk ? null : 'Match found but tracking failed',
      };
    });
  }

  const disabledNote = skippedDisabled.length ? ` (disabled layers skipped: ${skippedDisabled.join(', ')})` : '';
  return { ok: false, action: 'track_entity', query, error: `Nothing matched "${query}"${disabledNote}` };
}

/** Releases tracking/selection on every entity layer family. */
function stopAllTracking(viewer, dataManager) {
  const released = [];
  const failed = new Set();
  for (const family of TRACKABLE_FAMILIES) {
    const module = dataManager.layers.get(family.layerId)?.module;
    if (!module) continue;
    try {
      if (family.kind === 'vessel') {
        if (module.getSelectedInfo?.()) {
          if (typeof module.clearSelection !== 'function' || module.clearSelection() === false) {
            failed.add(family.layerId);
          } else {
            released.push(family.layerId);
          }
        }
      } else if (module.getTrackedInfo?.()) {
        if (typeof module.stopTracking !== 'function' || module.stopTracking({ origin: 'voice' }) === false) {
          failed.add(family.layerId);
        } else {
          released.push(family.layerId);
        }
      }
    } catch {
      failed.add(family.layerId);
    }
  }
  for (const [layerId, key] of [
    ['flights', 'selectedFlightsTrackingId'],
    ['military', 'selectedMilitaryTrackingId'],
    ['satellites', 'selectedSatTrackingId'],
  ]) {
    try {
      if (dataManager.setLayerParams(layerId, { [key]: null }, { origin: 'voice' }) === false) {
        failed.add(layerId);
      }
    } catch {
      failed.add(layerId);
    }
  }
  if (viewer) viewer.trackedEntity = undefined;
  if (failed.size) {
    const failedLayerIds = [...failed];
    return {
      ok: false,
      action: 'stop_tracking',
      released,
      failedLayerIds,
      error: `Tracking could not be cleared for: ${failedLayerIds.join(', ')}`,
    };
  }
  return { ok: true, action: 'stop_tracking', released };
}

/**
 * Frames entities near the current view target with a cinematic pull-back:
 * oblique high pitch for aircraft/ships, shallow wide pitch for satellites.
 * When entries are found and detection is OFF, auto-enables panoptic
 * detection so the framed entities are labeled, and reports
 * detectionEnabled so the voice agent can mention labels are on.
 */
async function frameOverhead(viewer, dataManager, styleManager, args = {}) {
  const targetRaw = String(args.target || 'flights').toLowerCase();
  const layerId = FRAME_TARGETS.get(targetRaw) || normalizeLayerId(targetRaw) || 'flights';
  if (!dataManager.layers.has(layerId)) {
    return { ok: false, action: 'frame_overhead', error: `Unknown target layer: ${args.target}` };
  }
  if (!dataManager.isEnabled(layerId)) {
    return { ok: false, action: 'frame_overhead', layerId, error: `The ${layerId} layer is not enabled` };
  }
  const module = dataManager.layers.get(layerId)?.module;
  const isSatellites = layerId === 'satellites';
  const defaultRadiusKm = isSatellites ? 3000 : (layerId === 'ais-live-vessels' ? 120 : 150);
  const radiusKm = clampNumber(args.radiusKm, 10, 20000, defaultRadiusKm);
  const center = getViewTargetCartesian(viewer) || viewer.camera.positionWC;

  let entries = [];
  if (typeof module.getNearby === 'function') {
    entries = module.getNearby(center, radiusKm * 1000, 80) || [];
  } else if (typeof module.getAllPositions === 'function') {
    entries = (module.getAllPositions(800) || [])
      .filter((entry) => entry.position)
      .map((entry) => ({ ...entry, distance: Cesium.Cartesian3.distance(center, entry.position) }))
      .filter((entry) => entry.distance <= radiusKm * 1000)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 80);
  }
  if (!entries.length) {
    return {
      ok: false, action: 'frame_overhead', layerId, radiusKm: Math.round(radiusKm), count: 0,
      error: `No ${targetRaw} within ${Math.round(radiusKm)} km of the current view`,
    };
  }

  const sphere = Cesium.BoundingSphere.fromPoints(entries.map((entry) => entry.position));
  sphere.radius = Math.max(sphere.radius * 1.25, 8000);
  const pitch = Cesium.Math.toRadians(isSatellites ? -35 : -62);
  return runManagedVoiceNavigation(styleManager, 'frame', 'frame_overhead', () => {
    viewer.camera.flyToBoundingSphere(sphere, {
      duration: 2.0,
      offset: new Cesium.HeadingPitchRange(viewer.camera.heading, pitch, sphere.radius * 2.4),
    });

    let detectionEnabled = false;
    try {
      const detectionState = styleManager?.getDetectionState?.();
      if (detectionState?.detectionMode === 'OFF') {
        const detectionResult = styleManager.setDetection({ mode: 'dense' });
        detectionEnabled = detectionResult?.ok === true;
      } else if (detectionState) {
        detectionEnabled = true;
      }
    } catch {
      // detection facade unavailable; framing still succeeded
    }

    return {
      ok: true,
      action: 'frame_overhead',
      layerId,
      radiusKm: Math.round(radiusKm),
      count: entries.length,
      detectionEnabled,
      nearest: entries.slice(0, 5).map((entry) => ({
        id: entry.id || entry.icao24 || entry.mmsi || null,
        label: entry.label || entry.callsign || entry.name || null,
      })),
    };
  });
}

/** Run one validated voice camera mutation through the UI-owned authority seam. */
function runManagedVoiceNavigation(styleManager, noun, action, navigate, releaseOptions = undefined) {
  if (typeof styleManager?.runImmediateNavigation !== 'function') {
    return { ok: false, action, error: 'Camera navigation policy unavailable' };
  }
  const result = styleManager.runImmediateNavigation(noun, navigate, releaseOptions);
  if (result !== false) return result;
  return { ok: false, action, error: 'Camera navigation is unavailable in the current view' };
}

/** Gathers tracked/selected entities across layer families for read-back. */
function collectTrackedEntities(dataManager) {
  const tracked = [];
  for (const family of TRACKABLE_FAMILIES) {
    const module = dataManager.layers.get(family.layerId)?.module;
    if (!module) continue;
    try {
      const info = family.kind === 'vessel' ? module.getSelectedInfo?.() : module.getTrackedInfo?.();
      if (info) tracked.push({ kind: family.kind, layerId: family.layerId, ...info });
    } catch {
      // layer not ready
    }
  }
  return tracked;
}

export async function getBasemapLabelContext(viewer) {
  const samples = sampleViewportCartographics(viewer);
  const cameraHeightM = viewer.camera.positionCartographic.height;
  const target = getViewTargetCartographic(viewer);
  if (!target) {
    return {
      placeLabels: [],
      streetLabels: [],
      nearbyPlaceLabels: [],
    };
  }

  const latitude = Number(Cesium.Math.toDegrees(target.latitude).toFixed(6));
  const longitude = Number(Cesium.Math.toDegrees(target.longitude).toFixed(6));
  const cachedViewportPlaces = viewportPlacesFromCache(samples, cameraHeightM);
  const viewportPromise = cachedViewportPlaces
    ? Promise.resolve(cachedViewportPlaces)
    : reverseGeocodeViewportSamples(samples, cameraHeightM);
  const placePromise = shouldReverseGeocode(cameraHeightM)
    ? reverseGeocode(latitude, longitude)
    : Promise.resolve(null);
  const nearbyPromise = shouldFetchNearbyPlaces(cameraHeightM)
    ? fetchNearbyPlaces(latitude, longitude, cameraHeightM)
    : Promise.resolve([]);
  const [viewportPlaces, place, nearbyPlaces] = await Promise.all([
    resolveWithin(viewportPromise, BASEMAP_CONTEXT_WAIT_MS, cachedViewportPlaces),
    resolveWithin(placePromise, BASEMAP_CONTEXT_WAIT_MS, null),
    resolveWithin(nearbyPromise, BASEMAP_CONTEXT_WAIT_MS, []),
  ]);

  return {
    placeLabels: uniqueStrings([
      place?.formattedAddress,
      place?.locality,
      place?.region,
      place?.country,
      ...(place?.labels || []),
      ...(viewportPlaces?.visibleLabels || []),
    ]).slice(0, 24),
    streetLabels: uniqueStrings([
      ...(place?.streetLabels || []),
      ...(viewportPlaces?.streetLabels || []),
    ]).slice(0, 16),
    nearbyPlaceLabels: uniqueStrings((nearbyPlaces || []).flatMap((nearbyPlace) => [
      nearbyPlace.name,
      nearbyPlace.address,
    ])).slice(0, 24),
  };
}

function installViewTargetPrewarm(viewer) {
  if (viewer.__gevViewTargetPrewarmInstalled) return;
  viewer.__gevViewTargetPrewarmInstalled = true;
  let timer = null;
  let reportedPrewarmFailure = false;
  viewer.camera.moveEnd.addEventListener(() => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      // Belt and braces. Validating the pick is the fix; this catch exists
      // because an idle callback is an UNCAUGHT context — nothing above it can
      // handle a surprise from the scene graph, and a red console error on a
      // plain camera flight is worse than a cold cache. Reported once per
      // viewer so a repeating cause cannot spam the console.
      const warm = () => {
        try {
          getViewTargetCartographic(viewer);
        } catch (error) {
          if (reportedPrewarmFailure) return;
          reportedPrewarmFailure = true;
          console.debug('[Voice] view-target prewarm skipped:', error?.message || error);
        }
      };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(warm, { timeout: 500 });
      } else {
        warm();
      }
    }, 120);
  });
}

function adjustCameraZoom(viewer, args) {
  const direction = String(args.direction || '').toLowerCase();
  if (direction !== 'in' && direction !== 'out') {
    throw new Error('adjust_camera_zoom direction must be "in" or "out"');
  }

  const amount = String(args.amount || 'little').toLowerCase();
  const fraction = {
    little: 0.25,
    medium: 0.55,
    lot: 1.0,
  }[amount];
  if (!fraction) throw new Error(`Unknown zoom amount: ${args.amount}`);

  const camera = viewer.camera;
  const beforePosition = Cesium.Cartesian3.clone(camera.positionWC);
  const beforeHeightM = camera.positionCartographic.height;
  const target = getViewTargetCartesian(viewer);
  const targetDistanceM = target
    ? Cesium.Cartesian3.distance(beforePosition, target)
    : Math.max(100, beforeHeightM);
  const minimumDistanceM = direction === 'in' ? 20 : 50;
  const movementM = Math.max(minimumDistanceM, targetDistanceM * fraction);

  camera.cancelFlight();
  if (direction === 'out') {
    camera.zoomOut(movementM);
  } else {
    const safeMovementM = Math.min(movementM, Math.max(0, targetDistanceM - 25));
    if (safeMovementM <= 0) {
      return {
        ok: false,
        action: 'adjust_camera_zoom',
        direction,
        amount,
        error: 'Camera is already at the minimum target distance',
      };
    }
    camera.zoomIn(safeMovementM);
  }
  viewer.scene.requestRender();

  const afterPosition = camera.positionWC;
  const movedM = Cesium.Cartesian3.distance(beforePosition, afterPosition);
  const afterHeightM = camera.positionCartographic.height;
  const moved = movedM >= 0.5;
  return {
    ok: moved,
    action: 'adjust_camera_zoom',
    direction,
    amount,
    movementRequestedM: Math.round(movementM),
    movementActualM: Math.round(movedM),
    beforeHeightM: Math.round(beforeHeightM),
    afterHeightM: Math.round(afterHeightM),
    error: moved ? null : 'Cesium camera position did not change',
  };
}

const COMPASS_16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

function compassDir(azDeg) {
  return COMPASS_16[Math.round(((((azDeg % 360) + 360) % 360)) / 22.5) % 16];
}

function nextIssPass(viewer, args) {
  let latDeg = Number.isFinite(args.latitude) ? args.latitude : null;
  let lonDeg = Number.isFinite(args.longitude) ? args.longitude : null;
  if (latDeg == null || lonDeg == null) {
    const carto = viewer?.camera?.positionCartographic;
    if (!carto) throw new Error('Camera position unavailable');
    latDeg = Cesium.Math.toDegrees(carto.latitude);
    lonDeg = Cesium.Math.toDegrees(carto.longitude);
  }
  const minElevDeg = Number.isFinite(args.minElevationDeg) ? args.minElevationDeg : 10;
  const result = getNextIssPass({ latDeg, lonDeg, minElevDeg });
  if (result.status === 'no-tle') {
    return {
      ok: false,
      action: 'next_iss_pass',
      error: 'ISS orbital elements not loaded yet — enable the satellites layer once, then ask again.',
    };
  }
  if (result.status === 'none') {
    return {
      ok: false,
      action: 'next_iss_pass',
      error: `No ISS pass above ${minElevDeg}° in the next 24 hours for this location.`,
    };
  }
  const { pass } = result;
  return {
    ok: true,
    action: 'next_iss_pass',
    observer: { latitude: latDeg, longitude: lonDeg },
    riseIso: new Date(pass.riseMs).toISOString(),
    minutesFromNow: Math.round((pass.riseMs - Date.now()) / 60000),
    durationMin: Math.max(1, Math.round((pass.setMs - pass.riseMs) / 60000)),
    peakElevationDeg: Math.round(pass.maxElevDeg),
    riseDirection: compassDir(pass.riseAzDeg),
  };
}

function normalizePanelId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (PANEL_IDS.has(raw)) return raw;
  return PANEL_ALIASES.get(raw.toLowerCase()) || null;
}

function normalizeLayerId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (LAYER_ALIASES.has(raw.toLowerCase())) return LAYER_ALIASES.get(raw.toLowerCase());
  return raw;
}

function normalizeCockpitTargetLayer(value) {
  const layerId = normalizeLayerId(value);
  if (!layerId || !COCKPIT_TARGET_LAYERS.has(layerId)) return null;
  return layerId;
}

function normalizeCockpitNavigationHints(rawAction) {
  const raw = String(rawAction || '').trim().toLowerCase();
  if (!raw) return {};

  const targetLayer = raw.includes('vessel') || raw.includes('ship') || raw.includes('ais')
    ? 'ais-live-vessels'
    : raw.includes('installation') || raw.includes('facility') || raw.includes('base')
      ? 'military-installations'
      : raw.includes('military')
        ? 'military'
        : null;

  const aircraftClass = raw.includes('helicopter') || raw.includes('helo') || raw.includes('chopper')
    ? 'helicopter'
    : null;

  return {
    targetLayer,
    aircraftClass,
  };
}

/**
 * Normalize a spoken/typed aircraft-class filter to the class id the analyst
 * records carry.
 *
 * Every real `classifyAircraft()` id is a single unpunctuated word, so callers
 * already say them exactly and a plain lower-case is enough. The one exception
 * is the TR-3B Easter egg (`tr3b`): people write and say it hyphenated, so
 * "TR-3B" / "tr 3b" / "tr 3 b" would otherwise reach the analyst as a value no
 * record matches. Collapsing spaces and hyphens and comparing against THAT ONE
 * id keeps this surgical — no general alias table, and no other class id
 * collapses to `tr3b`, so nothing else can be caught by it.
 *
 * App-side only: the voice tool schema and the model instructions are
 * untouched, so this costs no prompt-cache churn.
 * @param {*} value Raw class filter from the tool call or an utterance hint.
 * @returns {string|null} Class id, or null when nothing was supplied.
 */
function normalizeAircraftClassFilter(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  return raw.replace(/[\s-]+/g, '') === TR3B_CLASS ? TR3B_CLASS : raw;
}

function setPanelOpen(styleManager, panelId, open) {
  if (styleManager && typeof styleManager.setPanelCollapsed === 'function') {
    styleManager.setPanelCollapsed(panelId, !open, { explicit: true });
  } else {
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.toggle('collapsed', !open);
  }
}

function normalizeContextMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  return CONTEXT_MODE_ALIASES.get(raw) || null;
}

function normalizeCockpitAction(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;

  const direct = COCKPIT_ACTION_ALIASES.get(raw);
  if (direct) return direct;

  const normalized = raw
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const directNormalized = COCKPIT_ACTION_ALIASES.get(normalized);
  if (directNormalized) return directNormalized;

  if (/\bprevious\b|\bprev\b/.test(normalized)) return 'previous';
  if (/\bstatus\b|\bstate\b/.test(normalized)) return 'status';
  if (/\bexit\b|\bleave\b|\bquit\b/.test(normalized)) return 'exit';
  if (/\benter\b|\bopen\b|\bstart\b/.test(normalized)) return 'enter';
  if (/\bnext\b|\bclosest\b|\bnearby\b|\bnearest\b/.test(normalized)) return 'next';

  return null;
}

function focusDataLayerRow(layerId) {
  const row = document.querySelector(`#data-toggles [data-layer-id="${CSS.escape(layerId)}"]`);
  if (!row) return null;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('gev-voice-focus');
  void row.offsetWidth;
  row.classList.add('gev-voice-focus');
  window.setTimeout(() => row.classList.remove('gev-voice-focus'), 3000);
  const name = row.querySelector('.data-name')?.textContent?.trim() || layerId;
  return { id: layerId, name };
}


function normalizeStyle(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'filter off' || raw === 'off' || raw === 'default') return 'normal';
  if (raw === 'night vision' || raw === 'nvg') return 'surveillance';
  if (raw === 'flir') return 'thermal';
  if (ALLOWED_STYLES.has(raw)) return raw;
  return null;
}

async function flyToRequestedLocation(viewer, args, {
  onStart = null,
  runImmediate = null,
  beginDeferred = null,
  reassertDeferred = null,
} = {}) {
  const requestedRangeM = Number(args.rangeM);
  const rangeM = Number.isFinite(requestedRangeM)
    ? clampNumber(requestedRangeM, 100, 20000000, 900)
    : null;
  const locationId = normalizeLocationId(args.locationId || args.query);
  const immediate = (navigate) => (
    typeof runImmediate === 'function' ? runImmediate(navigate) : navigate()
  );
  const immediateOnStart = typeof runImmediate === 'function' ? null : onStart;
  const cancelled = (label) => ({
    ok: false,
    cancelled: true,
    action: 'fly_to_location',
    label,
  });
  let settleArrival = null;
  const arrival = args.waitForArrival === true
    ? new Promise((resolve) => { settleArrival = resolve; })
    : null;
  const arrivalHooks = arrival ? {
    onComplete: () => settleArrival?.('arrived'),
    onCancel: () => settleArrival?.('cancelled'),
  } : {};
  const afterArrival = async (result, label) => {
    if (!arrival || result?.ok !== true) return result;
    const status = await arrival;
    settleArrival = null;
    return status === 'arrived'
      ? { ...result, arrived: true }
      : cancelled(label);
  };

  if (locationId) {
    const result = immediate(() => flyToPresetLocation(viewer, locationId, {
      ...(rangeM || args.viewMode === 'close'
        ? { range: rangeM || 250 }
        : { viewMode: 'overview' }),
      duration: 2.2,
      onStart: immediateOnStart,
      ...arrivalHooks,
    }));
    if (result === false) return cancelled(CITY_POIS[locationId]?.name || locationId);
    const response = {
      ok: Boolean(result),
      action: 'fly_to_location',
      locationId,
      label: CITY_POIS[locationId]?.name || locationId,
      rangeM: result?.range ? Math.round(result.range) : (rangeM || null),
      navigationMode: rangeM
        ? 'explicit-range'
        : (args.viewMode === 'close' ? 'city-close' : (result?.navigationMode || 'city-overview')),
    };
    return afterArrival(response, response.label);
  }

  const latitude = Number(args.latitude);
  const longitude = Number(args.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const result = immediate(() => flyToLandmark(viewer, latitude, longitude, {
      range: rangeM || 250,
      pitch: -35,
      heading: 0,
      buildingHeight: 0,
      duration: 2.2,
      onStart: immediateOnStart,
      ...arrivalHooks,
    }));
    if (result === false) return cancelled(`${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
    const response = {
      ok: true,
      action: 'fly_to_location',
      latitude,
      longitude,
      label: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
      rangeM: Math.round(rangeM || 250),
      navigationMode: rangeM ? 'explicit-range' : 'close-coordinate',
    };
    return afterArrival(response, response.label);
  }

  const query = String(args.query || '').trim();
  if (query) {
    // A query that names a curated preset POI ("the Texas State Capitol", "Golden Gate Bridge")
    // flies to its hand-tuned camera pose — the same beautiful framing as clicking the LOCATIONS
    // panel button — instead of generic geocode framing. An explicit rangeM still overrides distance.
    const poiMatch = findPoiByName(query);
    if (poiMatch) {
      const result = immediate(() => flyToPOI(viewer, poiMatch.cityId, poiMatch.index, {
        duration: 2.2,
        onStart: immediateOnStart,
        ...arrivalHooks,
        ...(rangeM ? { range: rangeM } : {}),
      }));
      const poi = CITY_POIS[poiMatch.cityId]?.pois?.[poiMatch.index];
      if (result === false) return cancelled(poi?.name || query);
      const response = {
        ok: Boolean(result),
        action: 'fly_to_location',
        query,
        label: poi?.name || query,
        navigationMode: rangeM ? 'preset-poi-range' : 'preset-poi',
        rangeM: result?.range ? Math.round(result.range) : (rangeM || null),
      };
      return afterArrival(response, response.label);
    }

    const generation = typeof beginDeferred === 'function' ? beginDeferred() : null;
    if (generation === false) return cancelled(query);
    const managedDeferred = typeof reassertDeferred === 'function';
    const destination = await searchAndFlyTo(viewer, query, {
      ...(rangeM ? { range: rangeM } : {}),
      forceClose: args.viewMode === 'close',
      // 'overview' frames the geocode viewport even for precise-place results —
      // previously dropped here, so "overview of Zilker Park" flew to a rooftop.
      viewMode: args.viewMode || null,
      duration: 2.2,
      ...arrivalHooks,
      beforeFly: managedDeferred ? () => reassertDeferred(generation) : null,
      onStart: managedDeferred ? null : onStart,
    });
    if (destination?.cancelled) return cancelled(query);
    const response = {
      ok: Boolean(destination),
      action: 'fly_to_location',
      query,
      label: destination?.label || query,
      navigationMode: destination?.navigationMode || null,
      rangeM: destination?.rangeM || rangeM || null,
    };
    return afterArrival(response, response.label);
  }

  throw new Error('fly_to_location needs a locationId, query, or latitude/longitude');
}

function normalizeLocationId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (CITY_POIS[raw]) return raw;
  if (CITY_ALIASES.has(raw)) return CITY_ALIASES.get(raw);
  return null;
}

function getCurrentViewState(viewer, styleManager, dataManager, sceneDirector = null) {
  const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
  return {
    ok: true,
    action: 'get_current_view_state',
    camera: {
      latitude: Cesium.Math.toDegrees(cartographic.latitude),
      longitude: Cesium.Math.toDegrees(cartographic.longitude),
      heightM: cartographic.height,
    },
    style: styleManager.activeStyle || 'normal',
    context: typeof styleManager.getContextModeState === 'function'
      ? {
        ...withContextModeVocabulary(styleManager.getContextModeState()),
        // The numbers on the operator's Contacts panel, so a window/count
        // question can be answered from what they are looking at.
        ...(activeContactsWindow() ? { contactsWindow: activeContactsWindow() } : {}),
      }
      : null,
    cockpit: typeof styleManager.getCockpitState === 'function'
      ? styleManager.getCockpitState()
      : null,
    controls: typeof styleManager.getControlState === 'function' ? styleManager.getControlState() : null,
    scenePlayback: sceneDirector?.getPlaybackStatus?.() || null,
    tracked: collectTrackedEntities(dataManager),
    layers: dataManager.getAll().map((layer) => ({
      id: layer.id,
      name: layer.name,
      enabled: layer.enabled,
      count: layer.stats?.count || 0,
      error: layer.stats?.error || null,
    })),
  };
}

async function getEntityContext(viewer, dataManager, styleManager, args = {}) {
  const startedAt = performance.now();
  const scope = String(args.scope || 'auto').toLowerCase();
  const layerId = normalizeLayerId(args.layerId || args.layer);
  const limit = Math.round(clampNumber(args.limit, 1, 12, 5));
  const selected = selectedEntityContext(dataManager);
  const cameraHeightM = viewer.camera.positionCartographic.height;
  const viewTarget = getViewTargetCartographic(viewer);
  const scenePromise = getSceneContext(viewer, styleManager, dataManager, viewTarget);
  const selectedWillBeReturned = selected && (scope === 'selected' || scope === 'auto');
  const visible = (!selectedWillBeReturned && shouldScanVisibleEntities(cameraHeightM))
    ? visibleEntityContexts(viewer, dataManager, { layerId, limit, target: viewTarget })
    : [];
  const scene = await scenePromise;

  if ((scope === 'selected' || scope === 'auto') && selected) {
    logSlowContext(startedAt, 'selected');
    return {
      ok: true,
      action: 'get_entity_context',
      scope: 'selected',
      scene,
      selected,
    };
  }

  logSlowContext(startedAt, 'in_view');
  return {
    ok: true,
    action: 'get_entity_context',
    scope: 'in_view',
    scene,
    selected: selected || null,
    visible,
    count: visible.length,
    visibleScanSkipped: !shouldScanVisibleEntities(cameraHeightM),
  };
}

/**
 * Answer an entity-centred "how many aircraft nearby" from the Contacts
 * engine, or null when the question is not that.
 *
 * Applies only when the requested radius centre IS the active Contacts
 * subject: that is precisely the case where the operator can see a number on
 * the panel, so the spoken answer must be that number. Everything else — an
 * explicit region, an arbitrary point, a named place — keeps the general
 * record engine, which is what those questions actually mean.
 * @param {object} args Tool arguments.
 * @param {object} result The general engine's result, reused for scope text.
 * @returns {object|null} A unified-count payload, or null.
 */
function aircraftProximityWindowForQuery(args, result) {
  const scope = args?.scope;
  if (String(scope?.kind || '').toLowerCase() !== 'radius') return null;
  const layers = Array.isArray(args.layers) ? args.layers : [];
  if (!layers.some((layer) => layer === 'flights' || layer === 'military')) return null;
  const snapshot = militaryAwarenessLayer.getContextSnapshot?.();
  const subject = snapshot?.subject;
  if (!subject?.position) return null;
  // An explicit centre only qualifies when it IS the subject; otherwise the
  // operator asked about somewhere else and must get that answer.
  if (scope.center && !centerMatchesSubject(scope.center, subject.position)) return null;
  const radiusM = Number.isFinite(scope.km) ? scope.km * 1000 : (snapshot.radiusM || 250_000);
  const window = collectAircraftProximityWindow(subject.position, { radiusM, subject });
  if (!window) return null;
  const label = subject.label || subject.id || 'the selected contact';
  const radiusKm = Math.round(radiusM / 1000);
  const wanted = new Set(layers);
  const items = [
    ...(wanted.has('flights') ? window.flights.map((item) => ({ ...item, layerKey: 'flights' })) : []),
    ...(wanted.has('military') ? window.military.map((item) => ({ ...item, layerKey: 'military' })) : []),
  ];
  const count = items.length;
  return {
    ok: true,
    action: 'analyst_query',
    count,
    scopeLabel: `within ${radiusKm} km of ${label}`,
    truncated: false,
    items: items.slice(0, Math.round(clampNumber(args.limit, 1, 50, 12))).map((item) => ({
      layerKey: item.layerKey,
      id: item.id,
      ...(item.icao24 ? { icao24: item.icao24 } : {}),
      ...(item.callsign ? { callsign: item.callsign } : {}),
      ...(Number.isFinite(item.distance) ? { distanceKm: Math.round(item.distance / 100) / 10 } : {}),
    })),
    summary: { count },
    coverage: {
      layersQueried: result?.coverage?.layersQueried || [],
      scope: `window:${radiusKm}km@${label}`,
      followUp: false,
      note: 'Contacts window engine — the same computation and cohort the Contacts panel displays, so this count matches the panel exactly — counts cover loaded data; the flights layer loads by viewport.',
    },
    // (D) The answer always says whose window it is and which engine produced it.
    window: {
      engine: 'contacts-window',
      centeredOn: label,
      radiusKm,
      flights: window.flights.length,
      military: window.military.length,
      aircraft: window.aircraft,
    },
    ...(activeContactsWindow() ? { contactsWindow: activeContactsWindow() } : {}),
  };
}

/**
 * Radius within which a requested centre counts as the Contacts subject's own
 * position. Generous enough to absorb the fix-vs-display offset between what
 * the model read off a card and where the contact is now, tight enough that a
 * neighbouring landmark is never mistaken for the subject.
 */
const SUBJECT_CENTER_TOLERANCE_KM = 1;

/**
 * Is this requested centre the Contacts subject's own position?
 *
 * Measured as true ground distance. A lat/lon delta box was wrong in a way
 * that hid at the equator and widened toward it: a degree of longitude is
 * ~111 km at the equator and ~78 km at 45°, so a fixed 0.01° box spans a
 * different real distance at every latitude, and its diagonal admitted centres
 * ~1.5 km away — far enough to be a different place, close enough to slip
 * through and get answered as the subject's window.
 * @param {{lat: number, lon: number}} center Requested centre.
 * @param {Cesium.Cartesian3} subjectPosition Subject's world position.
 * @returns {boolean} True when the two are the same place.
 */
function centerMatchesSubject(center, subjectPosition) {
  if (!Number.isFinite(center?.lat) || !Number.isFinite(center?.lon)) return false;
  const carto = Cesium.Cartographic.fromCartesian(subjectPosition);
  if (!carto) return false;
  const subjectLat = Cesium.Math.toDegrees(carto.latitude);
  const subjectLon = Cesium.Math.toDegrees(carto.longitude);
  return haversineKm(subjectLat, subjectLon, center.lat, center.lon) <= SUBJECT_CENTER_TOLERANCE_KM;
}

function shouldScanVisibleEntities(cameraHeightM) {
  return cameraHeightM <= 100000;
}

function selectedEntityContext(dataManager) {
  const record = getSelectedEntityContext({ dataManager });
  if (!record) return null;
  return summarizeContextRecord(record, { includeProperties: true });
}

function visibleEntityContexts(viewer, dataManager, { layerId = null, limit = 5, target = null } = {}) {
  const nearbyRecords = [];
  const canvas = viewer.scene.canvas;
  const width = canvas.clientWidth || canvas.width || 0;
  const height = canvas.clientHeight || canvas.height || 0;
  const centerX = width / 2;
  const centerY = height / 2;
  const targetLat = target ? Cesium.Math.toDegrees(target.latitude) : null;
  const targetLon = target ? Cesium.Math.toDegrees(target.longitude) : null;
  const store = getContextStore();
  const enabledLayerIds = new Set(
    dataManager.getAll().filter((layer) => layer.enabled).map((layer) => layer.id)
  );

  for (const record of store.entities.values()) {
    if (layerId && record.layerId !== layerId) continue;
    if (record.layerId && !enabledLayerIds.has(record.layerId)) continue;
    if (record.entity?.show === false || record.dataSource?.show === false) continue;
    if (!Number.isFinite(record.latitude) || !Number.isFinite(record.longitude)) continue;
    insertNearestRecord(nearbyRecords, {
      record,
      distanceScore: target
        ? approximateCoordinateDistanceSq(targetLat, targetLon, record.latitude, record.longitude)
        : 0,
    }, VISIBLE_ENTITY_SHORTLIST);
  }

  const candidates = [];
  for (const { record } of nearbyRecords) {
    const position = record.entity?.__localBaseCartesian;
    if (!position) continue;
    const screen = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, position);
    if (!screen || screen.x < 0 || screen.y < 0 || screen.x > width || screen.y > height) continue;
    const dx = screen.x - centerX;
    const dy = screen.y - centerY;
    candidates.push({
      summary: summarizeContextRecord(record, { includeProperties: true }),
      distancePx: Math.sqrt(dx * dx + dy * dy),
    });
  }

  return candidates
    .sort((a, b) => a.distancePx - b.distancePx)
    .slice(0, limit)
    .map((item) => item.summary);
}

function insertNearestRecord(records, candidate, limit) {
  if (records.length < limit) {
    records.push(candidate);
    records.sort((a, b) => a.distanceScore - b.distanceScore);
    return;
  }
  if (candidate.distanceScore >= records[records.length - 1].distanceScore) return;

  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (records[middle].distanceScore <= candidate.distanceScore) low = middle + 1;
    else high = middle;
  }
  records.splice(low, 0, candidate);
  records.pop();
}

async function getSceneContext(viewer, styleManager, dataManager, viewTarget = null) {
  const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
  const basemap = await getBasemapContext(viewer, viewTarget);
  const enabledLayers = dataManager.getAll()
    .filter((layer) => layer.enabled)
    .map((layer) => ({
      id: layer.id,
      name: layer.name,
      count: layer.stats?.count || 0,
      source: layer.source,
    }));
  return {
    camera: {
      latitude: Number(Cesium.Math.toDegrees(cartographic.latitude).toFixed(6)),
      longitude: Number(Cesium.Math.toDegrees(cartographic.longitude).toFixed(6)),
      heightM: Math.round(cartographic.height),
    },
    basemap,
    style: styleManager.activeStyle || 'normal',
    enabledLayers,
  };
}

async function getBasemapContext(viewer, viewTarget = null) {
  const target = viewTarget;
  const samples = sampleViewportCartographics(viewer);
  const cameraCartographic = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
  const cameraHeightM = cameraCartographic.height;
  const viewScale = classifyViewScale(cameraHeightM);
  const cachedViewportPlaces = viewportPlacesFromCache(samples, cameraHeightM);
  const viewportPlacesPromise = cachedViewportPlaces
    ? Promise.resolve(cachedViewportPlaces)
    : reverseGeocodeViewportSamples(samples, cameraHeightM);
  if (!target) {
    const viewportPlaces = await resolveWithin(
      viewportPlacesPromise,
      BASEMAP_CONTEXT_WAIT_MS,
      cachedViewportPlaces
    );
    return {
      source: 'Google Photorealistic 3D Tiles / Cesium basemap',
      hasGoogle3DTiles: Boolean(window.__godsEyeView?.tileset),
      viewScale,
      viewportSamples: samples,
      viewportPlaces,
      target: null,
      place: null,
    };
  }

  const latitude = Number(Cesium.Math.toDegrees(target.latitude).toFixed(6));
  const longitude = Number(Cesium.Math.toDegrees(target.longitude).toFixed(6));
  const inferredCountry = inferCountryFromSamples(samples);
  const knownLandmarks = nearbyKnownLandmarks(latitude, longitude, cameraHeightM);
  const fallbackPlace = coarseBasemapPlace(viewScale, latitude, longitude, inferredCountry);
  const cachedPlace = shouldReverseGeocode(cameraHeightM)
    ? reverseGeocodeCache.get(reverseGeocodeKey(latitude, longitude)) || null
    : null;
  const nearbyCacheKey = nearbyPlacesCacheKey(latitude, longitude, cameraHeightM);
  const cachedNearbyPlaces = shouldFetchNearbyPlaces(cameraHeightM) && nearbyPlacesCache.has(nearbyCacheKey)
    ? nearbyPlacesCache.get(nearbyCacheKey)
    : null;
  const placePromise = shouldReverseGeocode(cameraHeightM) && !cachedPlace
    ? reverseGeocode(latitude, longitude)
    : Promise.resolve(cachedPlace);
  const nearbyPlacesPromise = shouldFetchNearbyPlaces(cameraHeightM) && !cachedNearbyPlaces
    ? fetchNearbyPlaces(latitude, longitude, cameraHeightM)
    : Promise.resolve(cachedNearbyPlaces);
  const [viewportPlaces, resolvedPlace, resolvedNearbyPlaces] = await Promise.all([
    resolveWithin(viewportPlacesPromise, BASEMAP_CONTEXT_WAIT_MS, cachedViewportPlaces),
    resolveWithin(placePromise, BASEMAP_CONTEXT_WAIT_MS, cachedPlace),
    resolveWithin(nearbyPlacesPromise, BASEMAP_CONTEXT_WAIT_MS, cachedNearbyPlaces),
  ]);
  const place = resolvedPlace || fallbackPlace;
  const nearbyPlaces = resolvedNearbyPlaces || [];
  return {
    source: 'Google Photorealistic 3D Tiles / Cesium basemap',
    hasGoogle3DTiles: Boolean(window.__godsEyeView?.tileset),
    viewScale,
    viewportSamples: samples,
    viewportPlaces,
    target: {
      latitude,
      longitude,
      heightM: Math.round(target.height || 0),
    },
    knownLandmarks,
    nearbyPlaces,
    place,
  };
}

function classifyViewScale(cameraHeightM) {
  if (cameraHeightM > 12000000) return 'global';
  if (cameraHeightM > 3000000) return 'continental';
  if (cameraHeightM > 750000) return 'regional';
  if (cameraHeightM > 100000) return 'metro';
  if (cameraHeightM > 10000) return 'city';
  return 'local';
}

function shouldReverseGeocode(cameraHeightM) {
  return cameraHeightM <= 750000;
}

function shouldReverseGeocodeViewport(cameraHeightM) {
  return cameraHeightM <= 3000000;
}

function shouldFetchNearbyPlaces(cameraHeightM) {
  return cameraHeightM <= 25000;
}

function nearbyKnownLandmarks(latitude, longitude, cameraHeightM) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  const maxDistanceKm = cameraHeightM <= 5000
    ? 2
    : cameraHeightM <= 50000
      ? 10
      : cameraHeightM <= 250000
        ? 35
        : 0;
  if (maxDistanceKm <= 0) return [];

  const matches = [];
  for (const [cityId, city] of Object.entries(CITY_POIS)) {
    for (let poiIndex = 0; poiIndex < city.pois.length; poiIndex++) {
      const poi = city.pois[poiIndex];
      const distanceKm = haversineKm(latitude, longitude, poi.lat, poi.lon);
      if (distanceKm > maxDistanceKm) continue;
      matches.push({
        name: poi.name,
        cityId,
        city: city.name,
        latitude: poi.lat,
        longitude: poi.lon,
        distanceKm: Number(distanceKm.toFixed(3)),
      });
    }
  }
  return matches.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 5);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (value) => Cesium.Math.toRadians(value);
  const radiusKm = 6371.0088;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * radiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function coarseBasemapPlace(viewScale, latitude, longitude, inferredCountry = null) {
  if (viewScale === 'global') {
    return {
      formattedAddress: 'Global Earth view',
      locality: null,
      region: null,
      country: null,
      precision: 'global',
      note: 'Camera is too far out for a precise street or city label; do not infer a local place from the center point.',
    };
  }
  return {
    formattedAddress: inferredCountry?.country
      ? `${viewScale[0].toUpperCase()}${viewScale.slice(1)} basemap view over ${inferredCountry.country}`
      : `${viewScale[0].toUpperCase()}${viewScale.slice(1)} basemap view centered near ${latitude.toFixed(2)}, ${longitude.toFixed(2)}`,
    locality: null,
    region: null,
    country: inferredCountry?.country || null,
    precision: viewScale,
    confidence: inferredCountry?.confidence || null,
    note: 'Camera altitude is high, so this is approximate basemap context rather than a precise address.',
  };
}

function getViewTargetCartographic(viewer) {
  const signature = cameraViewSignature(viewer);
  const cached = viewTargetCache.get(viewer);
  if (cached?.signature === signature && performance.now() - cached.cachedAt < 2500) {
    return cached.target;
  }
  const position = getViewTargetCartesian(viewer);
  // `fromCartesian` still returns undefined for a point too near the ellipsoid
  // center to project; normalize that to the same "no target" null the callers
  // already handle for a missed pick.
  const target = position ? (Cesium.Cartographic.fromCartesian(position) || null) : null;
  viewTargetCache.set(viewer, {
    signature,
    target,
    cachedAt: performance.now(),
  });
  return target;
}

function cameraViewSignature(viewer) {
  const camera = viewer.camera;
  const cartographic = camera.positionCartographic;
  return [
    Cesium.Math.toDegrees(cartographic.latitude).toFixed(5),
    Cesium.Math.toDegrees(cartographic.longitude).toFixed(5),
    Math.round(cartographic.height / 2),
    camera.heading.toFixed(3),
    camera.pitch.toFixed(3),
  ].join(':');
}

/**
 * World position under the center of the viewport, or null when the view has no
 * target. Each stage of the cascade is validated before it is accepted: a depth
 * pick over empty sky can return a NaN or center-of-the-earth Cartesian, and
 * converting one of those throws deep inside Cesium. A degenerate pick is a
 * MISSED pick, so it falls through to the next stage rather than poisoning
 * every caller downstream.
 */
function getViewTargetCartesian(viewer) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const width = canvas.clientWidth || canvas.width || 0;
  const height = canvas.clientHeight || canvas.height || 0;
  const center = new Cesium.Cartesian2(width / 2, height / 2);
  let position = null;

  if (scene.pickPositionSupported && typeof scene.pickPosition === 'function') {
    try {
      position = scene.pickPosition(center);
    } catch {
      position = null;
    }
  }

  if (!isPickedWorldPosition(position)
    && viewer.camera && typeof viewer.camera.pickEllipsoid === 'function') {
    try {
      position = viewer.camera.pickEllipsoid(center, Cesium.Ellipsoid.WGS84);
    } catch {
      position = null;
    }
  }

  if (!isPickedWorldPosition(position)
    && viewer.camera && typeof viewer.camera.getPickRay === 'function') {
    try {
      const ray = viewer.camera.getPickRay(center);
      position = scene.globe?.pick(ray, scene) || null;
    } catch {
      position = null;
    }
  }

  return isPickedWorldPosition(position) ? position : null;
}

function sampleViewportCartographics(viewer) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const width = canvas.clientWidth || canvas.width || 0;
  const height = canvas.clientHeight || canvas.height || 0;
  if (!width || !height) return [];

  const points = [
    [0.5, 0.5],
    [0.25, 0.35],
    [0.75, 0.35],
    [0.25, 0.65],
    [0.75, 0.65],
    [0.5, 0.25],
    [0.5, 0.75],
  ];

  const samples = [];
  for (const [x, y] of points) {
    const cartesian = viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(width * x, height * y),
      Cesium.Ellipsoid.WGS84
    );
    if (!isPickedWorldPosition(cartesian)) continue;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) continue;
    samples.push({
      latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(4)),
      longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(4)),
    });
  }
  return samples;
}

function inferCountryFromSamples(samples) {
  if (!samples.length) return null;
  const counts = new Map();
  for (const sample of samples) {
    const country = inferCountry(sample.latitude, sample.longitude);
    if (!country) continue;
    counts.set(country, (counts.get(country) || 0) + 1);
  }
  if (!counts.size) return null;
  const [country, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    country,
    confidence: Number((count / samples.length).toFixed(2)),
    sampleCount: count,
    totalSamples: samples.length,
  };
}

function inferCountry(latitude, longitude) {
  const regions = [
    { name: 'Iran', south: 24.0, north: 40.2, west: 44.0, east: 63.5 },
    { name: 'Iraq', south: 29.0, north: 37.5, west: 38.5, east: 49.0 },
    { name: 'Turkey', south: 35.5, north: 42.5, west: 25.5, east: 45.2 },
    { name: 'Saudi Arabia', south: 16.0, north: 32.5, west: 34.0, east: 56.5 },
    { name: 'Afghanistan', south: 29.0, north: 38.8, west: 60.0, east: 75.5 },
    { name: 'Pakistan', south: 23.0, north: 37.2, west: 60.5, east: 77.5 },
    { name: 'Turkmenistan', south: 35.0, north: 42.9, west: 52.0, east: 66.8 },
    { name: 'Azerbaijan', south: 38.3, north: 41.9, west: 44.6, east: 50.8 },
    { name: 'Armenia', south: 38.7, north: 41.4, west: 43.4, east: 46.7 },
    { name: 'Japan', south: 24.0, north: 46.5, west: 122.0, east: 146.5 },
    { name: 'South Korea', south: 33.0, north: 38.8, west: 124.0, east: 132.0 },
    { name: 'North Korea', south: 37.5, north: 43.2, west: 124.0, east: 131.0 },
    { name: 'China', south: 18.0, north: 53.8, west: 73.0, east: 135.2 },
    { name: 'Russia', south: 41.0, north: 82.0, west: 19.0, east: 180.0 },
    { name: 'United States', south: 24.0, north: 49.8, west: -125.0, east: -66.0 },
  ];
  const region = regions.find((item) => (
    latitude >= item.south &&
    latitude <= item.north &&
    longitude >= item.west &&
    longitude <= item.east
  ));
  return region?.name || null;
}

async function reverseGeocode(latitude, longitude) {
  const apiKey = window.__GOOGLE_MAPS_API_KEY__;
  if (!apiKey || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const key = reverseGeocodeKey(latitude, longitude);
  if (reverseGeocodeCache.has(key)) return reverseGeocodeCache.get(key);
  if (reverseGeocodeInFlight.has(key)) return reverseGeocodeInFlight.get(key);

  const request = (async () => {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(`${latitude},${longitude}`)}&key=${apiKey}`;
      const response = await fetchWithTimeout(url, {}, 5000);
      const data = await response.json();
      if (data.status !== 'OK' || !data.results?.length) {
        reverseGeocodeCache.set(key, null);
        return null;
      }

      const result = data.results[0];
      const relevantResults = data.results.slice(0, 12);
      const components = Array.isArray(result.address_components) ? result.address_components : [];
      const component = (type) => components.find((item) => item.types?.includes(type))?.long_name || null;
      const labels = uniqueStrings(relevantResults.map((item) => item.formatted_address)).slice(0, 12);
      const streetLabels = uniqueStrings(relevantResults.flatMap((item) => {
        const itemComponents = Array.isArray(item.address_components) ? item.address_components : [];
        return itemComponents
          .filter((entry) => entry.types?.includes('route'))
          .map((entry) => entry.long_name);
      })).slice(0, 12);
      const place = {
        formattedAddress: result.formatted_address || null,
        locality: component('locality') || component('postal_town') || component('administrative_area_level_2'),
        region: component('administrative_area_level_1'),
        country: component('country'),
        types: result.types || [],
        labels,
        streetLabels,
      };
      reverseGeocodeCache.set(key, place);
      return place;
    } catch {
      return null;
    } finally {
      reverseGeocodeInFlight.delete(key);
    }
  })();
  reverseGeocodeInFlight.set(key, request);
  return request;
}

async function reverseGeocodeViewportSamples(samples, cameraHeightM) {
  if (!shouldReverseGeocodeViewport(cameraHeightM) || !samples.length) return null;
  // At building scale, center geocoding plus Nearby Places is more precise and
  // avoids three redundant Google requests.
  if (cameraHeightM <= 10000) return null;
  const prioritySamples = [samples[0], samples[1], samples[2]].filter(Boolean);
  const places = (await Promise.all(prioritySamples.map(async (sample) => {
    const place = await reverseGeocode(sample.latitude, sample.longitude);
    if (!place) return null;
    return {
      latitude: sample.latitude,
      longitude: sample.longitude,
      formattedAddress: place.formattedAddress,
      locality: place.locality,
      region: place.region,
      country: place.country,
      types: place.types,
      labels: place.labels,
      streetLabels: place.streetLabels,
    };
  }))).filter(Boolean);
  return summarizeViewportPlaces(places);
}

function viewportPlacesFromCache(samples, cameraHeightM) {
  if (!shouldReverseGeocodeViewport(cameraHeightM) || cameraHeightM <= 10000 || !samples.length) return null;
  const places = [samples[0], samples[1], samples[2]].filter(Boolean).flatMap((sample) => {
    const place = reverseGeocodeCache.get(reverseGeocodeKey(sample.latitude, sample.longitude));
    if (!place) return [];
    return [{
      latitude: sample.latitude,
      longitude: sample.longitude,
      formattedAddress: place.formattedAddress,
      locality: place.locality,
      region: place.region,
      country: place.country,
      types: place.types,
      labels: place.labels,
      streetLabels: place.streetLabels,
    }];
  });
  return summarizeViewportPlaces(places);
}

function summarizeViewportPlaces(places) {
  if (!places.length) return null;
  return {
    samples: places,
    dominantCountry: dominantValue(places.map((place) => place.country).filter(Boolean)),
    dominantRegion: dominantValue(places.map((place) => place.region).filter(Boolean)),
    dominantLocality: dominantValue(places.map((place) => place.locality).filter(Boolean)),
    visibleLabels: uniqueStrings(places.flatMap((place) => place.labels || [])).slice(0, 24),
    streetLabels: uniqueStrings(places.flatMap((place) => place.streetLabels || [])).slice(0, 20),
  };
}

async function fetchNearbyPlaces(latitude, longitude, cameraHeightM) {
  const radiusM = nearbyPlacesRadiusM(cameraHeightM);
  const cacheKey = nearbyPlacesCacheKey(latitude, longitude, cameraHeightM);
  if (nearbyPlacesCache.has(cacheKey)) return nearbyPlacesCache.get(cacheKey);
  if (nearbyPlacesInFlight.has(cacheKey)) return nearbyPlacesInFlight.get(cacheKey);

  const request = (async () => {
    try {
      const params = new URLSearchParams({
        lat: String(latitude),
        lon: String(longitude),
        radiusM: String(radiusM),
      });
      const response = await fetchWithTimeout(`/api/gev/google/nearby-places?${params}`, {}, 5000);
      const data = await response.json().catch(() => null);
      const places = response.ok && Array.isArray(data?.places)
      ? data.places.filter((place) => place?.name).slice(0, 12)
        : [];
      nearbyPlacesCache.set(cacheKey, places);
      return places;
    } catch {
      return [];
    } finally {
      nearbyPlacesInFlight.delete(cacheKey);
    }
  })();
  nearbyPlacesInFlight.set(cacheKey, request);
  return request;
}

function uniqueStrings(values) {
  return [...new Set(values
    .map((value) => sanitizeLabel(value))
    .filter(Boolean))];
}

/**
 * Normalize a feed-sourced label (place/street/POI name from OSM, geocoding,
 * Google Places, etc.) before it enters the voice LLM's scene context.
 * Collapses newlines/control chars to single spaces and hard-caps length, so
 * crafted map data can't smuggle multi-line "instructions" into the prompt.
 * Defense-in-depth — these are reference labels, not commands.
 * @param {*} value - Raw label value.
 * @returns {string} Sanitized single-line label (max 120 chars).
 */
function sanitizeLabel(value) {
  const text = String(value || '');
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    out += (code < 0x20 || code === 0x7f) ? ' ' : ch; // drop control chars incl. newlines
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function reverseGeocodeKey(latitude, longitude) {
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

function nearbyPlacesCacheKey(latitude, longitude, cameraHeightM) {
  const radiusM = nearbyPlacesRadiusM(cameraHeightM);
  return `${latitude.toFixed(4)},${longitude.toFixed(4)},${radiusM}`;
}

function nearbyPlacesRadiusM(cameraHeightM) {
  if (cameraHeightM <= 1000) return 500;
  if (cameraHeightM <= 5000) return 2000;
  return 5000;
}

async function resolveWithin(promise, timeoutMs, fallback) {
  let timeout = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((resolve) => {
        timeout = window.setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) window.clearTimeout(timeout);
  }
}

function approximateCoordinateDistanceSq(latA, lonA, latB, lonB) {
  const latDelta = latB - latA;
  const lonDelta = (lonB - lonA) * Math.cos(Cesium.Math.toRadians((latA + latB) / 2));
  return latDelta * latDelta + lonDelta * lonDelta;
}

function logSlowContext(startedAt, scope) {
  const durationMs = Math.round(performance.now() - startedAt);
  if (durationMs >= 500) {
    console.info(`[GEV Voice] ${scope} scene context completed in ${durationMs}ms`);
  }
}

function dominantValue(values) {
  if (!values.length) return null;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const [value, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    value,
    count,
    confidence: Number((count / values.length).toFixed(2)),
  };
}

function summarizeEntity(viewer, entity, { includeProperties = false } = {}) {
  const now = Cesium.JulianDate.now();
  if (entity.__gevContextId) {
    const store = window.__gevContextStore;
    const record = store?.entities?.get(entity.__gevContextId);
    if (record) return summarizeContextRecord(record, { includeProperties });
  }
  const props = propertyObject(entity);
  const layerId = entity.__localLayerId || props.layerId || null;
  const tags = props.tags || {};
  const label = cleanText(
    props.name ||
    tags.name ||
    tags['name:en'] ||
    tags.official_name ||
    tags.operator ||
    props.operator ||
    entity.name ||
    layerTitle(layerId)
  );
  const position = entity.__localBaseCartesian || entity.position?.getValue?.(now) || polygonCenter(entity, now);
  const carto = position ? Cesium.Cartographic.fromCartesian(position) : null;
  return {
    id: String(entity.id || ''),
    name: label || layerTitle(layerId),
    layerId,
    layerName: layerTitle(layerId),
    latitude: carto ? Number(Cesium.Math.toDegrees(carto.latitude).toFixed(6)) : null,
    longitude: carto ? Number(Cesium.Math.toDegrees(carto.longitude).toFixed(6)) : null,
    properties: includeProperties ? compactProperties(props) : undefined,
  };
}

function summarizeContextRecord(record, { includeProperties = false } = {}) {
  return {
    id: String(record.id || ''),
    name: cleanText(record.label || record.properties?.name) || layerTitle(record.layerId),
    layerId: record.layerId || null,
    layerName: record.layerName || layerTitle(record.layerId),
    source: record.source || null,
    latitude: record.latitude ?? null,
    longitude: record.longitude ?? null,
    properties: includeProperties ? compactProperties(record.properties || {}) : undefined,
    active: isContextRecordActive(record),
  };
}

function polygonCenter(entity, now) {
  const hierarchy = entity.polygon?.hierarchy?.getValue?.(now);
  const positions = hierarchy?.positions;
  if (!positions?.length) return null;
  return Cesium.BoundingSphere.fromPoints(positions).center;
}

function propertyObject(entity) {
  const raw = entity?.properties?.getValue?.(Cesium.JulianDate.now()) || {};
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

function compactProperties(props) {
  const preferredKeys = [
    'name',
    'operator',
    'owner',
    'brand',
    'addr:city',
    'addr:state',
    'country',
    'capacity',
    'output',
    'osm_id',
    'source',
  ];
  const flat = { ...props, ...(props.tags && typeof props.tags === 'object' ? props.tags : {}) };
  const result = {};
  for (const key of preferredKeys) {
    const value = cleanText(flat[key]);
    if (value) result[key] = value;
  }
  for (const [key, value] of Object.entries(flat)) {
    if (Object.keys(result).length >= 12) break;
    if (key === 'tags' || result[key] !== undefined) continue;
    const text = cleanText(value);
    if (text) result[key] = text;
  }
  return result;
}

function cleanText(value) {
  if (value == null || typeof value === 'object') return '';
  const text = String(value).trim();
  if (!text || text === 'undefined' || text === 'null') return '';
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function layerTitle(layerId) {
  if (layerId === 'local-datacenters') return 'Datacenter';
  if (layerId === 'local-dams') return 'Dam';
  if (layerId === 'telegeography-submarine-cables') return 'Submarine Cable';
  if (layerId === 'local-firms') return 'Active Fire';
  return layerId || 'Entity';
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

/**
 * Analyst query — spoken questions over data already on the client
 * ("how many flights over Texas?", "biggest fire near LA?", "which ships
 * are headed to Oakland?"). The ENGINE (analystEngine.js) does the query
 * logic; this wiring supplies live providers and compacts the result for
 * the voice payload. One engine per runner keeps follow-up memory
 * ("which of those is closest?") scoped to the session.
 */
/** layerId → epoch ms of last voice-driven enable (analyst warm-up honesty). */
const _layerEnabledAt = new Map();
let _analystEngine = null;
/** Layers whose loaded set follows the camera, so a loaded count is not a world count. */
const VIEWPORT_LOADED_LAYERS = new Set(['flights']);

/**
 * The Contacts panel's own counts, or null when Contacts has no subject.
 * Read through the awareness snapshot the panel renders, so the two cannot
 * diverge no matter which surface asks.
 * @returns {object|null} Panel-equivalent window counts.
 */
function activeContactsWindow() {
  try {
    return contactsWindowFromSnapshot(militaryAwarenessLayer.getContextSnapshot?.());
  } catch {
    return null;
  }
}

function analystProviders(viewer, dataManager, { recordLimitByLayer = null } = {}) {
  return {
    getRecords(layerKey) {
      const layer = dataManager.layers.get(layerKey);
      if (!layer || !dataManager.isEnabled(layerKey)) return [];
      const mod = layer.module;
      if (typeof mod?.getAnalystRecords !== 'function') return [];
      const requestedLimit = recordLimitByLayer?.[layerKey];
      return Number.isFinite(requestedLimit)
        ? (mod.getAnalystRecords(requestedLimit) || [])
        : (mod.getAnalystRecords() || []);
    },
    resolveRegionRing: (name) => resolveRegionRingForQuery(name),
    /**
     * The active Contacts subject, when there is one — the centre the operator
     * is reasoning about while Contacts is up. Null whenever Contacts is off,
     * so view-centred behaviour is unchanged outside it.
     * @returns {{lat: number, lon: number, label: string|null}|null} Subject centre.
     */
    getContextSubject() {
      const snapshot = militaryAwarenessLayer.getContextSnapshot?.();
      const subject = snapshot?.subject;
      if (!subject?.position) return null;
      const carto = Cesium.Cartographic.fromCartesian(subject.position);
      if (!carto) return null;
      return {
        lat: Cesium.Math.toDegrees(carto.latitude),
        lon: Cesium.Math.toDegrees(carto.longitude),
        label: subject.label || subject.id || null,
      };
    },
    getViewContext() {
      const carto = viewer.camera.positionCartographic;
      const altKm = carto.height / 1000;
      // View radius scales with altitude: street-level asks stay local,
      // country-level asks sweep wide. Clamped so "in view" is never absurd.
      const viewRadiusKm = Math.max(25, Math.min(2500, altKm * 1.6));
      return {
        lat: Cesium.Math.toDegrees(carto.latitude),
        lon: Cesium.Math.toDegrees(carto.longitude),
        viewRadiusKm,
      };
    },
  };
}

async function runAnalystQuery(viewer, dataManager, args = {}) {
  if (!_analystEngine) _analystEngine = createAnalystEngine(analystProviders(viewer, dataManager));
  const result = await _analystEngine.query({
    layers: Array.isArray(args.layers) ? args.layers : undefined,
    scope: args.scope,
    filters: Array.isArray(args.filters) ? args.filters : [],
    sortBy: args.sortBy || null,
    sortDir: args.sortDir,
    limit: args.limit,
    followUp: Boolean(args.followUp),
  });
  if (!result.ok) return { ok: false, action: 'analyst_query', error: result.error, coverage: result.coverage };
  // Compact payload for the voice model: identity + the fields queries sort/
  // filter on. The full record set stays engine-side for follow-ups.
  //
  // `icao24`/`mmsi` ride along because the tool instructions tell the model to
  // hand this result straight to track_entity, and `id` is a DISPLAY label
  // (callsign, else registration, else hex). A callsign-less contact therefore
  // handed track_entity a tail number the lookup could not resolve, and the
  // model burned the turn on retries (field session 2026-08-21, 23:48).
  const items = result.items.map((r) => {
    const compact = { layerKey: r.layerKey, id: r.id };
    for (const k of ['icao24', 'mmsi', 'registration', 'label', 'callsign', 'name', 'altitudeM', 'speedMps', 'speedKts', 'frp', 'magnitude', 'shipType', 'destination', 'operator', 'routeOrigin', 'routeDestination', 'aircraftClass', 'military', 'onGround', 'distanceKm', 'confidence', 'place']) {
      if (r[k] !== null && r[k] !== undefined) compact[k] = r[k];
    }
    return compact;
  });
  // Warm-up honesty: a layer enabled seconds ago hasn't finished its first
  // poll (entity layers render one interval behind live BY DESIGN) — tell the
  // model so a low count is narrated as "still loading", not as fact.
  const warming = (result.coverage?.layersQueried || [])
    .filter((l) => {
      const at = _layerEnabledAt.get(l.layerKey);
      return at && (Date.now() - at) < 45_000;
    })
    .map((l) => l.layerKey);
  if (warming.length) {
    result.coverage.warmup = `${warming.join(', ')} enabled moments ago — data is still loading; counts will rise for ~30-45s. Say so.`;
  }
  // A radius/view count over a viewport-loaded layer counts what is LOADED, and
  // the flights layer reloads as the camera moves — so this number can sit well
  // under the Contacts cohort without either being wrong. Say which is which.
  const scopeKind = String(args.scope?.kind || 'view').toLowerCase();
  const viewportScoped = (scopeKind === 'radius' || scopeKind === 'view')
    && (result.coverage?.layersQueried || [])
      .some((l) => VIEWPORT_LOADED_LAYERS.has(l.layerKey));
  if (viewportScoped && result.coverage) {
    result.coverage.note = `${result.coverage.note} — counts cover loaded data; the flights layer loads by viewport`;
  }
  // ENTITY-CENTRED NEARBY: answered by the SAME engine that fills the Contacts
  // panel, so the spoken number and the panel readout for one centre cannot
  // differ. The generic record/scope engine still owns explicit regions and
  // arbitrary points — only "how many aircraft around <this contact>" is
  // unified, because that is the question the panel is already answering.
  const entityWindow = aircraftProximityWindowForQuery(args, result);
  if (entityWindow) return entityWindow;

  const contactsWindow = activeContactsWindow();
  const aircraftQueried = (result.coverage?.layersQueried || [])
    .some((l) => l.layerKey === 'flights' || l.layerKey === 'military');
  // Both numbers, and which one answers the question. The window counts have
  // ridden along in `contactsWindow` for a while, and the live trial showed
  // that is not enough on its own: with Contacts active and a DATACENTER in
  // the selection slot, the model centred a radius on the datacenter, answered
  // 15, and then explained away the 111 sitting in the same payload ("that
  // number is from the Contacts window, and I wasn't using Contacts as the
  // source"). So the payload now states the relationship instead of leaving it
  // to be inferred from two bare numbers.
  const windowAircraft = Number.isFinite(contactsWindow?.aircraft) ? contactsWindow.aircraft : null;
  const proximityScoped = scopeKind === 'radius' || scopeKind === 'view';
  const countsReconciliation = (contactsWindow && aircraftQueried && proximityScoped && windowAircraft !== null)
    ? `Contacts is ACTIVE: its window holds ${windowAircraft} aircraft within `
      + `${contactsWindow.radiusKm} km of ${contactsWindow.centeredOn}, and that is the answer to a bare `
      + `"how many aircraft are nearby". This query measured something else — ${result.count} ${result.scopeLabel}. `
      + 'Give this one only if the operator asked about that specific area, and name both scopes if you give both.'
    : null;
  return {
    ok: true,
    action: 'analyst_query',
    count: result.count,
    // Every count names its scope in words; a bare number is what made two
    // honest answers look like a contradiction.
    scopeLabel: result.scopeLabel,
    truncated: result.truncated,
    items,
    summary: result.summary,
    coverage: result.coverage,
    // The panel's own numbers, carried so the answer can match what the
    // operator is looking at regardless of how the model reads the note.
    // Flattened alongside the object so the count and its subject cannot be
    // missed inside a nested shape.
    ...(contactsWindow && aircraftQueried
      ? {
        contactsWindow,
        contactsWindowCount: windowAircraft,
        contactsWindowSubject: contactsWindow.centeredOn || null,
      }
      : {}),
    ...(countsReconciliation ? { countsReconciliation } : {}),
  };
}
