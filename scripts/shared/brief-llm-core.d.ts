export interface BriefStoryHashInput {
  headline?: string;
  source?: string;
  threatLevel?: string;
  category?: string;
  country?: string;
  /** v5: part of cache identity so same-story + different description
   *  don't collide on cached analyst output. */
  description?: string;
}

export interface BriefStoryPromptInput {
  headline: string;
  source: string;
  threatLevel: string;
  category: string;
  country: string;
}

export const WHY_MATTERS_SYSTEM: string;
export const WHY_MATTERS_V1_MIN_CHARS: number;
export const WHY_MATTERS_V1_MAX_CHARS: number;
export const WHY_MATTERS_V2_MIN_CHARS: number;
export const WHY_MATTERS_V2_MAX_CHARS: number;

export function briefDateLine(todayIso?: string): string;

export function buildWhyMattersUserPrompt(
  story: BriefStoryPromptInput,
  todayIso?: string,
): {
  system: string;
  user: string;
};

export function parseWhyMatters(text: unknown): string | null;

export function hasTerminalPunctuation(text: unknown): boolean;

export function hashBriefStory(story: BriefStoryHashInput): Promise<string>;

// ── v2 (analyst path only) ────────────────────────────────────────────────
export const WHY_MATTERS_ANALYST_SYSTEM_V2: string;
export interface WhyMattersV2Provenance {
  publicStory?: Pick<BriefStoryHashInput, 'headline' | 'description' | 'source'>;
  privateForecasts?: string;
}
export function parseWhyMattersV2(
  text: unknown,
  provenance?: WhyMattersV2Provenance,
): string | null;

// ── Hallucination validator (PR-2 of brief-content-quality regressions) ──
export function extractProperNounSequences(text: string): string[][];
export function validateNoHallucinatedProperNouns(
  summary: unknown,
  headline: unknown,
): { ok: true } | { ok: false; hallucinated: string[] };

// ── Grounding spine (#4921) ────────────────────────────────────────────────
export function extractAnchorTokens(s: string): string[];
export function groundingTokenSet(text: string): Set<string>;
export function checkLeadGrounding(
  synthesis: { lead?: string; threads?: Array<{ tag?: string; teaser?: string }> },
  stories: Array<{ headline?: string }>,
  storyCap?: number,
): boolean;
export function leadGroundsAgainstStory(lead: string, headline: string): boolean;
export function verifyCitationIndexes(
  text: string,
  sourceCount: number,
): { text: string; stripped: number };
