import type { GetCountryCostShockResponse, GetMultiSectorCostShockResponse } from '../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import type { ComputeEnergyShockScenarioResponse } from '../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { CHOKEPOINT_REGISTRY } from '../../../server/_shared/chokepoint-registry';
import { COUNTRY_ARG_HINT, requireCountryCode } from '../_country-args';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk, RpcValidationError } from '../billing-denial';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';

// One Gulf crude share window (compute_energy_shock preCrisisBaseline / currentFlows).
const d = (type: string, description: string) => ({ type, description });
const CRUDE_SHARE_BASELINE_SCHEMA = { type: 'object', properties: {
  basis: { type: 'string', enum: ['comtrade_monthly', 'national_monthly', 'comtrade_annual'], description: 'Share source: UN Comtrade monthly import value, the importer\'s own monthly statistics in tonnes, or the Comtrade annual fallback.' },
  fromMonth: d('string', 'First month of the window, YYYY-MM.'), toMonth: d('string', 'Last month of the window, YYYY-MM.'),
  monthsCovered: d('number', 'Monthly filings in the window.'),
  gulfCrudeShare: d('number', 'Gulf share of crude imports times the chokepoint route factor, as a fraction.'),
  crudeLossKbd: d('number', 'Crude loss at disruption_pct with no bypass recovery, thousand barrels per day; 0 when not modelled.'),
  crudeLossAfterBypassKbd: d('number', 'Hormuz only: crude loss after bypass rerouting, thousand barrels per day; absent otherwise.'),
} } as const;
const GBP = 'War-risk insurance premium for the chokepoint, basis points.';
const TIER = 'War-risk tier of the chokepoint, from WAR_RISK_TIER_NORMAL to WAR_RISK_TIER_WAR_ZONE.';

const MODES = {
  energy: '/api/supply-chain/v1/get-country-cost-shock',
  'multi-sector': '/api/supply-chain/v1/get-multi-sector-cost-shock',
} as const;

function costShockCountry(params: Record<string, unknown>): string {
  const country = requireCountryCode(params.country, 'get_supply_chain_cost_shock', 'country');
  if (params.mode === 'energy' && params.closure_days !== undefined) {
    throw new RpcValidationError('get_supply_chain_cost_shock', [{ field: 'closure_days', description: 'Closure duration is only supported in multi-sector mode.' }]);
  }
  if (params.mode === 'multi-sector' && params.hs2 !== undefined) {
    throw new RpcValidationError('get_supply_chain_cost_shock', [{ field: 'hs2', description: 'HS2 is only supported in energy mode.' }]);
  }
  return country;
}

export const COST_SHOCK_TOOLS: ToolDef[] = [{
  name: 'get_supply_chain_cost_shock',
  _validateArgs: params => { costShockCountry(params); },
  title: 'Chokepoint closure cost shock',
  description: 'Model country energy exposure or multi-sector import costs for a chokepoint closure. Returns {mode, data}: energy data contains refined-product supply deficit and IEA stock cover; multi-sector data contains sector cost estimates and totalAddedCost over closure_days. Energy models cover only supported chokepoints and HS 27 mineral fuels. Read unavailableReason for missing energy metrics or models and country-wide missing imports; partial sector imports have no missing-data reason. hasEnergyModel is true only when both energy metrics are modelled. Unavailable values are not measured zero impacts. Sector costs are estimates in USD using seeded imports, freight/insurance assumptions and closure duration, not realized losses or forecasts. Uses existing subscription access and seeded computations; no scenario is saved.',
  _outputBudgetBytes: 65536,
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: Object.keys(MODES), description: 'Which model: energy returns the refined-product supply deficit and stock cover for one HS2 chapter; multi-sector returns added import costs across seeded HS2 sectors over closure_days.' },
      country: { type: 'string', description: `Importing country. ${COUNTRY_ARG_HINT}` },
      chokepoint_id: { type: 'string', enum: CHOKEPOINT_REGISTRY.map(point => point.id), description: 'Maritime chokepoint assumed closed when modelling the importing country\'s exposure or bypass freight and insurance costs.' },
      hs2: { type: 'string', pattern: '^\\d{1,2}$', default: '27', description: 'Energy mode only: Harmonized System goods chapter to assess. The energy model covers mineral fuels (27); other chapters return hasEnergyModel false with unavailableReason.' },
      closure_days: { type: 'integer', minimum: 1, maximum: 365, default: 30, description: 'Multi-sector mode only: days the chokepoint stays closed; scales totalCostShock and totalAddedCost.' },
    },
    required: ['mode', 'country', 'chokepoint_id'],
  },
  outputSchema: {
    type: 'object', required: ['mode', 'data'],
    properties: {
      mode: { type: 'string', enum: Object.keys(MODES), description: 'Model that ran.' },
      data: { type: 'object', description: 'Source model result. Both modes return iso2, chokepointId, warRiskTier, unavailableReason and fetchedAt. Energy adds hs2, supplyDeficitPct, coverageDays, warRiskPremiumBps and hasEnergyModel. Multi-sector adds closureDays, totalAddedCost and sectors.', properties: {
        iso2: d('string', 'ISO alpha-2 importing country.'), chokepointId: d('string', 'Chokepoint modelled.'), hs2: d('string', 'Energy mode: HS2 chapter modelled.'),
        supplyDeficitPct: d('number', 'Energy mode: average deficit across refined products with demand observations under full closure, percent. Unmodelled values stay 0; read unavailableReason for metric-specific gaps even when hasEnergyModel is false.'),
        coverageDays: d('number', 'Energy mode: IEA stock cover under the modelled loss, days. Stays 0 without an IEA stock observation or usable model, for non-energy chapters, or when import cover is inapplicable to a net exporter; read unavailableReason.'),
        warRiskPremiumBps: d('number', `Energy mode: ${GBP}`), warRiskTier: d('string', TIER),
        hasEnergyModel: d('boolean', 'Energy mode: whether both supplyDeficitPct and coverageDays are modelled. False can accompany one modelled metric; read unavailableReason rather than interpreting unavailable values as zero impact.'),
        unavailableReason: d('string', 'Explanation of missing models, individual energy metrics or country-wide missing imports, including inapplicable net-exporter cover. Empty when no gap is reported, including when only some sectors lack imports.'),
        fetchedAt: d('string', 'Response construction time, as an ISO timestamp; not the observation date of the seeded inputs.'),
        closureDays: d('number', 'Multi-sector mode: closure duration used.'), totalAddedCost: d('number', 'Multi-sector mode: sum of totalCostShock across sectors, USD.'),
        sectors: { type: 'array', description: 'Multi-sector mode: seeded HS2 sector estimates, largest daily cost first when imports are available. No seeded imports for the country yields zero-valued sector placeholders with data.unavailableReason. With partial imports, sectors without imports have zero import values and costs but retain route assumptions, and data.unavailableReason is empty; these zeros do not establish zero impact. Access denial can yield an empty array.', items: { type: 'object', properties: {
          hs2: d('string', 'HS2 chapter code.'), hs2Label: d('string', 'Sector name.'), importValueAnnual: d('number', 'Annual import value, USD.'),
          freightAddedPctPerTon: d('number', 'Freight uplift on the bypass route as a fraction per ton (0.10 is +10%).'), warRiskPremiumBps: d('number', GBP),
          addedTransitDays: d('number', 'Extra transit days on the bypass route.'),
          totalCostShockPerDay: d('number', 'Added cost per closure day, USD.'), totalCostShock30Days: d('number', 'Added cost over 30 days, USD.'), totalCostShock90Days: d('number', 'Added cost over 90 days, USD.'),
          totalCostShock: d('number', 'Added cost over closureDays, USD.'), closureDays: d('number', 'Closure duration used.'),
        } } },
      } },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _execute: async (params, base, context, execution) => {
    const invalid = (field: string, description: string): never => { throw new RpcValidationError('get_supply_chain_cost_shock', [{ field, description }]); };
    const mode = params.mode;
    if (typeof mode !== 'string' || !Object.prototype.hasOwnProperty.call(MODES, mode)) invalid('mode', 'Select energy or multi-sector mode.');
    const selected = mode as keyof typeof MODES;
    const country = costShockCountry(params);
    const chokepoint = params.chokepoint_id;
    if (typeof chokepoint !== 'string' || !CHOKEPOINT_REGISTRY.some(point => point.id === chokepoint)) invalid('chokepoint_id', 'Select a canonical chokepoint ID.');
    const hs2 = params.hs2 ?? '27';
    if (typeof hs2 !== 'string' || !/^\d{1,2}$/.test(hs2)) invalid('hs2', 'Expected a one- or two-digit HS2 code.');
    const days = params.closure_days ?? 30;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) invalid('closure_days', 'Expected an integer from 1 through 365.');
    const query = new URLSearchParams({ iso2: country, chokepointId: chokepoint as string });
    if (selected === 'energy') query.set('hs2', hs2 as string);
    else query.set('closureDays', String(days));
    const url = `${base}${MODES[selected]}?${query}`;
    const auth = await buildAuthHeaders(context, 'GET', url, null);
    const response = await fetchMcpDownstream(url, {
      headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' }, signal: AbortSignal.timeout(25_000),
    }, execution);
    await assertToolFetchOk(response, 'get_supply_chain_cost_shock', { preserveBackoff: true });
    const data = await response.json() as GetCountryCostShockResponse | GetMultiSectorCostShockResponse;
    return { mode: selected, data };
  },
  _apiPaths: Object.values(MODES).map(path => `GET ${path}`),
}, {
  name: 'compute_energy_shock',
  _validateArgs: params => { requireCountryCode(params.country, 'compute_energy_shock', 'country'); },
  title: 'Energy supply shock scenario',
  description: 'Compute the oil/gas supply-sensitivity scenario for a country and supported chokepoint. Set disruption_pct (10..100, default 100) and fuel_mode (oil/gas/both, default oil). Results carry dataAvailable, coverage flags, coverageLevel, limitations, degraded, chokepointConfidence and gasSensitivity.modelBasis. Oil headline figures use preCrisisBaseline, the Gulf share over the 12 months before the 2026 Hormuz crisis (basis comtrade_annual is the annual fallback); currentFlows covers the latest 3 monthly filings and is absent when unavailable. Shares include the chokepoint route factor. For Hormuz, crudeLossKbd is after bypass rerouting (Saudi East-West, UAE ADCOP, Iraqi Kirkuk-Ceyhan); preCrisisBaseline.crudeLossKbd is before it. An unavailable source is not a zero deficit; assumed LNG routing is not a measured live-flow shock. Units: products kb/d, gas TJ, storage TWh, cover days. Non-IEA cover uses reportedStocks (JODI month-end stocks, not IEA data). Results may be cached; no user scenario is saved.',
  _outputBudgetBytes: 65536,
  inputSchema: {
    type: 'object',
    properties: {
      country: { type: 'string', description: `Importing energy market to model. ${COUNTRY_ARG_HINT}` },
      chokepoint_id: { type: 'string', enum: CHOKEPOINT_REGISTRY.filter(point => point.shockModelSupported).map(point => point.id), description: 'Chokepoint whose disruption is modelled.' },
      disruption_pct: { type: 'integer', minimum: 10, maximum: 100, default: 100, description: 'Share of the chokepoint\'s flow lost, percent; 100 models a full closure.' },
      fuel_mode: { type: 'string', enum: ['oil', 'gas', 'both'], default: 'oil', description: 'Fuel to model: oil fills the crude and product figures, gas fills gasSensitivity, both fills all of them.' },
    },
    required: ['country', 'chokepoint_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      countryCode: d('string', 'ISO alpha-2 country modelled.'), chokepointId: d('string', 'Chokepoint modelled.'), disruptionPct: d('number', 'Disruption applied, percent.'),
      gulfCrudeShare: d('number', 'Headline Gulf crude share from preCrisisBaseline, as a fraction including the route factor; 0 when absent or in gas mode.'),
      crudeLossKbd: d('number', 'Headline crude loss, thousand barrels per day: after bypass when available, else before; 0 when not modelled or in gas mode.'),
      effectiveCoverDays: d('number', 'Days oil stocks last under the crude loss; 0 when not modelled; -1 marks a net oil exporter, where no import cover applies.'),
      assessment: d('string', 'Plain-language summary of the oil scenario.'),
      dataAvailable: d('boolean', 'Whether usable inputs exist for the requested fuel_mode (either fuel for both); false is not a zero deficit.'),
      jodiOilCoverage: d('boolean', 'JODI oil data present for the country.'), comtradeCoverage: d('boolean', 'Crude origin shares present (Comtrade or national statistics).'),
      ieaStocksCoverage: d('boolean', 'IEA strategic stock data present.'), portwatchCoverage: d('boolean', 'PortWatch live chokepoint flow data present.'),
      coverageLevel: d('string', 'Overall input coverage: full, partial or unsupported.'), degraded: d('boolean', 'True when PortWatch flow data is absent or stale.'),
      chokepointConfidence: d('string', 'Confidence in the chokepoint flow reading: high, low or none.'),
      liveFlowRatio: d('number', 'Current chokepoint flow relative to normal, 0-1.5; absent without PortWatch coverage.'),
      preCrisisBaseline: { ...CRUDE_SHARE_BASELINE_SCHEMA, description: 'Gulf crude share over the 12 months before the 2026 Hormuz crisis; drives the headline, products and cover.' },
      currentFlows: { ...CRUDE_SHARE_BASELINE_SCHEMA, description: 'Gulf crude share over the latest 3 monthly filings; absent when unavailable and not used for products or cover.' },
      reportedStocks: { type: 'object', description: 'Month-end oil stocks reported to JODI by a country without IEA data; absent otherwise.', properties: {
        source: { type: 'string', enum: ['jodi'], description: 'Data source.' }, month: d('string', 'Month the stocks closed, YYYY-MM.'),
        crudeMb: d('number', 'Crude stocks, million barrels.'), productsMb: d('number', 'Product stocks, million barrels.'), totalMb: d('number', 'Total stocks, million barrels.'),
        stockDays: d('number', 'totalMb in days of crude imports; absent unless it sets effectiveCoverDays.'),
      } },
      limitations: { type: 'array', items: { type: 'string' }, description: 'Model assumptions and data gaps that qualify the figures.' },
      products: { type: 'array', description: 'Refined-product impact.', items: { type: 'object', properties: {
        product: d('string', 'Product name, such as Diesel.'), outputLossKbd: d('number', 'Lost refinery output, thousand barrels per day.'),
        demandKbd: d('number', 'Product demand, thousand barrels per day.'), deficitPct: d('number', 'outputLossKbd as a percent of demandKbd.'),
      } } },
      gasSensitivity: { type: 'object', description: 'Gas mode: LNG route sensitivity.', properties: {
        lngShareOfImports: d('number', 'Share of gas imports arriving as LNG, as a fraction; absent when unmeasured.'), lngImportsTj: d('number', 'LNG imports, terajoules per month.'),
        lngDisruptionTj: d('number', 'Monthly LNG loss at the route share, terajoules; independent of current shipping flow.'),
        totalDemandTj: d('number', 'Gas demand, terajoules per month.'), deficitPct: d('number', 'lngDisruptionTj as a percent of demand; can exceed 100 and is not a shortage estimate.'),
        dataAvailable: d('boolean', 'Whether gas inputs exist.'), assessment: d('string', 'Plain-language summary of the gas scenario.'),
        dataSource: d('string', 'Source of the gas figures.'), dataMonth: d('string', 'JODI observation month, YYYY-MM; empty when unknown.'),
        modelBasis: d('string', 'How the LNG loss was derived: comtrade_lng_origin_share (Hormuz), observed_zero_lng_imports or assumed_route_sensitivity (fixed route share, not a measured flow).'),
        storage: { type: 'object', description: 'National gas storage observation; no endurance is estimated.', properties: {
          fillPct: d('number', 'Storage fill, percent of capacity.'), gasTwh: d('number', 'Gas in storage, terawatt-hours.'), trend: d('string', 'Recent fill direction.'), date: d('string', 'Observation date.'), scope: d('string', 'Geography the observation covers.'),
        } },
      } },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _execute: async (params, base, context, execution) => {
    const invalid = (field: string, description: string): never => { throw new RpcValidationError('compute_energy_shock', [{ field, description }]); };
    const country = requireCountryCode(params.country, 'compute_energy_shock', 'country');
    const chokepoint = params.chokepoint_id;
    if (typeof chokepoint !== 'string' || !CHOKEPOINT_REGISTRY.some(point => point.id === chokepoint && point.shockModelSupported)) invalid('chokepoint_id', 'Select a supported energy-model chokepoint.');
    const disruption = params.disruption_pct ?? 100;
    if (typeof disruption !== 'number' || !Number.isInteger(disruption) || disruption < 10 || disruption > 100) invalid('disruption_pct', 'Expected an integer from 10 through 100.');
    const fuel = params.fuel_mode ?? 'oil';
    if (typeof fuel !== 'string' || !['oil', 'gas', 'both'].includes(fuel)) invalid('fuel_mode', 'Select oil, gas or both.');
    const query = new URLSearchParams({ country_code: country, chokepoint_id: chokepoint as string, disruption_pct: String(disruption), fuel_mode: fuel as string });
    const url = `${base}/api/intelligence/v1/compute-energy-shock?${query}`;
    const auth = await buildAuthHeaders(context, 'GET', url, null);
    const response = await fetchMcpDownstream(url, {
      headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' }, signal: AbortSignal.timeout(25_000),
    }, execution);
    await assertToolFetchOk(response, 'compute_energy_shock', { preserveBackoff: true });
    return await response.json() as ComputeEnergyShockScenarioResponse;
  },
  _apiPaths: ['GET /api/intelligence/v1/compute-energy-shock'],
}];
