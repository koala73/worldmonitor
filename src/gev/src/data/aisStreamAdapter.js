// Transport adapter for the AISStream watchdog.
//
// Extracted from vite.config.js so the socket lifecycle — the part that has
// historically carried the defects — can be exercised offline with mock
// sockets. The adapter owns sockets and translates watchdog ACTIONS into
// transport calls; the watchdog owns policy and owns no I/O.
//
// Two ownership rules make the single-socket invariant hold even when events
// arrive late, out of order, or across a dev-server restart:
//
//   1. Socket generations are MONOTONIC for the lifetime of this module and
//      are never reused, including across dispose(). A recycled generation
//      would let a pre-disposal handler act on its successor's socket.
//   2. Every mutation of the socket map is IDENTITY-checked: an entry is only
//      deleted or acted on when the map still holds *that* socket object.
//
// Liveness credit is granted only to a frame that (a) arrived on a socket we
// still own, and (b) decoded into a real AIS record. Handshakes, malformed
// frames and error envelopes are never liveness.

import { createAisWatchdog } from './aisWatchdog.js';

const DEFAULT_CLOCK = Object.freeze({
  wall: () => Date.now(),
  mono: () => performance.now(),
});

/** Upstream text that identifies a credential rejection. */
const AUTH_TEXT = /(unauthoriz|unauthoris|forbidden|invalid\s*api[\s_-]*key|invalid\s*key|bad\s*api[\s_-]*key|authentic|api\s*key\s*(is\s*)?(invalid|required|missing|not\s*valid))/i;

/** Upstream text that identifies a rate limit / connection cap. */
const RATE_TEXT = /(rate[\s_-]*limit|too\s*many\s*(requests|connections)|quota\s*exceeded|429)/i;

/**
 * Parse an HTTP `Retry-After` header into milliseconds.
 * Accepts delta-seconds or an HTTP-date. Returns 0 when absent/unparseable.
 * @param {string|number|undefined|null} raw
 * @param {number} [nowMs] Wall-clock reference for the HTTP-date form.
 * @returns {number}
 */
export function parseRetryAfterMs(raw, nowMs = Date.now()) {
  if (raw === null || raw === undefined) return 0;
  const text = String(raw).trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return 0;
}

/**
 * Classify a transport or upstream failure.
 *
 * Only 'transport' may walk the fast backoff ladder. An auth rejection cannot
 * be fixed by retrying, and a rate limit must honour the server's own pacing —
 * treating either as a generic error is how a watchdog turns into a hammer.
 *
 * @param {{httpStatus?: number|string, message?: string,
 *   retryAfterHeader?: string|number|null, nowMs?: number}} input
 * @returns {{kind: string, message: string, retryAfterMs?: number}}
 */
export function classifyAisFailure(input = {}) {
  const text = String(input.message || '').trim();
  const fromHeader = () => parseRetryAfterMs(input.retryAfterHeader, input.nowMs);

  let status = Number(input.httpStatus);
  if (!Number.isFinite(status)) {
    // ws reports a failed upgrade as "Unexpected server response: 401" when no
    // 'unexpected-response' listener consumed it.
    const match = /unexpected server response:\s*(\d{3})/i.exec(text);
    status = match ? Number(match[1]) : NaN;
  }

  if (status === 401 || status === 403) {
    return { kind: 'auth', message: `AISStream rejected the API key (HTTP ${status})` };
  }
  if (status === 429) {
    return {
      kind: 'rate-limit',
      message: 'AISStream rate-limited this key (HTTP 429)',
      retryAfterMs: fromHeader(),
    };
  }
  if (Number.isFinite(status) && status >= 400) {
    return { kind: 'transport', message: `AISStream upgrade failed (HTTP ${status})` };
  }
  if (AUTH_TEXT.test(text)) return { kind: 'auth', message: text };
  if (RATE_TEXT.test(text)) return { kind: 'rate-limit', message: text, retryAfterMs: fromHeader() };
  return { kind: 'transport', message: text || 'AISStream websocket error' };
}

/**
 * Decode a frame to text WITHOUT suspending, or return null if that is
 * impossible (only the Blob shape needs an await).
 *
 * This exists to keep the message pipeline synchronous for every shape `ws`
 * actually delivers. An await inside the pipeline is a suspension point, and a
 * 'close' event arriving in the same tick would otherwise overtake the frame —
 * which for an auth error envelope means the rejection is dropped and the
 * generic transport ladder runs instead.
 *
 * @param {*} data
 * @returns {string|null}
 */
export function decodeAisFrameSync(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    );
  }
  if (Array.isArray(data)) {
    // ws delivers a fragmented message as an array of Buffers.
    const parts = data.map(decodeAisFrameSync);
    return parts.some((part) => part === null) ? null : parts.join('');
  }
  return null;
}

/**
 * Decode one websocket frame to text. Handles the String (built-in WebSocket),
 * Buffer/TypedArray (ws), ArrayBuffer and Blob shapes.
 * @param {*} data
 * @returns {Promise<string>}
 */
export async function decodeAisFrame(data) {
  const sync = decodeAisFrameSync(data);
  if (sync !== null) return sync;
  if (data && typeof data.text === 'function') return data.text();
  return String(data ?? '');
}

/**
 * Upper bound on a single frame before decoding.
 *
 * AIS envelopes are a couple of KB; anything approaching this is not a feed
 * message. The bound is applied BEFORE the synchronous decode so a hostile or
 * corrupt frame cannot stall the event loop building a huge string.
 */
export const AIS_MAX_FRAME_BYTES = 1_000_000;

/**
 * Approximate a frame's size without decoding it. String length is in code
 * units rather than UTF-8 bytes, which only ever under-counts — fine for a
 * rejection threshold.
 * @param {*} data
 * @returns {number}
 */
export function aisFrameByteLength(data) {
  if (typeof data === 'string') return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((sum, part) => sum + aisFrameByteLength(part), 0);
  return 0;
}

/**
 * AISStream message types that count as feed traffic.
 *
 * This is the COMPLETE `AisMessageTypes` enum from AISStream's own
 * type-definition.yaml (github.com/aisstream/ais-message-models, master),
 * transcribed wholesale rather than hand-picked: a type missing from this list
 * is never credited as liveness, so a subscription filtered to it would read
 * as dead and be recycled forever. An earlier hand-picked version omitted
 * AddressedBinaryMessage, DataLinkManagementMessageData and UnknownMessage for
 * exactly that reason.
 *
 * If AISStream adds a type, add it here — do not infer it.
 */
export const AIS_RECOGNIZED_MESSAGE_TYPES = Object.freeze(new Set([
  'PositionReport',
  'UnknownMessage',
  'AddressedSafetyMessage',
  'AddressedBinaryMessage',
  'AidsToNavigationReport',
  'AssignedModeCommand',
  'BaseStationReport',
  'BinaryAcknowledge',
  'BinaryBroadcastMessage',
  'ChannelManagement',
  'CoordinatedUTCInquiry',
  'DataLinkManagementMessage',
  'DataLinkManagementMessageData',
  'ExtendedClassBPositionReport',
  'GroupAssignmentCommand',
  'GnssBroadcastBinaryMessage',
  'Interrogation',
  'LongRangeAisBroadcastMessage',
  'MultiSlotBinaryMessage',
  'SafetyBroadcastMessage',
  'ShipStaticData',
  'SingleSlotBinaryMessage',
  'StandardClassBPositionReport',
  'StandardSearchAndRescueAircraftReport',
  'StaticDataReport',
]));

/**
 * Resolve an envelope's MMSI, or null.
 * @param {Object} envelope
 * @param {Object} body
 * @returns {string|null}
 */
export function aisEnvelopeMmsi(envelope, body = {}) {
  const metadata = envelope?.MetaData || envelope?.Metadata || {};
  const raw = metadata.MMSI ?? body.UserID ?? body.UserId ?? body.Mmsi;
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  return text ? text : null;
}

/**
 * Is this envelope real AIS traffic — the feed's only liveness proof?
 *
 * Requires a recognised MessageType, a body filed under that type, AND an
 * MMSI. An envelope carrying nothing but an MMSI is not evidence the feed
 * works: that is exactly the shape a malformed or synthetic frame takes.
 *
 * @param {Object} envelope
 * @returns {boolean}
 */
export function isRecognizedAisEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
  const messageType = envelope.MessageType;
  if (typeof messageType !== 'string' || !AIS_RECOGNIZED_MESSAGE_TYPES.has(messageType)) return false;
  const body = envelope.Message?.[messageType];
  if (!body || typeof body !== 'object') return false;
  return aisEnvelopeMmsi(envelope, body) !== null;
}

/**
 * Parse a decoded frame into a classified envelope.
 *
 * @param {string} text
 * @returns {{kind: 'malformed'}|{kind: 'error', message: string}|{kind: 'data', envelope: Object}}
 */
export function parseAisEnvelope(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { kind: 'malformed' };
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { kind: 'malformed' };
  }
  if (envelope.error) return { kind: 'error', message: String(envelope.error) };
  return { kind: 'data', envelope };
}

/**
 * Create the AISStream transport adapter.
 *
 * @param {Object} options
 * @param {(url: string) => Object} options.createSocket Socket factory.
 * @param {() => string} options.resolveUrl Upstream URL, read per connect.
 * @param {() => Object} options.buildSubscription Subscription payload.
 * @param {(envelope: Object) => boolean} options.ingestEnvelope Returns true
 *   only when the envelope was a real AIS record — the sole liveness proof.
 * @param {{wall: function, mono: function}} [options.clock]
 * @param {(message: string) => void} [options.warn]
 * @returns {Object} adapter handle
 */
export function createAisStreamAdapter(options) {
  const {
    createSocket,
    resolveUrl,
    buildSubscription,
    ingestEnvelope,
    clock = DEFAULT_CLOCK,
    warn = () => {},
  } = options;

  /** generation -> socket. Mutated only through the identity-checked helpers. */
  const sockets = new Map();
  /** Never reset, including across dispose(). See rule 1 at the top. */
  let generationHighWater = 0;
  let watchdog = null;

  /** (Re)build the state machine, preserving the generation namespace. */
  function setWatchdogOptions(watchdogOptions = {}) {
    if (watchdog) {
      generationHighWater = Math.max(generationHighWater, watchdog.highWaterGeneration());
    }
    watchdog = createAisWatchdog({
      ...watchdogOptions,
      startGeneration: generationHighWater,
      clock,
    });
    return watchdog;
  }

  /** True while `socket` is still the adapter's socket for `generation`. */
  function ownsSocket(generation, socket) {
    return sockets.get(generation) === socket;
  }

  /** Drop the map entry only if it still holds this exact socket. */
  function releaseSocketEntry(generation, socket) {
    if (sockets.get(generation) === socket) sockets.delete(generation);
  }

  /** Hard-abort a socket. Always terminate(), never close(). */
  function abort(socket, reason) {
    try {
      socket.terminate();
    } catch (error) {
      warn(`[AISStream] terminate(${reason || 'unknown'}) failed: ${error?.message || error}`);
    }
  }

  /** Terminate the socket registered for `generation`, if any. */
  function terminateGeneration(generation, reason) {
    const socket = sockets.get(generation);
    if (!socket) return;
    sockets.delete(generation);
    abort(socket, reason);
  }

  /**
   * Perform watchdog actions in order.
   * @param {Object} owner Watchdog instance that produced the actions.
   * @param {Array<Object>} actions
   */
  function runActions(owner, actions) {
    for (const action of actions || []) {
      if (action.type === 'terminate') terminateGeneration(action.generation, action.reason);
      else if (action.type === 'connect') openSocket(owner, action.generation);
    }
  }

  /** Fail a generation through its owning watchdog, with classification. */
  function failGeneration(owner, generation, detail) {
    runActions(owner, owner.onFailure(generation, detail));
  }

  /**
   * Open a socket for `generation`.
   *
   * Handlers capture BOTH the socket object and the watchdog instance that
   * commissioned them, so an event arriving after a dispose cannot reach the
   * replacement machine or a replacement socket.
   */
  function openSocket(owner, generation) {
    generationHighWater = Math.max(generationHighWater, generation);

    let socket;
    try {
      socket = createSocket(resolveUrl());
    } catch (error) {
      failGeneration(owner, generation, classifyAisFailure({ message: error?.message }));
      return;
    }
    if (!socket) {
      failGeneration(owner, generation, { kind: 'transport', message: 'socket factory returned nothing' });
      return;
    }
    sockets.set(generation, socket);

    // `ws` emitter semantics only. The built-in WebSocket's addEventListener
    // hands the handler an Event rather than the frame data, so accepting it
    // here would silently mis-decode every frame — and it cannot be used
    // anyway, having no terminate().
    if (typeof socket.on !== 'function') {
      sockets.delete(generation);
      abort(socket, 'unsupported-transport');
      failGeneration(owner, generation, {
        kind: 'transport',
        message: 'AIS socket does not expose ws emitter semantics',
      });
      return;
    }
    const on = (event, handler) => socket.on(event, handler);

    on('open', () => {
      if (!ownsSocket(generation, socket)) {
        abort(socket, 'orphan-open');
        return;
      }
      const actions = owner.onOpen(generation);
      if (actions.length) {
        runActions(owner, actions);
        return; // orphan — hung up, never subscribed
      }
      try {
        socket.send(JSON.stringify(buildSubscription()));
      } catch (error) {
        failGeneration(owner, generation, classifyAisFailure({ message: error?.message }));
      }
    });

    on('message', (data) => {
      // The whole body is guarded: this is an EventEmitter handler, so an
      // escaping throw (including from the decode itself) would reach the
      // process-level handler and take the dev server down.
      try {
        const size = aisFrameByteLength(data);
        if (size > AIS_MAX_FRAME_BYTES) {
          warn(`[AISStream] dropping oversized frame (${size} bytes)`);
          return; // no decode, no state effect
        }
        // Fast path: every shape ws delivers decodes without suspending, so
        // the frame is fully classified before any same-tick 'close' runs.
        const text = decodeAisFrameSync(data);
        if (text !== null) {
          handleDecodedMessage(owner, generation, socket, text);
          return;
        }
        handleMessage(owner, generation, socket, data).catch((error) => {
          warn(`[AISStream] message handling failed: ${error?.message || error}`);
        });
      } catch (error) {
        // A frame that cannot even be decoded is a malformed frame: dropped,
        // with no liveness credit and no other state effect.
        warn(`[AISStream] message handling failed: ${error?.message || error}`);
      }
    });

    // Consuming 'unexpected-response' gives the real HTTP status and headers,
    // which is what separates an auth rejection from a generic fault.
    on('unexpected-response', (_request, response) => {
      const detail = classifyAisFailure({
        httpStatus: response?.statusCode,
        retryAfterHeader: response?.headers?.['retry-after'],
        nowMs: clock.wall(),
      });
      try {
        response?.destroy?.();
      } catch { /* already gone */ }
      releaseSocketEntry(generation, socket);
      abort(socket, 'unexpected-response');
      failGeneration(owner, generation, detail);
    });

    on('error', (error) => {
      // An error on a socket we already abandoned yields no watchdog action,
      // so it has to be hung up here or it would linger holding the slot.
      if (!ownsSocket(generation, socket)) {
        abort(socket, 'orphan-error');
        return;
      }
      failGeneration(owner, generation, classifyAisFailure({
        message: error?.message || String(error || ''),
        nowMs: clock.wall(),
      }));
    });

    on('close', () => {
      releaseSocketEntry(generation, socket);
      runActions(owner, owner.onClose(generation));
    });
  }

  /**
   * The message pipeline. Ownership is verified before any work AND again
   * after the decode await, because that suspension point is long enough for a
   * terminate to land.
   */
  async function handleMessage(owner, generation, socket, data) {
    if (!ownsSocket(generation, socket)) {
      abort(socket, 'orphan-message');
      return;
    }
    // Only the Blob shape reaches here, and only it needs an await.
    const text = await decodeAisFrame(data);
    handleDecodedMessage(owner, generation, socket, text);
  }

  /**
   * Classify and apply one decoded frame. Ownership is re-verified here because
   * the async path suspends before reaching it.
   */
  function handleDecodedMessage(owner, generation, socket, text) {
    if (!ownsSocket(generation, socket)) {
      abort(socket, 'orphan-message');
      return;
    }

    const parsed = parseAisEnvelope(text);
    if (parsed.kind === 'malformed') return; // not liveness, not data
    if (parsed.kind === 'error') {
      // An error envelope is the OPPOSITE of liveness. Classifying it keeps a
      // rejected key out of the fast ladder.
      failGeneration(owner, generation, classifyAisFailure({
        message: parsed.message,
        nowMs: clock.wall(),
      }));
      return;
    }

    const accepted = Boolean(ingestEnvelope(parsed.envelope));
    if (!accepted) return; // valid JSON, but no AIS record — proves nothing
    runActions(owner, owner.onMessage(generation));
  }

  /** Drive the machine once: re-declare the environment, then advance time. */
  function ensure(env) {
    if (!watchdog) setWatchdogOptions();
    runActions(watchdog, watchdog.configure(env));
    runActions(watchdog, watchdog.tick());
  }

  /** Tear down sockets and machine state, preserving the generation namespace. */
  function dispose() {
    if (watchdog) {
      generationHighWater = Math.max(generationHighWater, watchdog.highWaterGeneration());
      runActions(watchdog, watchdog.dispose());
    }
    for (const [generation, socket] of [...sockets]) {
      sockets.delete(generation);
      abort(socket, 'dispose');
    }
    sockets.clear();
  }

  return {
    setWatchdogOptions,
    ensure,
    dispose,
    snapshot: () => (watchdog ? watchdog.snapshot() : null),
    /** Diagnostics for tests. */
    debug: () => ({
      liveSockets: sockets.size,
      generations: [...sockets.keys()],
      generationHighWater,
      watchdog: watchdog ? watchdog.debugState() : null,
    }),
  };
}
