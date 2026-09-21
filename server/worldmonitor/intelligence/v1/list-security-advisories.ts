import type {
  ServerContext,
  ListSecurityAdvisoriesRequest,
  ListSecurityAdvisoriesResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { readRequiredSeed } from '../../../_shared/required-seed';

const ADVISORY_KEY = 'intelligence:advisories:v1';

export async function listSecurityAdvisories(
  _ctx: ServerContext,
  _req: ListSecurityAdvisoriesRequest,
): Promise<ListSecurityAdvisoriesResponse> {
  return readRequiredSeed(ADVISORY_KEY, value => {
    const data = value as ListSecurityAdvisoriesResponse | null;
    return data && Array.isArray(data.advisories)
      ? { advisories: data.advisories, byCountry: data.byCountry || {} }
      : undefined;
  });
}
