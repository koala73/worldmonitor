import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INSIGHTS_SYNTHESIS_FAILURE_CODES,
  buildInsightsFreshnessMetaPatch,
  classifyInsightsSynthesisFailure,
  decorateInsightsRun,
  insightsFreshnessPatchArgs,
  publishInsightsPayload,
  resolveInsightsFallbackStatus,
  validateInsightsPayload,
} from '../scripts/seed-insights.mjs';

const OLD_GENERATED_AT = '2026-08-01T06:30:39.268Z';
const NEW_GENERATED_AT = '2026-08-01T08:30:39.268Z';

test('synthesis rejection codes identify missing cluster, provider, parse, and gate stages', () => {
  assert.equal(
    classifyInsightsSynthesisFailure({ hasBriefCluster: false }),
    INSIGHTS_SYNTHESIS_FAILURE_CODES.MISSING_CLUSTER,
  );
  assert.equal(
    classifyInsightsSynthesisFailure({ hasBriefCluster: true }),
    INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER,
  );
  assert.equal(
    classifyInsightsSynthesisFailure({ hasBriefCluster: true, synthesisResult: { text: 'raw' } }),
    INSIGHTS_SYNTHESIS_FAILURE_CODES.PARSE,
  );
  assert.equal(
    classifyInsightsSynthesisFailure({
      hasBriefCluster: true,
      synthesisResult: { text: 'raw' },
      parsedSynthesis: { lead: 'parsed' },
    }),
    INSIGHTS_SYNTHESIS_FAILURE_CODES.GATE,
  );
  assert.equal(
    classifyInsightsSynthesisFailure({
      hasBriefCluster: true,
      synthesisResult: { text: 'raw' },
      parsedSynthesis: { lead: 'parsed' },
      composed: { lead: 'published' },
    }),
    null,
  );
});

test('LKG-preserved insights fail publication validation without leaking run metadata into JSON', () => {
  const lkg = decorateInsightsRun(
    {
      status: 'ok',
      generatedAt: OLD_GENERATED_AT,
      topStories: [{ primaryTitle: 'The last good brief' }],
    },
    { outcome: 'lkg_preserved', failureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.PARSE },
  );

  const publishedShape = publishInsightsPayload(lkg);

  assert.equal(validateInsightsPayload(publishedShape), false);
  assert.equal(JSON.stringify(publishedShape).includes('lkg_preserved'), false);
  assert.equal(publishedShape.generatedAt, OLD_GENERATED_AT);
});

test('repeated synthesis rejection advances attempt metadata but preserves LKG freshness fields', () => {
  const patch = buildInsightsFreshnessMetaPatch({
    previousMeta: {
      fetchedAt: 1_754_000_000_000,
      lastAttemptAt: 1_754_000_060_000,
      lastSuccessAt: 1_754_000_000_000,
      servedGeneratedAt: OLD_GENERATED_AT,
      consecutiveFailures: 1,
    },
    outcome: 'lkg_preserved',
    failureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.GATE,
    nowMs: 1_754_000_120_000,
    servedGeneratedAt: OLD_GENERATED_AT,
  });

  assert.equal(patch.lastAttemptAt, 1_754_000_120_000);
  assert.equal(patch.lastSuccessAt, 1_754_000_000_000);
  assert.equal(patch.servedGeneratedAt, OLD_GENERATED_AT);
  assert.equal(patch.consecutiveFailures, 2);
  assert.equal(patch.lastSynthesisFailureCode, INSIGHTS_SYNTHESIS_FAILURE_CODES.GATE);
  assert.equal('fetchedAt' in patch, false, 'failed attempts must not re-anchor seed freshness');
});

test('a newly published payload resets synthesis failures only after publication', () => {
  const patch = buildInsightsFreshnessMetaPatch({
    previousMeta: {
      fetchedAt: 1_754_000_000_000,
      lastAttemptAt: 1_754_000_060_000,
      lastSuccessAt: 1_754_000_000_000,
      servedGeneratedAt: OLD_GENERATED_AT,
      consecutiveFailures: 7,
      lastSynthesisFailureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.PARSE,
    },
    outcome: 'published',
    nowMs: 1_754_000_180_000,
    servedGeneratedAt: NEW_GENERATED_AT,
  });

  assert.equal(patch.lastAttemptAt, 1_754_000_180_000);
  assert.equal(patch.lastSuccessAt, 1_754_000_180_000);
  assert.equal(patch.servedGeneratedAt, NEW_GENERATED_AT);
  assert.equal(patch.consecutiveFailures, 0);
  assert.equal(patch.lastSynthesisFailureCode, null);
});

// #5947: MISSING_CLUSTER alone could not distinguish "the corpus genuinely had
// no corroborated story" (a legitimate degraded run) from "corroborated
// clusters existed but selection never surfaced them" (the 35-run production
// incident). Carry the bounded corpus count so the next occurrence is one
// field away from diagnosis instead of a Redis archaeology session.
test('missing-cluster rejections record how many corroborated clusters the corpus held', () => {
  const selectionBug = buildInsightsFreshnessMetaPatch({
    previousMeta: { consecutiveFailures: 3 },
    outcome: 'lkg_preserved',
    failureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.MISSING_CLUSTER,
    nowMs: 1_754_000_120_000,
    briefEligibleClusters: 11,
  });
  assert.equal(selectionBug.briefEligibleClusters, 11);
  assert.equal(selectionBug.lastSynthesisFailureCode, INSIGHTS_SYNTHESIS_FAILURE_CODES.MISSING_CLUSTER);

  const genuinelyBare = buildInsightsFreshnessMetaPatch({
    previousMeta: {},
    outcome: 'lkg_preserved',
    failureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.MISSING_CLUSTER,
    nowMs: 1_754_000_120_000,
    briefEligibleClusters: 0,
  });
  assert.equal(genuinelyBare.briefEligibleClusters, 0);
});

test('brief-eligible cluster count stays bounded and numeric', () => {
  const absent = buildInsightsFreshnessMetaPatch({
    previousMeta: {},
    outcome: 'lkg_preserved',
    failureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.PARSE,
    nowMs: 1_754_000_120_000,
  });
  assert.equal(absent.briefEligibleClusters, null, 'omitted count must not fabricate a value');

  for (const bad of ['11', -4, Number.NaN, Infinity, { n: 1 }]) {
    const patch = buildInsightsFreshnessMetaPatch({
      previousMeta: {},
      outcome: 'lkg_preserved',
      failureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.MISSING_CLUSTER,
      nowMs: 1_754_000_120_000,
      briefEligibleClusters: bad,
    });
    assert.equal(patch.briefEligibleClusters, null, `non-count input ${String(bad)} must normalize to null`);
  }

  const huge = buildInsightsFreshnessMetaPatch({
    previousMeta: {},
    outcome: 'lkg_preserved',
    failureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.MISSING_CLUSTER,
    nowMs: 1_754_000_120_000,
    briefEligibleClusters: 10_000,
  });
  assert.ok(huge.briefEligibleClusters <= 1000, 'count must stay bounded for seed-meta/health');
});

test('a published run records the corroborated cluster count it succeeded with', () => {
  const patch = buildInsightsFreshnessMetaPatch({
    previousMeta: { consecutiveFailures: 35 },
    outcome: 'published',
    nowMs: 1_754_000_180_000,
    servedGeneratedAt: NEW_GENERATED_AT,
    briefEligibleClusters: 11,
  });
  assert.equal(patch.consecutiveFailures, 0);
  assert.equal(patch.briefEligibleClusters, 11);
});

// The count is only worth carrying if it survives the run-meta -> seed-meta
// seam. Drive the REAL exported chain (decorate -> patch args -> patch) rather
// than asserting on source text, which would still pass with the wiring cut.
test('the corroborated-cluster count survives the run-meta to seed-meta seam', () => {
  const rejected = decorateInsightsRun(
    { status: 'ok', generatedAt: OLD_GENERATED_AT, topStories: [{ primaryTitle: 'lkg' }] },
    {
      outcome: 'lkg_preserved',
      failureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.MISSING_CLUSTER,
      briefEligibleClusters: 11,
    },
  );
  const patch = buildInsightsFreshnessMetaPatch(
    insightsFreshnessPatchArgs(rejected, 'lkg_preserved', { consecutiveFailures: 34 }, 1_754_000_120_000),
  );
  assert.equal(patch.briefEligibleClusters, 11, 'run meta must reach the seed-meta patch');
  assert.equal(patch.lastSynthesisFailureCode, INSIGHTS_SYNTHESIS_FAILURE_CODES.MISSING_CLUSTER);
  assert.equal(patch.consecutiveFailures, 35);
  assert.equal(patch.servedGeneratedAt, OLD_GENERATED_AT);

  const published = decorateInsightsRun(
    { status: 'ok', generatedAt: NEW_GENERATED_AT, topStories: [{ primaryTitle: 'fresh' }] },
    { outcome: 'published', failureCode: null, briefEligibleClusters: 4 },
  );
  const okPatch = buildInsightsFreshnessMetaPatch(
    insightsFreshnessPatchArgs(published, 'published', { consecutiveFailures: 35 }, 1_754_000_180_000),
  );
  assert.equal(okPatch.briefEligibleClusters, 4);
  assert.equal(okPatch.consecutiveFailures, 0);
  assert.equal(okPatch.lastSuccessAt, 1_754_000_180_000);
  assert.equal(okPatch.servedGeneratedAt, NEW_GENERATED_AT);
});

test('a rejected synthesized brief keeps a successful legacy fallback degraded', () => {
  assert.equal(
    resolveInsightsFallbackStatus({
      synthesisFailureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.GATE,
      legacyStatus: 'ok',
    }),
    'degraded',
  );
  assert.equal(
    resolveInsightsFallbackStatus({ synthesisFailureCode: null, legacyStatus: 'ok' }),
    'ok',
  );
});
