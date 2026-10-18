// The desk's only link to WorldMonitor's grading. Nothing here re-implements
// a rule: every judgment is a call into the same modules the dashboard, the
// MCP tools and the brief seeders use. If WorldMonitor changes a rule, the
// desk changes with it. Run under tsx (npm scripts do) so the TypeScript
// modules load directly from the repo.
//
//   coverage      server/_shared/corroboration.ts      assessCorroboration, publisherRoster
//   families      shared/publisher-families.js         MIN_CORROBORATING_PUBLISHERS
//   source tier   server/_shared/source-tiers.ts       getSourceTier, declaredSourceTier, TIER_MEANING
//   provenance    shared/source-provenance.ts          getSourcePropagandaRisk, getSourceProvenanceState
//   credibility   shared/news-credibility.js           computeCredibilityScore
//   figures       shared/brief-llm-core.js             extractNumericFacts, validateNoHallucinatedFacts
//   anchor script shared/brief-llm-core.js             the brief hallucination validators
//   open web      scripts/crawlable-developments.mjs   briefGroundingPublisherCount, briefGroundingGap
//   wording       src/locales/en.json                  components.corroboration.*

import { readFileSync } from 'node:fs';
import { assessCorroboration, publisherRoster, toCorroborationJson } from '../../../server/_shared/corroboration.ts';
import { declaredSourceTier, getSourceTier, TIER_MEANING } from '../../../server/_shared/source-tiers.ts';
import { getSourcePropagandaRisk, getSourceProvenanceState } from '../../../shared/source-provenance.ts';
import { computeCredibilityScore } from '../../../shared/news-credibility.js';
import { MIN_CORROBORATING_PUBLISHERS } from '../../../shared/publisher-families.js';
import {
  extractNumericFacts,
  validateNoHallucinatedFacts,
  validateNoHallucinatedProperNouns,
  validateNoHallucinatedStatusQualifiers,
} from '../../../shared/brief-llm-core.js';
import { briefGroundingGap, briefGroundingPublisherCount } from '../../../scripts/crawlable-developments.mjs';

export { MIN_CORROBORATING_PUBLISHERS, TIER_MEANING, briefGroundingGap, briefGroundingPublisherCount };

const EN = JSON.parse(readFileSync(new URL('../../../src/locales/en.json', import.meta.url), 'utf8'));
/** WorldMonitor's own UI strings for corroboration (components.corroboration in en.json). */
export const WM_TEXT = EN.components.corroboration;

/**
 * Credibility band exactly as the dashboard draws it
 * (src/components/news/source-provenance.ts renderCredibilityBadge, InsightsPanel).
 */
export function credibilityBand(score) {
  return score < 40 ? 'low' : score < 70 ? 'medium' : 'high';
}

/**
 * Per-source credibility, composed exactly as the dashboard's
 * resolveCredibilityScore (src/components/news/source-provenance.ts) does.
 * That module imports browser-only code, so its three calls are made here.
 */
export function sourceCredibility(sourceName, corroborationCount) {
  return computeCredibilityScore({
    sourceTier: getSourceTier(sourceName),
    propagandaRisk: getSourcePropagandaRisk(sourceName).risk,
    independentCorroborationCount: corroborationCount ?? 1,
  });
}

/**
 * Coverage of one story: WorldMonitor's verdict and publisher roster over the
 * feed labels of every matched cluster, with the digest's origin-aware count
 * as the reported floor (evidenceFromCluster takes the max the same way).
 */
export function coverage(labels, reportedPublishers) {
  const evidence = { kind: 'grouped', labels, reportedPublishers: reportedPublishers ?? null };
  const verdict = assessCorroboration(evidence);
  const roster = publisherRoster(evidence);
  return { verdict: toCorroborationJson(verdict), roster };
}

/** Each publisher in the roster, rated with WorldMonitor's tables. Order is the roster's: best tier first. */
export function ratePublishers(roster, corroborationCount) {
  return roster.map((p) => {
    // A family is rated by its best-scoring label, the way the roster takes its best tier.
    const scored = p.labels.map((label) => ({ label, score: sourceCredibility(label, corroborationCount) }))
      .sort((a, b) => b.score - a.score);
    const label = scored[0]?.label ?? p.name;
    const prov = getSourceProvenanceState(label);
    const declared = declaredSourceTier(label);
    return {
      name: p.name,
      labels: p.labels,
      tier: p.tier ?? declared ?? null,
      tierTitle: p.tier ? WM_TEXT[`tierTitle${p.tier}`] : WM_TEXT.tierTitleUndeclared,
      credibility: scored[0]?.score ?? sourceCredibility(p.name, corroborationCount),
      band: credibilityBand(scored[0]?.score ?? 0),
      risk: prov.risk,
      riskReviewed: prov.riskReviewed,
      type: prov.type,
      stateAffiliated: prov.stateAffiliated ?? null,
      summary: prov.summary,
    };
  });
}

/** The roster sentence the dashboard prints ("Reported by 6 publishers, including 2 tier-1"). */
export function rosterSummary(verdict, rated) {
  if (verdict.state === 'unknown') return null;
  const n = verdict.publishers;
  const publishers = (n === 1 ? WM_TEXT.rosterPublishers_one : WM_TEXT.rosterPublishers_other).replace('{{count}}', n);
  const tier1 = rated.filter((r) => r.tier === 1).length;
  return tier1
    ? WM_TEXT.rosterSummaryTier1.replace('{{publishers}}', publishers).replace('{{tier1}}', tier1)
    : WM_TEXT.rosterSummary.replace('{{publishers}}', publishers);
}

/** The flag the dashboard shows for a coverage state (src/utils/corroboration-flag.ts). */
export function coverageFlag(state) {
  if (state === 'single-publisher') return { text: WM_TEXT.singlePublisher, hint: WM_TEXT.singlePublisherHint };
  if (state === 'tier4-only') return { text: WM_TEXT.tier4Only, hint: WM_TEXT.tier4OnlyHint };
  return null;
}

/**
 * Figures in the headline against the sourced text, with the brief seeders'
 * fact extractor and grounding gate ("9" and "nine" are the same fact).
 * `bySource` ([{publisher, text}]) lists which publishers state each fact.
 */
export function groundFigures(headline, groundText, bySource = []) {
  const claimed = [...extractNumericFacts(headline)];
  const ground = extractNumericFacts(groundText);
  const gate = validateNoHallucinatedFacts(headline, groundText);
  return {
    gate: gate.ok ? 'grounded' : 'ungrounded',
    facts: claimed.map((fact) => ({
      fact,
      label: fact.replace(/^[a-z]+:/, ''),
      grounded: ground.has(fact),
      statedBy: bySource.length ? [...new Set(bySource.filter((s) => extractNumericFacts(s.text).has(fact)).map((s) => s.publisher))] : null,
    })),
  };
}

/**
 * The anchor's script must pass the same validators WorldMonitor runs on its
 * own AI briefs before it is spoken: no invented names, titles or numbers.
 */
export function validateScript(script, groundText) {
  const failures = [
    validateNoHallucinatedProperNouns(script, groundText),
    validateNoHallucinatedStatusQualifiers(script, groundText),
    validateNoHallucinatedFacts(script, groundText),
  ].flatMap((r) => (r.ok ? [] : r.hallucinated ?? ['unspecified']));
  return { ok: failures.length === 0, hallucinated: failures };
}
