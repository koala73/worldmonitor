import type {
  ResilienceServiceHandler,
  ServerContext,
  GetResilienceScoreRequest,
  GetResilienceScoreResponse,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { ensureResilienceScoreCached } from './_shared';

export const getResilienceScore: ResilienceServiceHandler['getResilienceScore'] = async (
  _ctx: ServerContext,
  req: GetResilienceScoreRequest,
): Promise<GetResilienceScoreResponse> => {
  const countryCode = String(req.countryCode || '').trim().toUpperCase();
  if (!countryCode) {
    throw new ValidationError([{ field: 'countryCode', description: 'countryCode is required' }]);
  }
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new ValidationError([{ field: 'countryCode', description: 'countryCode must be a 2-letter ISO 3166-1 alpha-2 code' }]);
  }

  return ensureResilienceScoreCached(countryCode);
};
