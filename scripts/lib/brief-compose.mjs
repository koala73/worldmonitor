// WorldMonitor Brief compose library.
//
// Pure helpers for producing the per-user brief envelope that the
// hosted magazine route (api/brief/*) + dashboard panel + future
// channels all consume. Shared between:
//   - scripts/seed-digest-notifications.mjs (the consolidated cron;
//     composes a brief for every user it's about to dispatch a
//     digest to, so the magazine URL can be injected into the
//     notification output).
//   - future tests + ad-hoc tools.
//
// Deliberately has NO top-level side effects: no env guards, no
// process.exit, no main(). Import anywhere.
//
// History: this file used to include a stand-alone Railway cron
// (`seed-brief-composer.mjs`). That path was retired in the
// consolidation PR — the digest cron now owns the compose+send
// pipeline so there is exactly one cron writing brief:{userId}:
// {issueDate} keys.

import {
  assembleStubbedBriefEnvelope,
  filterTopStories,
  issueDateInTz,
} from '../../shared/brief-filter.js';

// ── Rule dedupe (one brief per user, not per variant) ───────────────────────

const SENSITIVITY_RANK = { all: 0, high: 1, critical: 2 };

function compareRules(a, b) {
  const aFull = a.variant === 'full' ? 0 : 1;
  const bFull = b.variant === 'full' ? 0 : 1;
  if (aFull !== bFull) return aFull - bFull;
  // Default missing sensitivity to 'high' (NOT 'all') so the rank
  // matches what compose/buildDigest/cache/log actually treat the
  // rule as. Otherwise a legacy undefined-sensitivity rule would be
  // ranked as the most-permissive 'all' and tried first, but compose
  // would then apply a 'high' filter — shipping a narrow brief while
  // an explicit 'all' rule for the same user is never tried.
  // See PR #3387 review (P2).
  const aRank = SENSITIVITY_RANK[a.sensitivity ?? 'high'] ?? 0;
  const bRank = SENSITIVITY_RANK[b.sensitivity ?? 'high'] ?? 0;
  if (aRank !== bRank) return aRank - bRank;
  return (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
}

/**
 * Group eligible (not-opted-out) rules by userId with each user's
 * candidates sorted in preference order. Callers walk the candidate
 * list and take the first that produces non-empty stories — falls
 * back across variants cleanly.
 */
export function groupEligibleRulesByUser(rules) {
  const byUser = new Map();
  for (const rule of rules) {
    if (!rule || typeof rule.userId !== 'string') continue;
    if (rule.aiDigestEnabled === false) continue;
    const list = byUser.get(rule.userId);
    if (list) list.push(rule);
    else byUser.set(rule.userId, [rule]);
  }
  for (const list of byUser.values()) list.sort(compareRules);
  return byUser;
}

/**
 * @deprecated Kept for existing test imports. Prefer
 * groupEligibleRulesByUser + per-user fallback at call sites.
 */
export function dedupeRulesByUser(rules) {
  const out = [];
  for (const candidates of groupEligibleRulesByUser(rules).values()) {
    if (candidates.length > 0) out.push(candidates[0]);
  }
  return out;
}

// ── Failure gate ─────────────────────────────────────────────────────────────

/**
 * Decide whether the consolidated cron should exit non-zero because
 * the brief-write failure rate is structurally bad (not just a
 * transient blip). Denominator is ATTEMPTED writes, not eligible
 * users: skipped-empty users never reach the write path and must not
 * dilute the ratio.
 *
 * @param {{ success: number; failed: number; thresholdRatio?: number }} counters
 */
export function shouldExitNonZero({ success, failed, thresholdRatio = 0.05 }) {
  if (failed <= 0) return false;
  const attempted = success + failed;
  if (attempted <= 0) return false;
  const threshold = Math.max(1, Math.floor(attempted * thresholdRatio));
  return failed >= threshold;
}

// ── Insights fetch ───────────────────────────────────────────────────────────

/** Unwrap news:insights:v1 envelope and project the fields the brief needs. */
export function extractInsights(raw) {
  const data = raw?.data ?? raw;
  const topStories = Array.isArray(data?.topStories) ? data.topStories : [];
  const clusterCount = Number.isFinite(data?.clusterCount) ? data.clusterCount : topStories.length;
  const multiSourceCount = Number.isFinite(data?.multiSourceCount) ? data.multiSourceCount : 0;
  return {
    topStories,
    numbers: { clusters: clusterCount, multiSource: multiSourceCount },
  };
}

// ── Date + display helpers ───────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function dateLongFromIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

export function issueCodeFromIso(iso) {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

export function localHourInTz(nowMs, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    const hour = fmt.formatToParts(new Date(nowMs)).find((p) => p.type === 'hour')?.value;
    const n = Number(hour);
    return Number.isFinite(n) ? n : 9;
  } catch {
    return 9;
  }
}

export function userDisplayNameFromId(userId) {
  // Clerk IDs look like "user_2abc…". Phase 3b will hydrate real
  // names via a Convex query; for now a generic placeholder so the
  // magazine's greeting reads naturally.
  void userId;
  return 'Reader';
}

// ── Compose a full brief for a single rule ──────────────────────────────────

const MAX_STORIES_PER_USER = 12;

/**
 * Filter + assemble a BriefEnvelope for one alert rule from a
 * prebuilt upstream top-stories list (news:insights:v1 shape).
 *
 * @deprecated The live path is composeBriefFromDigestStories(), which
 *   reads from the same digest:accumulator pool as the email. This
 *   entry point is kept only for tests that stub a news:insights payload
 *   directly — real runs would ship a brief with a different story
 *   list than the email and should use the digest-stories path.
 *
 * @param {object} rule — enabled alertRule row
 * @param {{ topStories: unknown[]; numbers: { clusters: number; multiSource: number } }} insights
 * @param {{ nowMs: number }} [opts]
 */
export function composeBriefForRule(rule, insights, { nowMs = Date.now() } = {}) {
  // Default to 'high' (NOT 'all') for parity with composeBriefFromDigestStories,
  // buildDigest, the digestFor cache key, and the per-attempt log line.
  // See PR #3387 review (P2).
  const sensitivity = rule.sensitivity ?? 'high';
  const tz = rule.digestTimezone ?? 'UTC';
  const stories = filterTopStories({
    stories: insights.topStories,
    sensitivity,
    maxStories: MAX_STORIES_PER_USER,
  });
  if (stories.length === 0) return null;
  const issueDate = issueDateInTz(nowMs, tz);
  return assembleStubbedBriefEnvelope({
    user: { name: userDisplayNameFromId(rule.userId), tz },
    stories,
    issueDate,
    dateLong: dateLongFromIso(issueDate),
    issue: issueCodeFromIso(issueDate),
    insightsNumbers: insights.numbers,
    // Same nowMs as the rest of the envelope so the function stays
    // deterministic for a given input — tests + retries see identical
    // output.
    issuedAt: nowMs,
    localHour: localHourInTz(nowMs, tz),
  });
}

// ── Compose from digest-accumulator stories (the live path) ─────────────────

// RSS titles routinely end with " - <Publisher>" / " | <Publisher>" /
// " — <Publisher>" (Google News normalised form + most major wires).
// Leaving the suffix in place means the brief headline reads like
// "... as Iran reimposes restrictions - AP News" instead of "... as
// Iran reimposes restrictions", and the source attribution underneath
// ends up duplicated. We strip the suffix ONLY when it matches the
// primarySource we're about to attribute anyway — so we never strip
// a real subtitle that happens to look like "foo - bar".
const HEADLINE_SUFFIX_RE_PART = /\s+[-\u2013\u2014|]\s+([^\s].*)$/;

/**
 * @param {string} title
 * @param {string} publisher
 * @returns {string}
 */
export function stripHeadlineSuffix(title, publisher) {
  if (typeof title !== 'string' || title.length === 0) return '';
  if (typeof publisher !== 'string' || publisher.length === 0) return title.trim();
  const trimmed = title.trim();
  const m = trimmed.match(HEADLINE_SUFFIX_RE_PART);
  if (!m) return trimmed;
  const tail = m[1].trim();
  // Case-insensitive full-string match. We're conservative: only strip
  // when the tail EQUALS the publisher — a tail that merely contains
  // it (e.g. "- AP News analysis") is editorial content and stays.
  if (tail.toLowerCase() !== publisher.toLowerCase()) return trimmed;
  return trimmed.slice(0, m.index).trimEnd();
}

/**
 * Adapter: the digest accumulator hydrates stories from
 * story:track:v1:{hash} (title / link / severity / lang / score /
 * mentionCount / description?) + story:sources:v1:{hash} SMEMBERS. It
 * does NOT carry a category or country-code — those fields are optional
 * in the upstream brief-filter shape and default cleanly.
 *
 * Since envelope v2, the story's `link` field is carried through as
 * `primaryLink` so filterTopStories can emit a BriefStory.sourceUrl.
 * Stories without a valid link are still passed through here — the
 * filter drops them at the validation boundary rather than this adapter.
 *
 * Description plumbing (post RSS-description fix, 2026-04-24):
 *   When the ingested story:track row carries a cleaned RSS description,
 *   it rides here as `s.description` and becomes the brief's baseline
 *   description. When absent (old rows inside the 48h bleed, or feeds
 *   without a description), we fall back to the cleaned headline —
 *   preserving today's behavior and letting Phase 3b's LLM enrichment
 *   still operate over something, not nothing.
 *
 * @param {object} s — digest-shaped story from buildDigest()
 */
function digestStoryToUpstreamTopStory(s) {
  const sources = Array.isArray(s?.sources) ? s.sources : [];
  const primarySource = sources.length > 0 ? sources[0] : 'Multiple wires';
  const rawTitle = typeof s?.title === 'string' ? s.title : '';
  const cleanTitle = stripHeadlineSuffix(rawTitle, primarySource);
  const rawDescription = typeof s?.description === 'string' ? s.description.trim() : '';
  return {
    primaryTitle: cleanTitle,
    // When upstream persists a real RSS description (via story:track:v1
    // post-fix), forward it; otherwise fall back to the cleaned headline
    // so downstream consumers (brief filter, Phase 3b LLM) always have
    // something to ground on.
    description: rawDescription || cleanTitle,
    primarySource,
    primaryLink: typeof s?.link === 'string' ? s.link : undefined,
    threatLevel: s?.severity,
    // story:track:v1 carries neither field, so the brief falls back
    // to 'General' / 'Global' via filterTopStories defaults.
    category: typeof s?.category === 'string' ? s.category : undefined,
    countryCode: typeof s?.countryCode === 'string' ? s.countryCode : undefined,
  };
}

/**
 * Compose a BriefEnvelope from a per-rule digest-accumulator pool
 * (same stories the email digest uses), plus global insights numbers
 * for the stats page.
 *
 * Returns null when no story survives the sensitivity filter — caller
 * falls back to another variant or skips the user.
 *
 * @param {object} rule — enabled alertRule row
 * @param {unknown[]} digestStories — output of buildDigest(rule, windowStart)
 * @param {{ clusters: number; multiSource: number }} insightsNumbers
 * @param {{ nowMs?: number, onDrop?: import('../../shared/brief-filter.js').DropMetricsFn }} [opts]
 *   `onDrop` is forwarded to filterTopStories so the seeder can
 *   aggregate per-user filter-drop counts without this module knowing
 *   how they are reported.
 */
export function composeBriefFromDigestStories(rule, digestStories, insightsNumbers, { nowMs = Date.now(), onDrop } = {}) {
  if (!Array.isArray(digestStories) || digestStories.length === 0) return null;
  // Default to 'high' (NOT 'all') for undefined sensitivity, aligning
  // with buildDigest at scripts/seed-digest-notifications.mjs:392 and
  // the digestFor cache key. The live cron path pre-filters the pool
  // to {critical, high}, so this default is a no-op for production
  // calls — but a non-prefiltered caller with undefined sensitivity
  // would otherwise silently widen to {medium, low} stories while the
  // operator log labels the attempt as 'high', misleading telemetry.
  // See PR #3387 review (P2) and Defect 2 / Solution 1 in
  // docs/plans/2026-04-24-004-fix-brief-topic-adjacency-defects-plan.md.
  const sensitivity = rule.sensitivity ?? 'high';
  const tz = rule.digestTimezone ?? 'UTC';
  const upstreamLike = digestStories.map(digestStoryToUpstreamTopStory);
  const stories = filterTopStories({
    stories: upstreamLike,
    sensitivity,
    maxStories: MAX_STORIES_PER_USER,
    onDrop,
  });
  if (stories.length === 0) return null;
  const issueDate = issueDateInTz(nowMs, tz);
  return assembleStubbedBriefEnvelope({
    user: { name: userDisplayNameFromId(rule.userId), tz },
    stories,
    issueDate,
    dateLong: dateLongFromIso(issueDate),
    issue: issueCodeFromIso(issueDate),
    insightsNumbers,
    issuedAt: nowMs,
    localHour: localHourInTz(nowMs, tz),
  });
}
