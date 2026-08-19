#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnvFile, GRACEFUL_FETCH_FAILURE_EXIT_CODE } from './_seed-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BATCH_SIZE = 500;
const R2_BUCKET_URL = 'https://api.cloudflare.com/client/v4/accounts/{acct}/r2/buckets/worldmonitor-data/objects/seed-data/military-bases-final.json';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const PROGRESS_INTERVAL = 5000;
// Window between publishing a new version and deleting the superseded one, so a
// reader that resolved `military:bases:active` just before the switch can still
// GET the old geo/meta keys.
//
// 30s, not 300s (#6806). This wait runs INSIDE the bundle section's slot but
// AFTER `atomicSwitch` has already made the new version live, so every second of
// it is budget the section reserves to do nothing. At 5 minutes it was 55% of
// the 540s reservation, which is what made `Military-Bases` need 565s of
// `seed-bundle-static-ref`'s 570s budget and starve every other due section.
// The window it actually has to cover is one in-flight HTTP request, which is
// seconds; 30s is an order of magnitude over that.
export const GRACE_PERIOD_MS = 30 * 1000;
// Self-healing TTLs for version keys, so a run that dies before its own
// cleanup leaves nothing behind permanently (#6845). The runner SIGTERMs a
// section at `timeoutMs` and SIGKILLs 10s later; a death before
// `atomicSwitch` leaves `military:bases:{geo,meta}:<version>` written with no
// TTL, and `cleanupOldVersion` only ever names the keys of the version that
// is *currently active* — a version that never published (or was superseded
// by a run killed inside the grace window) is swept by nothing, ever.
//
//   VERSION_KEY_TTL_SECONDS is armed on every seed batch, so it stays
//   refreshed for as long as the run is alive and only counts down once the
//   run is gone. `atomicSwitch` PERSISTs both keys inside the same EVAL that
//   publishes, so a live version can never expire out from under readers.
//   30 minutes is ~3x the section's 540s slot including the R2-cold worst
//   case: generous enough that a slow-but-alive run never loses its own data,
//   short enough that a leaked 125k-member zset + hash is gone within the
//   hour.
//
//   SUPERSEDED_KEY_TTL_SECONDS covers the superseded version's keys between
//   `atomicSwitch` and the post-grace DELs. The publish EVAL arms that TTL in
//   the same atomic operation that moves `active`, so a kill immediately after
//   publication still leaves the displaced pair self-healing.
export const VERSION_KEY_TTL_SECONDS = 30 * 60;
export const SUPERSEDED_KEY_TTL_SECONDS = 5 * (GRACE_PERIOD_MS / 1000);
const DAY_MS = 24 * 60 * 60 * 1000;
// Mirrors Military-Bases' `intervalMs` in seed-bundle-static-ref.mjs. The
// seeder owns the "is the published data already stale" verdict because it is
// the only party that knows the no-data fallback restored data it could not
// refresh (#6845): without this, that fallback restores the active version's
// own timestamp and exits green every day while the data ages forever — due
// again next tick, indistinguishable from progress.
export const SECTION_INTERVAL_MS = 30 * DAY_MS;
const VALIDATION_BATCH_SIZE = 500;
const USER_AGENT = 'worldmonitor-military-bases-seeder/1.0';

const PUBLISH_ACTIVE_AND_META_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[3] then
  return {0, current or ''}
end
redis.call('PERSIST', KEYS[3])
redis.call('PERSIST', KEYS[4])
if current and current ~= ARGV[1] then
  redis.call('EXPIRE', KEYS[5], ARGV[4])
  redis.call('EXPIRE', KEYS[6], ARGV[4])
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return {1, ARGV[1], current or ''}
`.trim();

const ARM_LEAKED_KEY_IF_INACTIVE_SCRIPT = `
local active = redis.call('GET', KEYS[1])
if active == ARGV[1] then
  return {0, 'active', active}
end
local ttl = redis.call('TTL', KEYS[2])
if ttl ~= -1 then
  return {0, 'ttl', tostring(ttl)}
end
local armed = redis.call('EXPIRE', KEYS[2], ARGV[2])
return {armed, 'armed', active or ''}
`.trim();

const ARM_STAGING_KEY_TTL_IF_INACTIVE_SCRIPT = `
local active = redis.call('GET', KEYS[1])
if active == ARGV[1] then
  return 0
end
return redis.call('EXPIRE', KEYS[2], ARGV[2])
`.trim();

const BACKFILL_META_IF_ACTIVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then
  return {0, current or ''}
end
redis.call('SET', KEYS[2], ARGV[2])
return {1, current}
`.trim();

export function parseArgs() {
  const args = process.argv.slice(2);
  let env = 'production';
  let sha = '';
  // Bypass the missing-seed-meta repair short-circuit and reseed unconditionally.
  // Without this an operator who runs the seeder by hand while the freshness
  // marker is absent gets the cheap repair instead of the reseed they asked for.
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' && args[i + 1]) {
      env = args[++i];
    } else if (args[i] === '--sha' && args[i + 1]) {
      sha = args[++i];
    } else if (args[i].startsWith('--env=')) {
      env = args[i].split('=')[1];
    } else if (args[i].startsWith('--sha=')) {
      sha = args[i].split('=')[1];
    } else if (args[i] === '--force' || args[i] === '--force=true') {
      force = true;
    } else if (args[i].startsWith('--force=')) {
      // `--env=`/`--sha=` accept the `=` form, so an operator reaching for
      // `--force=1` must not silently get the repair path instead of the reseed
      // they asked for. Anything other than an explicit false-y value enables it.
      force = !['false', '0', 'no'].includes(args[i].split('=')[1].toLowerCase());
    }
  }

  const valid = ['production', 'preview', 'development'];
  if (!valid.includes(env)) {
    console.error(`Invalid --env "${env}". Must be one of: ${valid.join(', ')}`);
    process.exit(1);
  }

  if ((env === 'preview' || env === 'development') && !sha) {
    sha = 'dev';
  }

  return { env, sha, force };
}

function getKeyPrefix(env, sha) {
  if (env === 'production') return '';
  return `${env}:${sha}:`;
}

function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

async function redisRequest(url, token, path, body, label, attempt = 1) {
  const resp = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
      console.warn(`  ${label} failed (HTTP ${resp.status}), retry ${attempt}/${MAX_RETRIES} in ${delay}ms...`);
      await sleep(delay);
      return redisRequest(url, token, path, body, label, attempt + 1);
    }
    throw new Error(`${label} failed after ${MAX_RETRIES} attempts: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }

  try {
    return await resp.json();
  } catch (err) {
    throw new Error(`${label} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function commandFailure(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'invalid response cell';
  if (result.error != null) return String(result.error);
  if (!Object.hasOwn(result, 'result')) return 'missing result field';
  if (result.result === 'ERR') return 'ERR';
  return null;
}

async function pipelineRequest(url, token, commands) {
  const results = await redisRequest(url, token, '/pipeline', commands, 'Pipeline');
  if (!Array.isArray(results) || results.length !== commands.length) {
    throw new Error(`Pipeline returned ${Array.isArray(results) ? results.length : 'an invalid response'} for ${commands.length} commands`);
  }

  for (let i = 0; i < results.length; i++) {
    const failure = commandFailure(results[i]);
    if (failure) {
      throw new Error(`Pipeline command ${i + 1}/${commands.length} ${commands[i]?.[0] || 'UNKNOWN'} failed: ${failure}`);
    }
  }
  return results;
}

async function commandRequest(url, token, command) {
  const response = await redisRequest(url, token, '/', command, 'Redis command');
  const failure = commandFailure(response);
  if (failure) {
    throw new Error(`Redis command ${command[0] || 'UNKNOWN'} failed: ${failure}`);
  }
  return response.result;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function stagingTtlCommand(versionKey, kind) {
  const marker = `military:bases:${kind}:`;
  const markerIndex = versionKey.lastIndexOf(marker);
  const candidateVersion = markerIndex === -1
    ? ''
    : versionKey.slice(markerIndex + marker.length);
  if (!candidateVersion) {
    throw new Error(`Cannot derive the ${kind} staging version from key "${versionKey}"`);
  }
  const prefix = versionKey.slice(0, markerIndex);
  return [
    'EVAL',
    ARM_STAGING_KEY_TTL_IF_INACTIVE_SCRIPT,
    '2',
    `${prefix}military:bases:active`,
    versionKey,
    candidateVersion,
    String(VERSION_KEY_TTL_SECONDS),
  ];
}

export async function seedGeo(url, token, geoKey, entries) {
  let seeded = 0;
  const total = entries.length;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const commands = [
      ...batch.map(e => ['GEOADD', geoKey, String(e.lon), String(e.lat), e.id]),
      // Refresh the self-healing TTL while this version is still staging.
      // Same-millisecond runs can share version keys, so the active check and
      // EXPIRE must be one Redis operation: once either run publishes this
      // version, a slower batch must not restore the TTL that publish removed.
      stagingTtlCommand(geoKey, 'geo'),
    ];
    await pipelineRequest(url, token, commands);
    seeded += batch.length;

    if (seeded % PROGRESS_INTERVAL === 0 || seeded === total) {
      console.log(`  GEO: ${seeded.toLocaleString()} / ${total.toLocaleString()}`);
    }
  }

  return seeded;
}

export async function seedMeta(url, token, metaKey, entries) {
  let seeded = 0;
  const total = entries.length;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const commands = [
      ...batch.map(e => {
        const meta = { ...e };
        delete meta.id;
        return ['HSET', metaKey, e.id, JSON.stringify(meta)];
      }),
      stagingTtlCommand(metaKey, 'meta'),
    ];
    await pipelineRequest(url, token, commands);
    seeded += batch.length;

    if (seeded % PROGRESS_INTERVAL === 0 || seeded === total) {
      console.log(`  META: ${seeded.toLocaleString()} / ${total.toLocaleString()}`);
    }
  }

  return seeded;
}

/**
 * @param {{ deep?: boolean }} [opts] `deep: false` stops after the ZCARD/HLEN
 *   agreement check and skips the per-member walk. The walk costs one round
 *   trip per 500 records (~250 for the current corpus), which is affordable
 *   once per real reseed but not for the cheap seed-meta repair path, which has
 *   to finish inside a section slot that no longer reserves ten minutes (#6806).
 */
async function validate(url, token, prefix, version, expectedCount, opts = {}) {
  const { deep = true } = opts;
  const geoKey = `${prefix}military:bases:geo:${version}`;
  const metaKey = `${prefix}military:bases:meta:${version}`;

  console.log('\nValidating seeded data...');

  const [zcardResult, hlenResult] = await pipelineRequest(url, token, [
    ['ZCARD', geoKey],
    ['HLEN', metaKey],
  ]);

  const geoCount = Number(zcardResult.result);
  const metaCount = Number(hlenResult.result);

  console.log(`  ZCARD ${geoKey} = ${geoCount} (expected >= ${expectedCount})`);
  console.log(`  HLEN  ${metaKey} = ${metaCount} (expected == ZCARD)`);

  if (!Number.isSafeInteger(geoCount) || geoCount < expectedCount) {
    throw new Error(`GEO count ${geoCount} < expected ${expectedCount}`);
  }

  if (!Number.isSafeInteger(metaCount) || metaCount !== geoCount) {
    throw new Error(`META count ${metaCount} != GEO count ${geoCount}`);
  }

  if (!deep) {
    console.log(`  Shallow check only — ZCARD == HLEN == ${geoCount}; per-member walk skipped.`);
    return geoCount;
  }

  let validatedCount = 0;
  for (let offset = 0; offset < geoCount; offset += VALIDATION_BATCH_SIZE) {
    const end = Math.min(offset + VALIDATION_BATCH_SIZE, geoCount) - 1;
    const membersResult = await pipelineRequest(url, token, [
      ['ZRANGE', geoKey, String(offset), String(end)],
    ]);
    const memberIds = membersResult[0].result;
    const expectedBatchSize = end - offset + 1;
    if (!Array.isArray(memberIds) || memberIds.length !== expectedBatchSize) {
      throw new Error(`ZRANGE returned ${Array.isArray(memberIds) ? memberIds.length : 'an invalid response'} members for range ${offset}-${end}`);
    }

    const hmgetResult = await pipelineRequest(url, token, [
      ['HMGET', metaKey, ...memberIds],
    ]);
    const values = hmgetResult[0].result;
    if (!Array.isArray(values) || values.length !== memberIds.length) {
      throw new Error(`HMGET returned ${Array.isArray(values) ? values.length : 'an invalid response'} values for ${memberIds.length} members`);
    }

    for (let i = 0; i < values.length; i++) {
      if (!values[i]) {
        throw new Error(`ID "${memberIds[i]}" missing from META hash`);
      }
      try {
        JSON.parse(values[i]);
      } catch {
        throw new Error(`ID "${memberIds[i]}" has invalid JSON in META hash`);
      }
    }
    validatedCount += memberIds.length;
  }

  const [finalZcardResult, finalHlenResult] = await pipelineRequest(url, token, [
    ['ZCARD', geoKey],
    ['HLEN', metaKey],
  ]);
  if (Number(finalZcardResult.result) !== geoCount || Number(finalHlenResult.result) !== metaCount) {
    throw new Error('GEO or META counts changed during validation');
  }

  console.log(`  Validated ${validatedCount}/${geoCount} entries — all present with valid JSON`);
  console.log('  Validation passed.');
  return geoCount;
}

// `durationMs` is the measured seed+validate wall time. It is published rather
// than only logged because this seeder runs as a Railway cron section: its
// stdout is not retrievable after the fact, so the seed-meta record is the only
// durable measurement available to size the section's `timeoutMs` against real
// runtime instead of a worst-case guess (#6806).
function buildSeedMetaPayload(version, recordCount, fetchedAt, durationMs) {
  return JSON.stringify({
    fetchedAt,
    recordCount,
    sourceVersion: String(version),
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
  });
}

export async function atomicSwitch(
  url,
  token,
  prefix,
  version,
  recordCount,
  fetchedAt = Date.now(),
  durationMs = undefined,
  expectedActiveVersion = null,
) {
  const activeKey = `${prefix}military:bases:active`;
  const seedMetaKey = `${prefix}seed-meta:military:bases`;
  // PERSISTed inside the same EVAL that publishes, so the self-healing TTL
  // armed during seeding is dropped atomically with the version going live —
  // a published version can never expire, and an unpublished one always can
  // (#6845).
  const geoKey = `${prefix}military:bases:geo:${version}`;
  const metaKey = `${prefix}military:bases:meta:${version}`;
  const expectedActive = expectedActiveVersion == null ? '' : String(expectedActiveVersion);
  // Pass every touched key through KEYS rather than hiding key construction
  // inside Lua. The CAS proves that these old keys name the version displaced
  // by this exact publish.
  const oldGeoKey = expectedActive
    ? `${prefix}military:bases:geo:${expectedActive}`
    : geoKey;
  const oldMetaKey = expectedActive
    ? `${prefix}military:bases:meta:${expectedActive}`
    : metaKey;
  const publishResult = await commandRequest(url, token, [
    'EVAL',
    PUBLISH_ACTIVE_AND_META_SCRIPT,
    '6',
    activeKey,
    seedMetaKey,
    geoKey,
    metaKey,
    oldGeoKey,
    oldMetaKey,
    String(version),
    buildSeedMetaPayload(version, recordCount, fetchedAt, durationMs),
    expectedActive,
    String(SUPERSEDED_KEY_TTL_SECONDS),
  ]);

  if (!Array.isArray(publishResult)) {
    throw new Error('Atomic switch returned an unexpected response');
  }
  if (Number(publishResult[0]) !== 1) {
    const current = publishResult[1] == null || publishResult[1] === ''
      ? 'missing'
      : String(publishResult[1]);
    throw new Error(
      `Active version changed before publish (${expectedActive || 'missing'} -> ${current})`,
    );
  }
  if (String(publishResult[1]) !== String(version)) {
    throw new Error(`Atomic switch returned unexpected version "${publishResult[1]}"`);
  }

  const displacedVersion = String(publishResult[2] || '');
  if (displacedVersion !== expectedActive) {
    throw new Error(
      `Atomic switch returned unexpected displaced version "${displacedVersion || 'missing'}"`,
    );
  }
  console.log(`\nAtomic switch: SET ${activeKey} = ${version}`);
  console.log(`Freshness meta: SET ${seedMetaKey}`);
  if (!displacedVersion || displacedVersion === String(version)) return null;
  return {
    oldVersion: displacedVersion,
    oldGeoKey: `${prefix}military:bases:geo:${displacedVersion}`,
    oldMetaKey: `${prefix}military:bases:meta:${displacedVersion}`,
  };
}

/**
 * Re-arm a TTL on version keys left behind by earlier runs (#6845). Leaks
 * from before the TTL mechanism have no TTL and no sweeper: a version key is
 * treated as leaked only when it has NO ttl and does not belong to the active
 * version — live seeding runs arm a TTL on every batch, and the active
 * version's keys are PERSISTed inside the publish EVAL, so neither can match.
 *
 * The sweep never DELs directly: a per-candidate EVAL reads the current active
 * version, checks TTL == -1, and arms the superseded TTL as one operation.
 * A concurrent publish either wins first (so the candidate is skipped) or
 * wins second and PERSISTs its newly active pair.
 */
export async function sweepLeakedVersionKeys(url, token, prefix) {
  const activeKey = `${prefix}military:bases:active`;

  for (const kind of ['geo', 'meta']) {
    const keyPrefix = `${prefix}military:bases:${kind}:`;
    let cursor = '0';
    do {
      const scanResult = await commandRequest(url, token, [
        'SCAN',
        cursor,
        'MATCH',
        `${prefix}military:bases:${kind}:*`,
        'COUNT',
        '100',
      ]);
      if (!Array.isArray(scanResult) || scanResult.length !== 2) {
        throw new Error(`SCAN for ${kind} version keys returned an unexpected shape`);
      }
      cursor = String(scanResult[0]);
      const keys = Array.isArray(scanResult[1]) ? scanResult[1] : [];
      for (const key of keys) {
        const candidateKey = String(key);
        if (!candidateKey.startsWith(keyPrefix)) continue;
        const candidateVersion = candidateKey.slice(keyPrefix.length);
        if (!candidateVersion) continue;
        const armResult = await commandRequest(url, token, [
          'EVAL',
          ARM_LEAKED_KEY_IF_INACTIVE_SCRIPT,
          '2',
          activeKey,
          candidateKey,
          candidateVersion,
          String(SUPERSEDED_KEY_TTL_SECONDS),
        ]);
        if (!Array.isArray(armResult) || ![0, 1].includes(Number(armResult[0]))) {
          throw new Error(`TTL sweep for ${candidateKey} returned an unexpected response`);
        }
        if (Number(armResult[0]) === 1) {
          console.log(`  Re-arming TTL on leaked version key (no TTL, not active): ${candidateKey}`);
        }
      }
    } while (cursor !== '0');
  }
}

/**
 * Rebuild `seed-meta:military:bases` from whatever `military:bases:active`
 * already points at, without reseeding.
 *
 * That key is the section's ONLY freshness signal — it declares no
 * `canonicalKey`, so `_bundle-runner.mjs` falls through to the legacy
 * `seed-meta:<key>` read. While it is absent the runner sees "never seeded" and
 * marks the section due on EVERY daily tick instead of every 30 days, which is
 * what turned an occasionally-expensive section into a permanently-due one
 * (#6806).
 *
 * @param {{ deep?: boolean }} [opts] `deep: false` trusts ZCARD/HLEN agreement
 *   instead of walking every member. Use it for the repair path, where the
 *   published data is already live and the goal is to restore the marker
 *   cheaply rather than to re-audit a corpus that has not changed.
 */
export async function backfillSeedMetaFromActiveVersion(url, token, prefix, opts = {}) {
  const { deep = true } = opts;
  const activeKey = `${prefix}military:bases:active`;
  const activeResult = await pipelineRequest(url, token, [['GET', activeKey]]);
  const rawVersion = activeResult[0]?.result;
  if (rawVersion == null || rawVersion === '') {
    throw new Error('Data file not found locally or on R2, and no existing active version in Redis');
  }

  const version = String(rawVersion);
  const fetchedAt = Number(version);
  if (!/^\d+$/.test(version) || !Number.isSafeInteger(fetchedAt) || fetchedAt <= 0) {
    throw new Error(`Active version "${version}" is not a valid millisecond timestamp`);
  }

  const recordCount = await validate(url, token, prefix, version, 1, { deep });

  const seedMetaKey = `${prefix}seed-meta:military:bases`;
  const writeResult = await commandRequest(url, token, [
    'EVAL',
    BACKFILL_META_IF_ACTIVE_SCRIPT,
    '2',
    activeKey,
    seedMetaKey,
    version,
    buildSeedMetaPayload(version, recordCount, fetchedAt),
  ]);
  if (!Array.isArray(writeResult) || Number(writeResult[0]) !== 1) {
    const currentVersion = Array.isArray(writeResult) ? writeResult[1] : null;
    throw new Error(`Active version changed during validation (${version} -> ${currentVersion || 'missing'})`);
  }
  // Deliberately does not name a reason: there are two callers (no data file to
  // seed from, and the #6806 missing-marker repair) and each logs its own before
  // calling. Naming one here mislabels the other in the Railway log.
  console.log(`Restored ${seedMetaKey} from active version ${version} (${recordCount.toLocaleString()} records).`);
  return { version, fetchedAt, recordCount };
}


function isRedisTransportError(err) {
  if (!(err instanceof Error)) return false;
  const message = err.message;
  return (
    message.startsWith('Redis command ')
    || message.startsWith('Pipeline ')
    || message.includes(' failed after ')
  );
}

function isActiveVersionCasConflict(err) {
  return err instanceof Error && err.message.startsWith('Active version changed during validation');
}

/**
 * Cheap missing-marker repair. Returns `repaired` only when seed-meta was
 * rewritten from a live active version; every other action means `main()`
 * should continue into the file/R2 reseed path.
 *
 * A validate/data-shape failure on the published pointer must not abort the
 * section: that used to fall through to a rewrite, and exiting 1 here would
 * leave seed-meta absent so every later tick retries the same dead repair.
 * A compare-and-swap miss means another writer already published — rethrow.
 * Redis transport errors also rethrow; a 1,000-round-trip reseed would fail
 * the same way.
 */
export async function maybeRepairMissingSeedMeta(url, token, prefix, { force = false } = {}) {
  if (force) return { action: 'skipped-force' };

  const seedMetaKey = `${prefix}seed-meta:military:bases`;
  const existingSeedMeta = await commandRequest(url, token, ['GET', seedMetaKey]);
  if (existingSeedMeta != null && existingSeedMeta !== '') {
    return { action: 'skipped-present' };
  }

  const activeVersion = await commandRequest(url, token, [
    'GET',
    `${prefix}military:bases:active`,
  ]);
  if (!activeVersion) {
    return { action: 'fallthrough-no-active' };
  }

  console.log(`${seedMetaKey} is missing while an active version (${activeVersion}) is published.`);
  console.log('Restoring the freshness marker without reseeding...');
  try {
    const repaired = await backfillSeedMetaFromActiveVersion(url, token, prefix, { deep: false });
    return { action: 'repaired', ...repaired };
  } catch (err) {
    if (isActiveVersionCasConflict(err) || isRedisTransportError(err)) throw err;
    console.warn(
      `Shallow repair failed (${err instanceof Error ? err.message : err}); falling through to reseed.`,
    );
    return { action: 'fallthrough-invalid-active' };
  }
}

async function cleanupOldVersion(url, token, prefix, newVersion) {
  const activeKey = `${prefix}military:bases:active`;
  const getResult = await pipelineRequest(url, token, [['GET', activeKey]]);
  const currentActive = getResult[0].result;

  if (!currentActive || String(currentActive) === String(newVersion)) return null;

  const oldVersion = currentActive;
  const oldGeoKey = `${prefix}military:bases:geo:${oldVersion}`;
  const oldMetaKey = `${prefix}military:bases:meta:${oldVersion}`;

  return { oldVersion, oldGeoKey, oldMetaKey };
}

async function main() {
  loadEnvFile(import.meta.url);

  const { env, sha, force } = parseArgs();
  const prefix = getKeyPrefix(env, sha);

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl) {
    console.error('Missing UPSTASH_REDIS_REST_URL. Set it in .env.local or as an env var.');
    process.exit(1);
  }
  if (!redisToken) {
    console.error('Missing UPSTASH_REDIS_REST_TOKEN. Set it in .env.local or as an env var.');
    process.exit(1);
  }

  // Everything from here on bills against the bundle section's slot, so this is
  // where the published `durationMs` has to start. Measuring only the write loop
  // would omit the R2 download (up to 60s), the JSON.parse of ~125k entries and
  // the post-publish grace — and the whole point of publishing the number is to
  // size `timeoutMs` in seed-bundle-static-ref.mjs against it (#6806).
  const runStartedAt = Date.now();

  // Missing seed-meta with a live active version: restore the marker and stop.
  // `--force`, a present marker, no active pointer, or a broken active corpus
  // all fall through to the file/R2 reseed. A successful repair costs at most
  // one tick if the restored timestamp is already past the 30-day interval.
  const repair = await maybeRepairMissingSeedMeta(redisUrl, redisToken, prefix, { force });
  if (repair.action === 'repaired') {
    return;
  }

  // Collect version keys leaked by pre-TTL runs (#6845). Best-effort: a
  // transport failure here must not take the section down with it — the next
  // run sweeps again.
  try {
    await sweepLeakedVersionKeys(redisUrl, redisToken, prefix);
  } catch (err) {
    console.warn(`Version-key sweep skipped: ${err instanceof Error ? err.message : err}`);
  }

  const volumePath = '/data/military-bases-final.json';
  const localPath = join(__dirname, 'data', 'military-bases-final.json');
  let dataPath = existsSync(volumePath) ? volumePath : existsSync(localPath) ? localPath : null;

  if (!dataPath) {
    const cfToken = process.env.CLOUDFLARE_R2_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '';
    const cfAccountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID || '';
    if (cfToken && cfAccountId) {
      console.log('  Local file not found — downloading from R2...');
      try {
        const r2Url = R2_BUCKET_URL.replace('{acct}', cfAccountId);
        const resp = await fetch(r2Url, {
          headers: { Authorization: `Bearer ${cfToken}` },
          signal: AbortSignal.timeout(60_000),
        });
        if (resp.ok) {
          const body = await resp.text();
          mkdirSync(join(__dirname, 'data'), { recursive: true });
          writeFileSync(localPath, body);
          dataPath = localPath;
          console.log(`  Downloaded ${(body.length / 1024 / 1024).toFixed(1)}MB from R2`);
        } else {
          console.log(`  R2 download failed: HTTP ${resp.status}`);
        }
      } catch (err) {
        console.log(`  R2 download failed: ${err.message}`);
      }
    } else if (cfToken) {
      console.log('  R2 download skipped: missing CLOUDFLARE_R2_ACCOUNT_ID');
    }
  }

  if (!dataPath) {
    console.log('No data file found locally or on R2 — falling back to the published active version.');
    // Shallow on purpose (#6845): the corpus was validated when it was
    // published, no new data arrived, and re-walking all ~125k members costs
    // ~250 round trips — every day, proving nothing about freshness.
    const backfilled = await backfillSeedMetaFromActiveVersion(redisUrl, redisToken, prefix, { deep: false });
    const ageMs = Date.now() - backfilled.fetchedAt;
    if (ageMs > SECTION_INTERVAL_MS) {
      console.warn(
        `  Published data is ${Math.floor(ageMs / DAY_MS)}d old — past the `
          + `${Math.round(SECTION_INTERVAL_MS / DAY_MS)}d interval, and this fallback could not `
          + `refresh it. Exiting ${GRACEFUL_FETCH_FAILURE_EXIT_CODE} so this tick is `
          + 'distinguishable from progress instead of exiting green forever (#6845).',
      );
      // exitCode rather than process.exit(): the keep-alive sockets behind the
      // Redis REST client need to drain, and tearing them down synchronously
      // trips libuv assertions on some platforms.
      process.exitCode = GRACEFUL_FETCH_FAILURE_EXIT_CODE;
      return;
    }
    return;
  }

  const raw = readFileSync(dataPath, 'utf8');
  const entries = JSON.parse(raw);

  if (!Array.isArray(entries) || entries.length === 0) {
    console.error('Data file is empty or not a JSON array.');
    process.exit(1);
  }

  const invalid = entries.filter(e => !e.id || e.lat == null || e.lon == null);
  if (invalid.length > 0) {
    console.error(`Found ${invalid.length} entries missing id/lat/lon. First: ${JSON.stringify(invalid[0])}`);
    process.exit(1);
  }

  const version = Date.now();
  const geoKey = `${prefix}military:bases:geo:${version}`;
  const metaKey = `${prefix}military:bases:meta:${version}`;

  console.log('=== Military Bases Seed ===');
  console.log(`  Environment:  ${env}`);
  console.log(`  Prefix:       ${prefix || '(none — production)'}`);
  console.log(`  Redis URL:    ${redisUrl}`);
  console.log(`  Redis Token:  ${maskToken(redisToken)}`);
  console.log(`  Data file:    ${dataPath}`);
  console.log(`  Entries:      ${entries.length.toLocaleString()}`);
  console.log(`  Version:      ${version}`);
  console.log(`  GEO key:      ${geoKey}`);
  console.log(`  META key:     ${metaKey}`);
  console.log(`  Batch size:   ${BATCH_SIZE}`);
  console.log();

  const oldInfo = await cleanupOldVersion(redisUrl, redisToken, prefix, version);
  if (oldInfo) {
    console.log(`Previous version detected: ${oldInfo.oldVersion}`);
    console.log(`  Will clean up after grace period: ${oldInfo.oldGeoKey}, ${oldInfo.oldMetaKey}`);
  }

  console.log('Seeding GEO entries...');
  const t0 = Date.now();
  const geoSeeded = await seedGeo(redisUrl, redisToken, geoKey, entries);

  console.log('\nSeeding META entries...');
  const metaSeeded = await seedMeta(redisUrl, redisToken, metaKey, entries);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\nSeeding complete in ${elapsed}s — GEO: ${geoSeeded.toLocaleString()}, META: ${metaSeeded.toLocaleString()}`);

  await validate(redisUrl, redisToken, prefix, version, entries.length);

  // Measured from `runStartedAt`, not `t0`: the per-member walk is roughly half
  // the round trips and data acquisition can add another minute, so a duration
  // scoped to the write loop would under-report the slot requirement it exists
  // to size. Still excludes the grace below — the config comment adds it back
  // rather than this number pretending to be the whole slot (#6806).
  const durationMs = Date.now() - runStartedAt;
  const supersededInfo = await atomicSwitch(
    redisUrl,
    redisToken,
    prefix,
    version,
    entries.length,
    Date.now(),
    durationMs,
    oldInfo?.oldVersion ?? null,
  );

  if (supersededInfo) {
    console.log(`\nScheduling cleanup of old version ${supersededInfo.oldVersion} in ${GRACE_PERIOD_MS / 1000}s...`);
    await sleep(GRACE_PERIOD_MS);
    console.log(`Cleaning up old keys: ${supersededInfo.oldGeoKey}, ${supersededInfo.oldMetaKey}`);
    await pipelineRequest(redisUrl, redisToken, [
      ['DEL', supersededInfo.oldGeoKey],
      ['DEL', supersededInfo.oldMetaKey],
    ]);
    console.log('Old version cleaned up.');
  }

  console.log('\n=== Done ===');
  console.log(`  Active version: ${version}`);
  console.log(`  GEO key:        ${geoKey}`);
  console.log(`  META key:       ${metaKey}`);
  console.log(`  Total entries:  ${entries.length.toLocaleString()}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(err => {
    console.error('\nFATAL:', err.message || err);
    process.exit(1);
  });
}
