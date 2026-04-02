import type {
  ServerContext,
  ListUcdpEventsRequest,
  ListUcdpEventsResponse,
  UcdpViolenceEvent,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const CACHE_KEY = 'conflict:ucdp-events:v1';

// All UCDP fetching happens on Railway (ais-relay.cjs seedUcdpEvents loop).
// This handler reads pre-seeded data from Redis only.
// Gold standard: Vercel reads, Railway writes.

export async function listUcdpEvents(
  _ctx: ServerContext,
  req: ListUcdpEventsRequest,
): Promise<ListUcdpEventsResponse> {
  try {
    const raw = await getCachedJson(CACHE_KEY, true) as { events?: UcdpViolenceEvent[] } | null;
    if (!raw?.events?.length) return { events: [], pagination: undefined };
    let events = raw.events;
    if (req.country) events = events.filter((e) => e.country === req.country);
    return { events, pagination: undefined };
  } catch {
    return { events: [], pagination: undefined };
  }
}
