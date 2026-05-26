// Opinion / analysis classifier for the WorldMonitor brief pipeline.
//
// The brief is event-driven intelligence — an op-ed column is not an
// event. On 2026-05-14 a Le Monde opinion column ("'Russia's invasion
// of Ukraine could have warned Trump…'", by columnist Gilles Paris)
// shipped as story #1, tagged Critical, ahead of a nuclear ICBM test.
// See plan docs/plans/2026-05-14-001-fix-brief-pipeline-parity-grounding-opinion-plan.md
// (F3, Phase 3).
//
// This module is the SINGLE classifier, imported by BOTH the ingest
// path (server/worldmonitor/news/v1/list-feed-digest.ts — stamps
// `isOpinion` onto the story:track:v1 row) AND the read path
// (scripts/seed-digest-notifications.mjs buildDigest — re-classifies
// to catch residue rows ingested before the ingest stamp shipped).
//
// Available signals at BOTH layers are the same: title, link (URL),
// description. story:track:v1 does not persist byline or feed-section
// metadata, and the parsed RSS item does not carry them either — so
// there is no richer ingest-time signal to exploit.
//
// Tiering (conservative — a false negative ships one opinion piece;
// a false positive silently drops a real event):
//   STRONG       — sufficient alone to classify as opinion
//   CORROBORATING — needs a STRONG signal OR two CORROBORATING signals

// ── STRONG: URL path / feed-section segments ─────────────────────────
// A dedicated opinion/commentary section in the URL is an unambiguous
// publisher signal. Every entry is SLASH-DELIMITED on both sides — a
// real path segment, not a substring. An unbounded `/opinion-` prefix
// was rejected on review: it false-positives on hard-news article
// slugs like `/world/opinion-polls-tighten-election` (PR #3690
// review). `/analysis/` is deliberately NOT here either — many
// outlets file hard-news explainers under /analysis/ (it is a
// CORROBORATING signal below).
const STRONG_URL_SEGMENTS = [
  '/opinion/',
  '/opinions/',
  '/views/',
  '/commentary/',
  '/editorial/',
  '/editorials/',
  '/op-ed/',
  '/op-eds/',
  '/columnists/',
  '/columnist/',
  '/columns/',
];

// ── STRONG: explicit headline prefix ─────────────────────────────────
// "Opinion: …", "Analysis: …", "Commentary: …", "Op-Ed: …" — an
// explicit editorial label the publisher chose. Mirrors the prefix
// set stripHeadlinePrefix removes for display, but here it CLASSIFIES
// rather than strips. Trailing colon required so a bare-noun headline
// ("Opinion polls tighten…") is not caught.
const STRONG_HEADLINE_PREFIX_RE = /^(?:opinion|analysis|commentary|op-?ed|editorial|perspective|viewpoint)\s*:/i;

// ── STRONG: source-domain allowlist ──────────────────────────────────
// Publications whose entire output is commentary / analysis. Different
// signal from STRONG #1: those catch op-ed SECTIONS inside hard-news
// outlets (NYT/opinion/, BBC/views/). This catches publications where
// the WHOLE SITE is analysis and they don't use opinion-style URL
// paths. On 2026-05-19 the Bulletin of Atomic Scientists' "How nuclear
// war would impact the global food system" shipped as CRITICAL story
// #6 in a Pro brief — STRONG #1 missed it (no /opinion/ path), STRONG
// #2 missed it (no "Opinion:" prefix), CORROBORATING missed it
// (no quote-wrap, hard-news-shaped description).
//
// SELECTION CRITERIA (read before adding to this list):
//   1. Publication's editorial mission is analysis / commentary / op-ed.
//   2. They do NOT publish breaking-news wires or event coverage.
//   3. Dropping every piece they publish is editorially safer than
//      including any single piece as a brief "event."
//
// MAINTENANCE: this list is a permanent editorial commitment. Quarterly
// review against `droppedOpinion` telemetry to catch (a) new commentary
// publishers that should be added, (b) listed publishers that launched
// a hard-news section. Owner: brief on-call author.
//
// ROLLBACK: if a Doomsday-Clock-style EVENT from one of these publishers
// is unfairly dropped, remove the publisher from this Set. Do NOT add
// ad-hoc URL exceptions — they accumulate into cruft.
const COMMENTARY_HOSTNAMES = new Set([
  'thebulletin.org',          // Bulletin of the Atomic Scientists — entirely commentary/analysis
  'project-syndicate.org',    // Project Syndicate — op-eds from world leaders / academics
  'foreignaffairs.com',       // Foreign Affairs — CFR's analysis quarterly; long-form essays
  'warontherocks.com',        // War on the Rocks — defense analysis blog
  // NOTE: foreignpolicy.com is INTENTIONALLY NOT here. FP runs hard-news
  // surfaces — World Brief, Situation Report, Morning Brief — that
  // publish event coverage (e.g., "G-7 Finance Ministers Discuss
  // Economic Fallout of Iran War"). Allowlisting the whole hostname
  // would silently drop those events. FP's commentary pieces still get
  // caught by the existing /opinion/ path segment OR the "Opinion:" /
  // "Analysis:" headline prefix; that's the right granularity for
  // mixed-content publishers. PR #3835 review caught this.
]);

// ── CORROBORATING: description framing ───────────────────────────────
// Columnist/argument framing in the body. Alone these false-positive
// on quoted-statement hard news ("the minister argues that…"), so they
// only count toward a 2-signal threshold.
const CORROBORATING_DESCRIPTION_RE = /\b(?:columnist|op-?ed|opinion piece|our columnist|argues that|posits that|makes the case|the case for|guest essay|editorial board)\b/i;

// ── CORROBORATING: whole-headline quote wrap ─────────────────────────
// An entire headline wrapped in quotation marks is the classic op-ed
// headline format (the May 14 Le Monde column). But a hard-news
// headline can also lead with a quoted phrase, so this is corroborating
// only. Requires the FULL headline to be quote-wrapped — a headline
// that merely CONTAINS a quoted phrase does not count.
function isWholeHeadlineQuoted(title) {
  if (typeof title !== 'string') return false;
  const t = title.trim();
  if (t.length < 2) return false;
  const first = t[0];
  const last = t[t.length - 1];
  const opensQuote = first === '"' || first === '“' || first === "'" || first === '‘';
  const closesQuote = last === '"' || last === '”' || last === "'" || last === '’';
  return opensQuote && closesQuote;
}

/**
 * Parse the URL pathname defensively. Malformed URL → empty string
 * (skip URL signal entirely; do not throw). Closes the tracking-param
 * injection vector — aggregator tracking params (?utm=/opinion/promo)
 * and URL fragments (#/opinion/footer) live OUTSIDE the pathname and
 * must not trigger STRONG (or CORROBORATING) via raw-string includes()
 * matching on the full link. Backport of the same helper added in
 * feelgood-classifier.js (PR #3748 / adv-002).
 */
function safePathname(link) {
  if (typeof link !== 'string' || link.length === 0) return '';
  try {
    return new URL(link).pathname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Parse the URL hostname defensively. Same shape as safePathname but
 * for the host portion — closes the same tracking-param / fragment
 * injection vector. A raw-string `link.includes('thebulletin.org')`
 * would false-positive on `https://nytimes.com/article?ref=thebulletin.org`
 * (tracking param) or `https://evil.com#thebulletin.org` (fragment).
 * Hostname comes from the parsed URL only.
 *
 * Suffix-anchored match: hostname `=== entry` OR hostname `.endsWith('.' + entry)`.
 * This catches subdomain variants (`newsletter.thebulletin.org`,
 * `m.thebulletin.org`) while rejecting typo-domains (`evilthebulletin.org`).
 * The plan's subdomain-policy decision (F12 in PR #3828's doc review).
 */
function safeHostname(link) {
  if (typeof link !== 'string' || link.length === 0) return '';
  try {
    return new URL(link).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matchesCommentaryHost(hostname) {
  if (!hostname) return false;
  for (const entry of COMMENTARY_HOSTNAMES) {
    if (hostname === entry || hostname.endsWith('.' + entry)) return true;
  }
  return false;
}

/**
 * Classify a story as opinion/analysis vs hard news.
 *
 * @param {{ title?: unknown; link?: unknown; description?: unknown }} story
 * @returns {boolean} true = opinion/analysis (exclude from the brief)
 */
export function classifyOpinion(story) {
  const title = typeof story?.title === 'string' ? story.title : '';
  const link = typeof story?.link === 'string' ? story.link : '';
  const description = typeof story?.description === 'string' ? story.description : '';

  // Parse pathname once; reused by STRONG #1 and CORROBORATING URL check.
  const pathname = safePathname(link);

  // STRONG #1 — URL section. Matches a path segment on the parsed
  // pathname (NOT raw link), so tracking params / fragments can't
  // spoof a section match. Every STRONG_URL_SEGMENTS entry is
  // slash-delimited on both sides.
  if (pathname && STRONG_URL_SEGMENTS.some((seg) => pathname.includes(seg))) return true;

  // STRONG #2 — explicit headline prefix.
  if (STRONG_HEADLINE_PREFIX_RE.test(title.trim())) return true;

  // STRONG #3 — source-domain allowlist. Catches commentary-only
  // publishers whose WHOLE SITE is analysis (Bulletin of Atomic
  // Scientists, Project Syndicate, Foreign Affairs, …) — they don't
  // use /opinion/-style URL paths because they have no hard-news
  // section to distinguish from. Hostname match on the parsed URL
  // only, suffix-anchored to permit `newsletter.<host>` and `m.<host>`
  // while rejecting typo-domains.
  if (matchesCommentaryHost(safeHostname(link))) return true;

  // CORROBORATING — need at least TWO.
  let corroborating = 0;
  if (isWholeHeadlineQuoted(title)) corroborating += 1;
  if (CORROBORATING_DESCRIPTION_RE.test(description)) corroborating += 1;
  // `/analysis/` in the URL is corroborating, not strong. Parsed
  // pathname only (same injection-vector reasoning as STRONG #1).
  if (pathname && (pathname.includes('/analysis/') || pathname.includes('/analyses/'))) corroborating += 1;

  return corroborating >= 2;
}
