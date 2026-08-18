/**
 * Types for shared/news-credibility.js — per-headline credibility score (#6597).
 * Distinct from importanceScore. See the .js module doc for the formula.
 */

export type PropagandaRisk = 'low' | 'medium' | 'high' | 'unknown';

export const CREDIBILITY_WEIGHTS: {
  readonly sourceTier: 0.30;
  readonly propagandaRisk: 0.50;
  readonly independentCorroboration: 0.20;
};

export const CREDIBILITY_TIER_SCORES: {
  readonly 1: 100;
  readonly 2: 75;
  readonly 3: 50;
  readonly 4: 25;
};

export const CREDIBILITY_RISK_SCORES: {
  readonly low: 100;
  readonly medium: 50;
  readonly unknown: 35;
  readonly high: 12;
};

export const CREDIBILITY_HIGH_RISK_CAP: 40;
export const CREDIBILITY_CORROBORATION_CAP: 5;
export const CREDIBILITY_CORROBORATION_PER_SOURCE: 20;

export function computeCredibilityScore(input: {
  sourceTier: number;
  propagandaRisk: PropagandaRisk;
  independentCorroborationCount: number;
}): number;
