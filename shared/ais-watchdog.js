// Policy for the AISStream upstream: how to CLASSIFY a failure and how long to
// wait before the next connection attempt.
//
// Ported from the God's Eye View AIS watchdog (MIT, Bilawal Sidhu) and adapted
// to this relay's health contract. Deliberately PURE — no sockets, no timers, no
// process.env — so the whole policy is exercisable offline by
// tests/ais-watchdog.test.mjs. The relay owns the transport and asks this module
// two questions: "what just happened?" and "when may I try again?".
//
// Three things this exists to fix:
//
// 1. A REFUSED CREDENTIAL used to be indistinguishable from a transient
//    handshake failure. `ais-relay.cjs` only special-cased 429, so a revoked or
//    malformed AISSTREAM_API_KEY walked the ordinary ladder forever — knocking on
//    a provider that had already said no, ~288 times a day. An auth rejection is
//    now TERMINAL: only valid data or a credential change leaves it, and the slow
//    probe exists solely to recover from an upstream-side mistake.
//
// 2. `Number(raw)` on an operator knob coerces an exported-but-empty or
//    whitespace value to 0. For the position-freshness knob that is a 1000ms
//    floor — a reconnect storm against the provider — and for a future kill
//    switch it would silently disable the very feature that reports failure, a
//    failure mode that hides itself. Only a literal number is accepted here;
//    anything else falls back to the default and says so.
//
// 3. Durations were compared on the WALL clock. A system clock step (NTP, or a
//    suspend/resume cycle) can move Date.now() backwards, which makes a
//    `Date.now() - lastFrameAt` delta negative and suppresses staleness for an
//    unbounded time. Monotonic durations drive every decision here; wall time is
//    only ever projected for display.
//
// Deliberately absent: a terminal 'down' state. The relay retries a broken
// provider forever on the capped ladder, and its tests pin that. Adding a
// give-up state here would silently change behaviour the fleet depends on.

/** Failure classes. Only 'transport' and 'rate-limit' walk the ordinary ladder. */
export const AIS_FAILURE_KINDS = Object.freeze(['transport', 'auth', 'rate-limit']);

/** Default cadences. */
export const AIS_POLICY_DEFAULTS = Object.freeze({
  /**
   * Probe cadence while the credential is being refused. Deliberately very slow:
   * the only thing a probe can discover is that the provider changed its mind, or
   * that we deployed a fixed key (which clears the state directly).
   */
  authProbeMs: 3_600_000,
});

/**
 * Map an upstream failure onto a class plus the `lastFailure` label the relay's
 * /health contract already publishes. Returning the label here (rather than at
 * each call site) is what keeps `http_429`, `connection_error`,
 * `closed_without_data`, `disconnected` and `position_timeout` stable while the
 * classification underneath gains a class.
 *
 * @param {object} [detail]
 * @param {number} [detail.statusCode] HTTP status of the failed upgrade, if known.
 * @param {string} [detail.message] Error message (matched, never trusted for content).
 * @param {number} [detail.retryAfterMs] Server-supplied Retry-After, already in ms.
 * @param {boolean} [detail.positionTimedOut] The position watchdog fired.
 * @param {boolean} [detail.servedData] This socket had already delivered accepted data.
 * @returns {{kind: string, label: string, retryAfterMs: number|null}}
 */
export function classifyAisFailure(detail = {}) {
  const status = Number(detail.statusCode);
  const message = String(detail.message || '').toLowerCase();
  const retryAfterMs = Number.isFinite(detail.retryAfterMs) && detail.retryAfterMs > 0
    ? Math.floor(detail.retryAfterMs)
    : null;

  // 429 first: a throttle is a throttle even if the body wording would otherwise
  // read as an auth rejection.
  if (status === 429 || /\b429\b|too many requests|rate.?limit/.test(message)) {
    return { kind: 'rate-limit', label: 'http_429', retryAfterMs };
  }
  // 401/403 and the wordings AISStream uses for a bad key. The numeric forms are
  // matched with word boundaries so a port number or a latency figure inside a
  // transport message cannot impersonate an auth rejection and park the feed.
  if (
    status === 401 || status === 403
    || /\b(401|403)\b/.test(message)
    || /unauthoriz|forbidden|invalid[\s_-]*(api[\s_-]*)?key|api[\s_-]*key[\s_-]*(?:is[\s_-]*)?(?:invalid|not[\s_-]*valid)|authentication failed/.test(message)
  ) {
    return { kind: 'auth', label: 'auth_rejected', retryAfterMs: null };
  }
  if (detail.positionTimedOut) {
    return { kind: 'transport', label: 'position_timeout', retryAfterMs };
  }
  if (detail.servedData) {
    return { kind: 'transport', label: 'disconnected', retryAfterMs };
  }
  return { kind: 'transport', label: 'connection_error', retryAfterMs };
}

/**
 * Strictly interpret a numeric operator knob.
 *
 * Deliberately not `Number(raw)`: `''` and `'   '` both coerce to 0, and a knob
 * whose floor is applied to 0 becomes its minimum (for the freshness budget, a
 * 1000ms reconnect storm). Only a literal non-negative number is accepted;
 * everything else — including a value that parses to NaN — falls back to the
 * default and says so.
 *
 * @param {string|number|undefined|null} raw
 * @param {object} opts
 * @param {number} opts.fallback Value used when `raw` is absent or unusable.
 * @param {number} [opts.min] Floor applied to an accepted value.
 * @param {string} [opts.label] Name used in the warning.
 * @param {(message: string) => void} [opts.warn] Sink for the warning.
 * @returns {{value: number, source: 'env'|'default'}}
 */
export function parseAisEnvNumber(raw, { fallback, min, label, warn } = {}) {
  const name = label || 'value';
  const fallbackValue = Number.isFinite(fallback) ? fallback : 0;
  if (raw === undefined || raw === null) return { value: fallbackValue, source: 'default' };
  const rawText = String(raw);
  if (rawText === '') {
    // An exported-but-empty var is the dangerous case: it is present (so it looks
    // configured) and coerces to 0, which for a floor becomes the floor's minimum.
    warn?.(`[AISStream] Ignoring ${name}="" (empty); using the ${fallbackValue} default.`);
    return { value: fallbackValue, source: 'default' };
  }
  // Whitespace-only falls through to the numeric check: it is a value that WAS
  // set and is not a number, which deserves a different warning than "".
  const text = rawText.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    warn?.(`[AISStream] Ignoring ${name}=${JSON.stringify(rawText)} (not a non-negative number); using the ${fallbackValue} default.`);
    return { value: fallbackValue, source: 'default' };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return { value: fallbackValue, source: 'default' };
  const floored = Number.isFinite(min) ? Math.max(min, value) : value;
  return { value: Math.floor(floored), source: 'env' };
}

const DEFAULT_CLOCK = Object.freeze({
  wall: () => Date.now(),
  mono: () => performance.now(),
});

/**
 * Create the reconnect policy for one upstream feed.
 *
 * The caller drives it: report every failure class, every accepted frame and
 * every clean close, then ask for the delay before the next attempt. The policy
 * owns no timers — running `setTimeout` on the returned delay is the caller's
 * job, which is what keeps the relay's single scheduling site and makes the whole
 * policy testable offline.
 *
 * @param {object} options
 * @param {(attempts: number, ceilingMs: number) => number} options.ladder
 *   Backoff function. Injected rather than reimplemented so the relay keeps
 *   `nextBackoffMs` (with its thundering-herd jitter) and this module stays free
 *   of ladder math.
 * @param {number} options.maxMs Ordinary ceiling.
 * @param {number} options.throttleCeilingMs Ceiling while throttled (clamped up to maxMs).
 * @param {number} options.escalateAfter Consecutive throttles before the ceiling escalates.
 * @param {number} [options.authProbeMs] Cadence while the credential is refused.
 * @param {{wall: function, mono: function}} [options.clock]
 */
export function createAisReconnectPolicy(options = {}) {
  const ladder = typeof options.ladder === 'function' ? options.ladder : () => options.maxMs;
  const maxMs = Math.max(1, Number(options.maxMs) || 1);
  // Clamped at or above the ordinary ceiling: a smaller value would make
  // escalation SHORTEN the wait and reconnect more aggressively while throttled,
  // the exact inverse of the intent.
  const throttleCeilingMs = Math.max(maxMs, Number(options.throttleCeilingMs) || maxMs);
  const escalateAfter = Math.max(1, Math.floor(Number(options.escalateAfter) || 1));
  const authProbeMs = Math.max(1, Number(options.authProbeMs) || AIS_POLICY_DEFAULTS.authProbeMs);
  const clock = options.clock || DEFAULT_CLOCK;

  let attempts = 0;
  let consecutiveThrottles = 0;
  /** 'idle' | 'reconnecting' | 'auth-failed' */
  let status = 'idle';
  /** Monotonic deadline before which no attempt may be issued. */
  let nextAttemptMono = 0;
  /** Wall projection of the same deadline, for the health payload only. */
  let nextAttemptWall = 0;

  function escalated() {
    return consecutiveThrottles >= escalateAfter;
  }

  function arm(delayMs) {
    nextAttemptMono = clock.mono() + delayMs;
    nextAttemptWall = clock.wall() + delayMs;
    return delayMs;
  }

  /**
   * Record a failure and compute the next delay.
   *
   * @param {string} kind 'transport' | 'auth' | 'rate-limit'
   * @param {{retryAfterMs?: number|null}} [detail]
   * @returns {{delayMs: number, terminal: boolean, status: string}}
   */
  function onFailure(kind, detail = {}) {
    // While the key is refused, NO outcome of a probe may return the feed to the
    // fast ladder — not a close, not a transport error, not a throttle. A probe
    // that dies for any reason still leaves the credential unproven, and
    // hammering an unproven key is the behaviour this class exists to prevent.
    const effective = status === 'auth-failed' && kind !== 'auth' ? 'auth' : kind;
    attempts += 1;

    if (effective === 'auth') {
      status = 'auth-failed';
      return { delayMs: arm(authProbeMs), terminal: true, status };
    }

    if (effective === 'rate-limit') {
      // A throttle is a throttle: counting it HERE keeps the escalation honest
      // for callers that only ever report failures through onFailure. Report each
      // 429 exactly once — through onFailure('rate-limit') OR onThrottle(), never
      // both for the same event, or the ceiling escalates one 429 too early.
      consecutiveThrottles += 1;
      // Never re-enter at the fast rungs after being told to slow down, and honour
      // the server's own Retry-After when it sends one.
      //
      // The escalated ceiling applies ONLY once escalated: feeding it to the ladder
      // unconditionally would raise the cap on the very first 429, i.e. back off
      // harder than the ordinary schedule before the provider has shown sustained
      // throttling. Once escalated it is a FLOOR over a Retry-After, so a short
      // server hint cannot undercut the block we are waiting out — but it is NOT a
      // floor over the ladder value, which would jump straight to the full ceiling
      // on every escalated 429 instead of backing off. With no hint the ladder owns
      // the timing and only its CAP changes with escalation.
      const escalatedNow = escalated();
      const retryAfterMs = Number.isFinite(detail.retryAfterMs) && detail.retryAfterMs > 0
        ? Math.floor(detail.retryAfterMs)
        : null;
      const delay = retryAfterMs !== null
        ? (escalatedNow ? Math.max(retryAfterMs, throttleCeilingMs) : retryAfterMs)
        : ladder(attempts, escalatedNow ? throttleCeilingMs : maxMs);
      status = 'reconnecting';
      return { delayMs: arm(delay), terminal: false, status };
    }

    status = 'reconnecting';
    return { delayMs: arm(ladder(attempts, maxMs)), terminal: false, status };
  }

  /**
   * An accepted frame arrived. The only event that proves the feed works, and the
   * only one that clears a refused credential.
   */
  function onAcceptedFrame() {
    attempts = 0;
    consecutiveThrottles = 0;
    status = 'idle';
    nextAttemptMono = 0;
    nextAttemptWall = 0;
  }

  /** A close with no recorded error is by definition not a throttle. */
  function onCleanClose() {
    consecutiveThrottles = 0;
  }

  /**
   * Note a throttle the caller observed WITHOUT routing through `onFailure` — e.g.
   * a 429 spotted on an already-open socket. Calling this for an event that was
   * also passed to `onFailure('rate-limit')` double-counts it.
   */
  function onThrottle() {
    consecutiveThrottles += 1;
  }

  /** Note a non-throttle outcome (clears the escalation). */
  function onNonThrottleOutcome() {
    consecutiveThrottles = 0;
  }

  /**
   * The credential changed — the one event that can plausibly fix an auth
   * rejection — so it clears the terminal state and allows an immediate attempt.
   */
  function onCredentialChanged() {
    attempts = 0;
    status = 'idle';
    nextAttemptMono = 0;
    nextAttemptWall = 0;
  }

  function snapshot() {
    const monoNow = clock.mono();
    return {
      attempts,
      consecutiveThrottles,
      escalated: escalated(),
      status,
      /** Remaining wait, measured monotonically so a clock step cannot fool it. */
      remainingMs: Math.max(0, Math.ceil(nextAttemptMono - monoNow)),
      /** Wall projection for the health payload only. */
      nextAttemptAt: nextAttemptWall || null,
    };
  }

  return {
    onAcceptedFrame,
    onCleanClose,
    onCredentialChanged,
    onFailure,
    onNonThrottleOutcome,
    onThrottle,
    snapshot,
  };
}

/**
 * Split the silence budget in two, so the feed can be reported honestly without
 * thrashing the single connection AISStream allows per key: `staleMs` is when we
 * TELL the operator, `recycleAfterMs` is when we actually hard-abort.
 *
 * @param {object} detail
 * @param {number} detail.silentForMs Silence measured on a MONOTONIC clock.
 * @param {number} detail.staleMs
 * @param {number} detail.recycleAfterMs
 * @returns {'live'|'stale'|'recycle'}
 */
export function aisSilenceVerdict({ silentForMs, staleMs, recycleAfterMs }) {
  const silent = Math.max(0, Number(silentForMs) || 0);
  const recycle = Math.max(0, Number(recycleAfterMs) || 0);
  const stale = Math.max(0, Number(staleMs) || 0);
  if (recycle > 0 && silent >= recycle) return 'recycle';
  if (stale > 0 && silent >= stale) return 'stale';
  return 'live';
}

/**
 * Track which socket the relay currently owns.
 *
 * A monotonically increasing generation replaces bare identity checks: a late
 * event from a socket we already gave up on arrives carrying its old generation
 * and is reported as an orphan, so it can be told to hang up instead of silently
 * holding the one-connection-per-key slot or acting on its successor's state.
 *
 * `highWater()` is the seed for any replacement tracker, so a disposal never
 * re-issues a generation a late handler still refers to.
 */
export function createSocketOwnership() {
  let generation = 0;
  let owned = null;

  return {
    /** Claim the next generation for a socket about to be opened. */
    issue() {
      generation += 1;
      owned = generation;
      return generation;
    },
    /** True when the event's generation is still the one we own. */
    owns(eventGeneration) {
      return owned !== null && eventGeneration === owned;
    },
    /** Release the slot. A recycled generation would let a stale handler win. */
    release() {
      owned = null;
    },
    highWater() {
      return generation;
    },
    debug() {
      return { owned, generation };
    },
  };
}
