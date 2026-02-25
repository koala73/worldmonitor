import type { SupplyChainServiceHandler } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getShippingRates } from './get-shipping-rates';
import { getChokepointStatus } from './get-chokepoint-status';
import { getCriticalMinerals } from './get-critical-minerals';

export const supplyChainHandler: SupplyChainServiceHandler = {
  getShippingRates,
  getChokepointStatus,
  getCriticalMinerals,
};
