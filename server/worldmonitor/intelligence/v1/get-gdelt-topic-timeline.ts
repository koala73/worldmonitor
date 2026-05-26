import type {
  ServerContext,
  GetGdeltTopicTimelineRequest,
  GetGdeltTopicTimelineResponse,
  GdeltTimelinePoint,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const VALID_TOPICS = new Set(['military', 'cyber', 'nuclear', 'sanctions', 'intelligence', 'maritime']);

export async function getGdeltTopicTimeline(
  _ctx: ServerContext,
  req: GetGdeltTopicTimelineRequest,
): Promise<GetGdeltTopicTimelineResponse> {
  const topic = (req.topic ?? '').trim().toLowerCase();
  if (!topic || !VALID_TOPICS.has(topic)) {
    return { topic, tone: [], vol: [], fetchedAt: '', error: 'invalid topic' };
  }

  try {
    const [toneData, volData] = await Promise.all([
      getCachedJson(`gdelt:intel:tone:${topic}`, true),
      getCachedJson(`gdelt:intel:vol:${topic}`, true),
    ]);

    const unwrap = (d: unknown): { arr: GdeltTimelinePoint[]; fetchedAt: string } => {
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        const obj = d as { data?: unknown[]; fetchedAt?: string };
        return { arr: Array.isArray(obj.data) ? (obj.data as GdeltTimelinePoint[]) : [], fetchedAt: obj.fetchedAt ?? '' };
      }
      return { arr: Array.isArray(d) ? (d as GdeltTimelinePoint[]) : [], fetchedAt: '' };
    };

    const { arr: tone, fetchedAt: toneFetchedAt } = unwrap(toneData);
    const { arr: vol, fetchedAt: volFetchedAt } = unwrap(volData);
    const fetchedAt = toneFetchedAt || volFetchedAt;

    return { topic, tone, vol, fetchedAt, error: '' };
  } catch {
    return { topic, tone: [], vol: [], fetchedAt: '', error: 'unavailable' };
  }
}
