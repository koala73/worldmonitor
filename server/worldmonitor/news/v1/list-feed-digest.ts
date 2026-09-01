import type {
  ServerContext,
  ListFeedDigestRequest,
  ListFeedDigestResponse,
  CategoryBucket,
  NewsItem as ProtoNewsItem,
  ThreatLevel as ProtoThreatLevel,
  StoryMeta as ProtoStoryMeta,
  StoryPhase as ProtoStoryPhase,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import {
  cachedFetchJsonWithMeta,
  getCachedJson,
  setCachedJson,
  getCachedJsonBatch,
  readCachedJson,
  runRedisPipeline,
  runRedisTransaction,
  REDIS_PIPELINE_TIMEOUT_MS,
} from '../../../_shared/redis';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../../../../api/_sentry-edge.js';
import {
  classifyStaleSnapshot,
  filterRevokedUrls,
  type RevocationRead,
  type StaleReason,
} from './_lastgood';
import {
  beginDigestAttempt,
  completeDigestAttempt,
  publishAcceptedSnapshot,
  publishFailedAttempt,
  readAcceptedSnapshot,
  readRevokedUrlSet,
  recoverFailedAttempt,
  shouldStartDigestAttempt,
  __testing__ as lastGoodStoreTesting,
  type FailedDigestAttempt,
  type LastGoodRead,
} from './_lastgood-store';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { sha256Hex } from '../../../_shared/hash';
import { CHROME_UA } from '../../../_shared/constants';
import {
  isServerFeedReachableForLanguage,
  orderServerFeedEntries,
  VARIANT_FEEDS,
  INTEL_SOURCES,
  type ServerFeed,
} from './_feeds';
import { classifyByKeyword, hasHistoricalMarker, type ThreatLevel } from './_classifier';
import {
  buildDigestCoverage,
  cachedAttemptFrom,
  classifyFeedAttempt,
  interleaveByCategory,
  resolveTerminalFetchFailure,
  runFeedAttemptBatches,
  summarizeFeedAttempts,
  type FeedFetchAttempt,
} from './_attempts';
import {
  FORECAST_EVIDENCE_KEY,
  FORECAST_EVIDENCE_COVERAGE_KEY,
  FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
  FORECAST_EVIDENCE_TTL_S,
  accumulatorPruneBounds,
  advanceForecastEvidenceCoverage,
  buildForecastEvidenceMember,
  evidencePruneBounds,
  forecastEvidenceCoversWindow,
  forecastEvidenceRecordKey,
  isEligibleForecastEvidence,
  parseForecastEvidenceCoverage,
} from '../../../../scripts/_forecast-evidence-archive.mjs';
import { assignStoryIdentity, adoptExistingCanonical } from './dedup.mjs';
// @ts-expect-error — JS module, no declaration file
import { STORY_ALIAS_PUBLISH_SCRIPT } from '../../../../shared/story-alias-publish-script.mjs';
import { classifyOpinion } from '../../../_shared/opinion-classifier.js';
import { classifyFeelGood } from '../../../_shared/feelgood-classifier.js';
import { classifyEphemeralLiveCoverage } from '../../../../shared/ephemeral-live-classifier.js';
import { deriveCoreStoryPhase } from '../../../../shared/story-phase.js';
import { buildTickerDictionary, extractTickers } from '../../../../shared/ticker-extract.js';
import stocksData from '../../../../shared/stocks.json';
import { buildClassifyCacheKey } from '../../intelligence/v1/_shared';
import { getSourceTier, hasSourceTier } from '../../../_shared/source-tiers';
import {
  getSourcePropagandaRisk,
  hasReviewedPropagandaRisk,
} from '../../../../shared/source-provenance';
import { computeCredibilityScore } from '../../../../shared/news-credibility.js';
import {
  STORY_TRACK_KEY,
  STORY_SOURCES_KEY,
  STORY_PEAK_KEY,
  STORY_ALIAS_KEY,
  STORY_ALIAS_PUBLICATION_LOCK_KEY,
  DIGEST_ACCUMULATOR_KEY,
  STORY_TTL,
  DIGEST_ACCUMULATOR_TTL,
} from '../../../_shared/cache-keys';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';
import diplomacyKeywordsData from '../../../../shared/diplomacy-keywords.json';
// #6428: entity corroboration must count publishers, not feed labels.
import {
  MIN_CORROBORATING_PUBLISHERS,
  PUBLISHER_FAMILIES,
  publisherFamilyFor,
  publisherFamilyForItem,
} from '../../../../shared/publisher-families.js';

const RSS_ACCEPT = 'application/rss+xml, application/xml, text/xml, */*';

const VALID_VARIANTS = new Set(['full', 'tech', 'finance', 'happy', 'commodity']);
const fallbackDigestCache = new Map<string, { data: ListFeedDigestResponse; ts: number }>();
const ITEMS_PER_FEED = 5;
const MAX_ITEMS_PER_CATEGORY = 20;
const FEED_TIMEOUT_MS = 8_000;
// Vercel Edge functions have a 25s initial-response ceiling. The digest
// must fail closed to the warmed in-isolate fallback before the platform does.
const VERCEL_INITIAL_RESPONSE_LIMIT_MS = 25_000;
const DIGEST_RESPONSE_TIMEOUT_MS = 14_000;
const POST_FETCH_HEADROOM_MS = 15_000;
const RESPONSE_GUARD_BAND_MS = 3_000;
const RESPONSE_DEADLINE_MS = VERCEL_INITIAL_RESPONSE_LIMIT_MS - RESPONSE_GUARD_BAND_MS;
const OVERALL_DEADLINE_MS = VERCEL_INITIAL_RESPONSE_LIMIT_MS - POST_FETCH_HEADROOM_MS;
const BATCH_CONCURRENCY = 20;
const MAX_REDIS_PIPELINE_COMMANDS = 1000;
const STORY_BATCH_SIZE = 80; // bounds per-story work; command chunks enforce the hard cap
// #4925 item 1: canonical adoption reads two commands per member hash
// (alias GET + track HMGET), so the hash budget is half the command budget.
const ADOPTION_BATCH_SIZE = 400;
// Keep adoption inside the cold digest response budget, with the same guard
// band reserved for final assembly and cache writes.
const ADOPTION_DEADLINE_MS = DIGEST_RESPONSE_TIMEOUT_MS - RESPONSE_GUARD_BAND_MS;
// #7084: latest wall-clock point at which the best-effort snapshot publish may
// still start. Derivation: 25s platform ceiling - 3s guard band - the
// publish's own worst case (one 5s EVAL pipeline timeout).
const PUBLISH_DEADLINE_CUTOFF_MS =
  VERCEL_INITIAL_RESPONSE_LIMIT_MS - RESPONSE_GUARD_BAND_MS - 5_000;

async function settleBeforeDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  fallback: T,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type DigestFeedEntry = { attemptId: string; category: string; feed: ServerFeed };

/**
 * #7084: apply the revocation set to a whole digest body at SERVE time.
 * Shared by every path that can return bytes — fresh build, digest cache hit,
 * durable snapshot, warm-isolate replay — so an operator's SADD takes effect
 * on the next request rather than on the next rebuild. Returns the original
 * object untouched when nothing was suppressed, so the common path stays free.
 */
function suppressRevoked(
  data: ListFeedDigestResponse,
  revoked: ReadonlySet<string>,
): { data: ListFeedDigestResponse; dropped: number } {
  if (revoked.size === 0) return { data, dropped: 0 };
  const categories: Record<string, { items: ProtoNewsItem[] }> = {};
  let dropped = 0;
  for (const [category, bucket] of Object.entries(data.categories ?? {})) {
    const { kept, dropped: n } = filterRevokedUrls(
      (bucket?.items ?? []) as Array<{ link?: string }>,
      revoked,
    );
    dropped += n;
    categories[category] = { items: kept as ProtoNewsItem[] };
  }
  if (dropped === 0) return { data, dropped: 0 };
  const next = { ...data, categories } as ListFeedDigestResponse;
  // Counts must describe the body actually served, per the DigestCoverage
  // contract ("Items served in this response, after every gate").
  if (next.coverage) {
    const items = Object.values(categories).flatMap((b) => b.items);
    next.coverage = {
      ...next.coverage,
      itemsServed: items.length,
      publisherCount: new Set(items.map((i) => publisherFamilyFor(i?.source ?? ''))).size,
    };
  }
  return { data: next, dropped };
}

/**
 * #7084: durable last-good serving, tried before the warm-isolate cache on the
 * degraded paths. Returns a stale-marked response when Redis is readable and
 * the accepted snapshot is inside the six-hour contract, else null so the
 * caller falls through to the isolate tier and finally the explicit
 * unavailable response.
 */
async function serveLastGood(
  variant: string,
  lang: string,
  reason: StaleReason,
  attemptedAt: string,
  // Shared with the isolate tier so a degraded request pays for ONE
  // revocation read, not one per tier — two serial pipeline reads were part
  // of how the worst-case degraded path blew through the 25s Edge budget.
  revokedPromise: Promise<RevocationRead> = readRevokedUrlSet(),
  snapshotPromise: Promise<LastGoodRead<ListFeedDigestResponse>> = readAcceptedSnapshot(variant, lang),
): Promise<ListFeedDigestResponse | null> {
  const stored = await snapshotPromise;
  if (!stored.readable) {
    console.warn(`[digest-serving] tier=durable result=redis-unreadable variant=${variant} lang=${lang}`);
    return null;
  }
  const snapshot = stored.snapshot;

  // Everything below runs over a body deserialized from Redis. A malformed
  // shape must fail THIS tier, never the request — a throw escaping here
  // reaches the handler's catch, whose own degraded path re-throws on the
  // same body, and the second throw escapes as a 500 with every fallback
  // still unserved.
  try {
    const now = Date.now();

    const revoked = await revokedPromise;
    if (!revoked.readable) {
      // Fail CLOSED on replay: revocation is a content-suppression control,
      // and no path may serve unfiltered content when operator suppressions
      // cannot be checked.
      // `tier=` lines are hand-offs, not outcomes: only the tier that actually
      // returns a body emits `outcome=`. Counting `outcome=` occurrences used
      // to double-count isolate-fallback and record one request as two
      // different outcomes.
      console.warn(
        `[digest-serving] tier=durable result=revocations-unreadable variant=${variant} lang=${lang}`,
      );
      captureSilentError(new Error('revocation set unreadable on durable serving path'), {
        tags: { surface: 'news', component: 'digest-lastgood', stage: 'revocation-read', variant, lang },
        fingerprint: ['digest-lastgood', 'revocations-unreadable-durable'],
      });
      return null;
    }

    // Revoke BEFORE the servability gate: a snapshot whose every item has
    // been revoked is not servable content, and classifying the unfiltered
    // body would let it through with counts describing items nobody receives.
    const suppressed = snapshot ? suppressRevoked(snapshot.data, revoked.urls) : null;

    const verdict = classifyStaleSnapshot(
      snapshot && suppressed ? { acceptedAt: snapshot.acceptedAt, data: suppressed.data } : null,
      now,
    );
    if (!verdict.serve) {
      console.log(`[digest-serving] tier=durable result=${verdict.outcome} reason=${reason} variant=${variant} lang=${lang}`);
      return null;
    }

    console.log(
      `[digest-serving] outcome=stale reason=${reason} age_s=${verdict.ageSeconds} ` +
        `variant=${variant} lang=${lang} revoked_urls=${revoked.urls.size} ` +
        `revoked_dropped=${suppressed!.dropped}`,
    );
    // attemptedAt names the FAILED attempt, not the content.
    return markFallbackCoverageStale(suppressed!.data, attemptedAt, {
      ageSeconds: verdict.ageSeconds,
      reason,
    });
  } catch (err) {
    console.warn(`[digest-serving] tier=durable result=snapshot-malformed variant=${variant} lang=${lang}`);
    captureSilentError(err, {
      tags: { surface: 'news', component: 'digest-lastgood', stage: 'serve-classify', variant, lang },
      fingerprint: ['digest-lastgood', 'serve-classify-threw'],
    });
    return null;
  }
}

/**
 * Stamp a replayed body with the coverage that describes how it is being
 * served. Every replay tier goes through here — the durable snapshot (#7084)
 * and the warm in-isolate cache — so no tier can go out wearing the state its
 * original build stamped on it, and the stale fields have exactly one
 * implementation.
 *
 * `staleAgeSeconds`/`staleReason` are 0/'' for the isolate tier, which knows
 * only that the content is old, not how old relative to an acceptance.
 */
function markFallbackCoverageStale(
  fallback: ListFeedDigestResponse,
  attemptedAt: string,
  stale: { ageSeconds: number; reason: string } = { ageSeconds: 0, reason: '' },
): ListFeedDigestResponse {
  const coverage = fallback.coverage;
  if (coverage) {
    return {
      ...fallback,
      coverage: {
        ...coverage,
        state: 'stale',
        attemptedAt,
        servedStale: true,
        staleAgeSeconds: stale.ageSeconds,
        staleReason: stale.reason,
      },
    };
  }

  // Redis can still contain a digest written before the coverage field was
  // introduced. Keep that retained content useful, but do not describe it as
  // current. Only content-derived counts can be reconstructed here.
  // `bucket?.` / `item?.` guards throughout: this body was read back from
  // Redis, and a malformed bucket must degrade the counts, not throw out of
  // the last serving tier standing.
  const categoryEntries = Object.entries(fallback.categories ?? {});
  const items = categoryEntries.flatMap(([, bucket]) => bucket?.items ?? []);
  const categoryStates = Object.fromEntries(
    categoryEntries.map(([category, bucket]) => [category, (bucket?.items?.length ?? 0) > 0 ? 'ok' : 'missing']),
  );
  return {
    ...fallback,
    coverage: {
      state: 'stale',
      attemptedAt,
      itemsServed: items.length,
      publisherCount: new Set(items.map(item => publisherFamilyFor(item?.source ?? ''))).size,
      feedTotal: 0,
      feedCompleted: 0,
      categoryTotal: Object.keys(categoryStates).length,
      categoryCompleted: Object.values(categoryStates).filter(state => state === 'ok').length,
      categoryStates,
      droppedFeedCap: 0,
      droppedUndated: 0,
      droppedFreshness: 0,
      droppedCategoryCap: 0,
      servedStale: true,
      staleAgeSeconds: stale.ageSeconds,
      staleReason: stale.reason,
    },
  };
}

// U3 — hard freshness floor (default 96h, env override NEWS_MAX_AGE_HOURS).
// Items older than this are dropped before scoring. The 24h `recencyScore`
// component already treats anything older than 24h as zero recency, so the
// freshness floor is purely a "don't surface week-old news" guard, not a
// scoring input.
//
// 2026-05-03: bumped 48 → 96 after a production incident where every
// single-source category panel (GitHub Trending: github.blog/feed/, Product
// Hunt: producthunt.com/feed) went UNAVAILABLE over a weekend. Both feeds
// publish on a weekday cadence; over a Sat-Sun window their newest item
// sits at ~50-70h old, which the 48h floor wholesale dropped → category
// renders zero items → panel reads "UNAVAILABLE". 96h covers a Fri→Mon
// weekend with margin so we don't flip empty on Sunday-night dashboard
// checks. The 24h recencyScore still naturally de-ranks 48-96h items vs
// anything fresher, so the visible-but-de-ranked outcome is correct:
// better than "no news" but lower priority than today.
//
// Out-of-range / unparseable env values fall back to the default silently.
// See R3 in docs/plans/2026-04-26-001-fix-brief-static-page-contamination-plan.md.
function resolveMaxAgeMs(): number {
  const raw = Number.parseInt(process.env.NEWS_MAX_AGE_HOURS ?? '', 10);
  const hours = Number.isInteger(raw) && raw > 0 ? raw : 96;
  return hours * 60 * 60 * 1000;
}

const LEVEL_TO_PROTO: Record<ThreatLevel, ProtoThreatLevel> = {
  critical: 'THREAT_LEVEL_CRITICAL',
  high: 'THREAT_LEVEL_HIGH',
  medium: 'THREAT_LEVEL_MEDIUM',
  low: 'THREAT_LEVEL_LOW',
  info: 'THREAT_LEVEL_UNSPECIFIED',
};

/** Numeric severity values for importanceScore computation (0–100). */
const SEVERITY_SCORES: Record<ThreatLevel, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
  info: 0,
};

/**
 * Ordinal rank of each threat level, used by the LLM classify-cache
 * upgrade cap (U4). Cap = +2 tiers above the keyword classification.
 *
 * Rationale: keyword=info (no-match fallback at confidence 0.3) jumping
 * straight to high/critical is the static-institutional-page contamination
 * path; capping at info+2=medium blocks it. Cap behavior by keyword:
 *   info(0)+2=medium    — blocks info→{high,critical} (the contamination class)
 *   low(1)+2=high       — preserves low→{medium,high}; caps low→critical at high
 *   medium(2)+2=critical — preserves medium→{high,critical} (e.g. "Markets crash" → critical)
 *   high(3)+2=critical  — passes through (existing 0.9-confidence guard at
 *                         enrichWithAiCache also skips cache for keyword=critical)
 *
 * The keyword=low → LLM=critical case (capped at high) is the bounded
 * loss; logged on every cap-fire so operators can audit if any are real.
 * See R4 in the plan.
 */
const LEVEL_RANK: Record<ThreatLevel, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
const RANK_TO_LEVEL: ThreatLevel[] = ['info', 'low', 'medium', 'high', 'critical'];

/**
 * Cap an LLM-classified level to at most +2 tiers above the keyword level.
 * Returns the original `llmLevel` when within the cap, otherwise the
 * level at rank `keywordRank + 2`. Falls back to the keyword level when
 * the LLM level is unrecognized (defensive).
 */
function capLlmUpgrade(keywordLevel: ThreatLevel, llmLevel: string): ThreatLevel {
  const keywordRank = LEVEL_RANK[keywordLevel];
  const rawLlmRank = LEVEL_RANK[llmLevel as ThreatLevel];
  if (rawLlmRank == null) return keywordLevel;
  const cappedRank = Math.min(rawLlmRank, keywordRank + 2);
  return RANK_TO_LEVEL[cappedRank] ?? keywordLevel;
}

/**
 * Importance score component weights (must sum to 1.0).
 * Severity dominates because threat level is the primary signal.
 * Corroboration (independent sources) strongly validates an event.
 * Source tier boosts confidence. Recency is a minor tiebreaker.
 */
const SCORE_WEIGHTS = {
  severity: 0.55,
  sourceTier: 0.2,
  corroboration: 0.15,
  recency: 0.1,
} as const;

const DIPLOMACY_KEYWORDS: readonly string[] = diplomacyKeywordsData.diplomacyKeywords;
const FLASHPOINT_SCORING_KEYWORDS: readonly string[] = diplomacyKeywordsData.flashpointKeywords;
// JSON imports type each pair as `string[]` (length not statically tracked).
// The runtime shape is `[string, string]` — enforced by
// tests/diplomacy-keywords-parity.test.mjs against the canonical JSON.
const DIPLOMACY_FLASHPOINT_PAIRS: ReadonlyArray<readonly [string, string]> =
  diplomacyKeywordsData.diplomacyFlashpointPairs as unknown as ReadonlyArray<readonly [string, string]>;

// #4922a: compiled once — the company-name alternation regex is the
// expensive part of ticker extraction.
const TICKER_DICTIONARY = buildTickerDictionary(stocksData.symbols);

const DIPLOMACY_FLASHPOINT_BOOST = 18;
const ENTITY_CORROBORATION_SCORE_PER_SOURCE = 4;
const ENTITY_CORROBORATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const DIPLOMACY_SEVERITY_PROMOTION_MIN_TIER12_SOURCES = 3;


interface ParsedItem {
  source: string;
  // Originating publisher from the RSS <source> element ('' when absent).
  // Google News feeds — which back 154 of the 366 server digest labels —
  // stamp it per item, naming the outlet that actually wrote the story.
  // Corroboration counting may prefer this over `source` only when the parser
  // marks the feed as an explicitly configured trusted aggregator (#6430).
  // Internal to the digest build; `source` stays what the UI credits, links,
  // and tiers.
  originPublisher: string;
  originPublisherTrusted: boolean;
  title: string;
  link: string;
  publishedAt: number;
  isAlert: boolean;
  level: ThreatLevel;
  category: string;
  confidence: number;
  classSource: 'keyword' | 'keyword-historical-downgrade' | 'llm';
  importanceScore: number;
  credibilityScore: number;
  corroborationCount: number;
  entityCorroborationCount: number;
  titleHash?: string;
  lang: string;
  // Cleaned RSS/Atom article description: HTML-stripped, entity-decoded,
  // whitespace-normalised, clipped to MAX_DESCRIPTION_LEN. Empty string when
  // absent, too short, or indistinguishable from the headline. Grounding input
  // for brief / whyMatters / SummarizeArticle LLMs.
  description: string;
  // Non-event brief classification (classifyOpinion over title + link +
  // description). Persisted on the legacy `isOpinion` story:track:v1 field
  // so buildDigest can exclude op-ed/column and historical-explainer content
  // — the brief is event-driven intelligence, not an editorial or look-back
  // feed. See
  // docs/plans/2026-05-14-001-…-plan.md (F3). story:track rows feed more
  // than the brief, so this STAMPS rather than drops — only buildDigest
  // filters on it.
  isOpinion: boolean;
  // Feel-good / lifestyle classification (classifyFeelGood over title +
  // link + description). Sibling stamp to isOpinion — same persistence,
  // same buildDigest read-path filter. The brief is event-driven; a
  // vintage-warplane veterans' reunion in a 9,800-person town is not an
  // event. See docs/plans/2026-05-17-001-fix-feelgood-lifestyle-filter-plan.md
  // (Veterans-warplanes anchor case, May 17 0802 brief).
  isFeelGood: boolean;
  // Ephemeral live-programming classification. "WATCH LIVE: ..." and
  // live briefing/hearing previews are not durable event stories for a
  // delayed digest/brief, even when conflict vocabulary makes them score high.
  // Stamped here and re-classified by buildDigest for pre-stamp residue.
  isEphemeralLiveCoverage: boolean;
  // #4922a: stock tickers extracted at parse time from title + description
  // (cashtags + shared/stocks.json company names). Uppercase, deduped,
  // ≤8 (proto NewsItem.tickers max_items=8). Optional so items rehydrated
  // from pre-rollout cache rows stay valid; toProtoItem defaults to [].
  tickers?: string[];
}

type CredibilitySourceItem = Pick<ParsedItem, 'source' | 'originPublisher'> & {
  originPublisherTrusted?: boolean;
};

function resolveCredibilitySourceName(item: CredibilitySourceItem): string {
  const originPublisher = item.originPublisherTrusted === true
    && typeof item.originPublisher === 'string'
    ? item.originPublisher.trim()
    : '';
  const source = typeof item.source === 'string' ? item.source.trim() : '';
  const rawName = originPublisher || source;
  const family = publisherFamilyFor(rawName);
  const familyEntry = PUBLISHER_FAMILIES[family];
  const candidates = [
    rawName,
    familyEntry?.publisher,
    ...(familyEntry?.labels ?? []),
  ].filter((candidate): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0);

  // Prefer one identity reviewed by both registries so tier and risk describe
  // the same publisher; then degrade toward whichever curated signal exists.
  return candidates.find(candidate =>
    hasReviewedPropagandaRisk(candidate) && hasSourceTier(candidate))
    ?? candidates.find(hasReviewedPropagandaRisk)
    ?? candidates.find(hasSourceTier)
    ?? rawName;
}

// A story-track row is allowed to anchor a future cluster only after the
// current mention carries a server-known trust signal. Unknown/legacy rows
// fail closed; their firstSeen timestamp alone is never enough to seize a
// canonical identity.
const MAX_TRUSTED_ANCHOR_SOURCE_TIER = 2;

function isAnchorEligible(item: Pick<ParsedItem, 'source' | 'originPublisher' | 'corroborationCount'>): boolean {
  // `source` is the server-configured feed label. Do not use the RSS
  // `<source>`/originPublisher field for this gate: that field is upstream
  // content and therefore cannot elevate an otherwise unknown feed.
  return getSourceTier(item.source) <= MAX_TRUSTED_ANCHOR_SOURCE_TIER
    || (Number.isFinite(item.corroborationCount)
      && item.corroborationCount >= MIN_CORROBORATING_PUBLISHERS);
}

// Story identity calculates corroboration for the complete semantic cluster.
// Use that value while selecting a safe batch default instead of the parsed
// item's initial exact-title count, which is normally one before identity is
// applied back to every member.
function isIdentityAnchorEligible(
  item: Pick<ParsedItem, 'source' | 'originPublisher'>,
  corroborationCount: number,
): boolean {
  return isAnchorEligible({
    source: item.source,
    originPublisher: item.originPublisher,
    corroborationCount,
  });
}

function compareAnchorCandidates(a: ParsedItem, b: ParsedItem): number {
  const aTrusted = getSourceTier(a.source) <= MAX_TRUSTED_ANCHOR_SOURCE_TIER;
  const bTrusted = getSourceTier(b.source) <= MAX_TRUSTED_ANCHOR_SOURCE_TIER;
  if (aTrusted !== bTrusted) return aTrusted ? -1 : 1;
  if (a.publishedAt !== b.publishedAt) return a.publishedAt - b.publishedAt;
  if (a.title < b.title) return -1;
  if (a.title > b.title) return 1;
  return 0;
}

function computeItemCredibilityScore(
  item: CredibilitySourceItem,
  independentCorroborationCount: number,
): number {
  const sourceName = resolveCredibilitySourceName(item);
  return computeCredibilityScore({
    sourceTier: getSourceTier(sourceName),
    propagandaRisk: getSourcePropagandaRisk(sourceName).risk,
    independentCorroborationCount,
  });
}

const MAX_DESCRIPTION_LEN = 400;
const MIN_DESCRIPTION_LEN = 40;

const DESCRIPTION_TAG_PRIORITY = {
  rss: ['description', 'content:encoded'] as const,
  atom: ['summary', 'content'] as const,
};

interface ImportanceScoreContext {
  title?: string;
  classSource?: ParsedItem['classSource'] | string;
  entityCorroborationCount?: number;
}

function normalizeScoringText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Word-start containment in normalized text. Mirrors
// shared/brief-filter.js:containsKeywordToken — prevents 'pact' inside
// 'impact' (false positive) while still matching 'iran' inside
// 'iranian' (demonym preserved). PR #3909 review (P2).
function containsKeywordToken(text: string, kw: string): boolean {
  if (!kw) return false;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}`).test(text);
}

function hasAnySignal(text: string, keywords: readonly string[]): boolean {
  return keywords.some((kw) => containsKeywordToken(text, kw));
}

function hasDiplomacyFlashpointSignal(title: string | undefined): boolean {
  if (!title) return false;
  const text = normalizeScoringText(title);
  if (
    DIPLOMACY_FLASHPOINT_PAIRS.some(([entity, action]) =>
      containsKeywordToken(text, entity) && containsKeywordToken(text, action),
    )
  ) {
    return true;
  }
  return hasAnySignal(text, DIPLOMACY_KEYWORDS) && hasAnySignal(text, FLASHPOINT_SCORING_KEYWORDS);
}

function promoteDiplomacySeverity(
  level: ThreatLevel,
  title: string | undefined,
  tier12SourceCount: number,
): ThreatLevel {
  if (level === 'critical' || level === 'high') return level;
  if (!title || hasHistoricalMarker(title)) return level;
  const finite = Number.isFinite(tier12SourceCount) ? Number(tier12SourceCount) : 0;
  if (
    finite >= DIPLOMACY_SEVERITY_PROMOTION_MIN_TIER12_SOURCES &&
    hasDiplomacyFlashpointSignal(title)
  ) {
    return 'high';
  }
  return level;
}

function diplomacyFlashpointBoost(title: string | undefined): number {
  return hasDiplomacyFlashpointSignal(title) ? DIPLOMACY_FLASHPOINT_BOOST : 0;
}

function entityCorroborationScore(count: number | undefined): number {
  const finite = Number.isFinite(count) ? Number(count) : 0;
  return Math.min(Math.max(finite, 0), 5) * ENTITY_CORROBORATION_SCORE_PER_SOURCE;
}

function computeImportanceScore(
  level: ThreatLevel,
  source: string,
  corroborationCount: number,
  publishedAt: number,
  context: ImportanceScoreContext = {},
): number {
  const tier = getSourceTier(source);
  const tierScore = tier === 1 ? 100 : tier === 2 ? 75 : tier === 3 ? 50 : 25;
  const corroborationScore = Math.min(corroborationCount, 5) * 20;
  const ageMs = Date.now() - publishedAt;
  const recencyScore = Math.max(0, 1 - ageMs / (24 * 60 * 60 * 1000)) * 100;
  const base = Math.round(
    SEVERITY_SCORES[level] * SCORE_WEIGHTS.severity +
    tierScore * SCORE_WEIGHTS.sourceTier +
    corroborationScore * SCORE_WEIGHTS.corroboration +
    recencyScore * SCORE_WEIGHTS.recency,
  );
  return Math.round(
    base +
    diplomacyFlashpointBoost(context.title) +
    entityCorroborationScore(context.entityCorroborationCount),
  );
}

function createTimeoutLinkedController(parentSignal: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  // #7083: distinguish the per-feed timeout from the parent (global digest
  // deadline) abort so the attempt classifier can name the real cause.
  let perFeedTimeoutFired = false;
  const timeout = setTimeout(() => {
    perFeedTimeoutFired = true;
    controller.abort();
  }, FEED_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  parentSignal.addEventListener('abort', onAbort, { once: true });

  return {
    controller,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal.removeEventListener('abort', onAbort);
    },
    timedOut: () => perFeedTimeoutFired,
  };
}

/**
 * Sniff a response body to decide whether it looks like RSS/Atom/RDF.
 *
 * Some upstreams (Cloudflare-protected sites, captcha gateways, login walls)
 * return HTTP 200 with an HTML interstitial body when the requesting IP is
 * challenged — Vercel egress IPs are common targets. Without sniffing, the
 * caller forwards the HTML to parseRssXml, which finds zero `<item>` tags
 * and returns an empty ParseResult. That empty result then sits in Redis
 * cache for the full feed TTL (1h), pinning the panel to "No news available"
 * for an hour even after upstream recovers. Sniffing rejects these bodies
 * up front so the relay-fallback path fires and the cache stays clean.
 *
 * Heuristic:
 *   - Reject `<!DOCTYPE html>` / `<html ...>` (HTML wall pages)
 *   - Accept `<rss ...>` (RSS 2.0)
 *   - Accept `<feed ...>` (Atom 1.0)
 *   - Accept `<rdf:RDF ...>` (RSS 1.0 / Dublin Core RDF — Nature News,
 *     Asahi Shimbun, Slashdot, and other long-running feeds still emit
 *     this dialect; parseRssXml handles their `<item>` blocks fine)
 *   - Reject everything else as ambiguous (defensive — a feed without
 *     any of these signatures in the first 2KB is implausible)
 *
 * Exported for direct unit testing.
 */
export function looksLikeRssXml(text: string): boolean {
  const head = text.slice(0, 2048).toLowerCase();
  if (/<!doctype\s+html|<html[\s>]/.test(head)) return false;
  return /<rss[\s>]|<feed[\s>]|<rdf:rdf[\s>]/.test(head);
}

async function fetchRssText(
  url: string,
  signal: AbortSignal,
): Promise<{ text: string | null; failure: FeedFetchAttempt['failure'] }> {
  const { controller, cleanup, timedOut } = createTimeoutLinkedController(signal);

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': CHROME_UA,
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    if (!resp.ok) return { text: null, failure: 'direct-error' };
    const text = await resp.text();
    // Defensive: upstream may return HTTP 200 with an HTML interstitial
    // (Cloudflare bot challenge, captcha page). Reject up front so the
    // caller's relay fallback fires instead of caching an empty parse.
    if (!looksLikeRssXml(text)) return { text: null, failure: 'direct-error' };
    return { text, failure: null };
  } catch {
    return {
      text: null,
      failure: timedOut() ? 'per-feed-timeout' : signal.aborted ? 'deadline-abort' : 'direct-error',
    };
  } finally {
    cleanup();
  }
}

/**
 * Parser output: items that survived all parse-time gates plus per-feed
 * stats so the caller can classify feed health (e.g. silent zeroing from
 * an unrecognized date dialect — see U2 in
 * docs/plans/2026-04-26-001-fix-brief-static-page-contamination-plan.md).
 */
interface ParseResult {
  items: ParsedItem[];
  parsedTotal: number;     // count of <item>/<entry> blocks attempted
  droppedUndated: number;  // count dropped because every recognized date tag was empty/unparseable/future
  droppedFeedCap?: number; // #4920: items beyond ITEMS_PER_FEED, previously uncounted
  // #7083: how the fetch leg of this attempt actually ended. Absent on
  // cache entries written before the field existed.
  attempt?: FeedFetchAttempt;
}

// Cache TTLs: a successful parse (parsedTotal > 0) caches for an hour to
// match the existing aggressive-caching behaviour. A zero-from-zero result
// (no `<item>` tags found at all) caches for only 5 minutes — without this
// split, a single upstream-CF-challenge or transient outage would pin the
// panel to "No news available" for the full hour. 5min keeps load on
// upstream bounded while still recovering quickly when upstream heals.
const CACHE_TTL_HEALTHY_S = 3600;
const CACHE_TTL_EMPTY_S = 300;

async function fetchAndParseRss(
  feed: ServerFeed,
  variant: string,
  signal: AbortSignal,
): Promise<ParseResult> {
  // v5 cache shape: identical struct to v4 but a new prefix invalidates
  // every pre-fix entry on deploy. v4 entries cached pre-PR contain
  // ParsedItems without the new isEphemeralLiveCoverage field. If a cache hit
  // returned one of those, buildStoryTrackHsetFields would write
  // `'isEphemeralLiveCoverage', undefined ? '1' : '0'` → '0' onto the
  // story:track:v1 row, and buildDigest's stampMissing check would treat
  // '0' as a genuine "not ephemeral live" verdict and skip the residue catch.
  // Live-programming teasers could then silently slip through during the 1h
  // healthy-cache rollout window. Bumping the prefix forces cold parseRssXml
  // runs that stamp isEphemeralLiveCoverage correctly.
  //
  // (Same class of cache-prefix bump as v2→v3 and v3→v4, which this codebase
  // already established as the correct cutover pattern for parsed-cache
  // shape changes.)
  // v5→v6 (#4920 review): ParseResult gained droppedFeedCap; warm v5 rows
  // lack it and would undercount the coverage ledger for their whole TTL.
  // v6→v7: ParsedItems now stamp historical explainers using their persisted
  // publishedAt. Digest reads deliberately trust explicit isOpinion stamps,
  // so warm v6 rows could retain an earlier "0" verdict for one cache TTL.
  // Force a cold parse to stamp the stable ingest-time verdict immediately.
  // v7→v8: extend the same exclusion policy to duration-led anniversary
  // explainers ("10 years on from …"). Warm v7 rows already carry an
  // authoritative isOpinion="0", so force another cold parse on rollout.
  // v8→v9 (#7083): ParseResult gained the `attempt` field. Warm v8 rows
  // lack it, so zero-item entries could not be classified between
  // negative-cache and fresh-failure; force a cold parse on rollout.
  const cacheKey = `rss:feed:v9:${variant}:${feed.url}`;

  try {
    // Read cache unconditionally — the v5 prefix guarantees pre-fix
    // poisoning can't reach this read, so we don't need a parsedTotal
    // bypass. Honoring cached zero-from-zero entries IS the throttle:
    // setCachedJson below writes them with CACHE_TTL_EMPTY_S, so the next
    // request within 5 minutes hits cache instead of upstream. This is
    // what the PR description claimed and what review P1 flagged was
    // missing.
    const cached = (await getCachedJson(cacheKey)) as ParseResult | null;
    if (cached) {
      if (cached.parsedTotal === 0 && cached.items.length === 0) {
        // Only a cached prior fetch failure is negative. A valid RSS body
        // can also contain no entries; preserve that successful empty result
        // so cache hits keep the normal `empty` verdict.
        return { ...cached, attempt: cachedAttemptFrom(cached.attempt) };
      }
      return cached;
    }

    // Try direct fetch first
    const direct = await fetchRssText(feed.url, signal);
    let text = direct.text;
    let failure: FeedFetchAttempt['failure'] = direct.failure;
    let source: 'direct' | 'relay' | 'both-failed' = text ? 'direct' : 'both-failed';
    let relayStatus: number | null = null;
    let relayFailure: FeedFetchAttempt['failure'] = null;
    let relayAttempted = false;
    let relayBodyShape: 'rss' | 'html-or-empty' | 'no-relay' | 'fetch-error' = 'no-relay';

    // Fallback: route through Railway relay (different IP, avoids Vercel blocks)
    if (!text) {
      const relayBase = getRelayBaseUrl();
      if (relayBase) {
        relayAttempted = true;
        relayBodyShape = 'fetch-error';
        const relayUrl = `${relayBase}/rss?url=${encodeURIComponent(feed.url)}`;
        const { controller, cleanup, timedOut } = createTimeoutLinkedController(signal);
        try {
          const resp = await fetch(relayUrl, {
            headers: getRelayHeaders({ Accept: RSS_ACCEPT }),
            signal: controller.signal,
          });
          relayStatus = resp.status;
          if (resp.ok) {
            const relayText = await resp.text();
            // Relay can also return CF-challenge HTML if the relay's IP is
            // challenged — apply the same sniff to keep the cache clean.
            if (looksLikeRssXml(relayText)) {
              text = relayText;
              source = 'relay';
              relayBodyShape = 'rss';
            } else {
              relayBodyShape = 'html-or-empty';
            }
          }
        } catch {
          /* relay also failed */
          relayFailure = timedOut() ? 'per-feed-timeout' : signal.aborted ? 'deadline-abort' : 'relay-error';
        } finally {
          cleanup();
        }
      }
    }

    // Per-feed observability: surfaces which path won the fetch in Vercel
    // function logs. Critical when panels show 0 items — without this
    // breadcrumb you can't tell apart "direct blocked + relay env unset"
    // from "direct blocked + relay 403/429" from "relay returned HTML".
    // Filter logs by `[feed-fetch]` to triage. Volume: one line per cache
    // miss per feed (capped by CACHE_TTL_EMPTY_S=300s + healthy=3600s).
    if (source !== 'direct') {
      const host = (() => { try { return new URL(feed.url).hostname; } catch { return 'invalid-url'; } })();
      console.log(`[feed-fetch] variant=${variant} category=? host=${host} source=${source} relay_status=${relayStatus ?? 'n/a'} relay_shape=${relayBodyShape} feed=${feed.name}`);
    }

    if (!text) {
      // Both direct and relay failed. Cache empty short so we retry sooner
      // than the healthy-result TTL. The attempt verdict distinguishes the
      // global deadline abort (#7083) so a deadline-starved build is not
      // later reported as an upstream failure.
      const attempt: FeedFetchAttempt = {
        source: relayAttempted ? 'relay' : 'direct',
        failure: resolveTerminalFetchFailure({
          directFailure: failure,
          relayFailure,
          relayAttempted,
          deadlineAborted: signal.aborted,
        }),
        negativeCache: false,
      };
      const empty: ParseResult = { items: [], parsedTotal: 0, droppedUndated: 0, attempt };
      await setCachedJson(cacheKey, empty, CACHE_TTL_EMPTY_S);
      return empty;
    }

    // parseRssXml returns null on hard parse failure (malformed XML even
    // after surviving the body-shape sniff). Treat that the same as a
    // network failure: cache empty short so we retry sooner.
    const parsed = parseRssXml(text, feed, variant);
    const result: ParseResult = parsed ?? { items: [], parsedTotal: 0, droppedUndated: 0 };
    // text is non-null here, so the fetch source can only be 'direct' or
    // 'relay' — narrow explicitly, the variable's type still carries
    // 'both-failed' for the log line above.
    result.attempt = {
      source: source === 'relay' ? 'relay' : 'direct',
      failure: null,
      negativeCache: false,
    };
    // Long cache only for healthy parses; short cache for zero-from-zero so
    // transient upstream issues don't sticky-fail for an hour.
    const ttl = result.parsedTotal > 0 ? CACHE_TTL_HEALTHY_S : CACHE_TTL_EMPTY_S;
    await setCachedJson(cacheKey, result, ttl);
    return result;
  } catch {
    return {
      items: [],
      parsedTotal: 0,
      droppedUndated: 0,
      attempt: { source: 'direct', failure: 'direct-error', negativeCache: false },
    };
  }
}

// Date-tag priority lists. RSS feeds typically carry <pubDate>; Atom carries
// <published>/<updated>; ArXiv (and other Dublin Core dialects) carry <dc:date>
// or <dc:Date.Issued>; some hybrid feeds emit RSS-shaped items with Atom-style
// date tags. First non-empty hit wins.
const DATE_TAG_PRIORITY = {
  rss: ['pubDate', 'dc:date', 'dc:Date.Issued', 'published'] as const,
  atom: ['published', 'updated', 'dc:date', 'dc:Date.Issued'] as const,
};

// Future-dated guard: items > 1h ahead of now are clock-skew or malformed.
const FUTURE_DATE_TOLERANCE_MS = 60 * 60 * 1000;

// RSS <source> is upstream-provided text. Only these server-configured
// aggregator endpoints are allowed to vouch for it as publisher provenance;
// ordinary feeds remain anchored to their configured `feed.name` label.
const TRUSTED_ORIGIN_AGGREGATOR_HOSTS = new Set(['news.google.com']);

function isTrustedOriginAggregator(feedUrl: string): boolean {
  try {
    const parsed = new URL(feedUrl);
    return TRUSTED_ORIGIN_AGGREGATOR_HOSTS.has(parsed.hostname)
      || (parsed.hostname === 'moxie.foxbusiness.com'
        && parsed.pathname.startsWith('/google-publisher/'));
  } catch {
    return false;
  }
}

function extractFirstDateTag(block: string, isAtom: boolean): string {
  const tags = isAtom ? DATE_TAG_PRIORITY.atom : DATE_TAG_PRIORITY.rss;
  for (const tag of tags) {
    const value = extractTag(block, tag);
    if (value) return value;
  }
  return '';
}

function parseRssXml(xml: string, feed: ServerFeed, variant: string): ParseResult | null {
  const items: ParsedItem[] = [];
  let parsedTotal = 0;
  let droppedUndated = 0;

  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;

  let matches = [...xml.matchAll(itemRegex)];
  const isAtom = matches.length === 0;
  if (isAtom) matches = [...xml.matchAll(entryRegex)];

  // #4920 coverage ledger: items beyond the per-feed cap were previously
  // dropped with no counter anywhere — fully invisible.
  const droppedFeedCap = Math.max(0, matches.length - ITEMS_PER_FEED);

  for (const match of matches.slice(0, ITEMS_PER_FEED)) {
    const block = match[1]!;

    const title = extractTag(block, 'title');
    if (!title) continue;

    parsedTotal++;

    let link: string;
    if (isAtom) {
      const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["']/);
      link = hrefMatch?.[1] ?? '';
    } else {
      link = extractTag(block, 'link');
    }
    // Strip non-HTTP links (javascript:, data:, etc.) before any downstream use.
    if (!/^https?:\/\//i.test(link)) link = '';

    // Strict date gate (R2): walk the dialect-specific tag priority list and
    // require at least one non-empty, parseable, non-future timestamp. Items
    // that fail the gate are dropped — never silently stamped with Date.now()
    // (which is the bug that let static institutional pages reach the brief).
    const pubDateStr = extractFirstDateTag(block, isAtom);
    if (!pubDateStr) {
      droppedUndated++;
      continue;
    }
    const parsedDate = new Date(pubDateStr);
    const parsedMs = parsedDate.getTime();
    if (Number.isNaN(parsedMs)) {
      droppedUndated++;
      continue;
    }
    if (parsedMs > Date.now() + FUTURE_DATE_TOLERANCE_MS) {
      droppedUndated++;
      continue;
    }
    const publishedAt = parsedMs;

    const threat = classifyByKeyword(title, variant);
    const isAlert = threat.level === 'critical' || threat.level === 'high';
    const description = extractDescription(block, isAtom, title);

    // RSS 2.0 <source url="...">Name</source> — the originating publisher,
    // emitted per item by Google News. Atom's <source> is a metadata
    // CONTAINER (nested elements, no text of its own), so only the RSS
    // dialect is read; extractTag's [^<]* body would not match a container
    // anyway, but skipping Atom keeps that an invariant rather than a
    // regex accident.
    const originPublisher = isAtom ? '' : extractTag(block, 'source');

    items.push({
      source: feed.name,
      originPublisher,
      originPublisherTrusted: !isAtom && isTrustedOriginAggregator(feed.url),
      title,
      link,
      publishedAt,
      isAlert,
      level: threat.level,
      category: threat.category,
      confidence: threat.confidence,
      classSource: threat.source,
      importanceScore: 0,
      credibilityScore: 0,
      corroborationCount: 1,
      entityCorroborationCount: 0,
      lang: feed.lang ?? 'en',
      description,
      isOpinion: classifyOpinion({ title, link, description, publishedAt }),
      isFeelGood: classifyFeelGood({ title, link, description }),
      isEphemeralLiveCoverage: classifyEphemeralLiveCoverage({ title, link, description }),
      tickers: extractTickers(`${title} ${description}`, TICKER_DICTIONARY),
    });
  }

  // Per-feed structured WARN when every parsed item was dropped for missing
  // dates. Distinguishable from a genuinely empty feed (parsedTotal === 0)
  // by the keyword `FEED_HEALTH_WARNING all-undated` — log aggregation can
  // grep for it. Defers a Redis-backed health-key wiring to a follow-up;
  // see the linked plan.
  if (parsedTotal > 0 && items.length === 0 && droppedUndated > 0) {
    console.warn(
      `[digest] FEED_HEALTH_WARNING all-undated feed="${feed.name}" ` +
        `variant=${variant} parsed=${parsedTotal} dropped=${droppedUndated}`,
    );
  } else if (droppedUndated > 0) {
    console.warn(
      `[digest] partial-undated feed="${feed.name}" variant=${variant} ` +
        `parsed=${parsedTotal} dropped=${droppedUndated} kept=${items.length}`,
    );
  }

  // Two cases:
  //
  // (a) parsedTotal > 0 — we recognized at least one <item>/<entry> block in
  //     the XML, so the stats are meaningful (whether all dropped, partially
  //     dropped, or none dropped). Return the struct so cachedFetchJson
  //     positive-caches it for the full TTL and the 'all-undated' branch in
  //     buildDigest's caller can fire (parsedTotal>0 ∧ items=[] ∧ dropped>0).
  //
  // (b) parsedTotal === 0 — the XML body had no recognizable items at all.
  //     This covers genuinely empty feeds (channel exists, no items),
  //     malformed XML responses, transient block pages, and Cloudflare
  //     interstitials that don't match the item/entry regexes. Return null
  //     so cachedFetchJson writes NEG_SENTINEL with the short negativeTtl
  //     (default 120s) — the feed retries quickly instead of being pinned
  //     empty for the full 3600s TTL.
  if (parsedTotal === 0) return null;
  return { items, parsedTotal, droppedUndated, droppedFeedCap };
}

/**
 * Raw-body extractor for HTML-carrying tags (description, content:encoded,
 * summary, content). Non-greedy `[\s\S]*?` captures the full tag body including
 * nested markup; the CDATA end is anchored to the closing tag so internal `]]>`
 * sequences followed by more content do not truncate the match prematurely.
 * Returns the raw content without entity decoding — caller strips HTML and
 * decodes entities via `decodeXmlEntities`.
 */
const DESCRIPTION_TAG_REGEX_CACHE = new Map<string, { cdata: RegExp; plain: RegExp }>();

function extractRawTagBody(xml: string, tag: string): string {
  let cached = DESCRIPTION_TAG_REGEX_CACHE.get(tag);
  if (!cached) {
    cached = {
      cdata: new RegExp(
        `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`,
        'i',
      ),
      plain: new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'),
    };
    DESCRIPTION_TAG_REGEX_CACHE.set(tag, cached);
  }
  const cdataMatch = xml.match(cached.cdata);
  if (cdataMatch) return cdataMatch[1] ?? '';

  const match = xml.match(cached.plain);
  return match ? match[1] ?? '' : '';
}

function normalizeForDescriptionEquality(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract + clean the article description/summary for an RSS `<item>` or Atom
 * `<entry>` block. Picks the LONGEST non-empty candidate across the dialect's
 * tag priority list after HTML-strip + entity-decode + whitespace-normalise.
 * Returns '' when the best candidate is empty, shorter than
 * MIN_DESCRIPTION_LEN, or normalises-equal to the headline — in those cases
 * downstream consumers must fall back to the cleaned headline (R6).
 */
function extractDescription(block: string, isAtom: boolean, title: string): string {
  const tags = isAtom ? DESCRIPTION_TAG_PRIORITY.atom : DESCRIPTION_TAG_PRIORITY.rss;

  let best = '';
  for (const tag of tags) {
    const raw = extractRawTagBody(block, tag);
    if (!raw) continue;
    // Some publisher feeds place entity-encoded thumbnail markup before a
    // literal CDATA summary in one tag body (Times of India is one example).
    // Unwrap complete embedded CDATA sections before entity decoding and HTML
    // stripping; otherwise `<...>` removal consumes the wrapper and its text.
    const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    const cleaned = decodeXmlEntities(unwrapped)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length > best.length) best = cleaned;
  }

  if (best.length === 0) return '';
  if (best.length < MIN_DESCRIPTION_LEN) return '';
  if (normalizeForDescriptionEquality(best) === normalizeForDescriptionEquality(title)) return '';

  return best.slice(0, MAX_DESCRIPTION_LEN);
}

const TAG_REGEX_CACHE = new Map<string, { cdata: RegExp; plain: RegExp }>();
const KNOWN_TAGS = [
  'title',
  'link',
  'pubDate',
  'published',
  'updated',
  // Dublin Core date dialects (ArXiv and similar feeds publish via these
  // instead of <pubDate>). Pre-caching their regexes mirrors the perf
  // pattern used for other hot-path tags.
  'dc:date',
  'dc:Date.Issued',
] as const;
for (const tag of KNOWN_TAGS) {
  TAG_REGEX_CACHE.set(tag, {
    cdata: new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'),
    plain: new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'),
  });
}

function extractTag(xml: string, tag: string): string {
  const cached = TAG_REGEX_CACHE.get(tag);
  const cdataRe = cached?.cdata ?? new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
  const plainRe = cached?.plain ?? new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');

  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1]!.trim();

  const match = xml.match(plainRe);
  return match ? decodeXmlEntities(match[1]!.trim()) : '';
}

/**
 * `String.fromCodePoint` throws `RangeError` on anything outside the Unicode
 * range, which would turn one malformed numeric reference into a failed feed
 * parse. Drop those instead. `fromCharCode` is not usable here: it truncates to
 * 16 bits, so `&#128512;` decoded to U+F600 (a private-use glyph) rather than 😀.
 */
function decodeNumericReference(codePoint: number): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : '';
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => decodeNumericReference(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => decodeNumericReference(parseInt(n, 16)))
    // `&amp;` MUST be decoded last. Decoding it first turns the escaped
    // ampersand of `&amp;lt;` into a live `&`, which the very next replace then
    // consumes as `&lt;` — one pass decoding twice.
    .replace(/&amp;/g, '&');
}

/**
 * Validates a raw `getCachedJsonBatch` hit at the trust boundary before any
 * field reaches a typed `ParsedItem`. `level`/`category` on `ParsedItem` are
 * declared `string`/`ThreatLevel`-derived, but the cache is Redis-backed JSON
 * — an unrelated payload shape (stale schema, another feature's cache
 * collision, hand-edited Redis value) parses fine as JSON while carrying a
 * non-string, missing, or object/array `level`/`category`. Returns null
 * unless BOTH fields are actually strings, so callers never need a
 * downstream `typeof` guard before assigning onto `item.category`.
 */
function parseClassifyCacheHit(raw: unknown): { level: string; category: string } | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { level, category } = raw as Record<string, unknown>;
  if (typeof level !== 'string' || typeof category !== 'string') return null;
  return { level, category };
}

async function enrichWithAiCache(items: ParsedItem[]): Promise<void> {
  // Apply the LLM cache to BOTH 'keyword' and 'keyword-historical-downgrade'
  // sources. The historical-downgrade path forced an info level based on a
  // headline-shape heuristic; the LLM cache (when warmed) is a stronger
  // signal and should be allowed to either confirm or override.
  const candidates = items.filter(
    i => i.classSource === 'keyword' || i.classSource === 'keyword-historical-downgrade',
  );
  if (candidates.length === 0) return;

  // Use the canonical buildClassifyCacheKey from intelligence/v1/_shared
  // so the cache prefix (currently classify:sebuf:v6:) lives in exactly
  // one place — bumping it again only requires touching _shared.ts and
  // the relay's independent .cjs helper. See U4 of the plan.
  // Titles are independent — hash them concurrently instead of N sequential
  // WebCrypto hops on this hot fast-tier surface.
  const keyed = await Promise.all(
    candidates.map((item) => buildClassifyCacheKey(item.title).then((key) => ({ key, item }))),
  );
  const keyMap = new Map<string, ParsedItem[]>();
  for (const { key, item } of keyed) {
    const existing = keyMap.get(key) ?? [];
    existing.push(item);
    keyMap.set(key, existing);
  }

  const keys = [...keyMap.keys()];
  const cached = await getCachedJsonBatch(keys);

  for (const [key, relatedItems] of keyMap) {
    const hit = parseClassifyCacheHit(cached.get(key));
    // `hit.level === '_skip'` is currently unreachable and kept only as
    // defence-in-depth: both relay skip-writes emit `{ level: '_skip',
    // timestamp }` with no `category` (scripts/ais-relay.cjs:3892, :3968),
    // so the shape check above already rejects them and `!hit` catches them
    // here. It stays because it is the correct guard the moment any writer
    // starts pairing the sentinel with a category — do not read it as the
    // operative skip check today. Locked by the `_skip` cases in
    // tests/news-classify-cache-hit-validation.test.mts.
    if (!hit || hit.level === '_skip' || !hit.level || !hit.category) continue;

    for (const item of relatedItems) {
      // L3 defense-in-depth runs FIRST, BEFORE capLlmUpgrade. If the
      // title carries a historical-retrospective marker, force info
      // regardless of what the LLM cache claimed — retrospective content
      // should never ship at any non-info level.
      //
      // Why before the cap (P1 fix on PR #3429 round 3): when keyword=info
      // and hit=critical, capLlmUpgrade returns medium (info+2=medium).
      // A post-cap check on `cappedLevel === 'critical' || === 'high'`
      // would miss this — `medium` doesn't match — so the brief 2026-04-
      // 26-1302 Chernobyl-style title would have shipped at MEDIUM (which
      // still passes 'all' sensitivity briefs). Running the marker check
      // on the original hit and forcing info — not on cappedLevel — closes
      // that gap.
      //
      // Why force info unconditionally (not just critical/high): retro-
      // spective markers should suppress the LLM verdict at every non-info
      // level, including medium and low. A medium-level retrospective would
      // still ship in 'all'-sensitivity briefs; the goal of this guard is
      // "retrospective content NEVER ships, regardless of LLM verdict."
      if (hasHistoricalMarker(item.title)) {
        console.warn(
          `[classify] LLM hit forced to info by historical marker: ` +
            `keyword=${item.level} llm=${hit.level} title="${item.title.slice(0, 60)}"`,
        );
        item.level = 'info';
        item.category = hit.category;
        item.confidence = 0.9;
        item.classSource = 'llm';
        item.isAlert = false;
        continue;
      }

      // Skip the LLM cache for high-confidence keyword=critical matches
      // (confidence 0.9). Without this skip, capLlmUpgrade is a Math.min
      // — a stale or wrong LLM cache entry saying 'info' would silently
      // demote a genuine current critical event to info via min(critical,
      // info) = info, with no remaining safeguard.
      //
      // The retrospective case the prior PR #3424 wanted to handle here
      // is already handled UPSTREAM: a keyword=critical title with a
      // historical marker becomes classSource='keyword-historical-
      // downgrade' (confidence 0.85, level=info) inside classifyByKeyword
      // BEFORE reaching this function, so the L3 marker check above
      // catches it via the historical-downgrade source. Items reaching
      // here at confidence 0.9 are by construction items where the
      // keyword classifier saw a critical match AND saw no marker —
      // the safer default for those is to trust the keyword verdict.
      //
      // The L3 marker check above intentionally runs BEFORE this skip so
      // that keyword=info (confidence 0.3, no-match) titles with a
      // marker — the brief 2026-04-26-1302 "Science history: melts
      // down…" shape — still get forced to info via the cache hit.
      // Belt-and-suspenders for substring-keyword-miss contamination.
      //
      // P1 fix on PR #3429 round 4 (Greptile review on commit 96d3c12d7).
      if (0.9 <= item.confidence) continue;

      //
      // Cap the LLM upgrade at +2 tiers above the keyword classification
      // so a poisoned cache entry (e.g., "About Section 508" → high) can't
      // promote an info-keyword item past medium (info+2=medium). Legitimate
      // medium→critical upgrades (medium+2=critical) remain reachable.
      // capLlmUpgrade is a Math.min so downgrades pass through freely.
      // See LEVEL_RANK doc + R4 for the full per-keyword cap table.
      const cappedLevel = capLlmUpgrade(item.level, hit.level);
      if (cappedLevel !== hit.level) {
        console.warn(
          `[classify] LLM upgrade capped: keyword=${item.level} ` +
            `llm=${hit.level} applied=${cappedLevel} title="${item.title.slice(0, 60)}"`,
        );
      }
      item.level = cappedLevel;
      item.category = hit.category;
      item.confidence = 0.9;
      item.classSource = 'llm';
      item.isAlert = cappedLevel === 'critical' || cappedLevel === 'high';
    }
  }
}

// ── Story persistence tracking ────────────────────────────────────────────────

function normalizeTitle(title: string): string {
  // \p{L} = any Unicode letter; \p{N} = any Unicode number.
  // The `u` flag is required for Unicode property escapes — without it \w
  // matches only ASCII [A-Za-z0-9_], stripping all Arabic/CJK/Cyrillic chars
  // and collapsing every non-Latin title to the same empty hash.
  return title
    .toLowerCase()
    // Strip source attribution suffixes ("- Reuters", "- reuters.com", etc.)
    // so the same story from different domains hashes identically.
    .replace(/\s*[-\u2013\u2014]\s*[\w\s.]+\.(?:com|org|net|co\.uk)\s*$/, '')
    .replace(/\s*[-\u2013\u2014]\s*(?:reuters|ap news|bbc|cnn|al jazeera|france 24|dw news|pbs newshour|cbs news|nbc|abc|associated press|the guardian|nos nieuws|tagesschau|cnbc|the national)\s*$/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function entityKeysForTitle(title: string): string[] {
  const text = normalizeScoringText(title);
  const keys: string[] = [];
  for (const [entity, action] of DIPLOMACY_FLASHPOINT_PAIRS) {
    if (containsKeywordToken(text, entity) && containsKeywordToken(text, action)) keys.push(`${entity}:${action}`);
  }
  if (
    keys.length === 0 &&
    hasAnySignal(text, DIPLOMACY_KEYWORDS) &&
    hasAnySignal(text, FLASHPOINT_SCORING_KEYWORDS)
  ) {
    keys.push('generic:diplomacy-flashpoint');
  }
  return keys;
}

interface EntityCorroborationSignal {
  sourceCount: number;
  tier12SourceCount: number;
}

function computeEntityCorroborationSignals(
  items: ParsedItem[],
  nowMs = Date.now(),
): Map<string, EntityCorroborationSignal> {
  const buckets = new Map<string, { items: ParsedItem[]; sources: Set<string>; tier12Sources: Set<string> }>();
  for (const item of items) {
    if (!item.titleHash) continue;
    if (!Number.isFinite(item.publishedAt) || nowMs - item.publishedAt > ENTITY_CORROBORATION_WINDOW_MS) continue;
    for (const key of entityKeysForTitle(item.title)) {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { items: [], sources: new Set(), tier12Sources: new Set() };
        buckets.set(key, bucket);
      }
      bucket.items.push(item);
      // #6428: bucket by publisher FAMILY. Keyed on the raw feed label, one
      // newsroom's editions ("Reuters World" + "Reuters US") reached the
      // >= 2 gate below on their own and manufactured an entity-corroboration
      // signal that feeds importanceScore and the diplomacy severity
      // promotion. The tier is a property of the LABEL, so a family joins
      // tier12Sources when any of its labels is tier 1-2.
      // #6430: a trusted aggregator's originating publisher (RSS <source>)
      // outranks the feed label — a wire syndicated through a keyword feed
      // corroborates as the wire, not as the query it arrived through.
      const family = publisherFamilyForItem(item);
      if (family) {
        bucket.sources.add(family);
        if (getSourceTier(item.source) <= 2) bucket.tier12Sources.add(family);
      }
    }
  }

  const signals = new Map<string, EntityCorroborationSignal>();
  for (const bucket of buckets.values()) {
    if (bucket.sources.size < MIN_CORROBORATING_PUBLISHERS) continue;
    for (const item of bucket.items) {
      const previous = signals.get(item.titleHash!);
      signals.set(item.titleHash!, {
        sourceCount: Math.max(previous?.sourceCount ?? 0, bucket.sources.size),
        tier12SourceCount: Math.max(previous?.tier12SourceCount ?? 0, bucket.tier12Sources.size),
      });
    }
  }
  return signals;
}

function computeEntityCorroborationCounts(
  items: ParsedItem[],
  nowMs = Date.now(),
): Map<string, number> {
  const signals = computeEntityCorroborationSignals(items, nowMs);
  return new Map([...signals].map(([hash, signal]) => [hash, signal.sourceCount]));
}

interface StoryTrack {
  firstSeen: number;
  lastSeen: number;
  mentionCount: number;
  sourceCount: number;
}

/**
 * Derive the wire lifecycle phase for a story appearing in THIS build cycle.
 *
 * FADING is deliberately not derivable here. #7081 ran a bounded study against
 * frozen production evidence (tests/fixtures/story-phase-fading-study.json,
 * replayed by scripts/study-story-phase-fading.mjs) and recorded a no-go for
 * the previously documented `currentScore < 0.5 * peakScore` rule. Three
 * findings, each reproducible from that fixture:
 *
 *   1. The rule was unreachable. It read `peakScore` from the story:track hash,
 *      but the peak is written to the story:peak:v1 ZSet and that hash field has
 *      no writer — the field was absent on 14,000/14,000 sampled rows, so the
 *      branch could never be taken. The old comment here blamed "HSETNX
 *      placeholders" for both scores; that was wrong about currentScore, which
 *      is written on every cycle and was positive on all 14,000 rows.
 *
 *   2. Repaired to read the real peak, the ratio measures article age, not
 *      traction. importanceScore weights severity at 0.55 and recency at 0.10,
 *      so the score's dynamic range at fixed severity is min/max = 0.63
 *      (critical), 0.57 (high), 0.49 (medium), 0.37 (low), 0.18 (info). A
 *      critical or high story therefore cannot reach half its peak without a
 *      severity downgrade, while an info story crosses it on the recency term
 *      alone once its article passes 24h (18 -> 8). Measured on the same rows:
 *      673 firings, 670 of them info/low, and 0 of 679 critical/high rows.
 *
 *   3. Fading is not observable at this call site at all. derivePhase only runs
 *      for stories present in the current cycle, and it is handed a track whose
 *      lastSeen is `now` — a story that stopped being covered is absent from the
 *      cycle and never reaches this function. Silence, the one signal that does
 *      identify a fading story, is only visible where the non-serving population
 *      is in scope: scripts/seed-digest-notifications.mjs calls
 *      deriveNotificationStoryPhase() from shared/story-phase.js, which
 *      applies the same core mention-count/age rules documented here and
 *      additionally treats >24h of silence as fading.
 *
 * The STORY_PHASE_FADING wire value is retained for compatibility and is still
 * handled by consumers (the client alert gate suppresses it), but this handler
 * does not emit it. Do not reintroduce a score-ratio branch here without new
 * evidence that clears the acceptance bar recorded in the study.
 *
 * `nowMs` is injectable so the phase boundaries are testable without a live clock.
 */
function derivePhase(track: StoryTrack, nowMs: number = Date.now()): ProtoStoryPhase {
  const phase = deriveCoreStoryPhase(track, nowMs);
  if (phase === 'breaking') return 'STORY_PHASE_BREAKING';
  if (phase === 'developing') return 'STORY_PHASE_DEVELOPING';
  return 'STORY_PHASE_SUSTAINED';
}

/**
 * Batch-read existing story:track hashes from Redis for a list of title hashes.
 * Returns a Map<titleHash, StoryTrack>. Missing entries are absent from the map.
 */
async function readStoryTracks(
  titleHashes: string[],
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<Map<string, StoryTrack>> {
  if (titleHashes.length === 0) return new Map();
  // currentScore and peakScore are deliberately NOT read here. derivePhase is
  // the only consumer this handler ever had for them, and it no longer uses a
  // score at all (#7081 no-go — see derivePhase). peakScore in particular never
  // existed as a hash field: the peak lives in the story:peak:v1 ZSet, so the
  // HMGET slot returned null on every sampled production row. Dropping both
  // trims two fields from every per-story HMGET in the batch. The WRITE side is
  // unchanged — buildStoryTrackHsetFields still persists currentScore, which
  // scripts/seed-digest-notifications.mjs reads.
  const fields = ['firstSeen', 'lastSeen', 'mentionCount', 'sourceCount'];
  const commands = titleHashes.map(h => [
    'HMGET', STORY_TRACK_KEY(h), ...fields,
  ]);
  const timeoutMs = redisTimeoutForDeadline(deadlineAt);
  if (timeoutMs === undefined) return new Map();
  const results = await runRedisPipeline(commands, false, timeoutMs);
  const map = new Map<string, StoryTrack>();
  for (let i = 0; i < titleHashes.length; i++) {
    const vals = results[i]?.result as string[] | null;
    if (!vals || !vals[0]) continue; // firstSeen missing → new story
    map.set(titleHashes[i]!, {
      firstSeen:    Number(vals[0]),
      lastSeen:     Number(vals[1] ?? 0),
      mentionCount: Number(vals[2] ?? 0),
      sourceCount:  Number(vals[3] ?? 0),
    });
  }
  return map;
}

function parseRedisTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (typeof value === 'string' && value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function chunkRedisCommands(
  commands: Array<Array<string | number>>,
  maxCommands: number = MAX_REDIS_PIPELINE_COMMANDS,
): Array<Array<Array<string | number>>> {
  if (!Number.isInteger(maxCommands) || maxCommands < 1) {
    throw new RangeError('maxCommands must be a positive integer');
  }
  const chunks: Array<Array<Array<string | number>>> = [];
  for (let offset = 0; offset < commands.length; offset += maxCommands) {
    chunks.push(commands.slice(offset, offset + maxCommands));
  }
  return chunks;
}

/**
 * Convert an absolute digest deadline into a Redis request timeout. A caller
 * must not start a request after its deadline, but a short positive remainder
 * is still useful because same-region Upstash reads normally complete far
 * below the shared five-second fallback timeout.
 */
function redisTimeoutForDeadline(deadlineAt: number): number | undefined {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return undefined;
  return Math.min(REDIS_PIPELINE_TIMEOUT_MS, Math.max(1, Math.ceil(remainingMs)));
}

/**
 * Return firstSeen only for a track that is safe to use as a canonical anchor.
 * Missing/legacy metadata, malformed timestamps, stale rows, and explicit
 * ineligibility all fail closed.
 */
function parseFreshEligibleTrackFirstSeen(
  row: unknown,
  freshnessCutoff: number,
): number | undefined {
  if (!Array.isArray(row) || row.length < 3 || row[2] !== '1') return undefined;
  const firstSeen = parseRedisTimestamp(row[0]);
  const lastSeen = parseRedisTimestamp(row[1]);
  if (firstSeen === undefined || lastSeen === undefined || lastSeen < freshnessCutoff) {
    return undefined;
  }
  return firstSeen;
}

interface AdoptionState {
  aliasTargetByHash: Map<string, string>;
  trackFirstSeenByHash: Map<string, number>;
  incompleteHashes: Set<string>;
}

function isCompleteRedisResult(result: unknown): result is { result: unknown } {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, 'result')
    && !Object.prototype.hasOwnProperty.call(record, 'error');
}

/**
 * Read the alias and track state for one adoption pass.
 *
 * Each bounded chunk starts with one MULTI/EXEC call so the alias and
 * three-field member-track read for every hash come from the same Redis
 * snapshot. Distinct non-self alias targets are then read in a second bounded
 * MULTI/EXEC call, because their keys are not known until the aliases return.
 * The reader has one absolute deadline shared by all chunks. Each Redis call
 * is tightened to the remaining budget, so a short positive remainder can
 * still serve a normal fast response without letting a slow call outlive the
 * digest. A timeout, incomplete response, command error, or deadline skip
 * leaves the affected source hashes marked incomplete; callers must use their
 * batch-derived canonical for any affected cluster.
 */
async function readAdoptionState(
  memberHashes: string[],
  freshnessCutoff: number,
  deadlineAt = Date.now() + ADOPTION_DEADLINE_MS,
): Promise<AdoptionState> {
  const aliasTargetByHash = new Map<string, string>();
  const trackFirstSeenByHash = new Map<string, number>();
  const incompleteHashes = new Set(memberHashes);

  for (let offset = 0; offset < memberHashes.length; offset += ADOPTION_BATCH_SIZE) {
    const chunk = memberHashes.slice(offset, offset + ADOPTION_BATCH_SIZE);
    const timeoutMs = redisTimeoutForDeadline(deadlineAt);
    if (timeoutMs === undefined) {
      console.warn(
        `[digest] story adoption deadline reached; skipped ${memberHashes.length - offset} member hash(es)`,
      );
      break;
    }

    const adoptionResults = await runRedisTransaction([
      ...chunk.map((h) => ['GET', STORY_ALIAS_KEY(h)]),
      ...chunk.map((h) => ['HMGET', STORY_TRACK_KEY(h), 'firstSeen', 'lastSeen', 'anchorEligible']),
    ], false, timeoutMs);

    // A response that crossed the deadline is not a usable snapshot. Do this
    // check before applying either map so no half-read can influence adoption.
    if (Date.now() > deadlineAt) {
      console.warn(
        `[digest] story adoption chunk crossed deadline; skipped ${chunk.length} member hash(es)`,
      );
      break;
    }

    const expectedLength = chunk.length * 2;
    const complete = Array.isArray(adoptionResults)
      && adoptionResults.length === expectedLength
      && adoptionResults.every(isCompleteRedisResult);
    if (!complete) {
      console.warn(
        `[digest] story adoption chunk incomplete; expected ${expectedLength} Redis result(s), got ${Array.isArray(adoptionResults) ? adoptionResults.length : 'non-array'}`,
      );
      // A failed chunk is a Redis-health signal, not a per-key miss. Stop
      // here so later chunks cannot extend the cold-path work while the
      // adoption result is already unconfirmed.
      break;
    }

    // A successful Redis response can still contain an unexpected command
    // shape. Treat that as an unconfirmed chunk, not as a cache miss that is
    // safe to combine with other members in the same cluster.
    const aliases = adoptionResults.slice(0, chunk.length);
    const tracks = adoptionResults.slice(chunk.length);
    const validShapes = aliases.every(({ result }) => result === null || typeof result === 'string')
      && tracks.every(({ result }) => Array.isArray(result) && result.length >= 3);
    if (!validShapes) {
      console.warn('[digest] story adoption chunk returned invalid Redis value shapes');
      break;
    }

    // Only a complete, error-free chunk is eligible for adoption. A normal
    // HMGET miss is [null, null, null] and contributes no live track. The
    // exact string '1' is required for eligibility; missing/legacy metadata
    // never becomes trusted merely because firstSeen is old.
    const trackRowByHash = new Map<string, unknown[]>();
    for (let i = 0; i < chunk.length; i++) {
      const row = adoptionResults[chunk.length + i]!.result;
      trackRowByHash.set(chunk[i]!, row as unknown[]);
    }

    const nonSelfAliasByHash = new Map<string, string>();
    for (let i = 0; i < chunk.length; i++) {
      const target = adoptionResults[i]!.result;
      const row = trackRowByHash.get(chunk[i]!)!;
      // Self-aliases are useful only when their own track is fresh and
      // explicitly eligible. Non-self aliases are held until the target's own
      // track has been read and validated below.
      // This matters when the canonical member dropped out of the batch — its
      // persisted track is the only evidence that the alias is trustworthy.
      if (
        typeof target === 'string'
        && target.length > 0
      ) {
        if (
          target === chunk[i]
          && parseFreshEligibleTrackFirstSeen(row, freshnessCutoff) !== undefined
        ) {
          aliasTargetByHash.set(chunk[i]!, target);
        } else if (target !== chunk[i]) {
          nonSelfAliasByHash.set(chunk[i]!, target);
        }
      }
    }

    const targetHashes = [...new Set(nonSelfAliasByHash.values())]
      .filter((target) => !trackRowByHash.has(target));
    const unreadableTargetHashes = new Set<string>();
    if (targetHashes.length > 0) {
      const targetTimeoutMs = redisTimeoutForDeadline(deadlineAt);
      if (targetTimeoutMs === undefined) {
        console.warn(
          `[digest] story adoption target deadline reached; skipped ${targetHashes.length} track read(s)`,
        );
        for (const target of targetHashes) unreadableTargetHashes.add(target);
      } else {
        const targetResults = await runRedisTransaction(
          targetHashes.map((target) => [
            'HMGET', STORY_TRACK_KEY(target), 'firstSeen', 'lastSeen', 'anchorEligible',
          ]),
          false,
          targetTimeoutMs,
        );

        // A response that crossed the deadline is not a usable target
        // snapshot. Treat every target as unreadable so no alias can influence
        // adoption from a half-read result.
        if (Date.now() > deadlineAt) {
          console.warn(
            `[digest] story adoption target chunk crossed deadline; skipped ${targetHashes.length} track read(s)`,
          );
          for (const target of targetHashes) unreadableTargetHashes.add(target);
        } else {
          const targetComplete = Array.isArray(targetResults)
            && targetResults.length === targetHashes.length
            && targetResults.every(isCompleteRedisResult);
          if (!targetComplete) {
            console.warn(
              `[digest] story adoption target read incomplete; expected ${targetHashes.length} Redis result(s), got ${Array.isArray(targetResults) ? targetResults.length : 'non-array'}`,
            );
            for (const target of targetHashes) unreadableTargetHashes.add(target);
          } else {
            for (let i = 0; i < targetHashes.length; i++) {
              const row = targetResults[i]!.result;
              if (!Array.isArray(row) || row.length < 3) {
                unreadableTargetHashes.add(targetHashes[i]!);
                continue;
              }
              trackRowByHash.set(targetHashes[i]!, row);
            }
          }
        }
      }
    }

    // A target row is trusted only when it carries its own fresh, eligible
    // anchor metadata. A readable but stale/ineligible/legacy row rejects the
    // alias; an unreadable row marks the source incomplete so its whole
    // cluster falls back to the batch-derived canonical.
    for (const [memberHash, target] of nonSelfAliasByHash) {
      if (unreadableTargetHashes.has(target)) {
        continue;
      }
      if (parseFreshEligibleTrackFirstSeen(trackRowByHash.get(target), freshnessCutoff) !== undefined) {
        aliasTargetByHash.set(memberHash, target);
      }
    }

    for (let i = 0; i < chunk.length; i++) {
      const firstSeen = parseFreshEligibleTrackFirstSeen(
        trackRowByHash.get(chunk[i]!),
        freshnessCutoff,
      );
      if (firstSeen !== undefined) trackFirstSeenByHash.set(chunk[i]!, firstSeen);
    }

    const affectedByUnreadableTarget = new Set<string>();
    for (const [memberHash, target] of nonSelfAliasByHash) {
      if (unreadableTargetHashes.has(target)) affectedByUnreadableTarget.add(memberHash);
    }
    for (const hash of chunk) {
      if (!affectedByUnreadableTarget.has(hash)) incompleteHashes.delete(hash);
    }
    if (unreadableTargetHashes.size > 0) {
      // A transport/incomplete/deadline failure is a Redis-health signal, not
      // a per-key miss. Stop here so later chunks cannot extend the cold-path
      // work while adoption is already unconfirmed.
      break;
    }
  }

  return { aliasTargetByHash, trackFirstSeenByHash, incompleteHashes };
}

function toProtoItem(item: ParsedItem, storyMeta?: ProtoStoryMeta): ProtoNewsItem {
  return {
    source: item.source,
    title: item.title,
    link: item.link,
    publishedAt: item.publishedAt,
    isAlert: item.isAlert,
    importanceScore: item.importanceScore,
    credibilityScore: item.credibilityScore,
    corroborationCount: item.corroborationCount ?? 0,
    storyMeta,
    threat: {
      level: LEVEL_TO_PROTO[item.level],
      category: item.category,
      confidence: item.confidence,
      source: item.classSource,
    },
    locationName: '',
    snippet: item.description ?? '',
    tickers: item.tickers ?? [],
  };
}

export async function listFeedDigest(
  ctx: ServerContext,
  req: ListFeedDigestRequest,
): Promise<ListFeedDigestResponse> {
  const variant = VALID_VARIANTS.has(req.variant) ? req.variant : 'full';
  const lang = req.lang || 'en';

  const digestCacheKey = `news:digest:v1:${variant}:${lang}`;
  const fallbackKey = `${variant}:${lang}`;
  const requestStart = Date.now();
  const attemptedAt = new Date(requestStart).toISOString();
  const responseDeadlineAt = requestStart + RESPONSE_DEADLINE_MS;
  // Wall-clock budget for optional tail work. The build alone can consume
  // ~19s worst case (14s fetcher timeout + a 5s sentinel write inside the
  // cache wrapper); every awaited Redis op after it must fit inside the 25s
  // Edge response ceiling minus a guard band.
  // ONE revocation read per request, started at t=0 so its worst case
  // overlaps the build instead of stacking after it. Shared by the fresh
  // serve path and both replay tiers.
  const revokedPromise = readRevokedUrlSet();

  // #7085: an empty response still carries an explicit `unavailable`
  // coverage block so clients can distinguish "nothing served" from
  // "digest temporarily absent".
  const empty = (at: string, reason: string): ListFeedDigestResponse => ({
    categories: {},
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
    coverage: {
      state: 'unavailable',
      attemptedAt: at,
      itemsServed: 0,
      publisherCount: 0,
      feedTotal: 0,
      feedCompleted: 0,
      categoryTotal: 0,
      categoryCompleted: 0,
      categoryStates: {},
      droppedFeedCap: 0,
      droppedUndated: 0,
      droppedFreshness: 0,
      droppedCategoryCap: 0,
      servedStale: false,
      staleAgeSeconds: 0,
      staleReason: reason,
    },
  });

  /**
   * #7084: the last serving tier — the warm in-isolate cache, reached when the
   * durable snapshot was unreadable, absent, or expired. Bounded by the same
   * six-hour contract as the durable tier: the `ts` recorded at write time was
   * previously never read, so this tier could replay content of unbounded age.
   */
  const serveIsolateFallback = async (
    reason: StaleReason,
    at: string,
    revoked: RevocationRead,
  ): Promise<ListFeedDigestResponse> => {
    const entry = fallbackDigestCache.get(fallbackKey);
    if (!entry) {
      console.log(`[digest-serving] outcome=unavailable reason=${reason} variant=${variant} lang=${lang}`);
      return empty(at, reason);
    }
    if (!revoked.readable) {
      // Same fail-closed rule as the durable tier: replayed content must not
      // go out unfiltered when the suppression set could not be read.
      console.warn(
        `[digest-serving] outcome=unavailable reason=revocations-unreadable variant=${variant} lang=${lang} tier=isolate`,
      );
      captureSilentError(new Error('revocation set unreadable on isolate serving path'), {
        tags: { surface: 'news', component: 'digest-lastgood', stage: 'revocation-read', variant, lang },
        fingerprint: ['digest-lastgood', 'revocations-unreadable-isolate'],
      });
      return empty(at, reason);
    }
    // The body below was cached in-process, but it originated from a build or
    // a Redis read — degrade this tier on a malformed shape, never the request.
    try {
      // Suppress BEFORE the servability gate, mirroring the durable tier: a
      // fully-revoked body is not servable content, and classifying the
      // unfiltered body would serve it as a valid (empty) stale response.
      const { data, dropped } = suppressRevoked(entry.data, revoked.urls);
      // Same window policy as the durable tier — one implementation, so the
      // two replay tiers cannot drift apart on what "six hours" means.
      const verdict = classifyStaleSnapshot({ acceptedAt: entry.ts, data }, Date.now());
      if (!verdict.serve) {
        fallbackDigestCache.delete(fallbackKey);
        console.log(
          `[digest-serving] outcome=${verdict.outcome} reason=${reason} variant=${variant} ` +
            `lang=${lang} tier=isolate age_s=${verdict.ageSeconds}`,
        );
        return empty(at, reason);
      }
      const ageSeconds = verdict.ageSeconds;
      console.log(
        `[digest-serving] outcome=isolate-fallback reason=${reason} age_s=${ageSeconds} ` +
          `variant=${variant} lang=${lang} revoked_urls=${revoked.urls.size} revoked_dropped=${dropped}`,
      );
      return markFallbackCoverageStale(data, at, { ageSeconds, reason });
    } catch (err) {
      fallbackDigestCache.delete(fallbackKey);
      console.warn(`[digest-serving] outcome=unavailable reason=isolate-malformed variant=${variant} lang=${lang}`);
      captureSilentError(err, {
        tags: { surface: 'news', component: 'digest-lastgood', stage: 'isolate-serve', variant, lang },
        fingerprint: ['digest-lastgood', 'isolate-serve-threw'],
      });
      return empty(at, reason);
    }
  };

  /** Durable snapshot first, warm isolate second, unavailable last. */
  const serveDegraded = async (
    fallbackReason: StaleReason,
    knownAttempt: FailedDigestAttempt | null,
    preferRecentAttempt = true,
  ): Promise<ListFeedDigestResponse> => {
    if (Date.now() >= responseDeadlineAt) {
      return empty(knownAttempt?.at ?? attemptedAt, knownAttempt?.reason ?? fallbackReason);
    }
    // Start the large body read only after degradation is known. It overlaps
    // attempt recovery and the already-running revocation read without adding
    // ~126KB of Redis I/O to every healthy/cache-hit request.
    const degradedSnapshotPromise = readAcceptedSnapshot<ListFeedDigestResponse>(variant, lang);
    const fallbackAttempt = Object.freeze({ at: attemptedAt, reason: fallbackReason });
    const attempt = knownAttempt ?? await settleBeforeDeadline(
      recoverFailedAttempt(variant, lang, fallbackAttempt, preferRecentAttempt),
      responseDeadlineAt,
      fallbackAttempt,
    );
    const unavailable = empty(attempt.at, attempt.reason);
    const stale = await settleBeforeDeadline(
      serveLastGood(
        variant,
        lang,
        attempt.reason,
        attempt.at,
        revokedPromise,
        degradedSnapshotPromise,
      ),
      responseDeadlineAt,
      null,
    );
    if (stale) return stale;
    const revoked = await settleBeforeDeadline(
      revokedPromise,
      responseDeadlineAt,
      { urls: new Set<string>(), readable: false },
    );
    return settleBeforeDeadline(
      serveIsolateFallback(attempt.reason, attempt.at, revoked),
      responseDeadlineAt,
      unavailable,
    );
  };

  let leaderSlot: ReturnType<typeof beginDigestAttempt> | null = null;
  let leaderFailure: FailedDigestAttempt | null = null;

  try {
    // cachedFetchJsonWithMeta reports whether the fetcher actually ran, which
    // the plain wrapper hides. Publishing on a cache hit would mean a full
    // read+write of the ~126KB snapshot on EVERY request, awaited before the
    // response, and would re-stamp acceptance for content that had not changed.
    const cachedResult = await settleBeforeDeadline(
      cachedFetchJsonWithMeta<ListFeedDigestResponse>(
        digestCacheKey,
        900,
        async () => {
          leaderSlot = beginDigestAttempt(variant, lang, attemptedAt);
          try {
            const result = await buildDigest(variant, lang, (await revokedPromise).urls);
            const totalItems = Object.values(result.categories).reduce((sum, b) => sum + b.items.length, 0);
            if (totalItems > 0) {
              completeDigestAttempt(variant, lang, leaderSlot);
              return result;
            }
            leaderFailure = publishFailedAttempt(
              variant,
              lang,
              digestCacheKey,
              leaderSlot,
              'empty-rebuild',
              120,
            );
            completeDigestAttempt(variant, lang, leaderSlot);
            return null;
          } catch (err) {
            leaderFailure = publishFailedAttempt(
              variant,
              lang,
              digestCacheKey,
              leaderSlot,
              'build-error',
              30,
            );
            completeDigestAttempt(variant, lang, leaderSlot);
            throw err;
          }
        },
        120,
        {
          timeoutMs: DIGEST_RESPONSE_TIMEOUT_MS,
          // The fetcher publishes attempt + sentinel atomically. Letting the
          // generic wrapper write its own sentinel first would detach identity.
          cacheFailures: false,
          shouldFetch: () => shouldStartDigestAttempt(digestCacheKey),
        },
      ),
      responseDeadlineAt,
      { data: null, source: 'skipped', leader: false },
    );
    const { data: fresh, source, leader } = cachedResult;

    if (fresh === null) {
      markNoCacheResponse(ctx.request);
      if (leaderSlot && !leaderFailure) {
        leaderFailure = publishFailedAttempt(
          variant,
          lang,
          digestCacheKey,
          leaderSlot,
          'build-error',
          30,
        );
        completeDigestAttempt(variant, lang, leaderSlot);
      }
      return await serveDegraded('empty-rebuild', leaderFailure, source !== 'cache');
    }

    if (fallbackDigestCache.size > 50) fallbackDigestCache.clear();
    // Anchor the isolate entry to the CONTENT clock, exactly like acceptedAt:
    // stamping Date.now() re-aged unchanged content on every cache hit, so a
    // steadily-hit digest never expired from this tier and a later replay
    // reported an age measured from the last request rather than the build.
    const contentTs = Date.parse(fresh.generatedAt ?? '');
    fallbackDigestCache.set(fallbackKey, {
      data: fresh,
      ts: Number.isFinite(contentTs) ? contentTs : Date.now(),
    });
    // Revocation is a SERVE-time gate. Applying it only inside buildDigest
    // would let a cache hit replay the pre-revocation body for up to 900s.
    // The read has been in flight since t=0, so this await is essentially
    // free by the time a build has run.
    const revoked = await settleBeforeDeadline(
      revokedPromise,
      responseDeadlineAt,
      { urls: new Set<string>(), readable: false },
    );
    if (!revoked.readable) {
      console.warn(
        `[digest-serving] outcome=unavailable reason=revocations-unreadable variant=${variant} lang=${lang} tier=fresh`,
      );
      captureSilentError(new Error('revocation set unreadable on fresh serving path'), {
        tags: { surface: 'news', component: 'digest-lastgood', stage: 'revocation-read', variant, lang },
        fingerprint: ['digest-lastgood', 'revocations-unreadable-fresh'],
      });
      markNoCacheResponse(ctx.request);
      return empty(fresh.coverage?.attemptedAt || attemptedAt, '');
    }
    // Only the coalescing LEADER of a real build publishes: followers resolve
    // with source 'fresh' too, and each would repeat the full ~126KB guarded
    // write for a body identical to the one the leader just published. The
    // deadline gate keeps the worst case inside the 25s Edge ceiling: a
    // maximally slow build (~19s with its own cache writes) plus this
    // publish's worst case (~6.5s of Redis timeouts) would exceed it, and
    // the publish is best-effort by contract — skipping it under pressure
    // loses nothing the next uncontended build will not restore.
    if (source === 'fresh' && leader) {
      if (Date.now() - requestStart <= PUBLISH_DEADLINE_CUTOFF_MS) {
        await settleBeforeDeadline(
          publishAcceptedSnapshot(variant, lang, fresh),
          responseDeadlineAt,
          undefined,
        );
      } else {
        console.warn(
          `[digest-lastgood] publish skipped (over deadline budget) variant=${variant} lang=${lang} ` +
            `elapsed_ms=${Date.now() - requestStart}`,
        );
      }
    }
    // #7084: while ANY revocation is live, stop feeding shared caches. This
    // endpoint is the gateway's `slow` tier (s-maxage=1800, CDN-Cache-Control
    // s-maxage=3600), so without this an operator's SADD left the revoked item
    // being served from the CDN for up to an hour from the very endpoint the
    // runbook calls clean. This does not evict copies already stored — the
    // runbook in _lastgood.ts still requires a purge for those — it stops new
    // ones accumulating for as long as the suppression is in force.
    if (revoked.urls.size > 0) markNoCacheResponse(ctx.request);
    const { data: served, dropped } = suppressRevoked(fresh, revoked.urls);
    if (dropped > 0) {
      console.log(`[digest-serving] outcome=fresh variant=${variant} lang=${lang} revoked_dropped=${dropped}`);
    }
    return served;
  } catch {
    markNoCacheResponse(ctx.request);
    // A cache-layer timeout rejects outside the fetcher. Name it from the
    // leader's request-start clock without waiting for telemetry; followers
    // recover the same in-isolate identity.
    if (leaderSlot && !leaderFailure) {
      leaderFailure = publishFailedAttempt(
        variant,
        lang,
        digestCacheKey,
        leaderSlot,
        'build-error',
        30,
      );
      completeDigestAttempt(variant, lang, leaderSlot);
    }
    return await serveDegraded('build-error', leaderFailure);
  }
}

function redisPipelineConfirmed(
  results: Array<{ result?: unknown; error?: string }>,
  expectedCommands: number,
): boolean {
  return results.length === expectedCommands && results.every(result => !result?.error);
}

/**
 * The prune is destructive, so this gate takes no staleness budget: the marker
 * handed in was written by THIS publication and must already reach `nowMs`.
 * (The read path in seed-forecast-resolutions.mjs is the only caller that opts
 * into FORECAST_EVIDENCE_COVERAGE_MAX_LAG_MS.)
 *
 * `evidenceDropped` is deliberately separate from `evidenceWritesConfirmed`:
 * a story whose member could not be built never reached Redis, so it says
 * nothing about whether the writes that DID happen were confirmed. It still
 * blocks the marker advance (and therefore this gate, via coverageAdvanced),
 * but it must not be laundered into a write-failure signal.
 */
function shouldPruneAccumulator(options: {
  evidenceEligible: boolean;
  cutoverEnabled: boolean;
  coverage: unknown;
  nowMs: number;
  trackingWritesConfirmed: boolean;
  evidenceWritesConfirmed: boolean;
  coverageAdvanced: boolean;
  accumulatorTtlConfirmed: boolean;
}): boolean {
  if (!options.trackingWritesConfirmed || !options.accumulatorTtlConfirmed) return false;
  if (!options.evidenceEligible) return true;
  return options.cutoverEnabled
    && options.evidenceWritesConfirmed
    && options.coverageAdvanced
    && forecastEvidenceCoversWindow(
      options.coverage,
      options.nowMs - FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
      options.nowMs,
    );
}
/**
 * Build the HSET field list for a story:track:v1 row.
 *
 * Description is written UNCONDITIONALLY (empty string when the current
 * mention has no body). Rationale: story:track rows are collapsed by
 * normalized-title hash, so multiple wire reports of the same event share a
 * row. If we only wrote description when non-empty, an earlier mention's
 * body would persist on subsequent body-less mentions for up to STORY_TTL
 * (7 days), and consumers would unknowingly ground LLMs on "some mention's
 * body" rather than "this mention's body" — violating the grounding
 * contract advertised to brief / whyMatters / SummarizeArticle. Writing
 * empty is the authoritative signal that the current mention has no body;
 * consumers then fall back to the cleaned headline (R6) honestly, and the
 * next mention with a body re-populates the field naturally.
 */
function buildStoryTrackHsetFields(
  item: ParsedItem,
  nowStr: string,
  score: number,
  anchorEligible = isAnchorEligible(item),
): Array<string | number> {
  return [
    'lastSeen', nowStr,
    'currentScore', score,
    // Canonical adoption may use firstSeen only when this server-derived
    // eligibility stamp is present. Legacy rows without it fail closed.
    'anchorEligible', anchorEligible ? '1' : '0',
    'title', item.title,
    'link', item.link,
    'severity', item.level,
    'lang', item.lang,
    'description', item.description ?? '',
    // Source publishedAt (the article's actual publication time as parsed
    // from the RSS pubDate or Dublin Core fallback). Persisted so READ-time
    // consumers — buildDigest's freshness floor and the U6 audit's
    // age-mode — can drop residual stale entries that pre-date an
    // ingest-side gate tightening. See:
    //   skill: ingest-gate-tightening-leaves-residue-in-read-path.
    // Defensive cast: write '' when publishedAt isn't a finite number so
    // the field never holds the literal "undefined"/"NaN" string. Read-side
    // parseInt('') yields NaN → falls through the missing-field branch
    // (treats as legacy row) instead of being mis-classified as a stale
    // row with a bogus timestamp.
    'publishedAt', Number.isFinite(item.publishedAt) ? String(item.publishedAt) : '',
    // Entity-level cross-title corroboration count. Distinct from exact
    // normalized-title sourceCount: this captures related flashpoint +
    // diplomacy reports that do not collapse into the same story hash.
    // The digest composer uses it as a narrow lead/card coherence signal.
    'entityCorroborationCount', Number.isFinite(item.entityCorroborationCount)
      ? String(item.entityCorroborationCount)
      : '0',
    // Non-event brief flag (classifyOpinion). '1' = op-ed/column or
    // historical explainer, '0' = hard news. The legacy `isOpinion` field
    // name remains for cache compatibility; buildDigest excludes '1' rows
    // from the brief pool. Written unconditionally for the same
    // shared-row reason as `description` above: story:track rows are
    // collapsed by normalised-title hash, so a stale '1' from an earlier
    // mention must be overwritten by the current mention's verdict.
    // Pre-stamp rows (ingested before this shipped) have no field at
    // all; buildDigest re-classifies those from title/link/description.
    'isOpinion', item.isOpinion ? '1' : '0',
    // Feel-good / lifestyle flag (classifyFeelGood). Sibling to
    // isOpinion — same write semantics, same buildDigest read-path
    // exclusion. Pre-stamp rows are re-classified by buildDigest from
    // title/link/description (residue catch).
    'isFeelGood', item.isFeelGood ? '1' : '0',
    // Ephemeral live-programming flag (classifyEphemeralLiveCoverage).
    // Same write semantics as the opinion/feel-good stamps: overwrite on
    // every mention so a collapsed story row reflects the current headline
    // verdict; buildDigest re-classifies pre-stamp rows for the TTL window.
    'isEphemeralLiveCoverage', item.isEphemeralLiveCoverage ? '1' : '0',
    // Event category (classifyByKeyword EventCategory enum, possibly
    // overridden by enrichWithAiCache). Persisted so the brief's
    // threads card + magazine story-page + public-thread fallback
    // can display a meaningful per-story tag instead of defaulting
    // to 'General' for every story. Defensive empty-string write on
    // missing/non-string: shared/brief-filter.js:384's
    // `asTrimmedString(raw.category) || 'General'` fallback converts
    // empty back to 'General' for graceful degradation. See plan
    // docs/plans/2026-05-17-002-fix-persist-story-track-category-plan.md.
    'category', typeof item.category === 'string' ? item.category : '',
  ];
}

async function writeStoryTracking(
  items: ParsedItem[],
  variant: string,
  lang: string,
  hashes: string[],
  memberHashesByFinal?: Map<string, Set<string>>,
  deadlineAt = Number.POSITIVE_INFINITY,
  clusterAnchorEligibleByHash?: ReadonlyMap<string, boolean>,
): Promise<void> {
  if (items.length === 0) return;
  if (redisTimeoutForDeadline(deadlineAt) === undefined) {
    console.warn('[digest] story tracking deadline reached before writes');
    return;
  }
  const now = Date.now();
  const accKey = DIGEST_ACCUMULATOR_KEY(variant, lang);
  // The archive/coverage keys are written raw (see the pipeline call below), so
  // getKeyPrefix() does NOT isolate them per deployment the way the accumulator
  // ZADD on the adjacent line is isolated. Preview and dev deployments share
  // this Upstash instance, and the marker they would rewrite is the artefact
  // that authorises destructive accumulator pruning — so production is the only
  // deployment allowed to publish evidence at all.
  const productionDeployment = (process.env.VERCEL_ENV ?? 'production') === 'production';
  const evidenceEligible = isEligibleForecastEvidence(variant, lang) && productionDeployment;
  const cutoverEnabled = process.env.FORECAST_EVIDENCE_CUTOVER_ENABLED === '1';
  const coverageRead = evidenceEligible
    ? await readCachedJson(FORECAST_EVIDENCE_COVERAGE_KEY, true)
    : { status: 'miss' as const };
  const coverageReadConfirmed = !evidenceEligible || coverageRead.status !== 'error';
  const coverageBefore = evidenceEligible && coverageRead.status === 'hit'
    ? parseForecastEvidenceCoverage(coverageRead.value)
    : null;
  // #7082 evidence archive publication counters (operator visibility).
  let evidenceAttempted = 0;
  let evidenceDropped = 0;
  let trackingWritesConfirmed = true;
  let evidenceWritesConfirmed = coverageReadConfirmed;

  const runPipelineBeforeDeadline = async (
    commands: Array<Array<string | number>>,
    raw = false,
  ) => {
    const timeoutMs = redisTimeoutForDeadline(deadlineAt);
    if (timeoutMs === undefined) return [];
    return runRedisPipeline(commands, raw, timeoutMs);
  };

  // #4919/#4924: with fuzzy story identity, N same-cycle wording variants
  // share one titleHash. Mutable per-story writes (mentionCount HINCRBY,
  // HSET representative fields) must run ONCE per unique hash per cycle —
  // per-item they would inflate mentionCount by N per cycle (a 6-variant
  // story would skip DEVELOPING straight to SUSTAINED, since the read
  // path treats mentionCount as +1/cycle) and let whichever member
  // iterated last overwrite the representative fields nondeterministically.
  // Representative = highest importanceScore, tie-break newest publishedAt
  // then title — deterministic for a given batch. Per-MEMBER writes that
  // are set-shaped stay per item: SADD source (distinct-source set is the
  // point of corroboration) and ZADD peak GT (max is idempotent).
  const representativeByHash = new Map<string, ParsedItem>();
  const displayedAnchorEligibleByHash = new Map<string, boolean>();
  for (let i = 0; i < items.length; i++) {
    const hash = hashes[i]!;
    const item = items[i]!;
    if (isAnchorEligible(item)) displayedAnchorEligibleByHash.set(hash, true);
    const current = representativeByHash.get(hash);
    if (
      !current
      || item.importanceScore > current.importanceScore
      || (item.importanceScore === current.importanceScore && item.publishedAt > current.publishedAt)
      || (item.importanceScore === current.importanceScore && item.publishedAt === current.publishedAt
        && item.title < current.title)
    ) {
      representativeByHash.set(hash, item);
    }
  }

  const writtenHashes = new Set<string>();
  const aliasMembersByFinal = new Map<string, Set<string>>();
  let trackingStopped = false;
  for (let batchStart = 0; batchStart < items.length; batchStart += STORY_BATCH_SIZE) {
    const batch = items.slice(batchStart, batchStart + STORY_BATCH_SIZE);
    const commands: Array<Array<string | number>> = [];
    const evidenceBatchCommands: Array<Array<string | number>> = [];

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]!;
      const hash = hashes[batchStart + i]!;
      const trackKey = STORY_TRACK_KEY(hash);
      const sourcesKey = STORY_SOURCES_KEY(hash);
      const peakKey = STORY_PEAK_KEY(hash);
      const score = item.importanceScore;
      const nowStr = String(now);
      const ttl = STORY_TTL;

      if (!writtenHashes.has(hash)) {
        writtenHashes.add(hash);
        const representative = representativeByHash.get(hash) ?? item;
        const hsetFieldsWithEligibility = buildStoryTrackHsetFields(
          representative,
          nowStr,
          representative.importanceScore,
          clusterAnchorEligibleByHash?.get(hash)
            ?? displayedAnchorEligibleByHash.get(hash)
            ?? false,
        );
        const anchorFieldAt = hsetFieldsWithEligibility.indexOf('anchorEligible');
        const anchorEligible = anchorFieldAt >= 0
          && hsetFieldsWithEligibility[anchorFieldAt + 1] === '1';
        const hsetFields = anchorFieldAt >= 0
          ? [
            ...hsetFieldsWithEligibility.slice(0, anchorFieldAt),
            ...hsetFieldsWithEligibility.slice(anchorFieldAt + 2),
          ]
          : hsetFieldsWithEligibility;
        commands.push(
          ['HINCRBY', trackKey, 'mentionCount', '1'],
          ['HSET', trackKey, ...hsetFields],
          // Eligibility is monotonic: an eligible mention upgrades the stamp,
          // while an ineligible mention can initialize it to 0 without
          // erasing a prior 1. Exactly one command handles the field, keeping
          // every Redis request inside the hard command budget.
          anchorEligible
            ? ['HSET', trackKey, 'anchorEligible', '1']
            : ['HSETNX', trackKey, 'anchorEligible', '0'],
          ['HSETNX', trackKey, 'firstSeen', nowStr],
          ['EXPIRE', trackKey, ttl],
          ['ZADD', accKey, nowStr, hash],
        );
        // #7082 dual publication: forecast judging needs this story for up
        // to 14 days, beyond the accumulator's retention contract. The
        // evidence archive member is self-contained (title/link/description
        // ride on the member; no story:track dependency) and only the
        // full/English scope that judging actually reads is archived.
        if (evidenceEligible) {
          const evidenceMember = buildForecastEvidenceMember(
            {
              hash,
              title: representative.title,
              link: representative.link,
              description: representative.description,
              publishedAt: representative.publishedAt,
            },
            now,
          );
          if (evidenceMember) {
            // The ZSet member is the stable story hash. Mutable lastSeen and
            // representative fields live in a self-contained, independently
            // retained record key, so refreshing one story cannot create a
            // second index member or crowd unique evidence out of the cap.
            evidenceBatchCommands.push(['SET', forecastEvidenceRecordKey(hash), evidenceMember, 'EX', FORECAST_EVIDENCE_TTL_S]);
            evidenceBatchCommands.push(['ZADD', FORECAST_EVIDENCE_KEY, nowStr, hash]);
            evidenceAttempted += 1;
          } else {
            // Counted, but NOT folded into evidenceWritesConfirmed: nothing was
            // attempted against Redis, so this says nothing about whether the
            // writes that did happen were confirmed. evidenceDropped gates the
            // coverage advance on its own below.
            evidenceDropped += 1;
          }
        }
        // Alias rows publish canonical continuity. Keep each final-hash group
        // separate from the mutable tracking pipeline so it can be committed
        // atomically only after all base tracking writes are confirmed.
        const aliasMembers = memberHashesByFinal?.get(hash);
        if (aliasMembers?.size) aliasMembersByFinal.set(hash, new Set(aliasMembers));
      }

      commands.push(
        ['ZADD', peakKey, 'GT', score, 'peak'],
        ['SADD', sourcesKey, item.source],
        // #4924 review P2 (TTL ordering): EXPIRE must follow the SADD/ZADD
        // that CREATE these keys — EXPIRE on a missing key is a no-op, so
        // the pre-block ordering left brand-new story:sources/story:peak
        // keys persistent forever. Idempotent per member; kept adjacent to
        // the creating writes so no future reorder can reopen the leak.
        ['EXPIRE', sourcesKey, ttl],
        ['EXPIRE', peakKey, ttl],
      );
    }

    // Tracking and evidence touch disjoint keyspaces and neither reads the
    // other's result, so evidence stays in flight while tracking chunks are
    // sent in order. Each request receives the digest's remaining budget;
    // after any failed or expired chunk we stop rather than starting more
    // writes that can outlive the cold response.
    //
    // Archive keys are deliberately raw: the Railway resolver and backfill
    // operate outside a Vercel deployment prefix and must read this same
    // durable evidence namespace.
    const evidenceTimeoutMs = redisTimeoutForDeadline(deadlineAt);
    const evidencePromise = evidenceEligible && evidenceTimeoutMs !== undefined
      ? runRedisPipeline(evidenceBatchCommands, true, evidenceTimeoutMs)
      : Promise.resolve([]);
    if (evidenceEligible && evidenceTimeoutMs === undefined) evidenceWritesConfirmed = false;
    for (const trackingChunk of chunkRedisCommands(commands)) {
      const trackingTimeoutMs = redisTimeoutForDeadline(deadlineAt);
      if (trackingTimeoutMs === undefined) {
        console.warn('[digest] story tracking deadline reached; skipped remaining writes');
        trackingWritesConfirmed = false;
        trackingStopped = true;
        break;
      }
      const trackingResults = await runRedisPipeline(trackingChunk, false, trackingTimeoutMs);
      if (!redisPipelineConfirmed(trackingResults, trackingChunk.length)) {
        trackingWritesConfirmed = false;
        trackingStopped = true;
        break;
      }
    }
    const evidenceResults = await evidencePromise;
    if (evidenceEligible) {
      if (!redisPipelineConfirmed(evidenceResults, evidenceBatchCommands.length)) {
        evidenceWritesConfirmed = false;
      }
    }
    if (trackingStopped) break;
  }

  // Alias rows decide whether a later, differently-worded batch can retain a
  // live canonical. They must never be sliced at an arbitrary pipeline
  // boundary: publish each complete canonical group atomically only after all
  // base tracking writes have confirmed. A short, shared publication lease
  // keeps separate Edge isolates and digest scopes from racing. Each Lua call
  // checks its token inside Redis, which fences an older request that was
  // delayed until after the lease expired. A group above the Redis command
  // limit is deliberately deferred; preserving its prior aliases is safer
  // than exposing a partial new cohort.
  if (trackingWritesConfirmed && aliasMembersByFinal.size > 0) {
    const aliasTimeoutMs = redisTimeoutForDeadline(deadlineAt);
    if (aliasTimeoutMs === undefined) {
      console.warn('[digest] story alias deadline reached; skipped alias publication');
      trackingWritesConfirmed = false;
    } else {
      // Keep the lease no longer than the request timeout. If an abort races
      // with a late Redis execution, its orphaned lease can then block later
      // publishers for at most the existing five-second Redis bound. A lease
      // that expires during a long publication is safe: the fenced script
      // rejects every remaining call before it writes aliases.
      const aliasLeaseMs = aliasTimeoutMs;
      const aliasLockToken = crypto.randomUUID();
      const aliasLockResults = await runRedisPipeline([[
        'SET',
        STORY_ALIAS_PUBLICATION_LOCK_KEY,
        aliasLockToken,
        'NX',
        'PX',
        aliasLeaseMs,
      ]], false, aliasTimeoutMs);
      const aliasLockAcquired = aliasLockResults.length === 1
        && aliasLockResults[0]?.result === 'OK';
      if (!aliasLockAcquired) {
        console.warn('[digest] story alias publication lease unavailable; preserved live aliases');
      } else {
        const aliasScriptCommands: Array<Array<string | number>> = [];
        for (const [hash, memberHashes] of aliasMembersByFinal) {
          if (memberHashes.size > MAX_REDIS_PIPELINE_COMMANDS) {
            console.warn(
              `[digest] deferred ${memberHashes.size} story aliases for ${hash.slice(0, 12)}; group exceeds Redis transaction limit`,
            );
            trackingWritesConfirmed = false;
            break;
          }
          const aliasKeys = [...memberHashes].map(STORY_ALIAS_KEY);
          aliasScriptCommands.push([
            'EVAL',
            STORY_ALIAS_PUBLISH_SCRIPT,
            String(aliasKeys.length + 1),
            STORY_ALIAS_PUBLICATION_LOCK_KEY,
            ...aliasKeys,
            aliasLockToken,
            hash,
            String(STORY_TTL),
          ]);
        }
        if (trackingWritesConfirmed) {
          // One EVAL is one bounded pipeline command even when the script writes
          // a full alias group. Batch the independent, fenced group scripts so
          // a high-cardinality digest cannot spend one network round-trip per
          // story; each EVAL remains atomic on Redis.
          for (const aliasScriptChunk of chunkRedisCommands(aliasScriptCommands)) {
            const groupTimeoutMs = redisTimeoutForDeadline(deadlineAt);
            if (groupTimeoutMs === undefined) {
              console.warn('[digest] story alias deadline reached; skipped remaining alias groups');
              trackingWritesConfirmed = false;
              break;
            }
            const aliasResults = await runRedisPipeline(aliasScriptChunk, false, groupTimeoutMs);
            if (
              aliasResults.length !== aliasScriptChunk.length
              || aliasResults.some((result) => result?.result !== 1)
            ) {
              console.warn('[digest] story alias publication was not confirmed; stopped remaining groups');
              trackingWritesConfirmed = false;
              break;
            }
          }
        }
      }
    }
  }

  if (redisTimeoutForDeadline(deadlineAt) === undefined) {
    console.warn('[digest] story tracking deadline reached before maintenance writes');
    return;
  }

  // Refresh accumulator TTL once per build. The TTL is abandoned-key cleanup
  // only: member retention is the explicit prune below (#7082) — millions of
  // expired members previously lived here forever because the TTL never
  // removed them.
  const accumulatorTtlCommands: Array<Array<string | number>> = [['EXPIRE', accKey, DIGEST_ACCUMULATOR_TTL]];
  const accumulatorTtlResults = await runPipelineBeforeDeadline(accumulatorTtlCommands);
  const accumulatorTtlConfirmed = redisPipelineConfirmed(accumulatorTtlResults, accumulatorTtlCommands.length);
  let coverageAdvanced = false;
  let coverageAfter = coverageBefore;
  if (evidenceEligible && coverageBefore) {
    const canAdvance = trackingWritesConfirmed && evidenceWritesConfirmed && evidenceDropped === 0;
    // Even when this cycle cannot advance the window, re-SET the marker so its
    // EX is refreshed. Otherwise a condition that recurs for 15 days (a feed
    // that keeps emitting one unbuildable item, say) lets the marker EXPIRE,
    // coverageBefore becomes null forever, and the only way back is another
    // backfill run — a self-inflicted outage on top of a recoverable blip.
    const advanced = advanceForecastEvidenceCoverage(coverageBefore, now);
    coverageAfter = canAdvance && advanced ? advanced : coverageBefore;
    const coverageCommands: Array<Array<string | number>> = [[
      'SET',
      FORECAST_EVIDENCE_COVERAGE_KEY,
      JSON.stringify(coverageAfter),
      'EX',
      FORECAST_EVIDENCE_TTL_S,
    ]];
    const coverageResults = await runPipelineBeforeDeadline(coverageCommands, true);
    coverageAdvanced = canAdvance && redisPipelineConfirmed(coverageResults, coverageCommands.length);
  }

  // For the judged full/en accumulator, pruning is destructive migration:
  // retain legacy evidence until backfill has installed a verified coverage
  // marker AND this cycle's archive writes and coverage update are confirmed.
  // Other accumulator scopes are not used by forecast judging.
  const pruneAllowed = shouldPruneAccumulator({
    evidenceEligible,
    cutoverEnabled,
    coverage: coverageAfter,
    nowMs: now,
    trackingWritesConfirmed,
    evidenceWritesConfirmed,
    coverageAdvanced,
    accumulatorTtlConfirmed,
  });
  let pruneConfirmed = true;
  if (pruneAllowed) {
    const prune = accumulatorPruneBounds(now);
    const pruneCommands: Array<Array<string | number>> = [['ZREMRANGEBYSCORE', accKey, prune.min, prune.max]];
    const pruneResults = await runPipelineBeforeDeadline(pruneCommands);
    // A silently-failing prune is how an unbounded key stays unbounded while
    // the operator log reports a healthy cutover.
    pruneConfirmed = redisPipelineConfirmed(pruneResults, pruneCommands.length);
  }
  const archiveMaintenanceCommands: Array<Array<string | number>> = [];
  if (evidenceEligible) {
    // Rolling archive retention + TTL (contract + guard band).
    const evidencePrune = evidencePruneBounds(now);
    archiveMaintenanceCommands.push(['ZREMRANGEBYSCORE', FORECAST_EVIDENCE_KEY, evidencePrune.min, evidencePrune.max]);
    archiveMaintenanceCommands.push(['EXPIRE', FORECAST_EVIDENCE_KEY, FORECAST_EVIDENCE_TTL_S]);
  }
  const archiveMaintenanceResults = await runPipelineBeforeDeadline(archiveMaintenanceCommands, true);
  const maintenanceConfirmed = redisPipelineConfirmed(archiveMaintenanceResults, archiveMaintenanceCommands.length);
  if (evidenceEligible) {
    // `published` counts what the confirmed pipeline actually wrote. Drops are
    // reported separately — folding them in here reported published=0 for a
    // cycle where every attempted member landed.
    const published = evidenceWritesConfirmed ? evidenceAttempted : 0;
    const message =
      `[forecast-evidence] attempted=${evidenceAttempted} published=${published} dropped=${evidenceDropped} ` +
      `coverage_read_confirmed=${coverageReadConfirmed} tracking_writes_confirmed=${trackingWritesConfirmed} ` +
      `writes_confirmed=${evidenceWritesConfirmed} coverage_advanced=${coverageAdvanced} ` +
      `accumulator_ttl_confirmed=${accumulatorTtlConfirmed} maintenance_confirmed=${maintenanceConfirmed} ` +
      `accumulator_pruned=${pruneAllowed} accumulator_prune_confirmed=${pruneConfirmed} ` +
      `cutover_enabled=${cutoverEnabled} cutover_verified=${pruneAllowed} ` +
      `key=${FORECAST_EVIDENCE_KEY} ttl_s=${FORECAST_EVIDENCE_TTL_S}`;
    if (evidenceWritesConfirmed && coverageAdvanced && maintenanceConfirmed && pruneConfirmed) console.info(message);
    else console.warn(message);
  } else if (!pruneConfirmed) {
    console.warn(`[forecast-evidence] accumulator prune unconfirmed key=${accKey}`);
  }
}

function buildDigestFeedBatches(variant: string, lang: string): {
  allEntries: DigestFeedEntry[];
  batches: DigestFeedEntry[][];
} {
  const feedsByCategory = VARIANT_FEEDS[variant] ?? {};
  const allEntries: DigestFeedEntry[] = [];

  for (const [category, feeds] of Object.entries(feedsByCategory)) {
    const filtered = feeds.filter(f => isServerFeedReachableForLanguage(f, lang));
    for (const feed of filtered) {
      allEntries.push({ attemptId: `${category}:${allEntries.length}`, category, feed });
    }
  }

  if (variant === 'full') {
    const filteredIntel = INTEL_SOURCES.filter(f => isServerFeedReachableForLanguage(f, lang));
    for (const feed of filteredIntel) {
      allEntries.push({ attemptId: `intel:${allEntries.length}`, category: 'intel', feed });
    }
  }

  // #7083: category-fair scheduling, with the deadline-priority promise
  // kept absolute: feeds with deadlinePriority > 0 start first in a cold
  // build (the China coverage trio is market-hours critical), and the rest
  // interleave so the next wave contains the head of every eligible
  // category — a slow category can no longer push all later categories
  // behind the global deadline.
  const priorityOrdered = orderServerFeedEntries(allEntries);
  const priorityHead = priorityOrdered.filter((entry) => (entry.feed.deadlinePriority ?? 0) > 0);
  const orderedEntries = [
    ...priorityHead,
    ...interleaveByCategory(priorityOrdered.filter((entry) => (entry.feed.deadlinePriority ?? 0) <= 0)),
  ];
  const batches: DigestFeedEntry[][] = [];
  for (let i = 0; i < orderedEntries.length; i += BATCH_CONCURRENCY) {
    batches.push(orderedEntries.slice(i, i + BATCH_CONCURRENCY));
  }
  return { allEntries, batches };
}

async function buildDigest(
  variant: string,
  lang: string,
  // #7084: the operator suppression set, threaded in so a revoked item is
  // dropped BEFORE the per-category cap rather than after it. Filtering only
  // at serve time left a hole: the revoked item had already taken a cap slot,
  // so the category shipped 19 items and the 21st-ranked one was never
  // promoted, while droppedCategoryCap still counted the item it displaced.
  revokedUrls: ReadonlySet<string> = new Set(),
): Promise<ListFeedDigestResponse> {
  const feedStatuses: Record<string, string> = {};
  // #4920 coverage ledger: count every silent drop gate so "how much did
  // we NOT show" is a queryable number instead of a feeling.
  const ledgerDrops = { perFeedCap: 0, undated: 0, freshnessFloor: 0, perCategoryCap: 0 };
  const categories: Record<string, CategoryBucket> = {};
  const digestStartedAt = Date.now();

  const deadlineController = new AbortController();
  const deadlineTimeout = setTimeout(() => deadlineController.abort(), OVERALL_DEADLINE_MS);

  try {
    const { allEntries, batches } = buildDigestFeedBatches(variant, lang);

    const results = new Map<string, ParsedItem[]>();
    const buildStart = Date.now();
    const attempts = await runFeedAttemptBatches(
      allEntries,
      batches,
      deadlineController.signal,
      async (entry) => {
        const { category, feed } = entry;
        const result = await fetchAndParseRss(feed, variant, deadlineController.signal);
        const outcome = classifyFeedAttempt(true, result.attempt ?? {
          source: 'cache', failure: null, negativeCache: false,
        }, {
          parsedTotal: result.parsedTotal,
          keptItems: result.items.length,
          droppedUndated: result.droppedUndated,
        });

        // Public feed status keeps the historical four-value contract
        // (docs/methodology + the proto comment): completed feeds carry
        // 'all-undated'/'empty'/'partial-undated', feeds that never
        // completed carry 'timeout'. The fine-grained attempt outcome
        // stays in telemetry, keyed by the unique inventory attempt ID.
        if (result.parsedTotal > 0 && result.items.length === 0 && result.droppedUndated > 0) {
          feedStatuses[feed.name] = 'all-undated';
        } else if (result.items.length === 0) {
          feedStatuses[feed.name] = 'empty';
        } else if (result.droppedUndated > 0) {
          feedStatuses[feed.name] = 'partial-undated';
        }

        return {
          outcome,
          value: {
            category,
            items: result.items,
            droppedUndated: result.droppedUndated,
            droppedFeedCap: result.droppedFeedCap ?? 0,
          },
        };
      },
    );

    for (const { value } of attempts.fulfilled) {
      const { category, items, droppedUndated, droppedFeedCap } = value;
      const existing = results.get(category) ?? [];
      existing.push(...items);
      results.set(category, existing);
      ledgerDrops.undated += droppedUndated;
      ledgerDrops.perFeedCap += droppedFeedCap;
    }

    const deadlineAborted = deadlineController.signal.aborted;
    for (const entry of allEntries) {
      if (!attempts.startedAttemptIds.has(entry.attemptId)) {
        // #7083: this feed's batch never ran. The public map keeps the
        // coarse 'timeout' contract; the precise 'not-started' verdict
        // (scheduling starvation, not an upstream failure) lives in
        // the helper's attempt-outcome map and telemetry line.
        feedStatuses[entry.feed.name] = 'timeout';
      }
    }

    // #7083 operator telemetry: one structured line per build with the
    // outcome histogram, per-category coverage, and the timings needed to
    // see which stage consumes the deadline. No host names or exceptions
    // here — details stay in the [feed-fetch] lines.
    {
      const { byOutcome, byCategory, headroomMs } = summarizeFeedAttempts(
        attempts.attemptCategories,
        attempts.attemptOutcomes,
        OVERALL_DEADLINE_MS,
        attempts.finalCompletionMs ?? Date.now() - buildStart,
      );
      console.info(
        `[digest-attempts] variant=${variant} lang=${lang} feeds=${allEntries.length} ` +
        `deadline_aborted=${deadlineAborted} first_start_ms=${attempts.firstStartMs ?? 'n/a'} ` +
        `first_completion_ms=${attempts.firstCompletionMs ?? 'n/a'} final_completion_ms=${attempts.finalCompletionMs ?? 'n/a'} ` +
        `headroom_ms=${headroomMs} by_outcome=${JSON.stringify(byOutcome)} by_category=${JSON.stringify(byCategory)}`,
      );
    }

    // U3 — hard freshness floor. Drop items older than NEWS_MAX_AGE_HOURS
    // (default 96h) BEFORE corroboration counting so a stale duplicate of a
    // fresh story can't inflate the cluster's source count. Runs after parse
    // (where U2 already dropped undated items) so every item here carries a
    // real publishedAt. See R3.
    const maxAgeMs = resolveMaxAgeMs();
    const freshnessCutoff = Date.now() - maxAgeMs;
    let droppedStaleTotal = 0;
    for (const [category, items] of results) {
      const fresh = items.filter((it) => it.publishedAt >= freshnessCutoff);
      droppedStaleTotal += items.length - fresh.length;
      results.set(category, fresh);
    }
    ledgerDrops.freshnessFloor = droppedStaleTotal;
    if (droppedStaleTotal > 0) {
      console.warn(
        `[digest] freshness floor dropped ${droppedStaleTotal} stale items ` +
          `(max age: ${maxAgeMs / (60 * 60 * 1000)}h)`,
      );
    }

    // Flatten ALL items before any truncation so cross-category corroboration is counted.
    const allItems = [...results.values()].flat();

    // #4919: fuzzy story identity. Items are clustered by the shared
    // story-identity similarity (edit-tolerant: suffixes, truncations,
    // qualifier swaps, reorders, morphology) and every cluster member
    // shares one canonical titleHash + a cluster-wide corroboration
    // count. The previous exact sha256(normalizeTitle) identity forked a
    // story on ANY wording edit, so corroboration only counted verbatim
    // wire syndication — deflating importanceScore's corroboration
    // signal and the BREAKING/DEVELOPING phase tracker. Singleton
    // clusters hash exactly as before, so story:track keys for
    // uncorroborated stories are unchanged.
    const identityByItem = await assignStoryIdentity(allItems, normalizeTitle, sha256Hex);

    // #4924 review P1: adopt a LIVE canonical before assigning hashes.
    // Alias rows (memberHash -> canonicalHash, story-track TTL) written by
    // previous cycles let a cluster keep its story identity when the
    // member that anchored the canonical drops out of the batch.
    //
    // #4925 item 1: the alias vote is most-common-wins, and how many member
    // hashes point at a canonical is something a determined feed can move —
    // publish several wordings, they alias to your canonical, out-vote the
    // genuine story and absorb its track (phase re-fires, counts reset).
    // story:track.firstSeen cannot be moved that way: the digest HSETNXs it
    // at first observation, so it is server-side state, unlike publishedAt,
    // which decides the batch-derived default and is publisher-controlled.
    // Read it alongside the alias row and prefer the oldest live track.
    // A failed or skipped chunk degrades affected clusters to batch-derived
    // canonicals (pre-adoption behavior).
    const allMemberHashes = new Set<string>();
    // If no eligible persisted track can be adopted, a current trusted or
    // independently corroborated member may still provide the batch default.
    // Prefer a trusted-tier member over a merely corroborated one, then use
    // the same deterministic publication-time ordering as identity clustering.
    const eligibleAnchorByCluster = new Map<string, ParsedItem>();
    for (const identity of identityByItem.values()) {
      for (const h of identity.memberTitleHashes ?? []) allMemberHashes.add(h);
    }
    for (const [item, identity] of identityByItem) {
      if (!isIdentityAnchorEligible(item, identity.corroborationCount)) continue;
      const current = eligibleAnchorByCluster.get(identity.titleHash);
      if (!current || compareAnchorCandidates(item, current) < 0) {
        eligibleAnchorByCluster.set(identity.titleHash, item);
      }
    }
    const eligibleDefaultHashByCluster = new Map<string, string>();
    await Promise.all([...eligibleAnchorByCluster].map(async ([clusterHash, item]) => {
      const normalized = normalizeTitle(item.title);
      if (normalized) eligibleDefaultHashByCluster.set(clusterHash, await sha256Hex(normalized));
    }));
    const aliasTargetByHash = new Map<string, string>();
    const trackFirstSeenByHash = new Map<string, number>();
    const memberHashes = [...allMemberHashes];
    // Chunked because this read now carries two commands per member hash, and
    // a full batch runs to four figures of hashes — the alias read was already
    // unchunked at one command each, which STORY_BATCH_SIZE's own comment says
    // is the wrong side of Upstash's 1000-command cap. readAdoptionState keeps
    // both reads for a hash in one atomic MULTI/EXEC call, validates the whole
    // response before applying either map, and enforces one digest deadline.
    const adoptionState = await readAdoptionState(
      memberHashes,
      freshnessCutoff,
      digestStartedAt + ADOPTION_DEADLINE_MS,
    );
    const { aliasTargetByHash: adoptionAliases, trackFirstSeenByHash: adoptionTracks } = adoptionState;
    for (const [hash, target] of adoptionAliases) aliasTargetByHash.set(hash, target);
    for (const [hash, firstSeen] of adoptionTracks) trackFirstSeenByHash.set(hash, firstSeen);

    // Do not overwrite a live alias cohort when this build could not confirm
    // all of the cluster's prior state. The batch default is safe only for
    // serving this response; persisting it would erase continuity evidence
    // and let a transient Redis failure re-fork the next cycle.
    const incompleteIdentityHashes = new Set<string>();
    await Promise.all(allItems.map(async (item) => {
      const identity = identityByItem.get(item);
      if (identity) {
        const clusterReadIncomplete = (identity.memberTitleHashes ?? [])
          .some((hash) => adoptionState.incompleteHashes.has(hash));
        if (clusterReadIncomplete) incompleteIdentityHashes.add(identity.titleHash);
        const batchDefaultHash = eligibleDefaultHashByCluster.get(identity.titleHash) ?? identity.titleHash;
        item.titleHash = clusterReadIncomplete
          ? batchDefaultHash
          : adoptExistingCanonical(
            identity.memberTitleHashes,
            batchDefaultHash,
            aliasTargetByHash,
            trackFirstSeenByHash,
          );
        item.corroborationCount = identity.corroborationCount;
      } else {
        // Defensive: assignStoryIdentity covers every input by
        // construction; degrade to the pre-#4919 exact identity if not —
        // and say so, or a future coverage-invariant break is invisible.
        console.warn(
          `[digest] story-identity coverage miss — exact-hash fallback for "${item.title.slice(0, 60)}"`,
        );
        item.titleHash = await sha256Hex(normalizeTitle(item.title));
        item.corroborationCount = 1;
      }
    }));

    // Category capping happens after identity. A trusted/corroborated member
    // can therefore be absent from allSliced while a lower-tier cluster member
    // is retained. Preserve the full cluster's eligibility on the canonical
    // track instead of deriving it only from the displayed representative.
    const clusterAnchorEligibleByFinalHash = new Map<string, boolean>();
    for (const item of allItems) {
      if (item.titleHash && isAnchorEligible(item)) {
        clusterAnchorEligibleByFinalHash.set(item.titleHash, true);
      }
    }

    // Final(post-adoption) hash -> member exact-title hashes, consumed by
    // writeStoryTracking to persist next cycle's alias rows.
    const memberHashesByFinal = new Map<string, Set<string>>();
    for (const item of allItems) {
      const identity = identityByItem.get(item);
      if (!identity || !item.titleHash || incompleteIdentityHashes.has(identity.titleHash)) continue;
      let set = memberHashesByFinal.get(item.titleHash);
      if (!set) { set = new Set(); memberHashesByFinal.set(item.titleHash, set); }
      for (const h of identity.memberTitleHashes ?? []) set.add(h);
    }

    // Enrich ALL items with the AI classification cache BEFORE scoring so that
    // importanceScore uses the final (post-LLM) threat level, and truncation
    // discards items based on their true score.
    await enrichWithAiCache(allItems);

    const entityCorroborationSignals = computeEntityCorroborationSignals(allItems);
    let diplomacySignalCount = 0;
    let entityCorroborationHitCount = 0;
    let diplomacySeverityPromotionCount = 0;
    let llmScoredCount = 0;
    let keywordFallbackScoredCount = 0;

    // Compute importance score using final (post-enrichment) threat levels.
    for (const item of allItems) {
      const entitySignal = entityCorroborationSignals.get(item.titleHash!);
      item.entityCorroborationCount = entitySignal?.sourceCount ?? 0;
      const promotedLevel = promoteDiplomacySeverity(
        item.level,
        item.title,
        entitySignal?.tier12SourceCount ?? 0,
      );
      if (promotedLevel !== item.level) {
        item.level = promotedLevel;
        item.isAlert = true;
        diplomacySeverityPromotionCount++;
      }
      const scoringCorroboration = Math.max(item.corroborationCount, item.entityCorroborationCount);
      item.importanceScore = computeImportanceScore(
        item.level,
        item.source,
        scoringCorroboration,
        item.publishedAt,
        {
          title: item.title,
          classSource: item.classSource,
          entityCorroborationCount: item.entityCorroborationCount,
        },
      );
      item.credibilityScore = computeItemCredibilityScore(item, scoringCorroboration);
      if (hasDiplomacyFlashpointSignal(item.title)) diplomacySignalCount++;
      if (item.entityCorroborationCount > 0) entityCorroborationHitCount++;
      if (item.classSource === 'llm') llmScoredCount++;
      else keywordFallbackScoredCount++;
    }

    if (diplomacySignalCount > 0 || entityCorroborationHitCount > 0) {
      console.log(
        `[digest] importance signals llm=${llmScoredCount} ` +
          `keywordFallback=${keywordFallbackScoredCount} ` +
          `diplomacy=${diplomacySignalCount} ` +
          `entityCorroboration=${entityCorroborationHitCount} ` +
          `diplomacySeverityPromotions=${diplomacySeverityPromotionCount}`,
      );
    }

    // Sort by importanceScore desc, then pubDate desc; then truncate per category.
    const slicedByCategory = new Map<string, ParsedItem[]>();
    for (const [category, items] of results) {
      items.sort((a, b) =>
        b.importanceScore - a.importanceScore || b.publishedAt - a.publishedAt,
      );
      // Suppress BEFORE the cap so a revoked item never occupies a slot and
      // the next-ranked item is promoted into it.
      const servable = revokedUrls.size === 0
        ? items
        : items.filter((item) => typeof item.link !== 'string' || !revokedUrls.has(item.link));
      ledgerDrops.perCategoryCap += Math.max(0, servable.length - MAX_ITEMS_PER_CATEGORY);
      slicedByCategory.set(category, servable.slice(0, MAX_ITEMS_PER_CATEGORY));
    }

    const allSliced = [...slicedByCategory.values()].flat();
    // titleHash was already set on each item during the corroboration pass above.
    const titleHashes = allSliced.map(i => i.titleHash!);
    // Leave the response guard intact for final assembly and cache writes.
    // All optional Redis work after feed fetches shares this absolute boundary.
    const storyTrackingDeadlineAt = digestStartedAt + ADOPTION_DEADLINE_MS;

    const now = Date.now();

    // Read existing story tracking BEFORE writing so we know the previous cycle's
    // mentionCount. We merge read state + this cycle's increment in memory to
    // produce accurate, current StoryMeta without a second Redis round-trip.
    const uniqueHashes = [...new Set(titleHashes)];
    const storyTracks = await readStoryTracks(uniqueHashes, storyTrackingDeadlineAt)
      .catch(() => new Map<string, StoryTrack>());

    // Write story tracking. Errors never fail the digest build.
    await writeStoryTracking(
      allSliced,
      variant,
      lang,
      titleHashes,
      memberHashesByFinal,
      storyTrackingDeadlineAt,
      clusterAnchorEligibleByFinalHash,
    ).catch((err: unknown) =>
      console.warn('[digest] story tracking write failed:', err),
    );

    for (const [category, sliced] of slicedByCategory) {
      categories[category] = {
        items: sliced.map((item) => {
          const hash = item.titleHash!;
          // #4919: cluster-wide source count assigned by assignStoryIdentity.
          const sourceCount = item.corroborationCount ?? 1;
          const stale = storyTracks.get(hash);
          // Merge stale state + this cycle's HINCRBY to get the current mentionCount.
          // New stories (stale = undefined) start at mentionCount=1 this cycle.
          const mentionCount = stale ? stale.mentionCount + 1 : 1;
          const firstSeen = stale?.firstSeen ?? now;
          const merged: StoryTrack = {
            firstSeen,
            lastSeen: now,
            mentionCount,
            sourceCount,
          };
          const storyMeta: ProtoStoryMeta = {
            firstSeen,
            mentionCount,
            sourceCount,
            phase: derivePhase(merged, now),
          };
          return toProtoItem(item, storyMeta);
        }),
      };
    }

    // #4920: publish the coverage ledger — every gate's drop count plus
    // what survived — as a side key. Best-effort: ledger failures never
    // fail the digest. Read by ops tooling and the completeness reports;
    // deliberately NOT part of the proto response (no schema change).
    const distinctSources = new Set(allItems.map((item) => item.source)).size;
    const ledger = {
      v: 1,
      generatedAt: Date.now(),
      variant,
      lang,
      itemsIngested: allItems.length,
      itemsServed: allSliced.length,
      distinctSources,
      drops: { ...ledgerDrops },
    };
    // Key-cardinality clamp: variant/lang are request-supplied — only write
    // ledgers for known variants and well-formed 2-letter langs so a caller
    // spraying arbitrary values cannot inflate the keyspace.
    if (VARIANT_FEEDS[variant] && /^[a-z]{2}$/.test(lang)) {
      // #4927 review P2: awaited — a fire-and-forget write can be killed
      // when the response finishes before the side write lands.
      await setCachedJson(`news:coverage-ledger:v1:${variant}:${lang}`, ledger, 7200).catch((err: unknown) =>
        console.warn('[digest] coverage-ledger write failed:', err),
      );
    }

    // #7085 coverage block: one compact summary of the content served and
    // the latest build attempt. Content identity (generatedAt) and attempt
    // identity (attemptedAt) are separate on purpose — they diverge the day
    // durable last-good serving lands (#7084). Counts only: no raw errors,
    // feed URLs, hostnames, or per-host timings leave the server.
    // This describes the BUILD; a replay is stamped by markFallbackCoverageStale.
    const coverage = buildDigestCoverage({
      entries: allEntries,
      attemptOutcomes: attempts.attemptOutcomes,
      itemsServed: allSliced.length,
      publisherSources: allSliced.map((item) => publisherFamilyForItem(item)),
      deadlineAborted: deadlineController.signal.aborted,
      drops: { ...ledgerDrops },
      buildStartMs: buildStart,
    });

    return {
      categories,
      feedStatuses,
      generatedAt: new Date().toISOString(),
      coverage,
    };
  } finally {
    clearTimeout(deadlineTimeout);
  }
}

/** Internal exports for unit tests only — do not import in production code. */
export const __testing__ = {
  // #7084 serving path. Exported so the wiring can be EXECUTED in tests rather
  // than asserted against this file's own source text — a grep for
  // `serveLastGood(...)` passes whether or not the function behaves.
  publishAcceptedSnapshot,
  serveLastGood,
  readRevokedUrlSet,
  suppressRevoked,
  fallbackDigestCache,
  markFallbackCoverageStale,
  settleBeforeDeadline,
  lastGoodStoreTesting,
  beginDigestAttempt,
  completeDigestAttempt,
  publishFailedAttempt,
  recoverFailedAttempt,
  shouldStartDigestAttempt,
  buildDigestFeedBatches,
  parseRssXml,
  isTrustedOriginAggregator,
  decodeXmlEntities,
  extractDescription,
  extractRawTagBody,
  extractFirstDateTag,
  buildStoryTrackHsetFields,
  isAnchorEligible,
  isIdentityAnchorEligible,
  computeImportanceScore,
  computeCredibilityScore,
  computeItemCredibilityScore,
  hasDiplomacyFlashpointSignal,
  promoteDiplomacySeverity,
  computeEntityCorroborationSignals,
  computeEntityCorroborationCounts,
  derivePhase,
  readStoryTracks,
  readAdoptionState,
  redisTimeoutForDeadline,
  chunkRedisCommands,
  resolveMaxAgeMs,
  capLlmUpgrade,
  parseClassifyCacheHit,
  VERCEL_INITIAL_RESPONSE_LIMIT_MS,
  DIGEST_RESPONSE_TIMEOUT_MS,
  POST_FETCH_HEADROOM_MS,
  RESPONSE_GUARD_BAND_MS,
  RESPONSE_DEADLINE_MS,
  OVERALL_DEADLINE_MS,
  ADOPTION_BATCH_SIZE,
  ADOPTION_DEADLINE_MS,
  BATCH_CONCURRENCY,
  redisPipelineConfirmed,
  shouldPruneAccumulator,
  writeStoryTracking,
  MAX_REDIS_PIPELINE_COMMANDS,
  MAX_DESCRIPTION_LEN,
  MIN_DESCRIPTION_LEN,
  FUTURE_DATE_TOLERANCE_MS,
};
