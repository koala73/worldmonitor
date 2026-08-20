// Pure helpers for the WORLD BRIEF pipeline. Split out from seed-insights.mjs
// so tests can import without triggering the top-level runSeed() call.

import { isBriefLeadEligible } from './_clustering.mjs';
import { countPublisherFamilies } from './shared/publisher-families.js';
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
 * (>= MIN_CORROBORATING_PUBLISHERS distinct publisher families across
 * `sources`, which holds feed LABELS — #6428) or entity corroboration across
 * related clusters.
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
- If you name an outlet, copy its label exactly (including capitalization) and use it only as an attribution: "<outlet> reported/reports/said/says/wrote/writes ..." or "According to <outlet>, ...".
- Write acronyms WITHOUT periods: "US", "UN", "EU", "UK" — never "U.S.", "U.N.". A trailing period there reads as the end of a sentence.
- Refer to an actor by the name the story uses. Do not swap in a capital city, nickname, or synonym for it — write "US", not "Washington"; "Iran", not "Tehran" — unless that word is in the story text.
- NEVER start with "Breaking news", "Good evening", "Tonight", or TV-style openings.`;
}

export function synthesisUserPrompt(stories) {
  const lines = stories.map((story, i) => {
    // #6428: the model writes the published brief from these lines, so this
    // count is a corroboration claim reaching a reader. It counted feed
    // LABELS, telling the model that four Reuters desks were four sources.
    // clusterItems resolves the families onto the cluster; fall back to
    // resolving them here, and to 1 — never to sourceCount, which is the
    // ARTICLE count and would overstate in exactly the same direction.
    const publishers = Number.isFinite(story.uniquePublisherCount)
      ? story.uniquePublisherCount
      : countPublisherFamilies(story.sources);
    const sources = publishers > 0 ? publishers : 1;
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
 * The ground text a story's claims must be found in: the story TEXT only.
 *
 * Exported so the string this gate actually turns on can be read directly by a
 * unit test or a replay script. It was a local closure, and both the #6019 and
 * #6119 investigations had to rebuild a live-digest harness to see it.
 *
 * `primarySource` is deliberately NOT here — see `maskAttributedSources`.
 */
export const storyGroundText = (story) => [
  story?.primaryTitle,
  ...(Array.isArray(story?.memberTitles) ? story.memberTitles : []),
].filter(Boolean).join(' — ');

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Blank the outlet labels the prompt showed the model, so the model may NAME
 * its source without that name grounding anything else.
 *
 * synthesisUserPrompt renders each story as
 *   `N. <primaryTitle> (<primarySource>, K sources)`
 * and the system prompt says "Use ONLY facts present in the numbered story
 * text". primarySource IS in that text, so a lead writing "Reuters reported …"
 * is obeying the prompt — and was rejected as a hallucinated proper noun for
 * naming something the prompt itself supplied. On 2026-08-18 that cost 13
 * INSIGHTS_SYNTHESIS_LEAD_PROPER_NOUN alarms in 10.5h, and because the provider
 * loop advances on gate rejection (seed-insights.mjs) it silently demoted the
 * chain from the paid model to a free one.
 *
 * The obvious repair — appending primarySource to the ground text — is wrong,
 * because the ground text is TOKENISED, not matched as a phrase:
 * validateNoHallucinatedProperNouns grounds a single-token claim against any
 * token inside any ground sequence (brief-llm-core.js). Adding the label would
 * donate each of its words to the free grounding pool, so
 * `primarySource: 'Iran International'` would ground a lead asserting that
 * *Iran* deployed security forces — the exact swap the system prompt forbids
 * ("write 'US', not 'Washington'"). 40+ of the 416 labels in source-tiers.json
 * carry a country, capital or institution token. Worse, the same ground string
 * feeds validateNoHallucinatedFacts, so `'France 24'` (a live source here)
 * would ground a fabricated "24 people were killed" — the digits are a
 * tokenisation artefact of a brand name, not a fact about the story.
 *
 * Masking gets the semantics right only when the label is used as an explicit
 * attribution. "Reuters reported X" and "According to Al Jazeera, X" pass,
 * while "Iran International deployed …" and "24 people were killed" still face
 * the un-widened ground and still reject. Labels are exact-case, normalized,
 * deduplicated and checked longest-first, so `WHO` cannot mask the pronoun
 * `who`, and `ABC News` cannot partially mask `ABC News Australia`.
 *
 * Only the gate's VIEW changes; the published lead and lines keep their text.
 *
 * @param {string} text
 * @param {Array<unknown>} sources primarySource of each story in scope
 * @returns {string}
 */
export function maskAttributedSources(text, sources) {
  return maskAttributedSourcesResult(text, sources).text;
}

/**
 * Internal form used by the composer so telemetry counts qualified
 * attributions, rather than any incidental occurrence of an outlet label.
 *
 * @param {string} text
 * @param {Array<unknown>} sources
 * @returns {{ text: string; matches: number }}
 */
function maskAttributedSourcesResult(text, sources) {
  if (typeof text !== 'string' || text.length === 0) return { text, matches: 0 };
  let masked = text;
  let matches = 0;
  const labels = [...new Set(
    (Array.isArray(sources) ? sources : [])
      .filter((source) => typeof source === 'string')
      .map((source) => source.trim().replace(/\s+/g, ' '))
      .filter(Boolean),
  )].sort((a, b) => b.length - a.length);

  for (const label of labels) {
    // Escape first, THEN relax runs of whitespace — a label may carry regex
    // metacharacters ('+972 Magazine', '24.hu', 'CAC (China)').
    const pattern = label.replace(REGEX_METACHARACTERS, '\\$&').replace(/\s+/g, '\\s+');
    const sourceFirst = new RegExp(
      `(^|[^\\p{L}\\p{N}])${pattern}(?=\\s+(?:reported|reports|said|says|wrote|writes)\\b)`,
      'gu',
    );
    masked = masked.replace(sourceFirst, (_match, prefix) => {
      matches++;
      return prefix;
    });

    const accordingTo = new RegExp(
      `(^|[^\\p{L}\\p{N}])[Aa]ccording\\s+to\\s+${pattern}(?=\\s*[,:])`,
      'gu',
    );
    masked = masked.replace(accordingTo, (_match, prefix) => {
      matches++;
      return prefix;
    });
  }
  return { text: masked, matches };
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
 *   sourceAttributions: number;
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
  // `detail` carries WHAT tripped the gate, not just which gate. Both
  // validators already return the offending token sequence; discarding it left
  // production able to say only that the lead was rejected, never why — while
  // the sibling summary gate two hundred lines away has always logged
  // `invented "talks" not in headline` (seed-insights.mjs). Same field, same
  // use.
  const reject = (rejection, detail = null) => ({
    brief: null,
    rejection,
    rejectionDetail: Array.isArray(detail) && detail.length > 0 ? detail.join(' ') : null,
  });

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
  // `storyGroundText` (module level) is the story TEXT only; the outlet label
  // reaches the gate through `maskAttributedSources` instead. Both are shared by
  // THREE call sites below — the lead proper-noun gate, the lead numeric-fact
  // gate, and the per-story line gate — so a change here ripples to all three.
  //
  // memberTitles is the mirror case and stays: it is in the ground text but NOT
  // in the prompt, which only makes the gate more permissive and cannot cause a
  // false rejection.
  //
  // How often a lead actually names its outlet, so the accept side is legible.
  // The reject side already reports a reason; without this, the alarm going
  // quiet cannot distinguish "stopped over-rejecting" from "started
  // under-rejecting".
  let sourceAttributions = 0;

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
    // Fail CLOSED on empty ground. Both validators return ok:true for an empty
    // ground string, so an untitled cluster would accept every proper noun and
    // every number in the sentence — a dead gate that looks like a healthy one.
    if (!scopedGround.trim()) return reject(BRIEF_REJECTIONS.LEAD_GROUNDING);
    // The lead may NAME the outlets of the stories it cites — the prompt showed
    // it those labels. Blank them so they ground nothing else, scoped to the
    // cited stories so one story's outlet cannot license a claim about another.
    const attribution = maskAttributedSourcesResult(
      sentence,
      cited.map((n) => topStories[n - 1]?.primarySource),
    );
    const attributed = attribution.text;
    if (attribution.matches > 0) sourceAttributions++;
    // Both validators still run before either can reject, so shadow mode
    // observes exactly what it observed before the reasons were split out.
    const sentenceValidation = validateNoHallucinatedProperNouns(attributed, scopedGround);
    const factValidation = validateNoHallucinatedFacts(attributed, scopedGround);
    if (validatorMode === 'enforce') {
      if (!sentenceValidation.ok) {
        return reject(BRIEF_REJECTIONS.LEAD_PROPER_NOUN, sentenceValidation.hallucinated);
      }
      if (!factValidation.ok) {
        return reject(BRIEF_REJECTIONS.LEAD_NUMERIC_FACT, factValidation.hallucinated);
      }
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
    // Same attribution rule as the lead, scoped to THIS story's outlet: the line
    // may name it, and naming it grounds nothing else. The published text stays
    // `bare` — only the gate's view is masked.
    const validation = validateNoHallucinatedProperNouns(
      maskAttributedSources(bare, [story.primarySource]),
      storyGroundText(story),
    );
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
    brief: { lead: leadCheck.text, lines, sources, hallucinatedLines, strippedCitations, sourceAttributions },
    rejection: null,
    rejectionDetail: null,
  };
}
