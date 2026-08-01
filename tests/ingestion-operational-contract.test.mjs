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

test('RSS backoff is exponential but capped so fallback exhaustion stops retry growth', () => {
  const delays = [0, 1, 2, 3, 4, 5].map((failures) => nextBackoffMs(failures, 60_000, 900_000));
  assert.deepEqual(delays, [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  assert.equal(nextBackoffMs(100, 60_000, 900_000), 900_000);
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
