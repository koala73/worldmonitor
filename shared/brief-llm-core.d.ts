export interface BriefStoryHashInput {
  headline?: string;
  source?: string;
  threatLevel?: string;
  category?: string;
  country?: string;
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
