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
const CACHE_TTL = 86400; // 24h — intentionally much longer than the 2h cron so verifySeedKey always has a prior snapshot to merge from when GDELT 429s all topics
// 7d — brownout-scale, NOT one-missed-tick-scale. The per-run EXPIRE-extend in
// afterPublish keeps last-good timelines alive up to this TTL while GDELT is
// unreachable; at the previous 12h (2× cron) the 2026-07 brownout expired all
// 12 tone/vol keys, and once a key is gone EXPIRE is a no-op and nothing
// re-seeds it until GDELT answers again (issue #5478). Consumers get the
// stored fetchedAt alongside the data to judge staleness.
export const TIMELINE_TTL = 604800;
const TIMELINE_REPAIR_DELAY_MS = 5_500;
// Both entrypoints mutate the same canonical/timeline cohort, so their shared
// ownership lease must cover the full bounded retry envelope, not just healthy
// latency. Under simultaneous GDELT and Upstash throttling, 12 sequential
// timeline reads/fetches/writes plus metadata reconciliation can take roughly
// 75 minutes (Retry-After is capped at 60s in the shared Redis helpers). Two
// hours preserves a wide scheduling margin without blocking the next 6h cron
// tick if a process dies before its owner-token release runs.
export const GDELT_LOCK_TTL_MS = 2 * 60 * 60_000;
const RUN_SEED_FETCH_PHASE_TIMEOUT_MS = 270_000;
const TIMELINE_ERROR_REASON = 'timeline_keys_missing_or_unconfirmed';
const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const INTER_TOPIC_DELAY_MS = 20_000; // 20s between topics on success
const POST_EXHAUST_DELAY_MS = 120_000; // 2min extra cooldown after a topic exhausts all retries

// Wall-clock soft budget for the whole fetch phase (issue #4864). Kept well
// under runSeed's explicit 270s hard #4786 deadline, while the 10min lock also
// covers canonical/timeline publication after the 150s fetch budget, so
// that under a GDELT/Decodo throttle storm the loop stops fetching and falls
// through to the cached-snapshot merge below — publishing partial+cached data
// and exiting 0 — instead of two independent budget-blowers pushing the phase
// past 240s and tripping the deadline into a graceful exit-75 "crash" email:
//   1. a single topic's fetchGdeltJson can churn ~3.5min under full retry
//      exhaustion (4×15s direct + 60s backoff + 5×15s proxy + 20s backoff);
//   2. the inter-topic (20s×5) + post-exhaust (120s) cooldowns alone exceed 240s.
// The 24h CACHE_TTL guarantees a prior snapshot exists to merge from.
const FETCH_SOFT_BUDGET_MS = 150_000; // 2.5min — >80s headroom under the 240s hard deadline for merge + publish
const MIN_TOPIC_BUDGET_MS = 25_000;   // don't start a topic we can't plausibly finish before the budget

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

async function fetchTopicArticles(topic) {
  const url = new URL(GDELT_DOC_API);
  url.searchParams.set('query', topic.query);
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('maxrecords', '10');
  url.searchParams.set('format', 'json');
  url.searchParams.set('sort', 'date');
  url.searchParams.set('timespan', '24h');

  // fetchGdeltJson does direct retry + curl proxy multi-retry internally.
  // Throws on exhaustion with HTTP 429 in message — outer fetchWithRetry's
  // is429 substring match still works against the new error format.
  const data = await fetchGdeltJson(url.toString(), { label: topic.id });
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

export async function fetchTopicTimeline(topic, mode, opts = {}) {
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
    // Best-effort: timelines degrade silently to [] on any failure.
    // Pre-helper code did a single direct fetch with no retry. The
    // article-fetch defaults (3 direct retries + 5 proxy attempts ≈ 90s)
    // are too aggressive for discarded-on-failure data — would burn up to
    // ~18 min/seed-run across 12 timeline calls under GDELT 429 storms.
    //
    // Compromise: 1 direct + 2 proxy (Decodo session rotation) attempts.
    // Worst case ~25s per call × 12 = ~5 min ceiling. Gives timelines a
    // realistic chance to succeed via proxy without blocking the seeder
    // for the full article-fetch budget.
    const data = await _fetchJson(url.toString(), {
      label: `${topic.id}/${mode}`,
      maxRetries: 0,
      proxyMaxAttempts: 2,
    });
    return normalizeTimeline(data, mode === 'TimelineTone' ? 'tone' : 'value');
  } catch (err) {
    if (strict) throw err;
    return [];
  }
}

async function fetchWithRetry(topic) {
  // Pre-helper: this function did 3 outer retries with 60/120/240s backoff
  // on top of fetchTopicArticles. Now fetchGdeltJson handles ALL retry +
  // proxy multi-retry internally (3 direct retries + 5 curl proxy attempts
  // per call), so the outer loop is gone. This function's only remaining
  // job is to translate thrown exhaustion into the {exhausted, articles:[]}
  // shape that fetchAllTopics expects (used to drive POST_EXHAUST_DELAY_MS
  // cooldown decisions).
  try {
    return await fetchTopicArticles(topic);
  } catch (err) {
    // Helper's exhausted-throw includes "HTTP 429" in the message when
    // 429 was the upstream signal — substring match preserved.
    const is429 = err.message?.includes('429');
    console.warn(`    ${topic.id}: giving up (${err.message})`);
    return { id: topic.id, articles: [], fetchedAt: new Date().toISOString(), exhausted: is429 };
  }
}

// Resolve `promise` but never let it run past `budgetMs`; on timeout resolve to
// `fallback` (and run `onTimeout` for a log line). Unlike raceFetchDeadline this
// RESOLVES rather than rejects, because a topic that overruns is not a failure —
// the caller backfills it from the cached snapshot. The abandoned fetch keeps
// running but every socket underneath it is bounded by AbortSignal.timeout /
// curl --max-time, so it settles and is GC'd (no leak).
function withBudget(promise, budgetMs, fallback, onTimeout) {
  if (!(budgetMs > 0)) return Promise.resolve(fallback);
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      resolve(fallback);
    }, budgetMs);
  });
  return Promise.race([Promise.resolve(promise), budget]).finally(() => clearTimeout(timer));
}

// Exported for tests. Deps are injectable so the soft-budget + cache-merge
// behaviour can be driven without a real GDELT/Redis.
export async function fetchAllTopics(deps = {}) {
  const {
    _now = () => Date.now(),
    _sleep = sleep,
    _fetchArticles = fetchWithRetry,
    _fetchTimeline = fetchTopicTimeline,
    // The cache-merge fallback is what keeps seed-meta fresh through a GDELT
    // outage — when this read dies the run degrades to a no-write skip and
    // freshness silently rots (21h stale before the gate fired, issue #5437),
    // so its failure must be visible in the run log.
    _loadPrevious = () => verifySeedKey(CANONICAL_KEY).catch((err) => {
      console.warn(`  cache-merge: failed to load previous snapshot (${err?.message || err}) — topics will not be backfilled this run`);
      return null;
    }),
    _softBudgetMs = FETCH_SOFT_BUDGET_MS,
    _minTopicBudgetMs = MIN_TOPIC_BUDGET_MS,
    _interTopicDelayMs = INTER_TOPIC_DELAY_MS,
    _postExhaustDelayMs = POST_EXHAUST_DELAY_MS,
  } = deps;
  const deadlineAt = _now() + _softBudgetMs;
  const remaining = () => deadlineAt - _now();

  const topics = [];
  for (let i = 0; i < INTEL_TOPICS.length; i++) {
    // Stop fetching once we can't plausibly finish another topic in time — the
    // cache-merge below backfills every topic we skip from the prior snapshot,
    // so the run publishes partial+cached data and exits 0 instead of churning
    // past the hard #4786 deadline into a graceful exit-75 crash (issue #4864).
    if (remaining() < _minTopicBudgetMs) {
      console.log(`  Soft budget (${Math.round(_softBudgetMs / 1000)}s) reached after ${i}/${INTEL_TOPICS.length} topic(s) — remaining ${INTEL_TOPICS.length - i} will fall back to cached snapshot`);
      break;
    }
    if (i > 0) await _sleep(Math.min(_interTopicDelayMs, Math.max(0, remaining() - _minTopicBudgetMs)));
    console.log(`  Fetching ${INTEL_TOPICS[i].id}...`);
    // Bound this single topic against the remaining budget: its own retry ladder
    // can reach ~3.5min under a 429 storm, which alone would blow the phase.
    const emptyTopic = () => ({ id: INTEL_TOPICS[i].id, articles: [], fetchedAt: new Date().toISOString() });
    const result = await withBudget(
      _fetchArticles(INTEL_TOPICS[i]),
      remaining(),
      { ...emptyTopic(), budgetExceeded: true },
      () => console.warn(`    ${INTEL_TOPICS[i].id}: article budget reached — falling back to cached`),
    );
    console.log(`    ${result.articles.length} articles`);
    // Fetch tone/vol timelines in parallel — best-effort, 429s silently return [].
    // Also bounded so a slow timeline pair can't overrun the phase.
    const timelines = await withBudget(
      Promise.all(TIMELINE_SERIES.map(
        (series) => _fetchTimeline(INTEL_TOPICS[i], series.mode),
      )),
      remaining(),
      [[], []],
      () => console.warn(`    ${INTEL_TOPICS[i].id}: timeline budget reached — skipping timelines`),
    );
    for (let j = 0; j < TIMELINE_SERIES.length; j++) {
      result[TIMELINE_SERIES[j].topicField] = timelines[j];
    }
    console.log(`    timeline: ${result._tone.length} tone pts, ${result._vol.length} vol pts`);
    topics.push(result);
    // After a topic exhausts all retries, give GDELT a longer cooldown before hitting
    // it again with the next topic — the rate limit window for popular queries exceeds 50s.
    // Skip the cooldown when it would eat the remaining budget.
    if (result.exhausted && i < INTEL_TOPICS.length - 1 && remaining() - _postExhaustDelayMs >= _minTopicBudgetMs) {
      console.log(`    Rate-limit cooldown: waiting ${_postExhaustDelayMs / 1000}s before next topic...`);
      await _sleep(_postExhaustDelayMs);
    }
  }

  // Represent every topic so the cache-merge can backfill both the ones we
  // skipped (soft budget) and the ones that came back empty (429).
  const fetchedIds = new Set(topics.map((t) => t.id));
  for (const t of INTEL_TOPICS) {
    if (!fetchedIds.has(t.id)) topics.push({ id: t.id, articles: [], fetchedAt: new Date().toISOString() });
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

  return { topics, fetchedAt: new Date().toISOString() };
}

function validate(data) {
  if (!Array.isArray(data?.topics) || data.topics.length === 0) return false;
  const populated = data.topics.filter((t) => Array.isArray(t.articles) && t.articles.length > 0);
  return populated.length >= 3; // at least 3 of 6 topics must have articles; partial 429s handled by per-topic merge above
}

// Strip private fields (_tone, _vol, exhausted) before writing to the canonical Redis key.
function publishTransform(data) {
  return {
    ...data,
    topics: (data.topics ?? []).map(({ _tone: _t, _vol: _v, exhausted: _e, ...rest }) => rest),
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
  const completionState = missingOrUnconfirmedKeys.length > 0 ? 'DEGRADED' : 'OK';
  return {
    completionState,
    freshnessMetaPatch: completionState === 'DEGRADED'
      ? {
          status: 'error',
          errorReason: TIMELINE_ERROR_REASON,
          missingTimelineKeys: missingOrUnconfirmedKeys,
        }
      : null,
  };
}

function hasTimelineData(value) {
  const points = Array.isArray(value) ? value : value?.data;
  return Array.isArray(points) && points.length > 0;
}

// Dedicated operator repair path for issue #5712. The regular seed's 150s
// article budget is intentionally unable to walk all 12 timeline requests
// during a GDELT throttle storm. This path does no article work, paces each
// timeline request independently, and writes every missing key with SET.
export async function repairTimelines(deps = {}) {
  const {
    _readTimeline = verifySeedKey,
    _fetchTimeline = (topic, mode) => fetchTopicTimeline(topic, mode, { strict: true }),
    _writeTimeline = writeExtraKey,
    _extendTtl = extendExistingTtl,
    _sleep = sleep,
    _interRequestDelayMs = TIMELINE_REPAIR_DELAY_MS,
    _now = () => Date.now(),
  } = deps;
  const repairedKeys = [];
  const preservedKeys = [];
  const failedKeys = [];
  let fetchCount = 0;

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

      if (fetchCount > 0 && _interRequestDelayMs > 0) {
        await _sleep(_interRequestDelayMs);
      }
      fetchCount += 1;

      let timeline;
      try {
        timeline = await _fetchTimeline(topic, series.mode);
      } catch (err) {
        failedKeys.push(key);
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
    }
    nextMeta.missingTimelineKeys = failedKeys;
  } else {
    delete nextMeta.missingTimelineKeys;
    if (nextMeta.errorReason === TIMELINE_ERROR_REASON) {
      delete nextMeta.status;
      delete nextMeta.errorReason;
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
  // 24h = 4× the 6h cadence. Normal runs refresh at least topic[0] every
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
