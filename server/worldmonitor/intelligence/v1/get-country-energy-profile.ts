import type {
  ServerContext,
  GetCountryEnergyProfileRequest,
  GetCountryEnergyProfileResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { ENERGY_SPINE_KEY_PREFIX, EMBER_ELECTRICITY_KEY_PREFIX } from '../../../_shared/cache-keys';

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

interface EnergySpine {
  countryCode?: string;
  updatedAt?: string;
  sources?: {
    mixYear?: number | null;
    jodiOilMonth?: string | null;
    jodiGasMonth?: string | null;
    ieaStocksMonth?: string | null;
  };
  coverage?: {
    hasMix?: boolean;
    hasJodiOil?: boolean;
    hasJodiGas?: boolean;
    hasIeaStocks?: boolean;
  };
  oil?: {
    crudeImportsKbd?: number;
    gasolineDemandKbd?: number;
    gasolineImportsKbd?: number;
    dieselDemandKbd?: number;
    dieselImportsKbd?: number;
    jetDemandKbd?: number;
    jetImportsKbd?: number;
    lpgDemandKbd?: number;
    lpgImportsKbd?: number;
    daysOfCover?: number;
    netExporter?: boolean;
    belowObligation?: boolean;
  };
  gas?: {
    lngImportsTj?: number;
    pipeImportsTj?: number;
    totalDemandTj?: number;
    lngShareOfImports?: number;
  };
  mix?: {
    coalShare?: number;
    gasShare?: number;
    oilShare?: number;
    nuclearShare?: number;
    renewShare?: number;
    windShare?: number;
    solarShare?: number;
    hydroShare?: number;
    importShare?: number;
  };
  electricity?: {
    fossilShare?: number | null;
    renewShare?: number | null;
    nuclearShare?: number | null;
    coalShare?: number | null;
    gasShare?: number | null;
    demandTwh?: number | null;
  } | null;
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
  emberFossilShare: 0,
  emberRenewShare: 0,
  emberNuclearShare: 0,
  emberCoalShare: 0,
  emberGasShare: 0,
  emberDemandTwh: 0,
  emberDataMonth: '',
  emberAvailable: false,
};

function n(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function s(v: string | null | undefined): string {
  return typeof v === 'string' ? v : '';
}

interface EmberData {
  fossilShare?: number | null;
  renewShare?: number | null;
  nuclearShare?: number | null;
  coalShare?: number | null;
  gasShare?: number | null;
  demandTwh?: number | null;
  dataMonth?: string | null;
  [key: string]: unknown;
}

function buildResponseFromSpine(
  spine: EnergySpine,
  gasStorage: GasStorage | null,
  electricity: ElectricityEntry | null,
  emberData: EmberData | null,
): GetCountryEnergyProfileResponse {
  const cov = spine.coverage ?? {};
  const src = spine.sources ?? {};
  const oil = spine.oil ?? {};
  const gas = spine.gas ?? {};
  const mix = spine.mix ?? {};

  const electricityAvailable = electricity != null && electricity.priceMwhEur != null;

  const resolvedEmber: EmberData | null = (spine.electricity != null && typeof spine.electricity.fossilShare === 'number')
    ? spine.electricity
    : emberData;

  return {
    mixAvailable: cov.hasMix === true,
    mixYear: n(src.mixYear),
    coalShare: n(mix.coalShare),
    gasShare: n(mix.gasShare),
    oilShare: n(mix.oilShare),
    nuclearShare: n(mix.nuclearShare),
    renewShare: n(mix.renewShare),
    windShare: n(mix.windShare),
    solarShare: n(mix.solarShare),
    hydroShare: n(mix.hydroShare),
    importShare: n(mix.importShare),

    gasStorageAvailable: gasStorage != null,
    gasStorageFillPct: n(gasStorage?.fillPct),
    gasStorageChange1d: n(gasStorage?.fillPctChange1d),
    gasStorageTrend: s(gasStorage?.trend),
    gasStorageDate: s(gasStorage?.date),

    electricityAvailable,
    electricityPriceMwh: n(electricity?.priceMwhEur),
    electricitySource: electricityAvailable ? s(electricity?.source) : '',
    electricityDate: electricityAvailable ? s(electricity?.date) : '',

    jodiOilAvailable: cov.hasJodiOil === true,
    jodiOilDataMonth: s(src.jodiOilMonth),
    gasolineDemandKbd: n(oil.gasolineDemandKbd),
    gasolineImportsKbd: n(oil.gasolineImportsKbd),
    dieselDemandKbd: n(oil.dieselDemandKbd),
    dieselImportsKbd: n(oil.dieselImportsKbd),
    jetDemandKbd: n(oil.jetDemandKbd),
    jetImportsKbd: n(oil.jetImportsKbd),
    lpgDemandKbd: n(oil.lpgDemandKbd),
    lpgImportsKbd: n(oil.lpgImportsKbd),
    crudeImportsKbd: n(oil.crudeImportsKbd),

    jodiGasAvailable: cov.hasJodiGas === true,
    jodiGasDataMonth: s(src.jodiGasMonth),
    gasTotalDemandTj: n(gas.totalDemandTj),
    gasLngImportsTj: n(gas.lngImportsTj),
    gasPipeImportsTj: n(gas.pipeImportsTj),
    gasLngShare: n(gas.lngShareOfImports != null ? gas.lngShareOfImports * 100 : null),

    ieaStocksAvailable: cov.hasIeaStocks === true,
    ieaStocksDataMonth: s(src.ieaStocksMonth),
    ieaDaysOfCover: n(oil.daysOfCover),
    ieaNetExporter: oil.netExporter === true,
    ieaBelowObligation: oil.belowObligation === true,

    emberFossilShare: n(resolvedEmber?.fossilShare),
    emberRenewShare: n(resolvedEmber?.renewShare),
    emberNuclearShare: n(resolvedEmber?.nuclearShare),
    emberCoalShare: n(resolvedEmber?.coalShare),
    emberGasShare: n(resolvedEmber?.gasShare),
    emberDemandTwh: n(resolvedEmber?.demandTwh),
    emberDataMonth: s(resolvedEmber?.dataMonth),
    emberAvailable: resolvedEmber != null && typeof resolvedEmber.fossilShare === 'number',
  };
}

export async function getCountryEnergyProfile(
  _ctx: ServerContext,
  req: GetCountryEnergyProfileRequest,
): Promise<GetCountryEnergyProfileResponse> {
  const code = req.countryCode?.trim().toUpperCase() ?? '';
  if (!code || code.length !== 2) return EMPTY;

  // Always read gas-storage and electricity directly — both update sub-daily
  // (gas storage ~10:30 UTC, electricity ~14:00 UTC) while the spine seeds once
  // at 06:00 UTC. Serving them from the spine would return stale data for up to 8h.
  const [spineResult, gasStorageResult, electricityResult] = await Promise.allSettled([
    getCachedJson(`${ENERGY_SPINE_KEY_PREFIX}${code}`, true),
    getCachedJson(`energy:gas-storage:v1:${code}`, true),
    getCachedJson(`energy:electricity:v1:${code}`, true),
  ]);

  const spine = spineResult.status === 'fulfilled' ? (spineResult.value as EnergySpine | null) : null;
  const gasStorage = gasStorageResult.status === 'fulfilled' ? (gasStorageResult.value as GasStorage | null) : null;
  const electricity = electricityResult.status === 'fulfilled' ? (electricityResult.value as ElectricityEntry | null) : null;

  if (spine != null && typeof spine === 'object' && spine.coverage != null) {
    let emberFallback: EmberData | null = null;
    if (!spine.electricity || typeof spine.electricity.fossilShare !== 'number') {
      const directEmber = await getCachedJson(`${EMBER_ELECTRICITY_KEY_PREFIX}${code}`, true).catch(() => null);
      if (directEmber && typeof directEmber === 'object') {
        emberFallback = directEmber as EmberData;
      }
    }
    return buildResponseFromSpine(spine, gasStorage, electricity, emberFallback);
  }

  // Fallback: 4-key direct join (cold cache or countries not yet in spine)
  const [mixResult, jodiOilResult, jodiGasResult, ieaStocksResult, emberResult] =
    await Promise.allSettled([
      getCachedJson(`energy:mix:v1:${code}`, true),
      getCachedJson(`energy:jodi-oil:v1:${code}`, true),
      getCachedJson(`energy:jodi-gas:v1:${code}`, true),
      getCachedJson(`energy:iea-oil-stocks:v1:${code}`, true),
      getCachedJson(`${EMBER_ELECTRICITY_KEY_PREFIX}${code}`, true),
    ]);

  const mix = mixResult.status === 'fulfilled' ? (mixResult.value as OwidMix | null) : null;
  const jodiOil = jodiOilResult.status === 'fulfilled' ? (jodiOilResult.value as JodiOil | null) : null;
  const jodiGas = jodiGasResult.status === 'fulfilled' ? (jodiGasResult.value as JodiGas | null) : null;
  const ieaStocks = ieaStocksResult.status === 'fulfilled' ? (ieaStocksResult.value as IeaStocks | null) : null;
  const emberData = emberResult.status === 'fulfilled' ? (emberResult.value as EmberData | null) : null;

  const electricityAvailable = electricity != null && electricity.priceMwhEur != null;

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

    electricityAvailable,
    electricityPriceMwh: n(electricity?.priceMwhEur),
    electricitySource: electricityAvailable ? s(electricity?.source) : '',
    electricityDate: electricityAvailable ? s(electricity?.date) : '',

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

    emberFossilShare: n(emberData?.fossilShare),
    emberRenewShare: n(emberData?.renewShare),
    emberNuclearShare: n(emberData?.nuclearShare),
    emberCoalShare: n(emberData?.coalShare),
    emberGasShare: n(emberData?.gasShare),
    emberDemandTwh: n(emberData?.demandTwh),
    emberDataMonth: s(emberData?.dataMonth),
    emberAvailable: emberData != null && typeof emberData.fossilShare === 'number',
  };
}
