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
// Server cron interval: scripts/seed-insights.mjs runs every 30 min
// (CACHE_TTL=10800s/3h, maxStaleMin: 30). The previous 15-min freshness gate
// was strictly less than the cron interval, so the panel spent ~50% of every
// 30-min cycle showing UNAVAILABLE + "Waiting for data..." even when the
// system was working perfectly. 60 min = 2× cron interval, gives one full
// missed-tick of headroom before falling through to the client-side path.
// Exported so the regression test asserts against the real value rather than
// inlining a copy that drifts silently when this constant changes.
export const MAX_AGE_MS = 60 * 60 * 1000;

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
