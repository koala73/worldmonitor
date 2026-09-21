/**
 * Product timeline scrub for generative-AI usage / conversation waves.
 * Drives the AI Usage layer TimeNav markers (not Convo Hotspots).
 */

import {
  AI_CONVERSATION_GROWTH_POINTS,
  AI_CONVERSATION_PERIOD_ENDS_MS,
} from '@/config/ai-conversation-growth';
import type { AiEraLandmark } from '@/config/ai-era-landmarks';

const OWID_SOURCE =
  'https://ourworldindata.org/grapher/estimated-share-people-generative-ai';
const WILDCHAT_SOURCE = 'https://huggingface.co/datasets/allenai/WildChat-1M';

function labelForPeriod(ms: number): string {
  const sample = AI_CONVERSATION_GROWTH_POINTS.find((p) => p.periodEndMs === ms);
  return sample?.periodLabel ?? new Date(ms).toISOString().slice(0, 7);
}

function sourceForPeriod(ms: number): 'owid' | 'wildchat' {
  const sample = AI_CONVERSATION_GROWTH_POINTS.find((p) => p.periodEndMs === ms);
  return sample?.source === 'wildchat' ? 'wildchat' : 'owid';
}

function countryCount(ms: number): number {
  return AI_CONVERSATION_GROWTH_POINTS.filter((p) => p.periodEndMs === ms).length;
}

/**
 * One TimeNav marker per reporting wave (WildChat quarters, then OWID H1/H2/Q).
 * Empty if catalog not generated yet.
 */
export const AI_CONVERSATION_GROWTH_LANDMARKS: readonly AiEraLandmark[] =
  AI_CONVERSATION_PERIOD_ENDS_MS.map((ms) => {
    const label = labelForPeriod(ms);
    const n = countryCount(ms);
    const src = sourceForPeriod(ms);
    const isWildchat = src === 'wildchat';
    return {
      id: `ai-conv-${label.replace(/\s+/g, '-').toLowerCase()}`,
      ms,
      headline: `AI use · ${label}`,
      kind: 'product' as const,
      sourceUrl: isWildchat ? WILDCHAT_SOURCE : OWID_SOURCE,
      note:
        n > 0
          ? isWildchat
            ? `${n} countries with WildChat conversation share (quarter ending ${new Date(ms).toISOString().slice(0, 10)}; opt-in corpus, not population %)`
            : `${n} countries with OWID generative-AI usage share (period ending ${new Date(ms).toISOString().slice(0, 10)})`
          : `No country rows for ${label}`,
    };
  });

export const AI_CONVERSATION_GROWTH_START_MS =
  AI_CONVERSATION_GROWTH_LANDMARKS[0]?.ms ?? null;
