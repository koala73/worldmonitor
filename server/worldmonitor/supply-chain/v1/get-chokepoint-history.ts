import type {
  ServerContext,
  GetChokepointHistoryRequest,
  GetChokepointHistoryResponse,
  TransitDayCount,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { CANONICAL_CHOKEPOINTS } from './_chokepoint-ids';

const HISTORY_KEY_PREFIX = 'supply_chain:transit-summaries:history:v1:';
const VALID_IDS = new Set(CANONICAL_CHOKEPOINTS.map(c => c.id));

interface HistoryPayload {
  chokepointId: string;
  history: TransitDayCount[];
  fetchedAt: number;
}

export async function getChokepointHistory(
  _ctx: ServerContext,
  req: GetChokepointHistoryRequest,
): Promise<GetChokepointHistoryResponse> {
  const id = String(req.chokepointId || '').trim();
  if (!id || !VALID_IDS.has(id)) {
    return { chokepointId: '', history: [], fetchedAt: '0' };
  }

  try {
    const payload = await getCachedJson(`${HISTORY_KEY_PREFIX}${id}`, true) as HistoryPayload | null;
    if (!payload || !Array.isArray(payload.history)) {
      return { chokepointId: id, history: [], fetchedAt: '0' };
    }
    return {
      chokepointId: id,
      history: payload.history,
      fetchedAt: String(payload.fetchedAt ?? 0),
    };
  } catch {
    return { chokepointId: id, history: [], fetchedAt: '0' };
  }
}
