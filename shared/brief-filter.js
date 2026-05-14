// Pure helpers for composing a WorldMonitor Brief envelope from
// upstream news:insights:v1 content + a user's alert-rule preferences.
//
// Split into its own module so Phase 3a (stubbed digest text) and
// Phase 3b (LLM-generated digest) share the same filter + shape
// logic. No I/O, no LLM calls, no network — fully testable.

import { BRIEF_ENVELOPE_VERSION } from './brief-envelope.js';
import { assertBriefEnvelope } from '../server/_shared/brief-render.js';
import { isInstitutionalStaticPage } from './url-classifier.js';

/**
 * @typedef {import('./brief-envelope.js').BriefEnvelope} BriefEnvelope
 * @typedef {import('./brief-envelope.js').BriefStory} BriefStory
 * @typedef {import('./brief-envelope.js').BriefThreatLevel} BriefThreatLevel
 * @typedef {import('./brief-envelope.js').BriefThread} BriefThread
 * @typedef {import('./brief-envelope.js').BriefDigest} BriefDigest
 * @typedef {import('./brief-filter.js').AlertSensitivity} AlertSensitivity
 * @typedef {import('./brief-filter.js').UpstreamTopStory} UpstreamTopStory
 */

// ── Severity normalisation ───────────────────────────────────────────────────

/** @type {Record<string, BriefThreatLevel>} */
const SEVERITY_MAP = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  // Upstream seed-insights still emits 'moderate' — alias to 'medium'.
  moderate: 'medium',
  low: 'low',
};

/**
 * @param {unknown} upstream
 * @returns {BriefThreatLevel | null}
 */
export function normaliseThreatLevel(upstream) {
  if (typeof upstream !== 'string') return null;
  return SEVERITY_MAP[upstream.toLowerCase()] ?? null;
}

// ── Sensitivity → severity threshold ─────────────────────────────────────────

/** @type {Record<AlertSensitivity, Set<BriefThreatLevel>>} */
const ALLOWED_LEVELS_BY_SENSITIVITY = {
  // Matches convex/constants.ts sensitivityValidator: 'all'|'high'|'critical'.
  all: new Set(['critical', 'high', 'medium', 'low']),
  high: new Set(['critical', 'high']),
  critical: new Set(['critical']),
};

// ── Filter ───────────────────────────────────────────────────────────────────

const MAX_HEADLINE_LEN = 200;
const MAX_DESCRIPTION_LEN = 400;
const MAX_SOURCE_LEN = 120;
const MAX_SOURCE_URL_LEN = 2000;

const SEVERITY_RANK = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** @param {unknown} v */
function finiteNumberOrZero(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} v */
function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Validate + normalise the upstream story link into an outgoing
 * https/http URL. Returns the normalised URL on success, null when the
 * link is missing / malformed / uses an unsafe scheme. Mirrors the
 * renderer's validateSourceUrl so a story that clears the composer's
 * gate will always clear the renderer's gate too.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function normaliseSourceUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_SOURCE_URL_LEN) return null;
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return u.toString();
}

/** @param {unknown} v */
function asTrimmedString(v) {
  if (typeof v !== 'string') return '';
  return v.trim();
}

/** @param {string} v @param {number} cap */
function clip(v, cap) {
  if (v.length <= cap) return v;
  return `${v.slice(0, cap - 1).trimEnd()}\u2026`;
}

/**
 * @typedef {(event: { reason: 'severity'|'headline'|'url'|'shape'|'cap'|'source_topic_cap'|'institutional_static_page', severity?: string, sourceUrl?: string }) => void} DropMetricsFn
 */

/**
 * Return the LLM rank slot for a story, or Infinity when unranked.
 * Match is by short-hash prefix: a ranking entry of "abc12345" matches
 * a story whose `hash` starts with "abc12345" (≥4 chars). The canonical
 * synthesis prompt emits 8-char prefixes; stories carry the full hash.
 *
 * @param {{ hash?: unknown }} story
 * @param {unknown} rankedStoryHashes
 * @returns {number}
 */
function rankForStory(story, rankedStoryHashes) {
  if (!Array.isArray(rankedStoryHashes) || rankedStoryHashes.length === 0) {
    return Infinity;
  }
  const ranking = rankedStoryHashes
    .filter((x) => typeof x === 'string' && x.length >= 4)
    .map((x) => x);
  if (ranking.length === 0) return Infinity;

  const storyHash = typeof story?.hash === 'string' ? story.hash : '';
  if (storyHash.length === 0) return Infinity;
  for (let i = 0; i < ranking.length; i++) {
    if (storyHash.startsWith(ranking[i])) {
      return i;
    }
  }
  return Infinity;
}

/**
 * Topic identity is transient composer metadata. It is deliberately
 * NOT written into BriefStory because the envelope contract stays
 * story-focused; ordering is the only consumer.
 *
 * @param {Record<string, unknown>} story
 * @param {number} originalIndex
 * @returns {string}
 */
function topicKeyForStory(story, originalIndex) {
  const explicit = nonEmptyString(story?.briefTopicId);
  if (explicit) return `topic:${explicit}`;
  const numericTopic = story?.briefTopicId;
  if (typeof numericTopic === 'number' && Number.isFinite(numericTopic)) return `topic:${numericTopic}`;
  const repHash = nonEmptyString(story?.clusterRepHash);
  if (repHash) return `cluster:${repHash}`;
  // Legacy/raw rows without topic or cluster metadata deliberately
  // atomise into singleton blocks. That loses adjacency, but avoids
  // false-grouping unrelated stories under a guessed key.
  return `story:${originalIndex}`;
}

/**
 * Final editorial ordering for the rendered brief.
 *
 * The build stage already tries to create topic-contiguous blocks, but
 * the LLM ranking used to run as a dominant global sort and could pull a
 * lower-severity singleton above a heavier critical cluster. Here the
 * deterministic signals lead:
 *   1. topic block's highest eligible severity;
 *   2. count of stories at that highest severity;
 *   3. eligible block size;
 *   4. max score in the block;
 *   5. LLM rank as a tie-breaker only.
 *
 * This keeps critical clusters together while still letting the model
 * choose between similarly severe/sized candidates.
 *
 * Editorial trade-off: concentrated top severity beats broad nearby
 * context. A block with two critical stories sorts ahead of a block
 * with one critical plus many high stories; once that count ties,
 * broader eligible block size decides the next tie.
 *
 * @param {Array<Record<string, unknown>>} stories
 * @param {Set<BriefThreatLevel>} allowed
 * @param {unknown} rankedStoryHashes
 * @returns {Array<Record<string, unknown>>}
 */
function orderBriefCandidates(stories, allowed, rankedStoryHashes) {
  const annotated = stories.map((story, originalIndex) => {
    const threatLevel = normaliseThreatLevel(story?.threatLevel);
    const severityRank = threatLevel ? (SEVERITY_RANK[threatLevel] ?? Infinity) : Infinity;
    return {
      story,
      originalIndex,
      topicKey: topicKeyForStory(story, originalIndex),
      threatLevel,
      severityRank,
      eligible: Boolean(threatLevel && allowed.has(threatLevel)),
      rank: rankForStory(story, rankedStoryHashes),
      score: finiteNumberOrZero(story?.importanceScore ?? story?.currentScore),
    };
  });

  /** @type {Map<string, any>} */
  const blocks = new Map();
  for (const item of annotated) {
    let block = blocks.get(item.topicKey);
    if (!block) {
      block = {
        key: item.topicKey,
        items: [],
        firstIndex: item.originalIndex,
        bestSeverityRank: Infinity,
        bestSeverityCount: 0,
        eligibleCount: 0,
        // Sentinel for all-ineligible blocks. The comparator's !==
        // guard prevents `-Infinity - -Infinity` from producing NaN.
        maxScore: -Infinity,
        // Best (lowest) LLM rank seen across any eligible member in
        // this block, not the rank of the highest-scoring member.
        bestLlmRank: Infinity,
      };
      blocks.set(item.topicKey, block);
    }
    block.items.push(item);
    block.firstIndex = Math.min(block.firstIndex, item.originalIndex);
    if (item.eligible) {
      block.eligibleCount += 1;
      block.maxScore = Math.max(block.maxScore, item.score);
      block.bestLlmRank = Math.min(block.bestLlmRank, item.rank);
      if (item.severityRank < block.bestSeverityRank) {
        block.bestSeverityRank = item.severityRank;
        block.bestSeverityCount = 1;
      } else if (item.severityRank === block.bestSeverityRank) {
        block.bestSeverityCount += 1;
      }
    }
  }

  const orderedBlocks = [...blocks.values()].sort((a, b) => {
    if (a.bestSeverityRank !== b.bestSeverityRank) return a.bestSeverityRank - b.bestSeverityRank;
    if (a.bestSeverityCount !== b.bestSeverityCount) return b.bestSeverityCount - a.bestSeverityCount;
    if (a.eligibleCount !== b.eligibleCount) return b.eligibleCount - a.eligibleCount;
    if (a.maxScore !== b.maxScore) return b.maxScore - a.maxScore;
    if (a.bestLlmRank !== b.bestLlmRank) return a.bestLlmRank - b.bestLlmRank;
    return a.firstIndex - b.firstIndex;
  });

  const ordered = [];
  for (const block of orderedBlocks) {
    block.items.sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (a.severityRank !== b.severityRank) return a.severityRank - b.severityRank;
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.score !== b.score) return b.score - a.score;
      return a.originalIndex - b.originalIndex;
    });
    for (const item of block.items) ordered.push(item.story);
  }
  return ordered;
}

/**
 * @param {{ stories: UpstreamTopStory[]; sensitivity: AlertSensitivity; maxStories?: number; maxPerSourceTopic?: number; onDrop?: DropMetricsFn; rankedStoryHashes?: string[] }} input
 * @returns {BriefStory[]}
 */
export function filterTopStories({ stories, sensitivity, maxStories = 12, maxPerSourceTopic = 2, onDrop, rankedStoryHashes }) {
  if (!Array.isArray(stories)) return [];
  const allowed = ALLOWED_LEVELS_BY_SENSITIVITY[sensitivity];
  if (!allowed) return [];

  // Per Solution 0 of the topic-adjacency plan: when the caller passes
  // onDrop, we emit one event per filter drop so the seeder can
  // aggregate counts and log per-tick drop rates. onDrop is optional
  // and synchronous — any throw is the caller's problem (tested above).
  const emit = typeof onDrop === 'function' ? onDrop : null;

  // Final editorial ordering happens BEFORE the cap. Severity and
  // topic-block mass dominate so a critical cluster stays contiguous
  // and reaches the rendered brief ahead of lower-severity singletons;
  // rankedStoryHashes remains a tie-breaker inside that frame.
  const orderedStories = orderBriefCandidates(stories, allowed, rankedStoryHashes);

  /** @type {BriefStory[]} */
  const out = [];
  // Per-(source, category) survivor count. Updated atomically with each
  // out.push() below so the U5 source-topic cap check is O(1) instead of
  // O(n) per candidate. Key format: source + KEY_DELIM + category. The
  // ASCII Unit Separator (0x1F) prevents collisions when source or
  // category itself contains spaces (e.g. (source='Reuters',
  // category='World Politics') vs (source='Reuters World',
  // category='Politics') would both produce the same key under a space
  // delimiter). Sources/categories never legitimately contain control
  // characters so 0x1F is a safe sentinel.
  const KEY_DELIM = String.fromCharCode(31);
  /** @type {Map<string, number>} */
  const pairCounts = new Map();
  for (let i = 0; i < orderedStories.length; i++) {
    const raw = orderedStories[i];
    if (!raw || typeof raw !== 'object') {
      if (emit) emit({ reason: 'shape' });
      continue;
    }
    const threatLevel = normaliseThreatLevel(raw.threatLevel);
    if (!threatLevel || !allowed.has(threatLevel)) {
      if (emit) emit({ reason: 'severity', severity: threatLevel ?? undefined });
      continue;
    }

    const headline = clip(asTrimmedString(raw.primaryTitle), MAX_HEADLINE_LEN);
    if (!headline) {
      if (emit) emit({ reason: 'headline', severity: threatLevel });
      continue;
    }

    // v2: every surfaced story must have a working outgoing link so
    // the magazine can wrap the source line in a UTM anchor. A story
    // that reaches this point without a valid link is a composer /
    // upstream bug, not something to paper over — drop rather than
    // ship a broken attribution. In practice story:track:v1.link is
    // populated on every ingested item; the check exists so one bad
    // row can't slip through.
    const sourceUrl = normaliseSourceUrl(raw.primaryLink);
    if (!sourceUrl) {
      if (emit) emit({ reason: 'url', severity: threatLevel, sourceUrl: typeof raw.primaryLink === 'string' ? raw.primaryLink : undefined });
      continue;
    }

    // U7: defense-in-depth URL/path denylist for static institutional
    // pages on .gov/.mil/.int. The upstream ingest gates (U1+U2+U3)
    // should keep these out, but a regression in the feed registry or
    // a new dialect bypassing U2 could let one through — this gate
    // ensures the brief surface stays clean even then. R7.
    if (isInstitutionalStaticPage(sourceUrl)) {
      if (emit) emit({ reason: 'institutional_static_page', severity: threatLevel, sourceUrl });
      continue;
    }

    if (out.length >= maxStories) {
      // Cap-truncation after eligibility checks: a story is counted as
      // `cap` only if it otherwise would have been eligible to render.
      // Invalid/low-severity tail items keep their root-cause reason,
      // which keeps operator reconciliation useful after deterministic
      // severity/topic ordering moves excluded stories later.
      if (emit) emit({ reason: 'cap' });
      continue;
    }

    const description = clip(
      asTrimmedString(raw.description) || headline,
      MAX_DESCRIPTION_LEN,
    );
    const source = clip(
      asTrimmedString(raw.primarySource) || 'Multiple wires',
      MAX_SOURCE_LEN,
    );
    const category = asTrimmedString(raw.category) || 'General';
    const country = asTrimmedString(raw.countryCode) || 'Global';

    // Source-topic cap (R6, U5): prevent more than maxPerSourceTopic
    // (default 2) stories sharing the same (source, category) pair from
    // reaching a single brief. Surgical fix for editorial-clutter cases
    // like the 2026-04-25 brief shipping both "Millions under tornado
    // threat" and "Watch tornadoes swirl through Oklahoma" from CBS News
    // — distinct stories the dedup correctly kept separate, but redundant
    // for a 12-story brief. Ranked-order rule above ensures the
    // highest-importance member of each pair survives.
    const pairKey = source + KEY_DELIM + category;
    if ((pairCounts.get(pairKey) ?? 0) >= maxPerSourceTopic) {
      if (emit) emit({ reason: 'source_topic_cap', severity: threatLevel, sourceUrl });
      continue;
    }

    // v4 clusterId: REQUIRED on every story (assertBriefEnvelope
    // enforces non-empty). Sprint 1 / U3 lands the canonical source:
    // `raw.clusterRepHash` is `mergedHashes[0]` from materializeCluster
    // (scripts/lib/brief-dedup-jaccard.mjs) — the deterministic
    // cluster-rep hash shared across every member of a multi-story
    // cluster. digestStoryToUpstreamTopStory at scripts/lib/brief-compose.mjs
    // wires it onto the upstream story shape this filter consumes.
    //
    // Source preference (top wins):
    //   1. raw.clusterRepHash — canonical, materializeCluster path.
    //      Singleton clusters: equals the story's own hash by
    //      construction (see digestStoryToUpstreamTopStory fallback).
    //      Multi-story clusters: shared identity for every member.
    //   2. raw.hash — back-compat for paths that bypass the cluster
    //      materializer (e.g. composeBriefForRule against
    //      news:insights:v1, which feeds raw upstream stories without
    //      a clusterRepHash field). Singleton cluster identity is the
    //      story's own hash, so the contract still holds.
    //   3. `url:${sourceUrl}` — last-ditch deterministic fallback for
    //      paths that omit hash entirely. sourceUrl is validated above
    //      and is required for v2+ stories, so it is always present
    //      at this point.
    //
    // The clusterId contract: non-empty string, stable across ticks
    // for the SAME upstream cluster, distinct across distinct
    // clusters. All three sources satisfy non-empty + stability; the
    // ordering ensures multi-story clusters collapse to ONE shared
    // clusterId (which raw.hash alone could not — it would give every
    // member a distinct id).
    const repHash = typeof raw.clusterRepHash === 'string' && raw.clusterRepHash.length > 0 ? raw.clusterRepHash : null;
    const upstreamHash = typeof raw.hash === 'string' && raw.hash.length > 0 ? raw.hash : null;
    const clusterId = repHash ?? upstreamHash ?? `url:${sourceUrl}`;
    out.push({
      category,
      country,
      threatLevel,
      headline,
      description,
      source,
      sourceUrl,
      clusterId,
      // Stubbed at Phase 3a. Phase 3b replaces this with an LLM-
      // generated per-user rationale. The renderer requires a non-
      // empty string, so we emit a generic fallback rather than
      // leaving the field blank.
      whyMatters:
        'Story flagged by your sensitivity settings. Open for context.',
    });
    pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1);
  }
  return out;
}

// ── Envelope assembly (stubbed digest text) ─────────────────────────────────

function deriveThreadsFromStories(stories) {
  const byCategory = new Map();
  for (const s of stories) {
    const n = byCategory.get(s.category) ?? 0;
    byCategory.set(s.category, n + 1);
  }
  const sorted = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 6).map(([tag, count]) => ({
    tag,
    teaser:
      count === 1
        ? 'One thread on the desk today.'
        : `${count} threads on the desk today.`,
  }));
}

function greetingForHour(localHour) {
  if (localHour < 5 || localHour >= 22) return 'Good evening.';
  if (localHour < 12) return 'Good morning.';
  if (localHour < 18) return 'Good afternoon.';
  return 'Good evening.';
}

/**
 * @param {{
 *   user: { name: string; tz: string };
 *   stories: BriefStory[];
 *   issueDate: string;
 *   dateLong: string;
 *   issue: string;
 *   insightsNumbers: { clusters: number; multiSource: number };
 *   issuedAt?: number;
 *   localHour?: number;
 * }} input
 * @returns {BriefEnvelope}
 */
export function assembleStubbedBriefEnvelope({
  user,
  stories,
  issueDate,
  dateLong,
  issue,
  insightsNumbers,
  issuedAt = Date.now(),
  localHour,
}) {
  const greeting = greetingForHour(
    typeof localHour === 'number' ? localHour : 9,
  );

  /** @type {BriefDigest} */
  const digest = {
    greeting,
    // Phase 3b swaps this with an LLM-generated executive summary.
    // Phase 3a uses a neutral placeholder so the magazine still
    // renders end-to-end.
    lead: `Today's brief surfaces ${stories.length} ${
      stories.length === 1 ? 'thread' : 'threads'
    } flagged by your sensitivity settings. Open any page to read the full editorial.`,
    numbers: {
      clusters: insightsNumbers.clusters,
      multiSource: insightsNumbers.multiSource,
      surfaced: stories.length,
    },
    threads: deriveThreadsFromStories(stories),
    // Signals-to-watch is intentionally empty at Phase 3a. The
    // Digest / 04 Signals page is conditional in the renderer, so
    // an empty array simply drops that page instead of rendering
    // stubbed content that would read as noise.
    signals: [],
  };

  /** @type {BriefEnvelope} */
  const envelope = {
    version: BRIEF_ENVELOPE_VERSION,
    issuedAt,
    data: {
      user,
      issue,
      date: issueDate,
      dateLong,
      digest,
      stories,
    },
  };

  // Fail loud if the composer would produce an envelope the
  // renderer cannot serve. Phase 1 established this as the central
  // contract; drift here is the error mode we most care about.
  assertBriefEnvelope(envelope);
  return envelope;
}

// ── Tz-aware issue date ──────────────────────────────────────────────────────

/**
 * @param {number} nowMs
 * @param {string} timezone
 * @returns {string}
 */
export function issueDateInTz(nowMs, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // en-CA conveniently formats as YYYY-MM-DD.
    const parts = fmt.format(new Date(nowMs));
    if (/^\d{4}-\d{2}-\d{2}$/.test(parts)) return parts;
  } catch {
    /* fall through to UTC */
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Slot identifier for the brief URL + Redis key. Encodes the user's
 * local calendar date PLUS the hour+minute of the compose run so two
 * digests on the same day produce distinct magazine URLs.
 *
 * Format: YYYY-MM-DD-HHMM (local tz).
 *
 * `issueDate` (YYYY-MM-DD) remains the field the magazine renders as
 * "19 April 2026"; `issueSlot` only drives routing.
 *
 * @param {number} nowMs
 * @param {string} timezone
 * @returns {string}
 */
export function issueSlotInTz(nowMs, timezone) {
  const date = issueDateInTz(nowMs, timezone);
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(nowMs));
    const hh = parts.find((p) => p.type === 'hour')?.value ?? '';
    const mm = parts.find((p) => p.type === 'minute')?.value ?? '';
    const hhmm = `${hh}${mm}`;
    // Intl in some locales emits "24" for midnight instead of "00";
    // pin to the expected 4-digit numeric shape or fall through.
    if (/^[01]\d[0-5]\d$|^2[0-3][0-5]\d$/.test(hhmm)) return `${date}-${hhmm}`;
  } catch {
    /* fall through to UTC */
  }
  const d = new Date(nowMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${date}-${hh}${mm}`;
}
