import type {
  ResilienceServiceHandler,
  ServerContext,
  GetResilienceScoreRequest,
  GetResilienceScoreResponse,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { isAssignedCountryCode } from '../../../../shared/country-code-resolve';
import { ensureResilienceScoreCached } from './_shared';

export const getResilienceScore: ResilienceServiceHandler['getResilienceScore'] = async (
  _ctx: ServerContext,
  req: GetResilienceScoreRequest,
): Promise<GetResilienceScoreResponse> => {
  const countryCode = String(req.countryCode || '').trim().toUpperCase();
  if (!countryCode) {
    throw new ValidationError([{ field: 'countryCode', description: 'countryCode is required' }]);
  }
  // Shape alone let ZZ through to a scored, cached record built from imputed
  // defaults: a fabricated country with a resilience level.
  if (!isAssignedCountryCode(countryCode)) {
    throw new ValidationError([{ field: 'countryCode', description: 'countryCode must be an assigned ISO 3166-1 alpha-2 code, e.g. "IQ".' }]);
  }
  return ensureResilienceScoreCached(countryCode);
};
