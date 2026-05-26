import type { ResilienceServiceHandler } from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { getResilienceRanking } from './get-resilience-ranking';
import { getResilienceScore } from './get-resilience-score';

export const resilienceHandler: ResilienceServiceHandler = {
  getResilienceScore,
  getResilienceRanking,
};
