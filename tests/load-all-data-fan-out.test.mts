import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_QUIESCENCE_TIMEOUT_MS } from '../e2e/helpers/hydration-request-quiescence';
import {
  REPEAT_FAN_OUT_DRAIN_TIMEOUT_MS,
  REPEAT_FAN_OUT_START_TIMEOUT_MS,
  waitForLoadAllDataFanOut,
} from '../e2e/helpers/load-all-data-fan-out';

const clock = {
  waitForTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

test('drain budget is independent of and longer than the start budget', () => {
  assert.equal(REPEAT_FAN_OUT_START_TIMEOUT_MS, DEFAULT_QUIESCENCE_TIMEOUT_MS);
  assert.equal(REPEAT_FAN_OUT_DRAIN_TIMEOUT_MS, 20_000);
  assert.ok(REPEAT_FAN_OUT_DRAIN_TIMEOUT_MS > REPEAT_FAN_OUT_START_TIMEOUT_MS);
});

test('drain wait survives past the start timeout once START has been observed', async () => {
  const marks = { start: 1, end: 1 };
  const pending = waitForLoadAllDataFanOut(clock, () => marks, { start: 1, end: 1 }, {
    message: 'fan-out missed',
    startTimeoutMs: 40,
    drainTimeoutMs: 200,
    pollMs: 10,
  });
  marks.start = 2;
  // Land END after the start budget would have expired if it were reused for drain.
  // CI: variant-smoke-full job 99074126316 observed START++ then END stuck for 6s.
  setTimeout(() => {
    marks.end = 2;
  }, 80);

  await pending;
});

test('fails when START never arrives, without waiting the drain budget', async () => {
  const marks = { start: 1, end: 1 };
  const started = Date.now();
  await assert.rejects(
    waitForLoadAllDataFanOut(clock, () => marks, { start: 1, end: 1 }, {
      message: 'no second fan-out',
      startTimeoutMs: 50,
      drainTimeoutMs: 5_000,
      pollMs: 10,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'no second fan-out');
      return true;
    },
  );
  assert.ok(
    Date.now() - started < 1_000,
    'must not wait the drain budget when START never fires',
  );
});

test('fails when START fires but END never drains', async () => {
  const marks = { start: 1, end: 1 };
  marks.start = 2;
  await assert.rejects(
    waitForLoadAllDataFanOut(clock, () => marks, { start: 1, end: 1 }, {
      message: 'no second fan-out',
      startTimeoutMs: 50,
      drainTimeoutMs: 60,
      pollMs: 10,
    }),
    /no second fan-out \(fan-out did not drain\)/,
  );
});

test('requires the matching END for the observed START, not a stale prior drain', async () => {
  // START already jumped to 3; END=2 is > marksBefore.end so a drain window that
  // only checked `end > before.end` would go green while the observed pass is
  // still in flight.
  const marks = { start: 3, end: 2 };
  await assert.rejects(
    waitForLoadAllDataFanOut(clock, () => marks, { start: 1, end: 1 }, {
      message: 'stale end',
      startTimeoutMs: 40,
      drainTimeoutMs: 50,
      pollMs: 10,
    }),
    /stale end \(fan-out did not drain\)/,
  );
});

test('waits for the matching END when an earlier iteration drained first', async () => {
  const marks = { start: 3, end: 2 };
  const pending = waitForLoadAllDataFanOut(clock, () => marks, { start: 1, end: 1 }, {
    message: 'partial drain',
    startTimeoutMs: 40,
    drainTimeoutMs: 200,
    pollMs: 10,
  });
  setTimeout(() => {
    marks.end = 3;
  }, 30);
  await pending;
});
