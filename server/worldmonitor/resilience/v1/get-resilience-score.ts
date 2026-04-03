import type {
  ResilienceServiceHandler,
  ServerContext,
  GetResilienceScoreRequest,
  GetResilienceScoreResponse,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

export const getResilienceScore: ResilienceServiceHandler['getResilienceScore'] = async (
  _ctx: ServerContext,
  req: GetResilienceScoreRequest,
): Promise<GetResilienceScoreResponse> => {
  const countryCode = String(req.countryCode || '').toUpperCase();

  return {
    countryCode,
    overallScore: 0,
    level: 'unknown',
    domains: [],
    cronbachAlpha: 0,
    trend: 'stable',
    change30d: 0,
    lowConfidence: true,
  };
};
