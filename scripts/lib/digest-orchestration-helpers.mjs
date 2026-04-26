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
 * Single source of truth for the digest's story window. Used by BOTH
 * the compose path (digestFor closure in the cron) and the send loop.
 * Without this, the brief lead can be synthesized from a 24h pool
 * while the channel body ships 7d / 12h of stories — reintroducing
 * the cross-surface divergence the canonical-brain refactor is meant
 * to eliminate, just in a different shape.
 *
 * `lastSentAt` is the rule's previous successful send timestamp (ms
 * since epoch) or null on first send. `defaultLookbackMs` is the
 * first-send fallback (today: 24h).
 *
 * @param {number | null | undefined} lastSentAt
 * @param {number} nowMs
 * @param {number} defaultLookbackMs
 * @returns {number}
 */
export function digestWindowStartMs(lastSentAt, nowMs, defaultLookbackMs) {
  return lastSentAt ?? (nowMs - defaultLookbackMs);
}

/**
 * Walk an annotated rule list and return the winning candidate +
 * its non-empty story pool. Two-pass: due rules first (so the
 * synthesis comes from a rule that's actually sending), then ALL
 * eligible rules (compose-only tick — keeps the dashboard brief
 * fresh for weekly/twice_daily users). Within each pass, walk by
 * compareRules priority and pick the FIRST candidate whose pool is
 * non-empty AND survives `tryCompose` (when provided).
 *
 * Returns null when every candidate is rejected — caller skips the
 * user (same as today's behavior on empty-pool exhaustion).
 *
 * Plan acceptance criteria A6.l (compose-only tick still works for
 * weekly user) + A6.m (winner walks past empty-pool top-priority
 * candidate). Codex Round-3 High #1 + Round-4 High #1 + Round-4
 * Medium #2.
 *
 * `tryCompose` (optional): called with `(cand, stories)` after a
 * non-empty pool is found. Returning a truthy value claims the
 * candidate as winner and the value is forwarded as `composeResult`.
 * Returning a falsy value (e.g. composeBriefFromDigestStories
 * dropped every story via its URL/headline/shape filters) walks to
 * the next candidate. Without this callback, the helper preserves
 * the original "first non-empty pool wins" semantics, which let a
 * filter-rejected top-priority candidate suppress the brief for the
 * user even when a lower-priority candidate would have shipped one.
 *
 * `digestFor` receives the full annotated candidate (not just the
 * rule) so callers can derive a per-candidate story window from
 * `cand.lastSentAt` — see `digestWindowStartMs`.
 *
 * `log` is the per-rejected-candidate log emitter — passed in so
 * tests can capture lines without reaching for console.log.
 *
 * @param {Array<{ rule: object; lastSentAt: number | null; due: boolean }>} annotated
 * @param {(cand: { rule: object; lastSentAt: number | null; due: boolean }) => Promise<unknown[] | null | undefined>} digestFor
 * @param {(line: string) => void} log
 * @param {string} userId
 * @param {((cand: { rule: object; lastSentAt: number | null; due: boolean }, stories: unknown[]) => Promise<unknown> | unknown)} [tryCompose]
 * @returns {Promise<{ winner: { rule: object; lastSentAt: number | null; due: boolean }; stories: unknown[]; composeResult?: unknown } | null>}
 */
export async function pickWinningCandidateWithPool(annotated, digestFor, log, userId, tryCompose) {
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
    const stories = await digestFor(cand);
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
    if (typeof tryCompose === 'function') {
      const composeResult = await tryCompose(cand, stories);
      if (!composeResult) {
        log(
          `[digest] brief filter drops user=${userId} ` +
            `sensitivity=${cand.rule.sensitivity ?? 'high'} ` +
            `variant=${cand.rule.variant ?? 'full'} ` +
            `due=${cand.due} ` +
            `outcome=filter-rejected ` +
            `in=${stories.length} out=0`,
        );
        continue;
      }
      return { winner: cand, stories, composeResult };
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

/**
 * READ-time freshness predicate. Returns true if the story:track:v1 row
 * should be dropped because its source `publishedAt` is older than the
 * cutoff. Used by buildDigest to keep pre-deploy residue (whose ingest
 * gate has since been tightened) from shipping in briefs.
 *
 * Behaviour matrix:
 *   - publishedAt is a positive integer epoch-ms AND < cutoff → drop (true).
 *   - publishedAt is a positive integer epoch-ms AND ≥ cutoff → keep (false).
 *   - publishedAt is missing/unparseable/zero/negative → keep (false).
 *
 * The "missing → keep" branch is back-compat for legacy story:track:v1
 * rows written before publishedAt was persisted. Pre-deploy residue
 * with no publishedAt is NOT caught here — handle it via the audit
 * script's `--mode=residue` (one-shot eviction). Once that has run AND
 * ≥1 cron cycle has refreshed publishedAt on still-active rows, any
 * row reaching this predicate without publishedAt is anomalous, not
 * residue.
 *
 * See: skill ingest-gate-tightening-leaves-residue-in-read-path.
 *
 * @param {Record<string, string> | null | undefined} track
 * @param {number} ageCutoffMs — drop rows with publishedAt strictly less than this
 * @returns {boolean}
 */
export function shouldDropTrackByAge(track, ageCutoffMs) {
  const pubMs = Number.parseInt(track?.publishedAt ?? '', 10);
  if (!Number.isInteger(pubMs) || pubMs <= 0) return false;
  return pubMs < ageCutoffMs;
}

/**
 * Compute the READ-time freshness cutoff for a given digest window.
 * Cutoff is anchored to `windowStartMs` (from `digestWindowStartMs`)
 * minus a 24h buffer that accommodates sustained stories whose first
 * mention sits just before the window edge.
 *
 * Daily user (24h window) → 48h-ago cutoff.
 * Weekly user (7d window) → 8d-ago cutoff.
 *
 * @param {number} windowStartMs
 * @returns {number}
 */
export function readTimeAgeCutoffMs(windowStartMs) {
  const STALE_BUFFER_MS = 24 * 60 * 60 * 1000;
  return windowStartMs - STALE_BUFFER_MS;
}
