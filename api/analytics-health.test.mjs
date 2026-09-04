import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  advanceBreachStreak,
  dayIndexForBucket,
  hourIndexForBucket,
  parseCollectorHealthReport,
  readBaseline,
  recordCollectorHealthAggregate,
  shouldEmitAggregateAlert,
  wilsonBounds,
} = await import('./analytics-health.js');

const WINDOW_COMMANDS = 15;

/**
 * Shape a pipeline reply the way the endpoint reads it, so a fixture can only
 * express states the real Redis call could actually return.
 */
function pipelineResults({
  writes,
  manualTimeoutWrites = 0,
  failures,
  previousWrites = null,
  previousFailures = null,
  baselineWrites = null,
  baselineFailures = null,
  baselineWindows = null,
  streak = null,
}) {
  const counter = (value) => (value === null ? { result: null } : { result: String(value) });
  // INCRBY replies deliberately differ from GET replies. A fixture that only
  // keys off command count cannot catch swapped reads or writes.
  const incrReply = (value) => ({ result: value === null ? null : value + 100_000 });
  return [
    incrReply(writes),
    incrReply(manualTimeoutWrites),
    incrReply(failures),
    { result: 1 },
    { result: 1 },
    { result: 1 },
    counter(writes),
    counter(manualTimeoutWrites),
    counter(failures),
    counter(previousWrites),
    counter(previousFailures),
    counter(baselineWrites),
    counter(baselineFailures),
    counter(baselineWindows),
    streak === null ? { result: null } : { result: streak },
  ];
}

async function drive({
  report,
  bucket,
  results,
  claimResult,
  claimReply,
  finalizationReply,
  baselineWriteReply,
}) {
  const calls = [];
  const captures = [];
  const recorded = await recordCollectorHealthAggregate(report, bucket, undefined, {
    redisPipeline: async (commands) => {
      calls.push(commands);
      if (commands.length === WINDOW_COMMANDS) return results;
      const first = commands[0];
      if (first?.[0] === 'SET' && String(first[1]).includes(':baseline-finalized:')) {
        return finalizationReply === undefined ? [{ result: 'OK' }] : finalizationReply;
      }
      if (first?.[0] === 'INCRBY' && String(first[1]).includes(':day:')) {
        return baselineWriteReply === undefined
          ? [{ result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }]
          : baselineWriteReply;
      }
      if (first?.[0] === 'EVAL') {
        return claimReply === undefined
          ? [{ result: claimResult === undefined ? `CLAIMED:${first[5]}` : claimResult }]
          : claimReply;
      }
      throw new Error(`unexpected Redis pipeline: ${JSON.stringify(commands)}`);
    },
    captureSilentError: (error, options) => captures.push({ error, options }),
  });
  return { recorded, calls, captures };
}

const REPORT = {
  cohort: 'event',
  writes: 1,
  manualTimeoutWrites: 0,
  failures: 1,
  failureKind: 'network',
};

describe('analytics collector health aggregate', () => {
  it('accepts only bounded allowlisted counter deltas', () => {
    assert.deepEqual(
      parseCollectorHealthReport({
        cohort: 'critical-event',
        writes: 4,
        manualTimeoutWrites: 3,
        failures: 2,
        failureKind: 'missing-receipt',
        bucket: 123,
      }),
      {
        cohort: 'critical-event',
        writes: 4,
        manualTimeoutWrites: 3,
        failures: 2,
        failureKind: 'missing-receipt',
        bucket: 123,
      },
    );
    assert.equal(parseCollectorHealthReport({ cohort: 'event', writes: 0, failures: 0, failureKind: 'network' }), null);
    assert.deepEqual(
      parseCollectorHealthReport({ cohort: 'event', writes: 20, failures: 0, failureKind: 'none' }),
      { cohort: 'event', writes: 20, manualTimeoutWrites: 0, failures: 0, failureKind: 'none' },
    );
    assert.equal(
      parseCollectorHealthReport({
        cohort: 'event',
        writes: 2,
        manualTimeoutWrites: 3,
        failures: 0,
        failureKind: 'none',
      }),
      null,
      'the manual-path numerator cannot exceed its write denominator',
    );
    assert.equal(parseCollectorHealthReport({ cohort: 'event', writes: 20, failures: 1, failureKind: 'none' }), null);
    assert.equal(parseCollectorHealthReport({ cohort: 'event', writes: 2, failures: 3, failureKind: 'network' }), null);
    assert.equal(parseCollectorHealthReport({ cohort: 'other', writes: 5, failures: 5, failureKind: 'network' }), null);
    assert.equal(parseCollectorHealthReport({ cohort: 'event', writes: 5, failures: 1, failureKind: 'network', bucket: -1 }), null);
    assert.equal(parseCollectorHealthReport({ cohort: 'event', writes: 5, failures: 1, failureKind: 'network', bucket: 1.5 }), null);
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

  it('strips a saturated or outage-shaped baseline of its veto', () => {
    const saturated = { writes: 600_000, failures: 600_000 };
    assert.equal(wilsonBounds(saturated.failures, saturated.writes).upper, 1);
    assert.equal(shouldEmitAggregateAlert(200, 190, saturated), true);
    assert.equal(shouldEmitAggregateAlert(5_000, 5_000, saturated), true);
    assert.equal(shouldEmitAggregateAlert(200, 120, { writes: 100_000, failures: 61_000 }), false);
  });

  it('keeps the baseline comparison discriminating at a thin sample size', () => {
    const thin = { writes: 620, failures: 380 };
    const { lower, upper } = wilsonBounds(thin.failures, thin.writes);
    assert.ok(lower < 0.62 && 0.62 < upper, `expected ${lower} < 0.62 < ${upper}`);
    assert.equal(shouldEmitAggregateAlert(5_000, 3_150, thin), false);
    assert.equal(shouldEmitAggregateAlert(5_000, 3_400, thin), true);
  });
});

describe('readBaseline', () => {
  it('ignores a baseline too thin to judge a single window', () => {
    assert.equal(readBaseline({ result: '100' }, { result: '60' }, { result: '20' }), null);
    assert.deepEqual(
      readBaseline({ result: '620' }, { result: '300' }, { result: '20' }),
      { writes: 620, failures: 300, windows: 20 },
    );
  });

  it('rejects impossible and errored counters', () => {
    assert.equal(readBaseline({ result: '1000' }, { result: '1001' }), null);
    assert.equal(readBaseline({ error: 'ERR' }, { result: '10' }), null);
    assert.equal(readBaseline({ result: null }, { result: null }), null);
  });
});

describe('advanceBreachStreak', () => {
  it('starts at one with no prior run', () => {
    assert.deepEqual(advanceBreachStreak(null, 500), { count: 1, bucket: 500 });
    assert.deepEqual(advanceBreachStreak('not-a-streak', 500), { count: 1, bucket: 500 });
    assert.deepEqual(advanceBreachStreak('0:499', 500), { count: 1, bucket: 500 });
  });

  it('is idempotent inside a window and advances across adjacent ones', () => {
    assert.deepEqual(advanceBreachStreak('2:500', 500), { count: 2, bucket: 500 });
    assert.deepEqual(advanceBreachStreak('2:499', 500), { count: 3, bucket: 500 });
  });

  it('resets when a healthy window interrupts the run', () => {
    assert.deepEqual(advanceBreachStreak('9:498', 500), { count: 1, bucket: 500 });
  });

  it('leaves a newer run alone when a straggler crosses the boundary', () => {
    assert.deepEqual(advanceBreachStreak('9:501', 500), { count: 9, bucket: 501 });
  });
});

describe('recordCollectorHealthAggregate', () => {
  it('uses explicit current, previous-window, and previous-day keys', async () => {
    const { calls } = await drive({
      report: {
        cohort: 'event',
        writes: 3,
        manualTimeoutWrites: 2,
        failures: 2,
        failureKind: 'network',
      },
      bucket: 1_000,
      results: pipelineResults({ writes: 5_000, failures: 10 }),
    });
    const p = 'analytics:collector-health:v1:production';
    assert.deepEqual(calls[0], [
      ['INCRBY', `${p}:1000:event:writes`, '3'],
      ['INCRBY', `${p}:1000:event:manual-timeout-writes`, '2'],
      ['INCRBY', `${p}:1000:event:failures`, '2'],
      ['EXPIRE', `${p}:1000:event:writes`, '120'],
      ['EXPIRE', `${p}:1000:event:manual-timeout-writes`, '120'],
      ['EXPIRE', `${p}:1000:event:failures`, '120'],
      ['GET', `${p}:1000:event:writes`],
      ['GET', `${p}:1000:event:manual-timeout-writes`],
      ['GET', `${p}:1000:event:failures`],
      ['GET', `${p}:999:event:writes`],
      ['GET', `${p}:999:event:failures`],
      ['GET', `${p}:day:-1:hour:16:event:writes`],
      ['GET', `${p}:day:-1:hour:16:event:failures`],
      ['GET', `${p}:day:-1:hour:16:event:windows`],
      ['GET', `${p}:event:streak`],
    ]);
    assert.equal(
      calls.flat().some((value) => String(value).includes(':day:0:hour:16:event:writes')),
      false,
      'the current report must not train the current day before the window is complete',
    );
  });

  it('does not admit an already-breached previous window to the baseline', async () => {
    const { calls } = await drive({
      report: REPORT,
      bucket: 1_001,
      results: pipelineResults({
        writes: 5_000,
        failures: 100,
        previousWrites: 200,
        previousFailures: 190,
      }),
    });
    const finalization = calls[1];
    assert.deepEqual(finalization[0], [
      'SET',
      'analytics:collector-health:v1:production:baseline-finalized:1000:event',
      '0',
      'NX',
      'EX',
      '172800',
    ]);
    assert.equal(calls.some((commands) => commands[0]?.[0] === 'INCRBY' && String(commands[0]?.[1]).includes(':day:')), false);
  });

  it('admits one completed normal window exactly once', async () => {
    const { calls } = await drive({
      report: REPORT,
      bucket: 1_001,
      results: pipelineResults({
        writes: 5_000,
        failures: 100,
        previousWrites: 5_000,
        previousFailures: 3_000,
      }),
    });
    assert.equal(calls[1][0][0], 'SET');
    assert.equal(calls[2][0][0], 'INCRBY');
    assert.deepEqual(calls[2], [
      ['INCRBY', 'analytics:collector-health:v1:production:day:0:hour:16:event:writes', '5000'],
      ['INCRBY', 'analytics:collector-health:v1:production:day:0:hour:16:event:failures', '3000'],
      ['INCRBY', 'analytics:collector-health:v1:production:day:0:hour:16:event:windows', '1'],
      ['EXPIRE', 'analytics:collector-health:v1:production:day:0:hour:16:event:writes', '172800'],
      ['EXPIRE', 'analytics:collector-health:v1:production:day:0:hour:16:event:failures', '172800'],
      ['EXPIRE', 'analytics:collector-health:v1:production:day:0:hour:16:event:windows', '172800'],
    ]);
  });

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

    for (const [bucket, claimResult] of [[1_000, 'CLAIMED:1'], [1_001, 'CLAIMED:2'], [1_002, 'CLAIMED:3']]) {
      const { calls, captures } = await drive({
        report: REPORT,
        bucket,
        results: pipelineResults({ writes: 200, failures: 190, streak }),
        claimResult,
      });
      assert.equal(calls[1][0][0], 'EVAL', 'a breached window must use the atomic streak transition');
      streak = `${claimResult.slice('CLAIMED:'.length)}:${bucket}`;
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
        manualTimeoutWrites: 50,
        failures: 190,
        baselineWrites: 100_000,
        baselineFailures: 61_000,
        baselineWindows: 20,
        streak: '2:1001',
      }),
    });

    assert.equal(captures.length, 1);
    const { extra, tags, fingerprint } = captures[0].options;
    assert.deepEqual(fingerprint, ['analytics-collector', 'environment-noise', 'event']);
    assert.equal(tags.healthCohort, 'event');
    assert.equal(extra.writeCount, 200);
    assert.equal(extra.manualTimeoutWriteCount, 50);
    assert.equal(extra.manualTimeoutRate, 0.25);
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
          baselineWindows: 20,
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

  it('fails closed when Redis errors on the window counters', async () => {
    const results = pipelineResults({ writes: 200, failures: 190, streak: '2:1001' });
    results[4] = { error: 'ERR backend unavailable' };
    const { recorded, captures } = await drive({ report: REPORT, bucket: 1_002, results });
    assert.equal(recorded, false);
    assert.equal(captures.length, 0);
  });

  it('fails closed when Redis errors while incrementing the window', async () => {
    const results = pipelineResults({ writes: 200, failures: 190, streak: '2:1001' });
    results[0] = { error: 'ERR write unavailable' };
    const { recorded, captures } = await drive({ report: REPORT, bucket: 1_002, results });
    assert.equal(recorded, false);
    assert.equal(captures.length, 0);
  });

  it('fails closed when Redis errors on the streak read', async () => {
    const results = pipelineResults({ writes: 200, failures: 190, streak: '2:1001' });
    results[11] = { error: 'ERR backend unavailable' };
    const { recorded, captures } = await drive({ report: REPORT, bucket: 1_002, results });
    assert.equal(recorded, false);
    assert.equal(captures.length, 0);
  });

  it('fails closed when the atomic streak transition errors', async () => {
    const { recorded, captures } = await drive({
      report: REPORT,
      bucket: 1_002,
      results: pipelineResults({ writes: 200, failures: 190, streak: '2:1001' }),
      claimReply: [{ error: 'ERR write failed' }],
    });
    assert.equal(recorded, false);
    assert.equal(captures.length, 0);
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

  it('maps 60s windows onto their UTC hour for same-hour baselines', () => {
    assert.equal(hourIndexForBucket(0), 0);
    assert.equal(hourIndexForBucket(59), 0);
    assert.equal(hourIndexForBucket(60), 1);
    assert.equal(hourIndexForBucket(1_439), 23);
    assert.equal(hourIndexForBucket(1_440), 0);
  });
});
