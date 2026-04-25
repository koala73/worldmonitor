// Pure helpers for the digest cron's per-user compose loop.
//
// Extracted from scripts/seed-digest-notifications.mjs so they can be
// unit-tested without dragging the cron's env-checking side effects
// (DIGEST_CRON_ENABLED check, Upstash REST helper, Convex relay
// auth) into the test runtime. The cron imports back from here.

import { compareRules, MAX_STORIES_PER_USER } from './brief-compose.mjs';
import { generateDigestProse } from './brief-llm.mjs';

/**
 * Build the email subject string. Extracted so the synthesis-level
 * → subject ternary can be unit-tested without standing up the whole
 * cron loop. (Plan acceptance criterion A6.i.)
 *
 * Rules:
 *   - synthesisLevel 1 or 2 + non-empty briefLead → "Intelligence Brief"
 *   - synthesisLevel 3 OR empty/null briefLead → "Digest"
 *
 * Mirrors today's UX where the editorial subject only appeared when
 * a real LLM-produced lead was available; the L3 stub falls back to
 * the plain "Digest" subject to set reader expectations correctly.
 *
 * @param {{ briefLead: string | null | undefined; synthesisLevel: number; shortDate: string }} input
 * @returns {string}
 */
export function subjectForBrief({ briefLead, synthesisLevel, shortDate }) {
  if (briefLead && synthesisLevel >= 1 && synthesisLevel <= 2) {
    return `WorldMonitor Intelligence Brief — ${shortDate}`;
  }
  return `WorldMonitor Digest — ${shortDate}`;
}

/**
 * Walk an annotated rule list and return the winning candidate +
 * its non-empty story pool. Two-pass: due rules first (so the
 * synthesis comes from a rule that's actually sending), then ALL
 * eligible rules (compose-only tick — keeps the dashboard brief
 * fresh for weekly/twice_daily users). Within each pass, walk by
 * compareRules priority and pick the FIRST candidate whose pool is
 * non-empty.
 *
 * Returns null when every candidate has an empty pool — caller
 * skips the user (same as today's behavior).
 *
 * Plan acceptance criteria A6.l (compose-only tick still works for
 * weekly user) + A6.m (winner walks past empty-pool top-priority
 * candidate). Codex Round-3 High #1 + Round-4 High #1 + Round-4
 * Medium #2.
 *
 * `log` is the per-empty-pool log emitter — passed in so tests can
 * capture lines without reaching for console.log.
 *
 * @param {Array<{ rule: object; lastSentAt: number | null; due: boolean }>} annotated
 * @param {(rule: object) => Promise<unknown[] | null | undefined>} digestFor
 * @param {(line: string) => void} log
 * @param {string} userId
 * @returns {Promise<{ winner: { rule: object; lastSentAt: number | null; due: boolean }; stories: unknown[] } | null>}
 */
export async function pickWinningCandidateWithPool(annotated, digestFor, log, userId) {
  if (!Array.isArray(annotated) || annotated.length === 0) return null;
  const sortedDue = annotated.filter((a) => a.due).sort((a, b) => compareRules(a.rule, b.rule));
  const sortedAll = [...annotated].sort((a, b) => compareRules(a.rule, b.rule));
  // Build the walk order, deduping by rule reference so the same
  // rule isn't tried twice (a due rule appears in both sortedDue
  // and sortedAll).
  const seen = new Set();
  const walkOrder = [];
  for (const cand of [...sortedDue, ...sortedAll]) {
    if (seen.has(cand.rule)) continue;
    seen.add(cand.rule);
    walkOrder.push(cand);
  }
  for (const cand of walkOrder) {
    const stories = await digestFor(cand.rule);
    if (!stories || stories.length === 0) {
      log(
        `[digest] brief filter drops user=${userId} ` +
          `sensitivity=${cand.rule.sensitivity ?? 'high'} ` +
          `variant=${cand.rule.variant ?? 'full'} ` +
          `due=${cand.due} ` +
          `outcome=empty-pool ` +
          `in=0 dropped_severity=0 dropped_url=0 dropped_headline=0 dropped_shape=0 dropped_cap=0 out=0`,
      );
      continue;
    }
    return { winner: cand, stories };
  }
  return null;
}

/**
 * Run the three-level canonical synthesis fallback chain.
 *   L1: full pre-cap pool + ctx (profile, greeting, !public) — canonical.
 *   L2: envelope-sized slice + empty ctx — degraded fallback (mirrors
 *       today's enrichBriefEnvelopeWithLLM behaviour).
 *   L3: null synthesis — caller composes from stub.
 *
 * Returns { synthesis, level } with `synthesis` matching
 * generateDigestProse's output shape (or null on L3) and `level`
 * one of {1, 2, 3}.
 *
 * Pure helper — no I/O beyond the deps.callLLM the inner functions
 * already perform. Errors at L1 propagate to L2; L2 errors propagate
 * to L3 (null/stub). `trace` callback fires per level transition so
 * callers can quantify failure-mode distribution in production logs.
 *
 * Plan acceptance criterion A6.h (3-level fallback triggers).
 *
 * @param {string} userId
 * @param {Array} stories — full pre-cap pool
 * @param {string} sensitivity
 * @param {{ profile: string | null; greeting: string | null }} ctx
 * @param {{ callLLM: Function; cacheGet: Function; cacheSet: Function }} deps
 * @param {(level: 1 | 2 | 3, kind: 'success' | 'fall' | 'throw', err?: unknown) => void} [trace]
 * @returns {Promise<{ synthesis: object | null; level: 1 | 2 | 3 }>}
 */
export async function runSynthesisWithFallback(userId, stories, sensitivity, ctx, deps, trace) {
  const noteTrace = typeof trace === 'function' ? trace : () => {};
  // L1 — canonical
  try {
    const l1 = await generateDigestProse(userId, stories, sensitivity, deps, {
      profile: ctx?.profile ?? null,
      greeting: ctx?.greeting ?? null,
      isPublic: false,
    });
    if (l1) {
      noteTrace(1, 'success');
      return { synthesis: l1, level: 1 };
    }
    noteTrace(1, 'fall');
  } catch (err) {
    noteTrace(1, 'throw', err);
  }
  // L2 — degraded fallback
  try {
    const cappedSlice = (Array.isArray(stories) ? stories : []).slice(0, MAX_STORIES_PER_USER);
    const l2 = await generateDigestProse(userId, cappedSlice, sensitivity, deps);
    if (l2) {
      noteTrace(2, 'success');
      return { synthesis: l2, level: 2 };
    }
    noteTrace(2, 'fall');
  } catch (err) {
    noteTrace(2, 'throw', err);
  }
  // L3 — stub
  noteTrace(3, 'success');
  return { synthesis: null, level: 3 };
}
