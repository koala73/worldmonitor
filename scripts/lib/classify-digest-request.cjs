'use strict';

// #7437: where should Classify fetch list-feed-digest from, and with which
// auth/transport? The previous inline https.get against the hardcoded
// production API host silently classified 0 titles on every self-host install.
//
// Lives in scripts/lib rather than inline in ais-relay.cjs so the URL, scheme,
// and header contract can execute in tests without importing the boot-on-require
// relay — same reason as digest-stale-gate.cjs.

const DEFAULT_CLASSIFY_API_HOST = 'api.worldmonitor.app';
const DEFAULT_CLASSIFY_API_BASE = `https://${DEFAULT_CLASSIFY_API_HOST}`;

function resolveClassifyApiBase(env = process.env) {
  const raw = typeof env.API_BASE_URL === 'string' ? env.API_BASE_URL.trim() : '';
  return (raw || DEFAULT_CLASSIFY_API_BASE).replace(/\/+$/, '');
}

function buildClassifyDigestUrl(variant, env = process.env) {
  const encodedVariant = encodeURIComponent(String(variant ?? ''));
  return `${resolveClassifyApiBase(env)}/api/news/v1/list-feed-digest?variant=${encodedVariant}&lang=en`;
}

function classifyDigestTransport(url) {
  try {
    return new URL(url).protocol === 'http:' ? 'http' : 'https';
  } catch {
    return 'https';
  }
}

function buildClassifyDigestHeaders({ userAgent, relayKey } = {}) {
  const headers = { Accept: 'application/json' };
  if (userAgent) headers['User-Agent'] = userAgent;
  if (relayKey) headers['X-WorldMonitor-Key'] = relayKey;
  return headers;
}

function formatClassifyDigestFetchFailure(status, relayKey) {
  const authFailure = status === 401 || status === 403;
  const keyNote = !relayKey && authFailure
    ? ' (WORLDMONITOR_RELAY_KEY not set — 401 expected; set it on the relay AND the API host)'
    : '';
  return `[Classify] digest fetch failed: HTTP ${status}${keyNote}`;
}

function shouldWriteClassifySeedMeta({ fetchOk = 0, fetchFailed = 0 } = {}) {
  return fetchOk > 0 || fetchFailed === 0;
}

// Compose starts ais-relay before worldmonitor (the app already depends_on the
// relay; reversing that would cycle). A refused first `full` fetch would
// otherwise sit until the 15-minute interval. Bounded retries cover the
// seconds between relay listen and app listen without waiting on HTTP 4xx.
const CLASSIFY_DIGEST_RETRY_DELAYS_MS = Object.freeze([2000, 4000, 8000, 8000, 8000]);
const CLASSIFY_DIGEST_TRANSIENT_ERROR = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|timeout|socket hang up/i;

function isTransientClassifyDigestFetchError(error) {
  if (error == null) return false;
  const code = typeof error === 'object' && error.code ? String(error.code) : '';
  const message = typeof error === 'object' && error.message ? String(error.message) : String(error);
  return CLASSIFY_DIGEST_TRANSIENT_ERROR.test(code) || CLASSIFY_DIGEST_TRANSIENT_ERROR.test(message);
}

function isRetryableClassifyDigestStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

function classifyDigestRetryDelayMs(attempt) {
  const delay = CLASSIFY_DIGEST_RETRY_DELAYS_MS[attempt];
  return typeof delay === 'number' ? delay : 0;
}

function classifyDigestRetryDecision({ attempt = 0, error, status } = {}) {
  const maxAttempts = CLASSIFY_DIGEST_RETRY_DELAYS_MS.length + 1;
  if (attempt >= maxAttempts - 1) return { retry: false, delayMs: 0 };
  if (isTransientClassifyDigestFetchError(error) || isRetryableClassifyDigestStatus(status)) {
    return { retry: true, delayMs: classifyDigestRetryDelayMs(attempt) };
  }
  return { retry: false, delayMs: 0 };
}

// ── Build watch ──────────────────────────────────────────────────────────────
// The relay used to read each edition's digest once per 15-minute cycle, so a
// headline waited up to 15 minutes after the digest that carried it was built
// (measured 2026-11-10..17: median 13.6 min from story tracking's first sight
// to the queue, p90 28.2). The digest handler writes a small coverage ledger
// at the end of every build; its generatedAt tells the relay a body exists
// that it has not classified, so it can read that edition at once.
const DIGEST_BUILD_STAMP_PREFIX = 'news:coverage-ledger:v1';
// How often the relay looks for new builds.
const DIGEST_BUILD_WATCH_INTERVAL_MS = 20_000;
// The ledger is written inside the build and the body reaches the digest cache
// when the build returns. A fetch before that finds the cache empty and starts
// a second build, so a stamp is acted on only once it is this old.
const DIGEST_BUILD_SETTLE_MS = 10_000;
// A digest read that fails does not count as classifying the build. The watch
// leaves that edition alone for this long, so a failing API is not re-read on
// every check.
const DIGEST_BUILD_RETRY_MS = 2 * 60_000;
// Build to queue is the one stage the relay owns: a watch poll, the settle
// wait, the digest fetch and one LLM call. Anything over this means the watch
// is not firing and alerts are back on the 15-minute cycle.
const BUILD_TO_QUEUE_BUDGET_MS = 3 * 60_000;

// Classify reads the English digest of each edition (buildClassifyDigestUrl).
function digestBuildStampKey(variant) {
  return `${DIGEST_BUILD_STAMP_PREFIX}:${variant}:en`;
}

function digestBuildStampMs(ledger) {
  let value = ledger;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return 0; }
  }
  const at = value && typeof value === 'object' ? Number(value.generatedAt) : Number.NaN;
  return Number.isFinite(at) && at > 0 ? at : 0;
}

/**
 * Editions whose digest was built after the build the relay last classified.
 * `stamps` and `classifiedAt` map edition -> build time in ms. An edition the
 * relay has never classified counts, so a restarted relay catches up at once.
 * `retryAt` maps edition -> the earliest time it may be read again after a
 * failed read.
 */
function editionsWithUnclassifiedBuild({ editions, stamps, classifiedAt, now, settleMs = DIGEST_BUILD_SETTLE_MS, retryAt }) {
  return editions.filter((edition) => {
    const stamp = stamps.get(edition);
    if (!Number.isFinite(stamp) || stamp <= 0) return false;
    if (stamp > now - settleMs) return false;
    if ((retryAt?.get(edition) ?? 0) > now) return false;
    return stamp > (classifiedAt.get(edition) ?? 0);
  });
}

/**
 * The editions one build pass classifies, in order. An alert is published once,
 * by whichever edition classifies the headline first, and a rule only receives
 * its own edition's events. The timed cycle reads `full` before every other
 * edition, so `full` has first claim on a headline two editions carry; a pass
 * triggered by another edition's build reads `full` first for the same reason.
 */
function buildPassEditions(editions, triggered) {
  const wanted = new Set(triggered);
  const rebuilt = editions.filter((edition) => wanted.has(edition));
  if (rebuilt.length === 0) return [];
  const first = editions[0];
  return rebuilt.includes(first) ? rebuilt : [first, ...rebuilt];
}

// ── Alert latency ────────────────────────────────────────────────────────────
function elapsedMs(from, to) {
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) return null;
  const ms = to - from;
  return ms >= 0 ? ms : null;
}

/**
 * How long one alert took to reach the queue, by stage. A stage that cannot be
 * measured is null: X posts have no digest build or story tracking, and a
 * publisher clock ahead of ours gives a negative age.
 *   publishToQueueMs  publisher's own timestamp to queue (includes the feed)
 *   seenToQueueMs     digest story tracking's first sight, in any edition or
 *                     language, to queue
 *   buildToQueueMs    build of the digest body the relay read, to queue
 */
function alertLatency({ publishedAt, firstSeen, buildAt, queuedAt }) {
  const buildToQueueMs = elapsedMs(buildAt, queuedAt);
  return {
    publishToQueueMs: elapsedMs(publishedAt, queuedAt),
    seenToQueueMs: elapsedMs(firstSeen, queuedAt),
    buildToQueueMs,
    overBudget: buildToQueueMs !== null && buildToQueueMs > BUILD_TO_QUEUE_BUDGET_MS,
  };
}

function formatAlertLatency(latency, { severity, importanceScore, variant, source }) {
  const seconds = (ms) => (ms === null ? 'n/a' : String(Math.round(ms / 1000)));
  return `[Classify] alert latency publish_to_queue_s=${seconds(latency.publishToQueueMs)} ` +
    `seen_to_queue_s=${seconds(latency.seenToQueueMs)} build_to_queue_s=${seconds(latency.buildToQueueMs)} ` +
    `over_budget=${latency.overBudget} severity=${severity} score=${importanceScore} variant=${variant} ` +
    `source=${JSON.stringify(String(source ?? ''))}`;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * p50 / p90 / max per stage over recorded alert samples, for
 * scripts/report-alert-latency.mjs. `overBudget` counts samples whose
 * build-to-queue stage exceeded BUILD_TO_QUEUE_BUDGET_MS.
 */
function summarizeAlertLatency(samples) {
  const stage = (field) => {
    const values = samples.map((sample) => sample[field]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    return { n: values.length, p50: percentile(values, 0.5), p90: percentile(values, 0.9), max: values.at(-1) ?? null };
  };
  return {
    count: samples.length,
    publishToQueue: stage('publishToQueueMs'),
    seenToQueue: stage('seenToQueueMs'),
    buildToQueue: stage('buildToQueueMs'),
    overBudget: samples.filter((sample) => sample.buildToQueueMs > BUILD_TO_QUEUE_BUDGET_MS).length,
  };
}

/**
 * The --strict verdict of scripts/report-alert-latency.mjs for one summary.
 * No measured build stage is a failure, not a pass: a window holding only X
 * alerts has samples and still says nothing about the budget.
 */
function strictLatencyVerdict(summary) {
  const minutes = (ms) => (ms / 60_000).toFixed(1);
  const { n, p90 } = summary.buildToQueue;
  if (n === 0) return { ok: false, reason: 'no alert in this window measured digest build to queue' };
  if (p90 > BUILD_TO_QUEUE_BUDGET_MS) {
    return { ok: false, reason: `build-to-queue p90 ${minutes(p90)} min is over the ${minutes(BUILD_TO_QUEUE_BUDGET_MS)}-minute budget` };
  }
  return { ok: true, reason: '' };
}

module.exports = {
  summarizeAlertLatency,
  strictLatencyVerdict,
  DIGEST_BUILD_RETRY_MS,
  DIGEST_BUILD_WATCH_INTERVAL_MS,
  DIGEST_BUILD_SETTLE_MS,
  BUILD_TO_QUEUE_BUDGET_MS,
  digestBuildStampKey,
  digestBuildStampMs,
  editionsWithUnclassifiedBuild,
  buildPassEditions,
  alertLatency,
  formatAlertLatency,
  DEFAULT_CLASSIFY_API_HOST,
  DEFAULT_CLASSIFY_API_BASE,
  CLASSIFY_DIGEST_RETRY_DELAYS_MS,
  resolveClassifyApiBase,
  buildClassifyDigestUrl,
  classifyDigestTransport,
  buildClassifyDigestHeaders,
  formatClassifyDigestFetchFailure,
  shouldWriteClassifySeedMeta,
  isTransientClassifyDigestFetchError,
  isRetryableClassifyDigestStatus,
  classifyDigestRetryDelayMs,
  classifyDigestRetryDecision,
};
