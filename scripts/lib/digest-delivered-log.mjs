/**
 * Sprint 1 / U4 — per-channel, per-cluster delivered-log writer.
 *
 * Records "channel X delivered story-cluster Y for rule R to user U at
 * time T" as an idempotent Redis row. Sprint 1 ships this in shadow:
 * the U5 cooldown evaluator (next unit) will read these rows to decide
 * "would-have-suppressed" without changing send behaviour. Sprint 2
 * flips the read into enforcement.
 *
 * Key shape:
 *   digest:sent:v1:${userId}:${channel}:${ruleId}:${clusterId}
 *
 * Every discriminator is explicit (no `${ruleId || slot}` boolean-OR
 * fallback collapse — see `skill_cache_key_or_fallback_collapses_input
 * _shapes`). Even though U2's option (a) collapses multi-rule users to
 * one canonical winning rule per slot, `ruleId` stays in the key for
 * audit traceability + so a future per-rule policy can target rows
 * without a key migration.
 *
 * Value shape (minimal):
 *   { sentAt: <epochMs>, sourceCount: <int>, severity: <tier> }
 *
 * U5's cooldown evaluator reads sentAt for the floor check and
 * (sourceCount, severity) for the evolution-bypass decisions. Adding
 * fields here is a contract change (U5 must read them); avoid bloat.
 *
 * TTL: 30 days base + per-key uniform random jitter 0-3 days. The
 * jitter prevents synchronized expiry of every key 30 days after first
 * deploy — without it, Sprint 2's enforce-mode would face a cliff
 * where the cooldown filter sees no history one day after writing
 * stopped working. See `per-item-cache-cliff-masks-upstream-regression`
 * for the canonical incident pattern (different feed; same mechanism).
 *
 * Idempotency:
 *   We use SET NX EX in JSON-body pipeline form (`feedback_upstash_rest
 *   _set_ex_path_not_query`). The boolean response distinguishes
 *   "wrote new key" (`'OK'`) from "key already existed, NX prevented
 *   overwrite" (`null`). We trust the response and never write-then-
 *   reread (`feedback_upstash_write_reread_race_in_handler`).
 *
 * Tri-state writer return: `{ written, conflicts, errors }` per
 * `skill_caller_narrows_partial_result_type_drops_failure_counters`.
 * The send-loop caller MUST early-return on `errors > 0` BEFORE any
 * subsequent stamp/log — letting the story re-air to that channel on
 * the next tick is preferable to false-suppressing it. `conflicts > 0`
 * is benign idempotent re-write; log INFO not WARN.
 *
 * Failure-mode trade-off (operator-facing): if Resend returns 200 but
 * THIS writer fails afterwards, the story re-airs to that channel on
 * the next cron tick. We accept that trade-off: an extra email beats
 * a silent suppression that hides a real delivery failure. The inverse
 * (suppress on failure) would mask the delivery problem itself by
 * pretending we'd already sent the story.
 *
 * Operator-side: paired primitive `clearDeliveredEntry` lives at
 * `scripts/clear-delivered-entry.mjs`. Required `--reason` argument
 * matches `skill_new_blocking_state_without_matching_clear_primitive`
 * — every halt-able state needs an audited unhalt path.
 */

import { defaultRedisPipeline } from './_upstash-pipeline.mjs';

const KEY_PREFIX = 'digest:sent:v1';
const TTL_BASE_SECONDS = 30 * 24 * 60 * 60;     // 30d
const TTL_JITTER_SECONDS = 3 * 24 * 60 * 60;    // 3d uniform random spread

// Keep in lockstep with the cron's deliverable-channels filter in
// scripts/seed-digest-notifications.mjs (the channel.channelType check).
// Adding a new channel type → also add it here AND in api/health.js's
// seed-meta SEED_META configuration if that channel needs separate
// monitoring.
export const ALLOWED_CHANNELS = Object.freeze(
  new Set(['email', 'telegram', 'slack', 'discord', 'webhook']),
);

/**
 * Build the canonical Redis key for a delivered-log entry. Every
 * component must be a non-empty string of `[A-Za-z0-9_:-]` to keep the
 * key namespace traversable by `redis-cli SCAN` / Upstash dashboard.
 * Throws on any violation BEFORE the network call so malformed keys
 * never reach Upstash.
 *
 * @param {{ userId: string; channel: string; ruleId: string; clusterId: string }} parts
 * @returns {string}
 */
export function buildDeliveredLogKey(parts) {
  const { userId, channel, ruleId, clusterId } = parts ?? {};
  assertNonEmptyString(userId, 'userId');
  assertChannel(channel);
  assertNonEmptyString(ruleId, 'ruleId');
  assertNonEmptyString(clusterId, 'clusterId');
  // No explicit safety regex here — we trust the cron's userId/ruleId/
  // clusterId producers (Convex IDs, our own variant strings, sha256
  // hashes). If a future producer ever introduces a colon-bearing
  // segment that could ambiguate the key, the `assertNonEmptyString`
  // gate is the place to tighten.
  return `${KEY_PREFIX}:${userId}:${channel}:${ruleId}:${clusterId}`;
}

/**
 * Pure helper: per-write TTL with uniform jitter.
 *
 * Returns 30d * 86400 + Math.floor(rand * 3d * 86400). With the default
 * `Math.random` the spread is uniform in `[2_592_000, 2_851_200)`.
 *
 * Tests inject a deterministic `randomFn` to assert distribution shape
 * + bounds without relying on `Math.random` luck.
 *
 * @param {() => number} [randomFn=Math.random]
 * @returns {number}
 */
export function computeTtlSecondsWithJitter(randomFn = Math.random) {
  const r = randomFn();
  // Clamp the random sample to [0, 1) so a buggy injection (returns
  // negative, returns >=1) cannot push the TTL below the base or above
  // base+jitter. Without this guard a `randomFn = () => 1` injection
  // would yield TTL = base + jitter exactly, off-by-one above the
  // documented bound.
  const clamped = Number.isFinite(r) ? Math.max(0, Math.min(0.9999999, r)) : 0;
  return TTL_BASE_SECONDS + Math.floor(clamped * TTL_JITTER_SECONDS);
}

/**
 * Write one delivered-log entry. Idempotent via SET NX EX.
 *
 * Returns tri-state counts. Caller MUST inspect `errors > 0` and skip
 * any subsequent "delivered" stamp / log when set — allowing the story
 * to re-air on the next tick. See module docblock for the full failure-
 * mode rationale.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {string} args.channel — one of ALLOWED_CHANNELS
 * @param {string} args.ruleId
 * @param {string} args.clusterId — BriefStory.clusterId (rep hash)
 * @param {number} args.sentAt — epoch ms (Date.now()) at write time
 * @param {number} args.sourceCount — BriefStory.sources?.length ?? 1
 * @param {string} args.severity — BriefStory.threatLevel tier
 * @param {object} [args.deps]
 * @param {typeof defaultRedisPipeline} [args.deps.redisPipeline]
 * @param {() => number} [args.deps.randomFn]
 * @returns {Promise<{ written: number, conflicts: number, errors: number, key: string }>}
 *   `key` is the canonical key shape — useful to logs and tests; never
 *   used as a side-channel for the tri-state contract.
 * @throws if any key component is empty or `channel` is unknown. Thrown
 *   BEFORE the Upstash call — malformed keys never reach the wire.
 */
export async function writeDeliveredEntry(args) {
  const {
    userId,
    channel,
    ruleId,
    clusterId,
    sentAt,
    sourceCount,
    severity,
    // Greptile PR #3617 P2 — `headline` (optional) lets U5's cooldown
    // evaluator drive the EVOLUTION_NEW_FACT bypass via simple string
    // comparison against the prior delivery. Sprint 1 ships this as
    // a stub (string-equality on the canonical headline); Sprint 3's
    // full classifier replaces with an LLM-driven fact-diff. Storing
    // headline here is forward-compatible — older readers ignore the
    // field; the contract surface is the JSON shape, not the schema.
    headline,
    deps = {},
  } = args ?? {};

  // Throws on bad input — caller's responsibility to pre-validate.
  // Throwing here (vs returning {errors: 1}) is intentional: a bad
  // userId/clusterId is a programmer error, not a transient upstream
  // failure, and we want the cron's existing try/catch to surface the
  // stack trace. Network/Upstash failures DO return `errors: 1` — see
  // the catch arm below.
  const key = buildDeliveredLogKey({ userId, channel, ruleId, clusterId });
  if (!Number.isFinite(sentAt) || sentAt <= 0) {
    throw new Error(
      `writeDeliveredEntry: sentAt must be a positive epoch-ms number; got ${JSON.stringify(sentAt)}`,
    );
  }
  // sourceCount + severity are persisted but not key components — bad
  // values degrade U5's cooldown decision, they don't break the key.
  // Coerce defensively rather than throw so a single weird story can't
  // poison an entire cron tick.
  const safeSourceCount = Number.isFinite(sourceCount) && sourceCount >= 0
    ? Math.floor(sourceCount)
    : 0;
  const safeSeverity = typeof severity === 'string' && severity.length > 0
    ? severity
    : 'unknown';
  // Headline is optional — only set when caller provides a non-empty
  // string. Allows existing call sites without a headline arg to keep
  // working (their stored row simply omits the field, and the U5
  // evaluator treats `lastDeliveredHeadline = null` as "can't compare,
  // skip the new-fact bypass").
  const safeHeadline = typeof headline === 'string' && headline.length > 0
    ? headline
    : null;

  /** @type {Record<string, unknown>} */
  const valueShape = {
    sentAt,
    sourceCount: safeSourceCount,
    severity: safeSeverity,
  };
  if (safeHeadline !== null) valueShape.headline = safeHeadline;
  const value = JSON.stringify(valueShape);
  const ttl = computeTtlSecondsWithJitter(deps.randomFn);
  const pipeline = deps.redisPipeline ?? defaultRedisPipeline;

  let result;
  try {
    // Codex PR #3617 round-4 P1 — SET (overwrite) semantics, NOT SET NX.
    //
    // Pre-fix used NX so the row "stuck" to its first value forever
    // (within the 30d±jitter TTL). After a high-event re-air was
    // ALLOWED at 19h post-floor, the Redis row still pointed to T0 —
    // so the next re-air at 20h read lastDeliveredAt=T0 and saw "20h
    // beyond 18h floor → allow", instead of "1h since last delivery
    // → suppress". Production shadow telemetry diverged from U6
    // replay (which correctly updates synthetic state on allow), and
    // Sprint 2 enforce-mode would have inherited the divergence as
    // under-suppression of high-rate clusters.
    //
    // Refresh semantics: every successful send overwrites the row
    // with the new {sentAt, sourceCount, severity}. The same-tick
    // double-write idempotency that NX provided was a non-concern
    // (the second write has the same value structurally), so SET is
    // strictly correct + simpler. The TTL is re-applied on each
    // write (per-key jitter recomputed) so a cluster that re-airs
    // every few days never permanently expires.
    result = await pipeline([['SET', key, value, 'EX', String(ttl)]]);
  } catch (err) {
    // defaultRedisPipeline catches its own throws and returns null. If
    // a custom-injected pipeline DOES throw (test mock, future helper),
    // surface as `errors: 1` so the caller's gate still fires. The
    // failure mode is identical to a 5xx — story re-airs next tick.
    return { written: 0, conflicts: 0, errors: 1, key };
  }

  // pipeline returned null = creds missing OR HTTP non-2xx OR fetch
  // threw. Treat as error: caller short-circuits stamp/log.
  if (result == null || !Array.isArray(result) || result.length === 0) {
    return { written: 0, conflicts: 0, errors: 1, key };
  }
  const cell = result[0];
  if (cell && typeof cell === 'object' && 'error' in cell) {
    return { written: 0, conflicts: 0, errors: 1, key };
  }
  // Upstash pipeline cells: { result: 'OK' } on every successful SET
  // (whether new or overwrite). Anything else is an upstream surprise —
  // count as error so the cron does not silently mark the story stamped.
  // The `conflicts` counter is preserved at 0 in the return shape for
  // back-compat with the U4 aggregator and existing call sites; under
  // SET semantics it can never increment (every successful write IS a
  // write, never an idempotent no-op).
  const cellResult = cell?.result;
  if (cellResult === 'OK') return { written: 1, conflicts: 0, errors: 0, key };
  return { written: 0, conflicts: 0, errors: 1, key };
}

/**
 * Convenience aggregator — sum tri-state counters across multiple
 * writes (e.g. one cron tick across all channels for one user). Pure;
 * no I/O. Useful for the seed-meta `keyCount`/`errorRate` sample +
 * for tests that batch writes.
 *
 * @param {Array<{written?: number, conflicts?: number, errors?: number}>} results
 * @returns {{ written: number, conflicts: number, errors: number }}
 */
export function aggregateResults(results) {
  let written = 0, conflicts = 0, errors = 0;
  if (!Array.isArray(results)) return { written, conflicts, errors };
  for (const r of results) {
    written += Number(r?.written ?? 0);
    conflicts += Number(r?.conflicts ?? 0);
    errors += Number(r?.errors ?? 0);
  }
  return { written, conflicts, errors };
}

// ── Internal validators ──────────────────────────────────────────────

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `digest-delivered-log: ${label} must be a non-empty string; got ${JSON.stringify(value)}`,
    );
  }
}

function assertChannel(channel) {
  assertNonEmptyString(channel, 'channel');
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new Error(
      `digest-delivered-log: channel must be one of ${[...ALLOWED_CHANNELS].join(',')}; got ${JSON.stringify(channel)}`,
    );
  }
}
