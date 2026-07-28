import COUNTRY_BBOXES from '../../../shared/country-bboxes.js';
import { CII_RISK_SCORE_CACHE_KEYS } from '../../_cii-risk-cache-keys.js';
import {
  CHINA_DECISION_SIGNAL_GROUP_IDS,
  CHINA_DECISION_SIGNAL_MAX_SERIALIZED_BYTES,
  isChinaDecisionSignalSnapshot,
} from '../../../shared/china-decision-signals';
// @ts-expect-error — generated JS module, no declaration file
import MINING_SITES_RAW from '../../../shared/mining-sites.js';
import { buildAlertDigest, buildWeeklyTrends } from '../../../shared/analysis-alert-digest';
import {
  anomaliesToDigestInput,
  buildDigestInputs,
  earthquakesToExposureEvents,
  type ExposureEvent,
  firesToExposureEvents,
  ucdpEventsToExposureEvents,
} from '../../../shared/analysis-composite-adapters';
import { buildEntityIndex } from '../../../shared/analysis-entity-index';
import { FocalPointCore } from '../../../shared/analysis-focal-points';
import {
  computeEscalationScore,
  countMilitaryNearHotspot,
} from '../../../shared/analysis-hotspot-escalation';
import { GeoConvergenceEngine, getLocationName } from '../../../shared/analysis-geo-convergence';
import {
  buildDependencyGraph,
  calculateCascade,
  getGraphStats,
} from '../../../shared/analysis-infrastructure-cascade';
import {
  applyVesselCountsToPostures,
  crossSourceSignalsToSignalSummary,
  earthquakesToGeoEvents,
  filterFocalPointsByCountry,
  insightsToFocalClusters,
  MCP_CASCADE_WATERWAYS,
  MCP_GEO_PLACES,
  militaryFlightsToGeoEvents,
  militaryFlightsToSurgeInputs,
  riskScoresToCiiLookup,
  submarineCablesToCableInputs,
  surgeHistoryToActivityHistory,
  theaterPostureVesselCounts,
  unrestEventsToGeoEvents,
  usniVesselsToGeoEvents,
} from '../../../shared/analysis-mcp-adapters';
import {
  getTheaterPostureSummaries,
  MilitarySurgeEngine,
  recalcPostureWithVessels,
} from '../../../shared/analysis-military-surge';
import {
  computeExposure,
  getRadiusForEventType,
  listCountryPopulations,
} from '../../../shared/analysis-population-exposure';
import { ENTITY_REGISTRY } from '../../../shared/entities-data';
import { INTEL_HOTSPOTS } from '../../../shared/geo-data';
// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash } from '../../_upstash-json.js';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk, BillingDenialError, throwIfBillingDenial } from '../billing-denial';
import { SUPPORTED_CONSUMER_PRICES_COUNTRIES } from '../constants';
import { assertMcpToolFetchOk } from '../downstream';
import { evaluateFreshness } from '../freshness';
import type { FreshnessCheck, ToolDef } from '../types';
import { COUNTRY_BRIEF_UI_URI, COUNTRY_RISK_UI_URI, WORLD_BRIEF_UI_URI } from '../ui/registry';
import { buildPublicTool, TOOL_REGISTRY } from './index';

// Entity index for the analysis tools (#5696): deterministic, built from the
// shared registry, memoized per isolate so repeated tools/call requests skip
// the regex construction pass.
let sharedEntityIndex: ReturnType<typeof buildEntityIndex> | null = null;
function getSharedEntityIndex(): ReturnType<typeof buildEntityIndex> {
  sharedEntityIndex ??= buildEntityIndex(ENTITY_REGISTRY);
  return sharedEntityIndex;
}

/**
 * Read data caches and their freshness metadata in one round of parallel
 * requests, returning the two sets already separated.
 *
 * The hand-rolled form each analysis tool used was
 * `const [a, b, ...metas] = await Promise.all([...keys.map(read), ...checks.map(read)])`,
 * whose correctness depends on the count of named payload variables exactly
 * matching `keys.length`. Add a key without adding a variable and the first
 * meta silently becomes a payload, `metas` shifts, and evaluateFreshness
 * reports another dataset's staleness — with no error and no failing test.
 * Slicing here makes that misalignment unrepresentable.
 */
async function readCachesWithFreshness(
  keys: readonly string[],
  checks: FreshnessCheck[],
): Promise<{ payloads: unknown[]; freshness: { cached_at: string | null; stale: boolean } }> {
  const results = await Promise.all([
    ...keys.map((key) => readJsonFromUpstash(key)),
    ...checks.map((check) => readJsonFromUpstash(check.key)),
  ]);
  return {
    payloads: results.slice(0, keys.length),
    freshness: evaluateFreshness(checks, results.slice(keys.length)),
  };
}

// `limit: 0` means "no cap" across the MCP tool surface (the cache tools
// document it that way and capNested implements it), so the analysis tools
// honour the same convention instead of silently coercing 0 to the default.
function resolveLimit(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return Number.POSITIVE_INFINITY;
  return parsed;
}

type McpBriefSource = {
  title: string;
  source: string;
  url: string;
  publishedAt?: string;
};

type DigestItemForBrief = {
  title?: string;
  snippet?: string;
  source?: string;
  link?: string;
  url?: string;
  publishedAt?: string | number;
  pubDate?: string | number;
  date?: string | number;
};

function clipBriefText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trim()}...` : text;
}

function normalizeBriefUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function normalizeBriefDate(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countryTermIndex(text: string, term: string): number {
  const normalizedTerm = term.trim().toLowerCase();
  if (!normalizedTerm) return -1;
  const match = new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedTerm)}(?=$|[^a-z0-9])`, 'i').exec(text);
  return match ? match.index + (match[1] ?? '').length : -1;
}

function includesCountryTerm(text: string, term: string): boolean {
  return countryTermIndex(text, term) !== -1;
}

function collectMcpBriefSources(items: DigestItemForBrief[], maxSources = 6): McpBriefSource[] {
  const out: McpBriefSource[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const url = normalizeBriefUrl(item.link ?? item.url);
    const title = clipBriefText(item.title, 160);
    const source = clipBriefText(item.source, 80);
    if (!url || !title || !source || seen.has(url)) continue;
    const publishedAt = normalizeBriefDate(item.publishedAt ?? item.pubDate ?? item.date);
    out.push(publishedAt ? { title, source, url, publishedAt } : { title, source, url });
    seen.add(url);
    if (out.length >= maxSources) break;
  }
  return out;
}

function briefSourceContextLines(sources: McpBriefSource[]): string[] {
  return sources.map((source, index) => {
    const payload = source.publishedAt
      ? { title: source.title, source: source.source, url: source.url, publishedAt: source.publishedAt }
      : { title: source.title, source: source.source, url: source.url };
    return `Source [${index + 1}]: ${JSON.stringify(payload)}`;
  });
}

function countryBriefSearchTerms(countryCode: string): string[] {
  const terms = [countryCode.toLowerCase()];
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode);
    if (name) terms.push(name.toLowerCase());
  } catch {
    /* Intl.DisplayNames can be missing in constrained runtimes. */
  }
  return [...new Set(terms.filter(Boolean))];
}

const PROCUREMENT_TOOL_DEFAULT_PAGE_SIZE = 10;
const PROCUREMENT_TOOL_MAX_PAGE_SIZE = 25;

type ProcurementRouteTender = {
  id: string;
  source: string;
  officialUrl: string;
  countryCode?: string;
  region?: string;
  title: string;
  buyer?: string;
  publishedAt?: string;
  deadline?: string;
  status: string;
  noticeType?: string;
  money?: { amount?: number; currency?: string };
  categoryCodes: string[];
  sectors: string[];
  participationMode: string;
  automationFit?: { level: string; score: number; classificationVersion: string; matchReasons: string[] };
};

type ProcurementRouteResponse = {
  tenders?: ProcurementRouteTender[];
  nextCursor?: string;
  fetchedAt?: string;
  dataAvailable?: boolean;
  availability?: string;
  sourceStatuses?: unknown[];
  total?: number;
  appliedFilters?: string[];
  countryCoverage?: string;
};

function addProcurementStringParam(query: URLSearchParams, name: string, value: unknown): void {
  if (typeof value === 'string' && value.trim()) query.set(name, value.trim());
}

function procurementPageSize(value: unknown): number {
  return Number.isInteger(value) && (value as number) > 0
    ? Math.min(PROCUREMENT_TOOL_MAX_PAGE_SIZE, value as number)
    : PROCUREMENT_TOOL_DEFAULT_PAGE_SIZE;
}

/**
 * The MCP tool preserves the canonical relevance-filter semantics:
 * malformed/non-positive values disable the filter; values above 100 are
 * deliberately passed through so the route remains the sole authority that
 * clamps its documented upper bound.
 */
function procurementAutomationThreshold(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : null;
}

function compactProcurementOpportunity(tender: ProcurementRouteTender) {
  return {
    id: tender.id,
    source: tender.source,
    officialUrl: tender.officialUrl,
    countryCode: tender.countryCode,
    region: tender.region,
    title: tender.title,
    buyer: tender.buyer,
    publishedAt: tender.publishedAt,
    deadline: tender.deadline,
    status: tender.status,
    noticeType: tender.noticeType,
    money: tender.money,
    categoryCodes: tender.categoryCodes,
    sectors: tender.sectors,
    // This remains upstream evidence, not a claim about a caller's legal
    // ability to participate in a procurement process.
    participationMode: tender.participationMode,
    automationFit: tender.automationFit && {
      score: tender.automationFit.score,
      level: tender.automationFit.level,
      classificationVersion: tender.automationFit.classificationVersion,
      matchReasons: tender.automationFit.matchReasons,
    },
  };
}

export const RPC_TOOLS: ToolDef[] = [
  {
    name: 'get_china_decision_signals',
    _outputBudgetBytes: CHINA_DECISION_SIGNAL_MAX_SERIALIZED_BYTES,
    description: 'Return the bounded six-domain China decision-signal snapshot used by the public country summary. Every item retains canonical provenance, revision, supersession, translation, confidence, corroboration, and freshness claims; unavailable domains remain explicit rather than becoming zero or normal. Detailed bilateral trade rows and operator-only source health are intentionally excluded.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    outputSchema: {
      type: 'object',
      required: ['schemaVersion', 'generatedAt', 'groups', 'access'],
      properties: {
        schemaVersion: { type: 'integer', enum: [1] },
        generatedAt: { type: 'string' },
        groups: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'state', 'reason', 'items', 'metadata'],
            properties: {
              id: {
                type: 'string',
                enum: [...CHINA_DECISION_SIGNAL_GROUP_IDS],
              },
              state: { type: 'string', enum: ['available', 'partial', 'stale', 'unavailable'] },
              reason: { type: ['string', 'null'] },
              items: {
                type: 'array',
                maxItems: 4,
                items: {
                  type: 'object',
                  required: ['id', 'lineageId', 'label', 'summary', 'sourceName', 'sourceUrl', 'publisherType', 'observedAt', 'publishedAt', 'effectiveAt', 'retrievedAt', 'stale', 'metadata', 'provenance'],
                  properties: {
                    id: { type: 'string' },
                    lineageId: { type: 'string' },
                    label: { type: 'string' },
                    summary: { type: 'string' },
                    sourceName: { type: 'string' },
                    sourceUrl: { type: ['string', 'null'] },
                    publisherType: {
                      type: 'string',
                      enum: ['official_government', 'state_controlled_media', 'official_exchange', 'independent_observation', 'independent_media', 'wire_service', 'market_publisher', 'derived_output', 'unknown'],
                    },
                    observedAt: { type: ['string', 'null'] },
                    publishedAt: { type: ['string', 'null'] },
                    effectiveAt: { type: ['string', 'null'] },
                    retrievedAt: { type: ['string', 'null'] },
                    stale: { type: 'boolean' },
                    metadata: { type: 'object' },
                    provenance: { type: 'object' },
                  },
                },
              },
              metadata: { type: 'object' },
            },
          },
        },
        access: {
          type: 'object',
          required: ['anonymous', 'pro', 'operator'],
          properties: {
            anonymous: { type: 'string', enum: ['bounded_public_summary'] },
            pro: { type: 'string', enum: ['same_provenance_via_mcp'] },
            operator: { type: 'string', enum: ['source_health_only'] },
          },
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (_params, base, context, execution) => {
      const url = `${base}/api/intelligence/v1/get-china-decision-signals`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const response = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(12_000),
      });
      await assertMcpToolFetchOk(response, {
        operation: 'get-china-decision-signals',
        tool: 'get_china_decision_signals',
        auth: context,
        execution,
      });
      const wire = await response.json() as { payloadJson?: unknown };
      if (typeof wire.payloadJson !== 'string') {
        throw new Error('get-china-decision-signals returned no canonical payload');
      }
      const payload = JSON.parse(wire.payloadJson) as unknown;
      if (!isChinaDecisionSignalSnapshot(payload)) {
        throw new Error('get-china-decision-signals returned an invalid canonical payload');
      }
      return payload;
    },
    _coverageKeys: [
      'china:policy-events:v1',
      'military:cross-strait-activity:v1',
      'military:cross-strait-activity-bootstrap:v1',
      'market:china:corporate-disclosures:v1',
      'intelligence:china-decision-signals:v1',
    ],
    _apiPaths: [
      'GET /api/intelligence/v1/get-china-decision-signals',
    ],
  },
  {
    name: 'get_procurement_opportunities',
    _outputBudgetBytes: 65536,
    description: 'Search open global public-procurement opportunities through the canonical Pro route. Default output is 10 compact records (maximum 25), without descriptions or submission/eligibility payloads. automationFit is keyword relevance evidence only, never bidding eligibility; participationMode "unknown" remains unknown.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'One ISO 3166-1 alpha-2 country code.' },
        countries: { type: 'array', items: { type: 'string' }, description: 'Additional ISO 3166-1 alpha-2 country codes. Combined with country.' },
        source: { type: 'string', description: 'Official source adapter, such as sam, ted, contracts-finder, canada-buys, gets, or world-bank.' },
        query: { type: 'string', description: 'Case-insensitive text search across procurement titles and descriptions.' },
        buyer: { type: 'string', description: 'Case-insensitive buyer or contracting-authority text.' },
        deadline_from: { type: 'string', description: 'Include deadlines on or after this ISO-8601 timestamp.' },
        deadline_to: { type: 'string', description: 'Include deadlines on or before this ISO-8601 timestamp.' },
        sort: { type: 'string', enum: ['newest', 'closing_soon', 'estimated_value', 'relevance'], description: 'Result ordering. Defaults to newest.' },
        min_automation_score: { type: 'integer', minimum: 1, description: 'Optional positive keyword-relevance threshold. Non-integer or non-positive values are ignored; the canonical route clamps values above 100. This is not bidding-eligibility evidence.' },
        page_size: { type: 'integer', minimum: 1, maximum: PROCUREMENT_TOOL_MAX_PAGE_SIZE, description: 'Records per call. Defaults to 10; capped at 25 to protect agent context.' },
        cursor: { type: 'string', description: 'Opaque nextCursor from the prior result; keep the same filters and sort when continuing.' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      required: ['opportunities', 'nextCursor', 'fetchedAt', 'dataAvailable', 'availability', 'sourceStatuses', 'total', 'appliedFilters', 'countryCoverage'],
      properties: {
        opportunities: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, source: { type: 'string' }, officialUrl: { type: 'string' }, countryCode: { type: 'string' }, region: { type: 'string' },
          title: { type: 'string' }, buyer: { type: 'string' }, publishedAt: { type: 'string' }, deadline: { type: 'string' }, status: { type: 'string' }, noticeType: { type: 'string' },
          money: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string' } } },
          categoryCodes: { type: 'array', items: { type: 'string' } }, sectors: { type: 'array', items: { type: 'string' } }, participationMode: { type: 'string' },
          automationFit: { type: 'object', properties: { score: { type: 'number' }, level: { type: 'string' }, classificationVersion: { type: 'string' }, matchReasons: { type: 'array', items: { type: 'string' } } } },
        } } },
        nextCursor: { type: 'string', description: 'Opaque pagination cursor. An empty string means no further pages are available.' }, fetchedAt: { type: 'string' }, dataAvailable: { type: 'boolean' }, availability: { type: 'string' },
        sourceStatuses: { type: 'array', items: { type: 'object' } }, total: { type: 'number' }, appliedFilters: { type: 'array', items: { type: 'string' } },
        countryCoverage: { type: 'string', description: 'unknown means the requested country has not been observed in this snapshot, not that there are confirmed zero results.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params, base, context) => {
      const query = new URLSearchParams();
      addProcurementStringParam(query, 'country', params.country);
      if (Array.isArray(params.countries)) {
        for (const country of params.countries) {
          if (typeof country === 'string' && country.trim()) query.append('countries', country.trim());
        }
      }
      for (const [name, value] of Object.entries({
        source: params.source,
        query: params.query,
        buyer: params.buyer,
        deadline_from: params.deadline_from,
        deadline_to: params.deadline_to,
        sort: params.sort,
        cursor: params.cursor,
      })) addProcurementStringParam(query, name, value);
      query.set('page_size', String(procurementPageSize(params.page_size)));
      const threshold = procurementAutomationThreshold(params.min_automation_score);
      if (threshold !== null) query.set('min_automation_score', String(threshold));

      const url = `${base}/api/economic/v1/list-global-tenders?${query}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const response = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(8_000),
      });
      assertToolFetchOk(response, 'list-global-tenders');
      const result = await response.json() as ProcurementRouteResponse;
      return {
        opportunities: (result.tenders || []).map(compactProcurementOpportunity),
        nextCursor: result.nextCursor || '',
        fetchedAt: result.fetchedAt || '',
        dataAvailable: result.dataAvailable === true,
        availability: result.availability || 'unavailable',
        sourceStatuses: result.sourceStatuses || [],
        total: typeof result.total === 'number' ? result.total : 0,
        appliedFilters: result.appliedFilters || [],
        countryCoverage: result.countryCoverage || 'unknown',
      };
    },
    _apiPaths: [
      'GET /api/economic/v1/list-global-tenders',
    ],
  },
  {
    name: 'get_world_brief',
    _outputBudgetBytes: 65536,
    description: 'AI-generated world intelligence brief. Fetches the latest geopolitical headlines along with their RSS article bodies and produces a grounded LLM-summarized brief. Supply an optional geo_context to focus on a region or topic.',
    inputSchema: {
      type: 'object',
      properties: {
        geo_context: { type: 'string', description: 'Optional focus context (e.g. "Middle East tensions", "US-China trade war")' },
      },
      required: [],
    },
    // RPC tool: returns the raw body of /api/news/v1/summarize-article (LLM brief).
    outputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'LLM-summarized geopolitical brief.' },
        summary: { type: 'string', description: 'Alternate naming used by some upstream variants.' },
        headlines: { type: 'array', items: { type: 'string' } },
        provider: { type: 'string' },
        model: { type: 'string' },
        generatedAt: { type: ['string', 'number', 'null'] },
        sources: {
          type: 'array',
          description: 'Original feed articles used as grounding inputs for this brief.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              url: { type: 'string' },
              source: { type: 'string' },
              publishedAt: { type: 'string' },
            },
          },
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    // MCP Apps (`io.modelcontextprotocol/ui`): links the tool to its interactive
    // ui:// app shell (rendered inline by an MCP-Apps host). Single source of
    // truth — the ui:// resource is registered in ../ui/registry.ts.
    _uiResourceUri: WORLD_BRIEF_UI_URI,
    _execute: async (params, base, context, execution) => {
      const UA = 'worldmonitor-mcp-edge/1.0';
      // Step 1: fetch current geopolitical headlines (budget: 6 s, leaves ~24 s for LLM).
      // `full` is the documented geopolitical/default digest variant.
      const digestUrl = `${base}/api/news/v1/list-feed-digest?variant=full&lang=en`;
      const digestAuth = await buildAuthHeaders(context, 'GET', digestUrl, null);
      const digestRes = await fetch(digestUrl, {
        headers: { ...digestAuth, 'User-Agent': UA },
        signal: AbortSignal.timeout(6_000),
      });
      await assertMcpToolFetchOk(digestRes, {
        operation: 'list-feed-digest',
        tool: 'get_world_brief',
        auth: context,
        execution,
      });
      type DigestPayload = { categories?: Record<string, { items?: DigestItemForBrief[] }> };
      const digest = await digestRes.json() as DigestPayload;
      // Pair headlines with their RSS snippets so the LLM grounds per-story
      // on article bodies instead of hallucinating across unrelated titles.
      const pairs = Object.values(digest.categories ?? {})
        .flatMap(cat => cat.items ?? [])
        .map(item => ({
          title: item.title ?? '',
          snippet: item.snippet ?? '',
          source: item.source ?? '',
          link: item.link ?? item.url ?? '',
          publishedAt: item.publishedAt ?? item.pubDate ?? item.date,
        }))
        .filter(p => p.title.length > 0)
        .slice(0, 10);
      const headlines = pairs.map(p => p.title);
      const bodies = pairs.map(p => p.snippet);
      const sources = collectMcpBriefSources(pairs, 6);
      // Step 2: summarize with LLM (budget: 18 s — combined 24 s, well under 30 s edge ceiling)
      const briefUrl = `${base}/api/news/v1/summarize-article`;
      const briefBody = JSON.stringify({
        provider: 'openrouter',
        headlines,
        bodies,
        mode: 'brief',
        geoContext: String(params.geo_context ?? ''),
        variant: 'full',
        lang: 'en',
      });
      const briefAuth = await buildAuthHeaders(context, 'POST', briefUrl, briefBody);
      const briefRes = await fetch(briefUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...briefAuth, 'User-Agent': UA },
        body: briefBody,
        signal: AbortSignal.timeout(18_000),
      });
      await assertMcpToolFetchOk(briefRes, {
        operation: 'summarize-article',
        tool: 'get_world_brief',
        auth: context,
        execution,
      });
      const result = await briefRes.json() as Record<string, unknown>;
      return { ...result, headlines, sources };
    },
    _apiPaths: [
      "GET /api/news/v1/list-feed-digest",
      "POST /api/news/v1/summarize-article",
    ],
  },
  {
    name: 'get_country_brief',
    _outputBudgetBytes: 65536,
    description: 'AI-generated per-country intelligence brief. Produces an LLM-analyzed geopolitical and economic assessment for the given country. Supports analytical frameworks for structured lenses.',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'ISO 3166-1 alpha-2 country code, e.g. "US", "DE", "CN", "IR"' },
        framework: { type: 'string', description: 'Optional analytical framework instructions to shape the analysis lens (e.g. Ray Dalio debt cycle, PMESII-PT)' },
      },
      required: ['country_code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string' },
        brief: { type: 'string', description: 'LLM-synthesized country intelligence brief.' },
        framework: { type: 'string' },
        generatedAt: { type: ['string', 'number', 'null'] },
        provider: { type: 'string' },
        model: { type: 'string' },
        sources: {
          type: 'array',
          description: 'Original feed articles used as grounding inputs for this brief.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              url: { type: 'string' },
              source: { type: 'string' },
              publishedAt: { type: 'string' },
            },
          },
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    // MCP Apps (`io.modelcontextprotocol/ui`): links the tool to its interactive
    // ui:// app shell. Single source of truth — registered in ../ui/registry.ts.
    _uiResourceUri: COUNTRY_BRIEF_UI_URI,
    _execute: async (params, base, context) => {
      const UA = 'worldmonitor-mcp-edge/1.0';
      const countryCode = String(params.country_code ?? '').toUpperCase().slice(0, 2);

      // Fetch current geopolitical headlines to ground the LLM (budget: 2 s — cached endpoint).
      // Without context the model hallucinates events — real headlines anchor it.
      // 2 s + 22 s brief = 24 s worst-case; 6 s margin before the 30 s Edge kill.
      let contextSnapshot = '';
      let sources: McpBriefSource[] = [];
      try {
        const digestUrl = `${base}/api/news/v1/list-feed-digest?variant=full&lang=en`;
        const digestAuth = await buildAuthHeaders(context, 'GET', digestUrl, null);
        const digestRes = await fetch(digestUrl, {
          headers: { ...digestAuth, 'User-Agent': UA },
          signal: AbortSignal.timeout(2_000),
        });
        if (digestRes.ok) {
          type DigestPayload = { categories?: Record<string, { items?: DigestItemForBrief[] }> };
          const digest = await digestRes.json() as DigestPayload;
          const allItems = Object.values(digest.categories ?? {})
            .flatMap(cat => cat.items ?? [])
            .filter(item => typeof item.title === 'string' && item.title.length > 0);
          const terms = countryBriefSearchTerms(countryCode);
          const countryItems = allItems.filter((item) => {
            const text = `${item.title ?? ''} ${item.snippet ?? ''}`.toLowerCase();
            return terms.some(term => includesCountryTerm(text, term));
          });
          const groundingItems = (countryItems.length > 0 ? countryItems : allItems).slice(0, 15);
          sources = collectMcpBriefSources(groundingItems, 6);
          const sourceLines = sources.length > 0 ? ['Brief source articles:', ...briefSourceContextLines(sources)] : [];
          const headlineLines = groundingItems.map(item => item.title ?? '').filter(Boolean);
          const contextLines = [...sourceLines, 'Headlines:', ...headlineLines].join('\n');
          if (contextLines.trim()) contextSnapshot = contextLines.slice(0, 4000);
        }
      } catch { /* proceed without context — better than failing */ }

      const briefUrl = `${base}/api/intelligence/v1/get-country-intel-brief`;
      // Keep grounding context out of the signed URL; the gateway's POST-to-GET
      // compatibility path promotes scalar JSON body fields for this GET handler.
      const briefPayload: { country_code: string; framework: string; context?: string } = {
        country_code: countryCode,
        framework: String(params.framework ?? ''),
      };
      if (contextSnapshot) briefPayload.context = contextSnapshot;
      const briefBody = JSON.stringify(briefPayload);
      const briefAuth = await buildAuthHeaders(context, 'POST', briefUrl, briefBody);
      const res = await fetch(briefUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...briefAuth, 'User-Agent': UA },
        body: briefBody,
        signal: AbortSignal.timeout(22_000),
      });
      if (!res.ok) {
        throwIfBillingDenial(res, 'get-country-intel-brief');
        // Surface the gateway's error code in the thrown message so Sentry
        // groups the failure by root cause, not just status. Body reads are
        // best-effort; a read failure must not mask the HTTP status.
        const detail = await res.text().catch(() => '');
        let code = '';
        // `error` is usually a string (for example,
        // `invalid_internal_mcp_signature`), but stringify non-string shapes so
        // object envelopes remain readable. Bound both paths so Sentry titles
        // cannot bloat on a long body.
        try {
          const error = (JSON.parse(detail) as { error?: unknown }).error ?? '';
          code = (typeof error === 'string' ? error : JSON.stringify(error)).slice(0, 120);
        } catch {
          code = detail.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        }
        throw new Error(`get-country-intel-brief HTTP ${res.status}${code ? `: ${code}` : ''}`);
      }
      const result = await res.json() as Record<string, unknown>;
      const resultSources = collectMcpBriefSources(Array.isArray(result.sources) ? result.sources as DigestItemForBrief[] : [], 6);
      return { ...result, sources: resultSources.length > 0 ? resultSources : sources };
    },
    // METHOD DRIFT: _execute POSTs above but OpenAPI declares only GET on this
    // path (verified against docs/api/IntelligenceService.openapi.json). The
    // gateway routes by path, not method, so POST works at runtime. We declare
    // GET here because OpenAPI is the parity test's source-of-truth — fixing
    // the spec to add POST (or migrating the handler to GET) is out of scope.
    _apiPaths: [
      "GET /api/intelligence/v1/get-country-intel-brief",
    ],
  },
  {
    name: 'get_country_risk',
    _outputBudgetBytes: 262144,
    description: 'Structured risk intelligence for a specific country: Composite Instability Index (CII) score 0-100, component breakdown (unrest/conflict/security/news), travel advisory level, and OFAC sanctions exposure. Fast Redis read — no LLM. Use for quantitative risk screening or to answer "how risky is X right now?"',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'ISO 3166-1 alpha-2 country code, e.g. "RU", "IR", "CN", "UA"' },
      },
      required: ['country_code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string' },
        cii: { type: ['number', 'null'], description: 'Composite Instability Index 0-100.' },
        components: {
          type: 'object',
          properties: {
            unrest: { type: ['number', 'null'] },
            conflict: { type: ['number', 'null'] },
            security: { type: ['number', 'null'] },
            news: { type: ['number', 'null'] },
          },
        },
        travelAdvisory: { type: ['object', 'string', 'null'] },
        sanctionsExposure: { type: ['object', 'array', 'null'] },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    // MCP Apps (`io.modelcontextprotocol/ui`): buildPublicTool emits
    // _meta.ui.resourceUri from this, linking the tool to its interactive
    // ui:// app shell (rendered inline by an MCP-Apps host). Single source of
    // truth — the ui:// resource is registered in ../ui/registry.ts.
    _uiResourceUri: COUNTRY_RISK_UI_URI,
    _execute: async (params, base, context) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const url = `${base}/api/intelligence/v1/get-country-risk?country_code=${encodeURIComponent(code)}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(8_000),
      });
      assertToolFetchOk(res, 'get-country-risk');
      return res.json();
    },
    _apiPaths: [
      "GET /api/intelligence/v1/get-country-risk",
    ],
  },
  {
    name: 'get_consumer_prices',
    _outputBudgetBytes: 262144,
    description: "Per-country consumer-prices intelligence: 30-day overview, category-level inflation, retailer spread (essentials basket), top movers, and source freshness. Requires country_code (currently only 'ae' is seeded).",
    inputSchema: {
      type: 'object',
      properties: {
        country_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code. Currently supported: AE (case-insensitive).',
        },
      },
      required: ['country_code'],
    },
    // Hybrid _execute — success path returns the envelope below; missing/unknown
    // country_code returns `{error: "..."}` instead (result-level user-input error).
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'] },
        stale: { type: 'boolean' },
        country_code: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            overview: { type: ['object', 'null'] },
            categories: { type: ['object', 'array', 'null'] },
            movers: { type: ['object', 'array', 'null'] },
            retailerSpread: { type: ['object', 'array', 'null'] },
            freshness: { type: ['object', 'null'] },
          },
        },
        error: { type: 'string', description: 'Present only on user-input failure (missing/unknown country_code).' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    // Hybrid _execute (not a pure cache tool) because the cache keys are
    // parameterised by country. Mirrors api/health.js::BOOTSTRAP_KEYS:55-59
    // exactly so the U7 Tier-3 parity test treats every key as covered.
    _coverageKeys: [
      'consumer-prices:overview:ae',
      'consumer-prices:categories:ae:30d',
      'consumer-prices:movers:ae:30d',
      'consumer-prices:retailer-spread:ae:essentials-ae',
      'consumer-prices:freshness:ae',
    ],
    _execute: async (params) => {
      // Result-level errors (NOT throws) for user-input issues — the dispatcher
      // maps thrown errors to JSON-RPC -32603 "Internal error", which is
      // misleading for a clearly-user-side fault like a missing/unknown
      // country_code. Returning {error: ...} surfaces a usable message via
      // the normal tools/call result envelope.
      if (!params.country_code || typeof params.country_code !== 'string') {
        return { error: 'country_code is required' };
      }
      const code = params.country_code.toLowerCase();
      // Strict ISO 3166-1 alpha-2 shape: exactly two lowercase letters.
      // Without this, .slice(0,2) would silently truncate inputs like
      // "aexxx" or "AE-DXB" to "ae" and serve AE data — masking client bugs.
      if (!/^[a-z]{2}$/.test(code)) {
        return { error: 'country_code must be a two-letter ISO code (e.g. "ae")' };
      }
      if (!SUPPORTED_CONSUMER_PRICES_COUNTRIES.has(code)) {
        return { error: 'Country not yet supported. Available: ae' };
      }

      const dataKeys = [
        `consumer-prices:overview:${code}`,
        `consumer-prices:categories:${code}:30d`,
        `consumer-prices:movers:${code}:30d`,
        `consumer-prices:retailer-spread:${code}:essentials-${code}`,
        `consumer-prices:freshness:${code}`,
      ];

      // Freshness checks use the producer's actual meta keys. Note the spread
      // entry: scripts/seed-consumer-prices.mjs:151 writes
      // `seed-meta:consumer-prices:spread:<code>` (NO `retailer-` prefix,
      // NO `:essentials-<code>` suffix). api/health.js:337 has the documented
      // drift bug (expects `retailer-spread:<code>:essentials-<code>` which
      // never exists) and so would always report stale; we deliberately
      // diverge from health.js here to match the actual producer.
      const freshnessChecks: FreshnessCheck[] = [
        { key: `seed-meta:consumer-prices:overview:${code}`,      maxStaleMin: 1500 }, // 25h = 24h cron + 1h grace
        { key: `seed-meta:consumer-prices:categories:${code}:30d`, maxStaleMin: 1500 },
        { key: `seed-meta:consumer-prices:movers:${code}:30d`,     maxStaleMin: 1500 },
        { key: `seed-meta:consumer-prices:spread:${code}`,         maxStaleMin: 1500 }, // producer's actual key shape
        { key: `seed-meta:consumer-prices:freshness:${code}`,      maxStaleMin: 1500 },
      ];

      const [dataResults, metaResults] = await Promise.all([
        Promise.all(dataKeys.map((k) => readJsonFromUpstash(k))),
        Promise.all(freshnessChecks.map((c) => readJsonFromUpstash(c.key))),
      ]);

      // F6 contract parity with the cache-tool path (executeTool, ~line 1139):
      // if every data read is null/undefined, this is a degenerate-empty
      // response (Redis transient / stampede / pre-seed). Throw so
      // dispatchToolsCall reports a normal tool-execution failure. For Pro
      // callers the already-reserved slot stays charged because the tool has
      // executed.
      if (dataResults.every((v: unknown) => v === null || v === undefined)) {
        throw new Error('cache_all_null');
      }

      const { cached_at, stale } = evaluateFreshness(freshnessChecks, metaResults);

      return {
        cached_at,
        stale,
        country_code: code,
        data: {
          overview: dataResults[0],
          categories: dataResults[1],
          movers: dataResults[2],
          retailerSpread: dataResults[3],
          freshness: dataResults[4],
        },
      };
    },
    // Hybrid tool covers the consumer-prices domain via direct Redis reads
    // of the same keys the per-method handlers expose via the API. The
    // OpenAPI ops listed here read parameterized keys (the audit's
    // manual-mapping case); this MCP tool wraps the 'ae'-instance equivalent.
    //
    // NOTE: `get-consumer-price-basket-series` is NOT covered here — that
    // handler reads `consumer-prices:basket-series:${market}:${basket}:${range}`
    // which is a separate parameterized time-series key, NOT in this tool's
    // `_coverageKeys`. Excluded as `deferred-to-future-tool` in
    // tests/mcp-api-parity.test.mjs until a future expanded_consumer_prices
    // tool exposes the basket-series time series.
    _apiPaths: [
      'GET /api/consumer-prices/v1/get-consumer-price-freshness',
      'GET /api/consumer-prices/v1/get-consumer-price-overview',
      'GET /api/consumer-prices/v1/list-consumer-price-categories',
      'GET /api/consumer-prices/v1/list-consumer-price-movers',
      'GET /api/consumer-prices/v1/list-retailer-price-spreads',
    ],
  },
  {
    name: 'get_airspace',
    _outputBudgetBytes: 262144,
    description: 'Live ADS-B aircraft over a country. Returns civilian flights (OpenSky) and identified military aircraft with callsigns, positions, altitudes, and headings. Answers questions like "how many planes are over the UAE right now?" or "are there military aircraft over Taiwan?"',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code (e.g. "AE", "US", "GB", "JP")',
        },
        type: {
          type: 'string',
          enum: ['all', 'civilian', 'military'],
          description: 'Filter: all flights (default), civilian only, or military only',
        },
      },
      required: ['country_code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string' },
        bounding_box: { type: 'object', properties: {
          sw_lat: { type: 'number' }, sw_lon: { type: 'number' },
          ne_lat: { type: 'number' }, ne_lon: { type: 'number' },
        } },
        civilian_count: { type: 'number' },
        military_count: { type: 'number' },
        civilian_flights: { type: 'array', items: { type: 'object', properties: {
          callsign: { type: 'string' }, icao24: { type: 'string' },
          lat: { type: 'number' }, lon: { type: 'number' },
          altitude_m: { type: ['number', 'null'] }, speed_kts: { type: ['number', 'null'] },
          heading_deg: { type: ['number', 'null'] }, on_ground: { type: 'boolean' },
        } } },
        military_flights: { type: 'array', items: { type: 'object', properties: {
          callsign: { type: 'string' }, hex_code: { type: 'string' },
          aircraft_type: { type: 'string' }, aircraft_model: { type: 'string' },
          operator: { type: 'string' }, operator_country: { type: 'string' },
          lat: { type: ['number', 'null'] }, lon: { type: ['number', 'null'] },
          altitude: { type: ['number', 'null'] }, heading: { type: ['number', 'null'] },
          speed: { type: ['number', 'null'] }, is_interesting: { type: 'boolean' }, note: { type: 'string' },
        } } },
        partial: { type: 'boolean', description: 'True if one of the two upstream sources failed.' },
        warnings: { type: 'array', items: { type: 'string' } },
        source: { type: 'string' },
        updated_at: { type: 'string' },
        error: { type: 'string', description: 'Present only on unknown country_code.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const bbox = COUNTRY_BBOXES[code];
      if (!bbox) return { error: `Unknown country code: ${code}. Use ISO 3166-1 alpha-2 (e.g. "AE", "US", "GB").` };
      const [sw_lat, sw_lon, ne_lat, ne_lon] = bbox;
      const type = String(params.type ?? 'all');
      const UA = 'worldmonitor-mcp-edge/1.0';
      const bboxQ = `sw_lat=${sw_lat}&sw_lon=${sw_lon}&ne_lat=${ne_lat}&ne_lon=${ne_lon}`;

      type CivilianResp = {
        positions?: { callsign: string; icao24: string; lat: number; lon: number; altitude_m: number; ground_speed_kts: number; track_deg: number; on_ground: boolean }[];
        source?: string;
        updated_at?: number;
      };
      type MilResp = {
        flights?: { callsign: string; hex_code: string; aircraft_type: string; aircraft_model: string; operator: string; operator_country: string; location?: { latitude: number; longitude: number }; altitude: number; heading: number; speed: number; is_interesting: boolean; note: string }[];
      };

      const civUrl = `${base}/api/aviation/v1/track-aircraft?${bboxQ}`;
      const milUrl = `${base}/api/military/v1/list-military-flights?${bboxQ}&page_size=100`;
      const civAuth = type === 'military' ? null : await buildAuthHeaders(context, 'GET', civUrl, null);
      const milAuth = type === 'civilian' ? null : await buildAuthHeaders(context, 'GET', milUrl, null);

      const [civResult, milResult] = await Promise.allSettled([
        type === 'military' || !civAuth
          ? Promise.resolve(null)
          : fetch(civUrl, { headers: { ...civAuth, 'User-Agent': UA }, signal: AbortSignal.timeout(8_000) })
              .then(r => {
                throwIfBillingDenial(r, 'get-airspace-civilian');
                return r.ok ? r.json() as Promise<CivilianResp> : Promise.reject(new Error(`HTTP ${r.status}`));
              }),
        type === 'civilian' || !milAuth
          ? Promise.resolve(null)
          : fetch(milUrl, { headers: { ...milAuth, 'User-Agent': UA }, signal: AbortSignal.timeout(8_000) })
              .then(r => {
                throwIfBillingDenial(r, 'get-airspace-military');
                return r.ok ? r.json() as Promise<MilResp> : Promise.reject(new Error(`HTTP ${r.status}`));
              }),
      ]);

      // A billing denial is user-level, not a data-source outage: never serve
      // partial data or a generic both-failed error over it — rethrow so
      // dispatch re-emits the full billing contract (status, Retry-After,
      // X-Billing-Verification, data.code).
      for (const result of [civResult, milResult]) {
        if (result.status === 'rejected' && result.reason instanceof BillingDenialError) {
          throw result.reason;
        }
      }

      const civOk = type === 'military' || civResult.status === 'fulfilled';
      const milOk = type === 'civilian' || milResult.status === 'fulfilled';

      // Both sources down — total outage, don't return misleading empty data
      if (!civOk && !milOk) throw new Error('Airspace data unavailable: both civilian and military sources failed');

      const civ = civResult.status === 'fulfilled' ? civResult.value : null;
      const mil = milResult.status === 'fulfilled' ? milResult.value : null;
      const warnings: string[] = [];
      if (!civOk) warnings.push('civilian ADS-B data unavailable');
      if (!milOk) warnings.push('military flight data unavailable');

      const civilianFlights = (civ?.positions ?? []).slice(0, 100).map(p => ({
        callsign: p.callsign, icao24: p.icao24,
        lat: p.lat, lon: p.lon,
        altitude_m: p.altitude_m, speed_kts: p.ground_speed_kts,
        heading_deg: p.track_deg, on_ground: p.on_ground,
      }));
      const militaryFlights = (mil?.flights ?? []).slice(0, 100).map(f => ({
        callsign: f.callsign, hex_code: f.hex_code,
        aircraft_type: f.aircraft_type, aircraft_model: f.aircraft_model,
        operator: f.operator, operator_country: f.operator_country,
        lat: f.location?.latitude, lon: f.location?.longitude,
        altitude: f.altitude, heading: f.heading, speed: f.speed,
        is_interesting: f.is_interesting, ...(f.note ? { note: f.note } : {}),
      }));

      return {
        country_code: code,
        bounding_box: { sw_lat, sw_lon, ne_lat, ne_lon },
        civilian_count: civilianFlights.length,
        military_count: militaryFlights.length,
        ...(type !== 'military' && { civilian_flights: civilianFlights }),
        ...(type !== 'civilian' && { military_flights: militaryFlights }),
        ...(warnings.length > 0 && { partial: true, warnings }),
        source: civ?.source ?? 'opensky',
        updated_at: civ?.updated_at ? new Date(civ.updated_at).toISOString() : new Date().toISOString(),
      };
    },
    _apiPaths: [
      "GET /api/aviation/v1/track-aircraft",
      "GET /api/military/v1/list-military-flights",
    ],
  },
  {
    name: 'get_maritime_activity',
    _outputBudgetBytes: 262144,
    description: "Live vessel traffic and maritime disruptions for a country's waters. Returns AIS density zones (ships-per-day, intensity score), dark ship events, and chokepoint congestion from AIS tracking.",
    inputSchema: {
      type: 'object',
      properties: {
        country_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code (e.g. "AE", "SA", "JP", "EG")',
        },
      },
      required: ['country_code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string' },
        bounding_box: { type: 'object', properties: {
          sw_lat: { type: 'number' }, sw_lon: { type: 'number' },
          ne_lat: { type: 'number' }, ne_lon: { type: 'number' },
        } },
        snapshot_at: { type: 'string' },
        total_zones: { type: 'number' },
        total_disruptions: { type: 'number' },
        density_zones: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, intensity: { type: ['number', 'null'] },
          ships_per_day: { type: ['number', 'null'] }, delta_pct: { type: ['number', 'null'] }, note: { type: 'string' },
        } } },
        disruptions: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, type: { type: 'string' }, severity: { type: 'string' },
          dark_ships: { type: ['number', 'null'] }, vessel_count: { type: ['number', 'null'] },
          region: { type: 'string' }, description: { type: 'string' },
        } } },
        error: { type: 'string', description: 'Present only on unknown country_code.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const bbox = COUNTRY_BBOXES[code];
      if (!bbox) return { error: `Unknown country code: ${code}. Use ISO 3166-1 alpha-2 (e.g. "AE", "SA", "JP").` };
      const [sw_lat, sw_lon, ne_lat, ne_lon] = bbox;
      // Deliberately NO bbox on the inner fetch: the handler rejects any bbox
      // dimension >10° (BboxValidationError → HTTP 400), and 67 of the 167
      // COUNTRY_BBOXES exceed that (US, JP, AU, BR, …) — WORLDMONITOR-T8.
      // The relay's density/disruption sets are global regardless of bbox
      // (bbox only scopes tanker/candidate reports, which this tool never
      // requests), so we take the cached global snapshot and filter to the
      // country bbox here using each item's coordinates.
      const url = `${base}/api/maritime/v1/get-vessel-snapshot`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);

      // Wire shape is the generated sebuf JSON — camelCase field names with
      // nested `location` (the previous snake_case reads matched nothing, so
      // density_zones was permanently empty).
      type VesselLoc = { latitude?: number; longitude?: number };
      type VesselResp = {
        snapshot?: {
          snapshotAt?: number;
          densityZones?: { name?: string; location?: VesselLoc; intensity?: number; shipsPerDay?: number; deltaPct?: number; note?: string }[];
          disruptions?: { name?: string; type?: string; severity?: string; location?: VesselLoc; darkShips?: number; vesselCount?: number; region?: string; description?: string }[];
        };
      };

      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        throwIfBillingDenial(res, 'get-vessel-snapshot');
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`get-vessel-snapshot HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
      }
      const data = await res.json() as VesselResp;
      const snap = data.snapshot ?? {};

      // 3° pad: maritime zones sit offshore, outside land bboxes (e.g. the
      // Strait of Hormuz at 26.6N/56.3E vs AE's ne corner at 26.06/56.38).
      // (0,0) is the handler's default for missing coordinates → exclude.
      const PAD_DEG = 3;
      const inCountryBbox = (loc?: VesselLoc): boolean => {
        const lat = loc?.latitude ?? 0;
        const lon = loc?.longitude ?? 0;
        if (lat === 0 && lon === 0) return false;
        if (lat < sw_lat - PAD_DEG || lat > ne_lat + PAD_DEG) return false;
        const lo = sw_lon - PAD_DEG;
        // Source boxes stored wrapped (sw_lon > ne_lon) span the dateline;
        // unwrap to a monotonic interval before reasoning about the pad.
        const hi = (sw_lon > ne_lon ? ne_lon + 360 : ne_lon) + PAD_DEG;
        // Pad widened the interval to the full circle — AQ and RU are stored
        // as -180..180 spans, so every longitude matches.
        if (hi - lo >= 360) return true;
        // The pad itself can push a ±180-adjacent box past the dateline
        // (FJ ne_lon=180 → hi=183; NZ 178.29 → 181.29): points just across
        // it (e.g. -179) must still match, so renormalize the overflowing
        // end into [-180,180] and compare on the wrapped complement.
        const wraps = lo < -180 || hi > 180;
        const loN = lo < -180 ? lo + 360 : lo;
        const hiN = hi > 180 ? hi - 360 : hi;
        return wraps ? lon >= loN || lon <= hiN : lon >= loN && lon <= hiN;
      };

      const zones = (snap.densityZones ?? []).filter(z => inCountryBbox(z.location));
      const disruptions = (snap.disruptions ?? []).filter(d => inCountryBbox(d.location));

      return {
        country_code: code,
        bounding_box: { sw_lat, sw_lon, ne_lat, ne_lon },
        snapshot_at: snap.snapshotAt ? new Date(snap.snapshotAt).toISOString() : new Date().toISOString(),
        total_zones: zones.length,
        total_disruptions: disruptions.length,
        density_zones: zones.map(z => ({
          name: z.name, intensity: z.intensity, ships_per_day: z.shipsPerDay,
          delta_pct: z.deltaPct, ...(z.note ? { note: z.note } : {}),
        })),
        disruptions: disruptions.map(d => ({
          name: d.name, type: d.type, severity: d.severity,
          dark_ships: d.darkShips, vessel_count: d.vesselCount,
          region: d.region, description: d.description,
        })),
      };
    },
    _apiPaths: [
      "GET /api/maritime/v1/get-vessel-snapshot",
    ],
  },
  {
    name: 'analyze_situation',
    _outputBudgetBytes: 65536,
    description: 'AI geopolitical situation analysis (DeductionPanel). Provide a query and optional geo-political context; returns an LLM-powered analytical deduction with confidence and supporting signals.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question or situation to analyze, e.g. "What are the implications of the Taiwan strait escalation for semiconductor supply chains?"' },
        context: { type: 'string', description: 'Optional additional geo-political context to include in the analysis' },
        framework: { type: 'string', description: 'Optional analytical framework instructions to shape the analysis lens (e.g. Ray Dalio debt cycle, PMESII-PT, Porter\'s Five Forces)' },
      },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        deduction: { type: 'string', description: 'LLM-generated analytical deduction.' },
        analysis: { type: 'string', description: 'Alternate naming for the body.' },
        confidence: { type: ['number', 'string', 'null'] },
        signals: { type: ['array', 'object', 'null'] },
        framework: { type: 'string' },
        generatedAt: { type: ['string', 'number', 'null'] },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const url = `${base}/api/intelligence/v1/deduct-situation`;
      const body = JSON.stringify({ query: String(params.query ?? ''), geoContext: String(params.context ?? ''), framework: String(params.framework ?? '') });
      const auth = await buildAuthHeaders(context, 'POST', url, body);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        body,
        signal: AbortSignal.timeout(25_000),
      });
      assertToolFetchOk(res, 'deduct-situation');
      return res.json();
    },
    _apiPaths: [
      "POST /api/intelligence/v1/deduct-situation",
    ],
  },
  {
    name: 'generate_forecasts',
    _outputBudgetBytes: 65536,
    description: 'Generate live AI geopolitical and economic forecasts. Unlike get_forecast_predictions (pre-computed cache), this calls the forecasting model directly for fresh probability estimates. Note: slower than cache tools.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Forecast domain: "geopolitical", "economic", "military", "climate", or empty for all domains' },
        region: { type: 'string', description: 'Geographic region filter, e.g. "Middle East", "Europe", "Asia Pacific", or empty for global' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        forecasts: { type: 'array', items: { type: 'object', properties: {
          domain: { type: 'string' }, region: { type: 'string' },
          probability: { type: ['number', 'null'] }, title: { type: 'string' }, rationale: { type: 'string' },
        } } },
        generatedAt: { type: ['string', 'number', 'null'] },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      // 25 s — stays within Vercel Edge's ~30 s hard ceiling (was 60 s, which exceeded the limit)
      const url = `${base}/api/forecast/v1/get-forecasts`;
      const body = JSON.stringify({ domain: String(params.domain ?? ''), region: String(params.region ?? '') });
      const auth = await buildAuthHeaders(context, 'POST', url, body);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        body,
        signal: AbortSignal.timeout(25_000),
      });
      assertToolFetchOk(res, 'get-forecasts');
      return res.json();
    },
    _apiPaths: [],
  },
  {
    name: 'search_flights',
    _outputBudgetBytes: 262144,
    description: 'Search Google Flights for real-time flight options between two airports on a specific date. Returns available flights with prices, stops, airline, and segment details. Use IATA airport codes (e.g. "JFK", "LHR", "DXB").',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'IATA code for the departure airport, e.g. "JFK"' },
        destination: { type: 'string', description: 'IATA code for the arrival airport, e.g. "LHR"' },
        departure_date: { type: 'string', description: 'Departure date in YYYY-MM-DD format' },
        return_date: { type: 'string', description: 'Return date in YYYY-MM-DD format for round trips (optional)' },
        cabin_class: { type: 'string', description: 'Cabin class: "economy", "premium_economy", "business", or "first" (optional, default economy)' },
        max_stops: { type: 'string', description: 'Max stops: "0" or "non_stop" for nonstop, "1" or "one_stop" for max one stop, or omit for any (optional)' },
        passengers: { type: 'number', description: 'Number of passengers (1-9, default 1)' },
        sort_by: { type: 'string', description: 'Sort order: "price" (cheapest), "duration", "departure", or "arrival" (optional)' },
      },
      required: ['origin', 'destination', 'departure_date'],
    },
    // Proxies SerpAPI Google Flights. Shape mirrors that upstream's JSON
    // envelope — keep schema permissive on field types since SerpAPI rotates.
    outputSchema: {
      type: 'object',
      properties: {
        flights: { type: 'array', items: { type: 'object', properties: {
          price: { type: ['number', 'string', 'null'] }, currency: { type: 'string' },
          stops: { type: ['number', 'null'] }, airline: { type: 'string' },
          total_duration: { type: ['number', 'string', 'null'] },
          segments: { type: 'array', items: { type: 'object' } },
        } } },
        search_metadata: { type: ['object', 'null'] },
        error: { type: 'string', description: 'Present when upstream returned a usable error message.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const qs = new URLSearchParams({
        origin: String(params.origin ?? ''),
        destination: String(params.destination ?? ''),
        departure_date: String(params.departure_date ?? ''),
        ...(params.return_date ? { return_date: String(params.return_date) } : {}),
        // Default to economy when the LLM omits cabin_class. The relay /
        // upstream SerpAPI returns ZERO flights for some popular routes
        // (e.g. JFK→LHR) when cabin_class is unset, even though the tool
        // description advertises "default economy". Diagnosis: live probe
        // showed empty `flights` with no error AND no degraded flag; adding
        // `cabin_class=economy` to the same call returned 10+ real flights.
        // This restores the advertised contract.
        cabin_class: String(params.cabin_class ?? 'economy'),
        ...(params.max_stops ? { max_stops: String(params.max_stops) } : {}),
        ...(params.sort_by ? { sort_by: String(params.sort_by) } : {}),
        passengers: String(Math.max(1, Math.min(Number(params.passengers ?? 1), 9))),
      });
      const url = `${base}/api/aviation/v1/search-google-flights?${qs}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(25_000),
      });
      assertToolFetchOk(res, 'search-google-flights');
      return res.json();
    },
    _apiPaths: [
      "GET /api/aviation/v1/search-google-flights",
    ],
  },
  {
    name: 'search_flight_prices_by_date',
    _outputBudgetBytes: 262144,
    description: 'Search Google Flights date-grid pricing across a date range. Returns cheapest prices for each departure date between two airports. Useful for finding the cheapest day to fly. Use IATA airport codes.',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'IATA code for the departure airport, e.g. "JFK"' },
        destination: { type: 'string', description: 'IATA code for the arrival airport, e.g. "LHR"' },
        start_date: { type: 'string', description: 'Start of the date range in YYYY-MM-DD format' },
        end_date: { type: 'string', description: 'End of the date range in YYYY-MM-DD format' },
        is_round_trip: { type: 'boolean', description: 'Whether to search round-trip prices (default false). Requires trip_duration when true.' },
        trip_duration: { type: 'number', description: 'Trip duration in days — required when is_round_trip is true (e.g. 7 for a one-week trip)' },
        cabin_class: { type: 'string', description: 'Cabin class: "economy", "premium_economy", "business", or "first" (optional, default economy)' },
        passengers: { type: 'number', description: 'Number of passengers (1-9, default 1)' },
        sort_by_price: { type: 'boolean', description: 'Sort results by price ascending (default false, sorts by date)' },
      },
      required: ['origin', 'destination', 'start_date', 'end_date'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        prices: { type: 'array', items: { type: 'object', properties: {
          date: { type: 'string' }, price: { type: ['number', 'string', 'null'] },
          currency: { type: 'string' },
        } } },
        search_metadata: { type: ['object', 'null'] },
        error: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const qs = new URLSearchParams({
        origin: String(params.origin ?? ''),
        destination: String(params.destination ?? ''),
        start_date: String(params.start_date ?? ''),
        end_date: String(params.end_date ?? ''),
        is_round_trip: String(params.is_round_trip ?? false),
        ...(params.trip_duration ? { trip_duration: String(params.trip_duration) } : {}),
        // Mirror search_flights: default to economy when omitted. Same
        // upstream-empty-on-missing-cabin-class issue.
        cabin_class: String(params.cabin_class ?? 'economy'),
        sort_by_price: String(params.sort_by_price ?? false),
        passengers: String(Math.max(1, Math.min(Number(params.passengers ?? 1), 9))),
      });
      const url = `${base}/api/aviation/v1/search-google-dates?${qs}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(25_000),
      });
      assertToolFetchOk(res, 'search-google-dates');
      return res.json();
    },
    _apiPaths: [
      "GET /api/aviation/v1/search-google-dates",
    ],
  },
  {
    name: 'get_commodity_geo',
    _outputBudgetBytes: 262144,
    description: 'Global mining sites with coordinates, operator, mineral type, and production status. Covers 71 major mines spanning gold, silver, copper, lithium, uranium, coal, and other minerals worldwide.',
    inputSchema: {
      type: 'object',
      properties: {
        mineral: { type: 'string', description: 'Filter by mineral type (e.g. "Gold", "Copper", "Lithium")' },
        country: { type: 'string', description: 'Filter by country name (e.g. "Australia", "Chile")' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      required: ['sites', 'total'],
      properties: {
        sites: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, name: { type: 'string' },
          lat: { type: 'number' }, lon: { type: 'number' },
          mineral: { type: 'string' }, country: { type: 'string' },
          operator: { type: 'string' }, status: { type: 'string' }, significance: { type: 'string' },
          annualOutput: { type: 'string' }, productionRank: { type: 'number' },
          openPitOrUnderground: { type: 'string' },
        } } },
        total: { type: 'number' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params: Record<string, unknown>) => {
      type MineSite = { id: string; name: string; lat: number; lon: number; mineral: string; country: string; operator: string; status: string; significance: string; annualOutput?: string; productionRank?: number; openPitOrUnderground?: string };
      let sites = MINING_SITES_RAW as MineSite[];
      if (params.mineral) sites = sites.filter((s) => s.mineral === String(params.mineral));
      if (params.country) sites = sites.filter((s) => s.country.toLowerCase().includes(String(params.country).toLowerCase()));
      return { sites, total: sites.length };
    },
    _apiPaths: [],
  },
  {
    name: 'get_signal_convergence',
    _outputBudgetBytes: 65536,
    description:
      'Geographic signal convergence: grid cells where protests, military activity, naval movements, and earthquakes co-occur. ' +
      'The same multi-domain convergence engine the dashboard map runs, executed server-side over the seeded feeds: unrest events, ' +
      'tracked military flights, USNI fleet positions (region centroids), and USGS earthquakes are bucketed into one-degree cells ' +
      'over a 24-hour window, and any cell where enough distinct domains overlap becomes an alert scored by breadth and volume. ' +
      'Each alert carries coordinates, the contributing domains, a reverse-geocoded location name from the curated hotspot/' +
      'chokepoint/conflict-zone gazetteer, and the total event count. Pass lat/lon/radius_km together to narrow to one area, or ' +
      'min_domains to tighten the co-occurrence bar. An empty alert list with fresh inputs means nothing is converging — signal in itself.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude of the area of interest; requires lon and radius_km as well.' },
        lon: { type: 'number', description: 'Longitude of the area of interest; requires lat and radius_km as well.' },
        radius_km: { type: 'number', description: 'Radius in km around lat/lon to keep alerts for; requires lat and lon.' },
        min_domains: { type: 'number', description: 'Distinct signal domains required per cell, 2-5 (default 3).' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Oldest fetch time across the contributing feeds.' },
        stale: { type: 'boolean', description: 'True when any contributing feed is older than its freshness budget.' },
        data: {
          type: 'object',
          properties: {
            alerts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  cellId: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' },
                  location: { type: 'string' },
                  types: { type: 'array', items: { type: 'string' } },
                  totalEvents: { type: 'number' }, score: { type: 'number' },
                },
              },
            },
            cell_count: { type: 'number' },
            min_domains: { type: 'number' },
            feeds: { type: 'object', description: 'Per-feed ingested event counts (0 = feed empty or unavailable).' },
          },
          required: [],
        },
        error: { type: 'string', description: 'Present only on a user-input failure; the envelope keys are still returned.' },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const lat = typeof params.lat === 'number' ? params.lat : null;
      const lon = typeof params.lon === 'number' ? params.lon : null;
      const radiusKm = typeof params.radius_km === 'number' ? params.radius_km : null;
      const provided = [lat, lon, radiusKm].filter((v) => v !== null).length;
      if (provided > 0 && provided < 3) {
        // Envelope always present: the declared outputSchema marks cached_at/
        // stale/data required, so a bare {error} would violate the published
        // contract a strict MCP client validates against.
        return {
          cached_at: null,
          stale: false,
          data: { alerts: [], cell_count: 0, min_domains: 0, feeds: {} },
          error: 'lat, lon, and radius_km must be provided together (all three or none).',
        };
      }
      const minDomains = Math.min(5, Math.max(2, Math.round(Number(params.min_domains ?? 3)) || 3));

      const keys = ['unrest:events:v1', 'military:flights:v1', 'seismology:earthquakes:v1', 'usni-fleet:sebuf:v1'];
      const checks: FreshnessCheck[] = [
        { key: 'seed-meta:unrest:events', maxStaleMin: 120 },
        { key: 'seed-meta:military:flights', maxStaleMin: 30 },
        { key: 'seed-meta:seismology:earthquakes', maxStaleMin: 30 },
        { key: 'seed-meta:military:usni-fleet', maxStaleMin: 720 },
      ];
      const { payloads: [unrest, flights, quakes, fleet], freshness } = await readCachesWithFreshness(keys, checks);
      if ([unrest, flights, quakes, fleet].every((value) => value === null)) {
        throw new Error('cache_all_null: no convergence input feeds are available');
      }

      const now = Date.now();
      const engine = new GeoConvergenceEngine({ convergenceThreshold: minDomains, now: () => now });
      const feeds = {
        protests: unrestEventsToGeoEvents(unrest, { now }),
        military_flights: militaryFlightsToGeoEvents(flights, { now }),
        earthquakes: earthquakesToGeoEvents(quakes, { now }),
        naval_vessels: usniVesselsToGeoEvents(fleet, { now }),
      };
      engine.ingestEvents(feeds.protests, 'protest');
      engine.ingestEvents(feeds.military_flights, 'military_flight');
      engine.ingestEvents(feeds.earthquakes, 'earthquake');
      engine.ingestEvents(feeds.naval_vessels, 'military_vessel');

      let alerts = engine.detect(new Set());
      if (lat !== null && lon !== null && radiusKm !== null) {
        const toRad = (d: number) => (d * Math.PI) / 180;
        alerts = alerts.filter((alert) => {
          const dLat = toRad(alert.lat - lat);
          const dLon = toRad(alert.lon - lon);
          const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(alert.lat)) * Math.sin(dLon / 2) ** 2;
          return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= radiusKm;
        });
      }
      return {
        ...freshness,
        data: {
          alerts: alerts.map((alert) => ({
            ...alert,
            location: getLocationName(alert.lat, alert.lon, MCP_GEO_PLACES),
          })),
          cell_count: engine.cellCount(),
          min_domains: minDomains,
          feeds: Object.fromEntries(Object.entries(feeds).map(([name, events]) => [name, events.length])),
        },
      };
    },
    _coverageKeys: ['unrest:events:v1', 'military:flights:v1', 'seismology:earthquakes:v1', 'usni-fleet:sebuf:v1'],
    _apiPaths: [],
  },
  {
    name: 'get_focal_points',
    _outputBudgetBytes: 65536,
    description:
      'Focal-point detection: entities where news coverage and live map signals converge, ranked by multi-signal score. ' +
      'Runs the dashboard focal-point engine server-side: seeded news story clusters are entity-matched against the curated ' +
      'registry of countries, companies, and organizations, then cross-referenced with cross-source escalation signals mapped ' +
      'to countries through the same entity index. Each focal point reports its urgency band, news and signal scores, a ' +
      'correlation bonus when headlines and map signals name the same entity, supporting headlines, and a generated narrative. ' +
      'The response also carries an aiContext block suitable for grounding follow-up analysis, plus mapping-coverage counters ' +
      'so a thin result is distinguishable from an outage. Filter to one country with country_code; cap the list with limit.',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'Filter focal points to one country (ISO-2) and entities the registry relates to it.' },
        limit: { type: 'number', description: 'Cap the focal point list (default 10, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Oldest fetch time across the contributing feeds.' },
        stale: { type: 'boolean', description: 'True when any contributing feed is older than its freshness budget.' },
        data: {
          type: 'object',
          properties: {
            focal_points: { type: 'array', items: { type: 'object' } },
            ai_context: { type: 'string' },
            coverage: {
              type: 'object',
              properties: {
                clusters: { type: 'number' },
                signals_total: { type: 'number' },
                signals_mapped: { type: 'number' },
                signals_unmapped: { type: 'number' },
              },
            },
          },
          required: [],
        },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const limit = resolveLimit(params.limit, 10);
      const keys = ['news:insights:v1', 'intelligence:cross-source-signals:v1', CII_RISK_SCORE_CACHE_KEYS.live];
      const checks: FreshnessCheck[] = [
        { key: 'seed-meta:news:insights', maxStaleMin: 30 },
        { key: 'seed-meta:intelligence:cross-source-signals', maxStaleMin: 30 },
        { key: 'seed-meta:intelligence:risk-scores', maxStaleMin: 30 },
      ];
      const { payloads: [insights, crossSource, riskScores], freshness } = await readCachesWithFreshness(keys, checks);
      if ([insights, crossSource, riskScores].every((value) => value === null)) {
        throw new Error('cache_all_null: no focal-point input feeds are available');
      }

      const index = getSharedEntityIndex();
      const clusters = insightsToFocalClusters(insights);
      const mapping = crossSourceSignalsToSignalSummary(crossSource, index);
      const summary = new FocalPointCore(index).analyze(clusters, mapping.summary);
      const ciiLookup = riskScoresToCiiLookup(riskScores);

      let points = summary.focalPoints;
      const countryCode = typeof params.country_code === 'string' ? params.country_code : '';
      if (countryCode) points = filterFocalPointsByCountry(points, countryCode, index);
      return {
        ...freshness,
        data: {
          focal_points: points.slice(0, limit).map((point) => ({
            ...point,
            ciiScore: point.entityType === 'country' ? ciiLookup(point.entityId) : null,
          })),
          ai_context: summary.aiContext,
          coverage: {
            clusters: clusters.length,
            signals_total: mapping.signalsTotal,
            signals_mapped: mapping.signalsMapped,
            signals_unmapped: mapping.signalsUnmapped,
          },
        },
      };
    },
    _coverageKeys: ['news:insights:v1', 'intelligence:cross-source-signals:v1', CII_RISK_SCORE_CACHE_KEYS.live],
    _apiPaths: [],
  },
  {
    name: 'simulate_infrastructure_cascade',
    _outputBudgetBytes: 131072,
    description:
      'Infrastructure cascade simulation: what fails downstream when a cable, chokepoint, pipeline, or port is disrupted. ' +
      'Builds the dashboard dependency graph server-side from the seeded TeleGeography submarine-cable table plus the curated ' +
      'pipeline, port, and maritime-chokepoint registries, then runs breadth-first failure propagation from the chosen source ' +
      'node. Results include every affected node with its degraded capacity share, per-country impact categories, redundancy ' +
      'candidates, and graph statistics. Call with no source_id to receive the catalog of simulatable node ids grouped by ' +
      'type; disruption_level scales the initial failure from partial (0.1) to total (1, the default). Chained capacity math ' +
      'multiplies along paths, so distant impacts shrink realistically instead of cascading at full strength.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'string', description: 'Node id to disrupt (see the no-argument catalog for valid ids).' },
        disruption_level: { type: 'number', description: 'Initial failure severity between 0.1 and 1 (default 1).' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Fetch time of the seeded cable table.' },
        stale: { type: 'boolean', description: 'True when the cable table is older than its freshness budget.' },
        data: {
          type: 'object',
          properties: {
            catalog: { type: ['object', 'null'], description: 'Node ids by type; present only when source_id is omitted.' },
            cascade: { type: ['object', 'null'], description: 'Cascade result; present only when source_id is given.' },
            stats: { type: 'object' },
          },
          required: [],
        },
        error: { type: 'string', description: 'Present only on a user-input failure; the envelope keys are still returned.' },
        known_id_sample: { type: 'array', items: { type: 'string' }, description: 'Sample of valid node ids; present only alongside an unknown-source_id error.' },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const checks: FreshnessCheck[] = [
        { key: 'seed-meta:infrastructure:submarine-cables', maxStaleMin: 25200 },
      ];
      const { payloads: [cablesPayload], freshness } = await readCachesWithFreshness(
        ['infrastructure:submarine-cables:v1'],
        checks,
      );
      if (cablesPayload === null) {
        throw new Error('cache_all_null: the submarine-cable table is unavailable');
      }

      const cables = submarineCablesToCableInputs(cablesPayload);
      const graph = buildDependencyGraph({ cables, waterways: MCP_CASCADE_WATERWAYS });
      const stats = getGraphStats(graph);

      const sourceId = typeof params.source_id === 'string' ? params.source_id.trim() : '';
      if (!sourceId) {
        const catalog: Record<string, Array<{ id: string; name: string }>> = {};
        for (const node of graph.nodes.values()) {
          if (node.type === 'country') continue;
          (catalog[node.type] ??= []).push({ id: node.id, name: node.name });
        }
        return { ...freshness, data: { catalog, cascade: null, stats } };
      }

      if (!graph.nodes.has(sourceId)) {
        const sample = [...graph.nodes.keys()].filter((id) => !id.startsWith('country-')).slice(0, 12);
        return {
          ...freshness,
          data: { catalog: null, cascade: null, stats },
          error: `unknown source_id "${sourceId}" — call without source_id for the full catalog`,
          known_id_sample: sample,
        };
      }

      const rawLevel = Number(params.disruption_level ?? 1);
      const disruptionLevel = Math.min(1, Math.max(0.1, Number.isFinite(rawLevel) ? rawLevel : 1));
      const cascade = calculateCascade(graph, sourceId, disruptionLevel);
      return { ...freshness, data: { catalog: null, cascade, stats } };
    },
    _coverageKeys: ['infrastructure:submarine-cables:v1'],
    _apiPaths: [],
  },
  {
    name: 'get_military_surge',
    _outputBudgetBytes: 65536,
    description:
      'Military surge watch: theater aircraft postures, foreign-presence detections, and seeder-computed surge alerts. ' +
      'Runs the dashboard military-surge engine server-side over the seeded flight snapshot: per-theater posture summaries ' +
      'count fighters, tankers, AWACS, reconnaissance, transports, bombers, and drones inside each theater boundary, with ' +
      'trend context recovered from the persisted surge history and tracked-vessel counts merged from the theater-posture ' +
      'cache. Foreign-presence detection flags operators flying far from their home region above per-operator thresholds. ' +
      'The seeded_surges block carries the surge alerts the flights seeder computed against its own persisted baselines — ' +
      'reported separately because that variant uses different thresholds than the snapshot engine. Filter with theater.',
    inputSchema: {
      type: 'object',
      properties: {
        theater: { type: 'string', description: 'Filter to one theater by id or name substring (case-insensitive).' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Oldest fetch time across the contributing feeds.' },
        stale: { type: 'boolean', description: 'True when any contributing feed is older than its freshness budget.' },
        data: {
          type: 'object',
          properties: {
            postures: { type: 'array', items: { type: 'object' } },
            foreign_presence: { type: 'array', items: { type: 'object' } },
            seeded_surges: { type: 'array', items: { type: 'object' } },
            flight_count: { type: 'number' },
          },
          required: [],
        },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const keys = ['military:flights:v1', 'theater-posture:sebuf:v1', 'military:surges:v1', 'military:surges:history:v1'];
      const checks: FreshnessCheck[] = [
        { key: 'seed-meta:military:flights', maxStaleMin: 30 },
        { key: 'seed-meta:theater-posture', maxStaleMin: 60 },
      ];
      const { payloads: [flightsPayload, posturePayload, surgesPayload, historyPayload], freshness } = await readCachesWithFreshness(keys, checks);
      if ([flightsPayload, posturePayload, surgesPayload].every((value) => value === null)) {
        throw new Error('cache_all_null: no military feeds are available');
      }

      const flights = militaryFlightsToSurgeInputs(flightsPayload);
      const history = surgeHistoryToActivityHistory(historyPayload);
      const postures = getTheaterPostureSummaries(flights, history);
      applyVesselCountsToPostures(postures, theaterPostureVesselCounts(posturePayload));
      recalcPostureWithVessels(postures);

      const engine = new MilitarySurgeEngine();
      const foreignPresence = engine.detectForeignMilitaryPresence(flights).map((alert) => ({
        id: alert.id,
        operator: alert.operator,
        operatorCountry: alert.operatorCountry,
        region: alert.region.name,
        region_id: alert.region.id,
        aircraftCount: alert.aircraftCount,
      }));

      const seededSurges = Array.isArray((surgesPayload as { surges?: unknown[] } | null)?.surges)
        ? ((surgesPayload as { surges: unknown[] }).surges as Array<Record<string, unknown>>)
        : [];

      const theaterFilter = typeof params.theater === 'string' ? params.theater.trim().toLowerCase() : '';
      const matchesTheater = (id: unknown, name?: unknown, shortName?: unknown) =>
        !theaterFilter ||
        [id, name, shortName].some(
          (value) => typeof value === 'string' && value.toLowerCase().includes(theaterFilter),
        );
      return {
        ...freshness,
        data: {
          postures: postures.filter((p) => matchesTheater(p.theaterId, p.theaterName, p.shortName)),
          foreign_presence: theaterFilter
            ? foreignPresence.filter((alert) => alert.region.toLowerCase().includes(theaterFilter))
            : foreignPresence,
          seeded_surges: seededSurges.filter((surge) => matchesTheater(surge.theaterId, surge.theater)),
          flight_count: flights.length,
        },
      };
    },
    _coverageKeys: ['military:flights:v1', 'theater-posture:sebuf:v1', 'military:surges:v1', 'military:surges:history:v1'],
    _apiPaths: [],
  },
  {
    name: 'get_population_exposure',
    _outputBudgetBytes: 65536,
    description:
      'Population exposure: estimated people within the impact radius of active earthquakes, wildfires, and conflict events. ' +
      'Uses the same country-density approximation the dashboard ships — the nearest priority-country centroid supplies a ' +
      'population density that is multiplied over the event-type radius disc (50 km for conflict, 100 km for earthquakes and ' +
      'floods, 30 km for fires). Three modes: events (the default) enriches the current seeded event feeds and ranks them by ' +
      'exposed population; point estimates exposure around an arbitrary lat/lon; countries returns the priority-country ' +
      'population table itself. Estimates are deliberately coarse screening numbers — there is no city-level population ' +
      'dataset behind them — so treat them as ranking signals, not casualty projections.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['events', 'point', 'countries'], description: 'events enriches live feeds (default); point takes lat/lon; countries lists the population table.' },
        event_source: { type: 'string', enum: ['earthquakes', 'wildfires', 'conflicts', 'all'], description: 'Which event feeds to enrich in events mode (default all).' },
        lat: { type: 'number', description: 'Latitude for point mode.' },
        lon: { type: 'number', description: 'Longitude for point mode.' },
        radius_km: { type: 'number', description: 'Radius in km for point mode (default 50, clamped to 1000).' },
        limit: { type: 'number', description: 'Cap the enriched event list in events mode (default 20, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Oldest fetch time across the feeds read; null in point and countries modes.' },
        stale: { type: 'boolean', description: 'True when any contributing feed is older than its freshness budget.' },
        data: {
          type: 'object',
          properties: {
            events: { type: ['array', 'null'], items: { type: 'object' } },
            exposure: { type: ['object', 'null'] },
            countries: { type: ['array', 'null'], items: { type: 'object' } },
          },
          required: [],
        },
        error: { type: 'string', description: 'Present only on a user-input failure; the envelope keys are still returned.' },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const mode = typeof params.mode === 'string' ? params.mode : 'events';

      if (mode === 'countries') {
        return { cached_at: null, stale: false, data: { events: null, exposure: null, countries: listCountryPopulations() } };
      }

      if (mode === 'point') {
        const lat = typeof params.lat === 'number' ? params.lat : null;
        const lon = typeof params.lon === 'number' ? params.lon : null;
        if (lat === null || lon === null) {
          return {
            cached_at: null,
            stale: false,
            data: { events: null, exposure: null, countries: null },
            error: 'point mode requires numeric lat and lon.',
          };
        }
        // Out-of-range coordinates would still resolve to a nearest centroid
        // by Euclidean distance and return a real-looking estimate for a place
        // that does not exist (lat 999 attributes to Mali).
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          return {
            cached_at: null,
            stale: false,
            data: { events: null, exposure: null, countries: null },
            error: `lat must be within [-90, 90] and lon within [-180, 180] (received lat=${lat}, lon=${lon}).`,
          };
        }
        const radiusKm = Math.max(1, Number(params.radius_km ?? 50) || 50);
        return {
          cached_at: null,
          stale: false,
          data: { events: null, exposure: computeExposure(lat, lon, radiusKm), countries: null },
        };
      }

      const source = typeof params.event_source === 'string' ? params.event_source : 'all';
      const limit = resolveLimit(params.limit, 20);
      const wants = (name: string) => source === 'all' || source === name;
      const reads: Array<{ key: string; check: FreshnessCheck; adapt: (payload: unknown) => ExposureEvent[] }> = [];
      if (wants('earthquakes')) {
        reads.push({
          key: 'seismology:earthquakes:v1',
          check: { key: 'seed-meta:seismology:earthquakes', maxStaleMin: 30 },
          adapt: (payload) => earthquakesToExposureEvents(payload),
        });
      }
      if (wants('wildfires')) {
        reads.push({
          key: 'wildfire:fires:v1',
          check: { key: 'seed-meta:wildfire:fires', maxStaleMin: 360 },
          adapt: (payload) => firesToExposureEvents(payload),
        });
      }
      if (wants('conflicts')) {
        reads.push({
          key: 'conflict:ucdp-events:v1',
          check: { key: 'seed-meta:conflict:ucdp-events', maxStaleMin: 1440 },
          adapt: (payload) => ucdpEventsToExposureEvents(payload),
        });
      }

      const payloads = await Promise.all(reads.map((read) => readJsonFromUpstash(read.key)));
      const metas = await Promise.all(reads.map((read) => readJsonFromUpstash(read.check.key)));
      if (payloads.every((value: unknown) => value === null)) {
        throw new Error('cache_all_null: no event feeds are available for exposure enrichment');
      }

      const enriched = reads
        .flatMap((read, i) => read.adapt(payloads[i]))
        .map((event) => {
          const radius = getRadiusForEventType(event.type);
          const exposure = computeExposure(event.lat, event.lon, radius);
          return { ...event, ...exposure };
        })
        .sort((a, b) => b.exposedPopulation - a.exposedPopulation)
        .slice(0, limit);

      const freshness = evaluateFreshness(reads.map((read) => read.check), metas);
      return { ...freshness, data: { events: enriched, exposure: null, countries: null } };
    },
    _coverageKeys: ['seismology:earthquakes:v1', 'wildfire:fires:v1', 'conflict:ucdp-events:v1'],
    _apiPaths: ['GET /api/displacement/v1/get-population-exposure'],
  },
  {
    name: 'get_alert_digest',
    _outputBudgetBytes: 131072,
    description:
      'Cross-domain alert digest: everything that tripped a threshold today, in one rollup. ' +
      'Sweeps seven seeded domains — country instability bands, military surge alerts, submarine-cable health, ongoing ' +
      'internet outages, temporal anomalies, thermal escalation zones, and shipping stress — and reports each trip with the ' +
      'severity vocabulary its own producer already uses; no thresholds are invented by this tool. Domains with data but no ' +
      'trips are listed as quiet, and domains whose caches are unavailable are listed separately so silence is never mistaken ' +
      'for calm. The weekly view adds direction, volatility, and anomaly flags derived from the persisted military-activity ' +
      'history plus the current temporal-anomaly snapshot. This is the fastest single call for what changed today.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['today', 'weekly'], description: 'today lists current threshold trips (default); weekly adds trend context.' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Oldest fetch time across the contributing feeds.' },
        stale: { type: 'boolean', description: 'True when any contributing feed is older than its freshness budget.' },
        data: {
          type: 'object',
          properties: {
            tripped: { type: 'array', items: { type: 'object' } },
            quiet: { type: 'array', items: { type: 'string' } },
            unavailable: { type: 'array', items: { type: 'string' } },
            weekly: { type: ['object', 'null'] },
          },
          required: [],
        },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const view = typeof params.view === 'string' ? params.view : 'today';
      const keys = [
        CII_RISK_SCORE_CACHE_KEYS.live,
        'military:surges:v1',
        'cable-health-v1',
        'infra:outages:v1',
        'temporal:anomalies:v1',
        'thermal:escalation:v1',
        'supply_chain:shipping_stress:v1',
      ];
      const checks: FreshnessCheck[] = [
        { key: 'seed-meta:intelligence:risk-scores', maxStaleMin: 30 },
        { key: 'seed-meta:military:flights', maxStaleMin: 30 },
        { key: 'seed-meta:cable-health', maxStaleMin: 90 },
        { key: 'seed-meta:infra:outages', maxStaleMin: 30 },
        { key: 'seed-meta:temporal:anomalies', maxStaleMin: 45 },
        { key: 'seed-meta:thermal:escalation', maxStaleMin: 360 },
        { key: 'seed-meta:supply_chain:shipping_stress', maxStaleMin: 45 },
      ];
      const { payloads: [riskScores, surges, cableHealth, outages, temporal, thermal, stress], freshness } = await readCachesWithFreshness(keys, checks);
      if ([riskScores, surges, cableHealth, outages, temporal, thermal, stress].every((value: unknown) => value === null)) {
        throw new Error('cache_all_null: no digest input feeds are available');
      }

      const now = Date.now();
      const digest = buildAlertDigest(
        buildDigestInputs({ riskScores, surges, cableHealth, outages, temporal, thermal, stress }),
        now,
      );

      let weekly: Record<string, unknown> | null = null;
      if (view === 'weekly') {
        const historyPayload = await readJsonFromUpstash('military:surges:history:v1');
        const activity = surgeHistoryToActivityHistory(historyPayload);
        const series = [...activity.entries()].map(([theaterId, points]) => ({
          domain: `military:${theaterId}`,
          points: points.map((point) => ({ t: point.timestamp, value: point.totalMilitary })),
        }));
        weekly = {
          trends: buildWeeklyTrends(series, now),
          current_anomalies: anomaliesToDigestInput(temporal),
          note: 'weekly trends derive from the persisted military-activity history; other domains publish no whole-feed history caches yet',
        };
      }
      return {
        ...freshness,
        data: { tripped: digest.tripped, quiet: digest.quiet, unavailable: digest.unavailable, weekly },
      };
    },
    _coverageKeys: [
      CII_RISK_SCORE_CACHE_KEYS.live,
      'military:surges:v1',
      'cable-health-v1',
      'infra:outages:v1',
      'temporal:anomalies:v1',
      'thermal:escalation:v1',
      'supply_chain:shipping_stress:v1',
    ],
    _apiPaths: [],
  },
  {
    name: 'get_hotspot_escalation',
    _outputBudgetBytes: 65536,
    description:
      'Hotspot escalation scores: the 29 curated intelligence hotspots ranked by dynamic escalation on a 1-5 scale. ' +
      'Runs the dashboard escalation engine server-side: for each curated hotspot, news pressure (keyword matches over the ' +
      'seeded story clusters), country instability, geographic signal convergence (protests, military flights, earthquakes ' +
      'gridded around the hotspot), and nearby military activity are normalized to 0-100 components, weighted 35/25/25/15, ' +
      'and blended 30/70 with the curated static baseline into the same 1-5 composite the dashboard map publishes. Server ' +
      'runs are snapshots: trend reads stable without the browser session history, CII attaches only where a hotspot maps to ' +
      'a scored country, and vessel counts are unavailable — each such gap is visible in the per-hotspot components block.',
    inputSchema: {
      type: 'object',
      properties: {
        hotspot_id: { type: 'string', description: 'Return only this curated hotspot id (see any full response for the id list).' },
        limit: { type: 'number', description: 'Cap the ranked hotspot list (default 29, the full curated set; pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'], description: 'Oldest fetch time across the contributing feeds.' },
        stale: { type: 'boolean', description: 'True when any contributing feed is older than its freshness budget.' },
        data: {
          type: 'object',
          properties: {
            hotspots: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  hotspotId: { type: 'string' }, name: { type: 'string' },
                  lat: { type: 'number' }, lon: { type: 'number' },
                  staticBaseline: { type: 'number' }, dynamicScore: { type: 'number' },
                  combinedScore: { type: 'number', description: 'Composite escalation on the documented 1-5 scale.' },
                  components: { type: 'object' }, trend: { type: 'string' },
                },
              },
            },
          },
          required: [],
        },
        error: { type: 'string', description: 'Present only on a user-input failure; the envelope keys are still returned.' },
        known_ids: { type: 'array', items: { type: 'string' }, description: 'All curated hotspot ids; present only alongside an unknown-hotspot_id error.' },
      },
      required: ['cached_at', 'stale', 'data'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      // Validated against the static curated list BEFORE any cache read: an
      // unknown id is knowable without spending five Redis round-trips.
      const hotspotIdFilter = typeof params.hotspot_id === 'string' ? params.hotspot_id.trim() : '';
      const targets = hotspotIdFilter
        ? INTEL_HOTSPOTS.filter((hotspot) => hotspot.id === hotspotIdFilter)
        : INTEL_HOTSPOTS;
      if (hotspotIdFilter && targets.length === 0) {
        return {
          cached_at: null,
          stale: false,
          data: { hotspots: [] },
          error: `unknown hotspot_id "${hotspotIdFilter}"`,
          known_ids: INTEL_HOTSPOTS.map((hotspot) => hotspot.id),
        };
      }

      const keys = ['news:insights:v1', CII_RISK_SCORE_CACHE_KEYS.live, 'military:flights:v1', 'unrest:events:v1', 'seismology:earthquakes:v1'];
      const checks: FreshnessCheck[] = [
        { key: 'seed-meta:news:insights', maxStaleMin: 30 },
        { key: 'seed-meta:intelligence:risk-scores', maxStaleMin: 30 },
        { key: 'seed-meta:military:flights', maxStaleMin: 30 },
        { key: 'seed-meta:unrest:events', maxStaleMin: 120 },
        { key: 'seed-meta:seismology:earthquakes', maxStaleMin: 30 },
      ];
      const { payloads: [insights, riskScores, flightsPayload, unrest, quakes], freshness } = await readCachesWithFreshness(keys, checks);
      if ([insights, riskScores, flightsPayload, unrest, quakes].every((value) => value === null)) {
        throw new Error('cache_all_null: no hotspot-escalation input feeds are available');
      }

      const now = Date.now();
      const clusters = insightsToFocalClusters(insights);
      const ciiLookup = riskScoresToCiiLookup(riskScores);
      const flights = militaryFlightsToSurgeInputs(flightsPayload);
      const index = getSharedEntityIndex();

      const geoEngine = new GeoConvergenceEngine({ now: () => now });
      geoEngine.ingestEvents(unrestEventsToGeoEvents(unrest, { now }), 'protest');
      geoEngine.ingestEvents(militaryFlightsToGeoEvents(flightsPayload, { now }), 'military_flight');
      geoEngine.ingestEvents(earthquakesToGeoEvents(quakes, { now }), 'earthquake');

      const scored = targets.map((hotspot) => {
        const keywords = (hotspot.keywords ?? []).map((keyword) => keyword.toLowerCase());
        const matchesKeyword = (title: string) => {
          const lower = title.toLowerCase();
          return keywords.some((keyword) => lower.includes(keyword));
        };
        const newsMatches = clusters.filter(
          (cluster) => matchesKeyword(cluster.primaryTitle) || (cluster.allItems ?? []).some((item) => matchesKeyword(item.title)),
        ).length;
        const nearby = geoEngine.alertsNear(hotspot.lat, hotspot.lon, 300);
        const countryEntity = index.byId.get(hotspot.id.toUpperCase());
        const ciiScore = countryEntity?.type === 'country' ? ciiLookup(hotspot.id.toUpperCase()) : null;
        const score = computeEscalationScore(
          hotspot,
          {
            newsMatches,
            hasBreaking: false,
            newsVelocity: 0,
            ciiScore,
            geoAlertScore: nearby?.score ?? 0,
            geoAlertTypes: nearby?.types ?? 0,
            flightsNearby: countMilitaryNearHotspot(hotspot, flights, []).flights,
            vesselsNearby: 0,
          },
          { now, previousHistory: [] },
        );
        return {
          hotspotId: score.hotspotId,
          name: hotspot.name,
          lat: hotspot.lat,
          lon: hotspot.lon,
          staticBaseline: score.staticBaseline,
          dynamicScore: score.dynamicScore,
          combinedScore: score.combinedScore,
          components: score.components,
          trend: score.trend,
        };
      });

      const limit = resolveLimit(params.limit, INTEL_HOTSPOTS.length);
      scored.sort((a, b) => b.combinedScore - a.combinedScore || b.dynamicScore - a.dynamicScore);
      return { ...freshness, data: { hotspots: scored.slice(0, limit) } };
    },
    _coverageKeys: ['news:insights:v1', CII_RISK_SCORE_CACHE_KEYS.live, 'military:flights:v1', 'unrest:events:v1', 'seismology:earthquakes:v1'],
    _apiPaths: [],
  },
  {
    // describe_tool (v1.5.0) — on-demand escape hatch for the full
    // uncompressed tool definition. tools/list (default) emits each tool's
    // description compressed to ≤TOOL_DESCRIPTION_MAX_BYTES (first sentence
    // or byte-truncated); the LLM calls describe_tool with a tool_name to
    // get the full v1.4.0-shape tool object — same public shape, just with
    // long-form text in `description`. Uses the SAME buildPublicTool helper
    // as tools/list so the two surfaces can never drift.
    name: 'describe_tool',
    _outputBudgetBytes: 8192,
    description: 'Return the full uncompressed definition of one tool by name. Use when the compressed tools/list entry is ambiguous about behaviour or argument semantics.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Exact tool name from tools/list.' },
      },
      required: ['tool_name'],
    },
    // Returns either the public Tool shape (see PublicToolShape) or one of the
    // two structured error envelopes — both are tools/call results, not JSON-RPC errors.
    outputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        annotations: { type: 'object' },
        error: { type: 'string', enum: ['missing_tool_name', 'unknown_tool'], description: 'Present only on user-input failure.' },
        hint: { type: 'string' },
        requested: { type: 'string' },
        available: { type: 'array', items: { type: 'string' } },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params: Record<string, unknown>) => {
      const name = params.tool_name;
      if (typeof name !== 'string' || name.length === 0) {
        return { error: 'missing_tool_name', hint: 'Pass tool_name as a non-empty string matching a tool from tools/list.' };
      }
      const tool = TOOL_REGISTRY.find((t) => t.name === name);
      if (!tool) {
        return {
          error: 'unknown_tool',
          requested: name,
          available: TOOL_REGISTRY.map((t) => t.name).sort(),
        };
      }
      return buildPublicTool(tool, { compressDescriptions: false });
    },
    _apiPaths: [],
  },
];
