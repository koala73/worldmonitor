import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QUIESCENCE_SAMPLE_MS,
  type HydrationRequestLog,
  waitForHydrationRequestQuiescence,
} from '../e2e/helpers/hydration-request-quiescence';

const clock = {
  waitForTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

test('quiescence absorbs a late counter bump before freezing the baseline (#7212)', async () => {
  const log: HydrationRequestLog = {
    counts: { earthquakes: 1 },
    tiers: [],
    inflight: 0,
  };

  const pending = waitForHydrationRequestQuiescence(clock, log, ['earthquakes'], {
    message: 'late first-pass bump was not absorbed into the baseline',
  });
  // Land after the first quiet sample window would have begun — a fixed sleep
  // that froze immediately after the first visible count would misattribute
  // this bump to a later "repeat" window (false green).
  setTimeout(() => {
    log.counts.earthquakes = 2;
  }, QUIESCENCE_SAMPLE_MS + 50);

  const baseline = await pending;
  assert.equal(baseline.earthquakes, 2);
});

test('quiescence waits for in-flight handlers to drain before freezing (#7212)', async () => {
  const log: HydrationRequestLog = {
    counts: { earthquakes: 1 },
    tiers: [],
    inflight: 1,
  };

  const pending = waitForHydrationRequestQuiescence(clock, log, ['earthquakes'], {
    message: 'in-flight first-pass handler was not drained before the baseline freeze',
  });
  setTimeout(() => {
    log.counts.earthquakes = 2;
    log.inflight = 0;
  }, QUIESCENCE_SAMPLE_MS + 50);

  const baseline = await pending;
  assert.equal(baseline.earthquakes, 2);
  assert.equal(log.inflight, 0);
});

test('quiescence fails loudly when handlers never drain (#7212)', async () => {
  const log: HydrationRequestLog = {
    counts: { earthquakes: 1 },
    tiers: [],
    inflight: 1,
  };

  await assert.rejects(
    waitForHydrationRequestQuiescence(clock, log, ['earthquakes'], {
      message: 'stuck handler',
      timeout: QUIESCENCE_SAMPLE_MS * 2,
    }),
    /stuck handler \(inflight=1, lastCounts=\{"earthquakes":1\}\)/,
  );
});
