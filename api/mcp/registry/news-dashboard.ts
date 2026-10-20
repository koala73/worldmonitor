import { parseNewsDashboardRequest, NEWS_DASHBOARD_INPUT_SCHEMA } from '../../../shared/plugin-news-view';
import { newsPanelAdmissionSchema } from '../../../shared/panel-admission';
import { z } from 'zod';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk, RpcValidationError } from '../billing-denial';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';

import { NEWS_DASHBOARD_UI_URI } from '../ui/news-dashboard-app';

function newsDashboardView(params: Record<string, unknown>) {
  const parsedView = parseNewsDashboardRequest(params);
  if (!parsedView.success) throw new RpcValidationError('open_news_dashboard', [{ field: 'view', description: 'Invalid news view arguments; map center requires both latitude and longitude.' }]);
  return parsedView.data.view;
}

export const NEWS_DASHBOARD_TOOLS: ToolDef[] = [{
  name: 'open_news_dashboard',
  title: 'WorldMonitor news and maps',
  description: 'Open the embedded WorldMonitor news and map dashboard and return the full feed digest (categories with items, publication dates, source provenance, coordinates, feedStatuses, coverage) plus requestedView. The view arguments (query, source, category, country, time_range, renderer, map_layers, map center and zoom) configure the rendered instance; requestedView echoes what was requested, not an already-open map\'s applied state, and empty arguments open the default dashboard. Requires a paid plan; weight 2 on API plans. On dedicated paid plans one dashboard request covers the news load and bounded map snapshot loads, repeat opens reuse it for at least five minutes, and refresh with request_id starts one new request. Read-only; up to 1 MB of digest.',
  _uiResourceUri: NEWS_DASHBOARD_UI_URI,
  _openaiEntrypoints: [{ type: 'global' }, { type: 'thread' }],
  _outputBudgetBytes: 1048576,
  _apiPaths: ['GET /api/news/v1/list-feed-digest'],
  inputSchema: NEWS_DASHBOARD_INPUT_SCHEMA,
  outputSchema: {
    type: 'object',
    properties: {
      categories: { type: 'object', additionalProperties: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } }, required: ['items'] } },
      feedStatuses: { type: 'object', additionalProperties: { type: 'string' } },
      generatedAt: { type: 'string' },
      coverage: { type: 'object' },
      requestedView: { type: 'object' },
      panelRequest: z.toJSONSchema(newsPanelAdmissionSchema),
    },
    required: ['categories'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _validateArgs: newsDashboardView,
  _execute: async (params, base, context, execution) => {
    const requestedView = newsDashboardView(params);
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
  title: 'Summarize or translate headlines',
  description: 'Summarize up to 8 supplied headlines (mode brief, the default) or translate exactly one headline (mode translate) with the dashboard\'s LLM route, returning {summary, provider, model, tokens, fallback} or an error with errorType. The text is generated per call from the headlines and optional bodies (article snippets, up to 400 characters each, that ground the summary); nothing is fetched from WorldMonitor\'s own feeds. lang is the target language code for a translation and the output language for a brief (default en); geoContext adds a short framing hint. Requires a paid plan; one live LLM request, weight 2 on API plans, up to 25 s. Read-only.',
  _outputBudgetBytes: 32768,
  _apiPaths: ['POST /api/news/v1/summarize-article'],
  inputSchema: {
    type: 'object',
    properties: {
      headlines: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', maxLength: 4000 }, description: 'Headlines to work on: 1-8 for a brief, exactly 1 for a translation. Each up to 4000 characters.' },
      bodies: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 400 }, description: 'Optional article snippets, index-aligned with headlines (up to 400 characters each), that ground the brief. Ignored for translation.' },
      mode: { type: 'string', enum: ['brief', 'translate'], description: 'brief (default) summarizes the headlines; translate renders one headline in lang.' },
      lang: { type: 'string', maxLength: 16, description: 'BCP 47 language code: the target language for translate and the output language for brief (default en).' },
      geoContext: { type: 'string', maxLength: 100, description: 'Optional short geographic or topical framing passed to the model with the headlines.' },
    },
    required: ['headlines'],
    oneOf: [
      { required: ['mode'], properties: { mode: { const: 'translate', description: 'Translation mode: lang is the target language.' }, headlines: { type: 'array', maxItems: 1, description: 'Exactly one headline to translate.' } } },
      { properties: { mode: { const: 'brief', description: 'Brief mode (the default when mode is omitted): summarize the headlines.' } } },
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
    const body = JSON.stringify({ provider: 'openrouter', headlines: params.headlines, bodies: params.bodies ?? [], mode, lang: mode === 'translate' ? '' : lang, geoContext: params.geoContext ?? '', variant: mode === 'translate' ? lang : 'full', systemAppend: '' });
    const headers = await buildAuthHeaders(context, 'POST', url, body);
    const response = await fetchMcpDownstream(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'User-Agent': 'WorldMonitor-MCP/1.0' }, body, signal: AbortSignal.timeout(25_000) }, execution);
    await assertToolFetchOk(response, 'summarize-article');
    return response.json();
  },
}];
