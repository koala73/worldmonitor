#!/usr/bin/env node
/**
 * WorldMonitor Brief composer — Railway cron.
 *
 * Phase 3a of docs/plans/2026-04-17-003-feat-worldmonitor-brief-
 * magazine-plan.md. Produces the per-user envelopes that Phases 1+2
 * already know how to serve; Phase 3b will replace the stubbed
 * digest text with LLM output.
 *
 * Per run:
 *   1. Fetch the global news-intelligence bundle once.
 *   2. Ask Convex for every enabled alert-rule with digestMode set.
 *      This matches the eligibility set already used by
 *      seed-digest-notifications — brief access is free-riding on
 *      the digest opt-in.
 *   3. For each rule:
 *        - Compute issueDate from rule.digestTimezone.
 *        - Filter insights.topStories by rule.sensitivity.
 *        - Assemble a BriefEnvelope with stubbed digest text.
 *        - SETEX brief:{userId}:{issueDate} with a 7-day TTL.
 *   4. Log per-status counters (success / skipped_empty / failed).
 *
 * The script is idempotent within a day: re-running overwrites the
 * same key with the same envelope (modulo issuedAt). Phase 3c adds
 * fan-out events on first-write only.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readRawJsonFromUpstash, redisPipeline } from '../api/_upstash-json.js';
import {
  assembleStubbedBriefEnvelope,
  filterTopStories,
  issueDateInTz,
} from '../shared/brief-filter.js';

const require = createRequire(import.meta.url);

// ── Config ────────────────────────────────────────────────────────────────────

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';
const CONVEX_SITE_URL =
  process.env.CONVEX_SITE_URL ??
  (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
const RELAY_SECRET = process.env.RELAY_SHARED_SECRET ?? '';

const BRIEF_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MAX_STORIES_PER_USER = 12;
const INSIGHTS_KEY = 'news:insights:v1';

// ── Upstash helpers ──────────────────────────────────────────────────────────

/**
 * Write the brief envelope via the Upstash REST pipeline endpoint
 * (body-POST), not the path-embedded SETEX form. Realistic briefs
 * (12 stories, per-story description + whyMatters near caps) encode
 * to 5–20 KB of JSON; URL-encoding inflates that further and can hit
 * CDN / edge / Node HTTP request-target limits (commonly 8–16 KB).
 * `redisPipeline` places the command in a JSON body where size
 * limits are generous and uniform with the rest of the codebase's
 * Upstash writes.
 */
async function upstashSetex(key, value, ttlSeconds) {
  const results = await redisPipeline([
    ['SETEX', key, String(ttlSeconds), JSON.stringify(value)],
  ]);
  if (!results || !Array.isArray(results) || results.length === 0) {
    throw new Error(`Upstash SETEX failed for ${key}: null pipeline response`);
  }
  const result = results[0];
  // Upstash pipeline returns either {result} or {error} per command.
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`Upstash SETEX failed for ${key}: ${result.error}`);
  }
  return result;
}

// ── Date helpers ─────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function dateLongFromIso(iso) {
  // iso is YYYY-MM-DD. Parse literally to avoid tz drift.
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

function issueCodeFromIso(iso) {
  // "2026-04-18" → "18.04"
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

function localHourInTz(nowMs, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    const hour = fmt.formatToParts(new Date(nowMs))
      .find((p) => p.type === 'hour')?.value;
    const n = Number(hour);
    return Number.isFinite(n) ? n : 9;
  } catch {
    return 9;
  }
}

// ── Convex helpers ───────────────────────────────────────────────────────────

async function fetchDigestRules() {
  const res = await fetch(`${CONVEX_SITE_URL}/relay/digest-rules`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${RELAY_SECRET}`,
      'User-Agent': 'worldmonitor-brief-composer/1.0',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch digest rules: HTTP ${res.status}`);
  }
  const rules = await res.json();
  if (!Array.isArray(rules)) {
    throw new Error('digest-rules response was not an array');
  }
  return rules;
}

// ── Failure gate ─────────────────────────────────────────────────────────────

/**
 * Decide whether the cron should exit non-zero so Railway flags the
 * run. Denominator is ATTEMPTED writes (success + failed); skipped-
 * empty users never reached the write path and must not inflate it.
 * Exported so the denominator contract is testable without mocking
 * Redis + LLM + the whole cron.
 *
 * @param {{ success: number; failed: number; thresholdRatio?: number }} counters
 * @returns {boolean}
 */
export function shouldExitNonZero({ success, failed, thresholdRatio = 0.05 }) {
  if (failed <= 0) return false;
  const attempted = success + failed;
  if (attempted <= 0) return false;
  const threshold = Math.max(1, Math.floor(attempted * thresholdRatio));
  return failed >= threshold;
}

// ── User-name lookup (best effort) ───────────────────────────────────────────

function userDisplayNameFromId(userId) {
  // Clerk IDs look like "user_2abc..." — not display-friendly. Phase
  // 3b will hydrate names via a Convex query; Phase 3a uses a
  // generic "you" so the greeting still reads naturally without a
  // round-trip we don't yet need.
  void userId;
  return 'Reader';
}

// ── Rule dedupe (one brief per user, not per variant) ───────────────────────

// Most-permissive-first ranking. Lower = broader.
const SENSITIVITY_RANK = { all: 0, high: 1, critical: 2 };

function compareRules(a, b) {
  // Prefer the 'full' variant — it's the superset dashboard.
  const aFull = a.variant === 'full' ? 0 : 1;
  const bFull = b.variant === 'full' ? 0 : 1;
  if (aFull !== bFull) return aFull - bFull;
  // Tie-break on most permissive sensitivity (broadest brief).
  const aRank = SENSITIVITY_RANK[a.sensitivity ?? 'all'] ?? 0;
  const bRank = SENSITIVITY_RANK[b.sensitivity ?? 'all'] ?? 0;
  if (aRank !== bRank) return aRank - bRank;
  // Final tie-break: earlier-updated rule wins for determinism.
  return (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
}

/**
 * Group eligible (non-opted-out) rules by userId, with each user's
 * candidates sorted in preference order (best first). Returns an
 * array of `[userId, ranked-candidates[]]` pairs so the main loop
 * can try each variant in order and fall back when the preferred
 * one produces zero stories.
 *
 * aiDigestEnabled is pre-filtered here so a user whose preferred
 * variant is opted out but another variant is opted in still
 * produces a brief — the dedupe must not pick a variant that can
 * never emit.
 */
export function groupEligibleRulesByUser(rules) {
  /** @type {Map<string, any[]>} */
  const byUser = new Map();
  for (const rule of rules) {
    if (!rule || typeof rule.userId !== 'string') continue;
    // Default is OPT-IN — only an explicit false opts the user out.
    if (rule.aiDigestEnabled === false) continue;
    const list = byUser.get(rule.userId);
    if (list) list.push(rule);
    else byUser.set(rule.userId, [rule]);
  }
  for (const list of byUser.values()) {
    list.sort(compareRules);
  }
  return byUser;
}

/**
 * @deprecated Kept so the existing dedupe tests still compile.
 * Prefer groupEligibleRulesByUser + per-user fallback in callers.
 */
export function dedupeRulesByUser(rules) {
  const grouped = groupEligibleRulesByUser(rules);
  const out = [];
  for (const candidates of grouped.values()) {
    if (candidates.length > 0) out.push(candidates[0]);
  }
  return out;
}

// ── Insights fetch ───────────────────────────────────────────────────────────

function extractInsights(raw) {
  // news:insights:v1 is stored as a seed envelope {_seed, data}.
  // readRawJsonFromUpstash intentionally does not unwrap; do so here.
  const data = raw?.data ?? raw;
  const topStories = Array.isArray(data?.topStories) ? data.topStories : [];
  const clusterCount = Number.isFinite(data?.clusterCount) ? data.clusterCount : topStories.length;
  const multiSourceCount = Number.isFinite(data?.multiSourceCount) ? data.multiSourceCount : 0;
  return {
    topStories,
    numbers: {
      clusters: clusterCount,
      multiSource: multiSourceCount,
    },
  };
}

// ── SIGTERM handling ─────────────────────────────────────────────────────────
// Matches the bundle-runner SIGTERM pattern (feedback note
// bundle-runner-sigkill-leaks-child-lock). This script does not take
// a distributed lock, but it does perform many parallel Upstash
// writes; SIGTERM during the loop should flush partial progress
// cleanly instead of throwing mid-fetch.
let shuttingDown = false;
process.on('SIGTERM', () => {
  shuttingDown = true;
  console.log('[brief-composer] SIGTERM received — finishing current iteration');
});

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log('[brief-composer] Run start:', new Date(startMs).toISOString());

  let insightsRaw;
  try {
    insightsRaw = await readRawJsonFromUpstash(INSIGHTS_KEY);
  } catch (err) {
    console.error('[brief-composer] failed to read', INSIGHTS_KEY, err.message);
    process.exit(1);
  }
  if (!insightsRaw) {
    console.warn('[brief-composer] insights key empty; no brief to compose');
    return;
  }

  const insights = extractInsights(insightsRaw);
  if (insights.topStories.length === 0) {
    console.warn('[brief-composer] upstream topStories empty; no brief to compose');
    return;
  }

  let rules;
  try {
    rules = await fetchDigestRules();
  } catch (err) {
    console.error('[brief-composer]', err.message);
    process.exit(1);
  }
  console.log(`[brief-composer] Rules to process: ${rules.length}`);

  // Briefs are user-scoped, but alertRules are (userId, variant)-scoped.
  // Group eligible (not-opted-out) rules by user in preference order
  // so we can fall back across variants when the preferred one can't
  // emit (opt-out on that variant, or zero matching stories).
  const eligibleByUser = groupEligibleRulesByUser(rules);

  let success = 0;
  let skippedEmpty = 0;
  let failed = 0;

  for (const [userId, candidates] of eligibleByUser) {
    if (shuttingDown) break;
    try {
      // Walk preference order; first variant with non-empty stories wins.
      let chosen = null;
      let chosenStories = null;
      for (const candidate of candidates) {
        const sensitivity = candidate.sensitivity ?? 'all';
        const stories = filterTopStories({
          stories: insights.topStories,
          sensitivity,
          maxStories: MAX_STORIES_PER_USER,
        });
        if (stories.length > 0) {
          chosen = candidate;
          chosenStories = stories;
          break;
        }
      }
      if (!chosen) {
        skippedEmpty += 1;
        continue;
      }
      if (candidates.length > 1) {
        console.log(
          `[brief-composer] dedup: userId=${userId} chose variant=${chosen.variant} sensitivity=${chosen.sensitivity ?? 'all'} from ${candidates.length} enabled variants`,
        );
      }

      const tz = chosen.digestTimezone ?? 'UTC';
      const issueDate = issueDateInTz(startMs, tz);
      const envelope = assembleStubbedBriefEnvelope({
        user: { name: userDisplayNameFromId(chosen.userId), tz },
        stories: chosenStories,
        issueDate,
        dateLong: dateLongFromIso(issueDate),
        issue: issueCodeFromIso(issueDate),
        insightsNumbers: insights.numbers,
        issuedAt: Date.now(),
        localHour: localHourInTz(startMs, tz),
      });

      const key = `brief:${chosen.userId}:${issueDate}`;
      await upstashSetex(key, envelope, BRIEF_TTL_SECONDS);
      success += 1;
    } catch (err) {
      failed += 1;
      const variants = candidates.map((c) => c.variant).join(',');
      console.error(
        `[brief-composer] failed for user=${userId} variants=${variants}:`,
        err.message,
      );
    }
  }

  const eligibleUserCount = eligibleByUser.size;
  const attempted = success + failed;
  const durationMs = Date.now() - startMs;
  console.log(
    `[brief-composer] Done: rules=${rules.length} eligible_users=${eligibleUserCount} attempted=${attempted} success=${success} skipped_empty=${skippedEmpty} failed=${failed} duration_ms=${durationMs}`,
  );

  if (shouldExitNonZero({ success, failed })) process.exit(1);
}

// Only run the cron loop when executed as a script, never on import.
// Tests import this file for the dedupe helpers and must not trigger
// process.exit() at module load. Matches feedback_seed_isMain_guard.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isMain()) {
  if (process.env.BRIEF_COMPOSER_ENABLED === '0') {
    console.log('[brief-composer] BRIEF_COMPOSER_ENABLED=0 — skipping run');
    process.exit(0);
  }
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error('[brief-composer] UPSTASH_REDIS_REST_URL/TOKEN not set');
    process.exit(1);
  }
  if (!CONVEX_SITE_URL || !RELAY_SECRET) {
    console.error('[brief-composer] CONVEX_SITE_URL / RELAY_SHARED_SECRET not set');
    process.exit(1);
  }
  main().catch((err) => {
    console.error('[brief-composer] fatal:', err);
    process.exit(1);
  });
}
