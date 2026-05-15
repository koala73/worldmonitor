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
import { sanitizeForPrompt, sanitizeHeadline } from '../../server/_shared/llm-sanitize.js';

// ── Rule dedupe (one brief per user, not per variant) ───────────────────────

const SENSITIVITY_RANK = { all: 0, high: 1, critical: 2 };

// Exported so the cron orchestration's two-pass winner walk
// (sortedDue / sortedAll) can sort each pass identically to how
// `groupEligibleRulesByUser` already orders candidates here. Kept as
// a same-shape function so callers can reuse it without re-deriving
// the priority key.
export function compareRules(a, b) {
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

// Cap on stories shown per user per brief.
//
// Default 12 — kept at the historical value because the offline sweep
// harness (scripts/sweep-topic-thresholds.mjs) showed bumping the cap
// to 16 against 2026-04-24 production replay data DROPPED visible
// quality at the active 0.45 threshold (visible_quality 0.916 → 0.716;
// positions 13-16 are mostly singletons or members of "should-separate"
// clusters at this threshold, so they dilute without helping adjacency).
//
// Env-tunable via DIGEST_MAX_STORIES_PER_USER so future sweep evidence
// (different threshold, different label set, different pool composition)
// can be acted on with a Railway env flip without a redeploy. Any
// invalid / non-positive value falls back to the 12 default.
//
// "Are we getting better" signal: re-run scripts/sweep-topic-thresholds.mjs
// with --cap N before flipping the env, and the daily
// scripts/brief-quality-report.mjs after.
function readMaxStoriesPerUser() {
  const raw = process.env.DIGEST_MAX_STORIES_PER_USER;
  if (raw == null || raw === '') return 12;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 12;
}
// Exported so brief-llm.mjs (buildDigestPrompt + hashDigestInput) can
// slice to the same cap. Hard-coding `slice(0, 12)` there would mean
// the LLM prose only references the first 12 stories even when the
// brief envelope carries more — a quiet mismatch between what the
// reader sees as story cards vs the AI summary above them. Reviewer
// P1 on PR #3389.
export const MAX_STORIES_PER_USER = readMaxStoriesPerUser();

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
 * Wire-name vs feed-name match. Returns true when `tail` is a shorter
 * (or equal) word-boundary prefix of `publisher` — i.e. when the
 * headline ended with the wire-service short name (e.g. "Reuters")
 * but the configured publisher is the longer feed-name expansion
 * (e.g. "Reuters World" / "Reuters Politics"). Strict equality
 * (the v1 implementation) missed this case — observed live on the
 * May 13 brief: "Putin says Russia will deploy new Sarmat nuclear
 * missile this year - Reuters" had publisher "Reuters World" and the
 * strict-equality check passed the suffix to the magazine.
 *
 * The direction is asymmetric ON PURPOSE: we never accept the inverse
 * (publisher word-prefix of tail), because that case admits editorial
 * suffixes like "Story - AP News analysis" — the tail "AP News
 * analysis" extends the publisher "AP News" with an editorial word,
 * not a desk-name suffix, and stripping it would lose real content.
 *
 * Word-boundary requirement (trailing space) prevents "iran" matching
 * "iranian" — only space-delimited extensions ("Reuters" / "Reuters
 * World") succeed.
 *
 * @param {string} tail — already lowercased, trimmed
 * @param {string} publisher — already lowercased, trimmed
 * @returns {boolean}
 */
function isPublisherWordPrefix(tail, publisher) {
  if (tail === publisher) return true;
  if (tail.length >= publisher.length) return false;
  return publisher.startsWith(tail + ' ');
}

// ── Layer 2 helpers (publisher-naming variants) ───────────────────────────
//
// Layer 1's strict word-prefix test misses three structural classes of
// variant between the headline-suffix's publisher form and the configured
// `source` field. All three observed live on the May 15 brief:
//   1. Article insertion — tail "Bulletin of the Atomic Scientists"
//      vs source "Bulletin of Atomic Scientists" (the/no-the).
//   2. Trailing wire-suffix word — tail "BBC News" vs source "BBC".
//   3. Abbreviation ↔ long-form — tail "Department of Justice (.gov)"
//      vs source "DOJ".
//
// Layer 2 adds two source-aware paths after Layer 1:
//   Path 2a — `normalizePublisher` on both sides + the same asymmetric
//             prefix test (handles classes 1, 2, 3).
//   Path 2b — acronym-shape-gated initials equivalence using a separate
//             `tailForInitials` (handles class 3 when source is an
//             explicit ALL-CAPS acronym like DOJ/NPR/AP/BBC).
//
// No source-blind layer. Considered and rejected on Codex review —
// integrity risk (feed-controlled text could force user-visible
// truncation). See docs/plans/2026-05-15-001-fix-headline-suffix-strip-
// publisher-naming-variants-plan.md for the full rationale.

const ARTICLE_TOKENS = new Set(['the', 'a']);

// Wire-suffix tokens stripped ONLY from the trailing position of a
// normalised publisher. Iteratively from the end, never from leading
// or middle positions — stripping globally would corrupt names like
// "Daily Mail", "News Corp", "Press TV", "The Press Democrat".
const WIRE_SUFFIX_TOKENS = new Set([
  'news', 'online', 'press', 'wire', 'daily', 'weekly',
]);

// Connector words allowed inside a publisher-shape tail. Lowercase
// exact match (case-insensitive on the lowercased token).
const PUBLISHER_CONNECTOR_TOKENS = new Set([
  'of', 'the', 'and', 'du', 'de', 'le', 'la', 'el', 'al', 'in', 'for',
]);

// Title-Case token: starts with an uppercase letter, then word chars or
// apostrophe/hyphen. Accepts "BBC", "O'Reilly", "Al-Jazeera", "News".
const TITLE_CASE_TOKEN_RE = /^[A-Z][\w'-]*$/;
// Trailing domain paren: " (.gov)", " (.org)", " (.com)", " (.io)" etc.
const DOMAIN_PAREN_TRAILING_RE = /\s*\(\.\w{2,4}\)\s*$/;
// Explicit acronym shape on the ORIGINAL configured publisher field —
// 1-5 all-uppercase letters, no spaces. Matching on the unaltered
// field is what prevents Title-Case 4-char names like "Time"/"Wired"
// from accidentally activating the initials path.
const PUBLISHER_ACRONYM_RE = /^[A-Z]{1,5}$/;

/**
 * Normalise a publisher-name string for the asymmetric prefix test in
 * Path 2a. Lowercases, strips trailing domain paren, removes article
 * words from any position, removes wire-suffix words ONLY from the
 * trailing position iteratively, then strips non-alphanumerics per
 * token.
 *
 * Trailing-only suffix-strip is load-bearing: stripping `news` / `press`
 * / `daily` from leading or middle positions would corrupt names like
 * "Daily Mail", "News Corp", "Press TV", "The Press Democrat".
 *
 * Used ONLY in Path 2a. Path 2b's initials test uses tailForInitials()
 * which preserves wire-suffix words — the `Press` in "Associated Press"
 * must survive to count toward the AP initials.
 *
 * @param {unknown} s
 * @returns {string}
 */
function normalizePublisher(s) {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim().toLowerCase();
  if (trimmed.length === 0) return '';
  const stripped = trimmed.replace(DOMAIN_PAREN_TRAILING_RE, '');
  let tokens = stripped
    .split(/\s+/)
    .filter((t) => t.length > 0 && !ARTICLE_TOKENS.has(t));
  while (tokens.length > 0 && WIRE_SUFFIX_TOKENS.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  tokens = tokens
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 0);
  return tokens.join(' ');
}

/**
 * Tail normalisation for the initials path (Path 2b). Same as
 * normalizePublisher MINUS the wire-suffix strip — distinct because
 * "Associated Press" must keep `press` so initialsOf yields `ap`, not
 * just `a`. Reusing normalizePublisher here would corrupt the
 * Associated Press → AP / National Public Radio → NPR cases.
 *
 * @param {unknown} s
 * @returns {string}
 */
function tailForInitials(s) {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim().toLowerCase();
  if (trimmed.length === 0) return '';
  const stripped = trimmed.replace(DOMAIN_PAREN_TRAILING_RE, '');
  const tokens = stripped
    .split(/\s+/)
    .filter((t) => t.length > 0 && !ARTICLE_TOKENS.has(t))
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 0);
  return tokens.join(' ');
}

/**
 * First letter of each whitespace-separated token, joined and
 * lowercased, alpha only. Returns '' for empty or all-non-alpha input.
 *
 * @param {string} s
 * @returns {string}
 */
function initialsOf(s) {
  if (typeof s !== 'string' || s.length === 0) return '';
  return s
    .split(/\s+/)
    .map((t) => (t.length > 0 ? t[0] : ''))
    .filter((c) => /^[a-z]$/i.test(c))
    .join('')
    .toLowerCase();
}

/**
 * "Looks like a publisher attribution" shape check on the original tail
 * (post domain-paren strip, pre other normalisation). Every token must
 * be either Title-Case (matches TITLE_CASE_TOKEN_RE) OR a permitted
 * lowercase connector. Token cap of 8 keeps the function focused on
 * filtering editorial fragments, not enforcing publisher length.
 *
 * Used in Path 2b as the second of two gates on the initials path; the
 * first gate is the all-uppercase acronym check on the original
 * publisher field. Together they block both editorial-text false
 * positives (lowercase tokens fail this gate) and ordinary-Title-Case-
 * publisher false positives (`Time`/`Wired` configured as source fail
 * the acronym gate).
 *
 * @param {unknown} s
 * @returns {boolean}
 */
function looksLikePublisherShape(s) {
  if (typeof s !== 'string') return false;
  const stripped = s.trim().replace(DOMAIN_PAREN_TRAILING_RE, '');
  if (stripped.length === 0) return false;
  const tokens = stripped.split(/\s+/);
  if (tokens.length === 0 || tokens.length > 8) return false;
  for (const tok of tokens) {
    if (TITLE_CASE_TOKEN_RE.test(tok)) continue;
    if (PUBLISHER_CONNECTOR_TOKENS.has(tok.toLowerCase())) continue;
    return false;
  }
  return true;
}

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
  const stripped = trimmed.slice(0, m.index).trimEnd();
  // Layer 1: existing strict asymmetric word-prefix test (load-bearing
  // PR #3673 protection — tail must be a SHORTER prefix of publisher).
  // Stripping "AP News analysis" against "AP News" is REJECTED here,
  // and Layer 2 below preserves the same asymmetry.
  if (isPublisherWordPrefix(tail.toLowerCase(), publisher.toLowerCase())) {
    return stripped;
  }
  // Layer 2 — Path 2a: source-aware fuzzy match via normalised
  // asymmetric prefix. normalizePublisher strips articles globally and
  // wire-suffix words trailing-only, so "Bulletin of the Atomic
  // Scientists" matches "Bulletin of Atomic Scientists" and "BBC News"
  // matches "BBC" — without mangling "Daily Mail" or "News Corp".
  const normTail = normalizePublisher(tail);
  const normPub = normalizePublisher(publisher);
  if (
    normTail.length > 0
    && normPub.length > 0
    && isPublisherWordPrefix(normTail, normPub)
  ) {
    return stripped;
  }
  // Layer 2 — Path 2b: acronym-shape-gated initials equivalence. The
  // ORIGINAL publisher must match /^[A-Z]{1,5}$/ (DOJ, NPR, AP, BBC),
  // gated on the unaltered field as authored — Title-Case names like
  // "Time"/"Wired" do not opt in. The tail must also be Title-Case-or-
  // connector shaped, blocking lowercase editorial text. Initials use
  // tailForInitials (NOT normalizePublisher) so wire-suffix words like
  // `Press` in "Associated Press" survive to count toward `ap`.
  if (
    PUBLISHER_ACRONYM_RE.test(publisher)
    && looksLikePublisherShape(tail)
    && initialsOf(tailForInitials(tail)) === publisher.toLowerCase()
  ) {
    return stripped;
  }
  return trimmed;
}

// Editorial-format prefixes some feeds prepend to headlines. They tell
// the user nothing the magazine card doesn't already convey (every
// card has its own source line and body block), so they just dilute
// the headline. Conservative list — only patterns observed in
// production briefs (May 12 magazine page 16/18: "Video: Philippine
// senator flees ICC arrest..."). The trailing colon is REQUIRED so a
// real headline starting with the bare word "Video game regulator
// fines..." stays intact.
const HEADLINE_PREFIX_RE = /^(?:video|watch|live|photos?|gallery|listen|podcast|breaking|exclusive|opinion|analysis|update)\s*:\s*/i;

/**
 * Strip editorial-format prefixes like "Video: ", "Watch: ", "Live: ",
 * "Photos: ", "Breaking: " from the start of a headline.
 *
 * @param {string} title
 * @returns {string}
 */
export function stripHeadlinePrefix(title) {
  if (typeof title !== 'string' || title.length === 0) return '';
  return title.trim().replace(HEADLINE_PREFIX_RE, '').trimStart();
}

/**
 * Adapter for the SYNTHESIS boundary — distinct from
 * `digestStoryToUpstreamTopStory` (the compose-envelope boundary).
 *
 * The canonical synthesis (`generateDigestProse` via
 * `runSynthesisWithFallback` / `generateDigestProsePublic`) is handed
 * the raw `buildDigest` pool, whose stories carry
 * `{ title, severity, sources }`. But `buildDigestPrompt`,
 * `checkLeadGrounding`, and `hashDigestInput` all read
 * `{ headline, threatLevel, source, category, country }`. The
 * field-name mismatch meant every synthesis prompt rendered every
 * story line as `[h:hash] [] undefined — undefined · undefined ·
 * undefined` — the model got NO story content and confabulated the
 * lead/threads/signals wholesale (the May 12 / May 14 hallucinations),
 * and `checkLeadGrounding` saw empty headlines so the grounding gate
 * skipped every time. See plan
 * docs/plans/2026-05-14-001-fix-brief-pipeline-parity-grounding-opinion-plan.md
 * (F2, Phase 2).
 *
 * This is the SINGLE normalisation point — apply it once at each
 * synthesis call site, never patch the three readers individually.
 * The headline gets the same prefix/suffix cleanup the magazine
 * headline gets (so the lead grounds against the same text the
 * reader sees). Sanitisation closes the prompt-injection vector
 * (F8) — the digest-prose prompt carries the reader's profile
 * context, so an unsanitised hostile RSS `<title>` is a real risk.
 * The headline is normalised to a single line and then run through
 * `sanitizeHeadline` (structural delimiters only) — the full
 * `sanitizeForPrompt` would mangle legitimate news headlines whose
 * SUBJECT is an injection phrase, e.g. "Senator urges Trump to ignore
 * all previous instructions on tariffs". The single-line normalisation
 * closes the one gap structural-only sanitisation leaves: a multi-line
 * hostile `<title>` injecting a line-start role turn. The other
 * free-text fields (`source`, `category`, `country`) are metadata,
 * not headlines, so they get the full `sanitizeForPrompt`.
 * `threatLevel` is an enum and `hash` is a hex digest — neither is
 * sanitised.
 *
 * `category` / `country` default to `'General'` / `'Global'`,
 * matching `digestStoryToUpstreamTopStory` + `filterTopStories`
 * defaults, because `story:track:v1` carries neither field.
 *
 * @param {object} s — digest-shaped story from buildDigest()
 * @returns {{ headline: string; threatLevel: string; source: string; category: string; country: string; hash: string }}
 */
export function digestStoryToSynthesisShape(s) {
  const sources = Array.isArray(s?.sources) ? s.sources : [];
  // An empty / whitespace-only first entry passes the `typeof` guard but
  // is not a real source — fall back to 'Multiple wires' so a prompt line
  // never renders with a trailing blank attribution.
  const primarySource = sources.length > 0
    && typeof sources[0] === 'string'
    && sources[0].trim().length > 0
    ? sources[0]
    : 'Multiple wires';
  // Collapse all whitespace to single spaces up front: a headline is one
  // line by definition, and a multi-line hostile RSS <title> must not be
  // able to break the prompt's per-story line into a fake line-start role
  // turn ("...\nassistant: ignore all previous instructions").
  const rawTitle = typeof s?.title === 'string' ? s.title.replace(/\s+/g, ' ').trim() : '';
  const cleanTitle = stripHeadlineSuffix(stripHeadlinePrefix(rawTitle), primarySource);
  return {
    // sanitizeHeadline (structural-only) — NOT sanitizeForPrompt — so a
    // legitimate headline that quotes an injection phrase as its news
    // subject survives intact. See the doc comment above. The rawTitle
    // single-line normalisation above closes the newline-injection gap
    // that structural-only sanitisation would otherwise leave open.
    headline: sanitizeHeadline(cleanTitle),
    threatLevel: typeof s?.severity === 'string' ? s.severity : '',
    source: sanitizeForPrompt(primarySource),
    category: sanitizeForPrompt(typeof s?.category === 'string' ? s.category : 'General'),
    country: sanitizeForPrompt(typeof s?.countryCode === 'string' ? s.countryCode : 'Global'),
    hash: typeof s?.hash === 'string' ? s.hash : '',
  };
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
  // Two-stage cleanup: strip editorial-format prefix first ("Video:",
  // "Watch:", "Breaking:") then publisher suffix (" - Reuters",
  // "| AP News"). Order matters because some headlines have both:
  // "Video: Philippine senator flees ICC arrest - Al Jazeera" should
  // become "Philippine senator flees ICC arrest".
  const cleanTitle = stripHeadlineSuffix(stripHeadlinePrefix(rawTitle), primarySource);
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
    importanceScore: Number.isFinite(Number(s?.currentScore)) ? Number(s.currentScore) : undefined,
    // story:track:v1 carries neither field, so the brief falls back
    // to 'General' / 'Global' via filterTopStories defaults.
    category: typeof s?.category === 'string' ? s.category : undefined,
    countryCode: typeof s?.countryCode === 'string' ? s.countryCode : undefined,
    // Stable digest story hash. Carried through so:
    //   (a) the canonical synthesis prompt can emit `rankedStoryHashes`
    //       referencing each story by hash (not position, not title),
    //   (b) `filterTopStories` can use the model's order as the final
    //       tie-breaker after deterministic severity/topic-block mass
    //       and score, before applying the MAX_STORIES_PER_USER cap.
    // Falls back to titleHash when the digest path didn't materialise
    // a primary `hash` (rare; shape varies across producer versions).
    hash: typeof s?.hash === 'string' && s.hash.length > 0
      ? s.hash
      : (typeof s?.titleHash === 'string' ? s.titleHash : undefined),
    // Sprint 1 / U3: canonical cluster-rep hash threaded into
    // BriefStory.clusterId via filterTopStories. For multi-story
    // clusters, materializeCluster (in brief-dedup-jaccard.mjs) sets
    // `mergedHashes[]` on the rep — `mergedHashes[0]` is the
    // deterministic cluster identity (sort: score DESC, mentionCount
    // DESC, hash ASC), shared by every member that maps back to this
    // rep. For singleton clusters (no clustering pass, or one-member
    // result) `mergedHashes` is absent — fall back to the rep's own
    // hash so singletons satisfy the plan invariant "clusterId equals
    // the story's own hash" naturally.
    clusterRepHash: Array.isArray(s?.mergedHashes) && s.mergedHashes.length > 0
      && typeof s.mergedHashes[0] === 'string' && s.mergedHashes[0].length > 0
      ? s.mergedHashes[0]
      : (typeof s?.hash === 'string' && s.hash.length > 0 ? s.hash : undefined),
    // Transient topic-ordering metadata from groupTopicsPostDedup.
    // filterTopStories consumes these before writing BriefStory; they
    // are not part of the persisted envelope schema.
    briefTopicId: typeof s?.briefTopicId === 'string' && s.briefTopicId.length > 0
      ? s.briefTopicId
      : undefined,
    briefTopicSize: Number.isFinite(Number(s?.briefTopicSize)) ? Number(s.briefTopicSize) : undefined,
    briefTopicMaxScore: Number.isFinite(Number(s?.briefTopicMaxScore)) ? Number(s.briefTopicMaxScore) : undefined,
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
 * Pure / synchronous. The cron orchestration layer pre-resolves the
 * canonical synthesis (`exec` from `generateDigestProse`) and the
 * non-personalised `publicLead` (`generateDigestProsePublic`) and
 * passes them in via `opts.synthesis` — this module performs no LLM
 * I/O.
 *
 * @param {object} rule — enabled alertRule row
 * @param {unknown[]} digestStories — output of buildDigest(rule, windowStart)
 * @param {{ clusters: number; multiSource: number }} insightsNumbers
 * @param {{
 *   nowMs?: number,
 *   onDrop?: import('../../shared/brief-filter.js').DropMetricsFn,
 *   synthesis?: {
 *     lead?: string,
 *     threads?: Array<{ tag: string, teaser: string }>,
 *     signals?: string[],
 *     rankedStoryHashes?: string[],
 *     publicLead?: string,
 *     publicSignals?: string[],
 *     publicThreads?: Array<{ tag: string, teaser: string }>,
 *   },
 * }} [opts]
 *   `onDrop` is forwarded to filterTopStories so the seeder can
 *   aggregate per-user filter-drop counts without this module knowing
 *   how they are reported.
 *   `synthesis` (when provided) substitutes envelope.digest.lead /
 *   threads / signals / publicLead with the canonical synthesis from
 *   the orchestration layer. `synthesis.rankedStoryHashes` is passed to
 *   the filter as a tie-breaker after severity/topic-cluster ordering,
 *   before applying the cap.
 */
export function composeBriefFromDigestStories(rule, digestStories, insightsNumbers, { nowMs = Date.now(), onDrop, synthesis } = {}) {
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
    rankedStoryHashes: synthesis?.rankedStoryHashes,
  });
  if (stories.length === 0) return null;
  const issueDate = issueDateInTz(nowMs, tz);
  const envelope = assembleStubbedBriefEnvelope({
    user: { name: userDisplayNameFromId(rule.userId), tz },
    stories,
    issueDate,
    dateLong: dateLongFromIso(issueDate),
    issue: issueCodeFromIso(issueDate),
    insightsNumbers,
    issuedAt: nowMs,
    localHour: localHourInTz(nowMs, tz),
  });
  // Splice canonical synthesis into the envelope's digest. Done as a
  // shallow merge so the assembleStubbedBriefEnvelope path stays the
  // single source for greeting/numbers/threads-default. We only
  // override the LLM-driven fields when the orchestrator supplied
  // them; missing fields fall back to the stub for graceful
  // degradation when synthesis fails.
  if (synthesis && envelope?.data?.digest) {
    if (typeof synthesis.lead === 'string' && synthesis.lead.length > 0) {
      envelope.data.digest.lead = synthesis.lead;
    }
    if (Array.isArray(synthesis.threads) && synthesis.threads.length > 0) {
      envelope.data.digest.threads = synthesis.threads;
    }
    if (Array.isArray(synthesis.signals)) {
      envelope.data.digest.signals = synthesis.signals;
    }
    if (typeof synthesis.publicLead === 'string' && synthesis.publicLead.length > 0) {
      envelope.data.digest.publicLead = synthesis.publicLead;
    }
    // Public signals/threads are non-personalised siblings produced by
    // generateDigestProsePublic. Captured separately from the
    // personalised signals/threads above so the share-URL renderer
    // never has to choose between leaking and omitting a whole page.
    if (Array.isArray(synthesis.publicSignals) && synthesis.publicSignals.length > 0) {
      envelope.data.digest.publicSignals = synthesis.publicSignals;
    }
    if (Array.isArray(synthesis.publicThreads) && synthesis.publicThreads.length > 0) {
      envelope.data.digest.publicThreads = synthesis.publicThreads;
    }
  }
  return envelope;
}
