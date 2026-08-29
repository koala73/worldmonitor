import * as Cesium from 'cesium';
import { BLOOM_INTENSITY_DEFAULT, BLOOM_SCALE_VERSION } from './bloom.js';
import {
  migrateDetectionState,
  normalizeAllocationStrategy,
} from './data/detectionPolicy.js';
import { clampScopeTerminusPct } from './scopeMask.js';
import { decodeLayerStateParams, encodeLayerStateParams } from './data/layerState.js';

/**
 * Share Links — URL Hash State Management
 *
 * Encodes camera position + style into the URL hash so links can be shared.
 * Format: #lat=37.77&lon=-122.42&alt=800&heading=0&pitch=-35&style=nvg&bloom=1&bi=84&bv=2&sharpen=0&si=65&hud=tactical&hv=1&dm=BALANCED&dd=50&da=elastic&kf=16&ko=0&cr=0&map=photoreal
 */

const DEBOUNCE_MS = 500;
const LEGACY_BLOOM_FALLBACK = 50;

// Style name mapping: internal → URL-friendly
const STYLE_TO_URL = {
  normal: 'normal',
  retro: 'crt',
  surveillance: 'nvg',
  thermal: 'flir',
  anime: 'anime',
  noir: 'noir',
  snow: 'snow',
};

const SHARE_UI_STATE_PARAM = 'ui';
const SHARE_STYLE_PARAMS_PARAM = 'sp';
const SHARE_CREATED_AT_PARAM = 'at';

const SHARE_PANEL_STATE_REGISTRY = Object.freeze([
  { id: 'control-panel', token: 'c', pinnable: true },
  { id: 'location-bar', token: 'l', pinnable: true },
  { id: 'data-panel', token: 'd', pinnable: false },
  { id: 'cctv-panel', token: 'v', pinnable: false },
  { id: 'radio-panel', token: 'r', pinnable: false },
  { id: 'scene-panel', token: 's', pinnable: false },
  { id: 'global-context-panel', token: 'g', pinnable: false },
  { id: 'pp-toggles', token: 'p', pinnable: false },
  { id: 'param-slider-panel', token: 'm', pinnable: false },
]);

const SHARE_PANEL_STATE_BY_TOKEN = Object.freeze(new Map(
  SHARE_PANEL_STATE_REGISTRY.map((entry) => [entry.token, entry]),
));

const URL_TO_STYLE = Object.fromEntries(
  Object.entries(STYLE_TO_URL).map(([k, v]) => [v, k])
);

const SHARE_STYLE_PARAM_REGISTRY = Object.freeze({
  retro: Object.freeze([
    { key: 'pixelation', token: 'p', min: 1, max: 10 },
    { key: 'distortion', token: 'd', min: 0, max: 1 },
    { key: 'instability', token: 'i', min: 0, max: 1 },
  ]),
  surveillance: Object.freeze([
    { key: 'gain', token: 'g', min: 0, max: 1 },
    { key: 'bloom', token: 'b', min: 0, max: 1 },
    { key: 'scanlineStr', token: 's', min: 0, max: 1 },
    { key: 'pixelation', token: 'p', min: 1, max: 6 },
  ]),
  thermal: Object.freeze([
    { key: 'sensitivity', token: 's', min: 0, max: 1 },
    { key: 'bloom', token: 'b', min: 0, max: 1 },
    { key: 'mode', token: 'm', min: 0, max: 1 },
    { key: 'pixelation', token: 'p', min: 1, max: 6 },
    { key: 'palette', token: 'a', min: 0, max: 1 },
  ]),
  anime: Object.freeze([
    { key: 'saturation', token: 's', min: 0, max: 2 },
    { key: 'edgeThick', token: 'e', min: 0, max: 1 },
  ]),
  noir: Object.freeze([
    { key: 'contrastAmt', token: 'c', min: 0, max: 2 },
    { key: 'grainAmt', token: 'g', min: 0, max: 1 },
    { key: 'vignetteAmt', token: 'v', min: 0, max: 1 },
  ]),
  snow: Object.freeze([
    { key: 'density', token: 'd', min: 0, max: 1 },
    { key: 'wind', token: 'w', min: 0, max: 1 },
  ]),
});

export class ShareLinkManager {
  constructor(viewer, {
    onRestore,
    isNavigationCurrent,
    cancelOwnedNavigation,
  } = {}) {
    this.viewer = viewer;
    this._onRestore = onRestore; // callback: ({ style, bloom, sharpen }) => void
    this._debounceTimer = null;
    this._currentStyle = 'normal';
    this._bloomEnabled = false;
    this._sharpenEnabled = false;
    this._bloomIntensity = BLOOM_INTENSITY_DEFAULT;
    this._bloomVersion = BLOOM_SCALE_VERSION;
    this._sharpenIntensity = 49;
    this._hudVariant = 'tactical';
    this._hudVisible = false;
    this._detectionMode = 'OFF';
    this._detectionDensity = 50;
    this._detectionAllocation = 'ELASTIC';
    this._detectionFadePct = 7;
    // Mirrors KEYHOLE_OUTSIDE_OPACITY_DEFAULT in celestialRing.js and the
    // slider's markup value (final value 2026-08-24: 5 -> 3 -> 1). This is the
    // state the link THIS session generates starts from, so it must match what
    // the session actually renders; the `ko` PARSE fallback below is a separate
    // question and deliberately stays at 5.
    this._detectionOutsideOpacityPct = 1;
    this._celestialRingEnabled = false;
    this._scopeEnabled = true;
    // Feather opens on a soft 11% scope-mask edge (final value 2026-08-24,
    // superseding the 08-22 hard-crop and 08-23 8% rulings) — mirrors
    // SCOPE_FEATHER_RATIO_DEFAULT in scopeMask.js and the slider's markup value.
    this._scopeFeatherPct = 11;
    // null = the altitude-adaptive terminus (the default). A number pins the
    // outside-fill opacity as a percent, 94..100. (`sce`, 2026-08-17)
    this._scopeTerminusPct = null;
    this._mapStack = 'photoreal';
    this._layerStateProvider = null;
    this._panelStateProvider = null;
    this._styleParamStateProvider = null;
    this._initialRestorePending = false;
    this._restoreAuthority = {
      visual: 0,
      map: 0,
      panels: new Map(),
    };
    this._destroyed = false;
    this._restoreGeneration = 0;
    this._activeCameraFlight = null;
    this._isNavigationCurrent = typeof isNavigationCurrent === 'function'
      ? isNavigationCurrent
      : () => true;
    this._cancelOwnedNavigation = typeof cancelOwnedNavigation === 'function'
      ? cancelOwnedNavigation
      : null;

    // Listen for camera changes
    this._removeCameraChanged = this.viewer.camera.changed.addEventListener(() => {
      this._scheduleUpdate();
    });
  }

  /**
   * Parse URL hash on page load. Returns parsed state or null.
   */
  parseInitialHash() {
    const hash = window.location.hash.slice(1);
    if (!hash) return null;

    const params = new URLSearchParams(hash);
    const lat = parseFloat(params.get('lat'));
    const lon = parseFloat(params.get('lon'));

    // Coordinates drive Cartesian conversion, so reject non-finite URL values
    // before marking a share restoration as pending. `parseFloat('Infinity')`
    // is not NaN and would otherwise reach Cesium asynchronously at startup.
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const parseOr = (value, fallback) => {
      const num = parseFloat(value);
      return Number.isFinite(num) ? num : fallback;
    };

    const restoredDetection = migrateDetectionState(
      params.get('dm') || 'OFF',
      parseOr(params.get('dd'), 50),
      50,
    );
    const style = URL_TO_STYLE[params.get('style')] || 'normal';
    const decodedLayerState = decodeLayerStateParams(params);
    const state = {
      lat,
      lon,
      alt: parseOr(params.get('alt'), 800),
      heading: parseOr(params.get('heading'), 0),
      pitch: parseOr(params.get('pitch'), -35),
      roll: parseOr(params.get('roll'), 0),
      style,
      styleParams: decodeStyleParamState(params, style),
      bloom: params.get('bloom') === '1',
      sharpen: params.get('sharpen') === '1',
      bloomIntensity: parseOr(params.get('bi'), LEGACY_BLOOM_FALLBACK),
      bloomVersion: parseOr(params.get('bv'), 1),
      sharpenIntensity: parseOr(params.get('si'), 49),
      hudVariant: params.get('hud') || 'tactical',
      hudVisible: params.get('hv') === '1',
      detectionMode: restoredDetection.enabled ? restoredDetection.profile : 'OFF',
      detectionDensity: restoredDetection.densityPct,
      detectionAllocation: normalizeAllocationStrategy(params.get('da')),
      detectionFadePct: Math.max(0, Math.min(40, Math.round(parseOr(params.get('kf'), 16)))),
      // Deliberately still 5 after the 2026-08-23 default moved to 3. Same rule
      // as `scf` below: this is the PARSE fallback for a link that predates
      // `ko`, and such a link was authored when 5 was what its author saw. Every
      // link since carries `ko` explicitly, because the generator always writes
      // the field — so nothing from the 5 % era depends on this number either
      // way. The first-run default is a different question, answered in
      // celestialRing.js.
      detectionOutsideOpacityPct: Math.max(0, Math.min(100, Math.round(parseOr(params.get('ko'), 5)))),
      celestialRing: params.has('cr') ? params.get('cr') === '1' : false,
      scopeEnabled: params.has('sc') ? params.get('sc') === '1' : true,
      // Deliberately still 35 through both later default moves (0 on
      // 2026-08-22, 8 on 2026-08-23). This is the PARSE fallback for a link that
      // predates `scf` entirely, and such a link was authored when 35 was what
      // its author saw — restoring their view is the point of a share link. A
      // link from the feather-0 era is unaffected either way: it carries
      // `scf=0` explicitly, because the generator always writes the field. The
      // first-run default is a different question, answered in scopeMask.js.
      // (`_scopeFeatherPct` in the constructor tracks the default: that one
      // mirrors live state for the link this session generates, so it must match
      // the mask, not the archive.)
      scopeFeatherPct: Math.max(0, Math.min(100, Math.round(parseOr(params.get('scf'), 35)))),
      // Absent (or non-numeric) `sce` = adaptive (null), the default behavior;
      // a value pins the terminus opacity percent, clamped into the SUPPORTED
      // 94..100 band. `sce=0` used to survive as a sub-94 terminus — a hole in
      // the mask — and then got written straight back out on the next update.
      scopeTerminusPct: params.has('sce')
        ? clampScopeTerminusPct(params.get('sce'))
        : null,
      mapStack: params.get('map') || 'photoreal',
      layerState: decodedLayerState,
      layerStateInvalid: params.get('v') === '2'
        && params.has('l')
        && decodedLayerState === null,
      panelState: decodePanelStateParams(params),
      sharedAtMs: decodeShareCreatedAtMs(params),
    };
    state.restoreAuthority = {
      visual: this._restoreAuthority.visual,
      map: this._restoreAuthority.map,
      panels: new Map(this._restoreAuthority.panels),
    };

    // Hold URL writes until the complete incoming state has been restored.
    this._initialRestorePending = true;
    return state;
  }

  /**
   * Apply a parsed state to the viewer + style manager.
   */
  async applyState(state, { applyCamera = true, navigationToken = null } = {}) {
    if (this._destroyed || !state) return { succeeded: false, reason: 'unavailable' };
    const view = {
      destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt),
      orientation: {
        heading: Cesium.Math.toRadians(state.heading),
        pitch: Cesium.Math.toRadians(state.pitch),
        roll: Cesium.Math.toRadians(state.roll),
      },
    };
    let cameraPromise = Promise.resolve({ status: applyCamera ? 'superseded' : 'skipped' });
    if (applyCamera && this._isNavigationCurrent(navigationToken)) {
      const restoreGeneration = ++this._restoreGeneration;
      let settleCamera;
      cameraPromise = new Promise((resolve) => { settleCamera = resolve; });
      const releaseOwnedFlight = (status = 'cancelled') => {
        if (this._activeCameraFlight?.restoreGeneration === restoreGeneration) {
          this._activeCameraFlight = null;
        }
        settleCamera({ status });
      };
      this._activeCameraFlight = { restoreGeneration, navigationToken, settle: releaseOwnedFlight };
      // Re-apply the final pose only while this share restoration still owns
      // navigation. A later user or voice command wins over delayed restore.
      this.viewer.camera.flyTo({
        ...view,
        duration: 3.0,
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        complete: () => {
          if (
            this._destroyed
            || restoreGeneration !== this._restoreGeneration
            || !this._isNavigationCurrent(navigationToken)
          ) {
            releaseOwnedFlight('superseded');
            return;
          }
          this.viewer.camera.setView(view);
          this.viewer.scene?.requestRender?.();
          releaseOwnedFlight('applied');
        },
        cancel: () => releaseOwnedFlight('cancelled'),
      });
    }

    // Notify the style manager via callback
    const reserved = state.restoreAuthority || null;
    const visualCurrent = !reserved || reserved.visual === this._restoreAuthority.visual;
    const mapCurrent = !reserved || reserved.map === this._restoreAuthority.map;
    let panelState = state.panelState;
    if (reserved && panelState?.specs) {
      panelState = {
        specs: panelState.specs.filter((spec) => (
          (reserved.panels?.get(spec.id) || 0) === (this._restoreAuthority.panels.get(spec.id) || 0)
        )),
      };
      if (panelState.specs.length === 0) panelState = null;
    }
    let restoreStatus = 'skipped';
    if (this._onRestore) {
      await this._onRestore({
        style: visualCurrent ? state.style : undefined,
        bloom: visualCurrent ? state.bloom : undefined,
        sharpen: visualCurrent ? state.sharpen : undefined,
        bloomIntensity: visualCurrent ? state.bloomIntensity : undefined,
        bloomVersion: visualCurrent ? state.bloomVersion : undefined,
        sharpenIntensity: visualCurrent ? state.sharpenIntensity : undefined,
        hudVariant: visualCurrent ? state.hudVariant : undefined,
        hudVisible: visualCurrent ? state.hudVisible : undefined,
        detectionMode: visualCurrent ? state.detectionMode : undefined,
        detectionDensity: visualCurrent ? state.detectionDensity : undefined,
        detectionAllocation: visualCurrent ? state.detectionAllocation : undefined,
        detectionFadePct: visualCurrent ? state.detectionFadePct : undefined,
        detectionOutsideOpacityPct: visualCurrent ? state.detectionOutsideOpacityPct : undefined,
        celestialRing: visualCurrent ? state.celestialRing : undefined,
        scopeEnabled: visualCurrent ? state.scopeEnabled : undefined,
        scopeFeatherPct: visualCurrent ? state.scopeFeatherPct : undefined,
        scopeTerminusPct: visualCurrent ? state.scopeTerminusPct : undefined,
        mapStack: mapCurrent ? state.mapStack : undefined,
        panelState,
        styleParams: visualCurrent ? state.styleParams : undefined,
      });
      restoreStatus = 'applied';
    }
    const camera = await cameraPromise;
    return {
      succeeded: !this._destroyed,
      camera: camera.status,
      visual: visualCurrent ? restoreStatus : 'superseded',
      map: mapCurrent ? restoreStatus : 'superseded',
      panels: panelState ? restoreStatus : (state.panelState ? 'superseded' : 'skipped'),
    };
  }

  /** Release initial hash suppression only after every restore owner settles. */
  completeInitialRestore() {
    if (!this._initialRestorePending) return;
    this._initialRestorePending = false;
    this._scheduleUpdate();
  }

  /** Mark a newer explicit action as owner of one delayed restore lane. */
  claimRestoreLane(lane, panelId = null) {
    if (!this._initialRestorePending) return;
    if (lane === 'panel' && panelId) {
      this._restoreAuthority.panels.set(panelId, (this._restoreAuthority.panels.get(panelId) || 0) + 1);
    } else if (lane === 'visual' || lane === 'map') {
      this._restoreAuthority[lane] += 1;
    }
  }

  /** Install the finalized durable layer-state source used by URL generation. */
  setLayerStateProvider(provider) {
    this._layerStateProvider = typeof provider === 'function' ? provider : null;
  }

  /** Install the finalized panel-state source used by URL generation. */
  setPanelStateProvider(provider) {
    this._panelStateProvider = typeof provider === 'function' ? provider : null;
  }

  /** Install the active visual preset parameter source used by URL generation. */
  setStyleParamStateProvider(provider) {
    this._styleParamStateProvider = typeof provider === 'function' ? provider : null;
  }

  /** Called only when the durable layer preference model changes. */
  onLayerStateChange() {
    this._scheduleUpdate();
  }

  /** Called when the panel-state provider changes. */
  onPanelStateChange(panelId = null) {
    if (panelId) this.claimRestoreLane('panel', panelId);
    this._scheduleUpdate();
  }

  _encodePanelStateParam(params, panelState) {
    if (!panelState || !Array.isArray(panelState.specs) || panelState.specs.length === 0) {
      params.delete(SHARE_UI_STATE_PARAM);
      return;
    }
    const assignments = [];
    for (const spec of SHARE_PANEL_STATE_REGISTRY) {
      const state = panelState.specs.find((entry) => entry.id === spec.id);
      if (!state || typeof state.collapsed !== 'boolean') continue;
      assignments.push(`${spec.token}.c.${state.collapsed ? '1' : '0'}`);
      if (spec.pinnable && typeof state.pinned === 'boolean') {
        assignments.push(`${spec.token}.p.${state.pinned ? '1' : '0'}`);
      }
    }
    if (assignments.length) params.set(SHARE_UI_STATE_PARAM, assignments.join('_'));
    else params.delete(SHARE_UI_STATE_PARAM);
  }

  /** Called by StyleManager when style/toggles change */
  onStyleChange(styleName) {
    this._currentStyle = styleName;
    this._scheduleUpdate();
  }

  onToggleChange(bloom, sharpen, extras = {}) {
    this._bloomEnabled = bloom;
    this._sharpenEnabled = sharpen;
    if (typeof extras.bloomIntensity === 'number') this._bloomIntensity = extras.bloomIntensity;
    if (typeof extras.bloomVersion === 'number') this._bloomVersion = extras.bloomVersion;
    if (typeof extras.sharpenIntensity === 'number') this._sharpenIntensity = extras.sharpenIntensity;
    if (typeof extras.hudVariant === 'string') this._hudVariant = extras.hudVariant;
    if (typeof extras.hudVisible === 'boolean') this._hudVisible = extras.hudVisible;
    if (typeof extras.detectionMode === 'string') this._detectionMode = extras.detectionMode.toUpperCase();
    if (typeof extras.detectionDensity === 'number') this._detectionDensity = extras.detectionDensity;
    if (typeof extras.detectionAllocation === 'string') {
      this._detectionAllocation = normalizeAllocationStrategy(extras.detectionAllocation);
    }
    if (typeof extras.detectionFadePct === 'number') {
      this._detectionFadePct = Math.max(0, Math.min(40, Math.round(extras.detectionFadePct)));
    }
    if (typeof extras.detectionOutsideOpacityPct === 'number') {
      this._detectionOutsideOpacityPct = Math.max(
        0,
        Math.min(100, Math.round(extras.detectionOutsideOpacityPct)),
      );
    }
    if (typeof extras.celestialRingEnabled === 'boolean') this._celestialRingEnabled = extras.celestialRingEnabled;
    if (typeof extras.scopeEnabled === 'boolean') this._scopeEnabled = extras.scopeEnabled;
    if (typeof extras.scopeFeatherPct === 'number') {
      this._scopeFeatherPct = Math.max(0, Math.min(100, Math.round(extras.scopeFeatherPct)));
    }
    if (extras.scopeTerminusPct === null) this._scopeTerminusPct = null;
    else if (typeof extras.scopeTerminusPct === 'number') {
      this._scopeTerminusPct = clampScopeTerminusPct(extras.scopeTerminusPct);
    }
    if (typeof extras.mapStack === 'string') this._mapStack = extras.mapStack;
    this._scheduleUpdate();
  }

  /** Copy a current-state snapshot with a copy-time timestamp. Returns true on success. */
  async copyLink({ nowMs = Date.now() } = {}) {
    const params = this._buildHashParams();
    if (!params) return false;
    params.set(SHARE_CREATED_AT_PARAM, String(Math.floor(nowMs / 1000)));
    const copiedUrl = new URL(window.location.href);
    copiedUrl.hash = params.toString();
    try {
      await navigator.clipboard.writeText(copiedUrl.href);
      return true;
    } catch {
      return false;
    }
  }

  _scheduleUpdate() {
    if (this._destroyed || this._initialRestorePending) return;
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._updateHash(), DEBOUNCE_MS);
  }

  _updateHash() {
    if (this._destroyed || this._initialRestorePending) return;
    const params = this._buildHashParams();
    if (!params) return;
    history.replaceState(null, '', `#${params.toString()}`);
  }

  /** Build a deterministic snapshot without mutating history. */
  _buildHashParams() {
    if (this._destroyed) return null;
    const camera = this.viewer.camera;
    const carto = camera.positionCartographic;
    if (!carto) return null;

    const params = new URLSearchParams();
    params.set('v', '2');
    params.set('lat', Cesium.Math.toDegrees(carto.latitude).toFixed(4));
    params.set('lon', Cesium.Math.toDegrees(carto.longitude).toFixed(4));
    params.set('alt', Math.round(carto.height).toString());
    params.set('heading', Math.round(Cesium.Math.toDegrees(camera.heading)).toString());
    params.set('pitch', Math.round(Cesium.Math.toDegrees(camera.pitch)).toString());
    params.set('roll', Math.round(Cesium.Math.toDegrees(camera.roll)).toString());
    params.set('style', STYLE_TO_URL[this._currentStyle] || 'normal');
    params.set('bloom', this._bloomEnabled ? '1' : '0');
    params.set('sharpen', this._sharpenEnabled ? '1' : '0');
    params.set('bi', Math.round(this._bloomIntensity).toString());
    params.set('bv', Math.round(this._bloomVersion).toString());
    params.set('si', Math.round(this._sharpenIntensity).toString());
    params.set('hud', this._hudVariant);
    params.set('hv', this._hudVisible ? '1' : '0');
    params.set('dm', this._detectionMode);
    params.set('dd', Math.round(this._detectionDensity).toString());
    params.set('da', this._detectionAllocation.toLowerCase());
    params.set('kf', Math.round(this._detectionFadePct).toString());
    params.set('ko', Math.round(this._detectionOutsideOpacityPct).toString());
    params.set('cr', this._celestialRingEnabled ? '1' : '0');
    params.set('sc', this._scopeEnabled ? '1' : '0');
    params.set('scf', Math.round(this._scopeFeatherPct).toString());
    // Only written when pinned — an absent `sce` IS the adaptive default, so a
    // shared link never freezes the ramp for the recipient by accident. The
    // same 94..100 clamp applies on the way OUT, so a link can never carry an
    // unsupported terminus even if the field was set from somewhere else.
    const terminusPct = clampScopeTerminusPct(this._scopeTerminusPct);
    if (terminusPct != null) params.set('sce', String(terminusPct));
    params.set('map', this._mapStack);
    const layerState = this._layerStateProvider?.();
    if (layerState) encodeLayerStateParams(params, layerState);
    this._encodePanelStateParam(params, this._panelStateProvider?.());
    encodeStyleParamState(
      params,
      this._currentStyle,
      this._styleParamStateProvider?.(this._currentStyle),
    );

    // Copy-time metadata is intentionally absent here. `copyLink()` adds a
    // fresh timestamp to its ephemeral URL without aging the live address.
    params.delete(SHARE_CREATED_AT_PARAM);
    return params;
  }

  /** Cancel owned work and release listeners without disturbing newer navigation. */
  destroy() {
    if (this._destroyed) return;
    const activeFlight = this._activeCameraFlight;
    if (activeFlight && this._isNavigationCurrent(activeFlight.navigationToken)) {
      this._cancelOwnedNavigation?.();
    }
    activeFlight?.settle?.('destroyed');
    this._restoreGeneration += 1;
    this._activeCameraFlight = null;
    this._destroyed = true;
    clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
    this._removeCameraChanged?.();
    this._removeCameraChanged = null;
    this._layerStateProvider = null;
    this._panelStateProvider = null;
    this._styleParamStateProvider = null;
    this._onRestore = null;
  }
}

/** Decode a strict positive epoch-seconds copy timestamp for age classification. */
export function decodeShareCreatedAtMs(params, { nowMs = Date.now() } = {}) {
  const raw = params?.get?.(SHARE_CREATED_AT_PARAM);
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds)) return null;
  const timestampMs = seconds * 1000;
  if (!Number.isSafeInteger(timestampMs) || timestampMs > nowMs) return null;
  return timestampMs;
}

/** Encode allowlisted parameters for the active visual preset. */
export function encodeStyleParamState(params, styleName, values) {
  const registry = SHARE_STYLE_PARAM_REGISTRY[styleName];
  if (!registry || !values || typeof values !== 'object') {
    params.delete(SHARE_STYLE_PARAMS_PARAM);
    return;
  }
  const assignments = [];
  for (const spec of registry) {
    const numeric = Number(values[spec.key]);
    if (!Number.isFinite(numeric)) continue;
    const clamped = Math.max(spec.min, Math.min(spec.max, numeric));
    assignments.push(`${spec.token}.${Math.round(clamped * 100)}`);
  }
  if (assignments.length) params.set(SHARE_STYLE_PARAMS_PARAM, assignments.join('_'));
  else params.delete(SHARE_STYLE_PARAMS_PARAM);
}

/** Decode allowlisted parameters for the selected visual preset. */
export function decodeStyleParamState(params, styleName) {
  if (params.get('v') !== '2' || !params.has(SHARE_STYLE_PARAMS_PARAM)) return null;
  const registry = SHARE_STYLE_PARAM_REGISTRY[styleName];
  if (!registry) return null;
  const byToken = new Map(registry.map((spec) => [spec.token, spec]));
  const decoded = {};
  for (const assignment of String(params.get(SHARE_STYLE_PARAMS_PARAM) || '').split('_')) {
    const [token, scaledRaw, ...extra] = assignment.split('.');
    if (extra.length || !/^-?\d+$/.test(scaledRaw || '')) continue;
    const spec = byToken.get(token);
    if (!spec) continue;
    const numeric = Number(scaledRaw) / 100;
    decoded[spec.key] = Math.max(spec.min, Math.min(spec.max, numeric));
  }
  return Object.keys(decoded).length ? decoded : null;
}

/** Decode the shareable collapsed and pinned state for known panels. */
export function decodePanelStateParams(params) {
  if (params.get('v') !== '2' || !params.has(SHARE_UI_STATE_PARAM)) return null;
  const raw = String(params.get(SHARE_UI_STATE_PARAM) || '').trim();
  if (!raw) return null;
  const stateById = new Map();
  for (const assignment of raw.split('_')) {
    if (!assignment) continue;
    const [token, field, value, ...extra] = assignment.split('.');
    if (extra.length) continue;
    const spec = SHARE_PANEL_STATE_BY_TOKEN.get(token);
    if (!spec || (field !== 'c' && field !== 'p')) continue;
    if (value !== '0' && value !== '1') continue;
    const bool = value === '1';
    const current = stateById.get(spec.id) || { id: spec.id, collapsed: null, pinned: null };
    if (field === 'c') current.collapsed = bool;
    else if (field === 'p' && spec.pinnable) current.pinned = bool;
    stateById.set(spec.id, current);
  }
  const specs = Array.from(stateById.values())
    .filter((entry) => typeof entry.collapsed === 'boolean');
  return specs.length ? { specs } : null;
}
