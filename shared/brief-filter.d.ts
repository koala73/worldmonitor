// Pure helpers for composing a WorldMonitor Brief envelope from the
// upstream news:insights:v1 cache + a user's alert-rule preferences.
//
// Split into its own module so Phase 3a (stubbed digest text) and
// Phase 3b (LLM-generated digest) can share the same filter + shape
// logic. Also importable from tests without pulling in Railway
// runtime deps.

import type {
  BriefEnvelope,
  BriefStory,
  BriefThreatLevel,
} from './brief-envelope.js';

/**
 * Upstream `news:insights:v1.topStories[i].threatLevel` uses an
 * extended ladder that includes 'moderate' as a synonym for
 * 'medium'. Phase 1 of the brief contract pinned the union to four
 * values; this helper normalises incoming severities.
 */
export function normaliseThreatLevel(upstream: string): BriefThreatLevel | null;

export type AlertSensitivity = 'all' | 'high' | 'critical';

/**
 * Optional drop-metrics callback. Called synchronously once per
 * dropped story. `severity` is present when threatLevel parsed but
 * failed the sensitivity gate, or when a later gate (headline/url)
 * dropped a story that had already passed the severity check.
 *
 * `cap` fires once per story skipped after `maxStories` has been
 * reached — neither severity nor field metadata is included since
 * the loop short-circuits without parsing the remaining stories.
 *
 * `source_topic_cap` (U5) fires when a story is dropped because the
 * `(source, category)` pair already has `maxPerSourceTopic` survivors
 * earlier in the in-flight `out` array. Both `severity` and `sourceUrl`
 * are populated.
 *
 * `institutional_static_page` (U7) fires when a story's `sourceUrl`
 * matches the static-institutional-page denylist (e.g.
 * `defense.gov/About/Section-508/`). Both `severity` and `sourceUrl`
 * are populated.
 */
export type DropMetricsFn = (event: {
  reason:
    | 'severity'
    | 'headline'
    | 'url'
    | 'shape'
    | 'cap'
    | 'source_topic_cap'
    | 'institutional_static_page';
  severity?: string;
  sourceUrl?: string;
}) => void;

/**
 * Filters the upstream `topStories` array against a user's
 * `alertRules.sensitivity` setting and caps at `maxStories`. Stories
 * with an unknown upstream severity are dropped.
 *
 * When `onDrop` is provided, it is invoked synchronously for each
 * dropped story with the drop reason and available metadata. The
 * callback runs before the `continue` that skips the story — callers
 * can use it to aggregate per-user drop counters without altering
 * filter behaviour.
 *
 * When `rankedStoryHashes` is provided, stories are re-ordered BEFORE
 * the cap is applied: stories whose `hash` matches a ranking entry
 * (by short-hash prefix, ≥4 chars) come first in ranking order;
 * stories not in the ranking come after in their original relative
 * order. Lets the canonical synthesis brain's editorial judgment of
 * importance survive the `maxStories` cut.
 *
 * `maxPerSourceTopic` (U5, default 2) caps how many stories sharing
 * the same `(source, category)` pair can survive into a single brief.
 * Pass `Infinity` to disable. The cap runs AFTER `applyRankedOrder`
 * so the highest-ranked sibling of any pair survives. Stories beyond
 * the cap are dropped with `onDrop({ reason: 'source_topic_cap' })`.
 */
export function filterTopStories(input: {
  stories: UpstreamTopStory[];
  sensitivity: AlertSensitivity;
  maxStories?: number;
  maxPerSourceTopic?: number;
  onDrop?: DropMetricsFn;
  rankedStoryHashes?: string[];
}): BriefStory[];

/**
 * Builds a complete BriefEnvelope with stubbed digest text. Phase 3b
 * replaces the stubs with LLM output; every other field is final.
 *
 * Throws if the resulting envelope would fail assertBriefEnvelope —
 * the composer never writes an envelope the renderer cannot serve.
 */
export function assembleStubbedBriefEnvelope(input: {
  user: { name: string; tz: string };
  stories: BriefStory[];
  issueDate: string;
  dateLong: string;
  issue: string;
  insightsNumbers: { clusters: number; multiSource: number };
  issuedAt?: number;
}): BriefEnvelope;

/**
 * Computes the user's local issue date from the current timestamp
 * and their IANA timezone. Falls back to UTC today for malformed
 * timezones so a composer run never blocks on one bad record.
 */
export function issueDateInTz(nowMs: number, timezone: string): string;

/**
 * Slot identifier (YYYY-MM-DD-HHMM, local tz) used as the Redis key
 * suffix and magazine URL path segment. Two compose runs on the same
 * day produce distinct slots so each digest dispatch gets a frozen
 * magazine URL that keeps pointing at the envelope that was live when
 * the notification went out.
 *
 * envelope.data.date (YYYY-MM-DD) is still the field the magazine
 * renders as "19 April 2026"; issueSlot only drives routing.
 */
export function issueSlotInTz(nowMs: number, timezone: string): string;

/** Upstream shape from news:insights:v1.topStories[]. */
export interface UpstreamTopStory {
  primaryTitle?: unknown;
  primarySource?: unknown;
  /**
   * Outgoing article link as read from story:track:v1.link. The filter
   * validates + normalises this into `BriefStory.sourceUrl`; stories
   * without a valid https/http URL are dropped (v2 requires every
   * surfaced story to have a working source link).
   */
  primaryLink?: unknown;
  description?: unknown;
  threatLevel?: unknown;
  category?: unknown;
  countryCode?: unknown;
  importanceScore?: unknown;
  /**
   * Stable digest-story hash carried through from the cron's pool
   * (digestStoryToUpstreamTopStory at scripts/lib/brief-compose.mjs).
   * Used by `filterTopStories` when `rankedStoryHashes` is supplied
   * to re-order stories before the cap. Falls back to titleHash when
   * the upstream digest path didn't materialise a primary `hash`.
   */
  hash?: unknown;
}
