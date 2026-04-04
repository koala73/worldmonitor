import type {
  ResilienceServiceHandler,
  ServerContext,
  GetResilienceScoreRequest,
  GetResilienceScoreResponse,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { ensureResilienceScoreCached } from './_shared';

export const getResilienceScore: ResilienceServiceHandler['getResilienceScore'] = async (
  _ctx: ServerContext,
  req: GetResilienceScoreRequest,
): Promise<GetResilienceScoreResponse> => {
  return ensureResilienceScoreCached(req.countryCode);
};
