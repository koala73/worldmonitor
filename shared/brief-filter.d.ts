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
 */
export type DropMetricsFn = (event: {
  reason: 'severity' | 'headline' | 'url' | 'shape' | 'cap';
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
 */
export function filterTopStories(input: {
  stories: UpstreamTopStory[];
  sensitivity: AlertSensitivity;
  maxStories?: number;
  onDrop?: DropMetricsFn;
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
}
