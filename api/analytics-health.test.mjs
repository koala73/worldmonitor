import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  advanceBreachStreak,
  dayIndexForBucket,
  parseCollectorHealthReport,
  readBaseline,
  recordCollectorHealthAggregate,
  shouldEmitAggregateAlert,
  wilsonBounds,
} = await import('./analytics-health.js');

const WINDOW_COMMANDS = 13;

/**
 * Shape a pipeline reply the way the endpoint reads it, so a fixture can only
 * express states the real Redis call could actually return.
 */
function pipelineResults({
  writes,
  failures,
  baselineWrites = null,
  baselineFailures = null,
  streak = null,
}) {
  const counter = (value) => (value === null ? { result: null } : { result: String(value) });
  return [
    { result: writes },
    { result: failures },
    { result: 1 },
    { result: 1 },
    counter(writes),
    counter(failures),
    { result: writes },
    { result: failures },
    { result: 1 },
    { result: 1 },
    counter(baselineWrites),
    counter(baselineFailures),
    streak === null ? { result: null } : { result: streak },
  ];
}

async function drive({ report, bucket, results, claimResult = 'OK', claimReply }) {
  const calls = [];
  const captures = [];
  const recorded = await recordCollectorHealthAggregate(report, bucket, undefined, {
    redisPipeline: async (commands) => {
      calls.push(commands);
      if (commands.length === WINDOW_COMMANDS) return results;
      if (claimReply !== undefined) return claimReply;
      return [{ result: 'OK' }, { result: claimResult }];
    },
    captureSilentError: (error, options) => captures.push({ error, options }),
  });
  return { recorded, calls, captures };
}

const REPORT = { cohort: 'event', writes: 1, failures: 1, failureKind: 'network' };

describe('analytics collector health aggregate', () => {
  it('accepts only bounded allowlisted counter deltas', () => {
    assert.deepEqual(
      parseCollectorHealthReport({
        cohort: 'critical-event',
        writes: 4,
        failures: 2,
        failureKind: 'missing-receipt',
      }),
      {
        cohort: 'critical-event',
        writes: 4,
        failures: 2,
        failureKind: 'missing-receipt',
      },
    );
    assert.equal(parseCollectorHealthReport({ cohort: 'event', writes: 0, failures: 0, failureKind: 'network' }), null);
    assert.equal(parseCollectorHealthReport({ cohort: 'event', writes: 2, failures: 3, failureKind: 'network' }), null);
    assert.equal(parseCollectorHealthReport({ cohort: 'other', writes: 5, failures: 5, failureKind: 'network' }), null);
  });
});

describe('wilsonBounds', () => {
  it('brackets the point estimate and stays inside [0, 1]', () => {
    const { lower, upper } = wilsonBounds(60, 100);
    assert.ok(lower < 0.6 && 0.6 < upper, `expected ${lower} < 0.6 < ${upper}`);
    const saturated = wilsonBounds(10, 10);
    assert.ok(saturated.lower > 0 && saturated.upper <= 1);
    const empty = wilsonBounds(0, 0);
    assert.deepEqual(empty, { lower: 0, upper: 1 });
  });

  it('separates the same rate at different sample sizes', () => {
    const small = wilsonBounds(5, 5).lower;
    const large = wilsonBounds(5_000, 5_000).lower;
    assert.ok(
      large - small > 0.3,
      `a 5-sample window must claim far less than a 5000-sample one, got ${small} vs ${large}`,
    );
  });
});

describe('shouldEmitAggregateAlert', () => {
  it('refuses to judge a rate on a denominator that cannot resolve one', () => {
    // The pre-#6026 gate fired here: writes >= 5 and 5/5 >= 0.5.
    assert.equal(shouldEmitAggregateAlert(5, 5), false);
    assert.equal(shouldEmitAggregateAlert(30, 30), false);
    assert.equal(shouldEmitAggregateAlert(31, 31), true);
  });

  it('reads the low end of the interval, not the point estimate', () => {
    // 17/31 is 54.8% — over the 0.5 floor on the raw quotient, and nowhere near
    // it once the sample size is accounted for.
    assert.ok(17 / 31 > 0.5);
    assert.equal(shouldEmitAggregateAlert(31, 17), false);
    assert.equal(shouldEmitAggregateAlert(1_000, 548), true);
  });

  it('does not alert on traffic that merely matches its own baseline', () => {
    // The 2026-08-01 21:00 UTC hour: the busiest hour of the day, zero gap, and
    // a failure rate sitting exactly where this audience's ad-blockers put it.
    const baseline = { writes: 100_000, failures: 61_000 };
    assert.ok(120 / 200 > 0.5, 'the raw rate still clears the absolute floor');
    assert.equal(shouldEmitAggregateAlert(200, 120, baseline), false);
  });

  it('alerts when the window separates from the baseline', () => {
    const baseline = { writes: 100_000, failures: 61_000 };
    assert.equal(shouldEmitAggregateAlert(200, 190, baseline), true);
  });

  it('falls back to the absolute floor when no baseline is usable', () => {
    assert.equal(shouldEmitAggregateAlert(200, 120, null), true);
  });
});

describe('readBaseline', () => {
  it('ignores a baseline too thin to judge a single window', () => {
    assert.equal(readBaseline({ result: '100' }, { result: '60' }), null);
    assert.deepEqual(readBaseline({ result: '620' }, { result: '300' }), { writes: 620, failures: 300 });
  });

  it('rejects impossible and errored counters', () => {
    assert.equal(readBaseline({ result: '1000' }, { result: '1001' }), null);
    assert.equal(readBaseline({ error: 'ERR' }, { result: '10' }), null);
    assert.equal(readBaseline({ result: null }, { result: null }), null);
  });
});

describe('advanceBreachStreak', () => {
  it('starts at one with no prior run', () => {
    assert.equal(advanceBreachStreak(null, 500), 1);
    assert.equal(advanceBreachStreak('not-a-streak', 500), 1);
    assert.equal(advanceBreachStreak('0:499', 500), 1);
  });

  it('is idempotent inside a window and advances across adjacent ones', () => {
    assert.equal(advanceBreachStreak('2:500', 500), 2);
    assert.equal(advanceBreachStreak('2:499', 500), 3);
  });

  it('resets when a healthy window interrupts the run', () => {
    assert.equal(advanceBreachStreak('9:498', 500), 1);
    assert.equal(advanceBreachStreak('9:501', 500), 1);
  });
});

describe('recordCollectorHealthAggregate', () => {
  it('costs one round trip on a healthy window', async () => {
    const { recorded, calls, captures } = await drive({
      report: REPORT,
      bucket: 1_000,
      results: pipelineResults({ writes: 5_000, failures: 10 }),
    });

    assert.equal(recorded, true);
    assert.equal(calls.length, 1, 'a healthy window must not pay for a second Redis call');
    assert.equal(captures.length, 0);
  });

  it('stays silent until the breach has survived three consecutive windows', async () => {
    let streak = null;
    const emitted = [];

    for (const bucket of [1_000, 1_001, 1_002]) {
      const { calls, captures } = await drive({
        report: REPORT,
        bucket,
        results: pipelineResults({ writes: 200, failures: 190, streak }),
      });
      const streakWrite = calls[1].find((command) => command[0] === 'SET' && command[1].endsWith(':streak'));
      assert.ok(streakWrite, 'a breached window must persist its streak');
      streak = streakWrite[2];
      emitted.push(captures.length);
    }

    assert.deepEqual(emitted, [0, 0, 1], 'only the third consecutive breached window may alert');
    assert.equal(streak, '3:1002');
  });

  it('restarts the run when a healthy window interrupts it', async () => {
    const { captures } = await drive({
      report: REPORT,
      bucket: 1_010,
      results: pipelineResults({ writes: 200, failures: 190, streak: '2:1008' }),
    });
    assert.equal(captures.length, 0, 'a one-window gap must reset the run, not extend it');
  });

  it('reports the numbers an operator needs to calibrate the floors', async () => {
    const { captures } = await drive({
      report: REPORT,
      bucket: 1_002,
      results: pipelineResults({
        writes: 200,
        failures: 190,
        baselineWrites: 100_000,
        baselineFailures: 61_000,
        streak: '2:1001',
      }),
    });

    assert.equal(captures.length, 1);
    const { extra, tags, fingerprint } = captures[0].options;
    assert.deepEqual(fingerprint, ['analytics-collector', 'environment-noise', 'event']);
    assert.equal(tags.healthCohort, 'event');
    assert.equal(extra.writeCount, 200);
    assert.equal(extra.failureCount, 190);
    assert.equal(extra.consecutiveBreachedWindows, 3);
    assert.equal(extra.baselineWriteCount, 100_000);
    assert.equal(extra.baselineFailureRate, 0.61);
    assert.ok(extra.failureRateLowerBound < extra.failureRate);
    assert.ok(extra.failureRateLowerBound > extra.baselineFailureRateUpperBound);
    assert.equal(extra.minWrites, 31);
  });

  it('never alerts on a healthy peak hour, however long it runs', async () => {
    const streak = null;
    let alerts = 0;

    for (let bucket = 2_000; bucket < 2_060; bucket += 1) {
      const { calls, captures } = await drive({
        report: REPORT,
        bucket,
        // 60% failing on a 61% baseline: the day's busiest hour, no outage.
        results: pipelineResults({
          writes: 5_000,
          failures: 3_000,
          baselineWrites: 1_000_000,
          baselineFailures: 610_000,
          streak,
        }),
      });
      assert.equal(calls.length, 1, 'a baseline-matching window must not reach the claim pipeline');
      alerts += captures.length;
    }

    assert.equal(alerts, 0, 'an hour at baseline must stay silent');
  });

  it('claims one aggregate Sentry event per cohort and window', async () => {
    const { recorded, calls, captures } = await drive({
      report: REPORT,
      bucket: 1_002,
      results: pipelineResults({ writes: 200, failures: 190, streak: '2:1001' }),
    });

    assert.equal(recorded, true);
    assert.equal(calls.length, 2, 'counter update and once-per-window claim are separate Redis operations');
    assert.equal(captures.length, 1);
  });

  it('stays silent when another isolate won the window latch', async () => {
    const { recorded, captures } = await drive({
      report: REPORT,
      bucket: 1_002,
      results: pipelineResults({ writes: 200, failures: 190, streak: '2:1001' }),
      claimResult: null,
    });

    assert.equal(recorded, true);
    assert.equal(captures.length, 0);
  });

  it('fails closed when the once-per-window claim is unavailable', async () => {
    const { recorded } = await drive({
      report: REPORT,
      bucket: 1_002,
      results: pipelineResults({ writes: 200, failures: 190, streak: '2:1001' }),
      claimReply: null,
    });

    assert.equal(recorded, false);
  });

  it('fails closed when the window pipeline is truncated', async () => {
    const { recorded } = await drive({
      report: REPORT,
      bucket: 1_002,
      results: pipelineResults({ writes: 200, failures: 190 }).slice(0, 6),
    });

    assert.equal(recorded, false);
  });
});

describe('dayIndexForBucket', () => {
  it('maps 60s windows onto the day that holds them', () => {
    assert.equal(dayIndexForBucket(0), 0);
    assert.equal(dayIndexForBucket(1_439), 0);
    assert.equal(dayIndexForBucket(1_440), 1);
    assert.equal(dayIndexForBucket(2_880), 2);
  });
});
