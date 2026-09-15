import { isAdvisorySnapshot } from '../../../../shared/intelligence-snapshots.js';
import { ApiError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import type {
  ServerContext,
  ListSecurityAdvisoriesRequest,
  ListSecurityAdvisoriesResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { readCachedJson } from '../../../_shared/redis';

const ADVISORY_KEY = 'intelligence:advisories:v1';

export async function listSecurityAdvisories(
  _ctx: ServerContext,
  _req: ListSecurityAdvisoriesRequest,
): Promise<ListSecurityAdvisoriesResponse> {
  const read = await readCachedJson(ADVISORY_KEY, true);
  if (read.status !== 'hit' || !isAdvisorySnapshot(read.value)) {
    throw new ApiError(503, 'Security advisory snapshot unavailable', '');
  }
  const data = read.value as ListSecurityAdvisoriesResponse;
  return {
    advisories: data.advisories.map(a => ({
      title: a.title, link: a.link, pubDate: a.pubDate, source: a.source,
      sourceCountry: a.sourceCountry, level: a.level || 'info', country: a.country || '',
    })),
    byCountry: data.byCountry,
  };
}
