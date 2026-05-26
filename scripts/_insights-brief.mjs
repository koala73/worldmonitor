// Pure helpers for the WORLD BRIEF pipeline. Split out from seed-insights.mjs
// so tests can import without triggering the top-level runSeed() call.

import { isBriefLeadEligible } from './_clustering.mjs';

/**
 * Choose which clustered story to summarize for the WORLD BRIEF.
 *
 * Returns the first entry in `topStories` with either publisher diversity
 * (`sources.length >= 2`) or entity corroboration across related clusters.
 * Callers should treat null as "publish status=degraded, no brief" — the
 * top-stories list itself is still published; only the brief paragraph is
 * suppressed.
 *
 * Why not just topStories[0]? scoreImportance() in _clustering.mjs is
 * allowed to admit single-source alerts and high-score stories into the
 * headline list, but the brief lead should only publish claims with an
 * independent reporting signal — corroboration as a hard requirement, not a
 * tiebreaker.
 */
export function pickBriefCluster(topStories) {
  if (!Array.isArray(topStories)) return null;
  return topStories.find(isBriefLeadEligible) ?? null;
}

/**
 * System prompt for the WORLD BRIEF LLM call. Kept as a pure function so tests
 * can assert its invariants (no "pick the most important" language, no
 * unconditional WHERE instruction, explicit no-invention rules).
 */
export function briefSystemPrompt(dateISO) {
  return `Current date: ${dateISO}.

Rewrite the provided headline as 2 concise sentences MAX (under 60 words total).
Rules:
- Use ONLY facts present in the headline text. Do not add names, places, dates, or context that are not explicitly in the headline.
- Do not invent proper nouns (people, organizations, countries) that are not in the headline.
- Include a location, person, or organization ONLY if it appears in the headline. If the headline has no location, do not add one.
- NEVER start with "Breaking news", "Good evening", "Tonight", or TV-style openings.
- No bullet points, no meta-commentary, no speculation beyond the headline.`;
}

export function briefUserPrompt(headline) {
  return `Headline: ${headline}\n\nRewrite as 2 sentences using only facts from this headline.`;
}
