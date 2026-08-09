import type { NewsItem } from '@/types';

export function buildNewsContext(getLatestNews: () => NewsItem[], limit = 15): string {
  const news = getLatestNews().slice(0, limit);
  if (news.length === 0) return '';
  return 'Recent News:\n' + news.map(n => `- ${n.title} (${n.source})`).join('\n');
}
