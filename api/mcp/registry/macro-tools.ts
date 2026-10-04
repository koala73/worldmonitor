import type {
  GetGovernmentYieldCurveResponse,
  GetUsCpiMonthlyResponse,
  GetUsInterestRatesResponse,
  GetUsTreasuryParYieldCurveResponse,
  GetWorldCpiMonthlyResponse,
} from '../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { COUNTRY_ARG_HINT, requireCountryCode } from '../_country-args';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk, RpcValidationError } from '../billing-denial';
import { DEFAULT_LIST_LIMIT } from '../constants';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';

const DATASETS = {
  'us-cpi': { path: '/api/economic/v1/get-us-cpi-monthly', country: false },
  'us-interest-rates': { path: '/api/economic/v1/get-us-interest-rates', country: false },
  'us-treasury-yields': { path: '/api/economic/v1/get-us-treasury-par-yield-curve', country: false },
  'world-cpi': { path: '/api/economic/v1/get-world-cpi-monthly', country: true },
  'government-yields': { path: '/api/economic/v1/get-government-yield-curve', country: true },
} as const;

type MacroData = GetUsCpiMonthlyResponse | GetUsInterestRatesResponse
  | GetUsTreasuryParYieldCurveResponse | GetWorldCpiMonthlyResponse | GetGovernmentYieldCurveResponse;

const PERCENT_CHANGE_SCHEMA = { type: 'object', properties: { percent: { type: 'number' } } };
const CPI_READING_SCHEMA = {
  type: 'object',
  properties: {
    index: { type: 'number' },
    monthOverMonth: PERCENT_CHANGE_SCHEMA,
    yearOverYear: PERCENT_CHANGE_SCHEMA,
  },
};

export const MACRO_TOOLS: ToolDef[] = [{
  name: 'get_macro_history',
  _outputBudgetBytes: 262144,
  description: 'CPI, interest-rate and sovereign yield histories from seeded official-source reports. Select a dataset; country is required for world CPI or government yields. Default 30 newest observations per series, kept in chronological order; maximum 365. Set history=false for latest snapshots. Dates are Unix milliseconds, rates and yields are percentages. Missing readings or tenors are unknown, not zero. Preserve source, frequency, index base and yield measure when comparing countries. A truncated response is not full history; unavailable is not a zero reading.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset: { type: 'string', enum: Object.keys(DATASETS), description: 'Choose US CPI, US interest rates, US Treasury par yields, country CPI, or sovereign yields.' },
      country: { type: 'string', description: `Required for world-cpi and government-yields. Omit for US-only datasets. ${COUNTRY_ARG_HINT}` },
      history: { type: 'boolean', default: true, description: 'True returns bounded history; false requests the latest available snapshot.' },
      limit: { type: 'integer', minimum: 1, maximum: 365, default: DEFAULT_LIST_LIMIT, description: 'Maximum newest observations per series, in chronological order.' },
    },
    required: ['dataset'],
  },
  outputSchema: {
    type: 'object', required: ['dataset', 'history', 'truncated', 'data'],
    properties: {
      dataset: { type: 'string', enum: Object.keys(DATASETS) },
      history: { type: 'boolean' },
      truncated: { type: 'boolean', description: 'True if any series had older observations removed by the requested limit.' },
      data: {
        type: 'object', required: ['unavailable'],
        properties: {
          unavailable: { type: 'boolean' },
          country: { type: 'string' }, source: { type: 'string' }, measure: { type: 'string' },
          months: { type: 'array', items: { type: 'object', properties: {
            month: { type: 'integer' },
            headline: CPI_READING_SCHEMA, core: CPI_READING_SCHEMA, food: CPI_READING_SCHEMA,
            energy: CPI_READING_SCHEMA, shelter: CPI_READING_SCHEMA, services: CPI_READING_SCHEMA,
          } } },
          series: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' },
            points: { type: 'array', items: { type: 'object', properties: { date: { type: 'integer' }, percent: { type: 'number' } } } },
          } } },
          curves: { type: 'array', items: { type: 'object', properties: {
            date: { type: 'integer' },
            tenors: { type: 'object', additionalProperties: { type: 'number' } },
            oneMonth: { type: 'number' }, oneAndAHalfMonth: { type: 'number' }, twoMonth: { type: 'number' },
            threeMonth: { type: 'number' }, fourMonth: { type: 'number' }, sixMonth: { type: 'number' },
            oneYear: { type: 'number' }, twoYear: { type: 'number' }, threeYear: { type: 'number' },
            fiveYear: { type: 'number' }, sevenYear: { type: 'number' }, tenYear: { type: 'number' },
            twentyYear: { type: 'number' }, thirtyYear: { type: 'number' },
          } } },
          countries: { type: 'array', items: { type: 'object', properties: {
            country: { type: 'string' }, source: { type: 'string' }, frequency: { type: 'string' }, indexBase: { type: 'string' },
            periods: { type: 'array', items: { type: 'object', properties: {
              period: { type: 'integer' },
              reading: { type: 'object', properties: { index: { type: 'number' },
                periodOverPeriod: PERCENT_CHANGE_SCHEMA, yearOverYear: PERCENT_CHANGE_SCHEMA,
              } },
            } } },
          } } },
        },
      },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _execute: async (params, base, context, execution) => {
    const dataset = params.dataset;
    if (typeof dataset !== 'string' || !Object.prototype.hasOwnProperty.call(DATASETS, dataset)) {
      throw new RpcValidationError('get_macro_history', [{ field: 'dataset', description: 'Select a supported macro dataset.' }]);
    }
    const selected = DATASETS[dataset as keyof typeof DATASETS];
    if (params.history !== undefined && typeof params.history !== 'boolean') {
      throw new RpcValidationError('get_macro_history', [{ field: 'history', description: 'Expected a boolean.' }]);
    }
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 365) {
      throw new RpcValidationError('get_macro_history', [{ field: 'limit', description: 'Expected an integer from 1 through 365.' }]);
    }
    if (!selected.country && params.country !== undefined) {
      throw new RpcValidationError('get_macro_history', [{ field: 'country', description: 'Country is only supported for world-cpi and government-yields.' }]);
    }
    const country = selected.country ? requireCountryCode(params.country, 'get_macro_history', 'country') : undefined;
    const history = params.history ?? true;
    const query = new URLSearchParams({ history: String(history), limit: String(limit + 1), ...(country ? { country } : {}) });
    const url = `${base}${selected.path}?${query}`;
    const auth = await buildAuthHeaders(context, 'GET', url, null);
    const response = await fetchMcpDownstream(url, {
      headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
      signal: AbortSignal.timeout(25_000),
    }, execution);
    await assertToolFetchOk(response, 'get_macro_history', { preserveBackoff: true });
    const data = await response.json() as MacroData;
    let truncated = false;
    const cap = <T>(rows: T[]): T[] => {
      truncated ||= rows.length > limit;
      return rows.slice(-limit);
    };
    if ('months' in data) data.months = cap(data.months);
    if ('series' in data) data.series = data.series.map(series => ({ ...series, points: cap(series.points) }));
    if ('curves' in data) {
      truncated ||= data.curves.length > limit;
      data.curves = data.curves.slice(-limit);
    }
    if ('countries' in data) data.countries = data.countries.map(country => ({ ...country, periods: cap(country.periods) }));
    return { dataset, history, truncated, data };
  },
  _apiPaths: Object.values(DATASETS).map(dataset => `GET ${dataset.path}`),
}];
