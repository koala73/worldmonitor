import { parseNewsDashboardRequest, NEWS_DASHBOARD_INPUT_SCHEMA } from '../../../shared/plugin-news-view';
import { newsPanelAdmissionSchema } from '../../../shared/panel-admission';
import * as z from 'zod';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk, RpcValidationError } from '../billing-denial';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';

import { NEWS_DASHBOARD_UI_URI } from '../ui/news-dashboard-app';
import { normalizeSummaryLanguage } from '../../../server/worldmonitor/news/v1/_shared';

const PANEL_RECEIPT_DOCS: Record<string, string> = {
  token: 'Signed request token the embedded view uses for its own loads.',
  expiresAt: 'When the request token expires, ISO 8601.',
  reused: 'True when an existing paid request was reused rather than a new one admitted.',
  usage: 'Today\'s paid panel requests on this account.',
  panel: 'Panel the request admits.',
  countryCode: 'Country the request admits, ISO alpha-2.',
};
const PANEL_USAGE_DOCS: Record<string, string> = {
  used: 'Requests admitted today, this one included.',
  limit: 'Daily request limit; null when the plan has no daily cap.',
  remaining: 'Requests left today; null when the plan has no daily cap.',
  resetsAt: 'When the daily count resets (next UTC midnight), ISO 8601.',
  unit: 'Unit of used, limit and remaining.',
};

/** JSON Schema for a panel admission receipt, with each field described. */
export function describedPanelReceipt(schema: z.ZodType, description: string): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as { properties: Record<string, Record<string, unknown>> };
  const properties = Object.fromEntries(Object.entries(json.properties).map(([key, value]) => [key, { ...value, ...(PANEL_RECEIPT_DOCS[key] ? { description: PANEL_RECEIPT_DOCS[key] } : {}) }]));
  const usage = properties.usage as { properties?: Record<string, Record<string, unknown>> } | undefined;
  if (usage?.properties) usage.properties = Object.fromEntries(Object.entries(usage.properties).map(([key, value]) => [key, { ...value, ...(PANEL_USAGE_DOCS[key] ? { description: PANEL_USAGE_DOCS[key] } : {}) }]));
  return { ...json, description, properties };
}

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
  inputSchema: {
    ...NEWS_DASHBOARD_INPUT_SCHEMA,
    properties: {
      ...NEWS_DASHBOARD_INPUT_SCHEMA.properties,
      query: { ...NEWS_DASHBOARD_INPUT_SCHEMA.properties.query, description: 'Text to search the news for: the rendered dashboard opens its search box with this query. Omitted: no search.' },
      renderer: { ...NEWS_DASHBOARD_INPUT_SCHEMA.properties.renderer, description: 'Map projection to render: a flat map or a 3D globe. Omitted: the map keeps the projection it is showing. The receipt reports a fallback when the requested renderer is unavailable.' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      categories: { type: 'object', description: 'News by panel category id, such as conflict or economy.', additionalProperties: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' }, description: 'Articles, each with source, title, link, publishedAt (Unix epoch milliseconds), location and importanceScore.' } }, required: ['items'] } },
      feedStatuses: { type: 'object', additionalProperties: { type: 'string' }, description: 'Feeds that did not return cleanly, by feed name: empty, timeout, all-undated or partial-undated. A feed not listed is ok.' },
      generatedAt: { type: 'string', description: 'When the digest was built, ISO 8601.' },
      coverage: { type: 'object', description: 'Counts of feeds and items served and of the latest build attempt.' },
      requestedView: { type: 'object', description: 'The view arguments as requested, not the state an already-open dashboard applied.' },
      panelRequest: describedPanelReceipt(newsPanelAdmissionSchema, 'Dedicated paid plans only: the paid dashboard request this open admitted or reused.'),
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
      headlines: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', maxLength: 500 }, description: 'Headline texts to summarize together, or in translate mode the one headline to translate.' },
      bodies: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 400 }, description: 'Article snippets that ground the brief, matched to headlines by position (bodies[0] belongs to headlines[0]). Ignored for translation.' },
      mode: { type: 'string', enum: ['brief', 'translate'], description: 'brief (default) summarizes the headlines; translate renders one headline in lang.' },
      lang: { type: 'string', maxLength: 16, description: 'BCP 47 code of the output language: the language to translate into, or the language the brief is written in. Omitted: en. Accepts the dashboard languages (en, ar, bg, cs, de, el, es, fa, fr, hi, hr, hu, it, ja, ko, nl, pl, pt, ro, ru, sv, sw, th, tr, uk, vi, zh, zh-TW); a regional tag such as pt-BR resolves to its base language, zh-Hant to zh-TW.' },
      geoContext: { type: 'string', maxLength: 100, description: 'Geographic or topical framing passed to the model with the headlines, such as "Sahel security". Omitted: no framing.' },
    },
    required: ['headlines'],
    oneOf: [
      { required: ['mode'], properties: { mode: { const: 'translate', description: 'Translation mode: lang is the target language.' }, headlines: { type: 'array', maxItems: 1, description: 'The headline to translate.' } } },
      { properties: { mode: { const: 'brief', description: 'Summarize the headlines into one brief; an omitted mode does the same.' } } },
    ],
  },
  outputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Generated brief or translation; empty on error.' },
      provider: { type: 'string', description: 'LLM provider that produced the text, or cache for a reused result.' },
      model: { type: 'string', description: 'Model identifier that produced the text.' },
      tokens: { type: 'integer', description: 'Tokens the LLM response used.' },
      fallback: { type: 'boolean', description: 'True when this provider could not answer and another provider should be tried.' },
      error: { type: 'string', description: 'Error message when the request failed.' },
      errorType: { type: 'string', description: 'Error class, such as ValidationError or AuthError.' },
      status: { type: 'string', description: 'SUMMARIZE_STATUS_SUCCESS, _CACHED, _SKIPPED or _ERROR.' },
      statusDetail: { type: 'string', description: 'Reason for a skipped or failed request.' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  _execute: async (params, base, context, execution) => {
    const mode = params.mode ?? 'brief';
    // summarize-article refuses any language outside the dashboard set, so a
    // regional tag is resolved here rather than failing downstream.
    const lang = normalizeSummaryLanguage(typeof params.lang === 'string' ? params.lang : 'en');
    if (!lang) {
      throw new RpcValidationError('analyze_news_headlines', [{ field: 'lang', description: 'Unsupported language. Use one of the dashboard languages, e.g. en, fr, de, es, ar, zh, zh-TW, ja.' }]);
    }
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
