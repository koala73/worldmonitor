import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  parseCollectorHealthReport,
  shouldEmitAggregateAlert,
  recordCollectorHealthAggregate,
} = await import('./analytics-health.js');

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

  it('requires both the sample floor and failure-rate floor', () => {
    assert.equal(shouldEmitAggregateAlert(4, 4), false);
    assert.equal(shouldEmitAggregateAlert(100, 49), false);
    assert.equal(shouldEmitAggregateAlert(5, 5), true);
  });

  it('claims one aggregate Sentry event per cohort and window', async () => {
    const pipelineCalls = [];
    const captures = [];
    const pipeline = async (commands) => {
      pipelineCalls.push(commands);
      if (commands.length === 6) {
        return [
          { result: 5 },
          { result: 5 },
          { result: 1 },
          { result: 1 },
          { result: '5' },
          { result: '5' },
        ];
      }
      return [{ result: 'OK' }];
    };

    const recorded = await recordCollectorHealthAggregate(
      { cohort: 'event', writes: 1, failures: 1, failureKind: 'network' },
      123,
      undefined,
      {
        redisPipeline: pipeline,
        captureSilentError: (error, options) => captures.push({ error, options }),
      },
    );

    assert.equal(recorded, true);
    assert.equal(pipelineCalls.length, 2, 'counter update and once-per-window claim are separate Redis operations');
    assert.equal(captures.length, 1);
    assert.equal(captures[0].options.tags.healthCohort, 'event');
    assert.equal(captures[0].options.extra.writeCount, 5);
    assert.equal(captures[0].options.extra.failureCount, 5);
  });

  it('fails closed when the once-per-window claim is unavailable', async () => {
    const recorded = await recordCollectorHealthAggregate(
      { cohort: 'event', writes: 1, failures: 1, failureKind: 'network' },
      123,
      undefined,
      {
        redisPipeline: async (commands) => commands.length === 6
          ? [
            { result: 5 },
            { result: 5 },
            { result: 1 },
            { result: 1 },
            { result: '5' },
            { result: '5' },
          ]
          : null,
        captureSilentError: () => {},
      },
    );

    assert.equal(recorded, false);
  });
});
