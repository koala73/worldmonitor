import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildInsightsFreshnessMetaPatch,
  decorateInsightsRun,
  insightsFreshnessPatchArgs,
  publishInsightsPayload,
  resolveInsightsFallbackStatus,
  validateInsightsPayload,
} from '../scripts/seed-insights.mjs';
import {
  INSIGHTS_COMPOSER_THREW,
  INSIGHTS_SYNTHESIS_FAILURE_CODES,
  classifyInsightsSynthesisFailure,
  composeInsightsSynthesis,
  resolveInsightsSynthesis,
} from '../scripts/_insights-synthesis-diagnostics.mjs';
import { BRIEF_REJECTIONS } from '../scripts/_insights-brief.mjs';
import { __testing__ as healthTesting } from '../api/health.js';

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

// #5947: INSIGHTS_SYNTHESIS_GATE covered five independent editorial gates, so
// `lastSynthesisFailureCode: INSIGHTS_SYNTHESIS_GATE` told an operator only
// that the composer said no — the #6019 and #6119 investigations each had to
// snapshot the live digest and replay it offline to learn which gate fired.
test('a gate rejection reports which gate rejected it', () => {
  const gateStage = (gateReason) => classifyInsightsSynthesisFailure({
    hasBriefCluster: true,
    synthesisResult: { text: 'raw' },
    parsedSynthesis: { lead: 'parsed' },
    gateReason,
  });

  assert.equal(gateStage(BRIEF_REJECTIONS.LEAD_UNCITED), INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_UNCITED);
  assert.equal(gateStage(BRIEF_REJECTIONS.LEAD_PROPER_NOUN), INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_PROPER_NOUN);
  assert.equal(gateStage(BRIEF_REJECTIONS.LEAD_NUMERIC_FACT), INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_NUMERIC_FACT);
  assert.equal(gateStage(BRIEF_REJECTIONS.LEAD_GROUNDING), INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_GROUNDING);
  assert.equal(gateStage(BRIEF_REJECTIONS.LEAD_EMPTY), INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_EMPTY);
  assert.equal(gateStage(INSIGHTS_COMPOSER_THREW), INSIGHTS_SYNTHESIS_FAILURE_CODES.COMPOSER_ERROR);
});

// Drift guard: only final gate reasons reach the reason map. Missing-cluster
// and parse are classified by earlier stage checks and have real seam tests
// below. A new LEAD_* reason must not silently degrade to generic GATE.
test('every final composer gate reason maps to a code of its own', () => {
  const finalGateReasons = Object.entries(BRIEF_REJECTIONS)
    .filter(([name]) => name.startsWith('LEAD_'))
    .map(([, reason]) => reason);
  for (const reason of [...finalGateReasons, INSIGHTS_COMPOSER_THREW]) {
    const code = classifyInsightsSynthesisFailure({
      hasBriefCluster: true,
      synthesisResult: { text: 'raw' },
      parsedSynthesis: { lead: 'parsed' },
      gateReason: reason,
    });
    assert.notEqual(
      code,
      INSIGHTS_SYNTHESIS_FAILURE_CODES.GATE,
      `${reason} degrades to the opaque GATE bucket — add it to INSIGHTS_GATE_REASON_CODES`,
    );
    assert.ok(
      Object.values(INSIGHTS_SYNTHESIS_FAILURE_CODES).includes(code),
      `${reason} must map inside the bounded vocabulary, got ${code}`,
    );
  }
});

test('an absent or unrecognized gate reason still lands on the generic gate code', () => {
  const gateStage = (gateReason) => classifyInsightsSynthesisFailure({
    hasBriefCluster: true,
    synthesisResult: { text: 'raw' },
    parsedSynthesis: { lead: 'parsed' },
    gateReason,
  });

  // A caller that predates the reason seam passes nothing and must keep the
  // behavior it had.
  assert.equal(gateStage(undefined), INSIGHTS_SYNTHESIS_FAILURE_CODES.GATE);
  assert.equal(gateStage(null), INSIGHTS_SYNTHESIS_FAILURE_CODES.GATE);
  // A reason a future composer emits but this map does not know must fall into
  // the vocabulary's residual bucket, never leak through as a raw string.
  assert.equal(gateStage('some-gate-added-later'), INSIGHTS_SYNTHESIS_FAILURE_CODES.GATE);
  // Inherited Object keys must not answer the lookup — an object-literal map
  // would return a FUNCTION here instead of a bounded code.
  for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(gateStage(inherited), INSIGHTS_SYNTHESIS_FAILURE_CODES.GATE, `${inherited} must not resolve`);
  }
});

test('a gate reason never overrides an earlier failure stage', () => {
  // The composer reports one reason per run, and MISSING_CLUSTER/PROVIDER/PARSE
  // are decided BEFORE the gate arm. A reason that reached the classifier out
  // of stage order must not relabel a provider outage as an editorial gate.
  assert.equal(
    classifyInsightsSynthesisFailure({ hasBriefCluster: false, gateReason: BRIEF_REJECTIONS.LEAD_UNCITED }),
    INSIGHTS_SYNTHESIS_FAILURE_CODES.MISSING_CLUSTER,
  );
  assert.equal(
    classifyInsightsSynthesisFailure({ hasBriefCluster: true, gateReason: BRIEF_REJECTIONS.LEAD_UNCITED }),
    INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER,
  );
  assert.equal(
    classifyInsightsSynthesisFailure({
      hasBriefCluster: true,
      synthesisResult: { text: 'raw' },
      gateReason: BRIEF_REJECTIONS.LEAD_UNCITED,
    }),
    INSIGHTS_SYNTHESIS_FAILURE_CODES.PARSE,
  );
  // And a composed brief is still a success no matter what a reason claims.
  assert.equal(
    classifyInsightsSynthesisFailure({
      hasBriefCluster: true,
      synthesisResult: { text: 'raw' },
      parsedSynthesis: { lead: 'parsed' },
      composed: { lead: 'published' },
      gateReason: BRIEF_REJECTIONS.LEAD_UNCITED,
    }),
    null,
  );
});

test('the specific gate code survives the run-meta to seed-meta seam', () => {
  // buildInsightsFreshnessMetaPatch normalizes an unrecognized code to
  // PROVIDER, so a code the seeder emits but never registered would be
  // silently relabelled a provider outage on the way to Redis.
  const rejected = decorateInsightsRun(
    { status: 'ok', generatedAt: OLD_GENERATED_AT, topStories: [{ primaryTitle: 'lkg' }] },
    { outcome: 'lkg_preserved', failureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_PROPER_NOUN },
  );
  const patch = buildInsightsFreshnessMetaPatch(
    insightsFreshnessPatchArgs(rejected, 'lkg_preserved', { consecutiveFailures: 4 }, 1_754_000_120_000),
  );
  assert.equal(patch.lastSynthesisFailureCode, INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_PROPER_NOUN);
  assert.equal(patch.consecutiveFailures, 5);
  assert.equal(patch.servedGeneratedAt, OLD_GENERATED_AT);
});

// Health is the SECOND source of truth for this vocabulary, and it drops an
// unmatched code SILENTLY — the seeder would keep writing the reason while
// /api/health reported a failing insights seed with no reason at all. The
// market-implications key already has this guard; insights did not.
test('every failure code the seeder emits is accepted by health', () => {
  const { failureCodePattern } = healthTesting.SEED_META.newsInsights.synthesisFailure;
  for (const code of Object.values(INSIGHTS_SYNTHESIS_FAILURE_CODES)) {
    assert.ok(failureCodePattern.test(code), `health would silently drop the seeder's ${code}`);
  }
});

test('health does not admit a code from a sibling producer', () => {
  // The vocabulary is per-key. A pattern loose enough to swallow another
  // seeder's codes would report a foreign failure under newsInsights.
  const { failureCodePattern } = healthTesting.SEED_META.newsInsights.synthesisFailure;
  for (const foreign of [
    'MARKET_IMPLICATIONS_LLM_NO_RESPONSE',
    'INSIGHTS_SYNTHESIS_',
    'INSIGHTS_SYNTHESIS_LEAD_',
    'INSIGHTS_SYNTHESIS_SOMETHING_ELSE',
    'XINSIGHTS_SYNTHESIS_GATEX',
    // The reverse direction: the pattern must not carry an arm for a LEAD_*
    // code the seeder cannot produce, or health would advertise a diagnosis
    // that never arrives.
    'INSIGHTS_SYNTHESIS_LEAD_TONE',
    'INSIGHTS_SYNTHESIS_LEAD',
  ]) {
    assert.equal(failureCodePattern.test(foreign), false, `${foreign} must not be accepted as an insights code`);
  }
});

// The seam that carries a composer rejection all the way to the failure code
// used to live in a closure inside fetchInsights, reachable only by a regex
// over the seeder's source text — a guard that stays green when the wiring is
// moved into a comment or a dead branch. These drive the real exported seam.
const SEAM_STORY = {
  primaryTitle: 'Regional apple prices rose sharply in Chile last quarter, growers say',
  primarySource: 'Reuters',
  primaryLink: 'http://apple',
  sources: ['Reuters', 'AP News'],
  memberTitles: ['Regional apple prices rose sharply in Chile last quarter, growers say'],
};
const seamText = (lead) => JSON.stringify({
  lead,
  lines: [{ n: 1, text: 'Regional apple prices rose sharply in Chile [1]' }],
});

test('composeInsightsSynthesis preserves implicit brief-cluster selection', () => {
  const result = composeInsightsSynthesis(
    seamText('Prices rose sharply in Chile last quarter [1].'),
    [SEAM_STORY],
  );
  assert.equal(result.rejection, null);
  assert.ok(result.brief, 'an eligible corpus must compose when briefCluster is omitted');
});

test('the composer rejection reason reaches the failure code through the real seam', () => {
  const resolve = (lead) => resolveInsightsSynthesis({
    synthesisResult: { text: seamText(lead), provider: 'openrouter', model: 'test' },
    topStories: [SEAM_STORY],
    briefCluster: SEAM_STORY,
    validatorMode: 'enforce',
  });

  const published = resolve('Prices rose sharply in Chile last quarter [1].');
  assert.equal(published.failureCode, null, 'a composable brief has no failure code');
  assert.ok(published.composed, 'and the composed brief is returned');

  assert.equal(
    resolve('Prices rose sharply in Venezuela last quarter [1].').failureCode,
    INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_PROPER_NOUN,
  );
  assert.equal(
    resolve('Prices rose sharply in Chile by 42 percent last quarter [1].').failureCode,
    INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_NUMERIC_FACT,
  );
  assert.equal(
    resolve('Prices rose sharply in Chile last quarter [1]. Analysts expect more ahead.').failureCode,
    INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_UNCITED,
  );
  assert.equal(
    resolve('Growers reported a sharp rise in seasonal fruit costs across the region last quarter [1].').failureCode,
    INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_GROUNDING,
  );
});

test('the seam classifies an unparseable response as PARSE, not as a gate', () => {
  const { composed, failureCode } = resolveInsightsSynthesis({
    synthesisResult: { text: 'not parseable at all', provider: 'groq', model: 'test' },
    topStories: [SEAM_STORY],
    briefCluster: SEAM_STORY,
    validatorMode: 'enforce',
  });
  assert.equal(composed, null);
  assert.equal(failureCode, INSIGHTS_SYNTHESIS_FAILURE_CODES.PARSE);
});

test('the seam reports a provider outage when no candidate came back at all', () => {
  const { composed, failureCode } = resolveInsightsSynthesis({
    synthesisResult: null,
    topStories: [SEAM_STORY],
    briefCluster: SEAM_STORY,
  });
  assert.equal(composed, null);
  assert.equal(failureCode, INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER);
});

test('the seam reports MISSING_CLUSTER when nothing corroborated was selected', () => {
  const { failureCode } = resolveInsightsSynthesis({
    synthesisResult: { text: seamText('Prices rose sharply in Chile last quarter [1].') },
    topStories: [SEAM_STORY],
    briefCluster: null,
  });
  assert.equal(failureCode, INSIGHTS_SYNTHESIS_FAILURE_CODES.MISSING_CLUSTER);
});

// A composer throw is OUR defect, not rejected content, and it must not escape:
// an uncaught throw here reaches runSeed's withRetry and re-runs the whole
// digest read plus LLM chain until the seed lock expires.
test('a throwing composer is contained and reported as COMPOSER_ERROR', () => {
  let reads = 0;
  const exploding = {
    sources: ['Reuters', 'AP News'],
    memberTitles: [],
    get primaryTitle() {
      reads += 1;
      throw new Error('composer boom');
    },
  };
  const { composed, failureCode } = resolveInsightsSynthesis({
    synthesisResult: { text: seamText('Prices rose sharply in Chile last quarter [1].') },
    topStories: [exploding],
    briefCluster: exploding,
    validatorMode: 'enforce',
  });
  assert.ok(reads > 0, 'the fixture must actually reach the composer to prove containment');
  assert.equal(composed, null);
  assert.equal(failureCode, INSIGHTS_SYNTHESIS_FAILURE_CODES.COMPOSER_ERROR);
});

test('hostile non-Error throws cannot escape through diagnostic formatting', () => {
  const hostileMessage = Object.defineProperty({}, 'message', {
    get() {
      throw new Error('message getter must not run');
    },
  });
  for (const thrown of [Symbol('composer boom'), hostileMessage]) {
    const exploding = {
      sources: ['Reuters', 'AP News'],
      memberTitles: [],
      get primaryTitle() {
        throw thrown;
      },
    };
    assert.doesNotThrow(() => {
      const { failureCode } = resolveInsightsSynthesis({
        synthesisResult: { text: seamText('Prices rose sharply in Chile last quarter [1].') },
        topStories: [exploding],
        briefCluster: exploding,
        validatorMode: 'enforce',
      });
      assert.equal(failureCode, INSIGHTS_SYNTHESIS_FAILURE_CODES.COMPOSER_ERROR);
    });
  }
});

test('composeInsightsSynthesis honors shadow mode — the incident kill switch still ships', () => {
  // BRIEF_VALIDATOR_MODE=shadow is the documented way to stop enforcing during
  // an incident. The reason split rewrote exactly that branch, so prove shadow
  // still publishes a lead the enforce path rejects.
  //
  // The lead KEEPS "Chile" on purpose: checkLeadGrounding is deliberately not
  // gated by validatorMode — it is the anchor floor that applies in both modes
  // — so a fixture that dropped the anchor would be rejected in shadow too and
  // prove nothing about the proper-noun branch under test.
  const hallucinated = seamText('Prices rose sharply in Chile and Venezuela last quarter [1].');
  const enforced = composeInsightsSynthesis(hallucinated, [SEAM_STORY], {
    briefCluster: SEAM_STORY,
    validatorMode: 'enforce',
  });
  assert.equal(enforced.brief, null);
  assert.equal(enforced.rejection, 'lead-proper-noun');

  const shadowed = composeInsightsSynthesis(hallucinated, [SEAM_STORY], {
    briefCluster: SEAM_STORY,
    validatorMode: 'shadow',
  });
  assert.equal(shadowed.rejection, null, 'shadow mode observes without rejecting');
  assert.ok(shadowed.brief, 'and still returns a publishable brief');

  // Enforce is the DEFAULT: omitting validatorMode must behave like enforce,
  // not silently fall through to shadow. (Previously pinned only by a regex
  // over the seeder's source text.)
  const defaulted = composeInsightsSynthesis(hallucinated, [SEAM_STORY], { briefCluster: SEAM_STORY });
  assert.equal(defaulted.brief, null, 'the default mode must enforce');
  assert.equal(defaulted.rejection, 'lead-proper-noun');
});

test('the composer-threw sentinel cannot collide with a composer rejection reason', () => {
  // INSIGHTS_COMPOSER_THREW is synthesized by the seeder, not returned by the
  // composer, so it lives outside BRIEF_REJECTIONS. If a future BRIEF_REJECTIONS
  // value reused the literal it would silently overwrite the map row.
  assert.equal(
    Object.values(BRIEF_REJECTIONS).includes(INSIGHTS_COMPOSER_THREW),
    false,
    'the sentinel must stay distinct from every composer rejection reason',
  );
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
