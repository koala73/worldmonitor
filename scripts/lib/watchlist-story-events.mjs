// Watchlist story alerts — pure event builder (#4922 item e / U3).
//
// The digest cron (scripts/seed-digest-notifications.mjs) scans the story
// accumulator every 30 minutes; this module turns that scan into
// `watchlist_story_alert` queue events: a story whose title/description
// mentions a stock ticker (shared/ticker-extract.js — cashtags + company
// names from shared/stocks.json) AND whose importance score clears the
// threshold produces ONE event carrying the extracted tickers. The
// notification relay fans it out to PRO users whose alert rule opted in
// AND whose `rule.tickers` intersects `payload.tickers`.
//
// Kept as a separate scripts/lib module (not inline in the cron) because
// the cron is a runtime side-effect script — top-level main() + hard
// process.exit guards on missing env — so a pure function defined there
// can't be imported by tests. Same extraction pattern as
// scripts/lib/brief-compose.mjs et al. Docker: scripts/lib/ is COPY'd
// recursively by Dockerfile.digest-notifications; shared/ticker-extract.js
// needs its own COPY line (guarded by
// tests/dockerfile-digest-notifications-imports.test.mjs).

import { extractTickers } from '../../shared/ticker-extract.js';

export const WATCHLIST_STORY_EVENT_TYPE = 'watchlist_story_alert';

// Default threshold = the relay's calibrated 'high' importance gate
// (scripts/notification-relay.cjs shouldNotify: critical=82, high=69,
// else IMPORTANCE_SCORE_MIN). Locked in lockstep by
// tests/watchlist-story-events.test.mjs against the relay source.
export const DEFAULT_WATCHLIST_STORY_SCORE_MIN = 69;

// Severity band boundary — mirrors the relay's 'critical' threshold (82)
// so a score-82+ watchlist story rides the realtime critical path while
// [scoreMin, 82) events stay 'high' (delivered per the platform's existing
// severity/sensitivity machinery, unchanged by this feature).
const CRITICAL_SCORE_BAND = 82;

/**
 * Resolve the scan threshold from the environment.
 * `WATCHLIST_STORY_SCORE_MIN` must be a non-negative integer; anything
 * else (absent, garbage, negative) falls back to the default.
 *
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {number}
 */
export function resolveWatchlistScoreMin(env) {
  const raw = Number.parseInt(env?.WATCHLIST_STORY_SCORE_MIN ?? '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_WATCHLIST_STORY_SCORE_MIN;
}

/**
 * Build `watchlist_story_alert` events from scanned accumulator stories.
 * Pure — no I/O, no env reads. Malformed rows are skipped, never thrown:
 * the cron must not die because one story-track row is corrupt.
 *
 * @param {Array<{ hash: string; title: string; description?: string;
 *   link?: string; source?: string; currentScore: number }>} stories
 * @param {{ nameRe: RegExp | null; symbolByName: Map<string, string> } | null} dictionary
 *   compiled once via buildTickerDictionary(stocksJson.symbols)
 * @param {number} scoreMin inclusive importance-score floor
 * @returns {Array<{ eventType: string; severity: 'critical' | 'high';
 *   payload: { title: string; link: string; source: string;
 *     tickers: string[]; importanceScore: number; coalesceKey: string } }>}
 */
export function buildWatchlistStoryEvents(stories, dictionary, scoreMin) {
  const events = [];
  for (const story of Array.isArray(stories) ? stories : []) {
    if (!story || typeof story !== 'object') continue;
    if (typeof story.hash !== 'string' || story.hash.length === 0) continue;
    const title = typeof story.title === 'string' ? story.title : '';
    if (!title) continue;
    const importanceScore = Number(story.currentScore);
    if (!Number.isFinite(importanceScore) || importanceScore < scoreMin) continue;
    const description = typeof story.description === 'string' ? story.description : '';
    const tickers = extractTickers(description ? `${title}\n${description}` : title, dictionary);
    if (tickers.length === 0) continue;
    events.push({
      eventType: WATCHLIST_STORY_EVENT_TYPE,
      severity: importanceScore >= CRITICAL_SCORE_BAND ? 'critical' : 'high',
      payload: {
        title,
        link: typeof story.link === 'string' ? story.link : '',
        source: typeof story.source === 'string' ? story.source : '',
        tickers,
        importanceScore,
        // Stable story identity: the accumulator hash. The publisher-side
        // scan dedup AND the relay's per-user checkDedup both key on this
        // (via buildDedupMaterial), so a story that stays in the 24h scan
        // window does NOT re-alert every 30-minute cron tick.
        coalesceKey: `watchlist:${story.hash}`,
      },
    });
  }
  return events;
}
