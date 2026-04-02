import type {
  SupplyChainServiceHandler,
  ServerContext,
  GetShippingStressRequest,
  GetShippingStressResponse,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const REDIS_KEY = 'supply_chain:shipping_stress:v1';

export const getShippingStress: SupplyChainServiceHandler['getShippingStress'] = async (
  _ctx: ServerContext,
  _req: GetShippingStressRequest,
): Promise<GetShippingStressResponse> => {
  const data = (await getCachedJson(REDIS_KEY, true)) as GetShippingStressResponse | null;
  return data ?? { carriers: [], stressScore: 0, stressLevel: 'low', fetchedAt: 0, upstreamUnavailable: true };
};
