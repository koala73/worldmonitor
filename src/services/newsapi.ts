import { getApiBaseUrl } from '@/services/runtime';
import { isFeatureAvailable } from '@/services/runtime-config';
import type { NewsItem } from '@/types';

export interface NewsApiArticle {
  id: string;
  source: string;
  title: string;
  link: string;
  pubDate: string;
  description: string;
  imageUrl?: string;
}

function toNewsItem(a: NewsApiArticle): NewsItem {
  return {
    source: a.source,
    title: a.title,
    link: a.link,
    pubDate: new Date(a.pubDate),
    isAlert: false,
    threat: { level: 'info', category: 'general', source: 'keyword', confidence: 0 },
  };
}

export async function fetchNewsApiHeadlines(query = 'geopolitics world news', pageSize = 10): Promise<NewsItem[]> {
  if (!isFeatureAvailable('newsApiHeadlines')) return [];
  try {
    const params = new URLSearchParams({ q: query, pageSize: String(pageSize) });
    const res = await fetch(`${getApiBaseUrl()}/api/newsapi-headlines?${params}`);
    if (!res.ok) return [];
    const articles = (await res.json()) as NewsApiArticle[];
    return Array.isArray(articles) ? articles.map(toNewsItem) : [];
  } catch {
    return [];
  }
}
