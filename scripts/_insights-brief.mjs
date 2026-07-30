// Pure helpers for the WORLD BRIEF pipeline. Split out from seed-insights.mjs
// so tests can import without triggering the top-level runSeed() call.

import { isBriefLeadEligible } from './_clustering.mjs';
import {
  validateNoHallucinatedProperNouns,
  checkLeadGrounding,
  verifyCitationIndexes,
} from './shared/brief-llm-core.js';

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
- Never merge facts from different stories into one claim; the lead may JUXTAPOSE stories but each claim keeps its own [n].
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
 */
export function composeSynthesizedBrief(rawText, topStories, opts = {}) {
  const validatorMode = opts.validatorMode === 'shadow' ? 'shadow' : 'enforce';
  const sanitize = typeof opts.sanitizeTitle === 'function' ? opts.sanitizeTitle : (t) => t;
  const sourceFromStory = typeof opts.sourceFromStory === 'function' ? opts.sourceFromStory : () => null;

  if (!Array.isArray(topStories) || topStories.length === 0) return null;
  // Editorial gate: same bar the legacy pickBriefCluster enforced.
  if (!topStories.some(isBriefLeadEligible)) return null;

  const parsed = parseBriefSynthesis(rawText, topStories.length);
  if (!parsed) return null;

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
  const leadSentences = leadCheck.text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0);
  if (leadSentences.length === 0) return null;
  for (const sentence of leadSentences) {
    const cited = [...sentence.matchAll(/\[(\d{1,3})\]/g)]
      .map((match) => Number.parseInt(match[1], 10))
      .filter((n) => n >= 1 && n <= topStories.length);
    // Contract: every claim is cited. An uncited sentence is unverifiable.
    if (cited.length === 0) return null;
    const scopedGround = cited.map((n) => storyGroundText(topStories[n - 1])).join(' — ');
    const sentenceValidation = validateNoHallucinatedProperNouns(sentence, scopedGround);
    if (!sentenceValidation.ok && validatorMode === 'enforce') return null;
  }
  if (!checkLeadGrounding({ lead: leadCheck.text }, groundingStories, topStories.length)) return null;

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

  return { lead: leadCheck.text, lines, sources, hallucinatedLines, strippedCitations };
}
