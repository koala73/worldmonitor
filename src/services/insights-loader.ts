import { getHydratedData } from '@/services/bootstrap';

export interface ServerInsightStory {
  primaryTitle: string;
  primarySource: string;
  primaryLink: string;
  pubDate: string;
  sourceCount: number;
  importanceScore: number;
  velocity: { level: string; sourcesPerHour: number };
  isAlert: boolean;
  category: string;
  threatLevel: string;
  countryCode: string | null;
}

export interface ServerInsights {
  worldBrief: string;
  briefProvider: string;
  status: 'ok' | 'degraded';
  topStories: ServerInsightStory[];
  generatedAt: string;
  clusterCount: number;
  multiSourceCount: number;
  fastMovingCount: number;
}

let cached: ServerInsights | null = null;
const MAX_AGE_MS = 15 * 60 * 1000;

function isFresh(data: ServerInsights): boolean {
  const age = Date.now() - new Date(data.generatedAt).getTime();
  return age < MAX_AGE_MS;
}

export function getServerInsights(): ServerInsights | null {
  if (cached && isFresh(cached)) {
    return cached;
  }
  cached = null;

  const raw = getHydratedData('insights');
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as ServerInsights;
  if (!Array.isArray(data.topStories) || data.topStories.length === 0) return null;
  if (typeof data.generatedAt !== 'string') return null;
  if (!isFresh(data)) return null;

  cached = data;
  return data;
}

export function setServerInsights(data: ServerInsights): void {
  cached = data;
}
