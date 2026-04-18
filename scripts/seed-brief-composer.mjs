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
import { readRawJsonFromUpstash } from '../api/_upstash-json.js';
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

// ── Upstash helpers ──────────────────────────────────────────────────────────

async function upstashSetex(key, value, ttlSeconds) {
  const res = await fetch(
    `${UPSTASH_URL}/setex/${encodeURIComponent(key)}/${ttlSeconds}/${encodeURIComponent(JSON.stringify(value))}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'User-Agent': 'worldmonitor-brief-composer/1.0',
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    throw new Error(`Upstash SETEX failed for ${key}: HTTP ${res.status}`);
  }
  return res.json();
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

// ── User-name lookup (best effort) ───────────────────────────────────────────

function userDisplayNameFromId(userId) {
  // Clerk IDs look like "user_2abc..." — not display-friendly. Phase
  // 3b will hydrate names via a Convex query; Phase 3a uses a
  // generic "you" so the greeting still reads naturally without a
  // round-trip we don't yet need.
  void userId;
  return 'Reader';
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

  let success = 0;
  let skippedEmpty = 0;
  let failed = 0;

  for (const rule of rules) {
    if (shuttingDown) break;
    try {
      if (!rule.aiDigestEnabled) {
        // User opted out of AI-generated content; brief stays silent
        // until they opt in. Matches the plan's gating story.
        continue;
      }
      const sensitivity = rule.sensitivity ?? 'all';
      const tz = rule.digestTimezone ?? 'UTC';
      const issueDate = issueDateInTz(startMs, tz);

      const stories = filterTopStories({
        stories: insights.topStories,
        sensitivity,
        maxStories: MAX_STORIES_PER_USER,
      });
      if (stories.length === 0) {
        skippedEmpty += 1;
        continue;
      }

      const envelope = assembleStubbedBriefEnvelope({
        user: { name: userDisplayNameFromId(rule.userId), tz },
        stories,
        issueDate,
        dateLong: dateLongFromIso(issueDate),
        issue: issueCodeFromIso(issueDate),
        insightsNumbers: insights.numbers,
        issuedAt: Date.now(),
        localHour: localHourInTz(startMs, tz),
      });

      const key = `brief:${rule.userId}:${issueDate}`;
      await upstashSetex(key, envelope, BRIEF_TTL_SECONDS);
      success += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[brief-composer] failed for user=${rule.userId} variant=${rule.variant}:`,
        err.message,
      );
    }
  }

  const durationMs = Date.now() - startMs;
  console.log(
    `[brief-composer] Done: success=${success} skipped_empty=${skippedEmpty} failed=${failed} duration_ms=${durationMs}`,
  );

  if (failed > 0 && failed >= Math.max(1, Math.floor(rules.length * 0.05))) {
    // More than 5% of rules failed — exit non-zero so Railway flags
    // the run. A single transient composer error should not surface,
    // but structural bugs (auth break, shape drift) should.
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[brief-composer] fatal:', err);
  process.exit(1);
});
