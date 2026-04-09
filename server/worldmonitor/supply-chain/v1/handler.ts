import type { SupplyChainServiceHandler } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getShippingRates } from './get-shipping-rates';
import { getChokepointStatus } from './get-chokepoint-status';
import { getCriticalMinerals } from './get-critical-minerals';
import { getShippingStress } from './get-shipping-stress';
import { getCountryChokepointIndex } from './get-country-chokepoint-index';
import { getBypassOptions } from './get-bypass-options';
import { getCountryCostShock } from './get-country-cost-shock';

export const supplyChainHandler: SupplyChainServiceHandler = {
  getShippingRates,
  getChokepointStatus,
  getCriticalMinerals,
  getShippingStress,
  getCountryChokepointIndex,
  getBypassOptions,
  getCountryCostShock,
};
