import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FORECAST_EVIDENCE_MAX_LOOKBACK_MS } from '../scripts/_forecast-evidence-archive.mjs';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

const nowMs = 1_750_000_000_000;
const coverage = {
  v: 1,
  coverageStartMs: nowMs - FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
  coverageEndMs: nowMs,
  cutoverVerifiedAtMs: nowMs - 1,
  sourceDigestAtMs: nowMs,
  maxLookbackMs: FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
  retentionSeconds: 15 * 24 * 60 * 60,
  sourceKey: 'digest:accumulator:v1:full:en',
  legacyOldestHash: 'f'.repeat(64),
  legacyOldestScoreMs: nowMs - FORECAST_EVIDENCE_MAX_LOOKBACK_MS - 1,
};

describe('forecast evidence writer cutover gate (#7082)', () => {
  it('distinguishes a confirmed Redis pipeline from an empty/error result', () => {
    assert.equal(__testing__.redisPipelineConfirmed([{ result: 'OK' }], 1), true);
    assert.equal(__testing__.redisPipelineConfirmed([], 1), false);
    assert.equal(__testing__.redisPipelineConfirmed([{ error: 'timeout' }], 1), false);
  });

  it('does not prune when coverage read or an earlier write was unconfirmed', () => {
    const complete = {
      evidenceEligible: true,
      cutoverEnabled: true,
      coverage,
      nowMs,
      trackingWritesConfirmed: true,
      evidenceWritesConfirmed: true,
      coverageAdvanced: true,
      accumulatorTtlConfirmed: true,
    };
    assert.equal(__testing__.shouldPruneAccumulator(complete), true);
    assert.equal(__testing__.shouldPruneAccumulator({ ...complete, cutoverEnabled: false }), false);
    assert.equal(__testing__.shouldPruneAccumulator({ ...complete, coverage: null }), false);
    assert.equal(__testing__.shouldPruneAccumulator({ ...complete, evidenceWritesConfirmed: false }), false);
    assert.equal(__testing__.shouldPruneAccumulator({ ...complete, trackingWritesConfirmed: false }), false);
    assert.equal(__testing__.shouldPruneAccumulator({ ...complete, accumulatorTtlConfirmed: false }), false);
  });

  it('requires the cutover marker to cover the full 14-day declared window', () => {
    assert.equal(__testing__.shouldPruneAccumulator({
      evidenceEligible: true,
      cutoverEnabled: true,
      coverage: { ...coverage, coverageStartMs: coverage.coverageStartMs + 1 },
      nowMs,
      trackingWritesConfirmed: true,
      evidenceWritesConfirmed: true,
      coverageAdvanced: true,
      accumulatorTtlConfirmed: true,
    }), false);
  });

  it('preserves confirmed pruning for scopes outside full/en', () => {
    assert.equal(__testing__.shouldPruneAccumulator({
      evidenceEligible: false,
      cutoverEnabled: false,
      coverage: null,
      nowMs,
      trackingWritesConfirmed: true,
      evidenceWritesConfirmed: false,
      coverageAdvanced: false,
      accumulatorTtlConfirmed: true,
    }), true);
  });
});
