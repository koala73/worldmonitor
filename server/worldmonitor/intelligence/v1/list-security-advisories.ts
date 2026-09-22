import type {
  ServerContext,
  ListSecurityAdvisoriesRequest,
  ListSecurityAdvisoriesResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { readRequiredSeed } from '../../../_shared/required-seed';
import { normalizeAdvisorySnapshot } from '../../../../shared/intelligence-snapshots.js';

const ADVISORY_KEY = 'intelligence:advisories:v1';

export async function listSecurityAdvisories(
  _ctx: ServerContext,
  _req: ListSecurityAdvisoriesRequest,
): Promise<ListSecurityAdvisoriesResponse> {
  // Invalid advisories are dropped; a malformed, thin-coverage or all-invalid
  // snapshot is 503. Confirmed-empty `{ advisories: [], byCountry: {} }` is 200.
  const data = await readRequiredSeed(ADVISORY_KEY, value => normalizeAdvisorySnapshot(value) ?? undefined);
  return {
    advisories: data.advisories.map(a => ({
      title: a.title,
      link: a.link,
      pubDate: a.pubDate,
      source: a.source,
      sourceCountry: a.sourceCountry,
      level: a.level || 'info',
      country: a.country || '',
    })),
    byCountry: data.byCountry,
  };
}
