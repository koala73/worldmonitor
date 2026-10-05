import { countryActivityQueries } from '../../shared/country-activity-query';
import { z } from 'zod';
import { countryReaderSchema, COUNTRY_READERS, countryViewSchema, type PanelAdmission } from '../../shared/country-brief-host';
import { resolveCountryCode } from '../../shared/country-code-resolve';
import { conflictPanelReadSchema, conflictPanelViewSchema, disasterPanelReadSchema, disasterPanelViewSchema, forecastCaseReadSchema, forecastPanelReadSchema, forecastPanelViewSchema, marketPanelReadSchema, marketPanelViewSchema, newsIntelligencePanelReadSchema, newsIntelligencePanelViewSchema, predictionPanelReadSchema, predictionPanelViewSchema, type ConflictPanelAdmission, type DisasterPanelAdmission, type ForecastPanelAdmission, type MarketPanelAdmission, type NewsIntelligencePanelAdmission, type NewsPanelAdmission, type PredictionPanelAdmission } from '../../shared/panel-admission';
import { parseNewsDashboardRequest } from '../../shared/plugin-news-view';
import { forecastTheaterReadSchema, reusableForecastTheaterResult } from '../../shared/forecast-theaters';
import { iso2ToComtradeReporterCode, iso2ToUnCode } from '../../shared/country-numeric-codes';
import { PANEL_REQUEST_READ_SCRIPT, PANEL_REQUEST_RESERVE_SCRIPT } from '../../shared/panel-request-scripts.mjs';
import { dailyCounterKey, dailyQuotaFloorKey, envPrefix, PRO_DAILY_QUOTA_TTL_SECONDS } from '../../server/_shared/pro-mcp-token';
import { validNewsIntelligenceCache, type NewsIntelligencePanelRead } from './_news-intelligence-snapshot';
import type { NaturalDisastersPanelRead } from './_natural-disasters-reuse';
import { conflictPanelReuseUntil, isConflictPanelSnapshotCacheable } from './registry/cache-tools';
import { resolveDailyLimit, type McpBudget } from './quota';
import type { McpAuthContext, PipelineFn } from './types';

export const PANEL_REUSE_MS = 300_000;
export const PANEL_READ_LIMIT = 64;
const MAX_CACHED_BYTES = 524288;
const encoder = new TextEncoder();

type PanelScope = { panel: string; window: string; expires: number };
export type PaidPanelAdmission = PanelAdmission | NewsPanelAdmission | ForecastPanelAdmission | MarketPanelAdmission | PredictionPanelAdmission | ConflictPanelAdmission | DisasterPanelAdmission | NewsIntelligencePanelAdmission;
export class PanelRequestError extends Error {
  constructor(message: string, public code: 'invalid' | 'quota' | 'reads' | 'backend', public limit?: number, public retryAfter?: number) {
    super(message);
    this.name = 'PanelRequestError';
  }
}

function userId(context: McpAuthContext): string {
  if (context.kind !== 'pro' && context.kind !== 'user_key') throw new PanelRequestError('A paid user-bound connection is required.', 'invalid');
  return context.userId;
}
function panelFamily(panel: string): 'country' | 'news-intelligence' | 'news' | 'forecasts' | 'markets' | 'predictions' | 'conflicts' | 'disasters' {
  return panel === 'news-intelligence' || panel === 'news' || panel === 'forecasts' || panel === 'markets' || panel === 'predictions' || panel === 'conflicts' || panel === 'disasters' ? panel : 'country';
}
function panelKey(owner: string, scope: PanelScope): string {
  return `${dailyCounterKey(owner, new Date(scope.expires - 1))}:${panelFamily(scope.panel)}:${scope.panel}:${scope.window}`;
}
async function signature(owner: string, scope: PanelScope): Promise<string> {
  const secret = process.env.MCP_INTERNAL_HMAC_SECRET;
  if (!secret) throw new PanelRequestError('Panel authentication is unavailable.', 'backend');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(`${panelFamily(scope.panel)}-panel:${envPrefix()}:${owner}:${scope.panel}:${scope.window}:${scope.expires}`));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}
async function tuple(pipeline: PipelineFn, command: Array<string | number>): Promise<[number, number, number?]> {
  let result;
  try { result = await pipeline([command], 5_000, true); } catch { throw new PanelRequestError('Panel metering is temporarily unavailable.', 'backend'); }
  const value = result?.length === 1 && !result[0]?.error ? result[0]?.result : undefined;
  if (!Array.isArray(value) || value.length < 2 || value.length > 3 || !value.every(Number.isSafeInteger)) throw new PanelRequestError('Panel metering is temporarily unavailable.', 'backend');
  return value as [number, number, number?];
}

export async function admitCountryPanel(context: McpAuthContext, budget: McpBudget | undefined, pipeline: PipelineFn, args: Record<string, unknown>, now = Date.now()): Promise<PanelAdmission> {
  const parsed = countryViewSchema.safeParse(args);
  const country = parsed.success ? resolveCountryCode(parsed.data.country_code) : null;
  if (!parsed.success || !country) throw new PanelRequestError('Supply a recognized country and topic.', 'invalid');
  return { ...await admitPanel(context, budget, pipeline, country, parsed.data, now), countryCode: country };
}

export async function admitNewsPanel(context: McpAuthContext, budget: McpBudget | undefined, pipeline: PipelineFn, args: Record<string, unknown>, now = Date.now()): Promise<NewsPanelAdmission> {
  const parsed = parseNewsDashboardRequest(args);
  if (!parsed.success) throw new PanelRequestError('Supply valid dashboard view and refresh arguments.', 'invalid');
  return { ...await admitPanel(context, budget, pipeline, 'news', parsed.data, now), panel: 'news' };
}

export async function admitMarketPanel(context: McpAuthContext, budget: McpBudget | undefined, pipeline: PipelineFn, args: Record<string, unknown>, now = Date.now()): Promise<MarketPanelAdmission> {
  const parsed = marketPanelViewSchema.safeParse(args);
  if (!parsed.success) throw new PanelRequestError('Supply valid curated market filters and a request_id for refresh.', 'invalid');
  return { ...await admitPanel(context, budget, pipeline, 'markets', parsed.data, now), panel: 'markets' };
}

export async function admitForecastPanel(context: McpAuthContext, budget: McpBudget | undefined, pipeline: PipelineFn, args: Record<string, unknown>, now = Date.now()): Promise<ForecastPanelAdmission> {
  const parsed = forecastPanelViewSchema.safeParse(args);
  if (!parsed.success) throw new PanelRequestError('Supply valid forecast filters and refresh arguments.', 'invalid');
  return { ...await admitPanel(context, budget, pipeline, 'forecasts', parsed.data, now), panel: 'forecasts' };
}

export async function admitPredictionPanel(context: McpAuthContext, budget: McpBudget | undefined, pipeline: PipelineFn, args: Record<string, unknown>, now = Date.now()): Promise<PredictionPanelAdmission> {
  const parsed = predictionPanelViewSchema.safeParse(args);
  if (!parsed.success) throw new PanelRequestError('Supply valid prediction filters and a request_id for refresh.', 'invalid');
  return { ...await admitPanel(context, budget, pipeline, 'predictions', parsed.data, now), panel: 'predictions' };
}

export async function admitConflictPanel(context: McpAuthContext, budget: McpBudget | undefined, pipeline: PipelineFn, args: Record<string, unknown>, now = Date.now()): Promise<ConflictPanelAdmission> {
  const parsed = conflictPanelViewSchema.safeParse(args);
  if (!parsed.success) throw new PanelRequestError('Supply valid conflict filters and a request_id for refresh.', 'invalid');
  return { ...await admitPanel(context, budget, pipeline, 'conflicts', parsed.data, now), panel: 'conflicts' };
}

export async function admitDisasterPanel(context: McpAuthContext, budget: McpBudget | undefined, pipeline: PipelineFn, args: Record<string, unknown>, now = Date.now()): Promise<DisasterPanelAdmission> {
  const parsed = disasterPanelViewSchema.safeParse(args);
  if (!parsed.success) throw new PanelRequestError('Supply valid disaster filters and a request_id for refresh.', 'invalid');
  return { ...await admitPanel(context, budget, pipeline, 'disasters', parsed.data, now), panel: 'disasters' };
}

export async function admitNewsIntelligencePanel(context: McpAuthContext, budget: McpBudget | undefined, pipeline: PipelineFn, args: Record<string, unknown>, now = Date.now()): Promise<NewsIntelligencePanelAdmission> {
  const parsed = newsIntelligencePanelViewSchema.safeParse(args);
  if (!parsed.success) throw new PanelRequestError('Supply valid news intelligence filters and a request_id for refresh.', 'invalid');
  return { ...await admitPanel(context, budget, pipeline, 'news-intelligence', parsed.data, now), panel: 'news-intelligence' };
}

async function admitPanel(context: McpAuthContext, budget: McpBudget | undefined, pipeline: PipelineFn, country: string, request: { refresh: boolean; request_id?: string }, now: number) {
  if (budget?.allowance === 'api') throw new PanelRequestError('API allowances use per-tool billing.', 'invalid');
  const owner = userId(context);
  const limit = resolveDailyLimit(budget?.limit);
  if (limit === 0) throw new PanelRequestError('Daily MCP allowance exceeded.', 'quota', 0);
  const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
  const bucket = Math.floor(now / PANEL_REUSE_MS);
  let scope: PanelScope = {
    panel: country, window: request.refresh ? `r${(request.request_id ?? crypto.randomUUID()).replace(/-/g, '').toLowerCase()}` : `b${bucket}`,
    expires: Math.min(midnight, request.refresh ? now + PANEL_REUSE_MS : (bucket + 2) * PANEL_REUSE_MS),
  };
  const previous: PanelScope = { panel: country, window: `b${bucket - 1}`, expires: Math.min(midnight, (bucket + 1) * PANEL_REUSE_MS) };
  const currentDay = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const reusePrevious = !request.refresh && (bucket - 1) * PANEL_REUSE_MS >= currentDay;
  await signature(owner, scope);
  const [status, count, expires] = await tuple(pipeline, ['EVAL', PANEL_REQUEST_RESERVE_SCRIPT, 4,
    dailyCounterKey(owner, new Date(now)), dailyQuotaFloorKey(owner, new Date(now)), panelKey(owner, scope), panelKey(owner, reusePrevious ? previous : scope),
    limit === null ? '' : limit, PRO_DAILY_QUOTA_TTL_SECONDS, 1, 1, Math.max(1, Math.ceil((scope.expires - now) / 1000)), scope.expires]);
  if (status === 0) throw new PanelRequestError('Daily MCP allowance exceeded.', 'quota', limit ?? undefined);
  if (![1, 2, 3].includes(status)) throw new PanelRequestError('Panel metering is temporarily unavailable.', 'backend');
  if (status === 3) scope = previous;
  if (expires === undefined || expires <= now || expires > scope.expires) throw new PanelRequestError('Panel expiry is unavailable.', 'backend');
  scope = { ...scope, expires };
  const mac = await signature(owner, scope);
  return {
    token: `${scope.panel}.${scope.window}.${scope.expires}.${mac}`,
    expiresAt: new Date(scope.expires).toISOString(), reused: status !== 1,
    usage: { used: count, limit, remaining: limit === null ? null : Math.max(0, limit - count), resetsAt: new Date(midnight).toISOString(), unit: 'requests' as const },
  };
}

function checkReadScope(name: string, args: Record<string, unknown>, country: string): void {
  if (country === 'news-intelligence') {
    if (name !== 'get_news_intelligence' || !newsIntelligencePanelReadSchema.safeParse(args).success) throw new PanelRequestError('Panel request only covers news intelligence.', 'invalid');
    return;
  }
  if (country === 'disasters') {
    if (name !== 'get_natural_disasters' || !disasterPanelReadSchema.safeParse(args).success) throw new PanelRequestError('Panel request only covers natural disasters.', 'invalid');
    return;
  }
  if (country === 'conflicts') {
    if (name !== 'get_conflict_events' || !conflictPanelReadSchema.safeParse(args).success) throw new PanelRequestError('Panel request only covers conflict events.', 'invalid');
    return;
  }
  if (country === 'predictions') {
    if (name !== 'get_prediction_markets' || !predictionPanelReadSchema.safeParse(args).success) throw new PanelRequestError('Panel request only covers curated prediction markets.', 'invalid');
    return;
  }
  if (country === 'markets') {
    if (name !== 'get_market_data' || !marketPanelReadSchema.safeParse(args).success) throw new PanelRequestError('Panel request only covers curated market data.', 'invalid');
    return;
  }
  if (country === 'forecasts') {
    if (name === 'get_forecast_predictions' && forecastPanelReadSchema.safeParse(args).success) return;
    if (name === 'get_forecast_case' && forecastCaseReadSchema.safeParse(args).success) return;
    if (name === 'get_forecast_theaters' && forecastTheaterReadSchema.safeParse(args).success) return;
    throw new PanelRequestError('Panel request only covers bounded forecast lists, original cases and latest theater summaries.', 'invalid');
  }
  if (country === 'news') {
    const snapshot = z.object({
      dataset: z.array(z.enum(['earthquakes', 'other', 'wildfires'])).min(1).max(3).refine(values => new Set(values).size === values.length),
      limit: z.union([z.literal(100), z.literal(20), z.literal(1)]),
    }).strict();
    if (name === 'open_news_dashboard' && z.object({}).strict().safeParse(args).success) return;
    if (name !== 'get_natural_disasters' || !snapshot.safeParse(args).success) throw new PanelRequestError('Panel request only covers dashboard news and bounded map snapshots.', 'invalid');
    return;
  }
  if (name === 'get_country_brief' || name === 'get_country_coverage') {
    const allowed = z.object({ country_code: z.string() }).strict().safeParse(args);
    if (!allowed.success || resolveCountryCode(allowed.data.country_code) !== country) throw new PanelRequestError('Panel request does not cover this country or analysis.', 'invalid');
    return;
  }
  if (name !== 'get_country_brief_section') throw new PanelRequestError('Panel request does not cover this tool.', 'invalid');
  const parsed = countryReaderSchema.safeParse(args);
  if (!parsed.success) throw new PanelRequestError('Invalid country reader.', 'invalid');
  const parameters = COUNTRY_READERS[parsed.data.section].args.safeParse(parsed.data.arguments);
  if (!parameters.success) throw new PanelRequestError('Invalid country reader arguments.', 'invalid');
  const values = parameters.data as Record<string, unknown>;
  for (const field of ['country_code', 'countryCode', 'iso2']) {
    const globalReader = parsed.data.section === 'food' && values[field] === 'WORLD'
      || parsed.data.section === 'production' && field === 'iso2' && values[field] === '';
    if (field in values && values[field] !== country && !globalReader) throw new PanelRequestError('Panel request does not cover this country.', 'invalid');
  }
  if (parsed.data.section === 'flights' && !countryActivityQueries(country).some(query => Object.entries(query).every(([key, value]) => values[key] === value))) throw new PanelRequestError('Panel request does not cover this activity viewport.', 'invalid');
  if (parsed.data.section === 'flows' && (iso2ToComtradeReporterCode(country) === null || Number(values.reporter_code) !== Number(iso2ToComtradeReporterCode(country)))) throw new PanelRequestError('Panel request does not cover this reporter.', 'invalid');
  if (parsed.data.section === 'tariffs' && (iso2ToUnCode(country) === null || Number(values.reporting_country) !== Number(iso2ToUnCode(country)))) throw new PanelRequestError('Panel request does not cover this reporter.', 'invalid');
  if (parsed.data.section === 'markets' && (values.category !== `country:${country}` || values.query !== '' || values.page_size !== 5)) throw new PanelRequestError('Panel request does not cover this market search.', 'invalid');
  if (parsed.data.section === 'china' && country !== 'CN') throw new PanelRequestError('Panel request does not cover China.', 'invalid');
}

function canonicalArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalArguments);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalArguments(entry)]));
  return value;
}

export async function authorizePanelRead(context: McpAuthContext, pipeline: PipelineFn, name: string, args: Record<string, unknown>, token: unknown, now = Date.now()) {
  const owner = userId(context);
  if (typeof token !== 'string' || token.length > 160) throw new PanelRequestError('Invalid panel request.', 'invalid');
  const match = /^(news-intelligence|news|markets|predictions|forecasts|conflicts|disasters|[A-Z]{2})\.(b\d{1,12}|r[a-f0-9]{32})\.(\d{13})\.([a-f0-9]{64})$/.exec(token);
  if (!match) throw new PanelRequestError('Invalid panel request.', 'invalid');
  const scope: PanelScope = { panel: match[1]!, window: match[2]!, expires: Number(match[3]) };
  if (scope.expires <= now || scope.expires > now + 2 * PANEL_REUSE_MS) throw new PanelRequestError('Panel request expired. Open or refresh the panel.', 'invalid');
  const expected = await signature(owner, scope);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ match[4]!.charCodeAt(i);
  if (mismatch) throw new PanelRequestError('Invalid panel request.', 'invalid');
  checkReadScope(name, args, scope.panel);
  const key = panelKey(owner, scope);
  const cacheArguments = scope.panel === 'news-intelligence'
    ? {}
    : scope.panel === 'markets'
    ? marketPanelReadSchema.parse(args)
    : scope.panel === 'predictions'
      ? predictionPanelReadSchema.parse(args)
      : scope.panel === 'conflicts'
        ? conflictPanelReadSchema.parse(args)
        : scope.panel === 'disasters'
          ? disasterPanelReadSchema.parse(args)
          : scope.panel === 'forecasts' && name === 'get_forecast_predictions'
            ? forecastPanelReadSchema.parse(args)
            : args;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([name, canonicalArguments(cacheArguments)])));
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  const cacheKey = `${key}:data:${hash}`;
  const cacheBudget = name === 'open_news_dashboard' ? 1048576 : MAX_CACHED_BYTES;
  let cached: unknown;
  try {
    const results = await pipeline([['GET', key], ['GET', cacheKey]], 5_000, true);
    if (!results || results.length !== 2 || results.some(item => item.error) || results[0]?.result !== String(scope.expires)) throw new Error('Missing paid admission');
    const raw = results[1]?.result;
    if (typeof raw === 'string' && encoder.encode(raw).length <= cacheBudget) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch (error) { if (name !== 'get_natural_disasters' && name !== 'get_news_intelligence') throw error; }
      if (name === 'get_news_intelligence') {
        if (validNewsIntelligenceCache(parsed, Date.now(), scope.expires)) cached = parsed.value;
      } else if (name === 'get_natural_disasters') {
        if (validDisasterCache(parsed, Date.now(), scope.expires)) cached = parsed.value;
      } else if (scope.panel !== 'conflicts' || conflictPanelReuseUntil(parsed) !== null) cached = parsed;
    }
  } catch { throw new PanelRequestError('Panel cache is temporarily unavailable.', 'backend'); }
  const ttl = Math.max(1, Math.ceil((scope.expires - now) / 1000));
  return {
    panel: scope.panel,
    rateLimitKey: `${key}:${cached === undefined ? 'read' : 'replay'}`,
    cached,
    reserveUncachedRead: async () => {
      if (cached !== undefined) return;
      const [status] = await tuple(pipeline, ['EVAL', PANEL_REQUEST_READ_SCRIPT, 2, key, `${key}:reads`, PANEL_READ_LIMIT, ttl, scope.expires]);
      if (status === 0) throw new PanelRequestError('This panel reached its read budget. Refresh to start another request.', 'reads', undefined, ttl);
      if (status !== 1) throw new PanelRequestError('Panel admission is unavailable.', 'backend');
    },
    saveNewsIntelligence: async (read: NewsIntelligencePanelRead) => {
      if (name !== 'get_news_intelligence' || read.reuseUntil === null) return;
      const wrapper = { value: read.value, reuseUntil: Math.min(scope.expires, read.reuseUntil) };
      if (!validNewsIntelligenceCache(wrapper, Date.now(), scope.expires)) return;
      const raw = JSON.stringify(wrapper);
      if (encoder.encode(raw).length > cacheBudget) return;
      const remaining = Math.floor((wrapper.reuseUntil - Date.now()) / 1000);
      if (remaining < 1) return;
      try { await pipeline([['SET', cacheKey, raw, 'EX', remaining]], 5_000, true); } catch { /* Optional reuse must not turn a valid read into an error. */ }
    },
    saveNaturalDisasters: async (read: NaturalDisastersPanelRead) => {
      if (name !== 'get_natural_disasters' || read.reuseUntil === null) return;
      const wrapper = { value: read.value, reuseUntil: Math.min(scope.expires, read.reuseUntil) };
      if (!validDisasterCache(wrapper, Date.now(), scope.expires)) return;
      const raw = JSON.stringify(wrapper);
      if (encoder.encode(raw).length > cacheBudget) return;
      const remaining = Math.floor((wrapper.reuseUntil - Date.now()) / 1000);
      if (remaining < 1) return;
      try { await pipeline([['SET', cacheKey, raw, 'EX', remaining]], 5_000, true); } catch { /* Optional reuse must not turn a valid read into an error. */ }
    },
    save: async (value: unknown) => {
      if (name === 'get_natural_disasters' || name === 'get_news_intelligence') return;
      if (scope.panel === 'conflicts' && !isConflictPanelSnapshotCacheable(value)) return;
      if (scope.panel === 'predictions' && (!value || typeof value !== 'object' || Array.isArray(value))) return;
      if (name === 'get_forecast_theaters') {
        if (!value || typeof value !== 'object' || !('data' in value) || !value.data || typeof value.data !== 'object'
          || !('forecastTheaters' in value.data) || !reusableForecastTheaterResult(value.data.forecastTheaters)) return;
      }
      if (name === 'get_forecast_predictions') {
        if (!value || typeof value !== 'object' || !('data' in value) || !value.data || typeof value.data !== 'object' || !('predictions' in value.data)) return;
        const source = value.data.predictions;
        if (!source || typeof source !== 'object' || !('predictions' in source) || !Array.isArray(source.predictions)) return;
      }
      if (name === 'get_forecast_case') {
        if (!value || typeof value !== 'object' || !('data' in value) || !value.data || typeof value.data !== 'object' || !('forecastCase' in value.data)) return;
        const detail = value.data.forecastCase;
        if (!detail || typeof detail !== 'object' || !('status' in detail) || detail.status !== 'ready'
          || !('generatedAt' in detail) || String(detail.generatedAt) !== args.generated_at
          || !('forecast' in detail) || !detail.forecast || typeof detail.forecast !== 'object' || Array.isArray(detail.forecast)
          || !('id' in detail.forecast) || detail.forecast.id !== args.forecast_id) return;
      }
      if (name === 'open_news_dashboard' && (!value || typeof value !== 'object'
        || !('categories' in value) || !value.categories || typeof value.categories !== 'object' || Array.isArray(value.categories))) return;
      if (value && typeof value === 'object') {
        if (scope.panel === 'predictions') {
          const envelope = value as { cached_at?: unknown; stale?: unknown; unreadable?: unknown; data?: Record<string, unknown> };
          const bootstrap = envelope.data?.['markets-bootstrap'];
          if (typeof envelope.cached_at !== 'string' || !Number.isFinite(Date.parse(envelope.cached_at)) || envelope.stale !== false
            || Array.isArray(envelope.unreadable) && envelope.unreadable.length
            || !bootstrap || typeof bootstrap !== 'object' || Array.isArray(bootstrap)
            || !['geopolitical', 'tech', 'finance'].every(category => Array.isArray((bootstrap as Record<string, unknown>)[category]))
            || ['unavailable', 'upstreamUnavailable', 'rateLimited', 'stale', 'degraded'].some(flag => (bootstrap as Record<string, unknown>)[flag] === true)
            || typeof (bootstrap as Record<string, unknown>).error === 'string' && (bootstrap as Record<string, unknown>).error !== '') return;
        }
        if (scope.panel === 'markets') {
          if ('unreadable' in value && Array.isArray(value.unreadable) && value.unreadable.length) return;
          if ('data' in value && value.data && typeof value.data === 'object'
            && Object.values(value.data).some(bucket => bucket && typeof bucket === 'object'
              && ('rateLimited' in bucket && bucket.rateLimited === true
                || 'unavailable' in bucket && bucket.unavailable === true
                || 'upstreamUnavailable' in bucket && bucket.upstreamUnavailable === true
                || 'skipReason' in bucket && typeof bucket.skipReason === 'string' && bucket.skipReason !== ''
                || 'valuationCoverage' in bucket && bucket.valuationCoverage && typeof bucket.valuationCoverage === 'object'
                  && ('stale' in bucket.valuationCoverage && bucket.valuationCoverage.stale === true
                    || 'sourceStatus' in bucket.valuationCoverage && bucket.valuationCoverage.sourceStatus !== 'ok')))) return;
        }
        if ('stale' in value && value.stale === true) return;
        if ('degraded' in value && value.degraded === true) return;
        if ('coverage' in value && value.coverage && typeof value.coverage === 'object'
          && ('servedStale' in value.coverage && value.coverage.servedStale === true || 'state' in value.coverage && value.coverage.state !== 'complete')) return;
        if ('upstreamUnavailable' in value && value.upstreamUnavailable === true) return;
        if ('data' in value && value.data && typeof value.data === 'object'
          && Object.values(value.data).some(bucket => bucket === null || bucket && typeof bucket === 'object' && 'dataAvailable' in bucket && bucket.dataAvailable === false)) return;
        if ('state' in value && value.state !== 'ready') return;
        if ('value' in value && value.value && typeof value.value === 'object' && 'upstreamUnavailable' in value.value && value.value.upstreamUnavailable === true) return;
        if ('value' in value && value.value && typeof value.value === 'object' && 'missing' in value.value && Array.isArray(value.value.missing) && value.value.missing.length) return;
      }
      const raw = JSON.stringify(value);
      if (!raw || encoder.encode(raw).length > cacheBudget) return;
      let cacheTtl = ttl;
      if (scope.panel === 'conflicts') {
        const savedAt = Date.now();
        const reuseUntil = conflictPanelReuseUntil(value, savedAt);
        if (reuseUntil === null) return;
        cacheTtl = Math.floor((Math.min(scope.expires, reuseUntil) - savedAt) / 1000);
        if (cacheTtl < 1) return;
      }
      try { await pipeline([['SET', cacheKey, raw, 'EX', cacheTtl]], 5_000, true); } catch { /* Reads remain valid when optional response reuse is unavailable. */ }
    },
  };
}

function validDisasterCache(value: unknown, now: number, expires: number): value is { value: unknown; reuseUntil: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const wrapper = value as Record<string, unknown>;
  if (Object.keys(wrapper).sort().join(',') !== 'reuseUntil,value'
    || typeof wrapper.reuseUntil !== 'number' || !Number.isSafeInteger(wrapper.reuseUntil)
    || wrapper.reuseUntil <= now || wrapper.reuseUntil > expires
    || !wrapper.value || typeof wrapper.value !== 'object' || Array.isArray(wrapper.value)) return false;
  const envelope = wrapper.value as Record<string, unknown>;
  return typeof envelope.cached_at === 'string' && Number.isFinite(Date.parse(envelope.cached_at))
    && envelope.stale === false && !!envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
    && Object.entries(envelope.data).length > 0 && Object.entries(envelope.data).every(([label, bucket]) => {
      const list = label === 'earthquakes' ? 'earthquakes' : label === 'fires' ? 'fireDetections' : label === 'events' ? 'events' : null;
      if (!list || !bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return false;
      const rows = (bucket as Record<string, unknown>)[list];
      return Array.isArray(rows) && rows.every(row => row && typeof row === 'object' && !Array.isArray(row));
    });
}
