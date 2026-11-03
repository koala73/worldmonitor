'use strict';

/**
 * Stable event ids and the API fan-out list contract for occurrence events
 * (shared/event-triggers.json, kind "occurrence").
 *
 * CommonJS so scripts/ais-relay.cjs can require it at the publish site; the
 * ESM delivery worker (scripts/shipping-webhook-worker.mjs) imports it too, so
 * producer and consumer derive one id from one function. Dockerfile.relay
 * COPYs this file (tests/dockerfile-relay-imports.test.mjs).
 *
 * Why not the queue's title hash: the relay dedups wm:events:queue on
 * hash(title) per site variant for 30 minutes, so one story reaches the queue
 * up to five times (once per variant) and again under a reworded headline.
 * API subscribers must see one event per story, so news ids hash the
 * canonical story link and market ids hash the relay's coalesce key per UTC
 * day (the relay republishes a sustained move every hour).
 */

const { createHash } = require('node:crypto');

/** Second list the relay LPUSHes rss_alert / market_alert messages onto. */
const API_FANOUT_LIST_KEY = 'wm:events:api:v1';
/** Newest messages kept while the worker is away; LTRIM drops the oldest. */
const API_FANOUT_LIST_CAP = 2000;
/** The list dies on its own if nothing drains it. */
const API_FANOUT_LIST_TTL_SECONDS = 86_400;
/** Queue event types that are teed. Browser-submitted copies enter the queue through api/notify.ts, not through the relay publisher, so they are never teed. */
const API_FANOUT_EVENT_TYPES = new Set(['rss_alert', 'market_alert']);
/** Which registry event a teed queue message becomes. */
const RELAY_EVENT_TO_OCCURRENCE = Object.freeze({
  rss_alert: 'news.breaking',
  market_alert: 'market.move',
});
/** One round trip: push, cap, expire. KEYS[1] list, ARGV[1] message, ARGV[2] cap, ARGV[3] ttl seconds. */
const API_FANOUT_TEE_SCRIPT =
  "redis.call('LPUSH', KEYS[1], ARGV[1]) "
  + "redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1) "
  + "redis.call('EXPIRE', KEYS[1], ARGV[3]) "
  + 'return 1';

const NEWS_EVENT_ID_PREFIX = 'rss_';
const MARKET_EVENT_ID_PREFIX = 'mkt_';

function sha256Hex32(material) {
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Lowercase host (no leading www.) plus path, no query, fragment or trailing
 * slash. Null when the value is not an http(s) URL. Tracking parameters and
 * AMP/mobile query strings are what differ between copies of one story.
 */
function canonicalLink(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${host}${path}`;
}

/**
 * Lowercased, NFKC-folded headline with a trailing attribution (" - Reuters",
 * " | Al Jazeera") removed and every run of non-alphanumerics collapsed to one
 * space. Still a hash of a title, so only the fallback when a story has no link.
 */
function normalizeHeadline(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+[-|–—]\s+[^-|–—]{1,40}$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** news.breaking event id: the story link when there is one, else the normalized title. */
function rssEventId(link, title) {
  const canonical = canonicalLink(link);
  const material = canonical ? `link:${canonical}` : `title:${normalizeHeadline(title)}`;
  return `${NEWS_EVENT_ID_PREFIX}${sha256Hex32(material)}`;
}

function utcDay(epochMs) {
  const ms = Number(epochMs);
  const date = Number.isFinite(ms) ? new Date(ms) : new Date(NaN);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toISOString().slice(0, 10);
}

/**
 * market.move event id: the relay's coalesce key
 * (market:<class>:<symbol>:<surge|decline>:<severity>) per UTC day. The relay
 * republishes a sustained move every hour (its dedup TTL); API subscribers get
 * it once a day per symbol, direction and severity band.
 */
function marketEventId(coalesceKey, publishedAt) {
  return `${MARKET_EVENT_ID_PREFIX}${sha256Hex32(`${String(coalesceKey ?? '')}|${utcDay(publishedAt)}`)}`;
}

/** The id for a queue message about to be published, or null when the event type is not teed. */
function occurrenceEventIdFor(eventType, payload, publishedAt) {
  if (eventType === 'rss_alert') return rssEventId(payload?.link, payload?.title);
  if (eventType === 'market_alert' && payload?.coalesceKey) return marketEventId(payload.coalesceKey, publishedAt);
  return null;
}

module.exports = {
  API_FANOUT_LIST_KEY,
  API_FANOUT_LIST_CAP,
  API_FANOUT_LIST_TTL_SECONDS,
  API_FANOUT_EVENT_TYPES,
  API_FANOUT_TEE_SCRIPT,
  RELAY_EVENT_TO_OCCURRENCE,
  NEWS_EVENT_ID_PREFIX,
  MARKET_EVENT_ID_PREFIX,
  canonicalLink,
  normalizeHeadline,
  rssEventId,
  marketEventId,
  occurrenceEventIdFor,
  utcDay,
};
