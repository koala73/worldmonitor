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
