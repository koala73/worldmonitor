/**
 * AI-era timeline landmarks — cited product / open / infra / policy snapshots.
 * Used by TimeNav scrubber + AI Footprint drawer. Datacenter density growth scrub
 * points live in ai-dc-growth-landmarks.ts (Epoch firstOperationalMs).
 *
 * Missing ≠ 0: do not invent HQ/startup open dates from these labels alone.
 */

import { AI_DC_GROWTH_LANDMARKS } from '@/config/ai-dc-growth-landmarks';

export type AiEraLandmarkKind = 'product' | 'open' | 'infra' | 'policy';

export type AiEraLandmark = {
  id: string;
  /** UTC midnight of the cited event day */
  ms: number;
  headline: string;
  kind: AiEraLandmarkKind;
  sourceUrl: string;
  note: string;
};

/** ChatGPT public launch — product boom landmark (Time · all also reaches earlier DC growth). */
export const AI_BOOM_START_MS = Date.UTC(2022, 10, 30, 0, 0, 0);

/**
 * v1 TimeNav + drawer ship set (sparse). Deferred candidates live in REWRITE.md.
 */
export const AI_ERA_LANDMARKS: readonly AiEraLandmark[] = [
  {
    id: 'chatgpt',
    ms: AI_BOOM_START_MS,
    headline: 'ChatGPT',
    kind: 'product',
    sourceUrl: 'https://openai.com/index/chatgpt/',
    note: 'OpenAI ChatGPT research preview — generative consumer inflection',
  },
  {
    id: 'msft-openai-2023',
    ms: Date.UTC(2023, 0, 23, 0, 0, 0),
    headline: 'MSFT–OpenAI',
    kind: 'infra',
    sourceUrl:
      'https://blogs.microsoft.com/blog/2023/01/23/microsoftandopenaiextendpartnership/',
    note: 'Microsoft–OpenAI partnership extend — Azure exclusive cloud + supercomputing',
  },
  {
    id: 'gpt4-claude',
    ms: Date.UTC(2023, 2, 14, 0, 0, 0),
    headline: 'GPT-4 · Claude',
    kind: 'product',
    sourceUrl: 'https://openai.com/index/gpt-4/',
    note: 'GPT-4 release; Anthropic Claude public assistant same day',
  },
  {
    id: 'llama2',
    ms: Date.UTC(2023, 6, 18, 0, 0, 0),
    headline: 'Llama 2',
    kind: 'open',
    sourceUrl: 'https://ai.meta.com/blog/llama-2/',
    note: 'Meta Llama 2 — commercial open weights + cloud distribution',
  },
  {
    id: 'devday-2023',
    ms: Date.UTC(2023, 10, 6, 0, 0, 0),
    headline: 'DevDay',
    kind: 'product',
    sourceUrl: 'https://openai.com/index/new-models-and-developer-products-announced-at-devday/',
    note: 'OpenAI DevDay — GPT-4 Turbo / Assistants / GPTs',
  },
  {
    id: 'gpt4o',
    ms: Date.UTC(2024, 4, 13, 0, 0, 0),
    headline: 'GPT-4o',
    kind: 'product',
    sourceUrl: 'https://openai.com/index/hello-gpt-4o/',
    note: 'GPT-4o multimodal omni model',
  },
  {
    id: 'claude-35-sonnet',
    ms: Date.UTC(2024, 5, 21, 0, 0, 0),
    headline: 'Claude 3.5',
    kind: 'product',
    sourceUrl: 'https://www.anthropic.com/news/claude-3-5-sonnet',
    note: 'Claude 3.5 Sonnet — coding / agent step-change',
  },
  {
    id: 'eu-ai-act-eif',
    ms: Date.UTC(2024, 7, 1, 0, 0, 0),
    headline: 'EU AI Act',
    kind: 'policy',
    sourceUrl: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
    note: 'EU AI Act entry into force (graduated obligations follow)',
  },
] as const;

/** Product/policy eras + Epoch DC growth year markers (sorted). */
export const AI_TIMELINE_LANDMARKS: readonly AiEraLandmark[] = [
  ...AI_DC_GROWTH_LANDMARKS,
  ...AI_ERA_LANDMARKS,
].slice().sort((a, b) => a.ms - b.ms);

export function landmarkForMs(ms: number): AiEraLandmark | undefined {
  return AI_TIMELINE_LANDMARKS.find((l) => l.ms === ms);
}

export function formatAiEraLabel(ms: number): string | null {
  return landmarkForMs(ms)?.headline ?? null;
}
