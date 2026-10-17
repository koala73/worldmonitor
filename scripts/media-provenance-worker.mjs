#!/usr/bin/env node
// @ts-check
/**
 * Media provenance worker (#9096): always-on Railway service.
 *
 * Pulls media checks from Redis (BLMOVE), downloads the file with SSRF guards,
 * reads its C2PA content credentials, looks up the earliest copies TinEye has
 * seen (within a monthly spend cap), and writes the result for the API to
 * serve. Submitted files are kept in R2 for 30 days, then deleted.
 *
 * Deployed from Dockerfile.media-provenance-worker: the C2PA reader is a
 * native addon built for glibc.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getRedisCredentials, loadEnvFile } from './_seed-utils.mjs';
import { deleteR2Object, putR2BinaryObject, resolveR2StorageConfig } from './_r2-storage.mjs';
import {
  MEDIA_CAVEATS,
  MEDIA_JOB_ID_RE,
  MEDIA_OWNER_TOKEN_RE,
  MEDIA_PROCESSING_KEY,
  MEDIA_QUEUE_KEY,
  MEDIA_RESULT_TTL_SECONDS,
  MEDIA_RETENTION_DAYS,
  MEDIA_STORAGE_PREFIX,
  MEDIA_STORED_INDEX_KEY,
  mediaOwnerKey,
  mediaResultKey,
} from './shared/media-provenance-contract.js';
import {
  MediaCheckError,
  fetchMedia,
  findEarliestCopies,
  readCredentials,
  searchTinEye,
  strippedSearchBytes,
  tineyeLimits,
} from './lib/media-provenance.mjs';

loadEnvFile(import.meta.url);

const RETENTION_MS = MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
/** A claimed job holds a lease this long; only a job whose lease lapsed is reclaimed. */
const JOB_LEASE_SECONDS = 10 * 60;
/** A check with no result after this long is reported as failed and its claim released, so a hung parser never holds a job. */
export const JOB_TIME_LIMIT_MS = 4 * 60 * 1000;
/** A job that took its worker down this many times is reported as failed instead of re-queued again. */
export const JOB_MAX_RECOVERIES = 2;
/** A file whose delete failed is retried this long after, so it never blocks later files. */
const DELETE_RETRY_MS = 60 * 60 * 1000;

export function mediaRecoveriesKey(jobId) {
  return `media-provenance:recoveries:${jobId}`;
}

export function mediaLeaseKey(jobId) {
  return `media-provenance:lease:${jobId}`;
}

/** The R2 key of a submitted file: one object per job, so a sweep never deletes another job's upload. */
export function mediaStorageKey(sha256, jobId) {
  return `${MEDIA_STORAGE_PREFIX}/${sha256}/${jobId.replace(/:/g, '-')}`;
}
const IDLE_SLEEP_MS = 3_000;

let shuttingDown = false;
process.on('SIGTERM', () => { shuttingDown = true; });

/** One Redis command over Upstash REST. */
export async function redisCmd(cmd, args) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([String(cmd).toUpperCase(), ...args]),
    signal: AbortSignal.timeout(40_000),
  });
  if (!resp.ok) throw new Error(`Redis ${cmd} HTTP ${resp.status}`);
  const body = /** @type {{ result?: unknown; error?: string }} */ (await resp.json());
  if (body.error) throw new Error(`Redis ${cmd}: ${body.error}`);
  return body.result;
}

/** C2PA trust anchors (PEM), from the environment or a mounted file. */
async function loadTrustAnchors(env = process.env) {
  if (env.C2PA_TRUST_ANCHORS_PEM) return env.C2PA_TRUST_ANCHORS_PEM;
  if (env.C2PA_TRUST_ANCHORS_FILE) {
    const { readFile } = await import('node:fs/promises');
    return readFile(env.C2PA_TRUST_ANCHORS_FILE, 'utf8').catch(() => '');
  }
  return '';
}

/** (assetPath, mimeType) => manifest store | null, using @contentauth/c2pa-node. */
async function createReaderFactory(trustAnchors) {
  const { Reader, Context } = await import('@contentauth/c2pa-node');
  const context = trustAnchors
    ? new Context({ verify: { verifyTrust: true }, trust: { trustAnchors } })
    : undefined;
  return async (path, mimeType) => {
    const reader = await Reader.fromAsset({ path, mimeType }, context);
    return reader ? reader.json() : null;
  };
}

/**
 * Run one check. Dependencies are injected so tests run it without network,
 * native addons or storage.
 */
export async function runMediaCheck(job, deps) {
  const fetched = await deps.fetchMedia(job.url);
  const fetchedAt = new Date(deps.now()).toISOString();
  // Storing the original does not change the result: run it alongside the check.
  const stored = Promise.resolve()
    .then(() => deps.storeOriginal(fetched, job.jobId))
    .catch((error) => {
      console.warn('[media-provenance] storing the file failed:', error?.message ?? error);
    });

  const dir = await mkdtemp(join(tmpdir(), 'media-provenance-'));
  let credentials;
  try {
    const assetPath = join(dir, 'asset');
    await writeFile(assetPath, fetched.bytes, { mode: 0o600 });
    credentials = await readCredentials(assetPath, fetched.mediaType, deps.readerFactory, { trustListConfigured: deps.trustListConfigured });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const earliest = await findEarliestCopies({
    sha256: fetched.sha256,
    mediaType: fetched.mediaType,
    searchBytes: () => deps.strippedSearchBytes(fetched.bytes, fetched.mediaType),
    apiKey: deps.tineyeApiKey,
    redisCmd: deps.redisCmd,
    searchTinEye: deps.searchTinEye,
    limits: deps.limits,
    now: deps.now(),
    cacheTtlSeconds: Math.round(RETENTION_MS / 1000),
  });

  await stored;
  return {
    url: job.url,
    mediaType: fetched.mediaType,
    bytes: fetched.bytes.length,
    sha256: fetched.sha256,
    fetchedAt,
    credentials,
    earliest,
    caveats: [...MEDIA_CAVEATS],
  };
}

/**
 * Delete stored files older than the retention period. A failed delete is
 * pushed back an hour, so it cannot hold up the files behind it.
 */
export async function sweepExpiredMedia({ redisCmd: cmd, deleteObject, now = Date.now() }) {
  const expired = await cmd('zrangebyscore', [MEDIA_STORED_INDEX_KEY, '-inf', now - RETENTION_MS, 'LIMIT', 0, 200]);
  let deleted = 0;
  for (const key of Array.isArray(expired) ? expired : []) {
    if (typeof key !== 'string' || !key.startsWith(`${MEDIA_STORAGE_PREFIX}/`)) continue;
    try {
      await deleteObject(key);
      await cmd('zrem', [MEDIA_STORED_INDEX_KEY, key]);
      deleted += 1;
    } catch (error) {
      console.warn('[media-provenance] retention delete failed:', key, error?.message ?? error);
      // Retry it in an hour, behind the files that are due now.
      await cmd('zadd', [MEDIA_STORED_INDEX_KEY, now - RETENTION_MS + DELETE_RETRY_MS, key]).catch(() => null);
    }
  }
  return deleted;
}

/**
 * Put back on the queue every claimed job whose lease has lapsed: its worker
 * crashed or lost its final write. A live worker's job keeps its lease and is
 * left alone; LREM decides which of two recovering workers re-queues a job.
 */
export async function recoverAbandonedJobs(cmd, { settleMs = 5_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const leaseless = async () => {
    const claimed = await cmd('lrange', [MEDIA_PROCESSING_KEY, 0, -1]);
    const found = [];
    for (const raw of Array.isArray(claimed) ? claimed : []) {
      const job = parseJob(raw);
      if (!job) {
        await cmd('lrem', [MEDIA_PROCESSING_KEY, 1, String(raw)]);
        continue;
      }
      if (Number(await cmd('exists', [mediaLeaseKey(job.jobId)])) === 0) found.push({ raw: String(raw), job });
    }
    return found;
  };
  // A worker claims with BLMOVE, then sets the lease: a blocking move cannot
  // run inside a script. Look twice, a few seconds apart, so a job caught in
  // that gap is never taken from a live worker.
  if ((await leaseless()).length === 0) return 0;
  await sleep(settleMs);
  let recovered = 0;
  for (const { raw, job } of await leaseless()) {
    // One script: the job leaves processing only if it goes back on the queue,
    // and only while its lease is still absent.
    const failed = JSON.stringify({ status: 'failed', error: 'The check stopped unexpectedly. Try a different link to the same file.', failedAt: Date.now() });
    const outcome = Number(await cmd('eval', [
      REQUEUE_SCRIPT, 5,
      MEDIA_PROCESSING_KEY, MEDIA_QUEUE_KEY, mediaLeaseKey(job.jobId), mediaRecoveriesKey(job.jobId), mediaResultKey(job.owner, job.jobId),
      raw, JOB_MAX_RECOVERIES, failed, MEDIA_RESULT_TTL_SECONDS,
    ]));
    if (outcome === 1) recovered += 1;
  }
  return recovered;
}

/**
 * Re-queue a claimed job whose lease is gone, in one step. A job recovered
 * more than ARGV[2] times keeps taking its worker down (a file that crashes a
 * parser): it is finished as failed instead of being run again.
 */
const REQUEUE_SCRIPT = `if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
if redis.call('LREM', KEYS[1], 1, ARGV[1]) ~= 1 then return 0 end
local n = redis.call('INCR', KEYS[4])
redis.call('EXPIRE', KEYS[4], ARGV[4])
if n > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[5], ARGV[3], 'EX', ARGV[4])
  return 2
end
redis.call('LPUSH', KEYS[2], ARGV[1])
return 1`;

/** Extend a lease only while this claim still holds it. */
const REFRESH_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return 0`;

/**
 * Save a final status, release the claim and drop the lease in one step, and
 * only while this claim still holds the lease: a worker whose job was
 * recovered and re-run elsewhere cannot overwrite that run's result.
 */
const FINALIZE_SCRIPT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('LREM', KEYS[3], 1, ARGV[4])
redis.call('DEL', KEYS[1])
return 1`;

export async function claimJobLease(cmd, jobId, token) {
  await cmd('set', [mediaLeaseKey(jobId), token, 'EX', JOB_LEASE_SECONDS]);
}

export async function refreshJobLease(cmd, jobId, token) {
  return Number(await cmd('eval', [REFRESH_SCRIPT, 1, mediaLeaseKey(jobId), token, JOB_LEASE_SECONDS])) === 1;
}

/** True when the status was saved and the claim released; false when this claim no longer holds the lease. */
export async function finalizeJob(cmd, { jobId, token, resultKey, payload, raw }) {
  const saved = await cmd('eval', [FINALIZE_SCRIPT, 3, mediaLeaseKey(jobId), resultKey, MEDIA_PROCESSING_KEY, token, JSON.stringify(payload), MEDIA_RESULT_TTL_SECONDS, String(raw)]);
  return Number(saved) === 1;
}

/** Settle with the check, or fail it once the time limit passes (a hung parser is left behind). */
export function withTimeLimit(work, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new MediaCheckError('The check took too long.', 'timeout')), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

function parseJob(raw) {
  try {
    const job = JSON.parse(String(raw));
    if (!job || typeof job.url !== 'string' || !MEDIA_JOB_ID_RE.test(job.jobId) || !MEDIA_OWNER_TOKEN_RE.test(job.owner)) return null;
    return job;
  } catch {
    return null;
  }
}

async function runWorker() {
  console.log(`[media-provenance] starting — listening on ${MEDIA_QUEUE_KEY}`);
  const trustAnchors = await loadTrustAnchors();
  const readerFactory = await createReaderFactory(trustAnchors);
  const { default: sharp } = await import('sharp');
  const r2 = resolveR2StorageConfig(process.env, { bucketEnv: 'CLOUDFLARE_R2_MEDIA_BUCKET' });
  if (!r2) console.warn('[media-provenance] R2 is not configured: submitted files are not stored');
  if (!process.env.TINEYE_API_KEY) console.warn('[media-provenance] TINEYE_API_KEY is not set: earliest-copy searches report not-configured');

  // Record the deletion date first: a file is never stored without one.
  const storeOriginal = async (fetched, jobId) => {
    if (!r2) return;
    const key = mediaStorageKey(fetched.sha256, jobId);
    await redisCmd('zadd', [MEDIA_STORED_INDEX_KEY, Date.now(), key]);
    await putR2BinaryObject(r2, key, fetched.bytes, fetched.mediaType);
  };

  let lastSweep = 0;
  while (!shuttingDown) {
    if (Date.now() - lastSweep > SWEEP_INTERVAL_MS) {
      lastSweep = Date.now();
      await recoverAbandonedJobs(redisCmd).catch((error) => {
        console.warn('[media-provenance] job recovery failed:', error?.message ?? error);
      });
      if (r2) {
        await sweepExpiredMedia({ redisCmd, deleteObject: (key) => deleteR2Object(r2, key) }).catch((error) => {
          console.warn('[media-provenance] retention sweep failed:', error?.message ?? error);
        });
      }
    }

    let raw;
    try {
      raw = await redisCmd('blmove', [MEDIA_QUEUE_KEY, MEDIA_PROCESSING_KEY, 'LEFT', 'RIGHT', 30]);
    } catch (error) {
      console.error('[media-provenance] BLMOVE error:', error?.message ?? error);
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    if (!raw) {
      await new Promise((r) => setTimeout(r, IDLE_SLEEP_MS));
      continue;
    }

    const job = parseJob(raw);
    if (!job) {
      console.error('[media-provenance] discarding an invalid job');
      await redisCmd('lrem', [MEDIA_PROCESSING_KEY, 1, String(raw)]).catch(() => null);
      continue;
    }
    const resultKey = mediaResultKey(job.owner, job.jobId);
    // A job whose owner binding expired can no longer be read by anyone: drop it.
    if (Number(await redisCmd('exists', [mediaOwnerKey(job.jobId)]).catch(() => 1)) === 0) {
      await redisCmd('lrem', [MEDIA_PROCESSING_KEY, 1, String(raw)]).catch(() => null);
      continue;
    }
    const token = randomUUID();
    const leased = await claimJobLease(redisCmd, job.jobId, token).then(() => true, () => false);
    if (!leased) {
      // Without a lease the result could not be saved; leave the job claimed for recovery.
      console.warn(`[media-provenance] ${job.jobId}: lease not set; left for recovery`);
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    // Keep the lease alive while the check runs, so recovery never takes a live job.
    const heartbeat = setInterval(() => {
      refreshJobLease(redisCmd, job.jobId, token).catch(() => null);
    }, (JOB_LEASE_SECONDS * 1000) / 3);
    let payload;
    try {
      const result = await withTimeLimit(runMediaCheck(job, {
        fetchMedia,
        storeOriginal,
        readerFactory,
        trustListConfigured: Boolean(trustAnchors),
        strippedSearchBytes: (bytes, type) => strippedSearchBytes(bytes, type, sharp),
        searchTinEye,
        tineyeApiKey: process.env.TINEYE_API_KEY ?? '',
        limits: tineyeLimits(),
        redisCmd,
        now: () => Date.now(),
      }), JOB_TIME_LIMIT_MS);
      payload = { status: 'done', result, completedAt: Date.now() };
      console.log(`[media-provenance] ${job.jobId} done (${result.mediaType}, credentials=${result.credentials.state}, earliest=${result.earliest.state})`);
    } catch (error) {
      const message = error instanceof MediaCheckError ? error.message : 'The check could not be completed.';
      if (!(error instanceof MediaCheckError)) console.error(`[media-provenance] ${job.jobId} failed:`, error?.message ?? error);
      payload = { status: 'failed', error: message, failedAt: Date.now() };
    } finally {
      clearInterval(heartbeat);
    }
    // The status, the claim and the lease change together. If the write fails,
    // the job stays claimed; its lease lapses and recovery runs it again.
    const saved = await finalizeJob(redisCmd, { jobId: job.jobId, token, resultKey, payload, raw }).catch(() => false);
    if (!saved) console.warn(`[media-provenance] ${job.jobId}: final status not saved; left for recovery`);
  }
  console.log('[media-provenance] shutdown complete');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runWorker().catch((error) => {
    console.error('[media-provenance] fatal:', error);
    process.exit(1);
  });
}
