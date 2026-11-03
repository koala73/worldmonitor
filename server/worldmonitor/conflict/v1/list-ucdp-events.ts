import type {
  ServerContext,
  ListUcdpEventsRequest,
  ListUcdpEventsResponse,
  UcdpViolenceEvent,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { resolveCountryCode } from '../../../../shared/country-code-resolve';

const CACHE_KEY = 'conflict:ucdp-events:v1';

// All UCDP fetching happens on Railway (ais-relay.cjs seedUcdpEvents loop).
// This handler reads pre-seeded data from Redis only.
// Gold standard: Vercel reads, Railway writes.

export async function listUcdpEvents(
  ctx: ServerContext,
  req: ListUcdpEventsRequest,
): Promise<ListUcdpEventsResponse> {
  try {
    const raw = await getCachedJson(CACHE_KEY, true) as { events?: UcdpViolenceEvent[] } | null;
    if (!raw?.events?.length) return markNoStoreFallbackResponse(ctx.request, { events: [], pagination: undefined });
    let events = raw.events;
    if (req.country) {
      const country = resolveCountryCode(req.country);
      events = country ? events.filter((e) => resolveCountryCode(e.country) === country) : [];
    }
    return { events, pagination: undefined };
  } catch {
    return markNoStoreFallbackResponse(ctx.request, { events: [], pagination: undefined });
  }
}
