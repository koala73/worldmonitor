import type { StoryCluster, ChatMessage } from '@/types/news-reader';

function formatTimeAgo(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function buildShortSummaryPrompt(cluster: StoryCluster): ChatMessage[] {
  const topNames = cluster.topSources.slice(0, 3).map(s => s.name).join(', ');
  return [
    {
      role: 'system',
      content: 'You are a concise news summarizer. Output ONLY a 1-2 sentence summary.',
    },
    {
      role: 'user',
      content: `Story: ${cluster.primaryTitle}
Sources: ${cluster.sourceCount} outlets including ${topNames}
Region: ${cluster.region} | Category: ${cluster.categories.join(', ')}
Keywords: ${cluster.mergedKeywords.join(', ')}
Time: First reported ${formatTimeAgo(cluster.firstSeen)}
Summarize this developing story in 1-2 sentences.`,
    },
  ];
}

export function buildNewsBriefPrompt(cluster: StoryCluster): ChatMessage[] {
  const topSourcesStr = cluster.topSources
    .slice(0, 3)
    .map(s => `${s.name} (Tier ${s.tier})`)
    .join(', ');

  return [
    {
      role: 'system',
      content: 'You are a news briefing writer. Write a clear, factual 3-5 sentence brief. No opinions. Cite source count.',
    },
    {
      role: 'user',
      content: `CLUSTER: ${cluster.primaryTitle}
SOURCES (${cluster.sourceCount}): ${topSourcesStr}
REGION: ${cluster.region} | THREAT: ${cluster.threatLevel}
KEYWORDS: ${cluster.mergedKeywords.join(', ')}
TIMELINE: First reported ${formatTimeAgo(cluster.firstSeen)}, latest update ${formatTimeAgo(cluster.lastUpdated)}
Write a brief news report.`,
    },
  ];
}

export function buildAnchorNarrationPrompt(cluster: StoryCluster): ChatMessage[] {
  const velocity = cluster.velocityScore;
  const developing = velocity > 2 ? 'Yes, story gaining momentum' : 'Stable coverage';

  return [
    {
      role: 'system',
      content: 'You are a professional news anchor. Write a broadcast-style narration of this story. Conversational but factual. Use present tense.',
    },
    {
      role: 'user',
      content: `HEADLINE: ${cluster.primaryTitle}
COVERAGE: ${cluster.sourceCount} sources across ${cluster.region}
KEY FACTS: ${cluster.mergedKeywords.join(', ')}
DEVELOPING: ${developing}
Deliver this as a 30-second news anchor read.`,
    },
  ];
}

export function buildBatchTop5Prompt(clusters: StoryCluster[]): ChatMessage[] {
  const lines = clusters.slice(0, 5).map((c, i) =>
    `${i + 1}. ${c.primaryTitle} (${c.sourceCount} sources, ${c.region})`
  ).join('\n');

  return [
    {
      role: 'system',
      content: 'Summarize each story below in exactly 1 sentence. Number them 1-5. No extra commentary.',
    },
    {
      role: 'user',
      content: lines,
    },
  ];
}
