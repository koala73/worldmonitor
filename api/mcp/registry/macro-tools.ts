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

const percentChange = (description: string) => ({ type: 'object', description, properties: { percent: { type: 'number', description: 'Change, percent.' } } });
const CPI_READING_SCHEMA = {
  type: 'object',
  description: 'One CPI component; absent when not reported for the month.',
  properties: {
    index: { type: 'number', description: 'Index level.' },
    monthOverMonth: percentChange('Change from the previous month; absent when unknown.'),
    yearOverYear: percentChange('Change from the same month a year earlier; absent when unknown.'),
  },
};
const yieldPercent = (tenor: string) => ({ type: 'number', description: `${tenor} yield, percent; absent when not quoted.` });

function macroCountry(params: Record<string, unknown>): string | undefined {
  if (params.dataset === 'world-cpi' || params.dataset === 'government-yields') {
    return requireCountryCode(params.country, 'get_macro_history', 'country');
  }
  if (params.country !== undefined) {
    throw new RpcValidationError('get_macro_history', [{ field: 'country', description: 'Country is only supported for world-cpi and government-yields.' }]);
  }
  return undefined;
}

export const MACRO_TOOLS: ToolDef[] = [{
  name: 'get_macro_history',
  _validateArgs: params => { macroCountry(params); },
  title: 'Inflation, rates and yield history',
  _outputBudgetBytes: 262144,
  description: 'CPI, interest-rate and sovereign yield histories from seeded official-source reports. Select a dataset; country is required for world CPI or government yields. Default 30 newest observations per series, kept in chronological order; maximum 365. Set history=false for latest snapshots. Dates are Unix milliseconds, rates and yields are percentages. Missing readings or tenors are unknown, not zero. Series differ in source, frequency, index base and yield measure; a series records those that apply to its dataset. A truncated response is not full history; unavailable is not a zero reading.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset: { type: 'string', enum: Object.keys(DATASETS), description: 'Series family: us-cpi (US CPI by component), us-interest-rates (Fed funds, Treasury constant-maturity and SOFR rates), us-treasury-yields (US Treasury par yield curve), world-cpi (one country\'s CPI) or government-yields (one country\'s sovereign yield curve).' },
      country: { type: 'string', description: `Country whose CPI or yield curve to read. Required for world-cpi and government-yields; the US datasets reject it. ${COUNTRY_ARG_HINT}` },
      history: { type: 'boolean', default: true, description: 'Whether to return a time series (up to limit observations per series) or only the latest available observation.' },
      limit: { type: 'integer', minimum: 1, maximum: 365, default: DEFAULT_LIST_LIMIT, description: 'Number of newest observations kept in each series, returned oldest first. Older observations are dropped and truncated is set.' },
    },
    required: ['dataset'],
  },
  outputSchema: {
    type: 'object', required: ['dataset', 'history', 'truncated', 'data'],
    properties: {
      dataset: { type: 'string', enum: Object.keys(DATASETS), description: 'Dataset read.' },
      history: { type: 'boolean', description: 'Whether a time series (true) or the latest observation (false) was requested.' },
      truncated: { type: 'boolean', description: 'True if any series had older observations removed by the requested limit.' },
      data: {
        type: 'object', required: ['unavailable'],
        properties: {
          unavailable: { type: 'boolean', description: 'True when the dataset could not be read; the arrays are then empty. Not a zero reading.' },
          country: { type: 'string', description: 'government-yields: ISO alpha-2 country read.' },
          source: { type: 'string', description: 'government-yields: source id of the curve, such as jp-mof-cmt.' },
          measure: { type: 'string', description: 'government-yields: yield measure (par, spot or benchmark), or monthly-10y for the monthly 10-year fallback.' },
          months: { type: 'array', description: 'us-cpi: monthly readings, oldest first.', items: { type: 'object', properties: {
            month: { type: 'integer', description: 'First day of the month, Unix epoch milliseconds.' },
            headline: CPI_READING_SCHEMA, core: CPI_READING_SCHEMA, food: CPI_READING_SCHEMA,
            energy: CPI_READING_SCHEMA, shelter: CPI_READING_SCHEMA, services: CPI_READING_SCHEMA,
          } } },
          series: { type: 'array', description: 'us-interest-rates: one entry per rate.', items: { type: 'object', properties: {
            id: { type: 'string', description: 'Rate id, such as fedFundsEffective, treasuryTenYear or sofr.' },
            points: { type: 'array', description: 'Observations, oldest first.', items: { type: 'object', properties: { date: { type: 'integer', description: 'Observation date, Unix epoch milliseconds.' }, percent: { type: 'number', description: 'Rate, percent.' } } } },
          } } },
          curves: { type: 'array', description: 'us-treasury-yields and government-yields: one yield curve per date, oldest first.', items: { type: 'object', properties: {
            date: { type: 'integer', description: 'Curve date, Unix epoch milliseconds.' },
            tenors: { type: 'object', additionalProperties: { type: 'number' }, description: 'government-yields: yield in percent keyed by tenor label, such as 10Y.' },
            oneMonth: yieldPercent('1-month'), oneAndAHalfMonth: yieldPercent('6-week'), twoMonth: yieldPercent('2-month'),
            threeMonth: yieldPercent('3-month'), fourMonth: yieldPercent('4-month'), sixMonth: yieldPercent('6-month'),
            oneYear: yieldPercent('1-year'), twoYear: yieldPercent('2-year'), threeYear: yieldPercent('3-year'),
            fiveYear: yieldPercent('5-year'), sevenYear: yieldPercent('7-year'), tenYear: yieldPercent('10-year'),
            twentyYear: yieldPercent('20-year'), thirtyYear: yieldPercent('30-year'),
          } } },
          countries: { type: 'array', description: 'world-cpi: the requested country\'s CPI series.', items: { type: 'object', properties: {
            country: { type: 'string', description: 'ISO alpha-2 country code.' },
            source: { type: 'string', description: 'Source id of the series, such as eurostat-hicp.' },
            frequency: { type: 'string', description: 'Reporting frequency of the series.' },
            indexBase: { type: 'string', description: 'Base period of the index (where it equals 100).' },
            periods: { type: 'array', description: 'Readings, oldest first.', items: { type: 'object', properties: {
              period: { type: 'integer', description: 'Start of the period, Unix epoch milliseconds.' },
              reading: { type: 'object', properties: { index: { type: 'number', description: 'Index level.' },
                periodOverPeriod: percentChange('Change from the previous period; absent when unknown.'), yearOverYear: percentChange('Change from the same period a year earlier; absent when unknown.'),
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
    const country = macroCountry(params);
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
