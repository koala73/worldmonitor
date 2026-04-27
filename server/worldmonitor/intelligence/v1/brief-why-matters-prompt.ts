/**
 * Prompt builder for the analyst-backed whyMatters LLM call.
 *
 * System prompt is the edge-safe `WHY_MATTERS_SYSTEM` from
 * shared/brief-llm-core.js — same editorial voice the cron's legacy
 * Gemini path uses.
 *
 * User prompt wraps the story fields (identical to
 * `buildWhyMattersUserPrompt`) with a compact context block assembled
 * from `BriefStoryContext`. The context is hard-truncated to a total
 * budget so that worst-case prompts stay under ~2KB of text, keeping
 * LLM latency predictable.
 */

import { WHY_MATTERS_ANALYST_SYSTEM_V2 } from '../../../../shared/brief-llm-core.js';
import { sanitizeForPrompt } from '../../../_shared/llm-sanitize.js';
import type { BriefStoryContext } from './brief-story-context';

export interface StoryForPrompt {
  headline: string;
  source: string;
  threatLevel: string;
  category: string;
  country: string;
  /** Optional story description; included when the cron has already
   *  resolved it (post-describe pipeline). Absent on first-pass calls. */
  description?: string;
}

/**
 * Sanitize all untrusted string fields before interpolating into the
 * LLM prompt. Defense-in-depth: the endpoint is already
 * RELAY_SHARED_SECRET-gated, but repo convention applies
 * `sanitizeForPrompt` at every LLM boundary regardless of auth tier.
 * Strips role markers, instruction overrides, control chars, etc.
 */
export function sanitizeStoryFields(story: StoryForPrompt): StoryForPrompt {
  return {
    headline: sanitizeForPrompt(story.headline),
    source: sanitizeForPrompt(story.source),
    threatLevel: sanitizeForPrompt(story.threatLevel),
    category: sanitizeForPrompt(story.category),
    country: sanitizeForPrompt(story.country),
    ...(typeof story.description === 'string' && story.description.length > 0
      ? { description: sanitizeForPrompt(story.description) }
      : {}),
  };
}

// Total budget for the context block alone (the story fields + prompt
// footer add another ~250 chars). Keeping the total under ~2KB means
// the LLM call latency stays under ~6s on typical provider responses.
const CONTEXT_BUDGET_CHARS = 1700;

// ── Category-gated context sections ──────────────────────────────────────
//
// Shadow-diff (2026-04-22) of 15 v2 pairs showed the LLM pattern-matching
// the loudest numbers (VIX 19.50, top forecast probability, MidEast FX
// stress) into every story — even humanitarian / Rwanda / aviation stories
// with no editorial connection to markets. Root cause: the context block
// passes ALL six bundles for every story, so the LLM has the market /
// forecast numbers in-hand and the prompt's "cite a specific fact"
// instruction does the rest.
//
// Fix: structurally exclude bundles the LLM cannot appropriately cite for
// a given category. Humanitarian stories don't see market data; energy
// stories don't see domestic risk scores; etc. The model physically cannot
// cite what it wasn't given.
//
// Matching is case-insensitive substring on the story's category slug
// (shared/brief-filter.js:134 — category is free-form like "Humanitarian
// Crisis", "Geopolitical Risk", "Energy"). First match wins. Unknown →
// DEFAULT_SECTIONS (all six — same as pre-gating behavior).
type SectionKey = Exclude<keyof BriefStoryContext, 'degraded'>;

// Per-section caps so no single heavy bundle (e.g. long worldBrief)
// crowds out the others. Ordered by editorial importance: a single-
// sentence summary benefits most from narrative + country framing.
const SECTION_CAPS: Array<{ key: SectionKey; label: string; cap: number }> = [
  { key: 'worldBrief', label: 'World Brief', cap: 500 },
  { key: 'countryBrief', label: 'Country Brief', cap: 400 },
  { key: 'riskScores', label: 'Risk Scores', cap: 250 },
  { key: 'forecasts', label: 'Forecasts', cap: 250 },
  { key: 'macroSignals', label: 'Macro Signals', cap: 200 },
  { key: 'marketData', label: 'Market Data', cap: 200 },
];

const DEFAULT_SECTIONS: SectionKey[] = [
  'worldBrief',
  'countryBrief',
  'riskScores',
  'forecasts',
  'macroSignals',
  'marketData',
];

// NOTE on regex shape: patterns use a LEADING `\b` (start-of-word
// anchor) but NO TRAILING `\b`, so they match stems. "Diplomac" must
// match "Diplomacy" and "Diplomatic"; "migrat" must match "migration"
// and "migrating". A trailing `\b` here incorrectly required the stem
// to end on a non-word char and caused every inflected form to fall
// through to the default policy (caught in unit tests 2026-04-22).
const CATEGORY_SECTION_POLICY: Array<{ match: RegExp; sections: SectionKey[]; label: string }> = [
  // Energy / commodity / markets / financial — forecasts + markets matter.
  {
    label: 'market',
    match: /\b(energy|commodit|market|financ|trade|oil|gas|fuel)/i,
    sections: ['worldBrief', 'countryBrief', 'forecasts', 'macroSignals', 'marketData'],
  },
  // Humanitarian / civil / social / rights — NO market, NO forecasts.
  // This is the #1 source of the "77% FX stress dragged into a Rwanda
  // story" pattern from the 2026-04-22 shadow review.
  {
    label: 'humanitarian',
    match: /\b(humanitarian|refuge|civil|social|rights|genocid|aid\b|migrat)/i,
    sections: ['worldBrief', 'countryBrief', 'riskScores'],
  },
  // Geopolitical risk / conflict / military / security — risk + forecasts
  // but not market data (the LLM would otherwise tack on a VIX reading to
  // every conflict story).
  {
    label: 'geopolitical',
    match: /\b(geopolit|military|conflict|war\b|terror|securit|defen[cs]e|nuclear)/i,
    sections: ['worldBrief', 'countryBrief', 'riskScores', 'forecasts'],
  },
  // Diplomacy / negotiations — risk + country framing, no market / macro.
  {
    label: 'diplomacy',
    match: /\b(diplomac|negotia|summit|sanction)/i,
    sections: ['worldBrief', 'countryBrief', 'riskScores'],
  },
  // Technology / cyber — world narrative + risk, not markets.
  {
    label: 'tech',
    match: /\b(tech|cyber|a\.?i\b|artificial|algorith|autonom)/i,
    sections: ['worldBrief', 'countryBrief', 'riskScores'],
  },
  // Aviation / airspace / drones — world narrative + risk, NO market /
  // forecasts / macro. Named explicitly in the RELEVANCE RULE (shared/
  // brief-llm-core.js WHY_MATTERS_ANALYST_SYSTEM_V2) — the prior revision
  // of this file only had the prompt-level guard, so aviation categories
  // still fell through to DEFAULT_SECTIONS and got all 6 bundles.
  // Structural fix ensures the LLM physically cannot cite a forecast
  // probability or VIX reading for an aviation story (PR #3281 review).
  {
    label: 'aviation',
    match: /\b(aviation|airspace|flight\b|aircraft|plane\b|drone)/i,
    sections: ['worldBrief', 'countryBrief', 'riskScores'],
  },
];

/**
 * Resolve which context sections are editorially relevant for a given
 * story category. Exported for testability — the category → sections
 * map is the main lever for tuning analyst output relevance.
 *
 * @param category — the story's category slug (free-form, from the cron
 *   payload). `""` or unknown categories fall back to DEFAULT_SECTIONS.
 */
export function sectionsForCategory(category: string): {
  sections: SectionKey[];
  policyLabel: string;
} {
  if (typeof category === 'string' && category.length > 0) {
    for (const { match, sections, label } of CATEGORY_SECTION_POLICY) {
      if (match.test(category)) return { sections, policyLabel: label };
    }
  }
  return { sections: DEFAULT_SECTIONS, policyLabel: 'default' };
}

function clip(s: string, cap: number): string {
  if (typeof s !== 'string' || s.length === 0) return '';
  if (s.length <= cap) return s;
  return `${s.slice(0, cap - 1).trimEnd()}…`;
}

/**
 * Assemble the compact context block, filtered to sections that
 * editorially matter for the story's category. Skips empty sections.
 * Respects a total-chars budget so a bloated single section can't push
 * the prompt over its token limit.
 *
 * @param context — the full BriefStoryContext from assembleBriefStoryContext
 * @param allowedSections — whitelist from sectionsForCategory(category).
 *   When omitted, all sections allowed (pre-gating behavior — kept for
 *   test backcompat).
 */
export function buildContextBlock(
  context: BriefStoryContext,
  allowedSections?: SectionKey[],
): string {
  if (!context) return '';
  const allow = allowedSections ? new Set<SectionKey>(allowedSections) : null;
  const parts: string[] = [];
  let used = 0;
  for (const { key, label, cap } of SECTION_CAPS) {
    if (allow && !allow.has(key)) continue;
    const raw = context[key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const clipped = clip(raw, cap);
    const section = `## ${label}\n${clipped}`;
    // Keep adding sections until the total budget would overflow.
    // +2 accounts for the blank line between sections.
    if (used + section.length + 2 > CONTEXT_BUDGET_CHARS) break;
    parts.push(section);
    used += section.length + 2;
  }
  return parts.join('\n\n');
}

/**
 * Build the system + user prompt tuple for the analyst whyMatters path.
 *
 * The user prompt is layered:
 *   1. Compact context block (named sections, hard-truncated).
 *   2. Story fields (exact format from buildWhyMattersUserPrompt so
 *      the analyst path's story framing matches the gemini path).
 *   3. Instruction footer.
 */
export function buildAnalystWhyMattersPrompt(
  story: StoryForPrompt,
  context: BriefStoryContext,
): { system: string; user: string; policyLabel: string } {
  const safe = sanitizeStoryFields(story);
  const { sections: allowedSections, policyLabel } = sectionsForCategory(safe.category);
  const contextBlock = buildContextBlock(context, allowedSections);

  const storyLineList = [
    `Headline: ${safe.headline}`,
    ...(safe.description ? [`Description: ${safe.description}`] : []),
    `Source: ${safe.source}`,
    `Severity: ${safe.threatLevel}`,
    `Category: ${safe.category}`,
    `Country: ${safe.country}`,
  ];
  const storyLines = storyLineList.join('\n');

  const parts: string[] = [];
  if (contextBlock) {
    parts.push('# Live WorldMonitor Context', contextBlock);
  }
  parts.push('# Story', storyLines);
  // Prompt footer restates the grounding requirement inline (models
  // follow inline instructions more reliably than system-prompt
  // constraints on longer outputs), and adds a relevance guardrail.
  //
  // Shadow review (2026-04-22, 15 v2 pairs) showed the analyst pattern-
  // matching loud context numbers — VIX 19.50, top forecast probability,
  // MidEast FX stress 77 — into humanitarian / aviation / Rwanda stories
  // regardless of editorial fit. Structural category gating above strips
  // the worst offenders (markets never reach humanitarian stories), but
  // category overlap is imperfect: a "Security" story that regex-matches
  // as geopolitical still gets forecasts, and not every forecast belongs.
  //
  // The guardrail below is the second layer: tell the model explicitly
  // that the category framing it was handed limits what's worth citing,
  // and that a named actor from the headline / description is a valid
  // grounding target when no context fact is a clean fit.
  parts.push(
    `Write 2–3 sentences (40–70 words) on why this ${safe.category || 'story'} matters, grounded in at ` +
      "least ONE specific reference. Prefer a fact drawn from the context block above WHEN it clearly " +
      "relates to this story's category and country. If no context fact is a clean fit, ground " +
      'instead in a named actor, place, date, or figure from the headline or description. ' +
      'DO NOT force an off-topic market metric, VIX value, FX reading, or forecast probability ' +
      "into a story where it does not belong. Plain prose, no section labels in the output:",
  );

  return {
    system: WHY_MATTERS_ANALYST_SYSTEM_V2,
    user: parts.join('\n\n'),
    policyLabel,
  };
}
