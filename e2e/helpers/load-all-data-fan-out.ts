/**
 * Wait for a second `runLoadAllData` fan-out to start and drain.
 *
 * START and END are different events with different budgets. A missed trigger
 * should fail fast; an in-flight fan-out must be allowed to finish.
 *
 * CI evidence for the split (do not collapse drain back onto the 6s start
 * window):
 * - PR job https://github.com/koala73/worldmonitor/actions/runs/33242503567/job/99074126316
 *   (`variant-smoke-full`, mobile uncacheable arm): START increased, then END
 *   stayed put for 6000ms on both attempts (`Expected > 4, Received 4` then
 *   `Expected > 5, Received 5`).
 * - origin/main run 33234453375: the same test was Playwright-flaky (failed,
 *   then passed on retry).
 *
 * Root cause: `hydrate: false` plus `uncacheableFallbacks` makes every loader
 * in `runLoadAllData` actually fetch. `variant-smoke-full` runs 4 Playwright
 * workers. Once START has fired the fan-out is real — a 6s drain window
 * misreads "still in flight" as "never drained".
 */

import { DEFAULT_QUIESCENCE_TIMEOUT_MS } from './hydration-request-quiescence';

/** Mark data-loader emits around `runLoadAllData` — proves a fan-out ran. */
export const LOAD_ALL_DATA_START_MARK = 'wm:data:load-all-start';
/** Matching drain mark; emitted in `finally` after the fan-out awaits. */
export const LOAD_ALL_DATA_END_MARK = 'wm:data:load-all-end';

/** Wait for the repeat fan-out to start. Matches the former combined settle window. */
export const REPEAT_FAN_OUT_START_TIMEOUT_MS = DEFAULT_QUIESCENCE_TIMEOUT_MS;

/**
 * After START is observed, wait this long for the matching END.
 * Independent of `DEFAULT_QUIESCENCE_TIMEOUT_MS`, which still gates request-
 * counter quiescence.
 */
export const REPEAT_FAN_OUT_DRAIN_TIMEOUT_MS = 20_000;

export const FAN_OUT_POLL_MS = 50;

/** Minimal clock/sleep surface so unit tests need no Playwright Page. */
export type FanOutMarkClock = {
  waitForTimeout: (ms: number) => Promise<void>;
};

export type FanOutMarks = { start: number; end: number };

async function waitUntil(
  clock: FanOutMarkClock,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  pollMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await clock.waitForTimeout(Math.min(pollMs, remaining));
  }
  if (await predicate()) return;
  throw new Error(message);
}

/**
 * Prove a second `runLoadAllData` fan-out ran and drained after `marksBefore`.
 * START must increase first; END must then pass both the prior END and the
 * observed START so a stale prior drain cannot satisfy the wait.
 */
export async function waitForLoadAllDataFanOut(
  clock: FanOutMarkClock,
  readMarks: () => FanOutMarks | Promise<FanOutMarks>,
  marksBefore: FanOutMarks,
  options: {
    startTimeoutMs?: number;
    drainTimeoutMs?: number;
    pollMs?: number;
    message?: string;
  } = {},
): Promise<void> {
  const message = options.message ?? 'no second loadAllData() fan-out ran';
  const startTimeoutMs = options.startTimeoutMs ?? REPEAT_FAN_OUT_START_TIMEOUT_MS;
  const drainTimeoutMs = options.drainTimeoutMs ?? REPEAT_FAN_OUT_DRAIN_TIMEOUT_MS;
  const pollMs = options.pollMs ?? FAN_OUT_POLL_MS;

  let observedStart = marksBefore.start;
  await waitUntil(
    clock,
    async () => {
      const marks = await readMarks();
      if (marks.start > marksBefore.start) {
        observedStart = marks.start;
        return true;
      }
      return false;
    },
    startTimeoutMs,
    pollMs,
    message,
  );

  await waitUntil(
    clock,
    async () => {
      const marks = await readMarks();
      return marks.end > marksBefore.end && marks.end >= observedStart;
    },
    drainTimeoutMs,
    pollMs,
    `${message} (fan-out did not drain)`,
  );
}
