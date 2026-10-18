import type {
  ServerContext,
  GetCapitalFlowsRequest,
  GetCapitalFlowsResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { CAPITAL_FLOWS_KEY, buildCapitalFlowsResponse, unavailableCapitalFlows } from './capital-flows';

export async function getCapitalFlows(
  _ctx: ServerContext,
  req: GetCapitalFlowsRequest,
): Promise<GetCapitalFlowsResponse> {
  try {
    // raw=true: the seeder writes an unprefixed key.
    const raw = await getCachedJson(CAPITAL_FLOWS_KEY, true);
    return buildCapitalFlowsResponse(raw, typeof req.country === 'string' ? req.country : '', req.includeSeries === true);
  } catch {
    return unavailableCapitalFlows();
  }
}
