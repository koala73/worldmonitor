import type { GetCountryCostShockResponse, GetMultiSectorCostShockResponse } from '../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import type { ComputeEnergyShockScenarioResponse } from '../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { CHOKEPOINT_REGISTRY } from '../../../server/_shared/chokepoint-registry';
import { COUNTRY_ARG_HINT, requireCountryCode } from '../_country-args';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk, RpcValidationError } from '../billing-denial';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';

const MODES = {
  energy: '/api/supply-chain/v1/get-country-cost-shock',
  'multi-sector': '/api/supply-chain/v1/get-multi-sector-cost-shock',
} as const;

export const COST_SHOCK_TOOLS: ToolDef[] = [{
  name: 'get_supply_chain_cost_shock',
  description: 'Model existing country energy exposure or multi-sector import costs for a chokepoint closure. Select energy or multi-sector mode, country and canonical chokepoint. Energy defaults to HS 27 mineral fuels; closure_days applies only to multi-sector and defaults to 30. Energy models cover only supported chokepoints. Preserve hasEnergyModel and unavailableReason; missing models or imports are not measured zero impacts. Sector costs are estimates in USD using seeded imports, freight/insurance assumptions and closure duration, not realized losses or forecasts. Uses existing subscription access and seeded computations; no scenario is saved.',
  _outputBudgetBytes: 65536,
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: Object.keys(MODES), description: 'Energy exposure or multi-sector import-cost scenario.' },
      country: { type: 'string', description: COUNTRY_ARG_HINT },
      chokepoint_id: { type: 'string', enum: CHOKEPOINT_REGISTRY.map(point => point.id), description: 'Canonical chokepoint ID from the shared registry.' },
      hs2: { type: 'string', pattern: '^\\d{1,2}$', default: '27', description: 'Energy mode only: HS2 product code. HS 27 has energy coverage; other codes retain the source unavailable explanation.' },
      closure_days: { type: 'integer', minimum: 1, maximum: 365, default: 30, description: 'Multi-sector mode only: closure duration in days.' },
    },
    required: ['mode', 'country', 'chokepoint_id'],
  },
  outputSchema: {
    type: 'object', required: ['mode', 'data'],
    properties: {
      mode: { type: 'string', enum: Object.keys(MODES) },
      data: { type: 'object', properties: {
        iso2: { type: 'string' }, chokepointId: { type: 'string' }, hs2: { type: 'string' },
        supplyDeficitPct: { type: 'number' }, coverageDays: { type: 'number' }, warRiskPremiumBps: { type: 'number' },
        warRiskTier: { type: 'string' }, hasEnergyModel: { type: 'boolean' }, unavailableReason: { type: 'string' },
        fetchedAt: { type: 'string' }, closureDays: { type: 'number' }, totalAddedCost: { type: 'number' },
        sectors: { type: 'array', items: { type: 'object', properties: {
          hs2: { type: 'string' }, hs2Label: { type: 'string' }, importValueAnnual: { type: 'number' },
          freightAddedPctPerTon: { type: 'number' }, warRiskPremiumBps: { type: 'number' }, addedTransitDays: { type: 'number' },
          totalCostShockPerDay: { type: 'number' }, totalCostShock30Days: { type: 'number' }, totalCostShock90Days: { type: 'number' },
          totalCostShock: { type: 'number' }, closureDays: { type: 'number' },
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
    const country = requireCountryCode(params.country, 'get_supply_chain_cost_shock', 'country');
    const chokepoint = params.chokepoint_id;
    if (typeof chokepoint !== 'string' || !CHOKEPOINT_REGISTRY.some(point => point.id === chokepoint)) invalid('chokepoint_id', 'Select a canonical chokepoint ID.');
    if (selected === 'energy' && params.closure_days !== undefined) invalid('closure_days', 'Closure duration is only supported in multi-sector mode.');
    if (selected === 'multi-sector' && params.hs2 !== undefined) invalid('hs2', 'HS2 is only supported in energy mode.');
    const hs2 = params.hs2 ?? '27';
    if (typeof hs2 !== 'string' || !/^\d{1,2}$/.test(hs2)) invalid('hs2', 'Expected a one- or two-digit HS2 code.');
    const days = params.closure_days ?? 30;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) invalid('closure_days', 'Expected an integer from 1 through 365.');
    const query = new URLSearchParams({ iso2: country, chokepoint_id: chokepoint as string });
    if (selected === 'energy') query.set('hs2', hs2 as string);
    else query.set('closure_days', String(days));
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
  description: 'Compute the existing oil/gas supply-sensitivity scenario for a country and supported chokepoint. Set disruption_pct (10..100, default 100) and fuel_mode (oil/gas/both, default oil). Preserve dataAvailable, coverage flags, coverageLevel, limitations, degraded, chokepointConfidence and gasSensitivity.modelBasis. An unavailable source is not a zero deficit; assumed LNG routing sensitivity is not a measured live-flow shock. Product output/demand are thousand barrels/day, gas quantities are terajoules, storage is TWh and cover is days. Derived scenarios may be cached; no trade or saved user scenario is created.',
  _outputBudgetBytes: 65536,
  inputSchema: {
    type: 'object',
    properties: {
      country: { type: 'string', description: COUNTRY_ARG_HINT },
      chokepoint_id: { type: 'string', enum: CHOKEPOINT_REGISTRY.filter(point => point.shockModelSupported).map(point => point.id) },
      disruption_pct: { type: 'integer', minimum: 10, maximum: 100, default: 100 },
      fuel_mode: { type: 'string', enum: ['oil', 'gas', 'both'], default: 'oil' },
    },
    required: ['country', 'chokepoint_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      countryCode: { type: 'string' }, chokepointId: { type: 'string' }, disruptionPct: { type: 'number' },
      gulfCrudeShare: { type: 'number' }, crudeLossKbd: { type: 'number' }, effectiveCoverDays: { type: 'number' },
      assessment: { type: 'string' }, dataAvailable: { type: 'boolean' },
      jodiOilCoverage: { type: 'boolean' }, comtradeCoverage: { type: 'boolean' }, ieaStocksCoverage: { type: 'boolean' },
      portwatchCoverage: { type: 'boolean' }, coverageLevel: { type: 'string' }, degraded: { type: 'boolean' },
      chokepointConfidence: { type: 'string' }, liveFlowRatio: { type: 'number' },
      limitations: { type: 'array', items: { type: 'string' } },
      products: { type: 'array', items: { type: 'object', properties: {
        product: { type: 'string' }, outputLossKbd: { type: 'number' }, demandKbd: { type: 'number' }, deficitPct: { type: 'number' },
      } } },
      gasSensitivity: { type: 'object', properties: {
        lngShareOfImports: { type: 'number' }, lngImportsTj: { type: 'number' }, lngDisruptionTj: { type: 'number' },
        totalDemandTj: { type: 'number' }, deficitPct: { type: 'number' }, dataAvailable: { type: 'boolean' },
        assessment: { type: 'string' }, dataSource: { type: 'string' }, dataMonth: { type: 'string' }, modelBasis: { type: 'string' },
        storage: { type: 'object', properties: {
          fillPct: { type: 'number' }, gasTwh: { type: 'number' }, trend: { type: 'string' }, date: { type: 'string' }, scope: { type: 'string' },
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
