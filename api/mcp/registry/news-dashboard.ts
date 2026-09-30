import { pluginNewsViewSchema, PLUGIN_NEWS_VIEW_INPUT_SCHEMA } from '../../../shared/plugin-news-view';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk, RpcValidationError } from '../billing-denial';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';

import { NEWS_DASHBOARD_UI_URI } from '../ui/news-dashboard-app';

export const NEWS_DASHBOARD_TOOLS: ToolDef[] = [{
  name: 'open_news_dashboard',
  title: 'WorldMonitor news and maps',
  description: 'Open WorldMonitor with its news category panels and interactive map. Returns the current full dashboard feed digest, including publication dates, source provenance inputs, coordinates and coverage. Empty arguments open the dashboard. Map view arguments are applied by the mounted app.',
  _uiResourceUri: NEWS_DASHBOARD_UI_URI,
  _openaiEntrypoints: [{ type: 'global' }, { type: 'thread' }],
  _outputBudgetBytes: 1048576,
  _apiPaths: ['GET /api/news/v1/list-feed-digest'],
  inputSchema: PLUGIN_NEWS_VIEW_INPUT_SCHEMA,
  outputSchema: {
    type: 'object',
    properties: {
      categories: { type: 'object', additionalProperties: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } }, required: ['items'] } },
      feedStatuses: { type: 'object', additionalProperties: { type: 'string' } },
      generatedAt: { type: 'string' },
      coverage: { type: 'object' },
      requestedView: { type: 'object' },
    },
    required: ['categories'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _execute: async (params, base, context, execution) => {
    const parsedView = pluginNewsViewSchema.safeParse(Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'jmespath')));
    if (!parsedView.success) throw new RpcValidationError('open_news_dashboard', [{ field: 'view', description: 'Invalid news view arguments; map center requires both latitude and longitude.' }]);
    const requestedView = parsedView.data;
    const url = `${base}/api/news/v1/list-feed-digest?variant=full&lang=en`;
    const headers = await buildAuthHeaders(context, 'GET', url, null);
    const response = await fetchMcpDownstream(url, {
      headers: { ...headers, 'User-Agent': 'WorldMonitor-MCP/1.0' },
      signal: AbortSignal.timeout(15_000),
    }, execution);
    await assertToolFetchOk(response, 'list-feed-digest');
    return { ...await response.json(), requestedView };
  },
}, {
  name: 'analyze_news_headlines',
  description: 'Summarize selected headlines or translate one headline into the target language specified by lang. Requires the same authenticated access as the dashboard service. Supply article snippets as bodies to ground summaries.',
  _outputBudgetBytes: 32768,
  _apiPaths: ['POST /api/news/v1/summarize-article'],
  inputSchema: {
    type: 'object',
    properties: {
      headlines: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', maxLength: 4000 } },
      bodies: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 400 } },
      mode: { type: 'string', enum: ['brief', 'translate'] },
      lang: { type: 'string', maxLength: 16 },
      geoContext: { type: 'string', maxLength: 100 },
    },
    required: ['headlines'],
    oneOf: [
      { required: ['mode'], properties: { mode: { const: 'translate' }, headlines: { type: 'array', maxItems: 1 } } },
      { properties: { mode: { const: 'brief' } } },
    ],
  },
  outputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      tokens: { type: 'integer' },
      fallback: { type: 'boolean' },
      error: { type: 'string' },
      errorType: { type: 'string' },
      status: { type: 'string' },
      statusDetail: { type: 'string' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _execute: async (params, base, context, execution) => {
    const mode = params.mode ?? 'brief';
    const lang = params.lang ?? 'en';
    if (mode === 'translate' && (!Array.isArray(params.headlines) || params.headlines.length !== 1)) {
      throw new RpcValidationError('analyze_news_headlines', [{ field: 'headlines', description: 'Translation requires exactly one headline.' }]);
    }
    const url = `${base}/api/news/v1/summarize-article`;
    const body = JSON.stringify({ provider: 'groq', headlines: params.headlines, bodies: params.bodies ?? [], mode, lang: mode === 'translate' ? '' : lang, geoContext: params.geoContext ?? '', variant: mode === 'translate' ? lang : 'full', systemAppend: '' });
    const headers = await buildAuthHeaders(context, 'POST', url, body);
    const response = await fetchMcpDownstream(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'User-Agent': 'WorldMonitor-MCP/1.0' }, body, signal: AbortSignal.timeout(25_000) }, execution);
    await assertToolFetchOk(response, 'summarize-article');
    return response.json();
  },
}];
