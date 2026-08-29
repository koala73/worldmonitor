export const LOADING_REVEAL_DELAY_MS = 160;
export const LOADING_TERMINAL_DWELL_MS = 2200;
export const LOADING_FAILURE_DWELL_MS = 5000;
export const LOADING_LONG_THRESHOLD_MS = 30000;
export const TRAFFIC_SYNC_CONFIRM_MS = 1500;

function finiteCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

/** Normalize one manager layer into a small loading-feedback record. */
export function normalizeLayerLoading(layer = {}) {
  const stats = layer.stats || {};
  const lifecycleState = String(layer.lifecycleState || (layer.enabled ? 'enabled' : 'disabled'));
  const status = String(stats.status || '').toLowerCase();
  const disabling = lifecycleState === 'disabling';
  const loading = lifecycleState === 'enabling' || disabling || stats.loading === true || stats.refreshing === true;
  const count = finiteCount(stats.count);
  const error = stats.error || stats.lastError || stats.managerRefreshError || null;
  const unavailable = stats.unavailable === true
    || stats.available === false
    || ['unavailable', 'offline', 'down', 'error'].includes(status);
  const keyRequired = stats.keyRequired === true || stats.missingKey === true;
  const degraded = stats.degraded === true || Boolean(error);
  const accepted = Boolean(stats.lastUpdate) || count > 0;
  return {
    id: String(layer.id || ''),
    label: String(layer.name || layer.id || 'Layer'),
    loading,
    disabling,
    refresh: loading && layer.enabled && (stats.refreshing === true || accepted),
    lifecycleState,
    count,
    accepted,
    error,
    unavailable,
    keyRequired,
    degraded,
  };
}

function terminalFromParticipantStats(summary, participantIds) {
  if (!participantIds?.length) return null;
  const participants = new Set(participantIds);
  return summary.records.some((record) => participants.has(record.id)
    // A deliberately unconfigured optional provider is a truthful terminal
    // state for that row, not a failed multi-layer mission. The layer keeps
    // owning its KEY REQUIRED copy; explicit lifecycle failure events still
    // merge in below and retain error priority.
    && !record.keyRequired
    && (record.error || record.unavailable))
    ? 'error'
    : null;
}

/** Aggregate all manager layers without changing their lifecycle authority. */
export function aggregateLayerLoading(layers = []) {
  const records = layers.map(normalizeLayerLoading);
  const active = records.filter((record) => record.loading);
  const disabling = active.length > 0 && active.every((record) => record.disabling);
  return {
    records,
    active,
    activeIds: active.map((record) => record.id),
    disabling,
    refresh: !disabling && active.length > 0 && active.every((record) => record.refresh),
  };
}

export function createLoadingFeedbackState() {
  return {
    phase: 'idle',
    visible: false,
    startedAt: 0,
    showAt: 0,
    hideAt: 0,
    activeIds: [],
    batchOutcome: null,
    terminal: null,
    operation: null,
  };
}

/** Create a top-center status notice, optionally persistent until explicitly cleared. */
export function createGlobalStatusNotice(message, nowMs = 0, {
  state = 'error',
  detail = '',
  persistent = false,
} = {}) {
  const label = String(message || '').trim();
  if (!label) return null;
  return {
    state,
    label,
    detail: String(detail || '').trim(),
    persistent: !!persistent,
    dwellMs: persistent ? null : LOADING_FAILURE_DWELL_MS,
    // A finite notice starts its dwell only when it first wins presentation.
    // Otherwise a higher-priority manager failure could consume the whole
    // deadline while this notice remained queued and invisible.
    hideAt: null,
  };
}

/** Present a top-center status notice until its deadline or explicit clearing. */
export function presentGlobalStatusNotice(notice, nowMs = 0) {
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  if (!notice?.label) return null;
  if (!notice.persistent && !Number.isFinite(notice.hideAt)) {
    notice.hideAt = now + (Number.isFinite(notice.dwellMs)
      ? notice.dwellMs
      : LOADING_FAILURE_DWELL_MS);
  }
  if (Number.isFinite(notice.hideAt) && now >= notice.hideAt) return null;
  return {
    state: notice.state || 'error',
    label: notice.label,
    detail: notice.detail || '',
  };
}

/** Whether deferred notice work still owns the current presentation epoch. */
export function canPresentDeferredStatusNotice(expectedGeneration, currentGeneration, disposed = false) {
  return !disposed
    && Number.isSafeInteger(expectedGeneration)
    && expectedGeneration === currentGeneration;
}

/**
 * Present the shared status surface without allowing a persistent notice to
 * hide a terminal manager failure. Failure dwell starts when the manager
 * reports it, so it must remain the highest-priority presentation while live.
 */
export function presentGlobalLoadingStatus(notice, loadingState, summary, nowMs = 0) {
  const loadingPresentation = presentLoadingFeedback(loadingState, summary, nowMs);
  if (loadingPresentation?.state === 'error') return loadingPresentation;
  return presentGlobalStatusNotice(notice, nowMs) || loadingPresentation;
}

/** Create the sampled Street Traffic chip state. */
export function createTrafficSyncFeedbackState() {
  return {
    busy: false,
    visible: false,
    confirmationUntil: 0,
    label: '',
    progressText: '',
  };
}

/**
 * Reduce one sampled Street Traffic status without extending completion on
 * every animation-loop poll. Coverage describes accepted data, not work.
 */
export function reduceTrafficSyncFeedback(previous, {
  enabled = false,
  stats = {},
  forceShow = false,
} = {}, nowMs = 0) {
  const state = previous || createTrafficSyncFeedbackState();
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  if (!enabled) return createTrafficSyncFeedbackState();

  const hasProgress = Number.isFinite(stats.phaseProgressPct);
  const progressPct = hasProgress
    ? Math.max(0, Math.min(100, Math.round(stats.phaseProgressPct)))
    : (stats.loading ? 1 : 100);
  const busy = stats.loading === true
    || stats.worldJumping === true
    || (hasProgress && (progressPct < 100 || (stats.prewarmQueueDepth ?? 0) > 0));
  const label = String(stats.phaseLabel || stats.loadingLabel || '').trim();

  if (busy) {
    return {
      busy: true,
      visible: true,
      confirmationUntil: 0,
      // Neutral default: the layer always supplies its own LIVE/SIMULATED
      // label, and a fallback string must never claim a live feed on a
      // keyless build.
      label: label || 'syncing road network',
      progressText: hasProgress ? `${progressPct}%` : '...',
    };
  }

  const existingConfirmation = state.confirmationUntil > now
    ? state.confirmationUntil
    : 0;
  const confirmationUntil = existingConfirmation || (state.busy || forceShow
    ? now + TRAFFIC_SYNC_CONFIRM_MS
    : 0);
  const visible = confirmationUntil > now && progressPct >= 100 && Boolean(label);
  return {
    busy: false,
    visible,
    confirmationUntil: visible ? confirmationUntil : 0,
    label: visible ? label : '',
    // The settled flash carries NO progress number. A settled chip is 100% by
    // definition — the value never varied — and printing it beside a label
    // that already ends in a real measurement produced the self-contradicting
    // "LIVE · TomTom flow · 0% cov  100%". Coverage is the honest number, so
    // it is the only one left standing; the progress slot belongs to work in
    // flight.
    progressText: '',
  };
}

function terminalFromEvent(event) {
  const type = String(event?.type || '');
  if (type === 'visibility-failed' || type === 'refresh-failed' || event?.error) return 'error';
  if (type === 'visibility-cancelled' || event?.cancelled) return 'cancelled';
  if (type === 'visibility' || type === 'refresh') return 'complete';
  return null;
}

function mergeTerminalOutcome(current, next) {
  const severity = { complete: 1, cancelled: 2, error: 3 };
  if (!next) return current || null;
  if (!current || severity[next] > severity[current]) return next;
  return current;
}

/** Reduce a sampled manager summary into delayed, non-flashing UI state. */
export function reduceLoadingFeedback(previous, summary, nowMs, event = null) {
  const state = previous || createLoadingFeedbackState();
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  if (summary.active.length) {
    const beginning = state.phase !== 'loading';
    const startedAt = beginning ? now : state.startedAt;
    const priorParticipants = beginning ? [] : state.activeIds;
    const activeIds = [...new Set([...priorParticipants, ...summary.activeIds])];
    const eventLayerId = String(event?.layerId || '');
    const eventParticipates = eventLayerId && activeIds.includes(eventLayerId);
    const batchOutcome = mergeTerminalOutcome(
      mergeTerminalOutcome(
        beginning ? null : state.batchOutcome,
        terminalFromParticipantStats(summary, activeIds),
      ),
      eventParticipates ? terminalFromEvent(event) : null,
    );
    return {
      phase: 'loading',
      visible: !beginning && now >= state.showAt,
      startedAt,
      showAt: beginning ? now + LOADING_REVEAL_DELAY_MS : state.showAt,
      hideAt: 0,
      activeIds,
      batchOutcome,
      terminal: null,
      operation: summary.disabling ? 'disabling' : summary.refresh ? 'refresh' : 'loading',
    };
  }

  if (state.phase === 'loading') {
    const eventLayerId = String(event?.layerId || '');
    const eventParticipates = eventLayerId && state.activeIds.includes(eventLayerId);
    const terminal = mergeTerminalOutcome(
      mergeTerminalOutcome(
        state.batchOutcome,
        terminalFromParticipantStats(summary, state.activeIds),
      ),
      eventParticipates ? terminalFromEvent(event) : null,
    ) || 'complete';
    const wasVisible = state.visible || now >= state.showAt;
    if (!wasVisible && terminal === 'complete') return createLoadingFeedbackState();
    const dwell = terminal === 'error' ? LOADING_FAILURE_DWELL_MS : LOADING_TERMINAL_DWELL_MS;
    return {
      ...state,
      phase: 'terminal',
      visible: true,
      hideAt: now + dwell,
      batchOutcome: terminal,
      terminal,
    };
  }

  if (state.phase === 'terminal' && now < state.hideAt) return state;
  return createLoadingFeedbackState();
}

/** Build the user-facing status copy for the current loading state. */
export function presentLoadingFeedback(state, summary, nowMs) {
  if (!state?.visible) return null;
  if (state.phase === 'terminal') {
    const labels = { complete: 'LOAD COMPLETE', cancelled: 'LOAD CANCELLED', error: 'LOAD FAILED' };
    const label = state.operation === 'disabling' && state.terminal === 'complete'
      ? 'LIVE DATA OFF'
      : labels[state.terminal] || 'LOAD COMPLETE';
    return { state: state.terminal, label, detail: '' };
  }
  const active = summary.active;
  const elapsed = Math.max(0, nowMs - state.startedAt);
  const label = summary.disabling
    ? 'TURNING OFF LIVE DATA'
    : summary.refresh ? 'REFRESHING LIVE DATA' : 'LOADING LIVE DATA';
  const names = active.slice(0, 2).map((record) => record.label).join(' · ');
  const suffix = active.length > 2 ? ` +${active.length - 2}` : '';
  return {
    state: elapsed >= LOADING_LONG_THRESHOLD_MS
      ? 'long'
      : summary.disabling ? 'disabling' : summary.refresh ? 'refresh' : 'loading',
    label,
    detail: `${names}${suffix}`,
  };
}
