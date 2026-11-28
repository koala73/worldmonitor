import type { ToolDef } from '../types';
import { requireCountryCode } from '../_country-args';
import { buildAuthHeaders } from '../auth';
import { RpcValidationError } from '../billing-denial';
import { assertMcpToolFetchOk, fetchMcpDownstream } from '../downstream';

const score = (what: string) => ({ type: 'object', description: `${what} for this day; absent when it was unavailable at capture.`, required: ['score', 'version', 'observedAt'], properties: {
  score: { type: 'number', minimum: 0, maximum: 100, description: 'Score on a 0-100 scale.' },
  version: { type: 'string', description: 'Scoring formula version that produced the score.' },
  observedAt: { type: 'number', description: 'Unix epoch milliseconds when the score was computed.' },
} });

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
    days: { type: 'integer', minimum: 1, maximum: 365, description: 'Number of UTC calendar days to read, counting back from and including today. Omitted: 7. Capped at the account history depth; allowedDays and effectiveDays in the result report the cap.' },
  } },
  outputSchema: { type: 'object', required: ['country', 'requestedDays', 'allowedDays', 'effectiveDays', 'returnedDays', 'points', 'stale', 'upstreamUnavailable', 'fetchedAt'], properties: {
    country: { type: 'string', description: 'ISO alpha-2 country code read.' },
    requestedDays: { type: 'integer', description: 'Days asked for (7 when days was omitted).' },
    allowedDays: { type: 'integer', description: 'History depth the account may read.' },
    effectiveDays: { type: 'integer', description: 'Window actually read: the smaller of requestedDays and allowedDays.' },
    returnedDays: { type: 'integer', description: 'Number of daily points returned; lower than effectiveDays where days are missing.' },
    stale: { type: 'boolean', description: 'True when the history store was last written more than 36 hours ago, or could not be read.' },
    upstreamUnavailable: { type: 'boolean', description: 'True when the history store could not be read; points is then empty.' },
    fetchedAt: { type: 'number', description: 'Unix epoch milliseconds of the last history write; 0 when unavailable.' },
    points: { type: 'array', maxItems: 365, description: 'Daily snapshots, oldest first.', items: { type: 'object', required: ['date', 'capturedAt', 'topEvents', 'keySignals', 'ciiVersionBreak', 'resilienceVersionBreak'], properties: {
      date: { type: 'string', description: 'UTC day, YYYY-MM-DD.' },
      capturedAt: { type: 'number', description: 'Unix epoch milliseconds when the snapshot was taken.' },
      cii: score('Country Instability Index (higher means more unstable)'), resilience: score('Resilience score'),
      ciiVersionBreak: { type: 'boolean', description: 'True when the CII is not comparable with the previous point: a day is missing before it, either day lacks a score, or the formula version changed. Always false on the first point.' },
      resilienceVersionBreak: { type: 'boolean', description: 'Same as ciiVersionBreak, for the resilience score.' },
      keySignals: { type: 'array', items: { type: 'string' }, description: 'Data-quality flags for the day, such as cii_unavailable, resilience_unavailable, news_partial or events_reduced_for_output_budget.' },
      topEvents: { type: 'array', maxItems: 5, description: 'Headlines linked to the country that day.', items: { type: 'object', required: ['title', 'link', 'source', 'category'], properties: { title: { type: 'string', description: 'Headline text.' }, link: { type: 'string', description: 'Article URL.' }, source: { type: 'string', description: 'Publishing feed name.' }, category: { type: 'string', description: 'News category of the headline.' } } } },
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
