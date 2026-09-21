/**
 * Product / frontier scrub points — cited AI product + partnership eras.
 * Shown on TimeNav when Product layers (Tech HQs / Convo Hotspots) are on.
 *
 * Same role as ai-dc-growth-landmarks.ts for Infrastructure: sparse, named
 * accrual along the boom — not inventing HQ open dates (HQs stay Live-only).
 * AI Usage adds separate OWID wave markers. Convo paints wiki/news/Trends/social
 * at these product eras when channel data exists.
 */

import {
  AI_BOOM_START_MS,
  AI_ERA_LANDMARKS,
  type AiEraLandmark,
} from '@/config/ai-era-landmarks';

/** Product + partnership headlines (infra-tagged MSFT–OpenAI rides Product). */
export const AI_PRODUCT_GROWTH_LANDMARKS: readonly AiEraLandmark[] =
  AI_ERA_LANDMARKS.filter(
    (lm) => lm.kind === 'product' || lm.kind === 'infra',
  );

export const AI_PRODUCT_GROWTH_START_MS =
  AI_PRODUCT_GROWTH_LANDMARKS[0]?.ms ?? AI_BOOM_START_MS;

export function productGrowthLandmarkForMs(
  ms: number,
): AiEraLandmark | undefined {
  return AI_PRODUCT_GROWTH_LANDMARKS.find((l) => l.ms === ms);
}
