import type { SupplyChainServiceHandler } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getShippingRates } from './get-shipping-rates';
import { getChokepointStatus } from './get-chokepoint-status';
import { getChokepointHistory } from './get-chokepoint-history';
import { getCriticalMinerals } from './get-critical-minerals';
import { getShippingStress } from './get-shipping-stress';
import { getCountryChokepointIndex } from './get-country-chokepoint-index';
import { getBypassOptions } from './get-bypass-options';
import { getCountryCostShock } from './get-country-cost-shock';
import { getCountryProducts } from './get-country-products';
import { getMultiSectorCostShock } from './get-multi-sector-cost-shock';
import { getSectorDependency } from './get-sector-dependency';
import { getRouteExplorerLane } from './get-route-explorer-lane';
import { getRouteImpact } from './get-route-impact';
import { listPipelines } from './list-pipelines';
import { getPipelineDetail } from './get-pipeline-detail';
import { listStorageFacilities } from './list-storage-facilities';
import { getStorageFacilityDetail } from './get-storage-facility-detail';
import { listFuelShortages } from './list-fuel-shortages';
import { getFuelShortageDetail } from './get-fuel-shortage-detail';
import { listEnergyDisruptions } from './list-energy-disruptions';

export const supplyChainHandler: SupplyChainServiceHandler = {
  getShippingRates,
  getChokepointStatus,
  getChokepointHistory,
  getCriticalMinerals,
  getShippingStress,
  getCountryChokepointIndex,
  getBypassOptions,
  getCountryCostShock,
  getCountryProducts,
  getMultiSectorCostShock,
  getSectorDependency,
  getRouteExplorerLane,
  getRouteImpact,
  listPipelines,
  getPipelineDetail,
  listStorageFacilities,
  getStorageFacilityDetail,
  listFuelShortages,
  getFuelShortageDetail,
  listEnergyDisruptions,
};
