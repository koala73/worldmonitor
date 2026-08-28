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
const BREAKER_ELIGIBLE_CODES = new Set([
  INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_EMPTY,
  INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_UNCITED,
  INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_PROPER_NOUN,
  INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_NUMERIC_FACT,
  INSIGHTS_SYNTHESIS_FAILURE_CODES.LEAD_GROUNDING,
]);
export const INSIGHTS_BREAKER_MIN_CONSECUTIVE = 3;

// Signature over the RENDERED prompts, not their ingredients (#7255 review,
// both reviewers): the first version hashed only story titles, but the user
// prompt also renders each story's outlet label and publisher count, and the
// system prompt renders the current date — so a prompt that had actually
// changed could keep the breaker open. Hashing what the model is sent covers
// every input by construction, and the date inside the system prompt gives an
// open breaker a natural re-arm at UTC midnight: suppression can never outlive
// the day it was justified on.
export function insightsSynthesisSignature(systemPrompt, userPrompt) {
  const system = typeof systemPrompt === 'string' ? systemPrompt : '';
  const user = typeof userPrompt === 'string' ? userPrompt : '';
  if (system === '' && user === '') return null;
  return createHash('sha256').update(`${system}\u0000${user}`).digest('hex').slice(0, 12);
}

export function shouldSkipInsightsSynthesis({
  previousMeta,
  synthesisSignature,
  minConsecutive = INSIGHTS_BREAKER_MIN_CONSECUTIVE,
} = {}) {
  if (typeof synthesisSignature !== 'string' || synthesisSignature.length === 0) return false;
  const previous = previousMeta && typeof previousMeta === 'object' ? previousMeta : null;
  if (!previous) return false;
  // The PER-SIGNATURE counter, not the producer-wide consecutiveFailures
  // (#7255 review): three provider outages followed by one gate rejection
  // left the wide counter over the threshold, so the breaker opened after a
  // SINGLE matching failure. sameSignatureFailures increments only while the
  // (code, detail, signature) triple repeats exactly and resets on any change
  // — including a changed rejection detail, because a model producing a
  // DIFFERENT wrong draft is converging, and retrying it has value.
  const failures = Number.isInteger(previous.sameSignatureFailures) ? previous.sameSignatureFailures : 0;
  if (failures < minConsecutive) return false;
  const code = previous.lastSynthesisFailureCode;
  if (typeof code !== 'string' || code.length === 0) return false;
  if (!BREAKER_ELIGIBLE_CODES.has(code)) return false;
  return previous.failedStoriesSignature === synthesisSignature;
}

// Operator-facing warning for an open breaker. Uses sameSignatureFailures —
// the count that actually armed the skip — never producer-wide
// consecutiveFailures, which provider noise can inflate past the threshold
// while only three matching prompt/failure repeats opened the breaker
// (#7255 review).
export function formatInsightsBreakerOpenWarning(previousMeta) {
  const previous = previousMeta && typeof previousMeta === 'object' ? previousMeta : {};
  const code = typeof previous.lastSynthesisFailureCode === 'string'
    && previous.lastSynthesisFailureCode.length > 0
    ? previous.lastSynthesisFailureCode
    : 'unknown';
  const repeats = Number.isInteger(previous.sameSignatureFailures) && previous.sameSignatureFailures > 0
    ? previous.sameSignatureFailures
    : 0;
  return `  [brief_synthesis] breaker open: ${code} `
    + `x${repeats} on an unchanged story set — `
    + 'skipping synthesis spend until the stories change';
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
      promptScopedMembers: opts.promptScopedMembers,
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
    promptScopedMembers,
  } = options;
  const hasExplicitBriefCluster = Object.prototype.hasOwnProperty.call(options, 'briefCluster');
  const briefCluster = hasExplicitBriefCluster ? options.briefCluster : undefined;
  const composerOptions = { validatorMode, sanitizeTitle, sourceFromStory, promptScopedMembers };
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
