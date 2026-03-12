import type { StoryCluster, CachedNarration } from '@/types/news-reader';
import { callAI } from './provider';
import { buildShortSummaryPrompt, buildNewsBriefPrompt, buildAnchorNarrationPrompt } from './prompts';
import { getCachedNarration, putNarration, getBriefExpiry, getAnchorExpiry } from './cache';
import { getAIConfig, hasAIConfigured } from '@/services/settings-store';

export type NarrationType = 'shortSummary' | 'newsBrief' | 'anchorNarration';

const FALLBACK_GENERATING = 'Summary generating...';
const FALLBACK_UNAVAILABLE = 'Summary unavailable — click to retry';

export async function narrateCluster(
  cluster: StoryCluster,
  type: NarrationType = 'newsBrief',
  force = false,
): Promise<CachedNarration | null> {
  if (!hasAIConfigured()) return null;

  // Check cache first
  if (!force) {
    const cached = await getCachedNarration(cluster.clusterId);
    if (cached) {
      // Re-narration trigger: only if cluster gained 3+ new sources
      if (cluster.sourceCount - cached.sourceCountAtGen < 3) {
        return cached;
      }
    }
  }

  const config = getAIConfig();
  let messages;
  let maxTokens: number;

  switch (type) {
    case 'shortSummary':
      messages = buildShortSummaryPrompt(cluster);
      maxTokens = 150;
      break;
    case 'anchorNarration':
      messages = buildAnchorNarrationPrompt(cluster);
      maxTokens = 280;
      break;
    case 'newsBrief':
    default:
      messages = buildNewsBriefPrompt(cluster);
      maxTokens = 280;
      break;
  }

  try {
    const result = await callAI(config, messages, maxTokens);

    const narration: CachedNarration = {
      clusterId: cluster.clusterId,
      shortSummary: type === 'shortSummary' ? result.content : '',
      newsBrief: type === 'newsBrief' ? result.content : '',
      anchorNarration: type === 'anchorNarration' ? result.content : null,
      generatedAt: new Date(),
      expiresAt: type === 'anchorNarration' ? getAnchorExpiry() : getBriefExpiry(),
      sourceCountAtGen: cluster.sourceCount,
      provider: config.provider,
      model: config.model,
      tokensUsed: result.tokensUsed,
    };

    // Merge with existing narration if present
    const existing = await getCachedNarration(cluster.clusterId);
    if (existing) {
      if (type !== 'shortSummary' && existing.shortSummary) narration.shortSummary = existing.shortSummary;
      if (type !== 'newsBrief' && existing.newsBrief) narration.newsBrief = existing.newsBrief;
      if (type !== 'anchorNarration' && existing.anchorNarration) narration.anchorNarration = existing.anchorNarration;
      narration.tokensUsed += existing.tokensUsed;
    }

    await putNarration(narration);
    return narration;
  } catch (err) {
    console.error('[Narrator] AI call failed:', err);
    return null;
  }
}

export function getFallbackText(generating: boolean): string {
  return generating ? FALLBACK_GENERATING : FALLBACK_UNAVAILABLE;
}

export async function autoNarrateTop(clusters: StoryCluster[]): Promise<void> {
  if (!hasAIConfigured()) return;

  // Top 5 by source count
  const top = [...clusters]
    .sort((a, b) => b.sourceCount - a.sourceCount)
    .slice(0, 5);

  for (const cluster of top) {
    try {
      await narrateCluster(cluster, 'shortSummary');
    } catch {
      // Non-blocking, continue with next
    }
  }
}
