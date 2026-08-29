import { governorRequestRender } from '../renderGovernor.js';
import { markDetectionSourcesChanged } from './detection.js';
function cloneLayerParams(value) {
  if (Array.isArray(value)) return value.map(cloneLayerParams);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneLayerParams(nested)]),
    );
  }
  return value;
}

const FEED_STATE_LABELS = Object.freeze({
  nominal: 'ON',
  loading: 'LOADING',
  degraded: 'DEGRADED',
  stale: 'STALE',
  fallback: 'FALLBACK',
  unavailable: 'UNAVAILABLE',
});

const SUPERSEDED_VISIBILITY_INTENT = Symbol('superseded-visibility-intent');
const VALID_LAYER_SERIALIZATION_DISPOSITIONS = new Set([
  'enabled-only',
  'enabled+options',
  'enabled+mirrored-options',
]);

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function lifecycleRejectedError(layerId, phase) {
  const error = new Error(`[Data] ${layerId} ${phase} rejected the lifecycle transition`);
  error.name = 'LifecycleRejectedError';
  return error;
}

function paramsRejectedError(layerId) {
  const error = new Error(`[Data] ${layerId} rejected layer parameters`);
  error.name = 'LayerParamsRejectedError';
  return error;
}

function isExplicitLayerIntentOrigin(origin) {
  return origin === 'user' || origin === 'voice' || origin === 'tool';
}

function cancelPendingLayerRestore(entry, origin, reason) {
  if (!isExplicitLayerIntentOrigin(origin)) return;
  try {
    (entry.module?.cancelPendingRestore || entry.module?.cancelPendingTrackingRestore)?.({ origin, reason });
  } catch (error) {
    console.warn(`[Data] ${entry.module?.id || 'layer'} pending restore cancellation error:`, error);
  }
}

function refreshFailureFromStats(stats, label) {
  const specific = stats?.error || stats?.lastError;
  if (specific) return specific instanceof Error ? specific : new Error(String(specific));
  if (stats?.unavailable === true || stats?.available === false) {
    return new Error(`${label} refresh unavailable`);
  }
  return null;
}

/**
 * Normalize heterogeneous layer stats into one honest control-chip state.
 * @param {object|null} stats Layer getStats() result.
 * @returns {'nominal'|'loading'|'degraded'|'stale'|'fallback'|'unavailable'} Feed state.
 */
export function layerFeedState(stats = {}) {
  const state = stats || {};
  const status = typeof state.status === 'string' ? state.status.toLowerCase() : '';
  const source = `${state.source || ''} ${state.coverage || ''}`;
  const hasExplicitFallback = typeof state.fallback === 'boolean';
  const hasPriorData = Number(state.count) > 0 || Boolean(state.lastUpdate);
  const presentedError = state.error || state.lastError || state.managerRefreshError;
  if (['unavailable', 'offline', 'down', 'error'].includes(status)) return 'unavailable';
  if (
    (presentedError || state.unavailable === true || state.available === false)
    && !hasPriorData
    && !['zoom-in', 'empty', 'idle'].includes(status)
  ) {
    return 'unavailable';
  }
  if (state.loading) return 'loading';
  // Guidance states ask the user to act (zoom in, run a search) — normal
  // operation, not feed faults. One honesty carve-out: layers keep their
  // rendered records through the guidance state, so a genuinely stale cache
  // still reads STALE; a guidance prompt alone never reads DEGRADED.
  if (['zoom-in', 'empty', 'idle'].includes(status)) {
    return state.stale ? 'stale' : 'nominal';
  }
  if (
    state.fallback === true
    || status === 'fallback'
    || state.mode === 'sim'
    || /\bfallback\b/i.test(source)
    || (!hasExplicitFallback && /\badsb\.lol\b/i.test(source))
  ) {
    return 'fallback';
  }
  if (state.stale || status === 'stale') return 'stale';
  if (
    state.degraded
    || presentedError
    || state.unavailable === true
    || state.available === false
  ) return 'degraded';
  return 'nominal';
}

/**
 * DataLayerManager — Manages registration, toggling, and update loops
 * for real-time data overlays on the CesiumJS globe.
 */
export class DataLayerManager {
  constructor(viewer, { allowQaRegistration = false } = {}) {
    this.viewer = viewer;
    this.layers = new Map(); // id → { module, enabled, initialized, intervalId, lifecycleState, lifecycleUncertain }
    this._listeners = new Set();
    this._visibilityRequestListeners = new Set();
    this._beforeDestroyListeners = new Set();
    this._visibilityGuards = new Set();
    this._registrationsFinalized = false;
    this._registrationDispositions = null;
    this._allowQaRegistration = allowQaRegistration === true;
    this._qaLayerIds = new Set();
  }

  register(layerModule) {
    if (this._registrationsFinalized) {
      throw new Error('Data-layer registrations are finalized');
    }
    this._registerLayer(layerModule);
  }

  /** Register a synthetic layer after sealing in an explicitly dev-enabled manager. */
  registerForQa(layerModule) {
    if (!this._allowQaRegistration || !this._registrationsFinalized) {
      throw new Error('QA layer registration is not authorized');
    }
    this._registerLayer(layerModule);
    this._qaLayerIds.add(layerModule.id);
    return layerModule.id;
  }

  /** Destroy a layer previously registered through the dev QA seam. */
  async unregisterForQa(layerId) {
    if (!this._allowQaRegistration || !this._qaLayerIds.has(layerId)) return false;
    const destroyed = await this.destroyLayer(layerId);
    if (destroyed) this._qaLayerIds.delete(layerId);
    return destroyed;
  }

  _registerLayer(layerModule) {
    if (!layerModule || typeof layerModule.id !== 'string' || !layerModule.id) {
      throw new Error('Data layer must provide a stable id');
    }
    if (this.layers.has(layerModule.id)) {
      throw new Error(`Duplicate data-layer id: ${layerModule.id}`);
    }
    this.layers.set(layerModule.id, {
      module: layerModule,
      enabled: false,
      initialized: false,
      intervalId: null,
      // Periodic data refreshes are manager-owned work, independent from the
      // authoritative enable/disable lifecycle above. Every registered layer
      // receives the same normalized presentation contract even when its own
      // getStats() omits loading fields.
      refreshing: false,
      refreshEpoch: 0,
      managerRefreshError: null,
      // `enabled` is authoritative settled visibility. Awaited lifecycle work
      // is reported separately so callers never mistake activation for ON or
      // teardown for OFF before the transaction settles.
      lifecycleState: 'disabled',
      // A lifecycle rejection can leave the module's real state unknowable.
      // Keep the conservative public state, but do not let setEnabled() treat
      // that state as settled until the requested lifecycle is reconciled.
      lifecycleUncertain: false,
      // Absolute setEnabled() calls own a monotonic intent lane separate from
      // relative toggle() calls. A newer request can abort lifecycle work that
      // is already inside this entry's serialized queue, while the epoch keeps
      // older queued requests from starting after they have been superseded.
      visibilityIntentEpoch: 0,
      visibilityIntentEnabled: false,
      visibilityIntentOrigin: 'programmatic',
      activeVisibilityIntent: null,
      latestQueuedAbsoluteIntent: null,
      pendingVisibilityAdoptionEpoch: 0,
      // Exact absolute-intent completions are retained in a small bounded map.
      // Context transactions use these records to adopt a named successor
      // without guessing from mutable lifecycle state during listener re-entry.
      visibilityIntentRecords: new Map(),
      visibilityIntentFailures: new Map(),
      paramsIntentEpoch: 0,
      paramsIntentOrigin: 'programmatic',
      // Teardown owns the layer from its synchronous entry boundary. New
      // visibility work is refused while destroy drains and cleans up earlier
      // intents, so no request can publish settled state into a dying entry.
      destroying: false,
      // Clear All reserves its complete target set synchronously before any
      // per-layer teardown begins. A later absolute request supersedes this
      // reservation by advancing visibilityIntentEpoch.
      clearVisibilityReservation: null,
      // Promise chain that serializes toggle() calls for THIS entry. Without it
      // a second toggle during the awaited init()/first-update() of the first
      // interleaves: the disable branch runs while enable is mid-flight, the
      // interval is armed after the user already turned the layer off, and a
      // subsequent enable arms a SECOND interval → 2× poll → OpenSky 429 (M1).
      toggleChain: Promise.resolve(),
    });
  }

  /** Seal registration and prove each production layer has one share disposition. */
  finalizeRegistrations(serializationRegistry) {
    if (this._registrationsFinalized) throw new Error('Data-layer registrations are already finalized');
    if (!Array.isArray(serializationRegistry)) throw new Error('Layer serialization registry must be an array');
    const dispositions = new Map();
    for (const entry of serializationRegistry) {
      if (!entry?.id || !entry?.disposition) throw new Error('Layer serialization disposition is incomplete');
      if (dispositions.has(entry.id)) throw new Error(`Duplicate layer serialization disposition: ${entry.id}`);
      if (!VALID_LAYER_SERIALIZATION_DISPOSITIONS.has(entry.disposition)) {
        throw new Error(`Invalid layer serialization disposition: ${entry.id}`);
      }
      dispositions.set(entry.id, entry.disposition);
    }
    const registeredIds = [...this.layers.keys()];
    const missing = registeredIds.filter((id) => !dispositions.has(id));
    const extra = [...dispositions.keys()].filter((id) => !this.layers.has(id));
    if (missing.length || extra.length) {
      throw new Error(`Layer serialization registry mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
    }
    this._registrationDispositions = dispositions;
    this._registrationsFinalized = true;
    return true;
  }

  get registrationsFinalized() {
    return this._registrationsFinalized;
  }

  _moduleStats(entry) {
    if (!entry?.initialized || typeof entry.module?.getStats !== 'function') {
      return { count: 0, lastUpdate: null };
    }
    try {
      const stats = entry.module.getStats();
      return stats && typeof stats === 'object' ? stats : { count: 0, lastUpdate: null };
    } catch (error) {
      console.warn(`[Data] ${entry.module.id} getStats error:`, error);
      return { count: 0, lastUpdate: null, error };
    }
  }

  _normalizedStats(entry) {
    const moduleStats = this._moduleStats(entry);
    const lifecycleLoading = entry.lifecycleState === 'enabling' || entry.lifecycleState === 'disabling';
    return {
      count: 0,
      lastUpdate: null,
      ...moduleStats,
      loading: lifecycleLoading || moduleStats.loading === true,
      refreshing: entry.refreshing || moduleStats.refreshing === true,
      managerRefreshError: entry.managerRefreshError,
    };
  }

  _invalidateRefresh(layerId, entry, reason = 'invalidated') {
    const wasRefreshing = entry.refreshing;
    const refreshEpoch = entry.refreshEpoch;
    entry.refreshEpoch += 1;
    entry.refreshing = false;
    if (wasRefreshing) {
      this._refreshTogglePanel();
      this._notifyListeners({
        type: 'refresh-cancelled',
        layerId,
        enabled: entry.enabled,
        refreshEpoch,
        reason,
      });
    }
  }

  async _runPeriodicUpdate(layerId, entry, { signal = null } = {}) {
    if (
      !entry.enabled
      || entry.lifecycleState !== 'enabled'
      || entry.destroying
      || entry.refreshing
      || signal?.aborted
    ) return false;
    const refreshEpoch = ++entry.refreshEpoch;
    entry.refreshing = true;
    this._refreshTogglePanel();
    this._notifyListeners({
      type: 'refresh-transition',
      layerId,
      enabled: true,
      refreshEpoch,
    });

    let result;
    let failure = null;
    try {
      result = await entry.module.update(this.viewer, { signal });
      // Poll-tick entity refreshes don't auto-render in idle mode. Fires on
      // any non-throwing update — a rejected/partial refresh may still have
      // mutated scene state. (perf wave 2; moved into _runPeriodicUpdate
      // when main normalized the update loop behind _armUpdateLoop)
      governorRequestRender(`layer-tick:${layerId}`);
      // A poll tick can REPLACE what a layer exposes as detectable. Detection
      // pulls that set per paint but re-solves on a private throttle, so the one
      // frame requested above could be spent on a paint that declines to
      // re-solve — leaving the previous contact labelled and the new one not,
      // with nothing left to ask for another frame. (perf wave 2 follow-up)
      markDetectionSourcesChanged(`layer-tick:${layerId}`);
      if (result === false) failure = lifecycleRejectedError(layerId, 'refresh');
      if (!failure) failure = refreshFailureFromStats(this._moduleStats(entry), entry.module.name || layerId);
    } catch (error) {
      failure = error;
    }

    if (signal?.aborted) {
      if (
        this.layers.get(layerId) === entry
        && !entry.destroying
        && entry.enabled
        && entry.refreshEpoch === refreshEpoch
      ) {
        entry.refreshing = false;
        entry.managerRefreshError = null;
        this._refreshTogglePanel();
        this._notifyListeners({
          type: 'refresh-cancelled',
          layerId,
          enabled: true,
          refreshEpoch,
        });
      }
      return false;
    }

    if (
      this.layers.get(layerId) !== entry
      || entry.destroying
      || !entry.enabled
      || entry.refreshEpoch !== refreshEpoch
    ) {
      return false;
    }

    entry.refreshing = false;
    entry.managerRefreshError = failure ? String(failure.message || failure) : null;
    this._refreshTogglePanel();
    if (failure) {
      console.warn(`[Data] ${layerId} refresh error:`, failure);
      this._notifyListeners({
        type: 'refresh-failed',
        layerId,
        enabled: true,
        refreshEpoch,
        phase: 'refresh',
        error: failure,
      });
      return false;
    }
    this._notifyListeners({
      type: 'refresh',
      layerId,
      enabled: true,
      refreshEpoch,
    });
    return result !== false;
  }

  /**
   * Request one fresh update for an already-enabled layer. If the periodic
   * loop currently owns a refresh, wait for it to settle and then run a new
   * update so viewport-dependent callers do not reuse work started for the
   * prior camera location.
   * @param {string} layerId Registered layer id.
   * @param {object} [options] Refresh authority.
   * @param {AbortSignal|null} [options.signal] Caller cancellation authority.
   * @returns {Promise<boolean>} True only when the requested fresh update settles successfully.
   */
  async refreshLayer(layerId, { signal = null } = {}) {
    const entry = this.layers.get(layerId);
    if (
      !entry
      || !entry.enabled
      || entry.lifecycleState !== 'enabled'
      || entry.destroying
      || signal?.aborted
    ) return false;

    if (entry.refreshing) {
      const settled = await new Promise((resolve) => {
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          unsubscribe();
          signal?.removeEventListener?.('abort', onAbort);
          resolve(value);
        };
        const onAbort = () => finish(false);
        const unsubscribe = this.subscribe((change) => {
          if (
            change?.layerId === layerId
            && ['refresh', 'refresh-failed', 'refresh-cancelled'].includes(change.type)
          ) {
            finish(true);
          }
        });
        signal?.addEventListener?.('abort', onAbort, { once: true });
        queueMicrotask(() => {
          if (!entry.refreshing) finish(true);
        });
      });
      if (
        !settled
        || signal?.aborted
        || this.layers.get(layerId) !== entry
        || !entry.enabled
        || entry.lifecycleState !== 'enabled'
        || entry.destroying
      ) return false;
    }

    return this._runPeriodicUpdate(layerId, entry, { signal });
  }

  /**
   * Refresh one enabled tracked layer at the destination, then let that layer
   * decide whether the requested ID was present in an authoritative snapshot.
   * Lifecycle success alone is deliberately insufficient for this decision.
   */
  async resolveLayerTrackingTarget(layerId, targetId, {
    signal = null,
    origin = 'share-restore',
  } = {}) {
    const entry = this.layers.get(layerId);
    const base = {
      layerId,
      targetId,
      origin,
      refreshSucceeded: false,
    };
    if (!entry || !entry.enabled || entry.destroying) {
      return { ...base, status: 'unavailable', reason: 'layer-unavailable' };
    }
    if (typeof entry.module?.resolveTrackingRestoreTarget !== 'function') {
      return { ...base, status: 'unsupported', reason: 'tracking-restore-unsupported' };
    }
    if (signal?.aborted) {
      return { ...base, status: 'cancelled', reason: String(signal.reason || 'aborted') };
    }

    const refreshSucceeded = await this.refreshLayer(layerId, { signal });
    if (signal?.aborted) {
      return {
        ...base,
        refreshSucceeded,
        status: 'cancelled',
        reason: String(signal.reason || 'aborted'),
      };
    }
    if (this.layers.get(layerId) !== entry || entry.destroying || !entry.enabled) {
      return {
        ...base,
        refreshSucceeded,
        status: 'destroyed',
        reason: 'layer-destroyed',
      };
    }

    try {
      const resolution = await entry.module.resolveTrackingRestoreTarget(targetId, {
        signal,
        origin,
        refreshSucceeded,
      });
      if (signal?.aborted) {
        return {
          ...base,
          refreshSucceeded,
          status: 'cancelled',
          reason: String(signal.reason || 'aborted'),
        };
      }
      const status = [
        'found', 'missing', 'source-unavailable', 'cancelled', 'superseded', 'destroyed',
      ].includes(resolution?.status)
        ? resolution.status
        : 'source-unavailable';
      return { ...base, refreshSucceeded, ...resolution, status };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return {
          ...base,
          refreshSucceeded,
          status: 'cancelled',
          reason: String(signal?.reason || error?.message || 'aborted'),
          errorClass: 'AbortError',
        };
      }
      return {
        ...base,
        refreshSucceeded,
        status: 'source-unavailable',
        reason: String(error?.message || error),
        errorClass: error?.name || 'Error',
      };
    }
  }

  _armUpdateLoop(layerId, entry) {
    const configuredRefreshInterval = Number(entry.module.refreshInterval);
    const updateInterval = Number(entry.module.updateInterval);
    const refreshInterval = configuredRefreshInterval > 0
      ? configuredRefreshInterval
      : (updateInterval > 0 ? updateInterval : 0);
    if (refreshInterval > 0) {
      entry.intervalId = setInterval(() => {
        void this._runPeriodicUpdate(layerId, entry);
      }, refreshInterval);
    } else if (updateInterval === 0) {
      entry.intervalId = setInterval(() => {
        if (!entry.enabled) return;
        this._refreshTogglePanel();
      }, entry.module.statsRefreshInterval || 1000);
    }
  }

  toggle(layerId, { origin = 'programmatic', notificationToken = null } = {}) {
    const entry = this.layers.get(layerId);
    if (!entry || entry.destroying) return Promise.resolve(false);
    // A relative user action still needs the same revocable authority as an
    // absolute request. Invert the effective (latest-intent) state now, then
    // let the absolute-intent lane serialize and cancel obsolete lifecycle
    // work. This also makes two rapid toggles deterministically mean ON, OFF.
    return this._setEnabledWithIntent(layerId, !this.isEffectivelyEnabled(layerId), {
      origin,
      notificationToken,
      notifyWillChangeBeforeEffective: true,
    }).promise;
  }

  _enqueueToggle(entry, operation) {
    const next = entry.toggleChain
      .catch(() => {})
      .then(operation);
    entry.toggleChain = next;
    return next;
  }

  _setLifecycleTransition(entry, requestedChange, lifecycleState) {
    entry.lifecycleState = lifecycleState;
    this._syncModuleLifecyclePresentation(entry);
    this._refreshTogglePanel();
    this._notifyListeners({
      ...requestedChange,
      type: 'visibility-transition',
      lifecycleState,
      settledEnabled: entry.enabled,
    });
  }

  _settleLifecycle(entry) {
    entry.lifecycleState = entry.enabled ? 'enabled' : 'disabled';
    this._syncModuleLifecyclePresentation(entry);
  }

  _syncModuleLifecyclePresentation(entry) {
    if (typeof entry.module.setLifecyclePresentation !== 'function') return;
    try {
      entry.module.setLifecyclePresentation({
        lifecycleState: entry.lifecycleState,
        enabled: entry.enabled,
        uncertain: entry.lifecycleUncertain,
      });
    } catch (error) {
      console.warn(`[Data] ${entry.module.id} lifecycle presentation error:`, error);
    }
  }

  _visibilityCancellationMetadata(entry, intentEpoch, signal, phase, resourceAbort = false) {
    const hasSuccessor = Number.isInteger(intentEpoch) && entry.visibilityIntentEpoch > intentEpoch;
    const metadata = {
      ...(Number.isInteger(intentEpoch) ? { intentEpoch } : {}),
      phase,
      cancellationReason: resourceAbort
        ? 'resource-abort'
        : (hasSuccessor || signal?.reason === SUPERSEDED_VISIBILITY_INTENT
          ? 'superseded'
          : 'caller-abort'),
      ...(hasSuccessor ? {
        successorIntentEpoch: entry.visibilityIntentEpoch,
        successorEnabled: entry.visibilityIntentEnabled,
        successorOrigin: entry.visibilityIntentOrigin,
      } : {}),
    };
    const record = entry.visibilityIntentRecords.get(intentEpoch);
    if (record) Object.assign(record, metadata);
    return metadata;
  }

  _setVisibilityIntentPhase(entry, intentEpoch, phase) {
    if (!Number.isInteger(intentEpoch)) return;
    const record = entry.visibilityIntentRecords.get(intentEpoch);
    if (record) record.phase = phase;
  }

  async _doToggle(entry, layerId, origin, {
    signal = null,
    targetEnabled = !entry.enabled,
    notificationToken = null,
    intentEpoch = null,
    suppressWillChangeNotification = false,
    beforeEnableParams = null,
  } = {}) {
    const desiredState = Boolean(targetEnabled);
    const recordVisibilityFailure = (phase, error) => {
      if (!Number.isInteger(intentEpoch)) return;
      entry.visibilityIntentFailures.set(intentEpoch, {
        phase,
        error: error || lifecycleRejectedError(layerId, phase),
      });
    };
    const isSuperseded = () => (
      intentEpoch !== null && intentEpoch !== entry.visibilityIntentEpoch
    );
    const settleLifecycle = () => {
      if (!isSuperseded()) {
        entry.pendingVisibilityAdoptionEpoch = 0;
        this._settleLifecycle(entry);
        // setLifecyclePresentation() is synchronous and may notify a
        // subscriber that immediately issues a newer absolute request. Re-read
        // the epoch after that callback boundary before treating settlement as
        // owned by this transaction.
        if (!isSuperseded()) return true;
      }
      // Cleanup belongs to the obsolete transaction, so retain the actual
      // conservative state but keep presentation transitional/hidden. The
      // latest queued absolute request will reconcile or adopt it and alone
      // publish settled visibility under its own origin.
      entry.lifecycleState = entry.visibilityIntentEnabled ? 'enabling' : 'disabling';
      entry.pendingVisibilityAdoptionEpoch = entry.visibilityIntentEpoch;
      this._syncModuleLifecyclePresentation(entry);
      return false;
    };
    const requestedChange = {
      type: 'visibility-will-change',
      layerId,
      enabled: desiredState,
      origin,
      ...(Number.isInteger(intentEpoch) ? { intentEpoch } : {}),
      ...(notificationToken ? { notificationToken } : {}),
    };
    if (signal?.aborted) return false;
    if (!suppressWillChangeNotification) this._notifyListeners(requestedChange);
    const blockReason = await this._visibilityBlockReason(requestedChange);
    if (signal?.aborted) {
      this._notifyListeners({
        ...requestedChange,
        type: 'visibility-cancelled',
        ...this._visibilityCancellationMetadata(entry, intentEpoch, signal, 'guard'),
      });
      return false;
    }
    if (blockReason) {
      this._refreshTogglePanel();
      this._notifyListeners({
        ...requestedChange,
        type: 'visibility-blocked',
        reason: blockReason,
      });
      return false;
    }
    this._setLifecycleTransition(
      entry,
      requestedChange,
      desiredState ? 'enabling' : 'disabling',
    );
    if (!desiredState) {
      // Disable
      this._invalidateRefresh(layerId, entry, 'layer-disabled');
      const finishCancelledDisable = async (phase = 'disable', resourceAbort = false) => {
        // The module may already have completed its disable work, so compensate
        // inside this serialized manager transaction. Restore ON only after a
        // successful enable; otherwise remain truthfully OFF and let the next
        // setEnabled(true) perform real lifecycle work.
        let compensated = false;
        let compensationError = null;
        try {
          compensated = await entry.module.enable(this.viewer) !== false;
          if (!compensated) {
            compensationError = lifecycleRejectedError(layerId, 'cancel-disable-compensation');
          }
        } catch (error) {
          compensationError = error;
          console.warn(`[Data] ${layerId} cancelled-disable cleanup error:`, error);
        }
        let cleanupConfirmed = false;
        if (!compensated) {
          try {
            cleanupConfirmed = await entry.module.disable(this.viewer) !== false;
          } catch (error) {
            console.warn(`[Data] ${layerId} cancelled-disable final cleanup error:`, error);
          }
        }
        // A failed enable may have partially activated the module. Only record
        // OFF when a subsequent disable positively confirms cleanup; otherwise
        // retain ON as the conservative authoritative state.
        entry.enabled = compensated || !cleanupConfirmed;
        entry.lifecycleUncertain = !compensated && !cleanupConfirmed;
        settleLifecycle();
        if (!entry.enabled && entry.intervalId) {
          clearInterval(entry.intervalId);
          entry.intervalId = null;
        }
        this._refreshTogglePanel();
        if (!compensated) {
          recordVisibilityFailure(
            'cancel-disable-compensation',
            compensationError || lifecycleRejectedError(layerId, 'cancel-disable-compensation'),
          );
        }
        this._notifyListeners({
          ...requestedChange,
          type: compensated ? 'visibility-cancelled' : 'visibility-failed',
          ...(compensated
            ? this._visibilityCancellationMetadata(entry, intentEpoch, signal, phase, resourceAbort)
            : {}),
          ...(compensated ? {} : {
            phase: 'cancel-disable-compensation',
            error: compensationError,
          }),
        });
        return false;
      };
      try {
        const disabled = await entry.module.disable(this.viewer, { signal });
        if (disabled === false) throw lifecycleRejectedError(layerId, 'disable');
      } catch (e) {
        if (signal?.aborted || isAbortError(e)) {
          return finishCancelledDisable('disable', isAbortError(e) && !signal?.aborted);
        }
        // Fail closed: the module may still be polling or rendering, so keep
        // the manager's authoritative state enabled and preserve its interval.
        entry.enabled = true;
        entry.lifecycleUncertain = true;
        settleLifecycle();
        console.warn(`[Data] ${layerId} disable error:`, e);
        recordVisibilityFailure('disable', e);
        this._refreshTogglePanel();
        this._notifyListeners({
          ...requestedChange,
          type: 'visibility-failed',
          phase: 'disable',
          error: e,
        });
        return false;
      }
      if (signal?.aborted) return finishCancelledDisable('disable');
      if (entry.intervalId) {
        clearInterval(entry.intervalId);
        entry.intervalId = null;
      }
      entry.enabled = false;
      entry.lifecycleUncertain = false;
      if (!settleLifecycle() || signal?.aborted) return finishCancelledDisable('settle');
    } else {
      // Enable
      let abortCleanup = null;
      const cancelEnable = () => {
        if (entry.intervalId) {
          clearInterval(entry.intervalId);
          entry.intervalId = null;
        }
        // Disable immediately so modules with their own AbortController (Radio)
        // cancel pending update work at the same turn boundary. A second
        // disable after the current lifecycle await settles closes the race
        // where an asynchronous enable finishes after this callback.
        try {
          abortCleanup = Promise.resolve(entry.module.disable(this.viewer)).catch((error) => {
            console.warn(`[Data] ${layerId} cancelled-enable cleanup error:`, error);
            return false;
          });
        } catch (error) {
          console.warn(`[Data] ${layerId} cancelled-enable cleanup error:`, error);
          abortCleanup = Promise.resolve(false);
        }
      };
      const finishCancelledEnable = async (phase, resourceAbort = false) => {
        // A resource-local AbortError settles this transaction without
        // aborting the caller's signal. Release that signal's listener now so
        // a later abort cannot revoke a successful retry.
        signal?.removeEventListener('abort', cancelEnable);
        if (entry.intervalId) {
          clearInterval(entry.intervalId);
          entry.intervalId = null;
        }
        await abortCleanup;
        let cleanupConfirmed = false;
        try { cleanupConfirmed = await entry.module.disable(this.viewer) !== false; } catch (error) {
          console.warn(`[Data] ${layerId} cancelled-enable final cleanup error:`, error);
        }
        entry.enabled = !cleanupConfirmed;
        entry.lifecycleUncertain = !cleanupConfirmed;
        settleLifecycle();
        this._refreshTogglePanel();
        if (!cleanupConfirmed) {
          recordVisibilityFailure(
            'cancel-enable-cleanup',
            lifecycleRejectedError(layerId, 'cancel-enable-cleanup'),
          );
        }
        this._notifyListeners({
          ...requestedChange,
          type: cleanupConfirmed ? 'visibility-cancelled' : 'visibility-failed',
          ...(cleanupConfirmed
            ? this._visibilityCancellationMetadata(entry, intentEpoch, signal, phase, resourceAbort)
            : {}),
          ...(cleanupConfirmed ? {} : { phase: 'cancel-enable-cleanup' }),
        });
        return false;
      };
      const finishFailedEnable = async (phase, error) => {
        if (entry.intervalId) {
          clearInterval(entry.intervalId);
          entry.intervalId = null;
        }
        let cleanupConfirmed = false;
        try { cleanupConfirmed = await entry.module.disable(this.viewer) !== false; } catch (cleanupError) {
          console.warn(`[Data] ${layerId} failed-enable cleanup error:`, cleanupError);
        }
        entry.enabled = !cleanupConfirmed;
        entry.lifecycleUncertain = !cleanupConfirmed;
        settleLifecycle();
        console.warn(`[Data] ${layerId} ${phase} error:`, error);
        recordVisibilityFailure(phase, error);
        this._refreshTogglePanel();
        this._notifyListeners({
          ...requestedChange,
          type: 'visibility-failed',
          phase,
          error,
        });
        signal?.removeEventListener('abort', cancelEnable);
        return false;
      };
      signal?.addEventListener('abort', cancelEnable, { once: true });
      if (!entry.initialized) {
        this._setVisibilityIntentPhase(entry, intentEpoch, 'init');
        try {
          const initialized = await entry.module.init(this.viewer, { signal });
          if (initialized === false) throw lifecycleRejectedError(layerId, 'init');
          entry.initialized = true;
        } catch (e) {
          if (signal?.aborted || isAbortError(e)) {
            return finishCancelledEnable('init', isAbortError(e) && !signal?.aborted);
          }
          return finishFailedEnable('init', e);
        }
      }
      if (signal?.aborted) return finishCancelledEnable('init');
      if (beforeEnableParams) {
        this._setVisibilityIntentPhase(entry, intentEpoch, 'params');
        const paramsResult = this._applyLayerParamsIntent(
          layerId,
          beforeEnableParams.params,
          {
            origin: beforeEnableParams.origin,
            paramsIntentEpoch: beforeEnableParams.paramsIntentEpoch,
          },
        );
        beforeEnableParams.result = paramsResult;
        if (!paramsResult.succeeded) {
          if (signal?.aborted || paramsResult.cancellationReason) {
            return finishCancelledEnable('params');
          }
          return finishFailedEnable('params', paramsResult.error || paramsRejectedError(layerId));
        }
      }
      if (signal?.aborted) return finishCancelledEnable('params');
      entry.lifecycleUncertain = false;
      this._setVisibilityIntentPhase(entry, intentEpoch, 'enable');
      try {
        const enabled = await entry.module.enable(this.viewer, { signal });
        if (enabled === false) throw lifecycleRejectedError(layerId, 'enable');
      } catch (e) {
        if (signal?.aborted || isAbortError(e)) {
          return finishCancelledEnable('enable', isAbortError(e) && !signal?.aborted);
        }
        return finishFailedEnable('enable', e);
      }
      if (signal?.aborted) return finishCancelledEnable('enable');

      // First update immediately
      this._setVisibilityIntentPhase(entry, intentEpoch, 'update');
      try {
        const updated = await entry.module.update(this.viewer, { signal });
        if (updated === false) throw lifecycleRejectedError(layerId, 'update');
      } catch (e) {
        if (signal?.aborted || isAbortError(e)) {
          return finishCancelledEnable('update', isAbortError(e) && !signal?.aborted);
        }
        return finishFailedEnable('update', e);
      }
      if (signal?.aborted) return finishCancelledEnable('update');
      entry.managerRefreshError = null;

      entry.enabled = true;
      entry.lifecycleUncertain = false;
      this._setVisibilityIntentPhase(entry, intentEpoch, 'settle');
      if (!settleLifecycle() || signal?.aborted) return finishCancelledEnable('settle');

      // Always clear any stale interval before assigning a new one, so we never
      // orphan a running timer and end up double-polling.
      if (entry.intervalId) {
        clearInterval(entry.intervalId);
        entry.intervalId = null;
      }

      // Manager-owned periodic refresh work has one normalized loading/error
      // contract. Camera-driven layers may keep updateInterval=0 and opt into
      // a slower data fetch with refreshInterval.
      this._armUpdateLoop(layerId, entry);
      signal?.removeEventListener('abort', cancelEnable);
    }

    this._refreshTogglePanel();
    governorRequestRender('layer-visibility');
    // Same reason as the poll tick: a layer appearing or disappearing changes
    // the detectable set wholesale, and the solve behind it has to be re-run.
    markDetectionSourcesChanged('layer-visibility');
    this._notifyListeners({
      type: 'visibility',
      layerId,
      enabled: entry.enabled,
      origin,
      ...(Number.isInteger(intentEpoch) ? { intentEpoch } : {}),
      ...(notificationToken ? { notificationToken } : {}),
    });
    return true;
  }

  /**
   * Ensure a layer is in the requested enabled/disabled state.
   * Deterministic helper for scripted scene playback.
   */
  setEnabled(layerId, shouldEnable, {
    origin = 'programmatic',
    signal = null,
    notificationToken = null,
  } = {}) {
    return this._setEnabledWithIntent(layerId, shouldEnable, {
      origin,
      signal,
      notificationToken,
    }).promise;
  }

  /**
   * Internal absolute-visibility request with an exact intent handle.
   * The ordinary setEnabled() promise remains the public control contract.
   */
  _setEnabledWithIntent(layerId, shouldEnable, {
    origin = 'programmatic',
    signal = null,
    notificationToken = null,
    notifyWillChangeBeforeEffective = false,
    beforeEnableParams = null,
  } = {}) {
    const entry = this.layers.get(layerId);
    if (!entry) return { intentEpoch: null, promise: Promise.resolve() };
    const desiredState = Boolean(shouldEnable);
    if (entry.destroying) {
      return { intentEpoch: null, promise: Promise.resolve(desiredState === false) };
    }
    cancelPendingLayerRestore(entry, origin, 'explicit-visibility');
    const intentEpoch = ++entry.visibilityIntentEpoch;
    entry.visibilityIntentEnabled = desiredState;
    entry.visibilityIntentOrigin = origin;
    let resolveIntentRecord;
    const settled = new Promise((resolve) => { resolveIntentRecord = resolve; });
    const intentRecord = {
      intentEpoch,
      enabled: desiredState,
      origin,
      phase: 'queued',
      settled,
      resolve: resolveIntentRecord,
    };
    entry.visibilityIntentRecords.set(intentEpoch, intentRecord);
    for (const [recordEpoch, record] of entry.visibilityIntentRecords) {
      if (entry.visibilityIntentRecords.size <= 16) break;
      if (recordEpoch !== intentEpoch && record.completed) entry.visibilityIntentRecords.delete(recordEpoch);
    }
    // Relative toggle historically exposes its will-change edge while the
    // settled/effective snapshot is still the pre-click state. Preserve that
    // Context capture boundary, but reserve the epoch first so a re-entrant
    // listener can still supersede this request authoritatively.
    if (notifyWillChangeBeforeEffective) {
      this._notifyListeners({
        type: 'visibility-will-change',
        layerId,
        enabled: desiredState,
        origin,
        intentEpoch,
        ...(notificationToken ? { notificationToken } : {}),
      });
    }
    // Effective visibility must follow the NEWEST absolute intent from the
    // synchronous moment it is requested — the superseded transaction's
    // cleanup updates lifecycleState later, and Context capture can run in
    // between. Cleared by this request's own queue turn when it finishes.
    if (entry.visibilityIntentEpoch === intentEpoch) {
      entry.latestQueuedAbsoluteIntent = { intentEpoch, enabled: desiredState };
    }
    this._notifyVisibilityRequest({
      type: 'visibility-requested',
      layerId,
      enabled: desiredState,
      origin,
      intentEpoch,
      ...(notificationToken ? { notificationToken } : {}),
    });
    // Advance absolute intent before aborting so the obsolete transaction's
    // cleanup can defer settlement to this exact latest epoch. Supersede even
    // a same-target request: its newer origin may carry explicit user intent
    // that must own the eventual persistence-bearing visibility event.
    entry.activeVisibilityIntent?.controller.abort(SUPERSEDED_VISIBILITY_INTENT);
    // The idempotency check belongs inside the same per-layer queue as toggle.
    // Checking before enqueueing lets two simultaneous setEnabled(true) calls
    // both observe OFF and accidentally perform enable-then-disable (M6).
    const releaseQueuedIntent = () => {
      if (entry.latestQueuedAbsoluteIntent?.intentEpoch === intentEpoch) {
        entry.latestQueuedAbsoluteIntent = null;
      }
    };
    const runIntentTurn = async () => {
      const requestedChange = {
        type: 'visibility-will-change',
        layerId,
        enabled: desiredState,
        origin,
        intentEpoch,
        ...(notificationToken ? { notificationToken } : {}),
      };
      if (intentEpoch !== entry.visibilityIntentEpoch) {
        this._notifyListeners({
          ...requestedChange,
          type: 'visibility-cancelled',
          ...this._visibilityCancellationMetadata(entry, intentEpoch, null, 'queued'),
        });
        return false;
      }
      if (signal?.aborted) {
        if (entry.pendingVisibilityAdoptionEpoch === intentEpoch) {
          entry.pendingVisibilityAdoptionEpoch = 0;
          this._settleLifecycle(entry);
          this._refreshTogglePanel();
        }
        // Every accepted absolute request has one authoritative terminal
        // outcome. Even when it is aborted before its queue turn and no
        // adoption is pending, publish cancellation and populate the exact
        // intent record used by waiters.
        this._notifyListeners({
          ...requestedChange,
          type: 'visibility-cancelled',
          ...this._visibilityCancellationMetadata(entry, intentEpoch, signal, 'queued'),
        });
        return false;
      }
      if (
        entry.pendingVisibilityAdoptionEpoch === intentEpoch
        && entry.enabled === desiredState
        && !entry.lifecycleUncertain
      ) {
        // Adoption publishes a successful settled visibility, so it must pass
        // the same guards a fresh transition would — a guard installed after
        // the superseded transaction started (e.g. an exclusive Context mode)
        // must be able to veto the adopted state, not just future requests.
        const adoptionBlockReason = await this._visibilityBlockReason(requestedChange);
        if (intentEpoch !== entry.visibilityIntentEpoch) {
          // The guard is an async boundary. A newer intent can arrive while it
          // is pending, so this adoption needs the same exact terminal envelope
          // as every other superseded phase. Context follows these successor
          // fields instead of guessing from mutable manager state.
          if (entry.pendingVisibilityAdoptionEpoch === intentEpoch) {
            entry.pendingVisibilityAdoptionEpoch = entry.visibilityIntentEpoch;
          }
          entry.lifecycleState = entry.visibilityIntentEnabled ? 'enabling' : 'disabling';
          this._syncModuleLifecyclePresentation(entry);
          this._refreshTogglePanel();
          this._notifyListeners({
            ...requestedChange,
            type: 'visibility-cancelled',
            ...this._visibilityCancellationMetadata(entry, intentEpoch, null, 'adoption'),
          });
          return false;
        }
        if (signal?.aborted) {
          if (entry.pendingVisibilityAdoptionEpoch === intentEpoch) {
            entry.pendingVisibilityAdoptionEpoch = 0;
            this._settleLifecycle(entry);
            this._refreshTogglePanel();
            this._notifyListeners({
              ...requestedChange,
              type: 'visibility-cancelled',
              ...this._visibilityCancellationMetadata(entry, intentEpoch, signal, 'adoption'),
            });
          }
          return false;
        }
        if (adoptionBlockReason) {
          entry.pendingVisibilityAdoptionEpoch = 0;
          this._refreshTogglePanel();
          if (entry.enabled === desiredState) {
            // The guard forbids the very state the superseded transaction's
            // cleanup left behind. Reconcile through the ordinary lifecycle to
            // the guard-respecting opposite — but the CALLER's request stays
            // unfulfilled either way. Ordering matters: the compensation
            // registers as the active intent AND takes over the queued-intent
            // record BEFORE the blocked event is announced, so a listener that
            // re-enters setEnabled() during the callback has a live intent to
            // abort and observes the reconciliation target as effective
            // visibility, not the refused request.
            const compensationController = new AbortController();
            const compensationIntent = {
              intentEpoch,
              enabled: !desiredState,
              controller: compensationController,
            };
            entry.activeVisibilityIntent = compensationIntent;
            entry.latestQueuedAbsoluteIntent = { intentEpoch, enabled: !desiredState };
            this._notifyListeners({
              ...requestedChange,
              type: 'visibility-blocked',
              reason: adoptionBlockReason,
            });
            // The callback may have superseded this turn. The newest intent
            // owns reconciliation now — defer exactly like an obsolete
            // transaction instead of installing an already-doomed compensation.
            if (
              intentEpoch !== entry.visibilityIntentEpoch
              || compensationController.signal.aborted
            ) {
              if (entry.activeVisibilityIntent === compensationIntent) {
                entry.activeVisibilityIntent = null;
              }
              entry.lifecycleState = entry.visibilityIntentEnabled ? 'enabling' : 'disabling';
              entry.pendingVisibilityAdoptionEpoch = entry.visibilityIntentEpoch;
              this._syncModuleLifecyclePresentation(entry);
              return false;
            }
            try {
              await this._doToggle(entry, layerId, origin, {
                signal: compensationController.signal,
                targetEnabled: !desiredState,
                notificationToken,
                intentEpoch,
              });
            } finally {
              if (entry.activeVisibilityIntent === compensationIntent) {
                entry.activeVisibilityIntent = null;
              }
            }
            return false;
          }
          this._notifyListeners({
            ...requestedChange,
            type: 'visibility-blocked',
            reason: adoptionBlockReason,
          });
          this._settleLifecycle(entry);
          return false;
        }
        entry.pendingVisibilityAdoptionEpoch = 0;
        this._settleLifecycle(entry);
        if (intentEpoch !== entry.visibilityIntentEpoch) {
          entry.lifecycleState = entry.visibilityIntentEnabled ? 'enabling' : 'disabling';
          entry.pendingVisibilityAdoptionEpoch = entry.visibilityIntentEpoch;
          this._syncModuleLifecyclePresentation(entry);
          return false;
        }
        this._refreshTogglePanel();
        this._notifyListeners({
          type: 'visibility',
          layerId,
          enabled: desiredState,
          origin,
          intentEpoch,
          ...(notificationToken ? { notificationToken } : {}),
        });
        return true;
      }
      if (entry.enabled === desiredState && !entry.lifecycleUncertain) {
        // Idempotent exit — but an aborted predecessor (e.g. a compensation
        // cancelled before its first transition) may have left a stale
        // transitional presentation. State and intent agree here, so settle
        // the presentation rather than orphaning ENABLING/DISABLING forever.
        // Publish the accepted absolute intent even when lifecycle work is a
        // no-op: a newer explicit origin can own Context/persistence behavior
        // without redundantly re-enabling the module.
        if (entry.lifecycleState === 'enabling' || entry.lifecycleState === 'disabling') {
          this._settleLifecycle(entry);
        }
        this._refreshTogglePanel();
        this._notifyListeners({
          type: 'visibility',
          layerId,
          enabled: desiredState,
          origin,
          intentEpoch,
          ...(notificationToken ? { notificationToken } : {}),
        });
        return true;
      }

      entry.pendingVisibilityAdoptionEpoch = 0;
      const controller = new AbortController();
      const forwardCallerAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', forwardCallerAbort, { once: true });
      const activeIntent = { intentEpoch, enabled: desiredState, controller };
      entry.activeVisibilityIntent = activeIntent;
      try {
        return await this._doToggle(entry, layerId, origin, {
          signal: controller.signal,
          targetEnabled: desiredState,
          notificationToken,
          intentEpoch,
          suppressWillChangeNotification: notifyWillChangeBeforeEffective,
          beforeEnableParams,
        });
      } finally {
        signal?.removeEventListener('abort', forwardCallerAbort);
        if (entry.activeVisibilityIntent === activeIntent) {
          entry.activeVisibilityIntent = null;
        }
      }
    };
    const promise = this._enqueueToggle(entry, async () => {
      try {
        return await runIntentTurn();
      } finally {
        // This turn no longer owns queued-intent effective visibility —
        // either it settled, or a newer epoch superseded it (that epoch's
        // own record already replaced this one).
        releaseQueuedIntent();
      }
    });
    promise.then((result) => {
      const failure = entry.visibilityIntentFailures.get(intentEpoch) || null;
      entry.visibilityIntentFailures.delete(intentEpoch);
      intentRecord.completed = true;
      intentRecord.result = result;
      intentRecord.error = failure?.error || null;
      intentRecord.settledEnabled = entry.enabled;
      intentRecord.uncertain = entry.lifecycleUncertain;
      intentRecord.resolve({
        intentEpoch,
        enabled: desiredState,
        origin,
        phase: failure?.phase || intentRecord.phase,
        result,
        ...(failure?.error ? { error: failure.error } : {}),
        settledEnabled: entry.enabled,
        uncertain: entry.lifecycleUncertain,
        succeeded: result !== false && entry.enabled === desiredState && !entry.lifecycleUncertain,
        cancellationReason: intentRecord.cancellationReason || null,
        successorIntentEpoch: intentRecord.successorIntentEpoch ?? null,
        successorEnabled: intentRecord.successorEnabled ?? null,
        successorOrigin: intentRecord.successorOrigin ?? null,
      });
    }, (error) => {
      entry.visibilityIntentFailures.delete(intentEpoch);
      intentRecord.completed = true;
      intentRecord.error = error;
      intentRecord.resolve({
        intentEpoch,
        enabled: desiredState,
        origin,
        phase: intentRecord.phase,
        result: false,
        error,
        settledEnabled: entry.enabled,
        uncertain: entry.lifecycleUncertain,
        succeeded: false,
        cancellationReason: intentRecord.cancellationReason || null,
        successorIntentEpoch: intentRecord.successorIntentEpoch ?? null,
        successorEnabled: intentRecord.successorEnabled ?? null,
        successorOrigin: intentRecord.successorOrigin ?? null,
      });
    });
    return { intentEpoch, promise };
  }

  /** Wait for one exact absolute visibility intent to complete. */
  async _waitForVisibilityIntent(layerId, intentEpoch) {
    const record = this.layers.get(layerId)?.visibilityIntentRecords?.get(intentEpoch);
    return record ? record.settled : null;
  }

  /**
   * Follow one restore request through any explicit superseding intent chain.
   * The newest named successor must reach a terminal state before restore can
   * judge the layer; an obsolete caller boolean is never sufficient.
   */
  async _waitForAuthoritativeVisibilityIntent(layerId, intentEpoch) {
    const entry = this.layers.get(layerId);
    if (!entry || !Number.isInteger(intentEpoch)) return null;
    let epoch = intentEpoch;
    let outcome = null;
    while (Number.isInteger(epoch)) {
      outcome = await this._waitForVisibilityIntent(layerId, epoch);
      if (!outcome) return null;
      const newerEpoch = entry.visibilityIntentEpoch > epoch
        ? entry.visibilityIntentEpoch
        : outcome.successorIntentEpoch;
      if (!Number.isInteger(newerEpoch) || newerEpoch <= epoch) break;
      if (outcome.cancellationReason !== 'superseded') return null;
      epoch = newerEpoch;
    }
    return outcome;
  }

  /**
   * The layer's effective visibility target: settled state, unless awaited
   * lifecycle work (or a superseded transaction awaiting adoption) is moving
   * it — an ENABLING layer is effectively ON and a DISABLING layer is
   * effectively OFF, regardless of which side has settled.
   */
  _effectiveEnabled(entry) {
    // Newest-intent-wins: an absolute request owns effective visibility from
    // the synchronous moment it is made, even while a superseded transaction
    // has not yet updated lifecycleState.
    if (
      entry.clearVisibilityReservation
      && entry.visibilityIntentEpoch === entry.clearVisibilityReservation.intentEpoch
    ) return false;
    if (entry.latestQueuedAbsoluteIntent) return entry.latestQueuedAbsoluteIntent.enabled;
    if (entry.lifecycleState === 'enabling') return true;
    if (entry.lifecycleState === 'disabling') return false;
    return entry.enabled;
  }

  /**
   * Whether a layer is effectively enabled, counting in-flight transitions as
   * their target state. Context capture/isolation must use THIS (not the
   * settled `isEnabled()`) so a layer mid-activation is isolated and
   * snapshotted as ON, and a layer honoring a user's in-flight OFF is not
   * snapshotted (and later restored) as ON.
   * @param {string} layerId Registered layer identifier.
   * @returns {boolean}
   */
  isEffectivelyEnabled(layerId) {
    const entry = this.layers.get(layerId);
    return entry ? this._effectiveEnabled(entry) : false;
  }

  /**
   * Snapshot the exact set of registered layers the user currently intends
   * enabled, counting in-flight transitions as their target state.
   * @returns {Set<string>} A detached set safe for later restoration.
   */
  getEnabledLayerIds() {
    return new Set(
      [...this.layers]
        .filter(([, entry]) => this._effectiveEnabled(entry))
        .map(([layerId]) => layerId),
    );
  }

  /**
   * Turn off every layer whose latest authoritative intent is currently ON.
   * Reverse registration order lets dependents settle their teardown before
   * an earlier-registered dependency receives its final OFF intent. Each layer
   * keeps its normal latest-intent manager authority, so a newer direct request
   * can supersede this batch without being overwritten by a retry loop.
   *
   * @param {object} [options] Clear transition options.
   * @param {string} [options.origin='user'] Visibility-event origin.
   * @param {symbol|null} [options.notificationToken] Shared notification owner.
   * @returns {Promise<{targetIds:string[],items:object[],clearedIds:string[],notClearedIds:string[]}>}
   */
  async clearSelectedLayers({ origin = 'user', notificationToken = null } = {}) {
    const clearBatchId = Symbol('clear-selected-layers');
    const targets = [...this.layers]
      .filter(([, entry]) => this._effectiveEnabled(entry))
      .map(([layerId, entry]) => ({
        layerId,
        intentEpoch: entry.visibilityIntentEpoch,
      }))
      .reverse();
    // Reserve the whole batch before the first awaited OFF. This makes Clear
    // All's global OFF authority observable synchronously while preserving
    // reverse-order lifecycle teardown. Any later absolute intent advances
    // the epoch and therefore owns that layer instead.
    for (const { layerId, intentEpoch } of targets) {
      const entry = this.layers.get(layerId);
      if (entry) entry.clearVisibilityReservation = { clearBatchId, intentEpoch };
    }
    const targetIds = targets.map(({ layerId }) => layerId);
    const attempts = new Map();
    try {
      for (const { layerId, intentEpoch } of targets) {
        const entry = this.layers.get(layerId);
        const superseded = entry && entry.visibilityIntentEpoch !== intentEpoch;
        if (superseded) {
          attempts.set(layerId, { superseded: true });
          continue;
        }
        try {
          const clearIntentEpoch = entry.visibilityIntentEpoch + 1;
          const result = await this.setEnabled(layerId, false, {
            origin,
            ...(notificationToken ? { notificationToken } : {}),
          });
          attempts.set(layerId, {
            result,
            superseded: entry.visibilityIntentEpoch !== clearIntentEpoch,
          });
        } catch (error) {
          attempts.set(layerId, { error });
        }
      }
    } finally {
      for (const { layerId } of targets) {
        const entry = this.layers.get(layerId);
        if (entry?.clearVisibilityReservation?.clearBatchId === clearBatchId) {
          entry.clearVisibilityReservation = null;
        }
      }
    }
    const items = targetIds.map((id) => {
      const state = this.getLayerLifecycleState(id) || {
        enabled: false,
        lifecycleState: 'missing',
        uncertain: true,
      };
      const attempt = attempts.get(id) || {};
      const cleared = !state.enabled && state.lifecycleState === 'disabled' && !state.uncertain;
      return {
        id,
        requested: false,
        cleared,
        result: attempt.result,
        error: attempt.error || null,
        superseded: attempt.superseded === true,
        ...state,
      };
    });
    return {
      targetIds,
      items,
      clearedIds: items.filter((item) => item.cleared).map((item) => item.id),
      notClearedIds: items.filter((item) => !item.cleared).map((item) => item.id),
    };
  }

  /**
   * Restore the exact enabled set captured before a focused mode took over.
   * Each transition uses the normal serialized lifecycle and visibility event
   * path so subscribers observe the same state changes as direct operations.
   *
   * @param {Iterable<string>} enabledLayerIds Exact target enabled layer ids.
   * @param {object} [options] Restore notification options.
   * @param {string} [options.origin='programmatic'] Visibility event origin.
   * @param {symbol|null} [options.notificationToken] Opaque caller token used
   * to correlate one transition's user-facing failure notification.
   * @param {Iterable<string>} [options.excludeLayerIds] Layers owned by an
   * in-flight transition that must not enqueue behind themselves.
   * @param {AbortSignal|null} [options.signal] Caller cancellation authority.
   * @returns {Promise<void>} Resolves after every registered layer settles.
   */
  async restoreEnabledLayerIds(
    enabledLayerIds,
    {
      origin = 'programmatic',
      excludeLayerIds = [],
      notificationToken = null,
      signal = null,
    } = {},
  ) {
    const target = new Set(enabledLayerIds || []);
    const excluded = new Set(excludeLayerIds || []);
    const layerIds = [...this.layers.keys()].filter((layerId) => {
      if (excluded.has(layerId)) return false;
      const entry = this.layers.get(layerId);
      // Pre-destroy restoration cannot enqueue onto the layer whose teardown
      // already owns OFF. That terminal teardown satisfies an OFF snapshot;
      // an impossible ON target remains visible to the failure checks below.
      return !(entry?.destroying && !target.has(layerId));
    });
    const transitionOptions = {
      origin,
      ...(notificationToken ? { notificationToken } : {}),
      ...(signal ? { signal } : {}),
    };
    const handles = layerIds.map((layerId) => this._setEnabledWithIntent(
      layerId,
      target.has(layerId),
      transitionOptions,
    ));
    const results = await Promise.allSettled(handles.map((handle, index) => (
      this._waitForAuthoritativeVisibilityIntent(layerIds[index], handle.intentEpoch)
    )));
    const failedLayerIds = results.flatMap((result, index) => {
      if (result.status === 'rejected') return [layerIds[index]];
      const outcome = result.value;
      const layerId = layerIds[index];
      const state = this.getLayerLifecycleState(layerId);
      const desiredState = target.has(layerId);
      const failed = !outcome
        || outcome.error
        || !state
        || state.enabled !== desiredState
        || state.lifecycleState !== (desiredState ? 'enabled' : 'disabled')
        || state.uncertain
        || this.layers.get(layerId)?.latestQueuedAbsoluteIntent;
      return failed ? [layerId] : [];
    });
    if (failedLayerIds.length === 0) return;
    const failedIndex = layerIds.indexOf(failedLayerIds[0]);
    const failed = results[failedIndex];
    const error = failed.status === 'rejected'
      ? failed.reason
      : new Error(`Failed to restore layer "${layerIds[failedIndex]}" visibility`);
    error.failedLayerIds = [...new Set([
      ...(Array.isArray(error.failedLayerIds) ? error.failedLayerIds : []),
      ...failedLayerIds,
    ])];
    throw error;
  }

  /**
   * Wait until lifecycle work already queued for one layer has settled.
   * Callers use this outside manager listeners before scheduling reconciliation.
   * @param {string} layerId Layer identifier.
   * @returns {Promise<void>} Resolves after the captured queue settles.
   */
  async waitForLayerSettled(layerId) {
    const entry = this.layers.get(layerId);
    if (!entry) return;
    await entry.toggleChain.catch(() => {});
  }

  _reserveLayerParamsIntent(layerId, params, origin = 'programmatic') {
    const entry = this.layers.get(layerId);
    if (!entry || entry.destroying || typeof entry.module?.setParams !== 'function') return null;
    cancelPendingLayerRestore(entry, origin, 'explicit-params');
    const paramsIntentEpoch = ++entry.paramsIntentEpoch;
    entry.paramsIntentOrigin = origin;
    this._notifyListeners({
      type: 'params-requested',
      layerId,
      params: cloneLayerParams(params || {}),
      origin,
      paramsIntentEpoch,
    });
    return paramsIntentEpoch;
  }

  _applyLayerParamsIntent(layerId, params, {
    origin = 'programmatic',
    paramsIntentEpoch = null,
  } = {}) {
    const entry = this.layers.get(layerId);
    if (!entry || !entry.module || typeof entry.module.setParams !== 'function') {
      return { succeeded: false, error: paramsRejectedError(layerId), params: null };
    }
    if (!Number.isInteger(paramsIntentEpoch) || entry.paramsIntentEpoch !== paramsIntentEpoch) {
      const result = { succeeded: false, cancellationReason: 'superseded', params: null };
      this._notifyListeners({
        type: 'params-cancelled',
        layerId,
        origin,
        paramsIntentEpoch,
        cancellationReason: result.cancellationReason,
        successorParamsIntentEpoch: entry.paramsIntentEpoch,
        successorOrigin: entry.paramsIntentOrigin,
      });
      return result;
    }
    try {
      const accepted = entry.module.setParams(params || {}, { origin, paramsIntentEpoch });
      if (accepted === false) throw paramsRejectedError(layerId);
      if (entry.paramsIntentEpoch !== paramsIntentEpoch) {
        const result = { succeeded: false, cancellationReason: 'superseded', params: null };
        this._notifyListeners({
          type: 'params-cancelled',
          layerId,
          origin,
          paramsIntentEpoch,
          cancellationReason: result.cancellationReason,
          successorParamsIntentEpoch: entry.paramsIntentEpoch,
          successorOrigin: entry.paramsIntentOrigin,
        });
        return result;
      }
      const appliedParams = this.getLayerParams(layerId) || cloneLayerParams(params || {});
      this._refreshTogglePanel();
      governorRequestRender(`layer-params:${layerId}`);
      this._notifyListeners({
        type: 'params',
        layerId,
        params: appliedParams,
        requestedParams: cloneLayerParams(params || {}),
        origin,
        paramsIntentEpoch,
      });
      return { succeeded: true, params: appliedParams, paramsIntentEpoch };
    } catch (error) {
      console.warn(`[Data] ${layerId} setParams error:`, error);
      this._notifyListeners({
        type: 'params-failed',
        layerId,
        params: cloneLayerParams(params || {}),
        origin,
        paramsIntentEpoch,
        error,
      });
      return { succeeded: false, error, params: null, paramsIntentEpoch };
    }
  }

  /** Apply runtime parameters through an origin-bearing intent lane. */
  setLayerParams(layerId, params, { origin = 'programmatic' } = {}) {
    const paramsIntentEpoch = this._reserveLayerParamsIntent(layerId, params, origin);
    if (!Number.isInteger(paramsIntentEpoch)) return false;
    return this._applyLayerParamsIntent(layerId, params, { origin, paramsIntentEpoch }).succeeded;
  }

  /** Cancel a module-owned pending restore without creating a parameter intent. */
  cancelPendingLayerRestore(layerId, {
    origin = 'programmatic',
    reason = 'cancelled',
  } = {}) {
    const entry = this.layers.get(layerId);
    const cancel = entry?.module?.cancelPendingRestore
      || entry?.module?.cancelPendingTrackingRestore;
    if (typeof cancel !== 'function') return false;
    try {
      cancel.call(entry.module, { origin, reason });
      return true;
    } catch (error) {
      console.warn(`[Data] ${layerId} pending restore cancellation error:`, error);
      return false;
    }
  }

  /** Publish parameters already applied by a layer's direct interaction. */
  adoptLayerParams(layerId, params, { origin = 'programmatic' } = {}) {
    const requestedParams = cloneLayerParams(params || {});
    const paramsIntentEpoch = this._reserveLayerParamsIntent(layerId, requestedParams, origin);
    if (!Number.isInteger(paramsIntentEpoch)) return false;
    const appliedParams = this.getLayerParams(layerId);
    const matches = appliedParams && Object.entries(requestedParams)
      .every(([key, value]) => Object.is(appliedParams[key], value));
    if (!matches) {
      const error = paramsRejectedError(layerId);
      this._notifyListeners({
        type: 'params-failed', layerId, params: requestedParams, origin, paramsIntentEpoch, error,
      });
      return false;
    }
    this._refreshTogglePanel();
    governorRequestRender(`layer-params:${layerId}`);
    this._notifyListeners({
      type: 'params', layerId, params: appliedParams, requestedParams, origin, paramsIntentEpoch,
    });
    return true;
  }

  /**
   * Publish an explicit owner adoption of an already-settled layer visibility.
   * This is used when a direct selection promotes a Context-owned dependency
   * into durable user state without redundantly re-running its lifecycle.
   */
  adoptLayerVisibility(
    layerId,
    enabled,
    { origin = 'programmatic', adoptedFromSelection = false } = {},
  ) {
    const entry = this.layers.get(layerId);
    const desiredState = Boolean(enabled);
    if (!entry || entry.enabled !== desiredState || entry.lifecycleUncertain) return false;
    cancelPendingLayerRestore(entry, origin, 'superseded-by-explicit-visibility-adoption');
    this._refreshTogglePanel();
    this._notifyListeners({
      type: 'visibility',
      layerId,
      enabled: desiredState,
      origin,
      intentEpoch: entry.visibilityIntentEpoch,
      adopted: true,
      adoptedFromSelection: Boolean(adoptedFromSelection),
    });
    return true;
  }

  /**
   * Restore one finalized-registry layer independently. Parameters apply after
   * init and before enable, with a terminal envelope that never writes local
   * persistence.
   */
  async restoreLayerState(layerId, { enabled = false, params = null } = {}, {
    origin = 'programmatic',
    signal = null,
  } = {}) {
    if (!this._registrationsFinalized) throw new Error('Layer restore requires finalized registrations');
    const entry = this.layers.get(layerId);
    const targetEnabled = Boolean(enabled);
    if (!entry) {
      return {
        layerId,
        targetEnabled,
        origin,
        phase: 'missing',
        settledEnabled: false,
        lifecycleState: 'missing',
        lifecycleUncertain: false,
        appliedOptions: {},
        errorClass: 'UnknownLayer',
        persistenceWrite: false,
        succeeded: false,
      };
    }

    const requestedParams = params && typeof params === 'object' && Object.keys(params).length
      ? cloneLayerParams(params)
      : null;
    let paramsEnvelope = null;
    let beforeEnableParams = null;
    if (requestedParams) {
      const paramsIntentEpoch = this._reserveLayerParamsIntent(layerId, requestedParams, origin);
      if (Number.isInteger(paramsIntentEpoch)) {
        if (targetEnabled && !entry.enabled) {
          beforeEnableParams = { params: requestedParams, origin, paramsIntentEpoch, result: null };
        } else {
          paramsEnvelope = this._applyLayerParamsIntent(layerId, requestedParams, {
            origin,
            paramsIntentEpoch,
          });
        }
      } else {
        paramsEnvelope = { succeeded: false, error: paramsRejectedError(layerId) };
      }
    }

    const handle = this._setEnabledWithIntent(layerId, targetEnabled, {
      origin,
      signal,
      beforeEnableParams,
    });
    const requestedVisibility = await this._waitForVisibilityIntent(layerId, handle.intentEpoch);
    const authoritativeVisibility = requestedVisibility?.cancellationReason === 'superseded'
      ? await this._waitForAuthoritativeVisibilityIntent(layerId, handle.intentEpoch)
      : requestedVisibility;
    paramsEnvelope = paramsEnvelope || beforeEnableParams?.result;
    const state = this.getLayerLifecycleState(layerId);
    const paramsSucceeded = !requestedParams || paramsEnvelope?.succeeded === true;
    const visibilitySucceeded = authoritativeVisibility?.succeeded === true
      && state?.enabled === targetEnabled
      && state?.uncertain === false;
    const error = paramsEnvelope?.error || authoritativeVisibility?.error
      || requestedVisibility?.error || null;
    return {
      layerId,
      targetEnabled,
      origin,
      phase: requestedVisibility?.phase || (signal?.aborted ? 'reserved' : 'unknown'),
      completionPhase: authoritativeVisibility?.phase || null,
      settledEnabled: Boolean(state?.enabled),
      lifecycleState: state?.lifecycleState || 'missing',
      lifecycleUncertain: Boolean(state?.uncertain),
      appliedOptions: paramsSucceeded && requestedParams ? requestedParams : {},
      intentEpoch: handle.intentEpoch,
      authoritativeIntentEpoch: authoritativeVisibility?.intentEpoch ?? handle.intentEpoch,
      authoritativeEnabled: authoritativeVisibility?.enabled ?? null,
      authoritativeOrigin: authoritativeVisibility?.origin ?? null,
      paramsIntentEpoch: paramsEnvelope?.paramsIntentEpoch ?? beforeEnableParams?.paramsIntentEpoch ?? null,
      cancellationReason: requestedVisibility?.cancellationReason
        || paramsEnvelope?.cancellationReason || null,
      successorIntentEpoch: requestedVisibility?.successorIntentEpoch ?? null,
      successorEnabled: requestedVisibility?.successorEnabled ?? null,
      successorOrigin: requestedVisibility?.successorOrigin ?? null,
      errorClass: error?.name || (signal?.aborted ? 'AbortError' : null),
      ...(error ? { error: String(error.message || error) } : {}),
      persistenceWrite: false,
      succeeded: paramsSucceeded && visibilitySucceeded,
    };
  }

  /**
   * Read runtime parameters from a layer if it exposes `getParams()`.
   */
  getLayerParams(layerId) {
    const entry = this.layers.get(layerId);
    if (!entry || !entry.module || typeof entry.module.getParams !== 'function') return null;
    try {
      const params = entry.module.getParams();
      if (!params || typeof params !== 'object') return null;
      return cloneLayerParams(params);
    } catch (error) {
      console.warn(`[Data] ${layerId} getParams error:`, error);
      return null;
    }
  }

  /**
   * Destroy a single layer — calls its destroy() method if it has one,
   * then removes it from the manager. This is the proper cleanup path
   * that was previously missing.
   */
  async destroyLayer(layerId) {
    const entry = this.layers.get(layerId);
    if (!entry || entry.destroying) return false;
    entry.destroying = true;
    this._invalidateRefresh(layerId, entry, 'layer-destroyed');
    // Teardown becomes authoritative before the first await. Advancing the
    // intent epoch and aborting active work prevents a pending enable/update
    // from publishing a settled ON while the layer is being destroyed. The
    // synthetic successor metadata also lets Context restore rather than adopt.
    const teardownIntentEpoch = ++entry.visibilityIntentEpoch;
    entry.visibilityIntentEnabled = false;
    entry.visibilityIntentOrigin = 'teardown';
    entry.latestQueuedAbsoluteIntent = { intentEpoch: teardownIntentEpoch, enabled: false };
    entry.clearVisibilityReservation = null;
    entry.activeVisibilityIntent?.controller.abort(SUPERSEDED_VISIBILITY_INTENT);
    entry.paramsIntentEpoch += 1;
    entry.paramsIntentOrigin = 'teardown';
    await entry.toggleChain.catch(() => {});
    // Let focused UI modes restore their exact pre-session state before any
    // dependency is irreversibly removed. The intent revocation above makes
    // this callback safe to run before the old queue drains.
    for (const callback of this._beforeDestroyListeners) {
      try {
        await callback({ type: 'before-destroy', layerId });
      } catch (error) {
        console.warn('[Data] before-destroy listener error:', error);
      }
    }
    await entry.toggleChain.catch(() => {});
    if (this.layers.get(layerId) !== entry) return false;
    entry.latestQueuedAbsoluteIntent = null;
    if (entry.enabled) {
      try {
        const disabled = await entry.module.disable(this.viewer);
        if (disabled === false) throw lifecycleRejectedError(layerId, 'destroy-disable');
      } catch (e) {
        console.warn(`[Data] ${layerId} disable error:`, e);
        entry.destroying = false;
        entry.visibilityIntentEnabled = entry.enabled;
        this._settleLifecycle(entry);
        this._refreshTogglePanel();
        return false;
      }
      if (entry.intervalId) {
        clearInterval(entry.intervalId);
        entry.intervalId = null;
      }
      entry.enabled = false;
    }
    if (typeof entry.module.destroy === 'function') {
      try {
        const destroyed = await entry.module.destroy(this.viewer);
        if (destroyed === false) throw lifecycleRejectedError(layerId, 'destroy');
      } catch (e) {
        console.warn(`[Data] ${layerId} destroy error:`, e);
        entry.destroying = false;
        entry.visibilityIntentEnabled = entry.enabled;
        this._settleLifecycle(entry);
        this._refreshTogglePanel();
        return false;
      }
    }
    this.layers.delete(layerId);
    this._qaLayerIds.delete(layerId);
    return true;
  }

  /**
   * Destroy all layers and clear the manager.
   * Should be called when the viewer is being torn down.
   */
  async destroyAll() {
    for (const layerId of [...this.layers.keys()]) {
      await this.destroyLayer(layerId);
    }
  }

  isEnabled(layerId) {
    const entry = this.layers.get(layerId);
    return entry ? entry.enabled : false;
  }

  /** Return authoritative settled visibility and the current lifecycle phase. */
  getLayerLifecycleState(layerId) {
    const entry = this.layers.get(layerId);
    if (!entry) return null;
    return Object.freeze({
      enabled: entry.enabled,
      lifecycleState: entry.lifecycleState,
      uncertain: entry.lifecycleUncertain,
    });
  }

  getAll() {
    const result = [];
    for (const [id, entry] of this.layers) {
      result.push({
        id,
        name: entry.module.name,
        icon: entry.module.icon,
        source: entry.module.source,
        showInTogglePanel: entry.module.showInTogglePanel !== false,
        enabled: entry.enabled,
        lifecycleState: entry.lifecycleState,
        lifecycleUncertain: entry.lifecycleUncertain,
        stats: this._normalizedStats(entry),
      });
    }
    return result;
  }

  subscribe(callback) {
    if (typeof callback !== 'function') return () => {};
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  /**
   * Subscribe to explicit setEnabled intent before it joins the lifecycle queue.
   * This lets a newer direct-user OFF request cancel older work before that work
   * can publish an intermediate settled visibility state.
   * @param {(change:{type:string,layerId:string,enabled:boolean,origin:string}) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  subscribeVisibilityRequests(callback) {
    if (typeof callback !== 'function') return () => {};
    this._visibilityRequestListeners.add(callback);
    return () => this._visibilityRequestListeners.delete(callback);
  }

  /**
   * Register a visibility guard evaluated before layer lifecycle work. Guards
   * may await bounded mode preparation and return a string or `{reason}` to
   * refuse a transition.
   * @param {(change:{type:string,layerId:string,enabled:boolean,origin:string}) => (string|object|null|void)} callback Guard.
   * @returns {() => void} Unsubscribe function.
   */
  addVisibilityGuard(callback) {
    if (typeof callback !== 'function') return () => {};
    this._visibilityGuards.add(callback);
    return () => this._visibilityGuards.delete(callback);
  }

  /**
   * Subscribe to the awaited pre-destroy lifecycle boundary.
   * @param {(change:{type:string,layerId:string}) => (void|Promise<void>)} callback
   * @returns {() => void} Unsubscribe function.
   */
  subscribeBeforeDestroy(callback) {
    if (typeof callback !== 'function') return () => {};
    this._beforeDestroyListeners.add(callback);
    return () => this._beforeDestroyListeners.delete(callback);
  }

  _notifyListeners(change) {
    for (const callback of this._listeners) {
      try {
        callback(change);
      } catch (error) {
        console.warn('[Data] listener error:', error);
      }
    }
  }

  _notifyVisibilityRequest(change) {
    for (const callback of this._visibilityRequestListeners) {
      try {
        callback(change);
      } catch (error) {
        console.warn('[Data] visibility request listener error:', error);
      }
    }
  }

  async _visibilityBlockReason(change) {
    for (const callback of this._visibilityGuards) {
      try {
        const result = await callback(change);
        if (typeof result === 'string' && result.trim()) return result.trim();
        if (result && typeof result.reason === 'string' && result.reason.trim()) {
          return result.reason.trim();
        }
      } catch (error) {
        console.warn('[Data] visibility guard error:', error);
      }
    }
    return null;
  }

  /**
   * Build the toggle panel UI inside the given container element.
   */
  buildTogglePanel(container) {
    this._toggleContainer = container;
    this._renderToggles();
  }

  _renderToggles() {
    if (!this._toggleContainer) return;
    this._toggleContainer.innerHTML = '';

    for (const layer of this.getAll()) {
      if (!layer.showInTogglePanel) continue;
      const row = document.createElement('div');
      row.className = 'data-toggle-row';
      row.dataset.layerId = layer.id;

      const topRow = document.createElement('div');
      topRow.className = 'data-toggle-top';

      const left = document.createElement('div');
      left.className = 'data-toggle-left';
      left.innerHTML = `<span class="data-icon">${layer.icon}</span><span class="data-name">${layer.name}</span>`;

      const right = document.createElement('div');
      right.className = 'data-toggle-right';

      const count = document.createElement('span');
      count.className = 'data-count';
      count.textContent = layer.stats.count ? this._formatCount(layer.stats.count) : '—';

      const toggle = document.createElement('button');
      toggle.className = `data-toggle-btn${layer.enabled ? ' active' : ''}`;
      this._syncToggleButton(toggle, layer);
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          await this.setEnabled(layer.id, !this.isEnabled(layer.id), { origin: 'user' });
        } catch (error) {
          console.warn(`[Data] ${layer.id} toggle error:`, error);
        } finally {
          toggle.disabled = false;
        }
      });

      right.appendChild(count);
      right.appendChild(toggle);
      topRow.appendChild(left);
      topRow.appendChild(right);

      const bottomRow = document.createElement('div');
      bottomRow.className = 'data-toggle-meta';
      bottomRow.textContent = this._buildMetaText(layer);

      row.appendChild(topRow);
      row.appendChild(bottomRow);

      // Optional per-layer sub-controls (chips + color legend). The click
      // listener is delegated and attached once here, so it survives
      // _refreshTogglePanel — which only rewrites the container's contents.
      const rowModule = this.layers.get(layer.id)?.module;
      if (typeof rowModule?.getRowControls === 'function') {
        // A layer whose controls settle asynchronously (a chunked catalog load
        // that can also fail) pushes a re-render through this; nothing else
        // would repaint the row before its next scheduled refresh.
        rowModule.setRowControlsListener?.(() => this._refreshTogglePanel());
        const controls = document.createElement('div');
        controls.className = 'data-toggle-controls';
        controls.addEventListener('click', (event) => {
          const button = event.target?.closest?.('.data-toggle-chip');
          if (!button || button.disabled) return;
          // Re-read the live descriptor rather than trusting the rendered
          // chip, so a stale row can never apply an inverted toggle.
          const chip = this._rowControlsFor(layer.id)?.chips
            ?.find((entry) => entry.id === button.dataset.chipId);
          if (chip?.params) this.setLayerParams(layer.id, chip.params, { origin: 'user' });
        });
        row.appendChild(controls);
        this._syncRowControls(controls, layer);
      }

      this._toggleContainer.appendChild(row);
    }
  }

  /**
   * Read a layer's optional row-control descriptor, tolerating a throw so one
   * misbehaving layer cannot blank the whole panel. Resolved from the registry
   * rather than the `getAll()` projection, which deliberately omits `module`.
   * @param {string} layerId Registered layer id.
   * @returns {{ chips?: Array<object>, legend?: Array<object> }|null} Descriptor.
   */
  _rowControlsFor(layerId) {
    const module = this.layers.get(layerId)?.module;
    if (typeof module?.getRowControls !== 'function') return null;
    try {
      return module.getRowControls() || null;
    } catch (error) {
      console.warn(`[Data] ${layerId} getRowControls error:`, error);
      return null;
    }
  }

  /**
   * Render a layer's row chips and color legend, and keep the whole block
   * hidden while the layer is off (or while a dependency owner has surrendered
   * it) so a quiet row stays quiet.
   *
   * Chip BUTTONS are reconciled in place, keyed by chip id, rather than
   * rebuilt: this runs on every panel refresh — including the one the chip's
   * own click triggers — and replacing the node would drop keyboard focus
   * mid-interaction. Legend entries hold no focus and no listeners, so they
   * are replaced freely.
   * @param {HTMLElement|null} container The row's `.data-toggle-controls` node.
   * @param {object} layer Registered layer entry.
   */
  _syncRowControls(container, layer) {
    if (!container) return;
    const controls = layer.enabled ? this._rowControlsFor(layer.id) : null;
    const chips = controls?.chips || [];
    const legend = controls?.legend || [];
    container.hidden = chips.length === 0 && legend.length === 0;

    for (const node of [...container.children]) {
      if (String(node.className).split(/\s+/).includes('data-toggle-legend-item')) node.remove();
    }

    const stale = new Map();
    for (const node of [...container.children]) {
      if (node.dataset?.chipId) stale.set(node.dataset.chipId, node);
    }

    for (const chip of chips) {
      let button = stale.get(chip.id);
      stale.delete(chip.id);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.dataset.chipId = chip.id;
        container.appendChild(button);
      }
      const state = chip.state || (chip.active ? 'active' : 'idle');
      button.className = `data-toggle-chip chip-${state}${chip.active ? ' active' : ''}`;
      if (button.textContent !== chip.label) button.textContent = chip.label;
      button.title = chip.title || '';
      button.disabled = Boolean(chip.disabled);
      button.setAttribute('aria-pressed', chip.active ? 'true' : 'false');
      button.setAttribute('aria-busy', chip.busy ? 'true' : 'false');
    }
    for (const node of stale.values()) node.remove();

    for (const item of legend) {
      const entry = document.createElement('span');
      entry.className = 'data-toggle-legend-item';
      if (item.blurb) entry.title = item.blurb;
      const swatch = document.createElement('span');
      swatch.className = 'data-toggle-legend-swatch';
      swatch.style.background = item.color;
      const text = document.createElement('span');
      text.textContent = `${item.label} ${this._formatCount(item.count)}`;
      entry.append(swatch, text);
      container.appendChild(entry);
    }
  }

  _refreshTogglePanel() {
    if (!this._toggleContainer) return;
    // Skip DOM churn while hidden; visibilitychange (main.js) triggers one
    // refresh on return. (perf wave 2)
    if (typeof document !== 'undefined' && document.hidden) {
      this._panelRefreshPendingOnVisible = true;
      return;
    }
    for (const layer of this.getAll()) {
      const row = this._toggleContainer.querySelector(`[data-layer-id="${layer.id}"]`);
      if (!row) continue;

      const btn = row.querySelector('.data-toggle-btn');
      if (btn) {
        this._syncToggleButton(btn, layer);
      }

      const count = row.querySelector('.data-count');
      if (count) {
        count.textContent = layer.stats.count ? this._formatCount(layer.stats.count) : '—';
      }

      const meta = row.querySelector('.data-toggle-meta');
      if (meta) {
        meta.textContent = this._buildMetaText(layer);
      }

      this._syncRowControls(row.querySelector('.data-toggle-controls'), layer);
    }
  }

  _buildMetaText(layer) {
    const stats = layer.stats || {};
    const feedState = layerFeedState(stats);
    const stateLabel = FEED_STATE_LABELS[feedState];
    const source = stats.source || layer.source;
    const lifecycleState = layer.lifecycleState || (layer.enabled ? 'enabled' : 'disabled');
    if (lifecycleState === 'enabling' || lifecycleState === 'disabling') {
      return `${lifecycleState.toUpperCase()} · ${source}`;
    }
    if (layer.lifecycleUncertain) {
      return `UNCERTAIN · ${source} · lifecycle state requires reconciliation`;
    }
    const presentedError = stats.error || stats.lastError || stats.managerRefreshError;
    if (presentedError) {
      if (typeof stats.retryInSec === 'number' && stats.retryInSec > 0) {
        return `${stateLabel} · ${source} · ${presentedError} · retry ${stats.retryInSec}s`;
      }
      return `${stateLabel} · ${source} · ${presentedError}`;
    }
    const ago = stats.lastUpdate ? this._timeAgo(stats.lastUpdate) : 'never';
    if (stats.loading) {
      const loadingLabel = typeof stats.loadingLabel === 'string' && stats.loadingLabel.trim()
        ? stats.loadingLabel.trim()
        : 'loading...';
      return `${source} · ${loadingLabel}`;
    }
    if (feedState === 'fallback') {
      const detail = typeof stats.loadingLabel === 'string' && stats.loadingLabel.trim()
        ? stats.loadingLabel.trim()
        : (stats.coverage || ago);
      return `${stateLabel} · ${source} · ${detail}`;
    }
    if (feedState === 'stale') {
      const retry = typeof stats.retryInSec === 'number' && stats.retryInSec > 0
        ? ` · retrying in ${stats.retryInSec}s`
        : '';
      return `${stateLabel} · ${source} · ${ago}${retry}`;
    }
    if (typeof stats.loadingLabel === 'string' && stats.loadingLabel.trim()) {
      return `${source} · ${stats.loadingLabel.trim()}`;
    }
    return `${source} · ${ago}`;
  }

  _syncToggleButton(button, layer) {
    const feedState = layer.enabled ? layerFeedState(layer.stats) : 'off';
    const transitioning = layer.lifecycleState === 'enabling' || layer.lifecycleState === 'disabling';
    const uncertain = Boolean(layer.lifecycleUncertain);
    button.classList.toggle('active', layer.enabled);
    button.classList.toggle('transitioning', transitioning);
    button.classList.toggle('enabling', layer.lifecycleState === 'enabling');
    button.classList.toggle('disabling', layer.lifecycleState === 'disabling');
    button.classList.toggle('lifecycle-uncertain', uncertain);
    for (const state of Object.keys(FEED_STATE_LABELS)) {
      button.classList.toggle(`feed-${state}`, layer.enabled && !uncertain && feedState === state);
    }
    button.dataset.feedState = transitioning
      ? layer.lifecycleState
      : (uncertain ? 'uncertain' : feedState);
    button.disabled = transitioning;
    button.textContent = transitioning
      ? layer.lifecycleState.toUpperCase()
      : (uncertain ? 'UNCERTAIN' : (layer.enabled ? FEED_STATE_LABELS[feedState] : 'OFF'));
    button.setAttribute('aria-label', `${layer.name}: ${button.textContent}`);
  }

  _formatCount(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  }

  _timeAgo(timestamp) {
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }
}
