/**
 * #4920 (a): pure feed-health payload builder.
 *
 * Consumed by scripts/validate-rss-feeds.mjs after its validation run to
 * turn per-feed results into the published `news:feed-health:v1` payload,
 * carrying cross-run state (consecutive-empty streaks) so "silent zero"
 * Google News wrappers — feeds that respond 200 with zero items when
 * Google's ranking shifts — become visible instead of rotting quietly.
 *
 * Pure module: no I/O. The caller reads the previous payload from Redis
 * and passes it in.
 */

/** A Google News search wrapper — the class of feed that silently zeroes. */
export function isGoogleNewsWrapper(url) {
  return typeof url === 'string' && url.includes('news.google.com/rss/');
}

/**
 * Consecutive EMPTY runs (this run included) before a wrapper feed is
 * flagged as a silent zero. One empty run can be Google jitter; two daily
 * runs of zero items on a search wrapper is a real coverage hole.
 */
export const SILENT_ZERO_THRESHOLD = 2;

/**
 * @param {Array<{ name: string; url: string; status: 'OK'|'STALE'|'DEAD'|'EMPTY'|'SKIP'; detail?: string; catalog?: string }>} results
 * @param {{ feeds?: Record<string, { consecutiveEmpty?: number }> } | null} previousPayload
 * @param {number} nowMs
 */
export function buildFeedHealthPayload(results, previousPayload, nowMs) {
  const prevFeeds = previousPayload && typeof previousPayload === 'object' && previousPayload.feeds
    ? previousPayload.feeds
    : {};

  const feeds = {};
  const summary = { ok: 0, stale: 0, dead: 0, empty: 0, skipped: 0 };
  const silentZeros = [];

  for (const result of results) {
    const key = result.url;
    const status = result.status;
    if (status === 'OK') summary.ok++;
    else if (status === 'STALE') summary.stale++;
    else if (status === 'DEAD') summary.dead++;
    else if (status === 'EMPTY') summary.empty++;
    else summary.skipped++;

    const wrapper = isGoogleNewsWrapper(result.url);
    const prevStreak = Number.isFinite(prevFeeds[key]?.consecutiveEmpty)
      ? prevFeeds[key].consecutiveEmpty
      : 0;
    // DEAD counts toward the streak too — a wrapper that flips between
    // "200 with zero items" and timeouts is still delivering nothing.
    const deliveredNothing = status === 'EMPTY' || status === 'DEAD';
    const consecutiveEmpty = deliveredNothing ? prevStreak + 1 : 0;

    const entry = {
      name: result.name,
      status,
      catalog: result.catalog ?? 'client',
      wrapper,
      consecutiveEmpty,
    };
    if (result.detail) entry.detail = String(result.detail).slice(0, 120);
    feeds[key] = entry;

    if (wrapper && consecutiveEmpty >= SILENT_ZERO_THRESHOLD) {
      silentZeros.push({ name: result.name, url: result.url, consecutiveEmpty });
    }
  }

  silentZeros.sort((a, b) => b.consecutiveEmpty - a.consecutiveEmpty || a.name.localeCompare(b.name));

  return {
    v: 1,
    checkedAt: nowMs,
    summary,
    feedCount: results.length,
    silentZeros,
    feeds,
  };
}
