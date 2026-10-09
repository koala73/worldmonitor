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
  result.closest = !matched && best ? { title: best.cluster.title, score: Math.round(best.score * 100) / 100 } : null;
  yield { step: 'match', data: { terms, match: result.match, closest: result.closest, candidates: search.clusters.length, failures: search.failures ?? [] } };

  const detail = matched ? await source.storyDetail(matched, terms[0]) : null;
  const memberTitles = matched ? (detail?.memberTitles?.length ? detail.memberTitles : matched.memberTitles ?? [matched.title]) : [];

  // 1. Who said it? Publisher families, never feed labels.
  result.who = matched
    ? {
      families: matched.corroboration?.publishers ?? matched.distinctSourceCount ?? null,
      state: matched.corroboration?.state ?? 'unknown',
      publishers: matched.publishers,
      publishersUnlisted: matched.publishersUnlisted,
      feedLabels: matched.sources,
      memberCount: matched.memberCount,
      seederCorroboration: detail?.corroborationSourceCount ?? null,
      entityCorroboration: detail?.entityCorroboration ?? null,
    }
    : null;
  yield { step: 'who', data: result.who };

  // 2. When did it first appear, and who leans on whom?
  const cascade = attributionCascade(memberTitles);
  result.when = matched
    ? {
      firstSeen: matched.firstSeen,
      lastUpdated: matched.lastUpdated,
      spreadHours: hoursBetween(matched.firstSeen, matched.lastUpdated),
      primarySource: matched.primarySource,
      cascade,
      memberTitles: memberTitles.slice(0, 12),
    }
    : null;
  yield { step: 'when', data: result.when };

  // 3. Does the number exist in the sourced text?
  const article = matched?.link ? await source.articleText(matched.link) : null;
  const evidenceText = [...memberTitles, article ?? ''].join('\n');
  const figures = matched ? checkFigures(headline, evidenceText) : [];
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
  const judge = matched ? gateJudge(await anchor.judge(headline, evidenceText), evidenceText) : null;
  result.judge = judge;
  const sourcesUnreachable = (search.failures?.length ?? 0) > 0 && search.failures.length >= terms.length;
  result.verdict = computeVerdict({ match: matched ? { score: best.score } : null, corroboration: matched?.corroboration ?? null, figures, judge, sourcesUnreachable });
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
