import type {
  LookupSanctionEntityRequest,
  LookupSanctionEntityResponse,
  SanctionsServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/sanctions/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { sanctionsIndexRecords, screenSanctions } from '../../../_shared/sanctions-screen';

const ENTITY_INDEX_KEY = 'sanctions:entities:v1';

export const lookupSanctionEntity: SanctionsServiceHandler['lookupSanctionEntity'] = async (
  _ctx: ServerContext,
  req: LookupSanctionEntityRequest,
): Promise<LookupSanctionEntityResponse> => {
  const q = (req.q ?? '').trim();
  if (q.length < 2 || q.length > 200) return { results: [], total: 0, source: 'seeded' };
  const maxResults = Number.isFinite(req.maxResults) && req.maxResults > 0
    ? Math.min(Math.max(Math.trunc(req.maxResults), 1), 50) : 10;
  const raw = await getCachedJson(ENTITY_INDEX_KEY, true);
  if (!Array.isArray(raw)) return { results: [], total: 0, source: 'unavailable' };
  const index = sanctionsIndexRecords(raw);
  if (!index.length) return { results: [], total: 0, source: 'unavailable' };
  const lists = [...new Set(index.flatMap(entry => entry.sl?.length ? entry.sl : [entry.id.split(':')[0] ?? 'OFAC']))].sort();
  const matches = screenSanctions(index, q);
  return {
    results: matches.slice(0, maxResults).map(entry => ({
      id: entry.id, name: entry.name, entityType: entry.et, countryCodes: entry.cc, programs: entry.pr,
    })),
    total: matches.length,
    source: lists.join(', ') || 'seeded',
  };
};
