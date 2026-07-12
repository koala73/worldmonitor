// Pure funnel-diversity guardrail for the forecast generator (Phase 0 / #5233).
//
// The verification pipeline can only measure real skill if the PUBLISHED funnel
// is diverse and not dominated by synthetic count-padding. This assesses a
// published prediction set and flags a "collapsed" funnel — too few distinct
// domains, or too high a synthetic share — so the generator can WARN and a
// health check can surface it. Pure + injected: no wall-clock, no I/O.

import { SYNTHETIC_GENERATION_ORIGINS, SHADOW_GENERATION_ORIGINS } from './_forecast-scorecard.mjs';

export const DEFAULT_MIN_DISTINCT_DOMAINS = 4;
export const DEFAULT_MAX_SYNTHETIC_SHARE = 0.5;
// Origins that are NOT real user-facing coverage: synthetic count-padding
// (state_derived) AND unpromoted shadow bets (bet_engine). Kept in lock-step
// with the scorecard's skill-Brier exclusion set so a bet_engine-heavy funnel
// can't read "diverse/healthy" here while skill.count stays near zero there.
export const NON_REAL_FUNNEL_ORIGINS = [...SYNTHETIC_GENERATION_ORIGINS, ...SHADOW_GENERATION_ORIGINS];

export function assessFunnelDiversity(predictions, options = {}) {
  const minDistinctDomains = options.minDistinctDomains ?? DEFAULT_MIN_DISTINCT_DOMAINS;
  const maxSyntheticShare = options.maxSyntheticShare ?? DEFAULT_MAX_SYNTHETIC_SHARE;
  const syntheticOrigins = new Set(options.syntheticOrigins ?? NON_REAL_FUNNEL_ORIGINS);

  const list = Array.isArray(predictions) ? predictions.filter(Boolean) : [];
  const total = list.length;
  const domains = new Set();
  let syntheticCount = 0;
  for (const pred of list) {
    if (pred.domain) domains.add(pred.domain);
    const origin = pred.generationOrigin || 'legacy_detector';
    if (syntheticOrigins.has(origin)) syntheticCount++;
  }

  const domainCount = domains.size;
  const syntheticShare = total ? syntheticCount / total : 0;

  const reasons = [];
  if (total > 0 && domainCount < minDistinctDomains) {
    reasons.push(`only ${domainCount} distinct domain(s) (min ${minDistinctDomains})`);
  }
  if (total > 0 && syntheticShare > maxSyntheticShare) {
    reasons.push(`synthetic share ${round(syntheticShare)} exceeds ${maxSyntheticShare}`);
  }
  // An empty set is never "collapsed" — an empty/failed run is a different
  // failure surfaced by seed-meta freshness, not a funnel-diversity problem.
  const collapsed = reasons.length > 0;

  return {
    total,
    domainCount,
    domains: [...domains].sort(),
    syntheticCount,
    syntheticShare: round(syntheticShare),
    minDistinctDomains,
    maxSyntheticShare,
    collapsed,
    reasons,
  };
}

function round(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1_000_000) / 1_000_000;
}
