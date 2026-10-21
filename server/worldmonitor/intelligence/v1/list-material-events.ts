/**
 * RPC: listMaterialEvents — pre-seeded stream of recent SEC 8-K material-event
 * filings across all filers (issue #5695). Pure Redis read of the snapshot
 * published by scripts/seed-sec-8k-stream.mjs; no upstream fetch.
 */

import type {
  ServerContext,
  ListMaterialEventsRequest,
  ListMaterialEventsResponse,
  MaterialEvent,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { SEC_8K_STREAM_KEY } from '../../../_shared/sec-edgar';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const ITEM_CODE_RE = /^\d+\.\d{2}$/;

interface SeededStream {
  events?: MaterialEvent[];
  fetchedAt?: string;
}

export async function listMaterialEvents(
  _ctx: ServerContext,
  req: ListMaterialEventsRequest,
): Promise<ListMaterialEventsResponse> {
  const itemCode = req.itemCode?.trim() ?? '';
  // Fail closed: silently ignoring a malformed filter would return the entire
  // unfiltered stream, which reads as "these are all 5.02 events".
  if (itemCode && !ITEM_CODE_RE.test(itemCode)) {
    throw new ValidationError([{ field: 'item_code', description: 'item_code must be an 8-K item code such as 5.02' }]);
  }
  const limit = req.limit > 0 ? Math.min(req.limit, MAX_LIMIT) : DEFAULT_LIMIT;

  try {
    const raw = (await getCachedJson(SEC_8K_STREAM_KEY, true)) as SeededStream | null;
    if (!raw || !Array.isArray(raw.events)) {
      return { events: [], unavailable: true, fetchedAtMs: 0 };
    }

    let events = raw.events.filter(event => Array.isArray(event?.items) && event.items.length > 0);
    if (itemCode) {
      events = events.filter(event => event.items.some(item => item.code === itemCode));
    }

    return {
      events: events.slice(0, limit).map(event => ({
        company: event.company ?? '',
        cik: event.cik ?? '',
        form: event.form ?? '',
        accession: event.accession ?? '',
        filedAtMs: event.filedAtMs ?? 0,
        items: event.items.map(item => ({ code: item.code ?? '', description: item.description ?? '' })),
        url: event.url ?? '',
      })),
      unavailable: false,
      fetchedAtMs: raw.fetchedAt ? Date.parse(raw.fetchedAt) || 0 : 0,
    };
  } catch {
    return { events: [], unavailable: true, fetchedAtMs: 0 };
  }
}
