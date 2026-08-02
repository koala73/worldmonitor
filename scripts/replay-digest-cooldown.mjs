#!/usr/bin/env node
/**
 * Sprint 1 / U6 — 14-day replay harness against `digest:replay-log:v1:*`.
 *
 * Validates the U5 cooldown decision table BEFORE Sprint 2 enables
 * enforce mode. For each (ruleId, storyHash) timeline observed across
 * the last 14 days of replay-log records, simulates what U4's
 * delivered-log would have looked like, then runs U5's evaluateCooldown
 * against each subsequent occurrence. Aggregates would-have-suppressed
 * counts by classification × severity × channel.
 *
 * Phase 0 prerequisite: `DIGEST_DEDUP_REPLAY_LOG=1` must have been on
 * for ≥14 days before this script can produce a meaningful report. The
 * activation date for this deployment is 2026-05-06; earliest-runnable
 * is 2026-05-20. The harness refuses to run if coverage spans <14 days.
 *
 * Live run: `node scripts/replay-digest-cooldown.mjs [--days 14] [--rule <ruleId>]`
 *   Reads from Upstash via SCAN + per-key range fetch. Outputs a JSON
 *   report to stdout + a markdown summary block (printable for paste
 *   into docs/internal/digest-brief-improvements.md Sprint 1 outcomes).
 *
 * Test path: `aggregateReplayDecisions(records, options)` is the pure
 * aggregation function. Tests load fixture records and assert
 * histogram counts without any Upstash IO.
 *
 * Replay-log key shape (from scripts/lib/brief-dedup-replay-log.mjs):
 *   `digest:replay-log:v1:{ruleId}:{YYYY-MM-DD}`
 * Each value is a Redis list of JSON records. Each record carries:
 *   { storyHash, isRep, mergedHashes?, currentScore, mentionCount, phase,
 *     sources, severity, headline, sourceUrl, briefTickId, ruleId, tsMs, ... }
 *
 * Per-tick numeric `clusterId` from the replay-log is NOT stable across
 * ticks (per scripts/lib/brief-dedup-replay-log.mjs:96-109). We use the
 * REP's storyHash (= rep.hash, where mergedHashes[0] = rep.hash by
 * U3's contract) as the canonical cluster identity. For non-rep
 * stories we follow `mergedHashes[0]` to find the rep.
 *
 * The harness assumes cooldown channel = 'email' for the simulated
 * U4 lookup. Real production has per-channel cooldown rows; the
 * replay-log only records the dedup pass (channel-agnostic), so the
 * simulation conservatively models "would we have suppressed on
 * email?". Multi-channel granularity is a Sprint 3 follow-on.
 */

import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { evaluateCooldown } from './lib/digest-cooldown-decision.mjs';
import { REPLAY_WINDOW_DAYS } from './lib/brief-replay-constants.mjs';

export const DEFAULT_REPLAY_DAYS = REPLAY_WINDOW_DAYS;
const REPLAY_KEY_PREFIX = 'digest:replay-log:v1';
const SCAN_PAGE_SIZE = 200;
const REPLAY_REST_USER_AGENT = 'worldmonitor-digest/1.0';
const REPLAY_REQUEST_TIMEOUT_MS = 10_000;
const SNAPSHOT_TTL_SECONDS = 15 * 60;

function replayRequestInit(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': REPLAY_REST_USER_AGENT,
    },
    signal: AbortSignal.timeout(REPLAY_REQUEST_TIMEOUT_MS),
  };
}

/**
 * Entries per LRANGE page. Upstash's max-request-size limit counts a
 * SINGLE command's result, so `LRANGE key 0 -1` on a full day list was
 * rejected outright once the lists grew past 50MiB. Matches the page
 * size already used by the sibling harnesses (sweep-topic-thresholds.mjs,
 * brief-quality-report.mjs) — ~1.5MB per page at observed entry sizes.
 */
const LRANGE_PAGE_SIZE = 1_000;

// ── Pure aggregation (test-exercised) ───────────────────────────────

/**
 * @typedef {object} ReplayRecord
 * @property {string} storyHash
 * @property {boolean} [isRep]
 * @property {string[]} [mergedHashes]
 * @property {number} [currentScore]
 * @property {number} [mentionCount]
 * @property {string[]} [sources]
 * @property {string} [severity]   — 'critical' | 'high' | 'medium' | 'low'
 * @property {string} [headline]
 * @property {string} [sourceUrl]
 * @property {string} [phase]
 * @property {string} ruleId
 * @property {number} tsMs         — record timestamp; U6 timeline uses this
 *
 * @typedef {object} ReplayAggregate
 * @property {number} totalRecords
 * @property {number} totalTimelines      — distinct (ruleId, clusterId) pairs
 * @property {number} totalDecisions      — decisions evaluated (excludes first occurrence per timeline)
 * @property {number} allowDecisions
 * @property {number} suppressDecisions
 * @property {number} dropRatePct         — suppressDecisions / totalDecisions × 100
 * @property {Record<string, number>} reasonHistogram      — keyed by REASON value
 * @property {Record<string, number>} typeHistogram        — keyed by classifiedType
 * @property {Record<string, number>} severityHistogram    — keyed by severity
 * @property {Array<{clusterId: string, ruleId: string, suppressCount: number,
 *                   allowCount: number, reasons: Record<string, number>}>} topSuppressed
 * @property {{startDate: string, endDate: string, daysCovered: number,
 *             distinctRuleIds: number}} coverage
 */

/**
 * Build a stable cluster identity from a replay-log record. Source
 * preference (top wins; matches the writer's emit order):
 *
 *   1. `repHash` (v2+) — every record carries the rep's stable hash;
 *      non-reps inherit it via repHashByStoryHash. This is the
 *      canonical post-fix path: collapses cluster timelines uniformly
 *      regardless of which member was sampled in the dedup input.
 *   2. `mergedHashes[0]` (v2+ on reps) — equivalent to repHash for
 *      reps but absent on non-reps.
 *   3. `storyHash` (v1 fallback) — for records still in the 30-day TTL
 *      window that pre-date the v2 writer bump. These will silently
 *      split clusters by story (the original Codex PR #3617 P1 issue),
 *      but rejecting them entirely would cost the harness 1+ days of
 *      data right after the v2 cutover. Accept and degrade gracefully.
 *
 * @param {ReplayRecord} record
 * @returns {string}
 */
export function clusterIdFromRecord(record) {
  // Codex PR #3617 P1 — v2 records carry repHash on every record
  // (rep AND non-rep), so this is the canonical cluster identity.
  if (typeof record?.repHash === 'string' && record.repHash.length > 0) {
    return record.repHash;
  }
  if (Array.isArray(record?.mergedHashes) && record.mergedHashes.length > 0
    && typeof record.mergedHashes[0] === 'string' && record.mergedHashes[0].length > 0) {
    return record.mergedHashes[0];
  }
  if (typeof record?.storyHash === 'string' && record.storyHash.length > 0) {
    return record.storyHash;
  }
  return '';
}

/**
 * Read the headline from a replay-log record. v2 emits `headline`
 * (matching BriefStory + the U5 classifier's input shape); v1 emits
 * `title`. Accept either.
 */
function recordHeadline(record) {
  if (typeof record?.headline === 'string' && record.headline.length > 0) return record.headline;
  if (typeof record?.title === 'string' && record.title.length > 0) return record.title;
  return '';
}

/**
 * Read the source URL from a replay-log record. v2 emits `sourceUrl`
 * (matching BriefStory + the U5 classifier's input shape); v1 emits
 * `link`. Accept either.
 */
function recordSourceUrl(record) {
  if (typeof record?.sourceUrl === 'string' && record.sourceUrl.length > 0) return record.sourceUrl;
  if (typeof record?.link === 'string' && record.link.length > 0) return record.link;
  return '';
}

/**
 * Pure aggregation: simulate cooldown decisions across all (ruleId,
 * clusterId) timelines in the input records. The first occurrence of
 * a timeline seeds the synthesized U4 delivered-log; each subsequent
 * occurrence within the timeline runs evaluateCooldown against that
 * synthesized state and records the decision.
 *
 * @param {ReplayRecord[]} records
 * @param {object} [options]
 * @param {string} [options.channel='email']  — assumed channel for the simulation
 * @param {number} [options.minDaysCovered=14] — abort if coverage is below this
 * @param {boolean} [options.allowShortCoverage=false] — test-only escape hatch
 * @returns {ReplayAggregate}
 */
export function aggregateReplayDecisions(records, options = {}) {
  const channel = options.channel ?? 'email';
  const minDaysCovered = Number.isFinite(options.minDaysCovered)
    ? options.minDaysCovered
    : DEFAULT_REPLAY_DAYS;
  const allowShortCoverage = options.allowShortCoverage === true;

  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(
      'aggregateReplayDecisions: empty input — DIGEST_DEDUP_REPLAY_LOG may be off, OR no ticks ' +
        `recorded in the requested window. The flag must have been on for ≥${minDaysCovered} days.`,
    );
  }

  // Sort by tsMs so timeline simulation reads ticks in chronological order.
  // Defensive copy — never mutate caller input.
  const sorted = [...records]
    .filter((r) => Number.isFinite(r?.tsMs) && typeof r?.ruleId === 'string')
    .sort((a, b) => a.tsMs - b.tsMs);

  if (sorted.length === 0) {
    throw new Error(
      'aggregateReplayDecisions: no records have valid {tsMs, ruleId} — ' +
        'check replay-log writer (scripts/lib/brief-dedup-replay-log.mjs) is producing the expected shape.',
    );
  }

  // Coverage gate — refuse to run on insufficient data.
  const startMs = sorted[0].tsMs;
  const endMs = sorted[sorted.length - 1].tsMs;
  const daysCovered = Math.max(0, (endMs - startMs) / (24 * 60 * 60 * 1000));
  if (daysCovered < minDaysCovered && !allowShortCoverage) {
    throw new Error(
      `aggregateReplayDecisions: coverage ${daysCovered.toFixed(2)} days < required ${minDaysCovered}. ` +
        `First record: ${new Date(startMs).toISOString()}. Last record: ${new Date(endMs).toISOString()}. ` +
        'Wait for the 14-day window OR pass {allowShortCoverage: true} for a partial-window probe.',
    );
  }

  // Codex PR #3617 round-3 P1 — collapse multi-record-per-tick to ONE
  // observation per (ruleId, repHash, tsMs). The replay-log writer
  // emits one record per INPUT story (rep + each non-rep cluster
  // member), so a 2-story cluster in one tick yields 2 records at the
  // same tsMs. Pre-fix the timeline aggregator treated each record as
  // a separate occurrence — the second record (same tsMs) read the
  // first as `lastDeliveredAt` and produced a false "0-hour repeat"
  // suppression. Result: every multi-member cluster doubled its
  // suppression count in the report.
  //
  // Collapse: keep one record per (ruleId, repHash, tsMs). Prefer the
  // rep record (isRep=true) so the headline/sourceUrl come from the
  // canonical rep's view of the cluster. Falls back to the first-seen
  // record when no rep is present (e.g. v1 records without isRep).
  /** @type {Map<string, ReplayRecord>} */
  const collapsed = new Map();
  for (const record of sorted) {
    const clusterId = clusterIdFromRecord(record);
    if (!clusterId) continue;
    const tickKey = `${record.ruleId}::${clusterId}::${record.tsMs}`;
    const existing = collapsed.get(tickKey);
    if (!existing) {
      collapsed.set(tickKey, record);
      continue;
    }
    // Replace if the new record is the rep and the existing isn't
    // (the rep carries the canonical headline + sourceUrl + sources).
    if (record?.isRep === true && existing?.isRep !== true) {
      collapsed.set(tickKey, record);
    }
  }

  /** @type {Map<string, {records: ReplayRecord[], ruleId: string, clusterId: string}>} */
  const timelines = new Map();
  for (const record of collapsed.values()) {
    const clusterId = clusterIdFromRecord(record);
    if (!clusterId) continue;
    const key = `${record.ruleId}::${clusterId}`;
    let timeline = timelines.get(key);
    if (!timeline) {
      timeline = { records: [], ruleId: record.ruleId, clusterId };
      timelines.set(key, timeline);
    }
    timeline.records.push(record);
  }
  // Re-sort each timeline's records by tsMs after collapse — the
  // collapse Map iteration order matches insertion order (which was
  // already sorted), but defensive sort guards against future
  // refactors that change Map iteration semantics.
  for (const timeline of timelines.values()) {
    timeline.records.sort((a, b) => a.tsMs - b.tsMs);
  }

  let allowDecisions = 0;
  let suppressDecisions = 0;
  /** @type {Record<string, number>} */
  const reasonHistogram = {};
  /** @type {Record<string, number>} */
  const typeHistogram = {};
  /** @type {Record<string, number>} */
  const severityHistogram = {};
  /** @type {Array<{clusterId: string, ruleId: string, suppressCount: number, allowCount: number, reasons: Record<string, number>}>} */
  const perTimeline = [];

  for (const timeline of timelines.values()) {
    const tlRecords = timeline.records;
    if (tlRecords.length < 2) continue; // single-occurrence timelines have no cooldown decision to simulate
    let lastDelivered = null; // synthesized U4 row state
    let timelineSuppress = 0;
    let timelineAllow = 0;
    /** @type {Record<string, number>} */
    const timelineReasons = {};

    for (let i = 0; i < tlRecords.length; i += 1) {
      const r = tlRecords[i];
      const sources = Array.isArray(r.sources) ? r.sources : [];
      const sourceCount = sources.length;
      const severity = typeof r.severity === 'string' ? r.severity.toLowerCase() : 'unknown';
      severityHistogram[severity] = (severityHistogram[severity] ?? 0) + 1;

      if (i === 0) {
        // First occurrence — seed the synthesized delivered-log row.
        lastDelivered = { sentAt: r.tsMs, sourceCount, severity, headline: recordHeadline(r) };
        continue;
      }

      // Derive sourceDomain from sourceUrl host for the stub classifier.
      // Codex PR #3617 P1 — read via recordSourceUrl/recordHeadline so
      // both the v2 writer shape and v1 legacy records work correctly.
      const sourceUrlForRecord = recordSourceUrl(r);
      let sourceDomain = '';
      if (sourceUrlForRecord) {
        try {
          sourceDomain = new URL(sourceUrlForRecord).host.toLowerCase();
        } catch {
          sourceDomain = '';
        }
      }

      const decision = evaluateCooldown({
        userId: 'replay-harness', // synthetic — only used in logs the harness drops
        slot: 'replay',
        clusterId: timeline.clusterId,
        channel,
        ruleId: timeline.ruleId,
        // Let classifyStub run — replay records carry headline + sourceUrl
        classifierInputs: { sourceDomain, headline: recordHeadline(r) },
        severity,
        currentSourceCount: sourceCount,
        currentTier: severity,
        lastDeliveredAt: lastDelivered.sentAt,
        lastDeliveredSourceCount: lastDelivered.sourceCount,
        lastDeliveredTier: lastDelivered.severity,
        // Greptile PR #3617 P2 — drives EVOLUTION_NEW_FACT bypass.
        // Synthetic state tracks last delivered headline alongside
        // sentAt/sourceCount/severity so replay matches the live
        // evaluator's behavior under the new-fact bypass path.
        lastDeliveredHeadline: lastDelivered.headline ?? null,
        options: { mode: 'shadow', nowMs: r.tsMs },
      });

      if (decision === null) continue;

      if (decision.decision === 'allow') {
        allowDecisions += 1;
        timelineAllow += 1;
        // Allowed → simulated U4 write updates the synthesized state.
        lastDelivered = { sentAt: r.tsMs, sourceCount, severity, headline: recordHeadline(r) };
      } else {
        suppressDecisions += 1;
        timelineSuppress += 1;
      }

      reasonHistogram[decision.reason] = (reasonHistogram[decision.reason] ?? 0) + 1;
      typeHistogram[decision.classifiedType] = (typeHistogram[decision.classifiedType] ?? 0) + 1;
      timelineReasons[decision.reason] = (timelineReasons[decision.reason] ?? 0) + 1;
    }

    perTimeline.push({
      clusterId: timeline.clusterId,
      ruleId: timeline.ruleId,
      suppressCount: timelineSuppress,
      allowCount: timelineAllow,
      reasons: timelineReasons,
    });
  }

  const totalDecisions = allowDecisions + suppressDecisions;
  const dropRatePct = totalDecisions === 0 ? 0 : (suppressDecisions / totalDecisions) * 100;

  // Top-10 most-suppressed timelines for manual review.
  const topSuppressed = perTimeline
    .filter((t) => t.suppressCount > 0)
    .sort((a, b) => b.suppressCount - a.suppressCount)
    .slice(0, 10);

  /** @type {Set<string>} */
  const distinctRuleIds = new Set();
  for (const r of sorted) distinctRuleIds.add(r.ruleId);

  return {
    totalRecords: sorted.length,
    totalTimelines: timelines.size,
    totalDecisions,
    allowDecisions,
    suppressDecisions,
    dropRatePct: Number(dropRatePct.toFixed(2)),
    reasonHistogram,
    typeHistogram,
    severityHistogram,
    topSuppressed,
    coverage: {
      startDate: new Date(startMs).toISOString().slice(0, 10),
      endDate: new Date(endMs).toISOString().slice(0, 10),
      daysCovered: Number(daysCovered.toFixed(2)),
      distinctRuleIds: distinctRuleIds.size,
    },
  };
}

/**
 * Render a markdown summary block suitable for pasting into the strategic
 * doc's Sprint 1 outcomes section.
 *
 * @param {ReplayAggregate} agg
 * @returns {string}
 */
export function renderMarkdownSummary(agg) {
  const lines = [
    `## Sprint 1 / U6 replay results — ${agg.coverage.startDate} → ${agg.coverage.endDate}`,
    '',
    `- Coverage: ${agg.coverage.daysCovered} days, ${agg.coverage.distinctRuleIds} distinct ruleId(s)`,
    `- Records: ${agg.totalRecords}; timelines (rule × cluster): ${agg.totalTimelines}; decisions: ${agg.totalDecisions}`,
    `- **Drop-rate: ${agg.dropRatePct}%** (${agg.suppressDecisions} suppress / ${agg.allowDecisions} allow)`,
    '',
    '### Reason histogram',
    ...Object.entries(agg.reasonHistogram)
      .sort(([, a], [, b]) => b - a)
      .map(([reason, count]) => `- \`${reason}\`: ${count}`),
    '',
    '### Type histogram',
    ...Object.entries(agg.typeHistogram)
      .sort(([, a], [, b]) => b - a)
      .map(([type, count]) => `- \`${type}\`: ${count}`),
    '',
    '### Top-10 most-suppressed timelines',
    ...(agg.topSuppressed.length === 0
      ? ['_No timelines triggered suppression in this window._']
      : agg.topSuppressed.map((t, i) => {
          const reasons = Object.entries(t.reasons).map(([r, c]) => `${r}=${c}`).join(', ');
          return `${i + 1}. \`${t.clusterId.slice(0, 16)}…\` (rule \`${t.ruleId}\`): ${t.suppressCount} suppress, ${t.allowCount} allow — ${reasons}`;
        })),
  ];
  return lines.join('\n');
}

// ── CLI / live-Redis IO (not test-exercised) ─────────────────────────

/**
 * Parse CLI args. Returns { days, rule, allowShortCoverage, help }.
 */
export function parseArgs(argv) {
  const args = { days: DEFAULT_REPLAY_DAYS, rule: null, allowShortCoverage: false, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--days') {
      const next = argv[i + 1];
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`--days must be a positive integer, got: ${next}`);
      }
      args.days = parsed;
      i += 1;
    } else if (arg === '--rule') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--rule requires a value');
      }
      args.rule = next;
      i += 1;
    } else if (arg === '--allow-short-coverage') {
      args.allowShortCoverage = true;
    } else {
      throw new Error(`Unknown argument: ${arg}. Run with --help for usage.`);
    }
  }
  return args;
}

const HELP_TEXT = `
Usage: node scripts/replay-digest-cooldown.mjs [options]

Replay the last N days of digest:replay-log:v1:* records through the
Sprint 1 / U5 cooldown decision module and report a drop-rate
distribution. Used to validate the cooldown table BEFORE Sprint 2
enables enforce mode.

Options:
  --days <N>              Days of history to replay (default: 14, the
                          minimum required to validate Sprint 2 enforcement).
  --rule <ruleId>         Limit replay to one ruleId (e.g. "full:en:high").
                          Default: all rules in the window.
  --allow-short-coverage  Run with <14d coverage. ONLY for partial-window
                          probes during development. Sprint 2 cannot use
                          short-coverage results to gate enforcement.
  --help, -h              Show this message.

Required env:
  UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

Output:
  - Markdown summary block printed to stdout — paste into
    docs/internal/digest-brief-improvements.md Sprint 1 outcomes section.
  - Full JSON aggregate written to /tmp/replay-digest-cooldown-<date>.json
    for downstream tooling.
`.trim();

/**
 * Read one replay-log day list in bounded pages.
 *
 * Replaces `LRANGE key 0 -1`, which Upstash rejects once a day list
 * exceeds the 50MiB per-command limit. Two failure modes are collapsed
 * into one throw so neither can be mistaken for "this day had no data":
 *
 *   - non-2xx (transport / auth)
 *   - HTTP 200 carrying a per-command `error` field, which is how the
 *     max-request-size rejection actually arrives. `res.ok` is true and
 *     `body.result` is undefined, so the pre-2026-08-02 reader scored it
 *     as an empty list and the harness exited 2 blaming the feature flag.
 *
 * @param {string} url                       Upstash REST base URL
 * @param {string} token                     Upstash REST token
 * @param {string} key                       replay-log day key
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]    injectable for tests
 * @param {number} [opts.pageSize]           entries per request
 * @param {string} [opts.snapshotKey]        deterministic key for tests
 * @param {(...args: unknown[]) => void} [opts.warn] cleanup warning sink
 * @returns {Promise<string[]>}              raw JSON strings, list order
 */
export async function readReplayListPaged(url, token, key, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pageSize = opts.pageSize ?? LRANGE_PAGE_SIZE;
  const warn = opts.warn ?? ((...args) => console.warn(...args));
  // A non-positive page size makes `stop` land on -1, i.e. the exact
  // unbounded `LRANGE key 0 -1` this function exists to avoid — and the
  // short-page check could never terminate. Fail loudly instead.
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new TypeError(`readReplayListPaged: pageSize must be a positive integer, got ${pageSize}`);
  }
  const snapshotKey = opts.snapshotKey ?? `${key}:read-snapshot:${randomUUID()}`;
  let snapshotCreated = false;
  /** @type {string[]} */
  const out = [];
  try {
    const copyRes = await fetchImpl(
      `${url}/copy/${encodeURIComponent(key)}/${encodeURIComponent(snapshotKey)}`,
      replayRequestInit(token),
    );
    if (!copyRes.ok) {
      throw new Error(`COPY ${key} -> ${snapshotKey} failed: HTTP ${copyRes.status}`);
    }
    const copyBody = await copyRes.json();
    if (copyBody?.error) {
      throw new Error(`COPY ${key} -> ${snapshotKey} rejected by Upstash: ${copyBody.error}`);
    }
    if (copyBody?.result === 0 || copyBody?.result === '0') return out;
    if (copyBody?.result !== 1 && copyBody?.result !== '1') {
      throw new Error(`COPY ${key} -> ${snapshotKey} returned an unexpected result`);
    }
    snapshotCreated = true;

    const expireRes = await fetchImpl(
      `${url}/expire/${encodeURIComponent(snapshotKey)}/${SNAPSHOT_TTL_SECONDS}`,
      replayRequestInit(token),
    );
    if (!expireRes.ok) {
      throw new Error(`EXPIRE ${snapshotKey} failed: HTTP ${expireRes.status}`);
    }
    const expireBody = await expireRes.json();
    if (expireBody?.error || (expireBody?.result !== 1 && expireBody?.result !== '1')) {
      throw new Error(`EXPIRE ${snapshotKey} rejected by Upstash: ${expireBody?.error ?? 'unexpected result'}`);
    }

    let start = 0;
    for (;;) {
      const stop = start + pageSize - 1;
      const res = await fetchImpl(`${url}/lrange/${encodeURIComponent(snapshotKey)}/${start}/${stop}`, {
        ...replayRequestInit(token),
      });
      if (!res.ok) {
        throw new Error(`LRANGE ${snapshotKey} [${start}..${stop}] failed: HTTP ${res.status}`);
      }
      const body = await res.json();
      if (body?.error) {
        throw new Error(`LRANGE ${snapshotKey} [${start}..${stop}] rejected by Upstash: ${body.error}`);
      }
      const items = Array.isArray(body?.result) ? body.result : [];
      out.push(...items);
      // A short page is the end of the snapshot. An exact-multiple list
      // costs one extra empty page, which is cheaper than an LLEN round-trip.
      if (items.length < pageSize) return out;
      start += pageSize;
    }
  } finally {
    if (snapshotCreated) {
      try {
        const deleteRes = await fetchImpl(
          `${url}/del/${encodeURIComponent(snapshotKey)}`,
          replayRequestInit(token),
        );
        if (!deleteRes.ok) {
          warn(`[replay] failed to delete read snapshot ${snapshotKey}: HTTP ${deleteRes.status}`);
        } else {
          const deleteBody = await deleteRes.json();
          if (deleteBody?.error) {
            warn(`[replay] failed to delete read snapshot ${snapshotKey}: ${deleteBody.error}`);
          }
        }
      } catch (err) {
        warn(`[replay] failed to delete read snapshot ${snapshotKey}: ${err?.message ?? err}`);
      }
    }
  }
}

/**
 * Live-Redis fetch path. SCANs all replay-log keys, pages each list,
 * deserialises records, returns the flat record array. Bounded by
 * --days; defaults to 14.
 *
 * @param {object} args  — output of parseArgs
 * @returns {Promise<ReplayRecord[]>}
 */
export async function fetchRecords(args, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = opts.url ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = opts.token ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  const warn = opts.warn ?? ((...args) => console.warn(...args));
  const nowMs = opts.nowMs ?? Date.now();
  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set');
  }

  const cutoffMs = nowMs - args.days * 24 * 60 * 60 * 1000;
  const matchPattern = args.rule
    ? `${REPLAY_KEY_PREFIX}:${args.rule}:*`
    : `${REPLAY_KEY_PREFIX}:*`;

  /** @type {string[]} */
  const allKeys = [];
  let cursor = '0';
  do {
    const scanRes = await fetchImpl(`${url}/scan/${cursor}/match/${encodeURIComponent(matchPattern)}/count/${SCAN_PAGE_SIZE}`, {
      ...replayRequestInit(token),
    });
    if (!scanRes.ok) {
      throw new Error(`SCAN failed: ${scanRes.status} ${scanRes.statusText}`);
    }
    const body = await scanRes.json();
    if (body?.error) {
      throw new Error(`SCAN rejected by Upstash: ${body.error}`);
    }
    const result = Array.isArray(body?.result) ? body.result : null;
    if (!result || result.length < 2) break;
    cursor = String(result[0]);
    const keys = Array.isArray(result[1]) ? result[1] : [];
    for (const k of keys) {
      if (typeof k === 'string') allKeys.push(k);
    }
  } while (cursor !== '0');

  // Filter keys by date suffix to honour --days. Key shape:
  //   digest:replay-log:v1:{ruleId}:{YYYY-MM-DD}
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);
  const eligibleKeys = allKeys.filter((k) => {
    const dateSuffix = k.slice(-10);
    return /^\d{4}-\d{2}-\d{2}$/.test(dateSuffix) && dateSuffix >= cutoffDate;
  });

  if (eligibleKeys.length === 0) {
    return [];
  }

  /** @type {ReplayRecord[]} */
  const records = [];
  let failedKeys = 0;
  for (const key of eligibleKeys) {
    /** @type {string[]} */
    let list;
    try {
      list = await readReplayListPaged(url, token, key, { fetchImpl, warn });
    } catch (err) {
      // Keep the legacy per-key skip so one bad day doesn't abort a run,
      // but the message now carries the real reason (previously an
      // oversized-result rejection arrived as HTTP 200 and was silently
      // read as an empty day).
      failedKeys++;
      warn(`[replay] ${err?.message ?? err}; continuing`);
      continue;
    }
    for (const item of list) {
      try {
        const parsed = JSON.parse(item);
        records.push(parsed);
      } catch (err) {
        warn(`[replay] failed to parse record in ${key}: ${err?.message ?? err}`);
      }
    }
  }
  if (failedKeys > 0) {
    // Without this the caller's "no records returned. Verify
    // DIGEST_DEDUP_REPLAY_LOG=1" message blames the flag for what is
    // actually a read failure.
    warn(
      `[replay] ${failedKeys} of ${eligibleKeys.length} day keys failed to read — `
      + 'coverage below is incomplete and NOT evidence the flag was off',
    );
  }
  return records;
}

async function mainCli() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  console.log(`[replay] fetching last ${args.days} days of replay-log records${args.rule ? ` for rule=${args.rule}` : ''}…`);
  const records = await fetchRecords(args);
  if (records.length === 0) {
    console.error('[replay] no records returned. Verify DIGEST_DEDUP_REPLAY_LOG=1 has been on for the requested window.');
    process.exit(2);
  }

  const aggregate = aggregateReplayDecisions(records, {
    minDaysCovered: args.days,
    allowShortCoverage: args.allowShortCoverage,
  });

  const md = renderMarkdownSummary(aggregate);
  console.log('\n' + md + '\n');

  const fs = await import('node:fs/promises');
  const outPath = `/tmp/replay-digest-cooldown-${new Date().toISOString().slice(0, 10)}.json`;
  await fs.writeFile(outPath, JSON.stringify(aggregate, null, 2), 'utf8');
  console.log(`[replay] full JSON aggregate written to ${outPath}`);
  process.exit(0);
}

// Only run the CLI when invoked directly. Tests import the pure helpers.
const isMainModule = typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && process.argv[1]
  && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  mainCli().catch((err) => {
    console.error('[replay] fatal:', err?.stack ?? err);
    process.exit(3);
  });
}
