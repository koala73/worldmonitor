// Source quality: who said it matters as much as how many said it.
//
// Each publisher is scored with WorldMonitor's own credibility formula
// (shared/news-credibility.js: tier 30%, propaganda risk 50%, state media
// capped at 40), read from the same source tables the dashboard uses
// (get_sources). The story's evidence weight then adds those scores up,
// with three rules that stop a pile of weak sources passing as proof:
//
//   1. Each publisher adds its source score ÷ 80, so a top-tier,
//      low-risk wire counts as 1.0 and an unknown blog about 0.3.
//   2. State-affiliated outlets of one country are one voice, not several:
//      RT + TASS + RT Russia count once.
//   3. Aggregators and blogs (tier 4), plus publishers WorldMonitor counted
//      but cannot name, add at most 0.5 between them, however many there are.
//
// The divisor, the cap and the band thresholds below are this desk's
// choices, shown on screen and in the README, not WorldMonitor constants.

import { computeCredibilityScore } from '../../../shared/news-credibility.js';

export const TIER_LABEL = { 1: 'Wire / official', 2: 'Major outlet', 3: 'Specialist / regional', 4: 'Aggregator / blog' };
export const MAX_SOURCE_SCORE = 80; // computeCredibilityScore with no corroboration: tier 1 (30) + low risk (50)
export const WEAK_POOL_CAP = 0.5;
export const BANDS = { strong: 1.8, moderate: 1.2, anchor: 0.85 };

export class SourceBook {
  constructor(rows = []) {
    this.byName = new Map();
    for (const [name, tier, risk, type, stateAffiliated] of rows) {
      this.byName.set(name.toLowerCase(), { name, tier, risk, type, stateAffiliated: stateAffiliated ?? null });
    }
  }

  get size() {
    return this.byName.size;
  }

  get(name) {
    return name ? this.byName.get(String(name).toLowerCase()) ?? null : null;
  }
}

/** Source-only score on WorldMonitor's scale: no corroboration term, because corroboration is what we are measuring. */
export function sourceScore(tier, risk) {
  return computeCredibilityScore({ sourceTier: tier ?? 4, propagandaRisk: risk ?? 'unknown', independentCorroborationCount: 0 });
}

/**
 * Rates one publisher. Data the MCP cluster carried wins; otherwise the
 * source book is searched by publisher name, then by each feed label, and
 * the best-rated entry is used (a family is as good as its best desk).
 */
export function ratePublisher(pub, book, provenanceByLabel = new Map()) {
  const candidates = [];
  if (pub.tier != null || pub.risk) {
    candidates.push({ name: pub.name, tier: pub.tier ?? null, risk: pub.risk ?? null, type: pub.type ?? null, stateAffiliated: pub.stateAffiliated ?? null });
  }
  for (const label of [pub.name, ...(pub.labels ?? [])]) {
    const prov = provenanceByLabel.get(label);
    const entry = book?.get(label);
    if (prov || entry) {
      candidates.push({
        name: label,
        tier: prov?.tier ?? entry?.tier ?? pub.tier ?? null,
        risk: prov?.risk ?? entry?.risk ?? null,
        type: prov?.type ?? entry?.type ?? null,
        stateAffiliated: prov?.stateAffiliated ?? entry?.stateAffiliated ?? null,
      });
    }
  }
  const scored = candidates.map((c) => ({ ...c, score: sourceScore(c.tier, c.risk) }));
  const best = scored.sort((a, b) => b.score - a.score)[0];
  if (!best) {
    const score = sourceScore(null, null);
    return { name: pub.name, tier: null, risk: 'unknown', type: null, stateAffiliated: null, rated: false, score, weight: round2(score / MAX_SOURCE_SCORE) };
  }
  // A missing risk on the winning row may still be known from another row of the same family.
  const risk = best.risk ?? scored.find((c) => c.risk)?.risk ?? 'unknown';
  const stateAffiliated = best.stateAffiliated ?? scored.find((c) => c.stateAffiliated)?.stateAffiliated ?? null;
  const score = sourceScore(best.tier, risk);
  return { name: pub.name, tier: best.tier, risk, type: best.type, stateAffiliated, rated: true, score, weight: round2(score / MAX_SOURCE_SCORE) };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param {ReturnType<typeof ratePublisher>[]} rated
 * @param {number} unlisted publishers WorldMonitor counted but did not name
 */
export function evidenceStrength(rated, unlisted = 0) {
  const voices = new Map();
  for (const r of rated) {
    const key = r.stateAffiliated ? `state:${r.stateAffiliated}` : `pub:${r.name}`;
    const v = voices.get(key) ?? { key, label: r.stateAffiliated ? `${r.stateAffiliated} state media` : r.name, members: [], weight: 0, tier: r.tier };
    v.members.push(r.name);
    if (r.weight > v.weight) { v.weight = r.weight; v.tier = r.tier; }
    voices.set(key, v);
  }
  let strong = 0;
  let weakPool = 0;
  for (const v of voices.values()) {
    if (v.tier === 4) weakPool += v.weight;
    else strong += v.weight;
  }
  weakPool += unlisted * round2(sourceScore(4, 'unknown') / MAX_SOURCE_SCORE);
  const capped = weakPool > WEAK_POOL_CAP;
  const weight = round2(strong + Math.min(weakPool, WEAK_POOL_CAP));
  const best = Math.max(0, ...rated.map((r) => r.weight));
  const band = weight >= BANDS.strong && best >= BANDS.anchor ? 'strong' : weight >= BANDS.moderate ? 'moderate' : 'weak';
  const collapsed = [...voices.values()].filter((v) => v.members.length > 1).map((v) => ({ voice: v.label, members: v.members }));
  return { headcount: rated.length + unlisted, voices: voices.size + (unlisted ? 1 : 0), weight, band, bestSource: best, weakPoolCapped: capped, collapsed };
}

/** Rates and ranks a story's publishers, best first. */
export function assessSources(story, book) {
  const provenanceByLabel = new Map((story.sourceProvenance ?? []).map((p) => [p.source, p]));
  const rated = (story.publishers ?? []).map((p) => ratePublisher(p, book, provenanceByLabel)).sort((a, b) => b.weight - a.weight);
  return { rated, strength: evidenceStrength(rated, story.publishersUnlisted ?? 0) };
}
