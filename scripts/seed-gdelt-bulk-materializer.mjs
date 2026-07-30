#!/usr/bin/env node

import { createHash } from 'node:crypto';

import {
  loadEnvFile,
  readSeedSnapshot,
  runSeed,
  writeExtraKey,
  writeExtraKeyWithMeta,
} from './_seed-utils.mjs';
import {
  extractGdeltBulkCsv,
  GDELT_BULK_TOPICS,
  isGdeltGeoMaterializationRecord,
  materializeGdeltBulk,
  parseGdeltBulkDescriptors,
  parseGdeltGkgCsv,
} from './_gdelt-bulk-materializer.mjs';
import {
  GDELT_MASTER_FILELIST_URL,
  GDELT_ROLLING_WINDOW_MS,
  gdeltTimestampToMs,
  mapGdeltExportToConflictEvents,
  mergeGdeltBulkRollingWindow,
} from './_conflict-gdelt-bulk.mjs';
export {
  GDELT_INTEL_KEY,
  GDELT_BULK_STATE_KEY,
  GDELT_BULK_CONFLICT_KEY,
  GDELT_BULK_UNREST_KEY,
  GDELT_BULK_ARTICLES_KEY,
  POSITIVE_EVENTS_RPC_KEY,
  POSITIVE_EVENTS_BOOTSTRAP_KEY,
} from './_gdelt-bulk-contract.mjs';
import {
  GDELT_INTEL_KEY,
  GDELT_BULK_STATE_KEY,
  GDELT_BULK_CONFLICT_KEY,
  GDELT_BULK_UNREST_KEY,
  GDELT_BULK_ARTICLES_KEY,
  POSITIVE_EVENTS_RPC_KEY,
  POSITIVE_EVENTS_BOOTSTRAP_KEY,
} from './_gdelt-bulk-contract.mjs';

loadEnvFile(import.meta.url);

const MASTER_TAIL_BYTES = 65_536;
const USER_AGENT = 'WorldMonitor/1.0 (+https://www.worldmonitor.app)';
const REQUEST_TIMEOUT_MS = 30_000;
const FETCH_CONCURRENCY = 4;
const MAX_CATCHUP_FILES_PER_KIND = 8;
const RECENT_GKG_WINDOW_MS = 2 * 60 * 60 * 1000;
const GDELT_SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
const MAX_RECENT_GEO_RECORDS = 5_000;

const INTEL_TTL = 86_400;
const TIMELINE_TTL = 7 * 86_400;
const STATE_TTL = 14 * 86_400;
const CONFLICT_TTL = 6 * 60 * 60;
const UNREST_TTL = 4.5 * 60 * 60;
// 3h, NOT 45min: api/health.js gates positiveGeoEvents at maxStaleMin 60 AND
// treats a missing payload as a hard failure, so a TTL under that window makes a
// merely-late materializer page as EMPTY/crit before STALE_SEED can warn — the
// #5309 ACLED_TTL zero-headroom class. The old warm relay masked this with a
// 5-min in-process retry loop; a single-shot 15-min cron has no such cover, and
// a skipped tick must degrade to a warning, not a page (#5863 review).
const POSITIVE_TTL = 3 * 60 * 60;
const ARTICLES_TTL = 2 * 86_400;
const POSITIVE_EVENTS_META_KEY = 'seed-meta:positive-events:geo';

function timelineKey(series, topic) {
  return `gdelt:intel:${series}:${topic}`;
}

function feedTimestamps(values, kind) {
  return values
    .filter(({ descriptor }) => descriptor?.kind === kind)
    .map(({ descriptor }) => descriptor.timestamp)
    .filter((timestamp) => /^\d{14}$/.test(timestamp))
    .sort();
}

function validateCurrentFeedCohort(values, nowMs) {
  const latestByKind = {};
  for (const kind of ['gkg', 'export']) {
    const timestamps = feedTimestamps(values, kind);
    if (timestamps.length === 0) {
      throw new Error(`GDELT bulk materializer received no current ${kind === 'gkg' ? 'GKG' : kind} snapshot`);
    }
    latestByKind[kind] = timestamps.at(-1);
    const latestMs = gdeltTimestampToMs(latestByKind[kind]);
    if (!Number.isFinite(latestMs) || nowMs - latestMs > RECENT_GKG_WINDOW_MS) {
      throw new Error(
        `GDELT bulk materializer latest ${kind === 'gkg' ? 'GKG' : kind} snapshot is outside the 2h freshness window`,
      );
    }
    for (let index = 1; index < timestamps.length; index += 1) {
      const previousTimestamp = timestamps[index - 1];
      const currentTimestamp = timestamps[index];
      const gapMs = gdeltTimestampToMs(currentTimestamp)
        - gdeltTimestampToMs(previousTimestamp);
      if (gapMs > GDELT_SNAPSHOT_INTERVAL_MS) {
        throw new Error(
          `GDELT bulk materializer received a non-contiguous ${kind} cohort between `
          + `${previousTimestamp} and ${currentTimestamp}`,
        );
      }
    }
  }
  if (latestByKind.gkg !== latestByKind.export) {
    throw new Error(
      `GDELT bulk materializer requires a symmetric GKG and export cohort; `
      + `latest GKG is ${latestByKind.gkg}, latest export is ${latestByKind.export}`,
    );
  }
}

async function fetchBoundedBuffer(fetchImpl, url, maxBytes, { expectedStatus, ...options } = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Accept: '*/*',
      'User-Agent': USER_AGENT,
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GDELT bulk HTTP ${response.status} for ${url}`);
  if (expectedStatus && response.status !== expectedStatus) {
    throw new Error(`GDELT bulk expected HTTP ${expectedStatus}, got ${response.status}`);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`GDELT bulk response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) throw new Error('GDELT bulk response has no body');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`GDELT bulk response exceeds ${maxBytes} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

async function mapWithConcurrency(values, limit, fn) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(values[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}

export async function fetchGdeltBulkFiles({
  afterTimestamp = {},
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
} = {}) {
  const manifest = await fetchBoundedBuffer(
    fetchImpl,
    GDELT_MASTER_FILELIST_URL,
    MASTER_TAIL_BYTES,
    {
      headers: { Range: `bytes=-${MASTER_TAIL_BYTES}` },
      expectedStatus: 206,
    },
  );
  const descriptors = parseGdeltBulkDescriptors(manifest.toString('utf8'), {
    afterTimestamp,
    maxPerKind: MAX_CATCHUP_FILES_PER_KIND,
  });
  if (descriptors.length === 0) {
    throw new Error('GDELT bulk manifest has no newer GKG or export snapshot');
  }
  validateCurrentFeedCohort(descriptors.map((descriptor) => ({ descriptor })), nowMs);
  const downloaded = await mapWithConcurrency(
    descriptors,
    FETCH_CONCURRENCY,
    async (descriptor) => {
      const maxBytes = descriptor.kind === 'gkg' ? 15_000_000 : 5_000_000;
      const zip = await fetchBoundedBuffer(fetchImpl, descriptor.url, maxBytes);
      if (zip.length !== descriptor.size) {
        throw new Error(
          `GDELT ${descriptor.kind} download size mismatch: expected ${descriptor.size}, got ${zip.length}`,
        );
      }
      const md5 = createHash('md5').update(zip).digest('hex');
      if (md5 !== descriptor.md5) throw new Error(`GDELT ${descriptor.kind} checksum mismatch`);
      const csv = extractGdeltBulkCsv(zip, descriptor);
      return descriptor.kind === 'gkg'
        ? { descriptor, records: parseGdeltGkgCsv(csv) }
        : { descriptor, events: mapGdeltExportToConflictEvents(csv) };
    },
  );
  return downloaded;
}

function recentBatches(previous, current, nowMs) {
  const cutoff = nowMs - RECENT_GKG_WINDOW_MS;
  const byTimestamp = new Map();
  for (const batch of [
    ...(Array.isArray(previous) ? previous : []),
    ...current,
  ]) {
    const batchMs = gdeltTimestampToMs(batch?.timestamp);
    if (!Number.isFinite(batchMs) || batchMs < cutoff || !Array.isArray(batch.records)) continue;
    byTimestamp.set(batch.timestamp, batch);
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function compactRecentGeoBatches(batches) {
  let remaining = MAX_RECENT_GEO_RECORDS;
  const newestFirst = [];
  for (const batch of [...batches].reverse()) {
    if (remaining <= 0) break;
    const records = batch.records
      .filter(isGdeltGeoMaterializationRecord)
      .slice(-remaining);
    remaining -= records.length;
    if (records.length > 0) newestFirst.push({ ...batch, records });
  }
  return newestFirst.reverse();
}

function newestFetchedAt(...values) {
  return values
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1);
}

async function readLegacyTimelines(readSnapshot) {
  const snapshots = await Promise.all(
    GDELT_BULK_TOPICS.flatMap(({ id: topic }) =>
      ['tone', 'vol'].map(async (series) => ({
        topic,
        series,
        snapshot: await readSnapshot(timelineKey(series, topic)),
      }))),
  );
  const timelines = Object.fromEntries(
    GDELT_BULK_TOPICS.map(({ id }) => [id, {
      tone: [],
      vol: [],
      toneFetchedAt: undefined,
      volFetchedAt: undefined,
      fetchedAt: undefined,
    }]),
  );
  for (const { topic, series, snapshot } of snapshots) {
    timelines[topic][series] = Array.isArray(snapshot?.data)
      ? snapshot.data
      : (Array.isArray(snapshot) ? snapshot : []);
    timelines[topic][`${series}FetchedAt`] = Number.isFinite(Date.parse(snapshot?.fetchedAt))
      ? snapshot.fetchedAt
      : undefined;
  }
  for (const timeline of Object.values(timelines)) {
    timeline.fetchedAt = newestFetchedAt(
      timeline.toneFetchedAt,
      timeline.volFetchedAt,
    );
  }
  return timelines;
}

function timestampFromMs(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  return new Date(value).toISOString().replace(/\D/g, '').slice(0, 14);
}

function feedCoverage({
  kind,
  downloaded,
  previousState,
  nowMs,
}) {
  const timestamps = feedTimestamps(downloaded, kind);
  const oldestTimestamp = timestamps.at(0);
  const latestTimestamp = timestamps.at(-1);
  const previousCursor = previousState?.cursor?.[kind];
  const previousCursorMs = gdeltTimestampToMs(previousCursor);
  const oldestMs = gdeltTimestampToMs(oldestTimestamp);
  const gapMs = oldestMs - previousCursorMs;
  const hasGap = Number.isFinite(previousCursorMs)
    && Number.isFinite(oldestMs)
    && gapMs > GDELT_SNAPSHOT_INTERVAL_MS;
  const previousCoverage = previousState?.coverage?.[kind];
  const legacyConflictCoverage = kind === 'export'
    ? timestampFromMs(Number(previousState?.conflict?.pagination?.rollingWindowStartedAt))
    : '';
  return {
    continuousSince: hasGap
      ? oldestTimestamp
      : (
          previousCoverage?.continuousSince
          || legacyConflictCoverage
          || previousCursor
          || oldestTimestamp
        ),
    latestTimestamp,
    lastGap: hasGap
      ? {
          previousCursor,
          resumedAt: oldestTimestamp,
          gapMs,
          detectedAt: nowMs,
        }
      : (previousCoverage?.lastGap ?? null),
  };
}

export async function fetchMaterializedGdelt(deps = {}) {
  const {
    _now = () => Date.now(),
    _readSnapshot = (key) => readSeedSnapshot(key, { strict: true }),
    _fetchFiles = fetchGdeltBulkFiles,
  } = deps;
  const nowMs = _now();
  const [previousIntel, previousState] = await Promise.all([
    _readSnapshot(GDELT_INTEL_KEY),
    _readSnapshot(GDELT_BULK_STATE_KEY),
  ]);
  const downloaded = await _fetchFiles({
    afterTimestamp: previousState?.cursor || {},
    nowMs,
  });
  validateCurrentFeedCohort(downloaded, nowMs);
  const previousTimelines = previousState
    ? previousState.timelines
    : await readLegacyTimelines(_readSnapshot);
  const currentGkgBatches = downloaded
    .filter(({ descriptor }) => descriptor.kind === 'gkg')
    .map(({ descriptor, records, csv }) => ({
      timestamp: descriptor.timestamp,
      records: records ?? parseGdeltGkgCsv(csv),
    }));
  if (currentGkgBatches.reduce((total, batch) => total + batch.records.length, 0) === 0) {
    throw new Error('GDELT bulk materializer has no usable GKG records');
  }
  const currentRecentGkgBatches = recentBatches(
    [],
    currentGkgBatches,
    nowMs,
  );
  if (currentRecentGkgBatches.length === 0) {
    throw new Error('GDELT bulk materializer has no new GKG snapshot inside the 2h freshness window');
  }
  const geoBatches = recentBatches(
    previousState?.recentGkgBatches,
    currentRecentGkgBatches,
    nowMs,
  );
  const compactedGeoBatches = compactRecentGeoBatches(geoBatches);
  const materialized = materializeGdeltBulk({
    batches: currentGkgBatches,
    geoRecords: compactedGeoBatches.flatMap((batch) => batch.records),
    previous: {
      intel: previousIntel,
      timelines: previousTimelines,
      reference: previousState?.reference,
    },
    nowMs,
  });
  if (materialized.freshTopicCount === 0) {
    throw new Error('GDELT bulk materializer has no fresh GDELT topic matches');
  }

  const exportBatches = downloaded
    .filter(({ descriptor }) => descriptor.kind === 'export')
    .map(({ descriptor, events, csv }) => ({
      timestamp: descriptor.timestamp,
      events: events ?? mapGdeltExportToConflictEvents(csv),
    }));
  const latestExport = exportBatches.map(({ timestamp }) => timestamp).sort().at(-1);
  const oldestExport = exportBatches.map(({ timestamp }) => timestamp).sort().at(0);
  const coverage = {
    gkg: feedCoverage({ kind: 'gkg', downloaded, previousState, nowMs }),
    export: feedCoverage({ kind: 'export', downloaded, previousState, nowMs }),
  };
  const conflict = exportBatches.length > 0
    ? mergeGdeltBulkRollingWindow(
        {
          events: exportBatches.flatMap(({ events }) => events),
          oldestExportTimestamp: oldestExport,
          exportTimestamp: latestExport,
        },
        previousState?.conflict,
        nowMs,
      )
    : null;
  const coverageStartedAt = gdeltTimestampToMs(coverage.export.continuousSince);
  const rollingWindowStartedAt = Number.isFinite(coverageStartedAt)
    ? Math.max(conflict?.rollingWindowStartedAt ?? coverageStartedAt, coverageStartedAt)
    : conflict?.rollingWindowStartedAt;
  const rollingWindowComplete = Number.isFinite(rollingWindowStartedAt)
    && rollingWindowStartedAt <= nowMs - GDELT_ROLLING_WINDOW_MS;
  const conflictPayload = conflict
    ? {
        events: conflict.events,
        source: 'gdelt-bulk',
        pagination: {
          exportTimestamp: latestExport,
          oldestExportTimestamp: oldestExport,
          rollingWindowStartedAt,
          rollingWindowComplete,
        },
      }
    : previousState?.conflict ?? null;
  if (!conflictPayload?.events?.length) {
    throw new Error('GDELT bulk materializer has no conflict export data');
  }

  return {
    ...materialized.intel,
    _timelines: materialized.timelines,
    _unrest: materialized.unrest,
    _positive: materialized.positive,
    _reference: materialized.reference,
    _conflict: conflictPayload,
    _state: {
      cursor: {
        gkg: downloaded
          .filter(({ descriptor }) => descriptor.kind === 'gkg')
          .map(({ descriptor }) => descriptor.timestamp)
          .sort()
          .at(-1) || previousState?.cursor?.gkg || '',
        export: downloaded
          .filter(({ descriptor }) => descriptor.kind === 'export')
          .map(({ descriptor }) => descriptor.timestamp)
          .sort()
          .at(-1) || previousState?.cursor?.export || '',
      },
      recentGkgBatches: compactedGeoBatches,
      timelines: materialized.timelines,
      reference: materialized.reference,
      conflict: conflictPayload,
      coverage,
      updatedAt: nowMs,
    },
  };
}

function publishTransform(data) {
  return {
    topics: data.topics,
    fetchedAt: data.fetchedAt,
  };
}

function validate(data) {
  return Array.isArray(data?.topics) && data.topics.length === 6;
}

export function declareRecords(data) {
  return (data?.topics ?? []).reduce(
    (total, topic) => total + (Array.isArray(topic?.articles) ? topic.articles.length : 0),
    0,
  );
}

export async function afterPublish(data, _meta, deps = {}) {
  const {
    _writeExtraKey = writeExtraKey,
    _writeExtraKeyWithMeta = writeExtraKeyWithMeta,
  } = deps;
  const outputOperations = Object.entries(data._timelines ?? {}).flatMap(
    ([topic, series]) => [
      {
        label: timelineKey('tone', topic),
        run: () => _writeExtraKey(
          timelineKey('tone', topic),
          { data: series.tone, fetchedAt: series.toneFetchedAt ?? series.fetchedAt },
          TIMELINE_TTL,
        ),
      },
      {
        label: timelineKey('vol', topic),
        run: () => _writeExtraKey(
          timelineKey('vol', topic),
          { data: series.vol, fetchedAt: series.volFetchedAt ?? series.fetchedAt },
          TIMELINE_TTL,
        ),
      },
    ],
  );
  outputOperations.push(
    {
      label: GDELT_BULK_CONFLICT_KEY,
      run: () => _writeExtraKey(GDELT_BULK_CONFLICT_KEY, data._conflict, CONFLICT_TTL),
    },
    {
      label: GDELT_BULK_UNREST_KEY,
      run: () => _writeExtraKey(GDELT_BULK_UNREST_KEY, data._unrest, UNREST_TTL),
    },
    {
      label: GDELT_BULK_ARTICLES_KEY,
      run: () => _writeExtraKey(GDELT_BULK_ARTICLES_KEY, data._reference, ARTICLES_TTL),
    },
    {
      label: POSITIVE_EVENTS_META_KEY,
      run: () => _writeExtraKeyWithMeta(
        POSITIVE_EVENTS_RPC_KEY,
        data._positive,
        POSITIVE_TTL,
        data._positive.events.length,
        POSITIVE_EVENTS_META_KEY,
      ),
    },
    {
      label: POSITIVE_EVENTS_BOOTSTRAP_KEY,
      run: () => _writeExtraKey(
        POSITIVE_EVENTS_BOOTSTRAP_KEY,
        data._positive,
        POSITIVE_TTL,
      ),
    },
  );
  const settled = await Promise.allSettled(
    outputOperations.map(({ run }) => Promise.resolve().then(run)),
  );
  const failures = settled.flatMap((result, index) => {
    if (result.status === 'rejected') return [result.reason];
    if (result.value === false) {
      return [new Error(`${outputOperations[index].label} metadata write returned false`)];
    }
    return [];
  });
  if (failures.length > 0) {
    // DEGRADE, do not throw (#5863 review). This runs AFTER atomicPublish has
    // already written the canonical key, so throwing turns an
    // already-successful publish into FATAL exit 1 — precisely the #5478
    // incident the predecessor fixed with a degrade-not-crash afterPublish.
    // The cursor is deliberately NOT advanced, so the next tick replays the
    // same static cohort idempotently, and the error status + reason land on
    // seed-meta so health alarms instead of the process crash-looping.
    const summary = failures.map((error) => error?.message || error).join('; ');
    console.warn(`  WARNING: GDELT bulk output publication incomplete (cursor held): ${summary}`);
    return {
      completionState: 'DEGRADED',
      freshnessMetaPatch: {
        status: 'error',
        errorReason: 'gdelt_bulk_outputs_incomplete',
        failedOutputs: failures.length,
      },
    };
  }
  // State is the cursor/rolling accumulator. Write it last so a partial output
  // failure replays the same static files on the next tick.
  try {
    await _writeExtraKey(GDELT_BULK_STATE_KEY, data._state, STATE_TTL);
  } catch (error) {
    // Same reasoning: a cursor write failure must not crash a run whose
    // products all landed. Holding the cursor replays the cohort next tick.
    console.warn(`  WARNING: GDELT bulk cursor write failed (cohort will replay): ${error?.message || error}`);
    return {
      completionState: 'DEGRADED',
      freshnessMetaPatch: {
        status: 'error',
        errorReason: 'gdelt_bulk_cursor_write_failed',
      },
    };
  }
  return { completionState: 'OK' };
}

export const RUN_SEED_OPTS = {
  validateFn: validate,
  ttlSeconds: INTEL_TTL,
  sourceVersion: 'gdelt-bulk-v2',
  publishTransform,
  afterPublish,
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 45,
  preserveKeyTtls: [
    ...GDELT_BULK_TOPICS.flatMap(({ id }) => [
      { key: timelineKey('tone', id), ttlSeconds: TIMELINE_TTL },
      { key: timelineKey('vol', id), ttlSeconds: TIMELINE_TTL },
    ]),
    { key: GDELT_BULK_CONFLICT_KEY, ttlSeconds: CONFLICT_TTL },
    { key: GDELT_BULK_UNREST_KEY, ttlSeconds: UNREST_TTL },
    { key: GDELT_BULK_ARTICLES_KEY, ttlSeconds: ARTICLES_TTL },
    { key: POSITIVE_EVENTS_RPC_KEY, ttlSeconds: POSITIVE_TTL },
    { key: POSITIVE_EVENTS_BOOTSTRAP_KEY, ttlSeconds: POSITIVE_TTL },
    { key: POSITIVE_EVENTS_META_KEY, ttlSeconds: TIMELINE_TTL },
    { key: GDELT_BULK_STATE_KEY, ttlSeconds: STATE_TTL },
  ],
};

if (process.argv[1]?.endsWith('seed-gdelt-bulk-materializer.mjs')) {
  runSeed(
    'intelligence',
    'gdelt-intel',
    GDELT_INTEL_KEY,
    fetchMaterializedGdelt,
    RUN_SEED_OPTS,
  ).catch((error) => {
    console.error('FATAL:', error?.message || error);
    process.exit(1);
  });
}
