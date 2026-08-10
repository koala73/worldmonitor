/**
 * Backoff for viewport-triggered panel priming (#4487).
 *
 * `primeVisiblePanelData` records a key as primed only on RESOLVE, so a rejected
 * loader leaves no record and — because the pass runs from a scroll handler's
 * rAF — re-enters on every scroll frame forever. The in-flight guard bounds that
 * by request latency, which makes a SLOW failure self-limiting and a FAST one
 * (adblock, CORS, DNS, premium 403) unbounded. That is the field-common case and
 * the one absent from a lab run with healthy endpoints.
 *
 * These pin the delay schedule, and specifically that no input can produce a
 * zero/negative delay — a delay of 0 restores the per-frame loop this prevents.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  nextPrimeRetryDelayMs,
  PRIME_RETRY_BASE_MS,
  PRIME_RETRY_MAX_MS,
} from '../src/utils/prime-retry.ts';

test('first failure waits the base delay', () => {
  assert.equal(nextPrimeRetryDelayMs(1), PRIME_RETRY_BASE_MS);
});

test('delay doubles per consecutive failure', () => {
  assert.equal(nextPrimeRetryDelayMs(2), PRIME_RETRY_BASE_MS * 2);
  assert.equal(nextPrimeRetryDelayMs(3), PRIME_RETRY_BASE_MS * 4);
});

test('delay saturates at the ceiling instead of growing without bound', () => {
  assert.equal(nextPrimeRetryDelayMs(20), PRIME_RETRY_MAX_MS);
  assert.equal(nextPrimeRetryDelayMs(1000), PRIME_RETRY_MAX_MS);
});

test('a huge counter still yields a finite, positive delay', () => {
  // `2 ** 1024` saturates to Infinity rather than wrapping, so Math.min already
  // returns the ceiling — this pins that end of the schedule rather than
  // guarding an overflow JS cannot produce.
  for (const failures of [1024, 4096, Number.MAX_SAFE_INTEGER]) {
    const delay = nextPrimeRetryDelayMs(failures);
    assert.ok(Number.isFinite(delay), `delay must be finite for ${failures}`);
    assert.ok(delay > 0, `delay must be positive for ${failures}`);
    assert.equal(delay, PRIME_RETRY_MAX_MS);
  }
});

test('corrupt counters fall back to the base delay, never to zero', () => {
  for (const failures of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const delay = nextPrimeRetryDelayMs(failures);
    assert.ok(delay > 0, `delay must be positive for ${String(failures)}`);
    assert.ok(delay <= PRIME_RETRY_MAX_MS);
  }
  assert.equal(nextPrimeRetryDelayMs(0), PRIME_RETRY_BASE_MS);
  assert.equal(nextPrimeRetryDelayMs(Number.NaN), PRIME_RETRY_BASE_MS);
});

test('every delay in the schedule stays within the documented bounds', () => {
  for (let failures = 1; failures <= 50; failures++) {
    const delay = nextPrimeRetryDelayMs(failures);
    assert.ok(
      delay >= PRIME_RETRY_BASE_MS && delay <= PRIME_RETRY_MAX_MS,
      `failure ${failures} produced out-of-range delay ${delay}`,
    );
  }
});
