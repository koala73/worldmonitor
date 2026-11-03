import type {
  ServerContext,
  GetCapitalFlowsRequest,
  GetCapitalFlowsResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { getCachedJson, getCachedJsonBatch } from '../../../_shared/redis';
import { CAPITAL_FLOWS_KEY, CAPITAL_FLOWS_PAIRS_KEY, buildCapitalFlowsResponse, unavailableCapitalFlows } from './capital-flows';

export async function getCapitalFlows(
  _ctx: ServerContext,
  req: GetCapitalFlowsRequest,
): Promise<GetCapitalFlowsResponse> {
  try {
    const country = typeof req.country === 'string' ? req.country : '';
    const counterpart = typeof req.counterpart === 'string' ? req.counterpart : '';
    // raw=true: the seeder writes unprefixed keys. The pair matrices are read
    // only for a pair query (country and counterpart both set).
    if (country.trim() && counterpart.trim()) {
      const shards = await getCachedJsonBatch([CAPITAL_FLOWS_KEY, CAPITAL_FLOWS_PAIRS_KEY], true);
      return buildCapitalFlowsResponse(shards.get(CAPITAL_FLOWS_KEY) ?? null, country, req.includeSeries === true, {
        counterpart,
        pairsRaw: shards.get(CAPITAL_FLOWS_PAIRS_KEY) ?? null,
      });
    }
    const raw = await getCachedJson(CAPITAL_FLOWS_KEY, true);
    return buildCapitalFlowsResponse(raw, country, req.includeSeries === true);
  } catch {
    return unavailableCapitalFlows();
  }
}
