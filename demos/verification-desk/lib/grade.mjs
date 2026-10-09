// "Grade a headline". The desk finds which WorldMonitor story the audience
// means (retrieval); every judgment after that is WorldMonitor's (lib/wm.mjs).
// Checks are emitted one at a time so the stage reveals each as the anchor
// reaches it.

import { heuristicSearchTerms, overlapScore } from './text.mjs';
import { computeVerdict, MATCH_THRESHOLD } from './verdict.mjs';
import { coverage, credibilityBand, groundFigures, ratePublishers, rosterSummary, sourceCredibility } from './wm.mjs';

function hoursBetween(a, b) {
  const d = (Date.parse(b) - Date.parse(a)) / 3_600_000;
  return Number.isFinite(d) && d >= 0 ? Math.round(d * 10) / 10 : null;
}

function bestMatch(headline, clusters) {
  let best = null;
  for (const c of clusters) {
    const text = `${c.title} ${(c.topKeywords ?? []).join(' ')} ${(c.memberTitles ?? []).join(' ')}`;
    const score = Math.max(overlapScore(headline, c.title), overlapScore(headline, text) * 0.9);
    // Ties go to the wider story: the audience means the one everyone saw.
    if (!best || score > best.score + 0.02 || (Math.abs(score - best.score) <= 0.02 && (c.distinctSourceCount ?? 0) > (best.cluster.distinctSourceCount ?? 0))) {
      best = { score, cluster: c };
    }
  }
  return best;
}

/**
 * Retrieval, not grading. One event can land in several digest clusters: on
 * 2026-10-09 the Trump/Putin diesel deal sat in 8 clusters, each a lone outlet,
 * so each cluster alone read "single-publisher". The desk gathers every
 * cluster that matches the headline and the best cluster, then hands all of
 * their feed labels to WorldMonitor's assessCorroboration in one evidence
 * set, with the highest digest-reported count as the floor (the same way
 * evidenceFromCluster takes the max).
 */
export function gatherStory(headline, best, clusters) {
  const siblings = clusters.filter((c) => c !== best
    && overlapScore(headline, c.title) >= MATCH_THRESHOLD
    && Math.max(overlapScore(best.title, c.title), overlapScore(c.title, best.title)) >= 0.3);
  const all = [best, ...siblings];
  const labels = [...new Set(all.flatMap((c) => [...(c.sources ?? []), ...(c.publishers ?? []).flatMap((p) => p.labels ?? [])]))];
  const reported = Math.max(0, ...all.map((c) => c.corroboration?.publishers ?? 0)) || null;
  const times = (k) => all.map((c) => c[k]).filter(Boolean).sort();
  return {
    ...best,
    labels,
    reported,
    clusters: all,
    memberTitles: [...new Set(all.flatMap((c) => (c.memberTitles?.length ? c.memberTitles : [c.title])))],
    firstSeen: times('firstSeen')[0] ?? best.firstSeen,
    lastUpdated: times('lastUpdated').at(-1) ?? best.lastUpdated,
    // One text per cluster, credited to that cluster's lead publisher.
    bySource: all.map((c) => ({ publisher: c.publishers?.[0]?.name ?? c.primarySource ?? 'unknown', text: c.title })),
  };
}

function marketRelevance(headline, terms, market) {
  const base = overlapScore(headline, market.title);
  const termHit = terms.some((t) => market.title.toLowerCase().includes(t.toLowerCase())) ? 0.25 : 0;
  return base + termHit;
}

/**
 * @param {string} headline
 * @param {{source:object, anchor:object}} deps
 * @yields {{step:string, data:object}}
 */
export async function* gradeHeadline(headline, { source, anchor }) {
  const result = { headline, startedAt: new Date().toISOString(), sourceKind: source.kind };

  // 0. Find the story (retrieval).
  const terms = await anchor.searchTerms(headline, heuristicSearchTerms(headline));
  const search = await source.searchClusters(terms);
  const best = bestMatch(headline, search.clusters);
  const matched = best && best.score >= MATCH_THRESHOLD ? best.cluster : null;
  const story = matched ? gatherStory(headline, matched, search.clusters) : null;
  result.terms = terms;
  result.match = story
    ? { id: story.id, title: story.title, link: story.link, score: Math.round(best.score * 100) / 100, seenIn: story.seenIn ?? null, mergedClusters: story.clusters.length }
    : null;
  result.closest = !matched && best ? { title: best.cluster.title, score: Math.round(best.score * 100) / 100 } : null;
  yield { step: 'match', data: { terms, match: result.match, closest: result.closest, candidates: search.clusters.length, failures: search.failures ?? [] } };

  const detail = story ? await source.storyDetail(story, terms[0]) : null;
  const memberTitles = story ? [...new Set([...(detail?.memberTitles ?? []), ...story.memberTitles])] : [];

  // 1. Who said it? WorldMonitor's coverage verdict, publisher roster and source ratings.
  let cov = null;
  let rated = [];
  let credibility = null;
  if (story) {
    cov = coverage(story.labels, story.reported);
    const count = cov.verdict.publishers ?? 1;
    rated = ratePublishers(cov.roster, count);
    // One cluster: the credibility WorldMonitor already computed for it. Several:
    // the same formula over the gathered evidence, led by the best-rated source.
    const own = story.clusters.length === 1 && Number.isFinite(story.credibilityScore) ? story.credibilityScore : null;
    const lead = rated[0];
    const score = own ?? (lead ? sourceCredibility(lead.labels[0] ?? lead.name, count) : null);
    credibility = score == null ? null : { score: Math.round(score), band: credibilityBand(score), source: own != null ? story.primarySource : lead.name };
  }
  result.who = story
    ? {
      coverage: cov.verdict,
      summary: rosterSummary(cov.verdict, rated),
      rated,
      unlisted: Math.max(0, (cov.verdict.publishers ?? 0) - rated.length),
      credibility,
      feedLabels: story.labels,
      memberCount: story.clusters.reduce((n, c) => n + (c.memberCount ?? 1), 0),
      seeder: detail && (detail.entityCorroboration != null || detail.corroborationSourceCount != null)
        ? { entityCorroboration: detail.entityCorroboration ?? null, corroborationSourceCount: detail.corroborationSourceCount ?? null }
        : null,
    }
    : null;
  yield { step: 'who', data: result.who };

  // 2. When did it first appear and how fast did it spread? WorldMonitor's cluster timestamps.
  result.when = story
    ? {
      firstSeen: story.firstSeen,
      lastUpdated: story.lastUpdated,
      spreadHours: hoursBetween(story.firstSeen, story.lastUpdated),
      primarySource: story.primarySource,
      mergedClusters: story.clusters.length,
      memberTitles: memberTitles.slice(0, 12),
    }
    : null;
  yield { step: 'when', data: result.when };

  // 3. Is every figure grounded? WorldMonitor's fact extractor and grounding gate.
  const article = story?.link ? await source.articleText(story.link) : null;
  const groundText = [...memberTitles, article ?? ''].join('\n');
  // "Stated by one publisher only" needs text from at least two publishers to mean anything.
  const bySource = story ? [...story.bySource, ...(article ? [{ publisher: rated[0]?.name ?? story.primarySource, text: article }] : [])] : [];
  const comparable = new Set(bySource.map((b) => b.publisher)).size >= 2;
  result.numbers = story
    ? { ...groundFigures(headline, groundText, comparable ? bySource : []), evidence: article ? 'article text + member headlines' : 'member headlines only' }
    : { gate: 'not-checked', facts: [], evidence: null };
  yield { step: 'numbers', data: result.numbers };

  // 4. What is money saying? WorldMonitor's prediction-market feed.
  let markets = [];
  try {
    markets = (await source.markets(terms))
      .map((m) => ({ ...m, relevance: marketRelevance(headline, terms, m) }))
      .filter((m) => m.relevance >= 0.3)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 3);
  } catch {
    markets = [];
  }
  result.money = { markets };
  yield { step: 'money', data: result.money };

  // 5. The card: WorldMonitor's judgments, arranged.
  const sourcesUnreachable = !story && (search.failures?.length ?? 0) > 0 && search.failures.length >= Math.min(terms.length, 3);
  result.verdict = computeVerdict({
    found: Boolean(story),
    sourcesUnreachable,
    coverage: cov?.verdict,
    summary: result.who?.summary ?? null,
    credibility,
    rated,
    figures: story ? result.numbers : null,
    seeder: result.who?.seeder ?? null,
  });
  yield { step: 'verdict', data: result.verdict };

  result.script = await anchor.narrateGrade(result);
  yield { step: 'script', data: { text: result.script } };
  yield { step: 'done', data: result };
}

export async function gradeToResult(headline, deps) {
  let final = null;
  for await (const ev of gradeHeadline(headline, deps)) if (ev.step === 'done') final = ev.data;
  return final;
}
