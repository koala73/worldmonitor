// Pure state machine for the AISStream live-feed watchdog.
//
// Liveness is judged by DATA, not by socket state. AISStream can complete the
// websocket handshake and then deliver nothing at all — no frames, no error,
// no close — so `readyState === OPEN` proves only that a handshake once
// succeeded. Every health verdict here is derived from when a valid AIS
// message last arrived. A handshake, a malformed frame, and an error envelope
// are all explicitly NOT liveness.
//
// Two budgets, deliberately decoupled, so the feed can be reported honestly
// without thrashing the single connection AISStream allows per key:
//
//   staleMs         when to TELL the user the feed stopped delivering (fast)
//   recycleAfterMs  when to actually hard-abort and reconnect     (slow)
//
// Failures are CLASSIFIED, because "retry harder" is the wrong answer to most
// of them. Only genuine transport faults walk the backoff ladder; an auth
// rejection is terminal until the key changes, and a rate limit honours the
// server's own Retry-After. Steady-state failure must cost single-digit
// connection attempts per hour in every class.
//
// The machine owns no sockets, no timers and no environment. It returns
// ACTIONS for a transport adapter to perform, which keeps the entire policy
// exercisable by the offline node:test suite.
//
// The only teardown action is 'terminate' — never 'close'. Node's built-in
// WebSocket has no terminate(), and its close() parks a black-holed socket in
// CLOSING indefinitely (measured: no close event after 30s, TCP slot never
// released), which is exactly how the reverted watchdog wedged. The adapter
// binds 'terminate' to ws.terminate(), which destroys the underlying socket.
//
// Durations are measured on a MONOTONIC clock. Wall time is used only for
// display timestamps, so a system clock rollback cannot suppress staleness.

/** Default watchdog budgets. */
export const AIS_WATCHDOG_DEFAULTS = Object.freeze({
  /** Silence after which the feed is REPORTED stale. */
  staleMs: 120_000,
  /** Silence after which the socket is actually recycled. */
  recycleAfterMs: 300_000,
  /** Backoff ladder; its length is also the attempt budget before 'down'. */
  backoffMs: Object.freeze([5_000, 15_000, 60_000, 300_000]),
  /** Slow retry cadence once the ladder is exhausted. */
  downRetryMs: 900_000,
  /** Probe cadence while the key is being rejected. Deliberately very slow. */
  authProbeMs: 3_600_000,
});

/**
 * Statuses reported to the browser. 'missing-key' and 'unsupported' keep their
 * pre-watchdog meaning so a keyless install still reads as "feature off".
 */
export const AIS_WATCHDOG_STATUSES = Object.freeze([
  'idle',
  'missing-key',
  'unsupported',
  'connecting',
  'live',
  'stale',
  'reconnecting',
  'down',
  'auth-failed',
]);

/** Failure classes. Only 'transport' is allowed to walk the fast ladder. */
export const AIS_FAILURE_KINDS = Object.freeze(['transport', 'auth', 'rate-limit']);

/** Statuses that must not flip back to a hopeful 'connecting' on a retry. */
const QUIET_TERMINAL = new Set(['down', 'auth-failed']);

/** Statuses in which fresh data is genuinely flowing. */
export function isLiveAisStatus(status) {
  return status === 'live';
}

/**
 * Strictly interpret an AISSTREAM_SILENCE_TIMEOUT_MS-style override.
 *
 * Deliberately not `Number(raw)`: an exported-but-empty or whitespace value
 * coerces to 0, which would silently disable the watchdog — a failure mode
 * that hides itself, because the feature it disables is the one that reports
 * failure. Only a literal 0 is the kill switch; anything unparseable falls
 * back to the default and says so once.
 *
 * @param {string|number|undefined|null} raw
 * @param {(message: string) => void} [warn]
 * @returns {{kind: 'default'|'off'|'timeout', value?: number}}
 */
export function parseSilenceTimeoutEnv(raw, warn) {
  if (raw === undefined || raw === null) return { kind: 'default' };
  const text = String(raw).trim();
  if (!text) return { kind: 'default' };
  if (!/^\d+(\.\d+)?$/.test(text)) {
    warn?.(
      `[AISStream] Ignoring AISSTREAM_SILENCE_TIMEOUT_MS="${raw}" (not a non-negative number); `
      + `using the ${AIS_WATCHDOG_DEFAULTS.staleMs}ms default.`,
    );
    return { kind: 'default' };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return { kind: 'default' };
  if (value === 0) return { kind: 'off' };
  return { kind: 'timeout', value };
}

const DEFAULT_CLOCK = Object.freeze({
  wall: () => Date.now(),
  mono: () => performance.now(),
});

/**
 * Create an AISStream watchdog state machine.
 *
 * The caller must invoke `configure()` before the first `tick()` so the
 * machine knows whether a key and a websocket transport exist.
 *
 * @param {Object} [options]
 * @param {number} [options.staleMs]
 * @param {number} [options.recycleAfterMs]
 * @param {number[]} [options.backoffMs]
 * @param {number} [options.downRetryMs]
 * @param {number} [options.authProbeMs]
 * @param {number} [options.startGeneration] Seed for the socket-generation
 *   counter. MUST be the caller's module-lifetime high-water mark so that a
 *   disposal never re-issues a generation a late handler still refers to.
 * @param {{wall: function, mono: function}} [options.clock]
 * @returns {Object} watchdog handle
 */
export function createAisWatchdog(options = {}) {
  const staleMs = positiveOr(options.staleMs, AIS_WATCHDOG_DEFAULTS.staleMs);
  const recycleAfterMs = Math.max(
    staleMs,
    positiveOr(options.recycleAfterMs, AIS_WATCHDOG_DEFAULTS.recycleAfterMs),
  );
  const backoffMs = Array.isArray(options.backoffMs) && options.backoffMs.length
    ? options.backoffMs.map((ms) => positiveOr(ms, 5_000))
    : [...AIS_WATCHDOG_DEFAULTS.backoffMs];
  const downRetryMs = positiveOr(options.downRetryMs, AIS_WATCHDOG_DEFAULTS.downRetryMs);
  const authProbeMs = positiveOr(options.authProbeMs, AIS_WATCHDOG_DEFAULTS.authProbeMs);
  const clock = options.clock || DEFAULT_CLOCK;

  let status = 'idle';
  /**
   * Monotonic id for every socket the adapter is told to open. Seeded from the
   * caller's high-water mark and never reset — a recycled generation would let
   * a pre-disposal handler act on its successor's socket.
   */
  let generation = Math.max(0, Number(options.startGeneration) || 0);
  /** Generation of the socket the machine currently owns; null = slot free. */
  let owned = null;
  /** Monotonic ms at which the current silence window began (connect or data). */
  let silenceSinceMono = 0;
  /** Last DATA message. 0 = never — a handshake does not count. */
  let lastMessageWall = 0;
  /** Consecutive failed sessions since data last flowed. */
  let reconnectAttempt = 0;
  /** Monotonic deadline before which no new connect may be issued. */
  let nextAttemptMono = 0;
  let error = null;
  /** False for custom subscriptions, where silence can be legitimate. */
  let silenceWatchArmed = true;
  /** Identifies the credential in use, so a key change can clear auth-failed. */
  let keyFingerprint = null;

  function release() {
    owned = null;
  }

  /** True once the backoff ladder has been spent without any data. */
  function isExhausted() {
    return reconnectAttempt > backoffMs.length;
  }

  /**
   * Count a failed session and pick the next attempt time, BY FAILURE CLASS.
   * @param {string} kind 'transport' | 'auth' | 'rate-limit'
   * @param {number} [retryAfterMs] Server-supplied delay (429 Retry-After).
   */
  function scheduleRetry(kind, retryAfterMs) {
    const monoNow = clock.mono();
    // While the key is being refused, NO outcome of a probe may return the
    // feed to the fast ladder — not a close, not a transport error, not
    // silence. A probe that dies for any reason still leaves the credential
    // unproven, and hammering on an unproven key is the behaviour this whole
    // state exists to prevent. Only valid data or a key rotation leaves
    // auth-failed.
    const effective = status === 'auth-failed' && kind !== 'auth' ? 'auth' : kind;
    reconnectAttempt += 1;

    if (effective === 'auth') {
      // The key is being refused. Retrying cannot fix that, so this is
      // terminal until the credential changes or the server restarts; the
      // slow probe exists only to recover from an upstream-side mistake.
      status = 'auth-failed';
      nextAttemptMono = monoNow + authProbeMs;
      return;
    }

    if (effective === 'rate-limit') {
      // Never re-enter at the fast rungs after being told to slow down.
      reconnectAttempt = Math.max(reconnectAttempt, backoffMs.length);
      const wait = positiveOr(retryAfterMs, backoffMs[backoffMs.length - 1]);
      status = isExhausted() ? 'down' : 'reconnecting';
      nextAttemptMono = monoNow + (isExhausted() ? Math.max(wait, downRetryMs) : wait);
      return;
    }

    if (isExhausted()) {
      status = 'down';
      nextAttemptMono = monoNow + downRetryMs;
      return;
    }
    status = 'reconnecting';
    nextAttemptMono = monoNow + backoffMs[reconnectAttempt - 1];
  }

  /** Hard-abort whatever socket we hold, if any. */
  function terminateOwned(reason) {
    if (owned === null) return [];
    const generationToKill = owned;
    release();
    return [{ type: 'terminate', generation: generationToKill, reason }];
  }

  /**
   * Declare the environment. Safe to call repeatedly (the adapter calls it on
   * every request so a key added to .env mid-session is picked up).
   *
   * @param {{hasKey: boolean, hasTransport?: boolean, silenceWatch?: boolean,
   *   keyFingerprint?: string|null}} env
   * @returns {Array<Object>} actions
   */
  function configure(env) {
    silenceWatchArmed = env.silenceWatch !== false;

    if (!env.hasKey) {
      const actions = terminateOwned('key-absent');
      status = 'missing-key';
      error = 'AISSTREAM_API_KEY is not set';
      reconnectAttempt = 0;
      keyFingerprint = null;
      return actions;
    }
    if (env.hasTransport === false) {
      const actions = terminateOwned('no-transport');
      status = 'unsupported';
      error = 'Node WebSocket transport is unavailable';
      return actions;
    }

    // A changed credential is the one event that can plausibly fix an auth
    // rejection, so it clears the terminal state immediately.
    const nextFingerprint = env.keyFingerprint ?? null;
    const credentialChanged = keyFingerprint !== null && nextFingerprint !== keyFingerprint;
    keyFingerprint = nextFingerprint;
    if (credentialChanged) {
      // Any socket in flight belongs to the OLD key — it subscribed with that
      // credential, so its eventual rejection says nothing about the new one.
      // Terminating it here also releases the generation, which is what makes
      // every later event from that socket an orphan: without this, an
      // in-flight probe's rejection would arrive after the rotation and shove
      // the *new* key straight back into auth-failed for another hour.
      const actions = terminateOwned('key-rotated');
      status = 'idle';
      error = null;
      reconnectAttempt = 0;
      nextAttemptMono = clock.mono();
      return actions;
    }

    // Key/transport just arrived — clear the terminal state and allow an
    // immediate attempt rather than waiting out a stale backoff.
    if (status === 'missing-key' || status === 'unsupported') {
      status = 'idle';
      error = null;
      reconnectAttempt = 0;
      nextAttemptMono = clock.mono();
    }
    return [];
  }

  /**
   * Advance time. Returns the actions the adapter must perform, in order.
   *
   * A 'connect' is never returned while a socket is owned, and the machine
   * releases the slot in the same step it emits a 'terminate' — so a reconnect
   * can only ever follow a terminate, never race it.
   *
   * @returns {Array<Object>} actions
   */
  function tick() {
    if (status === 'missing-key' || status === 'unsupported') return [];
    const monoNow = clock.mono();

    if (owned !== null) {
      // AUTH-FAILED is STICKY against staleness processing. Relabelling the
      // state to 'stale' at the 120s mark would put the next close, error,
      // rate limit or recycle OUTSIDE the auth coercion in scheduleRetry —
      // laundering a refused key onto the fast ladder purely by the passage of
      // time. While the key is refused the hourly probe cadence is the only
      // clock that runs; the state leaves auth-failed exclusively via valid
      // data (onMessage) or a key rotation (configure).
      if (status === 'auth-failed') {
        // The probe is still bounded — on the auth cadence, not the silence
        // budget — so a probe that opens and then says nothing cannot pin the
        // one-connection-per-key slot indefinitely.
        if (monoNow - silenceSinceMono >= authProbeMs) {
          const actions = terminateOwned('auth-probe-expired');
          scheduleRetry('auth');
          return actions;
        }
        return [];
      }

      if (!silenceWatchArmed) return [];
      const silentFor = monoNow - silenceSinceMono;
      if (silentFor >= recycleAfterMs) {
        error = `AISStream delivered no data for ${Math.round(silentFor / 1000)}s`;
        const actions = terminateOwned('silent');
        scheduleRetry('transport');
        return actions;
      }
      if (silentFor >= staleMs) status = 'stale';
      return [];
    }

    if (monoNow < nextAttemptMono) return [];
    generation += 1;
    owned = generation;
    // The silence budget starts when the socket is COMMISSIONED, not when it
    // opens: a handshake that completes late must not buy extra silence.
    silenceSinceMono = monoNow;
    // Once DOWN or AUTH-FAILED, the slow retry runs *behind* the reported
    // state: the chip must not flicker back to a hopeful "connecting". Only
    // real data clears them.
    if (!QUIET_TERMINAL.has(status)) status = 'connecting';
    return [{ type: 'connect', generation }];
  }

  /** True when an event belongs to the socket we still own. */
  function ownsGeneration(eventGeneration) {
    return owned !== null && eventGeneration === owned;
  }

  /**
   * A socket finished its handshake.
   *
   * Deliberately touches NEITHER the silence clock nor the ladder: a handshake
   * is not data, and a socket that opens late then goes silent must recycle on
   * its original schedule. An orphan (a socket we already gave up on, opening
   * late) is told to hang itself up so it cannot hold the one-connection-per-key
   * slot.
   */
  function onOpen(eventGeneration) {
    if (!ownsGeneration(eventGeneration)) {
      return [{ type: 'terminate', generation: eventGeneration, reason: 'orphan' }];
    }
    if (!QUIET_TERMINAL.has(status) && status !== 'stale') status = 'connecting';
    return [];
  }

  /**
   * A VALID AIS message arrived — the only event that proves the feed works.
   * The adapter must call this only after the frame has decoded and been
   * recognised as an AIS payload; malformed frames and error envelopes are
   * never liveness.
   */
  function onMessage(eventGeneration) {
    if (!ownsGeneration(eventGeneration)) {
      return [{ type: 'terminate', generation: eventGeneration, reason: 'orphan' }];
    }
    const monoNow = clock.mono();
    silenceSinceMono = monoNow;
    lastMessageWall = clock.wall();
    reconnectAttempt = 0;
    error = null;
    status = 'live';
    return [];
  }

  /** The socket closed on its own. */
  function onClose(eventGeneration) {
    if (!ownsGeneration(eventGeneration)) return [];
    release();
    if (!error) error = 'AISStream websocket closed';
    scheduleRetry('transport');
    return [];
  }

  /**
   * A classified failure. Treated as definitive: terminate now and schedule
   * by class, rather than waiting out the silence budget for a socket we
   * already know is bad.
   *
   * @param {number} eventGeneration
   * @param {{kind?: string, message?: string, retryAfterMs?: number}} [detail]
   */
  function onFailure(eventGeneration, detail = {}) {
    if (!ownsGeneration(eventGeneration)) return [];
    const kind = AIS_FAILURE_KINDS.includes(detail.kind) ? detail.kind : 'transport';
    // A probe dying of some unrelated fault while the key is refused keeps the
    // credential message — surfacing "ECONNRESET" would send the operator
    // chasing the network instead of the key.
    if (!(status === 'auth-failed' && kind !== 'auth')) {
      error = detail.message || defaultFailureMessage(kind);
    }
    const actions = terminateOwned(kind);
    scheduleRetry(kind, detail.retryAfterMs);
    return actions;
  }

  /** Tear everything down (dev-server restart / plugin close). */
  function dispose() {
    const actions = terminateOwned('dispose');
    status = 'idle';
    reconnectAttempt = 0;
    nextAttemptMono = 0;
    silenceSinceMono = 0;
    lastMessageWall = 0;
    error = null;
    keyFingerprint = null;
    // `generation` is intentionally NOT reset: a recycled generation would let
    // a pre-disposal handler act on its successor's socket.
    return actions;
  }

  /** Highest generation ever issued — the seed for any replacement machine. */
  function highWaterGeneration() {
    return generation;
  }

  /** Status metadata for /api/ais-live. */
  function snapshot() {
    const monoNow = clock.mono();
    const wallNow = clock.wall();
    const silentForMs = owned !== null ? Math.max(0, monoNow - silenceSinceMono) : null;
    const waitingMs = Math.max(0, nextAttemptMono - monoNow);
    return {
      status,
      error,
      lastMessageAt: lastMessageWall || null,
      silentForMs,
      reconnectAttempt,
      // Projected onto the wall clock purely for display.
      nextAttemptAt: (status === 'reconnecting' || status === 'down' || status === 'auth-failed')
        ? wallNow + waitingMs
        : null,
      watchdog: silenceWatchArmed ? 'armed' : 'custom-subscription-off',
      staleAfterMs: staleMs,
    };
  }

  /** Test/diagnostic view of internal ownership. */
  function debugState() {
    return { status, owned, generation, reconnectAttempt, lastMessageAt: lastMessageWall };
  }

  return {
    configure,
    tick,
    onOpen,
    onMessage,
    onClose,
    onFailure,
    dispose,
    snapshot,
    debugState,
    highWaterGeneration,
  };
}

function defaultFailureMessage(kind) {
  if (kind === 'auth') return 'AISStream rejected the API key';
  if (kind === 'rate-limit') return 'AISStream rate-limited this key';
  return 'AISStream websocket error';
}

function positiveOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
