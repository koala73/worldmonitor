// AISStream watchdog state machine. Both clocks are injected and sockets are
// fakes, so every policy branch runs offline with no timers and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIS_WATCHDOG_DEFAULTS,
  createAisWatchdog,
  isLiveAisStatus,
  parseSilenceTimeoutEnv,
} from './aisWatchdog.js';

const LIVE_ENV = { hasKey: true, hasTransport: true, keyFingerprint: 'key-a' };

/**
 * Separately controllable wall and monotonic clocks. `advance` moves both, as
 * real time does; `rollbackWall` moves only the wall clock, which is what an
 * NTP correction or a manual clock change looks like.
 */
function fakeClock(startWall = 1_700_000_000_000, startMono = 10_000) {
  let wall = startWall;
  let mono = startMono;
  return {
    clock: { wall: () => wall, mono: () => mono },
    advance(ms) { wall += ms; mono += ms; },
    rollbackWall(ms) { wall -= ms; },
    get wall() { return wall; },
  };
}

/**
 * Drive a watchdog, recording every action in order and asserting the
 * single-socket invariant on each connect.
 */
function harness(options = {}) {
  const time = fakeClock();
  const watchdog = createAisWatchdog({ ...options, clock: time.clock });
  const actions = [];
  const openSockets = new Set();

  function record(list) {
    for (const action of list || []) {
      actions.push(action);
      if (action.type === 'connect') {
        assert.equal(
          openSockets.size, 0,
          `connect(gen ${action.generation}) issued while sockets ${[...openSockets]} were still live`,
        );
        openSockets.add(action.generation);
      } else if (action.type === 'terminate') {
        openSockets.delete(action.generation);
      }
    }
    return list;
  }

  return {
    watchdog,
    actions,
    openSockets,
    time,
    advance(ms) { time.advance(ms); },
    configure(env = LIVE_ENV) { return record(watchdog.configure(env)); },
    tick() { return record(watchdog.tick()); },
    open(generation) { return record(watchdog.onOpen(generation)); },
    message(generation) { return record(watchdog.onMessage(generation)); },
    close(generation) {
      openSockets.delete(generation); // a socket that closed itself is gone
      return record(watchdog.onClose(generation));
    },
    fail(generation, detail) { return record(watchdog.onFailure(generation, detail)); },
    dispose() { return record(watchdog.dispose()); },
    snapshot() { return watchdog.snapshot(); },
    types() { return actions.map((a) => `${a.type}:${a.generation}`); },
  };
}

/** Bring a harness to a healthy, data-flowing socket on generation 1. */
function goLive(h) {
  h.configure();
  h.tick();
  h.open(1);
  h.message(1);
  assert.equal(h.snapshot().status, 'live');
  return h;
}

test('keyless install reports the feature as off and never opens a socket', () => {
  const h = harness();
  h.configure({ hasKey: false });
  h.tick();
  h.advance(10 * 60_000);
  h.tick();

  assert.deepEqual(h.types(), []);
  const snap = h.snapshot();
  assert.equal(snap.status, 'missing-key');
  assert.equal(snap.error, 'AISSTREAM_API_KEY is not set');
  assert.equal(snap.reconnectAttempt, 0);
  assert.equal(snap.nextAttemptAt, null);
});

test('a key added mid-session clears the terminal state and connects at once', () => {
  const h = harness();
  h.configure({ hasKey: false });
  h.tick();
  assert.deepEqual(h.types(), []);

  h.configure(LIVE_ENV);
  h.tick();
  assert.deepEqual(h.types(), ['connect:1']);
  assert.equal(h.snapshot().status, 'connecting');
});

test('a key removed mid-session terminates the live socket', () => {
  const h = goLive(harness());
  h.configure({ hasKey: false });
  assert.deepEqual(h.types(), ['connect:1', 'terminate:1']);
  assert.equal(h.snapshot().status, 'missing-key');
  assert.equal(h.openSockets.size, 0);
});

test('an open socket is not live until data actually arrives', () => {
  const h = harness();
  h.configure();
  h.tick();
  h.open(1);

  assert.equal(h.snapshot().status, 'connecting');
  assert.equal(h.snapshot().lastMessageAt, null);
  assert.equal(isLiveAisStatus(h.snapshot().status), false);

  h.message(1);
  assert.equal(h.snapshot().status, 'live');
  assert.equal(h.snapshot().lastMessageAt, h.time.wall);
});

test('liveness is data, not socket state: silence past staleMs reports stale', () => {
  const h = goLive(harness());
  const startedAt = h.time.wall;

  h.advance(AIS_WATCHDOG_DEFAULTS.staleMs - 1_000);
  h.tick();
  assert.equal(h.snapshot().status, 'live', 'inside the budget the feed is still live');

  h.advance(2_000);
  h.tick();
  const snap = h.snapshot();
  assert.equal(snap.status, 'stale');
  assert.equal(snap.lastMessageAt, startedAt, 'the last good message is still reported');
  assert.ok(snap.silentForMs >= AIS_WATCHDOG_DEFAULTS.staleMs);
  assert.deepEqual(h.types(), ['connect:1'], 'reporting stale must not touch the socket');
});

test('reporting is fast but recycling is slow — no reconnect at the stale threshold', () => {
  const h = goLive(harness());
  h.advance(AIS_WATCHDOG_DEFAULTS.staleMs + 1_000);
  h.tick();
  assert.equal(h.snapshot().status, 'stale');

  for (let i = 0; i < 20; i += 1) {
    h.advance(8_000);
    h.tick();
  }
  assert.equal(h.snapshot().status, 'stale');
  assert.deepEqual(h.types(), ['connect:1'], 'no socket churn between staleMs and recycleAfterMs');
});

// --- FINDING 5: a handshake must not buy extra silence budget --------------

test('a late handshake does NOT reset the silence clock', () => {
  const h = harness();
  h.configure();
  h.tick(); // connect:1 — the silence budget starts here

  // The socket opens just before the recycle deadline.
  h.advance(AIS_WATCHDOG_DEFAULTS.recycleAfterMs - 1_000);
  h.open(1);
  assert.ok(
    h.snapshot().silentForMs >= AIS_WATCHDOG_DEFAULTS.recycleAfterMs - 1_000,
    'the handshake must not rewind the silence measurement',
  );

  // ...and it still recycles on the ORIGINAL schedule, not open + 300s.
  h.advance(1_001);
  h.tick();
  assert.deepEqual(h.types(), ['connect:1', 'terminate:1'],
    'an opened-but-silent socket recycles on its commissioning schedule');
});

test('a handshake does not clear a stale verdict or reset the ladder', () => {
  const h = goLive(harness());
  h.advance(AIS_WATCHDOG_DEFAULTS.staleMs + 1_000);
  h.tick();
  assert.equal(h.snapshot().status, 'stale');

  h.open(1); // a duplicate/late open event
  assert.equal(h.snapshot().status, 'stale', 'only data clears stale');
});

// --- FINDING 8: durations use a monotonic clock ---------------------------

test('a wall-clock rollback cannot suppress stale detection', () => {
  const h = goLive(harness());

  // The operator's clock jumps back an hour mid-silence.
  h.advance(AIS_WATCHDOG_DEFAULTS.staleMs + 1_000);
  h.time.rollbackWall(3_600_000);
  h.tick();

  assert.equal(h.snapshot().status, 'stale', 'staleness is measured monotonically');
  assert.ok(h.snapshot().silentForMs > 0, 'silence must never read negative');

  h.advance(AIS_WATCHDOG_DEFAULTS.recycleAfterMs);
  h.tick();
  assert.deepEqual(h.types(), ['connect:1', 'terminate:1'], 'recycle still fires after a rollback');
});

test('a silent socket is terminated once, then reconnected after backoff', () => {
  const h = goLive(harness());
  h.advance(AIS_WATCHDOG_DEFAULTS.recycleAfterMs + 1);
  h.tick();

  assert.deepEqual(h.types(), ['connect:1', 'terminate:1']);
  const afterKill = h.snapshot();
  assert.equal(afterKill.status, 'reconnecting');
  assert.equal(afterKill.reconnectAttempt, 1);
  assert.match(afterKill.error, /delivered no data for \d+s/);

  h.advance(4_000);
  h.tick();
  assert.deepEqual(h.types(), ['connect:1', 'terminate:1']);

  h.advance(1_001);
  h.tick();
  assert.deepEqual(h.types(), ['connect:1', 'terminate:1', 'connect:2']);
});

test('single-socket invariant: a reconnect always terminates the old socket first', () => {
  const h = goLive(harness());
  for (let round = 0; round < 6; round += 1) {
    h.advance(AIS_WATCHDOG_DEFAULTS.recycleAfterMs + 1);
    h.tick();
    h.advance(AIS_WATCHDOG_DEFAULTS.downRetryMs + 1);
    h.tick();
  }

  let held = null;
  for (const entry of h.types()) {
    const [type, generation] = entry.split(':');
    if (type === 'connect') {
      assert.equal(held, null, `connect ${generation} while ${held} was still held`);
      held = generation;
    } else {
      assert.equal(held, generation, `terminate ${generation} but ${held} was held`);
      held = null;
    }
  }
});

test('the machine never emits a graceful close — only terminate', () => {
  const h = goLive(harness());
  for (let round = 0; round < 4; round += 1) {
    h.advance(AIS_WATCHDOG_DEFAULTS.recycleAfterMs + 1);
    h.tick();
    h.advance(AIS_WATCHDOG_DEFAULTS.downRetryMs + 1);
    h.tick();
  }
  h.fail(99, { kind: 'transport' });
  h.dispose();

  const kinds = new Set(h.actions.map((a) => a.type));
  assert.deepEqual([...kinds].sort(), ['connect', 'terminate']);
});

test('backoff is exponential, not a fixed thrash cycle', () => {
  const h = harness();
  h.configure();
  h.tick();

  const waits = [];
  for (let attempt = 0; attempt < AIS_WATCHDOG_DEFAULTS.backoffMs.length; attempt += 1) {
    const generation = attempt + 1;
    h.open(generation);
    h.close(generation);
    waits.push(h.snapshot().nextAttemptAt - h.time.wall);
    h.advance(waits[waits.length - 1]);
    h.tick();
  }

  assert.deepEqual(waits, [5_000, 15_000, 60_000, 300_000]);
  assert.equal(waits.every((w) => w === 90_000), false, 'not the reverted fixed cycle');
});

/** Fail every rung plus one, leaving the watchdog DOWN with no socket held. */
function exhaustLadder(h) {
  h.configure();
  h.tick();
  const rungs = AIS_WATCHDOG_DEFAULTS.backoffMs.length;
  for (let attempt = 0; attempt <= rungs; attempt += 1) {
    const generation = attempt + 1;
    h.open(generation);
    h.close(generation);
    if (attempt < rungs) {
      assert.equal(h.snapshot().status, 'reconnecting', `attempt ${attempt + 1} should still be retrying`);
      h.advance(h.snapshot().nextAttemptAt - h.time.wall);
      h.tick();
    }
  }
  return h;
}

test('backoff exhaustion enters DOWN with a slow retry, not silent infinite retry', () => {
  const h = exhaustLadder(harness());
  const down = h.snapshot();
  assert.equal(down.status, 'down');
  assert.equal(down.reconnectAttempt, AIS_WATCHDOG_DEFAULTS.backoffMs.length + 1);
  assert.equal(h.watchdog.debugState().owned, null, 'DOWN holds no socket');

  const before = h.types().length;
  h.advance(AIS_WATCHDOG_DEFAULTS.downRetryMs - 1_000);
  h.tick();
  assert.equal(h.types().length, before, 'no retry inside the DOWN cadence');

  h.advance(2_000);
  h.tick();
  assert.equal(h.types().length, before + 1, 'exactly one slow retry after the cadence');
});

test('the DOWN chip does not flicker hopeful while the slow retry runs behind it', () => {
  const h = exhaustLadder(harness());
  h.advance(AIS_WATCHDOG_DEFAULTS.downRetryMs + 1);
  h.tick();
  assert.equal(h.snapshot().status, 'down', 'a retry attempt must not read as recovery');

  h.open(h.watchdog.debugState().owned);
  assert.equal(h.snapshot().status, 'down', 'a handshake proves nothing — still DOWN');
});

test('DOWN clears only when data actually flows again', () => {
  const h = exhaustLadder(harness());
  h.advance(AIS_WATCHDOG_DEFAULTS.downRetryMs + 1);
  h.tick();
  const generation = h.watchdog.debugState().owned;
  h.open(generation);
  h.message(generation);

  const recovered = h.snapshot();
  assert.equal(recovered.status, 'live');
  assert.equal(recovered.reconnectAttempt, 0, 'the ladder resets only on real data');
  assert.equal(recovered.error, null);

  h.close(generation);
  assert.equal(h.snapshot().nextAttemptAt - h.time.wall, AIS_WATCHDOG_DEFAULTS.backoffMs[0]);
});

test('an open socket that never delivers does not reset the backoff ladder', () => {
  const h = harness();
  h.configure();
  h.tick();

  h.open(1);
  h.close(1);
  assert.equal(h.snapshot().reconnectAttempt, 1);

  h.advance(h.snapshot().nextAttemptAt - h.time.wall);
  h.tick();
  h.open(2);
  h.close(2);
  assert.equal(h.snapshot().reconnectAttempt, 2, 'open alone must not count as success');
});

test('a late-opening orphan is told to hang itself up', () => {
  const h = goLive(harness());
  h.advance(AIS_WATCHDOG_DEFAULTS.recycleAfterMs + 1);
  h.tick();
  h.advance(6_000);
  h.tick();

  assert.deepEqual(h.watchdog.onOpen(1), [{ type: 'terminate', generation: 1, reason: 'orphan' }]);
  assert.deepEqual(h.watchdog.onMessage(1), [{ type: 'terminate', generation: 1, reason: 'orphan' }]);
  assert.equal(h.snapshot().status, 'connecting');
  assert.equal(h.watchdog.debugState().owned, 2);
});

test('a stale generation closing does not disturb the socket that replaced it', () => {
  const h = goLive(harness());
  h.advance(AIS_WATCHDOG_DEFAULTS.recycleAfterMs + 1);
  h.tick();
  h.advance(6_000);
  h.tick();
  h.open(2);
  h.message(2);

  h.close(1); // the old socket's close finally lands
  assert.equal(h.snapshot().status, 'live', 'orphan close must not knock the live feed over');
  assert.equal(h.snapshot().reconnectAttempt, 0);
  assert.equal(h.watchdog.debugState().owned, 2);
});

test('generations are never reused across dispose', () => {
  const h = goLive(harness());
  assert.equal(h.watchdog.highWaterGeneration(), 1);

  h.dispose();
  h.configure();
  h.tick();
  assert.equal(h.watchdog.debugState().owned, 2, 'the namespace continues past the disposal');
  assert.equal(h.watchdog.highWaterGeneration(), 2);
});

test('a replacement machine can be seeded past the old generation namespace', () => {
  const time = fakeClock();
  const first = createAisWatchdog({ clock: time.clock });
  first.configure(LIVE_ENV);
  first.tick();
  first.tick();
  const high = first.highWaterGeneration();

  const second = createAisWatchdog({ clock: time.clock, startGeneration: high });
  second.configure(LIVE_ENV);
  const actions = second.tick();
  assert.ok(actions[0].generation > high, 'a replacement must not re-issue a live generation');
});

// --- FINDINGS 3 & 4: failures are classified ------------------------------

test('a transport error terminates immediately and walks the ladder', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'transport', message: 'ECONNRESET' });

  assert.deepEqual(h.types(), ['connect:1', 'terminate:1']);
  const snap = h.snapshot();
  assert.equal(snap.status, 'reconnecting');
  assert.equal(snap.error, 'ECONNRESET');
  assert.equal(snap.nextAttemptAt - h.time.wall, AIS_WATCHDOG_DEFAULTS.backoffMs[0]);
});

test('an auth failure is terminal — no ladder, only a very slow probe', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'auth', message: 'AISStream rejected the API key (HTTP 401)' });

  const snap = h.snapshot();
  assert.equal(snap.status, 'auth-failed');
  assert.equal(snap.error, 'AISStream rejected the API key (HTTP 401)');
  assert.equal(
    snap.nextAttemptAt - h.time.wall, AIS_WATCHDOG_DEFAULTS.authProbeMs,
    'an auth rejection waits an hour, not five seconds',
  );

  // Nothing happens for the whole hour, however often we are ticked.
  const before = h.types().length;
  for (let i = 0; i < 719; i += 1) { // 3595s of 5-second ticks
    h.advance(5_000);
    h.tick();
  }
  assert.equal(h.types().length, before, 'no attempt inside the probe cadence');

  h.advance(10_000);
  h.tick();
  assert.equal(h.types().length, before + 1, 'exactly one probe after the cadence');
});

test('a silent probe socket cannot launder an auth rejection into the fast ladder', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'auth' });
  h.advance(AIS_WATCHDOG_DEFAULTS.authProbeMs);
  h.tick(); // the hourly probe connects

  // The probe opens and then says nothing at all. The silence budget does not
  // apply while the key is refused, so nothing happens at 300s...
  h.advance(AIS_WATCHDOG_DEFAULTS.recycleAfterMs + 1);
  h.tick();
  assert.equal(h.snapshot().status, 'auth-failed', 'silence is not a transport fault here');

  // ...and when the probe is finally hung up, it is on the auth cadence.
  h.advance(AIS_WATCHDOG_DEFAULTS.authProbeMs);
  h.tick();
  const snap = h.snapshot();
  assert.equal(snap.status, 'auth-failed', 'still terminal');
  assert.equal(
    snap.nextAttemptAt - h.time.wall, AIS_WATCHDOG_DEFAULTS.authProbeMs,
    'the next probe stays an hour out, not five seconds',
  );
});

test('repeated auth rejections never accelerate into the ladder', () => {
  const h = goLive(harness());
  for (let round = 0; round < 5; round += 1) {
    const generation = h.watchdog.debugState().owned;
    h.fail(generation, { kind: 'auth', message: 'Invalid API key' });
    const snap = h.snapshot();
    assert.equal(snap.status, 'auth-failed', `round ${round} must stay terminal`);
    assert.equal(
      snap.nextAttemptAt - h.time.wall, AIS_WATCHDOG_DEFAULTS.authProbeMs,
      `round ${round} must keep the slow cadence`,
    );
    h.advance(AIS_WATCHDOG_DEFAULTS.authProbeMs);
    h.tick();
  }
});

test('the AUTH-FAILED chip does not flicker hopeful while probing', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'auth' });
  h.advance(AIS_WATCHDOG_DEFAULTS.authProbeMs);
  h.tick();
  assert.equal(h.snapshot().status, 'auth-failed');
  h.open(h.watchdog.debugState().owned);
  assert.equal(h.snapshot().status, 'auth-failed', 'a handshake does not mean the key works');
});

test('a changed API key clears the terminal auth state immediately', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'auth' });
  assert.equal(h.snapshot().status, 'auth-failed');

  h.configure({ hasKey: true, hasTransport: true, keyFingerprint: 'key-b' });
  h.tick();
  assert.equal(h.snapshot().status, 'connecting', 'a new credential earns a fresh attempt');
  assert.equal(h.snapshot().reconnectAttempt, 0);
});

test('rotating the key mid-probe terminates the old key socket first', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'auth' });
  h.advance(AIS_WATCHDOG_DEFAULTS.authProbeMs);
  h.tick(); // the hourly probe opens generation 2, still on key A
  assert.equal(h.watchdog.debugState().owned, 2);

  // The operator swaps the key while that probe is in flight.
  const rotation = h.configure({ hasKey: true, hasTransport: true, keyFingerprint: 'key-b' });
  assert.deepEqual(
    rotation, [{ type: 'terminate', generation: 2, reason: 'key-rotated' }],
    'the in-flight old-key socket must be hung up, not left running',
  );
  assert.equal(h.openSockets.size, 0);

  h.tick(); // generation 3, now on key B
  assert.equal(h.watchdog.debugState().owned, 3);
  assert.equal(h.snapshot().status, 'connecting');
});

test("an old key's late rejection cannot push the new key into auth-failed", () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'auth' });
  h.advance(AIS_WATCHDOG_DEFAULTS.authProbeMs);
  h.tick(); // probe on key A = generation 2

  h.configure({ hasKey: true, hasTransport: true, keyFingerprint: 'key-b' });
  h.tick(); // generation 3 on key B
  h.open(3);
  h.message(3);
  assert.equal(h.snapshot().status, 'live', 'the new key works');

  // Generation 2's rejection finally lands, an hour late and about key A.
  const late = h.watchdog.onFailure(2, { kind: 'auth', message: 'Invalid API key' });
  assert.deepEqual(late, [], 'an old-key rejection is an orphan with no effect');
  assert.equal(h.snapshot().status, 'live', 'the new key must not inherit the old one\'s verdict');
  assert.equal(h.snapshot().reconnectAttempt, 0);
});

test('rotating the key also replaces a healthy socket built on the old credential', () => {
  const h = goLive(harness());
  const rotation = h.configure({ hasKey: true, hasTransport: true, keyFingerprint: 'key-b' });
  assert.deepEqual(rotation, [{ type: 'terminate', generation: 1, reason: 'key-rotated' }],
    'the live socket subscribed with the old key and must not outlive it');
  h.tick();
  assert.equal(h.watchdog.debugState().owned, 2);
});

// --- No probe outcome may relaunder auth into the fast ladder -------------

test('a probe CLOSE keeps auth-failed at the hourly cadence', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'auth' });
  h.advance(AIS_WATCHDOG_DEFAULTS.authProbeMs);
  h.tick();

  h.close(h.watchdog.debugState().owned);

  const snap = h.snapshot();
  assert.equal(snap.status, 'auth-failed', 'a normal close does not mean the key is fine');
  assert.equal(snap.nextAttemptAt - h.time.wall, AIS_WATCHDOG_DEFAULTS.authProbeMs);
});

test('a probe TRANSPORT ERROR keeps auth-failed at the hourly cadence', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'auth', message: 'AISStream rejected the API key (HTTP 401)' });
  h.advance(AIS_WATCHDOG_DEFAULTS.authProbeMs);
  h.tick();

  h.fail(h.watchdog.debugState().owned, { kind: 'transport', message: 'ECONNRESET' });

  const snap = h.snapshot();
  assert.equal(snap.status, 'auth-failed');
  assert.equal(snap.nextAttemptAt - h.time.wall, AIS_WATCHDOG_DEFAULTS.authProbeMs);
  assert.match(snap.error, /rejected the API key/,
    'the chip keeps pointing at the key, not at the network');
});

test('a probe RATE LIMIT keeps auth-failed at the hourly cadence', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'auth' });
  h.advance(AIS_WATCHDOG_DEFAULTS.authProbeMs);
  h.tick();

  h.fail(h.watchdog.debugState().owned, { kind: 'rate-limit', retryAfterMs: 5_000 });

  assert.equal(h.snapshot().status, 'auth-failed');
  assert.equal(h.snapshot().nextAttemptAt - h.time.wall, AIS_WATCHDOG_DEFAULTS.authProbeMs);
});

test('ticking past staleMs must not relabel an auth-failed probe', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'auth' });
  h.advance(AIS_WATCHDOG_DEFAULTS.authProbeMs);
  h.tick(); // hourly probe opens; it will never speak

  // Tick right through the stale threshold and the silent-recycle threshold.
  for (let second = 0; second < 400; second += 1) {
    h.advance(1_000);
    h.tick();
  }
  assert.ok(400_000 > AIS_WATCHDOG_DEFAULTS.recycleAfterMs, 'window covers both thresholds');
  assert.equal(h.snapshot().status, 'auth-failed', 'time alone must not relabel the state');
});

test('a probe outcome AFTER the stale window still keeps the hourly cadence', () => {
  // The exact laundering path: tick past staleMs so the old code would have
  // flipped the state to 'stale', THEN inject the outcome. From 'stale' the
  // auth coercion in scheduleRetry would no longer match.
  for (const outcome of ['close', 'transport', 'rate-limit']) {
    const h = goLive(harness());
    h.fail(1, { kind: 'auth', message: 'AISStream rejected the API key (HTTP 401)' });
    h.advance(AIS_WATCHDOG_DEFAULTS.authProbeMs);
    h.tick();
    const probe = h.watchdog.debugState().owned;

    for (let second = 0; second < 200; second += 1) { // past staleMs (120s)
      h.advance(1_000);
      h.tick();
    }
    assert.equal(h.snapshot().status, 'auth-failed', `${outcome}: still terminal before the outcome`);

    if (outcome === 'close') h.close(probe);
    else h.fail(probe, { kind: outcome });

    const snap = h.snapshot();
    assert.equal(snap.status, 'auth-failed', `${outcome} after the stale window must stay terminal`);
    assert.equal(
      snap.nextAttemptAt - h.time.wall, AIS_WATCHDOG_DEFAULTS.authProbeMs,
      `${outcome} after the stale window must keep the hourly cadence`,
    );
  }
});

test('a silent probe is recycled on the auth cadence, never the silence budget', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'auth' });
  h.advance(AIS_WATCHDOG_DEFAULTS.authProbeMs);
  h.tick();
  const before = h.types().length;

  // The silence budget would have recycled at 300s; the auth cadence must not.
  h.advance(AIS_WATCHDOG_DEFAULTS.recycleAfterMs + 1_000);
  h.tick();
  assert.equal(h.types().length, before, 'the silence budget does not apply while auth-failed');
  assert.equal(h.snapshot().status, 'auth-failed');

  // It IS bounded, though — the probe is hung up on the auth cadence.
  h.advance(AIS_WATCHDOG_DEFAULTS.authProbeMs);
  h.tick();
  assert.equal(h.types().length, before + 1, 'the probe is still terminated, on its own clock');
  assert.equal(h.watchdog.debugState().owned, null);
  assert.equal(h.snapshot().status, 'auth-failed');
});

test('every probe outcome costs at most one attempt per hour', () => {
  // Cycle through close / transport error / rate limit / silence in turn; an
  // unproven key must never buy more than the hourly probe.
  for (const outcome of ['close', 'transport', 'rate-limit', 'silence']) {
    const h = goLive(harness());
    h.fail(1, { kind: 'auth' });
    let connects = 0;

    for (let second = 0; second <= 3600; second += 1) {
      for (const action of h.tick()) {
        if (action.type !== 'connect') continue;
        connects += 1;
        if (outcome === 'close') h.close(action.generation);
        else if (outcome === 'transport') h.fail(action.generation, { kind: 'transport' });
        else if (outcome === 'rate-limit') h.fail(action.generation, { kind: 'rate-limit' });
        // 'silence' simply never responds.
      }
      h.advance(1_000);
    }
    assert.ok(connects <= 1, `${outcome}: ${connects} probes in an hour`);
    assert.equal(h.snapshot().status, 'auth-failed', `${outcome} must stay terminal`);
  }
});

test('an unchanged key does not clear the terminal auth state', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'auth' });
  const before = h.types().length;

  h.configure(LIVE_ENV); // same fingerprint
  h.tick();
  assert.equal(h.snapshot().status, 'auth-failed');
  assert.equal(h.types().length, before, 'no attempt while the same key is being refused');
});

test('a rate limit honours Retry-After', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'rate-limit', message: '429', retryAfterMs: 120_000 });

  const snap = h.snapshot();
  assert.equal(snap.status, 'reconnecting');
  assert.equal(snap.nextAttemptAt - h.time.wall, 120_000, "the server's own pacing wins");
});

test('a rate limit without Retry-After enters at the SLOWEST rung', () => {
  const h = goLive(harness());
  h.fail(1, { kind: 'rate-limit', message: '429' });

  const slowest = AIS_WATCHDOG_DEFAULTS.backoffMs[AIS_WATCHDOG_DEFAULTS.backoffMs.length - 1];
  assert.equal(h.snapshot().nextAttemptAt - h.time.wall, slowest);
  assert.notEqual(h.snapshot().nextAttemptAt - h.time.wall, AIS_WATCHDOG_DEFAULTS.backoffMs[0]);
});

// --- Worst-case connection rate, per failure class -------------------------

/**
 * Simulate an hour of unbroken failure with the watchdog ticked once a second
 * — far more often than either the 15s interval or the 60s browser poll — and
 * count connection attempts. Steady-state failure must cost single digits.
 */
function attemptsPerHour(kind, detail = {}) {
  const h = harness();
  h.configure();
  let connects = 0;
  for (let second = 0; second <= 3600; second += 1) {
    for (const action of h.tick()) {
      if (action.type !== 'connect') continue;
      connects += 1;
      h.fail(action.generation, { kind, ...detail });
    }
    h.advance(1_000);
  }
  return connects;
}

test('worst-case attempt rate is single digits per hour in every failure class', () => {
  const transport = attemptsPerHour('transport');
  const auth = attemptsPerHour('auth');
  const rateLimit = attemptsPerHour('rate-limit');

  // The reverted design's fixed 5s loop would be 720/hour here.
  assert.ok(transport < 10, `transport: ${transport} attempts/hour`);
  assert.ok(auth <= 2, `auth: ${auth} attempts/hour`);
  assert.ok(rateLimit < 10, `rate-limit: ${rateLimit} attempts/hour`);

  // Pin the exact figures so a budget change has to be deliberate.
  assert.equal(transport, 8);
  assert.equal(auth, 2);
  assert.equal(rateLimit, 5);
});

test('a silent-socket recycle loop also stays in single digits per hour', () => {
  const h = harness();
  h.configure();
  let connects = 0;
  for (let second = 0; second <= 3600; second += 1) {
    for (const action of h.tick()) {
      if (action.type === 'connect') connects += 1; // then simply never speaks
    }
    h.advance(1_000);
  }
  assert.ok(connects < 10, `silent-recycle: ${connects} attempts/hour`);
  // Pinned exactly, like the other classes, so a budget change is deliberate.
  assert.equal(connects, 6);
});

// --- Remaining policy ------------------------------------------------------

test('a custom subscription disarms the silence watch instead of recycling forever', () => {
  const h = harness();
  h.configure({ hasKey: true, hasTransport: true, silenceWatch: false, keyFingerprint: 'key-a' });
  h.tick();
  h.open(1);
  h.message(1);

  h.advance(AIS_WATCHDOG_DEFAULTS.recycleAfterMs * 4);
  h.tick();

  assert.deepEqual(h.types(), ['connect:1'], 'a legitimately quiet filter is never recycled');
  assert.equal(h.snapshot().watchdog, 'custom-subscription-off');
});

test('dispose terminates the live socket and resets the ladder', () => {
  const h = goLive(harness());
  h.advance(AIS_WATCHDOG_DEFAULTS.recycleAfterMs + 1);
  h.tick();
  h.advance(6_000);
  h.tick();

  assert.deepEqual(h.dispose(), [{ type: 'terminate', generation: 2, reason: 'dispose' }]);
  assert.equal(h.openSockets.size, 0);
  assert.equal(h.snapshot().status, 'idle');
  assert.equal(h.snapshot().reconnectAttempt, 0);
});

test('dispose on an idle watchdog is a no-op', () => {
  const h = harness();
  h.configure({ hasKey: false });
  assert.deepEqual(h.dispose(), []);
});

test('snapshot exposes the honest fields the browser chip needs', () => {
  const h = goLive(harness());
  h.advance(AIS_WATCHDOG_DEFAULTS.recycleAfterMs + 1);
  h.tick();

  const snap = h.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), [
    'error',
    'lastMessageAt',
    'nextAttemptAt',
    'reconnectAttempt',
    'silentForMs',
    'staleAfterMs',
    'status',
    'watchdog',
  ]);
  assert.equal(snap.staleAfterMs, AIS_WATCHDOG_DEFAULTS.staleMs);
  assert.ok(snap.nextAttemptAt > h.time.wall);
});

// --- FINDING 7: the silence override is parsed strictly -------------------

test('an empty or unparseable silence override never silently disables the watchdog', () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);

  // The dangerous cases: Number('') and Number('  ') are both 0, which under a
  // loose parse would read as the kill switch and mute the whole feature.
  assert.deepEqual(parseSilenceTimeoutEnv('', warn), { kind: 'default' });
  assert.deepEqual(parseSilenceTimeoutEnv('   ', warn), { kind: 'default' });
  assert.deepEqual(parseSilenceTimeoutEnv(undefined, warn), { kind: 'default' });
  assert.deepEqual(parseSilenceTimeoutEnv(null, warn), { kind: 'default' });
  assert.equal(warnings.length, 0, 'an absent value is normal, not worth warning about');

  assert.deepEqual(parseSilenceTimeoutEnv('abc', warn), { kind: 'default' });
  assert.deepEqual(parseSilenceTimeoutEnv('-5', warn), { kind: 'default' });
  assert.deepEqual(parseSilenceTimeoutEnv('12s', warn), { kind: 'default' });
  assert.equal(warnings.length, 3, 'each bad value says so exactly once');
  assert.match(warnings[0], /Ignoring AISSTREAM_SILENCE_TIMEOUT_MS="abc"/);
});

test('only a literal zero is the documented kill switch', () => {
  assert.deepEqual(parseSilenceTimeoutEnv('0'), { kind: 'off' });
  assert.deepEqual(parseSilenceTimeoutEnv(0), { kind: 'off' });
  assert.deepEqual(parseSilenceTimeoutEnv('90000'), { kind: 'timeout', value: 90_000 });
  assert.deepEqual(parseSilenceTimeoutEnv(' 90000 '), { kind: 'timeout', value: 90_000 });
});

test('recycleAfterMs can never be tuned below staleMs', () => {
  const time = fakeClock();
  const watchdog = createAisWatchdog({ staleMs: 60_000, recycleAfterMs: 1_000, clock: time.clock });
  watchdog.configure(LIVE_ENV);
  watchdog.tick();
  watchdog.onMessage(1);

  time.advance(30_000);
  assert.deepEqual(watchdog.tick(), []);
  time.advance(31_000);
  assert.deepEqual(watchdog.tick().map((a) => a.type), ['terminate']);
});
