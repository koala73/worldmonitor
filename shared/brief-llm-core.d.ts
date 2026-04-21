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

export function buildWhyMattersUserPrompt(story: BriefStoryPromptInput): {
  system: string;
  user: string;
};

export function parseWhyMatters(text: unknown): string | null;

export function hashBriefStory(story: BriefStoryHashInput): Promise<string>;

// ── v2 (analyst path only) ────────────────────────────────────────────────
export const WHY_MATTERS_ANALYST_SYSTEM_V2: string;
export function parseWhyMattersV2(text: unknown): string | null;
