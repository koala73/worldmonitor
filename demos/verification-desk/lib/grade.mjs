// "Grade a headline": the five checks, run in order and emitted one at a time
// so the stage can reveal each step as the anchor reaches it.

import { attributionCascade, checkFigures, heuristicSearchTerms, overlapScore } from './text.mjs';
import { computeVerdict, gateJudge, MATCH_THRESHOLD } from './verdict.mjs';

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
 * One event can land in several digest clusters: on 2026-10-09 the Trump/Putin
 * diesel deal sat in 8 clusters, each a lone outlet (BBC, FT, CNBC, NBC, ...),
 * so every cluster read "single-publisher". Counting only the best cluster
 * would call the day's most-corroborated story single-source. Merge every
 * cluster that matches the headline AND the best cluster, then count distinct
 * publisher families across all of them.
 */
export function mergeSiblings(headline, best, clusters) {
  const siblings = clusters.filter((c) => c !== best
    && overlapScore(headline, c.title) >= MATCH_THRESHOLD
    && Math.max(overlapScore(best.title, c.title), overlapScore(c.title, best.title)) >= 0.3);
  const titleSource = (c) => ({ publisher: c.publishers?.[0]?.name ?? c.primarySource ?? 'unknown', text: c.title });
  if (!siblings.length) return { ...best, mergedClusters: 1, bySource: [titleSource(best)] };
  const all = [best, ...siblings];
  const byName = new Map();
  for (const c of all) {
    for (const p of c.publishers ?? []) {
      const prev = byName.get(p.name);
      if (!prev) byName.set(p.name, { ...p, labels: [...(p.labels ?? [])] });
      else {
        for (const l of p.labels ?? []) if (!prev.labels.includes(l)) prev.labels.push(l);
        if (p.tier != null && (prev.tier == null || p.tier < prev.tier)) prev.tier = p.tier;
      }
    }
  }
  const publishers = [...byName.values()].sort((a, b) => (a.tier ?? 5) - (b.tier ?? 5) || a.name.localeCompare(b.name));
  const families = Math.max(publishers.length, ...all.map((c) => c.corroboration?.publishers ?? 0));
  const state = families === 0 ? 'unknown'
    : families === 1 ? 'single-publisher'
      : publishers.length && publishers.every((p) => p.tier === 4) && families === publishers.length ? 'tier4-only' : 'corroborated';
  const times = (k) => all.map((c) => c[k]).filter(Boolean).sort();
  return {
    ...best,
    publishers,
    publishersUnlisted: Math.max(0, families - publishers.length),
    corroboration: { state, publishers: families },
    sources: [...new Set(all.flatMap((c) => c.sources ?? []))],
    memberCount: all.reduce((n, c) => n + (c.memberCount ?? 1), 0),
    memberTitles: [...new Set(all.flatMap((c) => c.memberTitles?.length ? c.memberTitles : [c.title]))],
    firstSeen: times('firstSeen')[0] ?? best.firstSeen,
    lastUpdated: times('lastUpdated').at(-1) ?? best.lastUpdated,
    mergedClusters: all.length,
    bySource: all.map(titleSource),
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

  // 0. Find the story.
  const terms = await anchor.searchTerms(headline, heuristicSearchTerms(headline));
  const search = await source.searchClusters(terms);
  const best = bestMatch(headline, search.clusters);
  const matched = best && best.score >= MATCH_THRESHOLD ? best.cluster : null;
  result.terms = terms;
  result.match = matched
    ? { id: matched.id, title: matched.title, link: matched.link, score: Math.round(best.score * 100) / 100, seenIn: matched.seenIn ?? null }
    : null;
  const story = matched ? mergeSiblings(headline, matched, search.clusters) : null;
  if (result.match) result.match.mergedClusters = story.mergedClusters;
  result.closest = !matched && best ? { title: best.cluster.title, score: Math.round(best.score * 100) / 100 } : null;
  yield { step: 'match', data: { terms, match: result.match, closest: result.closest, candidates: search.clusters.length, failures: search.failures ?? [] } };

  const detail = story ? await source.storyDetail(story, terms[0]) : null;
  const memberTitles = story ? [...new Set([...(detail?.memberTitles ?? []), ...(story.memberTitles ?? [story.title])])] : [];

  // 1. Who said it? Publisher families, never feed labels.
  result.who = story
    ? {
      families: story.corroboration?.publishers ?? story.distinctSourceCount ?? null,
      state: story.corroboration?.state ?? 'unknown',
      publishers: story.publishers,
      publishersUnlisted: story.publishersUnlisted,
      feedLabels: story.sources,
      memberCount: story.memberCount,
      seederCorroboration: detail?.corroborationSourceCount ?? null,
      entityCorroboration: detail?.entityCorroboration ?? null,
    }
    : null;
  yield { step: 'who', data: result.who };

  // 2. When did it first appear, and who leans on whom?
  const cascade = attributionCascade(memberTitles);
  result.when = story
    ? {
      firstSeen: story.firstSeen,
      lastUpdated: story.lastUpdated,
      spreadHours: hoursBetween(story.firstSeen, story.lastUpdated),
      primarySource: story.primarySource,
      cascade,
      memberTitles: memberTitles.slice(0, 12),
    }
    : null;
  yield { step: 'when', data: result.when };

  // 3. Does the number exist in the sourced text?
  const article = story?.link ? await source.articleText(story.link) : null;
  const evidenceText = [...memberTitles, article ?? ''].join('\n');
  const bySource = story ? [...(story.bySource ?? []), ...(article ? [{ publisher: story.publishers?.[0]?.name ?? story.primarySource, text: article }] : [])] : [];
  const figures = story ? checkFigures(headline, evidenceText, bySource) : [];
  result.numbers = { figures, evidence: article ? 'article text + member headlines' : 'member headlines only', articleChars: article?.length ?? 0 };
  yield { step: 'numbers', data: result.numbers };

  // 4. What is money saying?
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

  // 5. Verdict, from counts. The model's contradiction call must quote the evidence verbatim.
  const judge = story ? gateJudge(await anchor.judge(headline, evidenceText), evidenceText) : null;
  result.judge = judge;
  const sourcesUnreachable = (search.failures?.length ?? 0) > 0 && search.failures.length >= terms.length;
  result.verdict = computeVerdict({ match: story ? { score: best.score } : null, corroboration: story?.corroboration ?? null, figures, judge, sourcesUnreachable });
  yield { step: 'verdict', data: { ...result.verdict, judge } };

  result.script = await anchor.narrateGrade(result);
  yield { step: 'script', data: { text: result.script } };
  yield { step: 'done', data: result };
}

export async function gradeToResult(headline, deps) {
  let final = null;
  for await (const ev of gradeHeadline(headline, deps)) if (ev.step === 'done') final = ev.data;
  return final;
}
