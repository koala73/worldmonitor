const VALID_DISPOSITIONS = new Set([
  'enabled-only',
  'enabled+options',
  'enabled+mirrored-options',
]);

export const LAYER_STATE_VERSION = 2;
/** Re-check cadence while a shared subject waits for its feed row to arrive. */
const PENDING_TRACKING_POLL_MS = 1_000;
/**
 * A tracking ID is a transponder address, not free text: 6 hex digits for an
 * ICAO24, with slack for TIS-B (`~abc123`) and similar prefixed forms. Bounding
 * it at the codec keeps an arbitrarily long string out of durable state, the
 * generated URL, and local storage. Identity is never TRUNCATED to fit — an
 * out-of-grammar ID is rejected outright, because half an address is a
 * DIFFERENT aircraft, not a shorter name for the same one.
 */
const TRACKING_ID_GRAMMAR = /^[0-9a-z~_-]{1,16}$/;
/**
 * Ceilings for the untrusted v2 layer fields. Both are far above any legitimate
 * payload (16 one-character tokens; a dozen short option assignments), so a
 * value past them is malformed or hostile. Reject the WHOLE payload, matching
 * the unknown-token rule — never salvage a prefix.
 */
const MAX_ENABLED_LAYERS_CHARS = 64;
const MAX_LAYER_OPTIONS_CHARS = 512;
export const LAYER_STATE_STORAGE_KEY = 'gev:layer-state:v2';
export const LAYER_RESTORE_ORIGINS = Object.freeze({
  share: 'share-restore',
  local: 'local-restore',
});

const RADIO_FILTER_CODES = Object.freeze({
  all: 'a',
  news: 'n',
  talk: 't',
  weather: 'w',
  'public-safety': 'p',
  'aviation-marine': 'v',
  'traffic-transit': 'x',
  music: 'm',
  other: 'o',
});
const RADIO_CODE_FILTERS = Object.freeze(
  Object.fromEntries(Object.entries(RADIO_FILTER_CODES).map(([key, value]) => [value, key])),
);

function normalizeBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function normalizeEnum(values, value) {
  return values.includes(value) ? value : null;
}

export function normalizeRadioFilter(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (Object.hasOwn(RADIO_FILTER_CODES, normalized)) return normalized;
  if (/^genre:[a-z0-9][a-z0-9 &-]{0,31}$/.test(normalized)) return normalized;
  return null;
}

function encodeRadioFilter(value) {
  return RADIO_FILTER_CODES[value] || `g-${value.slice('genre:'.length)}`;
}

function decodeRadioFilter(value) {
  if (Object.hasOwn(RADIO_CODE_FILTERS, value)) return RADIO_CODE_FILTERS[value];
  if (/^g-[a-z0-9][a-z0-9 &-]{0,31}$/.test(value)) return `genre:${value.slice(2)}`;
  return null;
}

function normalizeVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(Math.max(0, Math.min(1, numeric)) * 100) / 100;
}

function booleanOption(key, token, defaultValue, { absentValue = defaultValue } = {}) {
  return Object.freeze({
    key,
    token,
    defaultValue,
    absentValue,
    normalize: normalizeBoolean,
    encode: (value) => (value ? '1' : '0'),
    decode: (value) => (value === '1' ? true : value === '0' ? false : null),
  });
}

/**
 * What an ABSENT token means for this option inside the CURRENT schema version.
 *
 * Usually that is simply the default: the encoder omits default-valued fields to
 * keep the URL short and the decoder fills the default back in. But a DEFAULT CAN
 * MOVE while the schema version does not, and every link already in the wild was
 * authored under the old one. `absentValue` is that frozen historical meaning —
 * what an omitted token meant when links like it were being written — so a
 * default flip cannot silently rewrite what an existing link SAYS. A share link
 * is authored state; the only honest reading of `v=2&l=f` is the one its author
 * saw.
 *
 * The consequence is not cosmetic: once `absentValue` and `defaultValue` differ,
 * the NEW default has to be emitted EXPLICITLY, or one omission would mean two
 * different things inside a single schema version. Both sides of the codec read
 * this function so they cannot disagree about which it is.
 *
 * (This is the same rule `scf` follows in sharelink.js by hand. `models3d` is the
 * first option in THIS codec to need it — flipped to default-ON on 2026-08-22.)
 */
function absentTokenValue(spec) {
  return Object.hasOwn(spec, 'absentValue') ? spec.absentValue : spec.defaultValue;
}

function trackingIdOption(key, token, defaultValue = null) {
  const bounded = (candidate) => {
    if (candidate === null || candidate === undefined) return null;
    const raw = typeof candidate === 'number' && Number.isFinite(candidate)
      ? String(candidate)
      : (typeof candidate === 'string' ? candidate : null);
    if (raw === null) return null;
    const normalized = raw.trim().toLowerCase();
    return TRACKING_ID_GRAMMAR.test(normalized) ? normalized : null;
  };
  return Object.freeze({
    key,
    token,
    defaultValue,
    normalize: bounded,
    encode: (value) => String(value),
    decode: bounded,
  });
}

function stringOption(key, token, defaultValue) {
  return Object.freeze({
    key,
    token,
    defaultValue,
    normalize: (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return String(value).trim().toLowerCase();
      if (typeof value !== 'string') return null;
      const normalized = value.trim().toLowerCase();
      return normalized ? normalized : null;
    },
    encode: (value) => String(value),
    decode: (value) => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null),
  });
}

function enumOption(key, token, defaultValue, values, codes) {
  const reverse = Object.fromEntries(Object.entries(codes).map(([name, code]) => [code, name]));
  return Object.freeze({
    key,
    token,
    defaultValue,
    normalize: (value) => normalizeEnum(values, value),
    encode: (value) => codes[value],
    decode: (value) => reverse[value] || null,
  });
}

function integerOption(key, token, defaultValue) {
  return Object.freeze({
    key,
    token,
    defaultValue,
    normalize: (value) => {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
      const candidate = typeof value === 'string' ? value.trim() : '';
      const parsed = Number(candidate);
      if (!candidate || !Number.isInteger(parsed) || parsed <= 0) return null;
      return parsed;
    },
    encode: (value) => String(Math.trunc(value)),
    decode: (value) => {
      const candidate = Number(value);
      if (!Number.isInteger(candidate) || candidate <= 0) return null;
      return candidate;
    },
  });
}

const OPTION_GROUPS = Object.freeze({
  flights: Object.freeze([
    // Product invariant 2026-08-22: the fleet's 3D models are DEFAULT-ON in
    // PROXIMITY mode. Proximity is itself the altitude/count gate — models only
    // materialize once the camera is close enough and only for the nearest
    // contacts in view — so "on" costs nothing at globe scale, and an operator
    // who wants every in-view plane still opts into `all` deliberately.
    // This default must stay in lockstep with `_models3dEnabled` in BOTH flight
    // layers, `this._models3dEnabled` in ui.js, and the `active` / `visible`
    // classes in index.html: the fresh-boot path skips restoration entirely (see
    // `start()` below), so nothing ever pushes this value into the layers — those
    // four initializers ARE the agreement, and they are pinned together in
    // layerState.test.mjs.
    //
    // `absentValue: false` is what keeps the flip out of links already in the
    // wild. Schema v2 shipped with OFF as the omitted default, so `v=2&l=f`
    // MEANS off — and it has to keep meaning that. Moving the default without
    // this would have silently turned 3D on for every existing v2 link, and
    // `v=2&l=f&lo=f.m.a` (an OFF link that remembered mode All) would have come
    // back as ON+All. The price is that ON is now written explicitly (`f.e.1`)
    // instead of ridden in on the omission; see `absentTokenValue`.
    booleanOption('models3d', 'e', true, { absentValue: false }),
    enumOption('models3dMode', 'm', 'proximity', ['proximity', 'all'], {
      proximity: 'p',
      all: 'a',
    }),
    trackingIdOption('selectedFlightsTrackingId', 't', null),
    trackingIdOption('selectedMilitaryTrackingId', 'u', null),
  ]),
  satellites: Object.freeze([
    enumOption('catalog', 'c', 'core', ['core', 'dense'], { core: 'c', dense: 'd' }),
    integerOption('selectedSatTrackingId', 't', null),
  ]),
  cctv: Object.freeze([
    enumOption('coverageMode', 'c', 'on', ['off', 'on', 'viewshed'], {
      off: '0',
      on: '1',
      viewshed: 'v',
    }),
    booleanOption('showProjection', 'p', true),
    booleanOption('autoHop', 'a', false),
  ]),
  radio: Object.freeze([
    Object.freeze({
      key: 'filter',
      token: 'f',
      defaultValue: 'all',
      normalize: normalizeRadioFilter,
      encode: encodeRadioFilter,
      decode: decodeRadioFilter,
    }),
    Object.freeze({
      key: 'volume',
      token: 'v',
      defaultValue: 0.8,
      normalize: normalizeVolume,
      encode: (value) => String(Math.round(value * 100)),
      decode: (value) => (/^\d{1,3}$/.test(value) ? normalizeVolume(Number(value) / 100) : null),
    }),
  ]),
});

const TRACKING_OPTION_KEY_BY_LAYER = Object.freeze({
  flights: 'selectedFlightsTrackingId',
  military: 'selectedMilitaryTrackingId',
  satellites: 'selectedSatTrackingId',
});

export const SHARE_TRACKING_RESTORE_POLICIES = Object.freeze({
  flights: Object.freeze({
    optionOwner: 'flights',
    optionKey: 'selectedFlightsTrackingId',
    expiryWindowMs: 90_000,
    label: 'flight',
  }),
  military: Object.freeze({
    optionOwner: 'flights',
    optionKey: 'selectedMilitaryTrackingId',
    expiryWindowMs: 45_000,
    label: 'military flight',
  }),
  satellites: Object.freeze({
    optionOwner: 'satellites',
    optionKey: 'selectedSatTrackingId',
    expiryWindowMs: 300_000,
    label: 'satellite',
  }),
});

/**
 * Canonical serialization registry. Its order, not runtime registration order,
 * owns stable URL ordering.
 */
export const LAYER_STATE_REGISTRY = Object.freeze([
  Object.freeze({ id: 'ais-live-vessels', token: 'a', disposition: 'enabled-only' }),
  Object.freeze({ id: 'bikeshare', token: 'b', disposition: 'enabled-only' }),
  Object.freeze({ id: 'cctv', token: 'c', disposition: 'enabled+options', optionOwner: 'cctv' }),
  Object.freeze({ id: 'earthquakes', token: 'e', disposition: 'enabled-only' }),
  Object.freeze({ id: 'flights', token: 'f', disposition: 'enabled+options', optionOwner: 'flights' }),
  Object.freeze({ id: 'local-dams', token: 'q', disposition: 'enabled-only' }),
  Object.freeze({ id: 'local-datacenters', token: 'd', disposition: 'enabled-only' }),
  Object.freeze({ id: 'local-firms', token: 'w', disposition: 'enabled-only' }),
  Object.freeze({ id: 'military', token: 'm', disposition: 'enabled+mirrored-options', optionOwner: 'flights' }),
  Object.freeze({ id: 'military-awareness', token: 'g', disposition: 'enabled-only' }),
  Object.freeze({ id: 'military-installations', token: 'i', disposition: 'enabled-only' }),
  Object.freeze({ id: 'radio', token: 'r', disposition: 'enabled+options', optionOwner: 'radio' }),
  Object.freeze({ id: 'rocket-launches', token: 'x', disposition: 'enabled-only' }),
  Object.freeze({ id: 'satellites', token: 's', disposition: 'enabled+options', optionOwner: 'satellites' }),
  Object.freeze({ id: 'telegeography-submarine-cables', token: 'u', disposition: 'enabled-only' }),
  Object.freeze({ id: 'traffic', token: 't', disposition: 'enabled-only' }),
]);

export const REGISTERED_LAYER_IDS = Object.freeze(LAYER_STATE_REGISTRY.map((entry) => entry.id));

const REGISTRY_BY_ID = new Map(LAYER_STATE_REGISTRY.map((entry) => [entry.id, entry]));
const REGISTRY_BY_TOKEN = new Map(LAYER_STATE_REGISTRY.map((entry) => [entry.token, entry]));
const OPTION_OWNER_IDS = Object.freeze([...new Set(
  LAYER_STATE_REGISTRY.map((entry) => entry.optionOwner).filter(Boolean),
)]);

function optionSpecs(ownerId) {
  return OPTION_GROUPS[ownerId] || [];
}

function defaultsForOwner(ownerId) {
  return Object.fromEntries(optionSpecs(ownerId).map((spec) => [spec.key, spec.defaultValue]));
}

function normalizeOwnerOptions(ownerId, candidate = {}) {
  const input = candidate && typeof candidate === 'object' ? candidate : {};
  const normalized = {};
  for (const spec of optionSpecs(ownerId)) {
    const value = Object.hasOwn(input, spec.key) ? spec.normalize(input[spec.key]) : null;
    normalized[spec.key] = value === null ? spec.defaultValue : value;
  }
  return normalized;
}

/** Return whether an event origin represents durable direct intent. */
export function isExplicitLayerStateOrigin(origin) {
  return origin === 'user' || origin === 'voice' || origin === 'tool';
}

/** Validate the static registry itself before it is used to seal a manager. */
export function validateLayerStateRegistry(registry = LAYER_STATE_REGISTRY) {
  if (!Array.isArray(registry) || registry.length === 0) {
    throw new Error('Layer-state registry must be a non-empty array');
  }
  const ids = new Set();
  const tokens = new Set();
  for (const entry of registry) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) throw new Error('Layer-state entry missing id');
    if (!/^[a-z0-9-]+$/.test(entry.id)) throw new Error(`Invalid layer-state id: ${entry.id}`);
    if (ids.has(entry.id)) throw new Error(`Duplicate layer-state id: ${entry.id}`);
    ids.add(entry.id);
    if (!/^[a-z0-9]$/.test(entry.token || '')) throw new Error(`Invalid layer-state token: ${entry.id}`);
    if (tokens.has(entry.token)) throw new Error(`Duplicate layer-state token: ${entry.token}`);
    tokens.add(entry.token);
    if (!VALID_DISPOSITIONS.has(entry.disposition)) {
      throw new Error(`Invalid layer-state disposition: ${entry.id}`);
    }
    if (entry.disposition !== 'enabled-only') {
      if (!entry.optionOwner || optionSpecs(entry.optionOwner).length === 0) {
        throw new Error(`Layer-state option owner missing: ${entry.id}`);
      }
    } else if (entry.optionOwner) {
      throw new Error(`Enabled-only layer cannot own options: ${entry.id}`);
    }
  }
  return true;
}

validateLayerStateRegistry();

/** Produce the complete durable default state. */
export function createDefaultLayerState() {
  return {
    version: LAYER_STATE_VERSION,
    enabledLayerIds: [],
    options: Object.fromEntries(OPTION_OWNER_IDS.map((ownerId) => [
      ownerId,
      defaultsForOwner(ownerId),
    ])),
  };
}

/** Sanitize and canonicalize an externally supplied layer-state object. */
export function normalizeLayerState(candidate) {
  const input = candidate && typeof candidate === 'object' ? candidate : {};
  const requestedEnabled = new Set(
    Array.isArray(input.enabledLayerIds) ? input.enabledLayerIds.map(String) : [],
  );
  const enabledLayerIds = REGISTERED_LAYER_IDS.filter((id) => requestedEnabled.has(id));
  const enabled = new Set(enabledLayerIds);
  const options = Object.fromEntries(OPTION_OWNER_IDS.map((ownerId) => [
    ownerId,
    normalizeOwnerOptions(ownerId, input.options?.[ownerId]),
  ]));
  // A selected entity cannot outlive an explicitly disabled owner layer.
  // Keeping these IDs would resurrect tracking when that layer is enabled
  // later, even though OFF was newer explicit intent.
  if (!enabled.has('flights')) options.flights.selectedFlightsTrackingId = null;
  if (!enabled.has('military')) options.flights.selectedMilitaryTrackingId = null;
  if (!enabled.has('satellites')) options.satellites.selectedSatTrackingId = null;
  // The codec has no cross-family recency field, so multiple tracking IDs are
  // ambiguous rather than an ordered handoff. Fail closed instead of letting
  // asynchronous feed arrival decide which tracker and camera owner wins.
  const trackingSelectionCount = [
    options.flights.selectedFlightsTrackingId,
    options.flights.selectedMilitaryTrackingId,
    options.satellites.selectedSatTrackingId,
  ].filter((value) => value !== null).length;
  if (trackingSelectionCount > 1) {
    options.flights.selectedFlightsTrackingId = null;
    options.flights.selectedMilitaryTrackingId = null;
    options.satellites.selectedSatTrackingId = null;
  }
  return {
    version: LAYER_STATE_VERSION,
    enabledLayerIds,
    options,
  };
}

export function cloneLayerState(state) {
  const normalized = normalizeLayerState(state);
  return {
    ...normalized,
    enabledLayerIds: [...normalized.enabledLayerIds],
    options: Object.fromEntries(
      Object.entries(normalized.options).map(([id, options]) => [id, { ...options }]),
    ),
  };
}

/** Append the compact v2 layer fields to an existing URLSearchParams object. */
export function encodeLayerStateParams(params, state) {
  const normalized = normalizeLayerState(state);
  const enabled = new Set(normalized.enabledLayerIds);
  params.set('l', LAYER_STATE_REGISTRY
    .filter((entry) => enabled.has(entry.id))
    .map((entry) => entry.token)
    .join('.'));
  const encodedOptions = [];
  for (const ownerId of OPTION_OWNER_IDS) {
    const ownerEntry = REGISTRY_BY_ID.get(ownerId);
    const ownerOptions = normalized.options[ownerId];
    for (const spec of optionSpecs(ownerId)) {
      // Omit against what an ABSENT token means to a DECODER, not against the
      // current default — those are the same thing for every option whose
      // default never moved, and deliberately different for one whose did.
      if (ownerOptions[spec.key] === absentTokenValue(spec)) continue;
      encodedOptions.push(`${ownerEntry.token}.${spec.token}.${spec.encode(ownerOptions[spec.key])}`);
    }
  }
  if (encodedOptions.length) params.set('lo', encodedOptions.join('_'));
  else params.delete('lo');
  return params;
}

/** Decode v2 fields. Null means that the layer payload is absent. */
export function decodeLayerStateParams(params) {
  if (params.get('v') !== String(LAYER_STATE_VERSION) || !params.has('l')) return null;
  const rawLayers = String(params.get('l') || '');
  const rawOptionsField = String(params.get('lo') || '');
  // Fail closed on an oversized payload rather than decoding a truncated one.
  if (rawLayers.length > MAX_ENABLED_LAYERS_CHARS) return null;
  if (rawOptionsField.length > MAX_LAYER_OPTIONS_CHARS) return null;
  const layerTokens = rawLayers.split('.').filter(Boolean);
  // `l=` is the one valid explicit-empty representation. Any non-empty token
  // set containing an unknown member rejects the complete layer payload so a
  // typo or future token cannot silently become an authoritative empty set.
  if (layerTokens.some((token) => !REGISTRY_BY_TOKEN.has(token))) return null;
  const enabledLayerIds = layerTokens.map((token) => REGISTRY_BY_TOKEN.get(token).id);
  const rawOptions = {};
  for (const assignment of rawOptionsField.split('_')) {
    if (!assignment) continue;
    const [layerToken, optionToken, encodedValue, ...extra] = assignment.split('.');
    if (extra.length) continue;
    const entry = REGISTRY_BY_TOKEN.get(layerToken);
    const ownerId = entry?.optionOwner || null;
    if (!ownerId) continue;
    const spec = optionSpecs(ownerId).find((candidate) => candidate.token === optionToken);
    if (!spec) continue;
    const decoded = spec.decode(encodedValue);
    if (decoded === null) continue;
    if (!rawOptions[ownerId]) rawOptions[ownerId] = {};
    rawOptions[ownerId][spec.key] = decoded;
  }
  // Fill every token the link did NOT carry with its absent-meaning before
  // normalization, which would otherwise substitute the CURRENT default. For all
  // but one option those are identical and this is a no-op; for `models3d` it is
  // the whole point — an omitted `e` is a v2 author saying OFF, not a v2 author
  // saying "whatever the default happens to be today". See `absentTokenValue`.
  for (const ownerId of OPTION_OWNER_IDS) {
    for (const spec of optionSpecs(ownerId)) {
      if (rawOptions[ownerId] && Object.hasOwn(rawOptions[ownerId], spec.key)) continue;
      if (!rawOptions[ownerId]) rawOptions[ownerId] = {};
      rawOptions[ownerId][spec.key] = absentTokenValue(spec);
    }
  }
  return normalizeLayerState({ enabledLayerIds, options: rawOptions });
}

/** Stable local-storage representation (full IDs for debuggability). */
export function serializeStoredLayerState(state) {
  const normalized = normalizeLayerState(state);
  return JSON.stringify({
    v: LAYER_STATE_VERSION,
    l: normalized.enabledLayerIds,
    o: normalized.options,
  });
}

export function parseStoredLayerState(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.v !== LAYER_STATE_VERSION || !Array.isArray(parsed.l)) return null;
    return normalizeLayerState({ enabledLayerIds: parsed.l, options: parsed.o });
  } catch {
    return null;
  }
}

/** Return sanitized options to apply to one registered module. */
export function layerOptionsForRestore(state, layerId) {
  const entry = REGISTRY_BY_ID.get(layerId);
  if (!entry?.optionOwner) return null;
  return { ...normalizeLayerState(state).options[entry.optionOwner] };
}

function safeStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function currentLayerOutcome(dataManager, layerId) {
  const state = dataManager.getLayerLifecycleState?.(layerId);
  return {
    settledEnabled: Boolean(state?.enabled),
    lifecycleState: state?.lifecycleState || 'missing',
    lifecycleUncertain: Boolean(state?.uncertain),
  };
}

/**
 * Owns durable user layer preferences independently from transient runtime
 * choreography, and coordinates passive post-registration restoration.
 */
export class LayerStateCoordinator {
  constructor(dataManager, shareLinkManager, {
    storage = safeStorage(),
    restoreGate = null,
    onDurableStateChange = null,
    onTrackingRestoreStatus = null,
    now = () => Date.now(),
    // Injectable so the pending-window behavior is deterministically testable
    // without sleeping out a 90 s expiry.
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
  } = {}) {
    if (!dataManager?.registrationsFinalized) {
      throw new Error('Layer state requires finalized data-layer registrations');
    }
    this.dataManager = dataManager;
    this.shareLinkManager = shareLinkManager || null;
    this.storage = storage;
    this.restoreGate = restoreGate;
    this.onDurableStateChange = onDurableStateChange;
    this.onTrackingRestoreStatus = onTrackingRestoreStatus;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this._durableState = createDefaultLayerState();
    this._source = 'defaults';
    this._destroyed = false;
    this._restoreControllers = new Map();
    this._shareCreatedAtMs = null;
    this._trackingRestoreController = null;
    this._trackingRestoreGeneration = 0;
    this._pendingTrackingTimer = null;
    this._pendingTrackingContext = null;
    this._unsubscribe = this.dataManager.subscribe((change) => this._handleManagerChange(change));
    this._unsubscribeVisibilityRequests = this.dataManager.subscribeVisibilityRequests(
      (change) => this._handleVisibilityRequest(change),
    );
    this.restorePromise = Promise.resolve([]);
    this.lastRestoreResults = [];
  }

  start({ shareLayerState = null, allowLocalState = true, shareCreatedAtMs = null } = {}) {
    if (this._destroyed) throw new Error('Layer-state coordinator is destroyed');
    let selected = shareLayerState ? normalizeLayerState(shareLayerState) : null;
    if (selected) {
      this._source = 'share';
      this._shareCreatedAtMs = Number.isFinite(shareCreatedAtMs) ? shareCreatedAtMs : null;
    } else if (allowLocalState) {
      let stored = null;
      try { stored = parseStoredLayerState(this.storage?.getItem?.(LAYER_STATE_STORAGE_KEY)); } catch { /* best effort */ }
      if (stored) {
        selected = stored;
        this._source = 'local';
      }
    } else {
      // A valid historical camera/style share with no v2 layer payload keeps
      // the exact legacy default-layer behavior. It must not inherit an
      // unrelated recipient's saved local layer preferences.
      this._source = 'legacy-share';
    }
    this._durableState = selected || createDefaultLayerState();
    this.shareLinkManager?.setLayerStateProvider?.(() => this.getDurableState());
    this.shareLinkManager?.onLayerStateChange?.();
    this._notifyDurableState();
    if (!selected) return this.restorePromise;
    this.restorePromise = this._restoreSelectedState(
      this._source === 'share' ? LAYER_RESTORE_ORIGINS.share : LAYER_RESTORE_ORIGINS.local,
    );
    return this.restorePromise;
  }

  get source() {
    return this._source;
  }

  getDurableState() {
    return cloneLayerState(this._durableState);
  }

  _notifyDurableState() {
    try { this.onDurableStateChange?.(this.getDurableState()); } catch { /* UI sync is best effort */ }
  }

  _handleVisibilityRequest(change) {
    if (!isExplicitLayerStateOrigin(change?.origin)) return;
    this._restoreControllers.get(change.layerId)?.abort('superseded-by-explicit-visibility');
    if (SHARE_TRACKING_RESTORE_POLICIES[change.layerId]) {
      this._revokePendingTrackingWatch('superseded-by-explicit-visibility');
    }
  }

  /** Revoke every passive restore before explicit navigation can be reclaimed. */
  cancelPendingRestores(reason = 'superseded-by-explicit-navigation') {
    for (const controller of this._restoreControllers.values()) controller.abort(reason);
    this._revokePendingTrackingWatch(reason);
  }

  /**
   * Revoke a pending shared Follow. Physical navigation may also clear only
   * the exact passive selection, without writing recipient preferences.
   */
  cancelPendingShareTracking(reason = 'superseded-by-explicit-navigation', {
    clearSelection = false,
  } = {}) {
    this._revokePendingTrackingWatch(reason);
    if (!clearSelection) return false;
    const selected = this._selectedShareTrackingTarget();
    return selected ? this._passivelyClearTrackingSelection(selected) : false;
  }

  _handleManagerChange(change) {
    if (!change || this._destroyed) return;
    // Parameter and visibility ownership are independent. A newer explicit
    // option request may replace passive share options, but it must not abort
    // the same layer's visibility lifecycle.
    if (change.type === 'params-requested') {
      if (isExplicitLayerStateOrigin(change.origin)
          && SHARE_TRACKING_RESTORE_POLICIES[change.layerId]) {
        this._revokePendingTrackingWatch('superseded-by-explicit-params');
      }
      return;
    }
    // A layer that goes away takes its latch with it, at ANY origin — a
    // programmatic disable or teardown never reaches the explicit-intent path
    // below, so revoke here before that early return.
    if (change.type === 'visibility'
        && change.enabled === false
        && SHARE_TRACKING_RESTORE_POLICIES[change.layerId]) {
      this._revokePendingTrackingWatch('owner-layer-disabled');
    }
    if (!isExplicitLayerStateOrigin(change.origin)) return;
    if (change.type === 'visibility') {
      this._restoreControllers.get(change.layerId)?.abort('superseded-by-explicit-visibility');
      if (SHARE_TRACKING_RESTORE_POLICIES[change.layerId]) {
        this._revokePendingTrackingWatch('superseded-by-explicit-visibility');
      }
      const enabled = new Set(this._durableState.enabledLayerIds);
      if (change.enabled) enabled.add(change.layerId);
      else enabled.delete(change.layerId);
      this._commitExplicit({ ...this._durableState, enabledLayerIds: [...enabled] });
      return;
    }
    if (change.type !== 'params') return;
    const entry = REGISTRY_BY_ID.get(change.layerId);
    if (!entry?.optionOwner) return;
    const ownerId = entry.optionOwner;
    const nextOwnerOptions = { ...this._durableState.options[ownerId] };
    const requestedParams = change.requestedParams || {};
    const trackingOptionKey = TRACKING_OPTION_KEY_BY_LAYER[change.layerId] || null;
    let changed = false;
    for (const spec of optionSpecs(ownerId)) {
      // Only persist keys present in this explicit request. getLayerParams()
      // can return a wider live snapshot containing transient or passively
      // changed values that this user action did not own. Tracking is the one
      // exception: an unrelated explicit option cancels a pending restoration
      // in that family, so its wider live value (active ID or null) must replace
      // the formerly durable pending ID instead of allowing reload resurrection.
      const explicitlyRequested = Object.hasOwn(requestedParams, spec.key);
      const implicitTrackingSync = !explicitlyRequested && spec.key === trackingOptionKey;
      if (!explicitlyRequested && !implicitTrackingSync) continue;
      const value = spec.normalize(change.params[spec.key]);
      if (value === null) {
        if (implicitTrackingSync) {
          nextOwnerOptions[spec.key] = null;
          changed = true;
          continue;
        }
        if (spec.defaultValue !== null || change.params[spec.key] !== null) continue;
      }
      nextOwnerOptions[spec.key] = value;
      changed = true;
    }
    if (!changed) return;
    this._commitExplicit({
      ...this._durableState,
      options: { ...this._durableState.options, [ownerId]: nextOwnerOptions },
    });
  }

  _commitExplicit(candidate) {
    this._durableState = normalizeLayerState(candidate);
    const serialized = serializeStoredLayerState(this._durableState);
    try {
      if (this.storage?.getItem?.(LAYER_STATE_STORAGE_KEY) !== serialized) {
        this.storage?.setItem?.(LAYER_STATE_STORAGE_KEY, serialized);
      }
    } catch { /* storage can be unavailable or quota-limited */ }
    this.shareLinkManager?.onLayerStateChange?.();
    this._notifyDurableState();
  }

  async _waitForRestoreGate() {
    if (!this.restoreGate) return;
    await (typeof this.restoreGate === 'function' ? this.restoreGate() : this.restoreGate);
  }

  async _restoreSelectedState(origin) {
    for (const entry of LAYER_STATE_REGISTRY) {
      this._restoreControllers.set(entry.id, new AbortController());
    }
    try {
      await this._waitForRestoreGate();
      const enabled = new Set(this._durableState.enabledLayerIds);
      const settled = await Promise.allSettled(LAYER_STATE_REGISTRY.map(async (entry) => {
        const controller = this._restoreControllers.get(entry.id);
        const targetEnabled = enabled.has(entry.id);
        const options = layerOptionsForRestore(this._durableState, entry.id);
        if (origin === LAYER_RESTORE_ORIGINS.share && options) {
          for (const trackingKey of Object.values(TRACKING_OPTION_KEY_BY_LAYER)) {
            delete options[trackingKey];
          }
        }
        if (this._destroyed || controller?.signal.aborted) {
          return {
            layerId: entry.id,
            targetEnabled,
            origin,
            phase: 'reserved',
            ...currentLayerOutcome(this.dataManager, entry.id),
            appliedOptions: {},
            cancellationReason: this._destroyed ? 'destroyed' : 'superseded',
            errorClass: 'cancelled',
            persistenceWrite: false,
            succeeded: false,
          };
        }
        // Reserve passive option state before any asynchronous lifecycle work.
        // A later explicit params intent then wins on its own lane without
        // cancelling or being overwritten by the visibility restore.
        const paramsSucceeded = !options || Object.keys(options).length === 0
          || this.dataManager.setLayerParams(entry.id, options, { origin });
        return this.dataManager.restoreLayerState(entry.id, {
          enabled: targetEnabled,
          params: null,
        }, { origin, signal: controller.signal }).then((result) => ({
          ...result,
          appliedOptions: paramsSucceeded && options ? options : {},
          errorClass: paramsSucceeded ? result.errorClass : 'ParamsRejected',
          succeeded: paramsSucceeded && result.succeeded,
        }));
      }));
      this.lastRestoreResults = settled.map((result, index) => {
        if (result.status === 'fulfilled') return result.value;
        const entry = LAYER_STATE_REGISTRY[index];
        return {
          layerId: entry.id,
          targetEnabled: enabled.has(entry.id),
          origin,
          phase: 'coordinator',
          ...currentLayerOutcome(this.dataManager, entry.id),
          appliedOptions: {},
          cancellationReason: null,
          errorClass: result.reason?.name || 'Error',
          error: String(result.reason?.message || result.reason),
          persistenceWrite: false,
          succeeded: false,
        };
      });
      return this.lastRestoreResults.map((result) => ({ ...result }));
    } finally {
      this._restoreControllers.clear();
      this._notifyDurableState();
    }
  }

  _selectedShareTrackingTarget() {
    if (this._source !== 'share') return null;
    for (const [layerId, policy] of Object.entries(SHARE_TRACKING_RESTORE_POLICIES)) {
      const targetId = this._durableState.options?.[policy.optionOwner]?.[policy.optionKey];
      if (targetId !== null && targetId !== undefined && targetId !== '') {
        return { layerId, targetId, ...policy };
      }
    }
    return null;
  }

  _passivelyClearTrackingSelection(selected) {
    const current = this._durableState.options?.[selected.optionOwner]?.[selected.optionKey];
    if (String(current) !== String(selected.targetId)) return false;
    const ownerOptions = {
      ...this._durableState.options[selected.optionOwner],
      [selected.optionKey]: null,
    };
    this._durableState = normalizeLayerState({
      ...this._durableState,
      options: {
        ...this._durableState.options,
        [selected.optionOwner]: ownerOptions,
      },
    });
    this.dataManager.setLayerParams?.(
      selected.layerId,
      { [selected.optionKey]: null },
      { origin: LAYER_RESTORE_ORIGINS.share },
    );
    this.shareLinkManager?.onLayerStateChange?.();
    this._notifyDurableState();
    return true;
  }

  /**
   * `atMs` is the moment the subject was first found ABSENT, not the moment the
   * verdict is delivered. Waiting out the pending window must not by itself
   * push a fresh link into the "expired" wording — that word describes the
   * SHARE's age, not how long this client watched for the subject.
   */
  _classifyMissingTrackingTarget(selected, atMs = this.now()) {
    const copiedAt = this._shareCreatedAtMs;
    if (!Number.isFinite(copiedAt)) return 'unavailable';
    const ageMs = atMs - copiedAt;
    return ageMs > selected.expiryWindowMs ? 'expired' : 'unavailable';
  }

  /** Whether the owning layer currently follows the shared subject. */
  _trackingTargetLatched(selected) {
    const params = this.dataManager.getLayerParams?.(selected.layerId);
    const active = params?.[selected.optionKey];
    return active !== null && active !== undefined
      && String(active) === String(selected.targetId);
  }

  /** Stop watching a pending shared subject without deciding its fate. */
  _cancelPendingTrackingWatch() {
    if (this._pendingTrackingTimer !== null) this.clearTimer(this._pendingTrackingTimer);
    this._pendingTrackingTimer = null;
    const pending = this._pendingTrackingContext;
    if (pending?.signal && pending.abortHandler) {
      pending.signal.removeEventListener('abort', pending.abortHandler);
      pending.abortHandler = null;
    }
  }

  /** Publish a share-follow lifecycle update without allowing UI errors to own state. */
  _publishTrackingRestoreStatus(status) {
    try { this.onTrackingRestoreStatus?.(status); } catch { /* status UI is best effort */ }
  }

  /**
   * Revoke a pending shared Follow wholesale.
   *
   * The watch and the LAYER's own deferred-restore latch are two halves of one
   * mechanism, so they must die together. Aborting only the restore controller
   * left the timer alive: the controller has already settled by the time the
   * watch exists, so the abort was a no-op and the orphaned timer went on to
   * announce "Shared … unavailable" for a subject whose latch had been
   * cancelled — a notice about work no longer being attempted.
   */
  _revokePendingTrackingWatch(reason) {
    this._trackingRestoreController?.abort(reason);
    this._trackingRestoreGeneration += 1;
    this._cancelPendingTrackingWatch();
    const pending = this._pendingTrackingContext;
    this._pendingTrackingContext = null;
    if (pending) {
      this.dataManager.cancelPendingLayerRestore?.(pending.selected.layerId, {
        origin: LAYER_RESTORE_ORIGINS.share,
        reason: String(reason || 'cancelled'),
      });
      this._publishTrackingRestoreStatus({
        ...pending.probe,
        ...pending.selected,
        status: 'cancelled',
        classification: 'cancelled',
        reason: String(reason || 'cancelled'),
        cleared: false,
      });
    }
  }

  /**
   * Hold a not-yet-arrived shared subject PENDING instead of declaring it gone.
   *
   * A recipient's first authoritative refresh routinely lands without a given
   * contact — the feed is polled, coverage is partial, and rendering trails the
   * snapshot by a poll. Reload-from-local already survives this: its restore
   * arms the layer's own deferred-restore latch, which re-attempts on every
   * later poll. The shared path used to decide on that single refresh, clear
   * the subject from durable state AND from the URL, then post a failure notice
   * seconds into startup — so the same link healed on reload but never on the
   * share.
   *
   * Arm the SAME latch, then watch it in the background: the caller is never
   * blocked (startup must not wait out a 90 s window before it may write the
   * URL again), and the terminal verdict is deferred until the source-specific
   * window has genuinely expired. The existing wordings are unchanged.
   */
  async _beginPendingTrackingRestore(selected, probe, signal = null) {
    const generation = this._trackingRestoreGeneration;
    const absentAtMs = this.now();
    // Arm the layer's deferred-restore latch under the passive share origin, so
    // it re-attempts each poll and never rewrites recipient preferences.
    let armed = false;
    let armError = null;
    try {
      armed = await this.dataManager.setLayerParams?.(
        selected.layerId,
        { [selected.optionKey]: selected.targetId },
        { origin: LAYER_RESTORE_ORIGINS.share },
      ) === true;
    } catch (error) {
      armError = error;
    }
    if (this._destroyed || generation !== this._trackingRestoreGeneration || signal?.aborted) {
      if (armed) {
        this.dataManager.cancelPendingLayerRestore?.(selected.layerId, {
          origin: LAYER_RESTORE_ORIGINS.share,
          reason: String(signal?.reason || 'superseded'),
        });
      }
      return {
        ...probe,
        ...selected,
        status: 'cancelled',
        classification: 'cancelled',
        reason: String(signal?.reason || 'superseded'),
        cleared: false,
      };
    }
    if (!armed) {
      const terminal = {
        ...probe,
        ...selected,
        status: 'source-unavailable',
        classification: 'source-unavailable',
        reason: String(armError?.message || armError || 'tracking restore latch rejected'),
        cleared: this._passivelyClearTrackingSelection(selected),
      };
      this._publishTrackingRestoreStatus(terminal);
      return terminal;
    }
    const deadline = this.now() + selected.expiryWindowMs;
    const settle = (terminal) => {
      if (this._pendingTrackingContext?.generation !== generation) return;
      this._cancelPendingTrackingWatch();
      this._pendingTrackingContext = null;
      this._publishTrackingRestoreStatus(terminal);
    };
    const poll = () => {
      this._pendingTrackingTimer = null;
      if (this._destroyed || generation !== this._trackingRestoreGeneration) return;
      // The layer that owns the latch may have gone away since the last tick
      // (disable, teardown, replacement). There is nothing left attempting this
      // restore, so abandon it silently rather than announcing a verdict.
      if (this.dataManager.isEffectivelyEnabled?.(selected.layerId) === false) {
        this._revokePendingTrackingWatch('owner-layer-disabled');
        return;
      }
      if (this._trackingTargetLatched(selected)) {
        settle({ ...probe, ...selected, status: 'found', classification: 'followed', cleared: false });
        return;
      }
      if (this.now() >= deadline) {
        // The window really has elapsed — only now does the verdict apply.
        const classification = probe.status === 'missing'
          ? this._classifyMissingTrackingTarget(selected, absentAtMs)
          : 'source-unavailable';
        const cleared = this._passivelyClearTrackingSelection(selected);
        settle({ ...probe, ...selected, classification, cleared });
        return;
      }
      this._pendingTrackingTimer = this.setTimer(poll, PENDING_TRACKING_POLL_MS);
      this._pendingTrackingTimer?.unref?.();
    };
    this._cancelPendingTrackingWatch();
    const pending = { ...probe, ...selected, status: 'pending', classification: 'pending', cleared: false };
    const pendingContext = {
      generation,
      selected,
      probe,
      signal,
      abortHandler: null,
    };
    if (signal) {
      pendingContext.abortHandler = () => {
        if (this._pendingTrackingContext?.generation !== generation) return;
        this._revokePendingTrackingWatch(signal.reason || 'aborted');
      };
      signal.addEventListener('abort', pendingContext.abortHandler, { once: true });
    }
    this._pendingTrackingContext = pendingContext;
    this._publishTrackingRestoreStatus(pending);
    this._pendingTrackingTimer = this.setTimer(poll, PENDING_TRACKING_POLL_MS);
    this._pendingTrackingTimer?.unref?.();
    return pending;
  }

  /**
   * Refresh and restore the one shareable tracked target after destination
   * camera and ordinary layer restoration have settled.
   */
  async restoreShareTrackingSelection({ signal = null } = {}) {
    const selected = this._selectedShareTrackingTarget();
    if (!selected || this._destroyed) return { status: 'skipped', reason: 'no-shared-target' };
    this._revokePendingTrackingWatch('superseded-by-newer-restore');
    const controller = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    this._trackingRestoreController = controller;
    const generation = ++this._trackingRestoreGeneration;
    let result;
    try {
      result = await this.dataManager.resolveLayerTrackingTarget(
        selected.layerId,
        selected.targetId,
        { signal: combinedSignal, origin: LAYER_RESTORE_ORIGINS.share },
      );
    } catch (error) {
      result = combinedSignal.aborted
        ? { status: 'cancelled', reason: String(combinedSignal.reason || 'aborted') }
        : { status: 'source-unavailable', reason: String(error?.message || error) };
    }
    if (generation !== this._trackingRestoreGeneration || this._destroyed || combinedSignal.aborted) {
      if (this._trackingRestoreController === controller) this._trackingRestoreController = null;
      return { ...result, status: 'cancelled', reason: String(combinedSignal.reason || 'superseded') };
    }
    if (this._trackingRestoreController === controller) this._trackingRestoreController = null;

    if (result.status === 'found') {
      const terminal = { ...result, ...selected, classification: 'followed', cleared: false };
      this._publishTrackingRestoreStatus(terminal);
      return terminal;
    }
    if (['cancelled', 'superseded', 'destroyed'].includes(result.status)) return result;

    // A subject that is simply not here YET is not a subject that is gone. Hold
    // it on the layer's own deferred-restore latch for its source-specific
    // window before any verdict is reached or shown. `unsupported` layers have
    // no latch to arm, so they still decide immediately.
    if (result.status === 'missing' || result.status === 'source-unavailable') {
      return this._beginPendingTrackingRestore(selected, result, combinedSignal);
    }

    const classification = result.status === 'missing'
      ? this._classifyMissingTrackingTarget(selected)
      : 'source-unavailable';
    const cleared = this._passivelyClearTrackingSelection(selected);
    const terminal = { ...result, ...selected, classification, cleared };
    this._publishTrackingRestoreStatus(terminal);
    return terminal;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const controller of this._restoreControllers.values()) controller.abort('coordinator-destroyed');
    this._restoreControllers.clear();
    this._revokePendingTrackingWatch('coordinator-destroyed');
    this._trackingRestoreController = null;
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._unsubscribeVisibilityRequests?.();
    this._unsubscribeVisibilityRequests = null;
    this.shareLinkManager?.setLayerStateProvider?.(null);
    this.onDurableStateChange = null;
    this.onTrackingRestoreStatus = null;
  }
}
