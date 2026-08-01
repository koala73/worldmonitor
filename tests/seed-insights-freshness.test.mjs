import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INSIGHTS_SYNTHESIS_FAILURE_CODES,
  buildInsightsFreshnessMetaPatch,
  classifyInsightsSynthesisFailure,
  decorateInsightsRun,
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
