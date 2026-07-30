#!/usr/bin/env node

import {
  acquireLockSafely,
  extendExistingTtl,
  extendExistingTtlDetailed,
  loadEnvFile,
  releaseLock,
  runSeed,
  sleep,
  verifySeedKey,
  writeExtraKey,
} from './_seed-utils.mjs';
import { fetchGdeltJson } from './_gdelt-fetch.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:gdelt-intel:v1';
const SEED_DOMAIN_RESOURCE = 'intelligence:gdelt-intel';
const SEED_META_KEY = `seed-meta:${SEED_DOMAIN_RESOURCE}`;
const SEED_META_TTL = 86400 * 7;
const CACHE_TTL = 86400; // 24h — intentionally much longer than the 4h cron so verifySeedKey always has a prior snapshot to merge from when GDELT is unavailable
// 7d — brownout-scale, NOT one-missed-tick-scale. The per-run EXPIRE-extend in
// afterPublish keeps last-good timelines alive up to this TTL while GDELT is
// unreachable; at the previous 12h (2× cron) the 2026-07 brownout expired all
// 12 tone/vol keys, and once a key is gone EXPIRE is a no-op and nothing
// re-seeds it until GDELT answers again (issue #5478). Consumers get the
// stored fetchedAt alongside the data to judge staleness.
export const TIMELINE_TTL = 604800;
const GDELT_REQUEST_DELAY_MS = 5_500;
// Both entrypoints mutate the same canonical/timeline cohort, so their shared
// ownership lease must cover the full bounded retry envelope, not just healthy
// latency. Under simultaneous GDELT and Upstash throttling, 12 sequential
// timeline reads/fetches/writes plus metadata reconciliation can take roughly
// 75 minutes (Retry-After is capped at 60s in the shared Redis helpers). Two
// hours preserves a wide scheduling margin without blocking the next 4h cron
// tick if a process dies before its owner-token release runs.
export const GDELT_LOCK_TTL_MS = 2 * 60 * 60_000;
const RUN_SEED_FETCH_PHASE_TIMEOUT_MS = 390_000;
const TIMELINE_ERROR_REASON = 'timeline_keys_missing_or_unconfirmed';
const GDELT_UPSTREAM_ERROR_REASON = 'gdelt_upstream_unavailable';
const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
// Wall-clock soft budget for the whole fetch phase (issue #4864). The transport
// now selects one route and attempts it once. This remains as a final guard for
// an injected/hung implementation, but a budget timeout opens the run circuit:
// the abandoned promise is allowed to settle and no timeline or later-topic
// request is launched alongside it.
// The production residential route completed the real ArticleList query in
// roughly 22s, with most of that time in the target TLS handshake. Each 4h run
// now performs six article calls plus one topic's tone/volume pair (8 total);
// the UTC slot rotation refreshes all six 14-day timeline pairs once per day.
// At the 30s transport ceiling plus seven pacing gaps that sweep needs at most
// ~279s. Five minutes bounds it without retries, and the runSeed deadline keeps
// 90s for cache merge and fetch-phase cleanup.
const FETCH_SOFT_BUDGET_MS = 300_000;
const MIN_REQUEST_BUDGET_MS = 35_000; // 30s curl ceiling plus scheduling headroom

const INTEL_TOPICS = [
  { id: 'military',     query: '(military exercise OR troop deployment OR airstrike OR "naval exercise") sourcelang:eng' },
  { id: 'cyber',        query: '(cyberattack OR ransomware OR hacking OR "data breach" OR APT) sourcelang:eng' },
  { id: 'nuclear',      query: '(nuclear OR uranium enrichment OR IAEA OR "nuclear weapon" OR plutonium) sourcelang:eng' },
  { id: 'sanctions',    query: '(sanctions OR embargo OR "trade war" OR tariff OR "economic pressure") sourcelang:eng' },
  { id: 'intelligence', query: '(espionage OR spy OR "intelligence agency" OR covert OR surveillance) sourcelang:eng' },
  { id: 'maritime',     query: '(naval blockade OR piracy OR "strait of hormuz" OR "south china sea" OR warship) sourcelang:eng' },
];

const TIMELINE_SERIES = [
  { id: 'tone', mode: 'TimelineTone', topicField: '_tone' },
  { id: 'vol', mode: 'TimelineVol', topicField: '_vol' },
];

function timelineKey(seriesId, topicId) {
  return `gdelt:intel:${seriesId}:${topicId}`;
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function normalizeArticle(raw) {
  const url = raw.url || '';
  if (!isValidUrl(url)) return null;
  return {
    title: String(raw.title || '').slice(0, 500),
    url,
    source: String(raw.domain || raw.source?.domain || '').slice(0, 200),
    date: String(raw.seendate || ''),
    image: isValidUrl(raw.socialimage || '') ? raw.socialimage : '',
    language: String(raw.language || ''),
    tone: typeof raw.tone === 'number' ? raw.tone : 0,
  };
}

export async function fetchTopicArticles(topic, opts = {}) {
  const { _fetchJson = fetchGdeltJson } = opts;
  const url = new URL(GDELT_DOC_API);
  url.searchParams.set('query', topic.query);
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('maxrecords', '10');
  url.searchParams.set('format', 'json');
  url.searchParams.set('sort', 'date');
  url.searchParams.set('timespan', '24h');

  const data = await _fetchJson(url.toString(), {
    label: topic.id,
    maxRetries: 0,
    proxyMaxAttempts: 1,
  });
  const articles = (data.articles || [])
    .map(normalizeArticle)
    .filter(Boolean);

  return {
    id: topic.id,
    articles,
    fetchedAt: new Date().toISOString(),
  };
}

function normalizeTimeline(data, mode) {
  const raw = data?.timeline ?? data?.data ?? [];
  return raw.map((pt) => ({
    date: String(pt.date || pt.datetime || ''),
    value: typeof pt.value === 'number' ? pt.value : (typeof pt[mode] === 'number' ? pt[mode] : 0),
  })).filter((pt) => pt.date);
}

export async function fetchTopicTimelineResult(topic, mode, opts = {}) {
  const {
    strict = false,
    _fetchJson = fetchGdeltJson,
  } = opts;
  const url = new URL(GDELT_DOC_API);
  url.searchParams.set('query', topic.query);
  url.searchParams.set('mode', mode);
  url.searchParams.set('format', 'json');
  url.searchParams.set('timespan', '14d');

  try {
    const data = await _fetchJson(url.toString(), {
      label: `${topic.id}/${mode}`,
      maxRetries: 0,
      proxyMaxAttempts: 1,
    });
    return {
      points: normalizeTimeline(data, mode === 'TimelineTone' ? 'tone' : 'value'),
      errorCode: null,
    };
  } catch (err) {
    if (strict) throw err;
    return {
      points: [],
      errorCode: typeof err?.code === 'string' ? err.code : 'GDELT_TIMELINE_FETCH_FAILED',
    };
  }
}

export async function fetchTopicTimeline(topic, mode, opts = {}) {
  return (await fetchTopicTimelineResult(topic, mode, opts)).points;
}

async function fetchArticlesOnce(topic) {
  try {
    return await fetchTopicArticles(topic);
  } catch (err) {
    console.warn(`    ${topic.id}: giving up (${err.message})`);
    return {
      id: topic.id,
      articles: [],
      fetchedAt: new Date().toISOString(),
      failureCode: typeof err?.code === 'string' ? err.code : 'GDELT_ARTICLE_FETCH_FAILED',
    };
  }
}

// Start `operation` only when budget remains, and never let it run past
// `budgetMs`; on timeout resolve to `fallback` (and run `onTimeout` for a log
// line). The fallback opens the run-scoped circuit below, so the abandoned
// bounded request is never overlapped by timeline or later-topic calls.
function withBudget(operation, budgetMs, fallback, onTimeout) {
  if (!(budgetMs > 0)) return Promise.resolve(fallback);
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      resolve(fallback);
    }, budgetMs);
  });
  const pending = Promise.resolve().then(operation);
  return Promise.race([pending, budget]).finally(() => clearTimeout(timer));
}

// Exported for tests. Deps are injectable so the soft-budget + cache-merge
// behaviour can be driven without a real GDELT/Redis.
export async function fetchAllTopics(deps = {}) {
  const {
    _now = () => Date.now(),
    _sleep = sleep,
    _fetchArticles = fetchArticlesOnce,
    _fetchTimeline = fetchTopicTimelineResult,
    // The cache-merge fallback is what keeps seed-meta fresh through a GDELT
    // outage — when this read dies the run degrades to a no-write skip and
    // freshness silently rots (21h stale before the gate fired, issue #5437),
    // so its failure must be visible in the run log.
    _loadPrevious = () => verifySeedKey(CANONICAL_KEY).catch((err) => {
      console.warn(`  cache-merge: failed to load previous snapshot (${err?.message || err}) — topics will not be backfilled this run`);
      return null;
    }),
    _softBudgetMs = FETCH_SOFT_BUDGET_MS,
    _minRequestBudgetMs = MIN_REQUEST_BUDGET_MS,
    _interRequestDelayMs = GDELT_REQUEST_DELAY_MS,
  } = deps;
  const runStartedAt = _now();
  const deadlineAt = runStartedAt + _softBudgetMs;
  const remaining = () => deadlineAt - _now();

  const topics = [];
  let failureCode = null;
  let freshTopicCount = 0;
  let requestCount = 0;
  const paceNextRequest = async () => {
    if (requestCount > 0 && _interRequestDelayMs > 0) {
      const delay = Math.min(
        _interRequestDelayMs,
        Math.max(0, remaining() - _minRequestBudgetMs),
      );
      if (delay > 0) await _sleep(delay);
    }
    if (remaining() < _minRequestBudgetMs) return false;
    requestCount += 1;
    return true;
  };

  for (let i = 0; i < INTEL_TOPICS.length; i++) {
    // Stop fetching once we can't plausibly finish another topic in time — the
    // cache-merge below backfills every topic we skip from the prior snapshot,
    // so the run publishes partial+cached data and exits 0 instead of churning
    // past the hard #4786 deadline into a graceful exit-75 crash (issue #4864).
    if (remaining() < _minRequestBudgetMs) {
      console.log(`  Soft budget (${Math.round(_softBudgetMs / 1000)}s) reached after ${i}/${INTEL_TOPICS.length} topic(s) — remaining ${INTEL_TOPICS.length - i} will fall back to cached snapshot`);
      failureCode = 'GDELT_FETCH_BUDGET_EXCEEDED';
      break;
    }
    if (!(await paceNextRequest())) {
      failureCode = 'GDELT_FETCH_BUDGET_EXCEEDED';
      break;
    }
    console.log(`  Fetching ${INTEL_TOPICS[i].id}...`);
    const emptyTopic = () => ({ id: INTEL_TOPICS[i].id, articles: [], fetchedAt: new Date().toISOString() });
    const result = await withBudget(
      () => _fetchArticles(INTEL_TOPICS[i]),
      remaining(),
      { ...emptyTopic(), budgetExceeded: true },
      () => console.warn(`    ${INTEL_TOPICS[i].id}: article budget reached — falling back to cached`),
    );
    console.log(`    ${result.articles.length} articles`);
    for (const series of TIMELINE_SERIES) {
      result[series.topicField] = [];
    }
    topics.push(result);

    if (result.budgetExceeded || result.failureCode) {
      failureCode = result.failureCode || 'GDELT_FETCH_BUDGET_EXCEEDED';
      console.warn(`    ${INTEL_TOPICS[i].id}: opening run circuit (${failureCode}); remaining DOC requests will use cached data`);
      break;
    }

    if (result.articles.length > 0) freshTopicCount += 1;
  }

  if (!failureCode && freshTopicCount === 0) {
    failureCode = 'GDELT_EMPTY_ARTICLE_RESULTS';
  }

  // Timeline queries cover 14 days and are materially more expensive on
  // GDELT's rate-limited search cluster than the 24h ArticleList queries.
  // Refresh exactly one topic pair per 4h UTC slot, after all six article
  // requests have completed. This caps a healthy run at eight DOC requests,
  // refreshes every pair daily, and ensures a timeline 429 cannot starve later
  // article topics. Skipped series remain empty so afterPublish extends their
  // existing TTL without falsely stamping cached points as freshly fetched.
  if (!failureCode && topics.length === INTEL_TOPICS.length) {
    const fourHourSlot = Math.floor(runStartedAt / (4 * 60 * 60_000));
    const slotIndex =
      ((fourHourSlot % INTEL_TOPICS.length) + INTEL_TOPICS.length)
      % INTEL_TOPICS.length;
    const timelineTopic = INTEL_TOPICS[slotIndex];
    const result = topics.find((topic) => topic.id === timelineTopic.id);
    console.log(`  Refreshing ${timelineTopic.id} timeline pair...`);
    for (const series of TIMELINE_SERIES) {
      const timelineFallback = { points: [], errorCode: 'GDELT_FETCH_BUDGET_EXCEEDED' };
      const hasBudget = await paceNextRequest();
      const outcome = hasBudget
        ? await withBudget(
            () => _fetchTimeline(timelineTopic, series.mode),
            remaining(),
            timelineFallback,
            () => console.warn(`    ${timelineTopic.id}: ${series.id} timeline budget reached`),
          )
        : timelineFallback;
      const normalized = Array.isArray(outcome)
        ? { points: outcome, errorCode: null }
        : outcome;
      result[series.topicField] = Array.isArray(normalized?.points) ? normalized.points : [];
      if (normalized?.errorCode) {
        failureCode = normalized.errorCode;
        console.warn(`    ${timelineTopic.id}: opening run circuit (${failureCode}); remaining DOC requests will use cached data`);
        break;
      }
    }
    console.log(`    timeline: ${result._tone.length} tone pts, ${result._vol.length} vol pts`);
  }

  // Represent every topic so the cache-merge can backfill both the ones we
  // skipped (soft budget) and the ones that came back empty (429).
  const fetchedIds = new Set(topics.map((t) => t.id));
  for (const t of INTEL_TOPICS) {
    if (!fetchedIds.has(t.id)) {
      topics.push({
        id: t.id,
        articles: [],
        fetchedAt: new Date().toISOString(),
        _tone: [],
        _vol: [],
      });
    }
  }

  // For topics that returned 0 articles (rate-limited or budget-skipped), preserve
  // the previous snapshot's articles rather than publishing empty over good cached data.
  const emptyTopics = topics.filter((t) => t.articles.length === 0);
  if (emptyTopics.length > 0) {
    const previous = await _loadPrevious();
    if (previous && Array.isArray(previous.topics)) {
      const prevMap = new Map(previous.topics.map((t) => [t.id, t]));
      for (const topic of topics) {
        if (topic.articles.length === 0 && prevMap.has(topic.id)) {
          const prev = prevMap.get(topic.id);
          if (prev.articles?.length > 0) {
            console.log(`    ${topic.id}: no fresh articles — using ${prev.articles.length} cached articles from previous snapshot`);
            topic.articles = prev.articles;
            topic.fetchedAt = prev.fetchedAt;
          }
        }
      }
    }
  }

  // Restore canonical topic order (backfilled entries were appended out of order).
  const order = new Map(INTEL_TOPICS.map((t, idx) => [t.id, idx]));
  topics.sort((a, b) => (order.get(a.id) ?? INTEL_TOPICS.length) - (order.get(b.id) ?? INTEL_TOPICS.length));
  return {
    topics,
    fetchedAt: new Date().toISOString(),
    _gdeltFailureCode: failureCode,
    _freshTopicCount: freshTopicCount,
  };
}

function validate(data) {
  if (!Array.isArray(data?.topics) || data.topics.length === 0) return false;
  const populated = data.topics.filter((t) => Array.isArray(t.articles) && t.articles.length > 0);
  return populated.length >= 3; // at least 3 of 6 topics must have articles; partial 429s handled by per-topic merge above
}

// Strip transport/timeline implementation fields before writing the canonical
// Redis payload. They are consumed only by afterPublish and seed-meta.
function publishTransform(data) {
  const {
    _gdeltFailureCode: _failure,
    _freshTopicCount: _fresh,
    ...publicData
  } = data;
  return {
    ...publicData,
    topics: (data.topics ?? []).map(({
      _tone: _t,
      _vol: _v,
      failureCode: _failureCode,
      budgetExceeded: _budgetExceeded,
      ...rest
    }) => rest),
  };
}

// Write per-topic tone/vol timeline keys (TIMELINE_TTL, separate from the
// 24h canonical key). When GDELT rate-limits a topic's TimelineTone/Vol
// sub-fetch, _tone / _vol arrive empty for that topic — rather than let
// the existing Redis key silently expire mid-cycle, extend its TTL with
// EXPIRE so downstream consumers (cross-source-signals, etc.) keep seeing
// the last successful snapshot until the next cron cycle refreshes it.
//
// Runs strictly AFTER the canonical publish succeeded, so no failure here may
// escape as a throw — writeExtraKey exhausting its retries under the same
// Redis contention that produced the #5478 FATALs would otherwise turn an
// already-successful run into exit 1. A failed fresh write degrades to the
// EXPIRE-extend path (preserve last-good), loudly.
export async function afterPublish(data, _meta) {
  const keysToExtend = new Map(TIMELINE_SERIES.map((series) => [series.id, []]));
  const missingOrUnconfirmedKeys = [];
  const writeOrQueueExtend = async (key, timeline, fetchedAt, extendQueue) => {
    if (Array.isArray(timeline) && timeline.length > 0) {
      try {
        await writeExtraKey(key, { data: timeline, fetchedAt }, TIMELINE_TTL);
        return;
      } catch (err) {
        console.warn(`  WARNING: timeline write for ${key} failed after retries (${err?.message || err}) — falling back to EXPIRE-extend of last-good`);
      }
    }
    extendQueue.push(key);
  };
  for (const topic of data.topics ?? []) {
    // A non-empty _tone/_vol was fetched THIS run, so stamp writes with the
    // run-level fetchedAt: topic.fetchedAt may be coasted to the previous
    // snapshot's time when the articles 429'd but the timeline succeeded, and
    // a stale stamp would make cross-source-signals' 48h signal-grade guard
    // suppress a genuinely fresh series.
    const fetchedAt = data.fetchedAt ?? topic.fetchedAt;
    for (const series of TIMELINE_SERIES) {
      await writeOrQueueExtend(
        timelineKey(series.id, topic.id),
        topic[series.topicField],
        fetchedAt,
        keysToExtend.get(series.id),
      );
    }
  }
  for (const series of TIMELINE_SERIES) {
    const queuedKeys = keysToExtend.get(series.id);
    if (queuedKeys.length > 0) {
      console.log(`  Extending ${series.id} TTL for ${queuedKeys.length} rate-limited topic(s): ${queuedKeys.map((key) => key.split(':').pop()).join(', ')}`);
      const ttlResult = await extendExistingTtlDetailed(queuedKeys, TIMELINE_TTL);
      const unavailableKeys = new Set([...ttlResult.missingKeys, ...ttlResult.unconfirmedKeys]);
      missingOrUnconfirmedKeys.push(...queuedKeys.filter((key) => unavailableKeys.has(key)));
    }
  }
  if (missingOrUnconfirmedKeys.length > 0) {
    console.warn(
      `  WARNING: ${missingOrUnconfirmedKeys.length} timeline key(s) are missing or could not be confirmed; `
      + `run \`node scripts/seed-gdelt-intel.mjs --repair-timelines\` to restore them outside the article-fetch budget`,
    );
  }
  const upstreamFailed = typeof data?._gdeltFailureCode === 'string';
  const completionState = upstreamFailed || missingOrUnconfirmedKeys.length > 0
    ? 'DEGRADED'
    : 'OK';
  const freshnessMetaPatch = completionState === 'DEGRADED'
    ? {
        status: 'error',
        errorReason: upstreamFailed ? GDELT_UPSTREAM_ERROR_REASON : TIMELINE_ERROR_REASON,
        ...(upstreamFailed ? { errorCode: data._gdeltFailureCode } : {}),
        ...(Number.isInteger(data?._freshTopicCount)
          ? { freshTopicCount: data._freshTopicCount }
          : {}),
        ...(missingOrUnconfirmedKeys.length > 0
          ? { missingTimelineKeys: missingOrUnconfirmedKeys }
          : {}),
      }
    : null;
  return {
    completionState,
    freshnessMetaPatch,
  };
}

function hasTimelineData(value) {
  const points = Array.isArray(value) ? value : value?.data;
  return Array.isArray(points) && points.length > 0;
}

// Dedicated operator repair path for issue #5712. Healthy requests are paced,
// but the first transport failure opens a run-scoped circuit. Remaining keys
// are still read/preserved and reported as failed without repeating the same
// blocked route up to eleven more times.
export async function repairTimelines(deps = {}) {
  const {
    _readTimeline = verifySeedKey,
    _fetchTimeline = (topic, mode) => fetchTopicTimeline(topic, mode, { strict: true }),
    _writeTimeline = writeExtraKey,
    _extendTtl = extendExistingTtl,
    _sleep = sleep,
    _interRequestDelayMs = GDELT_REQUEST_DELAY_MS,
    _now = () => Date.now(),
  } = deps;
  const repairedKeys = [];
  const preservedKeys = [];
  const failedKeys = [];
  let fetchCount = 0;
  let failureCode = null;

  for (const topic of INTEL_TOPICS) {
    for (const series of TIMELINE_SERIES) {
      const key = timelineKey(series.id, topic.id);
      let existing = null;
      try {
        existing = await _readTimeline(key);
      } catch (err) {
        console.warn(`  ${key}: Redis read failed (${err?.message || err}); attempting a fresh repair`);
      }

      if (hasTimelineData(existing) && await _extendTtl([key], TIMELINE_TTL)) {
        preservedKeys.push(key);
        continue;
      }

      if (failureCode) {
        failedKeys.push(key);
        continue;
      }

      if (fetchCount > 0 && _interRequestDelayMs > 0) {
        await _sleep(_interRequestDelayMs);
      }
      fetchCount += 1;

      let timeline;
      try {
        timeline = await _fetchTimeline(topic, series.mode);
      } catch (err) {
        failedKeys.push(key);
        failureCode = typeof err?.code === 'string'
          ? err.code
          : 'GDELT_TIMELINE_FETCH_FAILED';
        console.warn(`  ${key}: repair fetch failed (${err?.message || err})`);
        continue;
      }
      if (!Array.isArray(timeline) || timeline.length === 0) {
        failedKeys.push(key);
        console.warn(`  ${key}: repair fetch returned no timeline points`);
        continue;
      }

      try {
        await _writeTimeline(
          key,
          { data: timeline, fetchedAt: new Date(_now()).toISOString() },
          TIMELINE_TTL,
        );
        repairedKeys.push(key);
      } catch (err) {
        failedKeys.push(key);
        console.warn(`  ${key}: repair write failed (${err?.message || err})`);
      }
    }
  }

  const result = {
    completionState: failedKeys.length > 0 ? 'DEGRADED' : 'OK',
    repairedCount: repairedKeys.length,
    preservedCount: preservedKeys.length,
    repairedKeys,
    preservedKeys,
    failedKeys,
    ...(failureCode ? { errorCode: failureCode } : {}),
  };
  return result;
}

function emptyRepairResult(extra = {}) {
  return {
    completionState: 'DEGRADED',
    repairedCount: 0,
    preservedCount: 0,
    repairedKeys: [],
    preservedKeys: [],
    failedKeys: [],
    ...extra,
  };
}

export async function reconcileTimelineRepairMetadata(repairResult, deps = {}) {
  const {
    _readMeta = () => verifySeedKey(SEED_META_KEY),
    _writeMeta = (meta, ttl) => writeExtraKey(SEED_META_KEY, meta, ttl),
  } = deps;
  const currentMeta = await _readMeta();
  if (!currentMeta || typeof currentMeta !== 'object' || Array.isArray(currentMeta)) {
    throw new Error(`${SEED_META_KEY} is absent or unreadable`);
  }

  const failedKeys = [...new Set(repairResult.failedKeys ?? [])];
  const nextMeta = { ...currentMeta };
  if (failedKeys.length > 0) {
    const unrelatedErrorOwnsRecord =
      nextMeta.status === 'error'
      && typeof nextMeta.errorReason === 'string'
      && nextMeta.errorReason.length > 0
      && nextMeta.errorReason !== TIMELINE_ERROR_REASON;
    if (!unrelatedErrorOwnsRecord) {
      nextMeta.status = 'error';
      nextMeta.errorReason = TIMELINE_ERROR_REASON;
      nextMeta.errorCode = repairResult.errorCode || 'GDELT_TIMELINE_REPAIR_INCOMPLETE';
    }
    nextMeta.missingTimelineKeys = failedKeys;
  } else {
    delete nextMeta.missingTimelineKeys;
    if (nextMeta.errorReason === TIMELINE_ERROR_REASON) {
      delete nextMeta.status;
      delete nextMeta.errorReason;
      delete nextMeta.errorCode;
    }
  }
  await _writeMeta(nextMeta, SEED_META_TTL);
  return nextMeta;
}

function logTimelineRepairResult(result) {
  console.log(JSON.stringify({
    event: 'gdelt_timeline_repair',
    state: result.completionState,
    repairedCount: result.repairedCount,
    preservedCount: result.preservedCount,
    failedCount: result.failedKeys?.length ?? 0,
    errorCode: result.errorCode,
    metadataReconciled: result.metadataReconciled === true,
    lockReason: result.lockReason,
    repairError: result.repairError,
    metadataError: result.metadataError,
    lockReleaseError: result.lockReleaseError,
  }));
}

// Operator entrypoint: the repair, health-metadata reconciliation, and final
// outcome all share the scheduled seeder's ownership lock. The only structured
// result is emitted after metadata persistence and lock release have settled.
export async function runTimelineRepair(deps = {}) {
  const {
    _acquireLock = acquireLockSafely,
    _releaseLock = releaseLock,
    _repair = repairTimelines,
    _repairDeps,
    _readMeta = () => verifySeedKey(SEED_META_KEY),
    _writeMeta = (meta, ttl) => writeExtraKey(SEED_META_KEY, meta, ttl),
    _runId = () => `repair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  } = deps;
  const runId = typeof _runId === 'function' ? _runId() : _runId;
  let locked = false;
  let result = emptyRepairResult({ lockReason: 'lock_unavailable' });

  try {
    let lockResult;
    if (
      _acquireLock === acquireLockSafely
      && (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN)
    ) {
      lockResult = { locked: false, skipped: true, reason: 'missing_redis_credentials' };
    } else {
      try {
        lockResult = await _acquireLock(
          SEED_DOMAIN_RESOURCE,
          runId,
          GDELT_LOCK_TTL_MS,
          { label: `${SEED_DOMAIN_RESOURCE} timeline repair` },
        );
      } catch (err) {
        result = emptyRepairResult({
          lockReason: 'lock_error',
          lockError: err?.message || String(err),
        });
      }
    }

    if (lockResult?.locked) {
      locked = true;
      try {
        const repairResult = await _repair(_repairDeps);
        if (!repairResult || typeof repairResult !== 'object') {
          throw new Error('repair returned no result');
        }
        result = repairResult;
        try {
          await reconcileTimelineRepairMetadata(result, { _readMeta, _writeMeta });
          result = { ...result, metadataReconciled: true };
        } catch (err) {
          result = {
            ...result,
            completionState: 'DEGRADED',
            metadataReconciled: false,
            metadataError: err?.message || String(err),
          };
        }
      } catch (err) {
        result = emptyRepairResult({
          repairError: err?.message || String(err),
        });
      }
    } else if (lockResult) {
      result = emptyRepairResult({
        lockReason: lockResult.skipped
          ? (lockResult.reason || 'lock_unavailable')
          : 'lock_contended',
      });
    }
  } finally {
    if (locked) {
      try {
        await _releaseLock(SEED_DOMAIN_RESOURCE, runId);
      } catch (err) {
        result = {
          ...result,
          completionState: 'DEGRADED',
          lockReleaseError: err?.message || String(err),
        };
      }
    }
  }

  logTimelineRepairResult(result);
  return result;
}

export function declareRecords(data) {
  return Array.isArray(data?.topics) ? data.topics.length : 0;
}

// Content-age trio (issue #5478 strand 3, carried over from #5437's "separate
// concern"). The cache-merge fallback republishes weeks-old articles under a
// fresh envelope fetchedAt, so seed-meta age NEVER trips during a GDELT
// brownout — 4 of 6 topics coasted for 3 weeks with zero alarms. Per-topic
// fetchedAt survives the merge unchanged (the backfill copies the previous
// snapshot's value), making it the honest coasting signal:
//   newestItemAt = most recently fetched topic — ages only when EVERY topic
//                  is coasting (topic[0] is fetched first each run, so any
//                  GDELT success at all keeps this fresh);
//   oldestItemAt = most starved topic, for operator visibility.
export function contentMeta(data) {
  // Only topics that actually carry articles count: an articleless topic keeps
  // fetchedAt=now (the empty-topic placeholder), which would hold newestItemAt
  // fresh precisely in the total-death scenario — brownout + expired canonical,
  // nothing to backfill — where STALE_CONTENT matters most.
  const times = (data?.topics ?? [])
    .filter((t) => Array.isArray(t?.articles) && t.articles.length > 0)
    .map((t) => Date.parse(t?.fetchedAt))
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  if (times.length === 0) return null;
  return { newestItemAt: Math.max(...times), oldestItemAt: Math.min(...times) };
}

// Exported so tests can pin the exact wiring the cron entry runs with.
export const RUN_SEED_OPTS = {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  lockTtlMs: GDELT_LOCK_TTL_MS,
  fetchPhaseTimeoutMs: RUN_SEED_FETCH_PHASE_TIMEOUT_MS,
  sourceVersion: 'gdelt-doc-v2',
  publishTransform,
  afterPublish,
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 420,
  contentMeta,
  // 24h = 6× the 4h cadence. Normal runs refresh at least topic[0] every
  // tick, so only a real brownout (every topic failing every run for a day)
  // flips health to STALE_CONTENT (warn).
  maxContentAgeMin: 1440,
};

export async function runCli(args = process.argv.slice(2), deps = {}) {
  const {
    _runTimelineRepair = runTimelineRepair,
    _runSeed = runSeed,
  } = deps;
  if (args.includes('--repair-timelines')) {
    const result = await _runTimelineRepair();
    return result.completionState === 'OK' ? 0 : 1;
  }
  await _runSeed('intelligence', 'gdelt-intel', CANONICAL_KEY, fetchAllTopics, RUN_SEED_OPTS);
  return 0;
}

if (process.argv[1]?.endsWith('seed-gdelt-intel.mjs')) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
