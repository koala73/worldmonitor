import { getApiBaseUrl } from '@/services/runtime';
import { isFeatureAvailable } from '@/services/runtime-config';
import type { NewsItem } from '@/types';

interface NewsDataArticle {
  id: string;
  source: string;
  title: string;
  link: string;
  pubDate: string;
  description: string;
  imageUrl?: string;
}

function toNewsItem(a: NewsDataArticle): NewsItem {
  return {
    source: a.source,
    title: a.title,
    link: a.link,
    pubDate: new Date(a.pubDate),
    isAlert: false,
    threat: { level: 'info', category: 'general', source: 'keyword', confidence: 0 },
  };
}

export async function fetchNewsDataFeed(query = 'world news'): Promise<NewsItem[]> {
  if (!isFeatureAvailable('newsDataFeed')) return [];
  try {
    const params = new URLSearchParams({ q: query });
    const res = await fetch(`${getApiBaseUrl()}/api/newsdata-feed?${params}`);
    if (!res.ok) return [];
    const articles = (await res.json()) as NewsDataArticle[];
    return Array.isArray(articles) ? articles.map(toNewsItem) : [];
  } catch {
    return [];
  }
}
