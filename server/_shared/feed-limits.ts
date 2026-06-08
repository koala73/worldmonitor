/**
 * Per-app-version feed caps — server-driven.
 *
 * The iOS client sends its marketing version as `?av=<version>` on the
 * live-news, conflict-archive, and intel-news list endpoints. Because `av` is
 * part of the request URL, the CDN keys each version's response separately, so
 * different versions can be served different caps without poisoning each
 * other's cached response.
 *
 * To change a limit for an app version: edit `LIMITS_BY_VERSION` below and
 * deploy. A version that isn't listed — and any old client that doesn't send
 * `av` at all — falls back to the existing `WM_FEED_MAX_ITEMS` /
 * `WM_CATEGORY_MAX_PER_TOPIC` env vars, and then to "no cap". So this is fully
 * backward-compatible: already-shipped builds behave exactly as before.
 */

export interface FeedLimits {
  /** Max items returned by the live-news + conflict-archive lists (newest-first). */
  feedMaxItems?: number;
  /** Max intel-news clusters kept PER topic (each chip stays bounded). */
  categoryMaxPerTopic?: number;
}

/**
 * Version string (CFBundleShortVersionString, e.g. "2.1") → caps.
 *
 * EMPTY by default: every version falls back to the WM_FEED_MAX_ITEMS /
 * WM_CATEGORY_MAX_PER_TOPIC env vars, so this is a no-op until you opt a
 * version in. Add an entry only for a version you want to override, e.g.:
 *
 *   const LIMITS_BY_VERSION: Record<string, FeedLimits> = {
 *     '2.1': { feedMaxItems: 100, categoryMaxPerTopic: 50 },
 *     '2.2': { feedMaxItems: 60 },                 // categoryMaxPerTopic → env
 *   };
 *
 * A listed field overrides the env var for that version; an omitted field
 * falls back to the env var. Unlisted versions use the env vars entirely.
 */
const LIMITS_BY_VERSION: Record<string, FeedLimits> = {};

function envCap(name: 'WM_FEED_MAX_ITEMS' | 'WM_CATEGORY_MAX_PER_TOPIC'): number {
  const raw = process.env[name];
  if (!raw) return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
}

function normalizeVersion(av?: string | null): string {
  return (av ?? '').trim();
}

/** Resolve the live-news / conflict-archive item cap for an app version. */
export function feedMaxItemsForVersion(av?: string | null): number {
  const mapped = LIMITS_BY_VERSION[normalizeVersion(av)]?.feedMaxItems;
  if (typeof mapped === 'number' && mapped > 0) return Math.floor(mapped);
  return envCap('WM_FEED_MAX_ITEMS');
}

/** Resolve the intel-news per-topic cap for an app version. */
export function categoryMaxPerTopicForVersion(av?: string | null): number {
  const mapped = LIMITS_BY_VERSION[normalizeVersion(av)]?.categoryMaxPerTopic;
  if (typeof mapped === 'number' && mapped > 0) return Math.floor(mapped);
  return envCap('WM_CATEGORY_MAX_PER_TOPIC');
}
