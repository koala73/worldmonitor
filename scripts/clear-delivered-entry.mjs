#!/usr/bin/env node
/**
 * Operator one-shot: clear one or more `digest:sent:v1:*` rows.
 *
 * Pairs with the writer at `scripts/lib/digest-delivered-log.mjs` per
 * the coding-convention rule from `skill_new_blocking_state_without_
 * matching_clear_primitive`: every halt-able state needs an audited
 * unhalt path. Without this primitive, an operator who needs to
 * un-suppress a story (cooldown evaluator falsely flagged a real
 * follow-up event as a re-air, classifier mis-tagged something as
 * Analysis with a 7d floor, etc.) would have to either wait out the
 * 30d TTL or hand-curl Upstash — neither is auditable.
 *
 * USAGE
 *
 *   node scripts/clear-delivered-entry.mjs \
 *     --user user_abc \
 *     --slot 2026-05-06-0800 \
 *     --cluster sha256-deadbeef \
 *     [--channel email] \
 *     [--rule full:en:high] \
 *     --reason "false-suppress: classifier mis-tagged USNI op-ed as Analysis"
 *
 * Required: --user, --slot, --cluster, --reason. Refuses to run on
 * missing reason — there's NO unsafe shortcut. The slot is consumed
 * for log-line context only (it's not part of the key); operators
 * carry it from the parity log line they were investigating.
 *
 * Without --channel and --rule the script SCANs for every row matching
 * `digest:sent:v1:${user}:*:*:${cluster}` and deletes each. With both,
 * it targets one specific row. With one but not the other → error.
 *
 * RETURN CODES
 *
 *   0  — operation completed (deletions or no-op both green; the
 *        no-op case is logged with the matched-zero counter).
 *   1  — argument validation failure (missing required flag, mis-paired
 *        --channel/--rule, no UPSTASH creds in env).
 *   2  — Upstash transport failure (SCAN/DEL HTTP non-2xx, fetch
 *        threw). Signals operator to retry, not "nothing matched".
 *
 * AUDIT TRAIL
 *
 *   Every deletion logs a single line:
 *     [clear-delivered-entry] DELETED key=<key> reason="<reason>" at=<ISO>
 *   The Railway log retention covers the audit window. No separate
 *   audit file: stdout-only keeps the script self-contained.
 */

import { defaultRedisPipeline } from './lib/_upstash-pipeline.mjs';
import { ALLOWED_CHANNELS } from './lib/digest-delivered-log.mjs';

const KEY_PREFIX = 'digest:sent:v1';

/** Tagged exit codes — kept terse so an exit-trap operator script can
 * map them without parsing stderr. */
const EXIT_OK = 0;
const EXIT_ARG = 1;
const EXIT_TRANSPORT = 2;

/**
 * Hand-rolled flag parser. We avoid commander/yargs to keep this script
 * importable from `Dockerfile.digest-notifications` without adding a
 * runtime dep. Pattern: `--flag value` only — no `--flag=value`, no
 * shorthands, no positional args. Anything unrecognised is rejected
 * loudly so a typo can't silently fall through to "no --reason".
 *
 * @param {string[]} argv — process.argv.slice(2)
 * @returns {{ kind: 'ok', args: Record<string,string> } | { kind: 'err', message: string }}
 */
// Codex PR #3617 P1 — Redis SCAN glob-injection guard.
//
// The sweep-mode scan pattern at buildScanPattern is
// `digest:sent:v1:${user}:*:*:${cluster}`. If user OR cluster contains
// Redis glob metacharacters (* ? [ ] \), the pattern broadens beyond
// the intended single-user-single-cluster scope. `--cluster '*'` would
// match every key in the prefix; `--user 'foo*'` would match every
// cluster for every user starting with `foo`. The followup DEL loop
// would then wipe far more rows than the operator intended.
//
// Codex PR #3617 P2 follow-up — the guard is SWEEP-MODE-ONLY. In
// exact-DEL mode (both --channel AND --rule supplied), the DEL is
// against a single literal key — Redis treats DEL arguments as exact
// strings, not patterns. Legitimate clusterIds can be the level-3
// fallback `url:${sourceUrl}` from `shared/brief-filter.js:300` and
// real URLs commonly contain `?` (query strings). Rejecting glob chars
// in exact-DEL mode would make those rows unrecoverable via this
// primitive.
//
// Implementation: sweep-mode guard runs in validateScanFlags() AFTER
// args are gathered (we know mode at that point). parseArgs only
// rejects the universally-illegal cases (empty, missing required).
const REDIS_GLOB_CHARS = /[*?[\]\\]/;
const SCAN_KEY_FLAGS = new Set(['user', 'cluster']);

export function parseArgs(argv) {
  const allowedFlags = new Set(['--user', '--slot', '--cluster', '--channel', '--rule', '--reason']);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowedFlags.has(flag)) {
      return { kind: 'err', message: `unknown flag: ${JSON.stringify(flag)} (allowed: ${[...allowedFlags].join(' ')})` };
    }
    const value = argv[i + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      return { kind: 'err', message: `flag ${flag} requires a non-empty value` };
    }
    args[flag.slice(2)] = value;
    i++;
  }

  // Required arg gate. The reason check is a hard contract — see module
  // docblock + skill_new_blocking_state_without_matching_clear_primitive.
  for (const required of ['user', 'slot', 'cluster', 'reason']) {
    if (!args[required]) {
      return { kind: 'err', message: `missing required flag: --${required}` };
    }
  }
  // Channel + rule must be paired (both or neither). One alone is
  // ambiguous: it would either skip the SCAN (not what the operator
  // wanted if they only specified --channel) or produce a malformed key.
  const hasChannel = typeof args.channel === 'string';
  const hasRule = typeof args.rule === 'string';
  if (hasChannel !== hasRule) {
    return { kind: 'err', message: `--channel and --rule must be specified together (or neither — sweep all rows for {user,cluster})` };
  }
  if (hasChannel && !ALLOWED_CHANNELS.has(args.channel)) {
    return { kind: 'err', message: `--channel must be one of ${[...ALLOWED_CHANNELS].join(',')}; got ${JSON.stringify(args.channel)}` };
  }
  // Codex PR #3617 P2 — glob-char guard is sweep-mode-only.
  // Sweep mode = no --channel + no --rule (we'll SCAN with a wildcard
  // pattern). Exact-DEL mode = both supplied (we DEL a literal key, so
  // Redis treats glob chars as plain bytes). The guard catches the
  // sweep case where injection would broaden the SCAN pattern.
  const isSweepMode = !hasChannel && !hasRule;
  if (isSweepMode) {
    for (const flagName of SCAN_KEY_FLAGS) {
      const value = args[flagName];
      if (typeof value === 'string' && REDIS_GLOB_CHARS.test(value)) {
        return {
          kind: 'err',
          message: `--${flagName} value contains a Redis glob metacharacter (*, ?, [, ], or \\) ` +
            `in sweep mode (no --channel/--rule). These would broaden the SCAN pattern beyond ` +
            `a single user-cluster scope and delete unrelated keys. Got: ${JSON.stringify(value)}. ` +
            `If the cluster ID legitimately contains glob chars (e.g. a url:* fallback), use ` +
            `exact-DEL mode by also passing --channel and --rule.`,
        };
      }
    }
  }
  return { kind: 'ok', args };
}

/**
 * Build the SCAN match pattern for the sweep mode (no --channel/--rule).
 *
 * Result: `digest:sent:v1:${user}:*:*:${cluster}` — narrow to ONE user
 * + ONE cluster with channel/rule wildcards. We don't sweep across
 * users or clusters from this primitive — that'd be too easy to
 * accidentally invoke.
 */
export function buildScanPattern(userId, clusterId) {
  return `${KEY_PREFIX}:${userId}:*:*:${clusterId}`;
}

/**
 * Single-key shape (paired --channel + --rule).
 */
export function buildSingleKey(userId, channel, ruleId, clusterId) {
  return `${KEY_PREFIX}:${userId}:${channel}:${ruleId}:${clusterId}`;
}

/**
 * Walk Upstash SCAN cursor. Returns every key that matches `pattern`.
 * Bounded by `maxKeys` as a defensive cap — a single user-cluster
 * shouldn't have more than 5 channel rows, but if a future schema bug
 * leaks bad keys we don't want one operator command to delete 100k
 * unrelated rows.
 *
 * @param {string} pattern
 * @param {{ url: string, token: string }} creds
 * @param {number} [maxKeys=200]
 * @returns {Promise<{ kind: 'ok', keys: string[] } | { kind: 'transport-error', message: string }>}
 */
async function scanKeys(pattern, creds, maxKeys = 200) {
  const keys = new Set();
  let cursor = '0';
  let iterations = 0;
  do {
    let resp;
    try {
      resp = await fetch(`${creds.url}/scan/${encodeURIComponent(cursor)}/match/${encodeURIComponent(pattern)}/count/100`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.token}`,
          'User-Agent': 'worldmonitor-clear-delivered/1.0',
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { kind: 'transport-error', message: `SCAN fetch threw: ${err?.message ?? err}` };
    }
    if (!resp.ok) {
      return { kind: 'transport-error', message: `SCAN HTTP ${resp.status}` };
    }
    const json = await resp.json();
    const result = Array.isArray(json?.result) ? json.result : [];
    cursor = String(result[0] ?? '0');
    const batch = Array.isArray(result[1]) ? result[1] : [];
    for (const k of batch) {
      if (typeof k === 'string') keys.add(k);
      if (keys.size >= maxKeys) {
        return { kind: 'ok', keys: [...keys] };
      }
    }
    iterations++;
    if (iterations > 50) {
      // Defensive — Upstash SCAN cursor on a 200-key cap should never
      // need 50+ iterations. Bail loudly so a buggy cursor loop
      // doesn't hang the operator.
      return { kind: 'transport-error', message: 'SCAN exceeded 50 iterations' };
    }
  } while (cursor !== '0');
  return { kind: 'ok', keys: [...keys] };
}

/**
 * Pure orchestration entrypoint — separated from `main` so the test
 * suite can drive it without process.exit. Returns a result code +
 * structured counts.
 *
 * @param {object} args
 * @param {{ user: string, slot: string, cluster: string, channel?: string, rule?: string, reason: string }} args.parsed
 * @param {object} args.deps
 * @param {(pattern: string) => Promise<{ kind: 'ok', keys: string[] } | { kind: 'transport-error', message: string }>} args.deps.scan
 * @param {typeof defaultRedisPipeline} args.deps.redisPipeline
 * @param {(line: string) => void} [args.deps.log=console.log]
 * @param {(line: string) => void} [args.deps.warn=console.warn]
 * @returns {Promise<{ code: number, deleted: number, ineligible: string[] }>}
 */
export async function runClear({ parsed, deps }) {
  const log = deps?.log ?? ((line) => console.log(line));
  const warn = deps?.warn ?? ((line) => console.warn(line));
  const pipeline = deps?.redisPipeline ?? defaultRedisPipeline;

  const { user, slot, cluster, channel, rule, reason } = parsed;

  // Resolve the target key set.
  let targetKeys;
  if (channel && rule) {
    targetKeys = [buildSingleKey(user, channel, rule, cluster)];
  } else {
    const scanResult = await deps.scan(buildScanPattern(user, cluster));
    if (scanResult.kind === 'transport-error') {
      warn(`[clear-delivered-entry] SCAN failed: ${scanResult.message}`);
      return { code: EXIT_TRANSPORT, deleted: 0, ineligible: [] };
    }
    targetKeys = scanResult.keys;
  }

  if (targetKeys.length === 0) {
    log(`[clear-delivered-entry] no matching keys for user=${user} cluster=${cluster} (slot=${slot}) — nothing to do`);
    return { code: EXIT_OK, deleted: 0, ineligible: [] };
  }

  // DEL each key individually so we can report per-key success/no-op.
  // DEL returns 1 for "key existed and was deleted", 0 for "key missing
  // already" (TTL expired, prior DEL by another operator, key never
  // existed). 0 isn't an error — it's "ineligible", reported separately.
  const cmds = targetKeys.map((key) => ['DEL', key]);
  const result = await pipeline(cmds);
  if (result == null || !Array.isArray(result)) {
    warn(`[clear-delivered-entry] DEL pipeline returned null — Upstash transport failure`);
    return { code: EXIT_TRANSPORT, deleted: 0, ineligible: [] };
  }

  const at = new Date().toISOString();
  const ineligible = [];
  let deleted = 0;
  for (let i = 0; i < targetKeys.length; i++) {
    const key = targetKeys[i];
    const cell = result[i];
    if (cell && typeof cell === 'object' && 'error' in cell) {
      warn(`[clear-delivered-entry] DEL key=${key} → upstream error: ${cell.error}`);
      continue;
    }
    const n = Number(cell?.result ?? 0);
    if (n >= 1) {
      log(`[clear-delivered-entry] DELETED key=${key} reason=${JSON.stringify(reason)} at=${at}`);
      deleted++;
    } else {
      ineligible.push(key);
    }
  }
  if (ineligible.length > 0) {
    log(`[clear-delivered-entry] ineligible_keys=${ineligible.length} (already expired or never present): ${ineligible.join(', ')}`);
  }
  log(`[clear-delivered-entry] summary user=${user} cluster=${cluster} slot=${slot} deleted=${deleted} ineligible=${ineligible.length} reason=${JSON.stringify(reason)}`);
  return { code: EXIT_OK, deleted, ineligible };
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const parseResult = parseArgs(process.argv.slice(2));
  if (parseResult.kind === 'err') {
    console.error(`[clear-delivered-entry] ARG ERROR: ${parseResult.message}`);
    console.error(`Usage: node scripts/clear-delivered-entry.mjs --user <id> --slot <YYYY-MM-DD-HHMM> --cluster <clusterId> [--channel <name> --rule <ruleId>] --reason "<string>"`);
    process.exit(EXIT_ARG);
  }
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error(`[clear-delivered-entry] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN must be set in env`);
    process.exit(EXIT_ARG);
  }
  const result = await runClear({
    parsed: parseResult.args,
    deps: {
      scan: (pattern) => scanKeys(pattern, { url, token }),
      redisPipeline: defaultRedisPipeline,
    },
  });
  process.exit(result.code);
}

// Only run main when invoked directly — keeps the export surface
// importable from tests without triggering a process.exit.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[clear-delivered-entry] FATAL:', err);
    process.exit(EXIT_TRANSPORT);
  });
}
