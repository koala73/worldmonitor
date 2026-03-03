import type {
  ServerContext,
  ListUcdpEventsRequest,
  ListUcdpEventsResponse,
  UcdpViolenceEvent,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const CACHE_KEY = 'conflict:ucdp-events:v1';
const MAX_AGE_MS = 25 * 60 * 60 * 1000; // 25h — reject if cron hasn't refreshed

let fallback: { events: UcdpViolenceEvent[]; ts: number } | null = null;

export async function listUcdpEvents(
  _ctx: ServerContext,
  req: ListUcdpEventsRequest,
): Promise<ListUcdpEventsResponse> {
  try {
    const raw = await getCachedJson(CACHE_KEY, true) as { events?: UcdpViolenceEvent[]; fetchedAt?: number } | null;
    if (raw?.events?.length && (!raw.fetchedAt || (Date.now() - raw.fetchedAt) < MAX_AGE_MS)) {
      fallback = { events: raw.events, ts: Date.now() };
      let events = raw.events;
      if (req.country) events = events.filter((e) => e.country === req.country);
      return { events, pagination: undefined };
    }
  } catch { /* fall through */ }

  if (fallback && (Date.now() - fallback.ts) < 12 * 60 * 60 * 1000) {
    let events = fallback.events;
    if (req.country) events = events.filter((e) => e.country === req.country);
    return { events, pagination: undefined };
  }

  return { events: [], pagination: undefined };
}
