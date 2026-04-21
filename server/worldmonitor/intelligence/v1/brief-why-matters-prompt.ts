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

// Per-section caps so no single heavy bundle (e.g. long worldBrief)
// crowds out the others. Ordered by editorial importance: a single-
// sentence summary benefits most from narrative + country framing.
const SECTION_CAPS: Array<{ key: keyof BriefStoryContext; label: string; cap: number }> = [
  { key: 'worldBrief', label: 'World Brief', cap: 500 },
  { key: 'countryBrief', label: 'Country Brief', cap: 400 },
  { key: 'riskScores', label: 'Risk Scores', cap: 250 },
  { key: 'forecasts', label: 'Forecasts', cap: 250 },
  { key: 'macroSignals', label: 'Macro Signals', cap: 200 },
  { key: 'marketData', label: 'Market Data', cap: 200 },
];

function clip(s: string, cap: number): string {
  if (typeof s !== 'string' || s.length === 0) return '';
  if (s.length <= cap) return s;
  return `${s.slice(0, cap - 1).trimEnd()}…`;
}

/**
 * Assemble the compact context block. Skips empty sections. Respects
 * a total-chars budget so a bloated single section can't push the
 * prompt over its token limit.
 */
export function buildContextBlock(context: BriefStoryContext): string {
  if (!context) return '';
  const parts: string[] = [];
  let used = 0;
  for (const { key, label, cap } of SECTION_CAPS) {
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
): { system: string; user: string } {
  const safe = sanitizeStoryFields(story);
  const contextBlock = buildContextBlock(context);

  const storyLineList = [
    `Headline: ${safe.headline}`,
    ...(safe.description ? [`Description: ${safe.description}`] : []),
    `Source: ${safe.source}`,
    `Severity: ${safe.threatLevel}`,
    `Category: ${safe.category}`,
    `Country: ${safe.country}`,
  ];
  const storyLines = storyLineList.join('\n');

  const sections = [];
  if (contextBlock) {
    sections.push('# Live WorldMonitor Context', contextBlock);
  }
  sections.push('# Story', storyLines);
  // Prompt footer matches the system prompt's SITUATION → ANALYSIS →
  // (optional) WATCH arc, but explicitly restates the grounding
  // requirement so the model can't ignore it from the system message
  // alone. Models follow inline instructions more reliably than
  // system-prompt constraints on longer outputs.
  sections.push(
    'Write 2–3 sentences (40–70 words) on why this story matters, grounded in at ' +
      'least ONE specific actor / metric / date / place drawn from the context above. ' +
      'Plain prose, no section labels in the output:',
  );

  return {
    system: WHY_MATTERS_ANALYST_SYSTEM_V2,
    user: sections.join('\n\n'),
  };
}
