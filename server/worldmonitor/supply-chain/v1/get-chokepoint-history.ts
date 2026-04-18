import type {
  ServerContext,
  GetChokepointHistoryRequest,
  GetChokepointHistoryResponse,
  TransitDayCount,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { CANONICAL_CHOKEPOINTS } from './_chokepoint-ids';

const HISTORY_KEY_PREFIX = 'supply_chain:transit-summaries:history:v1:';
const VALID_IDS = new Set(CANONICAL_CHOKEPOINTS.map(c => c.id));

interface HistoryPayload {
  chokepointId: string;
  history: TransitDayCount[];
  fetchedAt: number;
}

export async function getChokepointHistory(
  ctx: ServerContext,
  req: GetChokepointHistoryRequest,
): Promise<GetChokepointHistoryResponse> {
  const id = String(req.chokepointId || '').trim();
  if (!id || !VALID_IDS.has(id)) {
    // Invalid ID: mark no-cache so junk IDs don't pin a 30-min empty on CF.
    markNoCacheResponse(ctx.request);
    return { chokepointId: '', history: [], fetchedAt: '0' };
  }

  try {
    const payload = await getCachedJson(`${HISTORY_KEY_PREFIX}${id}`, true) as HistoryPayload | null;
    if (!payload || !Array.isArray(payload.history) || payload.history.length === 0) {
      // CRITICAL: do NOT let an empty response get CDN-cached. During the
      // deploy window (Vercel deploys instantly; Railway ais-relay takes
      // ~10 min to redeploy and another 10 min for the first transit-summary
      // cron tick), per-id history keys are absent. If we cached empty
      // responses at the 'slow' tier (30-min CDN), users would see "Transit
      // history unavailable" for 30 min AFTER the key got populated, because
      // CF serves stale empty bodies. Mark no-cache so every call re-checks
      // Redis. Cheap — fetch is ~35 KB and edge→Upstash is <1.5s.
      markNoCacheResponse(ctx.request);
      return { chokepointId: id, history: [], fetchedAt: '0' };
    }
    return {
      chokepointId: id,
      history: payload.history,
      fetchedAt: String(payload.fetchedAt ?? 0),
    };
  } catch {
    markNoCacheResponse(ctx.request);
    return { chokepointId: id, history: [], fetchedAt: '0' };
  }
}
