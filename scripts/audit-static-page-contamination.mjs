#!/usr/bin/env node
// Ops audit + cleanup for residual contamination in story:track:v1:* and the
// digest accumulator (U6 of docs/plans/2026-04-26-001-fix-brief-static-page-
// contamination-plan.md).
//
// Cleanup modes:
//
//   --mode=url     (default): match by institutional-static-page URL pattern.
//                             Catches direct-RSS pre-ingest entries where
//                             track.link is a real defense.gov / .mil / .int
//                             URL.
//
//   --mode=age     : match by track.publishedAt being older than --max-age-hours
//                    (default 48). Catches entries with a parseable publishedAt
//                    that's stale — works for Google-News-routed entries (whose
//                    track.link is an opaque news.google.com redirect) AND any
//                    other source where the publisher's pubDate is honest.
//                    REQUIRES rows to have publishedAt persisted (PR #3422+).
//
//   --mode=residue : match rows where track.publishedAt is missing/unparseable
//                    AND track.lastSeen is older than --residue-min-stale-hours
//                    (default 192 = 7d + 24h buffer = the maximum supported
//                    digest window per digest-orchestration-helpers.mjs's
//                    weekly-user readTimeAgeCutoffMs). The lastSeen guard is
//                    the safety constraint: a row that was re-mentioned within
//                    any user's digest window — including weekly users at 7d —
//                    is still legitimately ship-able, so deleting it would
//                    drop real stories from a user's brief. Only rows that
//                    are both missing publishedAt AND haven't been touched
//                    in N hours (default 8d) are treated as residue.
//                    Operator runbook: wait ≥24h post-deploy (so still-active
//                    rows have had publishedAt added via HSET re-mention),
//                    then run with default --residue-min-stale-hours=192.
//                    Operators with confidence the fleet is daily-only can
//                    drop to --residue-min-stale-hours=48 for faster cleanup.
//
//   --mode=both    : run url + age. Does NOT include residue (use --mode=residue
//                    explicitly so the operator opts into the destructive scan).
//
// Usage:
//   node scripts/audit-static-page-contamination.mjs                          # dry run, URL mode
//   node scripts/audit-static-page-contamination.mjs --mode=age               # dry run, age mode (48h)
//   node scripts/audit-static-page-contamination.mjs --mode=age --max-age-hours=24
//   node scripts/audit-static-page-contamination.mjs --mode=residue --apply              # one-shot, default 24h staleness gate
//   node scripts/audit-static-page-contamination.mjs --mode=residue --residue-min-stale-hours=48 --apply
//   node scripts/audit-static-page-contamination.mjs --mode=both --apply      # delete by URL OR age signal
//
// Pure-helper coverage lives in tests/url-classifier.test.mjs. The Redis
// scan is mechanical and exercised by manual dry runs — there is no unit
// test for the side-effecting --apply path (would require a Redis double;
// out of scope for this one-shot script).

import { isInstitutionalStaticPage } from './shared/url-classifier.js';
import { getRedisCredentials } from './_seed-utils.mjs';

const VALID_MODES = ['url', 'age', 'residue', 'both'];

export function parseArgs(argv) {
  // Default residueMinStaleHours = 192h = 7d + 24h buffer. Aligns with
  // the maximum supported digest window (weekly users) so residue mode
  // can never delete a row still legitimately ship-able for ANY user.
  // See P2 review on PR #3422 — earlier 24h default would have deleted
  // weekly users' 5d-old stories.
  const args = { mode: 'url', maxAgeHours: 48, residueMinStaleHours: 192, apply: false };
  const unknown = [];
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--mode=')) args.mode = arg.slice('--mode='.length);
    else if (arg.startsWith('--max-age-hours=')) {
      const n = Number.parseInt(arg.slice('--max-age-hours='.length), 10);
      if (Number.isInteger(n) && n > 0) args.maxAgeHours = n;
    } else if (arg.startsWith('--residue-min-stale-hours=')) {
      const n = Number.parseInt(arg.slice('--residue-min-stale-hours='.length), 10);
      if (Number.isInteger(n) && n > 0) args.residueMinStaleHours = n;
    } else {
      // Catch typos like `--mode age` (space instead of equals) or
      // misspelled flags before they silently use the default mode.
      unknown.push(arg);
    }
  }
  if (unknown.length > 0) {
    console.error(`Unknown args: ${unknown.join(' ')}`);
    console.error(`Expected: --mode=${VALID_MODES.join('|')} [--max-age-hours=N] [--residue-min-stale-hours=N] [--apply]`);
    process.exit(2);
  }
  if (!VALID_MODES.includes(args.mode)) {
    console.error(`Unknown --mode=${args.mode}; expected ${VALID_MODES.join('|')}`);
    process.exit(2);
  }
  return args;
}

// Argv-derived state (APPLY, MODE, MAX_AGE_MS) is resolved inside main()
// instead of at module load so unit tests can `import` this file
// without parseArgs running against the test-runner's argv.
const SCAN_PATTERN = 'story:track:v1:*';
const SCAN_BATCH = 100;
const SCAN_TIMEOUT_MS = 15_000;
const HGETALL_BATCH = 25; // pipeline width

async function redisCommand(url, token, command) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis command failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function redisPipeline(url, token, commands) {
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Cursor-based SCAN. Yields batches of matching keys. The 'cursor === 0'
 * termination follows Redis SCAN semantics (returns to 0 when done).
 */
async function* scanKeys(url, token, pattern) {
  let cursor = '0';
  do {
    const resp = await redisCommand(url, token, [
      'SCAN', cursor, 'MATCH', pattern, 'COUNT', String(SCAN_BATCH),
    ]);
    const result = resp.result;
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error(`Unexpected SCAN response shape: ${JSON.stringify(resp)}`);
    }
    cursor = String(result[0]);
    const keys = Array.isArray(result[1]) ? result[1] : [];
    if (keys.length > 0) yield keys;
  } while (cursor !== '0');
}

/**
 * Pipelined HGETALL for a batch of keys. Returns an array aligned with
 * `keys`: each entry is the parsed hash (object) or null on miss.
 */
async function batchHgetAll(url, token, keys) {
  if (keys.length === 0) return [];
  const commands = keys.map((k) => ['HGETALL', k]);
  const responses = await redisPipeline(url, token, commands);
  return responses.map((r) => {
    const result = r?.result;
    if (result == null) return null;
    // Upstash HGETALL response shape varies by client/version:
    //   - Object: { k1: 'v1', k2: 'v2' } — direct.
    //   - Flat array: ['k1', 'v1', 'k2', 'v2', ...] — pair-wise normalize.
    //   - Empty array / empty object: missing key.
    // Object check MUST come before the array check (typeof []  === 'object'
    // too, but Array.isArray distinguishes them); the previous order
    // returned null for object-shape responses before the object branch
    // could ever match, silently missing every contaminated row.
    if (typeof result === 'object' && !Array.isArray(result)) {
      return Object.keys(result).length === 0 ? null : result;
    }
    if (!Array.isArray(result) || result.length === 0) return null;
    const obj = {};
    for (let i = 0; i < result.length - 1; i += 2) {
      obj[result[i]] = result[i + 1];
    }
    return obj;
  });
}

async function batchDel(url, token, keys) {
  if (keys.length === 0) return 0;
  // SREM corresponding story:sources:v1:{hash} for each — the audit
  // deletes both halves of the contamination pair so a future
  // republish won't be blocked by an orphaned sources set.
  const commands = [];
  for (const k of keys) {
    commands.push(['DEL', k]);
    const hash = k.replace(/^story:track:v1:/, '');
    if (hash && hash !== k) {
      commands.push(['DEL', `story:sources:v1:${hash}`]);
    }
  }
  await redisPipeline(url, token, commands);
  return keys.length;
}

function summarizePerHostPath(matches) {
  const hostCounts = new Map();
  const pathPatternCounts = new Map();
  for (const m of matches) {
    try {
      const u = new URL(m.link);
      hostCounts.set(u.hostname, (hostCounts.get(u.hostname) ?? 0) + 1);
      // First two path segments give a useful pattern bucket without
      // exploding cardinality (e.g., '/About' vs '/About/Section-508').
      const segs = u.pathname.split('/').filter(Boolean);
      const bucket = '/' + segs.slice(0, 2).join('/');
      pathPatternCounts.set(bucket, (pathPatternCounts.get(bucket) ?? 0) + 1);
    } catch {
      // Already filtered by isInstitutionalStaticPage; reaching here
      // would be a regression in the classifier.
    }
  }
  const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return { byHost: fmt(hostCounts), byPathPattern: fmt(pathPatternCounts) };
}

/**
 * Pure classifier — exported so tests can exercise the matrix without
 * spinning up the script (which has top-level argv side effects).
 *
 * @param {Record<string, string>} track — flatArrayToObject of HGETALL result
 * @param {{
 *   mode: 'url'|'age'|'residue'|'both',
 *   maxAgeMs: number,
 *   nowMs: number,
 *   residueMinStaleMs?: number,
 * }} opts
 * @returns {string[]} reasons (subset of ['url', 'age', 'residue']) — empty = no match
 */
export function classifyTrack(track, { mode, maxAgeMs, nowMs, residueMinStaleMs }) {
  const reasons = [];
  const link = typeof track?.link === 'string' ? track.link : '';

  if ((mode === 'url' || mode === 'both') && link && isInstitutionalStaticPage(link)) {
    reasons.push('url');
  }

  if (mode === 'age' || mode === 'both') {
    const pubMs = Number.parseInt(track?.publishedAt ?? '', 10);
    if (Number.isInteger(pubMs) && pubMs > 0 && nowMs - pubMs > maxAgeMs) {
      reasons.push('age');
    }
  }

  if (mode === 'residue') {
    // SAFETY-CRITICAL: residue is the only mode that deletes by absence-of-
    // evidence (no publishedAt) rather than evidence-of-staleness. Without
    // a guard, this would delete EVERY pre-PR-3422 row including legitimate
    // weekly-user stories whose 5-7-day-old lastSeen is still well within
    // their digest window.
    //
    // Two conditions required:
    //   1. publishedAt is missing/unparseable (legacy row, never had the
    //      field, OR future write race that left the field empty).
    //   2. lastSeen is older than residueMinStaleMs (default 192h = 7d
    //      buffer = max supported digest window). Aligns with the
    //      readTimeAgeCutoffMs formula in digest-orchestration-helpers.mjs
    //      so residue mode can never delete a row that's still
    //      legitimately ship-able for ANY user (daily, twice-daily,
    //      weekly). Active stories get HSET-touched on every re-mention,
    //      so a row not touched in 8 days is unambiguously abandoned.
    //
    // Defensive fall-throughs: if lastSeen is missing/unparseable, treat
    // the row as if it were touched at epoch (i.e., consider it stale).
    // That's the safer default for residue mode — we're already in an
    // operator-opt-in destructive path; data without lastSeen is anomalous
    // enough that erring toward "evict" is acceptable.
    const pubMs = Number.parseInt(track?.publishedAt ?? '', 10);
    if (Number.isInteger(pubMs) && pubMs > 0) return reasons; // has publishedAt → not residue

    const DEFAULT_RESIDUE_MIN_STALE_MS = 192 * 60 * 60 * 1000; // 8d
    const minStaleMs = residueMinStaleMs ?? DEFAULT_RESIDUE_MIN_STALE_MS;
    const lastSeenMs = Number.parseInt(track?.lastSeen ?? '', 10);
    const lastSeenAge = Number.isInteger(lastSeenMs) && lastSeenMs > 0
      ? nowMs - lastSeenMs
      : Number.POSITIVE_INFINITY; // missing lastSeen → treat as ancient
    if (lastSeenAge >= minStaleMs) {
      reasons.push('residue');
    }
  }

  return reasons;
}

async function main() {
  const ARGS = parseArgs(process.argv.slice(2));
  const APPLY = ARGS.apply;
  const MODE = ARGS.mode;
  const MAX_AGE_MS = ARGS.maxAgeHours * 60 * 60 * 1000;
  const RESIDUE_MIN_STALE_MS = ARGS.residueMinStaleHours * 60 * 60 * 1000;

  const { url, token } = getRedisCredentials();
  const modeAnnotation =
    MODE === 'age' || MODE === 'both'
      ? ` max-age-hours=${ARGS.maxAgeHours}`
      : MODE === 'residue'
        ? ` residue-min-stale-hours=${ARGS.residueMinStaleHours}`
        : '';
  console.log(
    `[audit] mode=${MODE} ${APPLY ? 'APPLY (will DELETE)' : 'DRY RUN'}${modeAnnotation}`,
  );
  console.log(`[audit] scanning ${SCAN_PATTERN}…`);

  const nowMs = Date.now();
  const matches = [];
  let scanned = 0;

  for await (const keyBatch of scanKeys(url, token, SCAN_PATTERN)) {
    scanned += keyBatch.length;
    for (let i = 0; i < keyBatch.length; i += HGETALL_BATCH) {
      const slice = keyBatch.slice(i, i + HGETALL_BATCH);
      const tracks = await batchHgetAll(url, token, slice);
      for (let j = 0; j < slice.length; j++) {
        const key = slice[j];
        const t = tracks[j];
        if (!t || typeof t !== 'object') continue;
        const reasons = classifyTrack(t, {
          mode: MODE,
          maxAgeMs: MAX_AGE_MS,
          nowMs,
          residueMinStaleMs: RESIDUE_MIN_STALE_MS,
        });
        if (reasons.length === 0) continue;
        const pubMs = Number.parseInt(t.publishedAt ?? '', 10);
        const ageH = Number.isInteger(pubMs) && pubMs > 0
          ? Math.round((nowMs - pubMs) / (60 * 60 * 1000))
          : null;
        matches.push({
          key,
          link: t.link ?? '',
          severity: t.severity ?? '?',
          source: t.source ?? '?',
          title: (t.title ?? '').slice(0, 80),
          reasons,
          ageH,
        });
      }
    }
    process.stderr.write(`\r[audit] scanned=${scanned} matched=${matches.length}`);
  }
  process.stderr.write('\n');

  if (matches.length === 0) {
    console.log('[audit] zero contaminated entries — upstream gates working ✓');
    return;
  }

  console.log('');
  console.log(`[audit] matched ${matches.length} contaminated story:track:v1 entries:`);
  for (const m of matches) {
    const reasons = m.reasons.join(',');
    const ageStr = m.ageH != null ? ` age=${m.ageH}h` : '';
    console.log(
      `  [${m.key}] reasons=${reasons}${ageStr} severity=${m.severity} source="${m.source}" url=${m.link}`,
    );
  }

  console.log('');
  // Per-reason rollup so operators can tell URL hits from age hits at a glance.
  const reasonCounts = new Map();
  for (const m of matches) {
    for (const r of m.reasons) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  }
  console.log('[audit] by reason:');
  for (const [r, n] of reasonCounts) console.log(`  ${r.padEnd(8)} ${n}`);

  // Host/path rollup is only meaningful for matches with a parseable URL.
  // Age-only matches with Google News redirect URLs would clutter it
  // (every entry maps to news.google.com), so skip when MODE === 'age'.
  if (MODE !== 'age') {
    const summary = summarizePerHostPath(matches.filter((m) => m.reasons.includes('url')));
    if (summary.byHost.length > 0) {
      console.log('[audit] by host (url-mode matches only):');
      for (const [host, n] of summary.byHost) console.log(`  ${host.padEnd(40)} ${n}`);
      console.log('[audit] by path pattern (url-mode matches only):');
      for (const [pattern, n] of summary.byPathPattern) console.log(`  ${pattern.padEnd(40)} ${n}`);
    }
  }

  if (!APPLY) {
    console.log('');
    console.log('[audit] DRY RUN — pass --apply to delete these keys.');
    return;
  }

  console.log('');
  console.log(`[audit] APPLY: deleting ${matches.length} keys + their story:sources:v1 siblings…`);
  const keysToDelete = matches.map((m) => m.key);
  for (let i = 0; i < keysToDelete.length; i += HGETALL_BATCH) {
    const slice = keysToDelete.slice(i, i + HGETALL_BATCH);
    await batchDel(url, token, slice);
  }
  console.log(`[audit] deleted ${matches.length} contaminated entries.`);
}

// Only run main() when this file is invoked directly (not when imported
// by a unit test). Standard ESM idiom: compare import.meta.url against
// the resolved CLI entry-point.
const isDirectInvocation =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectInvocation) {
  main().catch((err) => {
    console.error('[audit] failed:', err);
    process.exit(1);
  });
}
