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
import { cachedFetchJson, getCachedJson, setCachedJson, getCachedJsonBatch, runRedisPipeline } from '../../../_shared/redis';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { sha256Hex } from '../../../_shared/hash';
import { CHROME_UA } from '../../../_shared/constants';
import { VARIANT_FEEDS, INTEL_SOURCES, type ServerFeed } from './_feeds';
import { classifyByKeyword, hasHistoricalMarker, type ThreatLevel } from './_classifier';
import { assignStoryIdentity, adoptExistingCanonical } from './dedup.mjs';
import { classifyOpinion } from '../../../_shared/opinion-classifier.js';
import { classifyFeelGood } from '../../../_shared/feelgood-classifier.js';
import { classifyEphemeralLiveCoverage } from '../../../../shared/ephemeral-live-classifier.js';
import { buildTickerDictionary, extractTickers } from '../../../../shared/ticker-extract.js';
import stocksData from '../../../../shared/stocks.json';
import { buildClassifyCacheKey } from '../../intelligence/v1/_shared';
import { getSourceTier } from '../../../_shared/source-tiers';
import {
  STORY_TRACK_KEY,
  STORY_SOURCES_KEY,
  STORY_PEAK_KEY,
  STORY_ALIAS_KEY,
  DIGEST_ACCUMULATOR_KEY,
  STORY_TTL,
  DIGEST_ACCUMULATOR_TTL,
} from '../../../_shared/cache-keys';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';
import diplomacyKeywordsData from '../../../../shared/diplomacy-keywords.json';

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
const OVERALL_DEADLINE_MS = VERCEL_INITIAL_RESPONSE_LIMIT_MS - POST_FETCH_HEADROOM_MS;
const BATCH_CONCURRENCY = 20;

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
  title: string;
  link: string;
  publishedAt: number;
  isAlert: boolean;
  level: ThreatLevel;
  category: string;
  confidence: number;
  classSource: 'keyword' | 'keyword-historical-downgrade' | 'llm';
  importanceScore: number;
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
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  parentSignal.addEventListener('abort', onAbort, { once: true });

  return {
    controller,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal.removeEventListener('abort', onAbort);
    },
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
): Promise<string | null> {
  const { controller, cleanup } = createTimeoutLinkedController(signal);

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': CHROME_UA,
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    // Defensive: upstream may return HTTP 200 with an HTML interstitial
    // (Cloudflare bot challenge, captcha page). Reject up front so the
    // caller's relay fallback fires instead of caching an empty parse.
    if (!looksLikeRssXml(text)) return null;
    return text;
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
  const cacheKey = `rss:feed:v8:${variant}:${feed.url}`;

  try {
    // Read cache unconditionally — the v5 prefix guarantees pre-fix
    // poisoning can't reach this read, so we don't need a parsedTotal
    // bypass. Honoring cached zero-from-zero entries IS the throttle:
    // setCachedJson below writes them with CACHE_TTL_EMPTY_S, so the next
    // request within 5 minutes hits cache instead of upstream. This is
    // what the PR description claimed and what review P1 flagged was
    // missing.
    const cached = (await getCachedJson(cacheKey)) as ParseResult | null;
    if (cached) return cached;

    // Try direct fetch first
    let text = await fetchRssText(feed.url, signal).catch(() => null);
    let source: 'direct' | 'relay' | 'both-failed' = text ? 'direct' : 'both-failed';
    let relayStatus: number | null = null;
    let relayBodyShape: 'rss' | 'html-or-empty' | 'no-relay' | 'fetch-error' = 'no-relay';

    // Fallback: route through Railway relay (different IP, avoids Vercel blocks)
    if (!text) {
      const relayBase = getRelayBaseUrl();
      if (relayBase) {
        relayBodyShape = 'fetch-error';
        const relayUrl = `${relayBase}/rss?url=${encodeURIComponent(feed.url)}`;
        const { controller, cleanup } = createTimeoutLinkedController(signal);
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
        } catch { /* relay also failed */ } finally {
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
      // than the healthy-result TTL.
      const empty: ParseResult = { items: [], parsedTotal: 0, droppedUndated: 0 };
      await setCachedJson(cacheKey, empty, CACHE_TTL_EMPTY_S);
      return empty;
    }

    // parseRssXml returns null on hard parse failure (malformed XML even
    // after surviving the body-shape sniff). Treat that the same as a
    // network failure: cache empty short so we retry sooner.
    const parsed = parseRssXml(text, feed, variant);
    const result: ParseResult = parsed ?? { items: [], parsedTotal: 0, droppedUndated: 0 };
    // Long cache only for healthy parses; short cache for zero-from-zero so
    // transient upstream issues don't sticky-fail for an hour.
    const ttl = result.parsedTotal > 0 ? CACHE_TTL_HEALTHY_S : CACHE_TTL_EMPTY_S;
    await setCachedJson(cacheKey, result, ttl);
    return result;
  } catch {
    return { items: [], parsedTotal: 0, droppedUndated: 0 };
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

    items.push({
      source: feed.name,
      title,
      link,
      publishedAt,
      isAlert,
      level: threat.level,
      category: threat.category,
      confidence: threat.confidence,
      classSource: threat.source,
      importanceScore: 0,
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
    const cleaned = decodeXmlEntities(raw)
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
  const keyMap = new Map<string, ParsedItem[]>();
  for (const item of candidates) {
    const key = await buildClassifyCacheKey(item.title);
    const existing = keyMap.get(key) ?? [];
    existing.push(item);
    keyMap.set(key, existing);
  }

  const keys = [...keyMap.keys()];
  const cached = await getCachedJsonBatch(keys);

  for (const [key, relatedItems] of keyMap) {
    const hit = cached.get(key) as { level?: string; category?: string } | undefined;
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
      if (item.source) {
        bucket.sources.add(item.source);
        if (getSourceTier(item.source) <= 2) bucket.tier12Sources.add(item.source);
      }
    }
  }

  const signals = new Map<string, EntityCorroborationSignal>();
  for (const bucket of buckets.values()) {
    if (bucket.sources.size < 2) continue;
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
  currentScore: number;
  peakScore: number;
}

function derivePhase(track: StoryTrack): ProtoStoryPhase {
  const ageMs = Date.now() - track.firstSeen;
  if (track.mentionCount <= 1) return 'STORY_PHASE_BREAKING';
  if (track.mentionCount <= 5 && ageMs < 2 * 60 * 60 * 1000) return 'STORY_PHASE_DEVELOPING';
  // FADING requires real scores from E1. Until E1 ships, currentScore and
  // peakScore are both 0 (HSETNX placeholders), so this branch is intentionally
  // inactive — stories fall through to SUSTAINED rather than incorrectly FADING.
  if (track.currentScore > 0 && track.peakScore > 0 && track.currentScore < track.peakScore * 0.5) return 'STORY_PHASE_FADING';
  return 'STORY_PHASE_SUSTAINED';
}

/**
 * Batch-read existing story:track hashes from Redis for a list of title hashes.
 * Returns a Map<titleHash, StoryTrack>. Missing entries are absent from the map.
 */
async function readStoryTracks(titleHashes: string[]): Promise<Map<string, StoryTrack>> {
  if (titleHashes.length === 0) return new Map();
  const fields = ['firstSeen', 'lastSeen', 'mentionCount', 'sourceCount', 'currentScore', 'peakScore'];
  const commands = titleHashes.map(h => [
    'HMGET', STORY_TRACK_KEY(h), ...fields,
  ]);
  const results = await runRedisPipeline(commands);
  const map = new Map<string, StoryTrack>();
  for (let i = 0; i < titleHashes.length; i++) {
    const vals = results[i]?.result as string[] | null;
    if (!vals || !vals[0]) continue; // firstSeen missing → new story
    map.set(titleHashes[i]!, {
      firstSeen:    Number(vals[0]),
      lastSeen:     Number(vals[1] ?? 0),
      mentionCount: Number(vals[2] ?? 0),
      sourceCount:  Number(vals[3] ?? 0),
      currentScore: Number(vals[4] ?? 0),
      peakScore:    Number(vals[5] ?? 0),
    });
  }
  return map;
}

function toProtoItem(item: ParsedItem, storyMeta?: ProtoStoryMeta): ProtoNewsItem {
  return {
    source: item.source,
    title: item.title,
    link: item.link,
    publishedAt: item.publishedAt,
    isAlert: item.isAlert,
    importanceScore: item.importanceScore,
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

  const empty = (): ListFeedDigestResponse => ({ categories: {}, feedStatuses: {}, generatedAt: new Date().toISOString() });

  try {
    // cachedFetchJson coalesces concurrent cold-path calls: concurrent requests
    // for the same key share a single buildDigest() run instead of fanning out
    // across all RSS feeds. Returning null skips the Redis write and caches a
    // neg-sentinel (120s) to absorb the request storm during degraded periods.
    const fresh = await cachedFetchJson<ListFeedDigestResponse>(
      digestCacheKey,
      900,
      async () => {
        const result = await buildDigest(variant, lang);
        const totalItems = Object.values(result.categories).reduce((sum, b) => sum + b.items.length, 0);
        return totalItems > 0 ? result : null;
      },
      120,
      { timeoutMs: DIGEST_RESPONSE_TIMEOUT_MS },
    );

    if (fresh === null) {
      markNoCacheResponse(ctx.request);
      return fallbackDigestCache.get(fallbackKey)?.data ?? empty();
    }

    if (fallbackDigestCache.size > 50) fallbackDigestCache.clear();
    fallbackDigestCache.set(fallbackKey, { data: fresh, ts: Date.now() });
    return fresh;
  } catch {
    markNoCacheResponse(ctx.request);
    return fallbackDigestCache.get(fallbackKey)?.data ?? empty();
  }
}

const STORY_BATCH_SIZE = 80; // keeps each pipeline call well under Upstash's 1000-command cap

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
): Array<string | number> {
  return [
    'lastSeen', nowStr,
    'currentScore', score,
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

async function writeStoryTracking(items: ParsedItem[], variant: string, lang: string, hashes: string[], memberHashesByFinal?: Map<string, Set<string>>): Promise<void> {
  if (items.length === 0) return;
  const now = Date.now();
  const accKey = DIGEST_ACCUMULATOR_KEY(variant, lang);

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
  for (let i = 0; i < items.length; i++) {
    const hash = hashes[i]!;
    const item = items[i]!;
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
  for (let batchStart = 0; batchStart < items.length; batchStart += STORY_BATCH_SIZE) {
    const batch = items.slice(batchStart, batchStart + STORY_BATCH_SIZE);
    const commands: Array<Array<string | number>> = [];

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
        const hsetFields = buildStoryTrackHsetFields(representative, nowStr, representative.importanceScore);
        commands.push(
          ['HINCRBY', trackKey, 'mentionCount', '1'],
          ['HSET', trackKey, ...hsetFields],
          ['HSETNX', trackKey, 'firstSeen', nowStr],
          ['EXPIRE', trackKey, ttl],
          ['ZADD', accKey, nowStr, hash],
        );
        // #4924: alias rows for every member exact-title hash -> the FINAL
        // (post-adoption) canonical, story-track TTL — next cycle's
        // adoption source. Includes the canonical's own hash.
        for (const memberHash of memberHashesByFinal?.get(hash) ?? []) {
          commands.push(['SET', STORY_ALIAS_KEY(memberHash), hash, 'EX', ttl]);
        }
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

    await runRedisPipeline(commands);
  }

  // Refresh accumulator TTL once per build — 48h, shorter than STORY_TTL since digest cron only needs ~24h lookback.
  await runRedisPipeline([['EXPIRE', accKey, DIGEST_ACCUMULATOR_TTL]]);
}

async function buildDigest(variant: string, lang: string): Promise<ListFeedDigestResponse> {
  const feedsByCategory = VARIANT_FEEDS[variant] ?? {};
  const feedStatuses: Record<string, string> = {};
  // #4920 coverage ledger: count every silent drop gate so "how much did
  // we NOT show" is a queryable number instead of a feeling.
  const ledgerDrops = { perFeedCap: 0, undated: 0, freshnessFloor: 0, perCategoryCap: 0 };
  const categories: Record<string, CategoryBucket> = {};

  const deadlineController = new AbortController();
  const deadlineTimeout = setTimeout(() => deadlineController.abort(), OVERALL_DEADLINE_MS);

  try {
    const allEntries: Array<{ category: string; feed: ServerFeed }> = [];

    for (const [category, feeds] of Object.entries(feedsByCategory)) {
      const filtered = feeds.filter(f => !f.lang || f.lang === lang);
      for (const feed of filtered) {
        allEntries.push({ category, feed });
      }
    }

    if (variant === 'full') {
      const filteredIntel = INTEL_SOURCES.filter(f => !f.lang || f.lang === lang);
      for (const feed of filteredIntel) {
        allEntries.push({ category: 'intel', feed });
      }
    }

    const results = new Map<string, ParsedItem[]>();
    // Track feeds that actually completed (with or without items) so we can
    // distinguish a genuine timeout (never ran) from a successful empty fetch.
    const completedFeeds = new Set<string>();

    for (let i = 0; i < allEntries.length; i += BATCH_CONCURRENCY) {
      if (deadlineController.signal.aborted) break;

      const batch = allEntries.slice(i, i + BATCH_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async ({ category, feed }) => {
          const result = await fetchAndParseRss(feed, variant, deadlineController.signal);
          completedFeeds.add(feed.name);
          // Classify per-feed status. 'all-undated' is the silent-zeroing
          // failure mode (every parsed item dropped for missing/unparseable
          // dates) — distinguished from a genuinely empty fetch ('empty')
          // so log aggregation can keyword-match. 'partial-undated' is
          // informational (some items dropped, some kept).
          if (result.parsedTotal > 0 && result.items.length === 0 && result.droppedUndated > 0) {
            feedStatuses[feed.name] = 'all-undated';
          } else if (result.items.length === 0) {
            feedStatuses[feed.name] = 'empty';
          } else if (result.droppedUndated > 0) {
            feedStatuses[feed.name] = 'partial-undated';
          }
          return {
            category,
            items: result.items,
            droppedUndated: result.droppedUndated,
            droppedFeedCap: result.droppedFeedCap ?? 0,
          };
        }),
      );

      for (const result of settled) {
        if (result.status === 'fulfilled') {
          const { category, items, droppedUndated, droppedFeedCap } = result.value;
          const existing = results.get(category) ?? [];
          existing.push(...items);
          results.set(category, existing);
          ledgerDrops.undated += droppedUndated;
          ledgerDrops.perFeedCap += droppedFeedCap;
        }
      }
    }

    for (const entry of allEntries) {
      if (!completedFeeds.has(entry.feed.name)) {
        feedStatuses[entry.feed.name] = 'timeout';
      }
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
    // member that anchored the canonical drops out of the batch. One
    // batched read for all member hashes; failures degrade to
    // batch-derived canonicals (pre-adoption behavior).
    const allMemberHashes = new Set<string>();
    for (const identity of identityByItem.values()) {
      for (const h of identity.memberTitleHashes ?? []) allMemberHashes.add(h);
    }
    const aliasTargetByHash = new Map<string, string>();
    if (allMemberHashes.size > 0) {
      const aliasHashes = [...allMemberHashes];
      const aliasResults = await runRedisPipeline(aliasHashes.map((h) => ['GET', STORY_ALIAS_KEY(h)]));
      for (let i = 0; i < aliasHashes.length; i++) {
        const target = aliasResults[i]?.result;
        if (typeof target === 'string' && target.length > 0) aliasTargetByHash.set(aliasHashes[i]!, target);
      }
    }

    await Promise.all(allItems.map(async (item) => {
      const identity = identityByItem.get(item);
      if (identity) {
        item.titleHash = adoptExistingCanonical(identity.memberTitleHashes, identity.titleHash, aliasTargetByHash);
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

    // Final(post-adoption) hash -> member exact-title hashes, consumed by
    // writeStoryTracking to persist next cycle's alias rows.
    const memberHashesByFinal = new Map<string, Set<string>>();
    for (const item of allItems) {
      const identity = identityByItem.get(item);
      if (!identity || !item.titleHash) continue;
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
      ledgerDrops.perCategoryCap += Math.max(0, items.length - MAX_ITEMS_PER_CATEGORY);
      slicedByCategory.set(category, items.slice(0, MAX_ITEMS_PER_CATEGORY));
    }

    const allSliced = [...slicedByCategory.values()].flat();
    // titleHash was already set on each item during the corroboration pass above.
    const titleHashes = allSliced.map(i => i.titleHash!);

    const now = Date.now();

    // Read existing story tracking BEFORE writing so we know the previous cycle's
    // mentionCount. We merge read state + this cycle's increment in memory to
    // produce accurate, current StoryMeta without a second Redis round-trip.
    const uniqueHashes = [...new Set(titleHashes)];
    const storyTracks = await readStoryTracks(uniqueHashes).catch(() => new Map<string, StoryTrack>());

    // Write story tracking. Errors never fail the digest build.
    await writeStoryTracking(allSliced, variant, lang, titleHashes, memberHashesByFinal).catch((err: unknown) =>
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
            currentScore: stale?.currentScore ?? 0,
            peakScore: stale?.peakScore ?? 0,
          };
          const storyMeta: ProtoStoryMeta = {
            firstSeen,
            mentionCount,
            sourceCount,
            phase: derivePhase(merged),
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

    return {
      categories,
      feedStatuses,
      generatedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(deadlineTimeout);
  }
}

/** Internal exports for unit tests only — do not import in production code. */
export const __testing__ = {
  parseRssXml,
  decodeXmlEntities,
  extractDescription,
  extractRawTagBody,
  extractFirstDateTag,
  buildStoryTrackHsetFields,
  computeImportanceScore,
  hasDiplomacyFlashpointSignal,
  promoteDiplomacySeverity,
  computeEntityCorroborationSignals,
  computeEntityCorroborationCounts,
  readStoryTracks,
  resolveMaxAgeMs,
  capLlmUpgrade,
  VERCEL_INITIAL_RESPONSE_LIMIT_MS,
  DIGEST_RESPONSE_TIMEOUT_MS,
  POST_FETCH_HEADROOM_MS,
  RESPONSE_GUARD_BAND_MS,
  OVERALL_DEADLINE_MS,
  MAX_DESCRIPTION_LEN,
  MIN_DESCRIPTION_LEN,
  FUTURE_DATE_TOLERANCE_MS,
};
