import type {
  ServerContext,
  GetCountryEnergyProfileRequest,
  GetCountryEnergyProfileResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

interface OwidMix {
  year?: number | null;
  coalShare?: number | null;
  gasShare?: number | null;
  oilShare?: number | null;
  nuclearShare?: number | null;
  renewShare?: number | null;
  windShare?: number | null;
  solarShare?: number | null;
  hydroShare?: number | null;
  importShare?: number | null;
}

interface GasStorage {
  fillPct?: number | null;
  fillPctChange1d?: number | null;
  trend?: string | null;
  date?: string | null;
}

interface ElectricityEntry {
  priceMwhEur?: number | null;
  source?: string | null;
  date?: string | null;
}

interface JodiProduct {
  demandKbd?: number | null;
  importsKbd?: number | null;
}

interface JodiOil {
  dataMonth?: string | null;
  gasoline?: JodiProduct | null;
  diesel?: JodiProduct | null;
  jet?: JodiProduct | null;
  lpg?: JodiProduct | null;
  crude?: { importsKbd?: number | null } | null;
}

interface JodiGas {
  dataMonth?: string | null;
  totalDemandTj?: number | null;
  lngImportsTj?: number | null;
  pipeImportsTj?: number | null;
  lngShareOfImports?: number | null;
}

interface IeaStocks {
  dataMonth?: string | null;
  daysOfCover?: number | null;
  netExporter?: boolean | null;
  belowObligation?: boolean | null;
  anomaly?: boolean | null;
}

const EMPTY: GetCountryEnergyProfileResponse = {
  mixAvailable: false,
  mixYear: 0,
  coalShare: 0,
  gasShare: 0,
  oilShare: 0,
  nuclearShare: 0,
  renewShare: 0,
  windShare: 0,
  solarShare: 0,
  hydroShare: 0,
  importShare: 0,
  gasStorageAvailable: false,
  gasStorageFillPct: 0,
  gasStorageChange1d: 0,
  gasStorageTrend: '',
  gasStorageDate: '',
  electricityAvailable: false,
  electricityPriceMwh: 0,
  electricitySource: '',
  electricityDate: '',
  jodiOilAvailable: false,
  jodiOilDataMonth: '',
  gasolineDemandKbd: 0,
  gasolineImportsKbd: 0,
  dieselDemandKbd: 0,
  dieselImportsKbd: 0,
  jetDemandKbd: 0,
  jetImportsKbd: 0,
  lpgDemandKbd: 0,
  lpgImportsKbd: 0,
  crudeImportsKbd: 0,
  jodiGasAvailable: false,
  jodiGasDataMonth: '',
  gasTotalDemandTj: 0,
  gasLngImportsTj: 0,
  gasPipeImportsTj: 0,
  gasLngShare: 0,
  ieaStocksAvailable: false,
  ieaStocksDataMonth: '',
  ieaDaysOfCover: 0,
  ieaNetExporter: false,
  ieaBelowObligation: false,
};

function n(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function s(v: string | null | undefined): string {
  return typeof v === 'string' ? v : '';
}

export async function getCountryEnergyProfile(
  _ctx: ServerContext,
  req: GetCountryEnergyProfileRequest,
): Promise<GetCountryEnergyProfileResponse> {
  const code = req.countryCode?.trim().toUpperCase() ?? '';
  if (!code || code.length !== 2) return EMPTY;

  const [mixResult, gasStorageResult, electricityResult, jodiOilResult, jodiGasResult, ieaStocksResult] =
    await Promise.allSettled([
      getCachedJson(`energy:mix:v1:${code}`, true),
      getCachedJson(`energy:gas-storage:v1:${code}`, true),
      getCachedJson(`energy:electricity:v1:${code}`, true),
      getCachedJson(`energy:jodi-oil:v1:${code}`, true),
      getCachedJson(`energy:jodi-gas:v1:${code}`, true),
      getCachedJson(`energy:iea-oil-stocks:v1:${code}`, true),
    ]);

  const mix = mixResult.status === 'fulfilled' ? (mixResult.value as OwidMix | null) : null;
  const gasStorage = gasStorageResult.status === 'fulfilled' ? (gasStorageResult.value as GasStorage | null) : null;
  const electricity = electricityResult.status === 'fulfilled' ? (electricityResult.value as ElectricityEntry | null) : null;
  const jodiOil = jodiOilResult.status === 'fulfilled' ? (jodiOilResult.value as JodiOil | null) : null;
  const jodiGas = jodiGasResult.status === 'fulfilled' ? (jodiGasResult.value as JodiGas | null) : null;
  const ieaStocks = ieaStocksResult.status === 'fulfilled' ? (ieaStocksResult.value as IeaStocks | null) : null;

  return {
    mixAvailable: mix != null,
    mixYear: n(mix?.year),
    coalShare: n(mix?.coalShare),
    gasShare: n(mix?.gasShare),
    oilShare: n(mix?.oilShare),
    nuclearShare: n(mix?.nuclearShare),
    renewShare: n(mix?.renewShare),
    windShare: n(mix?.windShare),
    solarShare: n(mix?.solarShare),
    hydroShare: n(mix?.hydroShare),
    importShare: n(mix?.importShare),

    gasStorageAvailable: gasStorage != null,
    gasStorageFillPct: n(gasStorage?.fillPct),
    gasStorageChange1d: n(gasStorage?.fillPctChange1d),
    gasStorageTrend: s(gasStorage?.trend),
    gasStorageDate: s(gasStorage?.date),

    electricityAvailable: electricity != null && electricity.priceMwhEur != null,
    electricityPriceMwh: n(electricity?.priceMwhEur),
    electricitySource: electricity?.priceMwhEur != null ? s(electricity?.source) : '',
    electricityDate: electricity?.priceMwhEur != null ? s(electricity?.date) : '',

    jodiOilAvailable: jodiOil != null,
    jodiOilDataMonth: s(jodiOil?.dataMonth),
    gasolineDemandKbd: n(jodiOil?.gasoline?.demandKbd),
    gasolineImportsKbd: n(jodiOil?.gasoline?.importsKbd),
    dieselDemandKbd: n(jodiOil?.diesel?.demandKbd),
    dieselImportsKbd: n(jodiOil?.diesel?.importsKbd),
    jetDemandKbd: n(jodiOil?.jet?.demandKbd),
    jetImportsKbd: n(jodiOil?.jet?.importsKbd),
    lpgDemandKbd: n(jodiOil?.lpg?.demandKbd),
    lpgImportsKbd: n(jodiOil?.lpg?.importsKbd),
    crudeImportsKbd: n(jodiOil?.crude?.importsKbd),

    jodiGasAvailable: jodiGas != null,
    jodiGasDataMonth: s(jodiGas?.dataMonth),
    gasTotalDemandTj: n(jodiGas?.totalDemandTj),
    gasLngImportsTj: n(jodiGas?.lngImportsTj),
    gasPipeImportsTj: n(jodiGas?.pipeImportsTj),
    gasLngShare: n(jodiGas?.lngShareOfImports != null ? jodiGas.lngShareOfImports * 100 : null),

    ieaStocksAvailable: ieaStocks != null && (ieaStocks.netExporter === true || (ieaStocks.daysOfCover != null && ieaStocks.anomaly !== true)),
    ieaStocksDataMonth: s(ieaStocks?.dataMonth),
    ieaDaysOfCover: n(ieaStocks?.daysOfCover),
    ieaNetExporter: ieaStocks?.netExporter === true,
    ieaBelowObligation: ieaStocks?.belowObligation === true,
  };
}
