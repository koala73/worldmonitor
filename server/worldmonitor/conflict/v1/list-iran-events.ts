import type {
  ServerContext,
  ListIranEventsRequest,
  ListIranEventsResponse,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const REDIS_KEY = 'conflict:iran-events:v1';

export async function listIranEvents(
  _ctx: ServerContext,
  _req: ListIranEventsRequest,
): Promise<ListIranEventsResponse> {
  try {
    const cached = await getCachedJson(REDIS_KEY);
    if (cached && typeof cached === 'object' && 'events' in (cached as Record<string, unknown>)) {
      return cached as ListIranEventsResponse;
    }
    return { events: [], scrapedAt: 0 };
  } catch {
    return { events: [], scrapedAt: 0 };
  }
}
