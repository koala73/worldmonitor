import { createHash } from 'node:crypto';
import { isBriefLeadEligible } from './_clustering.mjs';
import {
  BRIEF_REJECTIONS,
  composeSynthesizedBriefResult,
  parseBriefSynthesis,
} from './_insights-brief.mjs';

// These codes are intentionally low-cardinality and safe to put in seed-meta,
// health responses, and logs. Never include prompt or model output text in the
// rejection diagnostic: the payload may contain sensitive intelligence.
export const INSIGHTS_SYNTHESIS_FAILURE_CODES = Object.freeze({
  PARSE: 'INSIGHTS_SYNTHESIS_PARSE',
  GATE: 'INSIGHTS_SYNTHESIS_GATE',
  MISSING_CLUSTER: 'INSIGHTS_SYNTHESIS_MISSING_CLUSTER',
  PROVIDER: 'INSIGHTS_SYNTHESIS_PROVIDER',
  LEAD_EMPTY: 'INSIGHTS_SYNTHESIS_LEAD_EMPTY',
  LEAD_UNCITED: 'INSIGHTS_SYNTHESIS_LEAD_UNCITED',
  LEAD_PROPER_NOUN: 'INSIGHTS_SYNTHESIS_LEAD_PROPER_NOUN',
  LEAD_NUMERIC_FACT: 'INSIGHTS_SYNTHESIS_LEAD_NUMERIC_FACT',
  LEAD_GROUNDING: 'INSIGHTS_SYNTHESIS_LEAD_GROUNDING',
  COMPOSER_ERROR: 'INSIGHTS_SYNTHESIS_COMPOSER_ERROR',
});

// Local sentinel for "the composer threw". The composer never returns it, so
// it stays outside the BRIEF_REJECTIONS vocabulary.
export const INSIGHTS_COMPOSER_THREW = 'composer-threw';

// ---------------------------------------------------------------- breaker ---
// Cross-cycle repeat breaker (2026-08-28). The seeder retried an identical
// failing synthesis every cycle for four hours — 25 consecutive
// LEAD_PROPER_NOUN rejections on the same phrase against the same story set,
// each burning paid provider calls to produce nothing. The resample-feedback
// and lead-repair changes make an identical repeat much rarer; this is the
// backstop for whatever residue remains: when the SAME gate failure has
// repeated against the SAME story set, skip the spend until the stories change.
//
// Deliberately narrow:
//   - PROVIDER never trips it — a transport outage is not deterministic, and
//     the chain itself varies between cycles.
//   - MISSING_CLUSTER never trips it — no LLM call happens on that path, so
//     there is no spend to save.
//   - The signature must match exactly. Any change in the top stories —
//     ordering included, since ordering changes the prompt — re-arms synthesis.
const BREAKER_INELIGIBLE_CODES = new Set([
  INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER,
  INSIGHTS_SYNTHESIS_FAILURE_CODES.MISSING_CLUSTER,
]);
export const INSIGHTS_BREAKER_MIN_CONSECUTIVE = 3;

// Order-sensitive on purpose: the prompt renders stories in order, so a
// reorder IS a different synthesis input.
export function insightsStoriesSignature(topStories) {
  if (!Array.isArray(topStories) || topStories.length === 0) return null;
  const titles = topStories.map((story) => String(story?.primaryTitle ?? ''));
  if (titles.every((title) => title === '')) return null;
  return createHash('sha256').update(titles.join('\u0000')).digest('hex').slice(0, 12);
}

export function shouldSkipInsightsSynthesis({
  previousMeta,
  storiesSignature,
  minConsecutive = INSIGHTS_BREAKER_MIN_CONSECUTIVE,
} = {}) {
  if (typeof storiesSignature !== 'string' || storiesSignature.length === 0) return false;
  const previous = previousMeta && typeof previousMeta === 'object' ? previousMeta : null;
  if (!previous) return false;
  const failures = Number.isInteger(previous.consecutiveFailures) ? previous.consecutiveFailures : 0;
  if (failures < minConsecutive) return false;
  const code = previous.lastSynthesisFailureCode;
  if (typeof code !== 'string' || code.length === 0) return false;
  if (!Object.values(INSIGHTS_SYNTHESIS_FAILURE_CODES).includes(code)) return false;
  if (BREAKER_INELIGIBLE_CODES.has(code)) return false;
  return previous.failedStoriesSignature === storiesSignature;
}

// This map refines only the final gate stage. Missing-cluster and parse
// failures are classified by the earlier stage checks below.
const INSIGHTS_GATE_REASON_CODES = new Map([
  [BRIEF_REJECTIONS.LEAD_EMPTY, INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_EMPTY],
  [BRIEF_REJECTIONS.LEAD_UNCITED, INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_UNCITED],
  [BRIEF_REJECTIONS.LEAD_PROPER_NOUN, INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_PROPER_NOUN],
  [BRIEF_REJECTIONS.LEAD_NUMERIC_FACT, INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_NUMERIC_FACT],
  [BRIEF_REJECTIONS.LEAD_GROUNDING, INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_GROUNDING],
  [INSIGHTS_COMPOSER_THREW, INSIGHTS_SYNTHESIS_FAILURE_CODES.COMPOSER_ERROR],
]);

/**
 * Classify the first failed synthesis stage. A final composer rejection can
 * refine only the gate arm and cannot relabel an earlier-stage failure.
 */
export function classifyInsightsSynthesisFailure({
  hasBriefCluster = false,
  synthesisResult = null,
  parsedSynthesis = null,
  composed = null,
  gateReason = null,
} = {}) {
  if (composed) return null;
  if (!hasBriefCluster) return INSIGHTS_SYNTHESIS_FAILURE_CODES.MISSING_CLUSTER;
  if (!synthesisResult) return INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER;
  if (!parsedSynthesis) return INSIGHTS_SYNTHESIS_FAILURE_CODES.PARSE;
  return INSIGHTS_GATE_REASON_CODES.get(gateReason) || INSIGHTS_SYNTHESIS_FAILURE_CODES.GATE;
}

function warnComposerError() {
  try {
    // Do not inspect or interpolate the thrown value. JavaScript permits any
    // value to be thrown, including Symbols and objects with hostile getters.
    console.warn('  [brief_synthesis] composer threw — treating as rejected');
  } catch {
    // Diagnostics must never defeat the composer fault boundary.
  }
}

function runInsightsComposer(text, topStories, opts = {}) {
  let parsedSynthesis = null;
  try {
    parsedSynthesis = parseBriefSynthesis(text, topStories.length);
    const composerOptions = {
      validatorMode: opts.validatorMode ?? 'enforce',
      sanitizeTitle: opts.sanitizeTitle,
      sourceFromStory: opts.sourceFromStory,
      parsedSynthesis,
    };
    // Omitting briefCluster preserves the composer's implicit scan of the
    // corpus. Passing an own property, including null/undefined, is explicit.
    if (Object.prototype.hasOwnProperty.call(opts, 'briefCluster')) {
      composerOptions.briefCluster = opts.briefCluster;
    }
    return {
      composeResult: composeSynthesizedBriefResult(text, topStories, composerOptions),
      parsedSynthesis,
    };
  } catch {
    warnComposerError();
    return {
      composeResult: { brief: null, rejection: INSIGHTS_COMPOSER_THREW },
      parsedSynthesis,
    };
  }
}

/**
 * One publishability gate for provider acceptance and final resolution.
 * Seeder-private formatting helpers are injected through opts so this module
 * stays independently testable.
 */
export function composeInsightsSynthesis(text, topStories, opts = {}) {
  return runInsightsComposer(text, topStories, opts).composeResult;
}

/**
 * Compose the provider candidate and classify the resulting bounded failure.
 */
export function resolveInsightsSynthesis(options = {}) {
  const {
    synthesisResult = null,
    topStories = [],
    validatorMode,
    sanitizeTitle,
    sourceFromStory,
  } = options;
  const hasExplicitBriefCluster = Object.prototype.hasOwnProperty.call(options, 'briefCluster');
  const briefCluster = hasExplicitBriefCluster ? options.briefCluster : undefined;
  const composerOptions = { validatorMode, sanitizeTitle, sourceFromStory };
  if (hasExplicitBriefCluster) composerOptions.briefCluster = briefCluster;

  const { composeResult, parsedSynthesis } = synthesisResult
    ? runInsightsComposer(synthesisResult.text, topStories, composerOptions)
    : { composeResult: null, parsedSynthesis: null };
  const composed = composeResult?.brief ?? null;
  const hasBriefCluster = hasExplicitBriefCluster
    ? briefCluster != null
    : Array.isArray(topStories) && topStories.some(isBriefLeadEligible);

  return {
    composed,
    parsedSynthesis,
    // What the gate rejected, when it said so. Null for every non-gate stage.
    failureDetail: composeResult?.rejectionDetail ?? null,
    failureCode: classifyInsightsSynthesisFailure({
      hasBriefCluster,
      synthesisResult,
      parsedSynthesis,
      composed,
      gateReason: composeResult?.rejection ?? null,
    }),
  };
}
