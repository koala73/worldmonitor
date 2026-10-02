import type { NewsItem } from '@/types';

export function buildNewsContext(getLatestNews: () => NewsItem[], limit = 15): string {
  const news = getLatestNews().slice(0, limit);
  if (news.length === 0) return '';
  return 'Recent News: (JSON records)\n' + news.map(({ title, source }) => {
    // Quote fields as data; JSON permits these Unicode line breaks literally.
    const record = JSON.stringify({ title, source }).replace(
      /[\u0085\u2028\u2029]/g,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    return `- ${record}`;
  }).join('\n');
}
