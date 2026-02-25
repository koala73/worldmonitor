import type { EconomicServiceHandler } from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getFredSeries } from './get-fred-series';
import { listWorldBankIndicators } from './list-world-bank-indicators';
import { getEnergyPrices } from './get-energy-prices';
import { getMacroSignals } from './get-macro-signals';
import { getEnergyCapacity } from './get-energy-capacity';
import { getBisPolicyRates } from './get-bis-policy-rates';
import { getBisExchangeRates } from './get-bis-exchange-rates';
import { getBisCredit } from './get-bis-credit';

export const economicHandler: EconomicServiceHandler = {
  getFredSeries,
  listWorldBankIndicators,
  getEnergyPrices,
  getMacroSignals,
  getEnergyCapacity,
  getBisPolicyRates,
  getBisExchangeRates,
  getBisCredit,
};
