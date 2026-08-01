/**
 * On-demand NLP intelligence utilities (issue #5697): classify_event,
 * extract_entities, get_news_clusters, get_keyword_spikes.
 *
 * Split out of rpc-tools.ts so the registry file stays a registry: these four
 * tools carry real domain logic — a digest anti-corruption layer, entity
 * aggregation, and direct knowledge of the story-accumulator key layout — that
 * has its own reasons to change, independent of the procurement, brief,
 * flight, and China-signal tools.
 *
 * Appended after RPC_TOOLS in the merged registry, so tools/list ordering for
 * every pre-existing tool is unchanged.
 */

import { readJsonFromUpstash, redisPipeline, setCachedData } from '../../_upstash-json.js';
import { extractEntitiesFromTitle } from '../../../shared/entity-extraction-core.js';
import { getEntityById } from '../../../shared/entity-registry.js';
import {
  DEFAULT_MIN_SPIKE_COUNT,
  DEFAULT_SPIKE_MULTIPLIER,
  computeKeywordSpikesFromStories,
  extractEntities as extractPatternEntities,
} from '../../../shared/keyword-spike-core.js';
import { clusterNewsCore, protoThreatLevelToLabel, topClusterKeywords } from '../../../shared/news-clustering-core.js';
import type { NewsItemCore } from '../../../shared/news-clustering-core.js';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk } from '../billing-denial';
import { argStr } from '../filters';
import type { ToolDef } from '../types';

// ── #5697 on-demand NLP intelligence utilities ──────────────────────────────
// Four deterministic (classify_event excepted — enum-validated LLM) utilities
// over the shared NLP cores. Hard input caps keep the arbitrary-text surface
// bounded; all four are standard quota-consuming tools/call tools.

const CLASSIFY_TEXT_MAX_CHARS = 500; // mirrors the classify-event handler's own clip
const CLASSIFY_CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
];
const CLASSIFY_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
const CLASSIFY_SEVERITIES = [
  'SEVERITY_LEVEL_HIGH', 'SEVERITY_LEVEL_MEDIUM', 'SEVERITY_LEVEL_LOW',
];
const EXTRACT_TEXT_MAX_CHARS = 2048; // issue #5697's 2 KB arbitrary-text cap
const NLP_DIGEST_TIMEOUT_MS = 6_000;
const NLP_UA = 'worldmonitor-mcp-edge/1.0';
const KEYWORD_SPIKE_BASELINE_MS = 48 * 60 * 60 * 1000; // digest:accumulator retention
const KEYWORD_SPIKE_CACHE_TTL_S = 600;
const KEYWORD_SPIKE_MAX_STORIES = 800;
const KEYWORD_SPIKE_MAX_STORED = 25;
const DIGEST_ACCUMULATOR_KEY_MCP = 'digest:accumulator:v1:full:en';

// Full-variant digest category keys (VARIANT_FEEDS.full). Kept as a local
// enum so Edge MCP tools never import server/ — parity with _feeds.ts is
// asserted by tests/agent-commodities-news-parity.test.mts adjacent coverage
// and the tools/list enum check in mcp-nlp-tools.test.mjs.
const FULL_DIGEST_CATEGORIES = [
  'politics', 'us', 'europe', 'middleeast', 'tech', 'ai', 'finance',
  'commodities', 'gov', 'africa', 'latam', 'asia', 'energy', 'thinktanks',
  'crisis', 'layoffs', 'intel',
] as const;
const FULL_DIGEST_CATEGORY_DESC =
  'Restrict to one full-digest category: ' +
  FULL_DIGEST_CATEGORIES.join(', ') +
  '. Echoed as `category` in the result; an unknown value yields headlineCount 0 and a `note` listing categories present in the current digest.';

function nlpClampInt(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isInteger(value)
    ? Math.min(max, Math.max(min, value as number))
    : fallback;
}

function patternEntityKind(value: string): 'cve' | 'apt' | 'fin' | 'leader' {
  if (/^cve-/i.test(value)) return 'cve';
  if (/^apt\d+$/i.test(value)) return 'apt';
  if (/^fin\d+$/i.test(value)) return 'fin';
  return 'leader';
}

type NlpDigestCategoryGroup = {
  items?: Array<{
    source?: string; title?: string; link?: string; publishedAt?: number;
    isAlert?: boolean;
    threat?: { level?: string; category?: string; confidence?: number; source?: string };
  }>;
};

type NlpDigestFetch = {
  items: NewsItemCore[];
  generatedAt: string;
  /** Applied category filter, or null when aggregating every full-digest bucket. */
  category: string | null;
  /** Present when a non-empty category filter did not match any digest key. */
  note?: string;
};

// Caching asymmetry among these four tools is deliberate. get_keyword_spikes
// caches its result because it fans out across many Redis round trips over a
// corpus that changes slowly. extract_entities and get_news_clusters compute
// in low milliseconds over a digest that is ALREADY Redis-cached upstream on a
// ~15-minute cadence, so a second cache layer would add keys, a TTL to reason
// about, and a staleness surface without a matching win — and would make the
// tools lag the dashboard they are supposed to mirror.

/**
 * Recent-headline corpus for the no-text extract_entities mode and
 * get_news_clusters: the canonical full/en feed digest (~150-200 titles).
 * Digest items carry no per-source tier, so every item gets a neutral tier
 * and the shared algorithm's primary selection falls back to recency.
 *
 * When `category` is set, only that digest bucket is scanned. A miss
 * (typo or pre-deploy cache) returns zero items plus a `note` that lists
 * the keys present in the current snapshot so agents can self-correct —
 * empty-but-valid buckets stay silent (headlineCount 0, no note).
 */
async function fetchNlpDigestItems(
  base: string,
  context: Parameters<typeof buildAuthHeaders>[0],
  category = '',
): Promise<NlpDigestFetch> {
  const digestUrl = `${base}/api/news/v1/list-feed-digest?variant=full&lang=en`;
  const auth = await buildAuthHeaders(context, 'GET', digestUrl, null);
  const res = await fetch(digestUrl, {
    headers: { ...auth, 'User-Agent': NLP_UA },
    signal: AbortSignal.timeout(NLP_DIGEST_TIMEOUT_MS),
  });
  assertToolFetchOk(res, 'list-feed-digest');
  const body = await res.json() as {
    categories?: Record<string, NlpDigestCategoryGroup>;
    generatedAt?: string;
  };

  const seen = new Set<string>();
  const items: NewsItemCore[] = [];
  const categories = body.categories ?? {};
  const availableCategories = Object.keys(categories).sort();
  let groups: NlpDigestCategoryGroup[];
  let note: string | undefined;

  if (!category) {
    groups = Object.values(categories);
  } else if (Object.prototype.hasOwnProperty.call(categories, category)) {
    groups = [categories[category]!];
  } else {
    groups = [];
    // Prefer the live snapshot keys so agents see what this cycle actually
    // carries; fall back to the static enum when the digest is empty.
    const listed = availableCategories.length > 0
      ? availableCategories.join(', ')
      : FULL_DIGEST_CATEGORIES.join(', ');
    note = `Unknown digest category "${category}". Available: ${listed}.`;
  }

  for (const group of groups) {
    for (const raw of group.items ?? []) {
      if (!raw?.title || !raw.source) continue;
      const key = raw.link || `${raw.source}|${raw.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        source: raw.source,
        title: raw.title,
        link: raw.link ?? '',
        pubDate: new Date(Number(raw.publishedAt) || 0),
        isAlert: raw.isAlert === true,
        tier: 3,
        threat: raw.threat ? {
          level: protoThreatLevelToLabel(raw.threat.level),
          category: (raw.threat.category ?? 'general') as NonNullable<NewsItemCore['threat']>['category'],
          confidence: typeof raw.threat.confidence === 'number' ? raw.threat.confidence : 0.5,
          source: raw.threat.source === 'ml' || raw.threat.source === 'llm' ? raw.threat.source : 'keyword',
        } : undefined,
      });
    }
  }
  return {
    items,
    generatedAt: body.generatedAt ?? '',
    category: category || null,
    ...(note ? { note } : {}),
  };
}

function nlpRegistryEntities(titles: string[], limit: number) {
  const registryStats = new Map<string, { name: string; type: string; count: number; totalConfidence: number }>();
  const patternStats = new Map<string, number>();
  for (const title of titles) {
    for (const entity of extractEntitiesFromTitle(title)) {
      const stats = registryStats.get(entity.entityId)
        ?? { name: entity.name, type: getEntityById(entity.entityId)?.type ?? 'company', count: 0, totalConfidence: 0 };
      stats.count += 1;
      stats.totalConfidence += entity.confidence;
      registryStats.set(entity.entityId, stats);
    }
    for (const value of extractPatternEntities(title)) {
      patternStats.set(value, (patternStats.get(value) ?? 0) + 1);
    }
  }
  return {
    entities: Array.from(registryStats.entries())
      .map(([entityId, stats]) => ({
        entityId,
        name: stats.name,
        type: stats.type,
        mentionCount: stats.count,
        avgConfidence: Math.round((stats.totalConfidence / stats.count) * 100) / 100,
      }))
      .sort((a, b) => b.mentionCount - a.mentionCount || a.entityId.localeCompare(b.entityId))
      .slice(0, limit),
    patternEntities: Array.from(patternStats.entries())
      .map(([value, mentionCount]) => ({ value, kind: patternEntityKind(value), mentionCount }))
      .sort((a, b) => b.mentionCount - a.mentionCount || a.value.localeCompare(b.value))
      .slice(0, limit),
  };
}

export const NLP_TOOLS: ToolDef[] = [
  {
    name: 'classify_event',
    _outputBudgetBytes: 4096,
    description: 'Classify a supplied news headline or short text into a threat category and severity via the enum-validated WorldMonitor event classifier (temperature-0, 24h-cached per title, never free-form LLM output). Input is capped at 500 characters. classification is null when the classifier cannot produce an enum-valid result.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: CLASSIFY_TEXT_MAX_CHARS, description: 'Headline or short excerpt to classify (1-500 characters). Longer input is rejected, not truncated.' },
      },
      required: ['text'],
    },
    outputSchema: {
      type: 'object',
      required: ['classification'],
      properties: {
        classification: {
          type: ['object', 'null'],
          description: 'null when the classifier could not produce an enum-valid result for this text.',
          required: ['category', 'level', 'severity', 'confidence'],
          properties: {
            category: {
              type: 'string',
              enum: CLASSIFY_CATEGORIES,
            },
            level: { type: 'string', enum: CLASSIFY_LEVELS },
            severity: {
              type: 'string',
              enum: CLASSIFY_SEVERITIES,
            },
            confidence: { type: 'number' },
          },
        },
        error: { type: 'string', description: 'Present instead of a result when input validation fails.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const text = typeof params.text === 'string' ? params.text.trim() : '';
      if (!text) return { classification: null, error: 'text is required (a non-empty string of at most 500 characters)' };
      if (text.length > CLASSIFY_TEXT_MAX_CHARS) {
        return { classification: null, error: `text exceeds the ${CLASSIFY_TEXT_MAX_CHARS}-character limit; send a headline-sized excerpt` };
      }
      const url = `${base}/api/intelligence/v1/classify-event?title=${encodeURIComponent(text)}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': NLP_UA },
        // Matches the classify-event handler's own UPSTREAM_TIMEOUT_MS (25s)
        // and the sibling LLM tools below. A shorter client budget would abort
        // slow-but-successful cache-miss classifications the handler completes.
        signal: AbortSignal.timeout(25_000),
      });
      assertToolFetchOk(res, 'classify-event');
      const result = await res.json() as {
        classification?: { category?: string; subcategory?: string; severity?: string; confidence?: number };
      };
      const c = result.classification;
      if (
        !c
        || !CLASSIFY_CATEGORIES.includes(c.category ?? '')
        || !CLASSIFY_LEVELS.includes(c.subcategory ?? '')
        || !CLASSIFY_SEVERITIES.includes(c.severity ?? '')
        || typeof c.confidence !== 'number'
        || !Number.isFinite(c.confidence)
      ) {
        return { classification: null };
      }
      return {
        classification: {
          category: c.category,
          // The REST payload carries the fine-grained level in `subcategory`.
          level: c.subcategory,
          severity: c.severity,
          confidence: c.confidence,
        },
      };
    },
    _apiPaths: [
      'GET /api/intelligence/v1/classify-event',
    ],
  },
  {
    name: 'extract_entities',
    _outputBudgetBytes: 16384,
    description: 'Extract named entities deterministically — registry entities (companies, indices, commodities, crypto, sectors, countries) plus pattern entities (CVE IDs, APT/FIN threat-group designators, tracked world leaders). Supply text (max 2 KB) to extract from it, or omit text to aggregate entities across the current headline digest (optionally restricted with category, e.g. "commodities"). No LLM involved.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: EXTRACT_TEXT_MAX_CHARS, description: 'Optional text to extract from (max 2048 characters; longer input is rejected). When omitted, the tool aggregates entities across recent headlines.' },
        category: {
          type: 'string',
          enum: [...FULL_DIGEST_CATEGORIES],
          description: 'When text is omitted, ' + FULL_DIGEST_CATEGORY_DESC,
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum entities per list. Defaults to 20.' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      required: ['mode', 'entities', 'patternEntities'],
      properties: {
        mode: { type: 'string', description: '"text" when input text was supplied, "headlines" when aggregating the digest.' },
        entities: {
          type: 'array',
          description: 'Registry-matched entities. In text mode each match carries matchType/matchedText/confidence; in headlines mode entities aggregate to mentionCount/avgConfidence.',
          items: { type: 'object', properties: {
            entityId: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' },
            matchType: { type: 'string' }, matchedText: { type: 'string' }, confidence: { type: 'number' },
            mentionCount: { type: 'number' }, avgConfidence: { type: 'number' },
          } },
        },
        patternEntities: {
          type: 'array',
          items: { type: 'object', properties: {
            value: { type: 'string' }, kind: { type: 'string', description: 'cve, apt, fin, or leader.' }, mentionCount: { type: 'number' },
          } },
        },
        headlineCount: { type: 'number', description: 'Headlines scanned (headlines mode only).' },
        generatedAt: { type: 'string', description: 'Digest snapshot time (headlines mode only).' },
        category: { type: ['string', 'null'], description: 'Applied full-digest category filter in headlines mode; null when scanning every category. Omitted in text mode.' },
        note: { type: 'string', description: 'Present in headlines mode when category did not match any digest key (typo or missing bucket).' },
        error: { type: 'string', description: 'Present instead of a result when input validation fails.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params, base, context) => {
      // Validation failures keep every outputSchema-required member present so
      // schema-validating clients can parse the envelope (classify_event does
      // the same with `classification: null`).
      const invalid = (error: string) => ({ mode: 'text', entities: [], patternEntities: [], error });
      if (params.text !== undefined && typeof params.text !== 'string') {
        return invalid('text must be a string when provided');
      }
      const text = typeof params.text === 'string' ? params.text.trim() : '';
      if (text.length > EXTRACT_TEXT_MAX_CHARS) {
        return invalid(`text exceeds the ${EXTRACT_TEXT_MAX_CHARS}-character limit`);
      }
      const limit = nlpClampInt(params.limit, 1, 50, 20);

      if (text) {
        return {
          mode: 'text',
          entities: extractEntitiesFromTitle(text).slice(0, limit).map(entity => ({
            entityId: entity.entityId,
            name: entity.name,
            type: getEntityById(entity.entityId)?.type ?? 'company',
            matchType: entity.matchType,
            matchedText: entity.matchedText,
            confidence: entity.confidence,
          })),
          patternEntities: [...new Set(extractPatternEntities(text))]
            .slice(0, limit)
            .map(value => ({ value, kind: patternEntityKind(value) })),
        };
      }

      // Accept enum values plus non-enum strings so non-validating clients still
      // get a corrective note instead of a hard schema failure at the edge.
      const category = argStr(params.category);
      const digest = await fetchNlpDigestItems(base, context, category);
      const aggregated = nlpRegistryEntities(digest.items.map(item => item.title), limit);
      return {
        mode: 'headlines',
        headlineCount: digest.items.length,
        generatedAt: digest.generatedAt,
        category: digest.category,
        ...(digest.note ? { note: digest.note } : {}),
        ...aggregated,
      };
    },
    _apiPaths: [
      'GET /api/news/v1/list-feed-digest',
    ],
  },
  {
    name: 'get_news_clusters',
    _outputBudgetBytes: 32768,
    description: 'Current topic clusters over the live headline digest, computed with the same Jaccard clustering the dashboard uses. Optional category restricts clustering to one full-digest bucket (e.g. "commodities"). Each cluster reports its primary headline, member count, distinct sources, top keywords, threat level, and time span. Deterministic — no LLM.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum clusters returned. Defaults to 10.' },
        min_sources: { type: 'integer', minimum: 1, maximum: 10, description: 'Only return clusters carrying at least this many DISTINCT sources (outlets), not merely this many member headlines. Defaults to 1.' },
        category: {
          type: 'string',
          enum: [...FULL_DIGEST_CATEGORIES],
          description: FULL_DIGEST_CATEGORY_DESC,
        },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      required: ['clusters', 'totalClusters', 'headlineCount', 'generatedAt', 'category'],
      properties: {
        clusters: {
          type: 'array',
          items: { type: 'object', properties: {
            id: { type: 'string' },
            title: { type: 'string', description: 'Primary headline. Server-side primary selection is recency-based: digest items carry no per-source tier.' },
            primarySource: { type: 'string' }, link: { type: 'string' },
            memberCount: { type: 'number', description: 'Headlines in this cluster (one outlet can contribute several).' },
            distinctSourceCount: { type: 'number', description: 'Distinct outlets covering the cluster — the corroboration signal min_sources filters on.' },
            sources: { type: 'array', items: { type: 'string' }, description: 'Distinct source names (up to 8).' },
            topKeywords: { type: 'array', items: { type: 'string' } },
            isAlert: { type: 'boolean' },
            threatLevel: { type: 'string' }, threatCategory: { type: 'string' },
            firstSeen: { type: 'string' }, lastUpdated: { type: 'string' },
          } },
        },
        totalClusters: { type: 'number', description: 'Cluster count before limit/min_sources filtering.' },
        headlineCount: { type: 'number' },
        generatedAt: { type: 'string' },
        category: { type: ['string', 'null'], description: 'Applied full-digest category filter; null when clustering every category.' },
        note: { type: 'string', description: 'Present when category did not match any digest key (typo or missing bucket).' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params, base, context) => {
      const limit = nlpClampInt(params.limit, 1, 25, 10);
      const minSources = nlpClampInt(params.min_sources, 1, 10, 1);
      const category = argStr(params.category);
      const digest = await fetchNlpDigestItems(base, context, category);
      const clusters = clusterNewsCore(digest.items, () => 3);
      const projected = clusters.map(cluster => {
        const sources = [...new Set(cluster.allItems.map(item => item.source))];
        return {
          id: cluster.id,
          title: cluster.primaryTitle,
          primarySource: cluster.primarySource,
          link: cluster.primaryLink,
          memberCount: cluster.sourceCount,
          // Corroboration is distinct outlets, not headline count — one outlet
          // can file several near-identical headlines into the same cluster.
          distinctSourceCount: sources.length,
          sources: sources.slice(0, 8),
          topKeywords: topClusterKeywords(cluster, 5),
          isAlert: cluster.isAlert,
          threatLevel: cluster.threat?.level ?? 'info',
          threatCategory: cluster.threat?.category ?? 'general',
          firstSeen: cluster.firstSeen.toISOString(),
          lastUpdated: cluster.lastUpdated.toISOString(),
        };
      });
      return {
        clusters: projected
          .filter(cluster => cluster.distinctSourceCount >= minSources)
          .slice(0, limit),
        totalClusters: clusters.length,
        headlineCount: digest.items.length,
        generatedAt: digest.generatedAt,
        category: digest.category,
        ...(digest.note ? { note: digest.note } : {}),
      };
    },
    _apiPaths: [
      'GET /api/news/v1/list-feed-digest',
    ],
  },
  {
    name: 'get_keyword_spikes',
    _outputBudgetBytes: 16384,
    description: 'Trending keyword, CVE, and APT/FIN threat-group spikes versus baseline, using the same term-candidacy and spike-decision math as the dashboard. Baseline derives from the 48-hour story accumulator (per-window story rate), not the dashboard\'s incremental 7-day client history. Results are cached for 10 minutes. Deterministic — no LLM.',
    inputSchema: {
      type: 'object',
      properties: {
        window_hours: { type: 'integer', minimum: 1, maximum: 12, description: 'Recent window to test for spikes. Defaults to 2.' },
        min_count: { type: 'integer', minimum: 2, maximum: 20, description: 'Minimum recent-window story count for a term to spike. Defaults to 5.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum spikes returned. Defaults to 10.' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      required: ['spikes', 'window_hours', 'baseline_hours', 'story_count', 'sample_truncated', 'generatedAt'],
      properties: {
        spikes: {
          type: 'array',
          items: { type: 'object', required: [
            'term', 'count', 'baseline', 'multiplier', 'uniqueSources', 'sampleHeadlines',
          ], properties: {
            term: { type: 'string' },
            count: { type: 'number', description: 'Distinct stories mentioning the term inside the recent window.' },
            baseline: { type: 'number', description: 'Per-window story rate over the exact sampled pre-window duration (see baseline_hours). 0 means this term was absent from the available baseline cohort.' },
            multiplier: { type: 'number', description: 'count / baseline; 0 when the term has no baseline mentions.' },
            uniqueSources: { type: 'number' },
            sampleHeadlines: { type: 'array', items: { type: 'string' } },
          } },
        },
        window_hours: { type: 'number' },
        baseline_hours: { type: 'number', description: 'Exact hours in the sampled pre-window baseline cohort. 0 means no baseline was available and spikes is empty.' },
        story_count: { type: 'number', description: 'Stories this computation saw across the separately bounded recent and baseline cohorts.' },
        sample_truncated: { type: 'boolean', description: 'True when either bounded cohort hit its 800-story cap.' },
        generatedAt: { type: 'string' },
        note: { type: 'string', description: 'Present when the accumulator was unavailable/empty or the story store was only partially readable.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params) => {
      const windowHours = nlpClampInt(params.window_hours, 1, 12, 2);
      const minCount = nlpClampInt(params.min_count, 2, 20, DEFAULT_MIN_SPIKE_COUNT);
      const limit = nlpClampInt(params.limit, 1, 25, 10);

      // v2 invalidates v1 payloads computed without an independently sampled
      // pre-window cohort (and before sample_truncated became required).
      const cacheKey = `intelligence:keyword-spikes:mcp:v2:${windowHours}h:${minCount}`;
      // A cache-read failure must degrade to live computation, not surface as a
      // tool error: readJsonFromUpstash throws on network failure (unlike
      // redisPipeline, which returns null).
      let cached: { spikes?: unknown[] } | null = null;
      try {
        cached = await readJsonFromUpstash(cacheKey) as { spikes?: unknown[] } | null;
      } catch {
        cached = null;
      }
      if (cached && Array.isArray(cached.spikes)) {
        return { ...cached, spikes: cached.spikes.slice(0, limit) };
      }

      const nowMs = Date.now();
      const windowMs = windowHours * 60 * 60 * 1000;
      const windowStart = nowMs - windowMs;
      const emptyResult = {
        spikes: [] as unknown[],
        window_hours: windowHours,
        baseline_hours: 0,
        story_count: 0,
        sample_truncated: false,
        generatedAt: new Date(nowMs).toISOString(),
      };

      // Read recent and pre-window cohorts independently. A single newest-first
      // cap can be consumed entirely by a busy recent window, which proves
      // nothing about whether older baseline rows exist.
      const zres = await redisPipeline([
        [
          'ZRANGE', DIGEST_ACCUMULATOR_KEY_MCP,
          String(nowMs), String(windowStart),
          'BYSCORE', 'REV', 'WITHSCORES', 'LIMIT', '0', String(KEYWORD_SPIKE_MAX_STORIES),
        ],
        [
          'ZRANGE', DIGEST_ACCUMULATOR_KEY_MCP,
          String(windowStart - 1), String(nowMs - KEYWORD_SPIKE_BASELINE_MS),
          'BYSCORE', 'REV', 'WITHSCORES', 'LIMIT', '0', String(KEYWORD_SPIKE_MAX_STORIES),
        ],
      ]) as Array<{ result?: unknown; error?: unknown }> | null;
      const recentFlat = zres?.[0]?.result;
      const baselineFlat = zres?.[1]?.result;
      if (!Array.isArray(recentFlat) || !Array.isArray(baselineFlat)) {
        return { ...emptyResult, note: 'story accumulator unavailable or empty' };
      }

      if (recentFlat.length === 0 && baselineFlat.length === 0) {
        return { ...emptyResult, note: 'story accumulator unavailable or empty' };
      }

      const parseEntries = (flat: unknown[]): {
        entries: Array<{ hash: string; lastSeenMs: number }>;
        malformed: boolean;
      } => {
        const entries: Array<{ hash: string; lastSeenMs: number }> = [];
        let malformed = flat.length % 2 !== 0;
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const rawHash = flat[i];
          const hash = typeof rawHash === 'string' ? rawHash : '';
          const lastSeenMs = Number(flat[i + 1]);
          if (hash && Number.isFinite(lastSeenMs)) entries.push({ hash, lastSeenMs });
          else malformed = true;
        }
        return { entries, malformed };
      };
      const recentParsed = parseEntries(recentFlat);
      const baselineParsed = parseEntries(baselineFlat);
      if (recentParsed.malformed || baselineParsed.malformed) {
        return { ...emptyResult, note: 'story accumulator returned an unreadable payload' };
      }

      const recentEntries = recentParsed.entries;
      const baselineEntries = baselineParsed.entries;
      const sampleTruncated = recentEntries.length >= KEYWORD_SPIKE_MAX_STORIES
        || baselineEntries.length >= KEYWORD_SPIKE_MAX_STORIES;
      if (baselineEntries.length === 0) {
        return {
          ...emptyResult,
          story_count: recentEntries.length,
          sample_truncated: sampleTruncated,
          note: 'baseline unavailable: no pre-window stories were present; spikes were not computed or cached',
        };
      }

      const oldestBaselineMs = baselineEntries[baselineEntries.length - 1]!.lastSeenMs;
      const baselineDurationMs = Math.min(
        KEYWORD_SPIKE_BASELINE_MS - windowMs,
        windowStart - oldestBaselineMs,
      );
      const entries = [...recentEntries, ...baselineEntries];

      // Any chunk failure means the corpus is incomplete: spikes computed from
      // it can be both false (missing baseline stories) and missing (dropped
      // recent stories), so the result is reported with a note and never cached.
      let degraded = false;
      const chunkInto = <T,>(items: T[], size: number): T[][] => {
        const chunks: T[][] = [];
        for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
        return chunks;
      };

      const titles = new Map<string, string>();
      const HMGET_CHUNK = 200;
      const hmgetChunks = chunkInto(entries, HMGET_CHUNK);
      const hmgetResults = await Promise.all(hmgetChunks.map(chunk => redisPipeline(
        chunk.map(entry => ['HMGET', `story:track:v1:${entry.hash}`, 'title']),
      ) as Promise<Array<{ result?: unknown }> | null>));
      hmgetChunks.forEach((chunk, chunkIdx) => {
        const res = hmgetResults[chunkIdx];
        if (!Array.isArray(res) || res.length !== chunk.length) degraded = true;
        chunk.forEach((entry, idx) => {
          const reply = res?.[idx];
          const fields = reply?.result;
          if (!reply || Object.prototype.hasOwnProperty.call(reply, 'error')
            || !Array.isArray(fields) || fields.length !== 1) {
            degraded = true;
            return;
          }
          const title = fields[0];
          if (typeof title !== 'string' || !title) {
            degraded = true;
            return;
          }
          titles.set(entry.hash, title);
        });
      });

      const recentHashes = entries
        .filter(entry => entry.lastSeenMs >= windowStart && titles.has(entry.hash))
        .map(entry => entry.hash);
      const sourcesByHash = new Map<string, string[]>();
      const SMEMBERS_CHUNK = 200;
      const smembersChunks = chunkInto(recentHashes, SMEMBERS_CHUNK);
      const smembersResults = await Promise.all(smembersChunks.map(chunk => redisPipeline(
        chunk.map(hash => ['SMEMBERS', `story:sources:v1:${hash}`]),
      ) as Promise<Array<{ result?: unknown }> | null>));
      smembersChunks.forEach((chunk, chunkIdx) => {
        const res = smembersResults[chunkIdx];
        if (!Array.isArray(res) || res.length !== chunk.length) degraded = true;
        chunk.forEach((hash, idx) => {
          const reply = res?.[idx];
          const members = reply?.result;
          if (!reply || Object.prototype.hasOwnProperty.call(reply, 'error')
            || !Array.isArray(members) || members.some(member => typeof member !== 'string')) {
            degraded = true;
            return;
          }
          sourcesByHash.set(hash, members);
        });
      });

      const stories = entries
        .filter(entry => titles.has(entry.hash))
        .map(entry => ({
          title: titles.get(entry.hash) as string,
          lastSeenMs: entry.lastSeenMs,
          sources: sourcesByHash.get(entry.hash) ?? [],
        }));

      const spikes = computeKeywordSpikesFromStories(stories, {
        nowMs,
        windowMs,
        baselineDurationMs,
        minSpikeCount: minCount,
        spikeMultiplier: DEFAULT_SPIKE_MULTIPLIER,
      }).slice(0, KEYWORD_SPIKE_MAX_STORED).map(spike => ({
        term: spike.term,
        count: spike.count,
        baseline: Math.round(spike.baseline * 100) / 100,
        multiplier: Math.round(spike.multiplier * 100) / 100,
        uniqueSources: spike.uniqueSources,
        sampleHeadlines: spike.sampleHeadlines,
      }));

      const payload = {
        ...emptyResult,
        spikes,
        story_count: stories.length,
        baseline_hours: baselineDurationMs / 3_600_000,
        sample_truncated: sampleTruncated,
      };
      if (degraded) {
        return {
          ...payload,
          spikes: payload.spikes.slice(0, limit),
          note: 'partial story-store read; spikes may be incomplete and were not cached',
        };
      }
      await setCachedData(cacheKey, payload, KEYWORD_SPIKE_CACHE_TTL_S);
      return { ...payload, spikes: payload.spikes.slice(0, limit) };
    },
    // Redis-only computation: no HTTP endpoint is proxied (types.ts case (a)).
    _apiPaths: [],
  },
];
