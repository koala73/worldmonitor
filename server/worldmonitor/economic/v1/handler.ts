import type { EconomicServiceHandler } from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getFredSeries } from './get-fred-series';
import { getFredSeriesBatch } from './get-fred-series-batch';
import { listWorldBankIndicators } from './list-world-bank-indicators';
import { getEnergyPrices } from './get-energy-prices';
import { getMacroSignals } from './get-macro-signals';
import { getEnergyCapacity } from './get-energy-capacity';
import { getBisPolicyRates } from './get-bis-policy-rates';
import { getBisExchangeRates } from './get-bis-exchange-rates';
import { getBisCredit } from './get-bis-credit';
import { listGroceryBasketPrices } from './list-grocery-basket-prices';
import { listBigMacPrices } from './list-bigmac-prices';
import { getNationalDebt } from './get-national-debt';
import { listFuelPrices } from './list-fuel-prices';
import { getBlsSeries } from './get-bls-series';
import { getEconomicCalendar } from './get-economic-calendar';
import { getCrudeInventories } from './get-crude-inventories';
import { getNatGasStorage } from './get-nat-gas-storage';
import { getEcbFxRates } from './get-ecb-fx-rates';
import { getEurostatCountryData } from './get-eurostat-country-data';
import { getEuGasStorage } from './get-eu-gas-storage';
import { getEuYieldCurve } from './get-eu-yield-curve';
import { getEuFsi } from './get-eu-fsi';
import { getEconomicStress } from './get-economic-stress';
import { getFaoFoodPriceIndex } from './get-fao-food-price-index';

export const economicHandler: EconomicServiceHandler = {
  getFredSeries,
  getFredSeriesBatch,
  listWorldBankIndicators,
  getEnergyPrices,
  getMacroSignals,
  getEnergyCapacity,
  getBisPolicyRates,
  getBisExchangeRates,
  getBisCredit,
  listGroceryBasketPrices,
  listBigMacPrices,
  getNationalDebt,
  listFuelPrices,
  getBlsSeries,
  getEconomicCalendar,
  getCrudeInventories,
  getNatGasStorage,
  getEcbFxRates,
  getEurostatCountryData,
  getEuGasStorage,
  getEuYieldCurve,
  getEuFsi,
  getEconomicStress,
  getFaoFoodPriceIndex,
};
