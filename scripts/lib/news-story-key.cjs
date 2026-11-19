'use strict';

// Story key for relay news alerts.
//
// The relay used to identify an rss_alert by its exact title for 30 minutes.
// On 2026-11-17 CNN's exclusive alerted at 23:45 UTC as "<headline> - CNN"
// (the suffix its feed carries). Egypt Independent republished the text under
// the same headline nine hours later, and the relay alerted again as fresh
// single-publisher news: a different string, so a different event.
//
// The key is the headline as the digest's story tracking normalizes it
// (normalizeTitle in server/worldmonitor/news/v1/list-feed-digest.ts, kept in
// step by tests/news-story-key.test.mts): attribution suffix, case and
// punctuation removed, except that punctuation inside a number becomes a
// space. Story tracking then keeps the first 120 characters; the
// alert key keeps the whole headline, because two long headlines that part
// only at the end ("... three killed in Kyiv", "... twenty killed in Odesa")
// are different alerts. The publisher's scan-dedup keys on it instead of the
// title. It stays out of the payload, so the notification relay's per-user
// dedup still keys on the title, as it does for the alerts a browser submits.
//
// It merges repeats of one headline, not rewrites of one event. The
// notification relay skips rewrites for users who already had the story
// (lib/news-alert-coverage.mjs, #10916).

/**
 * How long a story stays claimed. A day is how long an exact repeat is already
 * held: the classify cache keeps a title's label that long and never offers a
 * cached title for alerting again.
 */
const NEWS_STORY_DEDUP_TTL_SECONDS = 86_400;

// Below this a headline is too generic to stand for one story for a day
// ("Israel strikes Lebanon"); those keep the exact-title identity. Titles in
// scripts written without spaces count as one word and do the same.
const MIN_STORY_WORDS = 4;

// Keep exact-title delivery available if the scripts image lacks the shared module.
let normalizeNewsStoryTitle = () => '';
let newsPublisherCoverageKey = () => '';
let loadError = null;
try {
  const identity = require('../shared/story-identity.js');
  if (typeof identity.normalizeNewsStoryTitle !== 'function') throw new Error('normalizeNewsStoryTitle is not exported');
  normalizeNewsStoryTitle = identity.normalizeNewsStoryTitle;
  if (typeof identity.newsPublisherCoverageKey === 'function') newsPublisherCoverageKey = identity.newsPublisherCoverageKey;
} catch (err) {
  loadError = err;
}

// The score a critical news alert needs to reach a realtime rule
// (shouldNotify in scripts/notification-relay.cjs, and
// NEWS_GLOBAL_IMPORTANCE_SCORE in notification-delivery-tiers.cjs, which
// tests/news-story-key.test.mts holds this to).
const REALTIME_CRITICAL_IMPORTANCE_SCORE = 82;
// The bar for a local news story on a rule scoped to its country (#10977).
const LOCAL_CRITICAL_IMPORTANCE_SCORE = 78;

/**
 * Whether a realtime rule can deliver the sighting: critical, and at or above
 * the score those rules require. A sighting with no score is not score-gated.
 */
function reachesRealtimeRules(severity, importanceScore) {
  if (severity !== 'critical') return false;
  return importanceScore == null || !(Number(importanceScore) < REALTIME_CRITICAL_IMPORTANCE_SCORE);
}

/**
 * Whether a country-scoped rule can deliver the sighting as local news:
 * critical, and at or above the local bar. Every realtime sighting passes.
 */
function reachesLocalRules(severity, importanceScore) {
  if (severity !== 'critical') return false;
  return importanceScore == null || !(Number(importanceScore) < LOCAL_CRITICAL_IMPORTANCE_SCORE);
}

/**
 * The story key for a news alert, or '' to keep the exact-title identity.
 *
 * Each audience gets its own key: realtime sightings reach every realtime
 * rule, local ones (critical, 78 to 81, naming one country) reach only rules
 * scoped to that country, and standard ones reach no realtime rule. A sighting must not use
 * up the story before a later, higher-scoring one reaches a wider audience.
 * The cost is an extra queued event for such a story, never a missed alert.
 */
function newsStoryKey(title, { severity, importanceScore, primaryCountryCode } = {}) {
  const normalized = normalizeNewsStoryTitle(title);
  if (!normalized || normalized.split(' ').length < MIN_STORY_WORDS) return '';
  const bucket = reachesRealtimeRules(severity, importanceScore) ? 'realtime'
    : reachesLocalRules(severity, importanceScore) && primaryCountryCode ? 'local'
    : 'standard';
  return `news-story:${bucket}:${normalized}`;
}

module.exports = {
  NEWS_STORY_DEDUP_TTL_SECONDS,
  MIN_STORY_WORDS,
  REALTIME_CRITICAL_IMPORTANCE_SCORE,
  LOCAL_CRITICAL_IMPORTANCE_SCORE,
  normalizeNewsStoryTitle,
  newsPublisherCoverageKey,
  newsStoryKey,
  reachesRealtimeRules,
  reachesLocalRules,
  /** Why the normalizer is unavailable, or null. The relay logs it at boot. */
  newsStoryKeyLoadError: () => loadError,
};
