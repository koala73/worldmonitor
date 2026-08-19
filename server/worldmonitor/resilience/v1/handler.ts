import type { ResilienceServiceHandler } from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { getDemographicsCapability } from './get-demographics-capability';
import { getFoodStocks } from './get-food-stocks';
import { getResilienceRanking } from './get-resilience-ranking';
import { getResilienceRuntimeManifest } from './get-resilience-runtime-manifest';
import { getResilienceScore } from './get-resilience-score';

export const resilienceHandler: ResilienceServiceHandler = {
  getResilienceScore,
  getFoodStocks,
  getDemographicsCapability,
  getResilienceRanking,
  getResilienceRuntimeManifest,
};
