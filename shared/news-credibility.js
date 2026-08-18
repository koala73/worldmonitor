/**
 * Per-headline credibility score (#6597) — distinct from importanceScore.
 *
 * importanceScore answers "how newsworthy is this right now?". It mixes
 * severity, recency, and a diplomacy/flashpoint boost, so a critical RT
 * flash scores high. credibilityScore answers a different question:
 * "how much should an analyst trust this source on this story?".
 *
 * Inputs that bear on truthfulness only:
 *   - source tier (wire/gov > major outlet > specialty > aggregator)
 *   - propaganda risk from SOURCE_PROPAGANDA_RISK (fail-closed unknown)
 *   - independent corroboration count (digest story-identity / entity count)
 *
 * Third-party bias/factuality ratings (AllSides, MBFC) are reserved and
 * not currently applied — do not block scoring on them.
 *
 * Pure function. Callers look up tier and risk; this module does not
 * import JSON so it stays safe on the Vercel edge bundle and in Node tests.
 */

export const CREDIBILITY_WEIGHTS = Object.freeze({
  sourceTier: 0.30,
  propagandaRisk: 0.50,
  independentCorroboration: 0.20,
});

export const CREDIBILITY_TIER_SCORES = Object.freeze({
  1: 100,
  2: 75,
  3: 50,
  4: 25,
});

export const CREDIBILITY_RISK_SCORES = Object.freeze({
  low: 100,
  medium: 50,
  unknown: 35,
  high: 12,
});

/** High propaganda-risk (state-controlled media) cannot exceed this. */
export const CREDIBILITY_HIGH_RISK_CAP = 40;

export const CREDIBILITY_CORROBORATION_CAP = 5;
export const CREDIBILITY_CORROBORATION_PER_SOURCE = 20;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function tierScore(sourceTier) {
  const tier = clampInt(sourceTier, 4, 1, 4);
  return CREDIBILITY_TIER_SCORES[tier] ?? CREDIBILITY_TIER_SCORES[4];
}

function riskScore(propagandaRisk) {
  if (propagandaRisk === 'low' || propagandaRisk === 'medium' || propagandaRisk === 'high') {
    return CREDIBILITY_RISK_SCORES[propagandaRisk];
  }
  return CREDIBILITY_RISK_SCORES.unknown;
}

function corroborationScore(count) {
  const finite = Number.isFinite(count) ? Number(count) : 0;
  const capped = Math.min(Math.max(finite, 0), CREDIBILITY_CORROBORATION_CAP);
  return capped * CREDIBILITY_CORROBORATION_PER_SOURCE;
}

/**
 * @param {{
 *   sourceTier: number,
 *   propagandaRisk: 'low' | 'medium' | 'high' | 'unknown',
 *   independentCorroborationCount: number,
 * }} input
 * @returns {number} integer 0–100
 */
export function computeCredibilityScore(input) {
  const source = input && typeof input === 'object' ? input : {};
  const base = Math.round(
    tierScore(source.sourceTier) * CREDIBILITY_WEIGHTS.sourceTier
      + riskScore(source.propagandaRisk) * CREDIBILITY_WEIGHTS.propagandaRisk
      + corroborationScore(source.independentCorroborationCount)
        * CREDIBILITY_WEIGHTS.independentCorroboration,
  );
  const bounded = Math.min(100, Math.max(0, base));
  if (source.propagandaRisk === 'high') {
    return Math.min(bounded, CREDIBILITY_HIGH_RISK_CAP);
  }
  return bounded;
}
