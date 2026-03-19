import type { NewsItem } from '@/types';

export function buildNewsContext(getLatestNews: () => NewsItem[], limit = 15): string {
  const news = getLatestNews().slice(0, limit);
  if (news.length === 0) return '';
  return 'Recent News:\n' + news.map(n => `- ${n.title} (${n.source})`).join('\n');
}

export function buildNewsContextFromItems(items: NewsItem[], limit = 15): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of items) {
    if (lines.length >= limit) break;
    const key = item.title.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const ts = item.pubDate instanceof Date ? item.pubDate.toISOString() : String(item.pubDate);
    const tier = item.tier != null ? ` | tier-${item.tier}` : '';
    const loc = item.locationName ? ` | ${item.locationName}` : '';
    lines.push(`- ${ts} | ${item.source}${tier} | ${item.title}${loc}`);
  }
  if (lines.length === 0) return '';
  return 'Recent News Signal Snapshot:\n' + lines.join('\n');
}
