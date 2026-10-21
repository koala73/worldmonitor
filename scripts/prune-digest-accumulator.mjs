#!/usr/bin/env node
/**
 * Bounded cleanup tool for the digest accumulator (#7082 plan section 4).
 *
 * The default dry run discovers accumulator keys with a complete cursor-based
 * SCAN and reports the pre-mutation state. Applying the cleanup is deliberately
 * stricter: every key must be supplied as a reviewed, exact --key allowlist
 * entry. Deletion is paged and can be resumed safely after a failed command.
 *
 * --apply needs FORECAST_EVIDENCE_CUTOVER_ENABLED=1, the same operator switch
 * that lets digest publication prune digest:accumulator:v1:full:en. It no
 * longer needs a backfill-certified coverage marker: forecast judging stopped
 * reading the accumulator in #8995 and reads only the evidence archive, which
 * this tool never touches (#7082, owner decision 2026-10-08). Retention stays
 * sized to the widest live accumulator reader (ACCUMULATOR_RETENTION_MS).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACCUMULATOR_RETENTION_MS } from './_forecast-evidence-archive.mjs';

/** Shared with the online prune in list-feed-digest.ts — see ACCUMULATOR_RETENTION_MS. */
export const RETENTION_MS = ACCUMULATOR_RETENTION_MS;
export const SCAN_PAGE_SIZE = 100;
export const DELETE_RECORD_BATCH = 100;
export const MAX_SCAN_PAGES = 10_000;
export const MAX_DELETE_COMMANDS_PER_KEY = 2_000;

const DELETE_COMMANDS_PER_PAGE = 1; // one EVAL of PRUNE_PAGE_SCRIPT
/**
 * Selects and removes one bounded page in a single atomic script, so a member
 * is only ever removed while its CURRENT score is below the cutoff. A separate
 * range read then ZREM by member could delete a story that a publication
 * re-ZADDed (fresh score) between the two calls.
 */
export const PRUNE_PAGE_SCRIPT = [
  "local members = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))",
  'if #members == 0 then return 0 end',
  "return redis.call('ZREM', KEYS[1], unpack(members))",
].join('\n');
const ACCUMULATOR_PATTERN = 'digest:accumulator:v1:*';
const ACCUMULATOR_KEY_RE = /^digest:accumulator:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;
const USER_AGENT = 'worldmonitor-prune-digest-accumulator/1.0';

export function usage() {
  return [
    'Usage: node scripts/prune-digest-accumulator.mjs [--apply] [--key <exact-key> ...] [--json]',
    '',
    '  Dry run (default): discover keys with SCAN and report what would be pruned.',
    '  --key: inspect an exact accumulator key; repeat for more than one key.',
    '  --apply: prune only the exact accumulator keys supplied with --key.',
    '  --json: emit the machine-readable report on stdout (prose log goes to stderr).',
    '',
    'Environment:',
    '  UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  required, always.',
    '  FORECAST_EVIDENCE_CUTOVER_ENABLED=1                required for --apply.',
    '',
    'Exit codes: 0 ok/nothing to do, 1 unexpected failure, 2 bad usage, 3 refused by the',
    'cutover gate (flag unset).',
  ].join('\n');
}

export function parseArgs(argv) {
  const parsed = { apply: false, help: false, json: false, keys: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      parsed.apply = true;
    } else if (arg === '--json') {
      parsed.json = true;
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

/**
 * The cutoff is derived from Redis's own clock: the digest publication that
 * writes the scores runs on Vercel, and a fast operator laptop clock would
 * otherwise move the cutoff forward and delete members inside retention.
 */
export async function readRedisClockMs(redis) {
  const result = await redis(['TIME']);
  if (!Array.isArray(result) || result.length !== 2) {
    throw new Error(`Redis TIME returned an unexpected shape: ${JSON.stringify(result)}`);
  }
  const seconds = Number(result[0]);
  const micros = Number(result[1]);
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(micros) || seconds <= 0 || micros < 0) {
    throw new Error(`Redis TIME returned an invalid clock: ${JSON.stringify(result)}`);
  }
  return seconds * 1000 + Math.floor(micros / 1000);
}

export function requireCutoverFlag(env) {
  if (env.FORECAST_EVIDENCE_CUTOVER_ENABLED !== '1') {
    throw new Error('Refusing --apply: FORECAST_EVIDENCE_CUTOVER_ENABLED must equal 1');
  }
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
  if (!Number.isSafeInteger(maxDeleteCommands) || maxDeleteCommands < 2) {
    throw new Error('Delete command budget must be an integer of at least 2');
  }

  // Reserve one command for the final ZCOUNT verification. Each mutation page
  // is one atomic EVAL. Large sweeps make safe, resumable progress across
  // repeated exact-key apply runs.
  const pageBudget = Math.floor((maxDeleteCommands - 1) / DELETE_COMMANDS_PER_PAGE);
  const recordBudget = pageBudget * deleteRecordBatch;
  const targetRemovals = Math.min(expectedRemovals, recordBudget);
  const targetPages = Math.ceil(targetRemovals / deleteRecordBatch);

  let removed = 0;
  let pages = 0;
  let convergedEarly = false;
  while (pages < targetPages) {
    const pageLimit = Math.min(deleteRecordBatch, targetRemovals - removed);
    const pageRemoved = nonNegativeInteger(
      await redis(['EVAL', PRUNE_PAGE_SCRIPT, '1', key, cutoffExclusive, String(pageLimit)]),
      'EVAL prune page',
    );
    if (pageRemoved > pageLimit) {
      throw new Error(`Redis prune page removed ${pageRemoved} members from ${key}, above the ${pageLimit} limit`);
    }
    if (pageRemoved < pageLimit) {
      // The live digest publication prunes the same key on every build, so a
      // short or empty page usually means it got there first — a converged
      // sweep, not a corrupted one. Re-measure before deciding: only a short
      // page while eligible members remain is a real inconsistency.
      const remaining = nonNegativeInteger(
        await redis(['ZCOUNT', key, '-inf', cutoffExclusive]),
        'ZCOUNT',
      );
      if (remaining > 0) {
        throw new Error(
          `${key} changed during cleanup: a delete page removed ${pageRemoved}/${pageLimit} with ${remaining} still eligible`,
        );
      }
      removed += pageRemoved;
      if (pageRemoved > 0) pages += 1;
      convergedEarly = true;
      break;
    }

    removed += pageRemoved;
    pages += 1;
  }

  const eligibleRemaining = nonNegativeInteger(
    await redis(['ZCOUNT', key, '-inf', cutoffExclusive]),
    'ZCOUNT',
  );
  // convergedEarly means a concurrent publication prune already removed the
  // tail and we re-measured zero eligible members — removing fewer than the
  // pre-scan target is the correct outcome there, not a failed verification.
  if (removed !== targetRemovals && !convergedEarly) {
    throw new Error(
      `${key} cleanup verification failed: target=${targetRemovals} removed=${removed}`,
    );
  }
  return {
    removed,
    pages,
    complete: eligibleRemaining === 0,
    eligibleRemaining,
    convergedEarly,
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
  // Dry-run evaluates the same gate and reports its verdict, so "would --apply
  // run?" is answerable without risking a mutation.
  let cutoverReady = false;
  let cutoverBlockedReason = null;
  try {
    requireCutoverFlag(env);
    cutoverReady = true;
  } catch (err) {
    if (parsed.apply) throw err;
    cutoverBlockedReason = err?.message || String(err);
  }
  const redisTimeMs = await readRedisClockMs(redis);
  const clockSkewMs = nowMs - redisTimeMs;
  const cutoff = redisTimeMs - RETENTION_MS;
  const cutoffExclusive = `(${cutoff}`;
  const mode = parsed.apply ? 'APPLY' : 'DRY-RUN';
  log(
    `[prune-digest-accumulator] mode=${mode} observedAt=${new Date(nowMs).toISOString()} `
    + `redisTime=${new Date(redisTimeMs).toISOString()} clockSkewMs=${clockSkewMs} `
    + `cutoff=${new Date(cutoff).toISOString()} `
    + `retentionHours=${Math.round(RETENTION_MS / 3_600_000)} cutoverReady=${cutoverReady}`,
  );
  if (cutoverBlockedReason) {
    log(`[prune-digest-accumulator] cutover NOT ready: ${cutoverBlockedReason}`);
  }

  const keys = parsed.keys.length > 0 ? parsed.keys.slice().sort() : await discoverAccumulatorKeys(redis);
  if (keys.length === 0) {
    log('[prune-digest-accumulator] no accumulator keys found; nothing to do.');
    return {
      mode, json: parsed.json, observedAtMs: nowMs, redisTimeMs, clockSkewMs, cutoff,
      retentionMs: RETENTION_MS, cutoverReady, cutoverBlockedReason,
      keys: [], results: [],
    };
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
    json: parsed.json,
    observedAtMs: nowMs,
    redisTimeMs,
    clockSkewMs,
    cutoff,
    retentionMs: RETENTION_MS,
    cutoverReady,
    cutoverBlockedReason,
    keys,
    results,
  };
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

/**
 * Exit codes are part of the tool's contract: an operator (or an agent)
 * sequencing the cutover must be able to tell "refused by the gate" from
 * "crashed" without scraping prose off stderr.
 */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_CUTOVER_REFUSED = 3;

if (isDirectExecution) {
  // With --json the machine-readable report owns stdout and the prose log is
  // routed to stderr, so `... --json | jq` works.
  const wantsJson = process.argv.slice(2).includes('--json');
  runCleanup(wantsJson ? { log: (...args) => console.error(...args) } : {})
    .then((report) => {
      if (wantsJson) console.log(JSON.stringify(report, null, 2));
    })
    .catch((err) => {
      const message = err?.message || String(err);
      console.error(`[prune-digest-accumulator] failed: ${message}`);
      if (wantsJson) console.log(JSON.stringify({ mode: 'FAILED', error: message }, null, 2));
      if (/^Refusing --apply:/.test(message)) process.exitCode = EXIT_CUTOVER_REFUSED;
      else if (/^(Unknown argument|--key requires|--apply requires|Refusing non-accumulator)/.test(message)) process.exitCode = EXIT_USAGE;
      else process.exitCode = EXIT_FAILED;
    });
}
