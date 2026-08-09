// Pure helpers for the WORLD BRIEF pipeline. Split out from seed-insights.mjs
// so tests can import without triggering the top-level runSeed() call.

import { isBriefLeadEligible } from './_clustering.mjs';
import {
  validateNoHallucinatedProperNouns,
  validateNoHallucinatedFacts,
  checkLeadGrounding,
  verifyCitationIndexes,
} from './shared/brief-llm-core.js';

// A dotted acronym ("U.S.", "U.N.", "D.O.J.") that is provably NOT at a sentence
// boundary, in one of two shapes:
//   1. followed by a lowercase word — sentences start with a capital;
//   2. followed by its own citation run that CLOSES the sentence — "[5]." or
//      "[1][2]!" or a run at end-of-lead. Deliberately narrow — see the sentence
//      split in composeSynthesizedBrief for why ambiguous cases must not match.
//
// #5947: shape 2 matters because the model writes the acronym as the sentence's
// OBJECT ("...not with the U.S. [5].") whenever the story is about a country
// rather than by it. Without it the split stranded an uncited fragment and
// orphaned "[5]." into a pseudo-sentence, rejecting the brief.
//
// The trailing [.!?]|$ is load-bearing and was NOT in the first version of this
// fix. Matching a bare citation marker let "…by the U.S. [1] GCC condemned the
// strikes [2]." collapse with NO sentence terminator anywhere, so the split
// produced ONE unit citing {1,2} and each claim validated against the other's
// story — the exact #4928 misattribution the review below fails closed on.
// Requiring the run to close the sentence keeps the merge citation-neutral: the
// fragment can only ever join the citation it already owned.
const MIDSENTENCE_DOTTED_ACRONYM = /\b[A-Z]\.(?:[A-Z]\.?)+(?=\s+(?:\p{Ll}|(?:\[\d{1,3}\])+(?:[.!?]|$)))/gu;

/**
 * #5947: why a synthesized brief was rejected, as a bounded closed vocabulary.
 *
 * Every value is a fixed literal — never prompt text, model output, or the
 * offending noun — so a caller can put it straight into seed-meta, health, and
 * run logs without leaking the payload, which may carry sensitive intelligence.
 *
 * The producer previously reported one opaque `INSIGHTS_SYNTHESIS_GATE` for
 * all five editorial gates below, so a recurring rejection could only be
 * attributed by snapshotting the live digest and replaying it through an
 * offline harness — which the #6019 and #6119 investigations each had to build
 * from scratch. The reason is the signal that makes the next recurrence
 * readable from `seed-meta:news:insights` alone.
 */
export const BRIEF_REJECTIONS = Object.freeze({
  NO_TOP_STORIES: 'no-top-stories',
  MISSING_CLUSTER: 'missing-brief-cluster',
  PARSE: 'parse-failed',
  LEAD_EMPTY: 'lead-no-sentences',
  LEAD_UNCITED: 'lead-uncited',
  LEAD_PROPER_NOUN: 'lead-proper-noun',
  LEAD_NUMERIC_FACT: 'lead-numeric-fact',
  LEAD_GROUNDING: 'lead-grounding',
});

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

// ═══════════════════════════════════════════════════════════════════════════
// #4921 — top-8 synthesis. The World Brief previously narrated ONE headline;
// these builders produce a genuine synthesis: a cited lead plus one line per
// top story, in a single structured LLM call.
// ═══════════════════════════════════════════════════════════════════════════

export function synthesisSystemPrompt(dateISO) {
  return `Current date: ${dateISO}.

You are compiling the WORLD BRIEF from the numbered stories below. Respond with JSON ONLY (no markdown fences, no commentary):
{"lead": "...", "lines": [{"n": 1, "text": "..."}, ...]}

Rules:
- "lead": 2-3 sentences, under 80 words, synthesizing the most consequential 2-3 threads. Cite every claim with the bracket number of its story, e.g. [1] or [3].
- "lines": exactly one entry per numbered story, in order. Each "text" is ONE sentence under 30 words restating that story, ending with its citation [n].
- Use ONLY facts present in the numbered story text. Do not add names, places, dates, numbers, or context that are not explicitly there.
- Do not invent proper nouns (people, organizations, countries) that are not in the story text.
- Two numbered stories can describe the SAME event in different words. A lead claim may combine them, but it MUST carry the citation of EVERY story it drew from — write [3][7], not just [3]. Any name, place, or number you take from a story you did not cite counts as invented.
- Write acronyms WITHOUT periods: "US", "UN", "EU", "UK" — never "U.S.", "U.N.". A trailing period there reads as the end of a sentence.
- Refer to an actor by the name the story uses. Do not swap in a capital city, nickname, or synonym for it — write "US", not "Washington"; "Iran", not "Tehran" — unless that word is in the story text.
- NEVER start with "Breaking news", "Good evening", "Tonight", or TV-style openings.`;
}

export function synthesisUserPrompt(stories) {
  const lines = stories.map((story, i) => {
    const sources = Array.isArray(story.sources) && story.sources.length > 0
      ? story.sources.length
      : (story.sourceCount ?? 1);
    return `${i + 1}. ${story.primaryTitle} (${story.primarySource}, ${sources} source${sources === 1 ? '' : 's'})`;
  });
  return `Stories:\n${lines.join('\n')}\n\nCompile the world brief JSON.`;
}

/**
 * Tolerant parser for the synthesis JSON. Strips code fences (groq and
 * Gemini both wrap), extracts the outermost object, validates shape.
 * Returns { lead, lines: [{ n, text }] } or null — callers fall back to
 * the single-headline path on null (the brief always ships).
 */
export function parseBriefSynthesis(rawText, storyCount) {
  if (typeof rawText !== 'string' || rawText.length === 0) return null;
  const text = rawText.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  if (start === -1) return null;
  // Balanced, string-aware brace scan (#4928 external review): a stray
  // '}' in trailing prose defeated lastIndexOf-based slicing.
  let end = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const lead = typeof parsed?.lead === 'string' ? parsed.lead.trim() : '';
  if (lead.length < 40 || lead.length > 700) return null;
  const rawLines = Array.isArray(parsed?.lines) ? parsed.lines : [];
  const byIndex = new Map();
  for (const entry of rawLines) {
    const n = Number(entry?.n);
    const lineText = typeof entry?.text === 'string' ? entry.text.trim() : '';
    if (!Number.isInteger(n) || n < 1 || n > storyCount) continue;
    if (lineText.length < 15 || lineText.length > 260) continue;
    if (!byIndex.has(n)) byIndex.set(n, lineText);
  }
  // Require at least half the stories to have usable lines — below that
  // the model ignored the contract and the single-headline fallback is
  // more trustworthy. Missing lines are filled from headlines upstream.
  if (byIndex.size < Math.ceil(storyCount / 2)) return null;
  return {
    lead,
    lines: Array.from(byIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([n, lineText]) => ({ n, text: lineText })),
  };
}

/**
 * #4921/#4928: assemble the synthesized brief from a raw LLM response —
 * pure and fully unit-testable. Applies the whole contract:
 *   - parse (fence-tolerant JSON, ≥half the stories lined)
 *   - editorial gate: at least one top story must be corroborated
 *     (≥2 sources / entity corroboration) — the synthesis path must not
 *     lower the legacy corroboration bar on all-single-source days
 *   - lead: proper-noun validation against ALL story titles (enforce →
 *     reject to fallback), anchor grounding, citation-index verification
 *   - lines: per-story proper-noun enforcement (a failing line degrades
 *     to its own headline, keeping its [n] so the citation contract holds)
 *   - sources: STRICT lockstep with citation indexes — entry i is always
 *     story i+1, substituting a minimal fallback when a story lacks a
 *     usable link (never filtered, or every later [n] would shift)
 *
 * @returns {null | {
 *   lead: string;
 *   lines: Array<{ n: number; text: string }>;
 *   sources: Array<{ title: string; source: string; url: string }>;
 *   hallucinatedLines: number;
 *   strippedCitations: number;
 * }} null → caller falls back to the legacy single-headline path.
 *
 * #5947: the seeder now calls `composeSynthesizedBriefResult` below so it can
 * report WHICH gate rejected. This brief-only shape is kept because the
 * composer's decision contract is pinned through it by a large existing test
 * corpus — rewriting those call sites would churn the tests that guard #4928
 * misattribution and the acronym-boundary fixes without changing any behavior.
 */
export function composeSynthesizedBrief(rawText, topStories, opts = {}) {
  return composeSynthesizedBriefResult(rawText, topStories, opts).brief;
}

/**
 * #5947: `composeSynthesizedBrief` with the rejection reason attached.
 *
 * Same logic and same accept/reject decisions — the only difference is that a
 * rejection names which gate fired, from the bounded `BRIEF_REJECTIONS`
 * vocabulary. `composeSynthesizedBrief` above is the unchanged shape for every
 * caller that only needs the brief.
 *
 * @returns {{ brief: ReturnType<typeof composeSynthesizedBrief>, rejection: string | null }}
 *   Exactly one side is set: a composed brief has `rejection: null`, and a
 *   rejection has `brief: null`.
 */
export function composeSynthesizedBriefResult(rawText, topStories, opts = {}) {
  const validatorMode = opts.validatorMode === 'shadow' ? 'shadow' : 'enforce';
  const sanitize = typeof opts.sanitizeTitle === 'function' ? opts.sanitizeTitle : (t) => t;
  const sourceFromStory = typeof opts.sourceFromStory === 'function' ? opts.sourceFromStory : () => null;
  const reject = (rejection) => ({ brief: null, rejection });

  if (!Array.isArray(topStories) || topStories.length === 0) return reject(BRIEF_REJECTIONS.NO_TOP_STORIES);
  // Editorial gate: same bar the legacy pickBriefCluster enforced. The caller
  // may pass the already-selected cluster so the synthesis path does not scan
  // the ranked list a second time.
  const hasBriefCluster = Object.prototype.hasOwnProperty.call(opts, 'briefCluster')
    ? opts.briefCluster != null
    : topStories.some(isBriefLeadEligible);
  if (!hasBriefCluster) return reject(BRIEF_REJECTIONS.MISSING_CLUSTER);

  // The caller may also pass the parser result when it needs to classify a
  // rejection. Keeping this seam optional preserves the pure public helper's
  // existing behavior for direct callers and tests.
  const parsed = Object.prototype.hasOwnProperty.call(opts, 'parsedSynthesis')
    ? opts.parsedSynthesis
    : parseBriefSynthesis(rawText, topStories.length);
  if (!parsed) return reject(BRIEF_REJECTIONS.PARSE);

  const groundingStories = topStories.map((story) => ({ headline: story.primaryTitle }));
  const storyGroundText = (story) =>
    [story.primaryTitle, ...(Array.isArray(story.memberTitles) ? story.memberTitles : [])].join(' — ');

  // Lead gates (#4928 external review — citation-SCOPED, not corpus-wide):
  // every lead sentence must carry at least one citation, and its proper
  // nouns must ground against ONLY the stories it cites. Corpus-wide
  // validation let a claim bind to [1] while its facts came from story 3
  // — shape-valid misattribution. Anchor grounding stays as the overall
  // floor. Any lead-level failure rejects to the legacy fallback.
  let strippedCitations = 0;
  const leadCheck = verifyCitationIndexes(parsed.lead, topStories.length);
  strippedCitations += leadCheck.stripped;
  // #5947: a dotted acronym mid-clause ("U.S. embassies") was read as a
  // sentence boundary, so the fragment ending at "U.S." inherited the previous
  // clause's citations and "us" grounded against the wrong story — rejecting
  // otherwise-valid briefs. Collapse the dots ONLY where the acronym is provably
  // mid-clause: followed by a lowercase word (which cannot start a sentence), or
  // by its own citation run that CLOSES the sentence ("U.S. [5]." / end-of-lead).
  // Everything else stays a boundary — a capitalized continuation, and a citation
  // run that does NOT close the sentence ("U.S. [1] GCC said…", which would merge
  // two real sentences). Review of this fix showed that collapsing more broadly
  // merged genuine sentences into one validation unit whose citation set was the
  // UNION of both, re-opening the misattribution #4928 closed and letting an
  // uncited sentence ride inside a cited one. Ambiguity must fail closed. Only
  // the gate's view changes — the published lead below stays leadCheck.text,
  // punctuation intact.
  const leadSentences = leadCheck.text
    .replace(MIDSENTENCE_DOTTED_ACRONYM, (acronym) => acronym.replace(/\./g, ''))
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.trim().length > 0);
  if (leadSentences.length === 0) return reject(BRIEF_REJECTIONS.LEAD_EMPTY);
  for (const sentence of leadSentences) {
    const cited = [...sentence.matchAll(/\[(\d{1,3})\]/g)]
      .map((match) => Number.parseInt(match[1], 10))
      .filter((n) => n >= 1 && n <= topStories.length);
    // Contract: every claim is cited. An uncited sentence is unverifiable.
    if (cited.length === 0) return reject(BRIEF_REJECTIONS.LEAD_UNCITED);
    const scopedGround = cited.map((n) => storyGroundText(topStories[n - 1])).join(' — ');
    // Both validators still run before either can reject, so shadow mode
    // observes exactly what it observed before the reasons were split out.
    const sentenceValidation = validateNoHallucinatedProperNouns(sentence, scopedGround);
    const factValidation = validateNoHallucinatedFacts(sentence, scopedGround);
    if (validatorMode === 'enforce') {
      if (!sentenceValidation.ok) return reject(BRIEF_REJECTIONS.LEAD_PROPER_NOUN);
      if (!factValidation.ok) return reject(BRIEF_REJECTIONS.LEAD_NUMERIC_FACT);
    }
  }
  if (!checkLeadGrounding({ lead: leadCheck.text }, groundingStories, topStories.length)) {
    return reject(BRIEF_REJECTIONS.LEAD_GROUNDING);
  }

  const lineByIndex = new Map(parsed.lines.map((line) => [line.n, line.text]));
  let hallucinatedLines = 0;
  const lines = topStories.map((story, i) => {
    const n = i + 1;
    const headline = sanitize(story.primaryTitle);
    // Missing/degraded lines keep their citation so the contract
    // ("every line ends with its own [n]") holds for renderers.
    if (!lineByIndex.has(n)) return { n, text: `${headline} [${n}]` };
    // #4928 external review: a line for story n could carry [1] (or no
    // citation at all after stripping) and the renderer would link the
    // wrong source. The line's content is validated against story n, so
    // its ONLY correct citation is [n]: strip every bracket marker and
    // append the canonical one.
    const bare = lineByIndex.get(n).replace(/\s*\[\d{1,3}\]/g, '').trim();
    const validation = validateNoHallucinatedProperNouns(bare, storyGroundText(story));
    if (!validation.ok) {
      hallucinatedLines++;
      if (validatorMode === 'enforce') return { n, text: `${headline} [${n}]` };
    }
    return { n, text: `${bare} [${n}]` };
  });

  // STRICT index lockstep: never filter — substitute.
  const sources = topStories.map((story) => {
    const source = sourceFromStory(story);
    if (source) return source;
    return {
      title: sanitize(story.primaryTitle) || 'Untitled',
      source: story.primarySource || 'Unknown',
      url: '',
    };
  });

  return {
    brief: { lead: leadCheck.text, lines, sources, hallucinatedLines, strippedCitations },
    rejection: null,
  };
}
