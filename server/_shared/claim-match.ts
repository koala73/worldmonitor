/**
 * Claim matching for verify_claim (#9092).
 *
 * Finds the digest clusters that report the same event as a free-text claim,
 * and checks the claim's figures against what those clusters say. It finds
 * coverage; it never grades it. The verdict comes from assessCorroboration
 * over the matched clusters, so this module adds no verdict vocabulary and
 * never says a claim is true or false.
 */
import { extractNumericFacts } from '../../shared/brief-llm-core.js';
import { clusterNewsCore } from '../../shared/news-clustering-core.js';
import type { ClusteredEventCore, NewsItemCore } from '../../shared/news-clustering-core.js';
import { computeCredibilityScore } from '../../shared/news-credibility.js';
import { getSourceProvenanceState, type SourceProvenanceState } from '../../shared/source-provenance';
import {
  assessCorroboration,
  publisherRoster,
  toCorroborationJson,
  toPublisherRosterJson,
  type ClaimEvidence,
  type CorroborationJson,
  type PublisherRosterJson,
} from './corroboration';
import { declaredSourceTier, getSourceTier, type DeclaredTier } from './source-tiers';

export const CLAIM_MAX_CHARS = 300;

/** Share of the claim's content words a headline must carry to match. */
export const CLAIM_MATCH_MIN_SCORE = 0.5;

/** A match also needs this many content words in common, so a two-word claim cannot match on one word. */
export const CLAIM_MATCH_MIN_SHARED = 2;

export const CLAIM_MATCH_MAX_CLUSTERS = 8;

export const CLAIM_CARD_MAX_HEADLINES = 10;

/** Shown with every claim card, found or not. */
export const CLAIM_CARD_CAVEAT = 'Coverage, not accuracy: this shows who reported the claim and whether they are independent, not whether it is true. Not found means not in WorldMonitor\'s current sources.';

const STOPWORDS = new Set(`a an and are as at be been but by can could did do does for from had has have he her his how
i if in into is it its just more most new news no not now of on or our out over says said say she so than that the their
them then there these they this those to up us was we were what when where which while who why will with would you your
after amid ahead against about all also any back before being between both during each few first get gets got here last
like many may might much must next off once only other own same should since some still such through under until very
week weeks year years day days today yesterday report reports reported reportedly breaking live update updates latest
claim claims claimed`.split(/\s+/));

/** Content words of a text: lowercased, accents folded, stopwords and one-letter tokens dropped. */
export function claimTokens(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]s\b/g, '')
    .split(/[^a-z0-9.%$-]+/)
    .map((token) => token.replace(/^[.$-]+|[.-]+$/g, ''))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Crude stem so "strikes" meets "strike" and "sanctioned" meets "sanction". */
function stem(token: string): string {
  return token.replace(/(ing|ed|es|s)$/, '').replace(/e$/, '');
}

/**
 * How much of the claim a headline carries: the share of the claim's distinct
 * content words found in the headline (0..1), and how many it shares. A word
 * matched only by stem counts three quarters.
 */
export function claimOverlap(claim: string, headline: string): { score: number; shared: number } {
  const wanted = [...new Set(claimTokens(claim))];
  if (wanted.length === 0) return { score: 0, shared: 0 };
  const have = new Set(claimTokens(headline));
  const haveStems = new Set([...have].map(stem).filter((s) => s.length >= 4));
  let hit = 0;
  let shared = 0;
  for (const token of wanted) {
    if (have.has(token)) {
      hit += 1;
      shared += 1;
      continue;
    }
    const s = stem(token);
    if (s.length >= 4 && haveStems.has(s)) {
      hit += 0.75;
      shared += 1;
    }
  }
  return { score: hit / wanted.length, shared };
}

export type ClaimClusterMatch<C extends ClusteredEventCore = ClusteredEventCore> = {
  readonly cluster: C;
  /** Best overlap among the cluster's primary and member headlines. */
  readonly score: number;
};

/**
 * The clusters about the claim's event, best match first. A cluster matches
 * when one of its headlines carries at least CLAIM_MATCH_MIN_SCORE of the
 * claim and CLAIM_MATCH_MIN_SHARED of its words. One event often sits in
 * several clusters, so every match is kept (up to CLAIM_MATCH_MAX_CLUSTERS).
 */
export function matchClaimToClusters<C extends ClusteredEventCore>(
  claim: string,
  clusters: readonly C[],
): ClaimClusterMatch<C>[] {
  const matches: ClaimClusterMatch<C>[] = [];
  for (const cluster of clusters) {
    let best = { score: 0, shared: 0 };
    for (const title of [cluster.primaryTitle, ...cluster.allItems.map((item) => item.title)]) {
      const overlap = claimOverlap(claim, title);
      if (overlap.score > best.score) best = overlap;
    }
    if (best.score >= CLAIM_MATCH_MIN_SCORE && best.shared >= CLAIM_MATCH_MIN_SHARED) {
      matches.push({ cluster, score: best.score });
    }
  }
  return matches
    .sort((a, b) => b.score - a.score || b.cluster.uniquePublisherCount - a.cluster.uniquePublisherCount)
    .slice(0, CLAIM_MATCH_MAX_CLUSTERS);
}

/**
 * One ClaimEvidence over every matched cluster: all their feed labels, and the
 * highest digest publisher count any member carries (the digest's
 * origin-aware count is a floor on publishers, as in evidenceFromCluster).
 */
export function evidenceFromMatches(matches: readonly ClaimClusterMatch[]): Extract<ClaimEvidence, { kind: 'grouped' }> {
  const labels: string[] = [];
  let reported: number | null = null;
  for (const { cluster } of matches) {
    for (const item of cluster.allItems) {
      labels.push(item.source);
      const count = item.corroborationCount;
      if (typeof count === 'number' && Number.isFinite(count) && count >= 1) {
        reported = Math.max(reported ?? 0, Math.floor(count));
      }
    }
  }
  return { kind: 'grouped', labels, reportedPublishers: reported };
}

export type FigureCheck = {
  /** Numbers and dates in the claim, normalized as the brief grounding gate normalizes them. */
  readonly claimed: string[];
  /** Claimed figures that appear in at least one matched headline. */
  readonly grounded: string[];
  /** Claimed figures that no matched headline carries. */
  readonly ungrounded: string[];
};

/** `number:200` -> `200`, `date:2026-10-09` -> `2026-10-09`: the figure as a reader would write it. */
function factLabel(fact: string): string {
  return fact.replace(/^(number|date):/, '');
}

/**
 * The brief grounding rule (extractNumericFacts, as validateNoHallucinatedFacts
 * uses it) applied to the claim against matched coverage. "Ungrounded" means
 * no matched headline states the figure, not that the figure is wrong.
 *
 * A date counts once, on both sides: its month, day and year are not read as
 * separate numbers, so "kills 9 on October 9" lists 9 and a headline's "Oct 9"
 * does not state it. A dated claim's short
 * `date:MM-DD` is dropped beside its full date. A full date is grounded when a
 * headline gives the same month and day, because headlines routinely omit the
 * year.
 */
export function checkClaimFigures(claim: string, coverageTexts: readonly string[]): FigureCheck {
  const facts = extractNumericFacts(claim, { dateParts: false });
  const ground = extractNumericFacts(coverageTexts.join('\n'), { dateParts: false });
  const fullDateMonthDays = new Set<string>();
  for (const fact of facts) {
    const full = fact.match(/^date:\d{4}-(\d{2}-\d{2})$/);
    if (full) fullDateMonthDays.add(`date:${full[1]}`);
  }
  const listed = [...facts].filter((fact) => !fullDateMonthDays.has(fact)).sort();
  const isGrounded = (fact: string) => {
    if (ground.has(fact)) return true;
    const full = fact.match(/^date:\d{4}-(\d{2}-\d{2})$/);
    return full !== null && ground.has(`date:${full[1]}`);
  };
  return {
    claimed: listed.map(factLabel),
    grounded: listed.filter(isGrounded).map(factLabel),
    ungrounded: listed.filter((fact) => !isGrounded(fact)).map(factLabel),
  };
}

export type ClaimCardHeadline = {
  readonly title: string;
  readonly source: string;
  readonly link: string;
  readonly publishedAt: string;
  readonly tier: DeclaredTier | null;
} & SourceProvenanceState;

/** The card's result: the coverage verdict, or not-found when nothing in the digest reports the claim. */
export type ClaimCardState = CorroborationJson['state'] | 'not-found';

export const CLAIM_CARD_STATES: readonly ClaimCardState[] = ['corroborated', 'single-publisher', 'tier4-only', 'unknown', 'not-found'];

export type ClaimCard = {
  readonly claim: string;
  readonly found: boolean;
  /** not-found when the digest was searched and no cluster reports the claim (never "false"); unknown when there was no digest to search; otherwise corroboration.state. */
  readonly state: ClaimCardState;
  readonly corroboration: CorroborationJson;
  readonly matchedClusters: number;
  readonly credibilityScore: number | null;
  readonly firstSeen: string | null;
  readonly lastUpdated: string | null;
  readonly headlines: ClaimCardHeadline[];
  readonly figures: FigureCheck;
  readonly caveat: string;
} & PublisherRosterJson;

/**
 * The evidence card for a claim over a set of digest items: the verify_claim
 * MCP tool and the /verify page both build it here, so they cannot disagree.
 * The claim is used as given (callers trim and cap it).
 */
export function buildClaimCard(claim: string, digestItems: readonly NewsItemCore[]): ClaimCard {
  const matches = claim ? matchClaimToClusters(claim, clusterNewsCore([...digestItems], getSourceTier)) : [];
  if (matches.length === 0) {
    return {
      claim,
      found: false,
      // not-found claims a search happened: with no digest items (coverage
      // unavailable) nothing was searched, so the state stays unknown.
      state: digestItems.length > 0 ? 'not-found' : 'unknown',
      corroboration: toCorroborationJson({ state: 'unknown' }),
      publishers: [],
      publishersUnlisted: 0,
      matchedClusters: 0,
      credibilityScore: null,
      firstSeen: null,
      lastUpdated: null,
      headlines: [],
      figures: checkClaimFigures(claim, []),
      caveat: CLAIM_CARD_CAVEAT,
    };
  }

  const evidence = evidenceFromMatches(matches);
  const verdict = assessCorroboration(evidence);
  const items = matches.flatMap(({ cluster }) => cluster.allItems);
  const times = items.map((item) => item.pubDate.getTime()).filter((t) => Number.isFinite(t) && t > 0);
  const top = matches[0]!.cluster;
  const seen = new Set<string>();
  const headlines: ClaimCardHeadline[] = [];
  for (const { cluster } of matches) {
    for (const item of [...cluster.allItems].sort((a, b) => getSourceTier(a.source) - getSourceTier(b.source))) {
      const key = item.link || `${item.source}|${item.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      headlines.push({
        title: item.title,
        source: item.source,
        link: item.link,
        publishedAt: item.pubDate.toISOString(),
        tier: declaredSourceTier(item.source),
        ...getSourceProvenanceState(item.source),
      });
      if (headlines.length >= CLAIM_CARD_MAX_HEADLINES) break;
    }
    if (headlines.length >= CLAIM_CARD_MAX_HEADLINES) break;
  }
  return {
    claim,
    found: true,
    state: verdict.state,
    corroboration: toCorroborationJson(verdict),
    ...toPublisherRosterJson(publisherRoster(evidence), verdict),
    matchedClusters: matches.length,
    credibilityScore: Number.isFinite(top.credibilityScore)
      ? top.credibilityScore!
      : computeCredibilityScore({
        sourceTier: getSourceTier(top.primarySource),
        propagandaRisk: getSourceProvenanceState(top.primarySource).risk,
        independentCorroborationCount: top.uniquePublisherCount,
      }),
    firstSeen: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastUpdated: times.length ? new Date(Math.max(...times)).toISOString() : null,
    headlines,
    figures: checkClaimFigures(claim, items.map((item) => item.title)),
    caveat: CLAIM_CARD_CAVEAT,
  };
}
