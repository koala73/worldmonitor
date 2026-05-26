/**
 * Sprint 1 / U5 — shadow-mode decision logger.
 *
 * Aggregates per-cluster cooldown decisions for one (user, rule) send
 * and emits ONE summary line per send (not one per cluster). Format
 * matches the existing parity log at `scripts/seed-digest-notifications
 * .mjs:~2122-2131` so Sentry's console-breadcrumb hook can group both
 * logs under the same fingerprint family.
 *
 * Why per-(user, rule), not per-(user, rule, channel): the cooldown
 * decision is per-channel under the U4 key shape, but the operator
 * surface that matters is "did this user-rule send have any would-have-
 * been-suppressed clusters?". Per-channel granularity stays available
 * via the `byChannel` aggregate in the line, but the line is one per
 * send so a busy cron doesn't flood Sentry.
 *
 * `console.log` is the default level. `console.warn` is reserved for
 * decisions where ANY cluster had `classificationMissing: true` — that
 * is real telemetry signal worth surfacing in Sentry (the stub
 * classifier hit the conservative-default fallback, which means U6
 * replay needs to spot the gap before Sprint 3's final taxonomy lands).
 *
 * The module is pure — accepts a `consoleLike` dep so tests can record
 * lines without touching real console. Returns the formatted line so
 * tests can assert on shape without parsing console output.
 */

import { REASON } from './digest-cooldown-decision.mjs';

/**
 * Aggregate a flat list of per-cluster decisions into the summary
 * counters used in the log line.
 *
 * Every decision is a `{decision, reason, classifiedType,
 * classificationMissing, ...}` object as produced by `evaluateCooldown`.
 * Decisions that came back `null` from the evaluator (mode='off') MUST
 * be filtered by the caller BEFORE invoking this function — the logger
 * intentionally has no opinion on the kill-switch state, only on
 * decisions that were actually computed.
 *
 * @param {Array<{ decision: 'allow' | 'suppress', reason: string,
 *   classifiedType: string, classificationMissing: boolean }>} decisions
 * @returns {{
 *   total: number,
 *   allow: number,
 *   suppress: number,
 *   classificationMissing: number,
 *   byReason: Record<string, number>,
 *   byType: Record<string, number>,
 * }}
 */
export function aggregateCooldownDecisions(decisions) {
  /** @type {Record<string, number>} */
  const byReason = {};
  /** @type {Record<string, number>} */
  const byType = {};
  let allow = 0;
  let suppress = 0;
  let classificationMissing = 0;
  if (!Array.isArray(decisions)) {
    return { total: 0, allow: 0, suppress: 0, classificationMissing: 0, byReason, byType };
  }
  for (const d of decisions) {
    if (!d || typeof d !== 'object') continue;
    if (d.decision === 'allow') allow++;
    else if (d.decision === 'suppress') suppress++;
    if (d.classificationMissing) classificationMissing++;
    const reason = typeof d.reason === 'string' ? d.reason : 'unknown';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    const type = typeof d.classifiedType === 'string' ? d.classifiedType : 'unknown';
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return {
    total: allow + suppress,
    allow,
    suppress,
    classificationMissing,
    byReason,
    byType,
  };
}

/**
 * Render the by-reason / by-type maps as a stable, parseable inline
 * string for the Sentry-friendly log line: `k1=v1,k2=v2` sorted by key.
 *
 * Sorting is load-bearing — without it two ticks with the same counter
 * distribution but different insertion order would produce different
 * log lines, which breaks Sentry fingerprint grouping (the breadcrumb
 * hook hashes the line text). Empty input renders as `none` so the
 * field is always non-empty (avoids `bytype= ` parsing ambiguity).
 *
 * @param {Record<string, number>} map
 * @returns {string}
 */
function renderSortedKv(map) {
  const keys = Object.keys(map).sort();
  if (keys.length === 0) return 'none';
  return keys.map((k) => `${k}=${map[k]}`).join(',');
}

/**
 * Emit one shadow-mode summary line per (user, rule) send. Caller
 * collects per-cluster per-channel decisions during the send loop and
 * passes them as a flat array.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {string} args.ruleId — same composite shape used by the U4
 *   delivered-log writer (`${variant}:${lang}:${sensitivity}`).
 * @param {string} args.slot — issueSlot string (used by the U6 replay
 *   harness to bucket per-day; included in the line so an operator can
 *   grep one slot's worth of decisions).
 * @param {Array<object>} args.decisions — per-cluster decisions; null
 *   entries (mode='off' short-circuits) MUST be filtered by the caller
 *   before the line is emitted, OR set
 *   `args.skipEmptyAggregate=true` to no-op when zero decisions remain.
 * @param {boolean} [args.skipEmptyAggregate=true] — when true and the
 *   filtered decisions list is empty, the function returns null without
 *   emitting (avoids a `cooldown_decision total=0` line on every cron
 *   tick when mode='off').
 * @param {{ log?: (line: string) => void, warn?: (line: string) => void }} [args.consoleLike]
 * @returns {string | null} — the line that was emitted, or null if
 *   skipped. Useful for tests that want to assert on shape.
 */
export function emitCooldownShadowLog(args) {
  const userId = typeof args?.userId === 'string' ? args.userId : 'unknown';
  const ruleId = typeof args?.ruleId === 'string' ? args.ruleId : 'unknown';
  const slot = typeof args?.slot === 'string' ? args.slot : 'unknown';
  const decisions = Array.isArray(args?.decisions) ? args.decisions.filter(Boolean) : [];
  const skipEmpty = args?.skipEmptyAggregate !== false;
  const log = args?.consoleLike?.log ?? ((line) => console.log(line));
  const warn = args?.consoleLike?.warn ?? ((line) => console.warn(line));

  if (decisions.length === 0) {
    if (skipEmpty) return null;
    // Non-skip path: still emit so operators can see "decision pipeline
    // ran with zero candidates" for one user-rule. Useful when testing
    // the wiring on a low-traffic dev account.
  }

  const agg = aggregateCooldownDecisions(decisions);

  // The line shape mirrors the existing parity log:
  //   `[digest] brief lead parity user=X rule=Y winner_match=true ...`
  // We use `[digest] cooldown_decision` as the prefix so a single
  // `grep -E "cooldown_decision"` filters the whole stream.
  const line =
    `[digest] cooldown_decision user=${userId} ` +
    `rule=${ruleId} ` +
    `slot=${slot} ` +
    `total=${agg.total} ` +
    `allow=${agg.allow} ` +
    `suppress=${agg.suppress} ` +
    `would_have_dropped=${agg.suppress} ` + // alias: U6 replay names the metric this
    `classification_missing=${agg.classificationMissing} ` +
    `by_reason=${renderSortedKv(agg.byReason)} ` +
    `by_type=${renderSortedKv(agg.byType)}`;

  // Promote to warn ONLY when the stub classifier fell back to the
  // conservative default for at least one cluster. That's a signal the
  // Sprint 3 taxonomy needs to learn a new pattern, and it's the kind
  // of thing Sentry should surface — the rest of the cooldown stream is
  // observability noise that only matters in aggregate.
  if (agg.classificationMissing > 0) {
    warn(line);
  } else {
    log(line);
  }
  return line;
}
