// AISStream transport adapter. Exercises the REAL adapter — the same code the
// Vite plugin runs — against mock sockets that reproduce `ws` semantics,
// including the window between terminate() and its asynchronous close event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIS_MAX_FRAME_BYTES,
  AIS_RECOGNIZED_MESSAGE_TYPES,
  aisFrameByteLength,
  classifyAisFailure,
  createAisStreamAdapter,
  decodeAisFrame,
  decodeAisFrameSync,
  isRecognizedAisEnvelope,
  parseAisEnvelope,
  parseRetryAfterMs,
} from './aisStreamAdapter.js';

const ENV = { hasKey: true, hasTransport: true, keyFingerprint: 'key-a' };

const BUDGETS = Object.freeze({
  staleMs: 1_000,
  recycleAfterMs: 2_500,
  backoffMs: [5_000, 15_000],
  downRetryMs: 60_000,
  authProbeMs: 3_600_000,
});

function fakeClock(startWall = 1_700_000_000_000, startMono = 10_000) {
  let wall = startWall;
  let mono = startMono;
  return {
    clock: { wall: () => wall, mono: () => mono },
    advance(ms) { wall += ms; mono += ms; },
    get wall() { return wall; },
  };
}

/**
 * Mock socket with `ws` semantics. terminate() destroys the connection
 * synchronously (that is the whole reason ws is used) but, like ws, the
 * 'close' event lands on a later turn — the window in which a stale handler
 * can still fire.
 */
function makeMockTransport() {
  const created = [];

  class MockSocket {
    constructor(url) {
      this.url = url;
      this.terminated = false;
      this.selfClosed = false;
      this.sent = [];
      this.handlers = new Map();
      this.pendingClose = false;
      created.push(this);
    }

    get connectionOpen() {
      return !this.terminated && !this.selfClosed;
    }

    on(event, handler) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event).push(handler);
    }

    emit(event, ...args) {
      for (const handler of [...(this.handlers.get(event) || [])]) handler(...args);
    }

    send(payload) {
      if (!this.connectionOpen) throw new Error('send on a dead socket');
      this.sent.push(payload);
    }

    terminate() {
      if (this.terminated) return;
      this.terminated = true;
      this.pendingClose = true; // close lands later, as in ws
    }

    /** Deliver the close event ws would emit after terminate(). */
    flushClose() {
      if (!this.pendingClose) return;
      this.pendingClose = false;
      this.emit('close');
    }

    /** The server hangs up on its own. */
    serverClose() {
      this.selfClosed = true;
      this.emit('close');
    }
  }

  return {
    MockSocket,
    created,
    /** Sockets still holding a connection right now. */
    openConnections: () => created.filter((socket) => socket.connectionOpen).length,
  };
}

/** Let the adapter's async message pipeline settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(options = {}) {
  const time = fakeClock();
  const transport = makeMockTransport();
  const ingested = [];
  const warnings = [];

  const adapter = createAisStreamAdapter({
    createSocket: (url) => new transport.MockSocket(url),
    resolveUrl: () => 'ws://mock.invalid/stream',
    buildSubscription: () => ({ APIKey: 'redacted' }),
    ingestEnvelope: (envelope) => {
      ingested.push(envelope);
      if (typeof options.ingestResult === 'function') return options.ingestResult(envelope);
      // The REAL production predicate, not a stand-in — otherwise these tests
      // would pass against a liveness rule that never ships.
      return isRecognizedAisEnvelope(envelope);
    },
    clock: time.clock,
    warn: (message) => warnings.push(message),
  });
  adapter.setWatchdogOptions({ ...BUDGETS, ...options.budgets });

  return { adapter, transport, time, ingested, warnings };
}

/** A well-formed AIS position report. */
function aisFrame(mmsi = '123456789') {
  return JSON.stringify({
    MessageType: 'PositionReport',
    MetaData: { MMSI: mmsi, latitude: 1, longitude: 2 },
    Message: { PositionReport: { Latitude: 1, Longitude: 2 } },
  });
}

/** Bring the adapter to one live, data-flowing socket. */
async function goLive(context) {
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');
  socket.emit('message', aisFrame());
  await flush();
  assert.equal(context.adapter.snapshot().status, 'live');
  return socket;
}

// --- FINDING 1 [P0]: generation reuse across disposal ----------------------

test('P0: a pre-disposal close event cannot erase the post-disposal socket', async () => {
  const context = setup();
  const first = await goLive(context);

  // Dev server restarts in-process: dispose, re-arm, reconnect.
  context.adapter.dispose();
  assert.equal(first.terminated, true, 'dispose hard-aborts the live socket');
  context.adapter.setWatchdogOptions(BUDGETS);
  context.adapter.ensure(ENV);

  const second = context.transport.created[1];
  assert.ok(second, 'a replacement socket was opened');
  assert.deepEqual(context.adapter.debug().generations, [2],
    'the replacement must NOT reuse generation 1');

  // The pre-disposal socket's close finally lands — review's exact interleaving.
  first.flushClose();

  const debug = context.adapter.debug();
  assert.equal(debug.liveSockets, 1, 'the live socket survives the stale close');
  assert.deepEqual(debug.generations, [2]);
  assert.equal(second.terminated, false, 'the replacement was not hung up');
  assert.equal(context.transport.created.length, 2, 'no third socket was opened');
  assert.equal(context.transport.openConnections(), 1, 'single-socket invariant holds');
});

test('P0: the same interleaving without an explicit re-arm is equally safe', async () => {
  const context = setup();
  const first = await goLive(context);

  context.adapter.dispose();
  context.adapter.ensure(ENV); // no setWatchdogOptions this time
  const second = context.transport.created[1];

  first.flushClose();

  assert.equal(context.adapter.debug().liveSockets, 1);
  assert.equal(second.terminated, false);
  assert.equal(context.transport.openConnections(), 1);
});

test('P0: the generation namespace never repeats across many disposals', async () => {
  const context = setup();
  const seen = new Set();

  for (let round = 0; round < 6; round += 1) {
    context.adapter.ensure(ENV);
    for (const generation of context.adapter.debug().generations) {
      assert.equal(seen.has(generation), false, `generation ${generation} was reused`);
      seen.add(generation);
    }
    context.adapter.dispose();
    context.adapter.setWatchdogOptions(BUDGETS);
  }
  assert.equal(seen.size, 6);
});

test('P0: at most one connection is ever open across a full failure cycle', async () => {
  const context = setup();
  await goLive(context);

  for (let round = 0; round < 5; round += 1) {
    assert.ok(context.transport.openConnections() <= 1,
      `round ${round}: ${context.transport.openConnections()} sockets open`);

    // Silence trips the recycle, which terminates before any reconnect.
    context.time.advance(BUDGETS.recycleAfterMs + 1);
    context.adapter.ensure(ENV);
    assert.ok(context.transport.openConnections() <= 1, 'terminate precedes reconnect');

    // The terminated socket's close lands only later — the ownership window.
    context.time.advance(BUDGETS.backoffMs[0] + 1);
    context.adapter.ensure(ENV);
    for (const socket of context.transport.created) socket.flushClose();
    assert.ok(context.transport.openConnections() <= 1, 'late closes open nothing extra');
  }
});

// --- FINDING 2 [P1]: liveness credit and orphan frames --------------------

test('an orphan frame is dropped entirely — no ingestion, no liveness', async () => {
  const context = setup();
  const first = await goLive(context);

  context.time.advance(BUDGETS.recycleAfterMs + 1);
  context.adapter.ensure(ENV); // terminates gen 1
  assert.equal(first.terminated, true);
  const ingestedBefore = context.ingested.length;
  const statusBefore = context.adapter.snapshot().status;

  // The dead socket delivers a perfectly valid frame.
  first.emit('message', aisFrame('999999999'));
  await flush();

  assert.equal(context.ingested.length, ingestedBefore, 'orphan data must not be ingested');
  assert.equal(context.adapter.snapshot().status, statusBefore, 'orphan data must not grant liveness');
});

test('a malformed frame is not liveness and is never ingested', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');

  socket.emit('message', 'not json at all {{{');
  await flush();

  assert.equal(context.ingested.length, 0);
  assert.equal(context.adapter.snapshot().status, 'connecting', 'garbage is not a working feed');
  assert.equal(context.adapter.snapshot().lastMessageAt, null);
});

test('a valid JSON frame carrying no AIS record is not liveness', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');

  socket.emit('message', JSON.stringify({ MessageType: 'Heartbeat' }));
  await flush();

  assert.equal(context.ingested.length, 1, 'it reached the ingester');
  assert.equal(context.adapter.snapshot().status, 'connecting', 'but proved nothing');
});

test('an MMSI-bearing envelope with no recognised message is NOT liveness', async () => {
  // The shape a synthetic or corrupt frame takes: an MMSI and nothing else.
  const context = setup();
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');

  socket.emit('message', JSON.stringify({ MetaData: { MMSI: '123456789' } }));
  socket.emit('message', JSON.stringify({
    MessageType: 'NotARealType',
    MetaData: { MMSI: '123456789' },
    Message: { NotARealType: { Latitude: 1 } },
  }));
  socket.emit('message', JSON.stringify({
    MessageType: 'PositionReport', // recognised type, but no body filed under it
    MetaData: { MMSI: '123456789' },
  }));
  await flush();

  assert.equal(
    context.adapter.snapshot().status, 'connecting',
    'an MMSI alone must never stand in for a working feed',
  );
  assert.equal(context.adapter.snapshot().lastMessageAt, null);
});

test('every message type in AISStream\'s own enum counts as liveness', () => {
  // The complete AisMessageTypes enum from AISStream's type-definition.yaml.
  // A type missing from the allowlist would make a subscription filtered to it
  // read as permanently dead, so each one is pinned individually.
  const officialTypes = [
    'PositionReport', 'UnknownMessage', 'AddressedSafetyMessage',
    'AddressedBinaryMessage', 'AidsToNavigationReport', 'AssignedModeCommand',
    'BaseStationReport', 'BinaryAcknowledge', 'BinaryBroadcastMessage',
    'ChannelManagement', 'CoordinatedUTCInquiry', 'DataLinkManagementMessage',
    'DataLinkManagementMessageData', 'ExtendedClassBPositionReport',
    'GroupAssignmentCommand', 'GnssBroadcastBinaryMessage', 'Interrogation',
    'LongRangeAisBroadcastMessage', 'MultiSlotBinaryMessage',
    'SafetyBroadcastMessage', 'ShipStaticData', 'SingleSlotBinaryMessage',
    'StandardClassBPositionReport', 'StandardSearchAndRescueAircraftReport',
    'StaticDataReport',
  ];
  assert.equal(officialTypes.length, 25);

  for (const messageType of officialTypes) {
    assert.equal(
      isRecognizedAisEnvelope({
        MessageType: messageType,
        MetaData: { MMSI: '123456789' },
        Message: { [messageType]: { UserID: 123456789 } },
      }),
      true,
      `${messageType} must count as liveness`,
    );
  }

  // The allowlist and the enum must not drift apart in either direction.
  assert.deepEqual(
    [...AIS_RECOGNIZED_MESSAGE_TYPES].sort(),
    [...officialTypes].sort(),
    'allowlist has drifted from the official enum',
  );
});

test('the previously-omitted types are live end to end, not just in the predicate', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');

  socket.emit('message', JSON.stringify({
    MessageType: 'AddressedBinaryMessage',
    MetaData: { MMSI: '987654321' },
    Message: { AddressedBinaryMessage: { UserID: 987654321 } },
  }));
  await flush();

  assert.equal(
    context.adapter.snapshot().status, 'live',
    'a subscription filtered to this type must not read as dead',
  );
});

test('the shared recognition predicate is what production actually ships', () => {
  assert.equal(isRecognizedAisEnvelope(JSON.parse(aisFrame())), true);
  assert.equal(isRecognizedAisEnvelope({ MetaData: { MMSI: '1' } }), false);
  assert.equal(isRecognizedAisEnvelope({ MessageType: 'PositionReport' }), false);
  assert.equal(isRecognizedAisEnvelope({
    MessageType: 'PositionReport',
    Message: { PositionReport: {} },
  }), false, 'no MMSI');
  assert.equal(isRecognizedAisEnvelope({
    MessageType: 'Nonsense',
    MetaData: { MMSI: '1' },
    Message: { Nonsense: {} },
  }), false, 'unrecognised type');
  // Static data has no position but is still real feed traffic.
  assert.equal(isRecognizedAisEnvelope({
    MessageType: 'ShipStaticData',
    MetaData: { MMSI: '1' },
    Message: { ShipStaticData: { Destination: 'X' } },
  }), true);
  assert.equal(isRecognizedAisEnvelope(null), false);
  assert.equal(isRecognizedAisEnvelope([]), false);
});

test('an error envelope is never liveness and never resets the ladder', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');

  socket.emit('message', JSON.stringify({ error: 'temporary upstream glitch' }));
  await flush();

  const snap = context.adapter.snapshot();
  assert.notEqual(snap.status, 'live', 'an error frame must never read as a working feed');
  assert.equal(snap.lastMessageAt, null, 'an error frame is not a message');
  assert.equal(context.ingested.length, 0);
});

test('liveness is granted only once the frame decodes into a real AIS record', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');
  assert.equal(context.adapter.snapshot().status, 'connecting');

  socket.emit('message', Buffer.from(aisFrame())); // ws delivers Buffers
  await flush();

  assert.equal(context.adapter.snapshot().status, 'live');
  assert.equal(context.adapter.snapshot().lastMessageAt, context.time.wall);
});

test('an orphan open never subscribes on a socket the adapter gave up on', async () => {
  const context = setup();
  const first = await goLive(context);

  context.time.advance(BUDGETS.recycleAfterMs + 1);
  context.adapter.ensure(ENV);
  const sentBefore = first.sent.length;

  first.emit('open'); // late handshake on the dead socket
  assert.equal(first.sent.length, sentBefore, 'an orphan must never be subscribed');
});

test('an owned open subscribes exactly once', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');

  assert.equal(socket.sent.length, 1);
  assert.deepEqual(JSON.parse(socket.sent[0]), { APIKey: 'redacted' });
});

// --- FINDINGS 3 & 4 [P1]: auth and rate-limit classification --------------

test('an auth error envelope goes terminal instead of into the fast ladder', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');

  socket.emit('message', JSON.stringify({ error: 'Invalid API key' }));
  await flush();

  const snap = context.adapter.snapshot();
  assert.equal(snap.status, 'auth-failed');
  assert.equal(socket.terminated, true, 'the rejected socket is hung up');
  assert.equal(
    snap.nextAttemptAt - context.time.wall, BUDGETS.authProbeMs,
    'an hour, not five seconds',
  );
});

test('repeated auth envelopes never accelerate — the 5s-forever loop is closed', async () => {
  const context = setup();
  let connects = 0;

  // An hour of one-second ticking against a key that is always refused.
  for (let second = 0; second <= 3600; second += 1) {
    const before = context.transport.created.length;
    context.adapter.ensure(ENV);
    for (let i = before; i < context.transport.created.length; i += 1) {
      connects += 1;
      const socket = context.transport.created[i];
      socket.emit('open');
      socket.emit('message', JSON.stringify({ error: 'Invalid API key' }));
      await flush();
    }
    context.time.advance(1_000);
  }

  assert.ok(connects <= 2, `auth-rejected key produced ${connects} connections in an hour`);
  assert.equal(context.adapter.snapshot().status, 'auth-failed');
});

test('an auth envelope followed by a same-tick close is still classified as auth', () => {
  // Worst-case ordering: the peer sends the rejection and hangs up in the same
  // breath. If the pipeline suspended mid-frame, the close handler would run
  // first, schedule the 5s transport rung, and the frame would then be dropped
  // as an orphan — losing the rejection entirely.
  const context = setup();
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');

  socket.emit('message', Buffer.from(JSON.stringify({ error: 'Invalid API key' })));
  socket.serverClose(); // same tick, no awaits in between

  const snap = context.adapter.snapshot();
  assert.equal(snap.status, 'auth-failed', 'the rejection must survive the race');
  assert.equal(
    snap.nextAttemptAt - context.time.wall, BUDGETS.authProbeMs,
    'and must not fall back to the fast ladder',
  );
});

test('the sync decode path covers every shape ws delivers', () => {
  assert.equal(decodeAisFrameSync('text'), 'text');
  assert.equal(decodeAisFrameSync(Buffer.from('buf')), 'buf');
  assert.equal(decodeAisFrameSync(new TextEncoder().encode('typed').buffer), 'typed');
  assert.equal(decodeAisFrameSync([Buffer.from('a'), Buffer.from('b')]), 'ab');
  // Only the Blob shape needs the async fallback.
  assert.equal(decodeAisFrameSync({ text: async () => 'blob' }), null);
});

test('a Blob frame still works through the async fallback', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');

  socket.emit('message', { text: async () => aisFrame() });
  await flush();

  assert.equal(context.adapter.snapshot().status, 'live');
});

test('an HTTP 401 upgrade failure is classified as auth, not a transport fault', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];

  socket.emit('unexpected-response', {}, { statusCode: 401, headers: {} });

  const snap = context.adapter.snapshot();
  assert.equal(snap.status, 'auth-failed');
  assert.match(snap.error, /HTTP 401/);
  assert.equal(snap.nextAttemptAt - context.time.wall, BUDGETS.authProbeMs);
});

test('an HTTP 403 upgrade failure is also terminal', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  context.transport.created[0].emit('unexpected-response', {}, { statusCode: 403, headers: {} });
  assert.equal(context.adapter.snapshot().status, 'auth-failed');
});

test('an HTTP 429 honours Retry-After', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  context.transport.created[0].emit('unexpected-response', {}, {
    statusCode: 429,
    headers: { 'retry-after': '120' },
  });

  const snap = context.adapter.snapshot();
  assert.equal(snap.status, 'reconnecting');
  assert.equal(snap.nextAttemptAt - context.time.wall, 120_000);
});

test('an HTTP 429 without Retry-After falls back to the slowest rung', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  context.transport.created[0].emit('unexpected-response', {}, { statusCode: 429, headers: {} });

  const slowest = BUDGETS.backoffMs[BUDGETS.backoffMs.length - 1];
  assert.equal(context.adapter.snapshot().nextAttemptAt - context.time.wall, slowest);
});

test('an error on an abandoned socket hangs it up instead of leaking the slot', async () => {
  const context = setup();
  const first = await goLive(context);

  context.time.advance(BUDGETS.recycleAfterMs + 1);
  context.adapter.ensure(ENV); // terminates gen 1
  first.terminated = false; // pretend the abort did not take, to isolate the guard

  first.emit('error', new Error('late failure on a dead socket'));
  assert.equal(first.terminated, true, 'the orphan was hung up by the error handler');
  assert.equal(context.transport.openConnections(), 0);
});

test('a genuine transport error still uses the fast first rung', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  context.transport.created[0].emit('error', new Error('ECONNRESET'));

  const snap = context.adapter.snapshot();
  assert.equal(snap.status, 'reconnecting');
  assert.equal(snap.nextAttemptAt - context.time.wall, BUDGETS.backoffMs[0]);
});

// --- Pure classification helpers ------------------------------------------

test('failure classification separates auth, rate limits and transport faults', () => {
  assert.equal(classifyAisFailure({ httpStatus: 401 }).kind, 'auth');
  assert.equal(classifyAisFailure({ httpStatus: 403 }).kind, 'auth');
  assert.equal(classifyAisFailure({ httpStatus: 429 }).kind, 'rate-limit');
  assert.equal(classifyAisFailure({ httpStatus: 500 }).kind, 'transport');
  // ws's own wording when nothing consumed 'unexpected-response'.
  assert.equal(classifyAisFailure({ message: 'Unexpected server response: 401' }).kind, 'auth');
  assert.equal(classifyAisFailure({ message: 'Unexpected server response: 429' }).kind, 'rate-limit');
  // Upstream envelope wording.
  assert.equal(classifyAisFailure({ message: 'Invalid API key' }).kind, 'auth');
  assert.equal(classifyAisFailure({ message: 'unauthorized' }).kind, 'auth');
  assert.equal(classifyAisFailure({ message: 'API key is required' }).kind, 'auth');
  assert.equal(classifyAisFailure({ message: 'rate limit exceeded' }).kind, 'rate-limit');
  assert.equal(classifyAisFailure({ message: 'too many connections' }).kind, 'rate-limit');
  assert.equal(classifyAisFailure({ message: 'ECONNRESET' }).kind, 'transport');
  assert.equal(classifyAisFailure({}).kind, 'transport');
});

test('Retry-After accepts delta-seconds and HTTP-dates', () => {
  const now = Date.parse('2026-08-18T12:00:00Z');
  assert.equal(parseRetryAfterMs('30'), 30_000);
  assert.equal(parseRetryAfterMs('  45  '), 45_000);
  assert.equal(parseRetryAfterMs('Tue, 18 Aug 2026 12:02:00 GMT', now), 120_000);
  assert.equal(parseRetryAfterMs(undefined), 0);
  assert.equal(parseRetryAfterMs(''), 0);
  assert.equal(parseRetryAfterMs('soon'), 0);
});

test('frame decoding covers the string, Buffer, ArrayBuffer and fragment shapes', async () => {
  assert.equal(await decodeAisFrame('plain'), 'plain');
  assert.equal(await decodeAisFrame(Buffer.from('buffered')), 'buffered');
  assert.equal(await decodeAisFrame(new TextEncoder().encode('typed').buffer), 'typed');
  assert.equal(await decodeAisFrame([Buffer.from('frag'), Buffer.from('ments')]), 'fragments');
});

test('envelope parsing separates malformed, error and data frames', () => {
  assert.equal(parseAisEnvelope('nope').kind, 'malformed');
  assert.equal(parseAisEnvelope('[]').kind, 'malformed');
  assert.equal(parseAisEnvelope('null').kind, 'malformed');
  assert.deepEqual(parseAisEnvelope('{"error":"bad key"}'), { kind: 'error', message: 'bad key' });
  assert.equal(parseAisEnvelope(aisFrame()).kind, 'data');
});

// --- Lifecycle -------------------------------------------------------------

test('a server-initiated close reconnects on the ladder without leaking sockets', async () => {
  const context = setup();
  const socket = await goLive(context);

  socket.serverClose();
  assert.equal(context.adapter.debug().liveSockets, 0, 'the closed socket is off the books');
  assert.equal(context.adapter.snapshot().status, 'reconnecting');

  context.time.advance(BUDGETS.backoffMs[0] + 1);
  context.adapter.ensure(ENV);
  assert.equal(context.transport.openConnections(), 1);
});

test('a keyless environment opens nothing and terminates anything held', async () => {
  const context = setup();
  const socket = await goLive(context);

  context.adapter.ensure({ hasKey: false });
  assert.equal(socket.terminated, true);
  assert.equal(context.adapter.snapshot().status, 'missing-key');

  context.time.advance(600_000);
  context.adapter.ensure({ hasKey: false });
  assert.equal(context.transport.created.length, 1, 'no sockets while keyless');
});

test('a socket without ws emitter semantics is rejected, not silently mis-read', () => {
  const time = fakeClock();
  const adapter = createAisStreamAdapter({
    // A built-in-WebSocket-shaped object: addEventListener only, no terminate.
    createSocket: () => ({ addEventListener() {}, close() {} }),
    resolveUrl: () => 'ws://mock.invalid/stream',
    buildSubscription: () => ({}),
    ingestEnvelope: () => false,
    clock: time.clock,
  });
  adapter.setWatchdogOptions(BUDGETS);

  adapter.ensure(ENV);
  assert.equal(adapter.snapshot().status, 'reconnecting');
  assert.match(adapter.snapshot().error, /ws emitter semantics/);
  assert.equal(adapter.debug().liveSockets, 0, 'the unusable socket is not retained');
});

test('a socket factory failure is classified rather than thrown', () => {
  const time = fakeClock();
  const adapter = createAisStreamAdapter({
    createSocket: () => { throw new Error('ws transport unavailable'); },
    resolveUrl: () => 'ws://mock.invalid/stream',
    buildSubscription: () => ({}),
    ingestEnvelope: () => false,
    clock: time.clock,
  });
  adapter.setWatchdogOptions(BUDGETS);

  assert.doesNotThrow(() => adapter.ensure(ENV));
  assert.equal(adapter.snapshot().status, 'reconnecting');
});

test('an oversized frame is dropped before it is ever decoded', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');

  socket.emit('message', Buffer.alloc(AIS_MAX_FRAME_BYTES + 1));
  await flush();

  assert.equal(context.ingested.length, 0, 'never decoded, never ingested');
  assert.equal(context.adapter.snapshot().status, 'connecting', 'and never liveness');
  assert.equal(context.warnings.length, 1);
  assert.match(context.warnings[0], /oversized frame/);

  // A normal frame on the same socket still works.
  socket.emit('message', aisFrame());
  await flush();
  assert.equal(context.adapter.snapshot().status, 'live');
});

test('frame sizing covers every shape without decoding', () => {
  assert.equal(aisFrameByteLength('abcd'), 4);
  assert.equal(aisFrameByteLength(Buffer.alloc(11)), 11);
  assert.equal(aisFrameByteLength(new ArrayBuffer(7)), 7);
  assert.equal(aisFrameByteLength([Buffer.alloc(3), Buffer.alloc(4)]), 7);
  assert.equal(aisFrameByteLength({ text: async () => '' }), 0, 'Blob defers to the async path');
});

test('a frame whose decode throws is treated as malformed, not fatal', async () => {
  const context = setup();
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');

  // A view whose backing buffer is detached: .byteLength reads fine, the
  // decode throws. The handler must absorb it rather than let it escape the
  // EventEmitter and reach the process-level handler.
  const view = new Uint8Array(new ArrayBuffer(8));
  Object.defineProperty(view, 'buffer', {
    get() { throw new TypeError('detached ArrayBuffer'); },
  });

  assert.doesNotThrow(() => socket.emit('message', view));
  await flush();

  assert.equal(context.warnings.length, 1);
  assert.match(context.warnings[0], /message handling failed/);
  assert.equal(context.adapter.snapshot().status, 'connecting', 'no liveness from a bad frame');

  socket.emit('message', aisFrame());
  await flush();
  assert.equal(context.adapter.snapshot().status, 'live', 'the socket still works afterwards');
});

test('an ingester that throws does not take the process down', async () => {
  const context = setup({ ingestResult: () => { throw new Error('boom'); } });
  context.adapter.ensure(ENV);
  const socket = context.transport.created[0];
  socket.emit('open');

  socket.emit('message', aisFrame());
  await flush();

  assert.equal(context.warnings.length, 1, 'the failure was reported, not fatal');
  assert.match(context.warnings[0], /message handling failed/);
});
