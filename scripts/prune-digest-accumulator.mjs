#!/usr/bin/env node
/**
 * Bounded cleanup tool for the digest accumulator (#7082 plan section 4).
 *
 * The default dry run discovers accumulator keys with a complete cursor-based
 * SCAN and reports the pre-mutation state. Applying the cleanup is deliberately
 * stricter: every key must be supplied as a reviewed, exact --key allowlist
 * entry. Deletion is paged and can be resumed safely after a failed command.
 *
 * Run the sweep only after the forecast cutover is deployed and verified
 * (the archive must carry the evidence the accumulator is about to lose).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FORECAST_EVIDENCE_COVERAGE_KEY,
  FORECAST_EVIDENCE_MAX_LOOKBACK_MS,
  forecastEvidenceCoversWindow,
  parseForecastEvidenceCoverage,
} from './_forecast-evidence-archive.mjs';

export const RETENTION_MS = 48 * 60 * 60 * 1000;
export const SCAN_PAGE_SIZE = 100;
export const DELETE_RECORD_BATCH = 100;
export const MAX_SCAN_PAGES = 10_000;
export const MAX_DELETE_COMMANDS_PER_KEY = 2_000;

const DELETE_COMMANDS_PER_PAGE = 2; // one bounded range read, then one bounded ZREM
const ACCUMULATOR_PATTERN = 'digest:accumulator:v1:*';
const ACCUMULATOR_KEY_RE = /^digest:accumulator:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;
const USER_AGENT = 'worldmonitor-prune-digest-accumulator/1.0';

export function usage() {
  return [
    'Usage: node scripts/prune-digest-accumulator.mjs [--apply] [--key <exact-key> ...]',
    '',
    '  Dry run (default): discover keys with SCAN and report what would be pruned.',
    '  --key: inspect an exact accumulator key; repeat for more than one key.',
    '  --apply: prune only the exact accumulator keys supplied with --key.',
  ].join('\n');
}

export function parseArgs(argv) {
  const parsed = { apply: false, help: false, keys: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      parsed.apply = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--key') {
      const key = argv[index + 1];
      if (!key || key.startsWith('--')) throw new Error('--key requires an exact accumulator key');
      parsed.keys.push(key);
      index += 1;
    } else if (arg.startsWith('--key=')) {
      parsed.keys.push(arg.slice('--key='.length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.keys = [...new Set(parsed.keys)];
  for (const key of parsed.keys) assertAccumulatorKey(key);
  if (parsed.apply && parsed.keys.length === 0) {
    throw new Error('--apply requires at least one reviewed exact --key; wildcard discovery is dry-run only');
  }
  return parsed;
}

export function assertAccumulatorKey(key) {
  if (!ACCUMULATOR_KEY_RE.test(key)) {
    throw new Error(`Refusing non-accumulator or non-exact key: ${key}`);
  }
  return key;
}

export function redisConfigFromEnv(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.');
  }
  return { url, token };
}

export async function redisCommand(config, command, fetchImpl = globalThis.fetch) {
  const resp = await fetchImpl(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Redis ${command[0]} failed: HTTP ${resp.status}`);
  const payload = await resp.json();
  if (payload?.error) throw new Error(`Redis ${command[0]} failed: ${payload.error}`);
  if (!payload || !Object.hasOwn(payload, 'result')) {
    throw new Error(`Redis ${command[0]} returned no result`);
  }
  return payload.result;
}

export async function discoverAccumulatorKeys(redis) {
  const keys = new Set();
  const seenCursors = new Set();
  let cursor = '0';
  let pages = 0;

  do {
    if (pages >= MAX_SCAN_PAGES) throw new Error(`SCAN exceeded ${MAX_SCAN_PAGES} pages`);
    if (seenCursors.has(cursor)) throw new Error(`SCAN repeated cursor ${cursor}`);
    seenCursors.add(cursor);

    const result = await redis([
      'SCAN', cursor, 'MATCH', ACCUMULATOR_PATTERN, 'COUNT', String(SCAN_PAGE_SIZE),
    ]);
    if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) {
      throw new Error(`Redis SCAN returned an unexpected shape: ${JSON.stringify(result)}`);
    }

    cursor = String(result[0]);
    for (const key of result[1]) keys.add(assertAccumulatorKey(key));
    pages += 1;
  } while (cursor !== '0');

  return [...keys].sort();
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Redis ${label} returned an invalid count: ${value}`);
  }
  return number;
}

function edgeScore(result, label) {
  if (!Array.isArray(result)) throw new Error(`Redis ${label} returned an unexpected shape`);
  if (result.length === 0) return null;
  if (result.length !== 2 || !Number.isFinite(Number(result[1]))) {
    throw new Error(`Redis ${label} returned an invalid scored member`);
  }
  return Number(result[1]);
}

export async function inspectAccumulatorKey(redis, key, cutoffExclusive) {
  const cardinality = nonNegativeInteger(await redis(['ZCARD', key]), 'ZCARD');
  const oldestScore = edgeScore(await redis(['ZRANGE', key, '0', '0', 'WITHSCORES']), 'oldest ZRANGE');
  const newestScore = edgeScore(await redis(['ZRANGE', key, '-1', '-1', 'WITHSCORES']), 'newest ZRANGE');
  const wouldRemove = nonNegativeInteger(
    await redis(['ZCOUNT', key, '-inf', cutoffExclusive]),
    'ZCOUNT',
  );
  return { cardinality, oldestScore, newestScore, wouldRemove };
}

export async function requireVerifiedCutover(redis, env, observedAtMs) {
  if (env.FORECAST_EVIDENCE_CUTOVER_ENABLED !== '1') {
    throw new Error('Refusing --apply: FORECAST_EVIDENCE_CUTOVER_ENABLED must equal 1');
  }

  const rawCoverage = await redis(['GET', FORECAST_EVIDENCE_COVERAGE_KEY]);
  const coverage = parseForecastEvidenceCoverage(rawCoverage);
  if (!coverage) {
    throw new Error('Refusing --apply: forecast evidence coverage marker is missing or malformed');
  }
  const requiredStartMs = coverage.coverageEndMs - FORECAST_EVIDENCE_MAX_LOOKBACK_MS;
  if (!forecastEvidenceCoversWindow(coverage, requiredStartMs, coverage.coverageEndMs)) {
    throw new Error('Refusing --apply: forecast evidence marker does not prove the required 14-day window');
  }
  if (coverage.coverageEndMs > observedAtMs) {
    throw new Error('Refusing --apply: forecast evidence coverage end is in the future');
  }
  return coverage;
}

export async function pruneAccumulatorKey(
  redis,
  key,
  cutoffExclusive,
  expectedRemovals,
  {
    deleteRecordBatch = DELETE_RECORD_BATCH,
    maxDeleteCommands = MAX_DELETE_COMMANDS_PER_KEY,
  } = {},
) {
  if (!Number.isSafeInteger(deleteRecordBatch) || deleteRecordBatch <= 0) {
    throw new Error('Delete record batch must be a positive integer');
  }
  if (!Number.isSafeInteger(maxDeleteCommands) || maxDeleteCommands < 3) {
    throw new Error('Delete command budget must be an integer of at least 3');
  }

  // Reserve one command for the final ZCOUNT verification. Each mutation page
  // uses one bounded range read and one bounded ZREM. Large sweeps make safe,
  // resumable progress across repeated exact-key apply runs.
  const pageBudget = Math.floor((maxDeleteCommands - 1) / DELETE_COMMANDS_PER_PAGE);
  const recordBudget = pageBudget * deleteRecordBatch;
  const targetRemovals = Math.min(expectedRemovals, recordBudget);
  const targetPages = Math.ceil(targetRemovals / deleteRecordBatch);

  let removed = 0;
  let pages = 0;
  while (pages < targetPages) {
    const pageLimit = Math.min(deleteRecordBatch, targetRemovals - removed);
    const members = await redis([
      'ZRANGEBYSCORE', key, '-inf', cutoffExclusive,
      'LIMIT', '0', String(pageLimit),
    ]);
    if (!Array.isArray(members) || members.some((member) => typeof member !== 'string')) {
      throw new Error(`Redis ZRANGEBYSCORE returned an unexpected page for ${key}`);
    }
    if (members.length === 0) {
      throw new Error(`${key} changed during cleanup: an expected delete page was empty`);
    }

    const pageRemoved = nonNegativeInteger(await redis(['ZREM', key, ...members]), 'ZREM');
    if (pageRemoved !== members.length) {
      throw new Error(
        `Redis ZREM removed ${pageRemoved}/${members.length} selected members from ${key}; stopped after a partial result`,
      );
    }
    removed += pageRemoved;
    pages += 1;
  }

  const eligibleRemaining = nonNegativeInteger(
    await redis(['ZCOUNT', key, '-inf', cutoffExclusive]),
    'ZCOUNT',
  );
  if (removed !== targetRemovals) {
    throw new Error(
      `${key} cleanup verification failed: target=${targetRemovals} removed=${removed}`,
    );
  }
  return {
    removed,
    pages,
    complete: eligibleRemaining === 0,
    eligibleRemaining,
    recordBudget,
    commandBudget: maxDeleteCommands,
  };
}

function formatScore(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'n/a';
}

export async function runCleanup({
  argv = process.argv.slice(2),
  env = process.env,
  nowMs = Date.now(),
  fetchImpl = globalThis.fetch,
  log = console.log,
  deleteRecordBatch = DELETE_RECORD_BATCH,
  maxDeleteCommands = MAX_DELETE_COMMANDS_PER_KEY,
} = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    log(usage());
    return { mode: 'help', keys: [] };
  }
  if (!Number.isFinite(nowMs)) throw new Error('Cleanup clock must be finite');

  const config = redisConfigFromEnv(env);
  const redis = (command) => redisCommand(config, command, fetchImpl);
  const coverage = parsed.apply ? await requireVerifiedCutover(redis, env, nowMs) : null;
  const referenceClockMs = coverage?.coverageEndMs ?? nowMs;
  const cutoff = referenceClockMs - RETENTION_MS;
  const cutoffExclusive = `(${cutoff}`;
  const mode = parsed.apply ? 'APPLY' : 'DRY-RUN';
  log(
    `[prune-digest-accumulator] mode=${mode} observedAt=${new Date(nowMs).toISOString()} `
    + `referenceClock=${new Date(referenceClockMs).toISOString()} cutoff=${new Date(cutoff).toISOString()}`,
  );
  if (coverage) {
    log(
      `[prune-digest-accumulator] coverageProof=${FORECAST_EVIDENCE_COVERAGE_KEY} `
      + `window=${new Date(coverage.coverageStartMs).toISOString()}..${new Date(coverage.coverageEndMs).toISOString()} `
      + `verifiedAt=${new Date(coverage.cutoverVerifiedAtMs).toISOString()}`,
    );
  }

  const keys = parsed.keys.length > 0 ? parsed.keys.slice().sort() : await discoverAccumulatorKeys(redis);
  if (keys.length === 0) {
    log('[prune-digest-accumulator] no accumulator keys found; nothing to do.');
    return { mode, keys: [] };
  }

  const results = [];
  for (const key of keys) {
    const before = await inspectAccumulatorKey(redis, key, cutoffExclusive);
    log(
      `  ${key}: cardinality=${before.cardinality} oldest=${formatScore(before.oldestScore)} `
      + `newest=${formatScore(before.newestScore)} wouldRemove=${before.wouldRemove}`,
    );

    if (!parsed.apply) {
      results.push({ key, before, removed: 0, pages: 0 });
      continue;
    }

    const applied = await pruneAccumulatorKey(redis, key, cutoffExclusive, before.wouldRemove, {
      deleteRecordBatch,
      maxDeleteCommands,
    });
    const after = await inspectAccumulatorKey(redis, key, cutoffExclusive);
    log(
      `    applied: removed=${applied.removed} pages=${applied.pages} `
      + `remaining=${after.cardinality} eligibleRemaining=${applied.eligibleRemaining} `
      + `complete=${applied.complete}`,
    );
    results.push({ key, before, ...applied, after });
  }

  if (!parsed.apply) {
    log('[prune-digest-accumulator] dry-run complete; pass reviewed exact --key values with --apply to mutate.');
  }
  return {
    mode,
    observedAtMs: nowMs,
    referenceClockMs,
    cutoff,
    coverage,
    keys,
    results,
  };
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  runCleanup().catch((err) => {
    console.error(`[prune-digest-accumulator] failed: ${err?.message || err}`);
    process.exitCode = 1;
  });
}
