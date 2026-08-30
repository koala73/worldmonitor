import type { ResilienceServiceHandler } from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { getDemographicsCapability } from './get-demographics-capability';
import { getFoodStocks } from './get-food-stocks';
import { getResilienceRanking } from './get-resilience-ranking';
import { getResilienceIndicators } from './get-resilience-indicators';
import { getResilienceRuntimeManifest } from './get-resilience-runtime-manifest';
import { getResilienceScore } from './get-resilience-score';

export const resilienceHandler: ResilienceServiceHandler = {
  getResilienceScore,
  getResilienceIndicators,
  getFoodStocks,
  getDemographicsCapability,
  getResilienceRanking,
  getResilienceRuntimeManifest,
};
