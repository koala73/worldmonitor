import type { Hotspot } from '@/types';
import { t } from '@/services/i18n';
import {
  IntelligenceServiceClient,
  type GdeltArticle as ProtoGdeltArticle,
  type SearchGdeltDocumentsResponse,
} from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { createCircuitBreaker } from '@/utils';

export interface GdeltArticle {
  title: string;
  url: string;
  source: string;
  date: string;
  image?: string;
  language?: string;
  tone?: number;
}

export interface IntelTopic {
  id: string;
  name: string;
  query: string;
  icon: string;
  description: string;
}

export interface TopicIntelligence {
  topic: IntelTopic;
  articles: GdeltArticle[];
  fetchedAt: Date;
}

export const INTEL_TOPICS: IntelTopic[] = [
  {
    id: 'military',
    name: 'Military Activity',
    query: '(military exercise OR troop deployment OR airstrike OR "naval exercise") sourcelang:eng',
    icon: '⚔️',
    description: 'Military exercises, deployments, and operations',
  },
  {
    id: 'cyber',
    name: 'Cyber Threats',
    query: '(cyberattack OR ransomware OR hacking OR "data breach" OR APT) sourcelang:eng',
    icon: '🔓',
    description: 'Cyber attacks, ransomware, and digital threats',
  },
  {
    id: 'nuclear',
    name: 'Nuclear',
    query: '(nuclear OR uranium enrichment OR IAEA OR "nuclear weapon" OR plutonium) sourcelang:eng',
    icon: '☢️',
    description: 'Nuclear programs, IAEA inspections, proliferation',
  },
  {
    id: 'sanctions',
    name: 'Sanctions',
    query: '(sanctions OR embargo OR "trade war" OR tariff OR "economic pressure") sourcelang:eng',
    icon: '🚫',
    description: 'Economic sanctions and trade restrictions',
  },
  {
    id: 'intelligence',
    name: 'Intelligence',
    query: '(espionage OR spy OR intelligence agency OR covert OR surveillance) sourcelang:eng',
    icon: '🕵️',
    description: 'Espionage, intelligence operations, surveillance',
  },
  {
    id: 'maritime',
    name: 'Maritime Security',
    query: '(naval blockade OR piracy OR "strait of hormuz" OR "south china sea" OR warship) sourcelang:eng',
    icon: '🚢',
    description: 'Naval operations, maritime chokepoints, sea lanes',
  },
];

export function getIntelTopics(): IntelTopic[] {
  return INTEL_TOPICS.map(topic => ({
    ...topic,
    name: t(`intel.topics.${topic.id}.name`),
    description: t(`intel.topics.${topic.id}.description`),
  }));
}

// ---- Sebuf client ----

const client = new IntelligenceServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const gdeltBreaker = createCircuitBreaker<SearchGdeltDocumentsResponse>({ name: 'GDELT Intelligence' });

const emptyGdeltFallback: SearchGdeltDocumentsResponse = { articles: [], query: '', error: '' };

const CACHE_TTL = 5 * 60 * 1000;
const articleCache = new Map<string, { articles: GdeltArticle[]; timestamp: number }>();

/** Map proto GdeltArticle (all required strings) to service GdeltArticle (optional fields) */
function toGdeltArticle(a: ProtoGdeltArticle): GdeltArticle {
  return {
    title: a.title,
    url: a.url,
    source: a.source,
    date: a.date,
    image: a.image || undefined,
    language: a.language || undefined,
    tone: a.tone || undefined,
  };
}

export async function fetchGdeltArticles(
  query: string,
  maxrecords = 10,
  timespan = '24h'
): Promise<GdeltArticle[]> {
  const cacheKey = `${query}:${maxrecords}:${timespan}`;
  const cached = articleCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.articles;
  }

  const resp = await gdeltBreaker.execute(async () => {
    return client.searchGdeltDocuments({
      query,
      maxRecords: maxrecords,
      timespan,
    });
  }, emptyGdeltFallback);

  if (resp.error) {
    console.warn(`[GDELT-Intel] RPC error: ${resp.error}`);
    return cached?.articles || [];
  }

  const articles: GdeltArticle[] = (resp.articles || []).map(toGdeltArticle);

  articleCache.set(cacheKey, { articles, timestamp: Date.now() });
  return articles;
}

export async function fetchHotspotContext(hotspot: Hotspot): Promise<GdeltArticle[]> {
  const query = hotspot.keywords.slice(0, 5).join(' OR ');
  return fetchGdeltArticles(query, 8, '48h');
}

export async function fetchTopicIntelligence(topic: IntelTopic): Promise<TopicIntelligence> {
  const articles = await fetchGdeltArticles(topic.query, 10, '24h');
  return {
    topic,
    articles,
    fetchedAt: new Date(),
  };
}

export async function fetchAllTopicIntelligence(): Promise<TopicIntelligence[]> {
  const results = await Promise.allSettled(
    INTEL_TOPICS.map(topic => fetchTopicIntelligence(topic))
  );

  return results
    .filter((r): r is PromiseFulfilledResult<TopicIntelligence> => r.status === 'fulfilled')
    .map(r => r.value);
}

export function formatArticleDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    // GDELT returns compact format: "20260111T093000Z"
    const year = dateStr.slice(0, 4);
    const month = dateStr.slice(4, 6);
    const day = dateStr.slice(6, 8);
    const hour = dateStr.slice(9, 11);
    const min = dateStr.slice(11, 13);
    const sec = dateStr.slice(13, 15);
    const date = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
    if (isNaN(date.getTime())) return '';

    const now = Date.now();
    const diff = now - date.getTime();

    if (diff < 0) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  } catch {
    return '';
  }
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return '';
  }
}
