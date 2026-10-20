import type { ToolDef } from '../types';
import { requireCountryCode } from '../_country-args';
import { buildAuthHeaders } from '../auth';
import { RpcValidationError } from '../billing-denial';
import { assertMcpToolFetchOk, fetchMcpDownstream } from '../downstream';

const score = { type: 'object', required: ['score', 'version', 'observedAt'], properties: { score: { type: 'number', minimum: 0, maximum: 100 }, version: { type: 'string' }, observedAt: { type: 'number' } } };

export const COUNTRY_HISTORY_TOOL: ToolDef = {
  name: 'get_country_history',
  title: 'Country daily history',
  description: 'Read cached daily country CII, resilience and linked headlines. Account depth: Pro 90 days; API/Enterprise 365. Starts at activation; gaps and formula breaks remain explicit. One request. Large outputs retain one headline per day, marked events_reduced_for_output_budget.',
  _subscriptionOnly: true,
  _outputBudgetBytes: 1048576,
  _apiPaths: ['GET /api/intelligence/v1/get-country-history'],
  _coverageKeys: ['history:country:index'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: 'object', required: ['country_code'], properties: {
    country_code: { type: 'string', description: 'Assigned ISO alpha-2 country code, such as US or FR.' },
    days: { type: 'integer', minimum: 1, maximum: 365, description: 'UTC calendar days including today. Defaults to 7; the account retention limit applies.' },
  } },
  outputSchema: { type: 'object', required: ['country', 'requestedDays', 'allowedDays', 'effectiveDays', 'returnedDays', 'points', 'stale', 'upstreamUnavailable', 'fetchedAt'], properties: {
    country: { type: 'string' }, requestedDays: { type: 'integer' }, allowedDays: { type: 'integer' }, effectiveDays: { type: 'integer' }, returnedDays: { type: 'integer' }, stale: { type: 'boolean' }, upstreamUnavailable: { type: 'boolean' }, fetchedAt: { type: 'number' },
    points: { type: 'array', maxItems: 365, items: { type: 'object', required: ['date', 'capturedAt', 'topEvents', 'keySignals', 'ciiVersionBreak', 'resilienceVersionBreak'], properties: {
      date: { type: 'string' }, capturedAt: { type: 'number' }, cii: score, resilience: score,
      ciiVersionBreak: { type: 'boolean' }, resilienceVersionBreak: { type: 'boolean' },
      keySignals: { type: 'array', items: { type: 'string' } },
      topEvents: { type: 'array', maxItems: 5, items: { type: 'object', required: ['title', 'link', 'source', 'category'], properties: { title: { type: 'string' }, link: { type: 'string' }, source: { type: 'string' }, category: { type: 'string' } } } },
    } } },
  } },
  _fitToBudget(result) {
    if (!Array.isArray(result.points)) return result;
    return { ...result, points: result.points.map(point => ({ ...point, topEvents: point.topEvents.slice(0, 1), keySignals: point.topEvents.length > 1 ? [...point.keySignals, 'events_reduced_for_output_budget'] : point.keySignals })) };
  },
  async _execute(params, base, context, execution) {
    const country = requireCountryCode(params.country_code, 'get_country_history', 'country_code');
    const days = params.days ?? 7;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) throw new RpcValidationError('get_country_history', [{ field: 'days', description: 'Use an integer from 1 to 365.' }]);
    const url = `${base}/api/intelligence/v1/get-country-history?country=${encodeURIComponent(country)}&days=${days}`;
    const response = await fetchMcpDownstream(url, { headers: { ...await buildAuthHeaders(context, 'GET', url, null), 'User-Agent': 'worldmonitor-mcp-edge/1.0' }, signal: AbortSignal.timeout(8000) }, execution);
    await assertMcpToolFetchOk(response, { tool: 'get_country_history', operation: 'get-country-history', auth: context });
    return response.json();
  },
};
