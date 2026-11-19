import * as z from 'zod';
import { applyRedisKeyPrefix, readJsonBatchFromUpstashWithStatus } from '../../_upstash-json.js';
import { isAppOwnedRedisKey } from '../../_redis-key-ownership.js';
import { readCountryCiiHistory } from '../_cii-history';
import { RpcValidationError } from '../billing-denial';
import { evaluateFreshness } from '../freshness';
import { McpSourceUnavailableError } from '../source-unavailable';
import type { ToolDef } from '../types';
import { utf8ByteLength } from '../utils';
import { isAssignedCountryCode } from '../../../shared/country-code-resolve';
import { CII_FORMULA_VERSION } from '../../../server/worldmonitor/intelligence/v1/_risk-config';
import { ANALYSIS_TOOLS } from './analysis-tools';
import {
  buildTravelRiskResult,
  CII_SCORED_CODES,
  SECURITY_WINDOW_DAYS,
  TRAVEL_RISK_FEEDS,
  TRAVEL_RISK_TOOL,
  type FeedId,
  type SourceSnapshot,
  type TravelRiskResult,
  type TravelRiskSources,
  type TripInput,
} from './_travel-risk-document';

export { TRAVEL_RISK_TOOL } from './_travel-risk-document';

export const MAX_TRIP_COUNTRIES = 6;
export const MAX_CITIES_PER_COUNTRY = 5;
export const MAX_CITY_CHARS = 80;
export const MAX_TASK_LABEL_CHARS = 120;
const OUTPUT_BUDGET_BYTES = 262_144;
/** Source reads in flight at once. */
const SOURCE_CONCURRENCY = 3;
const SOURCE_TIMEOUT_MS = 5_000;

const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
// Intl names statistical regions and test locales too; none of them is a destination.
const NON_COUNTRY_REGIONS = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'XX', 'ZZ']);

function countryName(code: string): string | null {
  if (!isAssignedCountryCode(code) || NON_COUNTRY_REGIONS.has(code)) return null;
  return regionNames.of(code) ?? null;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

const DATE_MESSAGE = 'Use a calendar date in YYYY-MM-DD form.';
const dateField = z.string().refine(isCalendarDate, DATE_MESSAGE);
// Control characters would break the one-line rendering and carry nothing a
// city name needs.
const cityField = z.string().trim().min(1, 'Give a city name, or omit the entry.').max(MAX_CITY_CHARS, `Use at most ${MAX_CITY_CHARS} characters.`)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Use a plain city name.');

const PERSONAL_DETAILS_HINT = 'Unknown argument. This tool takes countries, city names and dates only, never traveller names, contact details or addresses.';

const tripCountrySchema = z.object({
  country_code: z.string().regex(/^[A-Za-z]{2}$/, 'Use an ISO 3166-1 alpha-2 code such as TH.')
    .transform((value) => value.toUpperCase())
    .refine((code) => countryName(code) !== null, 'Use an assigned ISO 3166-1 alpha-2 country code.'),
  cities: z.array(cityField).max(MAX_CITIES_PER_COUNTRY, `List at most ${MAX_CITIES_PER_COUNTRY} cities per country.`).optional(),
  arrive: dateField.optional(),
  depart: dateField.optional(),
}).strict();

const argsSchema = z.object({
  countries: z.array(tripCountrySchema)
    .min(1, 'List at least one country.')
    .max(MAX_TRIP_COUNTRIES, `List at most ${MAX_TRIP_COUNTRIES} countries.`),
  date_from: dateField.optional(),
  date_to: dateField.optional(),
  task_label: z.string().trim().min(1, 'Give a label, or omit it.').max(MAX_TASK_LABEL_CHARS, `Use at most ${MAX_TASK_LABEL_CHARS} characters.`)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Use one line of plain text.')
    .optional(),
}).strict().superRefine((args, ctx) => {
  if (args.date_from && args.date_to && args.date_to < args.date_from) {
    ctx.addIssue({ code: 'custom', path: ['date_to'], message: 'Must be on or after date_from.' });
  }
  const seen = new Set<string>();
  // The list is in travel order, so a country cannot arrive or depart before
  // an earlier country's arrival.
  let latestArrive: string | null = null;
  args.countries.forEach((country, index) => {
    if (seen.has(country.country_code)) {
      ctx.addIssue({ code: 'custom', path: ['countries', index, 'country_code'], message: 'List each country once, with its first arrival and last departure.' });
    }
    seen.add(country.country_code);
    if (country.arrive && country.depart && country.depart < country.arrive) {
      ctx.addIssue({ code: 'custom', path: ['countries', index, 'depart'], message: 'Must be on or after arrive.' });
    }
    for (const field of ['arrive', 'depart'] as const) {
      const dated = country[field];
      if (dated && latestArrive && dated < latestArrive) {
        ctx.addIssue({ code: 'custom', path: ['countries', index, field], message: 'Countries are listed in travel order; this date is before an earlier country\'s arrival.' });
      }
    }
    if (country.arrive && (!latestArrive || country.arrive > latestArrive)) latestArrive = country.arrive;
    for (const field of ['arrive', 'depart'] as const) {
      const value = country[field];
      if (!value) continue;
      if ((args.date_from && value < args.date_from) || (args.date_to && value > args.date_to)) {
        ctx.addIssue({ code: 'custom', path: ['countries', index, field], message: 'Must fall inside date_from to date_to.' });
      }
    }
  });
});

/**
 * Validates and normalises the trip. Violations name the field and the rule,
 * never the submitted value, so nothing a caller typed is repeated back into
 * an error that a log line could carry.
 */
export function parseTravelRiskArgs(params: Record<string, unknown>): TripInput {
  const { jmespath: _projection, ...args } = params;
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) {
    const violations = parsed.error.issues.slice(0, 8).flatMap((issue) => {
      const field = issue.path.map(String).join('.') || 'arguments';
      if (issue.code === 'unrecognized_keys') {
        return issue.keys.map((key) => ({ field: (field === 'arguments' ? key : `${field}.${key}`).slice(0, 100), description: PERSONAL_DETAILS_HINT }));
      }
      if (issue.code === 'invalid_type') return [{ field, description: `Expected ${issue.expected}.` }];
      return [{ field, description: issue.message }];
    });
    throw new RpcValidationError(TRAVEL_RISK_TOOL, violations.slice(0, 8));
  }
  const { countries, date_from: dateFrom, date_to: dateTo, task_label: taskLabel } = parsed.data;
  return {
    countries: countries.map((country) => ({
      countryCode: country.country_code,
      countryName: countryName(country.country_code)!,
      cities: country.cities ?? [],
      arrive: country.arrive ?? null,
      depart: country.depart ?? null,
    })),
    dateFrom: dateFrom ?? null,
    dateTo: dateTo ?? null,
    taskLabel: taskLabel ?? null,
  };
}

// ---------------------------------------------------------------------------
// Source reads
// ---------------------------------------------------------------------------

export interface TravelRiskDeps {
  readBatch: (keys: string[]) => Promise<Array<{ status: 'hit' | 'miss' | 'error'; value: unknown }>>;
  readCiiHistory: (code: string, nowMs: number) => Promise<unknown>;
  runHotspots: () => Promise<unknown>;
  now: () => number;
  timeoutMs: number;
}

const hotspotTool = ANALYSIS_TOOLS.find((tool) => tool.name === 'get_hotspot_escalation');

export const DEFAULT_TRAVEL_RISK_DEPS: TravelRiskDeps = {
  // Seeder-owned keys are read bare and app-owned keys with the deployment
  // prefix, as the analysis tools do.
  readBatch: (keys) => readJsonBatchFromUpstashWithStatus(
    keys.map((key) => (isAppOwnedRedisKey(key) ? applyRedisKeyPrefix(key) : key)),
    SOURCE_TIMEOUT_MS - 500,
    true,
  ),
  readCiiHistory: (code, nowMs) => readCountryCiiHistory(code, SECURITY_WINDOW_DAYS, CII_FORMULA_VERSION, nowMs),
  runHotspots: async () => {
    if (!hotspotTool || !('_execute' in hotspotTool) || !hotspotTool._execute) throw new Error('hotspot model missing');
    return hotspotTool._execute({}, '', { kind: 'free' }, undefined as never);
  },
  now: () => Date.now(),
  timeoutMs: SOURCE_TIMEOUT_MS,
};

type Settled<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * One source read, bounded in time, that never throws. The reason is fixed
 * text: an error message from a read could carry anything.
 */
async function settle<T>(task: () => Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol('timeout');
  try {
    const value = await Promise.race([
      task(),
      new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), timeoutMs); }),
    ]);
    if (value === timedOut) return { ok: false, reason: `the read did not finish within ${timeoutMs / 1000} seconds` };
    return { ok: true, value: value as T };
  } catch (error) {
    if (error instanceof McpSourceUnavailableError) return { ok: false, reason: 'its input feeds are unavailable' };
    return { ok: false, reason: 'the read failed' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runPool<T>(tasks: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, tasks.length) }, worker));
  return results;
}

function unavailable(reason: string): SourceSnapshot {
  return { status: 'unavailable', value: null, reason, updatedAt: null, stale: true };
}

function feedSnapshots(
  read: Settled<Array<{ status: 'hit' | 'miss' | 'error'; value: unknown }>>,
  nowMs: number,
): Record<FeedId, SourceSnapshot> {
  const feeds = {} as Record<FeedId, SourceSnapshot>;
  const count = TRAVEL_RISK_FEEDS.length;
  const rows = read.ok && Array.isArray(read.value) && read.value.length === count * 2 ? read.value : null;
  TRAVEL_RISK_FEEDS.forEach((feed, index) => {
    if (!rows) {
      feeds[feed.id] = unavailable(read.ok ? 'the cache returned an unexpected reply' : `the cache ${read.reason.replace(/^the /, '')}`);
      return;
    }
    const payload = rows[index]!;
    const meta = rows[count + index]!;
    const freshness = evaluateFreshness(
      [{ key: feed.metaKey, maxStaleMin: feed.maxStaleMin, ...(feed.honorContentAge ? { honorContentAge: true } : {}) }],
      [meta.status === 'hit' ? meta.value : null],
      nowMs,
    );
    if (payload.status !== 'hit' || payload.value === null || payload.value === undefined) {
      feeds[feed.id] = {
        ...unavailable(payload.status === 'error' ? 'the cache read failed' : 'the source snapshot is not in the cache'),
        updatedAt: freshness.cached_at,
      };
      return;
    }
    const failed = meta.status === 'hit' ? (meta.value as { failedSources?: unknown } | null)?.failedSources : undefined;
    const failedProviders = Array.isArray(failed) ? failed.filter((entry): entry is string => typeof entry === 'string') : [];
    feeds[feed.id] = {
      status: 'ok', value: payload.value, reason: null, updatedAt: freshness.cached_at, stale: freshness.stale,
      ...(failedProviders.length > 0 ? { failedProviders } : {}),
    };
  });
  return feeds;
}

function hotspotSnapshot(read: Settled<unknown>): SourceSnapshot {
  if (!read.ok) return unavailable(`the hotspot model could not run: ${read.reason}`);
  const envelope = read.value as { cached_at?: unknown; stale?: unknown } | null;
  return {
    status: 'ok',
    value: read.value,
    reason: null,
    updatedAt: typeof envelope?.cached_at === 'string' ? envelope.cached_at : null,
    stale: envelope?.stale === true,
  };
}

function ciiSnapshot(read: Settled<unknown>): SourceSnapshot {
  if (!read.ok) return unavailable(read.reason);
  const points = (read.value as { history?: { points?: Array<{ date?: unknown }>; stale?: unknown } } | null)?.history;
  const last = Array.isArray(points?.points) ? points.points[points.points.length - 1] : undefined;
  if (!last) return unavailable('the daily history holds no readings for the window, or could not be read');
  return {
    status: 'ok',
    value: read.value,
    reason: null,
    updatedAt: typeof last?.date === 'string' ? `${last.date}T00:00:00.000Z` : null,
    stale: points?.stale === true,
  };
}

/**
 * Reads every source the draft cites, at most `SOURCE_CONCURRENCY` at a time,
 * each bounded by its own timeout. No read is keyed by, or carries, any part
 * of the trip beyond the country codes.
 */
export async function gatherTravelRiskSources(input: TripInput, nowMs: number, deps: TravelRiskDeps): Promise<TravelRiskSources> {
  const scored = input.countries.map((country) => country.countryCode).filter((code) => CII_SCORED_CODES.has(code));
  const keys = [...TRAVEL_RISK_FEEDS.map((feed) => feed.key), ...TRAVEL_RISK_FEEDS.map((feed) => feed.metaKey)];
  const tasks: Array<() => Promise<Settled<unknown>>> = [
    () => settle(() => deps.readBatch(keys), deps.timeoutMs),
    () => settle(() => deps.runHotspots(), deps.timeoutMs),
    ...scored.map((code) => () => settle(() => deps.readCiiHistory(code, nowMs), deps.timeoutMs)),
  ];
  const [feedRead, hotspotRead, ...ciiReads] = await runPool(tasks, SOURCE_CONCURRENCY);
  const cii: Record<string, SourceSnapshot> = {};
  scored.forEach((code, index) => { cii[code] = ciiSnapshot(ciiReads[index]!); });
  return {
    feeds: feedSnapshots(feedRead as Settled<Array<{ status: 'hit' | 'miss' | 'error'; value: unknown }>>, nowMs),
    hotspots: hotspotSnapshot(hotspotRead!),
    cii,
  };
}

function requireAnySource(sources: TravelRiskSources): void {
  const feeds = Object.values(sources.feeds);
  const anyAvailable = feeds.some((feed) => feed.status === 'ok')
    || sources.hotspots.status === 'ok'
    || Object.values(sources.cii).some((entry) => entry.status === 'ok');
  if (anyAvailable) return;
  const unavailableInputs = TRAVEL_RISK_FEEDS.map((feed) => feed.key);
  const failedInputs = TRAVEL_RISK_FEEDS.filter((feed) => sources.feeds[feed.id].reason === 'the cache read failed').map((feed) => feed.key);
  throw new McpSourceUnavailableError('No travel risk input feeds are available', unavailableInputs, failedInputs);
}

/** The largest per-block listing that fits the output budget; the counts stay whole. */
function fitResult(input: TripInput, sources: TravelRiskSources, nowMs: number): TravelRiskResult {
  let result = buildTravelRiskResult(input, sources, nowMs);
  for (const cap of [3, 1, 0]) {
    if (utf8ByteLength(JSON.stringify(result)) <= OUTPUT_BUDGET_BYTES) break;
    result = buildTravelRiskResult(input, sources, nowMs, cap);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DATE_SCHEMA = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

const FINDING_SCHEMA = {
  type: 'object',
  required: ['text', 'source', 'observed', 'url'],
  properties: {
    text: { type: 'string', description: 'What the source reports. Quoted titles are feed text as published.' },
    source: { type: 'string' },
    observed: { type: ['string', 'null'], description: 'Date the source gives for this item (YYYY-MM-DD); null when it gives none.' },
    url: { type: ['string', 'null'] },
  },
};

const BLOCK_SCHEMA = {
  type: 'object',
  required: ['topic', 'status', 'statement', 'count', 'findings', 'omitted'],
  properties: {
    topic: { type: 'string' },
    status: {
      type: 'string',
      enum: ['reported', 'none', 'unavailable', 'not_covered'],
      description: 'none: the source was read and holds nothing in the stated window. unavailable: the source could not be read, so nothing is known. not_covered: no source covers this topic for the country.',
    },
    statement: { type: 'string', description: 'One sentence naming the source and its update time, or the reason data is missing.' },
    count: { type: ['integer', 'null'] },
    findings: { type: 'array', items: FINDING_SCHEMA },
    omitted: { type: 'integer', description: 'Findings beyond the listed ones.' },
  },
};

const COUNTRY_BLOCKS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['countryCode', 'countryName', 'blocks'],
    properties: { countryCode: { type: 'string' }, countryName: { type: 'string' }, blocks: { type: 'array', items: BLOCK_SCHEMA } },
  },
};

const RATING_SCHEMA = {
  type: 'object',
  required: ['level', 'statement'],
  properties: {
    level: { type: ['integer', 'null'], minimum: 1, maximum: 4, description: 'Higher of the US State Dept and Australia DFAT Smartraveller levels; null when unrated.' },
    statement: { type: 'string' },
  },
};

const TRIP_COUNTRY_SCHEMA = {
  type: 'object',
  required: ['countryCode', 'countryName', 'cities', 'arrive', 'depart'],
  properties: {
    countryCode: { type: 'string' },
    countryName: { type: 'string' },
    cities: { type: 'array', items: { type: 'string' } },
    arrive: { type: ['string', 'null'] },
    depart: { type: ['string', 'null'] },
  },
};

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['markdown', 'document'],
  properties: {
    markdown: { type: 'string', description: 'The draft in Markdown: summary, government advice, security, natural hazards, health, getting in and out, communications, an empty analyst section per uncovered topic, and sources with capture time.' },
    document: {
      type: 'object',
      required: ['title', 'taskLabel', 'retrievedAt', 'trip', 'summary', 'advice', 'security', 'hazards', 'health', 'access', 'communications', 'notCovered', 'sources', 'method'],
      properties: {
        title: { type: 'string' },
        taskLabel: { type: ['string', 'null'] },
        retrievedAt: { type: 'string', description: 'When World Monitor read the sources, ISO 8601.' },
        trip: {
          type: 'object',
          required: ['dateFrom', 'dateTo', 'countries'],
          properties: { dateFrom: { type: ['string', 'null'] }, dateTo: { type: ['string', 'null'] }, countries: { type: 'array', items: TRIP_COUNTRY_SCHEMA } },
        },
        summary: {
          type: 'object',
          required: ['overallRating', 'countries'],
          properties: {
            overallRating: RATING_SCHEMA,
            countries: {
              type: 'array',
              items: {
                type: 'object',
                required: ['countryCode', 'countryName', 'rating', 'paragraph'],
                properties: { countryCode: { type: 'string' }, countryName: { type: 'string' }, rating: RATING_SCHEMA, paragraph: { type: 'string' } },
              },
            },
          },
        },
        advice: COUNTRY_BLOCKS_SCHEMA,
        security: COUNTRY_BLOCKS_SCHEMA,
        hazards: COUNTRY_BLOCKS_SCHEMA,
        health: COUNTRY_BLOCKS_SCHEMA,
        access: COUNTRY_BLOCKS_SCHEMA,
        communications: COUNTRY_BLOCKS_SCHEMA,
        notCovered: {
          type: 'array',
          items: { type: 'object', required: ['heading', 'status'], properties: { heading: { type: 'string' }, status: { type: 'string', enum: ['analyst_to_complete'] } } },
        },
        sources: {
          type: 'array',
          items: {
            type: 'object',
            required: ['source', 'updatedAt', 'status', 'note'],
            properties: {
              source: { type: 'string' },
              updatedAt: { type: ['string', 'null'], description: 'When the producer last fetched the source, ISO 8601.' },
              status: { type: 'string', enum: ['current', 'out_of_date', 'unavailable', 'not_used'] },
              note: { type: ['string', 'null'] },
            },
          },
        },
        method: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

export function createTravelRiskTool(deps: TravelRiskDeps = DEFAULT_TRAVEL_RISK_DEPS): ToolDef {
  return {
    name: TRAVEL_RISK_TOOL,
    title: 'Prepare a travel risk assessment draft',
    description:
      `Draft a travel risk assessment for 1 to ${MAX_TRIP_COUNTRIES} countries in travel order, for an analyst to finish. Country codes, optional cities and dates only; never traveller names or addresses. ` +
      `Markdown plus structured content: a rating (higher of the US and Australian levels), government advice, ${SECURITY_WINDOW_DAYS}-day security events, natural hazards, health, airports, internet outages, empty analyst sections and sources with capture time. ` +
      'Each finding names its source and date; unreadable sources say unavailable. Requires the Pro Business, API Business or Enterprise plan; weight 2 on API plans.',
    _outputBudgetBytes: OUTPUT_BUDGET_BYTES,
    _subscriptionOnly: true,
    _planFeature: 'travelRiskAssessment',
    _apiPaths: [],
    _coverageKeys: TRAVEL_RISK_FEEDS.map((feed) => feed.key),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      required: ['countries'],
      additionalProperties: false,
      properties: {
        countries: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_TRIP_COUNTRIES,
          description: 'Countries in travel order, each listed once.',
          items: {
            type: 'object',
            required: ['country_code'],
            additionalProperties: false,
            properties: {
              country_code: { type: 'string', pattern: '^[A-Za-z]{2}$', description: 'ISO 3166-1 alpha-2 code, such as TH.' },
              cities: {
                type: 'array',
                maxItems: MAX_CITIES_PER_COUNTRY,
                items: { type: 'string', minLength: 1, maxLength: MAX_CITY_CHARS },
                description: 'City names only, no street addresses. Shown in the draft and used to mark matching unrest signals and airports.',
              },
              arrive: { ...DATE_SCHEMA, description: 'First arrival, YYYY-MM-DD.' },
              depart: { ...DATE_SCHEMA, description: 'Last departure, YYYY-MM-DD, on or after arrive.' },
            },
          },
        },
        date_from: { ...DATE_SCHEMA, description: 'Trip start, YYYY-MM-DD. Country dates must fall inside the trip window.' },
        date_to: { ...DATE_SCHEMA, description: 'Trip end, YYYY-MM-DD, on or after date_from.' },
        task_label: { type: 'string', minLength: 1, maxLength: MAX_TASK_LABEL_CHARS, description: 'Optional label printed at the top of the draft, such as a project name. No personal details.' },
      },
    },
    outputSchema: OUTPUT_SCHEMA,
    _validateArgs: (params) => { parseTravelRiskArgs(params); },
    async _execute(params) {
      const input = parseTravelRiskArgs(params);
      const nowMs = deps.now();
      const sources = await gatherTravelRiskSources(input, nowMs, deps);
      requireAnySource(sources);
      return fitResult(input, sources, nowMs);
    },
  };
}

export const TRAVEL_RISK_TOOLS: ToolDef[] = [createTravelRiskTool()];
