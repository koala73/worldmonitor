'use strict';

// The relay's digest warm cycle. A feed's rows are fetched only while a digest
// that includes it builds, and a digest builds only when someone requests that
// (edition, language) pair. Without this cycle a feed in a language no reader
// requests is never fetched, so whole-catalog readers (get_media_perspective,
// country headlines) miss it. Each cycle requests every pair in
// scripts/shared/news-digest-warm-cells.json through the normal digest path,
// so it reuses that path's fetch, row keys, guards and last-good gate.
//
// Lives in scripts/lib so tests can run it without booting the relay.

const { buildClassifyDigestHeaders, resolveClassifyApiBase } = require('./classify-digest-request.cjs');

// Longer than the digest's 900 s cache TTL plus a build: at exactly 15
// minutes a cell's request could land just before the entry its previous build
// cached had expired, get a cache hit, and rebuild only every other cycle.
const DIGEST_WARM_INTERVAL_MS = 17 * 60 * 1000;
// Requests start evenly across this window and run without waiting for the
// previous one, so the cycle ends about one request after it whatever the cell
// count, inside the interval.
const DIGEST_WARM_SPREAD_MS = 12 * 60 * 1000;
// The digest answers within its own 25 s response deadline.
const DIGEST_WARM_REQUEST_TIMEOUT_MS = 35_000;
const DIGEST_WARM_HEARTBEAT_KEY = 'relay:heartbeat:news-digest-warm';
// Health keeps the probe soft until the first healthy cycle writes this.
const DIGEST_WARM_ACTIVATION_KEY = 'seed-activated:news:digest-warm:v1';
// Three missed cycles before the heartbeat key expires.
const DIGEST_WARM_HEARTBEAT_TTL_SECONDS = (3 * DIGEST_WARM_INTERVAL_MS) / 1000;

function buildDigestWarmUrl(cell, env = process.env) {
  const variant = encodeURIComponent(cell.edition);
  const lang = encodeURIComponent(cell.lang);
  return `${resolveClassifyApiBase(env)}/api/news/v1/list-feed-digest?variant=${variant}&lang=${lang}`;
}

function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * fresh: the digest served a current build. stale: it served a last-good
 * replay, so this request's build did not publish. failed: nothing served.
 */
function classifyDigestWarmResponse(status, body) {
  if (status < 200 || status >= 300) return { outcome: 'failed', reason: `http-${status}` };
  const coverage = body && typeof body === 'object' ? body.coverage : null;
  if (!coverage || typeof coverage !== 'object') return { outcome: 'failed', reason: 'malformed' };
  const feeds = { feedTotal: count(coverage.feedTotal), feedCompleted: count(coverage.feedCompleted) };
  if (coverage.state === 'unavailable') {
    return { outcome: 'failed', reason: coverage.staleReason || 'unavailable', ...feeds };
  }
  if (coverage.servedStale) {
    return { outcome: 'stale', reason: coverage.staleReason || 'stale', ...feeds };
  }
  return { outcome: 'fresh', reason: '', ...feeds };
}

async function fetchDigestWarmCell(cell, {
  fetchImpl = globalThis.fetch,
  env = process.env,
  userAgent,
  relayKey,
  timeoutMs = DIGEST_WARM_REQUEST_TIMEOUT_MS,
} = {}) {
  try {
    const resp = await fetchImpl(buildDigestWarmUrl(cell, env), {
      headers: buildClassifyDigestHeaders({ userAgent, relayKey }),
      // fetch would carry the relay key to a redirect target on another
      // origin; the digest never redirects, so a redirect is a failed cell.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = resp.ok ? await resp.json() : null;
    return classifyDigestWarmResponse(resp.status, body);
  } catch (error) {
    const name = error && typeof error === 'object' ? error.name : '';
    return { outcome: 'failed', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error' };
  }
}

/** Starts request i at i/(n-1) of the spread and settles every request. */
async function runDigestWarmCycle(cells, {
  fetchCell,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  spreadMs = DIGEST_WARM_SPREAD_MS,
} = {}) {
  const startedAt = now();
  const gapMs = cells.length > 1 ? spreadMs / (cells.length - 1) : 0;
  const pending = [];
  for (let i = 0; i < cells.length; i++) {
    const waitMs = startedAt + Math.round(i * gapMs) - now();
    if (waitMs > 0) await sleep(waitMs);
    const cell = cells[i];
    let request;
    try {
      request = Promise.resolve(fetchCell(cell));
    } catch (error) {
      request = Promise.reject(error);
    }
    pending.push(request
      .catch(() => ({ outcome: 'failed', reason: 'error' }))
      .then((result) => ({ ...cell, ...result })));
  }
  return Promise.all(pending);
}

function summarizeDigestWarmCycle(results, { fetchedAt, durMs }) {
  const totals = { fresh: 0, stale: 0, failed: 0 };
  const languages = {};
  const failures = [];
  for (const result of results) {
    totals[result.outcome] += 1;
    const lang = (languages[result.lang] ??= { cells: 0, served: 0, feedTotal: 0, feedCompleted: 0 });
    lang.cells += 1;
    if (result.outcome !== 'failed') lang.served += 1;
    lang.feedTotal += result.feedTotal ?? 0;
    lang.feedCompleted += result.feedCompleted ?? 0;
    if (result.outcome !== 'fresh') failures.push(`${result.edition}:${result.lang}:${result.reason}`);
  }
  return {
    fetchedAt,
    // Health's record count: cells that served news this cycle.
    recordCount: totals.fresh + totals.stale,
    cells: results.length,
    ...totals,
    durMs,
    languages,
    failures,
  };
}

/**
 * The heartbeat vouches for the cycle only when at least half its cells served
 * news. Below that, the heartbeat ages and health reports the cycle stale.
 */
function shouldPublishDigestWarmHeartbeat(summary) {
  return summary.cells > 0 && summary.recordCount * 2 >= summary.cells;
}

module.exports = {
  DIGEST_WARM_ACTIVATION_KEY,
  DIGEST_WARM_HEARTBEAT_KEY,
  DIGEST_WARM_HEARTBEAT_TTL_SECONDS,
  DIGEST_WARM_INTERVAL_MS,
  DIGEST_WARM_REQUEST_TIMEOUT_MS,
  DIGEST_WARM_SPREAD_MS,
  buildDigestWarmUrl,
  classifyDigestWarmResponse,
  fetchDigestWarmCell,
  runDigestWarmCycle,
  shouldPublishDigestWarmHeartbeat,
  summarizeDigestWarmCycle,
};
