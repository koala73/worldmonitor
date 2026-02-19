import { API_URLS } from '@/config';
import { createCircuitBreaker, fetchWithCache } from '@/utils';

export interface HackerNewsStory {
  id: number;
  title: string;
  url?: string;
  text?: string;
  by: string;
  score: number;
  time: Date;
  descendants: number; // comment count
  type: 'story' | 'job' | 'poll' | 'comment';
}

interface HNApiResponse {
  type: string;
  stories: any[];
  total: number;
  timestamp: string;
}

const breaker = createCircuitBreaker<HackerNewsStory[]>({ name: 'Hacker News' });

export async function fetchHackerNews(
  type: string = 'top',
  limit: number = 30
): Promise<HackerNewsStory[]> {
  return breaker.execute(async () => {
    const data = await fetchWithCache<HNApiResponse>(API_URLS.hackernews(type, limit), { ttl: 60_000 });

    return data.stories.map((story: any) => ({
      id: story.id || 0,
      title: story.title || '',
      url: story.url,
      text: story.text,
      by: story.by || 'unknown',
      score: story.score || 0,
      time: new Date((story.time || 0) * 1000), // HN uses Unix timestamps
      descendants: story.descendants || 0,
      type: story.type || 'story',
    }));
  }, []);
}

// Fetch top tech/AI stories from HN
export async function fetchTopTechStories(): Promise<HackerNewsStory[]> {
  const stories = await fetchHackerNews('top', 50);

  // Filter for tech/AI related stories
  const techKeywords = [
    'ai', 'ml', 'llm', 'gpt', 'claude', 'openai', 'anthropic', 'google',
    'microsoft', 'meta', 'apple', 'nvidia', 'chip', 'gpu', 'model',
    'algorithm', 'data', 'cloud', 'aws', 'azure', 'serverless',
    'startup', 'vc', 'funding', 'acquisition', 'ipo', 'tech', 'software',
    'programming', 'code', 'github', 'open source', 'cybersecurity',
    'blockchain', 'crypto', 'web3', 'developer', 'api', 'framework'
  ];

  const techStories = stories.filter(story => {
    const searchText = `${story.title} ${story.text || ''}`.toLowerCase();
    return techKeywords.some(keyword => searchText.includes(keyword));
  });

  return techStories.slice(0, 30);
}

// Fetch Show HN and Ask HN stories
export async function fetchShowHN(): Promise<HackerNewsStory[]> {
  const stories = await fetchHackerNews('top', 100);
  return stories.filter(s => s.title.toLowerCase().startsWith('show hn')).slice(0, 20);
}

export async function fetchAskHN(): Promise<HackerNewsStory[]> {
  const stories = await fetchHackerNews('top', 100);
  return stories.filter(s => s.title.toLowerCase().startsWith('ask hn')).slice(0, 20);
}

export function getHackerNewsStatus(): string {
  return breaker.getStatus();
}
