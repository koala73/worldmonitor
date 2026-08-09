import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  AVIATION_MIN_SERVED_COVERAGE,
  RSS_MIN_SERVED_COVERAGE,
  classifyUpstreamOutcome,
  nextBackoffMs,
  summarizeServedCoverage,
} from '../scripts/_ingestion-coverage.cjs';

test('relay outcome classes keep throttling and auth separate from faults', () => {
  assert.equal(classifyUpstreamOutcome({ status: 200 }), 'success');
  assert.equal(classifyUpstreamOutcome({ status: 429 }), 'throttle');
  assert.equal(classifyUpstreamOutcome({ status: 401 }), 'authRejection');
  assert.equal(classifyUpstreamOutcome({ status: 504 }), 'timeout');
  assert.equal(classifyUpstreamOutcome({ status: 502 }), 'terminalFailure');
  assert.equal(classifyUpstreamOutcome({ error: { name: 'TimeoutError' } }), 'timeout');
  assert.equal(classifyUpstreamOutcome({ error: new Error('socket timed out') }), 'timeout');
  assert.equal(classifyUpstreamOutcome({ status: 204 }), 'success');
  assert.equal(classifyUpstreamOutcome({ status: 0 }), 'terminalFailure');
});

test('served coverage degrades below the fixed aviation/RSS floors and recovers at the floor', () => {
  assert.equal(
    summarizeServedCoverage({ requests: 10, served: 4, minimum: AVIATION_MIN_SERVED_COVERAGE }).status,
    'degraded',
  );
  assert.equal(
    summarizeServedCoverage({ requests: 10, served: 5, minimum: AVIATION_MIN_SERVED_COVERAGE }).status,
    'ok',
  );
  assert.equal(
    summarizeServedCoverage({ requests: 10, served: 6, minimum: RSS_MIN_SERVED_COVERAGE }).status,
    'degraded',
  );
  assert.equal(
    summarizeServedCoverage({ requests: 10, served: 7, minimum: RSS_MIN_SERVED_COVERAGE }).status,
    'ok',
  );
});

test('RSS backoff is exponential with jitter but capped so fallback exhaustion stops retry growth', () => {
  const delays = [0, 1, 2, 3, 4, 5].map((failures) => nextBackoffMs(failures, 60_000, 900_000));
  // Each delay is deterministic-base ±25% jitter, capped at maxMs.
  assert.ok(delays[0] >= 45_000 && delays[0] <= 75_000, `delay[0]=${delays[0]} out of range`);
  assert.ok(delays[1] >= 90_000 && delays[1] <= 150_000, `delay[1]=${delays[1]} out of range`);
  assert.ok(delays[2] >= 180_000 && delays[2] <= 300_000, `delay[2]=${delays[2]} out of range`);
  assert.ok(delays[3] >= 360_000 && delays[3] <= 600_000, `delay[3]=${delays[3]} out of range`);
  // Jittered values at cap may be below maxMs, but never exceed it.
  assert.ok(delays[4] >= 675_000 && delays[4] <= 900_000, `delay[4]=${delays[4]} out of range (capped)`);
  assert.ok(delays[5] >= 675_000 && delays[5] <= 900_000, `delay[5]=${delays[5]} out of range (capped)`);
  assert.ok(nextBackoffMs(100, 60_000, 900_000) >= 675_000 && nextBackoffMs(100, 60_000, 900_000) <= 900_000);
});

test('served coverage is bounded and remains explicit when no request was observed', () => {
  assert.deepEqual(
    summarizeServedCoverage({ requests: 0, served: 10, minimum: 0.5 }),
    { requests: 0, served: 0, servedCoverage: null, minimumCoverage: 0.5, status: 'not_observed' },
  );
  assert.deepEqual(
    summarizeServedCoverage({ requests: 3.9, served: 10, minimum: 2 }),
    { requests: 3, served: 3, servedCoverage: 1, minimumCoverage: 1, status: 'ok' },
  );
  assert.equal(summarizeServedCoverage({ requests: 1, served: -2, minimum: 0.5 }).status, 'degraded');
});
