import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AIS_FAILURE_KINDS,
  aisSilenceVerdict,
  classifyAisFailure,
  createAisReconnectPolicy,
  createSocketOwnership,
  parseAisEnvNumber,
} from '../shared/ais-watchdog.js';

// A controllable clock. `wall` is deliberately able to move backwards (an NTP
// step, or a suspend/resume) while `mono` only ever advances — that asymmetry is
// the whole reason the policy measures durations monotonically.
function makeClock() {
  let mono = 100_000;
  let wall = 1_700_000_000_000;
  return {
    mono: () => mono,
    wall: () => wall,
    advance(ms) {
      mono += ms;
      wall += ms;
    },
    stepWall(ms) {
      wall += ms;
    },
  };
}

test('classifyAisFailure separates throttles, auth rejections and transport faults', () => {
  assert.deepEqual(
    classifyAisFailure({ statusCode: 429 }).kind,
    'rate-limit',
  );
  assert.equal(classifyAisFailure({ statusCode: 429 }).label, 'http_429');
  assert.equal(
    classifyAisFailure({ message: 'Unexpected server response: 429' }).kind,
    'rate-limit',
  );

  assert.equal(classifyAisFailure({ statusCode: 401 }).kind, 'auth');
  assert.equal(classifyAisFailure({ statusCode: 403 }).kind, 'auth');
  assert.equal(classifyAisFailure({ message: 'invalid api key' }).kind, 'auth');
  assert.equal(classifyAisFailure({ message: 'Api Key Is Not Valid' }).kind, 'auth');
  assert.equal(classifyAisFailure({ message: 'Invalid bounding box' }).kind, 'transport');
  assert.equal(classifyAisFailure({ message: 'Unauthorized' }).kind, 'auth');
  assert.equal(classifyAisFailure({ message: 'authentication failed' }).kind, 'auth');
  assert.equal(
    classifyAisFailure({ message: 'invalid api key' }).label,
    'auth_rejected',
  );

  assert.deepEqual(
    classifyAisFailure({ positionTimedOut: true }),
    { kind: 'transport', label: 'position_timeout', retryAfterMs: null },
  );
  assert.equal(classifyAisFailure({ servedData: true }).label, 'disconnected');
  assert.equal(classifyAisFailure({ message: 'socket hang up' }).label, 'connection_error');

  // A throttle wins over auth wording: the provider is telling us to slow down,
  // and misreading that as a credential problem would park the feed for an hour.
  assert.equal(
    classifyAisFailure({ statusCode: 429, message: 'invalid api key' }).kind,
    'rate-limit',
  );

  // The numeric auth forms are word-bounded on purpose: a port or a latency
  // figure inside a transport message must not impersonate an auth rejection.
  assert.equal(
    classifyAisFailure({ message: 'connect ECONNREFUSED 127.0.0.1:40123' }).kind,
    'transport',
  );
  assert.equal(classifyAisFailure({ message: 'timeout after 4290ms' }).kind, 'transport');
});

test('classifyAisFailure keeps a positive Retry-After and drops an unusable one', () => {
  assert.equal(classifyAisFailure({ statusCode: 429, retryAfterMs: 12_345 }).retryAfterMs, 12_345);
  assert.equal(classifyAisFailure({ statusCode: 429, retryAfterMs: 0 }).retryAfterMs, null);
  assert.equal(classifyAisFailure({ statusCode: 429, retryAfterMs: -5 }).retryAfterMs, null);
  assert.equal(classifyAisFailure({ statusCode: 429, retryAfterMs: Number.NaN }).retryAfterMs, null);
});

test('AIS_FAILURE_KINDS is the closed set the policy understands', () => {
  assert.deepEqual([...AIS_FAILURE_KINDS], ['transport', 'auth', 'rate-limit']);
});

test('parseAisEnvNumber rejects the values that coerce to a dangerous 0', () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  const opts = { fallback: 300_000, min: 1_000, label: 'AIS_POSITION_FRESHNESS_MS', warn };

  // Absent: default, silently.
  assert.deepEqual(parseAisEnvNumber(undefined, opts), { value: 300_000, source: 'default' });
  assert.deepEqual(parseAisEnvNumber(null, opts), { value: 300_000, source: 'default' });

  // Present-but-empty and whitespace: the self-hiding failure. `Number('')` is 0,
  // and a floor of 1000 applied to 0 becomes 1000ms — a reconnect storm.
  assert.deepEqual(parseAisEnvNumber('', opts), { value: 300_000, source: 'default' });
  assert.deepEqual(parseAisEnvNumber('   ', opts), { value: 300_000, source: 'default' });
  assert.deepEqual(parseAisEnvNumber('abc', opts), { value: 300_000, source: 'default' });

  // Every rejected value says so, rather than silently defaulting.
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /AIS_POSITION_FRESHNESS_MS=""/);
  assert.match(warnings[1], /not a non-negative number/);

  // A literal 0 is accepted and then floored — there is no way to disable the
  // freshness budget by accident through this knob.
  assert.deepEqual(parseAisEnvNumber('0', opts), { value: 1_000, source: 'env' });
  assert.deepEqual(parseAisEnvNumber('2500', opts), { value: 2_500, source: 'env' });
  assert.deepEqual(parseAisEnvNumber(2_000, opts), { value: 2_000, source: 'env' });
  assert.deepEqual(parseAisEnvNumber('3000.7', opts), { value: 3_000, source: 'env' });
  assert.deepEqual(parseAisEnvNumber(' 1500 ', { fallback: 1 }), { value: 1_500, source: 'env' });
});

test('transport failures walk the injected ladder against the ordinary ceiling', () => {
  const clock = makeClock();
  const seen = [];
  const policy = createAisReconnectPolicy({
    ladder: (attempts, ceilingMs) => {
      seen.push([attempts, ceilingMs]);
      return 1_000;
    },
    maxMs: 300_000,
    throttleCeilingMs: 900_000,
    escalateAfter: 3,
    clock,
  });

  const result = policy.onFailure('transport');
  assert.deepEqual(seen, [[1, 300_000]]);
  assert.equal(result.delayMs, 1_000);
  assert.equal(result.terminal, false);
  assert.equal(result.status, 'reconnecting');
  assert.equal(policy.snapshot().remainingMs, 1_000);
});

test('a Retry-After is honoured, and the escalated ceiling is a floor over it', () => {
  const clock = makeClock();
  const policy = createAisReconnectPolicy({
    ladder: () => 1_000,
    maxMs: 300_000,
    throttleCeilingMs: 600_000,
    escalateAfter: 2,
    clock,
  });

  // Below the escalation threshold: the server's own number is used verbatim.
  assert.equal(policy.onFailure('rate-limit', { retryAfterMs: 45_000 }).delayMs, 45_000);
  assert.equal(policy.snapshot().consecutiveThrottles, 1);

  policy.onThrottle(); // second 429 => escalation engages at escalateAfter=2
  assert.equal(policy.snapshot().escalated, true);

  // A short Retry-After must not undercut the block we are waiting out.
  assert.equal(policy.onFailure('rate-limit', { retryAfterMs: 1_000 }).delayMs, 600_000);
});

test('a throttle ceiling configured below the ordinary one is clamped up', () => {
  const ceilings = [];
  const policy = createAisReconnectPolicy({
    // Records the cap it was handed, which is where the clamp becomes observable:
    // with no Retry-After the ladder owns the timing and only its cap changes.
    ladder: (_attempts, ceilingMs) => {
      ceilings.push(ceilingMs);
      return 5;
    },
    maxMs: 2_000,
    // Misconfigured BELOW the ordinary ceiling: escalation must clamp up rather
    // than reconnect faster while throttled.
    throttleCeilingMs: 100,
    escalateAfter: 1,
    clock: makeClock(),
  });

  // escalateAfter=1, so this first 429 is already escalated.
  assert.equal(policy.onFailure('rate-limit').delayMs, 5);
  assert.deepEqual(ceilings, [2_000], 'the throttle ceiling must clamp up to the ordinary one');
});

test('without a Retry-After the ladder still owns the timing after escalation', () => {
  const policy = createAisReconnectPolicy({
    ladder: () => 400,
    maxMs: 2_000,
    throttleCeilingMs: 60_000,
    escalateAfter: 1,
    clock: makeClock(),
  });

  // Escalated on the first 429, but the ladder says 400ms. Escalation raises the
  // CAP; it must not teleport to it, or a sustained throttle would idle the feed
  // for the full ceiling on the very first escalated attempt.
  assert.equal(policy.onFailure('rate-limit').delayMs, 400);
  // A server hint, however, cannot undercut the escalated ceiling.
  assert.equal(policy.onFailure('rate-limit', { retryAfterMs: 1_000 }).delayMs, 60_000);
});

test('an auth rejection is terminal and sticky against every other failure class', () => {
  const clock = makeClock();
  const policy = createAisReconnectPolicy({
    ladder: () => 1_000,
    maxMs: 300_000,
    throttleCeilingMs: 600_000,
    escalateAfter: 3,
    authProbeMs: 3_600_000,
    clock,
  });

  const rejected = policy.onFailure('auth');
  assert.equal(rejected.terminal, true);
  assert.equal(rejected.status, 'auth-failed');
  assert.equal(rejected.delayMs, 3_600_000);

  clock.advance(3_600_000);
  assert.equal(policy.snapshot().remainingMs, 0);

  // A probe that dies for ANY reason still leaves the credential unproven, so no
  // other class may launder the feed back onto the fast ladder.
  for (const kind of ['transport', 'rate-limit', 'transport']) {
    const retried = policy.onFailure(kind, { retryAfterMs: 1 });
    assert.equal(retried.status, 'auth-failed', `${kind} must not clear auth-failed`);
    assert.equal(retried.delayMs, 3_600_000, `${kind} must keep the slow probe cadence`);
    assert.equal(retried.terminal, true);
  }

  // Only valid data or a credential change leaves it.
  policy.onAcceptedFrame();
  assert.equal(policy.snapshot().status, 'idle');
  assert.equal(policy.onFailure('transport').status, 'reconnecting');

  policy.onFailure('auth');
  policy.onCredentialChanged();
  assert.equal(policy.snapshot().status, 'idle');
  assert.equal(policy.onFailure('transport').status, 'reconnecting');
});

test('an accepted frame clears the ladder and the throttle escalation', () => {
  const policy = createAisReconnectPolicy({
    ladder: () => 1_000,
    maxMs: 300_000,
    throttleCeilingMs: 600_000,
    escalateAfter: 2,
    clock: makeClock(),
  });

  policy.onFailure('rate-limit', { retryAfterMs: 1_000 });
  policy.onThrottle();
  policy.onThrottle();
  assert.equal(policy.snapshot().escalated, true);
  assert.equal(policy.snapshot().attempts, 1);

  policy.onAcceptedFrame();
  const cleared = policy.snapshot();
  assert.equal(cleared.escalated, false);
  assert.equal(cleared.attempts, 0);
  assert.equal(cleared.consecutiveThrottles, 0);
  assert.equal(cleared.remainingMs, 0);
});

test('a clean close clears the escalation; a non-throttle outcome does too', () => {
  const policy = createAisReconnectPolicy({
    ladder: () => 1_000,
    maxMs: 300_000,
    throttleCeilingMs: 600_000,
    escalateAfter: 1,
    clock: makeClock(),
  });

  policy.onThrottle();
  assert.equal(policy.snapshot().escalated, true);
  policy.onCleanClose();
  assert.equal(policy.snapshot().escalated, false);
  assert.equal(policy.snapshot().consecutiveThrottles, 0);

  policy.onThrottle();
  assert.equal(policy.snapshot().escalated, true);
  policy.onNonThrottleOutcome();
  assert.equal(policy.snapshot().escalated, false);
});

test('durations are monotonic: a backwards wall-clock step cannot extend the wait', () => {
  const clock = makeClock();
  const policy = createAisReconnectPolicy({
    ladder: () => 60_000,
    maxMs: 300_000,
    throttleCeilingMs: 600_000,
    escalateAfter: 5,
    clock,
  });

  policy.onFailure('transport');
  assert.equal(policy.snapshot().remainingMs, 60_000);

  // An NTP step backwards must not inflate the remaining wait...
  clock.stepWall(-3_600_000);
  assert.equal(policy.snapshot().remainingMs, 60_000);
  // ...and must not report a deadline in the past for a wait that is still live.
  assert.ok(policy.snapshot().nextAttemptAt > clock.wall() - 3_600_000);

  // Real elapsed time still counts down.
  clock.advance(59_000);
  assert.equal(policy.snapshot().remainingMs, 1_000);
  clock.advance(1_000);
  assert.equal(policy.snapshot().remainingMs, 0);
});

test('aisSilenceVerdict reports stale before it recycles, and recycles even with no stale budget', () => {
  const staleMs = 120_000;
  const recycleAfterMs = 300_000;
  assert.equal(aisSilenceVerdict({ silentForMs: 0, staleMs, recycleAfterMs }), 'live');
  assert.equal(aisSilenceVerdict({ silentForMs: 119_999, staleMs, recycleAfterMs }), 'live');
  assert.equal(aisSilenceVerdict({ silentForMs: 120_000, staleMs, recycleAfterMs }), 'stale');
  assert.equal(aisSilenceVerdict({ silentForMs: 299_999, staleMs, recycleAfterMs }), 'stale');
  assert.equal(aisSilenceVerdict({ silentForMs: 300_000, staleMs, recycleAfterMs }), 'recycle');
  // A recycle budget always wins when both thresholds are crossed at once.
  assert.equal(
    aisSilenceVerdict({ silentForMs: 900_000, staleMs: 1_000, recycleAfterMs: 2_000 }),
    'recycle',
  );
  // Zero (unset) thresholds never fire.
  assert.equal(aisSilenceVerdict({ silentForMs: 1e9, staleMs: 0, recycleAfterMs: 0 }), 'live');
  // A negative or unparsable silence reads as live rather than instant staleness.
  assert.equal(aisSilenceVerdict({ silentForMs: -1, staleMs, recycleAfterMs }), 'live');
  assert.equal(aisSilenceVerdict({ silentForMs: Number.NaN, staleMs, recycleAfterMs }), 'live');
});

test('socket ownership orphans a late event and never re-issues a generation', () => {
  const ownership = createSocketOwnership();

  const first = ownership.issue();
  const second = ownership.issue();
  assert.equal(first, 1);
  assert.equal(second, 2);

  // A late event from the socket we already gave up on is an orphan: the caller
  // must be able to tell, so it can hang that socket up instead of letting it
  // hold the one-connection-per-key slot.
  assert.equal(ownership.owns(first), false);
  assert.equal(ownership.owns(second), true);

  ownership.release();
  assert.equal(ownership.owns(second), false);

  const third = ownership.issue();
  assert.equal(third, 3, 'generations only ever increase');
  assert.equal(ownership.highWater(), 3);
  assert.deepEqual(ownership.debug(), { owned: 3, generation: 3 });

  // A replacement tracker seeded from the high-water mark cannot collide with a
  // late handler still referring to an older generation.
  const replacement = createSocketOwnership();
  assert.equal(replacement.highWater(), 0);
  assert.equal(replacement.issue(), 1);
  assert.equal(ownership.highWater(), 3);
});
