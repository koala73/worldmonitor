const CONTEXT_DEPENDENCIES = Object.freeze({
  flights: new Set(['military-awareness', 'flights', 'military', 'ais-live-vessels', 'military-installations']),
  'space-missions': new Set(['rocket-launches', 'satellites']),
});
const CONTEXT_COMPANIONS = new Set(['radio']);
/** Return whether an origin represents a direct user choice on this route. */
export function isExplicitUserIntentOrigin(origin, layerId = null) {
  return origin === 'user' || origin === 'voice';
}

/** Preserve explicit layer intent that completes while a stale restore is queued. */
export function recordContextRestoreExplicitChange({ restoreState, change }) {
  if (
    !restoreState?.enabledLayerIds
    || change?.type !== 'visibility'
    || !isExplicitUserIntentOrigin(change.origin, change.layerId)
  ) return false;
  if (!restoreState.explicitLayerStates) restoreState.explicitLayerStates = new Map();
  restoreState.explicitLayerStates.set(change.layerId, Boolean(change.enabled));
  if (change.enabled) restoreState.enabledLayerIds.add(change.layerId);
  else restoreState.enabledLayerIds.delete(change.layerId);
  return true;
}

/** Settle every explicit Context-restore replay without losing semantic failures. */
export async function settleContextIntentReplay({ restoreState, setEnabled, notificationToken = null }) {
  if (restoreState?.cancelled) return null;
  const entries = [...(restoreState?.explicitLayerStates || [])];
  const results = await Promise.allSettled(entries.map(([layerId, enabled]) => (
    setEnabled(layerId, enabled, {
      origin: 'context-intent-replay',
      ...(notificationToken ? { notificationToken } : {}),
    })
  )));
  const failedIndexes = results.flatMap((result, index) => (
    result.status === 'rejected' || result.value === false ? [index] : []
  ));
  if (failedIndexes.length === 0) return null;
  const failedLayerIds = failedIndexes.map((index) => entries[index][0]);
  const rejected = failedIndexes
    .map((index) => results[index])
    .find((result) => result.status === 'rejected');
  const error = rejected?.reason instanceof Error
    ? rejected.reason
    : new Error(`Context intent replay failed for ${failedLayerIds.map((layerId) => `"${layerId}"`).join(', ')}`);
  error.failedLayerIds = [...new Set([
    ...(Array.isArray(error.failedLayerIds) ? error.failedLayerIds : []),
    ...failedLayerIds,
  ])];
  return error;
}

/** Preserve the primary Context failure while aggregating every failed layer. */
export function mergeContextTransitionErrors(primaryError, secondaryError) {
  if (!primaryError) return secondaryError || null;
  if (!secondaryError) return primaryError;
  primaryError.failedLayerIds = [...new Set([
    ...(Array.isArray(primaryError.failedLayerIds) ? primaryError.failedLayerIds : []),
    ...(Array.isArray(secondaryError.failedLayerIds) ? secondaryError.failedLayerIds : []),
  ])];
  return primaryError;
}

/** Settle a user-facing Context action and convert every failure form to false. */
export async function settleUserFacingContextAction({ operation, onFailure, falseIsFailure = true }) {
  try {
    const result = await operation();
    if (falseIsFailure && result === false) throw new Error('Context transition did not complete');
    return result;
  } catch (error) {
    try {
      onFailure?.(error);
    } catch {
      // A broken error surface must not recreate the unhandled rejection.
    }
    return false;
  }
}

/**
 * Layers whose user-owned enable IS a Context entry. They own the session,
 * so they are never bookkept as layers the user added *during* it — filing
 * one into `userAdded` makes exit restoration re-enable the mode layer the
 * user just turned off.
 */
export const CONTEXT_ENTRY_LAYER_IDS = Object.freeze(['military-awareness', 'rocket-launches']);

/**
 * Leave a Context transaction: publish the settled coordination flag, then
 * re-run the owner's context funnel so every SETTLE-GATED consumer sees the
 * final state.
 *
 * That second half is load-bearing. Consumers gated on `!_contextModeChanging`
 * — the Contacts detection override among them — deliberately no-op while a
 * transaction is in flight, so a path that mutates `_contextMode` mid-flight and
 * then merely drops the flag leaves them holding the pre-transaction state
 * forever. (Field case: destroying a Contacts dependency layer exited the
 * session but left detection forced on.)
 *
 * A nested scope handing control back to a still-running outer transaction has
 * settled nothing, so the funnel only runs on a real settle.
 *
 * @param {{_contextModeChanging?: boolean, _syncContextModeButtons?: () => void}} owner
 * @param {boolean} [changing=false] Flag state to publish.
 * @returns {void}
 */
export function settleContextModeChange(owner, changing = false) {
  if (!owner) return;
  const wasChanging = Boolean(owner._contextModeChanging);
  owner._contextModeChanging = Boolean(changing);
  if (wasChanging && !owner._contextModeChanging) owner._syncContextModeButtons?.();
}

/**
 * Run an asynchronous Context transition while preserving the caller's prior
 * coordination state. This matters during teardown: restoration notifications
 * must remain suppressed only for the duration of the restore, not forever.
 *
 * @param {{_contextModeChanging?: boolean}} owner Context coordinator.
 * @param {() => Promise<*>|*} operation Transition work.
 * @returns {Promise<*>} The operation result.
 */
export async function runWithContextModeChanging(owner, operation) {
  const wasChanging = Boolean(owner?._contextModeChanging);
  owner._contextModeChanging = true;
  try {
    return await operation();
  } finally {
    settleContextModeChange(owner, wasChanging);
  }
}

/**
 * Decide whether a manual Data Layer change should hand control away from the
 * active Context mode. User-enabled layers are additive and keep the active
 * mode running. Manually disabling one of the mode's dependencies requests
 * exit; programmatic dependency changes remain allowed.
 *
 * @param {object} input Context and layer-change state.
 * @param {string|null} input.contextMode Active Context mode.
 * @param {boolean} input.globalContextEnabled Whether the neutral/Contacts shell is enabled.
 * @param {object|null} input.change DataLayerManager visibility notification.
 * @returns {boolean} Whether the active Context bundle should be disabled.
 */
export function shouldExitContextForLayerChange({ contextMode, globalContextEnabled, change }) {
  if (
    change?.type !== 'visibility'
    || !isExplicitUserIntentOrigin(change.origin, change.layerId)
    || change.layerId === 'military-awareness'
    || CONTEXT_COMPANIONS.has(change.layerId)
  ) {
    return false;
  }
  const active = Boolean(globalContextEnabled || contextMode);
  if (!active) return false;

  const dependencies = CONTEXT_DEPENDENCIES[contextMode] || new Set(['military-awareness']);
  if (change.enabled) return false;
  return Boolean(contextMode && dependencies.has(change.layerId));
}

/**
 * Return the only layers allowed while a Context mode is being activated.
 * @param {string|null} contextMode Context mode or neutral shell.
 * @returns {Set<string>} Allowed layer identifiers.
 */
export function contextAllowedLayerIds(contextMode) {
  return new Set([
    ...(CONTEXT_DEPENDENCIES[contextMode] || ['military-awareness']),
    ...CONTEXT_COMPANIONS,
  ]);
}

/**
 * Decide whether an accepted intent or pre-transition notification represents a user-owned
 * Context entry whose pre-entry state must be captured. Internal programmatic,
 * dependency, and restoration enables must never create or replace a user
 * restoration snapshot.
 * @param {object|null} change DataLayerManager visibility notification.
 * @returns {boolean} Whether the Context session should capture now.
 */
export function shouldCaptureContextSession(change) {
  return Boolean(
    ['visibility-requested', 'visibility-will-change'].includes(change?.type)
    && isExplicitUserIntentOrigin(change.origin, change.layerId)
    && change.enabled
    && CONTEXT_ENTRY_LAYER_IDS.includes(change.layerId)
  );
}

/**
 * Return whether one explicit mission intent superseded an in-flight Clear All
 * reservation and therefore needs deferred Context adoption.
 */
export function shouldDeferContextEntryDuringClear({ change, clearInFlight }) {
  return Boolean(
    clearInFlight
    && change?.type === 'visibility-requested'
    && change.layerId === 'rocket-launches'
    && change.enabled === true
    && isExplicitUserIntentOrigin(change.origin, change.layerId)
    && Number.isInteger(change.intentEpoch)
  );
}

/**
 * Bookkeep a user-owned layer change against the active Context session so
 * exit restoration can honor layers the user added mid-session. Two rules
 * keep restoration exact:
 *  - Context ENTRY layers are never recorded — they own the session and must
 *    not survive their own exit.
 *  - The allowed set is judged against the EFFECTIVE mode (a mode still being
 *    entered counts), because the entry layer's own enable event lands before
 *    the mode is committed.
 * @param {object} input Session and change state.
 * @param {{userAdded: Set<string>, userRemoved?: Set<string>}|null} input.snapshot Active session snapshot.
 * @param {object|null} input.change DataLayerManager visibility notification.
 * @param {string|null} [input.effectiveContextMode] Committed or entering mode.
 * @returns {boolean} Whether the snapshot's userAdded set was modified.
 */
export function recordContextSessionUserChange({ snapshot, change, effectiveContextMode = null }) {
  if (
    !snapshot?.userAdded
    || change?.type !== 'visibility'
    || !isExplicitUserIntentOrigin(change.origin, change.layerId)
  ) {
    return false;
  }
  const isCompanion = CONTEXT_COMPANIONS.has(change.layerId);
  if (change.enabled) {
    if (CONTEXT_ENTRY_LAYER_IDS.includes(change.layerId)) return false;
    if (change.adoptedFromSelection) {
      snapshot.userAdded.add(change.layerId);
      return true;
    }
    if (contextAllowedLayerIds(effectiveContextMode).has(change.layerId) && !isCompanion) return false;
    snapshot.userAdded.add(change.layerId);
    if (isCompanion) snapshot.userRemoved?.delete(change.layerId);
    return true;
  }
  const removedAddition = snapshot.userAdded.delete(change.layerId);
  if (isCompanion && snapshot.userRemoved) {
    const wasRemoved = snapshot.userRemoved.has(change.layerId);
    snapshot.userRemoved.add(change.layerId);
    return removedAddition || !wasRemoved;
  }
  return removedAddition;
}

/**
 * Return the authoritative layer set for a new Context snapshot. When a prior
 * session is still restoring, the settled restore target is authoritative;
 * reading the manager mid-restore would capture a partial, order-dependent set.
 * @param {Iterable<string>} currentEnabledLayerIds Manager state at capture time.
 * @param {Iterable<string>|null} restoringLayerIds Pending restore target, if any.
 * @param {Iterable<string>} excludeLayerIds Entry-layer intents that were
 * already published synchronously but did not exist before this session.
 * @returns {Set<string>} Detached pre-entry layer set.
 */
export function contextSnapshotLayerIds(
  currentEnabledLayerIds,
  restoringLayerIds = null,
  excludeLayerIds = [],
) {
  const snapshot = new Set(restoringLayerIds || currentEnabledLayerIds || []);
  for (const layerId of excludeLayerIds || []) snapshot.delete(layerId);
  return snapshot;
}

/**
 * Block layers that would mix unrelated live/current data into Space Missions.
 * The manager calls this before lifecycle work so a refused layer never starts.
 * @param {object} input Current mode and requested visibility transition.
 * @param {string|null} input.contextMode Active Context mode.
 * @param {object|null} input.change Requested visibility transition.
 * @param {string|null} [input.layerName] User-facing layer name.
 * @returns {string|null} Honest user-facing refusal reason, or null when allowed.
 */
export function contextLayerEnableBlockReason({ contextMode, change, layerName = null }) {
  if (
    contextMode !== 'space-missions'
    || change?.enabled !== true
    || contextAllowedLayerIds('space-missions').has(change.layerId)
  ) {
    return null;
  }
  const label = String(layerName || change.layerId || 'that layer');
  return `Space Missions isolates replay data. Exit the mode to enable ${label}.`;
}

/**
 * Resolve who owns a cancelled direct Space Missions entry. A newer ON keeps
 * the entry shell reserved for its replacement transaction; every other
 * cancellation must roll back the isolated pre-entry session.
 *
 * @param {object} input Cancellation and current manager intent state.
 * @param {object|null} input.change Manager visibility notification.
 * @returns {'ignore'|'replacement'|'restore'} Cancellation disposition.
 */
export function spaceMissionEntryCancellationDisposition({
  change,
}) {
  if (
    change?.type !== 'visibility-cancelled'
    || change.layerId !== 'rocket-launches'
    || change.enabled !== true
  ) return 'ignore';
  if (
    change.cancellationReason === 'superseded'
    && Number.isInteger(change.successorIntentEpoch)
    && change.successorIntentEpoch > change.intentEpoch
    && change.successorEnabled === true
  ) return 'replacement';
  return 'restore';
}

/**
 * Merge the pre-entry layer snapshot with layers the user enabled during the
 * Context session so both survive restoration.
 * @param {{enabledLayerIds?: Iterable<string>, userAdded?: Iterable<string>, userRemoved?: Iterable<string>}} snapshot Session snapshot.
 * @returns {Set<string>} Layer identifiers to restore.
 */
export function contextRestoreLayerIds(snapshot = {}) {
  const restored = new Set([
    ...(snapshot.enabledLayerIds || []),
    ...(snapshot.userAdded || []),
  ]);
  for (const layerId of snapshot.userRemoved || []) restored.delete(layerId);
  return restored;
}

/**
 * Cockpit entry belongs to the operational Contacts context bundle. A tracked
 * aircraft alone is not sufficient: both observed-flight feeds must still be
 * active so the cockpit's surrounding-contact picture is not presented as a
 * complete context view when one source is disabled.
 *
 * @param {object} input Current context and dependency visibility.
 * @param {string|null} input.contextMode Active Context mode.
 * @param {boolean} input.contextModeChanging Whether the Context transaction is unsettled.
 * @param {boolean} input.flightsEnabled Whether Live Flights is enabled.
 * @param {boolean} input.militaryEnabled Whether Military Flights is enabled.
 * @returns {boolean} Whether cockpit entry may be offered or activated.
 */
export function cockpitEntryAllowed({
  contextMode,
  contextModeChanging,
  flightsEnabled,
  militaryEnabled,
}) {
  return contextMode === 'flights'
    && !contextModeChanging
    && Boolean(flightsEnabled)
    && Boolean(militaryEnabled);
}

/**
 * Internal context-mode id → the word the voice tools accept for it.
 *
 * `set_context_mode` takes 'contacts'; the mode's internal id is 'flights'.
 * The mapping lives here, beside the rest of the context-mode policy, so the
 * UI's operator-facing text and the voice payload translator cannot drift
 * apart — one saying "flights" while the other says "contacts" is the bug
 * this whole seam exists to prevent.
 */
export const CONTEXT_MODE_VOICE_NAMES = Object.freeze({
  flights: 'contacts',
  'space-missions': 'space-missions',
});

/**
 * Name a context mode in the vocabulary the tools and the operator share.
 * @param {string|null|undefined} internalMode Internal mode id.
 * @param {object} [options]
 * @param {string|null} [options.emptyAs='off'] What "no mode" is called. 'off'
 *   for a state field that always names a mode; null where an absent value
 *   means "none at all" (nothing is entering, there was no prior mode) and
 *   calling it 'off' would assert something untrue.
 * @returns {string|null} The shared word for this mode.
 */
export function contextModeWord(internalMode, { emptyAs = 'off' } = {}) {
  if (!internalMode) return emptyAs;
  return CONTEXT_MODE_VOICE_NAMES[internalMode] || internalMode;
}
